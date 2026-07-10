// Test-only mutable status holder for AuthGate.test.tsx. Lives in its
// own module so vi.mock("../lib/authStore") can `await import()` it
// inside the factory (hoisted-vi.mock factories cannot close over
// in-file variables). Not imported anywhere outside the test.
export type AuthStatus = "initializing" | "authenticated" | "anonymous" | "error";

let current: AuthStatus = "initializing";

export function getAuthStatusForTest(): AuthStatus {
  return current;
}

export function setAuthStatusForTest(status: AuthStatus): void {
  current = status;
}
