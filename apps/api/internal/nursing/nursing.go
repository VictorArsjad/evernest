// Package nursing implements CRUD for nursing sessions (baby fed at the
// breast). Mirrors bottlefeed/diaper/pumping: POST/GET/DELETE with UUIDv7
// client-id idempotency and baby-membership authz. Nursing has its own
// shape because the schema is fundamentally different from bottle feeds
// (duration + side, no volume) — see docs/schema.md.
//
// Open sessions ("start now / end later"): the schema lets ended_at be
// NULL, so we accept POSTs that omit ended_at + per-side durations and
// store 0/0 for the duration columns (they're NOT NULL DEFAULT 0; we don't
// want a migration just for this slice). The POST handler enforces "all
// three closed-session fields together or none of them" so we never end
// up with a half-closed row, and at most one open session per baby. PATCH
// /v1/nursing-sessions/{id} closes an open session and GET
// /v1/babies/{babyID}/nursing-sessions/open is a cheap "is one running?"
// shortcut for the Today screen.
package nursing

import (
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-playground/validator/v10"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/varsjad/evernest/apps/api/internal/auth"
	"github.com/varsjad/evernest/apps/api/internal/baby"
	"github.com/varsjad/evernest/apps/api/internal/httpx"
	"github.com/varsjad/evernest/apps/api/internal/store"
	"github.com/varsjad/evernest/apps/api/internal/uuidx"
)

type Nursing struct {
	ID             uuid.UUID  `json:"id"`
	BabyID         uuid.UUID  `json:"baby_id"`
	StartedAt      time.Time  `json:"started_at"`
	EndedAt        *time.Time `json:"ended_at,omitempty"`
	StartingBreast *string    `json:"starting_breast,omitempty"`
	NursingSide    string     `json:"nursing_side"`
	LeftDurationS  int        `json:"left_duration_s"`
	RightDurationS int        `json:"right_duration_s"`
	Notes          *string    `json:"notes,omitempty"`
	Source         string     `json:"source"`
	CreatedAt      time.Time  `json:"created_at"`
}

type Handler struct {
	store  *store.Store
	logger *slog.Logger
	v      *validator.Validate
}

func NewHandler(st *store.Store, logger *slog.Logger) *Handler {
	return &Handler{store: st, logger: logger, v: validator.New(validator.WithRequiredStructEnabled())}
}

// BabyRoutes mounts under /v1/babies/{babyID}.
func (h *Handler) BabyRoutes(r chi.Router) {
	r.Post("/nursing-sessions", h.create)
	r.Get("/nursing-sessions", h.list)
	// /open MUST be registered before any /{id}-shaped route so chi doesn't
	// try to parse "open" as a UUID. We mount it on the baby scope (not
	// the item scope) because open-ness is per-baby, not per-id.
	r.Get("/nursing-sessions/open", h.getOpen)
}

// ItemRoutes mounts under /v1/nursing-sessions/{id}.
func (h *Handler) ItemRoutes(r chi.Router) {
	r.Patch("/", h.end)
	r.Delete("/", h.delete)
}

// createReq accepts both shapes:
//   - closed session (the existing CP2c contract): started_at + ended_at +
//     left_duration_s + right_duration_s + nursing_side
//   - open session ("start now"): started_at + nursing_side ONLY; ended_at
//     and both durations are omitted.
//
// Mixing the two (ended_at without durations, or durations without
// ended_at) is rejected as 422 — see create() — to keep the closed-vs-open
// distinction unambiguous.
type createReq struct {
	ID             *uuid.UUID `json:"id,omitempty"`
	StartedAt      time.Time  `json:"started_at" validate:"required"`
	EndedAt        *time.Time `json:"ended_at,omitempty"`
	StartingBreast *string    `json:"starting_breast,omitempty" validate:"omitempty,oneof=left right"`
	NursingSide    string     `json:"nursing_side" validate:"required,oneof=left right both"`
	LeftDurationS  *int       `json:"left_duration_s,omitempty" validate:"omitempty,gte=0,lte=21600"`
	RightDurationS *int       `json:"right_duration_s,omitempty" validate:"omitempty,gte=0,lte=21600"`
	Notes          *string    `json:"notes,omitempty"`
}

