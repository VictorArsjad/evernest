package api_test

import (
	"fmt"
	"net/http"
	"testing"
)

// JSON Merge Patch (RFC 7396) semantics on every PATCH: absent keeps, null
// clears (clearable fields only), a value sets.

type clearable struct {
	kind, field string
	set         any // valid replacement value
	invalid     any // value that must still fail validation (nil = none)
	orig        any // value from the create sample
}

var clearableFields = []clearable{
	{"solid", "amount_g", 55, -1, float64(40)},
	{"pumping", "duration_seconds", 120, 21601, float64(900)},
	{"growth", "weight_g", 3600, 0, float64(3500)},
	{"growth", "height_cm", 53.5, 0, 52.5},
	{"growth", "head_circumference_cm", 36.5, 0, 35.5},
	{"sleep", "sleep_type", "night", "snooze", "nap"},
	{"nursing", "starting_breast", "right", "middle", "left"},
	{"solid", "reaction", "refused", "yummy", "liked"},
	{"sleep", "location", "bassinet", nil, "crib"},
	{"bottlefeed", "notes", "n2", nil, "left side"},
	{"diaper", "notes", "n2", nil, "light"},
	{"pumping", "notes", "n2", nil, "morning"},
	{"nursing", "notes", "n2", nil, "feed"},
	{"growth", "notes", "n2", nil, "clinic"},
	{"sleep", "notes", "n2", nil, "ok"},
	{"solid", "notes", "n2", nil, "ok"},
}

func createOne(t *testing.T, e *env, f fixture, k kind) string {
	t.Helper()
	r := e.create(t, f.token, f.baby, k, k.sample(fixedAt))
	mustStatus(t, r, http.StatusCreated)
	return fmt.Sprint(obj(t, r)["id"])
}

func TestMergePatch_ClearableFields(t *testing.T) {
	e := newEnv(t)
	f := newFixture(t, e)
	for _, c := range clearableFields {
		k := kindByName(t, c.kind)
		t.Run(c.kind+"/"+c.field, func(t *testing.T) {
			t.Run("absent keeps", func(t *testing.T) {
				id := createOne(t, e, f, k)
				pr := e.patch(t, f.token, k, id, map[string]any{})
				mustStatus(t, pr, http.StatusOK)
				expectField(t, obj(t, pr), c.field, c.orig)
			})
			t.Run("null clears", func(t *testing.T) {
				id := createOne(t, e, f, k)
				pr := e.patch(t, f.token, k, id, map[string]any{c.field: nil})
				mustStatus(t, pr, http.StatusOK)
				if v, ok := obj(t, pr)[c.field]; ok {
					t.Errorf("%s should be cleared, got %v", c.field, v)
				}
			})
			t.Run("value sets", func(t *testing.T) {
				id := createOne(t, e, f, k)
				pr := e.patch(t, f.token, k, id, map[string]any{c.field: c.set})
				mustStatus(t, pr, http.StatusOK)
				expectField(t, obj(t, pr), c.field, c.set)
			})
			if c.invalid != nil {
				t.Run("invalid value still 422", func(t *testing.T) {
					id := createOne(t, e, f, k)
					wantErr(t, e.patch(t, f.token, k, id, map[string]any{c.field: c.invalid}), 422, "validation_failed")
				})
			}
		})
	}
}

func TestMergePatch_EmptyStringClearsText(t *testing.T) {
	e := newEnv(t)
	f := newFixture(t, e)
	for _, c := range clearableFields {
		if _, isText := c.set.(string); !isText || c.field == "sleep_type" || c.field == "starting_breast" {
			continue
		}
		k := kindByName(t, c.kind)
		t.Run(c.kind+"/"+c.field, func(t *testing.T) {
			id := createOne(t, e, f, k)
			pr := e.patch(t, f.token, k, id, map[string]any{c.field: ""})
			mustStatus(t, pr, http.StatusOK)
			if v, ok := obj(t, pr)[c.field]; ok {
				t.Errorf("%s should be cleared by \"\", got %v", c.field, v)
			}
		})
	}
}

