// Integration tests for the nursing endpoints. Hits the real chi router
// against a live Postgres (dev DB by default). Mirrors auth_test.go for
// wiring; uses a fresh registered user + household + baby per test so
// concurrent reruns don't collide on baby_id (the at-most-one-open
// invariant is per-baby and we want to exercise it without coordinating
// state across runs).
package nursing_test

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

// newTestEnv boots an isolated chi server, registers a fresh user, creates
// a household + baby, and returns the bearer + baby_id ready to use.
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
	client := &http.Client{Timeout: 5 * time.Second}

	te := &testEnv{server: srv, client: client}

	// register
	email := fmt.Sprintf("nursingtest-%d@example.com", time.Now().UnixNano())
	regResp := te.do(t, "POST", "/v1/auth/register", "", map[string]any{
		"email":        email,
		"password":     "correct horse battery staple",
		"display_name": "Nursing Test",
	})
	if regResp.StatusCode != http.StatusCreated {
		t.Fatalf("register: %d: %s", regResp.StatusCode, readBody(regResp))
	}
	var reg struct {
		AccessToken string `json:"access_token"`
	}
	decodeJSON(t, regResp, &reg)
	te.token = reg.AccessToken

	// household
	hhResp := te.do(t, "POST", "/v1/households", te.token, map[string]any{"name": "H"})
	if hhResp.StatusCode != http.StatusCreated {
		t.Fatalf("household: %d: %s", hhResp.StatusCode, readBody(hhResp))
	}
	var hh struct {
		ID uuid.UUID `json:"id"`
	}
	decodeJSON(t, hhResp, &hh)

	// baby
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

// nursingResp mirrors nursing.Nursing as a test-side struct so we don't
// need to import the package and can assert on the JSON contract directly.
type nursingResp struct {
	ID             uuid.UUID  `json:"id"`
	BabyID         uuid.UUID  `json:"baby_id"`
	StartedAt      time.Time  `json:"started_at"`
	EndedAt        *time.Time `json:"ended_at,omitempty"`
	StartingBreast *string    `json:"starting_breast,omitempty"`
	NursingSide    string     `json:"nursing_side"`
	LeftDurationS  int        `json:"left_duration_s"`
	RightDurationS int        `json:"right_duration_s"`
	Notes          *string    `json:"notes,omitempty"`
	Source         string     `json:"source"`
	CreatedAt      time.Time  `json:"created_at"`
}

// TestOpenNursingLifecycle is the happy-path integration story: open a
// session, see it via /open, close it via PATCH, /open returns 204, then
// DELETE removes the row. Roughly mirrors the FE's expected flow.
func TestOpenNursingLifecycle(t *testing.T) {
	te := newTestEnv(t)
	babyPath := "/v1/babies/" + te.babyID.String() + "/nursing-sessions"

	startedAt := time.Now().UTC().Add(-5 * time.Minute).Truncate(time.Second)
	openResp := te.do(t, "POST", babyPath, te.token, map[string]any{
		"started_at":   startedAt.Format(time.RFC3339),
		"nursing_side": "both",
	})
	if openResp.StatusCode != http.StatusCreated {
		t.Fatalf("open POST: want 201, got %d: %s", openResp.StatusCode, readBody(openResp))
	}
	var open nursingResp
	decodeJSON(t, openResp, &open)
	if open.EndedAt != nil {
		t.Fatalf("open POST: expected null ended_at, got %v", open.EndedAt)
	}
	if open.LeftDurationS != 0 || open.RightDurationS != 0 {
		t.Fatalf("open POST: expected 0/0 durations, got %d/%d", open.LeftDurationS, open.RightDurationS)
	}

	// GET /open returns the row.
	getResp := te.do(t, "GET", babyPath+"/open", te.token, nil)
	if getResp.StatusCode != http.StatusOK {
		t.Fatalf("GET open: want 200, got %d: %s", getResp.StatusCode, readBody(getResp))
	}
	var got nursingResp
	decodeJSON(t, getResp, &got)
	if got.ID != open.ID {
		t.Fatalf("GET open: id = %s, want %s", got.ID, open.ID)
	}
	if got.EndedAt != nil {
		t.Fatalf("GET open: expected null ended_at, got %v", got.EndedAt)
	}

	// PATCH closes it.
	endedAt := startedAt.Add(15 * time.Minute)
	endResp := te.do(t, "PATCH", "/v1/nursing-sessions/"+open.ID.String(), te.token, map[string]any{
		"ended_at":         endedAt.Format(time.RFC3339),
		"left_duration_s":  300,
		"right_duration_s": 600,
	})
	if endResp.StatusCode != http.StatusOK {
		t.Fatalf("PATCH end: want 200, got %d: %s", endResp.StatusCode, readBody(endResp))
	}
	var ended nursingResp
	decodeJSON(t, endResp, &ended)
	if ended.EndedAt == nil {
		t.Fatal("PATCH end: expected non-null ended_at")
	}
	if ended.LeftDurationS != 300 || ended.RightDurationS != 600 {
		t.Fatalf("PATCH end: durations %d/%d, want 300/600", ended.LeftDurationS, ended.RightDurationS)
	}

	// PATCH again -> 409 already_closed
	dupEndResp := te.do(t, "PATCH", "/v1/nursing-sessions/"+open.ID.String(), te.token, map[string]any{
		"ended_at":         endedAt.Format(time.RFC3339),
		"left_duration_s":  300,
		"right_duration_s": 600,
	})
	if dupEndResp.StatusCode != http.StatusConflict {
		t.Fatalf("PATCH already-closed: want 409, got %d: %s", dupEndResp.StatusCode, readBody(dupEndResp))
	}
	_ = dupEndResp.Body.Close()

	// GET /open returns 204.
	emptyResp := te.do(t, "GET", babyPath+"/open", te.token, nil)
	if emptyResp.StatusCode != http.StatusNoContent {
		t.Fatalf("GET open after close: want 204, got %d: %s", emptyResp.StatusCode, readBody(emptyResp))
	}
	_ = emptyResp.Body.Close()

	// DELETE removes the row.
	delResp := te.do(t, "DELETE", "/v1/nursing-sessions/"+open.ID.String(), te.token, nil)
	if delResp.StatusCode != http.StatusNoContent {
		t.Fatalf("DELETE: want 204, got %d: %s", delResp.StatusCode, readBody(delResp))
	}
	_ = delResp.Body.Close()
}

