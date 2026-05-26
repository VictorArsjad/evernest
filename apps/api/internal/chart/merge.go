package chart

import "time"

// dateKey formats a calendar date as YYYY-MM-DD. Used as the merge key into
// the densified slice index — pgx returns a Postgres `date` as time.Time at
// midnight UTC, but only the Y/M/D components are meaningful, so a string
// key is the unambiguous join.
func dateKey(t time.Time) string {
	return t.Format("2006-01-02")
}

// densify returns a Daily slice with one entry per calendar day in
// [from, to] (inclusive) plus a lookup table from date-key to slice index.
// Zero values for sums/counts and nil pointers for growth are correct
// defaults; the per-kind merge functions overwrite/increment from the SQL
// rows.
//
// Pure (no DB access) so callers can unit-test it directly.
func densify(from, to time.Time) ([]Daily, map[string]int) {
	span := int(to.Sub(from).Hours()/24) + 1
	if span <= 0 {
		return []Daily{}, map[string]int{}
	}
	days := make([]Daily, 0, span)
	idx := make(map[string]int, span)
	// Step by calendar day on (from)'s tz so DST transitions don't drift —
	// AddDate operates on Y/M/D and doesn't touch the location.
	for d := from; !d.After(to); d = d.AddDate(0, 0, 1) {
		k := dateKey(d)
		idx[k] = len(days)
		days = append(days, Daily{Date: k})
	}
	return days, idx
}

// buildDays composes the final response shape from the per-kind SQL rows.
// Densifies first (so days outside any rowset still appear with zeros) then
// merges each kind in turn. Kept as a single function (rather than five
// chained mergers) so the test suite can drive end-to-end behavior with one
// call.
func buildDays(
	from, to time.Time,
	bottle []bottleDayRow,
	pumping []pumpingDayRow,
	nursing []nursingDayRow,
	diaper []diaperDayRow,
	growth []growthRow,
) []Daily {
	days, idx := densify(from, to)
	mergeBottle(days, idx, bottle)
	mergePumping(days, idx, pumping)
	mergeNursing(days, idx, nursing)
	mergeDiaper(days, idx, diaper)
	mergeGrowth(days, idx, growth)
	return days
}

func mergeBottle(days []Daily, idx map[string]int, rows []bottleDayRow) {
	for _, r := range rows {
		if i, ok := idx[dateKey(r.Day)]; ok {
			days[i].BottleML += r.AmountML
		}
	}
}

func mergePumping(days []Daily, idx map[string]int, rows []pumpingDayRow) {
	for _, r := range rows {
		if i, ok := idx[dateKey(r.Day)]; ok {
			days[i].PumpingML += r.AmountML
		}
	}
}

// mergeNursing accumulates total nursing minutes per day. SQL returns total
// seconds; we round to the nearest minute here so the rounding is testable
// without spinning up Postgres.
func mergeNursing(days []Daily, idx map[string]int, rows []nursingDayRow) {
	for _, r := range rows {
		if i, ok := idx[dateKey(r.Day)]; ok {
			minutes := int((r.DurationS + 30) / 60)
			days[i].NursingMinutes += minutes
		}
	}
}

func mergeDiaper(days []Daily, idx map[string]int, rows []diaperDayRow) {
	for _, r := range rows {
		i, ok := idx[dateKey(r.Day)]
		if !ok {
			continue
		}
		days[i].DiaperTotal += r.Count
		switch r.Type {
		case "wet":
			days[i].DiaperWet += r.Count
		case "soiled":
			days[i].DiaperSoiled += r.Count
		case "mixed":
			days[i].DiaperMixed += r.Count
		}
	}
}

// mergeGrowth resolves the "latest non-null reading per metric per day" rule.
// Rows arrive in ASC order by measured_at (see queryGrowth), so a simple
// overwrite-on-non-null per metric naturally lands the latest value. We
// don't blindly clone the row because a partial measurement at 5 PM should
// not blank out a complete one at 3 PM.
func mergeGrowth(days []Daily, idx map[string]int, rows []growthRow) {
	for _, r := range rows {
		i, ok := idx[dateKey(r.Day)]
		if !ok {
			continue
		}
		if r.WeightG != nil {
			v := *r.WeightG
			days[i].Growth.WeightG = &v
		}
		if r.HeightCM != nil {
			v := *r.HeightCM
			days[i].Growth.HeightCM = &v
		}
		if r.HeadCM != nil {
			v := *r.HeadCM
			days[i].Growth.HeadCM = &v
		}
	}
}
