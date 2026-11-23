// Package note is the event-store descriptor for free-text notes: a required
// body plus an optional inline photo. The HTTP surface, photo pipeline and
// PATCH conventions live in internal/eventstore.
//
// The body is NOT NULL, so PATCH can replace it but never clear it; a
// present-but-blank body is a 422.
package note

import (
	"log/slog"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/varsjad/evernest/apps/api/internal/eventstore"
	"github.com/varsjad/evernest/apps/api/internal/store"
)

type Note struct {
	ID         uuid.UUID `json:"id"`
	BabyID     uuid.UUID `json:"baby_id"`
	OccurredAt time.Time `json:"occurred_at"`
	Body       string    `json:"body"`
	HasPhoto   bool      `json:"has_photo"`
	PhotoMime  *string   `json:"photo_mime,omitempty"`
	Source     string    `json:"source"`
	CreatedAt  time.Time `json:"created_at"`
}

type createReq struct {
	ID         *uuid.UUID `json:"id,omitempty"`
	OccurredAt time.Time  `json:"occurred_at" validate:"required"`
	Body       string     `json:"body" validate:"required"`
	eventstore.PhotoIn
}

type updateReq struct {
	OccurredAt *time.Time `json:"occurred_at,omitempty"`
	Body       *string    `json:"body,omitempty"`
	eventstore.PhotoPatch
}

var spec = eventstore.Spec[Note]{
	Table:      "notes",
	Path:       "notes",
	Noun:       "note",
	TimeCol:    "occurred_at",
	Window:     24 * time.Hour,
	Select:     "id, baby_id, occurred_at, body, (photo IS NOT NULL) AS has_photo, photo_mime, source, created_at",
	InsertCols: "occurred_at, body",
	Photo:      true,

	Scan: func(s eventstore.Scanner) (Note, error) {
		var n Note
		err := s.Scan(&n.ID, &n.BabyID, &n.OccurredAt, &n.Body, &n.HasPhoto, &n.PhotoMime, &n.Source, &n.CreatedAt)
		return n, err
	},

	NewCreate: func() eventstore.Create {
		return eventstore.CreateOf(func(req *createReq) (eventstore.Insert, *eventstore.Problem) {
			// A whitespace-only body would slip past `required` but trip the
			// DB CHECK, so trim and guard here.
			body := strings.TrimSpace(req.Body)
			if body == "" {
				return eventstore.Insert{}, eventstore.Invalid("body must not be empty")
			}
			return eventstore.Insert{
				ID:   req.ID,
				Args: []any{req.OccurredAt, body},
			}, nil
		})
	},

	NewPatch: func() eventstore.Patch {
		return eventstore.PatchOf(func(req *updateReq) (eventstore.Update, *eventstore.Problem) {
			bodyPresent := req.Body != nil
			var bodyValue string
			if bodyPresent {
				bodyValue = strings.TrimSpace(*req.Body)
				if bodyValue == "" {
					return eventstore.Update{}, eventstore.Invalid("body must not be empty")
				}
			}
			set := eventstore.NewSet(2).
				Coalesce("occurred_at", req.OccurredAt).
				Optional("body", "", bodyPresent, bodyValue)
			return eventstore.Update{Set: set.SQL(), Args: set.Args()}, nil
		})
	},
}

func NewHandler(st *store.Store, logger *slog.Logger) *eventstore.Handler[Note] {
	return eventstore.New(spec, st, logger)
}
