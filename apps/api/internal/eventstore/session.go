package eventstore

import "time"

// SessionPatch builds the PATCH for start-now/end-later kinds. The row's
// ended_at picks the contract: NULL means PATCH closes the session (body E),
// non-NULL means PATCH edits a closed session (body X). The WHERE guards keep
// a concurrent close from flipping the row between lookup and UPDATE.
type SessionPatch[E, X any] struct {
	Noun string
	// Close returns the SET clause, its args ($2...) and the new ended_at.
	Close func(req *E) (set string, args []any, endedAt time.Time)
	// Edit returns the SET clause, its args ($2...) and the requested
	// started_at / ended_at (nil = unchanged).
	Edit func(req *X) (set string, args []any, startedAt, endedAt *time.Time)
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
				set, args, end := s.Close(&endReq)
				if end.Before(startedAt) {
					return Update{}, Invalid("ended_at must be >= started_at")
				}
				return Update{
					Set:     set,
					Args:    args,
					Where:   "AND ended_at IS NULL",
					NoRows:  Conflict("already_closed", s.Noun+" is already closed"),
					FailMsg: "could not close " + s.Noun,
				}, nil
			}
			set, args, start, end := s.Edit(&editReq)
			// Either field may be omitted: substitute the stored value.
			effStart, effEnd := startedAt, *endedAt
			if start != nil {
				effStart = *start
			}
			if end != nil {
				effEnd = *end
			}
			if effEnd.Before(effStart) {
				return Update{}, Invalid("ended_at must be >= started_at")
			}
			return Update{
				Set:    set,
				Args:   args,
				Where:  "AND ended_at IS NOT NULL",
				NoRows: Conflict("session_state_changed", s.Noun+" state changed; refetch and retry"),
			}, nil
		},
	}
}
