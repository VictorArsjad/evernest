// Integration tests for the link-based invite endpoints. Mirrors the
// auth + preferences suites: spins the full chi router against the dev
// Postgres, registers fresh users + a household per test, and asserts
// end-to-end behavior.
//
// We pin specific 404 paths to verify the "tampered / used / expired /
// unknown -> uniform 404" property — leaking which condition matched
// would let an attacker enumerate tokens.
package household_test

import (
	"bytes"
	"context"
	"crypto/sha256"
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
}

type testUser struct {
	ID          uuid.UUID
	Email       string
	AccessToken string
}

type testHousehold struct {
	ID    uuid.UUID
	Name  string
	Role  string
	Owner *testUser
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
	// Argon2id hashing under -race is slow; keep the per-request budget
	// generous, mirroring auth_test.go.
	client := &http.Client{Jar: jar, Timeout: 30 * time.Second}
	t.Cleanup(func() {
		srv.Close()
		st.Close()
	})
	return &testEnv{server: srv, client: client, store: st}
}

func (te *testEnv) registerUser(t *testing.T, label string) *testUser {
	t.Helper()
	email := fmt.Sprintf("%s-%d-%s@example.com", label, time.Now().UnixNano(), uuid.NewString())
	res := te.do(t, "POST", "/v1/auth/register", map[string]any{
		"email":        email,
		"password":     "correct horse battery staple",
		"display_name": label,
	}, "")
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("register %s: %d %s", label, res.StatusCode, readBody(res))
	}
	var tok struct {
		AccessToken string `json:"access_token"`
		User        struct {
			ID uuid.UUID `json:"id"`
		} `json:"user"`
	}
	decodeJSON(t, res, &tok)
	return &testUser{
		ID:          tok.User.ID,
		Email:       email,
		AccessToken: tok.AccessToken,
	}
}

func (te *testEnv) createHousehold(t *testing.T, owner *testUser, name string) *testHousehold {
	t.Helper()
	res := te.do(t, "POST", "/v1/households", map[string]any{"name": name}, owner.AccessToken)
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("create household: %d %s", res.StatusCode, readBody(res))
	}
	var hh struct {
		ID   uuid.UUID `json:"id"`
		Name string    `json:"name"`
		Role string    `json:"role"`
	}
	decodeJSON(t, res, &hh)
	return &testHousehold{ID: hh.ID, Name: hh.Name, Role: hh.Role, Owner: owner}
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

// --- create invite ---

func TestCreateInvite_OwnerSucceeds(t *testing.T) {
	te := newTestEnv(t)
	owner := te.registerUser(t, "invites-owner")
	hh := te.createHousehold(t, owner, "Invite Test Household")

	res := te.do(t, "POST", "/v1/households/"+hh.ID.String()+"/invites", map[string]any{
		"role": "caregiver",
	}, owner.AccessToken)
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("create invite: %d %s", res.StatusCode, readBody(res))
	}
	var inv struct {
		Token     string    `json:"token"`
		InviteURL string    `json:"invite_url"`
		Role      string    `json:"role"`
		ExpiresAt time.Time `json:"expires_at"`
	}
	decodeJSON(t, res, &inv)
	if inv.Token == "" {
		t.Fatal("expected token on create response")
	}
	if len(inv.Token) < 20 {
		t.Fatalf("token shorter than expected: %q", inv.Token)
	}
	if inv.Role != "caregiver" {
		t.Fatalf("role mismatch: %q", inv.Role)
	}
	if !strings.HasSuffix(inv.InviteURL, "/invite/"+inv.Token) {
		t.Fatalf("invite_url should end in /invite/{token}: %q", inv.InviteURL)
	}
	// Default 7-day expiry: should be ~168h out from now.
	delta := time.Until(inv.ExpiresAt)
	if delta < 167*time.Hour || delta > 169*time.Hour {
		t.Fatalf("default expiry not ~168h: %v", delta)
	}

	// DB sanity: only the hash should be stored, never the plaintext token.
	h := sha256.Sum256([]byte(inv.Token))
	var dbHash []byte
	if err := te.store.Pool.QueryRow(context.Background(),
		`SELECT token_hash FROM household_invites WHERE household_id = $1`, hh.ID).
		Scan(&dbHash); err != nil {
		t.Fatalf("select hash: %v", err)
	}
	if !bytes.Equal(dbHash, h[:]) {
		t.Fatalf("stored hash does not match SHA-256 of token")
	}
}

