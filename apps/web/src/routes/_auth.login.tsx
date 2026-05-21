import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useLogin } from "../lib/queries";

export const Route = createFileRoute("/_auth/login")({
  component: LoginPage,
});

function LoginPage() {
  const nav = useNavigate();
  const login = useLogin();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    login.mutate(
      { email: email.trim(), password },
      {
        onSuccess: () => nav({ to: "/" }),
      },
    );
  };

  return (
    <form onSubmit={onSubmit} className="card flex flex-col gap-4 p-6">
      <h2 className="text-xl font-semibold">Sign in</h2>
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
      <button type="submit" className="btn-primary" disabled={login.isPending}>
        {login.isPending ? "Signing in…" : "Sign in"}
      </button>
      <p className="text-center text-sm text-white/60">
        New here?{" "}
        <Link to="/register" className="text-accent underline-offset-2 hover:underline">
          Create an account
        </Link>
      </p>
    </form>
  );
}
