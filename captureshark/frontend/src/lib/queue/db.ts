/**
 * IndexedDB layer for the offline-resilient capture queue.
 *
 * Wraps Dexie (a thin promise-y wrapper around IndexedDB) so the
 * rest of the codebase doesn't have to deal with raw IDB request
 * objects, transaction lifecycle quirks, or version-upgrade callback
 * plumbing. Dexie was chosen over raw IndexedDB after both review
 * passes; rationale lives in `docs/_spec/offline_queue.md
 * §4.1`.
 *
 * This module exposes a single `queueDb` singleton; everything else
 * (drainer, capture submit refactors, UI surfaces) reads / writes
 * via its three tables:
 *
 *   - `captures` — the queue itself. One row per pending capture.
 *   - `blobs`    — photo / audio binary blobs, kept out of the
 *                  captures table so list rendering stays cheap.
 *   - `drafts`   — review-draft autosave (plan §4.3).
 *
 * Schema is versioned via Dexie's `version()` chain — bumping the
 * version is how we ship migrations once we go live. v1 is the
 * initial schema; future revisions append a new `.version(N).stores(...)`
 * block instead of mutating v1.
 *
 * Indexed fields are chosen to support the queries the drainer and
 * UI actually run:
 *   - `captures.created_at`  — FIFO drain ordering, expiry sweep.
 *   - `captures.state`       — "give me all `pending_save` rows".
 *   - `drafts.last_touched_at` — 24h abandonment sweep.
 * Primary keys (`id`) are indexed automatically; no need to list them.
 */

import Dexie, { type Table } from "dexie";

import type {
  BlobRecord,
  DraftRecord,
  QueueRecord,
} from "@/lib/queue/types";

const DB_NAME = "captureshark_queue";

/**
 * Typed Dexie subclass. The `Table<RecordType, KeyType>` generics let
 * TypeScript validate `.add()` / `.get()` / `.update()` calls against
 * the record shapes in `types.ts` — schema drift between this file
 * and the type definitions becomes a compile error rather than a
 * runtime surprise.
 */
class CapturesharkQueueDb extends Dexie {
  captures!: Table<QueueRecord, string>;
  blobs!: Table<BlobRecord, string>;
  drafts!: Table<DraftRecord, string>;

  constructor() {
    super(DB_NAME);

    // v1 schema. The string passed to `.stores()` is Dexie's terse
    // schema DSL: `&id` = primary key with uniqueness, plain field
    // names = secondary indexes. Anything not listed is still stored,
    // just not indexed — the record types are the source of truth
    // for what fields exist.
    this.version(1).stores({
      captures: "&id, created_at, state",
      blobs: "&id",
      drafts: "&id, last_touched_at",
    });
  }
}

/**
 * Singleton. Constructed lazily on first import; Dexie opens the
 * underlying IndexedDB connection on the first operation, not on
 * construction, so this is cheap to evaluate at module-load time.
 *
 * In tests, `fake-indexeddb/auto` patches the global `indexedDB`
 * before this module loads, so the same singleton hits an in-memory
 * backend instead of the browser's real one — no test-only
 * indirection needed in production code.
 */
export const queueDb = new CapturesharkQueueDb();

/**
 * Recovery sweep. Any record left in `syncing` from a previous
 * session means a tab was killed mid-network-call; the actual
 * outcome (sheet write succeeded vs. didn't) is recovered by the
 * backend's idempotency layer on the next attempt (plan §9.10).
 *
 * Rules:
 *   - A `syncing` record whose `extracted` is null bounces back to
 *     `pending_extraction` (the extraction call was in flight).
 *   - A `syncing` record whose `extracted` is populated bounces back
 *     to `pending_save` (the sheet write was in flight).
 *
 * Idempotent — safe to call on every app boot. Returns the number
 * of records adjusted so callers can log / observe sweep impact.
 */
export async function sweepStaleSyncing(): Promise<number> {
  const stale = await queueDb.captures.where("state").equals("syncing").toArray();
  if (stale.length === 0) return 0;
  await queueDb.transaction("rw", queueDb.captures, async () => {
    for (const record of stale) {
      const nextState = record.extracted === null ? "pending_extraction" : "pending_save";
      await queueDb.captures.update(record.id, { state: nextState });
    }
  });
  return stale.length;
}

/**
 * Test-only helper to clear all three tables. NOT exported from the
 * package barrel; tests import it directly. Production code has no
 * reason to wipe the queue.
 */
export async function _resetForTests(): Promise<void> {
  await queueDb.transaction("rw", queueDb.captures, queueDb.blobs, queueDb.drafts, async () => {
    await queueDb.captures.clear();
    await queueDb.blobs.clear();
    await queueDb.drafts.clear();
  });
}
