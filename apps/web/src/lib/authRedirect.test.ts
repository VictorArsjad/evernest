// Unit tests for the route-layout redirect contract. Pure helpers, so
// no jsdom is needed (vitest is intentionally node-only — see
// vitest.config.ts). The wired `useEffect` in _app.tsx / _auth.tsx is
// trivial glue that drops these decisions into `useNavigate`; covering
// the decisions here keeps the route files thin and the test surface
// framework-agnostic.
import { describe, expect, it } from "vitest";

import { anonSurfaceRedirect, authedSurfaceRedirect } from "./authRedirect";

describe("authedSurfaceRedirect (_app surface)", () => {
  it("bounces an anonymous user to /login", () => {
    expect(authedSurfaceRedirect("anonymous")).toBe("/login");
  });

  it("leaves an authenticated user where they are", () => {
    expect(authedSurfaceRedirect("authenticated")).toBeNull();
  });

  it("does not redirect during initialization (the splash covers it)", () => {
    // This is load-bearing: without it, a hard refresh of /_app/*
    // would briefly flicker to /login while bootstrapAuth() is
    // still in flight, even when the user is actually about to be
    // authenticated.
    expect(authedSurfaceRedirect("initializing")).toBeNull();
  });
});

describe("anonSurfaceRedirect (_auth surface)", () => {
  it("bounces an authenticated user to /", () => {
    expect(anonSurfaceRedirect("authenticated")).toBe("/");
  });

  it("leaves an anonymous user where they are", () => {
    expect(anonSurfaceRedirect("anonymous")).toBeNull();
  });

  it("does not redirect during initialization", () => {
    expect(anonSurfaceRedirect("initializing")).toBeNull();
  });
});
