// Offline mutation outbox.
//
// CP6b — the final v1 slice. This module owns the client-side queue of
// pending mutations and the replay loop that drains them when the
// network comes back. The hard parts of offline-first (conflict
// resolution, eventual consistency) are already handled at the schema
// layer in this codebase:
//
//   - Every event id is generated client-side (UUIDv7-shaped via
//     `crypto.randomUUID()`); the BE accepts it as the row id.
//   - Every BE insert uses `INSERT ... ON CONFLICT (id) DO NOTHING`, so
//     replaying the same mutation N times produces the same row N=1.
//   - DELETE handlers return 204 on unknown ids, so a "delete then
//     replay" race is safe.
//
// What's left is a thin queue. Records live in IndexedDB so they
// survive a hard reload / browser restart. Sequential replay with
// exponential backoff keeps a 500-event drain after a long outage from
// slamming the API. The UI subscribes via a tiny pub/sub so the badge
// updates as records drain without polling.
//
// v1 uses foreground replay only — `sync()` is invoked on app mount, on
// the `window.online` event, and opportunistically after each
// successful drain step. Workbox's BackgroundSync plugin would let us
// drain a backgrounded tab too, but is a v2 follow-up: in practice
// users open the PWA, log an event, and either stay on the tab until
// drain or come back to it later; both cases work fine with foreground
// replay.

import {
  type DBSchema,
  type IDBPDatabase,
  openDB,
} from "idb";

// --- types ---

export type OutboxStatus = "pending" | "failed" | "dead";

export type OutboxMethod = "POST" | "PUT" | "PATCH" | "DELETE";

export interface OutboxRecord {
  // Monotonic IDB-assigned key. Records replay in FIFO order by this id.
  id: number;
  createdAt: number;
  method: OutboxMethod;
  path: string;
  body?: unknown;
  // Client-generated UUID for the underlying event row (UUIDv7 for
  // creates, the row id for deletes/updates). Used to dedupe a
  // re-submission of the same form before replay, and to mark Recent
  // rows as "syncing" in the UI.
  idempotencyKey: string;
  attempts: number;
  lastError?: string;
  lastAttemptAt?: number;
  // Status:
  //   pending — waiting to be sent (or waiting on its retry timer).
  //   failed — currently mid-backoff; will retry automatically.
  //   dead   — won't retry without user action (4xx, or 5xx past cap).
  status: OutboxStatus;
  // Earliest epoch-ms at which the next send attempt is allowed.
  nextAttemptAt?: number;
}

// Snapshot returned by peekQueue / getPending / getDead. Does not
// include the full row; consumers that need the raw record use
// peekQueue() directly.
export interface OutboxSnapshot {
  pending: OutboxRecord[];
  dead: OutboxRecord[];
}

// --- constants ---

const DB_NAME = "evernest";
const DB_VERSION = 1;
const STORE = "outbox";

// 8 attempts ≈ 2 + 4 + 8 + 16 + 32 + 60 + 60 + 60 = ~242s of backoff
// before we give up and mark dead. Tunable via setAttemptCap() for
// tests. Anything north of a couple minutes of 5xx-ing is almost
// certainly a real backend outage; surfacing it to the user is more
// useful than silent retries.
let attemptCap = 8;
let backoffBaseMs = 1000;
let backoffCeilingMs = 60_000;

// --- dispatcher injection ---
//
// The replay loop needs a way to actually send a record. We inject the
// dispatcher rather than importing `api()` directly to keep this module
// import-cycle-free (api.ts depends on outbox; outbox stays leaf) and
// to make tests trivial — swap in a programmable mock fetch.

export type DispatchResult =
  | { kind: "ok"; status: number; data: unknown }
  // 4xx (excluding 401). Caller error; retrying won't help. Mark dead.
  | { kind: "client_error"; status: number; message: string }
  // 401. Refresh already attempted by the dispatcher; if we're still
  // 401, leave the record pending — when the user re-auths, sync()
  // picks it back up. Don't increment attempts.
  | { kind: "auth_error"; status: 401; message?: string }
  // 5xx or network failure. Transient; bump attempts + schedule retry.
  | { kind: "transient"; status: number; message: string };

export type Dispatcher = (
  record: Pick<OutboxRecord, "method" | "path" | "body">,
) => Promise<DispatchResult>;

let dispatcher: Dispatcher | null = null;

