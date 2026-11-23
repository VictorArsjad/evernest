// Package testutil holds helpers shared by DB-backed tests. It is imported
// only from _test.go files and so never compiles into a production binary.
package testutil

import (
	"os"
	"testing"
)

// SkipOrFail skips the test locally when a dependency (e.g. Postgres) is
// unavailable, but fails it when CI=true so a broken CI service can never
// pass silently.
func SkipOrFail(t testing.TB, format string, args ...any) {
	t.Helper()
	if os.Getenv("CI") == "true" {
		t.Fatalf(format, args...)
	}
	t.Skipf(format, args...)
}
