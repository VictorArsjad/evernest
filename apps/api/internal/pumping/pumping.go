// Package pumping implements CRUD for pumping sessions (mother expressing
// milk; no baby is "fed" here, we just track the volume + optional duration).
// Same shape as bottlefeed/diaper: POST/GET/DELETE, UUIDv7 client-id
// idempotency, baby-membership authz.
package pumping

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

type Pumping struct {
	ID              uuid.UUID `json:"id"`
	BabyID          uuid.UUID `json:"baby_id"`
	OccurredAt      time.Time `json:"occurred_at"`
	AmountML        float64   `json:"amount_ml"`
	DurationSeconds *int      `json:"duration_seconds,omitempty"`
	Notes           *string   `json:"notes,omitempty"`
	Source          string    `json:"source"`
	CreatedAt       time.Time `json:"created_at"`
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
	r.Post("/pumpings", h.create)
	r.Get("/pumpings", h.list)
}

// ItemRoutes mounts under /v1/pumpings/{id}.
func (h *Handler) ItemRoutes(r chi.Router) {
	r.Delete("/", h.delete)
}

type createReq struct {
	ID              *uuid.UUID `json:"id,omitempty"`
	OccurredAt      time.Time  `json:"occurred_at" validate:"required"`
	AmountML        float64    `json:"amount_ml" validate:"gte=0,lte=2000"`
	DurationSeconds *int       `json:"duration_seconds,omitempty" validate:"omitempty,gte=0,lte=21600"`
	Notes           *string    `json:"notes,omitempty"`
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

	var id uuid.UUID
	if req.ID != nil && *req.ID != uuid.Nil {
		id = *req.ID
	} else {
		id = uuidx.NewV7()
	}

	var out Pumping
	err = h.store.Pool.QueryRow(r.Context(), `
		WITH ins AS (
			INSERT INTO pumpings (id, baby_id, occurred_at, amount_ml, duration_seconds, notes, source, created_by_user_id)
			VALUES ($1, $2, $3, $4, $5, $6, 'manual', $7)
			ON CONFLICT (id) DO NOTHING
			RETURNING id, baby_id, occurred_at, amount_ml, duration_seconds, notes, source, created_at
		)
		SELECT id, baby_id, occurred_at, amount_ml, duration_seconds, notes, source, created_at FROM ins
		UNION ALL
		SELECT id, baby_id, occurred_at, amount_ml, duration_seconds, notes, source, created_at
		FROM pumpings WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM ins)
	`, id, babyID, req.OccurredAt, req.AmountML, req.DurationSeconds, req.Notes, uid).
		Scan(&out.ID, &out.BabyID, &out.OccurredAt, &out.AmountML, &out.DurationSeconds, &out.Notes, &out.Source, &out.CreatedAt)
	if err != nil {
		h.logger.Error("insert pumping", "err", err)
		httpx.WriteError(w, http.StatusInternalServerError, "internal", "could not create pumping")
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
		SELECT id, baby_id, occurred_at, amount_ml, duration_seconds, notes, source, created_at
		FROM pumpings
		WHERE baby_id = $1 AND occurred_at >= $2 AND occurred_at < $3
		ORDER BY occurred_at DESC
		LIMIT $4
	`, babyID, from, to, limit)
	if err != nil {
		h.logger.Error("list pumpings", "err", err)
		httpx.WriteError(w, http.StatusInternalServerError, "internal", "list failed")
		return
	}
	defer rows.Close()
	out := make([]Pumping, 0, 32)
	for rows.Next() {
		var p Pumping
		if err := rows.Scan(&p.ID, &p.BabyID, &p.OccurredAt, &p.AmountML, &p.DurationSeconds, &p.Notes, &p.Source, &p.CreatedAt); err != nil {
			h.logger.Error("scan pumping", "err", err)
			httpx.WriteError(w, http.StatusInternalServerError, "internal", "scan failed")
			return
		}
		out = append(out, p)
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
	err = h.store.Pool.QueryRow(r.Context(), `SELECT baby_id FROM pumpings WHERE id = $1`, id).Scan(&babyID)
	if errors.Is(err, pgx.ErrNoRows) {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if err != nil {
		h.logger.Error("lookup pumping", "err", err)
		httpx.WriteError(w, http.StatusInternalServerError, "internal", "lookup failed")
		return
	}
	if _, err := baby.MustOwnBaby(r.Context(), h.store, uid, babyID); err != nil {
		writeBabyAuthErr(w, err)
		return
	}
	_, err = h.store.Pool.Exec(r.Context(), `DELETE FROM pumpings WHERE id = $1`, id)
	if err != nil {
		h.logger.Error("delete pumping", "err", err)
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
