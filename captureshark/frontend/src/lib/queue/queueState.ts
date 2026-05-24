/**
 * Queue-state subscription layer for the UI surfaces (plan §8).
 *
 * The queue itself lives in IndexedDB (`db.ts`). UI components (pill,
 * list sheet, toast, online indicator) need to react when records are
 * added / removed / change state — Dexie's `liveQuery` does the heavy
 * lifting (it diffs IDB query results and re-emits when anything in
 * the queried scope changes), and `useSyncExternalStore` adapts the
 * Dexie observable to React's tearing-free subscription model. No
 * extra deps, no polling.
 *
 * Why a separate module:
 *   - The drainer + triggers shouldn't import React. Keeping all
 *     React glue here means `db.ts`, `drainer.ts`, etc. stay
 *     framework-agnostic (and trivially testable under jsdom).
 *   - The selectors (`summarise`, `pendingCount`, etc.) are pure
 *     functions of the record array. UI components consume the
 *     same summary shape so changing the count-rendering doesn't
 *     require touching every component.
 *
 * Subscription budget: one `useLiveRecords` subscription per
 * mounted UI surface is fine — Dexie coalesces internally. The pill
 * + list sheet share state via a single hook called at the App
 * level; this file does not enforce that, it just makes it cheap.
 */

import { liveQuery, type Subscription } from "dexie";
import { useEffect, useState, useSyncExternalStore } from "react";

import { queueDb } from "@/lib/queue/db";
import type {
  OnlineDetector,
  OnlineState,
} from "@/lib/queue/onlineDetection";
import type { QueueRecord, QueueState } from "@/lib/queue/types";

/**
 * Aggregate counts over the queue, in the shape the pill / list /
 * sign-in CTA all read. Computing this once at the top of the tree
 * and threading the summary down keeps render cost predictable —
 * pure derivation, no IDB reads downstream.
 */
export interface QueueSummary {
  /** Total records in the queue, all states. The pill's headline number. */
  total: number;
  /**
   * Records that are auto-progressing (no user action needed). This
   * is what the pill's "N waiting to save" copy counts. Includes
   * `pending_extraction`, `pending_save`, `syncing`, and
   * `failed_transient` (which retries forever per plan §6.4).
   */
  pending: number;
  /**
   * Records blocked on user sign-in. Drives the sibling CTA under
   * the pill (plan §8.1). Counted separately so the headline copy
   * stays calm ("3 waiting to save") even when one item also needs
   * sign-in.
   */
  failed_auth: number;
  /**
   * Records that need user attention to recover (sheet revoked,
   * schema mismatch, low-confidence extraction). Drives the muted
   * amber dot inside the pill (plan §8.1).
   */
  failed_permanent: number;
}

const EMPTY_SUMMARY: QueueSummary = {
  total: 0,
  pending: 0,
  failed_auth: 0,
  failed_permanent: 0,
};

const PENDING_STATES: ReadonlySet<QueueState> = new Set<QueueState>([
  "pending_extraction",
  "pending_save",
  "syncing",
  "failed_transient",
]);

/**
 * Reduce a record list to the summary the UI surfaces consume. Pure
 * — exported separately so tests can exercise it without spinning up
 * Dexie.
 */
export function summarise(records: ReadonlyArray<QueueRecord>): QueueSummary {
  if (records.length === 0) return EMPTY_SUMMARY;
  let pending = 0;
  let auth = 0;
  let perm = 0;
  for (const record of records) {
    if (PENDING_STATES.has(record.state)) {
      pending += 1;
    } else if (record.state === "failed_auth") {
      auth += 1;
    } else if (record.state === "failed_permanent") {
      perm += 1;
    }
  }
  return {
    total: records.length,
    pending,
    failed_auth: auth,
    failed_permanent: perm,
  };
}

/**
 * Subscribe to the full queue, FIFO-ordered. The hook re-renders the
 * caller whenever any record is added, removed, or mutated. Returns a
 * stable empty array on first render (before Dexie has emitted) so
 * downstream code can treat the array as always-defined.
 *
 * `useSyncExternalStore` would be ideal here, but it requires a
 * synchronous `getSnapshot` that returns a stable reference between
 * notifications — Dexie's emissions are async and produce a new array
 * each tick, so the snapshot path would tear. We use `useState` +
 * `useEffect` instead, which is the documented pattern for async
 * external stores.
 */
export function useLiveRecords(): ReadonlyArray<QueueRecord> {
  const [records, setRecords] = useState<ReadonlyArray<QueueRecord>>(
    EMPTY_RECORDS,
  );

  useEffect(() => {
    const observable = liveQuery(() =>
      queueDb.captures.orderBy("created_at").toArray(),
    );
    const subscription: Subscription = observable.subscribe({
      next: (next) => {
        setRecords(next);
      },
      // Dexie's contract: `error` fires only on fatal store-level
      // errors (closed DB, corrupted index). Falling back to an
      // empty array keeps the UI rendering — better than crashing
      // the whole tree because the queue is unreadable.
      error: () => {
        setRecords(EMPTY_RECORDS);
      },
    });
    return () => {
      subscription.unsubscribe();
    };
  }, []);

  return records;
}

const EMPTY_RECORDS: ReadonlyArray<QueueRecord> = Object.freeze([]);

/**
 * Convenience hook: read the queue and return the summary. UI
 * surfaces that don't care about individual records (pill,
 * online-indicator badge) use this; the list sheet uses
 * `useLiveRecords` directly.
 */
export function useQueueSummary(): QueueSummary {
  const records = useLiveRecords();
  return summarise(records);
}

/**
 * Subscribe to the runner's online state. `useSyncExternalStore` is
 * perfect here because the detector's `current()` is synchronous and
 * stable between notifications.
 */
export function useOnlineState(detector: OnlineDetector | null): OnlineState {
  return useSyncExternalStore(
    (notify) => {
      if (detector === null) {
        return () => {
          /* no-op */
        };
      }
      return detector.subscribe(() => {
        notify();
      });
    },
    () => (detector === null ? "online" : detector.current()),
    // Server snapshot — relevant only if we ever SSR. Match the
    // client default so hydration is clean.
    () => "online",
  );
}