func (h *Handler) create(w http.ResponseWriter, r *http.Request) {
	uid := auth.UserIDFrom(r.Context())
	babyID, err := uuid.Parse(chi.URLParam(r, "babyID"))
	if err != nil {
		httpx.WriteError(w, http.StatusBadRequest, "bad_id", "invalid baby id")
		return
	}
	if _, err := baby.MustOwnBaby(r.Context(), h.store, uid, babyID); err != nil {
		writeBabyAuthErr(w, err)
		return
	}

	var req createReq
	if err := httpx.DecodeJSON(r, &req); err != nil {
		httpx.WriteError(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	if err := h.v.Struct(req); err != nil {
		httpx.WriteError(w, http.StatusUnprocessableEntity, "validation_failed", err.Error())
		return
	}

	hasEnd := req.EndedAt != nil
	hasDurations := req.LeftDurationS != nil && req.RightDurationS != nil
	hasAnyDuration := req.LeftDurationS != nil || req.RightDurationS != nil
	switch {
	case hasEnd && !hasDurations:
		httpx.WriteError(w, http.StatusUnprocessableEntity, "validation_failed",
			"durations required when ended_at is provided")
		return
	case !hasEnd && hasAnyDuration:
		httpx.WriteError(w, http.StatusUnprocessableEntity, "validation_failed",
			"ended_at is required when durations are provided")
		return
	}
	if hasEnd && req.EndedAt.Before(req.StartedAt) {
		httpx.WriteError(w, http.StatusUnprocessableEntity, "validation_failed", "ended_at must be >= started_at")
		return
	}

	var id uuid.UUID
	if req.ID != nil && *req.ID != uuid.Nil {
		id = *req.ID
	} else {
		id = uuidx.NewV7()
	}

	// At most one open session per baby. We check before insert; the
	// idempotent-replay case (same client id) is allowed by excluding the
	// would-be-row's id from the lookup. There's a small TOCTOU window if
	// two concurrent clients both try to start a session, but a single
	// user driving the UI is the only realistic caller and the narrow race
	// is preferable to a CHECK / partial unique index migration this slice
	// is explicitly avoiding.
	openSession := !hasEnd
	if openSession {
		var existing uuid.UUID
		err := h.store.Pool.QueryRow(r.Context(), `
			SELECT id FROM nursing_sessions
			WHERE baby_id = $1 AND ended_at IS NULL AND id <> $2
			LIMIT 1
		`, babyID, id).Scan(&existing)
		switch {
		case err == nil:
			httpx.WriteError(w, http.StatusConflict, "open_session_exists",
				"a nursing session is already in progress for this baby")
			return
		case errors.Is(err, pgx.ErrNoRows):
			// no open session — proceed
		default:
			h.logger.Error("check open nursing", "err", err)
			httpx.WriteError(w, http.StatusInternalServerError, "internal", "could not check open session")
			return
		}
	}

	// nursing_sessions.left_duration_s / right_duration_s are NOT NULL with
	// default 0; for open sessions we explicitly insert 0 so closing the
	// row later is a plain UPDATE (no need to re-derive the columns from
	// per-side input).
	var leftDur, rightDur int
	if req.LeftDurationS != nil {
		leftDur = *req.LeftDurationS
	}
	if req.RightDurationS != nil {
		rightDur = *req.RightDurationS
	}

	// Idempotent insert: identical client id returns the existing row.
	var out Nursing
	err = h.store.Pool.QueryRow(r.Context(), `
		WITH ins AS (
			INSERT INTO nursing_sessions (
				id, baby_id, started_at, ended_at, starting_breast, nursing_side,
				left_duration_s, right_duration_s, notes, source, created_by_user_id
			)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'manual', $10)
			ON CONFLICT (id) DO NOTHING
			RETURNING id, baby_id, started_at, ended_at, starting_breast, nursing_side,
				left_duration_s, right_duration_s, notes, source, created_at
		)
		SELECT id, baby_id, started_at, ended_at, starting_breast, nursing_side,
			left_duration_s, right_duration_s, notes, source, created_at FROM ins
		UNION ALL
		SELECT id, baby_id, started_at, ended_at, starting_breast, nursing_side,
			left_duration_s, right_duration_s, notes, source, created_at
		FROM nursing_sessions WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM ins)
	`, id, babyID, req.StartedAt, req.EndedAt, req.StartingBreast, req.NursingSide,
		leftDur, rightDur, req.Notes, uid).
		Scan(&out.ID, &out.BabyID, &out.StartedAt, &out.EndedAt, &out.StartingBreast, &out.NursingSide,
			&out.LeftDurationS, &out.RightDurationS, &out.Notes, &out.Source, &out.CreatedAt)
	if err != nil {
		h.logger.Error("insert nursing", "err", err)
		httpx.WriteError(w, http.StatusInternalServerError, "internal", "could not create nursing session")
		return
	}
	httpx.WriteJSON(w, http.StatusCreated, out)
}

func (h *Handler) list(w http.ResponseWriter, r *http.Request) {
	uid := auth.UserIDFrom(r.Context())
	babyID, err := uuid.Parse(chi.URLParam(r, "babyID"))
	if err != nil {
		httpx.WriteError(w, http.StatusBadRequest, "bad_id", "invalid baby id")
		return
	}
	if _, err := baby.MustOwnBaby(r.Context(), h.store, uid, babyID); err != nil {
		writeBabyAuthErr(w, err)
		return
	}

	from, to, err := parseRange(r)
	if err != nil {
		httpx.WriteError(w, http.StatusBadRequest, "bad_range", err.Error())
		return
	}
	limit := 200
	if l := r.URL.Query().Get("limit"); l != "" {
		if n, err := strconv.Atoi(l); err == nil && n > 0 && n <= 1000 {
			limit = n
		}
	}

	rows, err := h.store.Pool.Query(r.Context(), `
		SELECT id, baby_id, started_at, ended_at, starting_breast, nursing_side,
			left_duration_s, right_duration_s, notes, source, created_at
		FROM nursing_sessions
		WHERE baby_id = $1 AND started_at >= $2 AND started_at < $3
		ORDER BY started_at DESC
		LIMIT $4
	`, babyID, from, to, limit)
	if err != nil {
		h.logger.Error("list nursing", "err", err)
		httpx.WriteError(w, http.StatusInternalServerError, "internal", "list failed")
		return
	}
	defer rows.Close()
	out := make([]Nursing, 0, 32)
	for rows.Next() {
		var n Nursing
		if err := rows.Scan(&n.ID, &n.BabyID, &n.StartedAt, &n.EndedAt, &n.StartingBreast, &n.NursingSide,
			&n.LeftDurationS, &n.RightDurationS, &n.Notes, &n.Source, &n.CreatedAt); err != nil {
			h.logger.Error("scan nursing", "err", err)
			httpx.WriteError(w, http.StatusInternalServerError, "internal", "scan failed")
			return
		}
		out = append(out, n)
	}
	httpx.WriteJSON(w, http.StatusOK, out)
}

// getOpen returns the most-recent open session for this baby, or 204 if
// none. The Today screen polls this on render so the in-progress chip is
// trivial to derive without scanning the full per-day list.
func (h *Handler) getOpen(w http.ResponseWriter, r *http.Request) {
	uid := auth.UserIDFrom(r.Context())
	babyID, err := uuid.Parse(chi.URLParam(r, "babyID"))
	if err != nil {
		httpx.WriteError(w, http.StatusBadRequest, "bad_id", "invalid baby id")
		return
	}
	if _, err := baby.MustOwnBaby(r.Context(), h.store, uid, babyID); err != nil {
		writeBabyAuthErr(w, err)
		return
	}

	var n Nursing
	err = h.store.Pool.QueryRow(r.Context(), `
		SELECT id, baby_id, started_at, ended_at, starting_breast, nursing_side,
			left_duration_s, right_duration_s, notes, source, created_at
		FROM nursing_sessions
		WHERE baby_id = $1 AND ended_at IS NULL
		ORDER BY started_at DESC
		LIMIT 1
	`, babyID).Scan(&n.ID, &n.BabyID, &n.StartedAt, &n.EndedAt, &n.StartingBreast, &n.NursingSide,
		&n.LeftDurationS, &n.RightDurationS, &n.Notes, &n.Source, &n.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if err != nil {
		h.logger.Error("get open nursing", "err", err)
		httpx.WriteError(w, http.StatusInternalServerError, "internal", "lookup failed")
		return
	}
	httpx.WriteJSON(w, http.StatusOK, n)
}

// endReq is the PATCH body for closing an open session. All three fields
// are required: PATCH IS the close transition, so accepting partial input
// would either leave the row half-closed or require a separate "abandon"
// path that this slice doesn't ship.
type endReq struct {
	EndedAt        time.Time `json:"ended_at" validate:"required"`
	LeftDurationS  *int      `json:"left_duration_s" validate:"required,gte=0,lte=21600"`
	RightDurationS *int      `json:"right_duration_s" validate:"required,gte=0,lte=21600"`
}

func (h *Handler) end(w http.ResponseWriter, r *http.Request) {
	uid := auth.UserIDFrom(r.Context())
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.WriteError(w, http.StatusBadRequest, "bad_id", "invalid id")
		return
	}

	// Look up the row first so we can authz against its baby's household
	// AND short-circuit on already-closed before doing any work.
	var (
		babyID    uuid.UUID
		startedAt time.Time
		endedAt   *time.Time
	)
	err = h.store.Pool.QueryRow(r.Context(), `
		SELECT baby_id, started_at, ended_at FROM nursing_sessions WHERE id = $1
	`, id).Scan(&babyID, &startedAt, &endedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.WriteError(w, http.StatusNotFound, "not_found", "nursing session not found")
		return
	}
	if err != nil {
		h.logger.Error("lookup nursing for end", "err", err)
		httpx.WriteError(w, http.StatusInternalServerError, "internal", "lookup failed")
		return
	}
	if _, err := baby.MustOwnBaby(r.Context(), h.store, uid, babyID); err != nil {
		writeBabyAuthErr(w, err)
		return
	}
	if endedAt != nil {
		httpx.WriteError(w, http.StatusConflict, "already_closed",
			"nursing session is already closed")
		return
	}

	var req endReq
	if err := httpx.DecodeJSON(r, &req); err != nil {
		httpx.WriteError(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	if err := h.v.Struct(req); err != nil {
		httpx.WriteError(w, http.StatusUnprocessableEntity, "validation_failed", err.Error())
		return
	}
	if req.EndedAt.Before(startedAt) {
		httpx.WriteError(w, http.StatusUnprocessableEntity, "validation_failed", "ended_at must be >= started_at")
		return
	}

	var out Nursing
	err = h.store.Pool.QueryRow(r.Context(), `
		UPDATE nursing_sessions
		SET ended_at = $2, left_duration_s = $3, right_duration_s = $4
		WHERE id = $1 AND ended_at IS NULL
		RETURNING id, baby_id, started_at, ended_at, starting_breast, nursing_side,
			left_duration_s, right_duration_s, notes, source, created_at
	`, id, req.EndedAt, *req.LeftDurationS, *req.RightDurationS).
		Scan(&out.ID, &out.BabyID, &out.StartedAt, &out.EndedAt, &out.StartingBreast, &out.NursingSide,
			&out.LeftDurationS, &out.RightDurationS, &out.Notes, &out.Source, &out.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		// Lost the race: someone closed the row between our lookup and
		// our UPDATE. Surface the same 409 the up-front check would have.
		httpx.WriteError(w, http.StatusConflict, "already_closed",
			"nursing session is already closed")
		return
	}
	if err != nil {
		h.logger.Error("update nursing", "err", err)
		httpx.WriteError(w, http.StatusInternalServerError, "internal", "could not close nursing session")
		return
	}
	httpx.WriteJSON(w, http.StatusOK, out)
}

func (h *Handler) delete(w http.ResponseWriter, r *http.Request) {
	uid := auth.UserIDFrom(r.Context())
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.WriteError(w, http.StatusBadRequest, "bad_id", "invalid id")
		return
	}
	var babyID uuid.UUID
	err = h.store.Pool.QueryRow(r.Context(), `SELECT baby_id FROM nursing_sessions WHERE id = $1`, id).Scan(&babyID)
	if errors.Is(err, pgx.ErrNoRows) {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if err != nil {
		h.logger.Error("lookup nursing", "err", err)
		httpx.WriteError(w, http.StatusInternalServerError, "internal", "lookup failed")
		return
	}
	if _, err := baby.MustOwnBaby(r.Context(), h.store, uid, babyID); err != nil {
		writeBabyAuthErr(w, err)
		return
	}
	_, err = h.store.Pool.Exec(r.Context(), `DELETE FROM nursing_sessions WHERE id = $1`, id)
	if err != nil {
		h.logger.Error("delete nursing", "err", err)
		httpx.WriteError(w, http.StatusInternalServerError, "internal", "delete failed")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func parseRange(r *http.Request) (time.Time, time.Time, error) {
	q := r.URL.Query()
	now := time.Now().UTC()
	from := now.Add(-24 * time.Hour)
	to := now.Add(24 * time.Hour)
	if s := q.Get("from"); s != "" {
		t, err := time.Parse(time.RFC3339, s)
		if err != nil {
			return time.Time{}, time.Time{}, errors.New("from must be RFC3339")
		}
		from = t
	}
	if s := q.Get("to"); s != "" {
		t, err := time.Parse(time.RFC3339, s)
		if err != nil {
			return time.Time{}, time.Time{}, errors.New("to must be RFC3339")
		}
		to = t
	}
	if !from.Before(to) {
		return time.Time{}, time.Time{}, errors.New("from must be before to")
	}
	return from, to, nil
}

func writeBabyAuthErr(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, baby.ErrNotFound):
		httpx.WriteError(w, http.StatusNotFound, "not_found", "baby not found")
	case errors.Is(err, baby.ErrUnauthorized):
		httpx.WriteError(w, http.StatusForbidden, "forbidden", "not a member of this household")
	default:
		httpx.WriteError(w, http.StatusInternalServerError, "internal", err.Error())
	}
}
