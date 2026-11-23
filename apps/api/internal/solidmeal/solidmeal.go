// Package solidmeal is the event-store descriptor for solid-food meals. A
// meal is a sitting: foods[] (required), optional meal-level reaction,
// amount_g, notes and inline photo. The HTTP surface, photo pipeline and
// PATCH conventions live in internal/eventstore.
package solidmeal

import (
	"log/slog"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/varsjad/evernest/apps/api/internal/eventstore"
	"github.com/varsjad/evernest/apps/api/internal/store"
)

var allowedReactions = map[string]struct{}{
	"liked":    {},
	"neutral":  {},
	"refused":  {},
	"reaction": {},
}

type SolidMeal struct {
	ID         uuid.UUID `json:"id"`
	BabyID     uuid.UUID `json:"baby_id"`
	OccurredAt time.Time `json:"occurred_at"`
	Foods      []string  `json:"foods"`
	Reaction   *string   `json:"reaction,omitempty"`
	AmountG    *float64  `json:"amount_g,omitempty"`
	Notes      *string   `json:"notes,omitempty"`
	HasPhoto   bool      `json:"has_photo"`
	PhotoMime  *string   `json:"photo_mime,omitempty"`
	Source     string    `json:"source"`
	CreatedAt  time.Time `json:"created_at"`
}

type createReq struct {
	ID         *uuid.UUID `json:"id,omitempty"`
	OccurredAt time.Time  `json:"occurred_at" validate:"required"`
	Foods      []string   `json:"foods" validate:"required,min=1"`
	Reaction   *string    `json:"reaction,omitempty" validate:"omitempty,oneof=liked neutral refused reaction"`
	AmountG    *float64   `json:"amount_g,omitempty" validate:"omitempty,gte=0,lte=100000"`
	Notes      *string    `json:"notes,omitempty"`
	eventstore.PhotoIn
}

type updateReq struct {
	OccurredAt *time.Time `json:"occurred_at,omitempty"`
	Foods      []string   `json:"foods,omitempty"`
	// Reaction allows "" to clear, so it is checked by hand rather than with
	// a oneof tag.
	Reaction     *string  `json:"reaction,omitempty"`
	AmountG      *float64 `json:"amount_g,omitempty" validate:"omitempty,gte=0,lte=100000"`
	ClearAmountG bool     `json:"clear_amount_g,omitempty"`
	Notes        *string  `json:"notes,omitempty"`
	eventstore.PhotoIn
}

var spec = eventstore.Spec[SolidMeal]{
	Table:      "solid_meals",
	Path:       "solid-meals",
	Noun:       "solid meal",
	TimeCol:    "occurred_at",
	Window:     24 * time.Hour,
	Select:     "id, baby_id, occurred_at, foods, reaction, amount_g, notes, (photo IS NOT NULL) AS has_photo, photo_mime, source, created_at",
	InsertCols: "occurred_at, foods, reaction, amount_g, notes",
	Photo:      true,

	Scan: func(s eventstore.Scanner) (SolidMeal, error) {
		var m SolidMeal
		err := s.Scan(&m.ID, &m.BabyID, &m.OccurredAt, &m.Foods, &m.Reaction,
			&m.AmountG, &m.Notes, &m.HasPhoto, &m.PhotoMime, &m.Source, &m.CreatedAt)
		return m, err
	},

	NewCreate: func() eventstore.Create {
		return eventstore.CreateOf(func(req *createReq) (eventstore.Insert, *eventstore.Problem) {
			foods := normalizeFoods(req.Foods)
			if len(foods) == 0 {
				return eventstore.Insert{}, eventstore.Invalid("foods must contain at least one non-empty item")
			}
			if req.Reaction != nil {
				if _, ok := allowedReactions[*req.Reaction]; !ok {
					return eventstore.Insert{}, eventstore.Invalid("invalid reaction")
				}
			}
			return eventstore.Insert{
				ID:    req.ID,
				Args:  []any{req.OccurredAt, foods, req.Reaction, req.AmountG, req.Notes},
				Photo: &req.PhotoIn,
			}, nil
		})
	},

	NewPatch: func() eventstore.Patch {
		return eventstore.PatchOf(func(req *updateReq) (eventstore.Update, *eventstore.Problem) {
			foodsPresent := req.Foods != nil
			var foods []string
			if foodsPresent {
				foods = normalizeFoods(req.Foods)
				if len(foods) == 0 {
					return eventstore.Update{}, eventstore.Invalid("foods must contain at least one non-empty item")
				}
			}
			// Reaction: omitted → leave; "" → clear; otherwise must be allowed.
			if req.Reaction != nil && *req.Reaction != "" {
				if _, ok := allowedReactions[*req.Reaction]; !ok {
					return eventstore.Update{}, eventstore.Invalid("invalid reaction")
				}
			}
			set := eventstore.NewSet(2).
				Coalesce("occurred_at", req.OccurredAt).
				Optional("foods", "text[]", foodsPresent, foods).
				Text("reaction", req.Reaction).
				Clearable("amount_g", "numeric", req.ClearAmountG, req.AmountG).
				Text("notes", req.Notes)
			return eventstore.Update{Set: set.SQL(), Args: set.Args(), Photo: &req.PhotoIn}, nil
		})
	},
}

func NewHandler(st *store.Store, logger *slog.Logger) *eventstore.Handler[SolidMeal] {
	return eventstore.New(spec, st, logger)
}

func normalizeFoods(in []string) []string {
	out := make([]string, 0, len(in))
	for _, f := range in {
		if trimmed := strings.TrimSpace(f); trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
}
