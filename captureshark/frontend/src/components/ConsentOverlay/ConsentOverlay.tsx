/**
 * Generic consent overlay.
 *
 * One-time "just so you know" disclosure used by any flow that ships
 * data off-device (voice → transcription service, photo → vision
 * model, etc.). Used to be duplicated per-feature; lifted into a
 * shared primitive on 2026-05-17 so adding a future disclosure is a
 * call-site change with three strings, not a new component family.
 *
 * Visual posture (shared across every consent moment in the app):
 *  - No hard modal, no card-drop. Soft scrim + a centred panel that
 *    fades in over ~280ms.
 *  - Plain-English copy per docs/_workflow/02_PRINCIPLES.md §6 — the call site supplies
 *    the title + body; this component never embeds product copy.
 *  - Two visible buttons — primary CTA dominant, secondary "Maybe
 *    later" small + clearly tappable so the broker has an obvious
 *    escape hatch and never feels trapped.
 *
 * Positioning: this component renders with `position: absolute;
 * inset: 0;` and expects its parent to be a positioned container
 * (relative / absolute / fixed). The voice surface and the photo
 * capture surface both already are, so no parent-side changes were
 * needed when this was extracted.
 *
 * Reduced-motion: skip the fade, render at final opacity. The CSS
 * media query handles this without a JS branch.
 */

import { useRef } from "react";

import "./ConsentOverlay.css";

export interface ConsentOverlayProps {
  /** Short heading at the top of the panel. Same tone as the body —
   *  *"Just so you know"* is the canonical default the existing two
   *  consent moments use, but the call site supplies it explicitly
   *  so a future feature can change it without monkey-patching here. */
  title: string;
  /** One-to-two sentence plain-English explanation of what's about
   *  to happen with the user's data. The body is purely string so
   *  there's no temptation to embed React nodes / formatting that
   *  drifts across features. */
  body: string;
  /** Label on the primary CTA. Defaults to *"Got it"*. */
  acceptLabel?: string;
  /** Label on the secondary text-button below the primary CTA.
   *  Defaults to *"Maybe later"*. */
  dismissLabel?: string;
  /** Fired when the broker taps the primary CTA. The call site
   *  persists consent (via its own `consentStorage.record()`) and
   *  unlocks the gated path. */
  onAccept: () => void;
  /** Fired when the broker taps the secondary button. The call site
   *  rolls back the in-progress surface (closes the sheet, stops
   *  tracks, etc.). Consent is NOT persisted so the overlay returns
   *  on the next attempt. */
  onDismiss: () => void;
  /** Optional id for the `aria-labelledby` link. Defaults to a value
   *  that's unique enough for the two-overlay-at-a-time-ceiling we
   *  currently target; supply your own when stacking gets denser. */
  titleId?: string;
}

const DEFAULT_TITLE_ID = "consent-overlay-title";

export function ConsentOverlay({
  title,
  body,
  acceptLabel = "Got it",
  dismissLabel = "Maybe later",
  onAccept,
  onDismiss,
  titleId = DEFAULT_TITLE_ID,
}: ConsentOverlayProps): React.ReactElement {
  // Idempotency guard — iOS Safari occasionally fires both a touchend
  // and a click for a single tap. Without this, the callback would
  // fire twice and the second call would land after the parent has
  // unmounted us (harmless but noisy in the console).
  const settledRef = useRef(false);

  function handleAccept(): void {
    if (settledRef.current) return;
    settledRef.current = true;
    onAccept();
  }

  function handleDismiss(): void {
    if (settledRef.current) return;
    settledRef.current = true;
    onDismiss();
  }

  return (
    <div
      className="consent-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
    >
      <div className="consent-panel">
        <h2 id={titleId} className="consent-title">
          {title}
        </h2>
        <p className="consent-body">{body}</p>
        <button
          type="button"
          className="capture-primary consent-cta"
          onClick={handleAccept}
        >
          {acceptLabel}
        </button>
        <button
          type="button"
          className="consent-dismiss"
          onClick={handleDismiss}
        >
          {dismissLabel}
        </button>
      </div>
    </div>
  );
}
