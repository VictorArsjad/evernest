// Integration tests for the diaper endpoints. Mirrors nursing_test.go and
// auth_test.go: hits the real chi router against a live Postgres, spins up
// a fresh user/household/baby per test so concurrent reruns don't collide.
// Coverage focuses on the photo attach feature added by migration 000010 —
// the legacy CRUD shape is already exercised in chart_integration_test.go
// and friends via the importer.
package diaper_test

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

// tinyJPEG is the 5-byte SOI/EOI-ish minimal sequence we use as a stand-in
// for a real image — the BE never decodes the pixels, it only stores the
// bytes and serves them back. We assert byte-equality on the round trip.
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

	email := fmt.Sprintf("diapertest-%d@example.com", time.Now().UnixNano())
	regResp := te.do(t, "POST", "/v1/auth/register", "", map[string]any{
		"email":        email,
		"password":     "correct horse battery staple",
		"display_name": "Diaper Test",
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

// diaperResp mirrors the JSON contract. Note the inclusion of HasPhoto
// (the canary the photo feature actually wired up) and the *string
// PhotoMime — the BE omits both fields' content from list rows that have
// no photo via `omitempty` on PhotoMime, but always includes HasPhoto as
// a bool (it's `false`, not absent, when there's no photo).
type diaperResp struct {
	ID         uuid.UUID `json:"id"`
	BabyID     uuid.UUID `json:"baby_id"`
	OccurredAt time.Time `json:"occurred_at"`
	Type       string    `json:"type"`
	Notes      *string   `json:"notes,omitempty"`
	HasPhoto   bool      `json:"has_photo"`
	PhotoMime  *string   `json:"photo_mime,omitempty"`
	Source     string    `json:"source"`
	CreatedAt  time.Time `json:"created_at"`
}

// TestCreateDiaperWithPhoto is the happy-path round trip: POST with a
// base64 photo, GET /photo returns the exact bytes with the declared
// mime, and the list endpoint exposes has_photo=true without shipping
// the blob.
func TestCreateDiaperWithPhoto(t *testing.T) {
	te := newTestEnv(t)
	babyPath := "/v1/babies/" + te.babyID.String() + "/diapers"

	occurred := time.Now().UTC().Add(-10 * time.Minute).Truncate(time.Second)
	resp := te.do(t, "POST", babyPath, te.token, map[string]any{
		"occurred_at": occurred.Format(time.RFC3339),
		"type":        "soiled",
		"photo":       base64.StdEncoding.EncodeToString(tinyJPEG),
		"photo_mime":  "image/jpeg",
	})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create: want 201, got %d: %s", resp.StatusCode, readBody(resp))
	}
	var created diaperResp
	decodeJSON(t, resp, &created)
	if !created.HasPhoto {
		t.Fatal("create: has_photo = false, want true")
	}
	if created.PhotoMime == nil || *created.PhotoMime != "image/jpeg" {
		t.Fatalf("create: photo_mime = %v, want image/jpeg", created.PhotoMime)
	}

	// Photo route returns the raw bytes with the declared mime.
	photoResp := te.do(t, "GET", "/v1/diapers/"+created.ID.String()+"/photo", te.token, nil)
	if photoResp.StatusCode != http.StatusOK {
		t.Fatalf("GET photo: want 200, got %d: %s", photoResp.StatusCode, readBody(photoResp))
	}
	if ct := photoResp.Header.Get("Content-Type"); ct != "image/jpeg" {
		t.Fatalf("GET photo: content-type = %q, want image/jpeg", ct)
	}
	if cc := photoResp.Header.Get("Cache-Control"); cc != "private, max-age=300" {
		t.Fatalf("GET photo: cache-control = %q, want private, max-age=300", cc)
	}
	gotBytes := readBytes(photoResp)
	if !bytes.Equal(gotBytes, tinyJPEG) {
		t.Fatalf("GET photo: bytes = %x, want %x", gotBytes, tinyJPEG)
	}

	// List endpoint shows has_photo but doesn't ship the blob. We check
	// the raw JSON for the substring `"photo"` to be sure the bytes
	// aren't there — Go's JSON encoder would only emit it if we Scan'd
	// into a field tagged that way, which the list query deliberately
	// doesn't.
	listResp := te.do(t, "GET", babyPath, te.token, nil)
	if listResp.StatusCode != http.StatusOK {
		t.Fatalf("list: want 200, got %d: %s", listResp.StatusCode, readBody(listResp))
	}
	listBody := readBody(listResp)
	if !strings.Contains(listBody, `"has_photo":true`) {
		t.Fatalf("list: missing has_photo:true in %s", listBody)
	}
	if strings.Contains(listBody, `"photo":"`) {
		t.Fatalf("list: should not ship raw photo bytes: %s", listBody)
	}
}

// TestCreateDiaperWithoutPhoto verifies the no-photo path: has_photo=false,
// photo_mime omitted from the JSON, and the photo route returns 204 (row
// exists, but no bytes attached).
func TestCreateDiaperWithoutPhoto(t *testing.T) {
	te := newTestEnv(t)
	babyPath := "/v1/babies/" + te.babyID.String() + "/diapers"

	occurred := time.Now().UTC().Add(-5 * time.Minute).Truncate(time.Second)
	resp := te.do(t, "POST", babyPath, te.token, map[string]any{
		"occurred_at": occurred.Format(time.RFC3339),
		"type":        "wet",
	})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create: want 201, got %d: %s", resp.StatusCode, readBody(resp))
	}
	var created diaperResp
	decodeJSON(t, resp, &created)
	if created.HasPhoto {
		t.Fatal("create: has_photo = true on a no-photo diaper")
	}
	if created.PhotoMime != nil {
		t.Fatalf("create: photo_mime = %q, want nil", *created.PhotoMime)
	}

	photoResp := te.do(t, "GET", "/v1/diapers/"+created.ID.String()+"/photo", te.token, nil)
	if photoResp.StatusCode != http.StatusNoContent {
		t.Fatalf("GET photo (no bytes): want 204, got %d: %s", photoResp.StatusCode, readBody(photoResp))
	}
	_ = photoResp.Body.Close()
}

