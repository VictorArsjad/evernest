// Public redeem route for link-based household invites.
//
// Sits at /invite/{token} OUTSIDE both the `_app` and `_auth` pathless
// layouts. We want a single URL that works equally well for:
//   - an authenticated user (renders the "Join {household} as {role}?"
//     confirmation and a one-click Accept button)
//   - an anonymous user (renders sign-in / register links, both carrying
//     ?next=/invite/{token} so they auto-redirect into accept after the
//     session lands)
//
// Putting this under `_auth` would force the existing "redirect away
// from auth screens if already logged in" guard onto invite links, and
// putting it under `_app` would force-login the user before they even
// see what they're being invited to. A top-level route avoids both
// traps.
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { format, parseISO } from "date-fns";

import { useAuthStore } from "../lib/authStore";
import { useAcceptInvite, useInviteInfo } from "../lib/queries";

export const Route = createFileRoute("/invite/$token")({
  component: InviteRedeemPage,
});

function InviteRedeemPage() {
  const { token } = Route.useParams();
  const nav = useNavigate();
  const status = useAuthStore((s) => s.status);
  const info = useInviteInfo(token);
  const accept = useAcceptInvite();

  // While the auth bootstrap is still in-flight on a hard reload, render
  // a neutral loading state rather than the "sign in or register" panel
  // — otherwise an already-signed-in user lands on the login affordance
  // for ~150ms before snapping over to the Accept button.
  if (status === "initializing" || info.isLoading) {
    return (
      <PageShell title="Invite">
        <p className="text-sm text-white/60">Loading…</p>
      </PageShell>
    );
  }

  if (info.isError || !info.data) {
    // Treat every failure mode (404 / 401 / 500 / network) identically.
    // The BE returns 404 for unknown / used / expired / tampered tokens;
    // we don't want the UI to leak which condition matched either.
    return (
      <PageShell title="Invite">
        <p className="text-sm text-white/80">
          This invite link is invalid or has expired.
        </p>
        <p className="mt-3 text-xs text-white/50">
          Ask the household owner to send you a fresh link.
        </p>
        <Link to="/" className="btn-primary mt-6 inline-block text-center">
          Back to Evernest
        </Link>
      </PageShell>
    );
  }

  const { household_name, role, expires_at } = info.data;
  const expiry = format(parseISO(expires_at), "MMM d, h:mm a");

  if (status !== "authenticated") {
    // Preserve the invite token through the auth flow so a fresh login or
    // signup auto-completes the redemption. The login/register pages read
    // the `next` query and call accept on success.
    const next = `/invite/${token}`;
    return (
      <PageShell title={`Join ${household_name}`}>
        <p className="text-sm text-white/80">
          You're invited to join <strong>{household_name}</strong> as{" "}
          <span className="capitalize">{role}</span>.
        </p>
        <p className="mt-2 text-xs text-white/50">Link expires {expiry}.</p>
        <div className="mt-6 flex flex-col gap-3">
          <Link
            to="/login"
            search={{ next }}
            className="btn-primary text-center"
          >
            Sign in to accept
          </Link>
          <Link
            to="/register"
            search={{ next }}
            className="rounded-xl border border-white/10 px-4 py-3 text-center text-sm text-white/80 hover:bg-white/5"
          >
            Create an account
          </Link>
        </div>
      </PageShell>
    );
  }

  // Authenticated: one-click accept.
  const onAccept = () => {
    accept.mutate(
      { token },
      {
        onSuccess: () => nav({ to: "/" }),
      },
    );
  };

  return (
    <PageShell title={`Join ${household_name}`}>
      <p className="text-sm text-white/80">
        You're joining <strong>{household_name}</strong> as{" "}
        <span className="capitalize">{role}</span>.
      </p>
      <p className="mt-2 text-xs text-white/50">Link expires {expiry}.</p>
      {accept.isError && (
        <p className="mt-3 text-sm text-red-400">
          {accept.error?.message ?? "Could not accept invite. Try again."}
        </p>
      )}
      <button
        type="button"
        onClick={onAccept}
        disabled={accept.isPending}
        className="btn-primary mt-6 w-full"
      >
        {accept.isPending ? "Joining…" : `Accept invite`}
      </button>
      <Link to="/" className="mt-3 block text-center text-xs text-white/50">
        Not now
      </Link>
    </PageShell>
  );
}

function PageShell({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <main className="flex flex-1 flex-col items-stretch justify-center p-6">
      <div className="mb-8 text-center">
        <h1 className="text-4xl font-semibold tracking-tight">Evernest</h1>
        <p className="mt-1 text-sm text-white/60">Multi-caregiver baby tracking.</p>
      </div>
      <section className="card flex flex-col gap-2 p-6">
        <h2 className="text-xl font-semibold">{title}</h2>
        {children}
      </section>
    </main>
  );
}
