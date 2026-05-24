/**
 * Type definitions for the offline-resilient capture queue.
 *
 * The queue is the durable backbone of the offline-first capture
 * flow: a user submits a capture, we write a record here, and a
 * drainer (see `drainer.ts`, sprint 2) handles extraction + sheet
 * write whenever the network allows. The records survive tab close,
 * browser restart, and phone restart.
 *
 * These types are the wire format between the submit path, the
 * IndexedDB layer (`db.ts`), and the drainer. They mirror the
 * schema documented in `docs/_planning/offline_queue.md §4.2`.
 *
 * Plan invariants this file enforces:
 *   - `state` is a closed union (the drainer pattern-matches on it).
 *   - `raw_input` is always present (we persist BEFORE extraction
 *     fires, so we can recover from a mid-stream extraction failure
 *     by re-running from raw).
 *   - `extracted` is `null` while in `pending_extraction`, populated
 *     once extraction has completed.
 *   - `idempotency_key` is generated at submit time and travels with
 *     the record for its whole life — the backend uses it to dedupe
 *     replays after retries.
 */

import type { ExtractedFields } from "@/lib/api";

/**
 * Where the capture originated. Drives which extraction endpoint
 * the drainer calls and which preview shape the queue list renders.
 */
export type QueueSource = "text" | "voice" | "photo";

/**
 * Canonical state machine for a queued capture. See plan §3 for the
 * full diagram. The drainer is the only writer that moves a record
 * between non-terminal states; UI surfaces read state to decide
 * presentation (pill colour, list-item chip, etc.).
 *
 *   pending_extraction → extraction hasn't run yet (offline at
 *                        submit time).
 *   pending_save       → extraction is done; sheet write hasn't
 *                        succeeded yet.
 *   syncing            → a network call is in flight RIGHT NOW.
 *                        Recovery sweep on boot (§9.10) flips any
 *                        records stuck here back to their pending
 *                        predecessor.
 *   failed_transient   → network or upstream-busy failure. Auto-
 *                        retried forever while the OS reports
 *                        offline; bounded retry otherwise.
 *   failed_auth        → OAuth refresh failed. Waits for explicit
 *                        sign-in before resuming.
 *   failed_permanent   → unrecoverable without user input (sheet
 *                        revoked, schema mismatch, extraction
 *                        gave up after 3 attempts, etc.).
 */
export type QueueState =
  | "pending_extraction"
  | "pending_save"
  | "syncing"
  | "failed_transient"
  | "failed_auth"
  | "failed_permanent";

/**
 * Coarse failure taxonomy the drainer uses to decide retry policy
 * (plan §6.5). These are NOT the exact backend error codes one-to-
 * one — the drainer maps the wire codes (`ai_busy`, `sheet_revoked`,
 * etc.) onto this taxonomy. Keeping it small here means the queue
 * UI surfaces (which read `last_error.code`) don't have to know
 * about every upstream provider's vocabulary.
 */
export type QueueErrorCode =
  | "network"             // transport-level failure or 5xx
  | "ai_busy"             // upstream LLM / vision rate-limit / overloaded
  | "auth_expired"        // token expired, refresh didn't help
  | "sheet_revoked"       // user removed our Drive access
  | "schema_mismatch"     // sheet columns don't line up
  | "forbidden"           // 403 from sheet write for any other reason
  | "not_found"           // sheet was deleted
  | "extraction_failed"   // extraction gave up after retries
  | "unknown";

/**
 * Last-attempt error envelope. `message` is safe to surface verbatim
 * to the user — the drainer is responsible for producing one
 * suitable line per code (no raw `Error.message` from fetch leaks).
 */
export interface QueueErrorEnvelope {
  code: QueueErrorCode;
  message: string;
}

/**
 * Which sheet a queued capture is destined for. Resolved at SUBMIT
 * time, not at sync time, so that changing the connected sheet
 * mid-queue doesn't accidentally redirect already-captured leads.
 * `display_name` exists so the pill / expanded-list / error surfaces
 * can name the sheet without a round-trip to the backend.
 */
export interface QueueSheetTarget {
  spreadsheet_id: string;
  tab_name: string;
  display_name: string;
}

/**
 * The raw input that produced the capture.
 *
 * - For `pending_extraction` records (capture submitted offline before
 *   extraction could run): exactly one of `text` / `audio_blob_id` /
 *   `photo_blob_id` is non-null, matching the submitted source. The
 *   drainer uses this to re-extract when signal returns (plan §5.4).
 * - For `pending_save` records added AFTER a successful in-app review
 *   (Item 0 onward): all three may legitimately be null. The user has
 *   already seen the extraction succeed and confirmed the fields, so
 *   the recovery path is "retry the sheet write," not "re-extract."
 *   Storing the audio blob just for this case would burn quota for no
 *   user-visible benefit.
 */
export interface QueueRawInput {
  /** Raw text the user typed. Null for voice / photo. */
  text: string | null;
  /** Blob-store id for the recorded audio. Null for text / photo. */
  audio_blob_id: string | null;
  /** Blob-store id for the captured photo. Null for text / voice. */
  photo_blob_id: string | null;
}

/**
 * The extracted result, in the same shape the review surface
 * already consumes (`StreamingResult` from `api.ts`). Null while we
 * still need to (re)run extraction.
 */
export interface QueueExtracted {
  fields: ExtractedFields;
  original_text: string;
}

/**
 * One row in the `captures` object store. The id is a uuid v4
 * generated client-side at submit time and stays stable for the
 * record's entire life (matching the `idempotency_key`).
 */
export interface QueueRecord {
  id: string;
  /** ms epoch. FIFO ordering and 14-day expiry both pivot off this. */
  created_at: number;
  source: QueueSource;
  state: QueueState;
  /** Retry counter the backoff schedule reads. */
  attempts: number;
  /** ms epoch of the most recent attempt, or `null` if never attempted. */
  last_attempt_at: number | null;
  /** Populated only while `state` is one of the `failed_*` kinds. */
  last_error: QueueErrorEnvelope | null;
  /** Mirrored to the backend via `X-Idempotency-Key` on every save. */
  idempotency_key: string;
  sheet_target: QueueSheetTarget;
  raw_input: QueueRawInput;
  /** `null` while in `pending_extraction`. */
  extracted: QueueExtracted | null;
}

/**
 * One row in the `blobs` object store. Separated from `captures` so
 * the queue list can be rendered cheaply (just metadata) without
 * paging multi-MB photo data into memory. The blob itself is only
 * read at sync time and immediately released.
 *
 * `bytes` is denormalised from `blob.size` so quota math (plan §4.4)
 * doesn't need to fan out into every blob on every check.
 */
export interface BlobRecord {
  id: string;
  blob: Blob;
  content_type: string;
  bytes: number;
}

/**
 * One row in the `drafts` object store — review-draft autosave
 * (plan §4.3). NOT a queue record: drafts are scratch state for
 * "the tab died while the user was reviewing extracted fields".
 *
 * Promoted to a `QueueRecord` when the user taps Save; deleted on
 * explicit Discard or after 24h of no activity. There is at most
 * one draft per source at any time (the user can only review one
 * capture at a time), so writes go via `put` rather than `add`.
 */
export interface DraftRecord {
  id: string;
  source: QueueSource;
  /** The extraction the user is reviewing. */
  extracted: QueueExtracted;
  /** The user's in-progress edits, applied on top of `extracted`. */
  edits: Partial<ExtractedFields>;
  /** Blob-store id if the source is `photo`. */
  photo_blob_id: string | null;
  /** ms epoch. Updated on every autosave tick; drives the 24h sweep. */
  last_touched_at: number;
}
