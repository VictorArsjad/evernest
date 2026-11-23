// Package nursing is the event-store descriptor for nursing sessions (baby
// fed at the breast). The HTTP surface lives in internal/eventstore.
//
// Open sessions ("start now / end later"): a POST may omit ended_at and both
// per-side durations; the duration columns are NOT NULL DEFAULT 0 so 0/0 is
// stored. Closed-session fields come together or not at all, and a baby has at
// most one open session. PATCH closes an open session (ended_at + both
// durations) or edits a closed one; see eventstore.SessionPatch.
package nursing

import (
	"log/slog"
	"time"

	"github.com/google/uuid"

	"github.com/varsjad/evernest/apps/api/internal/eventstore"
	"github.com/varsjad/evernest/apps/api/internal/store"
)

type Nursing struct {
	ID             uuid.UUID  `json:"id"`
	BabyID         uuid.UUID  `json:"baby_id"`
	StartedAt      time.Time  `json:"started_at"`
	EndedAt        *time.Time `json:"ended_at,omitempty"`
	StartingBreast *string    `json:"starting_breast,omitempty"`
	NursingSide    string     `json:"nursing_side"`
	LeftDurationS  int        `json:"left_duration_s"`
	RightDurationS int        `json:"right_duration_s"`
	Notes          *string    `json:"notes,omitempty"`
	Source         string     `json:"source"`
	CreatedAt      time.Time  `json:"created_at"`
}

// createReq accepts a closed session (started_at, ended_at, both durations,
// nursing_side) or an open one (started_at + nursing_side only). Mixing the
// two is a 422.
type createReq struct {
	ID             *uuid.UUID `json:"id,omitempty"`
	StartedAt      time.Time  `json:"started_at" validate:"required"`
	EndedAt        *time.Time `json:"ended_at,omitempty"`
	StartingBreast *string    `json:"starting_breast,omitempty" validate:"omitempty,oneof=left right"`
	NursingSide    string     `json:"nursing_side" validate:"required,oneof=left right both"`
	LeftDurationS  *int       `json:"left_duration_s,omitempty" validate:"omitempty,gte=0,lte=21600"`
	RightDurationS *int       `json:"right_duration_s,omitempty" validate:"omitempty,gte=0,lte=21600"`
	Notes          *string    `json:"notes,omitempty"`
}

// endReq closes an open session. PATCH is the close transition, so all three
// fields are required.
type endReq struct {
	EndedAt        time.Time `json:"ended_at" validate:"required"`
	LeftDurationS  *int      `json:"left_duration_s" validate:"required,gte=0,lte=21600"`
	RightDurationS *int      `json:"right_duration_s" validate:"required,gte=0,lte=21600"`
}

// editReq edits a closed session. Every field is optional; edits cannot
// re-open a session.
type editReq struct {
	StartedAt      *time.Time                  `json:"started_at,omitempty"`
	EndedAt        *time.Time                  `json:"ended_at,omitempty"`
	StartingBreast eventstore.Optional[string] `json:"starting_breast" check:"oneof=left right"`
	NursingSide    *string                     `json:"nursing_side,omitempty" validate:"omitempty,oneof=left right both"`
	LeftDurationS  *int                        `json:"left_duration_s,omitempty" validate:"omitempty,gte=0,lte=21600"`
	RightDurationS *int                        `json:"right_duration_s,omitempty" validate:"omitempty,gte=0,lte=21600"`
	Notes          eventstore.Optional[string] `json:"notes"`
}

var session = eventstore.SessionPatch[endReq, editReq]{
	Noun: "nursing session",
	Close: func(req *endReq) eventstore.SessionClose {
		return eventstore.SessionClose{
			Set: eventstore.NewSet(2).
				Assign("ended_at", req.EndedAt).
				Assign("left_duration_s", derefInt(req.LeftDurationS)).
				Assign("right_duration_s", derefInt(req.RightDurationS)),
			EndedAt: req.EndedAt,
		}
	},
	Edit: func(req *editReq) eventstore.SessionEdit {
		return eventstore.SessionEdit{
			Set: eventstore.NewSet(2).
				Coalesce("started_at", req.StartedAt).
				Coalesce("ended_at", req.EndedAt).
				Nullable("starting_breast", "text", req.StartingBreast).
				Coalesce("nursing_side", req.NursingSide).
				Coalesce("left_duration_s", req.LeftDurationS).
				Coalesce("right_duration_s", req.RightDurationS).
				Text("notes", req.Notes),
			StartedAt: req.StartedAt,
			EndedAt:   req.EndedAt,
		}
	},
}

func derefInt(p *int) int {
	if p == nil {
		return 0
	}
	return *p
}

var spec = eventstore.Spec[Nursing]{
	Table:      "nursing_sessions",
	Path:       "nursing-sessions",
	Noun:       "nursing session",
	TimeCol:    "started_at",
	Window:     24 * time.Hour,
	Select:     "id, baby_id, started_at, ended_at, starting_breast, nursing_side, left_duration_s, right_duration_s, notes, source, created_at",
	InsertCols: "started_at, ended_at, starting_breast, nursing_side, left_duration_s, right_duration_s, notes",
	Open:       true,

	Scan: func(s eventstore.Scanner) (Nursing, error) {
		var n Nursing
		err := s.Scan(&n.ID, &n.BabyID, &n.StartedAt, &n.EndedAt, &n.StartingBreast, &n.NursingSide,
			&n.LeftDurationS, &n.RightDurationS, &n.Notes, &n.Source, &n.CreatedAt)
		return n, err
	},

	NewCreate: func() eventstore.Create {
		return eventstore.CreateOf(func(req *createReq) (eventstore.Insert, *eventstore.Problem) {
			hasEnd := req.EndedAt != nil
			hasDurations := req.LeftDurationS != nil && req.RightDurationS != nil
			hasAnyDuration := req.LeftDurationS != nil || req.RightDurationS != nil
			switch {
			case hasEnd && !hasDurations:
				return eventstore.Insert{}, eventstore.Invalid("durations required when ended_at is provided")
			case !hasEnd && hasAnyDuration:
				return eventstore.Insert{}, eventstore.Invalid("ended_at is required when durations are provided")
			}
			if hasEnd && req.EndedAt.Before(req.StartedAt) {
				return eventstore.Insert{}, eventstore.Invalid("ended_at must be >= started_at")
			}
			return eventstore.Insert{
				ID: req.ID,
				Args: []any{req.StartedAt, req.EndedAt, req.StartingBreast, req.NursingSide,
					derefInt(req.LeftDurationS), derefInt(req.RightDurationS), req.Notes},
				Open: !hasEnd,
			}, nil
		})
	},

	NewPatch: session.Patch,
}

func NewHandler(st *store.Store, logger *slog.Logger) *eventstore.Handler[Nursing] {
	return eventstore.New(spec, st, logger)
}
