// Integration tests for the auth endpoints.
//
// These hit the real chi router against a live Postgres (dev DB by default).
// Each test uses a unique email so reruns don't collide. We avoid cleanup
// fixtures intentionally: the test data is harmless and `make reset-db` wipes
// everything if you really want a clean slate.
//
// Set DATABASE_URL/JWT_SECRET via env to point at something else; defaults
// match infra/docker-compose.yml dev profile.
package auth_test

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
	"net/url"
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
	cfg    *config.Config
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

	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatalf("cookiejar: %v", err)
	}
	client := &http.Client{Jar: jar, Timeout: 5 * time.Second}

	t.Cleanup(func() {
		srv.Close()
		st.Close()
	})

	return &testEnv{server: srv, client: client, store: st, cfg: cfg}
}

type reqOpts struct {
	bearer       string
	rawCookie    string // raw Cookie header to send instead of jar contents
	disableJar   bool
}

func (te *testEnv) request(t *testing.T, method, path string, body any, opts reqOpts) *http.Response {
	t.Helper()
	var reqBody io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}
		reqBody = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, te.server.URL+path, reqBody)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if opts.bearer != "" {
		req.Header.Set("Authorization", "Bearer "+opts.bearer)
	}
	if opts.rawCookie != "" {
		req.Header.Set("Cookie", opts.rawCookie)
	}

	client := te.client
	if opts.disableJar {
		client = &http.Client{Timeout: te.client.Timeout}
	}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("do: %v", err)
	}
	return resp
}

func (te *testEnv) do(t *testing.T, method, path string, body any) *http.Response {
	return te.request(t, method, path, body, reqOpts{})
}

func (te *testEnv) doWithBearer(t *testing.T, method, path, token string, body any) *http.Response {
	return te.request(t, method, path, body, reqOpts{bearer: token})
}

type tokenResp struct {
	AccessToken      string    `json:"access_token"`
	ExpiresAt        time.Time `json:"expires_at"`
	RefreshToken     string    `json:"refresh_token"`
	RefreshExpiresAt time.Time `json:"refresh_expires_at"`
	User             struct {
		ID          uuid.UUID `json:"id"`
		Email       string    `json:"email"`
		DisplayName string    `json:"display_name"`
	} `json:"user"`
}

func decodeJSON(t *testing.T, r *http.Response, v any) {
	t.Helper()
	defer func() { _ = r.Body.Close() }()
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		t.Fatalf("decode body (status %d): %v", r.StatusCode, err)
	}
}

func uniqueEmail() string {
	return fmt.Sprintf("authtest-%d@example.com", time.Now().UnixNano())
}

func TestRegisterLoginMeRefreshLogout(t *testing.T) {
	te := newTestEnv(t)
	email := uniqueEmail()
	password := "correct horse battery staple"

	// --- register ---
	resp := te.do(t, "POST", "/v1/auth/register", map[string]any{
		"email":        email,
		"password":     password,
		"display_name": "Test User",
	})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("register: want 201, got %d: %s", resp.StatusCode, readBody(resp))
	}
	var registered tokenResp
	decodeJSON(t, resp, &registered)
	if registered.AccessToken == "" {
		t.Fatal("register: empty access token")
	}
	if registered.RefreshToken == "" {
		t.Fatal("register: empty refresh token in body")
	}
	if registered.RefreshExpiresAt.IsZero() {
		t.Fatal("register: empty refresh_expires_at in body")
	}
	if registered.User.Email != email {
		t.Fatalf("register: user.email = %q, want %q", registered.User.Email, email)
	}
	refreshCookieAfterRegister := cookieValueFor(te, "/v1/auth", "evernest_refresh")
	if refreshCookieAfterRegister == "" {
		t.Fatal("register: missing refresh cookie (legacy compat)")
	}
	if refreshCookieAfterRegister != registered.RefreshToken {
		t.Fatal("register: cookie value should match body refresh_token")
	}

	// --- /me with the access token ---
	resp = te.doWithBearer(t, "GET", "/v1/me", registered.AccessToken, nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("/me after register: want 200, got %d: %s", resp.StatusCode, readBody(resp))
	}
	var me struct {
		ID    uuid.UUID `json:"id"`
		Email string    `json:"email"`
	}
	decodeJSON(t, resp, &me)
	if me.ID != registered.User.ID {
		t.Fatalf("/me id = %s, want %s", me.ID, registered.User.ID)
	}

	// --- /me without token -> 401 ---
	resp = te.do(t, "GET", "/v1/me", nil)
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("/me unauth: want 401, got %d", resp.StatusCode)
	}
	_ = resp.Body.Close()

	// --- login with same creds ---
	resp = te.do(t, "POST", "/v1/auth/login", map[string]any{
		"email":    email,
		"password": password,
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("login: want 200, got %d: %s", resp.StatusCode, readBody(resp))
	}
	var loggedIn tokenResp
	decodeJSON(t, resp, &loggedIn)
	if loggedIn.AccessToken == registered.AccessToken {
		// JWTs include `jti` (a random UUID per token) so they must differ.
		t.Fatal("login: access token must differ from registration token")
	}

	// --- login with wrong password -> 401 ---
	resp = te.do(t, "POST", "/v1/auth/login", map[string]any{
		"email":    email,
		"password": "nope",
	})
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("login bad pw: want 401, got %d", resp.StatusCode)
	}
	_ = resp.Body.Close()

	// --- refresh (uses cookie set by login; cookie path is /v1/auth) ---
	refreshCookieBeforeRotate := cookieValueFor(te, "/v1/auth", "evernest_refresh")
	if refreshCookieBeforeRotate == "" {
		t.Fatal("refresh: missing cookie before rotate")
	}
	resp = te.do(t, "POST", "/v1/auth/refresh", nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("refresh: want 200, got %d: %s", resp.StatusCode, readBody(resp))
	}
	var refreshed tokenResp
	decodeJSON(t, resp, &refreshed)
	if refreshed.AccessToken == loggedIn.AccessToken {
		t.Fatal("refresh: access token must change")
	}
	refreshCookieAfterRotate := cookieValueFor(te, "/v1/auth", "evernest_refresh")
	if refreshCookieAfterRotate == refreshCookieBeforeRotate {
		t.Fatal("refresh: cookie should rotate")
	}

	// --- reusing the OLD refresh cookie -> 401 (revoked) ---
	// Bypass the jar by sending the cookie header manually.
	resp = te.request(t, "POST", "/v1/auth/refresh", nil, reqOpts{
		rawCookie:  "evernest_refresh=" + refreshCookieBeforeRotate,
		disableJar: true,
	})
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("refresh with revoked token: want 401, got %d", resp.StatusCode)
	}
	_ = resp.Body.Close()

	// --- logout with the still-valid (post-rotate) cookie via jar ---
	resp = te.do(t, "POST", "/v1/auth/logout", nil)
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("logout: want 204, got %d: %s", resp.StatusCode, readBody(resp))
	}
	_ = resp.Body.Close()

	// --- after logout, replaying the same cookie -> 401 ---
	resp = te.request(t, "POST", "/v1/auth/refresh", nil, reqOpts{
		rawCookie:  "evernest_refresh=" + refreshCookieAfterRotate,
		disableJar: true,
	})
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("refresh after logout: want 401, got %d", resp.StatusCode)
	}
	_ = resp.Body.Close()
}

