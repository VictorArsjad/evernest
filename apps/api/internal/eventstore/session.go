package eventstore

import "time"

// SessionPatch builds the PATCH for start-now/end-later kinds. The row's
// ended_at picks the contract: NULL means PATCH closes the session (body E),
// non-NULL means PATCH edits a closed session (body X). The WHERE guards keep
// a concurrent close from flipping the row between lookup and UPDATE.
type SessionPatch[E, X any] struct {
	Noun  string
	Close func(req *E) SessionClose
	Edit  func(req *X) SessionEdit
}

// SessionClose is what a kind's Close hook returns: the SET (args from $2)
// and the new ended_at.
type SessionClose struct {
	Set     *Set
	EndedAt time.Time
}

// SessionEdit is what a kind's Edit hook returns: the SET (args from $2) and
// the requested started_at / ended_at (nil = unchanged).
type SessionEdit struct {
	Set       *Set
	StartedAt *time.Time
	EndedAt   *time.Time
}

// Patch returns a fresh Patch for one request.
func (s SessionPatch[E, X]) Patch() Patch {
	var (
		startedAt time.Time
		endedAt   *time.Time
		endReq    E
		editReq   X
	)
	return Patch{
		State: "started_at, ended_at",
		Dest:  []any{&startedAt, &endedAt},
		Body: func() any {
			if endedAt == nil {
				return &endReq
			}
			return &editReq
		},
		Build: func() (Update, *Problem) {
			if endedAt == nil {
				c := s.Close(&endReq)
				if c.EndedAt.Before(startedAt) {
					return Update{}, Invalid("ended_at must be >= started_at")
				}
				return Update{
					Set:     c.Set.SQL(),
					Args:    c.Set.Args(),
					Where:   "AND ended_at IS NULL",
					NoRows:  Conflict("already_closed", s.Noun+" is already closed"),
					FailMsg: "could not close " + s.Noun,
				}, nil
			}
			e := s.Edit(&editReq)
			// Either field may be omitted: substitute the stored value.
			effStart, effEnd := startedAt, *endedAt
			if e.StartedAt != nil {
				effStart = *e.StartedAt
			}
			if e.EndedAt != nil {
				effEnd = *e.EndedAt
			}
			if effEnd.Before(effStart) {
				return Update{}, Invalid("ended_at must be >= started_at")
			}
			return Update{
				Set:    e.Set.SQL(),
				Args:   e.Set.Args(),
				Where:  "AND ended_at IS NOT NULL",
				NoRows: Conflict("session_state_changed", s.Noun+" state changed; refetch and retry"),
			}, nil
		},
	}
}
