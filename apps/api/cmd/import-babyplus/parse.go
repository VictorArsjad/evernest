// Pure parser + mapper for the BabyPlus JSON export. All logic in this file is
// deliberately DB-free so the table-driven tests below can exercise the
// edge cases (unit conversion, oz->ml rounding, "0 means not measured",
// nursing_side derivation) without spinning up a Postgres.
//
// The shapes here mirror the iOS app's export — see the real fixture at
// ~/Downloads/babyplus_data_export.json for ground truth. The sections we
// care about (and the field names they use):
//
//   baby_bottlefeed     -> bottle_feeds
//   baby_nursingfeed    -> nursing_sessions
//   baby_nappy          -> diapers
//   baby_growth         -> growths
//   baby_expressingfeed -> pumpings  (often empty)
//
// Anything else in the export (yearbook, faceADay, tracker_detail, etc.)
// is intentionally ignored: those are auxiliary metadata, not events.
package main

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"time"

	"github.com/google/uuid"
)

// babyplusNamespace is the UUIDv5 namespace under which every imported row's
// id is derived: id = uuid.NewSHA1(namespace, []byte(section+":"+babyplus_pk)).
// Keeping this derivation behind a stable, project-scoped URL keeps the
// namespace value reproducible from source (no opaque magic UUID literal) and
// makes "re-running the importer is a no-op" mechanically provable: same input
// row -> same id forever.
//
// Changing the URL would orphan every row imported under the previous
// namespace, so treat this value as a versioned constant.
var babyplusNamespace = uuid.NewSHA1(uuid.NameSpaceURL, []byte("https://evernest.app/babyplus-import/v1"))

// Section names used as the first component of the idempotency key. They
// double as the human-readable labels in the summary output, so spelling
// changes here are a breaking change to the importer's idempotency contract.
const (
	sectionBottleFeeds      = "bottle_feeds"
	sectionNursingSessions  = "nursing_sessions"
	sectionDiapers          = "diapers"
	sectionGrowths          = "growths"
	sectionPumpings         = "pumpings"
	importSource            = "import_babyplus"
	ozToMLFactor            = 29.5735
	bottleMaxML             = 2000.0
	nursingMaxSeconds       = 21600
	growthMaxWeightG        = 30000.0
	growthMaxHeightCM       = 200.0
	growthMaxHeadCM         = 80.0
	pumpingMaxML            = 2000.0
	pumpingMaxDurationS     = 21600
)

// Export mirrors the top-level shape of the BabyPlus JSON. Every section is
// `omitempty` because real exports occasionally drop empty arrays entirely.
type Export struct {
	BottleFeeds      []RawBottle  `json:"baby_bottlefeed"`
	NursingFeeds     []RawNursing `json:"baby_nursingfeed"`
	Diapers          []RawDiaper  `json:"baby_nappy"`
	Growths          []RawGrowth  `json:"baby_growth"`
	ExpressingFeeds  []RawPumping `json:"baby_expressingfeed"`
}

// RawBottle is one row from baby_bottlefeed. The field name `amountML` is
// authoritative in the iOS app, but we still defensively support `amountOz`
// in case BabyPlus's units toggle ever exposes oz in the export — see
// mapBottle for the conversion path.
type RawBottle struct {
	PK        json.Number `json:"pk"`
	BabyID    json.Number `json:"babyid"`
	Date      float64     `json:"date"`
	AmountML  *float64    `json:"amountML,omitempty"`
	AmountOz  *float64    `json:"amountOz,omitempty"`
	IsFormula int         `json:"isFormula"`
}

type RawNursing struct {
	PK             json.Number `json:"pk"`
	BabyID         json.Number `json:"babyid"`
	StartDate      float64     `json:"startDate"`
	EndDate        float64     `json:"endDate"`
	NursingSide    string      `json:"nursingSide"`
	StartingBreast string      `json:"startingBreast"`
	LeftDuration   int         `json:"leftDuration"`
	RightDuration  int         `json:"rightDuration"`
}

type RawDiaper struct {
	PK      json.Number `json:"pk"`
	BabyID  json.Number `json:"babyid"`
	Date    float64     `json:"date"`
	Type    string      `json:"type"`
	Details string      `json:"details"`
}

