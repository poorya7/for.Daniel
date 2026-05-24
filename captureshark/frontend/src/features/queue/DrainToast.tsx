/**
 * Drain-complete toast (plan §8.3).
 *
 * Tiny tray-style toast at the bottom of the home screen, fired by
 * the parent when the drainer reports a non-zero `saved` count. Auto-
 * dismisses after `DISMISS_MS`.
 *
 * Privacy (plan §8.3 / engineer #2 #4):
 *   - Universal copy only. Never names the lead.
 *   - Toasts surface on iOS lock screens, in screen-shares, on macOS
 *     notification mirrors. "Saved Maria Lopez to your sheet" is a
 *     real-world leak vector.
 *
 * Suppression contract: the PARENT owns the "don't show during
 * capture flow" rule (plan §8.3 last paragraph) — this component
 * just renders when asked. The reasoning: the parent knows whether a
 * capture sheet is open; we don't want to thread that context through
 * the queue layer.
 */

import { useEffect } from "react";

import "./DrainToast.css";

const DISMISS_MS = 3_500;

export interface DrainToastProps {
  /**
   * How many records the most recent drain saved. The toast is
   * conditionally rendered by the parent based on this; we accept
   * it here too so the copy stays in sync with the count.
   */
  savedCount: number;
  /**
   * Called when the auto-dismiss timer elapses OR the user dismisses
   * manually. The parent clears its "show toast" state in response.
   */
  onDismiss: () => void;
}

export function DrainToast({
  savedCount,
  onDismiss,
}: DrainToastProps): React.ReactElement {
  useEffect(() => {
    const id = setTimeout(onDismiss, DISMISS_MS);
    return () => {
      clearTimeout(id);
    };
  }, [onDismiss]);

  return (
    <div
      className="drain-toast"
      role="status"
      // Polite so it doesn't interrupt an in-flight screen-reader
      // utterance — the toast is informational, not actionable.
      aria-live="polite"
    >
      <span
        className="drain-toast__check"
        aria-hidden="true"
      >
        ✓
      </span>
      <span className="drain-toast__text">{formatCopy(savedCount)}</span>
    </div>
  );
}

function formatCopy(n: number): string {
  if (n <= 1) return "Capture saved to your sheet.";
  return `${n} captures saved to your sheet.`;
}
