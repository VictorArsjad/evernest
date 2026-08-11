// Package sleep implements CRUD for sleep sessions (baby asleep/awake
// intervals). Mirrors nursing's open-session model: POSTs may omit ended_at
// to start an open session ("baby just fell asleep"), PATCH on an open row
// closes it, and GET /v1/babies/{babyID}/sleeps/open is the cheap "is one
// running?" shortcut for the Today screen. Closed-row PATCHes are partial
// edits. Same UUIDv7 client-id idempotency and baby-membership authz as
// every other event kind — see docs/schema.md.
package sleep

import (
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-playground/validator/v10"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/varsjad/evernest/apps/api/internal/auth"
	"github.com/varsjad/evernest/apps/api/internal/baby"
	"github.com/varsjad/evernest/apps/api/internal/httpx"
	"github.com/varsjad/evernest/apps/api/internal/store"
	"github.com/varsjad/evernest/apps/api/internal/uuidx"
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

type Handler struct {
	store  *store.Store
	logger *slog.Logger
	v      *validator.Validate
}

func NewHandler(st *store.Store, logger *slog.Logger) *Handler {
	return &Handler{store: st, logger: logger, v: validator.New(validator.WithRequiredStructEnabled())}
}

// BabyRoutes mounts under /v1/babies/{babyID}.
func (h *Handler) BabyRoutes(r chi.Router) {
	r.Post("/sleeps", h.create)
	r.Get("/sleeps", h.list)
	// /open MUST be registered before any /{id}-shaped route so chi doesn't
	// try to parse "open" as a UUID. Mounted on the baby scope (not the
	// item scope) because open-ness is per-baby, not per-id.
	r.Get("/sleeps/open", h.getOpen)
}

// ItemRoutes mounts under /v1/sleeps/{id}.
func (h *Handler) ItemRoutes(r chi.Router) {
	// PATCH dispatches based on row state: if ended_at IS NULL we're
	// closing an open session; if ended_at IS NOT NULL we're editing a
	// closed session's fields. See patch().
	r.Patch("/", h.patch)
	r.Delete("/", h.delete)
}

// createReq accepts both shapes: a closed interval (started_at + ended_at)
// or an open session (started_at only, ended_at omitted). Unlike nursing
// there are no duration columns to cross-check, so ended_at's presence
// alone distinguishes the two.
type createReq struct {
	ID        *uuid.UUID `json:"id,omitempty"`
	StartedAt time.Time  `json:"started_at" validate:"required"`
	EndedAt   *time.Time `json:"ended_at,omitempty"`
	SleepType *string    `json:"sleep_type,omitempty" validate:"omitempty,oneof=nap night"`
	Location  *string    `json:"location,omitempty" validate:"omitempty,max=100"`
	Notes     *string    `json:"notes,omitempty" validate:"omitempty,max=500"`
}

func (h *Handler) create(w http.ResponseWriter, r *http.Request) {
	uid := auth.UserIDFrom(r.Context())
	babyID, err := uuid.Parse(chi.URLParam(r, "babyID"))
	if err != nil {
		httpx.WriteError(w, http.StatusBadRequest, "bad_id", "invalid baby id")
		return
	}
	if _, err := baby.MustOwnBaby(r.Context(), h.store, uid, babyID); err != nil {
		writeBabyAuthErr(w, err)
		return
	}

	var req createReq
	if err := httpx.DecodeJSON(r, &req); err != nil {
		httpx.WriteError(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	if err := h.v.Struct(req); err != nil {
		httpx.WriteError(w, http.StatusUnprocessableEntity, "validation_failed", err.Error())
		return
	}
	if req.EndedAt != nil && req.EndedAt.Before(req.StartedAt) {
		httpx.WriteError(w, http.StatusUnprocessableEntity, "validation_failed", "ended_at must be >= started_at")
		return
	}

	var id uuid.UUID
	if req.ID != nil && *req.ID != uuid.Nil {
		id = *req.ID
	} else {
		id = uuidx.NewV7()
	}

	// At most one open session per baby. We check before insert; the
	// idempotent-replay case (same client id) is allowed by excluding the
	// would-be-row's id from the lookup. Same narrow TOCTOU window as
	// nursing — a single user driving the UI is the only realistic caller,
	// and a partial unique index would break outbox replay idempotency.
	if req.EndedAt == nil {
		var existing uuid.UUID
		err := h.store.Pool.QueryRow(r.Context(), `
			SELECT id FROM sleeps
			WHERE baby_id = $1 AND ended_at IS NULL AND id <> $2
			LIMIT 1
		`, babyID, id).Scan(&existing)
		switch {
		case err == nil:
			httpx.WriteError(w, http.StatusConflict, "open_session_exists",
				"a sleep session is already in progress for this baby")
			return
		case errors.Is(err, pgx.ErrNoRows):
			// no open session — proceed
		default:
			h.logger.Error("check open sleep", "err", err)
			httpx.WriteError(w, http.StatusInternalServerError, "internal", "could not check open session")
			return
		}
	}

	// Idempotent insert: identical client id returns the existing row.
	var out Sleep
	err = h.store.Pool.QueryRow(r.Context(), `
		WITH ins AS (
			INSERT INTO sleeps (
				id, baby_id, started_at, ended_at, sleep_type, location, notes,
				source, created_by_user_id
			)
			VALUES ($1, $2, $3, $4, $5, $6, $7, 'manual', $8)
			ON CONFLICT (id) DO NOTHING
			RETURNING id, baby_id, started_at, ended_at, sleep_type, location, notes, source, created_at
		)
		SELECT id, baby_id, started_at, ended_at, sleep_type, location, notes, source, created_at FROM ins
		UNION ALL
		SELECT id, baby_id, started_at, ended_at, sleep_type, location, notes, source, created_at
		FROM sleeps WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM ins)
	`, id, babyID, req.StartedAt, req.EndedAt, req.SleepType, req.Location, req.Notes, uid).
		Scan(&out.ID, &out.BabyID, &out.StartedAt, &out.EndedAt, &out.SleepType, &out.Location,
			&out.Notes, &out.Source, &out.CreatedAt)
	if err != nil {
		h.logger.Error("insert sleep", "err", err)
		httpx.WriteError(w, http.StatusInternalServerError, "internal", "could not create sleep session")
		return
	}
	httpx.WriteJSON(w, http.StatusCreated, out)
}

func (h *Handler) list(w http.ResponseWriter, r *http.Request) {
	uid := auth.UserIDFrom(r.Context())
	babyID, err := uuid.Parse(chi.URLParam(r, "babyID"))
	if err != nil {
		httpx.WriteError(w, http.StatusBadRequest, "bad_id", "invalid baby id")
		return
	}
	if _, err := baby.MustOwnBaby(r.Context(), h.store, uid, babyID); err != nil {
		writeBabyAuthErr(w, err)
		return
	}

	from, to, err := parseRange(r)
	if err != nil {
		httpx.WriteError(w, http.StatusBadRequest, "bad_range", err.Error())
		return
	}
	limit := 200
	if l := r.URL.Query().Get("limit"); l != "" {
		if n, err := strconv.Atoi(l); err == nil && n > 0 && n <= 1000 {
			limit = n
		}
	}

	rows, err := h.store.Pool.Query(r.Context(), `
		SELECT id, baby_id, started_at, ended_at, sleep_type, location, notes, source, created_at
		FROM sleeps
		WHERE baby_id = $1 AND started_at >= $2 AND started_at < $3
		ORDER BY started_at DESC
		LIMIT $4
	`, babyID, from, to, limit)
	if err != nil {
		h.logger.Error("list sleeps", "err", err)
		httpx.WriteError(w, http.StatusInternalServerError, "internal", "list failed")
		return
	}
	defer rows.Close()
	out := make([]Sleep, 0, 32)
	for rows.Next() {
		var s Sleep
		if err := rows.Scan(&s.ID, &s.BabyID, &s.StartedAt, &s.EndedAt, &s.SleepType, &s.Location,
			&s.Notes, &s.Source, &s.CreatedAt); err != nil {
			h.logger.Error("scan sleep", "err", err)
			httpx.WriteError(w, http.StatusInternalServerError, "internal", "scan failed")
			return
		}
		out = append(out, s)
	}
	httpx.WriteJSON(w, http.StatusOK, out)
}

// getOpen returns the most-recent open session for this baby, or 204 if
// none. The Today screen polls this on render so the in-progress tile is
// trivial to derive without scanning the full per-day list.
func (h *Handler) getOpen(w http.ResponseWriter, r *http.Request) {
	uid := auth.UserIDFrom(r.Context())
	babyID, err := uuid.Parse(chi.URLParam(r, "babyID"))
	if err != nil {
		httpx.WriteError(w, http.StatusBadRequest, "bad_id", "invalid baby id")
		return
	}
	if _, err := baby.MustOwnBaby(r.Context(), h.store, uid, babyID); err != nil {
		writeBabyAuthErr(w, err)
		return
	}

	var s Sleep
	err = h.store.Pool.QueryRow(r.Context(), `
		SELECT id, baby_id, started_at, ended_at, sleep_type, location, notes, source, created_at
		FROM sleeps
		WHERE baby_id = $1 AND ended_at IS NULL
		ORDER BY started_at DESC
		LIMIT 1
	`, babyID).Scan(&s.ID, &s.BabyID, &s.StartedAt, &s.EndedAt, &s.SleepType, &s.Location,
		&s.Notes, &s.Source, &s.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if err != nil {
		h.logger.Error("get open sleep", "err", err)
		httpx.WriteError(w, http.StatusInternalServerError, "internal", "lookup failed")
		return
	}
	httpx.WriteJSON(w, http.StatusOK, s)
}

// endReq is the PATCH body for closing an open session. Closing a sleep
// needs only the wake-up time.
type endReq struct {
	EndedAt time.Time `json:"ended_at" validate:"required"`
}

// editReq is the PATCH body for editing a closed session. Every field is
// optional. Sending ended_at = null is not supported (edits can't re-open a
// closed session — that's a state machine transition, not a correction).
// sleep_type uses an explicit clear flag because Go JSON can't distinguish
// absent from null; location/notes follow the bottlefeed "send empty string
// to clear" convention.
type editReq struct {
	StartedAt      *time.Time `json:"started_at,omitempty"`
	EndedAt        *time.Time `json:"ended_at,omitempty"`
	SleepType      *string    `json:"sleep_type,omitempty" validate:"omitempty,oneof=nap night"`
	ClearSleepType bool       `json:"clear_sleep_type,omitempty"`
	Location       *string    `json:"location,omitempty" validate:"omitempty,max=100"`
	Notes          *string    `json:"notes,omitempty" validate:"omitempty,max=500"`
}

// patch dispatches between "close open session" and "edit closed session"
// based on the row's ended_at state. Both paths share the lookup + authz
// preamble.
func (h *Handler) patch(w http.ResponseWriter, r *http.Request) {
	uid := auth.UserIDFrom(r.Context())
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.WriteError(w, http.StatusBadRequest, "bad_id", "invalid id")
		return
	}

	var (
		babyID    uuid.UUID
		startedAt time.Time
		endedAt   *time.Time
	)
	err = h.store.Pool.QueryRow(r.Context(), `
		SELECT baby_id, started_at, ended_at FROM sleeps WHERE id = $1
	`, id).Scan(&babyID, &startedAt, &endedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.WriteError(w, http.StatusNotFound, "not_found", "sleep session not found")
		return
	}
	if err != nil {
		h.logger.Error("lookup sleep for patch", "err", err)
		httpx.WriteError(w, http.StatusInternalServerError, "internal", "lookup failed")
		return
	}
	if _, err := baby.MustOwnBaby(r.Context(), h.store, uid, babyID); err != nil {
		writeBabyAuthErr(w, err)
		return
	}

	if endedAt == nil {
		h.endOpenSession(w, r, id, startedAt)
		return
	}
	h.editClosedSession(w, r, id, startedAt, *endedAt)
}

// endOpenSession closes an open sleep. Body must include ended_at.
func (h *Handler) endOpenSession(w http.ResponseWriter, r *http.Request, id uuid.UUID, startedAt time.Time) {
	var req endReq
	if err := httpx.DecodeJSON(r, &req); err != nil {
		httpx.WriteError(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	if err := h.v.Struct(req); err != nil {
		httpx.WriteError(w, http.StatusUnprocessableEntity, "validation_failed", err.Error())
		return
	}
	if req.EndedAt.Before(startedAt) {
		httpx.WriteError(w, http.StatusUnprocessableEntity, "validation_failed", "ended_at must be >= started_at")
		return
	}

	var out Sleep
	err := h.store.Pool.QueryRow(r.Context(), `
		UPDATE sleeps
		SET ended_at = $2
		WHERE id = $1 AND ended_at IS NULL
		RETURNING id, baby_id, started_at, ended_at, sleep_type, location, notes, source, created_at
	`, id, req.EndedAt).
		Scan(&out.ID, &out.BabyID, &out.StartedAt, &out.EndedAt, &out.SleepType, &out.Location,
			&out.Notes, &out.Source, &out.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		// Lost the race: someone closed the row between our lookup and
		// our UPDATE. Surface the same 409 the up-front check would have.
		httpx.WriteError(w, http.StatusConflict, "already_closed",
			"sleep session is already closed")
		return
	}
	if err != nil {
		h.logger.Error("update sleep (close)", "err", err)
		httpx.WriteError(w, http.StatusInternalServerError, "internal", "could not close sleep session")
		return
	}
	httpx.WriteJSON(w, http.StatusOK, out)
}

// editClosedSession handles partial edits to an already-closed sleep row.
// Guarded by `WHERE ended_at IS NOT NULL` so a concurrent close can't sneak
// the row back into the open path mid-edit.
func (h *Handler) editClosedSession(w http.ResponseWriter, r *http.Request, id uuid.UUID, startedAt, endedAt time.Time) {
	var req editReq
	if err := httpx.DecodeJSON(r, &req); err != nil {
		httpx.WriteError(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	if err := h.v.Struct(req); err != nil {
		httpx.WriteError(w, http.StatusUnprocessableEntity, "validation_failed", err.Error())
		return
	}

	// Validate the merged started_at/ended_at pair up front. Either field
	// may be omitted, so substitute the stored value for the missing side.
	effectiveStart := startedAt
	if req.StartedAt != nil {
		effectiveStart = *req.StartedAt
	}
	effectiveEnd := endedAt
	if req.EndedAt != nil {
		effectiveEnd = *req.EndedAt
	}
	if effectiveEnd.Before(effectiveStart) {
		httpx.WriteError(w, http.StatusUnprocessableEntity, "validation_failed",
			"ended_at must be >= started_at")
		return
	}

	locationPresent := req.Location != nil
	var locationValue string
	if locationPresent {
		locationValue = *req.Location
	}
	notesPresent := req.Notes != nil
	var notesValue string
	if notesPresent {
		notesValue = *req.Notes
	}

	var out Sleep
	err := h.store.Pool.QueryRow(r.Context(), `
		UPDATE sleeps SET
			started_at = COALESCE($2, started_at),
			ended_at   = COALESCE($3, ended_at),
			sleep_type = CASE WHEN $4::boolean THEN NULL
			                  WHEN $5::text IS NOT NULL THEN $5
			                  ELSE sleep_type END,
			location   = CASE WHEN $6::boolean THEN NULLIF($7, '') ELSE location END,
			notes      = CASE WHEN $8::boolean THEN NULLIF($9, '') ELSE notes END
		WHERE id = $1 AND ended_at IS NOT NULL
		RETURNING id, baby_id, started_at, ended_at, sleep_type, location, notes, source, created_at
	`, id, req.StartedAt, req.EndedAt,
		req.ClearSleepType, req.SleepType,
		locationPresent, locationValue,
		notesPresent, notesValue).
		Scan(&out.ID, &out.BabyID, &out.StartedAt, &out.EndedAt, &out.SleepType, &out.Location,
			&out.Notes, &out.Source, &out.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		// Either the row vanished mid-flight or a concurrent close/reopen
		// flipped ended_at between our lookup and our UPDATE.
		httpx.WriteError(w, http.StatusConflict, "session_state_changed",
			"sleep session state changed; refetch and retry")
		return
	}
	if err != nil {
		h.logger.Error("update sleep (edit)", "err", err)
		httpx.WriteError(w, http.StatusInternalServerError, "internal", "could not update sleep session")
		return
	}
	httpx.WriteJSON(w, http.StatusOK, out)
}

func (h *Handler) delete(w http.ResponseWriter, r *http.Request) {
	uid := auth.UserIDFrom(r.Context())
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.WriteError(w, http.StatusBadRequest, "bad_id", "invalid id")
		return
	}
	var babyID uuid.UUID
	err = h.store.Pool.QueryRow(r.Context(), `SELECT baby_id FROM sleeps WHERE id = $1`, id).Scan(&babyID)
	if errors.Is(err, pgx.ErrNoRows) {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if err != nil {
		h.logger.Error("lookup sleep", "err", err)
		httpx.WriteError(w, http.StatusInternalServerError, "internal", "lookup failed")
		return
	}
	if _, err := baby.MustOwnBaby(r.Context(), h.store, uid, babyID); err != nil {
		writeBabyAuthErr(w, err)
		return
	}
	_, err = h.store.Pool.Exec(r.Context(), `DELETE FROM sleeps WHERE id = $1`, id)
	if err != nil {
		h.logger.Error("delete sleep", "err", err)
		httpx.WriteError(w, http.StatusInternalServerError, "internal", "delete failed")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func parseRange(r *http.Request) (time.Time, time.Time, error) {
	q := r.URL.Query()
	now := time.Now().UTC()
	from := now.Add(-24 * time.Hour)
	to := now.Add(24 * time.Hour)
	if s := q.Get("from"); s != "" {
		t, err := time.Parse(time.RFC3339, s)
		if err != nil {
			return time.Time{}, time.Time{}, errors.New("from must be RFC3339")
		}
		from = t
	}
	if s := q.Get("to"); s != "" {
		t, err := time.Parse(time.RFC3339, s)
		if err != nil {
			return time.Time{}, time.Time{}, errors.New("to must be RFC3339")
		}
		to = t
	}
	if !from.Before(to) {
		return time.Time{}, time.Time{}, errors.New("from must be before to")
	}
	return from, to, nil
}

func writeBabyAuthErr(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, baby.ErrNotFound):
		httpx.WriteError(w, http.StatusNotFound, "not_found", "baby not found")
	case errors.Is(err, baby.ErrUnauthorized):
		httpx.WriteError(w, http.StatusForbidden, "forbidden", "not a member of this household")
	default:
		httpx.WriteError(w, http.StatusInternalServerError, "internal", err.Error())
	}
}
