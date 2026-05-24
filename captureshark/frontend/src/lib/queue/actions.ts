/**
 * Queue actions exposed to the rest of the app (plan §8.2).
 *
 * Two flavours of action live here:
 *
 *   - **Submit-time enqueue.** The app's save flow writes a
 *     `pending_save` record here the moment the user taps Save on a
 *     reviewed lead. The drainer takes it from there. The cascade
 *     ("Saved ✓") plays on the LOCAL durable write returning, not on
 *     the sheet write returning — that's how we reconcile principle
 *     5 ("show Saved instantly") with principle 8 ("never lose data").
 *
 *   - **User-initiated discard.** From the expanded queue list, the
 *     user can drop a pending or permanently-failed record. Blocked
 *     while syncing (plan §9.9) — the window is sub-second and we
 *     don't have a delete-row-from-sheet path in v1, so allowing
 *     discard mid-flight would risk the "discarded but the row showed
 *     up anyway" mental-model break.
 */

import { queueDb } from "@/lib/queue/db";
import type { ExtractedFields, PhotoRow } from "@/lib/api";
import type {
  QueueRecord,
  QueueSheetTarget,
  QueueSource,
} from "@/lib/queue/types";

/**
 * Inputs the save flow hands to `enqueueExtractedLead`. The caller has
 * already reviewed the fields and decided to save; we just need a
 * durable home for the record while the drainer pushes it to the sheet.
 */
export interface EnqueueExtractedLeadInput {
  source: QueueSource;
  fields: ExtractedFields;
  originalText: string;
  sheetTarget: QueueSheetTarget;
  /**
   * Optional pre-minted idempotency key. Photo rows arrive with a
   * server-minted key (see `PhotoRow.idempotency_key`); text + voice
   * have no upstream key and let this helper mint a fresh one.
   *
   * MUST be globally unique per logical lead — the backend's
   * idempotency store keys off this to short-circuit replays.
   */
  idempotencyKey?: string;
  /** Test-injectable clock. Production passes `Date.now`. */
  now?: () => number;
}

/**
 * Write one extracted lead to the queue as a `pending_save` record.
 *
 * This is the submit-time enqueue path Item 0 introduces. Resolves once
 * the IndexedDB write commits — at which point the lead is durable on
 * Linda's device, even if she closes the tab, even if the network never
 * comes back. The drainer picks it up on its own clock + triggers.
 *
 * Returns the record so callers can reference its ID (e.g. for a "view
 * in queue" affordance, or for tests).
 */
export async function enqueueExtractedLead(
  input: EnqueueExtractedLeadInput,
): Promise<QueueRecord> {
  const nowFn = input.now ?? Date.now;
  const id =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `lead-${String(nowFn())}-${Math.random().toString(36).slice(2, 10)}`;
  const record: QueueRecord = {
    id,
    created_at: nowFn(),
    source: input.source,
    state: "pending_save",
    attempts: 0,
    last_attempt_at: null,
    last_error: null,
    // For text + voice the helper mints the key (the user-supplied key
    // is photo-only today, but the seam stays flexible). Re-using the
    // record id keeps the local <-> server correspondence trivial.
    idempotency_key: input.idempotencyKey ?? id,
    sheet_target: input.sheetTarget,
    raw_input: {
      // See `QueueRawInput` comment — pending_save records added after
      // review legitimately have all-null raw input. Storing the audio
      // blob just to satisfy a comment would burn IDB quota for no
      // recovery value (we already have the reviewed fields).
      text: null,
      audio_blob_id: null,
      photo_blob_id: null,
    },
    extracted: {
      fields: input.fields,
      original_text: input.originalText,
    },
  };
  await queueDb.captures.put(record);
  return record;
}

/**
 * Inputs for the photo-batch enqueue path (Item 1a).
 */
export interface EnqueueExtractedPhotoRowsInput {
  /**
   * The rows the user reviewed + decided to save. Each row already
   * carries a server-minted `idempotency_key` from the photo
   * extraction stream, so the backend can dedupe replays without
   * any client-side coordination.
   */
  rows: PhotoRow[];
  sheetTarget: QueueSheetTarget;
  /** Test-injectable clock. Production passes `Date.now`. */
  now?: () => number;
}

/**
 * Write N reviewed photo rows to the queue as N `pending_save`
 * records, atomically in one IndexedDB transaction.
 *
 * Item 1a's load-bearing helper: a 20-row sign-in sheet → 20 protected
 * rows the instant Save All resolves locally. If signal drops mid-
 * batch later, the drainer will keep retrying each row until it lands;
 * backend idempotency (off the row's `idempotency_key`) prevents
 * duplicate sheet writes.
 *
 * **Deterministic record IDs.** We derive `id = "photo:" +
 * row.idempotency_key` rather than minting fresh UUIDs. Two
 * consequences:
 *   1. A double-tap on Save All in a half-second window doesn't create
 *      duplicate local records — the second `put` overwrites the
 *      identical record under the same key.
 *   2. The same row from a re-extracted photo (same content) maps to
 *      the same local id, preventing duplicates even across full
 *      re-capture-then-Save-All replays.
 *
 * **Created-at staggering.** All N rows are committed in the same
 * transaction; without staggering, they'd share an identical
 * `created_at` and the FIFO drainer could pick them in any order.
 * Staggering by row index (`baseTime + i`) preserves document reading
 * order through the drain, so the user's sheet ends up in the same
 * order the photo presented them in.
 */
