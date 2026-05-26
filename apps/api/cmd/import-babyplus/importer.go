// DB-facing importer for one BabyPlus export. Each event section is imported
// inside its OWN transaction: a parser error mid-section rolls just that
// section back, but a clean section commits even if a later one fails. We
// could have used one giant tx for the whole import, but the real export is
// ~1000 rows across five sections — wrapping that in a single tx makes the
// run a long-held lock window, and partial-failure recovery is easier when
// the "good" sections are already committed.
package main

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// SectionStats is the per-section running tally surfaced in the summary line.
// inserted counts rows we wrote; skipped counts rows already present (the
// idempotent re-run case); errored counts rows the parser/DB rejected.
type SectionStats struct {
	Section  string
	Inserted int
	Skipped  int
	Errored  int
	Errors   []string
}

// importer wraps the pool + per-run configuration. Keeping it as a small
// struct (rather than passing the pool everywhere) makes the integration
// test stub easier.
type importer struct {
	pool    *pgxpool.Pool
	babyID  uuid.UUID
	userID  *uuid.UUID
	dryRun  bool
	verbose bool
}

func newImporter(pool *pgxpool.Pool, babyID uuid.UUID, userID *uuid.UUID, dryRun, verbose bool) *importer {
	return &importer{pool: pool, babyID: babyID, userID: userID, dryRun: dryRun, verbose: verbose}
}

// importBottleFeeds, importNursingSessions, importDiapers, importGrowths and
// importPumpings all share the same skeleton: map row -> issue idempotent
// insert -> tally outcome. The five copies are deliberate; refactoring to
// reflection/interfaces costs more than it saves at five sites.

