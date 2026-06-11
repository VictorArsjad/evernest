// Integration tests for /v1/me/preferences and /v1/babies/{id}/settings.
//
// Mirrors the auth + chart suites: spins the full chi router against the
// dev Postgres, registers a fresh user + household + baby per test, and
// asserts end-to-end behavior. We test both endpoints in this file because
// they're a single FE-facing concept (the /settings screen surfaces both)
// and they share the same bootstrap.
package preferences_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	apirouter "github.com/varsjad/evernest/apps/api/internal/api"
	"github.com/varsjad/evernest/apps/api/internal/config"
	"github.com/varsjad/evernest/apps/api/internal/store"
)

const (
	defaultTestDSN    = "postgres://evernest:evernest_dev@localhost:5432/evernest?sslmode=disable"
	defaultTestSecret = "test-only-secret-please-do-not-use-in-production-aa"
)

type testEnv struct {
	server *httptest.Server
	client *http.Client
	store  *store.Store
	token  string
	baby   uuid.UUID
}

func newTestEnv(t *testing.T) *testEnv {
	t.Helper()
	if os.Getenv("JWT_SECRET") == "" {
		t.Setenv("JWT_SECRET", defaultTestSecret)
	}
	if os.Getenv("DATABASE_URL") == "" {
		t.Setenv("DATABASE_URL", defaultTestDSN)
	}
	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("config.Load: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	st, err := store.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		t.Skipf("postgres not reachable (%s): %v", cfg.DatabaseURL, err)
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	srv := httptest.NewServer(apirouter.NewRouter(cfg, st, logger))
	jar, _ := cookiejar.New(nil)
	// Register triggers argon2id hashing which is much slower under -race;
	// keep the per-request budget generous, mirroring chart_integration_test.go.
	client := &http.Client{Jar: jar, Timeout: 30 * time.Second}
	t.Cleanup(func() {
		srv.Close()
		st.Close()
	})

	te := &testEnv{server: srv, client: client, store: st}
	te.bootstrap(t)
	return te
}

// bootstrap mints a fresh user / household / baby and captures the access
// token so each test starts from a clean slate.
func (te *testEnv) bootstrap(t *testing.T) {
	t.Helper()
	email := fmt.Sprintf("prefstest-%d-%s@example.com", time.Now().UnixNano(), uuid.NewString())
	reg := te.do(t, "POST", "/v1/auth/register", map[string]any{
		"email":        email,
		"password":     "correct horse battery staple",
		"display_name": "Prefs Tester",
	}, "")
	if reg.StatusCode != http.StatusCreated {
		t.Fatalf("register: %d %s", reg.StatusCode, readBody(reg))
	}
	var tok struct {
		AccessToken string `json:"access_token"`
		User        struct {
			ID uuid.UUID `json:"id"`
		} `json:"user"`
	}
	decodeJSON(t, reg, &tok)
	te.token = tok.AccessToken

	hhRes := te.do(t, "POST", "/v1/households", map[string]any{"name": "Prefs Test Household"}, te.token)
	if hhRes.StatusCode != http.StatusCreated {
		t.Fatalf("household: %d %s", hhRes.StatusCode, readBody(hhRes))
	}
	var hh struct {
		ID uuid.UUID `json:"id"`
	}
	decodeJSON(t, hhRes, &hh)

	babyRes := te.do(t, "POST", "/v1/households/"+hh.ID.String()+"/babies", map[string]any{
		"name": "Prefs Junior",
	}, te.token)
	if babyRes.StatusCode != http.StatusCreated {
		t.Fatalf("baby: %d %s", babyRes.StatusCode, readBody(babyRes))
	}
	var b struct {
		ID uuid.UUID `json:"id"`
	}
	decodeJSON(t, babyRes, &b)
	te.baby = b.ID
}

func (te *testEnv) do(t *testing.T, method, path string, body any, bearer string) *http.Response {
	t.Helper()
	var reqBody io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		reqBody = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, te.server.URL+path, reqBody)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	res, err := te.client.Do(req)
	if err != nil {
		t.Fatalf("do: %v", err)
	}
	return res
}

