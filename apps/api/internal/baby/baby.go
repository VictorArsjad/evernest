// Package baby manages babies inside a household. CP1 covers create + list +
// fetch-by-id with household-membership authorization. Settings UI ships in
// CP4 but we already insert a default baby_settings row at create-time so
// no migration backfill is needed later.
package baby

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-playground/validator/v10"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/varsjad/evernest/apps/api/internal/auth"
	"github.com/varsjad/evernest/apps/api/internal/household"
	"github.com/varsjad/evernest/apps/api/internal/httpx"
	"github.com/varsjad/evernest/apps/api/internal/store"
)

type Baby struct {
	ID          uuid.UUID  `json:"id"`
	HouseholdID uuid.UUID  `json:"household_id"`
	Name        string     `json:"name"`
	DateOfBirth *time.Time `json:"date_of_birth,omitempty"`
	Sex         *string    `json:"sex,omitempty"`
	CreatedAt   time.Time  `json:"created_at"`
}

var (
	ErrNotFound    = errors.New("baby not found")
	ErrUnauthorized = errors.New("not authorized")
)

// MustOwnBaby looks up the baby's household and verifies the user is a member.
// Returns the baby on success. Other packages use this for per-event-route
// authorization.
func MustOwnBaby(ctx context.Context, st *store.Store, userID, babyID uuid.UUID) (Baby, error) {
	var b Baby
	err := st.Pool.QueryRow(ctx, `
		SELECT id, household_id, name, date_of_birth, sex, created_at
		FROM babies WHERE id = $1
	`, babyID).Scan(&b.ID, &b.HouseholdID, &b.Name, &b.DateOfBirth, &b.Sex, &b.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return b, ErrNotFound
	}
	if err != nil {
		return b, err
	}
	if err := household.MustBeMember(ctx, st, userID, b.HouseholdID); err != nil {
		return b, ErrUnauthorized
	}
	return b, nil
}

type Handler struct {
	store  *store.Store
	logger *slog.Logger
	v      *validator.Validate
}

func NewHandler(st *store.Store, logger *slog.Logger) *Handler {
	return &Handler{store: st, logger: logger, v: validator.New(validator.WithRequiredStructEnabled())}
}

// HouseholdRoutes mounts under /v1/households/{householdID}.
func (h *Handler) HouseholdRoutes(r chi.Router) {
	r.Post("/babies", h.create)
	r.Get("/babies", h.list)
}

// BabyRoutes mounts under /v1/babies/{babyID}.
func (h *Handler) BabyRoutes(r chi.Router) {
	r.Get("/", h.get)
}

type createReq struct {
	Name        string  `json:"name" validate:"required,min=1,max=80"`
	DateOfBirth *string `json:"date_of_birth,omitempty"`
	Sex         *string `json:"sex,omitempty" validate:"omitempty,oneof=female male unspecified"`
}

