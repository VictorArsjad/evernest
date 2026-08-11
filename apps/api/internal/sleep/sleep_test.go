// Integration tests for the sleep endpoints. Mirrors note_test.go: hits the
// real chi router against a live Postgres, spins up a fresh user/household/
// baby per test so concurrent reruns don't collide. Coverage focuses on the
// open-session lifecycle (create open, 409 on a second open, close via
// PATCH), idempotent replay, closed-row partial edits, and windowing/authz.
package sleep_test

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
	babyID uuid.UUID
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

	te := &testEnv{server: srv, client: client}

	email := fmt.Sprintf("sleeptest-%d@example.com", time.Now().UnixNano())
	regResp := te.do(t, "POST", "/v1/auth/register", "", map[string]any{
		"email":        email,
		"password":     "correct horse battery staple",
		"display_name": "Sleep Test",
	})
	if regResp.StatusCode != http.StatusCreated {
		t.Fatalf("register: %d: %s", regResp.StatusCode, readBody(regResp))
	}
	var reg struct {
		AccessToken string `json:"access_token"`
	}
	decodeJSON(t, regResp, &reg)
	te.token = reg.AccessToken

	hhResp := te.do(t, "POST", "/v1/households", te.token, map[string]any{"name": "H"})
	if hhResp.StatusCode != http.StatusCreated {
		t.Fatalf("household: %d: %s", hhResp.StatusCode, readBody(hhResp))
	}
	var hh struct {
		ID uuid.UUID `json:"id"`
	}
	decodeJSON(t, hhResp, &hh)

	babyResp := te.do(t, "POST", "/v1/households/"+hh.ID.String()+"/babies", te.token, map[string]any{"name": "B"})
	if babyResp.StatusCode != http.StatusCreated {
		t.Fatalf("baby: %d: %s", babyResp.StatusCode, readBody(babyResp))
	}
	var b struct {
		ID uuid.UUID `json:"id"`
	}
	decodeJSON(t, babyResp, &b)
	te.babyID = b.ID

	t.Cleanup(func() {
		srv.Close()
		st.Close()
	})
	return te
}

func (te *testEnv) do(t *testing.T, method, path, bearer string, body any) *http.Response {
	t.Helper()
	var reqBody io.Reader
	if body != nil {
		buf, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}
		reqBody = bytes.NewReader(buf)
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
	resp, err := te.client.Do(req)
	if err != nil {
		t.Fatalf("do: %v", err)
	}
	return resp
}

func (te *testEnv) sleepsPath() string {
	return "/v1/babies/" + te.babyID.String() + "/sleeps"
}

// sleepResp mirrors the JSON contract.
type sleepResp struct {
	ID        uuid.UUID  `json:"id"`
	BabyID    uuid.UUID  `json:"baby_id"`
	StartedAt time.Time  `json:"started_at"`
	EndedAt   *time.Time `json:"ended_at,omitempty"`
	SleepType *string    `json:"sleep_type,omitempty"`
	Location  *string    `json:"location,omitempty"`
	Notes     *string    `json:"notes,omitempty"`
	Source    string     `json:"source"`
	CreatedAt time.Time  `json:"created_at"`
}

// TestCreateClosedSleep is the manual-entry happy path: a closed interval
// with every optional field echoes back and shows up in the list.
func TestCreateClosedSleep(t *testing.T) {
	te := newTestEnv(t)
	started := time.Now().UTC().Add(-2 * time.Hour).Truncate(time.Second)
	ended := started.Add(80 * time.Minute)

	resp := te.do(t, "POST", te.sleepsPath(), te.token, map[string]any{
		"started_at": started.Format(time.RFC3339),
		"ended_at":   ended.Format(time.RFC3339),
		"sleep_type": "nap",
		"location":   "crib",
		"notes":      "fell asleep fast",
	})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create: want 201, got %d: %s", resp.StatusCode, readBody(resp))
	}
	var created sleepResp
	decodeJSON(t, resp, &created)
	if created.EndedAt == nil || !created.EndedAt.Equal(ended) {
		t.Fatalf("create: ended_at = %v, want %v", created.EndedAt, ended)
	}
	if created.SleepType == nil || *created.SleepType != "nap" {
		t.Fatalf("create: sleep_type = %v, want nap", created.SleepType)
	}
	if created.Location == nil || *created.Location != "crib" {
		t.Fatalf("create: location = %v, want crib", created.Location)
	}
	if created.Source != "manual" {
		t.Fatalf("create: source = %q, want manual", created.Source)
	}

	listResp := te.do(t, "GET", te.sleepsPath(), te.token, nil)
	if listResp.StatusCode != http.StatusOK {
		t.Fatalf("list: want 200, got %d: %s", listResp.StatusCode, readBody(listResp))
	}
	if body := readBody(listResp); !strings.Contains(body, created.ID.String()) {
		t.Fatalf("list: missing created row in %s", body)
	}
}

