// Package solidmeal implements CRUD for solid-food meals. Shape mirrors
// diaper (including the optional inline photo) plus bottlefeed-style
// optional amount. A meal is a sitting: foods[] (required), optional
// meal-level reaction / amount_g / notes / photo. PATCH is partial and
// preserves id / source / created_at / created_by_user_id.
package solidmeal

import (
	"encoding/base64"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
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

const (
	maxPhotoBytes = 2 * 1024 * 1024
	maxBodyBytes  = 3 * 1024 * 1024
)

var allowedPhotoMimes = map[string]struct{}{
	"image/jpeg": {},
	"image/png":  {},
	"image/webp": {},
}

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

type Handler struct {
	store  *store.Store
	logger *slog.Logger
	v      *validator.Validate
}

func NewHandler(st *store.Store, logger *slog.Logger) *Handler {
	return &Handler{store: st, logger: logger, v: validator.New(validator.WithRequiredStructEnabled())}
}

func (h *Handler) BabyRoutes(r chi.Router) {
	r.Post("/solid-meals", h.create)
	r.Get("/solid-meals", h.list)
}

func (h *Handler) ItemRoutes(r chi.Router) {
	r.Patch("/", h.update)
	r.Delete("/", h.delete)
	r.Get("/photo", h.photo)
}

type createReq struct {
	ID         *uuid.UUID `json:"id,omitempty"`
	OccurredAt time.Time  `json:"occurred_at" validate:"required"`
	Foods      []string   `json:"foods" validate:"required,min=1"`
	Reaction   *string    `json:"reaction,omitempty" validate:"omitempty,oneof=liked neutral refused reaction"`
	AmountG    *float64   `json:"amount_g,omitempty" validate:"omitempty,gte=0,lte=100000"`
	Notes      *string    `json:"notes,omitempty"`
	Photo      *string    `json:"photo,omitempty"`
	PhotoMime  *string    `json:"photo_mime,omitempty"`
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

	foods := normalizeFoods(req.Foods)
	if len(foods) == 0 {
		httpx.WriteError(w, http.StatusUnprocessableEntity, "validation_failed", "foods must contain at least one non-empty item")
		return
	}
	if req.Reaction != nil {
		if _, ok := allowedReactions[*req.Reaction]; !ok {
			httpx.WriteError(w, http.StatusUnprocessableEntity, "validation_failed", "invalid reaction")
			return
		}
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

	var out SolidMeal
	err = h.store.Pool.QueryRow(r.Context(), `
		WITH ins AS (
			INSERT INTO solid_meals (
				id, baby_id, occurred_at, foods, reaction, amount_g, notes,
				photo, photo_mime, source, created_by_user_id
			)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'manual', $10)
			ON CONFLICT (id) DO NOTHING
			RETURNING id, baby_id, occurred_at, foods, reaction, amount_g, notes,
				(photo IS NOT NULL) AS has_photo, photo_mime, source, created_at
		)
		SELECT id, baby_id, occurred_at, foods, reaction, amount_g, notes,
			has_photo, photo_mime, source, created_at FROM ins
		UNION ALL
		SELECT id, baby_id, occurred_at, foods, reaction, amount_g, notes,
			(photo IS NOT NULL) AS has_photo, photo_mime, source, created_at
		FROM solid_meals WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM ins)
	`, id, babyID, req.OccurredAt, foods, req.Reaction, req.AmountG, req.Notes,
		photoBytes, photoMime, uid).
		Scan(&out.ID, &out.BabyID, &out.OccurredAt, &out.Foods, &out.Reaction,
			&out.AmountG, &out.Notes, &out.HasPhoto, &out.PhotoMime, &out.Source, &out.CreatedAt)
	if err != nil {
		h.logger.Error("insert solid meal", "err", err)
		httpx.WriteError(w, http.StatusInternalServerError, "internal", "could not create solid meal")
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
		SELECT id, baby_id, occurred_at, foods, reaction, amount_g, notes,
			(photo IS NOT NULL) AS has_photo, photo_mime, source, created_at
		FROM solid_meals
		WHERE baby_id = $1 AND occurred_at >= $2 AND occurred_at < $3
		ORDER BY occurred_at DESC
		LIMIT $4
	`, babyID, from, to, limit)
	if err != nil {
		h.logger.Error("list solid meals", "err", err)
		httpx.WriteError(w, http.StatusInternalServerError, "internal", "list failed")
		return
	}
	defer rows.Close()
	out := make([]SolidMeal, 0, 32)
	for rows.Next() {
		var m SolidMeal
		if err := rows.Scan(&m.ID, &m.BabyID, &m.OccurredAt, &m.Foods, &m.Reaction,
			&m.AmountG, &m.Notes, &m.HasPhoto, &m.PhotoMime, &m.Source, &m.CreatedAt); err != nil {
			h.logger.Error("scan solid meal", "err", err)
			httpx.WriteError(w, http.StatusInternalServerError, "internal", "scan failed")
			return
		}
		out = append(out, m)
	}
	httpx.WriteJSON(w, http.StatusOK, out)
}

type updateReq struct {
	OccurredAt *time.Time `json:"occurred_at,omitempty"`
	Foods      []string   `json:"foods,omitempty"`
	// Reaction allows "" to clear. Validated manually below so empty
	// string isn't rejected by the oneof tag (validator treats "" as
	// present for oneof even with omitempty on some versions).
	Reaction     *string  `json:"reaction,omitempty"`
	AmountG      *float64 `json:"amount_g,omitempty" validate:"omitempty,gte=0,lte=100000"`
	ClearAmountG bool     `json:"clear_amount_g,omitempty"`
	Notes        *string  `json:"notes,omitempty"`
	Photo        *string  `json:"photo,omitempty"`
	PhotoMime    *string  `json:"photo_mime,omitempty"`
}

func (h *Handler) update(w http.ResponseWriter, r *http.Request) {
	uid := auth.UserIDFrom(r.Context())
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.WriteError(w, http.StatusBadRequest, "bad_id", "invalid id")
		return
	}
	var babyID uuid.UUID
	err = h.store.Pool.QueryRow(r.Context(), `SELECT baby_id FROM solid_meals WHERE id = $1`, id).Scan(&babyID)
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.WriteError(w, http.StatusNotFound, "not_found", "solid meal not found")
		return
	}
	if err != nil {
		h.logger.Error("lookup solid meal", "err", err)
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

	foodsPresent := req.Foods != nil
	var foods []string
	if foodsPresent {
		foods = normalizeFoods(req.Foods)
		if len(foods) == 0 {
			httpx.WriteError(w, http.StatusUnprocessableEntity, "validation_failed", "foods must contain at least one non-empty item")
			return
		}
	}

	// Reaction: omitted → leave; "" → clear; non-empty → set (validator
	// already constrained non-empty values to the allowlist).
	reactionPresent := req.Reaction != nil
	var reactionValue string
	if reactionPresent {
		reactionValue = *req.Reaction
		if reactionValue != "" {
			if _, ok := allowedReactions[reactionValue]; !ok {
				httpx.WriteError(w, http.StatusUnprocessableEntity, "validation_failed", "invalid reaction")
				return
			}
		}
	}

	notesPresent := req.Notes != nil
	var notesValue string
	if notesPresent {
		notesValue = *req.Notes
	}

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

	amountPresent := req.AmountG != nil

	var out SolidMeal
	err = h.store.Pool.QueryRow(r.Context(), `
		UPDATE solid_meals SET
			occurred_at = COALESCE($2, occurred_at),
			foods       = CASE WHEN $3::boolean THEN $4::text[] ELSE foods END,
			reaction    = CASE WHEN $5::boolean THEN NULLIF($6, '') ELSE reaction END,
			amount_g    = CASE
				WHEN $7::boolean THEN NULL
				WHEN $8::boolean THEN $9::numeric
				ELSE amount_g
			END,
			notes       = CASE WHEN $10::boolean THEN NULLIF($11, '') ELSE notes END,
			photo       = CASE
				WHEN $12::boolean THEN NULL
				WHEN $13::boolean THEN $14::bytea
				ELSE photo
			END,
			photo_mime  = CASE
				WHEN $12::boolean THEN NULL
				WHEN $13::boolean THEN $15::text
				ELSE photo_mime
			END
		WHERE id = $1
		RETURNING id, baby_id, occurred_at, foods, reaction, amount_g, notes,
			(photo IS NOT NULL) AS has_photo, photo_mime, source, created_at
	`, id, req.OccurredAt, foodsPresent, foods, reactionPresent, reactionValue,
		req.ClearAmountG, amountPresent, req.AmountG, notesPresent, notesValue,
		clearPhoto, photoBytes != nil, photoBytes, photoMime).
		Scan(&out.ID, &out.BabyID, &out.OccurredAt, &out.Foods, &out.Reaction,
			&out.AmountG, &out.Notes, &out.HasPhoto, &out.PhotoMime, &out.Source, &out.CreatedAt)
	if err != nil {
		h.logger.Error("update solid meal", "err", err)
		httpx.WriteError(w, http.StatusInternalServerError, "internal", "could not update solid meal")
		return
	}
	httpx.WriteJSON(w, http.StatusOK, out)
}

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
		SELECT baby_id, photo, photo_mime FROM solid_meals WHERE id = $1
	`, id).Scan(&babyID, &photoData, &photoMime)
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.WriteError(w, http.StatusNotFound, "not_found", "solid meal not found")
		return
	}
	if err != nil {
		h.logger.Error("lookup solid meal photo", "err", err)
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
		h.logger.Warn("write solid meal photo", "err", err)
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
	err = h.store.Pool.QueryRow(r.Context(), `SELECT baby_id FROM solid_meals WHERE id = $1`, id).Scan(&babyID)
	if errors.Is(err, pgx.ErrNoRows) {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if err != nil {
		h.logger.Error("lookup solid meal", "err", err)
		httpx.WriteError(w, http.StatusInternalServerError, "internal", "lookup failed")
		return
	}
	if _, err := baby.MustOwnBaby(r.Context(), h.store, uid, babyID); err != nil {
		writeBabyAuthErr(w, err)
		return
	}
	_, err = h.store.Pool.Exec(r.Context(), `DELETE FROM solid_meals WHERE id = $1`, id)
	if err != nil {
		h.logger.Error("delete solid meal", "err", err)
		httpx.WriteError(w, http.StatusInternalServerError, "internal", "delete failed")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func normalizeFoods(in []string) []string {
	out := make([]string, 0, len(in))
	for _, f := range in {
		trimmed := strings.TrimSpace(f)
		if trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
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