func TestCreateInvite_CaregiverForbidden(t *testing.T) {
	te := newTestEnv(t)
	owner := te.registerUser(t, "invites-owner")
	caregiver := te.registerUser(t, "invites-caregiver")
	hh := te.createHousehold(t, owner, "Caregiver Test")

	// Promote caregiver via an existing-owner-issued invite.
	token := mustCreateInvite(t, te, owner, hh.ID, "caregiver", 0)
	mustAcceptInvite(t, te, caregiver, token)

	// Caregiver attempts to issue a new invite -> 403.
	res := te.do(t, "POST", "/v1/households/"+hh.ID.String()+"/invites", map[string]any{
		"role": "caregiver",
	}, caregiver.AccessToken)
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("want 403, got %d: %s", res.StatusCode, readBody(res))
	}
	_ = res.Body.Close()
}

func TestCreateInvite_ValidatesRoleAndExpiry(t *testing.T) {
	te := newTestEnv(t)
	owner := te.registerUser(t, "invites-owner")
	hh := te.createHousehold(t, owner, "Validation Test")

	cases := []struct {
		name string
		body map[string]any
		code int
	}{
		{"empty role", map[string]any{"role": ""}, http.StatusUnprocessableEntity},
		{"bad role", map[string]any{"role": "stranger"}, http.StatusUnprocessableEntity},
		{"too short", map[string]any{"role": "caregiver", "expires_in_hours": 0 - 1}, http.StatusUnprocessableEntity},
		{"too long", map[string]any{"role": "caregiver", "expires_in_hours": 721}, http.StatusUnprocessableEntity},
		{"min OK", map[string]any{"role": "caregiver", "expires_in_hours": 1}, http.StatusCreated},
		{"max OK", map[string]any{"role": "caregiver", "expires_in_hours": 720}, http.StatusCreated},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			res := te.do(t, "POST", "/v1/households/"+hh.ID.String()+"/invites", tc.body, owner.AccessToken)
			if res.StatusCode != tc.code {
				t.Fatalf("want %d, got %d: %s", tc.code, res.StatusCode, readBody(res))
			}
			_ = res.Body.Close()
		})
	}
}

func TestCreateInvite_NotMember404(t *testing.T) {
	te := newTestEnv(t)
	stranger := te.registerUser(t, "invites-stranger")
	res := te.do(t, "POST", "/v1/households/"+uuid.NewString()+"/invites", map[string]any{
		"role": "caregiver",
	}, stranger.AccessToken)
	if res.StatusCode != http.StatusNotFound {
		t.Fatalf("want 404, got %d: %s", res.StatusCode, readBody(res))
	}
	_ = res.Body.Close()
}

// --- list invites ---

