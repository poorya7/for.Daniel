/**
 * HTTP status / `ApiError.code` → drainer next-state mapping.
 *
 * The drainer asks two questions after a save attempt fails:
 *   1. What state should the record go to? (`failed_transient`,
 *      `failed_auth`, or `failed_permanent`)
 *   2. What error code do we stash in `last_error.code` so the UI
 *      can render a calm message?
 *
 * Both answers come from this single mapping table, keeping the
 * route-status / queue-state correspondence in one place. The plan's
 * locked principle is that NETWORK failures retry forever — that's
 * encoded by classifying them as `failed_transient`. Non-network
 * transient failures (unknown / unmapped) get a retry ceiling
 * elsewhere; this module just answers "what kind is this".
 */

import type { ExtractAttemptFailure } from "@/lib/queue/extract";
import type { QueueErrorCode, QueueState } from "@/lib/queue/types";

/**
 * Wire-level shape of a failed save attempt as the drainer sees it.
 * Either an HTTP non-2xx (in which case we have a status + optional
 * backend code) or a transport failure (no status — fetch threw).
 */
export interface SaveAttemptFailure {
  /** HTTP status, or `0` when the request never reached the server. */
  status: number;
  /** Backend `ErrorBody.code`, or `undefined` for transport failures. */
  code: string | undefined;
}

export interface ClassifiedFailure {
  next_state: QueueState;
  error_code: QueueErrorCode;
}

/**
 * Classify one failed save attempt.
 *
 * Status 0 (transport failure) → `network` / `failed_transient`. The
 * locked principle: never make Linda tap retry for a connectivity
 * problem.
 *
 * 401 auth-expired family → `failed_auth`. The drainer halts the
 * pass; the UI surfaces a single sign-in CTA (plan §3.1).
 *
 * 403 / 404 / 409 → `failed_permanent`. These are real state problems
 * (revoked access, deleted sheet, no connected sheet) that need user
 * input — no amount of retrying changes the outcome.
 *
 * 429 / 5xx → `failed_transient`. Treat as network-equivalent;
 * upstream is busy or temporarily broken, retry on backoff.
 *
 * Anything else (including `200 OK` — shouldn't happen here but
 * defence in depth) → `failed_transient` with `unknown`. The drainer
 * gives unknowns a bounded retry ceiling.
 */
export function classifySaveFailure(failure: SaveAttemptFailure): ClassifiedFailure {
  if (failure.status === 0) {
    return { next_state: "failed_transient", error_code: "network" };
  }
  if (failure.status === 401) {
    return { next_state: "failed_auth", error_code: "auth_expired" };
  }
  if (failure.status === 403) {
    return { next_state: "failed_permanent", error_code: "forbidden" };
  }
  if (failure.status === 404) {
    // Backend uses `sheet_not_found` for a missing sheet; our queue
    // taxonomy is `not_found`. Drop the code prefix that's
    // route-specific.
    return { next_state: "failed_permanent", error_code: "not_found" };
  }
  if (failure.status === 409) {
    // `no_sheet_connected` — user has no sheet picked. The expanded
    // queue list will show a "save to a different sheet" CTA.
    return { next_state: "failed_permanent", error_code: "sheet_revoked" };
  }
  if (failure.status === 429) {
    return { next_state: "failed_transient", error_code: "ai_busy" };
  }
  if (failure.status >= 500 && failure.status < 600) {
    return { next_state: "failed_transient", error_code: "network" };
  }
  return { next_state: "failed_transient", error_code: "unknown" };
}

/**
 * Classify one failed extraction attempt.
 *
 * Transport failures (`undefined` code or explicit `"network"`) →
 * `failed_transient` with `network`. Locked principle applies just
 * as much to extracts as to saves: never make Linda tap retry for
 * a connectivity problem.
 *
 * `ai_busy` → `failed_transient` with `ai_busy`. The upstream LLM /
 * vision / Whisper service is rate-limited or hot — retry on
 * backoff. The drainer's non-network ceiling applies (3x → permanent),
 * matching the save-path behaviour.
 *
 * `no_signal` / `empty_input` → `failed_permanent` with
 * `extraction_failed`. These mean the backend got the input and
 * decided it's unusable (silent audio, blank text, garbage transcript,
 * unreadable photo). Retrying with the same raw input cannot change
 * the verdict — surface for the user to review or discard, do not
 * silently write zero data.
 *
 * Anything else → `failed_transient` with `unknown`. Bounded retry
 * via the same ceiling.
 */
export function classifyExtractFailure(
  failure: ExtractAttemptFailure,
): ClassifiedFailure {
  const code = failure.code;
  if (code === undefined || code === "network") {
    return { next_state: "failed_transient", error_code: "network" };
  }
  if (code === "ai_busy") {
    return { next_state: "failed_transient", error_code: "ai_busy" };
  }
  if (code === "no_signal" || code === "empty_input") {
    return { next_state: "failed_permanent", error_code: "extraction_failed" };
  }
  return { next_state: "failed_transient", error_code: "unknown" };
}

/**
 * Plain-English message the UI can surface for a given error code.
 * Kept in this module (next to the mapping) so the two stay in
 * lockstep; the queue UI surfaces just read `last_error.message`
 * without knowing about codes.
 */
export function messageForCode(code: QueueErrorCode): string {
  switch (code) {
    case "network":
      return "We're having trouble reaching the network. We'll keep trying.";
    case "ai_busy":
      return "Google Sheets is busy. We'll try again in a moment.";
    case "auth_expired":
      return "Sign in again to finish saving.";
    case "sheet_revoked":
      return "Pick a sheet to save to.";
    case "forbidden":
      return "We don't have permission to write to this sheet.";
    case "not_found":
      return "We can't find your sheet anymore.";
    case "schema_mismatch":
      return "Your sheet columns don't match. Open the sheet to check.";
    case "extraction_failed":
      return "We couldn't read this capture. Open it to review.";
    case "unknown":
      return "Something went wrong. We'll try again.";
  }
}
