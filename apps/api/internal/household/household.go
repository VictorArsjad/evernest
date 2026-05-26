// Package household exposes a minimal households API: create a household
// (the creator becomes its 'owner') and list households the authenticated
// user is a member of. Invite/accept flows are not yet implemented.
package household

import (
	"context"
	"errors"
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/go-playground/validator/v10"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"time"

	"github.com/varsjad/evernest/apps/api/internal/auth"
	"github.com/varsjad/evernest/apps/api/internal/httpx"
	"github.com/varsjad/evernest/apps/api/internal/store"
)

type Household struct {
	ID        uuid.UUID `json:"id"`
	Name      string    `json:"name"`
	Role      string    `json:"role"`
	CreatedAt time.Time `json:"created_at"`
}

var (
	ErrNotMember     = errors.New("user is not a member of this household")
	ErrNotFound      = errors.New("household not found")
)

// MustBeMember returns ErrNotMember if the user is not a member of the given
// household; ErrNotFound if the household doesn't exist. Other packages use this
// for per-route authorization.
func MustBeMember(ctx context.Context, st *store.Store, userID, householdID uuid.UUID) error {
	var exists bool
	err := st.Pool.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM households WHERE id = $1)
	`, householdID).Scan(&exists)
	if err != nil {
		return err
	}
	if !exists {
		return ErrNotFound
	}
	var dummy int
	err = st.Pool.QueryRow(ctx, `
		SELECT 1 FROM household_members WHERE household_id = $1 AND user_id = $2
	`, householdID, userID).Scan(&dummy)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotMember
	}
	return err
}

type Handler struct {
	store           *store.Store
	logger          *slog.Logger
	v               *validator.Validate
	publicWebOrigin string
}

// NewHandler wires the household + invite handlers. `publicWebOrigin` is
// used to construct outbound invite URLs ({origin}/invite/{token}); pass
// the same value `auth` reads for the refresh-cookie scope.
func NewHandler(st *store.Store, logger *slog.Logger, publicWebOrigin string) *Handler {
	return &Handler{
		store:           st,
		logger:          logger,
		v:               validator.New(validator.WithRequiredStructEnabled()),
		publicWebOrigin: publicWebOrigin,
	}
}

// Routes mounts under an authenticated router (auth.RequireUser already applied).
// The caller is expected to mount this under `/households` and to route the
// `{householdID}/invites` and `{householdID}/babies` subgroups separately.
func (h *Handler) Routes(r chi.Router) {
	r.Post("/", h.create)
	r.Get("/", h.list)
}

// InviteRoutes mounts under /v1/households/{householdID} on the
// authenticated router. POST creates an invite, GET lists pending invites
// for the household.
func (h *Handler) InviteRoutes(r chi.Router) {
	h.inviteRoutes(r)
}

// PublicInviteRoutes mounts the unauthenticated invite info endpoint:
// GET /v1/invites/{token}. Takes the v1 router directly (not a subrouter)
// because the authenticated mutation routes also live at /invites/* and
// chi's r.Route would conflict.
func (h *Handler) PublicInviteRoutes(r chi.Router) {
	r.Get("/invites/{token}", h.getPublicInviteInfo)
}

// AuthedInviteRoutes mounts POST /v1/invites/{token}/accept and
// DELETE /v1/invites/{token} on the supplied (auth-required) router.
func (h *Handler) AuthedInviteRoutes(r chi.Router) {
	r.Post("/invites/{token}/accept", h.acceptInvite)
	r.Delete("/invites/{token}", h.revokeInvite)
}

type createReq struct {
	Name string `json:"name" validate:"required,min=1,max=80"`
}

func (h *Handler) create(w http.ResponseWriter, r *http.Request) {
	uid := auth.UserIDFrom(r.Context())
	var req createReq
	if err := httpx.DecodeJSON(r, &req); err != nil {
		httpx.WriteError(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	if err := h.v.Struct(req); err != nil {
		httpx.WriteError(w, http.StatusUnprocessableEntity, "validation_failed", err.Error())
		return
	}

	tx, err := h.store.Pool.Begin(r.Context())
	if err != nil {
		h.logger.Error("begin tx", "err", err)
		httpx.WriteError(w, http.StatusInternalServerError, "internal", "could not start tx")
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	var hh Household
	hh.Role = "owner"
	err = tx.QueryRow(r.Context(), `
		INSERT INTO households (name, created_by)
		VALUES ($1, $2)
		RETURNING id, name, created_at
	`, req.Name, uid).Scan(&hh.ID, &hh.Name, &hh.CreatedAt)
	if err != nil {
		h.logger.Error("insert household", "err", err)
		httpx.WriteError(w, http.StatusInternalServerError, "internal", "could not create household")
		return
	}
	_, err = tx.Exec(r.Context(), `
		INSERT INTO household_members (household_id, user_id, role)
		VALUES ($1, $2, 'owner')
	`, hh.ID, uid)
	if err != nil {
		h.logger.Error("insert membership", "err", err)
		httpx.WriteError(w, http.StatusInternalServerError, "internal", "could not create membership")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		h.logger.Error("commit", "err", err)
		httpx.WriteError(w, http.StatusInternalServerError, "internal", "could not commit")
		return
	}

	httpx.WriteJSON(w, http.StatusCreated, hh)
}

func (h *Handler) list(w http.ResponseWriter, r *http.Request) {
	uid := auth.UserIDFrom(r.Context())
	rows, err := h.store.Pool.Query(r.Context(), `
		SELECT h.id, h.name, hm.role, h.created_at
		FROM households h
		JOIN household_members hm ON hm.household_id = h.id
		WHERE hm.user_id = $1
		ORDER BY h.created_at ASC
	`, uid)
	if err != nil {
		h.logger.Error("list households", "err", err)
		httpx.WriteError(w, http.StatusInternalServerError, "internal", "could not list households")
		return
	}
	defer rows.Close()
	out := make([]Household, 0, 4)
	for rows.Next() {
		var hh Household
		if err := rows.Scan(&hh.ID, &hh.Name, &hh.Role, &hh.CreatedAt); err != nil {
			h.logger.Error("scan household", "err", err)
			httpx.WriteError(w, http.StatusInternalServerError, "internal", "scan failed")
			return
		}
		out = append(out, hh)
	}
	httpx.WriteJSON(w, http.StatusOK, out)
}
