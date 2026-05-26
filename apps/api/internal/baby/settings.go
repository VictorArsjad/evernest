// Settings handlers cover the per-baby `baby_settings` row that holds the
// three unit preferences (volume, length, weight). They live alongside the
// baby package because the row's lifecycle is bound to the baby's: it's
// seeded inside the same transaction as the baby insert, and cascades on
// delete via the FK.
//
// PUT is full-replace; the FE settings screen always submits all three
// fields together. Time-format and other inherently per-user prefs live on
// `user_preferences` (see internal/preferences/) — the split is intentional
// so two babies in the same household can be tracked in different units.
package baby

import (
	"context"
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/varsjad/evernest/apps/api/internal/auth"
	"github.com/varsjad/evernest/apps/api/internal/httpx"
	"github.com/varsjad/evernest/apps/api/internal/store"
)

type Settings struct {
	BabyID     uuid.UUID `json:"baby_id"`
	UnitVolume string    `json:"unit_volume"`
	UnitLength string    `json:"unit_length"`
	UnitWeight string    `json:"unit_weight"`
}

func (h *Handler) getSettings(w http.ResponseWriter, r *http.Request) {
	uid := auth.UserIDFrom(r.Context())
	babyID, err := uuid.Parse(chi.URLParam(r, "babyID"))
	if err != nil {
		httpx.WriteError(w, http.StatusBadRequest, "bad_id", "invalid baby id")
		return
	}
	if _, err := MustOwnBaby(r.Context(), h.store, uid, babyID); err != nil {
		writeBabyAuthErr(w, err)
		return
	}

	s, err := loadOrSeedSettings(r.Context(), h.store, babyID)
	if err != nil {
		h.logger.Error("load baby_settings", "err", err)
		httpx.WriteError(w, http.StatusInternalServerError, "internal", "could not load settings")
		return
	}
	httpx.WriteJSON(w, http.StatusOK, s)
}

type settingsReq struct {
	UnitVolume string `json:"unit_volume" validate:"required,oneof=ml oz"`
	UnitLength string `json:"unit_length" validate:"required,oneof=cm in"`
	UnitWeight string `json:"unit_weight" validate:"required,oneof=kg lb"`
}

func (h *Handler) putSettings(w http.ResponseWriter, r *http.Request) {
	uid := auth.UserIDFrom(r.Context())
	babyID, err := uuid.Parse(chi.URLParam(r, "babyID"))
	if err != nil {
		httpx.WriteError(w, http.StatusBadRequest, "bad_id", "invalid baby id")
		return
	}
	if _, err := MustOwnBaby(r.Context(), h.store, uid, babyID); err != nil {
		writeBabyAuthErr(w, err)
		return
	}

	var req settingsReq
	if err := httpx.DecodeJSON(r, &req); err != nil {
		httpx.WriteError(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	if err := h.v.Struct(req); err != nil {
		httpx.WriteError(w, http.StatusUnprocessableEntity, "validation_failed", err.Error())
		return
	}

	var s Settings
	err = h.store.Pool.QueryRow(r.Context(), `
		INSERT INTO baby_settings (baby_id, unit_volume, unit_length, unit_weight)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (baby_id) DO UPDATE
		   SET unit_volume = EXCLUDED.unit_volume,
		       unit_length = EXCLUDED.unit_length,
		       unit_weight = EXCLUDED.unit_weight
		RETURNING baby_id, unit_volume, unit_length, unit_weight
	`, babyID, req.UnitVolume, req.UnitLength, req.UnitWeight).Scan(
		&s.BabyID, &s.UnitVolume, &s.UnitLength, &s.UnitWeight,
	)
	if err != nil {
		h.logger.Error("upsert baby_settings", "err", err)
		httpx.WriteError(w, http.StatusInternalServerError, "internal", "could not save settings")
		return
	}
	httpx.WriteJSON(w, http.StatusOK, s)
}

// loadOrSeedSettings returns the baby's settings row, inserting defaults
// (column-level) on the rare miss. baby.create() seeds a row inside the
// create-baby transaction so this should always hit the SELECT branch in
// practice.
func loadOrSeedSettings(ctx context.Context, st *store.Store, babyID uuid.UUID) (Settings, error) {
	var s Settings
	err := st.Pool.QueryRow(ctx, `
		SELECT baby_id, unit_volume, unit_length, unit_weight
		FROM baby_settings WHERE baby_id = $1
	`, babyID).Scan(&s.BabyID, &s.UnitVolume, &s.UnitLength, &s.UnitWeight)
	if err == nil {
		return s, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return s, err
	}
	err = st.Pool.QueryRow(ctx, `
		INSERT INTO baby_settings (baby_id) VALUES ($1)
		ON CONFLICT (baby_id) DO UPDATE SET baby_id = EXCLUDED.baby_id
		RETURNING baby_id, unit_volume, unit_length, unit_weight
	`, babyID).Scan(&s.BabyID, &s.UnitVolume, &s.UnitLength, &s.UnitWeight)
	return s, err
}

// writeBabyAuthErr maps the MustOwnBaby errors to HTTP responses. Mirrors
// the writeMembershipErr helper in baby.go so the two routes return the
// same envelope shapes.
func writeBabyAuthErr(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrNotFound):
		httpx.WriteError(w, http.StatusNotFound, "not_found", "baby not found")
	case errors.Is(err, ErrUnauthorized):
		httpx.WriteError(w, http.StatusForbidden, "forbidden", "not a member of this household")
	default:
		httpx.WriteError(w, http.StatusInternalServerError, "internal", err.Error())
	}
}
