// Integration test for the importer's DB writers. Runs against the live
// dev Postgres if it's reachable (same pattern as
// internal/nursing/nursing_test.go). Skips with t.Skipf when the DB is
// unavailable so `go test ./...` on a laptop without docker doesn't fail.
//
// Each test bootstraps its own household + baby via raw SQL (no auth flow
// involved — this is a CLI-level test, not an API test) and cleans up by
// truncating its own rows in t.Cleanup.
package main

import (
	"context"
	"encoding/json"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

const defaultTestDSN = "postgres://evernest:evernest_dev@localhost:5432/evernest?sslmode=disable"

type itEnv struct {
	pool        *pgxpool.Pool
	householdID uuid.UUID
	babyID      uuid.UUID
}

// newITEnv connects to the dev DB and creates an isolated household + baby +
// user. Returns nil to signal skip when the DB is unreachable.
func newITEnv(t *testing.T) *itEnv {
	t.Helper()
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		dsn = defaultTestDSN
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Skipf("postgres not reachable (%s): %v", dsn, err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		t.Skipf("postgres ping failed (%s): %v", dsn, err)
	}

	uid := uuid.New()
	_, err = pool.Exec(ctx, `
		INSERT INTO users (id, email, password_hash, display_name)
		VALUES ($1, $2, '$2y$10$placeholderplaceholderplaceholderplaceholderplaceholderplaceholderplacehold', $3)
	`, uid, "importtest-"+uid.String()+"@example.com", "Import Test")
	if err != nil {
		t.Fatalf("insert user: %v", err)
	}

	var hhID uuid.UUID
	err = pool.QueryRow(ctx, `
		INSERT INTO households (name, created_by) VALUES ('Import IT', $1) RETURNING id
	`, uid).Scan(&hhID)
	if err != nil {
		t.Fatalf("insert household: %v", err)
	}
	_, err = pool.Exec(ctx, `
		INSERT INTO household_members (household_id, user_id, role) VALUES ($1, $2, 'owner')
	`, hhID, uid)
	if err != nil {
		t.Fatalf("insert membership: %v", err)
	}

	var babyID uuid.UUID
	err = pool.QueryRow(ctx, `
		INSERT INTO babies (household_id, name, created_by) VALUES ($1, 'Elly Test', $2) RETURNING id
	`, hhID, uid).Scan(&babyID)
	if err != nil {
		t.Fatalf("insert baby: %v", err)
	}
	_, err = pool.Exec(ctx, `INSERT INTO baby_settings (baby_id) VALUES ($1)`, babyID)
	if err != nil {
		t.Fatalf("insert baby_settings: %v", err)
	}

	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		// ON DELETE CASCADE on babies/households cleans up the event rows.
		_, _ = pool.Exec(ctx, `DELETE FROM households WHERE id = $1`, hhID)
		_, _ = pool.Exec(ctx, `DELETE FROM users WHERE id = $1`, uid)
		pool.Close()
	})
	return &itEnv{pool: pool, householdID: hhID, babyID: babyID}
}

// syntheticExport builds a tiny in-memory export that exercises one row
// of every section, with edge cases:
//   - bottle: formula vs breast
//   - nursing: closed session with both sides
//   - diaper: title-case enum from BabyPlus
//   - growth: weight-only row + all-zero row (must skip)
//   - pumping: present (oz path)
func syntheticExport() *Export {
	pf := func(v float64) *float64 { return &v }
	pi := func(v int) *int { return &v }
	return &Export{
		BottleFeeds: []RawBottle{
			{PK: json.Number("11"), Date: 1779100000, AmountML: pf(120), IsFormula: 0},
			{PK: json.Number("12"), Date: 1779110000, AmountML: pf(60), IsFormula: 1},
		},
		NursingFeeds: []RawNursing{
			{
				PK: json.Number("21"), StartDate: 1779120000, EndDate: 1779121000,
				NursingSide: "both", StartingBreast: "left", LeftDuration: 500, RightDuration: 500,
			},
		},
		Diapers: []RawDiaper{
			{PK: json.Number("31"), Date: 1779130000, Type: "Wet"},
			{PK: json.Number("32"), Date: 1779131000, Type: "Mixed"},
		},
		Growths: []RawGrowth{
			{PK: json.Number("41"), Date: 1779140000, Weight: 3.5},
			{PK: json.Number("42"), Date: 1779141000}, // all-zero -> skipped
		},
		ExpressingFeeds: []RawPumping{
			{PK: json.Number("51"), Date: 1779150000, AmountOz: pf(2), DurationSeconds: pi(900)},
		},
	}
}

