// Package pumping is the event-store descriptor for pumping sessions (mother
// expressing milk; no baby is "fed", we just track the volume + optional
// duration). The HTTP surface lives in internal/eventstore.
package pumping

import (
	"log/slog"
	"time"

	"github.com/google/uuid"

	"github.com/varsjad/evernest/apps/api/internal/eventstore"
	"github.com/varsjad/evernest/apps/api/internal/store"
)

type Pumping struct {
	ID              uuid.UUID `json:"id"`
	BabyID          uuid.UUID `json:"baby_id"`
	OccurredAt      time.Time `json:"occurred_at"`
	AmountML        float64   `json:"amount_ml"`
	DurationSeconds *int      `json:"duration_seconds,omitempty"`
	Notes           *string   `json:"notes,omitempty"`
	Source          string    `json:"source"`
	CreatedAt       time.Time `json:"created_at"`
}

type createReq struct {
	ID              *uuid.UUID `json:"id,omitempty"`
	OccurredAt      time.Time  `json:"occurred_at" validate:"required"`
	AmountML        float64    `json:"amount_ml" validate:"gte=0,lte=2000"`
	DurationSeconds *int       `json:"duration_seconds,omitempty" validate:"omitempty,gte=0,lte=21600"`
	Notes           *string    `json:"notes,omitempty"`
}

// updateReq is the PATCH body (merge-patch): omitted keeps, null clears
// duration_seconds / notes (notes also clears with ""), occurred_at and
// amount_ml can't be null.
type updateReq struct {
	OccurredAt      *time.Time                  `json:"occurred_at,omitempty"`
	AmountML        *float64                    `json:"amount_ml,omitempty" validate:"omitempty,gte=0,lte=2000"`
	DurationSeconds eventstore.Optional[int]    `json:"duration_seconds" check:"gte=0,lte=21600"`
	Notes           eventstore.Optional[string] `json:"notes"`
}

var spec = eventstore.Spec[Pumping]{
	Table:      "pumpings",
	Path:       "pumpings",
	Noun:       "pumping",
	TimeCol:    "occurred_at",
	Window:     24 * time.Hour,
	Select:     "id, baby_id, occurred_at, amount_ml, duration_seconds, notes, source, created_at",
	InsertCols: "occurred_at, amount_ml, duration_seconds, notes",

	Scan: func(s eventstore.Scanner) (Pumping, error) {
		var p Pumping
		err := s.Scan(&p.ID, &p.BabyID, &p.OccurredAt, &p.AmountML, &p.DurationSeconds, &p.Notes, &p.Source, &p.CreatedAt)
		return p, err
	},

	NewCreate: func() eventstore.Create {
		return eventstore.CreateOf(func(req *createReq) (eventstore.Insert, *eventstore.Problem) {
			return eventstore.Insert{
				ID:   req.ID,
				Args: []any{req.OccurredAt, req.AmountML, req.DurationSeconds, req.Notes},
			}, nil
		})
	},

	NewPatch: func() eventstore.Patch {
		return eventstore.PatchOf(func(req *updateReq) (eventstore.Update, *eventstore.Problem) {
			set := eventstore.NewSet(2).
				Coalesce("occurred_at", req.OccurredAt).
				Coalesce("amount_ml", req.AmountML).
				Nullable("duration_seconds", "integer", req.DurationSeconds).
				Text("notes", req.Notes)
			return eventstore.Update{Set: set.SQL(), Args: set.Args()}, nil
		})
	},
}

func NewHandler(st *store.Store, logger *slog.Logger) *eventstore.Handler[Pumping] {
	return eventstore.New(spec, st, logger)
}
