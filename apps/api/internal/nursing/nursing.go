// Package nursing implements CRUD for nursing sessions (baby fed at the
// breast). Mirrors bottlefeed/diaper/pumping: POST/GET/DELETE with UUIDv7
// client-id idempotency and baby-membership authz. Nursing has its own
// shape because the schema is fundamentally different from bottle feeds
// (duration + side, no volume) — see docs/schema.md.
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
	ID              uuid.UUID  `json:"id"`
	BabyID          uuid.UUID  `json:"baby_id"`
	StartedAt       time.Time  `json:"started_at"`
	EndedAt         *time.Time `json:"ended_at,omitempty"`
	StartingBreast  *string    `json:"starting_breast,omitempty"`
	NursingSide     string     `json:"nursing_side"`
	LeftDurationS   int        `json:"left_duration_s"`
	RightDurationS  int        `json:"right_duration_s"`
	Notes           *string    `json:"notes,omitempty"`
	Source          string     `json:"source"`
	CreatedAt       time.Time  `json:"created_at"`
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
}

// ItemRoutes mounts under /v1/nursing-sessions/{id}.
func (h *Handler) ItemRoutes(r chi.Router) {
	r.Delete("/", h.delete)
}

type createReq struct {
	ID             *uuid.UUID `json:"id,omitempty"`
	StartedAt      time.Time  `json:"started_at" validate:"required"`
	EndedAt        *time.Time `json:"ended_at,omitempty"`
	StartingBreast *string    `json:"starting_breast,omitempty" validate:"omitempty,oneof=left right"`
	NursingSide    string     `json:"nursing_side" validate:"required,oneof=left right both"`
	LeftDurationS  int        `json:"left_duration_s" validate:"gte=0,lte=21600"`
	RightDurationS int        `json:"right_duration_s" validate:"gte=0,lte=21600"`
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
	if req.EndedAt != nil && req.EndedAt.Before(req.StartedAt) {
		httpx.WriteError(w, http.StatusUnprocessableEntity, "validation_failed", "ended_at must be >= started_at")
		return
	}

	var id uuid.UUID
	if req.ID != nil && *req.ID != uuid.Nil {
		id = *req.ID
	} else {
		id = uuidx.NewV7()
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
		req.LeftDurationS, req.RightDurationS, req.Notes, uid).
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