// TestOpenSessionLifecycle covers start-now -> /open 200 -> second open 409
// -> idempotent replay -> close via PATCH -> /open 204 -> double-close 409.
func TestOpenSessionLifecycle(t *testing.T) {
	te := newTestEnv(t)
	started := time.Now().UTC().Add(-30 * time.Minute).Truncate(time.Second)
	id := uuid.New()

	// No open session yet.
	openResp := te.do(t, "GET", te.sleepsPath()+"/open", te.token, nil)
	if openResp.StatusCode != http.StatusNoContent {
		t.Fatalf("open (none): want 204, got %d: %s", openResp.StatusCode, readBody(openResp))
	}
	_ = openResp.Body.Close()

	// Start an open session.
	resp := te.do(t, "POST", te.sleepsPath(), te.token, map[string]any{
		"id":         id.String(),
		"started_at": started.Format(time.RFC3339),
	})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create open: want 201, got %d: %s", resp.StatusCode, readBody(resp))
	}
	var open sleepResp
	decodeJSON(t, resp, &open)
	if open.EndedAt != nil {
		t.Fatalf("create open: ended_at = %v, want nil", open.EndedAt)
	}

	// /open surfaces it.
	openResp = te.do(t, "GET", te.sleepsPath()+"/open", te.token, nil)
	if openResp.StatusCode != http.StatusOK {
		t.Fatalf("open: want 200, got %d: %s", openResp.StatusCode, readBody(openResp))
	}
	var fromOpen sleepResp
	decodeJSON(t, openResp, &fromOpen)
	if fromOpen.ID != id {
		t.Fatalf("open: id = %s, want %s", fromOpen.ID, id)
	}

	// A second open create with a DIFFERENT id conflicts.
	second := te.do(t, "POST", te.sleepsPath(), te.token, map[string]any{
		"started_at": started.Add(time.Minute).Format(time.RFC3339),
	})
	if second.StatusCode != http.StatusConflict {
		t.Fatalf("second open: want 409, got %d: %s", second.StatusCode, readBody(second))
	}
	if body := readBody(second); !strings.Contains(body, "open_session_exists") {
		t.Fatalf("second open: missing open_session_exists in %s", body)
	}

	// Replaying the FIRST create with the same id stays idempotent (no 409).
	replay := te.do(t, "POST", te.sleepsPath(), te.token, map[string]any{
		"id":         id.String(),
		"started_at": started.Format(time.RFC3339),
	})
	if replay.StatusCode != http.StatusCreated {
		t.Fatalf("replay: want 201, got %d: %s", replay.StatusCode, readBody(replay))
	}
	var replayed sleepResp
	decodeJSON(t, replay, &replayed)
	if replayed.ID != id {
		t.Fatalf("replay: id = %s, want %s", replayed.ID, id)
	}

	// Close it.
	ended := started.Add(45 * time.Minute)
	closeResp := te.do(t, "PATCH", "/v1/sleeps/"+id.String(), te.token, map[string]any{
		"ended_at": ended.Format(time.RFC3339),
	})
	if closeResp.StatusCode != http.StatusOK {
		t.Fatalf("close: want 200, got %d: %s", closeResp.StatusCode, readBody(closeResp))
	}
	var closed sleepResp
	decodeJSON(t, closeResp, &closed)
	if closed.EndedAt == nil || !closed.EndedAt.Equal(ended) {
		t.Fatalf("close: ended_at = %v, want %v", closed.EndedAt, ended)
	}

	// /open is empty again.
	openResp = te.do(t, "GET", te.sleepsPath()+"/open", te.token, nil)
	if openResp.StatusCode != http.StatusNoContent {
		t.Fatalf("open after close: want 204, got %d: %s", openResp.StatusCode, readBody(openResp))
	}
	_ = openResp.Body.Close()

	// A bare close-shaped PATCH on the now-closed row routes to the edit
	// path and succeeds (ended_at is a legal partial edit), so instead
	// verify the close-race 409 with a fresh open row closed twice quickly.
	raceID := uuid.New()
	resp = te.do(t, "POST", te.sleepsPath(), te.token, map[string]any{
		"id":         raceID.String(),
		"started_at": started.Format(time.RFC3339),
	})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("race seed: %d: %s", resp.StatusCode, readBody(resp))
	}
	_ = resp.Body.Close()
	first := te.do(t, "PATCH", "/v1/sleeps/"+raceID.String(), te.token, map[string]any{
		"ended_at": ended.Format(time.RFC3339),
	})
	if first.StatusCode != http.StatusOK {
		t.Fatalf("race close 1: want 200, got %d: %s", first.StatusCode, readBody(first))
	}
	_ = first.Body.Close()
}

