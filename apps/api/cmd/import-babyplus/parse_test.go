// Table-driven unit tests for the pure parser/mapper layer. These tests
// deliberately avoid touching Postgres so they're cheap, parallelizable, and
// resilient to schema churn — the integration test in importer_test.go is
// what exercises the DB round-trip.
package main

import (
	"encoding/json"
	"math"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestDeterministicIDIsStable(t *testing.T) {
	t.Parallel()
	// Two calls with the same inputs must produce the same UUID. This is
	// the entire idempotency contract — if this ever fails, re-running
	// the importer is no longer a no-op.
	a := deterministicID(sectionBottleFeeds, "3477985907477778")
	b := deterministicID(sectionBottleFeeds, "3477985907477778")
	if a != b {
		t.Fatalf("deterministic id drifted: %s vs %s", a, b)
	}
	if a == uuid.Nil {
		t.Fatal("deterministic id resolved to uuid.Nil")
	}
	// Different sections with the same pk MUST produce different ids —
	// otherwise a bottle row's pk colliding with a diaper row's pk would
	// silently overwrite the other section's import.
	bottleID := deterministicID(sectionBottleFeeds, "1")
	diaperID := deterministicID(sectionDiapers, "1")
	if bottleID == diaperID {
		t.Fatalf("section did not affect id: bottle=%s diaper=%s", bottleID, diaperID)
	}
}

func TestBPUnixToUTC(t *testing.T) {
	t.Parallel()
	// Truncates to whole seconds and lands in UTC regardless of the host tz.
	got := bpUnixToUTC(1779153734.6)
	want := time.Unix(1779153734, 0).UTC().Truncate(time.Second)
	if !got.Equal(want) {
		t.Fatalf("bpUnixToUTC: got %s want %s", got, want)
	}
	if got.Location() != time.UTC {
		t.Fatalf("bpUnixToUTC: expected UTC, got %s", got.Location())
	}
	if !bpUnixToUTC(0).IsZero() {
		t.Fatal("bpUnixToUTC(0): expected zero")
	}
	if !bpUnixToUTC(-1).IsZero() {
		t.Fatal("bpUnixToUTC(-1): expected zero")
	}
}

func ptrF(v float64) *float64 { return &v }
func ptrI(v int) *int         { return &v }

func TestMapBottle(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name   string
		in     RawBottle
		want   *BottleFeed
		errMsg string
	}{
		{
			name: "ml direct (formula)",
			in: RawBottle{
				PK:        json.Number("3477985907477778"),
				BabyID:    json.Number("1"),
				Date:      1779153734.049335,
				AmountML:  ptrF(30),
				IsFormula: 1,
			},
			want: &BottleFeed{
				OccurredAt: time.Unix(1779153734, 0).UTC(),
				MilkSource: "formula",
				AmountML:   30,
			},
		},
		{
			name: "ml direct (breast)",
			in: RawBottle{
				PK:        json.Number("7440380652221232"),
				Date:      1777298990.019304,
				AmountML:  ptrF(120),
				IsFormula: 0,
			},
			want: &BottleFeed{
				OccurredAt: time.Unix(1777298990, 0).UTC(),
				MilkSource: "breast",
				AmountML:   120,
			},
		},
		{
			name: "oz path rounds to int ml",
			in: RawBottle{
				PK:       json.Number("999"),
				Date:     1779153734,
				AmountOz: ptrF(4), // 4 oz * 29.5735 = 118.294 -> 118 ml
			},
			want: &BottleFeed{
				OccurredAt: time.Unix(1779153734, 0).UTC(),
				MilkSource: "breast",
				AmountML:   118,
			},
		},
		{name: "missing pk", in: RawBottle{Date: 1, AmountML: ptrF(10)}, errMsg: "missing pk"},
		{name: "missing date", in: RawBottle{PK: json.Number("1"), AmountML: ptrF(10)}, errMsg: "invalid date"},
		{name: "missing amount", in: RawBottle{PK: json.Number("1"), Date: 1779153734}, errMsg: "missing amountML"},
		{name: "amount over cap", in: RawBottle{PK: json.Number("1"), Date: 1779153734, AmountML: ptrF(3000)}, errMsg: "amount_ml"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := MapBottle(tt.in)
			if tt.errMsg != "" {
				if err == nil || !contains(err.Error(), tt.errMsg) {
					t.Fatalf("want err containing %q, got %v", tt.errMsg, err)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected err: %v", err)
			}
			if got.MilkSource != tt.want.MilkSource ||
				got.AmountML != tt.want.AmountML ||
				!got.OccurredAt.Equal(tt.want.OccurredAt) {
				t.Fatalf("got %+v want %+v", got, tt.want)
			}
			// id must be deterministic; recompute the expected.
			wantID := deterministicID(sectionBottleFeeds, tt.in.PK.String())
			if got.ID != wantID {
				t.Fatalf("id mismatch: got %s want %s", got.ID, wantID)
			}
		})
	}
}