// TestCreateOpenSessionConflict ensures the at-most-one-open-per-baby
// invariant holds: a second "start now" while one is already running
// should be rejected as 409.
func TestCreateOpenSessionConflict(t *testing.T) {
	te := newTestEnv(t)
	babyPath := "/v1/babies/" + te.babyID.String() + "/nursing-sessions"

	startedAt := time.Now().UTC().Truncate(time.Second)
	first := te.do(t, "POST", babyPath, te.token, map[string]any{
		"started_at":   startedAt.Format(time.RFC3339),
		"nursing_side": "left",
	})
	if first.StatusCode != http.StatusCreated {
		t.Fatalf("first open: want 201, got %d: %s", first.StatusCode, readBody(first))
	}
	_ = first.Body.Close()

	second := te.do(t, "POST", babyPath, te.token, map[string]any{
		"started_at":   startedAt.Add(time.Minute).Format(time.RFC3339),
		"nursing_side": "right",
	})
	if second.StatusCode != http.StatusConflict {
		t.Fatalf("second open: want 409, got %d: %s", second.StatusCode, readBody(second))
	}
	_ = second.Body.Close()

	// Creating a CLOSED session while one is open is fine — the conflict
	// check only fires for the open path.
	closed := te.do(t, "POST", babyPath, te.token, map[string]any{
		"started_at":       startedAt.Add(2 * time.Minute).Format(time.RFC3339),
		"ended_at":         startedAt.Add(10 * time.Minute).Format(time.RFC3339),
		"nursing_side":     "left",
		"left_duration_s":  300,
		"right_duration_s": 0,
	})
	if closed.StatusCode != http.StatusCreated {
		t.Fatalf("closed-while-open: want 201, got %d: %s", closed.StatusCode, readBody(closed))
	}
	_ = closed.Body.Close()
}

