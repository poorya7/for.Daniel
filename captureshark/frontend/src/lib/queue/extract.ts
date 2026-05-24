/**
 * Drainer-side extraction adapter.
 *
 * The foreground capture flows use the streaming SSE endpoints
 * (`streamTextCapture`, `streamVoiceCapture`, `streamPhotoCaptureRows`)
 * because the review surface paints fields the moment each one lands —
 * the perceived-speed win behind the "fail clean" UX principle.
 *
 * The drainer doesn't render anything. It just needs the final
 * extracted result so it can promote a `pending_extraction` record to
 * `pending_save` and (per plan §6.7) immediately attempt the sheet
 * write in the same cycle. So this module wraps the existing streaming
 * endpoints in a one-shot Promise: discard the deltas, resolve on
 * `done`, reject on `error`. Photo records use the multi-row
 * `extractPhotoRowsFromRecord` below; `extractFromRecord` handles
 * text + voice only.
 *
 * Why reuse the streaming endpoints instead of adding non-streaming
 * variants on the backend:
 *   - Backend already gates, classifies, and emits typed error codes
 *     on the SSE channel (`no_signal`, `ai_busy`, `network`). A second
 *     extraction surface would have to mirror all of that.
 *   - The drainer doesn't pay the latency cost of "wait for the whole
 *     stream to finish" — that's the same wall-clock as a single
 *     non-streaming call would be.
 *   - One extraction code path means one place for bugs to hide.
 *
 * Failure shape is intentionally tiny: `code` is the same string the
 * streaming `onError(message, code)` callback surfaces. The classifier
 * in `errorMapping.ts` is the only consumer.
 */

import {
  streamTextCapture,
  streamVoiceCapture,
  streamPhotoCaptureRows,
  type ExtractionResult,
  type PhotoDone,
  type PhotoRow,
  type StreamHandlers,
} from "@/lib/api";
import { queueDb } from "@/lib/queue/db";
import type { QueueRecord } from "@/lib/queue/types";

/**
 * What the drainer sees when an extraction attempt fails. `code`
 * mirrors the backend's `error.code` when available — `"network"`,
 * `"ai_busy"`, `"no_signal"`, `"empty_input"` — and is `undefined`
 * for transport-only failures where no body ever arrived.
 *
 * NOT thrown as an `Error` instance because we don't want stack
 * traces in queue records or the chance of an unrelated `try/catch`
 * upstream swallowing a `TypeError` as if it were one of ours. The
 * drainer's try/catch around the call site checks shape, not class.
 */
export interface ExtractAttemptFailure {
  code: string | undefined;
}

/**
 * Run extraction for one queue record. Dispatches to the right
 * endpoint based on `source` and loads the audio/photo blob from the
 * blobs store when needed.
 *
 * Resolves with the final `ExtractionResult` on success. Rejects with
 * an `ExtractAttemptFailure` on any failure path — including the
 * "raw input is missing" defensive cases (a record can't have arrived
 * here in a coherent state with no text and no blob, but if it did,
 * surfacing it for review is better than crashing the drain loop).
 */
export async function extractFromRecord(
  record: QueueRecord,
): Promise<ExtractionResult> {
  switch (record.source) {
    case "text": {
      const text = record.raw_input.text;
      if (text === null || text.trim() === "") {
        // Invariant violation upstream — surface as a "this input
        // can't be extracted from" so the drainer routes to permanent.
        throw { code: "no_signal" } satisfies ExtractAttemptFailure;
      }
      return _runStreamAsPromise((handlers) =>
        streamTextCapture(text, handlers),
      );
    }
    case "voice": {
      const blobId = record.raw_input.audio_blob_id;
      if (blobId === null) {
        throw { code: "no_signal" } satisfies ExtractAttemptFailure;
      }
      const blobRecord = await queueDb.blobs.get(blobId);
      if (!blobRecord) {
        // The blob was evicted (iOS storage pressure) or never made
        // it to IndexedDB. Either way, retrying won't recover it.
        throw { code: "no_signal" } satisfies ExtractAttemptFailure;
      }
      return _runStreamAsPromise((handlers) =>
        streamVoiceCapture(blobRecord.blob, handlers),
      );
    }
    case "photo":
      // Photo records are dispatched through `extractPhotoRowsFromRecord`
      // by the drainer's `_attemptPhotoExtractThenFanOut` BEFORE reaching
      // this function (Item 1b). Reaching here means a new caller missed
      // that dispatch — surface as `no_signal` so the drain loop ceiling
      // kicks in instead of crashing the loop on an unexpected source.
      throw { code: "no_signal" } satisfies ExtractAttemptFailure;
  }
}

