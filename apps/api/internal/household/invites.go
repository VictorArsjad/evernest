// Invite endpoints for the household package. Kept in its own file so
// household.go stays focused on the household CRUD shape; both files share
// the same Handler / store.
//
// Design:
//
//   - The token is plaintext URL-safe base64 (16 random bytes -> 22 chars,
//     no padding). Only the SHA-256 of the token is stored in the DB; the
//     plaintext never round-trips back to the server after creation. This
//     means a DB leak does not let an attacker accept invites.
//
//   - Single-use: `accepted_at IS NULL AND expires_at > now()` is the
//     "pending" predicate. Acceptance writes both `accepted_at` and
//     `accepted_by` atomically inside a transaction that also inserts the
//     household_members row.
//
//   - Treat "used", "expired" and "unknown" identically as 404. We do not
//     want the public GET to leak whether a token *existed* but was used
//     vs never existed — that would let an attacker confirm a token they
//     guessed.
//
//   - Idempotent re-accept: if the caller is already a member of the
//     household, return 200 with the household but do NOT consume the
//     invite. The most common cause is a user clicking the link twice;
//     consuming the link on the second click would turn an idempotent
//     UX flow into an irreversible loss of the link. Anyone else with
//     the link can still accept it normally.
package household

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/varsjad/evernest/apps/api/internal/auth"
	"github.com/varsjad/evernest/apps/api/internal/httpx"
	"github.com/varsjad/evernest/apps/api/internal/store"
)

// Invite is the owner/admin-visible shape returned by POST/GET
// /v1/households/{id}/invites. The plaintext `token` is included on
// creation (POST) only — listing does NOT echo it back, because the DB
// only ever held the hash.
type Invite struct {
	Token      string     `json:"token,omitempty"`
	TokenHint  string     `json:"token_hint"` // base64url-encoded SHA-256 prefix; safe to log
	InviteURL  string     `json:"invite_url,omitempty"`
	Role       string     `json:"role"`
	ExpiresAt  time.Time  `json:"expires_at"`
	CreatedAt  time.Time  `json:"created_at"`
	CreatedBy  uuid.UUID  `json:"created_by"`
	AcceptedAt *time.Time `json:"accepted_at,omitempty"`
}

// InviteInfo is the public (unauthenticated) display metadata returned by
// GET /v1/invites/{token}. It deliberately omits invite-creator identity,
// the household_id, member list, and anything else that would let the
// invite link leak more about the household than "you're being invited to
// X as Y".
type InviteInfo struct {
	HouseholdName string    `json:"household_name"`
	Role          string    `json:"role"`
	ExpiresAt     time.Time `json:"expires_at"`
}

// hashToken returns the SHA-256 of the URL-safe token. We compare in the
// DB by hash so a hostile read of pg_dump never yields a usable token.
func hashToken(token string) []byte {
	h := sha256.Sum256([]byte(token))
	return h[:]
}

// generateToken returns 22 URL-safe characters (16 random bytes encoded as
// base64url, no padding). 128 bits of entropy; collision probability is
// negligible at any realistic invite count.
func generateToken() (string, error) {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(raw[:]), nil
}

// tokenHint returns a short, non-secret display ID derived from the
// SHA-256 hash of the plaintext token. Both POST (create) and GET (list)
// return the same shape so the FE can match a freshly-minted invite
// against its row in the list view (e.g. to populate a "Revoke" button
// for an invite the FE still has the plaintext for in memory).
//
// Using the hash-prefix rather than a plaintext-suffix keeps the hint
// non-sensitive: a leak of the hint reveals nothing useful about the
// token, just confirms the hint -> hash mapping.
func tokenHint(token string) string {
	h := sha256.Sum256([]byte(token))
	return base64.RawURLEncoding.EncodeToString(h[:6])
}

// inviteRoutes registers POST/GET under /v1/households/{householdID}/invites.
// It expects the caller to have already entered the auth-required
// /v1/households/{householdID} subrouter.
func (h *Handler) inviteRoutes(r chi.Router) {
	r.Post("/invites", h.createInvite)
	r.Get("/invites", h.listInvites)
}

