/**
 * Review-draft autosave (plan §4.3).
 *
 * Goal: if the tab dies while the user is mid-review (after the
 * extractor finished, before they tapped Save), bring them back to
 * the same review surface on next open with their typed edits
 * intact. Apple-grade reliability — nothing the user has reviewed
 * should be at risk of a tab death, a browser crash, or an OS
 * reboot.
 *
 * Where this lives vs the queue:
 *
 *   queue (`captures` table)   = committed records the user
 *                                explicitly Saved. Drained to the
 *                                connected sheet by the drainer.
 *   drafts (`drafts` table)    = best-effort scratch state for the
 *                                review surface ONLY. Not synced.
 *                                Deleted the moment the user taps
 *                                Save (the record promotes into
 *                                `captures`) or Discard, and after
 *                                24h of no activity.
 *
 * Two pieces of API:
 *
 *   - `saveDraft(...)` — debounced snapshot the review surface
 *     calls on every keystroke / edit. Coalesces rapid changes
 *     so we don't write to IndexedDB on every keystroke.
 *   - `restoreLatestDraft()` — boot-time read. Returns the freshest
 *     usable draft (or null) so the app can pre-open the review
 *     surface with the user's prior state.
 *
 * Plus the housekeeping functions: `clearDraft(id)` and
 * `sweepStaleDrafts(now)`.
 *
 * What ISN'T here: any React-rendering or App.tsx integration.
 * Those bindings live in the shared review/App layer because they
 * touch components both agents may need to read. This module owns
 * the storage + timing contract; the wiring is the consumer's job.
 */

import { queueDb } from "@/lib/queue/db";
import type {
  DraftRecord,
  QueueExtracted,
  QueueSource,
} from "@/lib/queue/types";
import type { ExtractedFields } from "@/lib/api";

/**
 * How long after the most recent edit before a draft is written to
 * IndexedDB. The review surface fires `saveDraft` on every change;
 * the debounce coalesces rapid typing into one write per ~1.5s
 * window. Plan §4.3 specifies "every 1.5 seconds (debounced)".
 */
export const AUTOSAVE_DEBOUNCE_MS = 1_500;

/**
 * Drafts older than this without activity are swept on boot. Plan
 * §11 Q4: 24-hour expiry on abandoned drafts. Generous enough that
 * a Linda-style same-day return restores; short enough that a
 * stale draft from last week doesn't pop up unexpectedly.
 */
export const DRAFT_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

/**
 * Snapshot the user's current review state.
 *
 * Caller hands in the draft id + the full extracted result + the
 * in-progress edits. We write the full record (idempotent
 * upsert via `put`) so a recovered draft has everything the
 * review surface needs to re-render.
 *
 * The debounce is owned by the caller via `debounceSaveDraft`
 * below; this raw function is exposed for tests and one-shot
 * "save right now" code paths (e.g. on visibilitychange-hidden).
 */
export async function saveDraft(input: {
  id: string;
  source: QueueSource;
  extracted: QueueExtracted;
  edits: Partial<ExtractedFields>;
  photo_blob_id: string | null;
  /** Caller-injectable clock; defaults to `Date.now`. */
  now?: () => number;
}): Promise<void> {
  const record: DraftRecord = {
    id: input.id,
    source: input.source,
    extracted: input.extracted,
    edits: input.edits,
    photo_blob_id: input.photo_blob_id,
    last_touched_at: (input.now ?? Date.now)(),
  };
  await queueDb.drafts.put(record);
}

/**
 * Debounce helper: every call resets a per-id timer, and only
 * the last call in a `AUTOSAVE_DEBOUNCE_MS` window actually writes.
 *
 * Returns a `flush()` function the caller can invoke to force an
 * immediate write (used on Save, on visibilitychange → hidden, and
 * on unmount — these are the moments we MUST not lose the latest
 * state to a pending timer).
 */
