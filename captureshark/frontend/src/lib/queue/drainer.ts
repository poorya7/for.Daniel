/**
 * Queue drainer — the orchestrator that turns a non-empty queue into
 * saved sheet rows.
 *
 * Responsibilities (plan §6):
 *   - Acquire a Web Lock so two tabs can't race the same record into
 *     `syncing`. Lock auto-releases if the holder tab crashes.
 *   - Iterate pending records FIFO by `created_at`.
 *   - Respect backoff: skip a record whose last attempt was too
 *     recent (the next cycle will pick it up).
 *   - Transition state → `syncing` before the network call; transition
 *     to a terminal kind (saved / failed_*) after, never leaving a
 *     record stuck in `syncing`.
 *   - Send the queue record's `idempotency_key` as `X-Idempotency-Key`
 *     so the backend short-circuits replays.
 *   - Stop the pass on `failed_auth` — auth requires user input, and
 *     subsequent records would all just hit the same auth wall.
 *
 * Handled paths:
 *   - `pending_save`            → run sheet write.
 *   - `pending_extraction`      → run extraction; on success promote
 *     to `pending_save` and attempt the sheet write in the SAME drain
 *     cycle (plan §6.7 — fewer cycles, identical recovery story).
 *   - `failed_transient`        → retry whichever step failed last
 *     (extract or save) once backoff has elapsed.
 *
 * Out of scope here:
 *   - Triggers (boot, online event, `visibilitychange`, /health
 *     probe) — that lives in `triggers.ts`; this module exposes
 *     `drainNow()` as the single entry point all triggers fan into.
 *
 * The drainer is idempotent + cheap to call: invocations while a
 * drain is in progress return immediately because the Web Lock is
 * exclusive and we use `ifAvailable: true` to avoid queueing on it.
 */

import { queueDb } from "@/lib/queue/db";
import {
  classifyExtractFailure,
  classifySaveFailure,
  messageForCode,
  type SaveAttemptFailure,
} from "@/lib/queue/errorMapping";
import {
  extractFromRecord,
  extractPhotoRowsFromRecord,
  type ExtractAttemptFailure,
  type PhotoExtractRowsResult,
} from "@/lib/queue/extract";
import { isReadyForAttempt } from "@/lib/queue/backoff";
import type { QueueRecord } from "@/lib/queue/types";
import {
  ApiError,
  saveRowToSheet,
  type ExtractedField,
  type ExtractedFields,
  type SaveRowPayload,
} from "@/lib/api";

const DRAINER_LOCK_NAME = "captureshark.drainer";

/**
 * Maximum number of attempts for a transient failure whose code is
 * NOT `network`. Network failures retry forever — that's the locked
 * principle. `unknown` / `ai_busy` codes get a ceiling so a
 * persistently broken upstream eventually surfaces to the user
 * rather than silently churning forever.
 */
const NON_NETWORK_TRANSIENT_CEILING = 3;

/**
 * Result of one `drainNow()` invocation. Returned so callers (UI,
 * tests, telemetry) can react without re-reading IndexedDB.
 */
export interface DrainResult {
  /** Records saved successfully and deleted from the queue. */
  saved: number;
  /** Records that hit a transient failure and stay in the queue. */
  transient_failures: number;
  /** Records that hit auth_expired and stay in the queue. */
  auth_failures: number;
  /** Records that hit a permanent failure and stay in the queue. */
  permanent_failures: number;
  /** Records skipped this cycle because backoff hasn't elapsed. */
  skipped_for_backoff: number;
  /**
   * `true` when another invocation already held the lock; this call
   * was a no-op. Tests and "Try now" UI use it to distinguish
   * "drained nothing because queue empty" from "drained nothing
   * because another tab is draining".
   */
  lock_unavailable: boolean;
}

const EMPTY_RESULT: DrainResult = {
  saved: 0,
  transient_failures: 0,
  auth_failures: 0,
  permanent_failures: 0,
  skipped_for_backoff: 0,
  lock_unavailable: false,
};

