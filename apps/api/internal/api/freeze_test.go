// Characterization ("freeze") tests for the event-kind HTTP surface.
//
// These tests pin the CURRENT behavior of the eight event kinds (bottle-feeds,
// diapers, pumpings, nursing-sessions, growths, sleeps, notes, solid-meals)
// through the real composition root (NewRouter) against a real Postgres. They
// are the safety net for the refactor that merges the duplicated per-kind
// handlers into one shared event-store module: if a refactor changes any
// observable behavior below, a test here fails.
//
// Rules of the suite:
//   - Observe only via HTTP status, JSON body and the error envelope code.
//     Fixtures (users, households, babies) are created through HTTP routes.
//   - Expected values are literals. Never recompute them the way the code does.
//   - Tests named "APPROVED CHANGE (...)" lock in behavior that is expected to
//     change on purpose; they should be updated, not preserved, when it does.
package api_test

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	apirouter "github.com/varsjad/evernest/apps/api/internal/api"
	"github.com/varsjad/evernest/apps/api/internal/config"
	"github.com/varsjad/evernest/apps/api/internal/store"
)

const defaultTestDSN = "postgres://evernest:evernest_dev@localhost:5432/evernest?sslmode=disable"

// fixedAt is the literal event time used by most create samples.
var fixedAt = time.Date(2026, 3, 1, 10, 0, 0, 0, time.UTC)

// ---------------------------------------------------------------------------
// environment + HTTP helpers
// ---------------------------------------------------------------------------

type env struct {
	srv *httptest.Server
}

// newEnv builds the real router (as cmd/server does) around a real store and
// serves it with httptest. Skips when Postgres is unreachable, unless CI=true.
func newEnv(t *testing.T) *env {
	t.Helper()
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		dsn = defaultTestDSN
	}
	st, err := store.Open(t.Context(), dsn)
	if err != nil {
		if os.Getenv("CI") == "true" {
			t.Fatalf("postgres not reachable (%s): %v", dsn, err)
		}
		t.Skipf("postgres not reachable (%s): %v", dsn, err)
	}
	t.Cleanup(st.Close)
	cfg := &config.Config{
		JWTSecret:           []byte("freeze-test-secret-at-least-32-bytes-long"),
		AccessTokenTTL:      15 * time.Minute,
		RefreshTokenTTLDays: 30,
		CORSAllowOrigin:     "http://localhost:5173",
		PublicWebOrigin:     "http://localhost:5173",
		CookieSameSite:      http.SameSiteLaxMode,
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	srv := httptest.NewServer(apirouter.NewRouter(cfg, st, logger))
	t.Cleanup(srv.Close)
	return &env{srv: srv}
}

type reply struct {
	status int
	body   []byte
	hdr    http.Header
}

// call sends one request. It uses Errorf (not Fatalf) so it is safe to call
// from worker goroutines.
func (e *env) call(t *testing.T, method, path, token string, body any) reply {
	t.Helper()
	var rd io.Reader
	switch b := body.(type) {
	case nil:
	case []byte:
		rd = bytes.NewReader(b)
	default:
		buf, err := json.Marshal(b)
		if err != nil {
			t.Errorf("marshal body: %v", err)
			return reply{}
		}
		rd = bytes.NewReader(buf)
	}
	req, err := http.NewRequest(method, e.srv.URL+path, rd)
	if err != nil {
		t.Errorf("new request: %v", err)
		return reply{}
	}
	if rd != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Errorf("%s %s: %v", method, path, err)
		return reply{}
	}
	defer func() { _ = res.Body.Close() }()
	b, err := io.ReadAll(res.Body)
	if err != nil {
		t.Errorf("read body: %v", err)
		return reply{}
	}
	return reply{status: res.StatusCode, body: b, hdr: res.Header}
}

func mustStatus(t *testing.T, r reply, want int) {
	t.Helper()
	if r.status != want {
		t.Fatalf("status = %d, want %d; body=%s", r.status, want, trunc(r.body))
	}
}

func wantErr(t *testing.T, r reply, status int, code string) {
	t.Helper()
	mustStatus(t, r, status)
	if got := errCode(r); got != code {
		t.Fatalf("error code = %q, want %q; body=%s", got, code, trunc(r.body))
	}
}

func trunc(b []byte) string {
	if len(b) > 300 {
		return string(b[:300]) + "...(truncated)"
	}
	return string(b)
}

func errCode(r reply) string {
	var env struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	_ = json.Unmarshal(r.body, &env)
	return env.Error.Code
}

func obj(t *testing.T, r reply) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(r.body, &m); err != nil {
		t.Fatalf("decode object: %v; body=%s", err, trunc(r.body))
	}
	return m
}

func list(t *testing.T, r reply) []map[string]any {
	t.Helper()
	var out []map[string]any
	if err := json.Unmarshal(r.body, &out); err != nil {
		t.Fatalf("decode list: %v; body=%s", err, trunc(r.body))
	}
	return out
}

func ids(rows []map[string]any) []string {
	out := make([]string, 0, len(rows))
	for _, r := range rows {
		out = append(out, fmt.Sprint(r["id"]))
	}
	return out
}

func contains(xs []string, want string) bool {
	for _, x := range xs {
		if x == want {
			return true
		}
	}
	return false
}

// normalize rewrites every "*_at" timestamp to canonical UTC RFC3339Nano so
// comparisons do not depend on the server's local timezone offset.
func normalize(m map[string]any) map[string]any {
	out := make(map[string]any, len(m))
	for k, v := range m {
		if s, ok := v.(string); ok && strings.HasSuffix(k, "_at") {
			if tm, err := time.Parse(time.RFC3339Nano, s); err == nil {
				out[k] = tm.UTC().Format(time.RFC3339Nano)
				continue
			}
		}
		out[k] = v
	}
	return out
}

// expectField compares one JSON field against a literal. fmt.Sprint is used
// because JSON numbers decode to float64 while literals are ints.
func expectField(t *testing.T, m map[string]any, key string, want any) {
	t.Helper()
	got, ok := m[key]
	if !ok {
		t.Errorf("field %q missing; want %v", key, want)
		return
	}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Errorf("field %q = %v, want %v", key, got, want)
	}
}

func expectTime(t *testing.T, m map[string]any, key string, want time.Time) {
	t.Helper()
	s, ok := m[key].(string)
	if !ok {
		t.Errorf("field %q missing or not a string: %v", key, m[key])
		return
	}
	got, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		t.Errorf("field %q not RFC3339: %v", key, err)
		return
	}
	if !got.UTC().Equal(want.UTC()) {
		t.Errorf("field %q = %s, want %s", key, got.UTC().Format(time.RFC3339Nano), want.UTC().Format(time.RFC3339Nano))
	}
}

func merge(base map[string]any, extra map[string]any) map[string]any {
	out := make(map[string]any, len(base)+len(extra))
	for k, v := range base {
		out[k] = v
	}
	for k, v := range extra {
		out[k] = v
	}
	return out
}

func drop(base map[string]any, keys ...string) map[string]any {
	out := make(map[string]any, len(base))
	for k, v := range base {
		out[k] = v
	}
	for _, k := range keys {
		delete(out, k)
	}
	return out
}