func decodeJSON(t *testing.T, r *http.Response, v any) {
	t.Helper()
	defer func() { _ = r.Body.Close() }()
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		t.Fatalf("decode body (status %d): %v", r.StatusCode, err)
	}
}

func readBody(r *http.Response) string {
	defer func() { _ = r.Body.Close() }()
	b, _ := io.ReadAll(r.Body)
	return strings.TrimSpace(string(b))
}

// --- /v1/me/preferences ---

// chartPalette mirrors preferences.ChartPalette on the wire so the test
// suite can deserialize the response without importing the production
// package (this is an external _test package).
type chartPalette struct {
	Preset    string            `json:"preset"`
	Overrides map[string]string `json:"overrides"`
}

type prefsResp struct {
	UserID                 uuid.UUID       `json:"user_id"`
	TimeFormat             string          `json:"time_format"`
	Timezone               string          `json:"timezone"`
	Locale                 string          `json:"locale"`
	ShowRecommendedTargets bool            `json:"show_recommended_targets"`
	ChartPalette           chartPalette    `json:"chart_palette"`
	FeatureVisibility      map[string]bool `json:"feature_visibility"`
	AutofillBottleAmount   bool            `json:"autofill_bottle_amount"`
	UpdatedAt              time.Time       `json:"updated_at"`
}

// defaultPalettePayload is the value the FE round-trips on a PUT when the
// user hasn't customized colors yet. Centralized so the many existing
// non-palette-focused tests don't all have to spell it out.
func defaultPalettePayload() map[string]any {
	return map[string]any{
		"preset":    "default",
		"overrides": map[string]any{},
	}
}

// defaultFeatureVisibilityPayload is the value the FE round-trips on a PUT
// when the user hasn't hidden any features yet. Empty object = all visible.
func defaultFeatureVisibilityPayload() map[string]any {
	return map[string]any{}
}

func TestUserPreferences_GetReturnsDefaults(t *testing.T) {
	te := newTestEnv(t)
	res := te.do(t, "GET", "/v1/me/preferences", nil, te.token)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("get prefs: %d %s", res.StatusCode, readBody(res))
	}
	var got prefsResp
	decodeJSON(t, res, &got)
	if got.TimeFormat != "24h" || got.Timezone != "UTC" || got.Locale != "en" {
		t.Fatalf("default prefs mismatch: %+v", got)
	}
	// Newly-created users should see the Today-banner target bars by
	// default; users opt out via the settings screen.
	if !got.ShowRecommendedTargets {
		t.Fatalf("show_recommended_targets default should be true: %+v", got)
	}
	// New users land on the `default` chart preset (which matches today's
	// hard-coded colors) with no per-series overrides.
	if got.ChartPalette.Preset != "default" {
		t.Fatalf("chart_palette default preset should be 'default', got %q", got.ChartPalette.Preset)
	}
	if len(got.ChartPalette.Overrides) != 0 {
		t.Fatalf("chart_palette overrides should be empty by default, got %+v", got.ChartPalette.Overrides)
	}
	// New users land with no features hidden — the column default is
	// '{}' so every feature renders until the user explicitly hides one.
	if got.FeatureVisibility == nil {
		t.Fatalf("feature_visibility should be a non-nil empty map by default")
	}
	if len(got.FeatureVisibility) != 0 {
		t.Fatalf("feature_visibility should be empty by default, got %+v", got.FeatureVisibility)
	}
	// Newly-created users should get the bottle-amount prefill convenience
	// by default; users opt out via the settings screen.
	if !got.AutofillBottleAmount {
		t.Fatalf("autofill_bottle_amount default should be true: %+v", got)
	}
}

