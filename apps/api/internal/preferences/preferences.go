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
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"regexp"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-playground/validator/v10"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/varsjad/evernest/apps/api/internal/auth"
	"github.com/varsjad/evernest/apps/api/internal/httpx"
	"github.com/varsjad/evernest/apps/api/internal/store"
)

// ChartPalette is the per-user chart color configuration. Persisted as a
// single JSONB column on user_preferences. Preset is the curated baseline
// (default matches today's hard-coded chart fills verbatim) and Overrides
// is a sparse map of series-key -> "#rrggbb" that wins over the preset on
// the FE side.
//
// Overrides keys are validated against a closed allowlist (see
// allowedSeriesKeys) in the PUT handler — validator/v10 can enforce the
// preset oneof but doesn't have first-class map-key validation, so the key
// + hex check happens after the struct validator pass.
type ChartPalette struct {
	Preset    string            `json:"preset" validate:"required,oneof=default warm pastel high_contrast colorblind"`
	Overrides map[string]string `json:"overrides"`
}

// UserPreferences mirrors the user_preferences row shape returned to the FE.
// Field tags match the schema column names so the FE can deserialize without
// remapping.
type UserPreferences struct {
	UserID     uuid.UUID `json:"user_id"`
	TimeFormat string    `json:"time_format"`
	Timezone   string    `json:"timezone"`
	Locale     string    `json:"locale"`
	// ShowRecommendedTargets gates the FE Today-banner's per-metric progress
	// bars (today vs. age-based daily target). Defaults to true server-side;
	// users opt out via the settings screen. Stored as a boolean column on
	// user_preferences (added in migration 000007).
	ShowRecommendedTargets bool `json:"show_recommended_targets"`
	// ChartPalette controls the /charts page series colors. Persisted as a
	// jsonb column added in migration 000008; the column default
	// ({preset:"default", overrides:{}}) keeps legacy rows visually
	// identical to today.
	ChartPalette ChartPalette `json:"chart_palette"`
	// FeatureVisibility lets the user hide event kinds (bottle / nursing /
	// pumping / diaper / growth) from the Today banner stats, the action
	// tile grid, and the /charts cards WITHOUT touching the underlying data.
	// Stored sparsely on a jsonb column (migration 000009): a key only
	// appears when explicitly hidden, e.g. {"bottle": false}. Missing key ⇒
	// visible. Default '{}' keeps every existing user fully unchanged.
	FeatureVisibility map[string]bool `json:"feature_visibility"`
	// AutofillBottleAmount gates the FE bottle-feed log form's
	// prefill-the-Amount-field-from-recent-feeds behavior. Defaults to true
	// server-side (boolean column added in migration 000010); users opt out
	// via the settings screen. Mirrors the ShowRecommendedTargets
	// preserve-on-omit precedent on PUT.
	AutofillBottleAmount bool      `json:"autofill_bottle_amount"`
	UpdatedAt            time.Time `json:"updated_at"`
}

// allowedSeriesKeys is the closed allowlist for ChartPalette.Overrides keys.
// Any key outside this set is rejected with 422. The set matches the FE's
// SeriesKey union so adding a new chart series is a coordinated FE+BE
// change rather than something a malformed PUT can sneak in.
var allowedSeriesKeys = map[string]struct{}{
	"bottle_breast":  {},
	"bottle_formula": {},
	"nursing":        {},
	"pumping":        {},
	"diaper_wet":     {},
	"diaper_soiled":  {},
	"diaper_mixed":   {},
	"weight":         {},
}

// hexColorRe matches the canonical 6-digit hex color form the FE color
// input emits. We intentionally do not accept 3-digit shorthand or named
// colors — the FE only ever writes the long form, and accepting other
// shapes here would mean the resolved color on the FE depends on which
// browser parsed the value last.
var hexColorRe = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

// validateChartPalette runs the post-validator key/hex checks. Returns an
// empty string on success or a user-facing reason on failure.
func validateChartPalette(p ChartPalette) string {
	for key, color := range p.Overrides {
		if _, ok := allowedSeriesKeys[key]; !ok {
			return "chart_palette.overrides: unknown series key " + key
		}
		if !hexColorRe.MatchString(color) {
			return "chart_palette.overrides[" + key + "]: must be #rrggbb"
		}
	}
	return ""
}