// ---------------------------------------------------------------------------
// fixtures (all through HTTP)
// ---------------------------------------------------------------------------

func signup(t *testing.T, e *env) string {
	t.Helper()
	r := e.call(t, http.MethodPost, "/v1/auth/register", "", map[string]any{
		"email":        "freeze-" + uuid.NewString() + "@example.test",
		"password":     "freeze-pass-1234",
		"display_name": "Freeze Test",
	})
	mustStatus(t, r, http.StatusCreated)
	tok, ok := obj(t, r)["access_token"].(string)
	if !ok {
		t.Fatalf("no access_token in register response")
	}
	return tok
}

func createHousehold(t *testing.T, e *env, token string) string {
	t.Helper()
	r := e.call(t, http.MethodPost, "/v1/households", token, map[string]any{"name": "Freeze Household"})
	mustStatus(t, r, http.StatusCreated)
	return fmt.Sprint(obj(t, r)["id"])
}

func createBaby(t *testing.T, e *env, token, householdID string) string {
	t.Helper()
	r := e.call(t, http.MethodPost, "/v1/households/"+householdID+"/babies", token, map[string]any{"name": "Freeze Baby"})
	mustStatus(t, r, http.StatusCreated)
	return fmt.Sprint(obj(t, r)["id"])
}

type fixture struct {
	token string // owner: member of the household that owns baby + baby2
	baby  string
	baby2 string // second baby in the same household
	other string // token of a user who is NOT a member of owner's household
}

func newFixture(t *testing.T, e *env) fixture {
	t.Helper()
	token := signup(t, e)
	hh := createHousehold(t, e, token)
	return fixture{
		token: token,
		baby:  createBaby(t, e, token, hh),
		baby2: createBaby(t, e, token, hh),
		other: signup(t, e),
	}
}

// ---------------------------------------------------------------------------
// per-kind table
// ---------------------------------------------------------------------------

type badCase struct {
	name   string
	body   any
	status int
	code   string
}

type kind struct {
	name        string        // subtest label
	path        string        // route segment for both /babies/{id}/<path> and /<path>/{id}
	timeField   string        // the field the list endpoint orders and filters by
	window      time.Duration // default list window looking back from now
	wantDefault int           // literal: rows returned by a default list for {now-1h, now-3d, now-400d, now+2d}
	notesKey    string        // "notes" (clearable with "") or "body" (note kind) or ""
	photo       bool          // supports photo / photo_mime and GET /photo
	sample      func(at time.Time) map[string]any
	patchKey    string // one field changed by the PATCH test
	patchVal    any    // literal value for patchKey (differs from sample)
	bad         []badCase
	// Open-session kinds (sleep, nursing) only.
	openSample func(at time.Time) map[string]any
	closeBody  func(endAt time.Time) map[string]any
	// Body-size behavior with a 12 MB notes/body string (create and PATCH).
	bigStatus, bigPatchStatus int
	bigCode, bigPatchCode     string
}

func allKinds() []kind {
	ts := fixedAt
	return []kind{
		{
			name: "bottlefeed", path: "bottle-feeds", timeField: "occurred_at", window: 24 * time.Hour, wantDefault: 1,
			notesKey: "notes",
			sample:   sampleFuncs()["bottlefeed"],
			patchKey: "amount_ml", patchVal: 150,
			bad: []badCase{
				{"milk_source outside enum", merge(kindSample("bottlefeed", ts), map[string]any{"milk_source": "water"}), 422, "validation_failed"},
				{"amount_ml zero (gt=0)", merge(kindSample("bottlefeed", ts), map[string]any{"amount_ml": 0}), 422, "validation_failed"},
				{"occurred_at missing", drop(kindSample("bottlefeed", ts), "occurred_at"), 422, "validation_failed"},
			},
			bigStatus: 413, bigCode: "payload_too_large", bigPatchStatus: 413, bigPatchCode: "payload_too_large",
		},
		{
			name: "diaper", path: "diapers", timeField: "occurred_at", window: 24 * time.Hour, wantDefault: 1,
			notesKey: "notes", photo: true,
			sample:   sampleFuncs()["diaper"],
			patchKey: "type", patchVal: "soiled",
			bad: []badCase{
				{"type outside enum", merge(kindSample("diaper", ts), map[string]any{"type": "runny"}), 422, "validation_failed"},
				{"type missing", drop(kindSample("diaper", ts), "type"), 422, "validation_failed"},
			},
			bigStatus: 413, bigCode: "payload_too_large", bigPatchStatus: 413, bigPatchCode: "payload_too_large",
		},
		{
			name: "pumping", path: "pumpings", timeField: "occurred_at", window: 24 * time.Hour, wantDefault: 1,
			notesKey: "notes",
			sample:   sampleFuncs()["pumping"],
			patchKey: "amount_ml", patchVal: 100,
			bad: []badCase{
				{"amount_ml above 2000", merge(kindSample("pumping", ts), map[string]any{"amount_ml": 2001}), 422, "validation_failed"},
				{"duration_seconds above 21600", merge(kindSample("pumping", ts), map[string]any{"duration_seconds": 21601}), 422, "validation_failed"},
			},
			bigStatus: 413, bigCode: "payload_too_large", bigPatchStatus: 413, bigPatchCode: "payload_too_large",
		},
		{
			name: "nursing", path: "nursing-sessions", timeField: "started_at", window: 24 * time.Hour, wantDefault: 1,
			notesKey: "notes",
			sample:   sampleFuncs()["nursing"],
			patchKey: "notes", patchVal: "edited",
			openSample: func(at time.Time) map[string]any {
				return map[string]any{"started_at": at, "nursing_side": "left"}
			},
			closeBody: func(endAt time.Time) map[string]any {
				return map[string]any{"ended_at": endAt, "left_duration_s": 300, "right_duration_s": 200}
			},
			bad: []badCase{
				{"nursing_side outside enum", merge(kindSample("nursing", ts), map[string]any{"nursing_side": "middle"}), 422, "validation_failed"},
				{"ended_at without durations", drop(kindSample("nursing", ts), "left_duration_s", "right_duration_s"), 422, "validation_failed"},
				{"ended_at before started_at", merge(kindSample("nursing", ts), map[string]any{"ended_at": ts.Add(-time.Hour)}), 422, "validation_failed"},
			},
			bigStatus: 413, bigCode: "payload_too_large", bigPatchStatus: 413, bigPatchCode: "payload_too_large",
		},
		{
			name: "growth", path: "growths", timeField: "measured_at", window: 365 * 24 * time.Hour, wantDefault: 2,
			notesKey: "notes",
			sample:   sampleFuncs()["growth"],
			patchKey: "weight_g", patchVal: 3600,
			bad: []badCase{
				{"no measurement at all", drop(kindSample("growth", ts), "weight_g", "height_cm", "head_circumference_cm"), 422, "validation_failed"},
				{"weight_g at limit (lt=30000)", merge(kindSample("growth", ts), map[string]any{"weight_g": 30000}), 422, "validation_failed"},
			},
			bigStatus: 413, bigCode: "payload_too_large", bigPatchStatus: 413, bigPatchCode: "payload_too_large",
		},
		{
			name: "sleep", path: "sleeps", timeField: "started_at", window: 24 * time.Hour, wantDefault: 1,
			notesKey: "notes",
			sample:   sampleFuncs()["sleep"],
			patchKey: "location", patchVal: "bassinet",
			openSample: func(at time.Time) map[string]any {
				return map[string]any{"started_at": at, "sleep_type": "nap"}
			},
			closeBody: func(endAt time.Time) map[string]any {
				return map[string]any{"ended_at": endAt}
			},
			bad: []badCase{
				{"sleep_type outside enum", merge(kindSample("sleep", ts), map[string]any{"sleep_type": "snooze"}), 422, "validation_failed"},
				{"ended_at before started_at", merge(kindSample("sleep", ts), map[string]any{"ended_at": ts.Add(-time.Hour)}), 422, "validation_failed"},
			},
			bigStatus: 413, bigCode: "payload_too_large", bigPatchStatus: 413, bigPatchCode: "payload_too_large",
		},
		{
			name: "note", path: "notes", timeField: "occurred_at", window: 24 * time.Hour, wantDefault: 1,
			notesKey: "body", photo: true,
			sample:   sampleFuncs()["note"],
			patchKey: "body", patchVal: "edited",
			bad: []badCase{
				{"body empty", merge(kindSample("note", ts), map[string]any{"body": ""}), 422, "validation_failed"},
				{"body whitespace only (trimmed to empty)", merge(kindSample("note", ts), map[string]any{"body": "   "}), 422, "validation_failed"},
			},
			bigStatus: 413, bigCode: "payload_too_large", bigPatchStatus: 413, bigPatchCode: "payload_too_large",
		},
		{
			name: "solid", path: "solid-meals", timeField: "occurred_at", window: 24 * time.Hour, wantDefault: 1,
			notesKey: "notes", photo: true,
			sample:   sampleFuncs()["solid"],
			patchKey: "reaction", patchVal: "refused",
			bad: []badCase{
				{"foods empty", merge(kindSample("solid", ts), map[string]any{"foods": []string{}}), 422, "validation_failed"},
				{"foods only blanks", merge(kindSample("solid", ts), map[string]any{"foods": []string{"  ", ""}}), 422, "validation_failed"},
				{"reaction outside enum", merge(kindSample("solid", ts), map[string]any{"reaction": "yummy"}), 422, "validation_failed"},
			},
			bigStatus: 413, bigCode: "payload_too_large", bigPatchStatus: 413, bigPatchCode: "payload_too_large",
		},
	}
}