func TestUserPreferences_PutPersists(t *testing.T) {
	te := newTestEnv(t)
	// PUT to a non-default value, then GET back.
	res := te.do(t, "PUT", "/v1/me/preferences", map[string]any{
		"time_format":        "12h",
		"timezone":           "Asia/Jakarta",
		"locale":             "id",
		"chart_palette":      defaultPalettePayload(),
		"feature_visibility": defaultFeatureVisibilityPayload(),
	}, te.token)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("put prefs: %d %s", res.StatusCode, readBody(res))
	}
	var got prefsResp
	decodeJSON(t, res, &got)
	if got.TimeFormat != "12h" || got.Timezone != "Asia/Jakarta" || got.Locale != "id" {
		t.Fatalf("put response mismatch: %+v", got)
	}
	// Older FE builds may not send show_recommended_targets — the server
	// should preserve whatever's already on the row (default TRUE for a
	// freshly-seeded user).
	if !got.ShowRecommendedTargets {
		t.Fatalf("show_recommended_targets should be preserved as true when omitted: %+v", got)
	}

	res = te.do(t, "GET", "/v1/me/preferences", nil, te.token)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("re-get prefs: %d %s", res.StatusCode, readBody(res))
	}
	var refetched prefsResp
	decodeJSON(t, res, &refetched)
	if refetched.TimeFormat != "12h" || refetched.Timezone != "Asia/Jakarta" || refetched.Locale != "id" {
		t.Fatalf("refetched mismatch: %+v", refetched)
	}
}

// TestUserPreferences_PutShowTargets exercises the new toggle: a PUT
// that flips show_recommended_targets to false should persist that
// value, and a subsequent PUT that *omits* the field should NOT silently
// flip it back to the default.
func TestUserPreferences_PutShowTargets(t *testing.T) {
	te := newTestEnv(t)

	// Flip the toggle off.
	res := te.do(t, "PUT", "/v1/me/preferences", map[string]any{
		"time_format":              "24h",
		"timezone":                 "UTC",
		"locale":                   "en",
		"show_recommended_targets": false,
		"chart_palette":            defaultPalettePayload(),
		"feature_visibility":       defaultFeatureVisibilityPayload(),
	}, te.token)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("put prefs (off): %d %s", res.StatusCode, readBody(res))
	}
	var got prefsResp
	decodeJSON(t, res, &got)
	if got.ShowRecommendedTargets {
		t.Fatalf("show_recommended_targets should be false: %+v", got)
	}

	// Now PUT without the field — old FE build path — and verify the
	// server preserves the false we just set rather than resetting to
	// the default.
	res = te.do(t, "PUT", "/v1/me/preferences", map[string]any{
		"time_format":        "12h",
		"timezone":           "UTC",
		"locale":             "en",
		"chart_palette":      defaultPalettePayload(),
		"feature_visibility": defaultFeatureVisibilityPayload(),
	}, te.token)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("put prefs (omit): %d %s", res.StatusCode, readBody(res))
	}
	var preserved prefsResp
	decodeJSON(t, res, &preserved)
	if preserved.ShowRecommendedTargets {
		t.Fatalf("show_recommended_targets should be preserved as false when omitted: %+v", preserved)
	}
	if preserved.TimeFormat != "12h" {
		t.Fatalf("other fields should still update: %+v", preserved)
	}
}

