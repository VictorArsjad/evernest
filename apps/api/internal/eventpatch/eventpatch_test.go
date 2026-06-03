// Cross-kind integration tests for PATCH /v1/{kind}/{id} across bottle
// feeds, diapers, pumpings, and growths. Boots the real chi router
// against the dev Postgres (same pattern as chart_integration_test.go).
//
// Nursing PATCH has its own test file because the close-open vs
// edit-closed dispatch is non-trivial — see nursing_test.go.
package eventpatch_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
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
	client := &http.Client{Timeout: 10 * time.Second}
	t.Cleanup(func() {
		srv.Close()
		st.Close()
	})

	te := &testEnv{server: srv, client: client}
	email := fmt.Sprintf("patchtest-%d-%s@example.com", time.Now().UnixNano(), uuid.NewString())
	reg := te.do(t, "POST", "/v1/auth/register", "", map[string]any{
		"email":        email,
		"password":     "correct horse battery staple",
		"display_name": "Patch Test",
	})
	if reg.StatusCode != http.StatusCreated {
		t.Fatalf("register: %d %s", reg.StatusCode, readBody(reg))
	}
	var tok struct {
		AccessToken string `json:"access_token"`
	}
	decodeJSON(t, reg, &tok)
	te.token = tok.AccessToken

	hhRes := te.do(t, "POST", "/v1/households", te.token, map[string]any{"name": "PatchHH"})
	if hhRes.StatusCode != http.StatusCreated {
		t.Fatalf("hh: %d %s", hhRes.StatusCode, readBody(hhRes))
	}
	var hh struct {
		ID uuid.UUID `json:"id"`
	}
	decodeJSON(t, hhRes, &hh)

	babyRes := te.do(t, "POST", "/v1/households/"+hh.ID.String()+"/babies", te.token, map[string]any{"name": "B"})
	if babyRes.StatusCode != http.StatusCreated {
		t.Fatalf("baby: %d %s", babyRes.StatusCode, readBody(babyRes))
	}
	var b struct {
		ID uuid.UUID `json:"id"`
	}
	decodeJSON(t, babyRes, &b)
	te.baby = b.ID
	return te
}

// newOtherEnv registers a second user + household + baby. Used to assert
// that PATCH on someone else's row returns 403 (or 404, depending on
// whose authorization gate fires first; both are acceptable as "the
// caller can't see this row").
func newOtherEnv(t *testing.T, basedOn *testEnv) *testEnv {
	t.Helper()
	other := &testEnv{server: basedOn.server, client: basedOn.client}
	email := fmt.Sprintf("patchtest-other-%d-%s@example.com", time.Now().UnixNano(), uuid.NewString())
	reg := other.do(t, "POST", "/v1/auth/register", "", map[string]any{
		"email":        email,
		"password":     "correct horse battery staple",
		"display_name": "Other Test",
	})
	if reg.StatusCode != http.StatusCreated {
		t.Fatalf("other register: %d %s", reg.StatusCode, readBody(reg))
	}
	var tok struct {
		AccessToken string `json:"access_token"`
	}
	decodeJSON(t, reg, &tok)
	other.token = tok.AccessToken
	return other
}