// RawGrowth captures the three measurement axes BabyPlus exposes. weight is
// kilograms in the export, height is centimeters, head is centimeters. A
// 0 means "not measured" (the iOS form leaves the others blank).
type RawGrowth struct {
	PK      json.Number `json:"pk"`
	BabyID  json.Number `json:"babyid"`
	Date    float64     `json:"date"`
	Weight  float64     `json:"weight"`
	Height  float64     `json:"height"`
	Head    float64     `json:"head"`
}

// RawPumping mirrors baby_expressingfeed. Field names mirror baby_bottlefeed
// because BabyPlus reuses the same shape; durationSeconds is optional.
type RawPumping struct {
	PK              json.Number `json:"pk"`
	BabyID          json.Number `json:"babyid"`
	Date            float64     `json:"date"`
	AmountML        *float64    `json:"amountML,omitempty"`
	AmountOz        *float64    `json:"amountOz,omitempty"`
	DurationSeconds *int        `json:"durationSeconds,omitempty"`
}

// Canonical shapes — what we actually insert. Decoupling these from the Raw*
// structs keeps the mapper testable in isolation and prevents accidental
// schema drift from BabyPlus's quirks leaking into the API/DB layer.

type BottleFeed struct {
	ID         uuid.UUID
	OccurredAt time.Time
	MilkSource string
	AmountML   float64
}

type NursingSession struct {
	ID             uuid.UUID
	StartedAt      time.Time
	EndedAt        time.Time
	StartingBreast *string
	NursingSide    string
	LeftDurationS  int
	RightDurationS int
}

type Diaper struct {
	ID         uuid.UUID
	OccurredAt time.Time
	Type       string
}

type Growth struct {
	ID                  uuid.UUID
	MeasuredAt          time.Time
	WeightG             *float64
	HeightCM            *float64
	HeadCircumferenceCM *float64
}

type Pumping struct {
	ID              uuid.UUID
	OccurredAt      time.Time
	AmountML        float64
	DurationSeconds *int
}

// LoadExport reads the export JSON from disk and returns the strongly-typed
// shape. Errors propagate verbatim so the CLI can surface "what went wrong
// reading the file" without wrapping noise.
func LoadExport(path string) (*Export, error) {
	f, err := os.Open(path) //nolint:gosec // path comes from --file flag; user-supplied is intentional
	if err != nil {
		return nil, fmt.Errorf("open export: %w", err)
	}
	defer func() { _ = f.Close() }()

	var ex Export
	dec := json.NewDecoder(f)
	dec.UseNumber()
	if err := dec.Decode(&ex); err != nil {
		return nil, fmt.Errorf("decode export: %w", err)
	}
	return &ex, nil
}

// deterministicID derives the row's primary key from the BabyPlus section
// name and the export's primary key. uuid.NewSHA1 produces UUIDv5, which is
// what docs/schema.md promises and what guarantees re-runs are no-ops.
func deterministicID(section, babyplusPK string) uuid.UUID {
	return uuid.NewSHA1(babyplusNamespace, []byte(section+":"+babyplusPK))
}

// bpUnixToUTC converts the export's "seconds since unix epoch (as a float
// with sub-second precision)" to a UTC time.Time. Truncating to the nearest
// second matches the precision the rest of the API stores and avoids the
// fractional-microsecond noise BabyPlus emits.
func bpUnixToUTC(secs float64) time.Time {
	if secs <= 0 {
		return time.Time{}
	}
	whole := int64(math.Floor(secs))
	frac := secs - float64(whole)
	nanos := int64(math.Round(frac * 1e9))
	return time.Unix(whole, nanos).UTC().Truncate(time.Second)
}

