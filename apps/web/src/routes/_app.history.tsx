// History has been folded into the Charts screen — charts on top, the
// day-grouped event log below (see _app.charts.tsx). This route stays
// as a redirect so old links and bookmarks to /history keep working.
import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/history")({
  beforeLoad: () => {
    throw redirect({ to: "/charts" });
  },
});
