// Package eventpatch hosts cross-kind integration tests for the PATCH
// endpoints across bottle_feeds, diapers, pumpings, and growths. Nursing
// has its own dedicated test file because its PATCH dispatches between
// close-open-session and edit-closed-session paths.
//
// This package has no non-test files; the package declaration here keeps
// `go test ./...` happy and gives the integration tests a stable home.
package eventpatch