// kindSample returns the sample body for the named kind at the given time.
func kindSample(name string, at time.Time) map[string]any {
	fn, ok := sampleFuncs()[name]
	if !ok {
		panic("unknown kind " + name)
	}
	return fn(at)
}

func kindByName(t *testing.T, name string) kind {
	t.Helper()
	for _, k := range allKinds() {
		if k.name == name {
			return k
		}
	}
	t.Fatalf("unknown kind %q", name)
	return kind{}
}

func (e *env) create(t *testing.T, token, babyID string, k kind, body any) reply {
	t.Helper()
	return e.call(t, http.MethodPost, "/v1/babies/"+babyID+"/"+k.path, token, body)
}

func (e *env) listDefault(t *testing.T, token, babyID string, k kind, query string) reply {
	t.Helper()
	return e.call(t, http.MethodGet, "/v1/babies/"+babyID+"/"+k.path+query, token, nil)
}

func (e *env) patch(t *testing.T, token string, k kind, id string, body any) reply {
	t.Helper()
	return e.call(t, http.MethodPatch, "/v1/"+k.path+"/"+id, token, body)
}

func (e *env) remove(t *testing.T, token string, k kind, id string) reply {
	t.Helper()
	return e.call(t, http.MethodDelete, "/v1/"+k.path+"/"+id, token, nil)
}

// rangeQuery is an explicit window wide enough for the fixture times.
const rangeQuery = "?from=2025-01-01T00:00:00Z&to=2030-01-01T00:00:00Z"

// ---------------------------------------------------------------------------
// 1. create: status, shape, client id, source, replay idempotency
// ---------------------------------------------------------------------------

func TestFreezeCreate_ShapeAndReplay(t *testing.T) {
	e := newEnv(t)
	f := newFixture(t, e)
	for _, k := range allKinds() {
		t.Run(k.name, func(t *testing.T) {
			id := uuid.NewString()
			body := merge(k.sample(fixedAt), map[string]any{"id": id})
			r := e.create(t, f.token, f.baby, k, body)
			mustStatus(t, r, http.StatusCreated)
			got := obj(t, r)

			expectField(t, got, "id", id)
			expectField(t, got, "baby_id", f.baby)
			expectField(t, got, "source", "manual")
			if _, ok := got["created_at"]; !ok {
				t.Errorf("created_at missing")
			}
			if _, ok := got["created_by_user_id"]; ok {
				t.Errorf("created_by_user_id must not be exposed")
			}
			for key, want := range k.sample(fixedAt) {
				if key == k.timeField {
					expectTime(t, got, key, fixedAt)
					continue
				}
				if key == "ended_at" {
					continue // only closed-interval kinds; compared below
				}
				expectField(t, got, key, want)
			}
			if k.timeField == "started_at" {
				if _, ok := got["ended_at"]; ok {
					expectTime(t, got, "ended_at", fixedAt.Add(10*time.Minute))
				}
			}

			// Replay the same create: must succeed and return the same row.
			r2 := e.create(t, f.token, f.baby, k, body)
			mustStatus(t, r2, http.StatusCreated)
			expectField(t, obj(t, r2), "id", id)

			// Replay with a different value: the ORIGINAL row wins (no update).
			if k.patchKey != "" {
				changed := merge(body, map[string]any{k.patchKey: k.patchVal})
				r3 := e.create(t, f.token, f.baby, k, changed)
				mustStatus(t, r3, http.StatusCreated)
				expectField(t, obj(t, r3), k.patchKey, k.sample(fixedAt)[k.patchKey])
			}

			// Exactly one row exists for that id in the range.
			rows := list(t, e.listDefault(t, f.token, f.baby, k, rangeQuery))
			n := 0
			for _, row := range rows {
				if fmt.Sprint(row["id"]) == id {
					n++
				}
			}
			if n != 1 {
				t.Errorf("rows with replayed id = %d, want 1", n)
			}
		})
	}
}

func TestFreezeCreate_ServerGeneratesIDWhenOmitted(t *testing.T) {
	e := newEnv(t)
	f := newFixture(t, e)
	for _, k := range allKinds() {
		t.Run(k.name, func(t *testing.T) {
			r := e.create(t, f.token, f.baby, k, k.sample(fixedAt))
			mustStatus(t, r, http.StatusCreated)
			id := fmt.Sprint(obj(t, r)["id"])
			if _, err := uuid.Parse(id); err != nil {
				t.Errorf("generated id %q is not a UUID: %v", id, err)
			}
		})
	}
}