// MapBottle converts one raw row to the canonical shape. Returns (nil, nil)
// when the row should be skipped without error — currently never (every
// well-formed bottle row is valid), but kept as the signature so the
// caller-side loop is uniform across sections.
func MapBottle(r RawBottle) (*BottleFeed, error) {
	pk := r.PK.String()
	if pk == "" {
		return nil, fmt.Errorf("missing pk")
	}
	occurred := bpUnixToUTC(r.Date)
	if occurred.IsZero() {
		return nil, fmt.Errorf("invalid date %v", r.Date)
	}
	ml, err := bottleAmountML(r)
	if err != nil {
		return nil, err
	}
	if ml < 0 || ml > bottleMaxML {
		return nil, fmt.Errorf("amount_ml %v out of [0, %v]", ml, bottleMaxML)
	}
	milkSource := "breast"
	if r.IsFormula != 0 {
		milkSource = "formula"
	}
	return &BottleFeed{
		ID:         deterministicID(sectionBottleFeeds, pk),
		OccurredAt: occurred,
		MilkSource: milkSource,
		AmountML:   ml,
	}, nil
}

// bottleAmountML resolves the amount to canonical ml. The export almost
// always uses amountML (verified against the real fixture), but we also
// accept amountOz for forward-compat and convert with the user-rule oz
// factor, rounding to the nearest int ml — int ml is the precision the iOS
// app shows in its UI and avoids the .53/.95 noise of raw float oz→ml.
func bottleAmountML(r RawBottle) (float64, error) {
	switch {
	case r.AmountML != nil:
		return *r.AmountML, nil
	case r.AmountOz != nil:
		return math.Round(*r.AmountOz * ozToMLFactor), nil
	default:
		return 0, fmt.Errorf("missing amountML and amountOz")
	}
}

// MapNursing returns (nil, nil) for the rare malformed row (zero duration
// on every side AND nursingSide unset) so the caller can count it as a
// skip rather than an error.
func MapNursing(r RawNursing) (*NursingSession, error) {
	pk := r.PK.String()
	if pk == "" {
		return nil, fmt.Errorf("missing pk")
	}
	started := bpUnixToUTC(r.StartDate)
	if started.IsZero() {
		return nil, fmt.Errorf("invalid startDate %v", r.StartDate)
	}
	ended := bpUnixToUTC(r.EndDate)
	if ended.IsZero() || ended.Before(started) {
		return nil, fmt.Errorf("invalid endDate %v", r.EndDate)
	}
	if r.LeftDuration < 0 || r.LeftDuration > nursingMaxSeconds {
		return nil, fmt.Errorf("leftDuration %d out of range", r.LeftDuration)
	}
	if r.RightDuration < 0 || r.RightDuration > nursingMaxSeconds {
		return nil, fmt.Errorf("rightDuration %d out of range", r.RightDuration)
	}

	side := deriveNursingSide(r.LeftDuration, r.RightDuration, r.NursingSide)
	if side == "" {
		return nil, nil
	}

	var startingBreast *string
	switch r.StartingBreast {
	case "left", "right":
		v := r.StartingBreast
		startingBreast = &v
	}

	return &NursingSession{
		ID:             deterministicID(sectionNursingSessions, pk),
		StartedAt:      started,
		EndedAt:        ended,
		StartingBreast: startingBreast,
		NursingSide:    side,
		LeftDurationS:  r.LeftDuration,
		RightDurationS: r.RightDuration,
	}, nil
}

// deriveNursingSide trusts the export's explicit nursingSide when it's
// already in the canonical set; otherwise it re-derives from per-side
// durations. Returns "" when neither side has duration AND the export's
// nursingSide is missing/invalid — caller treats that as a skip.
func deriveNursingSide(left, right int, exportSide string) string {
	switch exportSide {
	case "left", "right", "both":
		return exportSide
	}
	switch {
	case left > 0 && right > 0:
		return "both"
	case left > 0:
		return "left"
	case right > 0:
		return "right"
	default:
		return ""
	}
}

// MapDiaper converts a raw row. BabyPlus uses Title-Case enum labels
// ("Wet"/"Soiled"/"Mixed"/"Dirty") which we lower-case to match the
// diapers.type CHECK constraint ('wet'/'soiled'/'mixed'). "Dirty" is
// remapped to "soiled" — the iOS app uses both terms interchangeably for
// the same kind, and "soiled" is what schema.md picked.
func MapDiaper(r RawDiaper) (*Diaper, error) {
	pk := r.PK.String()
	if pk == "" {
		return nil, fmt.Errorf("missing pk")
	}
	occurred := bpUnixToUTC(r.Date)
	if occurred.IsZero() {
		return nil, fmt.Errorf("invalid date %v", r.Date)
	}
	t, err := mapDiaperType(r.Type)
	if err != nil {
		return nil, err
	}
	return &Diaper{
		ID:         deterministicID(sectionDiapers, pk),
		OccurredAt: occurred,
		Type:       t,
	}, nil
}

