// useOutbox — React subscription layer on top of lib/outbox.ts.
//
// Returns a live snapshot of the queue (pending + dead records) and
// the manual-intervention callbacks the SyncStatusDialog wires up.
// Internally subscribes to outbox.onChange() so the badge updates as
// records drain without polling.
//
// `inflightKeys` is a Set<string> of idempotencyKeys currently in the
// queue (pending or backing off). Recent-row components check
// membership to show a "syncing…" badge next to the row that's still
// being flushed.
//
// The hook also fires a one-shot "All caught up" toast on a successful
// drain that started with N>0 items. Toast plumbing is intentionally
// minimal — a local listener that pushes to component state — to
// avoid pulling in a toast library for a single message.

import { useCallback, useEffect, useState } from "react";

import {
  discardDead as _discardDead,
  onChange,
  onDrained,
  type OutboxRecord,
  retryDead as _retryDead,
  snapshot,
  sync,
} from "./outbox";

export interface UseOutbox {
  pending: OutboxRecord[];
  dead: OutboxRecord[];
  inflightKeys: Set<string>;
  retryAll: () => Promise<void>;
  retryOne: (id: number) => Promise<void>;
  discardOne: (id: number) => Promise<void>;
  refresh: () => Promise<void>;
  // Snapshot of the last "all-caught-up" event so consumers (e.g. the
  // top-level layout) can fire a toast once per drain.
  caughtUpAt: number | null;
}

export function useOutbox(): UseOutbox {
  const [pending, setPending] = useState<OutboxRecord[]>([]);
  const [dead, setDead] = useState<OutboxRecord[]>([]);
  const [caughtUpAt, setCaughtUpAt] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    const snap = await snapshot();
    setPending(snap.pending);
    setDead(snap.dead);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void refresh();
    const unsubChange = onChange(() => {
      if (!cancelled) void refresh();
    });
    const unsubDrain = onDrained(() => {
      if (!cancelled) setCaughtUpAt(Date.now());
    });
    return () => {
      cancelled = true;
      unsubChange();
      unsubDrain();
    };
  }, [refresh]);

  // Kick a drain attempt on mount and whenever the browser thinks
  // we're back online. navigator.onLine is unreliable (lies on captive
  // portals / VPN black holes) but the event itself is a reliable
  // "something changed, give it another shot" hint — we use a real
  // fetch result as the ground truth for online-ness.
  useEffect(() => {
    void sync();
    const onOnline = () => void sync();
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, []);

  const retryAll = useCallback(async () => {
    await _retryDead();
  }, []);
  const retryOne = useCallback(async (id: number) => {
    await _retryDead(id);
  }, []);
  const discardOne = useCallback(async (id: number) => {
    await _discardDead(id);
  }, []);

  const inflightKeys = new Set(pending.map((r) => r.idempotencyKey));

  return {
    pending,
    dead,
    inflightKeys,
    retryAll,
    retryOne,
    discardOne,
    refresh,
    caughtUpAt,
  };
}