func TestListInvites_OnlyPending(t *testing.T) {
	te := newTestEnv(t)
	owner := te.registerUser(t, "invites-owner")
	hh := te.createHousehold(t, owner, "Listing Test")

	pendingToken := mustCreateInvite(t, te, owner, hh.ID, "caregiver", 0)
	acceptedToken := mustCreateInvite(t, te, owner, hh.ID, "caregiver", 0)

	// Burn one of them.
	other := te.registerUser(t, "invites-other")
	mustAcceptInvite(t, te, other, acceptedToken)

	res := te.do(t, "GET", "/v1/households/"+hh.ID.String()+"/invites", nil, owner.AccessToken)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("list invites: %d %s", res.StatusCode, readBody(res))
	}
	var out []struct {
		Token     string `json:"token"`
		Role      string `json:"role"`
		TokenHint string `json:"token_hint"`
	}
	decodeJSON(t, res, &out)
	if len(out) != 1 {
		t.Fatalf("want 1 pending invite, got %d", len(out))
	}
	// List response must never echo the plaintext token; only a short hint.
	if out[0].Token != "" {
		t.Fatalf("list should not echo plaintext token, got %q", out[0].Token)
	}
	if out[0].TokenHint == "" {
		t.Fatalf("expected token_hint on list response")
	}
	_ = pendingToken // kept around for readability
}

// --- public invite info ---

func TestGetInviteInfo_PublicLookup(t *testing.T) {
	te := newTestEnv(t)
	owner := te.registerUser(t, "invites-owner")
	hh := te.createHousehold(t, owner, "Public Info Test")
	token := mustCreateInvite(t, te, owner, hh.ID, "owner", 0)

	// No Authorization header.
	res := te.do(t, "GET", "/v1/invites/"+token, nil, "")
	if res.StatusCode != http.StatusOK {
		t.Fatalf("public lookup: %d %s", res.StatusCode, readBody(res))
	}
	var info struct {
		HouseholdName string `json:"household_name"`
		Role          string `json:"role"`
	}
	decodeJSON(t, res, &info)
	if info.HouseholdName != "Public Info Test" {
		t.Fatalf("household name mismatch: %q", info.HouseholdName)
	}
	if info.Role != "owner" {
		t.Fatalf("role mismatch: %q", info.Role)
	}
}

func TestGetInviteInfo_UnknownTampered_All404(t *testing.T) {
	te := newTestEnv(t)
	owner := te.registerUser(t, "invites-owner")
	hh := te.createHousehold(t, owner, "Tamper Test")
	token := mustCreateInvite(t, te, owner, hh.ID, "caregiver", 0)

	// 1) Completely unknown token.
	res := te.do(t, "GET", "/v1/invites/totally-fake-token-aaaaaa", nil, "")
	if res.StatusCode != http.StatusNotFound {
		t.Fatalf("unknown: want 404, got %d", res.StatusCode)
	}
	_ = res.Body.Close()

	// 2) Tampered version (flip last char) of a real token.
	tampered := token[:len(token)-1]
	if token[len(token)-1] == 'A' {
		tampered += "B"
	} else {
		tampered += "A"
	}
	res = te.do(t, "GET", "/v1/invites/"+tampered, nil, "")
	if res.StatusCode != http.StatusNotFound {
		t.Fatalf("tampered: want 404, got %d", res.StatusCode)
	}
	_ = res.Body.Close()
}

func TestGetInviteInfo_ExpiredIs404(t *testing.T) {
	te := newTestEnv(t)
	owner := te.registerUser(t, "invites-owner")
	hh := te.createHousehold(t, owner, "Expiry Test")
	token := mustCreateInvite(t, te, owner, hh.ID, "caregiver", 0)

	// Backdate the expiry in the DB to simulate a stale link. (We
	// can't ask the server to issue a sub-second-expiry invite because
	// the validator enforces a min of 1 hour.)
	_, err := te.store.Pool.Exec(context.Background(),
		`UPDATE household_invites SET expires_at = now() - interval '1 minute'
		 WHERE token_hash = $1`, sha256Bytes(token))
	if err != nil {
		t.Fatalf("backdate: %v", err)
	}

	res := te.do(t, "GET", "/v1/invites/"+token, nil, "")
	if res.StatusCode != http.StatusNotFound {
		t.Fatalf("expired: want 404, got %d: %s", res.StatusCode, readBody(res))
	}
	_ = res.Body.Close()
}

// --- accept invite ---