export function setDispatcher(fn: Dispatcher | null): void {
  dispatcher = fn;
}

// Optional knob for tests: tighten the cap so a "give up after N tries"
// case doesn't have to actually wait the full ~4min backoff.
export function _setTestConfig(opts: {
  attemptCap?: number;
  backoffBaseMs?: number;
  backoffCeilingMs?: number;
}): void {
  if (opts.attemptCap !== undefined) attemptCap = opts.attemptCap;
  if (opts.backoffBaseMs !== undefined) backoffBaseMs = opts.backoffBaseMs;
  if (opts.backoffCeilingMs !== undefined) backoffCeilingMs = opts.backoffCeilingMs;
}

export function _resetTestConfig(): void {
  attemptCap = 8;
  backoffBaseMs = 1000;
  backoffCeilingMs = 60_000;
}

// --- pub/sub ---

const events = new EventTarget();
const CHANGE_EVENT = "outbox:change";
const DRAIN_EVENT = "outbox:drain";

export function onChange(listener: () => void): () => void {
  const h = () => listener();
  events.addEventListener(CHANGE_EVENT, h);
  return () => events.removeEventListener(CHANGE_EVENT, h);
}

// "drained" — N>0 items in queue at start of drain, now zero. Use to
// fire the "All caught up" toast exactly once per recovery, not on
// every routine empty-sync().
export function onDrained(listener: () => void): () => void {
  const h = () => listener();
  events.addEventListener(DRAIN_EVENT, h);
  return () => events.removeEventListener(DRAIN_EVENT, h);
}

function emitChange(): void {
  events.dispatchEvent(new Event(CHANGE_EVENT));
}

function emitDrained(): void {
  events.dispatchEvent(new Event(DRAIN_EVENT));
}

// --- IDB layer ---

interface OutboxSchema extends DBSchema {
  [STORE]: {
    key: number;
    value: OutboxRecord;
    indexes: {
      // Faster "any pending?" queries; not strictly required (the store
      // is small) but cheap and clear at the use-site.
      "by-status": OutboxStatus;
      "by-idempotency": string;
    };
  };
}

let dbPromise: Promise<IDBPDatabase<OutboxSchema>> | null = null;

function getDB(): Promise<IDBPDatabase<OutboxSchema>> {
  if (!dbPromise) {
    dbPromise = openDB<OutboxSchema>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        const store = db.createObjectStore(STORE, {
          keyPath: "id",
          autoIncrement: true,
        });
        store.createIndex("by-status", "status");
        store.createIndex("by-idempotency", "idempotencyKey");
      },
    });
  }
  return dbPromise;
}

// For tests — close + drop the connection so a fresh fake-indexeddb run
// starts from a clean slate.
export async function _resetForTests(): Promise<void> {
  if (dbPromise) {
    const db = await dbPromise;
    db.close();
    dbPromise = null;
  }
  draining = null;
  if (retryTimer !== null) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  // Best-effort wipe; ignore errors if indexedDB isn't available.
  try {
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase(DB_NAME);
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    });
  } catch {
    // ignore
  }
}

// --- queue inspection ---

export async function peekQueue(): Promise<OutboxRecord[]> {
  const db = await getDB();
  return db.getAll(STORE);
}

export async function getPending(): Promise<OutboxRecord[]> {
  const all = await peekQueue();
  return all
    .filter((r) => r.status === "pending" || r.status === "failed")
    .sort((a, b) => a.id - b.id);
}

export async function getDead(): Promise<OutboxRecord[]> {
  const all = await peekQueue();
  return all.filter((r) => r.status === "dead").sort((a, b) => a.id - b.id);
}

export async function snapshot(): Promise<OutboxSnapshot> {
  const all = await peekQueue();
  const pending: OutboxRecord[] = [];
  const dead: OutboxRecord[] = [];
  for (const r of all) {
    if (r.status === "dead") dead.push(r);
    else pending.push(r);
  }
  pending.sort((a, b) => a.id - b.id);
  dead.sort((a, b) => a.id - b.id);
  return { pending, dead };
}

// --- enqueue ---

export interface EnqueueInput {
  method: OutboxMethod;
  path: string;
  body?: unknown;
  idempotencyKey: string;
}