func (te *testEnv) do(t *testing.T, method, path, bearer string, body any) *http.Response {
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

// --- bottle feeds ---

func TestPatchBottleFeed(t *testing.T) {
	te := newTestEnv(t)
	other := newOtherEnv(t, te)

	// Create
	occurred := time.Now().UTC().Add(-time.Hour).Truncate(time.Second)
	createRes := te.do(t, "POST", "/v1/babies/"+te.baby.String()+"/bottle-feeds", te.token, map[string]any{
		"occurred_at":  occurred.Format(time.RFC3339),
		"milk_source":  "formula",
		"amount_ml":    60,
		"notes":        "first try",
	})
	if createRes.StatusCode != http.StatusCreated {
		t.Fatalf("create: %d %s", createRes.StatusCode, readBody(createRes))
	}
	var feed struct {
		ID        uuid.UUID `json:"id"`
		Source    string    `json:"source"`
		CreatedAt time.Time `json:"created_at"`
	}
	decodeJSON(t, createRes, &feed)

	// Patch happy: change amount + clear notes
	patchRes := te.do(t, "PATCH", "/v1/bottle-feeds/"+feed.ID.String(), te.token, map[string]any{
		"amount_ml": 90,
		"notes":     "",
	})
	if patchRes.StatusCode != http.StatusOK {
		t.Fatalf("patch: want 200, got %d: %s", patchRes.StatusCode, readBody(patchRes))
	}
	var patched struct {
		ID         uuid.UUID `json:"id"`
		AmountML   float64   `json:"amount_ml"`
		MilkSource string    `json:"milk_source"`
		Notes      *string   `json:"notes,omitempty"`
		Source     string    `json:"source"`
		CreatedAt  time.Time `json:"created_at"`
	}
	decodeJSON(t, patchRes, &patched)
	if patched.AmountML != 90 {
		t.Fatalf("amount_ml: want 90, got %v", patched.AmountML)
	}
	if patched.Notes != nil {
		t.Fatalf("notes: want cleared, got %v", *patched.Notes)
	}
	if patched.MilkSource != "formula" {
		t.Fatalf("milk_source: want formula (unchanged), got %s", patched.MilkSource)
	}
	if patched.Source != feed.Source {
		t.Fatalf("source: must be preserved, was %s, now %s", feed.Source, patched.Source)
	}
	if !patched.CreatedAt.Equal(feed.CreatedAt) {
		t.Fatalf("created_at: must be preserved, was %v, now %v", feed.CreatedAt, patched.CreatedAt)
	}

	// Patch 404 on unknown id
	missing := te.do(t, "PATCH", "/v1/bottle-feeds/"+uuid.NewString(), te.token, map[string]any{"amount_ml": 100})
	if missing.StatusCode != http.StatusNotFound {
		t.Fatalf("missing id: want 404, got %d: %s", missing.StatusCode, readBody(missing))
	}
	_ = missing.Body.Close()

	// Patch 403 from another user's account (the lookup succeeds then
	// authz fails; some kinds may also return 404 before lookup if they
	// were eager about row existence — we accept either).
	denied := te.do(t, "PATCH", "/v1/bottle-feeds/"+feed.ID.String(), other.token, map[string]any{"amount_ml": 100})
	if denied.StatusCode != http.StatusForbidden && denied.StatusCode != http.StatusNotFound {
		t.Fatalf("other user PATCH: want 403/404, got %d: %s", denied.StatusCode, readBody(denied))
	}
	_ = denied.Body.Close()
}

// --- diapers ---

func TestPatchDiaper(t *testing.T) {
	te := newTestEnv(t)
	other := newOtherEnv(t, te)

	occurred := time.Now().UTC().Add(-time.Hour).Truncate(time.Second)
	createRes := te.do(t, "POST", "/v1/babies/"+te.baby.String()+"/diapers", te.token, map[string]any{
		"occurred_at": occurred.Format(time.RFC3339),
		"type":        "wet",
	})
	if createRes.StatusCode != http.StatusCreated {
		t.Fatalf("create: %d %s", createRes.StatusCode, readBody(createRes))
	}
	var d struct {
		ID uuid.UUID `json:"id"`
	}
	decodeJSON(t, createRes, &d)

	// Happy patch: flip type and add notes
	patchRes := te.do(t, "PATCH", "/v1/diapers/"+d.ID.String(), te.token, map[string]any{
		"type":  "mixed",
		"notes": "blowout",
	})
	if patchRes.StatusCode != http.StatusOK {
		t.Fatalf("patch: want 200, got %d: %s", patchRes.StatusCode, readBody(patchRes))
	}
	var patched struct {
		Type  string  `json:"type"`
		Notes *string `json:"notes,omitempty"`
	}
	decodeJSON(t, patchRes, &patched)
	if patched.Type != "mixed" {
		t.Fatalf("type: want mixed, got %s", patched.Type)
	}
	if patched.Notes == nil || *patched.Notes != "blowout" {
		t.Fatalf("notes: want blowout, got %v", patched.Notes)
	}

	missing := te.do(t, "PATCH", "/v1/diapers/"+uuid.NewString(), te.token, map[string]any{"type": "wet"})
	if missing.StatusCode != http.StatusNotFound {
		t.Fatalf("missing id: want 404, got %d", missing.StatusCode)
	}
	_ = missing.Body.Close()

	denied := te.do(t, "PATCH", "/v1/diapers/"+d.ID.String(), other.token, map[string]any{"type": "wet"})
	if denied.StatusCode != http.StatusForbidden && denied.StatusCode != http.StatusNotFound {
		t.Fatalf("other user: want 403/404, got %d", denied.StatusCode)
	}
	_ = denied.Body.Close()

	// Invalid enum -> 422
	bad := te.do(t, "PATCH", "/v1/diapers/"+d.ID.String(), te.token, map[string]any{"type": "purple"})
	if bad.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("invalid type: want 422, got %d", bad.StatusCode)
	}
	_ = bad.Body.Close()
}

// --- pumpings ---