func TestAcceptInvite_Success(t *testing.T) {
	te := newTestEnv(t)
	owner := te.registerUser(t, "invites-owner")
	joiner := te.registerUser(t, "invites-joiner")
	hh := te.createHousehold(t, owner, "Accept Test")
	token := mustCreateInvite(t, te, owner, hh.ID, "caregiver", 0)

	res := te.do(t, "POST", "/v1/invites/"+token+"/accept", nil, joiner.AccessToken)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("accept: %d %s", res.StatusCode, readBody(res))
	}
	var hhResp struct {
		ID   uuid.UUID `json:"id"`
		Role string    `json:"role"`
	}
	decodeJSON(t, res, &hhResp)
	if hhResp.ID != hh.ID {
		t.Fatalf("household id mismatch")
	}
	if hhResp.Role != "caregiver" {
		t.Fatalf("role mismatch: %q", hhResp.Role)
	}

	// Joiner should now see the household in their list.
	list := te.do(t, "GET", "/v1/households", nil, joiner.AccessToken)
	var hhs []struct {
		ID   uuid.UUID `json:"id"`
		Role string    `json:"role"`
	}
	decodeJSON(t, list, &hhs)
	found := false
	for _, x := range hhs {
		if x.ID == hh.ID && x.Role == "caregiver" {
			found = true
		}
	}
	if !found {
		t.Fatalf("accepted household not in joiner's list: %+v", hhs)
	}
}

func TestAcceptInvite_IdempotentReAccept(t *testing.T) {
	te := newTestEnv(t)
	owner := te.registerUser(t, "invites-owner")
	joiner := te.registerUser(t, "invites-joiner")
	hh := te.createHousehold(t, owner, "Idempotent Test")
	token := mustCreateInvite(t, te, owner, hh.ID, "caregiver", 0)
	mustAcceptInvite(t, te, joiner, token)

	// Snapshot accepted_at after the FIRST accept. The second call by
	// the same user must NOT re-consume the invite, meaning accepted_at
	// stays at its first-accept value (not bumped to a new "now()").
	var firstAcceptedAt time.Time
	if err := te.store.Pool.QueryRow(context.Background(),
		`SELECT accepted_at FROM household_invites WHERE token_hash = $1`,
		sha256Bytes(token)).Scan(&firstAcceptedAt); err != nil {
		t.Fatalf("snapshot accepted_at: %v", err)
	}

	// Sleep just enough that a buggy "re-write accepted_at on every
	// accept" would visibly bump the timestamp.
	time.Sleep(50 * time.Millisecond)

	// Second accept by SAME user -> 200 (idempotent).
	res := te.do(t, "POST", "/v1/invites/"+token+"/accept", nil, joiner.AccessToken)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("idempotent re-accept: want 200, got %d: %s", res.StatusCode, readBody(res))
	}
	_ = res.Body.Close()

	var afterAcceptedAt time.Time
	if err := te.store.Pool.QueryRow(context.Background(),
		`SELECT accepted_at FROM household_invites WHERE token_hash = $1`,
		sha256Bytes(token)).Scan(&afterAcceptedAt); err != nil {
		t.Fatalf("re-select accepted_at: %v", err)
	}
	if !afterAcceptedAt.Equal(firstAcceptedAt) {
		t.Fatalf("idempotent re-accept must NOT re-consume the invite; first=%v after=%v",
			firstAcceptedAt, afterAcceptedAt)
	}
}

func TestAcceptInvite_AlreadyUsed404(t *testing.T) {
	te := newTestEnv(t)
	owner := te.registerUser(t, "invites-owner")
	first := te.registerUser(t, "invites-first")
	second := te.registerUser(t, "invites-second")
	hh := te.createHousehold(t, owner, "Already Used Test")
	token := mustCreateInvite(t, te, owner, hh.ID, "caregiver", 0)

	mustAcceptInvite(t, te, first, token)

	res := te.do(t, "POST", "/v1/invites/"+token+"/accept", nil, second.AccessToken)
	if res.StatusCode != http.StatusNotFound {
		t.Fatalf("want 404, got %d: %s", res.StatusCode, readBody(res))
	}
	_ = res.Body.Close()
}

