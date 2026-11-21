// Package sleep is the event-store descriptor for sleep sessions (baby
// asleep/awake). The HTTP surface lives in internal/eventstore.
//
// POST without ended_at starts an open session ("baby just fell asleep"),
// PATCH on an open row closes it with ended_at, and PATCH on a closed row
// edits it; see eventstore.SessionPatch. A baby has at most one open session.
package sleep

import (
	"log/slog"
	"time"

	"github.com/google/uuid"

	"github.com/varsjad/evernest/apps/api/internal/eventstore"
	"github.com/varsjad/evernest/apps/api/internal/store"
)

type Sleep struct {
	ID        uuid.UUID  `json:"id"`
	BabyID    uuid.UUID  `json:"baby_id"`
	StartedAt time.Time  `json:"started_at"`
	EndedAt   *time.Time `json:"ended_at,omitempty"`
	SleepType *string    `json:"sleep_type,omitempty"`
	Location  *string    `json:"location,omitempty"`
	Notes     *string    `json:"notes,omitempty"`
	Source    string     `json:"source"`
	CreatedAt time.Time  `json:"created_at"`
}

type createReq struct {
	ID        *uuid.UUID `json:"id,omitempty"`
	StartedAt time.Time  `json:"started_at" validate:"required"`
	EndedAt   *time.Time `json:"ended_at,omitempty"`
	SleepType *string    `json:"sleep_type,omitempty" validate:"omitempty,oneof=nap night"`
	Location  *string    `json:"location,omitempty" validate:"omitempty,max=100"`
	Notes     *string    `json:"notes,omitempty" validate:"omitempty,max=500"`
}

// endReq closes an open session; a sleep only needs the wake-up time.
type endReq struct {
	EndedAt time.Time `json:"ended_at" validate:"required"`
}

// editReq edits a closed session. Every field is optional; edits cannot
// re-open a session. sleep_type has an explicit clear flag; location and notes
// clear with "".
type editReq struct {
	StartedAt      *time.Time `json:"started_at,omitempty"`
	EndedAt        *time.Time `json:"ended_at,omitempty"`
	SleepType      *string    `json:"sleep_type,omitempty" validate:"omitempty,oneof=nap night"`
	ClearSleepType bool       `json:"clear_sleep_type,omitempty"`
	Location       *string    `json:"location,omitempty" validate:"omitempty,max=100"`
	Notes          *string    `json:"notes,omitempty" validate:"omitempty,max=500"`
}

var session = eventstore.SessionPatch[endReq, editReq]{
	Noun: "sleep session",
	Close: func(req *endReq) (string, []any, time.Time) {
		return `ended_at = $2`, []any{req.EndedAt}, req.EndedAt
	},
	Edit: func(req *editReq) (string, []any, *time.Time, *time.Time) {
		locationPresent, locationValue := eventstore.Text(req.Location)
		notesPresent, notesValue := eventstore.Text(req.Notes)
		return `started_at = COALESCE($2, started_at),
			ended_at   = COALESCE($3, ended_at),
			sleep_type = CASE WHEN $4::boolean THEN NULL
			                  WHEN $5::text IS NOT NULL THEN $5
			                  ELSE sleep_type END,
			location   = CASE WHEN $6::boolean THEN NULLIF($7, '') ELSE location END,
			notes      = CASE WHEN $8::boolean THEN NULLIF($9, '') ELSE notes END`,
			[]any{req.StartedAt, req.EndedAt,
				req.ClearSleepType, req.SleepType,
				locationPresent, locationValue,
				notesPresent, notesValue},
			req.StartedAt, req.EndedAt
	},
}

var spec = eventstore.Spec[Sleep]{
	Table:      "sleeps",
	Path:       "sleeps",
	Noun:       "sleep session",
	TimeCol:    "started_at",
	Window:     24 * time.Hour,
	Select:     "id, baby_id, started_at, ended_at, sleep_type, location, notes, source, created_at",
	InsertCols: "started_at, ended_at, sleep_type, location, notes",
	Open:       true,

	Scan: func(s eventstore.Scanner) (Sleep, error) {
		var x Sleep
		err := s.Scan(&x.ID, &x.BabyID, &x.StartedAt, &x.EndedAt, &x.SleepType, &x.Location,
			&x.Notes, &x.Source, &x.CreatedAt)
		return x, err
	},

	NewCreate: func() eventstore.Create {
		return eventstore.CreateOf(func(req *createReq) (eventstore.Insert, *eventstore.Problem) {
			if req.EndedAt != nil && req.EndedAt.Before(req.StartedAt) {
				return eventstore.Insert{}, eventstore.Invalid("ended_at must be >= started_at")
			}
			return eventstore.Insert{
				ID:   req.ID,
				Args: []any{req.StartedAt, req.EndedAt, req.SleepType, req.Location, req.Notes},
				Open: req.EndedAt == nil,
			}, nil
		})
	},

	NewPatch: session.Patch,
}

func NewHandler(st *store.Store, logger *slog.Logger) *eventstore.Handler[Sleep] {
	return eventstore.New(spec, st, logger)
}
