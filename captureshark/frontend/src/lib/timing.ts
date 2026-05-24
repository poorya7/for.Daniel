/**
 * Timing primitives for the capture flow.
 *
 * Centralises the "feel" durations that make the difference between
 * ASMR-calm and amateur-feeling transitions. Numbers here are anchored
 * to specific perceptual targets — adjust with care, not by ear.
 */

/**
 * Minimum visible duration for the "Saving" sub-status of the outcome
 * phase, measured from the moment the sheet flips out of review.
 *
 * Anchored to:
 *   - 1320ms — when the last B-side child (`.outcome__line-area`,
 *     i.e. "to {Sheet name}") finishes drifting in (delay 620ms +
 *     duration 700ms). The saving panel needs to be fully landed
 *     before the B→C scanner morph kicks in.
 *   - ~130ms — a small breathable beat after the line lands and
 *     before "Saved" starts, so the saving panel reads as its own
 *     phase rather than a transitional flash.
 *
 * On a fast network, this holds the saving surface for the missing
 * milliseconds. On a slow network, the save itself takes the time and
 * this is a no-op. Every save feels identical regardless of speed.
 */
export const MIN_SAVING_VISIBLE_MS = 1450;

/**
 * Resolve after `ms` milliseconds. Returns immediately if `ms <= 0`,
 * so callers can pass `floor - elapsed` without guarding the sign.
 */
export function holdFor(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}
