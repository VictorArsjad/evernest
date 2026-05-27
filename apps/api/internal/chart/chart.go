// Package chart serves cross-event aggregations for the FE Charts screen.
// Unlike the per-kind packages (bottlefeed/diaper/...), chart is read-only —
// it never mutates state, just rolls existing event rows up into per-day
// buckets that the FE can render as sparklines / bar charts.
//
// The unified endpoint (rather than five per-kind ones) is intentional: the
// Charts screen overlays multiple metrics on a shared X axis, so the FE wants
// one densified response with a row per calendar day in the chosen timezone.
// Five separate queries (one per kind) is fine for a personal-scale dataset;
// see merge.go for the pure aggregation helpers that get unit-tested.
package chart

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/varsjad/evernest/apps/api/internal/auth"
	"github.com/varsjad/evernest/apps/api/internal/baby"
	"github.com/varsjad/evernest/apps/api/internal/httpx"
	"github.com/varsjad/evernest/apps/api/internal/store"
)

// MaxWindowDays caps how wide a single Charts request can be. The FE only
// renders 7/14/30 day windows today, but we leave headroom for a future
// "last 3 months" preset. Anything beyond that should paginate.
const MaxWindowDays = 90

type Handler struct {
	store  *store.Store
	logger *slog.Logger
}

func NewHandler(st *store.Store, logger *slog.Logger) *Handler {
	return &Handler{store: st, logger: logger}
}

// BabyRoutes mounts under /v1/babies/{babyID}.
func (h *Handler) BabyRoutes(r chi.Router) {
	r.Get("/charts/daily", h.daily)
}

// DailyResponse is the JSON envelope returned to the FE: one row per calendar
// day in the requested timezone, densified so the FE never has to fill gaps.
type DailyResponse struct {
	Days []Daily `json:"days"`
}

// Daily holds aggregated stats for a single calendar day in the requested
// timezone. All count/sum fields default to zero; growth fields are nullable
// pointers because "no measurement that day" is materially different from
// "0 grams" and the FE renders the difference (broken line vs zero baseline).
type Daily struct {
	Date string `json:"date"`
	// BottleML is the combined per-day total across all milk sources. Kept
	// for the summary tile and old-FE compatibility; the per-source fields
	// below split it into breast vs formula so the bottle chart can render
	// a 2-segment stacked bar.
	BottleML        float64        `json:"bottle_ml"`
	BottleMLBreast  float64        `json:"bottle_ml_breast"`
	BottleMLFormula float64        `json:"bottle_ml_formula"`
	NursingMinutes  int            `json:"nursing_minutes"`
	PumpingML       float64        `json:"pumping_ml"`
	DiaperTotal     int            `json:"diaper_total"`
	DiaperWet       int            `json:"diaper_wet"`
	DiaperSoiled    int            `json:"diaper_soiled"`
	DiaperMixed     int            `json:"diaper_mixed"`
	Growth          GrowthSnapshot `json:"growth"`
}

// GrowthSnapshot carries the latest non-null reading for each metric on a
// given day. Each field is independently nullable because a single row in
// the `growths` table can record only weight (or only head circumference),
// and we don't want a partial measurement to mask a fuller earlier one in
// the same day.
type GrowthSnapshot struct {
	WeightG  *float64 `json:"weight_g"`
	HeightCM *float64 `json:"height_cm"`
	HeadCM   *float64 `json:"head_cm"`
}

func (h *Handler) daily(w http.ResponseWriter, r *http.Request) {
	uid := auth.UserIDFrom(r.Context())
	babyID, err := uuid.Parse(chi.URLParam(r, "babyID"))
	if err != nil {
		httpx.WriteError(w, http.StatusBadRequest, "bad_id", "invalid baby id")
		return
	}
	if _, err := baby.MustOwnBaby(r.Context(), h.store, uid, babyID); err != nil {
		writeBabyAuthErr(w, err)
		return
	}

	from, to, loc, err := parseDailyParams(r.URL.Query())
	if err != nil {
		httpx.WriteError(w, http.StatusUnprocessableEntity, "validation_failed", err.Error())
		return
	}

	// Bucket bounds in UTC. `from` is midnight (local) on the first day;
	// `toExclusive` is midnight (local) on the day after `to`. We compare on
	// the original timestamptz columns in UTC and let Postgres do the
	// `AT TIME ZONE` conversion only for bucketing.
	fromUTC := time.Date(from.Year(), from.Month(), from.Day(), 0, 0, 0, 0, loc).UTC()
	toExclusiveUTC := time.Date(to.Year(), to.Month(), to.Day(), 0, 0, 0, 0, loc).AddDate(0, 0, 1).UTC()
	tzName := loc.String()

	bottleRows, err := h.queryBottle(r.Context(), babyID, fromUTC, toExclusiveUTC, tzName)
	if err != nil {
		h.logger.Error("chart bottle query", "err", err)
		httpx.WriteError(w, http.StatusInternalServerError, "internal", "bottle aggregation failed")
		return
	}
	pumpingRows, err := h.queryPumping(r.Context(), babyID, fromUTC, toExclusiveUTC, tzName)
	if err != nil {
		h.logger.Error("chart pumping query", "err", err)
		httpx.WriteError(w, http.StatusInternalServerError, "internal", "pumping aggregation failed")
		return
	}
	nursingRows, err := h.queryNursing(r.Context(), babyID, fromUTC, toExclusiveUTC, tzName)
	if err != nil {
		h.logger.Error("chart nursing query", "err", err)
		httpx.WriteError(w, http.StatusInternalServerError, "internal", "nursing aggregation failed")
		return
	}
	diaperRows, err := h.queryDiaper(r.Context(), babyID, fromUTC, toExclusiveUTC, tzName)
	if err != nil {
		h.logger.Error("chart diaper query", "err", err)
		httpx.WriteError(w, http.StatusInternalServerError, "internal", "diaper aggregation failed")
		return
	}
	growthRows, err := h.queryGrowth(r.Context(), babyID, fromUTC, toExclusiveUTC, tzName)
	if err != nil {
		h.logger.Error("chart growth query", "err", err)
		httpx.WriteError(w, http.StatusInternalServerError, "internal", "growth aggregation failed")
		return
	}

	days := buildDays(from, to, bottleRows, pumpingRows, nursingRows, diaperRows, growthRows)
	httpx.WriteJSON(w, http.StatusOK, DailyResponse{Days: days})
}