// Enqueue a mutation. If a record with the same idempotencyKey is
// already in flight (pending or failed-backoff), this is a no-op and
// returns the existing record. Lets a double-tap of "Save" coalesce
// rather than enqueueing duplicate sends.
export async function enqueueMutation(
  input: EnqueueInput,
): Promise<OutboxRecord> {
  const db = await getDB();
  const tx = db.transaction(STORE, "readwrite");
  const idx = tx.store.index("by-idempotency");
  const existing = await idx.get(input.idempotencyKey);
  if (existing && existing.status !== "dead") {
    await tx.done;
    // Opportunistically kick a drain in case the existing record was
    // stuck on a stale backoff timer.
    void sync();
    return existing;
  }
  if (existing && existing.status === "dead") {
    // Same key was previously marked dead. Resurrect it: caller
    // explicitly re-submitted, so they want us to try again.
    existing.status = "pending";
    existing.attempts = 0;
    existing.lastError = undefined;
    existing.lastAttemptAt = undefined;
    existing.nextAttemptAt = undefined;
    existing.method = input.method;
    existing.path = input.path;
    existing.body = input.body;
    await tx.store.put(existing);
    await tx.done;
    emitChange();
    void sync();
    return existing;
  }
  const record: Omit<OutboxRecord, "id"> = {
    createdAt: Date.now(),
    method: input.method,
    path: input.path,
    body: input.body,
    idempotencyKey: input.idempotencyKey,
    attempts: 0,
    status: "pending",
  };
  // autoIncrement: `add` returns the assigned key.
  const id = (await tx.store.add(record as OutboxRecord)) as number;
  await tx.done;
  const stored: OutboxRecord = { ...record, id };
  emitChange();
  void sync();
  return stored;
}

// --- replay loop ---

// We serialize drains so concurrent triggers (mount + window.online +
// post-enqueue) don't fan out into N parallel drains. If a drain is
// already in flight, the new caller awaits it. Within a drain, records
// are processed one-at-a-time (concurrency = 1) so a 500-record
// backlog post-outage doesn't slam the API.
let draining: Promise<void> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

export function sync(): Promise<void> {
  if (draining) return draining;
  draining = drainLoop().finally(() => {
    draining = null;
  });
  return draining;
}

async function drainLoop(): Promise<void> {
  if (!dispatcher) return;

  const startCount = (await getPending()).length;
  let drainedAny = false;

  // Loop until either the queue is empty of "ready" records (all
  // remaining are scheduled for the future), or we hit a record that
  // can't proceed right now (5xx + backoff window not yet elapsed).
  while (true) {
    const next = await pickNextReady();
    if (!next) {
      // Either the queue is empty or every pending record is waiting
      // on its backoff timer. Schedule a wake-up for the earliest
      // nextAttemptAt; the timer fires sync() again.
      await schedulePendingWake();
      break;
    }
    const handled = await processOne(next);
    if (handled) drainedAny = true;
    // Loop continues; next iteration picks the new front of the queue.
  }

  if (drainedAny && startCount > 0) {
    const remaining = await getPending();
    if (remaining.length === 0) emitDrained();
  }
}

async function pickNextReady(): Promise<OutboxRecord | null> {
  const pending = await getPending();
  const now = Date.now();
  for (const r of pending) {
    if (!r.nextAttemptAt || r.nextAttemptAt <= now) return r;
  }
  return null;
}

async function schedulePendingWake(): Promise<void> {
  const pending = await getPending();
  if (pending.length === 0) return;
  const now = Date.now();
  let earliest = Infinity;
  for (const r of pending) {
    const t = r.nextAttemptAt ?? now;
    if (t < earliest) earliest = t;
  }
  const delay = Math.max(0, earliest - now);
  if (retryTimer !== null) clearTimeout(retryTimer);
  // setTimeout fires sync() again when the earliest backoff elapses.
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void sync();
  }, delay);
}