export async function enqueueExtractedPhotoRows(
  input: EnqueueExtractedPhotoRowsInput,
): Promise<number> {
  if (input.rows.length === 0) return 0;
  const nowFn = input.now ?? Date.now;
  const baseTime = nowFn();
  await queueDb.transaction("rw", queueDb.captures, async () => {
    for (let i = 0; i < input.rows.length; i += 1) {
      const row = input.rows[i]!;
      const record: QueueRecord = {
        id: `photo:${row.idempotency_key}`,
        created_at: baseTime + i,
        source: "photo",
        state: "pending_save",
        attempts: 0,
        last_attempt_at: null,
        last_error: null,
        idempotency_key: row.idempotency_key,
        sheet_target: input.sheetTarget,
        raw_input: {
          // Same rationale as single-row enqueue: this record is
          // already-extracted, no re-extraction path needs raw input.
          text: null,
          audio_blob_id: null,
          photo_blob_id: null,
        },
        extracted: {
          fields: row.fields,
          // A photo row doesn't have a meaningful "original text" — the
          // image itself was the input. Empty string keeps the wire
          // shape valid; the drainer never reads this field for
          // pending_save records.
          original_text: "",
        },
      };
      await queueDb.captures.put(record);
    }
  });
  return input.rows.length;
}

/**
 * Inputs for the offline-captured raw-photo enqueue path (Item 1b).
 */
export interface EnqueueRawPhotoInput {
  /** The captured photo bytes — typically straight from the shutter. */
  blob: Blob;
  /** Where the eventual extracted rows should land. */
  sheetTarget: QueueSheetTarget;
  /**
   * Override the blob's `type` if you need to (e.g. canvas-derived
   * blobs default to `image/png` on some browsers when the user took
   * a JPEG). Defaults to `blob.type || "image/jpeg"`.
   */
  contentType?: string;
  /** Test-injectable clock. Production passes `Date.now`. */
  now?: () => number;
}

/**
 * Persist a raw photo that hasn't been extracted yet (Item 1b).
 *
 * Used when the foreground extraction stream fails with a network
 * error — Linda captured a sign-in sheet from a basement open house,
 * her phone can't reach the server, but the safety net catches the
 * photo. When signal returns, the drainer (see Item 1b's drainer
 * extension) will pick it up, run the multi-row extraction, and fan
 * the result out into N `pending_save` records.
 *
 * Stores the photo blob in `queueDb.blobs` and creates a single
 * `pending_extraction` record in `queueDb.captures` that points at it.
 * Atomicity matters here — a partial commit would either leak a blob
 * (~1-3 MB) or leave a record pointing at no blob (which the drainer
 * would route to permanent on the next attempt).
 */
export async function enqueueRawPhoto(
  input: EnqueueRawPhotoInput,
): Promise<QueueRecord> {
  const nowFn = input.now ?? Date.now;
  const id =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `photo-raw-${String(nowFn())}-${Math.random().toString(36).slice(2, 10)}`;
  const blobId = `${id}-blob`;
  const contentType = input.contentType ?? (input.blob.type || "image/jpeg");

  const record: QueueRecord = {
    id,
    created_at: nowFn(),
    source: "photo",
    state: "pending_extraction",
    attempts: 0,
    last_attempt_at: null,
    last_error: null,
    // Idempotency key for the raw record itself — only used if a
    // future code path needs to dedupe at this layer. The fan-out
    // step creates per-row pending_save records with their own
    // server-minted keys, so this one is rarely surfaced.
    idempotency_key: id,
    sheet_target: input.sheetTarget,
    raw_input: {
      text: null,
      audio_blob_id: null,
      photo_blob_id: blobId,
    },
    extracted: null,
  };

  await queueDb.transaction(
    "rw",
    queueDb.captures,
    queueDb.blobs,
    async () => {
      await queueDb.blobs.put({
        id: blobId,
        blob: input.blob,
        content_type: contentType,
        bytes: input.blob.size,
      });
      await queueDb.captures.put(record);
    },
  );

  return record;
}

/**
 * Discard a queued capture. Removes the record and its associated
 * blob(s) in a single transaction so a partial delete can't leak a
 * blob (each photo blob is ~1-3 MB — orphans would eat quota).
 *
 * Rejects on `syncing` records. The UI is supposed to disable the
 * button in that case (plan §9.9), but enforcing it here too means
 * a fast double-tap or a stale render can't end-run the rule.
 */
export async function discardCapture(id: string): Promise<void> {
  await queueDb.transaction(
    "rw",
    queueDb.captures,
    queueDb.blobs,
    async () => {
      const record = await queueDb.captures.get(id);
      if (record === undefined) {
        // Already gone. Treat as success — the user's intent (no
        // longer in the queue) is satisfied.
        return;
      }
      if (record.state === "syncing") {
        throw new Error(
          "Cannot discard a capture that is currently syncing.",
        );
      }
      const blobIds = [
        record.raw_input.audio_blob_id,
        record.raw_input.photo_blob_id,
      ].filter((bid): bid is string => bid !== null);
      if (blobIds.length > 0) {
        await queueDb.blobs.bulkDelete(blobIds);
      }
      await queueDb.captures.delete(id);
    },
  );
}
