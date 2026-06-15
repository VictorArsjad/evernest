//go:build !embedspa

package spa

import "net/http"

// Enabled reports whether the SPA was embedded at build time. It is false
// for tag-free builds (local dev, CI, tests) so the API never needs the
// web artifact to compile. Callers must gate on Enabled before using
// Handler.
const Enabled = false

// Handler returns nil in tag-free builds; never call it without checking
// Enabled first.
func Handler() http.Handler { return nil }
