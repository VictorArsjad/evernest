// Vitest is configured separately from `vite.config.ts` so test runs don't
// instantiate the PWA plugin (and don't need a browser-like environment for
// pure-logic tests). Add `environment: "jsdom"` here if React component
// tests land later.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
