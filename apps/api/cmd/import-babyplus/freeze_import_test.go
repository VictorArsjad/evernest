// Characterization ("freeze") tests for the importer's current behavior: the
// stats it reports, the rows it writes, and idempotent re-runs. Every expected
// value is a literal. Ids were derived outside this code (UUIDv5 under the
// BabyPlus namespace) so a silent change to the namespace or the section
// labels fails here.
//
// Reuses newITEnv from importer_test.go (same package, skips without Postgres).
package main

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"github.com/google/uuid"
)

// frzFixture is one row per interesting case:
//   - bottle 1001: amountOz path (4 oz -> 118 ml), breast
//   - bottle 1002: amountML path, formula
//   - bottle 1003: no amount -> error
//   - nursing 2001: nursingSide missing, derived "both"
//   - nursing 2002: no durations, no side -> skip
//   - diaper 3001 "Wet", 3002 "Dirty" -> soiled, 3003 unknown -> error
//   - growth 4001 full, 4002 weight only (4.0 kg -> 4000 g), 4003 all zero -> skip
//   - pumping 5001: amountOz 2 -> 59 ml, duration 900
const frzFixture = `{
  "baby_bottlefeed": [
    {"pk": 1001, "babyid": 1, "date": 1767225600, "amountOz": 4, "isFormula": 0},
    {"pk": 1002, "babyid": 1, "date": 1767229200, "amountML": 120, "isFormula": 1},
    {"pk": 1003, "babyid": 1, "date": 1767232800, "isFormula": 0}
  ],
  "baby_nursingfeed": [
    {"pk": 2001, "babyid": 1, "startDate": 1767236400, "endDate": 1767237000, "nursingSide": "", "startingBreast": "left", "leftDuration": 300, "rightDuration": 300},
    {"pk": 2002, "babyid": 1, "startDate": 1767239999, "endDate": 1767240000, "nursingSide": "", "startingBreast": "", "leftDuration": 0, "rightDuration": 0}
  ],
  "baby_nappy": [
    {"pk": 3001, "babyid": 1, "date": 1767243600, "type": "Wet"},
    {"pk": 3002, "babyid": 1, "date": 1767247200, "type": "Dirty"},
    {"pk": 3003, "babyid": 1, "date": 1767247200, "type": "Runny"}
  ],
  "baby_growth": [
    {"pk": 4001, "babyid": 1, "date": 1767250800, "weight": 3.5, "height": 52.5, "head": 35.5},
    {"pk": 4002, "babyid": 1, "date": 1767250800, "weight": 4.0},
    {"pk": 4003, "babyid": 1, "date": 1767250800}
  ],
  "baby_expressingfeed": [
    {"pk": 5001, "babyid": 1, "date": 1767237000, "amountOz": 2, "durationSeconds": 900}
  ]
}`

// Literal row ids: uuid.NewSHA1(babyplusNamespace, section+":"+pk).
const (
	frzBottle1001  = "7aad78da-aab3-5840-b446-fa74dd7d8d57"
	frzBottle1002  = "22665cc5-3503-50a0-9668-b15a860cba1b"
	frzNursing2001 = "61255129-e16a-51b8-8de9-02bfb4065343"
	frzDiaper3001  = "3b92bab6-9df6-5241-8514-6c5b45eb0ed5"
	frzDiaper3002  = "818cf451-d8bc-506a-9dd1-1561c8e60c58"
	frzGrowth4001  = "0cdb81a7-3008-5906-b816-5a189d968046"
	frzGrowth4002  = "8981c1eb-1b18-55db-9a98-6c339bba1802"
	frzPumping5001 = "3de1a11f-cac4-5a66-92c5-823ecad11c96"
)

// frzUTC parses a literal RFC3339 instant. Comparisons use time.Equal, so a
// local-TZ difference cannot cause a false failure.
func frzUTC(t *testing.T, s string) time.Time {
	t.Helper()
	v, err := time.Parse(time.RFC3339, s)
	if err != nil {
		t.Fatalf("bad literal time %q: %v", s, err)
	}
	return v
}

