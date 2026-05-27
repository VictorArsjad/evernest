package chart

import (
	"net/url"
	"testing"
	"time"
)

func mustParseDay(t *testing.T, s string) time.Time {
	t.Helper()
	d, err := time.Parse("2006-01-02", s)
	if err != nil {
		t.Fatalf("parse %q: %v", s, err)
	}
	return d
}

func ptrF(v float64) *float64 { return &v }

func TestDensify_InclusiveRangeWithGaps(t *testing.T) {
	from := mustParseDay(t, "2026-05-25")
	to := mustParseDay(t, "2026-05-28")
	days, idx := densify(from, to)
	if got, want := len(days), 4; got != want {
		t.Fatalf("len(days) = %d, want %d", got, want)
	}
	wantKeys := []string{"2026-05-25", "2026-05-26", "2026-05-27", "2026-05-28"}
	for i, k := range wantKeys {
		if days[i].Date != k {
			t.Errorf("days[%d].Date = %q, want %q", i, days[i].Date, k)
		}
		if idx[k] != i {
			t.Errorf("idx[%q] = %d, want %d", k, idx[k], i)
		}
	}
}

func TestDensify_SingleDayWindow(t *testing.T) {
	from := mustParseDay(t, "2026-05-25")
	days, idx := densify(from, from)
	if len(days) != 1 {
		t.Fatalf("len = %d, want 1", len(days))
	}
	if days[0].Date != "2026-05-25" {
		t.Fatalf("date = %q", days[0].Date)
	}
	if idx["2026-05-25"] != 0 {
		t.Fatalf("idx wrong: %v", idx)
	}
}

func TestDensify_ReversedRangeReturnsEmpty(t *testing.T) {
	from := mustParseDay(t, "2026-05-28")
	to := mustParseDay(t, "2026-05-25")
	days, idx := densify(from, to)
	if len(days) != 0 || len(idx) != 0 {
		t.Fatalf("want empty; got %d days, %d idx", len(days), len(idx))
	}
}

