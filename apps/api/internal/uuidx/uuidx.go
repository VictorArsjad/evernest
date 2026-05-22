// Package uuidx wraps github.com/google/uuid with a couple of helpers our
// codebase needs frequently: UUIDv7 generation for event ids (time-ordered,
// safe for client-supplied idempotency) and a safe parse that returns a
// stable zero value on error.
package uuidx

import "github.com/google/uuid"

// NewV7 returns a UUIDv7 or panics on the (effectively impossible) RNG failure
// case. UUIDv7 is the right choice for event ids because:
//   - it's time-ordered, so primary-key indexes stay write-friendly;
//   - the client can generate it offline and the server can accept it as the
//     row id without coordination.
func NewV7() uuid.UUID {
	id, err := uuid.NewV7()
	if err != nil {
		// crypto/rand failure on a healthy machine is effectively impossible.
		// Panicking is honest: we cannot continue safely.
		panic(err)
	}
	return id
}