// TestUserPreferences_PutAutofillBottleAmount mirrors the show_targets
// test: flipping autofill_bottle_amount off should persist, and a later
// PUT that omits the field (older FE build) must NOT silently flip it
// back to the default true.
func TestUserPreferences_PutAutofillBottleAmount(t *testing.T) {
	te := newTestEnv(t)

	// Flip the toggle off.
	res := te.do(t, "PUT", "/v1/me/preferences", map[string]any{
		"time_format":            "24h",
		"timezone":               "UTC",
		"locale":                 "en",
		"autofill_bottle_amount": false,
		"chart_palette":          defaultPalettePayload(),
		"feature_visibility":     defaultFeatureVisibilityPayload(),
	}, te.token)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("put prefs (off): %d %s", res.StatusCode, readBody(res))
	}
	var got prefsResp
	decodeJSON(t, res, &got)
	if got.AutofillBottleAmount {
		t.Fatalf("autofill_bottle_amount should be false: %+v", got)
	}

	// PUT without the field — old FE build path — and verify the server
	// preserves the false we just set rather than resetting to default.
	res = te.do(t, "PUT", "/v1/me/preferences", map[string]any{
		"time_format":        "12h",
		"timezone":           "UTC",
		"locale":             "en",
		"chart_palette":      defaultPalettePayload(),
		"feature_visibility": defaultFeatureVisibilityPayload(),
	}, te.token)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("put prefs (omit): %d %s", res.StatusCode, readBody(res))
	}
	var preserved prefsResp
	decodeJSON(t, res, &preserved)
	if preserved.AutofillBottleAmount {
		t.Fatalf("autofill_bottle_amount should be preserved as false when omitted: %+v", preserved)
	}

	// Re-enable explicitly and confirm it survives a GET round-trip.
	res = te.do(t, "PUT", "/v1/me/preferences", map[string]any{
		"time_format":            "12h",
		"timezone":               "UTC",
		"locale":                 "en",
		"autofill_bottle_amount": true,
		"chart_palette":          defaultPalettePayload(),
		"feature_visibility":     defaultFeatureVisibilityPayload(),
	}, te.token)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("put prefs (on): %d %s", res.StatusCode, readBody(res))
	}
	_ = res.Body.Close()
	res = te.do(t, "GET", "/v1/me/preferences", nil, te.token)
	var refetched prefsResp
	decodeJSON(t, res, &refetched)
	if !refetched.AutofillBottleAmount {
		t.Fatalf("autofill_bottle_amount should be true after re-enable: %+v", refetched)
	}
}

func TestUserPreferences_RejectsBadEnum(t *testing.T) {
	te := newTestEnv(t)
	cases := []struct {
		name string
		body map[string]any
		code int
	}{
		{"bad time_format", map[string]any{"time_format": "13h", "timezone": "UTC", "locale": "en"}, http.StatusUnprocessableEntity},
		{"empty timezone", map[string]any{"time_format": "24h", "timezone": "", "locale": "en"}, http.StatusUnprocessableEntity},
		{"bad timezone (not IANA)", map[string]any{"time_format": "24h", "timezone": "Mars/Olympus_Mons", "locale": "en"}, http.StatusUnprocessableEntity},
		{"missing locale", map[string]any{"time_format": "24h", "timezone": "UTC"}, http.StatusUnprocessableEntity},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			res := te.do(t, "PUT", "/v1/me/preferences", tc.body, te.token)
			if res.StatusCode != tc.code {
				t.Fatalf("want %d, got %d: %s", tc.code, res.StatusCode, readBody(res))
			}
			_ = res.Body.Close()
		})
	}
}