// TestImporterEndToEnd asserts the importer writes the expected number of
// rows and is idempotent on a clean re-run.
func TestImporterEndToEnd(t *testing.T) {
	env := newITEnv(t)
	if env == nil {
		return
	}
	ctx := context.Background()
	export := syntheticExport()
	im := newImporter(env.pool, env.babyID, nil, false, false)

	// First pass — everything is new.
	bf, err := im.importBottleFeeds(ctx, export.BottleFeeds)
	if err != nil {
		t.Fatalf("bottle import: %v", err)
	}
	assertCounts(t, bf, 2, 0, 0)

	ns, err := im.importNursingSessions(ctx, export.NursingFeeds)
	if err != nil {
		t.Fatalf("nursing import: %v", err)
	}
	assertCounts(t, ns, 1, 0, 0)

	dp, err := im.importDiapers(ctx, export.Diapers)
	if err != nil {
		t.Fatalf("diaper import: %v", err)
	}
	assertCounts(t, dp, 2, 0, 0)

	gr, err := im.importGrowths(ctx, export.Growths)
	if err != nil {
		t.Fatalf("growth import: %v", err)
	}
	// 1 real measurement; 1 all-zero row -> skipped.
	assertCounts(t, gr, 1, 1, 0)

	pm, err := im.importPumpings(ctx, export.ExpressingFeeds)
	if err != nil {
		t.Fatalf("pumping import: %v", err)
	}
	assertCounts(t, pm, 1, 0, 0)

	assertRowCount(t, env, "bottle_feeds", 2)
	assertRowCount(t, env, "nursing_sessions", 1)
	assertRowCount(t, env, "diapers", 2)
	assertRowCount(t, env, "growths", 1)
	assertRowCount(t, env, "pumpings", 1)

	// Every imported row must carry source='import_babyplus'.
	for _, table := range []string{"bottle_feeds", "nursing_sessions", "diapers", "growths", "pumpings"} {
		var n int
		err := env.pool.QueryRow(ctx, `SELECT count(*) FROM `+table+` WHERE baby_id = $1 AND source <> 'import_babyplus'`, env.babyID).Scan(&n)
		if err != nil {
			t.Fatalf("source check %s: %v", table, err)
		}
		if n != 0 {
			t.Fatalf("source check %s: %d rows are not 'import_babyplus'", table, n)
		}
	}

	// Second pass — every previously-inserted row must be skipped.
	bf2, _ := im.importBottleFeeds(ctx, export.BottleFeeds)
	assertCounts(t, bf2, 0, 2, 0)
	ns2, _ := im.importNursingSessions(ctx, export.NursingFeeds)
	assertCounts(t, ns2, 0, 1, 0)
	dp2, _ := im.importDiapers(ctx, export.Diapers)
	assertCounts(t, dp2, 0, 2, 0)
	gr2, _ := im.importGrowths(ctx, export.Growths)
	// 1 was inserted last time -> now skipped; 1 was skipped last time -> still skipped.
	assertCounts(t, gr2, 0, 2, 0)
	pm2, _ := im.importPumpings(ctx, export.ExpressingFeeds)
	assertCounts(t, pm2, 0, 1, 0)

	// Row counts are unchanged on the re-run.
	assertRowCount(t, env, "bottle_feeds", 2)
	assertRowCount(t, env, "nursing_sessions", 1)
	assertRowCount(t, env, "diapers", 2)
	assertRowCount(t, env, "growths", 1)
	assertRowCount(t, env, "pumpings", 1)
}

