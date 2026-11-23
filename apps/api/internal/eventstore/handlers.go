package eventstore

import (
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/varsjad/evernest/apps/api/internal/httpx"
	"github.com/varsjad/evernest/apps/api/internal/uuidx"
)

func (h *Handler[T]) create(w http.ResponseWriter, r *http.Request) {
	babyID, uid, ok := h.babyScope(w, r)
	if !ok {
		return
	}

	c := h.spec.NewCreate()
	if !h.decodeBody(w, r, c.Body) {
		return
	}
	ins, prob := c.Build()
	if prob != nil {
		prob.write(w)
		return
	}

	if ins.Open && !h.spec.Open {
		panic("eventstore: " + h.spec.Table + ": Insert.Open on a kind without Spec.Open")
	}

	var photo decodedPhoto
	if h.spec.Photo {
		in := c.Body.(photoCarrier).photoIn()
		var p *Problem
		photo, p = decodePhoto(in.Photo, in.PhotoMime)
		if p != nil {
			p.write(w)
			return
		}
	}

	id := uuidx.NewV7()
	if ins.ID != nil && *ins.ID != uuid.Nil {
		id = *ins.ID
	}

	// At most one open session per baby. Checked before insert; the
	// idempotent-replay case (same client id) is allowed by excluding the
	// would-be row's id. There is a narrow TOCTOU window between two
	// concurrent starters; a partial unique index would break outbox replay
	// idempotency, so the narrow race is the accepted trade.
	if ins.Open {
		var existing uuid.UUID
		err := h.store.Pool.QueryRow(r.Context(), `
			SELECT id FROM `+h.spec.Table+`
			WHERE baby_id = $1 AND ended_at IS NULL AND id <> $2
			LIMIT 1
		`, babyID, id).Scan(&existing)
		switch {
		case err == nil:
			httpx.WriteError(w, http.StatusConflict, "open_session_exists",
				"a "+h.spec.Noun+" is already in progress for this baby")
			return
		case errors.Is(err, pgx.ErrNoRows):
			// no open session — proceed
		default:
			h.logger.Error("check open "+h.spec.Noun, "err", err)
			httpx.WriteError(w, http.StatusInternalServerError, "internal", "could not check open session")
			return
		}
	}

	// Idempotent insert: a retry with the same client id returns the
	// existing row instead of erroring, which is what makes outbox replay
	// safe.
	cols := "id, baby_id, " + h.spec.InsertCols
	args := []any{id, babyID}
	args = append(args, ins.Args...)
	if h.spec.Photo {
		cols += ", photo, photo_mime"
		args = append(args, photo.bytes, photo.mime)
	}
	args = append(args, uid)
	placeholders := make([]string, 0, len(args)+1)
	for i := range args[:len(args)-1] {
		placeholders = append(placeholders, "$"+strconv.Itoa(i+1))
	}
	placeholders = append(placeholders, "'manual'", "$"+strconv.Itoa(len(args)))

	out, err := h.spec.Scan(h.store.Pool.QueryRow(r.Context(), `
		WITH ins AS (
			INSERT INTO `+h.spec.Table+` (`+cols+`, source, created_by_user_id)
			VALUES (`+strings.Join(placeholders, ", ")+`)
			ON CONFLICT (id) DO NOTHING
			RETURNING `+h.spec.Select+`
		)
		SELECT * FROM ins
		UNION ALL
		SELECT `+h.spec.Select+`
		FROM `+h.spec.Table+` WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM ins)
	`, args...))
	if err != nil {
		h.logger.Error("insert "+h.spec.Noun, "err", err)
		httpx.WriteError(w, http.StatusInternalServerError, "internal", "could not create "+h.spec.Noun)
		return
	}
	httpx.WriteJSON(w, http.StatusCreated, out)
}