// parseDailyParams pulls (from, to, tz) out of the query string and applies
// the validation rules: both dates required, to >= from, window <= 90 days,
// tz must resolve via time.LoadLocation (default UTC).
//
// Returns calendar dates (year/month/day only) at midnight in the resolved
// location. The caller is responsible for converting those into UTC bounds
// for the SQL queries.
func parseDailyParams(q map[string][]string) (from, to time.Time, loc *time.Location, err error) {
	get := func(k string) string {
		if v, ok := q[k]; ok && len(v) > 0 {
			return v[0]
		}
		return ""
	}
	fromStr := get("from")
	toStr := get("to")
	tzStr := get("tz")

	if fromStr == "" || toStr == "" {
		return time.Time{}, time.Time{}, nil, errors.New("from and to are required (YYYY-MM-DD)")
	}
	if tzStr == "" {
		tzStr = "UTC"
	}
	loc, locErr := time.LoadLocation(tzStr)
	if locErr != nil {
		return time.Time{}, time.Time{}, nil, fmt.Errorf("invalid tz %q: must be IANA timezone name", tzStr)
	}
	fromDay, parseErr := time.ParseInLocation("2006-01-02", fromStr, loc)
	if parseErr != nil {
		return time.Time{}, time.Time{}, nil, errors.New("from must be YYYY-MM-DD")
	}
	toDay, parseErr := time.ParseInLocation("2006-01-02", toStr, loc)
	if parseErr != nil {
		return time.Time{}, time.Time{}, nil, errors.New("to must be YYYY-MM-DD")
	}
	if toDay.Before(fromDay) {
		return time.Time{}, time.Time{}, nil, errors.New("to must be >= from")
	}
	// Inclusive window: (to - from) days + 1 entries. Reject >90 days.
	span := int(toDay.Sub(fromDay).Hours()/24) + 1
	if span > MaxWindowDays {
		return time.Time{}, time.Time{}, nil, fmt.Errorf("window must be <= %d days (got %d)", MaxWindowDays, span)
	}
	return fromDay, toDay, loc, nil
}

func writeBabyAuthErr(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, baby.ErrNotFound):
		httpx.WriteError(w, http.StatusNotFound, "not_found", "baby not found")
	case errors.Is(err, baby.ErrUnauthorized):
		httpx.WriteError(w, http.StatusForbidden, "forbidden", "not a member of this household")
	default:
		httpx.WriteError(w, http.StatusInternalServerError, "internal", err.Error())
	}
}

// --- SQL queries ---
//
// All five queries follow the same shape:
//   - filter on the indexed `(baby_id, <timestamp>)` composite
//   - bucket on `date_trunc('day', <ts> AT TIME ZONE $tz)` and cast to `date`
//   - aggregate per bucket
//
// We pass the timezone name as a parameter so Postgres handles DST / IANA
// conversion canonically rather than trying to reimplement that in Go.

// Row types are the wire format between the SQL scan loop and the pure
// buildDays merger. They live here (rather than in merge.go) because their
// shape is dictated by the SQL select list.

type bottleDayRow struct {
	Day        time.Time
	MilkSource string
	AmountML   float64
}

type pumpingDayRow struct {
	Day      time.Time
	AmountML float64
}

type nursingDayRow struct {
	Day       time.Time
	DurationS int64
}

type diaperDayRow struct {
	Day   time.Time
	Type  string
	Count int
}

