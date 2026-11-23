// Package diaper is the event-store descriptor for diaper changes: an enum
// (wet/soiled/mixed), optional notes and an optional inline photo. The HTTP
// surface, photo pipeline and PATCH conventions live in internal/eventstore.
package diaper

import (
	"log/slog"
	"time"

	"github.com/google/uuid"

	"github.com/varsjad/evernest/apps/api/internal/eventstore"
	"github.com/varsjad/evernest/apps/api/internal/store"
)

type Diaper struct {
	ID         uuid.UUID `json:"id"`
	BabyID     uuid.UUID `json:"baby_id"`
	OccurredAt time.Time `json:"occurred_at"`
	Type       string    `json:"type"`
	Notes      *string   `json:"notes,omitempty"`
	HasPhoto   bool      `json:"has_photo"`
	PhotoMime  *string   `json:"photo_mime,omitempty"`
	Source     string    `json:"source"`
	CreatedAt  time.Time `json:"created_at"`
}

type createReq struct {
	ID         *uuid.UUID `json:"id,omitempty"`
	OccurredAt time.Time  `json:"occurred_at" validate:"required"`
	Type       string     `json:"type" validate:"required,oneof=wet soiled mixed"`
	Notes      *string    `json:"notes,omitempty"`
	eventstore.PhotoIn
}

type updateReq struct {
	OccurredAt *time.Time `json:"occurred_at,omitempty"`
	Type       *string    `json:"type,omitempty" validate:"omitempty,oneof=wet soiled mixed"`
	Notes      *string    `json:"notes,omitempty"`
	eventstore.PhotoIn
}

var spec = eventstore.Spec[Diaper]{
	Table:      "diapers",
	Path:       "diapers",
	Noun:       "diaper",
	TimeCol:    "occurred_at",
	Window:     24 * time.Hour,
	Select:     "id, baby_id, occurred_at, type, notes, (photo IS NOT NULL) AS has_photo, photo_mime, source, created_at",
	InsertCols: "occurred_at, type, notes",
	Photo:      true,

	Scan: func(s eventstore.Scanner) (Diaper, error) {
		var d Diaper
		err := s.Scan(&d.ID, &d.BabyID, &d.OccurredAt, &d.Type, &d.Notes, &d.HasPhoto, &d.PhotoMime, &d.Source, &d.CreatedAt)
		return d, err
	},

	NewCreate: func() eventstore.Create {
		return eventstore.CreateOf(func(req *createReq) (eventstore.Insert, *eventstore.Problem) {
			return eventstore.Insert{
				ID:    req.ID,
				Args:  []any{req.OccurredAt, req.Type, req.Notes},
				Photo: &req.PhotoIn,
			}, nil
		})
	},

	NewPatch: func() eventstore.Patch {
		return eventstore.PatchOf(func(req *updateReq) (eventstore.Update, *eventstore.Problem) {
			set := eventstore.NewSet(2).
				Coalesce("occurred_at", req.OccurredAt).
				Coalesce("type", req.Type).
				Text("notes", req.Notes)
			return eventstore.Update{Set: set.SQL(), Args: set.Args(), Photo: &req.PhotoIn}, nil
		})
	},
}

func NewHandler(st *store.Store, logger *slog.Logger) *eventstore.Handler[Diaper] {
	return eventstore.New(spec, st, logger)
}