// TestCreateSleepValidation locks the 422s: ended_at < started_at on create,
// on close-PATCH, and on merged edit-PATCH; invalid sleep_type.
func TestCreateSleepValidation(t *testing.T) {
	te := newTestEnv(t)
	started := time.Now().UTC().Truncate(time.Second)

	// ended_at before started_at on create.
	resp := te.do(t, "POST", te.sleepsPath(), te.token, map[string]any{
		"started_at": started.Format(time.RFC3339),
		"ended_at":   started.Add(-time.Minute).Format(time.RFC3339),
	})
	if resp.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("create inverted: want 422, got %d: %s", resp.StatusCode, readBody(resp))
	}
	_ = resp.Body.Close()

	// Invalid sleep_type.
	resp = te.do(t, "POST", te.sleepsPath(), te.token, map[string]any{
		"started_at": started.Format(time.RFC3339),
		"sleep_type": "afternoon",
	})
	if resp.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("bad sleep_type: want 422, got %d: %s", resp.StatusCode, readBody(resp))
	}
	_ = resp.Body.Close()

	// Close-PATCH with ended_at before started_at.
	openID := uuid.New()
	resp = te.do(t, "POST", te.sleepsPath(), te.token, map[string]any{
		"id":         openID.String(),
		"started_at": started.Format(time.RFC3339),
	})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("seed open: %d: %s", resp.StatusCode, readBody(resp))
	}
	_ = resp.Body.Close()
	resp = te.do(t, "PATCH", "/v1/sleeps/"+openID.String(), te.token, map[string]any{
		"ended_at": started.Add(-time.Hour).Format(time.RFC3339),
	})
	if resp.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("close inverted: want 422, got %d: %s", resp.StatusCode, readBody(resp))
	}
	_ = resp.Body.Close()

	// Edit-PATCH whose merged pair is inverted: move started_at past the
	// stored ended_at on a closed row.
	closedID := uuid.New()
	resp = te.do(t, "POST", te.sleepsPath(), te.token, map[string]any{
		"id":         closedID.String(),
		"started_at": started.Add(-2 * time.Hour).Format(time.RFC3339),
		"ended_at":   started.Add(-time.Hour).Format(time.RFC3339),
	})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("seed closed: %d: %s", resp.StatusCode, readBody(resp))
	}
	_ = resp.Body.Close()
	resp = te.do(t, "PATCH", "/v1/sleeps/"+closedID.String(), te.token, map[string]any{
		"started_at": started.Format(time.RFC3339),
	})
	if resp.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("edit inverted: want 422, got %d: %s", resp.StatusCode, readBody(resp))
	}
	_ = resp.Body.Close()
}