// growthRow is per-row, not per-day: we resolve "latest non-null reading"
// for each metric in Go (see mergeGrowth) so partial measurements don't
// mask earlier complete ones.
type growthRow struct {
	Day        time.Time
	MeasuredAt time.Time
	WeightG    *float64
	HeightCM   *float64
	HeadCM     *float64
}

func (h *Handler) queryBottle(ctx context.Context, babyID uuid.UUID, fromUTC, toUTC time.Time, tz string) ([]bottleDayRow, error) {
	// One row per (day, milk_source) so the FE can render a 2-segment
	// stacked bar (breast vs formula). mergeBottle still sums both into
	// the combined BottleML total for the summary tile.
	rows, err := h.store.Pool.Query(ctx, `
		SELECT (date_trunc('day', occurred_at AT TIME ZONE $1))::date AS day,
		       milk_source,
		       COALESCE(SUM(amount_ml), 0)::float8
		FROM bottle_feeds
		WHERE baby_id = $2 AND occurred_at >= $3 AND occurred_at < $4
		GROUP BY 1, 2
	`, tz, babyID, fromUTC, toUTC)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []bottleDayRow
	for rows.Next() {
		var r bottleDayRow
		if err := rows.Scan(&r.Day, &r.MilkSource, &r.AmountML); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func (h *Handler) queryPumping(ctx context.Context, babyID uuid.UUID, fromUTC, toUTC time.Time, tz string) ([]pumpingDayRow, error) {
	rows, err := h.store.Pool.Query(ctx, `
		SELECT (date_trunc('day', occurred_at AT TIME ZONE $1))::date AS day,
		       COALESCE(SUM(amount_ml), 0)::float8
		FROM pumpings
		WHERE baby_id = $2 AND occurred_at >= $3 AND occurred_at < $4
		GROUP BY 1
	`, tz, babyID, fromUTC, toUTC)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []pumpingDayRow
	for rows.Next() {
		var r pumpingDayRow
		if err := rows.Scan(&r.Day, &r.AmountML); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func (h *Handler) queryNursing(ctx context.Context, babyID uuid.UUID, fromUTC, toUTC time.Time, tz string) ([]nursingDayRow, error) {
	// Nursing rows model an interval, so the bucket key is `started_at`
	// (matches the recent-list helper on the FE). We sum left+right
	// duration so the bucket value is total seconds nursing in that day;
	// minutes conversion happens in buildDays so the rounding is testable.
	rows, err := h.store.Pool.Query(ctx, `
		SELECT (date_trunc('day', started_at AT TIME ZONE $1))::date AS day,
		       COALESCE(SUM(left_duration_s + right_duration_s), 0)::bigint
		FROM nursing_sessions
		WHERE baby_id = $2 AND started_at >= $3 AND started_at < $4
		GROUP BY 1
	`, tz, babyID, fromUTC, toUTC)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []nursingDayRow
	for rows.Next() {
		var r nursingDayRow
		if err := rows.Scan(&r.Day, &r.DurationS); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func (h *Handler) queryDiaper(ctx context.Context, babyID uuid.UUID, fromUTC, toUTC time.Time, tz string) ([]diaperDayRow, error) {
	// One row per (day, type) so we can populate the stacked-bar breakdown
	// (wet/soiled/mixed) on the FE without re-running the query per type.
	rows, err := h.store.Pool.Query(ctx, `
		SELECT (date_trunc('day', occurred_at AT TIME ZONE $1))::date AS day,
		       type,
		       COUNT(*)::int
		FROM diapers
		WHERE baby_id = $2 AND occurred_at >= $3 AND occurred_at < $4
		GROUP BY 1, 2
	`, tz, babyID, fromUTC, toUTC)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []diaperDayRow
	for rows.Next() {
		var r diaperDayRow
		if err := rows.Scan(&r.Day, &r.Type, &r.Count); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func (h *Handler) queryGrowth(ctx context.Context, babyID uuid.UUID, fromUTC, toUTC time.Time, tz string) ([]growthRow, error) {
	// Growth is sparse and per-metric independently nullable, so we don't
	// aggregate in SQL — we just return the raw rows and resolve "latest
	// non-null per metric per day" in Go. ORDER BY measured_at ASC so the
	// resolver can do a single pass updating the snapshot as later rows
	// arrive.
	rows, err := h.store.Pool.Query(ctx, `
		SELECT (date_trunc('day', measured_at AT TIME ZONE $1))::date AS day,
		       measured_at,
		       weight_g::float8,
		       height_cm::float8,
		       head_circumference_cm::float8
		FROM growths
		WHERE baby_id = $2 AND measured_at >= $3 AND measured_at < $4
		ORDER BY measured_at ASC
	`, tz, babyID, fromUTC, toUTC)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []growthRow
	for rows.Next() {
		var r growthRow
		if err := rows.Scan(&r.Day, &r.MeasuredAt, &r.WeightG, &r.HeightCM, &r.HeadCM); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}
