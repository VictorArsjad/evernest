// Package growth is the event-store descriptor for growth measurements
// (weight / height / head circumference). The HTTP surface lives in
// internal/eventstore.
//
// Growth's quirk vs the other event kinds: every measurement is independently
// optional, but at least one of (weight_g, height_cm, head_circumference_cm)
// MUST be non-NULL and > 0. The DB enforces "at least one non-NULL" via a
// CHECK; the >0 floor is enforced here because BabyPlus stores 0 to mean
// "not measured" and we don't want to silently accept those mistypes.
//
// Canonical units: grams, cm, UTC. The FE converts for display.
package growth

import (
	"log/slog"
	"time"

	"github.com/google/uuid"

	"github.com/varsjad/evernest/apps/api/internal/eventstore"
	"github.com/varsjad/evernest/apps/api/internal/store"
)

type Growth struct {
	ID                  uuid.UUID `json:"id"`
	BabyID              uuid.UUID `json:"baby_id"`
	MeasuredAt          time.Time `json:"measured_at"`
	WeightG             *float64  `json:"weight_g,omitempty"`
	HeightCM            *float64  `json:"height_cm,omitempty"`
	HeadCircumferenceCM *float64  `json:"head_circumference_cm,omitempty"`
	Notes               *string   `json:"notes,omitempty"`
	Source              string    `json:"source"`
	CreatedAt           time.Time `json:"created_at"`
}

// Bounds reject obvious mistypes while accepting any plausible infant/toddler
// reading. Newborns are ~3kg/50cm/35cm head; the upper bound covers a chunky
// toddler with margin.
type createReq struct {
	ID                  *uuid.UUID `json:"id,omitempty"`
	MeasuredAt          time.Time  `json:"measured_at" validate:"required"`
	WeightG             *float64   `json:"weight_g,omitempty" validate:"omitempty,gt=0,lt=30000"`
	HeightCM            *float64   `json:"height_cm,omitempty" validate:"omitempty,gt=0,lt=200"`
	HeadCircumferenceCM *float64   `json:"head_circumference_cm,omitempty" validate:"omitempty,gt=0,lt=80"`
	Notes               *string    `json:"notes,omitempty"`
}

// updateReq is the PATCH body (merge-patch): each measurement and notes clear
// with null (notes also with ""). The "at least one non-NULL" CHECK is
// mirrored in Go on the merged state so the user gets a structured 422
// instead of a 500.
type updateReq struct {
	MeasuredAt          *time.Time                   `json:"measured_at,omitempty"`
	WeightG             eventstore.Optional[float64] `json:"weight_g" check:"gt=0,lt=30000"`
	HeightCM            eventstore.Optional[float64] `json:"height_cm" check:"gt=0,lt=200"`
	HeadCircumferenceCM eventstore.Optional[float64] `json:"head_circumference_cm" check:"gt=0,lt=80"`
	Notes               eventstore.Optional[string]  `json:"notes"`
}

var spec = eventstore.Spec[Growth]{
	Table:      "growths",
	Path:       "growths",
	Noun:       "growth",
	TimeCol:    "measured_at",
	Window:     365 * 24 * time.Hour, // measurements are infrequent
	Select:     "id, baby_id, measured_at, weight_g, height_cm, head_circumference_cm, notes, source, created_at",
	InsertCols: "measured_at, weight_g, height_cm, head_circumference_cm, notes",

	Scan: func(s eventstore.Scanner) (Growth, error) {
		var g Growth
		err := s.Scan(&g.ID, &g.BabyID, &g.MeasuredAt, &g.WeightG, &g.HeightCM,
			&g.HeadCircumferenceCM, &g.Notes, &g.Source, &g.CreatedAt)
		return g, err
	},

	NewCreate: func() eventstore.Create {
		return eventstore.CreateOf(func(req *createReq) (eventstore.Insert, *eventstore.Problem) {
			// The DB has a matching CHECK; enforcing it here gives a
			// structured 422 instead of a generic 500.
			if req.WeightG == nil && req.HeightCM == nil && req.HeadCircumferenceCM == nil {
				return eventstore.Insert{}, eventstore.Invalid(
					"at least one of weight_g, height_cm, head_circumference_cm is required")
			}
			return eventstore.Insert{
				ID:   req.ID,
				Args: []any{req.MeasuredAt, req.WeightG, req.HeightCM, req.HeadCircumferenceCM, req.Notes},
			}, nil
		})
	},

	NewPatch: func() eventstore.Patch {
		var curWeight, curHeight, curHead *float64
		req := new(updateReq)
		return eventstore.Patch{
			State: "weight_g, height_cm, head_circumference_cm",
			Dest:  []any{&curWeight, &curHeight, &curHead},
			Body:  func() eventstore.Body { return eventstore.PlainBody(req) },
			Build: func() (eventstore.Update, *eventstore.Problem) {
				if req.WeightG.Ptr(curWeight) == nil &&
					req.HeightCM.Ptr(curHeight) == nil &&
					req.HeadCircumferenceCM.Ptr(curHead) == nil {
					return eventstore.Update{}, eventstore.Invalid(
						"at least one of weight_g, height_cm, head_circumference_cm must be set")
				}
				// Per measurement: null → NULL; value → replace; absent → keep.
				set := eventstore.NewSet(2).
					Coalesce("measured_at", req.MeasuredAt).
					Nullable("weight_g", "numeric", req.WeightG).
					Nullable("height_cm", "numeric", req.HeightCM).
					Nullable("head_circumference_cm", "numeric", req.HeadCircumferenceCM).
					Text("notes", req.Notes)
				return eventstore.Update{Set: set.SQL(), Args: set.Args()}, nil
			},
		}
	},
}

func NewHandler(st *store.Store, logger *slog.Logger) *eventstore.Handler[Growth] {
	return eventstore.New(spec, st, logger)
}