/**
 * Drain one pass. Acquires the Web Lock, iterates pending records
 * FIFO, attempts each. Returns once the lock body finishes (queue
 * empty, auth failure halts the pass, or some hard error).
 *
 * The clock is injectable for tests; in production callers pass
 * `Date.now`.
 */
export async function drainNow(
  now: () => number = Date.now,
): Promise<DrainResult> {
  // `ifAvailable: true` so a second concurrent call returns
  // immediately instead of waiting for the first to finish. Two
  // back-to-back trigger fires (e.g. `online` event + a fresh
  // visibility change) shouldn't queue up redundant passes.
  const result = await navigator.locks.request(
    DRAINER_LOCK_NAME,
    { mode: "exclusive", ifAvailable: true },
    async (lock) => {
      if (lock === null) {
        return { ...EMPTY_RESULT, lock_unavailable: true };
      }
      return _drainUnderLock(now);
    },
  );
  return result ?? EMPTY_RESULT;
}

async function _drainUnderLock(now: () => number): Promise<DrainResult> {
  const tally: DrainResult = { ...EMPTY_RESULT };

  // Snapshot the pending set up front. We re-read inside the loop
  // anyway (state changes), but starting from a stable list keeps the
  // FIFO ordering predictable across a single pass — new records
  // added while we drain get picked up on the next call.
  const pending = await queueDb.captures
    .where("state")
    .anyOf("pending_extraction", "pending_save", "failed_transient")
    .sortBy("created_at");

  for (const record of pending) {
    // Backoff check — if the record tried recently, skip it. Random
    // is the production jitter source; tests inject a fixed value.
    if (!isReadyForAttempt(record.attempts, record.last_attempt_at, now())) {
      tally.skipped_for_backoff += 1;
      continue;
    }

    // Dispatch by which step is outstanding. A record with `extracted
    // === null` still needs extraction (whether it's `pending_extraction`
    // or a `failed_transient` whose previous attempt died inside the
    // extract phase). A record with `extracted` populated is ready for
    // the sheet write.
    const outcome =
      record.extracted === null
        ? await _attemptExtractThenSave(record, now)
        : await _attemptSave(record, now);

    if (outcome === "saved") {
      tally.saved += 1;
      continue;
    }
    if (outcome === "failed_auth") {
      tally.auth_failures += 1;
      // Halt the pass — every subsequent record would hit the same
      // auth wall, and the user needs to sign in before progress
      // can continue.
      break;
    }
    if (outcome === "failed_permanent") {
      tally.permanent_failures += 1;
      continue;
    }
    // failed_transient
    tally.transient_failures += 1;
  }

  return tally;
}

type AttemptOutcome =
  | "saved"
  | "failed_transient"
  | "failed_auth"
  | "failed_permanent";

/**
 * Run the extract step for a record that still needs extraction; on
 * success, promote it to `pending_save` and attempt the sheet write
 * in the SAME drain cycle (plan §6.7).
 *
 * Returns whichever terminal outcome the combined extract → save run
 * produced. The drainer loop tallies it as a single outcome — from
 * the user's POV, a queue-extract → queue-save handoff is one event
 * (the count ticks down once, not twice).
 *
 * Attempts counter:
 *   - The extract step counts attempts on the record. A retry of a
 *     previously-failed extract increments `attempts`.
 *   - On extract SUCCESS we reset `attempts` to 0 before the
 *     same-cycle save, so the save phase gets its own retry budget.
 *     This prevents a record that took 2 extract retries from
 *     entering the save phase already at the non-network ceiling.
 */