func TestFreezeCreate_Validation(t *testing.T) {
	e := newEnv(t)
	f := newFixture(t, e)
	for _, k := range allKinds() {
		cases := append([]badCase{}, k.bad...)
		cases = append(cases,
			badCase{"unknown field rejected", merge(k.sample(fixedAt), map[string]any{"bogus": 1}), 400, "bad_request"},
			badCase{"malformed JSON", []byte("{"), 400, "bad_request"},
		)
		for _, c := range cases {
			t.Run(k.name+"/"+c.name, func(t *testing.T) {
				r := e.create(t, f.token, f.baby, k, c.body)
				wantErr(t, r, c.status, c.code)
			})
		}
	}
}

// ---------------------------------------------------------------------------
// 3. list: default window, from/to, ordering, limit default + cap
// ---------------------------------------------------------------------------

func TestFreezeList_DefaultWindow(t *testing.T) {
	e := newEnv(t)
	f := newFixture(t, e)
	now := time.Now().UTC()
	for _, k := range allKinds() {
		t.Run(k.name, func(t *testing.T) {
			inWindow := uuid.NewString()
			threeDays := uuid.NewString()
			tooOld := uuid.NewString()
			future := uuid.NewString()
			at := map[string]time.Time{
				inWindow:  now.Add(-time.Hour),
				threeDays: now.Add(-72 * time.Hour),
				tooOld:    now.Add(-400 * 24 * time.Hour),
				future:    now.Add(48 * time.Hour),
			}
			for id, when := range at {
				r := e.create(t, f.token, f.baby, k, merge(k.sample(when), map[string]any{"id": id}))
				mustStatus(t, r, http.StatusCreated)
			}

			got := ids(list(t, e.listDefault(t, f.token, f.baby, k, "")))
			if len(got) != k.wantDefault {
				t.Fatalf("default list returned %d rows, want %d: %v", len(got), k.wantDefault, got)
			}
			if !contains(got, inWindow) {
				t.Errorf("default list missing the 1h-ago row")
			}
			if (k.wantDefault == 2) != contains(got, threeDays) {
				t.Errorf("3-day-old row presence = %v, want %v (window %s)", contains(got, threeDays), k.wantDefault == 2, k.window)
			}
			if contains(got, tooOld) {
				t.Errorf("400-day-old row must never be in the default list")
			}
			if contains(got, future) {
				t.Errorf("row 48h in the future must not be in the default list (to = now+24h)")
			}
		})
	}
}

func TestFreezeList_FromToBoundsAndOrdering(t *testing.T) {
	e := newEnv(t)
	f := newFixture(t, e)
	t0 := time.Date(2026, 3, 1, 10, 0, 0, 0, time.UTC)
	t1 := time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC)
	t2 := time.Date(2026, 3, 2, 10, 0, 0, 0, time.UTC)
	for _, k := range allKinds() {
		t.Run(k.name, func(t *testing.T) {
			// Created out of order on purpose: list must sort by the time field DESC.
			idT1 := uuid.NewString()
			idT2 := uuid.NewString()
			idT0 := uuid.NewString()
			for _, c := range []struct {
				id string
				at time.Time
			}{{idT1, t1}, {idT2, t2}, {idT0, t0}} {
				r := e.create(t, f.token, f.baby, k, merge(k.sample(c.at), map[string]any{"id": c.id}))
				mustStatus(t, r, http.StatusCreated)
			}

			all := list(t, e.listDefault(t, f.token, f.baby, k,
				"?from=2026-03-01T00:00:00Z&to=2026-03-03T00:00:00Z"))
			if got := ids(all); len(got) != 3 || got[0] != idT2 || got[1] != idT1 || got[2] != idT0 {
				t.Fatalf("ordering = %v, want [t2 t1 t0] = [%s %s %s]", got, idT2, idT1, idT0)
			}
			// from is inclusive, to is exclusive.
			half := list(t, e.listDefault(t, f.token, f.baby, k,
				"?from=2026-03-01T10:00:00Z&to=2026-03-01T12:00:00Z"))
			if got := ids(half); len(got) != 1 || got[0] != idT0 {
				t.Errorf("[t0,t1) window = %v, want only t0 (%s)", got, idT0)
			}
			// to is exclusive at exactly t2.
			upToT2 := list(t, e.listDefault(t, f.token, f.baby, k,
				"?from=2026-03-01T00:00:00Z&to=2026-03-02T10:00:00Z"))
			if got := ids(upToT2); contains(got, idT2) {
				t.Errorf("row exactly at to= must be excluded, got %v", got)
			}
		})
	}
}

func TestFreezeList_RangeErrors(t *testing.T) {
	e := newEnv(t)
	f := newFixture(t, e)
	k := kindByName(t, "bottlefeed")
	cases := map[string]string{
		"from not RFC3339 (date only)": "?from=2026-03-01",
		"to not RFC3339":               "?to=tomorrow",
		"from equal to to":             "?from=2026-03-01T00:00:00Z&to=2026-03-01T00:00:00Z",
		"from after to":                "?from=2026-03-02T00:00:00Z&to=2026-03-01T00:00:00Z",
	}
	for name, q := range cases {
		t.Run(name, func(t *testing.T) {
			wantErr(t, e.listDefault(t, f.token, f.baby, k, q), 400, "bad_range")
		})
	}
}

// TestFreezeList_LimitDefaultAndCap creates 1001 rows per kind. Limit behavior:
// missing / 0 / negative / non-numeric / >1000 all fall back to 200; 1..1000 is
// honored. Rows are ordered newest first.
func TestFreezeList_LimitDefaultAndCap(t *testing.T) {
	e := newEnv(t)
	f := newFixture(t, e)
	base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	const total = 1001
	const window = "?from=2025-12-31T00:00:00Z&to=2026-01-02T00:00:00Z"
	for _, k := range allKinds() {
		t.Run(k.name, func(t *testing.T) {
			seedMinutes(t, e, f.token, f.baby, k, base, total)

			newest := base.Add(1000 * time.Minute) // i = 1000 is the newest
			def := list(t, e.listDefault(t, f.token, f.baby, k, window))
			if len(def) != 200 {
				t.Fatalf("default limit returned %d rows, want 200", len(def))
			}
			expectTime(t, def[0], k.timeField, newest)
			for i := 1; i < len(def); i++ {
				prev, _ := time.Parse(time.RFC3339Nano, fmt.Sprint(def[i-1][k.timeField]))
				cur, _ := time.Parse(time.RFC3339Nano, fmt.Sprint(def[i][k.timeField]))
				if !cur.Before(prev) {
					t.Fatalf("row %d not strictly older than row %d", i, i-1)
				}
			}

			cases := map[string]int{
				"&limit=5":    5,
				"&limit=0":    200,
				"&limit=-3":   200,
				"&limit=abc":  200,
				"&limit=1001": 200,
				"&limit=1000": 1000,
			}
			for q, want := range cases {
				got := list(t, e.listDefault(t, f.token, f.baby, k, window+q))
				if len(got) != want {
					t.Errorf("%s returned %d rows, want %d", q, len(got), want)
				}
			}
		})
	}
}

