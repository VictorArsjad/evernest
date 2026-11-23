package testutil

import "testing"

// fakeTB records which terminal method SkipOrFail chose. Like the real
// testing.T, Fatalf/Skipf end the calling goroutine (here via panic).
type fakeTB struct {
	testing.TB
	failed, skipped bool
}

type stop struct{}

func (f *fakeTB) Helper() {}
func (f *fakeTB) Fatalf(string, ...any) {
	f.failed = true
	panic(stop{})
}
func (f *fakeTB) Skipf(string, ...any) {
	f.skipped = true
	panic(stop{})
}

func run(f *fakeTB) {
	defer func() { _ = recover() }()
	SkipOrFail(f, "boom %d", 1)
}

func TestSkipOrFail(t *testing.T) {
	t.Run("CI=true fails", func(t *testing.T) {
		t.Setenv("CI", "true")
		f := &fakeTB{}
		run(f)
		if !f.failed || f.skipped {
			t.Fatalf("failed=%v skipped=%v, want fail only", f.failed, f.skipped)
		}
	})
	t.Run("CI unset skips", func(t *testing.T) {
		t.Setenv("CI", "")
		f := &fakeTB{}
		run(f)
		if f.failed || !f.skipped {
			t.Fatalf("failed=%v skipped=%v, want skip only", f.failed, f.skipped)
		}
	})
}
