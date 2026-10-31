package solidmeal_test

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

	email := fmt.Sprintf("solidtest-%d@example.com", time.Now().UnixNano())
	regResp := te.do(t, "POST", "/v1/auth/register", "", map[string]any{
		"email":        email,
		"password":     "correct horse battery staple",
		"display_name": "Solid Test",
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

type mealResp struct {
	ID         uuid.UUID `json:"id"`
	BabyID     uuid.UUID `json:"baby_id"`
	OccurredAt time.Time `json:"occurred_at"`
	Foods      []string  `json:"foods"`
	Reaction   *string   `json:"reaction,omitempty"`
	AmountG    *float64  `json:"amount_g,omitempty"`
	Notes      *string   `json:"notes,omitempty"`
	HasPhoto   bool      `json:"has_photo"`
	PhotoMime  *string   `json:"photo_mime,omitempty"`
	Source     string    `json:"source"`
	CreatedAt  time.Time `json:"created_at"`
}

func TestCreateSolidMealFull(t *testing.T) {
	te := newTestEnv(t)
	babyPath := "/v1/babies/" + te.babyID.String() + "/solid-meals"

	occurred := time.Now().UTC().Add(-10 * time.Minute).Truncate(time.Second)
	resp := te.do(t, "POST", babyPath, te.token, map[string]any{
		"occurred_at": occurred.Format(time.RFC3339),
		"foods":       []string{" avocado ", "", "banana"},
		"reaction":    "liked",
		"amount_g":    40.5,
		"notes":       "first try",
		"photo":       base64.StdEncoding.EncodeToString(tinyJPEG),
		"photo_mime":  "image/jpeg",
	})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create: want 201, got %d: %s", resp.StatusCode, readBody(resp))
	}
	var created mealResp
	decodeJSON(t, resp, &created)
	if len(created.Foods) != 2 || created.Foods[0] != "avocado" || created.Foods[1] != "banana" {
		t.Fatalf("create: foods = %v, want [avocado banana]", created.Foods)
	}
	if created.Reaction == nil || *created.Reaction != "liked" {
		t.Fatalf("create: reaction = %v", created.Reaction)
	}
	if created.AmountG == nil || *created.AmountG != 40.5 {
		t.Fatalf("create: amount_g = %v", created.AmountG)
	}
	if !created.HasPhoto {
		t.Fatal("create: has_photo = false")
	}

	photoResp := te.do(t, "GET", "/v1/solid-meals/"+created.ID.String()+"/photo", te.token, nil)
	if photoResp.StatusCode != http.StatusOK {
		t.Fatalf("GET photo: want 200, got %d: %s", photoResp.StatusCode, readBody(photoResp))
	}
	gotBytes := readBytes(photoResp)
	if !bytes.Equal(gotBytes, tinyJPEG) {
		t.Fatalf("GET photo: bytes mismatch")
	}

	listResp := te.do(t, "GET", babyPath, te.token, nil)
	if listResp.StatusCode != http.StatusOK {
		t.Fatalf("list: want 200, got %d: %s", listResp.StatusCode, readBody(listResp))
	}
	listBody := readBody(listResp)
	if !strings.Contains(listBody, `"has_photo":true`) {
		t.Fatalf("list: missing has_photo:true in %s", listBody)
	}
	if strings.Contains(listBody, `"photo":"`) {
		t.Fatalf("list: should not ship raw photo: %s", listBody)
	}
}

func TestCreateSolidMealRejectsEmptyFoods(t *testing.T) {
	te := newTestEnv(t)
	babyPath := "/v1/babies/" + te.babyID.String() + "/solid-meals"
	occurred := time.Now().UTC().Truncate(time.Second)

	resp := te.do(t, "POST", babyPath, te.token, map[string]any{
		"occurred_at": occurred.Format(time.RFC3339),
		"foods":       []string{"", "  "},
	})
	if resp.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("create blank foods: want 422, got %d: %s", resp.StatusCode, readBody(resp))
	}
	_ = resp.Body.Close()

	resp2 := te.do(t, "POST", babyPath, te.token, map[string]any{
		"occurred_at": occurred.Format(time.RFC3339),
		"foods":       []string{},
	})
	if resp2.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("create empty foods: want 422, got %d: %s", resp2.StatusCode, readBody(resp2))
	}
	_ = resp2.Body.Close()
}

func TestPatchSolidMealClearAmountAndReaction(t *testing.T) {
	te := newTestEnv(t)
	babyPath := "/v1/babies/" + te.babyID.String() + "/solid-meals"
	occurred := time.Now().UTC().Truncate(time.Second)

	resp := te.do(t, "POST", babyPath, te.token, map[string]any{
		"occurred_at": occurred.Format(time.RFC3339),
		"foods":       []string{"oats"},
		"reaction":    "neutral",
		"amount_g":    12,
	})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("seed: %d: %s", resp.StatusCode, readBody(resp))
	}
	var seed mealResp
	decodeJSON(t, resp, &seed)

	patch := te.do(t, "PATCH", "/v1/solid-meals/"+seed.ID.String(), te.token, map[string]any{
		"reaction":       "",
		"clear_amount_g": true,
		"foods":          []string{"oats", "blueberry"},
	})
	if patch.StatusCode != http.StatusOK {
		t.Fatalf("PATCH: want 200, got %d: %s", patch.StatusCode, readBody(patch))
	}
	var updated mealResp
	decodeJSON(t, patch, &updated)
	if updated.Reaction != nil {
		t.Fatalf("PATCH: reaction = %v, want nil", updated.Reaction)
	}
	if updated.AmountG != nil {
		t.Fatalf("PATCH: amount_g = %v, want nil", updated.AmountG)
	}
	if len(updated.Foods) != 2 {
		t.Fatalf("PATCH: foods = %v", updated.Foods)
	}
}

func TestPreferencesAcceptsSolidsKey(t *testing.T) {
	te := newTestEnv(t)
	putResp := te.do(t, "PUT", "/v1/me/preferences", te.token, map[string]any{
		"time_format":        "24h",
		"timezone":           "UTC",
		"locale":             "en",
		"chart_palette":      map[string]any{"preset": "default", "overrides": map[string]string{}},
		"feature_visibility": map[string]bool{"solids": false},
	})
	if putResp.StatusCode != http.StatusOK {
		t.Fatalf("PUT prefs: want 200, got %d: %s", putResp.StatusCode, readBody(putResp))
	}
	if body := readBody(putResp); !strings.Contains(body, `"solids":false`) {
		t.Fatalf("PUT prefs: missing solids:false in %s", body)
	}
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

func readBytes(r *http.Response) []byte {
	defer func() { _ = r.Body.Close() }()
	b, _ := io.ReadAll(r.Body)
	return b
}