// allowedFeatureKeys is the closed allowlist for FeatureVisibility map keys.
// Any key outside this set is rejected with 422. The set matches the FE's
// FeatureKey union — adding a new event kind is a coordinated FE+BE change,
// not something a malformed PUT can sneak in.
var allowedFeatureKeys = map[string]struct{}{
	"bottle":  {},
	"nursing": {},
	"pumping": {},
	"diaper":  {},
	"growth":  {},
}

// validateFeatureVisibility runs the post-validator key check. Values are
// already constrained to bool by the JSON decoder (non-bool inputs fail
// httpx.DecodeJSON with a 400), so we only need to guard the key set here.
func validateFeatureVisibility(m map[string]bool) string {
	for key := range m {
		if _, ok := allowedFeatureKeys[key]; !ok {
			return "feature_visibility: unknown feature key " + key
		}
	}
	return ""
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
//
// ShowRecommendedTargets is a pointer so we can tell "client omitted this
// field" (older FE builds) from "client explicitly sent false" — in the
// former case we preserve the existing value rather than silently flipping
// it back to true. The other fields are required because they've always
// been part of the contract.
//
// ChartPalette is required (no preserve-on-omit) because the FE always
// reads the current value first and round-trips it on every save; an
// omitted chart_palette is a bug in the FE, not a legitimate "leave as
// is" signal. The struct's inner `oneof` on Preset enforces the preset
// enum, and the post-validator pass in put() enforces the overrides
// shape.
//
// FeatureVisibility follows the same "FE always round-trips" rule —
// `validate:"required"` on a map enforces non-nil (empty `{}` is the
// default and passes). The key allowlist is enforced post-validator in
// validateFeatureVisibility.
//
// AutofillBottleAmount is a pointer for the same "omitted vs explicit
// false" reason as ShowRecommendedTargets: a `validate:"required"` tag on
// a bool can't distinguish them (false is the zero value), so we preserve
// the existing row value on omit via COALESCE rather than flipping it.
type putReq struct {
	TimeFormat             string          `json:"time_format" validate:"required,oneof=24h 12h"`
	Timezone               string          `json:"timezone" validate:"required,min=1,max=64"`
	Locale                 string          `json:"locale" validate:"required,min=2,max=16"`
	ShowRecommendedTargets *bool           `json:"show_recommended_targets,omitempty"`
	ChartPalette           ChartPalette    `json:"chart_palette" validate:"required"`
	FeatureVisibility      map[string]bool `json:"feature_visibility" validate:"required"`
	AutofillBottleAmount   *bool           `json:"autofill_bottle_amount,omitempty"`
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
	if msg := validateChartPalette(req.ChartPalette); msg != "" {
		httpx.WriteError(w, http.StatusUnprocessableEntity, "validation_failed", msg)
		return
	}
	if msg := validateFeatureVisibility(req.FeatureVisibility); msg != "" {
		httpx.WriteError(w, http.StatusUnprocessableEntity, "validation_failed", msg)
		return
	}

	// pgx accepts a []byte for a jsonb parameter and writes it as raw
	// JSON. Marshalling here (rather than relying on pgx's reflection
	// path on the struct) keeps the wire bytes obviously correct and
	// guarantees `overrides: nil` lands as `{}` on disk — see
	// chartPaletteToJSON.
	paletteJSON, err := chartPaletteToJSON(req.ChartPalette)
	if err != nil {
		// Shouldn't happen: the inputs are all strings + a map of
		// strings, both of which always marshal cleanly. Treat as a
		// 500 so it's loud if it ever does.
		h.logger.Error("marshal chart_palette", "err", err)
		httpx.WriteError(w, http.StatusInternalServerError, "internal", "could not encode chart_palette")
		return
	}
	featureJSON, err := featureVisibilityToJSON(req.FeatureVisibility)
	if err != nil {
		h.logger.Error("marshal feature_visibility", "err", err)
		httpx.WriteError(w, http.StatusInternalServerError, "internal", "could not encode feature_visibility")
		return
	}

	// When the client omits show_recommended_targets (older FE builds) we
	// preserve whatever's already on the row. COALESCE on the conflict
	// path against $5 (which is NULL in that case) leaves the existing
	// value untouched; on initial insert the column default of TRUE
	// applies because COALESCE(NULL, NULL) keeps NULL out of the column
	// and the schema default kicks in only for omitted columns. To get
	// that behavior reliably we branch the SQL on whether the pointer
	// is nil rather than passing NULL.
	var prefs UserPreferences
	prefs.UserID = uid
	var paletteRaw []byte
	var featureRaw []byte
	// autofill_bottle_amount uses the same preserve-on-omit semantics as
	// show_recommended_targets but via COALESCE rather than a second SQL
	// branch (two independent optional bools would otherwise be four
	// branches). On INSERT a NULL param falls back to the column default
	// (TRUE); on UPDATE it falls back to the existing row value — so we
	// reference the table column directly, NOT EXCLUDED, on the conflict
	// path.
	if req.ShowRecommendedTargets != nil {
		err = h.store.Pool.QueryRow(r.Context(), `
			INSERT INTO user_preferences (user_id, time_format, timezone, locale, show_recommended_targets, chart_palette, feature_visibility, autofill_bottle_amount)
			VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, TRUE))
			ON CONFLICT (user_id) DO UPDATE
			   SET time_format              = EXCLUDED.time_format,
			       timezone                 = EXCLUDED.timezone,
			       locale                   = EXCLUDED.locale,
			       show_recommended_targets = EXCLUDED.show_recommended_targets,
			       chart_palette            = EXCLUDED.chart_palette,
			       feature_visibility       = EXCLUDED.feature_visibility,
			       autofill_bottle_amount   = COALESCE($8, user_preferences.autofill_bottle_amount)
			RETURNING user_id, time_format, timezone, locale, show_recommended_targets, chart_palette, feature_visibility, autofill_bottle_amount, updated_at
		`, uid, req.TimeFormat, req.Timezone, req.Locale, *req.ShowRecommendedTargets, paletteJSON, featureJSON, req.AutofillBottleAmount).Scan(
			&prefs.UserID, &prefs.TimeFormat, &prefs.Timezone, &prefs.Locale, &prefs.ShowRecommendedTargets, &paletteRaw, &featureRaw, &prefs.AutofillBottleAmount, &prefs.UpdatedAt,
		)
	} else {
		err = h.store.Pool.QueryRow(r.Context(), `
			INSERT INTO user_preferences (user_id, time_format, timezone, locale, chart_palette, feature_visibility, autofill_bottle_amount)
			VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, TRUE))
			ON CONFLICT (user_id) DO UPDATE
			   SET time_format            = EXCLUDED.time_format,
			       timezone               = EXCLUDED.timezone,
			       locale                 = EXCLUDED.locale,
			       chart_palette          = EXCLUDED.chart_palette,
			       feature_visibility     = EXCLUDED.feature_visibility,
			       autofill_bottle_amount = COALESCE($7, user_preferences.autofill_bottle_amount)
			RETURNING user_id, time_format, timezone, locale, show_recommended_targets, chart_palette, feature_visibility, autofill_bottle_amount, updated_at
		`, uid, req.TimeFormat, req.Timezone, req.Locale, paletteJSON, featureJSON, req.AutofillBottleAmount).Scan(
			&prefs.UserID, &prefs.TimeFormat, &prefs.Timezone, &prefs.Locale, &prefs.ShowRecommendedTargets, &paletteRaw, &featureRaw, &prefs.AutofillBottleAmount, &prefs.UpdatedAt,
		)
	}
	if err != nil {
		h.logger.Error("upsert preferences", "err", err)
		httpx.WriteError(w, http.StatusInternalServerError, "internal", "could not save preferences")
		return
	}
	prefs.ChartPalette, err = chartPaletteFromJSON(paletteRaw)
	if err != nil {
		h.logger.Error("decode chart_palette", "err", err)
		httpx.WriteError(w, http.StatusInternalServerError, "internal", "could not decode chart_palette")
		return
	}
	prefs.FeatureVisibility, err = featureVisibilityFromJSON(featureRaw)
	if err != nil {
		h.logger.Error("decode feature_visibility", "err", err)
		httpx.WriteError(w, http.StatusInternalServerError, "internal", "could not decode feature_visibility")
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
	var paletteRaw []byte
	var featureRaw []byte
	err := st.Pool.QueryRow(ctx, `
		SELECT user_id, time_format, timezone, locale, show_recommended_targets, chart_palette, feature_visibility, autofill_bottle_amount, updated_at
		FROM user_preferences WHERE user_id = $1
	`, uid).Scan(&prefs.UserID, &prefs.TimeFormat, &prefs.Timezone, &prefs.Locale, &prefs.ShowRecommendedTargets, &paletteRaw, &featureRaw, &prefs.AutofillBottleAmount, &prefs.UpdatedAt)
	if err == nil {
		prefs.ChartPalette, err = chartPaletteFromJSON(paletteRaw)
		if err != nil {
			return prefs, err
		}
		prefs.FeatureVisibility, err = featureVisibilityFromJSON(featureRaw)
		return prefs, err
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return prefs, err
	}
	err = st.Pool.QueryRow(ctx, `
		INSERT INTO user_preferences (user_id) VALUES ($1)
		ON CONFLICT (user_id) DO UPDATE SET user_id = EXCLUDED.user_id
		RETURNING user_id, time_format, timezone, locale, show_recommended_targets, chart_palette, feature_visibility, autofill_bottle_amount, updated_at
	`, uid).Scan(&prefs.UserID, &prefs.TimeFormat, &prefs.Timezone, &prefs.Locale, &prefs.ShowRecommendedTargets, &paletteRaw, &featureRaw, &prefs.AutofillBottleAmount, &prefs.UpdatedAt)
	if err != nil {
		return prefs, err
	}
	prefs.ChartPalette, err = chartPaletteFromJSON(paletteRaw)
	if err != nil {
		return prefs, err
	}
	prefs.FeatureVisibility, err = featureVisibilityFromJSON(featureRaw)
	return prefs, err
}

// chartPaletteToJSON normalizes a nil overrides map to an empty object so
// the value persisted on disk always matches the column-default shape.
// Keeps SELECT-then-render predictable for the FE (it can rely on
// overrides being a non-null object).
func chartPaletteToJSON(p ChartPalette) ([]byte, error) {
	if p.Overrides == nil {
		p.Overrides = map[string]string{}
	}
	return json.Marshal(p)
}

// chartPaletteFromJSON unmarshals the raw jsonb bytes and ensures
// Overrides is a non-nil map (even if disk somehow held `null`), again so
// downstream consumers don't have to nil-guard on read.
func chartPaletteFromJSON(raw []byte) (ChartPalette, error) {
	var p ChartPalette
	if len(raw) == 0 {
		return ChartPalette{Preset: "default", Overrides: map[string]string{}}, nil
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return p, err
	}
	if p.Overrides == nil {
		p.Overrides = map[string]string{}
	}
	return p, nil
}

// featureVisibilityToJSON normalizes a nil map to an empty object so the
// value persisted on disk always matches the column-default shape ('{}').
// Mirrors chartPaletteToJSON.
func featureVisibilityToJSON(m map[string]bool) ([]byte, error) {
	if m == nil {
		m = map[string]bool{}
	}
	return json.Marshal(m)
}

// featureVisibilityFromJSON unmarshals the raw jsonb bytes and ensures the
// returned map is non-nil so downstream consumers (and the JSON encoder
// for the response body) don't have to nil-guard on read.
func featureVisibilityFromJSON(raw []byte) (map[string]bool, error) {
	if len(raw) == 0 {
		return map[string]bool{}, nil
	}
	var m map[string]bool
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, err
	}
	if m == nil {
		m = map[string]bool{}
	}
	return m, nil
}
