// Integration tests for /v1/babies/{babyID}/charts/daily.
//
// Mirrors the auth_test.go pattern: spins the full chi router against the
// dev Postgres, registers a fresh user + household + baby per test, seeds
// rows directly via the pool, and asserts end-to-end behavior of the
// aggregation endpoint (densification, tz bucketing, validation).
package chart_test

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
	"github.com/varsjad/evernest/apps/api/internal/uuidx"
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
	// Register triggers argon2id hashing which is much slower under -race,
	// so we keep the per-request budget generous.
	client := &http.Client{Jar: jar, Timeout: 30 * time.Second}
	t.Cleanup(func() {
		srv.Close()
		st.Close()
	})

	te := &testEnv{server: srv, client: client, store: st}
	te.bootstrap(t)
	return te
}

// bootstrap creates a fresh user / household / baby and returns a logged-in
// test env. We register through the real handlers (cheaper than reaching
// into the store directly) and capture the access token for subsequent
// authenticated requests.
func (te *testEnv) bootstrap(t *testing.T) {
	t.Helper()
	email := fmt.Sprintf("charttest-%d-%s@example.com", time.Now().UnixNano(), uuid.NewString())
	reg := te.do(t, "POST", "/v1/auth/register", map[string]any{
		"email":        email,
		"password":     "correct horse battery staple",
		"display_name": "Chart Test",
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

	hhRes := te.do(t, "POST", "/v1/households", map[string]any{"name": "Chart Test Household"}, te.token)
	if hhRes.StatusCode != http.StatusCreated {
		t.Fatalf("household: %d %s", hhRes.StatusCode, readBody(hhRes))
	}
	var hh struct {
		ID uuid.UUID `json:"id"`
	}
	decodeJSON(t, hhRes, &hh)

	babyRes := te.do(t, "POST", "/v1/households/"+hh.ID.String()+"/babies", map[string]any{
		"name": "Tester Junior",
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

// seed* helpers insert event rows directly via the pool. The public POST
// handlers force `created_by_user_id` from the JWT and re-validate
// payloads; we just want test fixtures with known timestamps.
func (te *testEnv) seedBottle(t *testing.T, ts time.Time, ml float64) {
	t.Helper()
	_, err := te.store.Pool.Exec(context.Background(), `
		INSERT INTO bottle_feeds (id, baby_id, occurred_at, milk_source, amount_ml, source)
		VALUES ($1, $2, $3, 'formula', $4, 'manual')
	`, uuidx.NewV7(), te.baby, ts, ml)
	if err != nil {
		t.Fatalf("seed bottle: %v", err)
	}
}

func (te *testEnv) seedPumping(t *testing.T, ts time.Time, ml float64) {
	t.Helper()
	_, err := te.store.Pool.Exec(context.Background(), `
		INSERT INTO pumpings (id, baby_id, occurred_at, amount_ml, source)
		VALUES ($1, $2, $3, $4, 'manual')
	`, uuidx.NewV7(), te.baby, ts, ml)
	if err != nil {
		t.Fatalf("seed pumping: %v", err)
	}
}

func (te *testEnv) seedNursing(t *testing.T, ts time.Time, leftSec, rightSec int) {
	t.Helper()
	_, err := te.store.Pool.Exec(context.Background(), `
		INSERT INTO nursing_sessions (id, baby_id, started_at, nursing_side, left_duration_s, right_duration_s, source)
		VALUES ($1, $2, $3, 'both', $4, $5, 'manual')
	`, uuidx.NewV7(), te.baby, ts, leftSec, rightSec)
	if err != nil {
		t.Fatalf("seed nursing: %v", err)
	}
}

func (te *testEnv) seedDiaper(t *testing.T, ts time.Time, typ string) {
	t.Helper()
	_, err := te.store.Pool.Exec(context.Background(), `
		INSERT INTO diapers (id, baby_id, occurred_at, type, source)
		VALUES ($1, $2, $3, $4, 'manual')
	`, uuidx.NewV7(), te.baby, ts, typ)
	if err != nil {
		t.Fatalf("seed diaper: %v", err)
	}
}

func (te *testEnv) seedGrowth(t *testing.T, ts time.Time, weightG, heightCM, headCM *float64) {
	t.Helper()
	_, err := te.store.Pool.Exec(context.Background(), `
		INSERT INTO growths (id, baby_id, measured_at, weight_g, height_cm, head_circumference_cm, source)
		VALUES ($1, $2, $3, $4, $5, $6, 'manual')
	`, uuidx.NewV7(), te.baby, ts, weightG, heightCM, headCM)
	if err != nil {
		t.Fatalf("seed growth: %v", err)
	}
}

type dailyResp struct {
	Days []struct {
		Date           string  `json:"date"`
		BottleML       float64 `json:"bottle_ml"`
		NursingMinutes int     `json:"nursing_minutes"`
		PumpingML      float64 `json:"pumping_ml"`
		DiaperTotal    int     `json:"diaper_total"`
		DiaperWet      int     `json:"diaper_wet"`
		DiaperSoiled   int     `json:"diaper_soiled"`
		DiaperMixed    int     `json:"diaper_mixed"`
		Growth         struct {
			WeightG  *float64 `json:"weight_g"`
			HeightCM *float64 `json:"height_cm"`
			HeadCM   *float64 `json:"head_cm"`
		} `json:"growth"`
	} `json:"days"`
}

func TestChartsDaily_HappyPathWithTZBucketing(t *testing.T) {
	te := newTestEnv(t)

	// Asia/Jakarta is UTC+7 with no DST, so 22:00 UTC on May 25 is
	// 05:00 Jakarta on May 26 — must bucket into May 26, not May 25.
	// This is the whole point of carrying the tz parameter; without
	// AT TIME ZONE the row would land in d25.
	loc, err := time.LoadLocation("Asia/Jakarta")
	if err != nil {
		t.Fatalf("load location: %v", err)
	}

	// Day 25 (Jakarta): bottle 200 ml @ 10:00 local
	te.seedBottle(t, time.Date(2026, 5, 25, 10, 0, 0, 0, loc), 200)

	// Day 26 (Jakarta) bottles: 180 ml at 22:00 UTC May 25 = 05:00
	// Jakarta May 26 (the bucketing fence post), plus 300 ml at 17:00
	// Jakarta May 26. Total expected for d26 is 480.
	te.seedBottle(t, time.Date(2026, 5, 25, 22, 0, 0, 0, time.UTC), 180)
	te.seedBottle(t, time.Date(2026, 5, 26, 17, 0, 0, 0, loc), 300)

	// Day 25: nursing 10 min (600s left, 0s right)
	te.seedNursing(t, time.Date(2026, 5, 25, 12, 0, 0, 0, loc), 600, 0)

	// Day 26: pumping 200 ml, diapers wet+wet+soiled+mixed = 4 total
	te.seedPumping(t, time.Date(2026, 5, 26, 9, 0, 0, 0, loc), 200)
	te.seedDiaper(t, time.Date(2026, 5, 26, 10, 0, 0, 0, loc), "wet")
	te.seedDiaper(t, time.Date(2026, 5, 26, 11, 0, 0, 0, loc), "wet")
	te.seedDiaper(t, time.Date(2026, 5, 26, 12, 0, 0, 0, loc), "soiled")
	te.seedDiaper(t, time.Date(2026, 5, 26, 13, 0, 0, 0, loc), "mixed")

	// Day 26: growth — weight only first, then a fuller measurement.
	// The latest-non-null-per-metric rule must keep the second weight
	// (4520) AND preserve the first row's nil head_cm (since the second
	// row also doesn't set head_cm). Height set only on the second row.
	w := 4500.0
	te.seedGrowth(t, time.Date(2026, 5, 26, 8, 0, 0, 0, loc), &w, nil, nil)
	w2 := 4520.0
	h2 := 55.0
	te.seedGrowth(t, time.Date(2026, 5, 26, 18, 0, 0, 0, loc), &w2, &h2, nil)

	// Window 25..28 — days 27 + 28 must densify to zero rows.
	resp := te.do(t, "GET",
		"/v1/babies/"+te.baby.String()+"/charts/daily?from=2026-05-25&to=2026-05-28&tz=Asia/Jakarta",
		nil, te.token)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("daily: %d %s", resp.StatusCode, readBody(resp))
	}
	var parsed dailyResp
	decodeJSON(t, resp, &parsed)

	if len(parsed.Days) != 4 {
		t.Fatalf("days len = %d, want 4", len(parsed.Days))
	}
	wantDates := []string{"2026-05-25", "2026-05-26", "2026-05-27", "2026-05-28"}
	for i, w := range wantDates {
		if parsed.Days[i].Date != w {
			t.Fatalf("days[%d].Date = %q, want %q", i, parsed.Days[i].Date, w)
		}
	}

	d25 := parsed.Days[0]
	if d25.BottleML != 200 {
		t.Errorf("d25 bottle = %v, want 200", d25.BottleML)
	}
	if d25.NursingMinutes != 10 {
		t.Errorf("d25 nursing = %d, want 10", d25.NursingMinutes)
	}
	if d25.PumpingML != 0 || d25.DiaperTotal != 0 {
		t.Errorf("d25 should have empty pumping/diaper, got %+v", d25)
	}
	if d25.Growth.WeightG != nil {
		t.Errorf("d25 growth weight should be nil")
	}

	d26 := parsed.Days[1]
	// 22:00 UTC on May 25 (== 05:00 Jakarta on May 26) must land here,
	// so total should be 180 (the fence-post row) + 300 (5pm Jakarta) = 480.
	if d26.BottleML != 480 {
		t.Errorf("d26 bottle = %v, want 480 (tz bucketing of fence-post row)", d26.BottleML)
	}
	if d26.PumpingML != 200 {
		t.Errorf("d26 pumping = %v, want 200", d26.PumpingML)
	}
	if d26.DiaperTotal != 4 || d26.DiaperWet != 2 || d26.DiaperSoiled != 1 || d26.DiaperMixed != 1 {
		t.Errorf("d26 diapers = (%d,%d,%d,%d), want (4,2,1,1)",
			d26.DiaperTotal, d26.DiaperWet, d26.DiaperSoiled, d26.DiaperMixed)
	}
	if d26.Growth.WeightG == nil || *d26.Growth.WeightG != 4520 {
		t.Errorf("d26 weight = %v, want 4520", d26.Growth.WeightG)
	}
	if d26.Growth.HeightCM == nil || *d26.Growth.HeightCM != 55 {
		t.Errorf("d26 height = %v, want 55", d26.Growth.HeightCM)
	}
	if d26.Growth.HeadCM != nil {
		t.Errorf("d26 head_cm should be nil")
	}

	// Empty days must still appear with zero/null defaults.
	d27 := parsed.Days[2]
	if d27.BottleML != 0 || d27.NursingMinutes != 0 || d27.DiaperTotal != 0 {
		t.Errorf("d27 should be all zero, got %+v", d27)
	}
	if d27.Growth.WeightG != nil || d27.Growth.HeightCM != nil || d27.Growth.HeadCM != nil {
		t.Errorf("d27 growth should be all nil, got %+v", d27.Growth)
	}
}

func TestChartsDaily_ValidationErrors(t *testing.T) {
	te := newTestEnv(t)
	base := "/v1/babies/" + te.baby.String() + "/charts/daily"
	cases := []struct {
		name   string
		query  string
		status int
		body   string
	}{
		{"window > 90 days", "?from=2026-01-01&to=2026-12-31&tz=UTC", http.StatusUnprocessableEntity, "window must be <="},
		{"to before from", "?from=2026-05-28&to=2026-05-20&tz=UTC", http.StatusUnprocessableEntity, "to must be >= from"},
		{"missing from", "?to=2026-05-28&tz=UTC", http.StatusUnprocessableEntity, "from and to are required"},
		{"bad tz", "?from=2026-05-25&to=2026-05-28&tz=Pluto/Olympus", http.StatusUnprocessableEntity, "invalid tz"},
		{"bad from format", "?from=tomorrow&to=2026-05-28", http.StatusUnprocessableEntity, "from must be YYYY-MM-DD"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			res := te.do(t, "GET", base+c.query, nil, te.token)
			if res.StatusCode != c.status {
				t.Fatalf("status = %d, want %d (body: %s)", res.StatusCode, c.status, readBody(res))
			}
			// Decode the error envelope rather than substring-matching
			// the raw body — encoding/json escapes `<` and `>` to
			// `\u003c` / `\u003e`, which is invisible noise here.
			var env struct {
				Error struct {
					Code    string `json:"code"`
					Message string `json:"message"`
				} `json:"error"`
			}
			decodeJSON(t, res, &env)
			if !strings.Contains(env.Error.Message, c.body) {
				t.Errorf("error.message = %q, want substring %q", env.Error.Message, c.body)
			}
		})
	}
}

func TestChartsDaily_ZeroEventDaysStillAppear(t *testing.T) {
	te := newTestEnv(t)
	// Fresh account → no events. A 7-day window must still return 7 rows.
	res := te.do(t, "GET",
		"/v1/babies/"+te.baby.String()+"/charts/daily?from=2026-05-01&to=2026-05-07&tz=UTC",
		nil, te.token)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status = %d %s", res.StatusCode, readBody(res))
	}
	var parsed dailyResp
	decodeJSON(t, res, &parsed)
	if len(parsed.Days) != 7 {
		t.Fatalf("len = %d, want 7", len(parsed.Days))
	}
	for i, d := range parsed.Days {
		if d.BottleML != 0 || d.PumpingML != 0 || d.NursingMinutes != 0 || d.DiaperTotal != 0 {
			t.Errorf("day %d should be zero, got %+v", i, d)
		}
		if d.Growth.WeightG != nil || d.Growth.HeightCM != nil || d.Growth.HeadCM != nil {
			t.Errorf("day %d growth should be all nil, got %+v", i, d.Growth)
		}
	}
}

func TestChartsDaily_UnauthorizedBabyReturns403(t *testing.T) {
	te := newTestEnv(t)
	// Bootstrap a second account; its token must not see the first baby.
	other := newTestEnv(t)
	res := other.do(t, "GET",
		"/v1/babies/"+te.baby.String()+"/charts/daily?from=2026-05-25&to=2026-05-28&tz=UTC",
		nil, other.token)
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("status = %d, want 403 (body: %s)", res.StatusCode, readBody(res))
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