// seedMinutes creates n closed events at base + i minutes via HTTP.
func seedMinutes(t *testing.T, e *env, token, babyID string, k kind, base time.Time, n int) {
	t.Helper()
	const workers = 8
	jobs := make(chan int)
	var wg sync.WaitGroup
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range jobs {
				at := base.Add(time.Duration(i) * time.Minute)
				r := e.create(t, token, babyID, k, k.sample(at))
				if r.status != http.StatusCreated {
					t.Errorf("seed %d: status %d body %s", i, r.status, trunc(r.body))
				}
			}
		}()
	}
	for i := 0; i < n; i++ {
		jobs <- i
	}
	close(jobs)
	wg.Wait()
}

// ---------------------------------------------------------------------------
// 4. PATCH: partial, notes clear, unknown field, 404, 400
// ---------------------------------------------------------------------------

func TestFreezePatch_PartialAndNotes(t *testing.T) {
	e := newEnv(t)
	f := newFixture(t, e)
	for _, k := range allKinds() {
		t.Run(k.name, func(t *testing.T) {
			r := e.create(t, f.token, f.baby, k, k.sample(fixedAt))
			mustStatus(t, r, http.StatusCreated)
			before := obj(t, r)
			id := fmt.Sprint(before["id"])

			// Single field change; everything else must be untouched.
			pr := e.patch(t, f.token, k, id, map[string]any{k.patchKey: k.patchVal})
			mustStatus(t, pr, http.StatusOK)
			after := obj(t, pr)
			expectField(t, after, k.patchKey, k.patchVal)
			b, a := normalize(before), normalize(after)
			if len(b) != len(a) {
				t.Errorf("key count changed: %d -> %d", len(b), len(a))
			}
			for key, v := range b {
				if key == k.patchKey {
					continue
				}
				if fmt.Sprint(a[key]) != fmt.Sprint(v) {
					t.Errorf("untouched field %q changed: %v -> %v", key, v, a[key])
				}
			}
			expectField(t, after, "source", "manual")
			expectField(t, after, "id", id)

			// Empty object is a no-op.
			noop := e.patch(t, f.token, k, id, map[string]any{})
			mustStatus(t, noop, http.StatusOK)
			if fmt.Sprint(normalize(obj(t, noop))) != fmt.Sprint(a) {
				t.Errorf("PATCH {} changed the row")
			}

			// Clearing notes with "" removes the field from the response.
			if k.notesKey == "notes" {
				cl := e.patch(t, f.token, k, id, map[string]any{"notes": ""})
				mustStatus(t, cl, http.StatusOK)
				if _, ok := obj(t, cl)["notes"]; ok {
					t.Errorf(`notes "" must clear the field (absent from JSON)`)
				}
			}

			// Unknown and protected fields are rejected, not silently ignored.
			wantErr(t, e.patch(t, f.token, k, id, map[string]any{"source": "import_babyplus"}), 400, "bad_request")
			wantErr(t, e.patch(t, f.token, k, id, map[string]any{"id": uuid.NewString()}), 400, "bad_request")
			wantErr(t, e.patch(t, f.token, k, id, []byte("{")), 400, "bad_request")

			// Unknown id and malformed id.
			wantErr(t, e.patch(t, f.token, k, uuid.NewString(), map[string]any{k.patchKey: k.patchVal}), 404, "not_found")
			wantErr(t, e.patch(t, f.token, k, "not-a-uuid", map[string]any{k.patchKey: k.patchVal}), 400, "bad_id")
		})
	}
}

func TestFreezePatch_NoteBodyCannotBeCleared(t *testing.T) {
	e := newEnv(t)
	f := newFixture(t, e)
	k := kindByName(t, "note")
	r := e.create(t, f.token, f.baby, k, k.sample(fixedAt))
	mustStatus(t, r, http.StatusCreated)
	id := fmt.Sprint(obj(t, r)["id"])
	wantErr(t, e.patch(t, f.token, k, id, map[string]any{"body": ""}), 422, "validation_failed")
}

func TestFreezePatch_ClearFlags(t *testing.T) {
	e := newEnv(t)
	f := newFixture(t, e)

	t.Run("growth clear_weight_g removes weight only", func(t *testing.T) {
		k := kindByName(t, "growth")
		id := fmt.Sprint(obj(t, e.create(t, f.token, f.baby, k, k.sample(fixedAt))))
		_ = id
		r := e.create(t, f.token, f.baby, k, k.sample(fixedAt))
		mustStatus(t, r, http.StatusCreated)
		gid := fmt.Sprint(obj(t, r)["id"])
		pr := e.patch(t, f.token, k, gid, map[string]any{"clear_weight_g": true})
		mustStatus(t, pr, http.StatusOK)
		got := obj(t, pr)
		if _, ok := got["weight_g"]; ok {
			t.Errorf("weight_g should be cleared")
		}
		expectField(t, got, "height_cm", 52.5)
		expectField(t, got, "head_circumference_cm", 35.5)
	})

	t.Run("growth clearing every measurement is 422", func(t *testing.T) {
		k := kindByName(t, "growth")
		r := e.create(t, f.token, f.baby, k, k.sample(fixedAt))
		mustStatus(t, r, http.StatusCreated)
		gid := fmt.Sprint(obj(t, r)["id"])
		wantErr(t, e.patch(t, f.token, k, gid, map[string]any{
			"clear_weight_g": true, "clear_height_cm": true, "clear_head_circumference_cm": true,
		}), 422, "validation_failed")
	})

	t.Run("nursing clear_starting_breast removes starting_breast", func(t *testing.T) {
		k := kindByName(t, "nursing")
		r := e.create(t, f.token, f.baby, k, k.sample(fixedAt))
		mustStatus(t, r, http.StatusCreated)
		nid := fmt.Sprint(obj(t, r)["id"])
		pr := e.patch(t, f.token, k, nid, map[string]any{"clear_starting_breast": true})
		mustStatus(t, pr, http.StatusOK)
		if _, ok := obj(t, pr)["starting_breast"]; ok {
			t.Errorf("starting_breast should be cleared")
		}
	})

	t.Run("sleep clear_sleep_type removes sleep_type", func(t *testing.T) {
		k := kindByName(t, "sleep")
		r := e.create(t, f.token, f.baby, k, k.sample(fixedAt))
		mustStatus(t, r, http.StatusCreated)
		sid := fmt.Sprint(obj(t, r)["id"])
		pr := e.patch(t, f.token, k, sid, map[string]any{"clear_sleep_type": true})
		mustStatus(t, pr, http.StatusOK)
		if _, ok := obj(t, pr)["sleep_type"]; ok {
			t.Errorf("sleep_type should be cleared")
		}
	})

	t.Run("solid clear_amount_g and reaction \"\"", func(t *testing.T) {
		k := kindByName(t, "solid")
		r := e.create(t, f.token, f.baby, k, k.sample(fixedAt))
		mustStatus(t, r, http.StatusCreated)
		sid := fmt.Sprint(obj(t, r)["id"])
		pr := e.patch(t, f.token, k, sid, map[string]any{"clear_amount_g": true, "reaction": ""})
		mustStatus(t, pr, http.StatusOK)
		got := obj(t, pr)
		if _, ok := got["amount_g"]; ok {
			t.Errorf("amount_g should be cleared")
		}
		if _, ok := got["reaction"]; ok {
			t.Errorf(`reaction "" should clear the field`)
		}
	})
}