async function _attemptExtractThenSave(
  record: QueueRecord,
  now: () => number,
): Promise<AttemptOutcome> {
  // Mark in flight. Boot sweep (sweepStaleSyncing) recovers any
  // record stuck here from a crashed tab — a crashed photo fan-out
  // mid-transaction leaves the parent stuck in `syncing`, which the
  // sweep then bounces back to `pending_extraction` for retry. Since
  // the fan-out's IDB transaction is atomic, crashing mid-flight
  // means the children were never created — no duplicate rows on
  // retry.
  await queueDb.captures.update(record.id, { state: "syncing" });

  // Photo records use the multi-row fan-out path (Item 1b): one
  // queued raw photo → N `pending_save` children, one per extracted
  // row, parent record + blob deleted.
  if (record.source === "photo") {
    return _attemptPhotoExtractThenFanOut(record, now);
  }

  let failure: ExtractAttemptFailure | null = null;
  let result: Awaited<ReturnType<typeof extractFromRecord>> | null = null;
  try {
    result = await extractFromRecord(record);
  } catch (err) {
    // The wrapper rejects with `ExtractAttemptFailure` shape. Defence
    // in depth: if anything else got thrown (an unexpected runtime
    // bug), treat it as a transport failure so the drain loop never
    // dies on one poisoned record.
    failure =
      typeof err === "object" && err !== null && "code" in err
        ? (err as ExtractAttemptFailure)
        : { code: undefined };
  }

  if (failure !== null) {
    return _commitExtractFailure(record, failure, now);
  }

  // Low-confidence guard (plan §3.2, §11 Q2): if the extracted row
  // has none of name / phone / email, silently writing it would
  // pollute the user's sheet with a nameless lead. Route to permanent
  // so the expanded queue list can surface it for review / discard.
  if (_isLowConfidence(result!.fields)) {
    await queueDb.captures.update(record.id, {
      state: "failed_permanent",
      extracted: { fields: result!.fields, original_text: result!.original_text },
      attempts: record.attempts + 1,
      last_attempt_at: now(),
      last_error: {
        code: "extraction_failed",
        message: messageForCode("extraction_failed"),
      },
    });
    return "failed_permanent";
  }

  // Promote to pending_save with a fresh retry budget for the save
  // phase. The save attempt below reads the updated record from
  // IndexedDB so it sees the right state + attempts counter.
  await queueDb.captures.update(record.id, {
    state: "pending_save",
    extracted: { fields: result!.fields, original_text: result!.original_text },
    attempts: 0,
    last_attempt_at: null,
    last_error: null,
  });

  const promoted = await queueDb.captures.get(record.id);
  if (!promoted) {
    // The record vanished mid-cycle (would only happen if a parallel
    // tab discarded it — extraordinarily unlikely under the Web Lock,
    // but harmless to handle). Treat as already-resolved.
    return "saved";
  }
  return _attemptSave(promoted, now);
}

/**
 * Run extraction on a queued raw photo (Item 1b) and fan the result
 * out into N `pending_save` children.
 *
 * Flow:
 *   1. Call `extractPhotoRowsFromRecord`, which sends the queued blob
 *      to `streamPhotoCaptureRows` and resolves with every row + the
 *      terminal status.
 *   2. On extract failure: hand off to the shared `_commitExtractFailure`
 *      retry/ceiling policy (network = retry forever, non-network = 3
 *      tries then permanent).
 *   3. On zero readable rows OR `status === "no_signal"`: mark the
 *      parent record `failed_permanent`. The user can review it via
 *      the expanded queue list and discard (which cleans up the blob).
 *   4. On rows present: create N `pending_save` children atomically
 *      (one IDB transaction). Child IDs are deterministic
 *      `photo:<idempotency_key>` so a re-extracted photo with the
 *      same content doesn't create duplicate locals. The parent
 *      record + photo blob are deleted in the same transaction —
 *      Linda's lead data is now durable on the children, the blob's
 *      job is done.
 *   5. The drainer loop continues with the snapshot it took at the
 *      start of the pass — the new children land in pending_save and
 *      get picked up on the next trigger (online / visibility /
 *      manual). On a cold boot they're picked up by the boot drain.
 *
 * From the drainer loop's POV the fan-out counts as one "saved"
 * outcome — the parent is resolved (deleted, in fact). The eventual
 * sheet writes for the children are tracked independently when their
 * own `pending_save` records are processed.
 */