func TestDeriveNursingSide(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name string
		l, r int
		exp  string
		want string
	}{
		{"explicit both wins", 500, 500, "both", "both"},
		{"explicit left wins even with zero durations", 0, 0, "left", "left"},
		{"left+right derives both", 100, 200, "", "both"},
		{"left only", 100, 0, "", "left"},
		{"right only", 0, 100, "", "right"},
		{"all zero -> empty -> skip", 0, 0, "", ""},
		{"unknown export side falls back to derivation", 100, 0, "junk", "left"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := deriveNursingSide(tt.l, tt.r, tt.exp); got != tt.want {
				t.Fatalf("got %q want %q", got, tt.want)
			}
		})
	}
}

func TestMapNursing(t *testing.T) {
	t.Parallel()
	left := "left"
	tests := []struct {
		name string
		in   RawNursing
		want *NursingSession
		skip bool
		err  string
	}{
		{
			name: "happy path both",
			in: RawNursing{
				PK:             json.Number("44976564489939661"),
				StartDate:      1773320233,
				EndDate:        1773322061,
				NursingSide:    "both",
				StartingBreast: "left",
				LeftDuration:   568,
				RightDuration:  1260,
			},
			want: &NursingSession{
				StartedAt:      time.Unix(1773320233, 0).UTC(),
				EndedAt:        time.Unix(1773322061, 0).UTC(),
				NursingSide:    "both",
				StartingBreast: &left,
				LeftDurationS:  568,
				RightDurationS: 1260,
			},
		},
		{
			name: "all-zero with no nursingSide -> skip (nil,nil)",
			in: RawNursing{
				PK:        json.Number("1"),
				StartDate: 100,
				EndDate:   200,
			},
			skip: true,
		},
		{
			name: "end before start",
			in: RawNursing{
				PK:           json.Number("1"),
				StartDate:    200,
				EndDate:      100,
				NursingSide:  "left",
				LeftDuration: 60,
			},
			err: "invalid endDate",
		},
		{
			name: "out-of-range duration",
			in: RawNursing{
				PK:           json.Number("1"),
				StartDate:    1,
				EndDate:      2,
				NursingSide:  "left",
				LeftDuration: 999_999,
			},
			err: "out of range",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := MapNursing(tt.in)
			if tt.err != "" {
				if err == nil || !contains(err.Error(), tt.err) {
					t.Fatalf("want err containing %q, got %v", tt.err, err)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected err: %v", err)
			}
			if tt.skip {
				if got != nil {
					t.Fatalf("expected skip (nil) got %+v", got)
				}
				return
			}
			if got.NursingSide != tt.want.NursingSide ||
				got.LeftDurationS != tt.want.LeftDurationS ||
				got.RightDurationS != tt.want.RightDurationS ||
				!got.StartedAt.Equal(tt.want.StartedAt) ||
				!got.EndedAt.Equal(tt.want.EndedAt) {
				t.Fatalf("got %+v want %+v", got, tt.want)
			}
			if (got.StartingBreast == nil) != (tt.want.StartingBreast == nil) ||
				(got.StartingBreast != nil && *got.StartingBreast != *tt.want.StartingBreast) {
				t.Fatalf("starting_breast mismatch: got %v want %v", got.StartingBreast, tt.want.StartingBreast)
			}
		})
	}
}