func (h *Handler[T]) list(w http.ResponseWriter, r *http.Request) {
	babyID, _, ok := h.babyScope(w, r)
	if !ok {
		return
	}
	from, to, err := parseRange(r, h.spec.Window)
	if err != nil {
		httpx.WriteError(w, http.StatusBadRequest, "bad_range", err.Error())
		return
	}
	limit := parseLimit(r)

	rows, err := h.store.Pool.Query(r.Context(), fmt.Sprintf(`
		SELECT %s
		FROM %s
		WHERE baby_id = $1 AND %s >= $2 AND %s < $3
		ORDER BY %s DESC
		LIMIT $4
	`, h.spec.Select, h.spec.Table, h.spec.TimeCol, h.spec.TimeCol, h.spec.TimeCol),
		babyID, from, to, limit)
	if err != nil {
		h.logger.Error("list "+h.spec.Noun, "err", err)
		httpx.WriteError(w, http.StatusInternalServerError, "internal", "list failed")
		return
	}
	defer rows.Close()
	out := make([]T, 0, 32)
	for rows.Next() {
		item, err := h.spec.Scan(rows)
		if err != nil {
			h.logger.Error("scan "+h.spec.Noun, "err", err)
			httpx.WriteError(w, http.StatusInternalServerError, "internal", "scan failed")
			return
		}
		out = append(out, item)
	}
	httpx.WriteJSON(w, http.StatusOK, out)
}

// getOpen returns the most recent open session for the baby, or 204. The
// Today screen polls this instead of scanning the per-day list.
func (h *Handler[T]) getOpen(w http.ResponseWriter, r *http.Request) {
	babyID, _, ok := h.babyScope(w, r)
	if !ok {
		return
	}
	out, err := h.spec.Scan(h.store.Pool.QueryRow(r.Context(), `
		SELECT `+h.spec.Select+`
		FROM `+h.spec.Table+`
		WHERE baby_id = $1 AND ended_at IS NULL
		ORDER BY started_at DESC
		LIMIT 1
	`, babyID))
	if errors.Is(err, pgx.ErrNoRows) {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if err != nil {
		h.logger.Error("get open "+h.spec.Noun, "err", err)
		httpx.WriteError(w, http.StatusInternalServerError, "internal", "lookup failed")
		return
	}
	httpx.WriteJSON(w, http.StatusOK, out)
}

func (h *Handler[T]) patch(w http.ResponseWriter, r *http.Request) {
	p := h.spec.NewPatch()
	id, ok := h.itemScope(w, r, false, p.State, p.Dest...)
	if !ok {
		return
	}
	body := p.Body()
	if !h.decodeBody(w, r, body) {
		return
	}
	u, prob := p.Build()
	if prob != nil {
		prob.write(w)
		return
	}

	args := append([]any{id}, u.Args...)
	set := u.Set
	if h.spec.Photo {
		in := body.(photoCarrier).photoIn()
		// Photo PATCH semantics:
		//   - omitted              → leave columns alone
		//   - "" (empty string)    → clear photo + photo_mime
		//   - non-empty + mime     → replace
		//   - non-empty + no mime  → 422 (validation_failed)
		var (
			clear bool
			photo decodedPhoto
		)
		if in.Photo != nil {
			if *in.Photo == "" {
				clear = true
			} else {
				var pp *Problem
				photo, pp = decodePhoto(in.Photo, in.PhotoMime)
				if pp != nil {
					pp.write(w)
					return
				}
			}
		}
		n := len(args)
		args = append(args, clear, photo.bytes != nil, photo.bytes, photo.mime)
		set += fmt.Sprintf(`,
			photo       = CASE WHEN $%[1]d::boolean THEN NULL WHEN $%[2]d::boolean THEN $%[3]d::bytea ELSE photo END,
			photo_mime  = CASE WHEN $%[1]d::boolean THEN NULL WHEN $%[2]d::boolean THEN $%[4]d::text ELSE photo_mime END`,
			n+1, n+2, n+3, n+4)
	}

	out, err := h.spec.Scan(h.store.Pool.QueryRow(r.Context(), `
		UPDATE `+h.spec.Table+` SET `+set+`
		WHERE id = $1 `+u.Where+`
		RETURNING `+h.spec.Select, args...))
	if errors.Is(err, pgx.ErrNoRows) && u.NoRows != nil {
		u.NoRows.write(w)
		return
	}
	if err != nil {
		h.logger.Error("update "+h.spec.Noun, "err", err)
		msg := u.FailMsg
		if msg == "" {
			msg = "could not update " + h.spec.Noun
		}
		httpx.WriteError(w, http.StatusInternalServerError, "internal", msg)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, out)
}

func (h *Handler[T]) delete(w http.ResponseWriter, r *http.Request) {
	id, ok := h.itemScope(w, r, true, "")
	if !ok {
		return
	}
	if _, err := h.store.Pool.Exec(r.Context(), `DELETE FROM `+h.spec.Table+` WHERE id = $1`, id); err != nil {
		h.logger.Error("delete "+h.spec.Noun, "err", err)
		httpx.WriteError(w, http.StatusInternalServerError, "internal", "delete failed")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