// TestUserPreferences_ChartPaletteRoundTrip exercises the happy path for
// the M3 palette column: PUT a non-default preset plus a single per-series
// override, GET it back, and confirm both fields persisted byte-for-byte.
func TestUserPreferences_ChartPaletteRoundTrip(t *testing.T) {
	te := newTestEnv(t)
	res := te.do(t, "PUT", "/v1/me/preferences", map[string]any{
		"time_format": "24h",
		"timezone":    "UTC",
		"locale":      "en",
		"chart_palette": map[string]any{
			"preset": "warm",
			"overrides": map[string]any{
				"bottle_breast": "#ff8800",
			},
		},
		"feature_visibility": defaultFeatureVisibilityPayload(),
	}, te.token)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("put prefs: %d %s", res.StatusCode, readBody(res))
	}
	var got prefsResp
	decodeJSON(t, res, &got)
	if got.ChartPalette.Preset != "warm" {
		t.Fatalf("preset mismatch: got %q want %q", got.ChartPalette.Preset, "warm")
	}
	if got.ChartPalette.Overrides["bottle_breast"] != "#ff8800" {
		t.Fatalf("override mismatch: got %+v", got.ChartPalette.Overrides)
	}

	// Re-fetch via GET to confirm the value survived the DB round-trip
	// (and wasn't just echoed straight back from the request body).
	res = te.do(t, "GET", "/v1/me/preferences", nil, te.token)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("get prefs: %d %s", res.StatusCode, readBody(res))
	}
	var refetched prefsResp
	decodeJSON(t, res, &refetched)
	if refetched.ChartPalette.Preset != "warm" {
		t.Fatalf("refetched preset mismatch: got %q want %q", refetched.ChartPalette.Preset, "warm")
	}
	if refetched.ChartPalette.Overrides["bottle_breast"] != "#ff8800" {
		t.Fatalf("refetched override mismatch: got %+v", refetched.ChartPalette.Overrides)
	}
	if len(refetched.ChartPalette.Overrides) != 1 {
		t.Fatalf("expected exactly one override, got %d: %+v", len(refetched.ChartPalette.Overrides), refetched.ChartPalette.Overrides)
	}
}

// TestUserPreferences_ChartPaletteRejectsBadInput covers the three classes
// of palette-specific validation failure: unknown preset, unknown series
// key in overrides, and malformed hex. All three should land as 422.
func TestUserPreferences_ChartPaletteRejectsBadInput(t *testing.T) {
	te := newTestEnv(t)
	base := func() map[string]any {
		return map[string]any{
			"time_format":        "24h",
			"timezone":           "UTC",
			"locale":             "en",
			"feature_visibility": defaultFeatureVisibilityPayload(),
		}
	}
	cases := []struct {
		name    string
		palette map[string]any
	}{
		{
			name: "unknown preset",
			palette: map[string]any{
				"preset":    "neon",
				"overrides": map[string]any{},
			},
		},
		{
			name: "unknown series key",
			palette: map[string]any{
				"preset": "default",
				"overrides": map[string]any{
					"sleep": "#112233",
				},
			},
		},
		{
			name: "malformed hex",
			palette: map[string]any{
				"preset": "default",
				"overrides": map[string]any{
					"nursing": "112233", // missing leading '#'
				},
			},
		},
		{
			name: "short hex",
			palette: map[string]any{
				"preset": "default",
				"overrides": map[string]any{
					"nursing": "#abc",
				},
			},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			body := base()
			body["chart_palette"] = tc.palette
			res := te.do(t, "PUT", "/v1/me/preferences", body, te.token)
			if res.StatusCode != http.StatusUnprocessableEntity {
				t.Fatalf("want 422, got %d: %s", res.StatusCode, readBody(res))
			}
			_ = res.Body.Close()
		})
	}
}