// TestPatchClearPhoto creates a diaper with a photo, then clears it via
// `"photo": ""`. After the PATCH the photo route returns 204 and the row
// has has_photo=false.
func TestPatchClearPhoto(t *testing.T) {
	te := newTestEnv(t)
	babyPath := "/v1/babies/" + te.babyID.String() + "/diapers"

	occurred := time.Now().UTC().Truncate(time.Second)
	resp := te.do(t, "POST", babyPath, te.token, map[string]any{
		"occurred_at": occurred.Format(time.RFC3339),
		"type":        "mixed",
		"photo":       base64.StdEncoding.EncodeToString(tinyJPEG),
		"photo_mime":  "image/jpeg",
	})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("seed: %d: %s", resp.StatusCode, readBody(resp))
	}
	var seed diaperResp
	decodeJSON(t, resp, &seed)

	patch := te.do(t, "PATCH", "/v1/diapers/"+seed.ID.String(), te.token, map[string]any{
		"photo": "",
	})
	if patch.StatusCode != http.StatusOK {
		t.Fatalf("PATCH clear: want 200, got %d: %s", patch.StatusCode, readBody(patch))
	}
	var cleared diaperResp
	decodeJSON(t, patch, &cleared)
	if cleared.HasPhoto {
		t.Fatal("PATCH clear: has_photo still true")
	}
	if cleared.PhotoMime != nil {
		t.Fatalf("PATCH clear: photo_mime = %q, want nil", *cleared.PhotoMime)
	}

	photoResp := te.do(t, "GET", "/v1/diapers/"+seed.ID.String()+"/photo", te.token, nil)
	if photoResp.StatusCode != http.StatusNoContent {
		t.Fatalf("GET photo after clear: want 204, got %d", photoResp.StatusCode)
	}
	_ = photoResp.Body.Close()
}

// TestPatchReplacePhoto creates with one mime, replaces with another, and
// verifies both bytes and mime came through.
func TestPatchReplacePhoto(t *testing.T) {
	te := newTestEnv(t)
	babyPath := "/v1/babies/" + te.babyID.String() + "/diapers"

	occurred := time.Now().UTC().Truncate(time.Second)
	resp := te.do(t, "POST", babyPath, te.token, map[string]any{
		"occurred_at": occurred.Format(time.RFC3339),
		"type":        "wet",
		"photo":       base64.StdEncoding.EncodeToString(tinyJPEG),
		"photo_mime":  "image/jpeg",
	})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("seed: %d: %s", resp.StatusCode, readBody(resp))
	}
	var seed diaperResp
	decodeJSON(t, resp, &seed)

	replacement := []byte{0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x99, 0xAA}
	patch := te.do(t, "PATCH", "/v1/diapers/"+seed.ID.String(), te.token, map[string]any{
		"photo":      base64.StdEncoding.EncodeToString(replacement),
		"photo_mime": "image/png",
	})
	if patch.StatusCode != http.StatusOK {
		t.Fatalf("PATCH replace: want 200, got %d: %s", patch.StatusCode, readBody(patch))
	}
	var replaced diaperResp
	decodeJSON(t, patch, &replaced)
	if !replaced.HasPhoto {
		t.Fatal("PATCH replace: has_photo = false")
	}
	if replaced.PhotoMime == nil || *replaced.PhotoMime != "image/png" {
		t.Fatalf("PATCH replace: photo_mime = %v, want image/png", replaced.PhotoMime)
	}

	photoResp := te.do(t, "GET", "/v1/diapers/"+seed.ID.String()+"/photo", te.token, nil)
	if photoResp.StatusCode != http.StatusOK {
		t.Fatalf("GET photo after replace: want 200, got %d", photoResp.StatusCode)
	}
	if ct := photoResp.Header.Get("Content-Type"); ct != "image/png" {
		t.Fatalf("GET photo: content-type = %q, want image/png", ct)
	}
	got := readBytes(photoResp)
	if !bytes.Equal(got, replacement) {
		t.Fatalf("GET photo bytes = %x, want %x", got, replacement)
	}
}