func TestAcceptInvite_Unauthenticated401(t *testing.T) {
	te := newTestEnv(t)
	owner := te.registerUser(t, "invites-owner")
	hh := te.createHousehold(t, owner, "Unauth Test")
	token := mustCreateInvite(t, te, owner, hh.ID, "caregiver", 0)

	res := te.do(t, "POST", "/v1/invites/"+token+"/accept", nil, "")
	if res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("want 401, got %d: %s", res.StatusCode, readBody(res))
	}
	_ = res.Body.Close()
}

// --- revoke ---

func TestRevokeInvite_OwnerSucceeds_ThenAccept404(t *testing.T) {
	te := newTestEnv(t)
	owner := te.registerUser(t, "invites-owner")
	joiner := te.registerUser(t, "invites-joiner")
	hh := te.createHousehold(t, owner, "Revoke Test")
	token := mustCreateInvite(t, te, owner, hh.ID, "caregiver", 0)

	res := te.do(t, "DELETE", "/v1/invites/"+token, nil, owner.AccessToken)
	if res.StatusCode != http.StatusNoContent {
		t.Fatalf("revoke: %d %s", res.StatusCode, readBody(res))
	}
	_ = res.Body.Close()

	res = te.do(t, "POST", "/v1/invites/"+token+"/accept", nil, joiner.AccessToken)
	if res.StatusCode != http.StatusNotFound {
		t.Fatalf("accept after revoke: want 404, got %d", res.StatusCode)
	}
	_ = res.Body.Close()
}

func TestRevokeInvite_NonOwner404(t *testing.T) {
	te := newTestEnv(t)
	owner := te.registerUser(t, "invites-owner")
	stranger := te.registerUser(t, "invites-stranger")
	hh := te.createHousehold(t, owner, "Stranger Revoke Test")
	token := mustCreateInvite(t, te, owner, hh.ID, "caregiver", 0)

	// Stranger has no relationship to the household; revoke must look
	// indistinguishable from "unknown token" to avoid disclosure.
	res := te.do(t, "DELETE", "/v1/invites/"+token, nil, stranger.AccessToken)
	if res.StatusCode != http.StatusNotFound {
		t.Fatalf("stranger revoke: want 404, got %d", res.StatusCode)
	}
	_ = res.Body.Close()

	// And the original token still works for a legitimate accept.
	joiner := te.registerUser(t, "invites-joiner")
	mustAcceptInvite(t, te, joiner, token)
}

// --- helpers ---

func mustCreateInvite(t *testing.T, te *testEnv, owner *testUser, hhID uuid.UUID, role string, hours int) string {
	t.Helper()
	body := map[string]any{"role": role}
	if hours > 0 {
		body["expires_in_hours"] = hours
	}
	res := te.do(t, "POST", "/v1/households/"+hhID.String()+"/invites", body, owner.AccessToken)
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("create invite: %d %s", res.StatusCode, readBody(res))
	}
	var inv struct {
		Token string `json:"token"`
	}
	decodeJSON(t, res, &inv)
	if inv.Token == "" {
		t.Fatalf("empty token")
	}
	return inv.Token
}

func mustAcceptInvite(t *testing.T, te *testEnv, joiner *testUser, token string) {
	t.Helper()
	res := te.do(t, "POST", "/v1/invites/"+token+"/accept", nil, joiner.AccessToken)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("accept: %d %s", res.StatusCode, readBody(res))
	}
	_ = res.Body.Close()
}

func sha256Bytes(token string) []byte {
	h := sha256.Sum256([]byte(token))
	return h[:]
}
