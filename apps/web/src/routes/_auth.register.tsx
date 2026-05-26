import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { z } from "zod";

import { useAcceptInvite, useRegister } from "../lib/queries";

const registerSearchSchema = z.object({
  next: z.string().optional(),
});

export const Route = createFileRoute("/_auth/register")({
  component: RegisterPage,
  validateSearch: registerSearchSchema,
});

function RegisterPage() {
  const nav = useNavigate();
  const { next } = Route.useSearch();
  const register = useRegister();
  const acceptInvite = useAcceptInvite();
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");

  const inviteToken = inviteTokenFromNext(next);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    register.mutate(
      { email: email.trim(), display_name: displayName.trim(), password },
      {
        onSuccess: () => {
          if (inviteToken) {
            // After auto-accept land on Today rather than onboarding;
            // the household + baby already exist on the owner's side, so
            // we don't want the new joiner to be funneled into "create
            // your first household".
            acceptInvite.mutate(
              { token: inviteToken },
              {
                onSettled: () => nav({ to: "/" }),
              },
            );
            return;
          }
          nav({ to: "/onboarding" });
        },
      },
    );
  };

  return (
    <form onSubmit={onSubmit} className="card flex flex-col gap-4 p-6">
      <h2 className="text-xl font-semibold">Create your account</h2>
      {inviteToken && (
        <p className="rounded-xl bg-bg-subtle px-3 py-2 text-xs text-white/70">
          You'll join the inviting household after sign-up.
        </p>
      )}
      <label className="flex flex-col gap-1 text-sm">
        Your name
        <input
          required
          minLength={1}
          maxLength={80}
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          className="rounded-xl bg-bg-subtle px-4 py-3 text-base outline-none focus:ring-2 focus:ring-accent"
        />
      </label>
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
          autoComplete="new-password"
          required
          minLength={8}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="rounded-xl bg-bg-subtle px-4 py-3 text-base outline-none focus:ring-2 focus:ring-accent"
        />
        <span className="text-xs text-white/40">Minimum 8 characters.</span>
      </label>
      {register.isError && (
        <p className="text-sm text-red-400">{register.error?.message ?? "registration failed"}</p>
      )}
      <button
        type="submit"
        className="btn-primary"
        disabled={register.isPending || acceptInvite.isPending}
      >
        {register.isPending || acceptInvite.isPending ? "Creating account…" : "Create account"}
      </button>
      <p className="text-center text-sm text-white/60">
        Have an account?{" "}
        <Link
          to="/login"
          search={next ? { next } : undefined}
          className="text-accent underline-offset-2 hover:underline"
        >
          Sign in
        </Link>
      </p>
    </form>
  );
}

function inviteTokenFromNext(next: string | undefined): string | null {
  if (!next) return null;
  const match = next.match(/^\/invite\/([A-Za-z0-9_-]+)$/);
  return match ? match[1] : null;
}