async function _attemptPhotoExtractThenFanOut(
  record: QueueRecord,
  now: () => number,
): Promise<AttemptOutcome> {
  let failure: ExtractAttemptFailure | null = null;
  let result: PhotoExtractRowsResult | null = null;
  try {
    result = await extractPhotoRowsFromRecord(record);
  } catch (err) {
    failure =
      typeof err === "object" && err !== null && "code" in err
        ? (err as ExtractAttemptFailure)
        : { code: undefined };
  }

  if (failure !== null) {
    return _commitExtractFailure(record, failure, now);
  }

  const rows = result!.rows;
  const status = result!.status;

  if (rows.length === 0 || status === "no_signal") {
    await queueDb.captures.update(record.id, {
      state: "failed_permanent",
      attempts: record.attempts + 1,
      last_attempt_at: now(),
      last_error: {
        code: "extraction_failed",
        message: messageForCode("extraction_failed"),
      },
    });
    return "failed_permanent";
  }

  // Fan out. One transaction creates the children, deletes the parent,
  // and drops the photo blob — keeping local storage tidy and avoiding
  // the "blob orphaned, record gone" state a multi-step approach could
  // leave behind on a mid-flight crash.
  const baseTime = now();
  const parentBlobId = record.raw_input.photo_blob_id;
  await queueDb.transaction(
    "rw",
    queueDb.captures,
    queueDb.blobs,
    async () => {
      for (let i = 0; i < rows.length; i += 1) {
        const row = rows[i]!;
        const child: QueueRecord = {
          id: `photo:${row.idempotency_key}`,
          created_at: baseTime + i,
          source: "photo",
          state: "pending_save",
          attempts: 0,
          last_attempt_at: null,
          last_error: null,
          idempotency_key: row.idempotency_key,
          sheet_target: record.sheet_target,
          raw_input: {
            text: null,
            audio_blob_id: null,
            photo_blob_id: null,
          },
          extracted: {
            fields: row.fields,
            // A photo row has no meaningful "original text" — the
            // image itself was the input. Empty string keeps the wire
            // contract; the drainer never reads this for pending_save.
            original_text: "",
          },
        };
        await queueDb.captures.put(child);
      }
      if (parentBlobId !== null) {
        await queueDb.blobs.delete(parentBlobId);
      }
      await queueDb.captures.delete(record.id);
    },
  );

  return "saved";
}

async function _commitExtractFailure(
  record: QueueRecord,
  failure: ExtractAttemptFailure,
  now: () => number,
): Promise<AttemptOutcome> {
  const classified = classifyExtractFailure(failure);
  const nextAttempts = record.attempts + 1;

  // Same ceiling rule the save path uses: a NETWORK transient retries
  // forever (locked principle), a NON-NETWORK transient gets bumped
  // to permanent after 3 attempts so a persistently broken upstream
  // surfaces to the user instead of spinning silently.
  if (
    classified.next_state === "failed_transient" &&
    classified.error_code !== "network" &&
    nextAttempts >= NON_NETWORK_TRANSIENT_CEILING
  ) {
    await queueDb.captures.update(record.id, {
      state: "failed_permanent",
      attempts: nextAttempts,
      last_attempt_at: now(),
      last_error: {
        code: "extraction_failed",
        message: messageForCode("extraction_failed"),
      },
    });
    return "failed_permanent";
  }

  await queueDb.captures.update(record.id, {
    state: classified.next_state,
    attempts: nextAttempts,
    last_attempt_at: now(),
    last_error: {
      code: classified.error_code,
      message: messageForCode(classified.error_code),
    },
  });
  return classified.next_state as AttemptOutcome;
}

/**
 * Plan §3.2 / §11 Q2: silently saving an extracted row that contains
 * none of the three core contact fields produces a nameless, contact-
 * less row in the user's sheet — net negative. The drainer is the
 * only writer for offline-captured rows (no-review contract), so the
 * gate has to live here.
 *
 * "Missing" includes null and whitespace-only values; the streaming
 * extractor occasionally surfaces empty strings for fields it
 * couldn't read, and those should count the same as null for the
 * purpose of this gate.
 */
function _isLowConfidence(fields: ExtractedFields): boolean {
  return _isBlank(fields.name) && _isBlank(fields.phone) && _isBlank(fields.email);
}