func TestPatchPumping(t *testing.T) {
	te := newTestEnv(t)

	occurred := time.Now().UTC().Add(-time.Hour).Truncate(time.Second)
	createRes := te.do(t, "POST", "/v1/babies/"+te.baby.String()+"/pumpings", te.token, map[string]any{
		"occurred_at":      occurred.Format(time.RFC3339),
		"amount_ml":        120,
		"duration_seconds": 900,
	})
	if createRes.StatusCode != http.StatusCreated {
		t.Fatalf("create: %d %s", createRes.StatusCode, readBody(createRes))
	}
	var p struct {
		ID uuid.UUID `json:"id"`
	}
	decodeJSON(t, createRes, &p)

	patchRes := te.do(t, "PATCH", "/v1/pumpings/"+p.ID.String(), te.token, map[string]any{
		"amount_ml":        150,
		"duration_seconds": 1200,
	})
	if patchRes.StatusCode != http.StatusOK {
		t.Fatalf("patch: want 200, got %d: %s", patchRes.StatusCode, readBody(patchRes))
	}
	var patched struct {
		AmountML        float64 `json:"amount_ml"`
		DurationSeconds *int    `json:"duration_seconds,omitempty"`
	}
	decodeJSON(t, patchRes, &patched)
	if patched.AmountML != 150 {
		t.Fatalf("amount_ml: want 150, got %v", patched.AmountML)
	}
	if patched.DurationSeconds == nil || *patched.DurationSeconds != 1200 {
		t.Fatalf("duration_seconds: want 1200, got %v", patched.DurationSeconds)
	}

	// Out of range -> 422
	bad := te.do(t, "PATCH", "/v1/pumpings/"+p.ID.String(), te.token, map[string]any{"amount_ml": 5000})
	if bad.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("amount_ml > max: want 422, got %d", bad.StatusCode)
	}
	_ = bad.Body.Close()
}

// --- growths ---

func TestPatchGrowth(t *testing.T) {
	te := newTestEnv(t)

	measured := time.Now().UTC().Add(-time.Hour).Truncate(time.Second)
	createRes := te.do(t, "POST", "/v1/babies/"+te.baby.String()+"/growths", te.token, map[string]any{
		"measured_at": measured.Format(time.RFC3339),
		"weight_g":    4500,
		"height_cm":   55,
	})
	if createRes.StatusCode != http.StatusCreated {
		t.Fatalf("create: %d %s", createRes.StatusCode, readBody(createRes))
	}
	var g struct {
		ID uuid.UUID `json:"id"`
	}
	decodeJSON(t, createRes, &g)

	// Happy: update weight
	patchRes := te.do(t, "PATCH", "/v1/growths/"+g.ID.String(), te.token, map[string]any{"weight_g": 4800})
	if patchRes.StatusCode != http.StatusOK {
		t.Fatalf("patch: want 200, got %d: %s", patchRes.StatusCode, readBody(patchRes))
	}
	var patched struct {
		WeightG  *float64 `json:"weight_g,omitempty"`
		HeightCM *float64 `json:"height_cm,omitempty"`
	}
	decodeJSON(t, patchRes, &patched)
	if patched.WeightG == nil || *patched.WeightG != 4800 {
		t.Fatalf("weight_g: want 4800, got %v", patched.WeightG)
	}
	if patched.HeightCM == nil || *patched.HeightCM != 55 {
		t.Fatalf("height_cm: want 55 (preserved), got %v", patched.HeightCM)
	}

	// Clearing all three measurements -> 422 (DB CHECK mirror)
	emptyAll := te.do(t, "PATCH", "/v1/growths/"+g.ID.String(), te.token, map[string]any{
		"clear_weight_g":              true,
		"clear_height_cm":             true,
		"clear_head_circumference_cm": true,
	})
	if emptyAll.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("clear all: want 422, got %d: %s", emptyAll.StatusCode, readBody(emptyAll))
	}
	_ = emptyAll.Body.Close()

	// Clear weight only — height is still set, so allowed.
	clearW := te.do(t, "PATCH", "/v1/growths/"+g.ID.String(), te.token, map[string]any{"clear_weight_g": true})
	if clearW.StatusCode != http.StatusOK {
		t.Fatalf("clear weight only: want 200, got %d: %s", clearW.StatusCode, readBody(clearW))
	}
	var afterClear struct {
		WeightG  *float64 `json:"weight_g,omitempty"`
		HeightCM *float64 `json:"height_cm,omitempty"`
	}
	decodeJSON(t, clearW, &afterClear)
	if afterClear.WeightG != nil {
		t.Fatalf("weight_g: want nil after clear, got %v", *afterClear.WeightG)
	}
	if afterClear.HeightCM == nil || *afterClear.HeightCM != 55 {
		t.Fatalf("height_cm: want 55 preserved, got %v", afterClear.HeightCM)
	}
}

// --- helpers ---

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
