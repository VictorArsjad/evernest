// Package eventstore is the one HTTP+SQL module behind every baby event kind
// (bottle feeds, diapers, pumpings, nursing, growths, sleeps, notes, solid
// meals). It owns everything the kinds have in common: baby-membership authz,
// list range/limit parsing, the idempotent insert, item lookup, PATCH
// plumbing, delete, the photo pipeline, the request-body cap and the error
// envelope.
//
// A kind package contributes only a Spec: its table, columns and scan, the
// create/PATCH request structs with their kind-specific rules, and (for
// nursing and sleep) the open-session hooks. It then mounts the resulting
// Handler on the same URLs as before:
//
//	POST/GET  /v1/babies/{babyID}/<Path>
//	GET       /v1/babies/{babyID}/<Path>/open   (Open kinds)
//	PATCH/DELETE /v1/<Path>/{id}
//	GET       /v1/<Path>/{id}/photo             (Photo kinds)
package eventstore

import (
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-playground/validator/v10"
	"github.com/google/uuid"

	"github.com/varsjad/evernest/apps/api/internal/httpx"
	"github.com/varsjad/evernest/apps/api/internal/store"
)

// Scanner is satisfied by both pgx.Row and pgx.Rows.
type Scanner interface {
	Scan(dest ...any) error
}

// Spec describes one event kind.
type Spec[T any] struct {
	Table string // SQL table, e.g. "bottle_feeds"
	Path  string // URL collection segment, e.g. "bottle-feeds"
	Noun  string // human noun used in messages, e.g. "bottle feed"

	// TimeCol is the single timestamp column list filters its from/to window
	// on and orders by.
	TimeCol string
	// Window is how far back list looks when `from` is omitted.
	Window time.Duration

	// Select is the column list (computed columns allowed) in Scan order.
	Select string
	// InsertCols are the kind-specific insert columns. id, baby_id, source and
	// created_by_user_id (and photo/photo_mime for Photo kinds) are implicit.
	InsertCols string

	// Photo enables the inline photo pipeline: the photo/photo_mime columns,
	// the GET .../photo route and photo handling on create and PATCH. The
	// create and PATCH request structs must embed PhotoIn (and non-Photo
	// kinds must not); New panics otherwise.
	Photo bool
	// Open marks start-now/end-later kinds: the table has started_at and
	// ended_at, at most one open row per baby, and a GET .../open route.
	// Only Open kinds may return Insert.Open.
	Open bool

	Scan      func(Scanner) (T, error)
	NewCreate func() Create
	NewPatch  func() Patch
}

// Problem is an HTTP error a kind hook returns.
type Problem struct {
	Status  int
	Code    string
	Message string
}

// Invalid is a 422 validation_failed problem.
func Invalid(msg string) *Problem {
	return &Problem{http.StatusUnprocessableEntity, "validation_failed", msg}
}

// Conflict is a 409 problem with the given code.
func Conflict(code, msg string) *Problem {
	return &Problem{http.StatusConflict, code, msg}
}

func (p *Problem) write(w http.ResponseWriter) {
	httpx.WriteError(w, p.Status, p.Code, p.Message)
}

// PhotoIn is embedded in the create/PATCH request structs of Photo kinds. The
// image is base64 (no data: prefix) with an explicit mime type.
type PhotoIn struct {
	Photo     *string `json:"photo,omitempty"`
	PhotoMime *string `json:"photo_mime,omitempty"`
}

// photoCarrier is satisfied by every request struct that embeds PhotoIn.
type photoCarrier interface{ photoIn() *PhotoIn }

func (p *PhotoIn) photoIn() *PhotoIn { return p }

func carriesPhoto(body any) bool {
	_, ok := body.(photoCarrier)
	return ok
}

// Create is one create request: Body is decoded and struct-validated, then
// Build applies the kind's extra rules.
type Create struct {
	Body  any
	Build func() (Insert, *Problem)
}

// Insert is what a kind returns for a validated create request.
type Insert struct {
	ID   *uuid.UUID // client-supplied id; nil/zero → server generates a v7
	Args []any      // values for Spec.InsertCols, in order
	Open bool       // the new row is an open session (Open kinds only)
}

// CreateOf adapts a typed build func to a Create. The request struct is
// allocated per call.
func CreateOf[R any](build func(req *R) (Insert, *Problem)) Create {
	req := new(R)
	return Create{Body: req, Build: func() (Insert, *Problem) { return build(req) }}
}

// Patch is one PATCH request. State (if set) names extra columns loaded
// with baby_id into Dest before Body is asked for the struct to decode into.
type Patch struct {
	State string
	Dest  []any
	Body  func() any
	Build func() (Update, *Problem)
}

// Update is the UPDATE a kind wants run.
type Update struct {
	// Set is the SET clause; $1 is the row id, kind args start at $2.
	Set  string
	Args []any
	// Where is an extra guard appended after "WHERE id = $1", e.g.
	// "AND ended_at IS NOT NULL".
	Where string
	// NoRows is returned when the guarded UPDATE matched nothing. Nil means
	// an internal error, as for a row deleted mid-flight.
	NoRows *Problem
	// FailMsg overrides the 500 message ("could not update <noun>").
	FailMsg string
}

// PatchOf adapts a typed build func to a Patch with no row state.
func PatchOf[R any](build func(req *R) (Update, *Problem)) Patch {
	req := new(R)
	return Patch{
		Body:  func() any { return req },
		Build: func() (Update, *Problem) { return build(req) },
	}
}

// Handler serves one event kind.
type Handler[T any] struct {
	spec   Spec[T]
	store  *store.Store
	logger *slog.Logger
}

// validate is shared by every handler; validator.Validate is safe for
// concurrent use and caches struct metadata.
var validate = validator.New(validator.WithRequiredStructEnabled())

// New panics when the Spec is internally inconsistent (a programmer error
// caught at startup): Photo disagreeing with the request structs, or Open
// without started_at/ended_at insert columns.
func New[T any](spec Spec[T], st *store.Store, logger *slog.Logger) *Handler[T] {
	if got := carriesPhoto(spec.NewCreate().Body); got != spec.Photo {
		panic("eventstore: " + spec.Table + ": Spec.Photo=" + strconv.FormatBool(spec.Photo) +
			" but create request embeds PhotoIn=" + strconv.FormatBool(got))
	}
	if got := carriesPhoto(spec.NewPatch().Body()); got != spec.Photo {
		panic("eventstore: " + spec.Table + ": Spec.Photo=" + strconv.FormatBool(spec.Photo) +
			" but PATCH request embeds PhotoIn=" + strconv.FormatBool(got))
	}
	if spec.Open && (!strings.Contains(spec.InsertCols, "started_at") || !strings.Contains(spec.InsertCols, "ended_at")) {
		panic("eventstore: " + spec.Table + ": Spec.Open requires started_at and ended_at in InsertCols")
	}
	return &Handler[T]{
		spec:   spec,
		store:  st,
		logger: logger,
	}
}

// BabyRoutes mounts under /v1/babies/{babyID}.
func (h *Handler[T]) BabyRoutes(r chi.Router) {
	r.Post("/"+h.spec.Path, h.create)
	r.Get("/"+h.spec.Path, h.list)
	if h.spec.Open {
		r.Get("/"+h.spec.Path+"/open", h.getOpen)
	}
}

// ItemRoutes mounts under /v1/<Path>/{id}.
func (h *Handler[T]) ItemRoutes(r chi.Router) {
	r.Patch("/", h.patch)
	r.Delete("/", h.delete)
	if h.spec.Photo {
		r.Get("/photo", h.photo)
	}
}
