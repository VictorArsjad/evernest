// @vitest-environment jsdom
// Proves the opt-in jsdom + Testing Library setup works. Component/hook tests
// add the pragma above per-file; the default environment stays `node`.
import { useState } from "react";
import { act, render, renderHook, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

describe("jsdom test environment", () => {
  it("renders a component into a DOM", () => {
    render(<p>hello jsdom</p>);
    expect(screen.getByText("hello jsdom")).toBeTruthy();
    expect(document.body.textContent).toContain("hello jsdom");
  });

  it("runs hooks via renderHook", () => {
    const { result } = renderHook(() => useState(1));
    act(() => result.current[1](2));
    expect(result.current[0]).toBe(2);
  });
});
