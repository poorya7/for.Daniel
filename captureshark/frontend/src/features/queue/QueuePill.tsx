/**
 * Queue pill — the landing-page surface that tells the user "we have
 * some captures waiting; we're handling them" (plan §8.1).
 *
 * Calm by design. The locked principle is that a busy open house in a
 * basement is 60-90 minutes of bad signal, and Linda should not feel
 * pressure during those 90 minutes — so this pill is cyan
 * (informational), never amber/red, never blinking.
 *
 * Surface shape:
 *
 *   1. Pending count (informational):
 *        "1 waiting to save"   /   "4 waiting to save"
 *      A subtle pulse rides on the dot when any record is in
 *      `syncing` (one save in flight right now).
 *
 *   2. Optional muted-amber dot inside the pill when at least one
 *      record is in `failed_permanent`. The pill copy becomes
 *      "4 waiting · 1 needs review". Tappable; tapping opens the
 *      expanded list so the user can resolve the offending row.
 *
 *   3. Sibling "Sign in to finish saving" CTA below the pill when
 *      any record is in `failed_auth`. Sibling (not nested inside
 *      the pill) so the auth resolution is visible from the home
 *      screen at a glance — see plan §3.1 / §8.1 / §11 Q6.
 *
 * Hidden entirely when the queue is empty. No empty-state UI; the
 * absence of the pill IS the empty state, which is what keeps the
 * happy-path home screen looking unchanged.
 *
 * The component is purely presentational — the parent owns the
 * "tap to expand" wiring (because the list sheet is also parent-
 * owned, to keep z-index / focus management in one place).
 */

import "./QueuePill.css";

import type { QueueSummary } from "@/lib/queue/queueState";

export interface QueuePillProps {
  /** Aggregate summary, typically from `useQueueSummary()`. */
  summary: QueueSummary;
  /** `true` while a record is in `syncing` — drives the pulse. */
  syncingNow: boolean;
  /** Open the expanded list (parent owns the overlay). */
  onExpand: () => void;
  /** Invoked when the user taps the "Sign in to finish saving" CTA. */
  onSignIn: () => void;
}

export function QueuePill({
  summary,
  syncingNow,
  onExpand,
  onSignIn,
}: QueuePillProps): React.ReactElement | null {
  // Hidden when there is nothing in the queue at all — including
  // failed_auth and failed_permanent. If the user has resolved
  // everything, the pill goes away.
  if (summary.total === 0) return null;

  // Pending count is the headline. `pending` already counts the
  // auto-progressing states (incl. `syncing` and `failed_transient`)
  // per the summary contract; `failed_auth` shows up only via the
  // sibling CTA below, and `failed_permanent` is the muted-amber
  // suffix inside the pill.
  const pendingLabel = formatPendingLabel(summary.pending);
  const reviewLabel =
    summary.failed_permanent > 0
      ? formatNeedsReviewLabel(summary.failed_permanent)
      : null;

  return (
    <div className="queue-pill-group">
      <button
        type="button"
        className="queue-pill"
        data-syncing={syncingNow ? "true" : undefined}
        data-needs-review={reviewLabel !== null ? "true" : undefined}
        onClick={onExpand}
        aria-label={
          reviewLabel === null
            ? pendingLabel
            : `${pendingLabel}, ${reviewLabel}`
        }
      >
        <span
          className="queue-pill__dot"
          aria-hidden="true"
        />
        <span className="queue-pill__text">
          {summary.pending > 0 && (
            <span className="queue-pill__pending">{pendingLabel}</span>
          )}
          {reviewLabel !== null && (
            <>
              {summary.pending > 0 && (
                <span
                  className="queue-pill__sep"
                  aria-hidden="true"
                >
                  ·
                </span>
              )}
              <span className="queue-pill__needs-review">{reviewLabel}</span>
            </>
          )}
        </span>
      </button>

      {summary.failed_auth > 0 && (
        <button
          type="button"
          className="queue-pill-cta"
          onClick={onSignIn}
        >
          Sign in to finish saving
        </button>
      )}
    </div>
  );
}

function formatPendingLabel(n: number): string {
  if (n === 0) return "";
  if (n === 1) return "1 waiting to save";
  return `${n} waiting to save`;
}

function formatNeedsReviewLabel(n: number): string {
  if (n === 1) return "1 needs review";
  return `${n} need review`;
}