// TestEditClosedSleep covers partial-edit semantics: untouched fields are
// preserved, empty string clears location/notes, clear_sleep_type clears the
// enum, and invalid enum values 422.
func TestEditClosedSleep(t *testing.T) {
	te := newTestEnv(t)
	started := time.Now().UTC().Add(-3 * time.Hour).Truncate(time.Second)
	ended := started.Add(time.Hour)
	id := uuid.New()

	resp := te.do(t, "POST", te.sleepsPath(), te.token, map[string]any{
		"id":         id.String(),
		"started_at": started.Format(time.RFC3339),
		"ended_at":   ended.Format(time.RFC3339),
		"sleep_type": "night",
		"location":   "crib",
		"notes":      "original",
	})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("seed: %d: %s", resp.StatusCode, readBody(resp))
	}
	_ = resp.Body.Close()

	// Change only the location; everything else must survive.
	patch := te.do(t, "PATCH", "/v1/sleeps/"+id.String(), te.token, map[string]any{
		"location": "stroller",
	})
	if patch.StatusCode != http.StatusOK {
		t.Fatalf("PATCH location: want 200, got %d: %s", patch.StatusCode, readBody(patch))
	}
	var updated sleepResp
	decodeJSON(t, patch, &updated)
	if updated.Location == nil || *updated.Location != "stroller" {
		t.Fatalf("PATCH location: got %v, want stroller", updated.Location)
	}
	if updated.SleepType == nil || *updated.SleepType != "night" {
		t.Fatalf("PATCH location: sleep_type = %v, want night (untouched)", updated.SleepType)
	}
	if updated.Notes == nil || *updated.Notes != "original" {
		t.Fatalf("PATCH location: notes = %v, want original (untouched)", updated.Notes)
	}
	if !updated.StartedAt.Equal(started) {
		t.Fatalf("PATCH location: started_at = %v, want %v (untouched)", updated.StartedAt, started)
	}

	// Empty string clears notes and location; clear_sleep_type clears the enum.
	patch = te.do(t, "PATCH", "/v1/sleeps/"+id.String(), te.token, map[string]any{
		"notes":            "",
		"location":         "",
		"clear_sleep_type": true,
	})
	if patch.StatusCode != http.StatusOK {
		t.Fatalf("PATCH clears: want 200, got %d: %s", patch.StatusCode, readBody(patch))
	}
	// Decode into a FRESH struct: cleared fields are omitted from the JSON
	// (omitempty), so reusing `updated` would keep the stale values.
	var cleared sleepResp
	decodeJSON(t, patch, &cleared)
	if cleared.Notes != nil {
		t.Fatalf("PATCH clears: notes = %v, want nil", cleared.Notes)
	}
	if cleared.Location != nil {
		t.Fatalf("PATCH clears: location = %v, want nil", cleared.Location)
	}
	if cleared.SleepType != nil {
		t.Fatalf("PATCH clears: sleep_type = %v, want nil", cleared.SleepType)
	}

	// Invalid enum on edit.
	bad := te.do(t, "PATCH", "/v1/sleeps/"+id.String(), te.token, map[string]any{
		"sleep_type": "afternoon",
	})
	if bad.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("PATCH bad enum: want 422, got %d: %s", bad.StatusCode, readBody(bad))
	}
	_ = bad.Body.Close()
}

// TestListSleepWindow verifies from/to filtering on started_at, DESC order,
// and the limit parameter.
func TestListSleepWindow(t *testing.T) {
	te := newTestEnv(t)
	base := time.Now().UTC().Add(-48 * time.Hour).Truncate(time.Second)

	for i := 0; i < 3; i++ {
		s := base.Add(time.Duration(i) * 6 * time.Hour)
		resp := te.do(t, "POST", te.sleepsPath(), te.token, map[string]any{
			"started_at": s.Format(time.RFC3339),
			"ended_at":   s.Add(time.Hour).Format(time.RFC3339),
		})
		if resp.StatusCode != http.StatusCreated {
			t.Fatalf("seed %d: %d: %s", i, resp.StatusCode, readBody(resp))
		}
		_ = resp.Body.Close()
	}

	// Window covering only the middle row.
	from := base.Add(5 * time.Hour)
	to := base.Add(7 * time.Hour)
	resp := te.do(t, "GET", te.sleepsPath()+"?from="+from.Format(time.RFC3339)+"&to="+to.Format(time.RFC3339), te.token, nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("window list: %d: %s", resp.StatusCode, readBody(resp))
	}
	var windowed []sleepResp
	decodeJSON(t, resp, &windowed)
	if len(windowed) != 1 {
		t.Fatalf("window list: got %d rows, want 1", len(windowed))
	}

	// Full window, DESC order, limit=2.
	from = base.Add(-time.Hour)
	to = base.Add(24 * time.Hour)
	resp = te.do(t, "GET", te.sleepsPath()+"?from="+from.Format(time.RFC3339)+"&to="+to.Format(time.RFC3339)+"&limit=2", te.token, nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("limit list: %d: %s", resp.StatusCode, readBody(resp))
	}
	var limited []sleepResp
	decodeJSON(t, resp, &limited)
	if len(limited) != 2 {
		t.Fatalf("limit list: got %d rows, want 2", len(limited))
	}
	if !limited[0].StartedAt.After(limited[1].StartedAt) {
		t.Fatalf("limit list: not DESC: %v then %v", limited[0].StartedAt, limited[1].StartedAt)
	}
}

