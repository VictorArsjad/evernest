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

type prefsResp struct {
	UserID     uuid.UUID `json:"user_id"`
	TimeFormat string    `json:"time_format"`
	Timezone   string    `json:"timezone"`
	Locale     string    `json:"locale"`
	UpdatedAt  time.Time `json:"updated_at"`
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
}

func TestUserPreferences_PutPersists(t *testing.T) {
	te := newTestEnv(t)
	// PUT to a non-default value, then GET back.
	res := te.do(t, "PUT", "/v1/me/preferences", map[string]any{
		"time_format": "12h",
		"timezone":    "Asia/Jakarta",
		"locale":      "id",
	}, te.token)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("put prefs: %d %s", res.StatusCode, readBody(res))
	}
	var got prefsResp
	decodeJSON(t, res, &got)
	if got.TimeFormat != "12h" || got.Timezone != "Asia/Jakarta" || got.Locale != "id" {
		t.Fatalf("put response mismatch: %+v", got)
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