func TestBuildDays_HappyPath(t *testing.T) {
	from := mustParseDay(t, "2026-05-25")
	to := mustParseDay(t, "2026-05-27")

	bottle := []bottleDayRow{
		{Day: mustParseDay(t, "2026-05-25"), MilkSource: "formula", AmountML: 300},
		{Day: mustParseDay(t, "2026-05-26"), MilkSource: "formula", AmountML: 480},
	}
	pumping := []pumpingDayRow{
		{Day: mustParseDay(t, "2026-05-25"), AmountML: 100},
	}
	nursing := []nursingDayRow{
		// 5730 sec + 30s round / 60 = 96 min — pinned by the half-up
		// rounding rule (TestMergeNursing_HalfMinuteRounding asserts
		// the boundaries, this just confirms the example from the
		// PR description).
		{Day: mustParseDay(t, "2026-05-26"), DurationS: 5730},
		{Day: mustParseDay(t, "2026-05-25"), DurationS: 600}, // 10 min
	}
	diaper := []diaperDayRow{
		{Day: mustParseDay(t, "2026-05-25"), Type: "wet", Count: 3},
		{Day: mustParseDay(t, "2026-05-25"), Type: "soiled", Count: 1},
		{Day: mustParseDay(t, "2026-05-26"), Type: "mixed", Count: 2},
	}
	growth := []growthRow{
		{
			Day:        mustParseDay(t, "2026-05-25"),
			MeasuredAt: time.Date(2026, 5, 25, 8, 0, 0, 0, time.UTC),
			WeightG:    ptrF(4500), HeightCM: ptrF(55), HeadCM: nil,
		},
		{
			Day:        mustParseDay(t, "2026-05-25"),
			MeasuredAt: time.Date(2026, 5, 25, 17, 0, 0, 0, time.UTC),
			WeightG:    ptrF(4520), HeightCM: nil, HeadCM: ptrF(36.5),
		},
	}

	days := buildDays(from, to, bottle, pumping, nursing, diaper, growth)
	if len(days) != 3 {
		t.Fatalf("len(days) = %d, want 3", len(days))
	}

	// Day 1 (25th)
	d := days[0]
	if d.Date != "2026-05-25" {
		t.Fatalf("days[0].Date = %q", d.Date)
	}
	if d.BottleML != 300 {
		t.Errorf("bottle = %v, want 300", d.BottleML)
	}
	if d.BottleMLFormula != 300 || d.BottleMLBreast != 0 {
		t.Errorf("bottle split d1 = (breast %v, formula %v), want (0, 300)", d.BottleMLBreast, d.BottleMLFormula)
	}
	if d.PumpingML != 100 {
		t.Errorf("pumping = %v, want 100", d.PumpingML)
	}
	if d.NursingMinutes != 10 {
		t.Errorf("nursing min = %d, want 10", d.NursingMinutes)
	}
	if d.DiaperTotal != 4 || d.DiaperWet != 3 || d.DiaperSoiled != 1 || d.DiaperMixed != 0 {
		t.Errorf("diaper(%d,%d,%d,%d) want (4,3,1,0)", d.DiaperTotal, d.DiaperWet, d.DiaperSoiled, d.DiaperMixed)
	}
	if d.Growth.WeightG == nil || *d.Growth.WeightG != 4520 {
		t.Errorf("weight latest non-null = %v, want 4520", d.Growth.WeightG)
	}
	if d.Growth.HeightCM == nil || *d.Growth.HeightCM != 55 {
		// 17:00 row had nil height — 08:00 row's value of 55 must survive.
		t.Errorf("height = %v, want 55 (preserved from earlier row)", d.Growth.HeightCM)
	}
	if d.Growth.HeadCM == nil || *d.Growth.HeadCM != 36.5 {
		t.Errorf("head = %v, want 36.5", d.Growth.HeadCM)
	}

	// Day 2 (26th)
	d = days[1]
	if d.BottleML != 480 {
		t.Errorf("bottle d2 = %v, want 480", d.BottleML)
	}
	if d.BottleMLFormula != 480 || d.BottleMLBreast != 0 {
		t.Errorf("bottle split d2 = (breast %v, formula %v), want (0, 480)", d.BottleMLBreast, d.BottleMLFormula)
	}
	if d.PumpingML != 0 {
		t.Errorf("pumping d2 should be zero, got %v", d.PumpingML)
	}
	if d.NursingMinutes != 96 {
		t.Errorf("nursing d2 = %d, want 96 (5730s + 30s round / 60)", d.NursingMinutes)
	}
	if d.DiaperTotal != 2 || d.DiaperMixed != 2 {
		t.Errorf("diaper d2 totals(%d) mixed(%d) want (2, 2)", d.DiaperTotal, d.DiaperMixed)
	}

	// Day 3 (27th) — no events at all, must still be present with zeros.
	d = days[2]
	if d.Date != "2026-05-27" {
		t.Fatalf("days[2].Date = %q", d.Date)
	}
	if d.BottleML != 0 || d.PumpingML != 0 || d.NursingMinutes != 0 {
		t.Errorf("empty day got non-zero metrics: %+v", d)
	}
	if d.DiaperTotal != 0 {
		t.Errorf("empty day diaper = %d, want 0", d.DiaperTotal)
	}
	if d.Growth.WeightG != nil || d.Growth.HeightCM != nil || d.Growth.HeadCM != nil {
		t.Errorf("empty day growth not nil: %+v", d.Growth)
	}
}

