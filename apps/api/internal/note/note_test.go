// Integration tests for the note endpoints. Mirrors diaper_test.go: hits the
// real chi router against a live Postgres, spins up a fresh user/household/baby
// per test so concurrent reruns don't collide. Coverage focuses on the note's
// required `body`, the optional-photo round trip, and PATCH semantics.
package note_test

import (
	"bytes"
	"context"
	"encoding/base64"
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

// tinyJPEG is the minimal byte sequence we use as a stand-in for a real image —
// the BE never decodes the pixels, it only stores the bytes and serves them
// back. We assert byte-equality on the round trip.
var tinyJPEG = []byte{0xFF, 0xD8, 0xFF, 0xD9, 0x00, 0x01, 0x02, 0x03}

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

	email := fmt.Sprintf("notetest-%d@example.com", time.Now().UnixNano())
	regResp := te.do(t, "POST", "/v1/auth/register", "", map[string]any{
		"email":        email,
		"password":     "correct horse battery staple",
		"display_name": "Note Test",
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

// noteResp mirrors the JSON contract.
type noteResp struct {
	ID         uuid.UUID `json:"id"`
	BabyID     uuid.UUID `json:"baby_id"`
	OccurredAt time.Time `json:"occurred_at"`
	Body       string    `json:"body"`
	HasPhoto   bool      `json:"has_photo"`
	PhotoMime  *string   `json:"photo_mime,omitempty"`
	Source     string    `json:"source"`
	CreatedAt  time.Time `json:"created_at"`
}

// TestCreateNote covers the happy path without a photo: the body round-trips
// and has_photo is false.
func TestCreateNote(t *testing.T) {
	te := newTestEnv(t)
	babyPath := "/v1/babies/" + te.babyID.String() + "/notes"

	occurred := time.Now().UTC().Add(-5 * time.Minute).Truncate(time.Second)
	resp := te.do(t, "POST", babyPath, te.token, map[string]any{
		"occurred_at": occurred.Format(time.RFC3339),
		"body":        "had a small rash on hand",
	})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create: want 201, got %d: %s", resp.StatusCode, readBody(resp))
	}
	var created noteResp
	decodeJSON(t, resp, &created)
	if created.Body != "had a small rash on hand" {
		t.Fatalf("create: body = %q", created.Body)
	}
	if created.HasPhoto {
		t.Fatal("create: has_photo = true on a no-photo note")
	}

	// List exposes the note.
	listResp := te.do(t, "GET", babyPath, te.token, nil)
	if listResp.StatusCode != http.StatusOK {
		t.Fatalf("list: want 200, got %d: %s", listResp.StatusCode, readBody(listResp))
	}
	listBody := readBody(listResp)
	if !strings.Contains(listBody, "had a small rash on hand") {
		t.Fatalf("list: missing body in %s", listBody)
	}
}

// TestCreateNoteRequiresBody locks in the required-body contract: a missing
// body and a whitespace-only body both 422.
func TestCreateNoteRequiresBody(t *testing.T) {
	te := newTestEnv(t)
	babyPath := "/v1/babies/" + te.babyID.String() + "/notes"
	now := time.Now().UTC().Truncate(time.Second)

	// Missing body -> 422 (validator `required`).
	resp := te.do(t, "POST", babyPath, te.token, map[string]any{
		"occurred_at": now.Format(time.RFC3339),
	})
	if resp.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("missing body: want 422, got %d: %s", resp.StatusCode, readBody(resp))
	}
	_ = resp.Body.Close()

	// Whitespace-only body -> 422 (trim guard).
	resp = te.do(t, "POST", babyPath, te.token, map[string]any{
		"occurred_at": now.Format(time.RFC3339),
		"body":        "   ",
	})
	if resp.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("blank body: want 422, got %d: %s", resp.StatusCode, readBody(resp))
	}
	_ = resp.Body.Close()
}

// TestCreateNoteWithPhoto is the photo happy-path round trip: POST with a
// base64 photo, GET /photo returns the exact bytes, list shows has_photo
// without shipping the blob.
func TestCreateNoteWithPhoto(t *testing.T) {
	te := newTestEnv(t)
	babyPath := "/v1/babies/" + te.babyID.String() + "/notes"

	occurred := time.Now().UTC().Add(-10 * time.Minute).Truncate(time.Second)
	resp := te.do(t, "POST", babyPath, te.token, map[string]any{
		"occurred_at": occurred.Format(time.RFC3339),
		"body":        "bruise photo",
		"photo":       base64.StdEncoding.EncodeToString(tinyJPEG),
		"photo_mime":  "image/jpeg",
	})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create: want 201, got %d: %s", resp.StatusCode, readBody(resp))
	}
	var created noteResp
	decodeJSON(t, resp, &created)
	if !created.HasPhoto {
		t.Fatal("create: has_photo = false, want true")
	}

	photoResp := te.do(t, "GET", "/v1/notes/"+created.ID.String()+"/photo", te.token, nil)
	if photoResp.StatusCode != http.StatusOK {
		t.Fatalf("GET photo: want 200, got %d: %s", photoResp.StatusCode, readBody(photoResp))
	}
	if ct := photoResp.Header.Get("Content-Type"); ct != "image/jpeg" {
		t.Fatalf("GET photo: content-type = %q, want image/jpeg", ct)
	}
	gotBytes := readBytes(photoResp)
	if !bytes.Equal(gotBytes, tinyJPEG) {
		t.Fatalf("GET photo: bytes = %x, want %x", gotBytes, tinyJPEG)
	}

	listResp := te.do(t, "GET", babyPath, te.token, nil)
	listBody := readBody(listResp)
	if !strings.Contains(listBody, `"has_photo":true`) {
		t.Fatalf("list: missing has_photo:true in %s", listBody)
	}
	if strings.Contains(listBody, `"photo":"`) {
		t.Fatalf("list: should not ship raw photo bytes: %s", listBody)
	}
}

// TestPatchNoteBody updates the body and verifies a blank body is rejected
// (the column is NOT NULL and can't be cleared).
func TestPatchNoteBody(t *testing.T) {
	te := newTestEnv(t)
	babyPath := "/v1/babies/" + te.babyID.String() + "/notes"

	occurred := time.Now().UTC().Truncate(time.Second)
	resp := te.do(t, "POST", babyPath, te.token, map[string]any{
		"occurred_at": occurred.Format(time.RFC3339),
		"body":        "original",
	})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("seed: %d: %s", resp.StatusCode, readBody(resp))
	}
	var seed noteResp
	decodeJSON(t, resp, &seed)

	patch := te.do(t, "PATCH", "/v1/notes/"+seed.ID.String(), te.token, map[string]any{
		"body": "edited",
	})
	if patch.StatusCode != http.StatusOK {
		t.Fatalf("PATCH body: want 200, got %d: %s", patch.StatusCode, readBody(patch))
	}
	var updated noteResp
	decodeJSON(t, patch, &updated)
	if updated.Body != "edited" {
		t.Fatalf("PATCH body: got %q, want edited", updated.Body)
	}

	// Blank body -> 422.
	blank := te.do(t, "PATCH", "/v1/notes/"+seed.ID.String(), te.token, map[string]any{
		"body": "  ",
	})
	if blank.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("PATCH blank body: want 422, got %d: %s", blank.StatusCode, readBody(blank))
	}
	_ = blank.Body.Close()
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

func readBytes(r *http.Response) []byte {
	defer func() { _ = r.Body.Close() }()
	b, _ := io.ReadAll(r.Body)
	return b
}