func frzLoad(t *testing.T) *Export {
	t.Helper()
	p := filepath.Join(t.TempDir(), "export.json")
	if err := os.WriteFile(p, []byte(frzFixture), 0o600); err != nil {
		t.Fatalf("write fixture: %v", err)
	}
	ex, err := LoadExport(p)
	if err != nil {
		t.Fatalf("LoadExport: %v", err)
	}
	return ex
}

// frzRunAll runs every section in the order the CLI uses.
func frzRunAll(t *testing.T, im *importer, ex *Export) map[string]SectionStats {
	t.Helper()
	ctx := context.Background()
	out := map[string]SectionStats{}
	steps := []struct {
		name string
		run  func() (SectionStats, error)
	}{
		{sectionBottleFeeds, func() (SectionStats, error) { return im.importBottleFeeds(ctx, ex.BottleFeeds) }},
		{sectionNursingSessions, func() (SectionStats, error) { return im.importNursingSessions(ctx, ex.NursingFeeds) }},
		{sectionDiapers, func() (SectionStats, error) { return im.importDiapers(ctx, ex.Diapers) }},
		{sectionGrowths, func() (SectionStats, error) { return im.importGrowths(ctx, ex.Growths) }},
		{sectionPumpings, func() (SectionStats, error) { return im.importPumpings(ctx, ex.ExpressingFeeds) }},
	}
	for _, s := range steps {
		st, err := s.run()
		if err != nil {
			t.Fatalf("%s: unexpected section error: %v", s.name, err)
		}
		out[s.name] = st
	}
	return out
}

func frzCheckStats(t *testing.T, got map[string]SectionStats, want map[string]SectionStats) {
	t.Helper()
	for _, section := range []string{sectionBottleFeeds, sectionNursingSessions, sectionDiapers, sectionGrowths, sectionPumpings} {
		g, w := got[section], want[section]
		if g.Inserted != w.Inserted || g.Skipped != w.Skipped || g.Errored != w.Errored {
			t.Errorf("%s: got inserted=%d skipped=%d errored=%d, want inserted=%d skipped=%d errored=%d",
				section, g.Inserted, g.Skipped, g.Errored, w.Inserted, w.Skipped, w.Errored)
		}
		if !slices.Equal(g.Errors, w.Errors) {
			t.Errorf("%s: errors = %q, want %q", section, g.Errors, w.Errors)
		}
	}
}

func TestFreezeImport_NamespaceIsStable(t *testing.T) {
	// Changing this value orphans every previously imported row (see parse.go).
	if got, want := babyplusNamespace.String(), "5fdd2e8d-8771-5bc4-b9f0-e0699073e91c"; got != want {
		t.Fatalf("babyplusNamespace = %s, want %s", got, want)
	}
	if got, want := deterministicID(sectionBottleFeeds, "1001").String(), frzBottle1001; got != want {
		t.Fatalf("bottle 1001 id = %s, want %s", got, want)
	}
}

func TestFreezeImport_FirstRunStats(t *testing.T) {
	env := newITEnv(t)
	ex := frzLoad(t)
	im := newImporter(env.pool, env.babyID, nil, false, false)

	got := frzRunAll(t, im, ex)
	want := map[string]SectionStats{
		sectionBottleFeeds: {Inserted: 2, Errored: 1,
			Errors: []string{"pk=1003: missing amountML and amountOz"}},
		sectionNursingSessions: {Inserted: 1, Skipped: 1},
		sectionDiapers: {Inserted: 2, Errored: 1,
			Errors: []string{`pk=3003: unknown diaper type "Runny"`}},
		sectionGrowths:  {Inserted: 2, Skipped: 1},
		sectionPumpings: {Inserted: 1},
	}
	frzCheckStats(t, got, want)
}