// ---------------------------------------------------------------------------
// 5. DELETE: 204, then the row is gone; repeat DELETE is 404
// ---------------------------------------------------------------------------

func TestFreezeDelete(t *testing.T) {
	e := newEnv(t)
	f := newFixture(t, e)
	for _, k := range allKinds() {
		t.Run(k.name, func(t *testing.T) {
			r := e.create(t, f.token, f.baby, k, k.sample(fixedAt))
			mustStatus(t, r, http.StatusCreated)
			id := fmt.Sprint(obj(t, r)["id"])

			d1 := e.remove(t, f.token, k, id)
			mustStatus(t, d1, http.StatusNoContent)
			if len(d1.body) != 0 {
				t.Errorf("204 must have empty body, got %q", d1.body)
			}
			if contains(ids(list(t, e.listDefault(t, f.token, f.baby, k, rangeQuery))), id) {
				t.Errorf("deleted row still listed")
			}

			// Repeat delete and unknown id are 404 (APPROVED CHANGE: was 204).
			wantErr(t, e.remove(t, f.token, k, id), 404, "not_found")
			wantErr(t, e.remove(t, f.token, k, uuid.NewString()), 404, "not_found")
			// Malformed id.
			wantErr(t, e.remove(t, f.token, k, "not-a-uuid"), 400, "bad_id")
			// PATCH after delete is a 404.
			wantErr(t, e.patch(t, f.token, k, id, map[string]any{k.patchKey: k.patchVal}), 404, "not_found")
		})
	}
}

// ---------------------------------------------------------------------------
// 6. authz + authentication
// ---------------------------------------------------------------------------

func TestFreezeAuthz(t *testing.T) {
	e := newEnv(t)
	f := newFixture(t, e)
	for _, k := range allKinds() {
		t.Run(k.name, func(t *testing.T) {
			r := e.create(t, f.token, f.baby, k, k.sample(fixedAt))
			mustStatus(t, r, http.StatusCreated)
			id := fmt.Sprint(obj(t, r)["id"])

			// Non-member on collection routes: 403 (baby exists, membership fails).
			wantErr(t, e.create(t, f.other, f.baby, k, k.sample(fixedAt)), 403, "forbidden")
			wantErr(t, e.listDefault(t, f.other, f.baby, k, rangeQuery), 403, "forbidden")

			// Non-member on item routes: 403.
			wantErr(t, e.patch(t, f.other, k, id, map[string]any{k.patchKey: k.patchVal}), 403, "forbidden")
			wantErr(t, e.remove(t, f.other, k, id), 403, "forbidden")

			// Owner's row is untouched by the rejected attempts.
			if !contains(ids(list(t, e.listDefault(t, f.token, f.baby, k, rangeQuery))), id) {
				t.Errorf("row disappeared after rejected cross-user writes")
			}

			// Unknown baby: 404 on collection routes.
			unknown := uuid.NewString()
			wantErr(t, e.create(t, f.token, unknown, k, k.sample(fixedAt)), 404, "not_found")
			wantErr(t, e.listDefault(t, f.token, unknown, k, rangeQuery), 404, "not_found")

			// Malformed baby id: 400.
			wantErr(t, e.create(t, f.token, "not-a-uuid", k, k.sample(fixedAt)), 400, "bad_id")
			wantErr(t, e.listDefault(t, f.token, "not-a-uuid", k, rangeQuery), 400, "bad_id")

			// No token and bad token: 401 on every route.
			wantErr(t, e.create(t, "", f.baby, k, k.sample(fixedAt)), 401, "unauthorized")
			wantErr(t, e.listDefault(t, "", f.baby, k, rangeQuery), 401, "unauthorized")
			wantErr(t, e.patch(t, "", k, id, map[string]any{k.patchKey: k.patchVal}), 401, "unauthorized")
			wantErr(t, e.remove(t, "", k, id), 401, "unauthorized")
			wantErr(t, e.listDefault(t, "not-a-jwt", f.baby, k, rangeQuery), 401, "unauthorized")
		})
	}
}

// ---------------------------------------------------------------------------
// 7. photo kinds: diaper, note, solid-meal
// ---------------------------------------------------------------------------

var (
	photoPNG  = []byte("\x89PNG-freeze-fixture-bytes")
	photoJPEG = []byte("\xff\xd8\xff-freeze-jpeg-bytes")
)

func b64(b []byte) string { return base64.StdEncoding.EncodeToString(b) }

func TestFreezePhoto_CreateGetPatchClear(t *testing.T) {
	e := newEnv(t)
	f := newFixture(t, e)
	for _, k := range allKinds() {
		if !k.photo {
			continue
		}
		t.Run(k.name, func(t *testing.T) {
			body := merge(k.sample(fixedAt), map[string]any{"photo": b64(photoPNG), "photo_mime": "image/png"})
			r := e.create(t, f.token, f.baby, k, body)
			mustStatus(t, r, http.StatusCreated)
			got := obj(t, r)
			expectField(t, got, "has_photo", true)
			expectField(t, got, "photo_mime", "image/png")
			if _, ok := got["photo"]; ok {
				t.Errorf("list/create must never ship photo bytes")
			}
			id := fmt.Sprint(got["id"])

			// GET photo streams the raw bytes with the stored mime.
			pg := e.call(t, http.MethodGet, "/v1/"+k.path+"/"+id+"/photo", f.token, nil)
			mustStatus(t, pg, http.StatusOK)
			if !bytes.Equal(pg.body, photoPNG) {
				t.Errorf("photo bytes = %q, want %q", pg.body, photoPNG)
			}
			if ct := pg.hdr.Get("Content-Type"); ct != "image/png" {
				t.Errorf("Content-Type = %q, want image/png", ct)
			}
			if cc := pg.hdr.Get("Cache-Control"); cc != "private, max-age=300" {
				t.Errorf("Cache-Control = %q, want private, max-age=300", cc)
			}

			// Replace with JPEG.
			rp := e.patch(t, f.token, k, id, map[string]any{"photo": b64(photoJPEG), "photo_mime": "image/jpeg"})
			mustStatus(t, rp, http.StatusOK)
			expectField(t, obj(t, rp), "photo_mime", "image/jpeg")
			pg2 := e.call(t, http.MethodGet, "/v1/"+k.path+"/"+id+"/photo", f.token, nil)
			mustStatus(t, pg2, http.StatusOK)
			if !bytes.Equal(pg2.body, photoJPEG) || pg2.hdr.Get("Content-Type") != "image/jpeg" {
				t.Errorf("replaced photo: bytes/type mismatch (ct=%q)", pg2.hdr.Get("Content-Type"))
			}

			// photo_mime alone (no photo) is silently ignored: 200, photo unchanged.
			mo := e.patch(t, f.token, k, id, map[string]any{"photo_mime": "image/png"})
			mustStatus(t, mo, http.StatusOK)
			got2 := obj(t, mo)
			expectField(t, got2, "has_photo", true)
			expectField(t, got2, "photo_mime", "image/jpeg")

			// photo "" clears photo and photo_mime.
			cl := e.patch(t, f.token, k, id, map[string]any{"photo": ""})
			mustStatus(t, cl, http.StatusOK)
			cleared := obj(t, cl)
			expectField(t, cleared, "has_photo", false)
			if _, ok := cleared["photo_mime"]; ok {
				t.Errorf("photo_mime should be absent after clear")
			}
			pg3 := e.call(t, http.MethodGet, "/v1/"+k.path+"/"+id+"/photo", f.token, nil)
			mustStatus(t, pg3, http.StatusNoContent)
			if len(pg3.body) != 0 {
				t.Errorf("204 photo body must be empty")
			}
		})
	}
}