// Returns true if the record was processed (not waiting on a timer).
async function processOne(record: OutboxRecord): Promise<boolean> {
  if (!dispatcher) return false;
  let result: DispatchResult;
  try {
    result = await dispatcher({
      method: record.method,
      path: record.path,
      body: record.body,
    });
  } catch (err) {
    // Defensive: dispatcher should never throw, but treat as transient
    // if it does.
    result = {
      kind: "transient",
      status: 0,
      message: (err as Error)?.message ?? "dispatcher threw",
    };
  }

  const db = await getDB();
  const tx = db.transaction(STORE, "readwrite");
  const fresh = await tx.store.get(record.id);
  if (!fresh) {
    // Record was removed between pick and dispatch (e.g. user
    // discarded it). Nothing to do.
    await tx.done;
    return true;
  }

  switch (result.kind) {
    case "ok": {
      await tx.store.delete(record.id);
      break;
    }
    case "client_error": {
      fresh.status = "dead";
      fresh.lastError = `${result.status}: ${result.message}`;
      fresh.lastAttemptAt = Date.now();
      fresh.attempts += 1;
      await tx.store.put(fresh);
      break;
    }
    case "auth_error": {
      // Don't increment attempts and don't backoff — once the user
      // re-auths and sync() runs, this record drains immediately.
      // But DO set a far-future nextAttemptAt so we don't tight-loop
      // re-firing it before the user re-auths. The window.online and
      // post-login sync() call will clear it (see kickAfterReauth).
      fresh.lastError = result.message ?? "auth_required";
      fresh.lastAttemptAt = Date.now();
      // 10-minute soft wait; in practice the user re-auths much sooner
      // and the explicit kick clears it.
      fresh.nextAttemptAt = Date.now() + 10 * 60 * 1000;
      await tx.store.put(fresh);
      break;
    }
    case "transient": {
      fresh.attempts += 1;
      fresh.lastError = `${result.status}: ${result.message}`;
      fresh.lastAttemptAt = Date.now();
      if (fresh.attempts >= attemptCap) {
        fresh.status = "dead";
        fresh.nextAttemptAt = undefined;
      } else {
        fresh.status = "failed";
        const delay = backoffDelayFor(fresh.attempts);
        fresh.nextAttemptAt = Date.now() + delay;
      }
      await tx.store.put(fresh);
      break;
    }
  }
  await tx.done;
  emitChange();
  return result.kind !== "auth_error";
}

// Backoff: min(base * 2^(attempts-1), ceiling). attempts is 1-indexed
// here — we call this AFTER incrementing, so attempts=1 → base (1s),
// attempts=2 → 2s, attempts=3 → 4s, ... attempts=6 → 32s, then capped
// to 60s.
export function backoffDelayFor(attempts: number): number {
  const e = Math.max(0, attempts - 1);
  const raw = backoffBaseMs * 2 ** e;
  return Math.min(raw, backoffCeilingMs);
}

// --- manual interventions ---

// Reset a dead record to pending so the next sync() retries it. Pass
// an id to target one record, omit to retry ALL dead records.
export async function retryDead(id?: number): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(STORE, "readwrite");
  const targets: OutboxRecord[] = id !== undefined
    ? [await tx.store.get(id)].filter((r): r is OutboxRecord => !!r && r.status === "dead")
    : (await tx.store.getAll()).filter((r) => r.status === "dead");
  for (const r of targets) {
    r.status = "pending";
    r.attempts = 0;
    r.lastError = undefined;
    r.nextAttemptAt = undefined;
    await tx.store.put(r);
  }
  await tx.done;
  if (targets.length > 0) {
    emitChange();
    void sync();
  }
}

export async function discardDead(id?: number): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(STORE, "readwrite");
  if (id !== undefined) {
    const r = await tx.store.get(id);
    if (r && r.status === "dead") {
      await tx.store.delete(id);
    }
  } else {
    const dead = (await tx.store.getAll()).filter((r) => r.status === "dead");
    for (const r of dead) await tx.store.delete(r.id);
  }
  await tx.done;
  emitChange();
}

// Called by the login-success path: an auth_error left records with a
// far-future nextAttemptAt; clear it so the next sync() can drain.
export async function kickAfterReauth(): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(STORE, "readwrite");
  const all = await tx.store.getAll();
  let changed = 0;
  for (const r of all) {
    if (
      (r.status === "pending" || r.status === "failed") &&
      r.lastError?.includes("auth")
    ) {
      r.nextAttemptAt = undefined;
      await tx.store.put(r);
      changed += 1;
    }
  }
  await tx.done;
  if (changed > 0) emitChange();
  void sync();
}

// Convenience: a set of idempotencyKeys currently in flight (pending
// or failed-backoff). UI uses this to mark Recent rows as "syncing…"
// without having to enumerate the full queue at each render.
export async function pendingKeys(): Promise<Set<string>> {
  const pending = await getPending();
  return new Set(pending.map((r) => r.idempotencyKey));
}
