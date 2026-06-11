// Package diaper implements CRUD for diaper changes. Mirrors the bottlefeed
// shape: POST/GET/PATCH/DELETE with UUIDv7 client-id idempotency. Diapers
// carry no amount or duration — just an enum (wet/soiled/mixed) and optional
// notes. PATCH is partial (omitted fields stay untouched) and preserves
// id / source / created_at / created_by_user_id server-side.
//
// Optional photo (added in migration 000011): the FE can attach a single
// compressed JPEG/PNG/WebP image to a diaper. To keep the offline outbox
// path JSON-only, the image rides the same create/update body as a
// base64 string in `photo` + an explicit `photo_mime`. The list endpoint
// projects `(photo IS NOT NULL) AS has_photo` and never ships the bytes;
// the dedicated GET /v1/diapers/{id}/photo route streams the raw image
// to <img src>. PATCH follows the existing notes convention:
//   - `"photo": ""` clears the photo (and photo_mime),
//   - `"photo": "<base64>"` + `"photo_mime": "image/jpeg"` replaces it,
//   - both omitted leaves the row untouched.
package diaper

import (
	"encoding/base64"
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

// maxPhotoBytes caps a single raw image at 2 MB after base64-decode. The FE
// compresses to ~150–400 KB before sending, so this is a defence-in-depth
// limit, not the expected size. maxBodyBytes leaves headroom for the JSON
// envelope and the ~33% base64 inflation so we 413 the request before
// allocating the worst-case decoded buffer.
const (
	maxPhotoBytes = 2 * 1024 * 1024
	maxBodyBytes  = 3 * 1024 * 1024
)

// allowedPhotoMimes mirrors the diapers_photo_mime_chk constraint added in
// migration 000011. Keep in sync if you ever loosen / tighten that list.
var allowedPhotoMimes = map[string]struct{}{
	"image/jpeg": {},
	"image/png":  {},
	"image/webp": {},
}

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
	r.Post("/diapers", h.create)
	r.Get("/diapers", h.list)
}

// ItemRoutes mounts under /v1/diapers/{id}.
func (h *Handler) ItemRoutes(r chi.Router) {
	r.Patch("/", h.update)
	r.Delete("/", h.delete)
	r.Get("/photo", h.photo)
}