// TestUserPreferences_FeatureVisibilityRoundTrip is the happy path for the
// new visibility map: PUT with one feature explicitly hidden, GET it back,
// confirm the value survived the DB round-trip. Mirrors
// TestUserPreferences_ChartPaletteRoundTrip in shape so future readers see
// the parallel.
func TestUserPreferences_FeatureVisibilityRoundTrip(t *testing.T) {
	te := newTestEnv(t)
	res := te.do(t, "PUT", "/v1/me/preferences", map[string]any{
		"time_format":   "24h",
		"timezone":      "UTC",
		"locale":        "en",
		"chart_palette": defaultPalettePayload(),
		"feature_visibility": map[string]any{
			"bottle": false,
		},
	}, te.token)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("put prefs: %d %s", res.StatusCode, readBody(res))
	}
	var got prefsResp
	decodeJSON(t, res, &got)
	if v, ok := got.FeatureVisibility["bottle"]; !ok || v {
		t.Fatalf("expected feature_visibility.bottle=false, got %+v", got.FeatureVisibility)
	}
	if len(got.FeatureVisibility) != 1 {
		t.Fatalf("expected exactly one feature_visibility entry, got %+v", got.FeatureVisibility)
	}

	// Re-fetch to confirm the value survived the DB round-trip.
	res = te.do(t, "GET", "/v1/me/preferences", nil, te.token)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("get prefs: %d %s", res.StatusCode, readBody(res))
	}
	var refetched prefsResp
	decodeJSON(t, res, &refetched)
	if v, ok := refetched.FeatureVisibility["bottle"]; !ok || v {
		t.Fatalf("refetched feature_visibility mismatch: %+v", refetched.FeatureVisibility)
	}

	// Re-enable bottle by sending an empty map back, simulating the
	// settings-screen toggle-on path.
	res = te.do(t, "PUT", "/v1/me/preferences", map[string]any{
		"time_format":        "24h",
		"timezone":           "UTC",
		"locale":             "en",
		"chart_palette":      defaultPalettePayload(),
		"feature_visibility": defaultFeatureVisibilityPayload(),
	}, te.token)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("put prefs (re-enable): %d %s", res.StatusCode, readBody(res))
	}
	var cleared prefsResp
	decodeJSON(t, res, &cleared)
	if len(cleared.FeatureVisibility) != 0 {
		t.Fatalf("feature_visibility should be empty after re-enable, got %+v", cleared.FeatureVisibility)
	}
}

// TestUserPreferences_FeatureVisibilityRejectsBadInput covers the two ways
// a malformed feature_visibility map can fail validation:
//   - unknown feature key (allowlist enforcement, post-validator)
//   - non-bool value (caught by the JSON decoder before validator runs)
func TestUserPreferences_FeatureVisibilityRejectsBadInput(t *testing.T) {
	te := newTestEnv(t)
	base := func() map[string]any {
		return map[string]any{
			"time_format":   "24h",
			"timezone":      "UTC",
			"locale":        "en",
			"chart_palette": defaultPalettePayload(),
		}
	}
	cases := []struct {
		name       string
		visibility any
	}{
		{
			name:       "unknown feature key",
			visibility: map[string]any{"sleep": false},
		},
		{
			name:       "non-bool value",
			visibility: map[string]any{"bottle": "no"},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			body := base()
			body["feature_visibility"] = tc.visibility
			res := te.do(t, "PUT", "/v1/me/preferences", body, te.token)
			// Either 400 (json decode for non-bool) or 422 (validator
			// for unknown key) is acceptable; both reject the payload
			// before it touches the DB.
			if res.StatusCode != http.StatusUnprocessableEntity && res.StatusCode != http.StatusBadRequest {
				t.Fatalf("want 400 or 422, got %d: %s", res.StatusCode, readBody(res))
			}
			_ = res.Body.Close()
		})
	}
}

func TestUserPreferences_Unauthenticated(t *testing.T) {
	te := newTestEnv(t)
	res := te.do(t, "GET", "/v1/me/preferences", nil, "")
	if res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("want 401 unauth, got %d: %s", res.StatusCode, readBody(res))
	}
	_ = res.Body.Close()
}

// --- /v1/babies/{id}/settings ---

type settingsResp struct {
	BabyID     uuid.UUID `json:"baby_id"`
	UnitVolume string    `json:"unit_volume"`
	UnitLength string    `json:"unit_length"`
	UnitWeight string    `json:"unit_weight"`
}

func TestBabySettings_GetReturnsSeededDefaults(t *testing.T) {
	te := newTestEnv(t)
	res := te.do(t, "GET", "/v1/babies/"+te.baby.String()+"/settings", nil, te.token)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("get settings: %d %s", res.StatusCode, readBody(res))
	}
	var got settingsResp
	decodeJSON(t, res, &got)
	if got.BabyID != te.baby {
		t.Fatalf("baby id mismatch: %s != %s", got.BabyID, te.baby)
	}
	if got.UnitVolume != "ml" || got.UnitLength != "cm" || got.UnitWeight != "kg" {
		t.Fatalf("default settings mismatch: %+v", got)
	}
}

