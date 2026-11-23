package eventstore

import (
	"bytes"
	"errors"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/varsjad/evernest/apps/api/internal/auth"
	"github.com/varsjad/evernest/apps/api/internal/baby"
	"github.com/varsjad/evernest/apps/api/internal/httpx"
)

const (
	defaultLimit = 200
	maxLimit     = 1000

	// maxBodyBytes leaves headroom for the JSON envelope and the ~33% base64
	// inflation of a maxPhotoBytes image, so an oversized request is rejected
	// with 413 before the worst-case decoded buffer is allocated.
	maxBodyBytes = 3 * 1024 * 1024
)

// babyScope parses {babyID} and proves the caller belongs to the baby's
// household. On failure it has already written the response.
func (h *Handler[T]) babyScope(w http.ResponseWriter, r *http.Request) (babyID uuid.UUID, uid uuid.UUID, ok bool) {
	uid = auth.UserIDFrom(r.Context())
	babyID, err := uuid.Parse(chi.URLParam(r, "babyID"))
	if err != nil {
		httpx.WriteError(w, http.StatusBadRequest, "bad_id", "invalid baby id")
		return babyID, uid, false
	}
	if _, err := baby.MustOwnBaby(r.Context(), h.store, uid, babyID); err != nil {
		baby.WriteAuthErr(w, err)
		return babyID, uid, false
	}
	return babyID, uid, true
}

// itemScope parses {id}, looks the row up and proves the caller owns its
// baby. extraCols are loaded alongside baby_id into dest. A missing row
// answers 404.
func (h *Handler[T]) itemScope(w http.ResponseWriter, r *http.Request, extraCols string, dest ...any) (id uuid.UUID, ok bool) {
	uid := auth.UserIDFrom(r.Context())
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.WriteError(w, http.StatusBadRequest, "bad_id", "invalid id")
		return id, false
	}
	cols := "baby_id"
	if extraCols != "" {
		cols += ", " + extraCols
	}
	var babyID uuid.UUID
	err = h.store.Pool.QueryRow(r.Context(),
		`SELECT `+cols+` FROM `+h.spec.Table+` WHERE id = $1`, id).
		Scan(append([]any{&babyID}, dest...)...)
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.WriteError(w, http.StatusNotFound, "not_found", h.spec.Noun+" not found")
		return id, false
	}
	if err != nil {
		h.logger.Error("lookup "+h.spec.Noun, "err", err)
		httpx.WriteError(w, http.StatusInternalServerError, "internal", "lookup failed")
		return id, false
	}
	if _, err := baby.MustOwnBaby(r.Context(), h.store, uid, babyID); err != nil {
		baby.WriteAuthErr(w, err)
		return id, false
	}
	return id, true
}

// decodeBody decodes + struct-validates the request body into dst. With
// patch set, an explicit null on a field that isn't Optional is a 422.
func (h *Handler[T]) decodeBody(w http.ResponseWriter, r *http.Request, dst any, patch bool) bool {
	// Cap the body BEFORE parsing so a hostile client can't OOM the API by
	// streaming a multi-GB body.
	r.Body = http.MaxBytesReader(w, r.Body, maxBodyBytes)
	raw, err := io.ReadAll(r.Body)
	if err == nil {
		r.Body = io.NopCloser(bytes.NewReader(raw))
		err = httpx.DecodeJSON(r, dst)
	}
	if err != nil {
		if isBodyTooLarge(err) {
			httpx.WriteError(w, http.StatusRequestEntityTooLarge, "payload_too_large", "request body exceeds limit")
			return false
		}
		httpx.WriteError(w, http.StatusBadRequest, "bad_request", err.Error())
		return false
	}
	if patch {
		if name, bad := rejectNulls(raw, dst); bad {
			httpx.WriteError(w, http.StatusUnprocessableEntity, "validation_failed", name+" cannot be null")
			return false
		}
	}
	err = validate.Struct(dst)
	if err == nil {
		err = validateOptionals(validate, dst)
	}
	if err != nil {
		httpx.WriteError(w, http.StatusUnprocessableEntity, "validation_failed", err.Error())
		return false
	}
	return true
}

// isBodyTooLarge recognizes net/http's MaxBytesReader limit hit, which the
// JSON decoder surfaces as *http.MaxBytesError.
func isBodyTooLarge(err error) bool {
	var maxErr *http.MaxBytesError
	return errors.As(err, &maxErr)
}

// parseRange returns the [from, to) window for a list query. Clients pass
// RFC3339 timestamps; everything is UTC. Without `from` the window starts
// `window` before now; without `to` it ends 24h from now.
func parseRange(r *http.Request, window time.Duration) (time.Time, time.Time, error) {
	q := r.URL.Query()
	now := time.Now().UTC()
	from := now.Add(-window)
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

// parseLimit reads `limit`: default 200, ignored unless in 1..1000.
func parseLimit(r *http.Request) int {
	if l := r.URL.Query().Get("limit"); l != "" {
		if n, err := strconv.Atoi(l); err == nil && n > 0 && n <= maxLimit {
			return n
		}
	}
	return defaultLimit
}