// TestCreateDiaperPhotoValidation covers the 422 / 400 / 413 error paths
// in decodePhoto. Each subtest is independent because the table is empty
// from newTestEnv's standpoint and we don't actually need stored rows.
func TestCreateDiaperPhotoValidation(t *testing.T) {
	te := newTestEnv(t)
	babyPath := "/v1/babies/" + te.babyID.String() + "/diapers"
	now := time.Now().UTC().Truncate(time.Second)
	base := map[string]any{
		"occurred_at": now.Format(time.RFC3339),
		"type":        "wet",
	}

	// photo set, photo_mime missing -> 422.
	noMime := withExtras(base, map[string]any{
		"photo": base64.StdEncoding.EncodeToString(tinyJPEG),
	})
	resp := te.do(t, "POST", babyPath, te.token, noMime)
	if resp.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("photo without mime: want 422, got %d: %s", resp.StatusCode, readBody(resp))
	}
	_ = resp.Body.Close()

	// photo_mime set, photo missing -> 422.
	noPhoto := withExtras(base, map[string]any{
		"photo_mime": "image/jpeg",
	})
	resp = te.do(t, "POST", babyPath, te.token, noPhoto)
	if resp.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("mime without photo: want 422, got %d: %s", resp.StatusCode, readBody(resp))
	}
	_ = resp.Body.Close()

	// Unsupported mime -> 422.
	bogus := withExtras(base, map[string]any{
		"photo":      base64.StdEncoding.EncodeToString(tinyJPEG),
		"photo_mime": "image/gif",
	})
	resp = te.do(t, "POST", babyPath, te.token, bogus)
	if resp.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("unsupported mime: want 422, got %d: %s", resp.StatusCode, readBody(resp))
	}
	_ = resp.Body.Close()

	// Invalid base64 -> 400.
	badB64 := withExtras(base, map[string]any{
		"photo":      "not!valid#base64===",
		"photo_mime": "image/jpeg",
	})
	resp = te.do(t, "POST", babyPath, te.token, badB64)
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("bad base64: want 400, got %d: %s", resp.StatusCode, readBody(resp))
	}
	_ = resp.Body.Close()

	// Oversized photo -> 413. 2.5 MB of zeros is well past the 2 MB raw
	// cap but still well under the 3 MB body cap so the JSON decoder
	// gets through and decodePhoto is the one returning 413.
	big := make([]byte, 2500*1024)
	oversize := withExtras(base, map[string]any{
		"photo":      base64.StdEncoding.EncodeToString(big),
		"photo_mime": "image/jpeg",
	})
	resp = te.do(t, "POST", babyPath, te.token, oversize)
	if resp.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized: want 413, got %d: %s", resp.StatusCode, readBody(resp))
	}
	_ = resp.Body.Close()
}

// TestPatchPhotoMimeWithoutPhoto sanity-checks the PATCH-side validation:
// supplying just `"photo_mime"` (without a `"photo"` key) is a no-op for
// the photo (it doesn't match either the clear or the replace branch).
// The handler currently leaves the columns alone in that case; we lock
// that behavior in so a future refactor doesn't silently start treating
// a stray mime as "clear" or "broken".
func TestPatchPhotoMimeWithoutPhoto(t *testing.T) {
	te := newTestEnv(t)
	babyPath := "/v1/babies/" + te.babyID.String() + "/diapers"
	occurred := time.Now().UTC().Truncate(time.Second)

	resp := te.do(t, "POST", babyPath, te.token, map[string]any{
		"occurred_at": occurred.Format(time.RFC3339),
		"type":        "soiled",
		"photo":       base64.StdEncoding.EncodeToString(tinyJPEG),
		"photo_mime":  "image/jpeg",
	})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("seed: %d: %s", resp.StatusCode, readBody(resp))
	}
	var seed diaperResp
	decodeJSON(t, resp, &seed)

	patch := te.do(t, "PATCH", "/v1/diapers/"+seed.ID.String(), te.token, map[string]any{
		"notes":      "tweak",
		"photo_mime": "image/png",
	})
	if patch.StatusCode != http.StatusOK {
		t.Fatalf("PATCH mime-only: want 200, got %d: %s", patch.StatusCode, readBody(patch))
	}
	var after diaperResp
	decodeJSON(t, patch, &after)
	if !after.HasPhoto {
		t.Fatal("PATCH mime-only: should not have cleared the photo")
	}
	// The mime stays whatever was originally stored (image/jpeg) because
	// the "replace" branch only fires when `photo` is also present and
	// non-empty.
	if after.PhotoMime == nil || *after.PhotoMime != "image/jpeg" {
		t.Fatalf("PATCH mime-only: photo_mime = %v, want unchanged image/jpeg", after.PhotoMime)
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

func readBytes(r *http.Response) []byte {
	defer func() { _ = r.Body.Close() }()
	b, _ := io.ReadAll(r.Body)
	return b
}

func withExtras(base, extras map[string]any) map[string]any {
	out := make(map[string]any, len(base)+len(extras))
	for k, v := range base {
		out[k] = v
	}
	for k, v := range extras {
		out[k] = v
	}
	return out
}