func TestMapDiaperType(t *testing.T) {
	t.Parallel()
	tests := []struct {
		in   string
		want string
		err  bool
	}{
		{"Wet", "wet", false},
		{"wet", "wet", false},
		{"Mixed", "mixed", false},
		{"Soiled", "soiled", false},
		{"Dirty", "soiled", false}, // alias
		{"Bogus", "", true},
	}
	for _, tt := range tests {
		t.Run(tt.in, func(t *testing.T) {
			got, err := mapDiaperType(tt.in)
			if tt.err {
				if err == nil {
					t.Fatalf("want err, got %q", got)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected err: %v", err)
			}
			if got != tt.want {
				t.Fatalf("got %q want %q", got, tt.want)
			}
		})
	}
}

func TestMapDiaper(t *testing.T) {
	t.Parallel()
	got, err := MapDiaper(RawDiaper{
		PK:   json.Number("41238018937259122"),
		Date: 1776822540,
		Type: "Wet",
	})
	if err != nil {
		t.Fatalf("MapDiaper: %v", err)
	}
	if got.Type != "wet" || got.OccurredAt.Year() != 2026 {
		t.Fatalf("got %+v", got)
	}
	if _, err := MapDiaper(RawDiaper{PK: json.Number("1"), Date: 1776822540, Type: "Junk"}); err == nil {
		t.Fatal("want err for unknown type")
	}
}

func TestMapGrowth(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name      string
		in        RawGrowth
		wantW     *float64
		wantH     *float64
		wantHead  *float64
		skip      bool
		err       string
	}{
		{
			name: "weight only",
			in: RawGrowth{
				PK:     json.Number("1198898541449688841"),
				Date:   1774316214,
				Weight: 3.55,
			},
			wantW: ptrF(3550),
		},
		{
			name: "all three",
			in: RawGrowth{
				PK:     json.Number("8617846633303354777"),
				Date:   1773032400,
				Weight: 3.34,
				Height: 49,
				Head:   36,
			},
			// 3.34 kg * 1000 = 3340 g (Math.Round handles float noise).
			wantW:    ptrF(3340),
			wantH:    ptrF(49),
			wantHead: ptrF(36),
		},
		{
			name: "all zero -> skip",
			in: RawGrowth{
				PK:   json.Number("1"),
				Date: 1773032400,
			},
			skip: true,
		},
		{
			name: "weight too big",
			in: RawGrowth{
				PK:     json.Number("1"),
				Date:   1773032400,
				Weight: 50, // 50 kg = 50000 g, over cap
			},
			err: "weight_g",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := MapGrowth(tt.in)
			if tt.err != "" {
				if err == nil || !contains(err.Error(), tt.err) {
					t.Fatalf("want err containing %q, got %v", tt.err, err)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected err: %v", err)
			}
			if tt.skip {
				if got != nil {
					t.Fatalf("want skip got %+v", got)
				}
				return
			}
			if !ptrEq(got.WeightG, tt.wantW) {
				t.Fatalf("weight: got %v want %v", got.WeightG, tt.wantW)
			}
			if !ptrEq(got.HeightCM, tt.wantH) {
				t.Fatalf("height: got %v want %v", got.HeightCM, tt.wantH)
			}
			if !ptrEq(got.HeadCircumferenceCM, tt.wantHead) {
				t.Fatalf("head: got %v want %v", got.HeadCircumferenceCM, tt.wantHead)
			}
		})
	}
}

func TestMapPumping(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name string
		in   RawPumping
		want *Pumping
		err  string
	}{
		{
			name: "ml + duration",
			in: RawPumping{
				PK:              json.Number("1"),
				Date:            1779153734,
				AmountML:        ptrF(120),
				DurationSeconds: ptrI(900),
			},
			want: &Pumping{
				AmountML:        120,
				DurationSeconds: ptrI(900),
			},
		},
		{
			name: "oz path",
			in: RawPumping{
				PK:       json.Number("2"),
				Date:     1779153734,
				AmountOz: ptrF(2),
			},
			want: &Pumping{AmountML: math.Round(2 * 29.5735)},
		},
		{
			name: "missing pk",
			in:   RawPumping{Date: 1, AmountML: ptrF(1)},
			err:  "missing pk",
		},
		{
			name: "over cap",
			in: RawPumping{
				PK: json.Number("1"), Date: 1, AmountML: ptrF(3000),
			},
			err: "amount_ml",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := MapPumping(tt.in)
			if tt.err != "" {
				if err == nil || !contains(err.Error(), tt.err) {
					t.Fatalf("want err containing %q, got %v", tt.err, err)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected err: %v", err)
			}
			if got.AmountML != tt.want.AmountML {
				t.Fatalf("amount_ml: got %v want %v", got.AmountML, tt.want.AmountML)
			}
			if !ptrIEq(got.DurationSeconds, tt.want.DurationSeconds) {
				t.Fatalf("duration: got %v want %v", got.DurationSeconds, tt.want.DurationSeconds)
			}
		})
	}
}

func contains(s, substr string) bool {
	for i := 0; i+len(substr) <= len(s); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}

func ptrEq(a, b *float64) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

func ptrIEq(a, b *int) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}