func mapDiaperType(t string) (string, error) {
	switch t {
	case "Wet", "wet":
		return "wet", nil
	case "Soiled", "soiled", "Dirty", "dirty":
		return "soiled", nil
	case "Mixed", "mixed":
		return "mixed", nil
	default:
		return "", fmt.Errorf("unknown diaper type %q", t)
	}
}

// MapGrowth normalizes the three measurement axes. BabyPlus stores 0 for
// "not measured" on every axis, so we treat 0 as NULL. Returns (nil, nil)
// when every axis is null/zero — the growths table CHECK rejects those
// rows anyway, so skipping is the only safe option.
func MapGrowth(r RawGrowth) (*Growth, error) {
	pk := r.PK.String()
	if pk == "" {
		return nil, fmt.Errorf("missing pk")
	}
	measured := bpUnixToUTC(r.Date)
	if measured.IsZero() {
		return nil, fmt.Errorf("invalid date %v", r.Date)
	}

	g := &Growth{
		ID:         deterministicID(sectionGrowths, pk),
		MeasuredAt: measured,
	}
	// BabyPlus exports weight in kg, head + height in cm. We canonicalize
	// to grams (weight_g) and cm (height_cm, head_circumference_cm).
	if w := r.Weight; w > 0 {
		grams := math.Round(w * 1000)
		if grams > growthMaxWeightG {
			return nil, fmt.Errorf("weight_g %v exceeds %v", grams, growthMaxWeightG)
		}
		g.WeightG = &grams
	}
	if h := r.Height; h > 0 {
		if h > growthMaxHeightCM {
			return nil, fmt.Errorf("height_cm %v exceeds %v", h, growthMaxHeightCM)
		}
		g.HeightCM = &h
	}
	if hd := r.Head; hd > 0 {
		if hd > growthMaxHeadCM {
			return nil, fmt.Errorf("head_circumference_cm %v exceeds %v", hd, growthMaxHeadCM)
		}
		g.HeadCircumferenceCM = &hd
	}
	if g.WeightG == nil && g.HeightCM == nil && g.HeadCircumferenceCM == nil {
		return nil, nil
	}
	return g, nil
}

// MapPumping is the symmetric mate to MapBottle. Pumping rows are often
// missing from BabyPlus exports entirely — that's handled at the caller
// loop level, not here.
func MapPumping(r RawPumping) (*Pumping, error) {
	pk := r.PK.String()
	if pk == "" {
		return nil, fmt.Errorf("missing pk")
	}
	occurred := bpUnixToUTC(r.Date)
	if occurred.IsZero() {
		return nil, fmt.Errorf("invalid date %v", r.Date)
	}
	ml, err := pumpingAmountML(r)
	if err != nil {
		return nil, err
	}
	if ml < 0 || ml > pumpingMaxML {
		return nil, fmt.Errorf("amount_ml %v out of [0, %v]", ml, pumpingMaxML)
	}
	out := &Pumping{
		ID:         deterministicID(sectionPumpings, pk),
		OccurredAt: occurred,
		AmountML:   ml,
	}
	if r.DurationSeconds != nil {
		d := *r.DurationSeconds
		if d < 0 || d > pumpingMaxDurationS {
			return nil, fmt.Errorf("durationSeconds %d out of range", d)
		}
		out.DurationSeconds = &d
	}
	return out, nil
}

func pumpingAmountML(r RawPumping) (float64, error) {
	switch {
	case r.AmountML != nil:
		return *r.AmountML, nil
	case r.AmountOz != nil:
		return math.Round(*r.AmountOz * ozToMLFactor), nil
	default:
		return 0, fmt.Errorf("missing amountML and amountOz")
	}
}