// TestImporterDryRun verifies dry-run leaves the DB untouched but still
// returns realistic counts so the operator gets a preview.
func TestImporterDryRun(t *testing.T) {
	env := newITEnv(t)
	if env == nil {
		return
	}
	ctx := context.Background()
	export := syntheticExport()
	im := newImporter(env.pool, env.babyID, nil, true, false)

	bf, err := im.importBottleFeeds(ctx, export.BottleFeeds)
	if err != nil {
		t.Fatalf("dry bottle: %v", err)
	}
	// The "inserted" tally is still 2 because we report "would have inserted",
	// but the row count must be 0 after the rollback.
	assertCounts(t, bf, 2, 0, 0)
	assertRowCount(t, env, "bottle_feeds", 0)
}

func assertCounts(t *testing.T, s SectionStats, ins, skip, errd int) {
	t.Helper()
	if s.Inserted != ins || s.Skipped != skip || s.Errored != errd {
		t.Fatalf("%s: got inserted=%d skipped=%d errored=%d; want %d/%d/%d (errors=%v)",
			s.Section, s.Inserted, s.Skipped, s.Errored, ins, skip, errd, s.Errors)
	}
}

func assertRowCount(t *testing.T, env *itEnv, table string, want int) {
	t.Helper()
	var got int
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := env.pool.QueryRow(ctx, `SELECT count(*) FROM `+table+` WHERE baby_id = $1`, env.babyID).Scan(&got); err != nil {
		t.Fatalf("count %s: %v", table, err)
	}
	if got != want {
		t.Fatalf("%s row count: got %d want %d", table, got, want)
	}
}

// TestResolveBaby ensures the household/baby resolution helpers behave as
// documented across the four cases the CLI relies on.
func TestResolveBaby(t *testing.T) {
	env := newITEnv(t)
	if env == nil {
		return
	}
	ctx := context.Background()

	// Single baby in household -> auto-pick.
	id, name, err := resolveBaby(ctx, env.pool, env.householdID, uuid.Nil)
	if err != nil {
		t.Fatalf("auto-pick: %v", err)
	}
	if id != env.babyID || name == "" {
		t.Fatalf("auto-pick: got %s/%q want %s/non-empty", id, name, env.babyID)
	}

	// Add a second baby — auto-pick now MUST fail with ErrAmbiguousBaby.
	var second uuid.UUID
	err = env.pool.QueryRow(ctx, `
		INSERT INTO babies (household_id, name, created_by)
		VALUES ($1, 'Second', (SELECT created_by FROM households WHERE id = $1))
		RETURNING id
	`, env.householdID).Scan(&second)
	if err != nil {
		t.Fatalf("insert second baby: %v", err)
	}
	_, _, err = resolveBaby(ctx, env.pool, env.householdID, uuid.Nil)
	if err == nil {
		t.Fatal("ambiguous: want error, got nil")
	}

	// Explicit baby ID inside the household resolves cleanly.
	gotID, _, err := resolveBaby(ctx, env.pool, env.householdID, second)
	if err != nil {
		t.Fatalf("explicit: %v", err)
	}
	if gotID != second {
		t.Fatalf("explicit: got %s want %s", gotID, second)
	}

	// Explicit baby ID NOT in the household -> ErrBabyNotInHousehold.
	_, _, err = resolveBaby(ctx, env.pool, env.householdID, uuid.New())
	if err == nil {
		t.Fatal("not-in-household: want error, got nil")
	}
}

func TestLoadExportRealFixture(t *testing.T) {
	path := os.Getenv("BABYPLUS_FIXTURE")
	if path == "" {
		t.Skip("BABYPLUS_FIXTURE not set; skipping real-fixture parse")
	}
	if _, err := os.Stat(path); err != nil {
		t.Skipf("fixture missing: %v", err)
	}
	ex, err := LoadExport(path)
	if err != nil {
		t.Fatalf("LoadExport: %v", err)
	}
	if len(ex.BottleFeeds)+len(ex.Diapers) == 0 {
		t.Fatal("fixture has no rows in any section we care about")
	}
}