// TestRefreshAndLogoutViaBody exercises the body-based refresh/logout path
// (the path used by the new FE). The jar is disabled so the legacy cookie
// fallback cannot rescue a request — anything that depends on body+token
// must work standalone.
func TestRefreshAndLogoutViaBody(t *testing.T) {
	te := newTestEnv(t)
	email := uniqueEmail()
	password := "correct horse battery staple"

	resp := te.do(t, "POST", "/v1/auth/register", map[string]any{
		"email":        email,
		"password":     password,
		"display_name": "Body Test User",
	})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("register: want 201, got %d: %s", resp.StatusCode, readBody(resp))
	}
	var registered tokenResp
	decodeJSON(t, resp, &registered)
	if registered.RefreshToken == "" {
		t.Fatal("register: missing refresh token in body")
	}

	// --- refresh via body, no cookie jar ---
	resp = te.request(t, "POST", "/v1/auth/refresh",
		map[string]any{"refresh_token": registered.RefreshToken},
		reqOpts{disableJar: true},
	)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("refresh via body: want 200, got %d: %s", resp.StatusCode, readBody(resp))
	}
	var refreshed tokenResp
	decodeJSON(t, resp, &refreshed)
	if refreshed.RefreshToken == "" {
		t.Fatal("refresh via body: response missing rotated refresh token")
	}
	if refreshed.RefreshToken == registered.RefreshToken {
		t.Fatal("refresh via body: refresh token must rotate")
	}

	// --- reusing the original (now revoked) refresh token via body -> 401 ---
	resp = te.request(t, "POST", "/v1/auth/refresh",
		map[string]any{"refresh_token": registered.RefreshToken},
		reqOpts{disableJar: true},
	)
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("refresh with revoked body token: want 401, got %d", resp.StatusCode)
	}
	_ = resp.Body.Close()

	// --- logout via body revokes the rotated token ---
	resp = te.request(t, "POST", "/v1/auth/logout",
		map[string]any{"refresh_token": refreshed.RefreshToken},
		reqOpts{disableJar: true},
	)
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("logout via body: want 204, got %d: %s", resp.StatusCode, readBody(resp))
	}
	_ = resp.Body.Close()

	// --- using the post-logout token again -> 401 ---
	resp = te.request(t, "POST", "/v1/auth/refresh",
		map[string]any{"refresh_token": refreshed.RefreshToken},
		reqOpts{disableJar: true},
	)
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("refresh after logout via body: want 401, got %d", resp.StatusCode)
	}
	_ = resp.Body.Close()
}

