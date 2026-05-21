// One-screen onboarding: create the user's first household + baby.
// CP5 will introduce a household-picker UI; until then, the user has exactly
// one household and one baby and we route around that assumption.
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useAuthStore } from "../lib/authStore";
import {
  useBabies,
  useCreateBaby,
  useCreateHousehold,
  useHouseholds,
} from "../lib/queries";

export const Route = createFileRoute("/_app/onboarding")({
  component: OnboardingPage,
});

function OnboardingPage() {
  const nav = useNavigate();
  const user = useAuthStore((s) => s.user);

  const households = useHouseholds();
  const existing = households.data?.[0];
  const babies = useBabies(existing?.id ?? null);

  // If onboarding is already complete (household + at least one baby), go home.
  useEffect(() => {
    if (households.isSuccess && babies.isSuccess && babies.data.length > 0) {
      nav({ to: "/" });
    }
  }, [households.isSuccess, babies.isSuccess, babies.data, nav]);

  const defaultHouseholdName = user ? `${user.display_name}'s family` : "My family";
  const [householdName, setHouseholdName] = useState(defaultHouseholdName);
  const [babyName, setBabyName] = useState("");
  const [dob, setDob] = useState(""); // YYYY-MM-DD
  const [sex, setSex] = useState<"female" | "male" | "unspecified">("unspecified");

  // Keep household name in sync with the default if the user hasn't typed yet.
  useEffect(() => {
    if (user && householdName === "My family") {
      setHouseholdName(`${user.display_name}'s family`);
    }
  }, [user, householdName]);

  const createHousehold = useCreateHousehold();
  const createBaby = useCreateBaby();

  const error =
    createHousehold.error?.message ?? createBaby.error?.message ?? null;
  const isPending = createHousehold.isPending || createBaby.isPending;

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const household =
        existing ?? (await createHousehold.mutateAsync({ name: householdName.trim() }));
      await createBaby.mutateAsync({
        householdId: household.id,
        name: babyName.trim(),
        date_of_birth: dob || undefined,
        sex,
      });
      nav({ to: "/" });
    } catch {
      // surfaced via the error block below
    }
  };

  return (
    <main className="flex flex-1 flex-col gap-4 p-5">
      <header>
        <h1 className="text-2xl font-semibold">Set things up</h1>
        <p className="mt-1 text-sm text-white/60">
          Just two quick details and you're in.
        </p>
      </header>

      <form onSubmit={onSubmit} className="card flex flex-col gap-4 p-5">
        <label className="flex flex-col gap-1 text-sm">
          Household name
          <input
            required
            value={householdName}
            onChange={(e) => setHouseholdName(e.target.value)}
            className="rounded-xl bg-bg-subtle px-4 py-3 text-base outline-none focus:ring-2 focus:ring-accent"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Baby name
          <input
            required
            value={babyName}
            onChange={(e) => setBabyName(e.target.value)}
            className="rounded-xl bg-bg-subtle px-4 py-3 text-base outline-none focus:ring-2 focus:ring-accent"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Date of birth
          <input
            type="date"
            value={dob}
            onChange={(e) => setDob(e.target.value)}
            className="rounded-xl bg-bg-subtle px-4 py-3 text-base outline-none focus:ring-2 focus:ring-accent"
          />
        </label>
        <fieldset className="flex flex-col gap-1 text-sm">
          <legend>Sex</legend>
          <div className="grid grid-cols-3 gap-2 pt-1">
            {(["female", "male", "unspecified"] as const).map((opt) => (
              <button
                type="button"
                key={opt}
                onClick={() => setSex(opt)}
                className={
                  "rounded-xl border px-3 py-2 text-sm capitalize " +
                  (sex === opt
                    ? "border-accent bg-accent/15 text-accent"
                    : "border-white/10 bg-bg-subtle text-white/70")
                }
              >
                {opt}
              </button>
            ))}
          </div>
        </fieldset>
        {error && <p className="text-sm text-red-400">{error}</p>}
        <button type="submit" className="btn-primary" disabled={isPending || !babyName.trim()}>
          {isPending ? "Saving…" : "Continue"}
        </button>
      </form>
    </main>
  );
}