func TestMergePatch_Photo(t *testing.T) {
	e := newEnv(t)
	f := newFixture(t, e)
	withPhoto := func(k kind) string {
		r := e.create(t, f.token, f.baby, k, merge(k.sample(fixedAt),
			map[string]any{"photo": b64(photoPNG), "photo_mime": "image/png"}))
		mustStatus(t, r, http.StatusCreated)
		return fmt.Sprint(obj(t, r)["id"])
	}
	for _, k := range allKinds() {
		if !k.photo {
			continue
		}
		t.Run(k.name, func(t *testing.T) {
			t.Run("absent keeps", func(t *testing.T) {
				id := withPhoto(k)
				pr := e.patch(t, f.token, k, id, map[string]any{})
				mustStatus(t, pr, http.StatusOK)
				expectField(t, obj(t, pr), "has_photo", true)
			})
			t.Run("null clears photo and mime", func(t *testing.T) {
				id := withPhoto(k)
				pr := e.patch(t, f.token, k, id, map[string]any{"photo": nil})
				mustStatus(t, pr, http.StatusOK)
				got := obj(t, pr)
				expectField(t, got, "has_photo", false)
				if _, ok := got["photo_mime"]; ok {
					t.Errorf("photo_mime should be cleared")
				}
			})
			t.Run("empty string clears", func(t *testing.T) {
				id := withPhoto(k)
				pr := e.patch(t, f.token, k, id, map[string]any{"photo": ""})
				mustStatus(t, pr, http.StatusOK)
				expectField(t, obj(t, pr), "has_photo", false)
			})
			t.Run("value sets", func(t *testing.T) {
				id := withPhoto(k)
				pr := e.patch(t, f.token, k, id, map[string]any{"photo": b64(photoJPEG), "photo_mime": "image/jpeg"})
				mustStatus(t, pr, http.StatusOK)
				expectField(t, obj(t, pr), "photo_mime", "image/jpeg")
			})
			t.Run("null photo with non-null mime is 422", func(t *testing.T) {
				id := withPhoto(k)
				wantErr(t, e.patch(t, f.token, k, id,
					map[string]any{"photo": nil, "photo_mime": "image/png"}), 422, "validation_failed")
			})
		})
	}
}

func TestMergePatch_ClearFlagsRemoved(t *testing.T) {
	e := newEnv(t)
	f := newFixture(t, e)
	flags := map[string]string{
		"solid": "clear_amount_g", "pumping": "clear_duration_seconds",
		"growth": "clear_weight_g", "sleep": "clear_sleep_type", "nursing": "clear_starting_breast",
	}
	for kn, flag := range flags {
		k := kindByName(t, kn)
		t.Run(flag, func(t *testing.T) {
			id := createOne(t, e, f, k)
			wantErr(t, e.patch(t, f.token, k, id, map[string]any{flag: true}), 400, "bad_request")
		})
	}
	for _, flag := range []string{"clear_height_cm", "clear_head_circumference_cm"} {
		t.Run(flag, func(t *testing.T) {
			k := kindByName(t, "growth")
			id := createOne(t, e, f, k)
			wantErr(t, e.patch(t, f.token, k, id, map[string]any{flag: true}), 400, "bad_request")
		})
	}
}

func TestMergePatch_NullOnNonClearable(t *testing.T) {
	e := newEnv(t)
	f := newFixture(t, e)
	cases := []struct{ kind, field string }{
		{"bottlefeed", "occurred_at"}, {"bottlefeed", "milk_source"}, {"bottlefeed", "amount_ml"},
		{"diaper", "occurred_at"}, {"diaper", "type"},
		{"pumping", "occurred_at"}, {"pumping", "amount_ml"},
		{"nursing", "started_at"}, {"nursing", "ended_at"}, {"nursing", "nursing_side"},
		{"nursing", "left_duration_s"}, {"nursing", "right_duration_s"},
		{"growth", "measured_at"},
		{"sleep", "started_at"}, {"sleep", "ended_at"},
		{"note", "occurred_at"}, {"note", "body"},
		{"solid", "occurred_at"}, {"solid", "foods"},
	}
	for _, c := range cases {
		k := kindByName(t, c.kind)
		t.Run(c.kind+"/"+c.field, func(t *testing.T) {
			id := createOne(t, e, f, k)
			pr := e.patch(t, f.token, k, id, map[string]any{c.field: nil})
			wantErr(t, pr, 422, "validation_failed")
			// The row is untouched and still closed.
			if k.openSample != nil {
				got := e.call(t, http.MethodGet, "/v1/babies/"+f.baby+"/"+k.path+"/open", f.token, nil)
				mustStatus(t, got, http.StatusNoContent)
			}
		})
	}
}

func TestMergePatch_GrowthNeedsOneMeasurement(t *testing.T) {
	e := newEnv(t)
	f := newFixture(t, e)
	k := kindByName(t, "growth")
	id := createOne(t, e, f, k)
	wantErr(t, e.patch(t, f.token, k, id, map[string]any{
		"weight_g": nil, "height_cm": nil, "head_circumference_cm": nil,
	}), 422, "validation_failed")
	// Clearing two while keeping one is fine.
	pr := e.patch(t, f.token, k, id, map[string]any{"weight_g": nil, "height_cm": nil})
	mustStatus(t, pr, http.StatusOK)
	expectField(t, obj(t, pr), "head_circumference_cm", 35.5)
}