func TestFreezeImport_RowContents(t *testing.T) {
	env := newITEnv(t)
	ex := frzLoad(t)
	im := newImporter(env.pool, env.babyID, nil, false, false)
	frzRunAll(t, im, ex)
	ctx := context.Background()

	t.Run("bottle 1001 amountOz converted, breast", func(t *testing.T) {
		var occurred time.Time
		var milk, source string
		var amount float64
		var notes *string
		var createdBy *uuid.UUID
		err := env.pool.QueryRow(ctx,
			`SELECT occurred_at, milk_source, amount_ml, notes, source, created_by_user_id
			 FROM bottle_feeds WHERE id = $1`, frzBottle1001).
			Scan(&occurred, &milk, &amount, &notes, &source, &createdBy)
		if err != nil {
			t.Fatalf("select: %v", err)
		}
		if !occurred.Equal(frzUTC(t, "2026-01-01T00:00:00Z")) {
			t.Errorf("occurred_at = %s", occurred)
		}
		if milk != "breast" || amount != 118 {
			t.Errorf("milk=%q amount=%v, want breast 118", milk, amount)
		}
		if notes != nil {
			t.Errorf("notes = %q, want NULL (importer does not map bottle notes)", *notes)
		}
		if source != "import_babyplus" {
			t.Errorf("source = %q", source)
		}
		if createdBy != nil {
			t.Errorf("created_by_user_id = %v, want NULL for CLI runs", *createdBy)
		}
	})

	t.Run("bottle 1002 amountML, formula", func(t *testing.T) {
		var occurred time.Time
		var milk string
		var amount float64
		err := env.pool.QueryRow(ctx,
			`SELECT occurred_at, milk_source, amount_ml FROM bottle_feeds WHERE id = $1`, frzBottle1002).
			Scan(&occurred, &milk, &amount)
		if err != nil {
			t.Fatalf("select: %v", err)
		}
		if !occurred.Equal(frzUTC(t, "2026-01-01T01:00:00Z")) || milk != "formula" || amount != 120 {
			t.Errorf("got %s %q %v, want 01:00Z formula 120", occurred, milk, amount)
		}
	})

	t.Run("nursing 2001 derives side both, keeps starting breast", func(t *testing.T) {
		var started, ended time.Time
		var startingBreast *string
		var side, source string
		var left, right int
		err := env.pool.QueryRow(ctx,
			`SELECT started_at, ended_at, starting_breast, nursing_side, left_duration_s,
			        right_duration_s, source FROM nursing_sessions WHERE id = $1`, frzNursing2001).
			Scan(&started, &ended, &startingBreast, &side, &left, &right, &source)
		if err != nil {
			t.Fatalf("select: %v", err)
		}
		if !started.Equal(frzUTC(t, "2026-01-01T03:00:00Z")) || !ended.Equal(frzUTC(t, "2026-01-01T03:10:00Z")) {
			t.Errorf("times = %s..%s", started, ended)
		}
		if startingBreast == nil || *startingBreast != "left" {
			t.Errorf("starting_breast = %v, want left", startingBreast)
		}
		if side != "both" || left != 300 || right != 300 || source != "import_babyplus" {
			t.Errorf("side=%q left=%d right=%d source=%q", side, left, right, source)
		}
	})

	t.Run("diapers map Wet and Dirty", func(t *testing.T) {
		for _, c := range []struct {
			id, at, typ string
		}{
			{frzDiaper3001, "2026-01-01T05:00:00Z", "wet"},
			{frzDiaper3002, "2026-01-01T06:00:00Z", "soiled"},
		} {
			var occurred time.Time
			var typ string
			if err := env.pool.QueryRow(ctx,
				`SELECT occurred_at, type FROM diapers WHERE id = $1`, c.id).Scan(&occurred, &typ); err != nil {
				t.Fatalf("select %s: %v", c.id, err)
			}
			if !occurred.Equal(frzUTC(t, c.at)) || typ != c.typ {
				t.Errorf("%s: got %s %q, want %s %q", c.id, occurred, typ, c.at, c.typ)
			}
		}
	})

	t.Run("growth 4001 converts kg to grams", func(t *testing.T) {
		var measured time.Time
		var weight, height, head *float64
		err := env.pool.QueryRow(ctx,
			`SELECT measured_at, weight_g, height_cm, head_circumference_cm FROM growths WHERE id = $1`, frzGrowth4001).
			Scan(&measured, &weight, &height, &head)
		if err != nil {
			t.Fatalf("select: %v", err)
		}
		if !measured.Equal(frzUTC(t, "2026-01-01T07:00:00Z")) {
			t.Errorf("measured_at = %s", measured)
		}
		if weight == nil || *weight != 3500 {
			t.Errorf("weight_g = %v, want 3500", weight)
		}
		if height == nil || *height != 52.5 || head == nil || *head != 35.5 {
			t.Errorf("height=%v head=%v, want 52.5 / 35.5", height, head)
		}
	})

	t.Run("growth 4002 weight only leaves other axes NULL", func(t *testing.T) {
		var weight, height, head *float64
		err := env.pool.QueryRow(ctx,
			`SELECT weight_g, height_cm, head_circumference_cm FROM growths WHERE id = $1`, frzGrowth4002).
			Scan(&weight, &height, &head)
		if err != nil {
			t.Fatalf("select: %v", err)
		}
		if weight == nil || *weight != 4000 || height != nil || head != nil {
			t.Errorf("weight=%v height=%v head=%v, want 4000 / NULL / NULL", weight, height, head)
		}
	})

	t.Run("pumping 5001 converts oz and keeps duration", func(t *testing.T) {
		var occurred time.Time
		var amount float64
		var duration *int
		err := env.pool.QueryRow(ctx,
			`SELECT occurred_at, amount_ml, duration_seconds FROM pumpings WHERE id = $1`, frzPumping5001).
			Scan(&occurred, &amount, &duration)
		if err != nil {
			t.Fatalf("select: %v", err)
		}
		if !occurred.Equal(frzUTC(t, "2026-01-01T03:10:00Z")) || amount != 59 {
			t.Errorf("got %s amount=%v, want 03:10Z 59", occurred, amount)
		}
		if duration == nil || *duration != 900 {
			t.Errorf("duration_seconds = %v, want 900", duration)
		}
	})
}

