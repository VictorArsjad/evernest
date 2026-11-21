// Vitest is configured separately from `vite.config.ts` so test runs do not
// instantiate the PWA plugin. Default environment is `node`; component/hook
// tests opt in per file with `// @vitest-environment jsdom`.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    // outbox.test.ts polls with its own waitFor() up to 8s on loaded CI
    // runners (see that file). Vitest's 5s default per-test timeout would
    // otherwise fire first and mask the real wait — keep this comfortably
    // above waitFor's ceiling.
    testTimeout: 15000,
  },
});