export interface DebouncedDraftSaver {
  schedule: (input: Parameters<typeof saveDraft>[0]) => void;
  flush: () => Promise<void>;
  /** Cancel any pending write without flushing. Used on Discard. */
  cancel: () => void;
}

export function createDebouncedDraftSaver(
  options: { debounceMs?: number } = {},
): DebouncedDraftSaver {
  // `debounceMs` is injectable so tests can use a small window
  // (avoids the fake-timers + fake-indexeddb interaction that hangs
  // Dexie's internal promises). Production callers omit it.
  const debounceMs = options.debounceMs ?? AUTOSAVE_DEBOUNCE_MS;

  let pendingTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingInput: Parameters<typeof saveDraft>[0] | null = null;

  async function _flushInternal(): Promise<void> {
    if (pendingTimer !== null) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
    const input = pendingInput;
    pendingInput = null;
    if (input !== null) {
      await saveDraft(input);
    }
  }

  return {
    schedule(input) {
      pendingInput = input;
      if (pendingTimer !== null) {
        clearTimeout(pendingTimer);
      }
      pendingTimer = setTimeout(() => {
        // The promise is fire-and-forget here — by the time the
        // timer fires, the caller no longer holds a handle. Errors
        // would be unhandled rejections; in practice IndexedDB
        // writes don't fail mid-session, but we still swallow so a
        // disk-full surfacing doesn't crash the page.
        void _flushInternal().catch(() => {
          /* swallow; next schedule will overwrite anyway */
        });
      }, debounceMs);
    },
    flush: _flushInternal,
    cancel() {
      if (pendingTimer !== null) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
      }
      pendingInput = null;
    },
  };
}

/**
 * Read the freshest non-stale draft on boot, or `null` if none.
 *
 * Returns the WHOLE draft record so the consumer can re-hydrate
 * the review surface without a second lookup. The `last_touched_at`
 * check is permissive — if the clock isn't monotonic across reboots
 * (DST, system clock fix) a draft slightly "in the future" still
 * restores.
 *
 * Stale drafts are NOT swept here — `sweepStaleDrafts` is the
 * dedicated boot-time cleanup. Keeping read and sweep separate
 * means a flaky write doesn't corrupt the boot path; the next
 * `sweepStaleDrafts` call cleans up.
 */
export async function restoreLatestDraft(
  now: () => number = Date.now,
): Promise<DraftRecord | null> {
  const drafts = await queueDb.drafts
    .orderBy("last_touched_at")
    .reverse()
    .toArray();
  const horizon = now() - DRAFT_MAX_AGE_MS;
  for (const draft of drafts) {
    if (draft.last_touched_at >= horizon) {
      return draft;
    }
  }
  return null;
}

/**
 * Delete a draft by id. Called when:
 *
 *   - The user taps Save — the captured record promotes into
 *     `captures`, the draft is no longer needed.
 *   - The user taps Discard — explicit throw-away.
 *   - The capture flow restarts with a fresh raw input (the
 *     restored draft was rejected via the "you have an unsaved
 *     review — restore or discard?" prompt, §9.11).
 *
 * Safe to call with a non-existent id (no-op).
 */
export async function clearDraft(id: string): Promise<void> {
  await queueDb.drafts.delete(id);
}

/**
 * Boot-time housekeeping: delete every draft older than
 * `DRAFT_MAX_AGE_MS`. Returns the count of records removed so
 * callers can log / observe sweep impact.
 *
 * Idempotent and safe to call every boot. Cheap — the drafts
 * store rarely has more than a single record (the user is only
 * reviewing one capture at a time), so a full scan is trivial.
 */
export async function sweepStaleDrafts(
  now: () => number = Date.now,
): Promise<number> {
  const horizon = now() - DRAFT_MAX_AGE_MS;
  const stale = await queueDb.drafts
    .where("last_touched_at")
    .below(horizon)
    .primaryKeys();
  if (stale.length === 0) return 0;
  await queueDb.drafts.bulkDelete(stale);
  return stale.length;
}