// TestRefreshNoTokenReturns401 confirms the "no body, no cookie" path is a
// 401 with the new error code, not a 500 from JSON decode trouble.
func TestRefreshNoTokenReturns401(t *testing.T) {
	te := newTestEnv(t)
	// Empty body, no cookie jar contents (fresh env).
	resp := te.request(t, "POST", "/v1/auth/refresh", nil, reqOpts{disableJar: true})
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("refresh no token: want 401, got %d: %s", resp.StatusCode, readBody(resp))
	}
	var env struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	decodeJSON(t, resp, &env)
	if env.Error.Code != "no_refresh_token" {
		t.Fatalf("refresh no token: want code no_refresh_token, got %q", env.Error.Code)
	}
}

// TestRefreshBodyTakesPrecedenceOverCookie pins down which token gets
// revoked when both sources are present. The body wins — that's what lets
// a migrated FE reliably rotate even if a stale legacy cookie is still in
// the browser's jar.
func TestRefreshBodyTakesPrecedenceOverCookie(t *testing.T) {
	te := newTestEnv(t)
	email := uniqueEmail()

	resp := te.do(t, "POST", "/v1/auth/register", map[string]any{
		"email":        email,
		"password":     "correct horse battery staple",
		"display_name": "Precedence Test",
	})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("register: want 201, got %d: %s", resp.StatusCode, readBody(resp))
	}
	var first tokenResp
	decodeJSON(t, resp, &first)

	// Mint a second token by logging in again; the jar now holds the
	// SECOND cookie, but we'll send the FIRST token in the body.
	resp = te.do(t, "POST", "/v1/auth/login", map[string]any{
		"email":    email,
		"password": "correct horse battery staple",
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("login: want 200, got %d", resp.StatusCode)
	}
	var second tokenResp
	decodeJSON(t, resp, &second)
	if second.RefreshToken == first.RefreshToken {
		t.Fatal("login should mint a distinct refresh token from register")
	}

	// Send body=first, cookie=second. Body should win → first gets revoked.
	resp = te.do(t, "POST", "/v1/auth/refresh", map[string]any{
		"refresh_token": first.RefreshToken,
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("refresh body+cookie: want 200, got %d: %s", resp.StatusCode, readBody(resp))
	}
	_ = resp.Body.Close()

	// Replaying the FIRST token via body -> 401 (revoked by the call above).
	resp = te.request(t, "POST", "/v1/auth/refresh",
		map[string]any{"refresh_token": first.RefreshToken},
		reqOpts{disableJar: true},
	)
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("replaying first token: want 401, got %d", resp.StatusCode)
	}
	_ = resp.Body.Close()

	// The SECOND token (cookie source) should still be valid because the
	// previous refresh consumed the BODY token, not the cookie.
	resp = te.request(t, "POST", "/v1/auth/refresh",
		map[string]any{"refresh_token": second.RefreshToken},
		reqOpts{disableJar: true},
	)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("second token still valid: want 200, got %d: %s", resp.StatusCode, readBody(resp))
	}
	_ = resp.Body.Close()
}

func TestRegisterDuplicateEmail(t *testing.T) {
	te := newTestEnv(t)
	email := uniqueEmail()
	body := map[string]any{
		"email":        email,
		"password":     "password1234",
		"display_name": "First",
	}
	resp := te.do(t, "POST", "/v1/auth/register", body)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("first register: want 201, got %d", resp.StatusCode)
	}
	_ = resp.Body.Close()
	resp = te.do(t, "POST", "/v1/auth/register", body)
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("duplicate register: want 409, got %d", resp.StatusCode)
	}
	_ = resp.Body.Close()
}

func TestRegisterValidation(t *testing.T) {
	te := newTestEnv(t)
	tests := []struct {
		name string
		body map[string]any
		want int
	}{
		{"bad email", map[string]any{"email": "not-an-email", "password": "password1234", "display_name": "X"}, http.StatusUnprocessableEntity},
		{"short pw", map[string]any{"email": uniqueEmail(), "password": "short", "display_name": "X"}, http.StatusUnprocessableEntity},
		{"missing name", map[string]any{"email": uniqueEmail(), "password": "password1234"}, http.StatusUnprocessableEntity},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			resp := te.do(t, "POST", "/v1/auth/register", tc.body)
			if resp.StatusCode != tc.want {
				t.Fatalf("want %d, got %d: %s", tc.want, resp.StatusCode, readBody(resp))
			}
			_ = resp.Body.Close()
		})
	}
}

// --- cookie + URL helpers ---

// cookieValueFor returns the value of the named cookie that the jar would send
// for a request to baseURL+path. We have to query with the right path because
// the auth cookie's Path attribute is /v1/auth, not /.
func cookieValueFor(te *testEnv, path, name string) string {
	u := mustParseURL(te.server.URL + path)
	for _, c := range te.client.Jar.Cookies(u) {
		if c.Name == name {
			return c.Value
		}
	}
	return ""
}

func mustParseURL(raw string) *url.URL {
	u, err := url.Parse(raw)
	if err != nil {
		panic(err)
	}
	return u
}

func readBody(r *http.Response) string {
	defer func() { _ = r.Body.Close() }()
	b, _ := io.ReadAll(r.Body)
	return strings.TrimSpace(string(b))
}
