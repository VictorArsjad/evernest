import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { z } from "zod";

import { useAcceptInvite, useLogin } from "../lib/queries";

// `?next` is a relative path. We only act on it when it points at
// `/invite/{token}`, which is the only post-auth deep-link the FE
// currently has. Future destinations can opt in by extending the schema.
const loginSearchSchema = z.object({
  next: z.string().optional(),
});

export const Route = createFileRoute("/_auth/login")({
  component: LoginPage,
  validateSearch: loginSearchSchema,
});

function LoginPage() {
  const nav = useNavigate();
  const { next } = Route.useSearch();
  const login = useLogin();
  const acceptInvite = useAcceptInvite();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const inviteToken = inviteTokenFromNext(next);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    login.mutate(
      { email: email.trim(), password },
      {
        onSuccess: () => {
          // If the user arrived from an invite link, finish the redemption
          // before bouncing to Today. We swallow accept errors here on
          // purpose — if the token is now invalid (race with revoke /
          // expiry) the user lands on Today and can re-click the link to
          // see the canonical "invalid invite" message.
          if (inviteToken) {
            acceptInvite.mutate(
              { token: inviteToken },
              {
                onSettled: () => nav({ to: "/" }),
              },
            );
            return;
          }
          nav({ to: "/" });
        },
      },
    );
  };

  return (
    <form onSubmit={onSubmit} className="card flex flex-col gap-4 p-6">
      <h2 className="text-xl font-semibold">Sign in</h2>
      {inviteToken && (
        <p className="rounded-xl bg-bg-subtle px-3 py-2 text-xs text-white/70">
          You'll join the inviting household after sign-in.
        </p>
      )}
      <label className="flex flex-col gap-1 text-sm">
        Email
        <input
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="rounded-xl bg-bg-subtle px-4 py-3 text-base outline-none focus:ring-2 focus:ring-accent"
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Password
        <input
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="rounded-xl bg-bg-subtle px-4 py-3 text-base outline-none focus:ring-2 focus:ring-accent"
        />
      </label>
      {login.isError && (
        <p className="text-sm text-red-400">{login.error?.message ?? "login failed"}</p>
      )}
      <button type="submit" className="btn-primary" disabled={login.isPending || acceptInvite.isPending}>
        {login.isPending || acceptInvite.isPending ? "Signing in…" : "Sign in"}
      </button>
      <p className="text-center text-sm text-white/60">
        New here?{" "}
        <Link
          to="/register"
          search={next ? { next } : undefined}
          className="text-accent underline-offset-2 hover:underline"
        >
          Create an account
        </Link>
      </p>
    </form>
  );
}

// inviteTokenFromNext extracts the token from `/invite/{token}` without
// the FE having to parse arbitrary URLs. Anything else returns null and
// the post-login redirect falls through to "/".
function inviteTokenFromNext(next: string | undefined): string | null {
  if (!next) return null;
  const match = next.match(/^\/invite\/([A-Za-z0-9_-]+)$/);
  return match ? match[1] : null;
}
