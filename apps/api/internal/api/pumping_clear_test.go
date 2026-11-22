package api_test

import (
	"fmt"
	"net/http"
	"testing"
)

func TestPumpingPatch_ClearDurationSeconds(t *testing.T) {
	e := newEnv(t)
	f := newFixture(t, e)
	k := kindByName(t, "pumping")
	create := func() string {
		r := e.create(t, f.token, f.baby, k, k.sample(fixedAt))
		mustStatus(t, r, http.StatusCreated)
		return fmt.Sprint(obj(t, r)["id"])
	}

	t.Run("clears duration and leaves other fields", func(t *testing.T) {
		id := create()
		pr := e.patch(t, f.token, k, id, map[string]any{"clear_duration_seconds": true})
		mustStatus(t, pr, http.StatusOK)
		got := obj(t, pr)
		if _, ok := got["duration_seconds"]; ok {
			t.Errorf("duration_seconds should be cleared, got %v", got["duration_seconds"])
		}
		expectField(t, got, "amount_ml", float64(90))
	})

	t.Run("clear with a value is rejected", func(t *testing.T) {
		id := create()
		wantErr(t, e.patch(t, f.token, k, id,
			map[string]any{"clear_duration_seconds": true, "duration_seconds": 60}), 400, "bad_request")
	})

	t.Run("false flag is a no-op", func(t *testing.T) {
		id := create()
		pr := e.patch(t, f.token, k, id, map[string]any{"clear_duration_seconds": false, "amount_ml": 100})
		mustStatus(t, pr, http.StatusOK)
		expectField(t, obj(t, pr), "duration_seconds", float64(900))
	})
}
