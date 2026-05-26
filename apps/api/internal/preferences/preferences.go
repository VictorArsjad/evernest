// Package preferences exposes the per-user `user_preferences` row through
// GET/PUT /v1/me/preferences. The four prefs the FE settings screen surfaces
// to the user are split across two tables on purpose:
//
//   - `time_format`, `timezone`, `locale` are inherently per-user and live
//     here.
//   - `unit_volume`, `unit_length`, `unit_weight` are per-baby (one child
//     can be tracked in metric while another is in imperial) and live on
//     `baby_settings` — see baby.SettingsRoutes for those.
//
// PUT is full-replace (not PATCH): the FE always submits all fields, so the
// API stays simple and partial-update merge logic stays out of it. The row
// is seeded at user-create time (auth.CreateUser does an INSERT into
// user_preferences alongside the user insert) so a freshly-registered user
// always has defaults available.
package preferences

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
	"github.com/varsjad/evernest/apps/api/internal/httpx"
	"github.com/varsjad/evernest/apps/api/internal/store"
)

// UserPreferences mirrors the user_preferences row shape returned to the FE.
// Field tags match the schema column names so the FE can deserialize without
// remapping.
type UserPreferences struct {
	UserID     uuid.UUID `json:"user_id"`
	TimeFormat string    `json:"time_format"`
	Timezone   string    `json:"timezone"`
	Locale     string    `json:"locale"`
	UpdatedAt  time.Time `json:"updated_at"`
}

type Handler struct {
	store  *store.Store
	logger *slog.Logger
	v      *validator.Validate
}

func NewHandler(st *store.Store, logger *slog.Logger) *Handler {
	return &Handler{store: st, logger: logger, v: validator.New(validator.WithRequiredStructEnabled())}
}

// MeRoutes mounts under /v1/me. Caller is expected to wrap the parent in
// auth.RequireUser.
func (h *Handler) MeRoutes(r chi.Router) {
	r.Get("/preferences", h.get)
	r.Put("/preferences", h.put)
}

func (h *Handler) get(w http.ResponseWriter, r *http.Request) {
	uid := auth.UserIDFrom(r.Context())
	prefs, err := loadOrSeed(r.Context(), h.store, uid)
	if err != nil {
		h.logger.Error("load preferences", "err", err)
		httpx.WriteError(w, http.StatusInternalServerError, "internal", "could not load preferences")
		return
	}
	httpx.WriteJSON(w, http.StatusOK, prefs)
}

// putReq is the full-replace payload. We use string fields with `oneof` tags
// rather than custom enum types because validator/v10 already enforces the
// allowed values and the JSON shape stays trivial.
type putReq struct {
	TimeFormat string `json:"time_format" validate:"required,oneof=24h 12h"`
	Timezone   string `json:"timezone" validate:"required,min=1,max=64"`
	Locale     string `json:"locale" validate:"required,min=2,max=16"`
}

func (h *Handler) put(w http.ResponseWriter, r *http.Request) {
	uid := auth.UserIDFrom(r.Context())
	var req putReq
	if err := httpx.DecodeJSON(r, &req); err != nil {
		httpx.WriteError(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	if err := h.v.Struct(req); err != nil {
		httpx.WriteError(w, http.StatusUnprocessableEntity, "validation_failed", err.Error())
		return
	}
	// IANA tz validation: rather than ship a hard-coded allowlist, defer
	// to the standard library which loads from the system zoneinfo. The
	// CHECK on time_format inside the DB is also defended at the
	// validator level above, but a bad tz would only surface as a 500
	// the next time the FE rendered with it; better to fail fast here.
	if _, err := time.LoadLocation(req.Timezone); err != nil {
		httpx.WriteError(w, http.StatusUnprocessableEntity, "validation_failed", "invalid timezone: must be IANA tz name")
		return
	}

	var prefs UserPreferences
	prefs.UserID = uid
	err := h.store.Pool.QueryRow(r.Context(), `
		INSERT INTO user_preferences (user_id, time_format, timezone, locale)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (user_id) DO UPDATE
		   SET time_format = EXCLUDED.time_format,
		       timezone    = EXCLUDED.timezone,
		       locale      = EXCLUDED.locale
		RETURNING user_id, time_format, timezone, locale, updated_at
	`, uid, req.TimeFormat, req.Timezone, req.Locale).Scan(
		&prefs.UserID, &prefs.TimeFormat, &prefs.Timezone, &prefs.Locale, &prefs.UpdatedAt,
	)
	if err != nil {
		h.logger.Error("upsert preferences", "err", err)
		httpx.WriteError(w, http.StatusInternalServerError, "internal", "could not save preferences")
		return
	}
	httpx.WriteJSON(w, http.StatusOK, prefs)
}

// loadOrSeed returns the user's preferences row, inserting defaults if it
// somehow doesn't exist (older users created before the auto-seed in
// auth.CreateUser shipped). The row is created with column defaults from
// the schema, so the only thing we need to pass is the user_id.
func loadOrSeed(ctx context.Context, st *store.Store, uid uuid.UUID) (UserPreferences, error) {
	var prefs UserPreferences
	err := st.Pool.QueryRow(ctx, `
		SELECT user_id, time_format, timezone, locale, updated_at
		FROM user_preferences WHERE user_id = $1
	`, uid).Scan(&prefs.UserID, &prefs.TimeFormat, &prefs.Timezone, &prefs.Locale, &prefs.UpdatedAt)
	if err == nil {
		return prefs, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return prefs, err
	}
	err = st.Pool.QueryRow(ctx, `
		INSERT INTO user_preferences (user_id) VALUES ($1)
		ON CONFLICT (user_id) DO UPDATE SET user_id = EXCLUDED.user_id
		RETURNING user_id, time_format, timezone, locale, updated_at
	`, uid).Scan(&prefs.UserID, &prefs.TimeFormat, &prefs.Timezone, &prefs.Locale, &prefs.UpdatedAt)
	return prefs, err
}