type createReq struct {
	ID         *uuid.UUID `json:"id,omitempty"`
	OccurredAt time.Time  `json:"occurred_at" validate:"required"`
	Type       string     `json:"type" validate:"required,oneof=wet soiled mixed"`
	Notes      *string    `json:"notes,omitempty"`
	// Photo is the base64-encoded image bytes (no `data:` prefix). When
	// non-nil, PhotoMime must also be set to one of allowedPhotoMimes.
	Photo     *string `json:"photo,omitempty"`
	PhotoMime *string `json:"photo_mime,omitempty"`
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

	// Cap body size BEFORE JSON parse so a hostile client can't OOM the
	// API by streaming a multi-GB body. The decoder reads from the
	// capped reader transparently; MaxBytesError on overflow surfaces as
	// an io error which we translate to 413.
	r.Body = http.MaxBytesReader(w, r.Body, maxBodyBytes)

	var req createReq
	if err := httpx.DecodeJSON(r, &req); err != nil {
		if isBodyTooLarge(err) {
			httpx.WriteError(w, http.StatusRequestEntityTooLarge, "payload_too_large", "request body exceeds limit")
			return
		}
		httpx.WriteError(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	if err := h.v.Struct(req); err != nil {
		httpx.WriteError(w, http.StatusUnprocessableEntity, "validation_failed", err.Error())
		return
	}

	photoBytes, photoMime, status, errCode, errMsg := decodePhoto(req.Photo, req.PhotoMime)
	if status != 0 {
		httpx.WriteError(w, status, errCode, errMsg)
		return
	}

	var id uuid.UUID
	if req.ID != nil && *req.ID != uuid.Nil {
		id = *req.ID
	} else {
		id = uuidx.NewV7()
	}

	// Idempotent insert: identical client id returns the existing row.
	// Project `(photo IS NOT NULL) AS has_photo` so the response never
	// carries the blob — keeps the CTE result small even when a 1 MB
	// JPEG was just stored.
	var out Diaper
	err = h.store.Pool.QueryRow(r.Context(), `
		WITH ins AS (
			INSERT INTO diapers (id, baby_id, occurred_at, type, notes, photo, photo_mime, source, created_by_user_id)
			VALUES ($1, $2, $3, $4, $5, $6, $7, 'manual', $8)
			ON CONFLICT (id) DO NOTHING
			RETURNING id, baby_id, occurred_at, type, notes, (photo IS NOT NULL) AS has_photo, photo_mime, source, created_at
		)
		SELECT id, baby_id, occurred_at, type, notes, has_photo, photo_mime, source, created_at FROM ins
		UNION ALL
		SELECT id, baby_id, occurred_at, type, notes, (photo IS NOT NULL) AS has_photo, photo_mime, source, created_at
		FROM diapers WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM ins)
	`, id, babyID, req.OccurredAt, req.Type, req.Notes, photoBytes, photoMime, uid).
		Scan(&out.ID, &out.BabyID, &out.OccurredAt, &out.Type, &out.Notes, &out.HasPhoto, &out.PhotoMime, &out.Source, &out.CreatedAt)
	if err != nil {
		h.logger.Error("insert diaper", "err", err)
		httpx.WriteError(w, http.StatusInternalServerError, "internal", "could not create diaper")
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

	// `(photo IS NOT NULL) AS has_photo` reads the TOAST pointer in the
	// main heap row, not the chunked blob — so adding photos to the
	// schema does NOT regress list-endpoint latency. The actual bytes are
	// fetched on demand via the /photo subroute.
	rows, err := h.store.Pool.Query(r.Context(), `
		SELECT id, baby_id, occurred_at, type, notes, (photo IS NOT NULL) AS has_photo, photo_mime, source, created_at
		FROM diapers
		WHERE baby_id = $1 AND occurred_at >= $2 AND occurred_at < $3
		ORDER BY occurred_at DESC
		LIMIT $4
	`, babyID, from, to, limit)
	if err != nil {
		h.logger.Error("list diapers", "err", err)
		httpx.WriteError(w, http.StatusInternalServerError, "internal", "list failed")
		return
	}
	defer rows.Close()
	out := make([]Diaper, 0, 32)
	for rows.Next() {
		var d Diaper
		if err := rows.Scan(&d.ID, &d.BabyID, &d.OccurredAt, &d.Type, &d.Notes, &d.HasPhoto, &d.PhotoMime, &d.Source, &d.CreatedAt); err != nil {
			h.logger.Error("scan diaper", "err", err)
			httpx.WriteError(w, http.StatusInternalServerError, "internal", "scan failed")
			return
		}
		out = append(out, d)
	}
	httpx.WriteJSON(w, http.StatusOK, out)
}

// updateReq is the PATCH body. All fields optional. See bottlefeed.update
// for the "send empty string to clear notes" convention; the same shape
// applies to photo (`"photo": ""` clears, present-and-non-empty replaces,
// omitted leaves the row alone).
type updateReq struct {
	OccurredAt *time.Time `json:"occurred_at,omitempty"`
	Type       *string    `json:"type,omitempty" validate:"omitempty,oneof=wet soiled mixed"`
	Notes      *string    `json:"notes,omitempty"`
	Photo      *string    `json:"photo,omitempty"`
	PhotoMime  *string    `json:"photo_mime,omitempty"`
}

func (h *Handler) update(w http.ResponseWriter, r *http.Request) {
	uid := auth.UserIDFrom(r.Context())
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.WriteError(w, http.StatusBadRequest, "bad_id", "invalid id")
		return
	}
	var babyID uuid.UUID
	err = h.store.Pool.QueryRow(r.Context(), `SELECT baby_id FROM diapers WHERE id = $1`, id).Scan(&babyID)
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.WriteError(w, http.StatusNotFound, "not_found", "diaper not found")
		return
	}
	if err != nil {
		h.logger.Error("lookup diaper", "err", err)
		httpx.WriteError(w, http.StatusInternalServerError, "internal", "lookup failed")
		return
	}
	if _, err := baby.MustOwnBaby(r.Context(), h.store, uid, babyID); err != nil {
		writeBabyAuthErr(w, err)
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxBodyBytes)

	var req updateReq
	if err := httpx.DecodeJSON(r, &req); err != nil {
		if isBodyTooLarge(err) {
			httpx.WriteError(w, http.StatusRequestEntityTooLarge, "payload_too_large", "request body exceeds limit")
			return
		}
		httpx.WriteError(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	if err := h.v.Struct(req); err != nil {
		httpx.WriteError(w, http.StatusUnprocessableEntity, "validation_failed", err.Error())
		return
	}

	notesPresent := req.Notes != nil
	var notesValue string
	if notesPresent {
		notesValue = *req.Notes
	}

	// Photo PATCH semantics:
	//   - omitted              → leave column alone
	//   - "" (empty string)    → clear photo + photo_mime
	//   - non-empty + mime     → replace
	//   - non-empty + no mime  → 422 (validation_failed)
	photoPresent := req.Photo != nil
	var photoBytes []byte
	var photoMime *string
	clearPhoto := false
	if photoPresent {
		if *req.Photo == "" {
			clearPhoto = true
		} else {
			b, m, status, code, msg := decodePhoto(req.Photo, req.PhotoMime)
			if status != 0 {
				httpx.WriteError(w, status, code, msg)
				return
			}
			photoBytes = b
			photoMime = m
		}
	}

	var out Diaper
	err = h.store.Pool.QueryRow(r.Context(), `
		UPDATE diapers SET
			occurred_at = COALESCE($2, occurred_at),
			type        = COALESCE($3, type),
			notes       = CASE WHEN $4::boolean THEN NULLIF($5, '') ELSE notes END,
			photo       = CASE
				WHEN $6::boolean THEN NULL
				WHEN $7::boolean THEN $8::bytea
				ELSE photo
			END,
			photo_mime  = CASE
				WHEN $6::boolean THEN NULL
				WHEN $7::boolean THEN $9::text
				ELSE photo_mime
			END
		WHERE id = $1
		RETURNING id, baby_id, occurred_at, type, notes, (photo IS NOT NULL) AS has_photo, photo_mime, source, created_at
	`, id, req.OccurredAt, req.Type, notesPresent, notesValue, clearPhoto, photoBytes != nil, photoBytes, photoMime).
		Scan(&out.ID, &out.BabyID, &out.OccurredAt, &out.Type, &out.Notes, &out.HasPhoto, &out.PhotoMime, &out.Source, &out.CreatedAt)
	if err != nil {
		h.logger.Error("update diaper", "err", err)
		httpx.WriteError(w, http.StatusInternalServerError, "internal", "could not update diaper")
		return
	}
	httpx.WriteJSON(w, http.StatusOK, out)
}

// photo streams the raw image bytes for an individual diaper. 404 if the
// row doesn't exist, 204 if it exists but has no photo attached. The
// `Cache-Control: private, max-age=300` is intentional: photos are
// effectively immutable for the lifetime of the row (a PATCH that
// replaces the photo also bumps no separate version, so 5 min of staleness
// is the right trade between "user just edited" and "list page re-fetches
// the same image repeatedly").
func (h *Handler) photo(w http.ResponseWriter, r *http.Request) {
	uid := auth.UserIDFrom(r.Context())
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.WriteError(w, http.StatusBadRequest, "bad_id", "invalid id")
		return
	}
	var (
		babyID    uuid.UUID
		photoData []byte
		photoMime *string
	)
	err = h.store.Pool.QueryRow(r.Context(), `
		SELECT baby_id, photo, photo_mime FROM diapers WHERE id = $1
	`, id).Scan(&babyID, &photoData, &photoMime)
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.WriteError(w, http.StatusNotFound, "not_found", "diaper not found")
		return
	}
	if err != nil {
		h.logger.Error("lookup diaper photo", "err", err)
		httpx.WriteError(w, http.StatusInternalServerError, "internal", "lookup failed")
		return
	}
	if _, err := baby.MustOwnBaby(r.Context(), h.store, uid, babyID); err != nil {
		writeBabyAuthErr(w, err)
		return
	}
	if len(photoData) == 0 || photoMime == nil {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	w.Header().Set("Content-Type", *photoMime)
	w.Header().Set("Content-Length", strconv.Itoa(len(photoData)))
	w.Header().Set("Cache-Control", "private, max-age=300")
	if _, err := w.Write(photoData); err != nil {
		h.logger.Warn("write diaper photo", "err", err)
	}
}

func (h *Handler) delete(w http.ResponseWriter, r *http.Request) {
	uid := auth.UserIDFrom(r.Context())
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.WriteError(w, http.StatusBadRequest, "bad_id", "invalid id")
		return
	}
	var babyID uuid.UUID
	err = h.store.Pool.QueryRow(r.Context(), `SELECT baby_id FROM diapers WHERE id = $1`, id).Scan(&babyID)
	if errors.Is(err, pgx.ErrNoRows) {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if err != nil {
		h.logger.Error("lookup diaper", "err", err)
		httpx.WriteError(w, http.StatusInternalServerError, "internal", "lookup failed")
		return
	}
	if _, err := baby.MustOwnBaby(r.Context(), h.store, uid, babyID); err != nil {
		writeBabyAuthErr(w, err)
		return
	}
	_, err = h.store.Pool.Exec(r.Context(), `DELETE FROM diapers WHERE id = $1`, id)
	if err != nil {
		h.logger.Error("delete diaper", "err", err)
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

// decodePhoto turns the wire (base64 string + mime) into the bytes the
// CTE / UPDATE will store. Returns a non-zero HTTP status with a stable
// error code/message when the inputs are invalid:
//   - 422 validation_failed: photo present but mime missing/unsupported,
//     or mime present without photo.
//   - 400 bad_request:       photo isn't valid base64.
//   - 413 payload_too_large: decoded raw image exceeds maxPhotoBytes.
//
// A nil photo + nil mime is the "no photo attached" case and returns
// (nil, nil, 0, "", "") — the SQL writes NULL for both columns.
func decodePhoto(photo *string, mime *string) ([]byte, *string, int, string, string) {
	if photo == nil && mime == nil {
		return nil, nil, 0, "", ""
	}
	if photo == nil || *photo == "" {
		return nil, nil, http.StatusUnprocessableEntity, "validation_failed", "photo_mime set without photo"
	}
	if mime == nil || *mime == "" {
		return nil, nil, http.StatusUnprocessableEntity, "validation_failed", "photo set without photo_mime"
	}
	if _, ok := allowedPhotoMimes[*mime]; !ok {
		return nil, nil, http.StatusUnprocessableEntity, "validation_failed", "unsupported photo_mime"
	}
	bytes, err := base64.StdEncoding.DecodeString(*photo)
	if err != nil {
		return nil, nil, http.StatusBadRequest, "bad_request", "photo is not valid base64"
	}
	if len(bytes) == 0 {
		return nil, nil, http.StatusUnprocessableEntity, "validation_failed", "photo decoded to empty bytes"
	}
	if len(bytes) > maxPhotoBytes {
		return nil, nil, http.StatusRequestEntityTooLarge, "payload_too_large", "photo exceeds size limit"
	}
	m := *mime
	return bytes, &m, 0, "", ""
}

// isBodyTooLarge recognizes net/http's MaxBytesReader limit hit. Modern
// Go wraps the underlying overflow as `*http.MaxBytesError`; the string
// fallback covers older runtimes / opaque decoder wrappers.
func isBodyTooLarge(err error) bool {
	if err == nil {
		return false
	}
	var maxErr *http.MaxBytesError
	if errors.As(err, &maxErr) {
		return true
	}
	if err.Error() == "http: request body too large" {
		return true
	}
	return false
}