func TestBabySettings_PutPersists(t *testing.T) {
	te := newTestEnv(t)
	res := te.do(t, "PUT", "/v1/babies/"+te.baby.String()+"/settings", map[string]any{
		"unit_volume": "oz",
		"unit_length": "in",
		"unit_weight": "lb",
	}, te.token)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("put settings: %d %s", res.StatusCode, readBody(res))
	}
	var got settingsResp
	decodeJSON(t, res, &got)
	if got.UnitVolume != "oz" || got.UnitLength != "in" || got.UnitWeight != "lb" {
		t.Fatalf("put response mismatch: %+v", got)
	}

	res = te.do(t, "GET", "/v1/babies/"+te.baby.String()+"/settings", nil, te.token)
	var refetched settingsResp
	decodeJSON(t, res, &refetched)
	if refetched.UnitVolume != "oz" || refetched.UnitLength != "in" || refetched.UnitWeight != "lb" {
		t.Fatalf("refetched mismatch: %+v", refetched)
	}
}

func TestBabySettings_RejectsBadEnum(t *testing.T) {
	te := newTestEnv(t)
	cases := []struct {
		name string
		body map[string]any
	}{
		{"bad volume", map[string]any{"unit_volume": "L", "unit_length": "cm", "unit_weight": "kg"}},
		{"bad length", map[string]any{"unit_volume": "ml", "unit_length": "ft", "unit_weight": "kg"}},
		{"bad weight", map[string]any{"unit_volume": "ml", "unit_length": "cm", "unit_weight": "g"}}, // 'g' is the canonical storage unit, not a valid display pref
		{"missing field", map[string]any{"unit_volume": "ml", "unit_length": "cm"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			res := te.do(t, "PUT", "/v1/babies/"+te.baby.String()+"/settings", tc.body, te.token)
			if res.StatusCode != http.StatusUnprocessableEntity {
				t.Fatalf("want 422, got %d: %s", res.StatusCode, readBody(res))
			}
			_ = res.Body.Close()
		})
	}
}

func TestBabySettings_Forbidden_OtherUsersBaby(t *testing.T) {
	te := newTestEnv(t)
	// Register a second user; they should not be able to read/write the
	// first user's baby settings even with a valid token.
	otherEmail := fmt.Sprintf("prefstest-other-%d-%s@example.com", time.Now().UnixNano(), uuid.NewString())
	reg := te.do(t, "POST", "/v1/auth/register", map[string]any{
		"email":        otherEmail,
		"password":     "correct horse battery staple",
		"display_name": "Outsider",
	}, "")
	var tok struct {
		AccessToken string `json:"access_token"`
	}
	decodeJSON(t, reg, &tok)

	res := te.do(t, "GET", "/v1/babies/"+te.baby.String()+"/settings", nil, tok.AccessToken)
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("want 403, got %d: %s", res.StatusCode, readBody(res))
	}
	_ = res.Body.Close()

	res = te.do(t, "PUT", "/v1/babies/"+te.baby.String()+"/settings", map[string]any{
		"unit_volume": "oz",
		"unit_length": "in",
		"unit_weight": "lb",
	}, tok.AccessToken)
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("want 403, got %d: %s", res.StatusCode, readBody(res))
	}
	_ = res.Body.Close()
}

func TestBabySettings_NotFound(t *testing.T) {
	te := newTestEnv(t)
	res := te.do(t, "GET", "/v1/babies/"+uuid.NewString()+"/settings", nil, te.token)
	if res.StatusCode != http.StatusNotFound {
		t.Fatalf("want 404, got %d: %s", res.StatusCode, readBody(res))
	}
	_ = res.Body.Close()
}
