// import-babyplus is a one-shot CLI that ingests a BabyPlus iOS export JSON
// into the Evernest Postgres. It's idempotent by construction (deterministic
// UUIDv5 per (section, babyplus_pk)) so re-running the same export is a
// no-op — see docs/schema.md and parse.go for the full contract.
//
// Usage:
//
//	make import-babyplus FILE=path/to/export.json HOUSEHOLD=<uuid> [BABY=<uuid>]
//
// or directly:
//
//	DATABASE_URL=... go run ./cmd/import-babyplus \
//	    --file=path --household=uuid [--baby=uuid] [--dry-run] [--verbose]
//
// The CLI is intentionally non-interactive: no prompts, no stdin reads.
// "Hard fail early" is the right posture — partial imports of misconfigured
// runs are worse than no import.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"sort"
	"syscall"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "import-babyplus:", err)
		os.Exit(1)
	}
}

func run() error {
	var (
		fileFlag      = flag.String("file", "", "path to BabyPlus JSON export (required)")
		householdFlag = flag.String("household", "", "household UUID to import into (required)")
		babyFlag      = flag.String("baby", "", "baby UUID inside the household (optional; defaults to the single baby when unambiguous)")
		dryRun        = flag.Bool("dry-run", false, "parse, validate, and roll back every section instead of committing")
		verbose       = flag.Bool("verbose", false, "log every parser/insert error to stderr instead of just the summary")
	)
	flag.Parse()

	if *fileFlag == "" {
		return errors.New("--file is required")
	}
	if *householdFlag == "" {
		return errors.New("--household is required")
	}
	householdID, err := uuid.Parse(*householdFlag)
	if err != nil {
		return fmt.Errorf("--household must be a UUID: %w", err)
	}
	var babyID uuid.UUID
	if *babyFlag != "" {
		babyID, err = uuid.Parse(*babyFlag)
		if err != nil {
			return fmt.Errorf("--baby must be a UUID: %w", err)
		}
	}

	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		return errors.New("DATABASE_URL is required (see .env)")
	}

	export, err := LoadExport(*fileFlag)
	if err != nil {
		return err
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return fmt.Errorf("parse dsn: %w", err)
	}
	// Importer is single-process; a small pool is plenty and keeps the
	// connection footprint predictable when sharing the dev DB with the
	// API server.
	cfg.MaxConns = 4
	cfg.MinConns = 1
	cfg.MaxConnLifetime = time.Hour

	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return fmt.Errorf("connect: %w", err)
	}
	defer pool.Close()

	pingCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := pool.Ping(pingCtx); err != nil {
		return fmt.Errorf("ping: %w", err)
	}

	if err := resolveHousehold(ctx, pool, householdID); err != nil {
		return err
	}
	resolvedBaby, babyName, err := resolveBaby(ctx, pool, householdID, babyID)
	if err != nil {
		return err
	}

	fmt.Printf("import-babyplus: file=%s household=%s baby=%s (%s) dry_run=%t\n",
		*fileFlag, householdID, resolvedBaby, babyName, *dryRun)
	fmt.Printf("export sections: bottle=%d nursing=%d diapers=%d growths=%d pumpings=%d\n",
		len(export.BottleFeeds), len(export.NursingFeeds), len(export.Diapers),
		len(export.Growths), len(export.ExpressingFeeds))
	if len(export.ExpressingFeeds) == 0 {
		fmt.Println("note: no pumping section in export — skipping pumping import")
	}

	im := newImporter(pool, resolvedBaby, nil, *dryRun, *verbose)

	type runner struct {
		name string
		fn   func() (SectionStats, error)
	}
	runners := []runner{
		{sectionBottleFeeds, func() (SectionStats, error) { return im.importBottleFeeds(ctx, export.BottleFeeds) }},
		{sectionNursingSessions, func() (SectionStats, error) { return im.importNursingSessions(ctx, export.NursingFeeds) }},
		{sectionDiapers, func() (SectionStats, error) { return im.importDiapers(ctx, export.Diapers) }},
		{sectionGrowths, func() (SectionStats, error) { return im.importGrowths(ctx, export.Growths) }},
		{sectionPumpings, func() (SectionStats, error) { return im.importPumpings(ctx, export.ExpressingFeeds) }},
	}

	var allStats []SectionStats
	var firstErr error
	for _, r := range runners {
		stats, err := r.fn()
		if err != nil {
			// Per-section fatal (tx begin/commit failed). Record the
			// partial stats so the summary still prints, but keep
			// going so we surface as much info as possible before
			// returning a non-zero exit.
			if firstErr == nil {
				firstErr = err
			}
			fmt.Fprintf(os.Stderr, "section %s failed: %v\n", r.name, err)
		}
		allStats = append(allStats, stats)
	}

	printSummary(allStats, *dryRun, *verbose)

	if firstErr != nil {
		return firstErr
	}
	return nil
}

func printSummary(stats []SectionStats, dryRun, verbose bool) {
	fmt.Println("---")
	if dryRun {
		fmt.Println("DRY RUN — no rows committed")
	}
	// Sort to a stable order (matches the runner order, but explicit is nice
	// to grep through `make import-babyplus | sort`-style usage).
	sort.SliceStable(stats, func(i, j int) bool {
		return sectionOrder(stats[i].Section) < sectionOrder(stats[j].Section)
	})
	for _, s := range stats {
		fmt.Printf("%-18s %d imported, %d skipped (already present), %d errors\n",
			s.Section+":", s.Inserted, s.Skipped, s.Errored)
		if verbose && len(s.Errors) > 0 {
			for _, e := range s.Errors {
				fmt.Fprintln(os.Stderr, "  err:", e)
			}
		}
	}
}

func sectionOrder(s string) int {
	switch s {
	case sectionBottleFeeds:
		return 0
	case sectionNursingSessions:
		return 1
	case sectionDiapers:
		return 2
	case sectionGrowths:
		return 3
	case sectionPumpings:
		return 4
	default:
		return 99
	}
}