/**
 * Multi-row photo extract result (Item 1b).
 *
 * `status` mirrors the wire vocabulary:
 *   - `"ok"`: every adapter row passed the signal gate.
 *   - `"partial"`: some rows survived, some were dropped server-side.
 *   - `"no_signal"`: zero readable rows. The drainer treats this as a
 *     permanent failure for the photo record (no point retrying the
 *     same blob).
 */
export interface PhotoExtractRowsResult {
  rows: PhotoRow[];
  status: PhotoDone["status"];
}

/**
 * Multi-row variant of `extractFromRecord` for photo records (Item 1b).
 *
 * Used by the drainer's photo fan-out path — runs
 * `streamPhotoCaptureRows` against the queued photo blob and resolves
 * with every row plus the terminal status. The drainer then turns each
 * row into a separate `pending_save` child record + deletes the parent
 * `pending_extraction` record.
 *
 * Failure shape mirrors `extractFromRecord`: rejects with an
 * `ExtractAttemptFailure` carrying the wire error code. The drainer's
 * outer try/catch handles classification + retry + ceiling logic.
 */
export async function extractPhotoRowsFromRecord(
  record: QueueRecord,
): Promise<PhotoExtractRowsResult> {
  if (record.source !== "photo") {
    throw { code: "no_signal" } satisfies ExtractAttemptFailure;
  }
  const blobId = record.raw_input.photo_blob_id;
  if (blobId === null) {
    throw { code: "no_signal" } satisfies ExtractAttemptFailure;
  }
  const blobRecord = await queueDb.blobs.get(blobId);
  if (!blobRecord) {
    // Blob evicted (iOS storage pressure) or never landed. Retrying
    // won't recover bytes that don't exist.
    throw { code: "no_signal" } satisfies ExtractAttemptFailure;
  }

  return new Promise<PhotoExtractRowsResult>((resolve, reject) => {
    const collected: PhotoRow[] = [];
    let settled = false;
    const settle = (outcome: () => void): void => {
      if (settled) return;
      settled = true;
      outcome();
    };

    void streamPhotoCaptureRows(blobRecord.blob, {
      onPhotoRow: (row) => {
        if (settled) return;
        collected.push(row);
      },
      onPhotoDone: (done) => {
        settle(() =>
          resolve({ rows: collected, status: done.status }),
        );
      },
      onError: (_message, code) => {
        settle(() =>
          reject({ code } satisfies ExtractAttemptFailure),
        );
      },
    }).catch(() => {
      settle(() =>
        reject({ code: undefined } satisfies ExtractAttemptFailure),
      );
    });
  });
}

/**
 * Adapt the SSE streaming handlers into a one-shot Promise. Partial
 * frames are discarded — the drainer has no UI to feed them into.
 *
 * Settlement is single-shot: the first `onDone` or `onError` wins.
 * Subsequent events (which shouldn't happen, but defence in depth)
 * are ignored so we never reject after resolving.
 *
 * The runner's returned Promise is awaited so a rejection-without-an-
 * onError-call (impossible per the current `_streamSseRequest`
 * contract but cheap to guard) still settles this Promise instead
 * of leaking an unhandled rejection.
 */
function _runStreamAsPromise(
  runner: (handlers: StreamHandlers) => Promise<void>,
): Promise<ExtractionResult> {
  return new Promise<ExtractionResult>((resolve, reject) => {
    let settled = false;
    const settle = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      outcome();
    };

    const handlers: StreamHandlers = {
      onDelta: () => {
        // Drainer doesn't paint partial fields — only the final
        // `onDone` matters here.
      },
      onDone: (result) => {
        settle(() => resolve(result));
      },
      onError: (_message, code) => {
        settle(() => reject({ code } satisfies ExtractAttemptFailure));
      },
    };

    runner(handlers).catch(() => {
      settle(() =>
        reject({ code: undefined } satisfies ExtractAttemptFailure),
      );
    });
  });
}
