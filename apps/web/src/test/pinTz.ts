// Pins the test timezone to Asia/Jakarta (UTC+7, no DST) for the route freeze
// tests.
//
// Import this module FIRST in a freeze test file. ES imports evaluate in
// order, and the routes read the zone once at module load (`BROWSER_TZ` in
// _app.index.tsx and _app.charts.tsx), so the pin must land before they load.
// Node re-reads TZ when it is assigned at runtime, so a plain assignment is
// enough; no npm script or environment variable is needed.
process.env.TZ = "Asia/Jakarta";

export {};
