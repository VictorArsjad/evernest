// Package bottlefeed is the event-store descriptor for bottle feeds. The
// HTTP surface (POST/GET/PATCH/DELETE), authz, idempotent insert and error
// envelope live in internal/eventstore; this package supplies only the
// columns, the validation and the PATCH rules for milk_source / amount_ml.
package bottlefeed

import (
	"log/slog"
	"time"

	"github.com/google/uuid"

	"github.com/varsjad/evernest/apps/api/internal/eventstore"
	"github.com/varsjad/evernest/apps/api/internal/store"
)

type BottleFeed struct {
	ID         uuid.UUID `json:"id"`
	BabyID     uuid.UUID `json:"baby_id"`
	OccurredAt time.Time `json:"occurred_at"`
	MilkSource string    `json:"milk_source"`
	AmountML   float64   `json:"amount_ml"`
	Notes      *string   `json:"notes,omitempty"`
	Source     string    `json:"source"`
	CreatedAt  time.Time `json:"created_at"`
}

type createReq struct {
	ID         *uuid.UUID `json:"id,omitempty"`
	OccurredAt time.Time  `json:"occurred_at" validate:"required"`
	MilkSource string     `json:"milk_source" validate:"required,oneof=breast formula"`
	AmountML   float64    `json:"amount_ml" validate:"required,gt=0,lte=2000"`
	Notes      *string    `json:"notes,omitempty"`
}

// updateReq is the PATCH body (merge-patch): an omitted field is left alone,
// notes clear with null or "". Other fields can't be null.
type updateReq struct {
	OccurredAt *time.Time                  `json:"occurred_at,omitempty"`
	MilkSource *string                     `json:"milk_source,omitempty" validate:"omitempty,oneof=breast formula"`
	AmountML   *float64                    `json:"amount_ml,omitempty" validate:"omitempty,gt=0,lte=2000"`
	Notes      eventstore.Optional[string] `json:"notes"`
}

var spec = eventstore.Spec[BottleFeed]{
	Table:      "bottle_feeds",
	Path:       "bottle-feeds",
	Noun:       "bottle feed",
	TimeCol:    "occurred_at",
	Window:     24 * time.Hour,
	Select:     "id, baby_id, occurred_at, milk_source, amount_ml, notes, source, created_at",
	InsertCols: "occurred_at, milk_source, amount_ml, notes",

	Scan: func(s eventstore.Scanner) (BottleFeed, error) {
		var b BottleFeed
		err := s.Scan(&b.ID, &b.BabyID, &b.OccurredAt, &b.MilkSource, &b.AmountML, &b.Notes, &b.Source, &b.CreatedAt)
		return b, err
	},

	NewCreate: func() eventstore.Create {
		return eventstore.CreateOf(func(req *createReq) (eventstore.Insert, *eventstore.Problem) {
			return eventstore.Insert{
				ID:   req.ID,
				Args: []any{req.OccurredAt, req.MilkSource, req.AmountML, req.Notes},
			}, nil
		})
	},

	NewPatch: func() eventstore.Patch {
		return eventstore.PatchOf(func(req *updateReq) (eventstore.Update, *eventstore.Problem) {
			set := eventstore.NewSet(2).
				Coalesce("occurred_at", req.OccurredAt).
				Coalesce("milk_source", req.MilkSource).
				Coalesce("amount_ml", req.AmountML).
				Text("notes", req.Notes)
			return eventstore.Update{Set: set.SQL(), Args: set.Args()}, nil
		})
	},
}

func NewHandler(st *store.Store, logger *slog.Logger) *eventstore.Handler[BottleFeed] {
	return eventstore.New(spec, st, logger)
}