// TestCreateValidationBranches exercises the new "all three together or
// none" rule introduced by this slice. The legacy closed-session shape
// (everything filled in) is also covered to make sure we didn't regress
// it while loosening the schema.
func TestCreateValidationBranches(t *testing.T) {
	te := newTestEnv(t)
	babyPath := "/v1/babies/" + te.babyID.String() + "/nursing-sessions"
	now := time.Now().UTC().Truncate(time.Second)

	// Legacy closed-session shape still works.
	closed := te.do(t, "POST", babyPath, te.token, map[string]any{
		"started_at":       now.Add(-30 * time.Minute).Format(time.RFC3339),
		"ended_at":         now.Add(-15 * time.Minute).Format(time.RFC3339),
		"nursing_side":     "both",
		"starting_breast":  "left",
		"left_duration_s":  300,
		"right_duration_s": 600,
	})
	if closed.StatusCode != http.StatusCreated {
		t.Fatalf("closed: want 201, got %d: %s", closed.StatusCode, readBody(closed))
	}
	_ = closed.Body.Close()

	// ended_at without durations -> 422
	endNoDur := te.do(t, "POST", babyPath, te.token, map[string]any{
		"started_at":   now.Format(time.RFC3339),
		"ended_at":     now.Add(5 * time.Minute).Format(time.RFC3339),
		"nursing_side": "left",
	})
	if endNoDur.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("ended_at w/o durations: want 422, got %d: %s", endNoDur.StatusCode, readBody(endNoDur))
	}
	_ = endNoDur.Body.Close()

	// durations without ended_at -> 422
	durNoEnd := te.do(t, "POST", babyPath, te.token, map[string]any{
		"started_at":       now.Format(time.RFC3339),
		"nursing_side":     "left",
		"left_duration_s":  60,
		"right_duration_s": 0,
	})
	if durNoEnd.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("durations w/o ended_at: want 422, got %d: %s", durNoEnd.StatusCode, readBody(durNoEnd))
	}
	_ = durNoEnd.Body.Close()

	// only one of left/right -> 422 (also "durations required" path)
	onlyLeft := te.do(t, "POST", babyPath, te.token, map[string]any{
		"started_at":      now.Format(time.RFC3339),
		"ended_at":        now.Add(5 * time.Minute).Format(time.RFC3339),
		"nursing_side":    "both",
		"left_duration_s": 60,
	})
	if onlyLeft.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("partial durations: want 422, got %d: %s", onlyLeft.StatusCode, readBody(onlyLeft))
	}
	_ = onlyLeft.Body.Close()

	// ended_at < started_at -> 422
	endBefore := te.do(t, "POST", babyPath, te.token, map[string]any{
		"started_at":       now.Format(time.RFC3339),
		"ended_at":         now.Add(-5 * time.Minute).Format(time.RFC3339),
		"nursing_side":     "left",
		"left_duration_s":  60,
		"right_duration_s": 0,
	})
	if endBefore.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("ended_at<started_at: want 422, got %d: %s", endBefore.StatusCode, readBody(endBefore))
	}
	_ = endBefore.Body.Close()
}

// TestPatchValidation covers the per-field validation on the close path:
// missing required fields, durations out of range, ended_at before
// started_at.
func TestPatchValidation(t *testing.T) {
	te := newTestEnv(t)
	babyPath := "/v1/babies/" + te.babyID.String() + "/nursing-sessions"

	startedAt := time.Now().UTC().Truncate(time.Second)
	openResp := te.do(t, "POST", babyPath, te.token, map[string]any{
		"started_at":   startedAt.Format(time.RFC3339),
		"nursing_side": "both",
	})
	if openResp.StatusCode != http.StatusCreated {
		t.Fatalf("open POST: %d: %s", openResp.StatusCode, readBody(openResp))
	}
	var open nursingResp
	decodeJSON(t, openResp, &open)
	itemPath := "/v1/nursing-sessions/" + open.ID.String()

	// Missing durations -> 422
	missing := te.do(t, "PATCH", itemPath, te.token, map[string]any{
		"ended_at": startedAt.Add(5 * time.Minute).Format(time.RFC3339),
	})
	if missing.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("PATCH missing durations: want 422, got %d: %s", missing.StatusCode, readBody(missing))
	}
	_ = missing.Body.Close()

	// ended_at before started_at -> 422
	before := te.do(t, "PATCH", itemPath, te.token, map[string]any{
		"ended_at":         startedAt.Add(-time.Minute).Format(time.RFC3339),
		"left_duration_s":  60,
		"right_duration_s": 0,
	})
	if before.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("PATCH ended_at<started_at: want 422, got %d: %s", before.StatusCode, readBody(before))
	}
	_ = before.Body.Close()

	// duration out of range (> 21600) -> 422
	tooBig := te.do(t, "PATCH", itemPath, te.token, map[string]any{
		"ended_at":         startedAt.Add(time.Hour).Format(time.RFC3339),
		"left_duration_s":  21601,
		"right_duration_s": 0,
	})
	if tooBig.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("PATCH duration > max: want 422, got %d: %s", tooBig.StatusCode, readBody(tooBig))
	}
	_ = tooBig.Body.Close()

	// negative duration -> 422
	neg := te.do(t, "PATCH", itemPath, te.token, map[string]any{
		"ended_at":         startedAt.Add(time.Hour).Format(time.RFC3339),
		"left_duration_s":  -1,
		"right_duration_s": 0,
	})
	if neg.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("PATCH negative duration: want 422, got %d: %s", neg.StatusCode, readBody(neg))
	}
	_ = neg.Body.Close()

	// PATCHing a non-existent id -> 404
	missingID := te.do(t, "PATCH", "/v1/nursing-sessions/"+uuid.NewString(), te.token, map[string]any{
		"ended_at":         startedAt.Add(time.Hour).Format(time.RFC3339),
		"left_duration_s":  0,
		"right_duration_s": 0,
	})
	if missingID.StatusCode != http.StatusNotFound {
		t.Fatalf("PATCH missing id: want 404, got %d: %s", missingID.StatusCode, readBody(missingID))
	}
	_ = missingID.Body.Close()
}