function _isBlank(field: ExtractedField): boolean {
  return field.value === null || field.value.trim() === "";
}

/**
 * Run one save attempt for one record. Handles the state-transition
 * dance (→ syncing → terminal kind) and the queue cleanup on success.
 */
async function _attemptSave(
  record: QueueRecord,
  now: () => number,
): Promise<AttemptOutcome> {
  // We only handle pending_save in this slice. Records in
  // pending_extraction need the extraction-then-save path that
  // ships in a follow-up.
  if (record.state !== "pending_save" && record.state !== "failed_transient") {
    return record.state as AttemptOutcome;
  }
  // Extraction MUST have happened for a save attempt to be valid.
  // Defensive — a `pending_save` record with `extracted === null` is
  // a queue invariant violation upstream. Move it to permanent so
  // it surfaces for review instead of crashing the loop.
  if (record.extracted === null) {
    await queueDb.captures.update(record.id, {
      state: "failed_permanent",
      attempts: record.attempts + 1,
      last_attempt_at: now(),
      last_error: {
        code: "extraction_failed",
        message: messageForCode("extraction_failed"),
      },
    });
    return "failed_permanent";
  }

  // Mark in flight. A tab crash here is recovered by the boot sweep
  // (`sweepStaleSyncing` in db.ts) which transitions stuck `syncing`
  // records back to their pending predecessor.
  await queueDb.captures.update(record.id, { state: "syncing" });

  const payload = _payloadFromRecord(record);
  let failure: SaveAttemptFailure | null = null;
  try {
    await saveRowToSheet(payload, { idempotencyKey: record.idempotency_key });
  } catch (err) {
    if (err instanceof ApiError) {
      failure = { status: err.status, code: err.code };
    } else {
      // Unexpected throw — treat as transport failure. The drainer
      // never lets a thrown error propagate out of the loop; one
      // poisoned record cannot stop the whole drain.
      failure = { status: 0, code: undefined };
    }
  }

  if (failure === null) {
    // Success. Backend already deduped the row via the idempotency
    // header; we just clean up our side.
    await queueDb.captures.delete(record.id);
    return "saved";
  }

  const classified = classifySaveFailure(failure);
  const nextAttempts = record.attempts + 1;

  // Ceiling for non-network transient failures (plan §6.4): the
  // locked principle only forbids stopping for NETWORK failures.
  // A persistently failing `ai_busy` / `unknown` deserves user
  // attention, not infinite churn.
  if (
    classified.next_state === "failed_transient" &&
    classified.error_code !== "network" &&
    nextAttempts >= NON_NETWORK_TRANSIENT_CEILING
  ) {
    await queueDb.captures.update(record.id, {
      state: "failed_permanent",
      attempts: nextAttempts,
      last_attempt_at: now(),
      last_error: {
        code: classified.error_code,
        message: messageForCode(classified.error_code),
      },
    });
    return "failed_permanent";
  }

  await queueDb.captures.update(record.id, {
    state: classified.next_state,
    attempts: nextAttempts,
    last_attempt_at: now(),
    last_error: {
      code: classified.error_code,
      message: messageForCode(classified.error_code),
    },
  });
  return classified.next_state as AttemptOutcome;
}

/**
 * Project a queue record onto the save endpoint's payload shape.
 * Field values come straight from `record.extracted.fields`; we
 * never re-apply user edits here because the user already
 * committed them when they tapped Save (the edits are baked into
 * `extracted` at that moment).
 */
function _payloadFromRecord(record: QueueRecord): SaveRowPayload {
  // We just defensive-asserted this above, but TypeScript can't
  // narrow through an `await update()` call.
  const fields = record.extracted!.fields;
  return {
    name: fields.name.value,
    phone: fields.phone.value,
    email: fields.email.value,
    has_agent: fields.has_agent.value,
    intent: fields.intent.value,
    timeline: fields.timeline.value,
    financing_status: fields.financing_status.value,
    budget: fields.budget.value,
    area: fields.area.value,
    follow_up: fields.follow_up.value,
    notes: fields.notes.value,
    source: record.source,
  };
}