func TestMergeGrowth_PartialDoesNotMaskComplete(t *testing.T) {
	// Regression for the "latest non-null per metric" rule. A later
	// row with only weight set must NOT blank out an earlier full
	// row's height and head.
	from := mustParseDay(t, "2026-05-25")
	to := from
	growth := []growthRow{
		{
			Day:        from,
			MeasuredAt: time.Date(2026, 5, 25, 8, 0, 0, 0, time.UTC),
			WeightG:    ptrF(4500), HeightCM: ptrF(55), HeadCM: ptrF(36),
		},
		{
			Day:        from,
			MeasuredAt: time.Date(2026, 5, 25, 18, 0, 0, 0, time.UTC),
			WeightG:    ptrF(4520),
		},
	}
	days := buildDays(from, to, nil, nil, nil, nil, growth)
	if days[0].Growth.WeightG == nil || *days[0].Growth.WeightG != 4520 {
		t.Fatalf("weight = %v, want 4520", days[0].Growth.WeightG)
	}
	if days[0].Growth.HeightCM == nil || *days[0].Growth.HeightCM != 55 {
		t.Fatalf("height = %v, want 55 (preserved from earlier row)", days[0].Growth.HeightCM)
	}
	if days[0].Growth.HeadCM == nil || *days[0].Growth.HeadCM != 36 {
		t.Fatalf("head = %v, want 36 (preserved from earlier row)", days[0].Growth.HeadCM)
	}
}

func TestMergeNursing_HalfMinuteRounding(t *testing.T) {
	from := mustParseDay(t, "2026-05-25")
	to := from
	cases := []struct {
		seconds int64
		minutes int
	}{
		{0, 0},
		{29, 0},
		{30, 1},
		{59, 1},
		{60, 1},
		{89, 1},
		{90, 2},
	}
	for _, c := range cases {
		days := buildDays(from, to, nil, nil, []nursingDayRow{{Day: from, DurationS: c.seconds}}, nil, nil)
		if days[0].NursingMinutes != c.minutes {
			t.Errorf("seconds=%d -> minutes=%d, want %d", c.seconds, days[0].NursingMinutes, c.minutes)
		}
	}
}

// --- parseDailyParams tests ---

func TestParseDailyParams_HappyPath(t *testing.T) {
	q := url.Values{
		"from": {"2026-05-25"},
		"to":   {"2026-05-31"},
		"tz":   {"Asia/Jakarta"},
	}
	from, to, loc, err := parseDailyParams(q)
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if loc.String() != "Asia/Jakarta" {
		t.Fatalf("loc = %q", loc.String())
	}
	if from.Format("2006-01-02") != "2026-05-25" {
		t.Fatalf("from = %v", from)
	}
	if to.Format("2006-01-02") != "2026-05-31" {
		t.Fatalf("to = %v", to)
	}
}

func TestParseDailyParams_DefaultsToUTC(t *testing.T) {
	q := url.Values{
		"from": {"2026-05-25"},
		"to":   {"2026-05-25"},
	}
	_, _, loc, err := parseDailyParams(q)
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if loc.String() != "UTC" {
		t.Fatalf("default tz = %q, want UTC", loc.String())
	}
}

func TestParseDailyParams_Errors(t *testing.T) {
	cases := []struct {
		name string
		q    url.Values
		want string
	}{
		{"missing from", url.Values{"to": {"2026-05-25"}}, "from and to are required"},
		{"missing to", url.Values{"from": {"2026-05-25"}}, "from and to are required"},
		{"bad tz", url.Values{"from": {"2026-05-25"}, "to": {"2026-05-25"}, "tz": {"Pluto/Olympus"}}, "invalid tz"},
		{"bad from format", url.Values{"from": {"25/05/2026"}, "to": {"2026-05-25"}}, "from must be YYYY-MM-DD"},
		{"bad to format", url.Values{"from": {"2026-05-25"}, "to": {"yesterday"}}, "to must be YYYY-MM-DD"},
		{"to before from", url.Values{"from": {"2026-05-25"}, "to": {"2026-05-20"}}, "to must be >= from"},
		{"window too wide", url.Values{"from": {"2026-01-01"}, "to": {"2026-12-31"}}, "window must be <= 90 days"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, _, _, err := parseDailyParams(c.q)
			if err == nil {
				t.Fatalf("want error containing %q, got nil", c.want)
			}
			if !contains(err.Error(), c.want) {
				t.Fatalf("err = %q, want substring %q", err.Error(), c.want)
			}
		})
	}
}

