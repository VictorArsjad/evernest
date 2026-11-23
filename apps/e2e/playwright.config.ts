import { defineConfig, devices } from "@playwright/test";

// Keep in sync with scripts/env.sh.
const port = process.env.E2E_PORT ?? "8090";
const origin = `http://localhost:${port}`;
const isCI = !!process.env.CI;

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  workers: isCI ? 2 : undefined,
  reporter: isCI
    ? [["list"], ["github"], ["html", { open: "never" }]]
    : [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: origin,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [
    { name: "chromium", use: { ...devices["Pixel 7"] } },
    {
      name: "firefox",
      use: {
        ...devices["Desktop Firefox"],
        viewport: { width: 412, height: 915 },
        hasTouch: false,
      },
    },
    { name: "webkit", use: { ...devices["iPhone 15"] } },
  ],
  webServer: {
    // Binary is built by scripts/build.sh (make e2e / CI); DB by scripts/db.sh.
    command: "bash -c '. scripts/env.sh && exec ../api/bin/e2e-server'",
    url: `${origin}/healthz`,
    reuseExistingServer: !isCI,
    timeout: 60_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});