func (h *Handler) create(w http.ResponseWriter, r *http.Request) {
	uid := auth.UserIDFrom(r.Context())

	householdID, err := uuid.Parse(chi.URLParam(r, "householdID"))
	if err != nil {
		httpx.WriteError(w, http.StatusBadRequest, "bad_id", "invalid household id")
		return
	}
	if err := household.MustBeMember(r.Context(), h.store, uid, householdID); err != nil {
		writeMembershipErr(w, err)
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

	var dobArg any
	if req.DateOfBirth != nil && *req.DateOfBirth != "" {
		dob, err := time.Parse("2006-01-02", *req.DateOfBirth)
		if err != nil {
			httpx.WriteError(w, http.StatusUnprocessableEntity, "validation_failed", "date_of_birth must be YYYY-MM-DD")
			return
		}
		dobArg = dob
	}

	tx, err := h.store.Pool.Begin(r.Context())
	if err != nil {
		h.logger.Error("begin tx", "err", err)
		httpx.WriteError(w, http.StatusInternalServerError, "internal", "tx begin")
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	var b Baby
	b.HouseholdID = householdID
	err = tx.QueryRow(r.Context(), `
		INSERT INTO babies (household_id, name, date_of_birth, sex, created_by)
		VALUES ($1, $2, $3, $4, $5)
		RETURNING id, name, date_of_birth, sex, created_at
	`, householdID, req.Name, dobArg, req.Sex, uid).Scan(&b.ID, &b.Name, &b.DateOfBirth, &b.Sex, &b.CreatedAt)
	if err != nil {
		h.logger.Error("insert baby", "err", err)
		httpx.WriteError(w, http.StatusInternalServerError, "internal", "could not create baby")
		return
	}
	// Seed default settings; CP4 will expose a PATCH for these.
	_, err = tx.Exec(r.Context(), `
		INSERT INTO baby_settings (baby_id) VALUES ($1)
	`, b.ID)
	if err != nil {
		h.logger.Error("seed baby_settings", "err", err)
		httpx.WriteError(w, http.StatusInternalServerError, "internal", "could not seed settings")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		h.logger.Error("commit", "err", err)
		httpx.WriteError(w, http.StatusInternalServerError, "internal", "tx commit")
		return
	}

	httpx.WriteJSON(w, http.StatusCreated, b)
}

func (h *Handler) list(w http.ResponseWriter, r *http.Request) {
	uid := auth.UserIDFrom(r.Context())
	householdID, err := uuid.Parse(chi.URLParam(r, "householdID"))
	if err != nil {
		httpx.WriteError(w, http.StatusBadRequest, "bad_id", "invalid household id")
		return
	}
	if err := household.MustBeMember(r.Context(), h.store, uid, householdID); err != nil {
		writeMembershipErr(w, err)
		return
	}
	rows, err := h.store.Pool.Query(r.Context(), `
		SELECT id, household_id, name, date_of_birth, sex, created_at
		FROM babies WHERE household_id = $1 ORDER BY created_at ASC
	`, householdID)
	if err != nil {
		h.logger.Error("list babies", "err", err)
		httpx.WriteError(w, http.StatusInternalServerError, "internal", "list failed")
		return
	}
	defer rows.Close()
	out := make([]Baby, 0, 4)
	for rows.Next() {
		var b Baby
		if err := rows.Scan(&b.ID, &b.HouseholdID, &b.Name, &b.DateOfBirth, &b.Sex, &b.CreatedAt); err != nil {
			h.logger.Error("scan baby", "err", err)
			httpx.WriteError(w, http.StatusInternalServerError, "internal", "scan failed")
			return
		}
		out = append(out, b)
	}
	httpx.WriteJSON(w, http.StatusOK, out)
}

func (h *Handler) get(w http.ResponseWriter, r *http.Request) {
	uid := auth.UserIDFrom(r.Context())
	babyID, err := uuid.Parse(chi.URLParam(r, "babyID"))
	if err != nil {
		httpx.WriteError(w, http.StatusBadRequest, "bad_id", "invalid baby id")
		return
	}
	b, err := MustOwnBaby(r.Context(), h.store, uid, babyID)
	if errors.Is(err, ErrNotFound) {
		httpx.WriteError(w, http.StatusNotFound, "not_found", "baby not found")
		return
	}
	if errors.Is(err, ErrUnauthorized) {
		httpx.WriteError(w, http.StatusForbidden, "forbidden", "not a member of this household")
		return
	}
	if err != nil {
		h.logger.Error("get baby", "err", err)
		httpx.WriteError(w, http.StatusInternalServerError, "internal", "could not load baby")
		return
	}
	httpx.WriteJSON(w, http.StatusOK, b)
}

func writeMembershipErr(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, household.ErrNotFound):
		httpx.WriteError(w, http.StatusNotFound, "not_found", "household not found")
	case errors.Is(err, household.ErrNotMember):
		httpx.WriteError(w, http.StatusForbidden, "forbidden", "not a member of this household")
	default:
		httpx.WriteError(w, http.StatusInternalServerError, "internal", err.Error())
	}
}
