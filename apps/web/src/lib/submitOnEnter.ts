import type { KeyboardEvent } from "react";

export function submitOnEnter(e: KeyboardEvent<HTMLFormElement>) {
  const target = e.target;
  if (e.key !== "Enter") return;
  if (target instanceof HTMLButtonElement) return;
  if (target instanceof HTMLTextAreaElement) return;
  if (target instanceof HTMLInputElement && target.type === "file") return;
  e.preventDefault();
  e.currentTarget.requestSubmit();
}