func TestFreezeImport_RerunIsIdempotent(t *testing.T) {
	env := newITEnv(t)
	ex := frzLoad(t)
	frzRunAll(t, newImporter(env.pool, env.babyID, nil, false, false), ex)

	// Second run: every previously inserted row is now Skipped. The rows that
	// were skipped or errored on the first run keep their same outcome.
	got := frzRunAll(t, newImporter(env.pool, env.babyID, nil, false, false), ex)
	want := map[string]SectionStats{
		sectionBottleFeeds: {Skipped: 2, Errored: 1,
			Errors: []string{"pk=1003: missing amountML and amountOz"}},
		sectionNursingSessions: {Skipped: 2},
		sectionDiapers: {Skipped: 2, Errored: 1,
			Errors: []string{`pk=3003: unknown diaper type "Runny"`}},
		sectionGrowths:  {Skipped: 3},
		sectionPumpings: {Skipped: 1},
	}
	frzCheckStats(t, got, want)

	// Row counts must not change after the re-run.
	counts := map[string]int{
		"bottle_feeds":     2,
		"nursing_sessions": 1,
		"diapers":          2,
		"growths":          2,
		"pumpings":         1,
	}
	for table, n := range counts {
		var c int
		err := env.pool.QueryRow(context.Background(),
			`SELECT count(*) FROM `+table+` WHERE baby_id = $1 AND source = 'import_babyplus'`, env.babyID).Scan(&c)
		if err != nil {
			t.Fatalf("count %s: %v", table, err)
		}
		if c != n {
			t.Errorf("%s: %d imported rows after re-run, want %d", table, c, n)
		}
	}
}