// TestEditClosedNursingSession covers the closed-session edit path of
// PATCH /v1/nursing-sessions/{id}. The handler dispatches on the row's
// current ended_at state — if non-NULL, the body is interpreted as a
// partial edit rather than the legacy close-session contract.
func TestEditClosedNursingSession(t *testing.T) {
	te := newTestEnv(t)
	babyPath := "/v1/babies/" + te.babyID.String() + "/nursing-sessions"

	startedAt := time.Now().UTC().Add(-30 * time.Minute).Truncate(time.Second)
	endedAt := startedAt.Add(20 * time.Minute)

	// Seed a closed session directly.
	closed := te.do(t, "POST", babyPath, te.token, map[string]any{
		"started_at":       startedAt.Format(time.RFC3339),
		"ended_at":         endedAt.Format(time.RFC3339),
		"nursing_side":     "both",
		"starting_breast":  "left",
		"left_duration_s":  600,
		"right_duration_s": 600,
		"notes":            "original notes",
	})
	if closed.StatusCode != http.StatusCreated {
		t.Fatalf("seed closed: %d: %s", closed.StatusCode, readBody(closed))
	}
	var row nursingResp
	decodeJSON(t, closed, &row)
	itemPath := "/v1/nursing-sessions/" + row.ID.String()

	// Edit: change side to right-only, drop right duration, update notes.
	editResp := te.do(t, "PATCH", itemPath, te.token, map[string]any{
		"nursing_side":     "right",
		"left_duration_s":  0,
		"right_duration_s": 900,
		"notes":            "corrected",
	})
	if editResp.StatusCode != http.StatusOK {
		t.Fatalf("edit closed: want 200, got %d: %s", editResp.StatusCode, readBody(editResp))
	}
	var edited nursingResp
	decodeJSON(t, editResp, &edited)
	if edited.NursingSide != "right" {
		t.Fatalf("edit: nursing_side = %s, want right", edited.NursingSide)
	}
	if edited.LeftDurationS != 0 || edited.RightDurationS != 900 {
		t.Fatalf("edit: durations %d/%d, want 0/900", edited.LeftDurationS, edited.RightDurationS)
	}
	if edited.Notes == nil || *edited.Notes != "corrected" {
		t.Fatalf("edit: notes = %v, want \"corrected\"", edited.Notes)
	}
	// ended_at must remain non-null (edits cannot re-open a closed session).
	if edited.EndedAt == nil {
		t.Fatal("edit: ended_at unexpectedly cleared")
	}

	// Clearing notes via empty string -> NULL on the row.
	clearResp := te.do(t, "PATCH", itemPath, te.token, map[string]any{
		"notes": "",
	})
	if clearResp.StatusCode != http.StatusOK {
		t.Fatalf("clear notes: want 200, got %d: %s", clearResp.StatusCode, readBody(clearResp))
	}
	var cleared nursingResp
	decodeJSON(t, clearResp, &cleared)
	if cleared.Notes != nil {
		t.Fatalf("clear notes: notes = %q, want nil", *cleared.Notes)
	}

	// clear_starting_breast: true -> NULL.
	clearBreast := te.do(t, "PATCH", itemPath, te.token, map[string]any{
		"clear_starting_breast": true,
	})
	if clearBreast.StatusCode != http.StatusOK {
		t.Fatalf("clear starting_breast: want 200, got %d: %s", clearBreast.StatusCode, readBody(clearBreast))
	}
	var clearedBreast nursingResp
	decodeJSON(t, clearBreast, &clearedBreast)
	if clearedBreast.StartingBreast != nil {
		t.Fatalf("clear starting_breast: %q, want nil", *clearedBreast.StartingBreast)
	}

	// ended_at < started_at after merging in the requested started_at -> 422.
	bad := te.do(t, "PATCH", itemPath, te.token, map[string]any{
		"started_at": endedAt.Add(time.Hour).Format(time.RFC3339),
	})
	if bad.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("edit started_at past ended_at: want 422, got %d: %s", bad.StatusCode, readBody(bad))
	}
	_ = bad.Body.Close()
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
