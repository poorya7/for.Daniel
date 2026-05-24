/**
 * SignInPanel — the inline panel that appears below the extracted fields
 * when the user taps "Save to sheet" but isn't ready (no session, or
 * signed in but missed the Drive checkbox on Google's consent screen).
 *
 * Two variants in one component because the visual scaffolding is
 * identical and the only difference is copy:
 *
 *   `needs-sign-in` — first-ever Save attempt. Title is "To save this,
 *     connect a sheet first." plus prep copy that warns the user about
 *     Google's granular-permissions checkbox (the "before" half of the
 *     sandwich UX).
 *
 *   `needs-retry`   — user signed in but skipped the Drive permission.
 *     Title is "One more tap to save." with friendly copy that tells
 *     them what to look for this time (the "after" half).
 *
 * The panel is intentionally not a modal / overlay — per spec §3, the
 * extracted rows stay visible above so the user doesn't feel like
 * their data vanished.
 */

import { SIGN_IN_URL } from "@/lib/api";

interface SignInPanelProps {
  variant: "needs-sign-in" | "needs-retry";
  /** Called when the user dismisses the panel (e.g. "Not now" link). */
  onDismiss: () => void;
  /**
   * Optional pre-redirect hook — runs before we navigate the browser
   * to Google. The parent uses this to stash the in-progress capture
   * in localStorage so it can be restored on the post-OAuth landing.
   * Errors here MUST NOT block the redirect: a degraded round-trip
   * (note lost) is still better than a stuck button.
   */
  onBeforeRedirect?: () => void;
}

export function SignInPanel({
  variant,
  onDismiss,
  onBeforeRedirect,
}: SignInPanelProps): React.ReactElement {
  function handleSignIn(): void {
    try {
      onBeforeRedirect?.();
    } catch {
      // Persistence failure shouldn't strand the user mid-click.
      // Worst case the note is lost on the round-trip; the sign-in
      // itself still works and they can retype on landing.
    }
    window.location.href = SIGN_IN_URL;
  }

  const copy = variant === "needs-sign-in" ? COPY_FIRST_TIME : COPY_RETRY;

  return (
    <section
      className="sign-in-panel"
      aria-labelledby="sign-in-heading"
      data-variant={variant}
    >
      <h3 id="sign-in-heading">{copy.title}</h3>
      <p className="sign-in-lead">{copy.lead}</p>
      <p className="sign-in-prep">
        <strong>Heads up:</strong> {copy.prep}
      </p>

      <button
        type="button"
        className="primary-action sign-in-button"
        onClick={handleSignIn}
      >
        {copy.button}
      </button>
      <button type="button" className="link-action" onClick={onDismiss}>
        Not now
      </button>
    </section>
  );
}

// Copy lives at module scope so the test file can assert against it
// without re-deriving from JSX. Keeping it short and conversational —
// the 75-year-old broker bar (per project rules) is the test.
const COPY_FIRST_TIME = {
  title: "To save this, connect a sheet first.",
  lead: "You’ll sign in with Google, then pick the sheet you want to add leads to.",
  prep:
    "Google will show a checkbox asking permission to write to your sheet. " +
    "Tap it — without it, we can’t save your leads.",
  button: "Sign in with Google",
} as const;

const COPY_RETRY = {
  title: "One more tap to save.",
  lead: "You’re signed in, but a permission was skipped on the last screen.",
  prep:
    "When Google asks again, look for the checkbox about your Google Sheets. " +
    "Tap it this time — that’s the one we need.",
  button: "Try again",
} as const;