func TestFreezePhoto_NoPhotoAndLookupCases(t *testing.T) {
	e := newEnv(t)
	f := newFixture(t, e)
	for _, k := range allKinds() {
		if !k.photo {
			continue
		}
		t.Run(k.name, func(t *testing.T) {
			r := e.create(t, f.token, f.baby, k, k.sample(fixedAt))
			mustStatus(t, r, http.StatusCreated)
			got := obj(t, r)
			expectField(t, got, "has_photo", false)
			if _, ok := got["photo_mime"]; ok {
				t.Errorf("photo_mime should be absent without a photo")
			}
			id := fmt.Sprint(got["id"])

			mustStatus(t, e.call(t, http.MethodGet, "/v1/"+k.path+"/"+id+"/photo", f.token, nil), http.StatusNoContent)
			wantErr(t, e.call(t, http.MethodGet, "/v1/"+k.path+"/"+uuid.NewString()+"/photo", f.token, nil), 404, "not_found")
			wantErr(t, e.call(t, http.MethodGet, "/v1/"+k.path+"/"+id+"/photo", f.other, nil), 403, "forbidden")
			wantErr(t, e.call(t, http.MethodGet, "/v1/"+k.path+"/"+id+"/photo", "", nil), 401, "unauthorized")
		})
	}
}

func TestFreezePhoto_ValidationAndSizeLimits(t *testing.T) {
	e := newEnv(t)
	f := newFixture(t, e)
	exactly2MB := make([]byte, 2*1024*1024)
	over2MB := make([]byte, 2*1024*1024+1)
	for _, k := range allKinds() {
		if !k.photo {
			continue
		}
		t.Run(k.name, func(t *testing.T) {
			with := func(extra map[string]any) map[string]any { return merge(k.sample(fixedAt), extra) }
			wantErr(t, e.create(t, f.token, f.baby, k, with(map[string]any{"photo": b64(photoPNG)})), 422, "validation_failed")
			wantErr(t, e.create(t, f.token, f.baby, k, with(map[string]any{"photo": b64(photoPNG), "photo_mime": "image/gif"})), 422, "validation_failed")
			wantErr(t, e.create(t, f.token, f.baby, k, with(map[string]any{"photo_mime": "image/png"})), 422, "validation_failed")
			wantErr(t, e.create(t, f.token, f.baby, k, with(map[string]any{"photo": "", "photo_mime": "image/png"})), 422, "validation_failed")
			wantErr(t, e.create(t, f.token, f.baby, k, with(map[string]any{"photo": "%%%not-base64", "photo_mime": "image/png"})), 400, "bad_request")

			// Exactly 2 MB decoded is accepted; 2 MB + 1 byte is rejected with 413.
			ok := e.create(t, f.token, f.baby, k, with(map[string]any{"photo": b64(exactly2MB), "photo_mime": "image/png"}))
			mustStatus(t, ok, http.StatusCreated)
			wantErr(t, e.create(t, f.token, f.baby, k, with(map[string]any{"photo": b64(over2MB), "photo_mime": "image/png"})), 413, "payload_too_large")

			// Same rules on PATCH.
			r := e.create(t, f.token, f.baby, k, k.sample(fixedAt))
			mustStatus(t, r, http.StatusCreated)
			id := fmt.Sprint(obj(t, r)["id"])
			wantErr(t, e.patch(t, f.token, k, id, map[string]any{"photo": b64(photoPNG), "photo_mime": "image/tiff"}), 422, "validation_failed")
			wantErr(t, e.patch(t, f.token, k, id, map[string]any{"photo": b64(photoPNG)}), 422, "validation_failed")
			wantErr(t, e.patch(t, f.token, k, id, map[string]any{"photo": b64(over2MB), "photo_mime": "image/png"}), 413, "payload_too_large")
		})
	}
}

// ---------------------------------------------------------------------------
// 8. body size: CURRENT behavior with a 12 MB JSON body.
// Photo kinds cap the body at 3 MB (413). The others have no cap.
// ---------------------------------------------------------------------------

func TestFreezeBodySize(t *testing.T) {
	e := newEnv(t)
	f := newFixture(t, e)
	big := strings.Repeat("a", 12*1024*1024)
	for _, k := range allKinds() {
		t.Run("APPROVED CHANGE (body cap): create "+k.name, func(t *testing.T) {
			body := merge(k.sample(fixedAt), map[string]any{k.notesKey: big})
			r := e.create(t, f.token, f.baby, k, body)
			mustStatus(t, r, k.bigStatus)
			if k.bigCode != "" {
				if got := errCode(r); got != k.bigCode {
					t.Errorf("error code = %q, want %q", got, k.bigCode)
				}
			}
		})
		t.Run("APPROVED CHANGE (body cap): patch "+k.name, func(t *testing.T) {
			r := e.create(t, f.token, f.baby, k, k.sample(fixedAt))
			mustStatus(t, r, http.StatusCreated)
			id := fmt.Sprint(obj(t, r)["id"])
			pr := e.patch(t, f.token, k, id, map[string]any{k.notesKey: big})
			mustStatus(t, pr, k.bigPatchStatus)
			if k.bigPatchCode != "" {
				if got := errCode(pr); got != k.bigPatchCode {
					t.Errorf("error code = %q, want %q", got, k.bigPatchCode)
				}
			}
		})
	}
}

// ---------------------------------------------------------------------------
// solid meals + notes: normalization (current contract)
// ---------------------------------------------------------------------------

