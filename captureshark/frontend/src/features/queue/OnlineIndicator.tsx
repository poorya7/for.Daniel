/**
 * Ambient online/offline indicator (plan §8.5).
 *
 * Lives next to the wordmark on the home screen. The locked principle
 * is awareness without alarm — Linda should know she's offline so she
 * can interpret "captures are queueing up", but she should never feel
 * blocked, never see a red banner.
 *
 * When online: renders nothing. The absence is the affordance — the
 * home screen looks unchanged in the happy path.
 *
 * When offline: a tiny grey dot + "Offline mode" copy, same scale as
 * the existing dev footer. No fade-in panic, no spinner — calm.
 */

import "./OnlineIndicator.css";

import type { OnlineState } from "@/lib/queue/onlineDetection";

export interface OnlineIndicatorProps {
  state: OnlineState;
}

export function OnlineIndicator({
  state,
}: OnlineIndicatorProps): React.ReactElement | null {
  if (state === "online") return null;
  return (
    <div
      className="online-indicator"
      role="status"
      // Polite: announce once when offline is entered, then stay
      // silent. We don't want screen readers re-announcing this every
      // 30s while the user is mid-capture.
      aria-live="polite"
    >
      <span
        className="online-indicator__dot"
        aria-hidden="true"
      />
      <span className="online-indicator__text">Offline mode</span>
    </div>
  );
}
