// Package growth implements CRUD for growth measurements (weight / height /
// head circumference). Mirrors bottlefeed/diaper/pumping/nursing: POST/GET/
// DELETE with UUIDv7 client-id idempotency and baby-membership authz.
//
// Growth's quirk vs the other event kinds: every measurement is independently
// optional (you might just weigh the baby without re-measuring height), but
// at least one of (weight_g, height_cm, head_circumference_cm) MUST be
// non-NULL and > 0. The DB enforces "at least one non-NULL" via a CHECK; the
// >0 floor is enforced here in Go because BabyPlus stores 0 to mean
// "not measured" and we don't want to silently accept those mistypes from
// the UI.
//
// Canonical units: grams, cm, UTC. The FE converts for display — see
// docs/schema.md.
package growth

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

type Growth struct {
	ID                  uuid.UUID  `json:"id"`
	BabyID              uuid.UUID  `json:"baby_id"`
	MeasuredAt          time.Time  `json:"measured_at"`
	WeightG             *float64   `json:"weight_g,omitempty"`
	HeightCM            *float64   `json:"height_cm,omitempty"`
	HeadCircumferenceCM *float64   `json:"head_circumference_cm,omitempty"`
	Notes               *string    `json:"notes,omitempty"`
	Source              string     `json:"source"`
	CreatedAt           time.Time  `json:"created_at"`
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
	r.Post("/growths", h.create)
	r.Get("/growths", h.list)
}

// ItemRoutes mounts under /v1/growths/{id}.
func (h *Handler) ItemRoutes(r chi.Router) {
	r.Delete("/", h.delete)
}

// Bounds picked to reject obvious mistypes while accepting any plausible
// infant/toddler reading. Newborns are ~3kg/50cm/35cm head; the upper bound
// covers a chunky toddler with margin.
type createReq struct {
	ID                  *uuid.UUID `json:"id,omitempty"`
	MeasuredAt          time.Time  `json:"measured_at" validate:"required"`
	WeightG             *float64   `json:"weight_g,omitempty" validate:"omitempty,gt=0,lt=30000"`
	HeightCM            *float64   `json:"height_cm,omitempty" validate:"omitempty,gt=0,lt=200"`
	HeadCircumferenceCM *float64   `json:"head_circumference_cm,omitempty" validate:"omitempty,gt=0,lt=80"`
	Notes               *string    `json:"notes,omitempty"`
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
	// At least one of the three measurements must be present. The DB has a
	// matching CHECK, but enforcing it here gives a structured 422 instead of
	// a generic 500 on the SQL error.
	if req.WeightG == nil && req.HeightCM == nil && req.HeadCircumferenceCM == nil {
		httpx.WriteError(w, http.StatusUnprocessableEntity, "validation_failed",
			"at least one of weight_g, height_cm, head_circumference_cm is required")
		return
	}

	var id uuid.UUID
	if req.ID != nil && *req.ID != uuid.Nil {
		id = *req.ID
	} else {
		id = uuidx.NewV7()
	}

	// Idempotent insert: identical client id returns the existing row.
	var out Growth
	err = h.store.Pool.QueryRow(r.Context(), `
		WITH ins AS (
			INSERT INTO growths (
				id, baby_id, measured_at, weight_g, height_cm, head_circumference_cm,
				notes, source, created_by_user_id
			)
			VALUES ($1, $2, $3, $4, $5, $6, $7, 'manual', $8)
			ON CONFLICT (id) DO NOTHING
			RETURNING id, baby_id, measured_at, weight_g, height_cm, head_circumference_cm,
				notes, source, created_at
		)
		SELECT id, baby_id, measured_at, weight_g, height_cm, head_circumference_cm,
			notes, source, created_at FROM ins
		UNION ALL
		SELECT id, baby_id, measured_at, weight_g, height_cm, head_circumference_cm,
			notes, source, created_at
		FROM growths WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM ins)
	`, id, babyID, req.MeasuredAt, req.WeightG, req.HeightCM, req.HeadCircumferenceCM,
		req.Notes, uid).
		Scan(&out.ID, &out.BabyID, &out.MeasuredAt, &out.WeightG, &out.HeightCM,
			&out.HeadCircumferenceCM, &out.Notes, &out.Source, &out.CreatedAt)
	if err != nil {
		h.logger.Error("insert growth", "err", err)
		httpx.WriteError(w, http.StatusInternalServerError, "internal", "could not create growth")
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
		SELECT id, baby_id, measured_at, weight_g, height_cm, head_circumference_cm,
			notes, source, created_at
		FROM growths
		WHERE baby_id = $1 AND measured_at >= $2 AND measured_at < $3
		ORDER BY measured_at DESC
		LIMIT $4
	`, babyID, from, to, limit)
	if err != nil {
		h.logger.Error("list growths", "err", err)
		httpx.WriteError(w, http.StatusInternalServerError, "internal", "list failed")
		return
	}
	defer rows.Close()
	out := make([]Growth, 0, 32)
	for rows.Next() {
		var g Growth
		if err := rows.Scan(&g.ID, &g.BabyID, &g.MeasuredAt, &g.WeightG, &g.HeightCM,
			&g.HeadCircumferenceCM, &g.Notes, &g.Source, &g.CreatedAt); err != nil {
			h.logger.Error("scan growth", "err", err)
			httpx.WriteError(w, http.StatusInternalServerError, "internal", "scan failed")
			return
		}
		out = append(out, g)
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
	err = h.store.Pool.QueryRow(r.Context(), `SELECT baby_id FROM growths WHERE id = $1`, id).Scan(&babyID)
	if errors.Is(err, pgx.ErrNoRows) {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if err != nil {
		h.logger.Error("lookup growth", "err", err)
		httpx.WriteError(w, http.StatusInternalServerError, "internal", "lookup failed")
		return
	}
	if _, err := baby.MustOwnBaby(r.Context(), h.store, uid, babyID); err != nil {
		writeBabyAuthErr(w, err)
		return
	}
	_, err = h.store.Pool.Exec(r.Context(), `DELETE FROM growths WHERE id = $1`, id)
	if err != nil {
		h.logger.Error("delete growth", "err", err)
		httpx.WriteError(w, http.StatusInternalServerError, "internal", "delete failed")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func parseRange(r *http.Request) (time.Time, time.Time, error) {
	q := r.URL.Query()
	now := time.Now().UTC()
	// Growth measurements are infrequent (weekly at most), so the default
	// window is wider than the per-day event windows. The Today screen still
	// passes an explicit `from`/`to` for its own filtering.
	from := now.Add(-365 * 24 * time.Hour)
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