func TestParseDailyParams_AcceptsExactly90Days(t *testing.T) {
	// from=Jan 1, to=Mar 31 = 31 + 28 + 31 = 90 days (2026 is not a leap year).
	q := url.Values{
		"from": {"2026-01-01"},
		"to":   {"2026-03-31"},
	}
	if _, _, _, err := parseDailyParams(q); err != nil {
		t.Fatalf("90-day window should be accepted: %v", err)
	}
	// 91 days must fail.
	q["to"] = []string{"2026-04-01"}
	if _, _, _, err := parseDailyParams(q); err == nil {
		t.Fatalf("91-day window should be rejected")
	}
}

// --- mergeBottle source-split tests ---

func TestMergeBottle_BreastAndFormulaSameDay(t *testing.T) {
	from := mustParseDay(t, "2026-05-25")
	to := from
	rows := []bottleDayRow{
		{Day: from, MilkSource: "breast", AmountML: 120},
		{Day: from, MilkSource: "formula", AmountML: 60},
	}
	days := buildDays(from, to, rows, nil, nil, nil, nil)
	d := days[0]
	if d.BottleMLBreast != 120 {
		t.Errorf("breast = %v, want 120", d.BottleMLBreast)
	}
	if d.BottleMLFormula != 60 {
		t.Errorf("formula = %v, want 60", d.BottleMLFormula)
	}
	if d.BottleML != 180 {
		t.Errorf("combined = %v, want 180 (sum of both sources)", d.BottleML)
	}
}

func TestMergeBottle_SingleSourceDays(t *testing.T) {
	from := mustParseDay(t, "2026-05-25")
	to := mustParseDay(t, "2026-05-26")
	rows := []bottleDayRow{
		{Day: mustParseDay(t, "2026-05-25"), MilkSource: "breast", AmountML: 200},
		{Day: mustParseDay(t, "2026-05-26"), MilkSource: "formula", AmountML: 150},
	}
	days := buildDays(from, to, rows, nil, nil, nil, nil)

	d25 := days[0]
	if d25.BottleMLBreast != 200 || d25.BottleMLFormula != 0 || d25.BottleML != 200 {
		t.Errorf("d25 = (breast %v, formula %v, total %v), want (200, 0, 200)",
			d25.BottleMLBreast, d25.BottleMLFormula, d25.BottleML)
	}

	d26 := days[1]
	if d26.BottleMLBreast != 0 || d26.BottleMLFormula != 150 || d26.BottleML != 150 {
		t.Errorf("d26 = (breast %v, formula %v, total %v), want (0, 150, 150)",
			d26.BottleMLBreast, d26.BottleMLFormula, d26.BottleML)
	}
}

// TestMergeBottle_UnknownSourceIsDefensive guards the documented behavior
// for milk_source values the schema CHECK currently rejects (so a future
// schema extension that ships before this code is taught about the new
// value still keeps the summary tile truthful).
func TestMergeBottle_UnknownSourceIsDefensive(t *testing.T) {
	from := mustParseDay(t, "2026-05-25")
	to := from
	rows := []bottleDayRow{
		{Day: from, MilkSource: "breast", AmountML: 100},
		{Day: from, MilkSource: "fortified", AmountML: 50}, // hypothetical future value
		{Day: from, MilkSource: "", AmountML: 25},          // empty / null source
	}
	days := buildDays(from, to, rows, nil, nil, nil, nil)
	d := days[0]
	if d.BottleML != 175 {
		t.Errorf("combined = %v, want 175 (all sources contribute to total)", d.BottleML)
	}
	if d.BottleMLBreast != 100 {
		t.Errorf("breast = %v, want 100 (only the 'breast' row)", d.BottleMLBreast)
	}
	if d.BottleMLFormula != 0 {
		t.Errorf("formula = %v, want 0 (unknown sources must not leak into formula)", d.BottleMLFormula)
	}
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