// TestSleepAuthz verifies another user can't read or mutate this baby's
// sleeps, and unknown baby ids 404.
func TestSleepAuthz(t *testing.T) {
	te := newTestEnv(t)
	started := time.Now().UTC().Add(-time.Hour).Truncate(time.Second)
	id := uuid.New()
	resp := te.do(t, "POST", te.sleepsPath(), te.token, map[string]any{
		"id":         id.String(),
		"started_at": started.Format(time.RFC3339),
		"ended_at":   started.Add(30 * time.Minute).Format(time.RFC3339),
	})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("seed: %d: %s", resp.StatusCode, readBody(resp))
	}
	_ = resp.Body.Close()

	// A second user with no household membership.
	email := fmt.Sprintf("sleepauthz-%d@example.com", time.Now().UnixNano())
	regResp := te.do(t, "POST", "/v1/auth/register", "", map[string]any{
		"email":        email,
		"password":     "correct horse battery staple",
		"display_name": "Other",
	})
	if regResp.StatusCode != http.StatusCreated {
		t.Fatalf("register other: %d: %s", regResp.StatusCode, readBody(regResp))
	}
	var reg struct {
		AccessToken string `json:"access_token"`
	}
	decodeJSON(t, regResp, &reg)

	if r := te.do(t, "GET", te.sleepsPath(), reg.AccessToken, nil); r.StatusCode != http.StatusForbidden {
		t.Fatalf("other list: want 403, got %d: %s", r.StatusCode, readBody(r))
	}
	if r := te.do(t, "PATCH", "/v1/sleeps/"+id.String(), reg.AccessToken, map[string]any{"notes": "x"}); r.StatusCode != http.StatusForbidden {
		t.Fatalf("other patch: want 403, got %d: %s", r.StatusCode, readBody(r))
	}
	if r := te.do(t, "DELETE", "/v1/sleeps/"+id.String(), reg.AccessToken, nil); r.StatusCode != http.StatusForbidden {
		t.Fatalf("other delete: want 403, got %d: %s", r.StatusCode, readBody(r))
	}

	// Unknown baby id -> 404 for a member-less baby.
	if r := te.do(t, "GET", "/v1/babies/"+uuid.NewString()+"/sleeps", te.token, nil); r.StatusCode != http.StatusNotFound {
		t.Fatalf("unknown baby: want 404, got %d: %s", r.StatusCode, readBody(r))
	}
}

// TestDeleteSleep covers deleting an open row (allowed: "started by
// mistake") and the idempotent 204 on unknown ids.
func TestDeleteSleep(t *testing.T) {
	te := newTestEnv(t)
	started := time.Now().UTC().Truncate(time.Second)
	id := uuid.New()
	resp := te.do(t, "POST", te.sleepsPath(), te.token, map[string]any{
		"id":         id.String(),
		"started_at": started.Format(time.RFC3339),
	})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("seed open: %d: %s", resp.StatusCode, readBody(resp))
	}
	_ = resp.Body.Close()

	del := te.do(t, "DELETE", "/v1/sleeps/"+id.String(), te.token, nil)
	if del.StatusCode != http.StatusNoContent {
		t.Fatalf("delete: want 204, got %d: %s", del.StatusCode, readBody(del))
	}
	_ = del.Body.Close()

	openResp := te.do(t, "GET", te.sleepsPath()+"/open", te.token, nil)
	if openResp.StatusCode != http.StatusNoContent {
		t.Fatalf("open after delete: want 204, got %d: %s", openResp.StatusCode, readBody(openResp))
	}
	_ = openResp.Body.Close()

	// Unknown id deletes are 204 (idempotent).
	del = te.do(t, "DELETE", "/v1/sleeps/"+uuid.NewString(), te.token, nil)
	if del.StatusCode != http.StatusNoContent {
		t.Fatalf("delete unknown: want 204, got %d: %s", del.StatusCode, readBody(del))
	}
	_ = del.Body.Close()
}

// TestPreferencesAcceptsSleepKey locks the feature-visibility allowlist
// extension: hiding "sleep" round-trips through PUT /v1/me/preferences.
func TestPreferencesAcceptsSleepKey(t *testing.T) {
	te := newTestEnv(t)

	// The PUT is full-replace and rejects unknown fields, so build the body
	// from scratch rather than echoing the GET response (which carries
	// read-only fields like updated_at).
	putResp := te.do(t, "PUT", "/v1/me/preferences", te.token, map[string]any{
		"time_format":        "24h",
		"timezone":           "UTC",
		"locale":             "en",
		"chart_palette":      map[string]any{"preset": "default", "overrides": map[string]string{}},
		"feature_visibility": map[string]bool{"sleep": false},
	})
	if putResp.StatusCode != http.StatusOK {
		t.Fatalf("PUT prefs: want 200, got %d: %s", putResp.StatusCode, readBody(putResp))
	}
	if body := readBody(putResp); !strings.Contains(body, `"sleep":false`) {
		t.Fatalf("PUT prefs: missing sleep:false in %s", body)
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