// inviteItemRoutes registers the token-scoped routes (public info, accept,
// revoke). Public info is mounted on the unauthenticated router; accept
// and revoke require auth — the caller wires them under the right group.
type createInviteReq struct {
	Role           string `json:"role"`
	ExpiresInHours int    `json:"expires_in_hours,omitempty"`
}

const (
	defaultInviteHours = 168 // 7 days
	minInviteHours     = 1
	maxInviteHours     = 720 // 30 days
)

func (h *Handler) createInvite(w http.ResponseWriter, r *http.Request) {
	uid := auth.UserIDFrom(r.Context())
	hhID, err := uuid.Parse(chi.URLParam(r, "householdID"))
	if err != nil {
		httpx.WriteError(w, http.StatusBadRequest, "bad_request", "invalid household id")
		return
	}
	role, err := h.requireOwner(r.Context(), hhID, uid)
	if err != nil {
		writeMembershipError(w, err)
		return
	}
	_ = role // (only used to gate; role is always 'owner' here)

	var req createInviteReq
	if err := httpx.DecodeJSON(r, &req); err != nil {
		httpx.WriteError(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	if req.Role != "owner" && req.Role != "caregiver" {
		httpx.WriteError(w, http.StatusUnprocessableEntity, "validation_failed",
			"role must be one of: owner, caregiver")
		return
	}
	hours := req.ExpiresInHours
	if hours == 0 {
		hours = defaultInviteHours
	}
	if hours < minInviteHours || hours > maxInviteHours {
		httpx.WriteError(w, http.StatusUnprocessableEntity, "validation_failed",
			fmt.Sprintf("expires_in_hours must be between %d and %d", minInviteHours, maxInviteHours))
		return
	}

	token, err := generateToken()
	if err != nil {
		h.logger.Error("generate token", "err", err)
		httpx.WriteError(w, http.StatusInternalServerError, "internal", "could not generate token")
		return
	}
	expiresAt := time.Now().Add(time.Duration(hours) * time.Hour)

	var created Invite
	created.Token = token
	created.TokenHint = tokenHint(token)
	created.Role = req.Role
	created.CreatedBy = uid

	err = h.store.Pool.QueryRow(r.Context(), `
		INSERT INTO household_invites (token_hash, household_id, role, created_by, expires_at)
		VALUES ($1, $2, $3, $4, $5)
		RETURNING expires_at, created_at
	`, hashToken(token), hhID, req.Role, uid, expiresAt).
		Scan(&created.ExpiresAt, &created.CreatedAt)
	if err != nil {
		h.logger.Error("insert invite", "err", err)
		httpx.WriteError(w, http.StatusInternalServerError, "internal", "could not create invite")
		return
	}
	created.InviteURL = h.inviteURL(token)

	httpx.WriteJSON(w, http.StatusCreated, created)
}

// listInvites returns *pending* (unaccepted + unexpired) invites for the
// household. Any member can call this — the caregiver UI surfaces "links
// currently outstanding" but only the owner can revoke them.
func (h *Handler) listInvites(w http.ResponseWriter, r *http.Request) {
	uid := auth.UserIDFrom(r.Context())
	hhID, err := uuid.Parse(chi.URLParam(r, "householdID"))
	if err != nil {
		httpx.WriteError(w, http.StatusBadRequest, "bad_request", "invalid household id")
		return
	}
	if err := MustBeMember(r.Context(), h.store, uid, hhID); err != nil {
		writeMembershipError(w, err)
		return
	}

	rows, err := h.store.Pool.Query(r.Context(), `
		SELECT token_hash, role, created_by, expires_at, created_at
		FROM household_invites
		WHERE household_id = $1
		  AND accepted_at IS NULL
		  AND expires_at > now()
		ORDER BY created_at DESC
	`, hhID)
	if err != nil {
		h.logger.Error("list invites", "err", err)
		httpx.WriteError(w, http.StatusInternalServerError, "internal", "could not list invites")
		return
	}
	defer rows.Close()

	out := make([]Invite, 0, 4)
	for rows.Next() {
		var inv Invite
		var hash []byte
		if err := rows.Scan(&hash, &inv.Role, &inv.CreatedBy, &inv.ExpiresAt, &inv.CreatedAt); err != nil {
			h.logger.Error("scan invite", "err", err)
			httpx.WriteError(w, http.StatusInternalServerError, "internal", "scan failed")
			return
		}
		// Derive the same hash-prefix hint that create uses so the FE can
		// match a list row against an invite it minted in this session.
		inv.TokenHint = base64.RawURLEncoding.EncodeToString(hash[:6])
		out = append(out, inv)
	}
	httpx.WriteJSON(w, http.StatusOK, out)
}

// getPublicInviteInfo is the unauthenticated lookup. It returns the
// household name + role + expires_at so the FE can render a "Join
// {household} as {role}?" confirmation. Anything beyond that (member list,
// inviter identity, household id) is deliberately omitted because the
// caller has only proven possession of the link.
func (h *Handler) getPublicInviteInfo(w http.ResponseWriter, r *http.Request) {
	token := chi.URLParam(r, "token")
	if token == "" {
		writeInviteNotFound(w)
		return
	}
	info, err := loadValidInvite(r.Context(), h.store, token)
	if err != nil {
		writeInviteNotFound(w)
		return
	}

	var hhName string
	err = h.store.Pool.QueryRow(r.Context(),
		`SELECT name FROM households WHERE id = $1`, info.householdID).Scan(&hhName)
	if err != nil {
		// If the household has vanished while the invite still exists,
		// treat as not-found rather than 500.
		writeInviteNotFound(w)
		return
	}

	httpx.WriteJSON(w, http.StatusOK, InviteInfo{
		HouseholdName: hhName,
		Role:          info.role,
		ExpiresAt:     info.expiresAt,
	})
}

// acceptInvite is the authenticated redemption endpoint. The body is
// empty; the token comes from the URL.
//
// Idempotent behavior on re-accept: if the user is already a member of
// the household, return 200 with the household and DO NOT touch the
// invite. The most common cause of a double-accept is the user reloading
// the redeem page or clicking the link twice from email; consuming the
// invite the second time would burn the link and prevent the *other*
// invited caregiver from using it. This is a deliberate trade-off in
// favor of UX over single-use strictness — anyone else with the link
// can still accept it the first time.
func (h *Handler) acceptInvite(w http.ResponseWriter, r *http.Request) {
	uid := auth.UserIDFrom(r.Context())
	token := chi.URLParam(r, "token")
	if token == "" {
		writeInviteNotFound(w)
		return
	}

	// Look up the invite WITHOUT filtering on accepted_at/expires_at so we
	// can detect the idempotent re-accept case (used invite, but the
	// caller is already a member). The validity check happens below, AFTER
	// the membership check.
	var (
		inviteHHID      uuid.UUID
		inviteRole      string
		inviteExpiresAt time.Time
		inviteAcceptedAt *time.Time
	)
	err := h.store.Pool.QueryRow(r.Context(), `
		SELECT household_id, role, expires_at, accepted_at
		FROM household_invites
		WHERE token_hash = $1
	`, hashToken(token)).Scan(&inviteHHID, &inviteRole, &inviteExpiresAt, &inviteAcceptedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		writeInviteNotFound(w)
		return
	}
	if err != nil {
		h.logger.Error("load invite for accept", "err", err)
		httpx.WriteError(w, http.StatusInternalServerError, "internal", "could not load invite")
		return
	}

	// Idempotent fast path: caller is already a member of the inviting
	// household. Return 200 with the household and do NOT consume the
	// invite, even if it's already used / expired. The double-click and
	// reload-the-redeem-page UX patterns both end up here.
	if alreadyMember, role, joinedAt, err := lookupMembership(r.Context(), h.store, uid, inviteHHID); err != nil {
		h.logger.Error("lookup membership", "err", err)
		httpx.WriteError(w, http.StatusInternalServerError, "internal", "could not check membership")
		return
	} else if alreadyMember {
		hh, hhErr := h.loadHousehold(r.Context(), inviteHHID, role, joinedAt)
		if hhErr != nil {
			h.logger.Error("load household after idempotent accept", "err", hhErr)
			httpx.WriteError(w, http.StatusInternalServerError, "internal", "could not load household")
			return
		}
		httpx.WriteJSON(w, http.StatusOK, hh)
		return
	}

	// Not already a member: enforce validity (used/expired both surface
	// as 404 to avoid token-enumeration leaks).
	if inviteAcceptedAt != nil || time.Now().After(inviteExpiresAt) {
		writeInviteNotFound(w)
		return
	}

	// Single transaction: re-validate the invite under FOR UPDATE so two
	// concurrent accepts can't both win, insert the member, mark accepted.
	tx, err := h.store.Pool.Begin(r.Context())
	if err != nil {
		h.logger.Error("begin tx", "err", err)
		httpx.WriteError(w, http.StatusInternalServerError, "internal", "could not start tx")
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	var (
		hhID      uuid.UUID
		role      string
		expiresAt time.Time
		accepted  *time.Time
	)
	err = tx.QueryRow(r.Context(), `
		SELECT household_id, role, expires_at, accepted_at
		FROM household_invites
		WHERE token_hash = $1
		FOR UPDATE
	`, hashToken(token)).Scan(&hhID, &role, &expiresAt, &accepted)
	if errors.Is(err, pgx.ErrNoRows) {
		writeInviteNotFound(w)
		return
	}
	if err != nil {
		h.logger.Error("select invite for accept", "err", err)
		httpx.WriteError(w, http.StatusInternalServerError, "internal", "could not load invite")
		return
	}
	if accepted != nil || time.Now().After(expiresAt) {
		writeInviteNotFound(w)
		return
	}

	var hh Household
	err = tx.QueryRow(r.Context(), `
		INSERT INTO household_members (household_id, user_id, role)
		VALUES ($1, $2, $3)
		ON CONFLICT (household_id, user_id) DO UPDATE
		   SET role = household_members.role
		RETURNING role, joined_at
	`, hhID, uid, role).Scan(&hh.Role, new(time.Time))
	if err != nil {
		h.logger.Error("insert member", "err", err)
		httpx.WriteError(w, http.StatusInternalServerError, "internal", "could not add member")
		return
	}

	_, err = tx.Exec(r.Context(), `
		UPDATE household_invites
		   SET accepted_at = now(), accepted_by = $2
		 WHERE token_hash = $1
	`, hashToken(token), uid)
	if err != nil {
		h.logger.Error("mark invite accepted", "err", err)
		httpx.WriteError(w, http.StatusInternalServerError, "internal", "could not mark invite accepted")
		return
	}

	err = tx.QueryRow(r.Context(), `
		SELECT id, name, created_at FROM households WHERE id = $1
	`, hhID).Scan(&hh.ID, &hh.Name, &hh.CreatedAt)
	if err != nil {
		h.logger.Error("load household after accept", "err", err)
		httpx.WriteError(w, http.StatusInternalServerError, "internal", "could not load household")
		return
	}

	if err := tx.Commit(r.Context()); err != nil {
		h.logger.Error("commit accept", "err", err)
		httpx.WriteError(w, http.StatusInternalServerError, "internal", "could not commit accept")
		return
	}

	httpx.WriteJSON(w, http.StatusOK, hh)
}

// revokeInvite deletes an invite by token. Authorization: caller must be
// an owner of the inviting household OR the invite's creator. We DELETE
// rather than soft-delete the invite — revoking is a destructive action
// surfaced explicitly to the user, and keeping revoked rows around for
// later audit is out of scope for v1.
func (h *Handler) revokeInvite(w http.ResponseWriter, r *http.Request) {
	uid := auth.UserIDFrom(r.Context())
	token := chi.URLParam(r, "token")
	if token == "" {
		writeInviteNotFound(w)
		return
	}

	var (
		hhID    uuid.UUID
		creator uuid.UUID
	)
	err := h.store.Pool.QueryRow(r.Context(), `
		SELECT household_id, created_by
		FROM household_invites
		WHERE token_hash = $1
	`, hashToken(token)).Scan(&hhID, &creator)
	if errors.Is(err, pgx.ErrNoRows) {
		writeInviteNotFound(w)
		return
	}
	if err != nil {
		h.logger.Error("load invite for revoke", "err", err)
		httpx.WriteError(w, http.StatusInternalServerError, "internal", "could not load invite")
		return
	}

	authorized := uid == creator
	if !authorized {
		role, err := lookupMemberRole(r.Context(), h.store, uid, hhID)
		if err == nil && role == "owner" {
			authorized = true
		}
	}
	if !authorized {
		// Mirror getPublicInviteInfo: don't disclose that the token
		// matched a real invite if the caller has no business touching it.
		writeInviteNotFound(w)
		return
	}

	_, err = h.store.Pool.Exec(r.Context(),
		`DELETE FROM household_invites WHERE token_hash = $1`, hashToken(token))
	if err != nil {
		h.logger.Error("delete invite", "err", err)
		httpx.WriteError(w, http.StatusInternalServerError, "internal", "could not revoke invite")
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// --- helpers ---

type loadedInvite struct {
	householdID uuid.UUID
	role        string
	expiresAt   time.Time
}

// loadValidInvite returns the invite row only if it is pending (unaccepted
// AND unexpired). Used by the public info endpoint and as a read-before-tx
// fast path for accept.
func loadValidInvite(ctx context.Context, st *store.Store, token string) (loadedInvite, error) {
	var li loadedInvite
	err := st.Pool.QueryRow(ctx, `
		SELECT household_id, role, expires_at
		FROM household_invites
		WHERE token_hash = $1
		  AND accepted_at IS NULL
		  AND expires_at > now()
	`, hashToken(token)).Scan(&li.householdID, &li.role, &li.expiresAt)
	return li, err
}

// lookupMembership returns whether the user is a member of the household,
// and if so their role + joined_at. Single round-trip rather than two.
func lookupMembership(ctx context.Context, st *store.Store, userID, hhID uuid.UUID) (bool, string, time.Time, error) {
	var (
		role     string
		joinedAt time.Time
	)
	err := st.Pool.QueryRow(ctx, `
		SELECT role, joined_at FROM household_members
		WHERE household_id = $1 AND user_id = $2
	`, hhID, userID).Scan(&role, &joinedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, "", time.Time{}, nil
	}
	if err != nil {
		return false, "", time.Time{}, err
	}
	return true, role, joinedAt, nil
}

// lookupMemberRole returns the caller's role in the household, or an error
// if they're not a member.
func lookupMemberRole(ctx context.Context, st *store.Store, userID, hhID uuid.UUID) (string, error) {
	var role string
	err := st.Pool.QueryRow(ctx, `
		SELECT role FROM household_members
		WHERE household_id = $1 AND user_id = $2
	`, hhID, userID).Scan(&role)
	return role, err
}

// requireOwner ensures the caller is the owner of the household. Returns
// the role string on success; otherwise an error mapped to 401/403/404 by
// writeMembershipError.
func (h *Handler) requireOwner(ctx context.Context, hhID, uid uuid.UUID) (string, error) {
	if err := MustBeMember(ctx, h.store, uid, hhID); err != nil {
		return "", err
	}
	role, err := lookupMemberRole(ctx, h.store, uid, hhID)
	if err != nil {
		return "", err
	}
	if role != "owner" {
		return role, errNotOwner
	}
	return role, nil
}

func (h *Handler) loadHousehold(ctx context.Context, hhID uuid.UUID, role string, _ time.Time) (Household, error) {
	var hh Household
	hh.Role = role
	err := h.store.Pool.QueryRow(ctx, `
		SELECT id, name, created_at FROM households WHERE id = $1
	`, hhID).Scan(&hh.ID, &hh.Name, &hh.CreatedAt)
	return hh, err
}

func (h *Handler) inviteURL(token string) string {
	origin := strings.TrimRight(h.publicWebOrigin, "/")
	return origin + "/invite/" + token
}

// errNotOwner is returned by requireOwner when the caller is a member but
// only a caregiver. Mapped to 403 by writeMembershipError.
var errNotOwner = errors.New("user must be owner of household")

func writeMembershipError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrNotFound):
		httpx.WriteError(w, http.StatusNotFound, "not_found", "household not found")
	case errors.Is(err, ErrNotMember):
		httpx.WriteError(w, http.StatusForbidden, "forbidden", "not a member of this household")
	case errors.Is(err, errNotOwner):
		httpx.WriteError(w, http.StatusForbidden, "forbidden", "must be owner to perform this action")
	default:
		httpx.WriteError(w, http.StatusInternalServerError, "internal", "membership check failed")
	}
}

// writeInviteNotFound is the single 404 path for every "unknown / used /
// expired / unauthorized" invite condition. Collapsing all four into one
// response avoids the token-enumeration leak.
func writeInviteNotFound(w http.ResponseWriter) {
	httpx.WriteError(w, http.StatusNotFound, "not_found", "invite not found or no longer valid")
}