func (im *importer) importBottleFeeds(ctx context.Context, rows []RawBottle) (SectionStats, error) {
	stats := SectionStats{Section: sectionBottleFeeds}
	if len(rows) == 0 {
		return stats, nil
	}
	tx, err := im.pool.Begin(ctx)
	if err != nil {
		return stats, fmt.Errorf("begin tx (%s): %w", stats.Section, err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	for _, r := range rows {
		mapped, err := MapBottle(r)
		if err != nil {
			stats.Errored++
			stats.Errors = append(stats.Errors, fmt.Sprintf("pk=%s: %v", r.PK, err))
			continue
		}
		if mapped == nil {
			stats.Skipped++
			continue
		}
		inserted, err := insertBottle(ctx, tx, mapped, im.babyID, im.userID)
		if err != nil {
			stats.Errored++
			stats.Errors = append(stats.Errors, fmt.Sprintf("pk=%s: %v", r.PK, err))
			continue
		}
		if inserted {
			stats.Inserted++
		} else {
			stats.Skipped++
		}
	}
	if im.dryRun {
		return stats, nil
	}
	if err := tx.Commit(ctx); err != nil {
		return stats, fmt.Errorf("commit (%s): %w", stats.Section, err)
	}
	return stats, nil
}

func (im *importer) importNursingSessions(ctx context.Context, rows []RawNursing) (SectionStats, error) {
	stats := SectionStats{Section: sectionNursingSessions}
	if len(rows) == 0 {
		return stats, nil
	}
	tx, err := im.pool.Begin(ctx)
	if err != nil {
		return stats, fmt.Errorf("begin tx (%s): %w", stats.Section, err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	for _, r := range rows {
		mapped, err := MapNursing(r)
		if err != nil {
			stats.Errored++
			stats.Errors = append(stats.Errors, fmt.Sprintf("pk=%s: %v", r.PK, err))
			continue
		}
		if mapped == nil {
			stats.Skipped++
			continue
		}
		inserted, err := insertNursing(ctx, tx, mapped, im.babyID, im.userID)
		if err != nil {
			stats.Errored++
			stats.Errors = append(stats.Errors, fmt.Sprintf("pk=%s: %v", r.PK, err))
			continue
		}
		if inserted {
			stats.Inserted++
		} else {
			stats.Skipped++
		}
	}
	if im.dryRun {
		return stats, nil
	}
	if err := tx.Commit(ctx); err != nil {
		return stats, fmt.Errorf("commit (%s): %w", stats.Section, err)
	}
	return stats, nil
}

func (im *importer) importDiapers(ctx context.Context, rows []RawDiaper) (SectionStats, error) {
	stats := SectionStats{Section: sectionDiapers}
	if len(rows) == 0 {
		return stats, nil
	}
	tx, err := im.pool.Begin(ctx)
	if err != nil {
		return stats, fmt.Errorf("begin tx (%s): %w", stats.Section, err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	for _, r := range rows {
		mapped, err := MapDiaper(r)
		if err != nil {
			stats.Errored++
			stats.Errors = append(stats.Errors, fmt.Sprintf("pk=%s: %v", r.PK, err))
			continue
		}
		if mapped == nil {
			stats.Skipped++
			continue
		}
		inserted, err := insertDiaper(ctx, tx, mapped, im.babyID, im.userID)
		if err != nil {
			stats.Errored++
			stats.Errors = append(stats.Errors, fmt.Sprintf("pk=%s: %v", r.PK, err))
			continue
		}
		if inserted {
			stats.Inserted++
		} else {
			stats.Skipped++
		}
	}
	if im.dryRun {
		return stats, nil
	}
	if err := tx.Commit(ctx); err != nil {
		return stats, fmt.Errorf("commit (%s): %w", stats.Section, err)
	}
	return stats, nil
}

func (im *importer) importGrowths(ctx context.Context, rows []RawGrowth) (SectionStats, error) {
	stats := SectionStats{Section: sectionGrowths}
	if len(rows) == 0 {
		return stats, nil
	}
	tx, err := im.pool.Begin(ctx)
	if err != nil {
		return stats, fmt.Errorf("begin tx (%s): %w", stats.Section, err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	for _, r := range rows {
		mapped, err := MapGrowth(r)
		if err != nil {
			stats.Errored++
			stats.Errors = append(stats.Errors, fmt.Sprintf("pk=%s: %v", r.PK, err))
			continue
		}
		if mapped == nil {
			stats.Skipped++
			continue
		}
		inserted, err := insertGrowth(ctx, tx, mapped, im.babyID, im.userID)
		if err != nil {
			stats.Errored++
			stats.Errors = append(stats.Errors, fmt.Sprintf("pk=%s: %v", r.PK, err))
			continue
		}
		if inserted {
			stats.Inserted++
		} else {
			stats.Skipped++
		}
	}
	if im.dryRun {
		return stats, nil
	}
	if err := tx.Commit(ctx); err != nil {
		return stats, fmt.Errorf("commit (%s): %w", stats.Section, err)
	}
	return stats, nil
}

func (im *importer) importPumpings(ctx context.Context, rows []RawPumping) (SectionStats, error) {
	stats := SectionStats{Section: sectionPumpings}
	if len(rows) == 0 {
		return stats, nil
	}
	tx, err := im.pool.Begin(ctx)
	if err != nil {
		return stats, fmt.Errorf("begin tx (%s): %w", stats.Section, err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	for _, r := range rows {
		mapped, err := MapPumping(r)
		if err != nil {
			stats.Errored++
			stats.Errors = append(stats.Errors, fmt.Sprintf("pk=%s: %v", r.PK, err))
			continue
		}
		if mapped == nil {
			stats.Skipped++
			continue
		}
		inserted, err := insertPumping(ctx, tx, mapped, im.babyID, im.userID)
		if err != nil {
			stats.Errored++
			stats.Errors = append(stats.Errors, fmt.Sprintf("pk=%s: %v", r.PK, err))
			continue
		}
		if inserted {
			stats.Inserted++
		} else {
			stats.Skipped++
		}
	}
	if im.dryRun {
		return stats, nil
	}
	if err := tx.Commit(ctx); err != nil {
		return stats, fmt.Errorf("commit (%s): %w", stats.Section, err)
	}
	return stats, nil
}

// insertBottle / insertNursing / etc. all use the same trick:
//
//   WITH ins AS (INSERT ... ON CONFLICT (id) DO NOTHING RETURNING id)
//   SELECT (SELECT 1 FROM ins) IS NOT NULL  -- true when a row was actually inserted
//
// pgx.ErrNoRows from the bare RETURNING would conflate "row already existed"
// with "scan failure"; the CTE pattern lets us return a clean (inserted bool)
// without losing real errors.

func insertBottle(ctx context.Context, tx pgx.Tx, b *BottleFeed, babyID uuid.UUID, userID *uuid.UUID) (bool, error) {
	var inserted bool
	err := tx.QueryRow(ctx, `
		WITH ins AS (
			INSERT INTO bottle_feeds (id, baby_id, occurred_at, milk_source, amount_ml, source, created_by_user_id)
			VALUES ($1, $2, $3, $4, $5, $6, $7)
			ON CONFLICT (id) DO NOTHING
			RETURNING 1
		)
		SELECT EXISTS (SELECT 1 FROM ins)
	`, b.ID, babyID, b.OccurredAt, b.MilkSource, b.AmountML, importSource, userIDArg(userID)).
		Scan(&inserted)
	if err != nil {
		return false, err
	}
	return inserted, nil
}

func insertNursing(ctx context.Context, tx pgx.Tx, n *NursingSession, babyID uuid.UUID, userID *uuid.UUID) (bool, error) {
	var inserted bool
	err := tx.QueryRow(ctx, `
		WITH ins AS (
			INSERT INTO nursing_sessions (
				id, baby_id, started_at, ended_at, starting_breast, nursing_side,
				left_duration_s, right_duration_s, source, created_by_user_id
			)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
			ON CONFLICT (id) DO NOTHING
			RETURNING 1
		)
		SELECT EXISTS (SELECT 1 FROM ins)
	`, n.ID, babyID, n.StartedAt, n.EndedAt, n.StartingBreast, n.NursingSide,
		n.LeftDurationS, n.RightDurationS, importSource, userIDArg(userID)).
		Scan(&inserted)
	if err != nil {
		return false, err
	}
	return inserted, nil
}

func insertDiaper(ctx context.Context, tx pgx.Tx, d *Diaper, babyID uuid.UUID, userID *uuid.UUID) (bool, error) {
	var inserted bool
	err := tx.QueryRow(ctx, `
		WITH ins AS (
			INSERT INTO diapers (id, baby_id, occurred_at, type, source, created_by_user_id)
			VALUES ($1, $2, $3, $4, $5, $6)
			ON CONFLICT (id) DO NOTHING
			RETURNING 1
		)
		SELECT EXISTS (SELECT 1 FROM ins)
	`, d.ID, babyID, d.OccurredAt, d.Type, importSource, userIDArg(userID)).
		Scan(&inserted)
	if err != nil {
		return false, err
	}
	return inserted, nil
}

func insertGrowth(ctx context.Context, tx pgx.Tx, g *Growth, babyID uuid.UUID, userID *uuid.UUID) (bool, error) {
	var inserted bool
	err := tx.QueryRow(ctx, `
		WITH ins AS (
			INSERT INTO growths (
				id, baby_id, measured_at, weight_g, height_cm, head_circumference_cm,
				source, created_by_user_id
			)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
			ON CONFLICT (id) DO NOTHING
			RETURNING 1
		)
		SELECT EXISTS (SELECT 1 FROM ins)
	`, g.ID, babyID, g.MeasuredAt, g.WeightG, g.HeightCM, g.HeadCircumferenceCM,
		importSource, userIDArg(userID)).
		Scan(&inserted)
	if err != nil {
		return false, err
	}
	return inserted, nil
}

func insertPumping(ctx context.Context, tx pgx.Tx, p *Pumping, babyID uuid.UUID, userID *uuid.UUID) (bool, error) {
	var inserted bool
	err := tx.QueryRow(ctx, `
		WITH ins AS (
			INSERT INTO pumpings (id, baby_id, occurred_at, amount_ml, duration_seconds, source, created_by_user_id)
			VALUES ($1, $2, $3, $4, $5, $6, $7)
			ON CONFLICT (id) DO NOTHING
			RETURNING 1
		)
		SELECT EXISTS (SELECT 1 FROM ins)
	`, p.ID, babyID, p.OccurredAt, p.AmountML, p.DurationSeconds, importSource, userIDArg(userID)).
		Scan(&inserted)
	if err != nil {
		return false, err
	}
	return inserted, nil
}

// userIDArg returns nil for nil so the column receives NULL (created_by_user_id
// is nullable on every event table). The CLI never has an authenticated user
// — the importer runs out-of-band — so passing nil here is the common case.
func userIDArg(u *uuid.UUID) any {
	if u == nil {
		return nil
	}
	return *u
}

// resolveHousehold returns ErrHouseholdNotFound when the household UUID
// doesn't exist. Anything else from the DB is wrapped as a generic error.
func resolveHousehold(ctx context.Context, pool *pgxpool.Pool, id uuid.UUID) error {
	var exists bool
	err := pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM households WHERE id = $1)`, id).Scan(&exists)
	if err != nil {
		return fmt.Errorf("lookup household: %w", err)
	}
	if !exists {
		return ErrHouseholdNotFound
	}
	return nil
}

// resolveBaby finds the baby in the household. If explicitID is uuid.Nil, the
// caller wants the importer to auto-pick the single baby in the household;
// ambiguous (multiple babies) is a hard error so we never silently pick the
// wrong one.
func resolveBaby(ctx context.Context, pool *pgxpool.Pool, householdID, explicitID uuid.UUID) (uuid.UUID, string, error) {
	if explicitID != uuid.Nil {
		var name string
		err := pool.QueryRow(ctx, `
			SELECT name FROM babies WHERE id = $1 AND household_id = $2
		`, explicitID, householdID).Scan(&name)
		if errors.Is(err, pgx.ErrNoRows) {
			return uuid.Nil, "", ErrBabyNotInHousehold
		}
		if err != nil {
			return uuid.Nil, "", fmt.Errorf("lookup baby: %w", err)
		}
		return explicitID, name, nil
	}
	rows, err := pool.Query(ctx, `SELECT id, name FROM babies WHERE household_id = $1 ORDER BY created_at ASC`, householdID)
	if err != nil {
		return uuid.Nil, "", fmt.Errorf("list babies: %w", err)
	}
	defer rows.Close()
	type bb struct {
		id   uuid.UUID
		name string
	}
	var babies []bb
	for rows.Next() {
		var b bb
		if err := rows.Scan(&b.id, &b.name); err != nil {
			return uuid.Nil, "", fmt.Errorf("scan baby: %w", err)
		}
		babies = append(babies, b)
	}
	switch len(babies) {
	case 0:
		return uuid.Nil, "", ErrNoBabiesInHousehold
	case 1:
		return babies[0].id, babies[0].name, nil
	default:
		return uuid.Nil, "", fmt.Errorf("%w: %d babies in household, pass --baby explicitly", ErrAmbiguousBaby, len(babies))
	}
}

var (
	ErrHouseholdNotFound   = errors.New("household not found")
	ErrBabyNotInHousehold  = errors.New("baby not found in household")
	ErrNoBabiesInHousehold = errors.New("household has no babies")
	ErrAmbiguousBaby       = errors.New("multiple babies in household")
)
