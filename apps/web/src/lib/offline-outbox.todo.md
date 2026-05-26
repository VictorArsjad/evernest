# Offline mutation outbox — deferred to CP6b

CP6 was split into two halves so the PWA install polish (CP6a) could
land before CP5 (invites + multi-baby) lengthens the mutation surface.
This file is a placeholder so the codepath is discoverable in search
when CP6b picks it up.

## Out of scope for CP6a (this PR)

- IndexedDB outbox for failed/queued mutations.
- Background Sync registration / replay loop.
- UI affordances ("3 changes will sync when you're back online").
- Conflict-resolution policy for mutations that fail server-side after
  a successful enqueue.

## Why split

CP5 is adding invites + multi-baby switching, which:

- Introduces several new POST/PUT endpoints we'd want the outbox to
  cover (invite redeem, active-baby selection).
- Touches `lib/queries.ts` mutation registration heavily.

Landing the outbox now would mean two large refactors of the same
surface within a day. Better to let CP5 stabilize the mutation set,
then wrap the final shape once in CP6b.

## Where the outbox will plug in

- New `apps/web/src/lib/outbox/` directory: IDB schema, enqueue,
  replay, retry/backoff.
- `lib/api.ts` becomes the single chokepoint that decides "online →
  fire now" vs "offline → enqueue, return optimistic result".
- A `BackgroundSync` registration in the SW (which `vite-plugin-pwa`
  already configures for us) wakes the replay loop when connectivity
  returns.

## Definition of done for CP6b

- All write endpoints (bottle, diaper, pumping, nursing start/end,
  growth, prefs, settings) survive an airplane-mode round-trip.
- A simple counter UI shows pending-mutation count.
- Replay is idempotent (client-generated UUIDs are already in place
  from CP1, so this is mostly enforcement at the wrapper layer).