func TestFreezeNormalization(t *testing.T) {
	e := newEnv(t)
	f := newFixture(t, e)

	t.Run("solid foods are trimmed and blanks dropped", func(t *testing.T) {
		k := kindByName(t, "solid")
		r := e.create(t, f.token, f.baby, k, merge(k.sample(fixedAt), map[string]any{
			"foods": []string{"  banana ", "", "oat"},
		}))
		mustStatus(t, r, http.StatusCreated)
		foods, ok := obj(t, r)["foods"].([]any)
		if !ok || len(foods) != 2 || foods[0] != "banana" || foods[1] != "oat" {
			t.Errorf("foods = %v, want [banana oat]", obj(t, r)["foods"])
		}
	})

	t.Run("note body is trimmed", func(t *testing.T) {
		k := kindByName(t, "note")
		r := e.create(t, f.token, f.baby, k, merge(k.sample(fixedAt), map[string]any{"body": "  hi  "}))
		mustStatus(t, r, http.StatusCreated)
		expectField(t, obj(t, r), "body", "hi")
	})

	t.Run("bottle replay returns original row not new values", func(t *testing.T) {
		k := kindByName(t, "bottlefeed")
		id := uuid.NewString()
		mustStatus(t, e.create(t, f.token, f.baby, k, merge(k.sample(fixedAt), map[string]any{"id": id})), http.StatusCreated)
		r := e.create(t, f.token, f.baby, k, merge(k.sample(fixedAt), map[string]any{"id": id, "amount_ml": 999}))
		mustStatus(t, r, http.StatusCreated)
		expectField(t, obj(t, r), "amount_ml", 120)
	})
}

// ---------------------------------------------------------------------------
// 10. nursing + sleep: open session lifecycle
// ---------------------------------------------------------------------------

func TestFreezeOpenSession(t *testing.T) {
	e := newEnv(t)
	f := newFixture(t, e)
	for _, name := range []string{"sleep", "nursing"} {
		t.Run(name, func(t *testing.T) {
			k := kindByName(t, name)
			at := fixedAt
			a := uuid.NewString()
			b := uuid.NewString()

			// Open session: no ended_at in the response.
			ra := e.create(t, f.token, f.baby, k, merge(k.openSample(at), map[string]any{"id": a}))
			mustStatus(t, ra, http.StatusCreated)
			if _, ok := obj(t, ra)["ended_at"]; ok {
				t.Errorf("open session must not have ended_at")
			}
			expectTime(t, obj(t, ra), "started_at", at)
			expectField(t, obj(t, ra), "source", "manual")

			// A second open session for the same baby conflicts.
			wantErr(t, e.create(t, f.token, f.baby, k, merge(k.openSample(at.Add(time.Hour)), map[string]any{"id": b})), 409, "open_session_exists")

			// Replaying the SAME open create (same id) is not a conflict.
			mustStatus(t, e.create(t, f.token, f.baby, k, merge(k.openSample(at), map[string]any{"id": a})), http.StatusCreated)

			// GET /open returns the open row.
			open := e.call(t, http.MethodGet, "/v1/babies/"+f.baby+"/"+k.path+"/open", f.token, nil)
			mustStatus(t, open, http.StatusOK)
			expectField(t, obj(t, open), "id", a)

			// A closed create is allowed while an open session exists.
			mustStatus(t, e.create(t, f.token, f.baby, k, k.sample(at.Add(-2*time.Hour))), http.StatusCreated)

			// Closing the open session with PATCH.
			endAt := at.Add(30 * time.Minute)
			cl := e.patch(t, f.token, k, a, k.closeBody(endAt))
			mustStatus(t, cl, http.StatusOK)
			expectTime(t, obj(t, cl), "ended_at", endAt)
			if name == "nursing" {
				expectField(t, obj(t, cl), "left_duration_s", 300)
				expectField(t, obj(t, cl), "right_duration_s", 200)
			}

			// No open session left: 204.
			none := e.call(t, http.MethodGet, "/v1/babies/"+f.baby+"/"+k.path+"/open", f.token, nil)
			mustStatus(t, none, http.StatusNoContent)

			// Open again now that nothing is open.
			mustStatus(t, e.create(t, f.token, f.baby, k, merge(k.openSample(at.Add(2*time.Hour)), map[string]any{"id": b})), http.StatusCreated)

			// Closing without ended_at is 422.
			wantErr(t, e.patch(t, f.token, k, b, map[string]any{}), 422, "validation_failed")

			// Editing the now-closed session A: a PATCH body with ended_at + fields is a closed edit.
			wantErr(t, e.patch(t, f.token, k, a, k.closeBody(at.Add(-time.Hour))), 422, "validation_failed")
			ed := e.patch(t, f.token, k, a, map[string]any{"notes": "edited"})
			mustStatus(t, ed, http.StatusOK)
			expectField(t, obj(t, ed), "notes", "edited")
			expectTime(t, obj(t, ed), "ended_at", endAt)

			// The second baby in the same household has its own open slot.
			mustStatus(t, e.create(t, f.token, f.baby2, k, merge(k.openSample(at), map[string]any{"id": uuid.NewString()})), http.StatusCreated)
			expectField(t, obj(t, e.call(t, http.MethodGet, "/v1/babies/"+f.baby2+"/"+k.path+"/open", f.token, nil)), "baby_id", f.baby2)

			// Open lookup is authz-gated.
			wantErr(t, e.call(t, http.MethodGet, "/v1/babies/"+f.baby+"/"+k.path+"/open", f.other, nil), 403, "forbidden")
			wantErr(t, e.call(t, http.MethodGet, "/v1/babies/"+f.baby+"/"+k.path+"/open", "", nil), 401, "unauthorized")
		})
	}
}

// Sanity: the default-window and range tests pin literal values; this keeps the
// fixed sample time visibly in the past so the default window never sees it.
var _ = fixedAt.Before(time.Now().Add(-365 * 24 * time.Hour * 100))

// sampleFuncs builds the literal sample bodies. It must not call allKinds:
// allKinds' bad cases use them, so a dependency back would recurse forever.
func sampleFuncs() map[string]func(at time.Time) map[string]any {
	const oneMin = time.Minute
	return map[string]func(at time.Time) map[string]any{
		"bottlefeed": func(at time.Time) map[string]any {
			return map[string]any{"occurred_at": at, "milk_source": "breast", "amount_ml": 120, "notes": "left side"}
		},
		"diaper": func(at time.Time) map[string]any {
			return map[string]any{"occurred_at": at, "type": "wet", "notes": "light"}
		},
		"pumping": func(at time.Time) map[string]any {
			return map[string]any{"occurred_at": at, "amount_ml": 90, "duration_seconds": 900, "notes": "morning"}
		},
		"nursing": func(at time.Time) map[string]any {
			return map[string]any{
				"started_at": at, "ended_at": at.Add(10 * oneMin), "starting_breast": "left",
				"nursing_side": "both", "left_duration_s": 300, "right_duration_s": 300, "notes": "feed",
			}
		},
		"growth": func(at time.Time) map[string]any {
			return map[string]any{
				"measured_at": at, "weight_g": 3500, "height_cm": 52.5,
				"head_circumference_cm": 35.5, "notes": "clinic",
			}
		},
		"sleep": func(at time.Time) map[string]any {
			return map[string]any{
				"started_at": at, "ended_at": at.Add(10 * oneMin), "sleep_type": "nap",
				"location": "crib", "notes": "ok",
			}
		},
		"note": func(at time.Time) map[string]any {
			return map[string]any{"occurred_at": at, "body": "first word"}
		},
		"solid": func(at time.Time) map[string]any {
			return map[string]any{
				"occurred_at": at, "foods": []string{"banana", "oat"}, "reaction": "liked",
				"amount_g": 40, "notes": "ok",
			}
		},
	}
}
