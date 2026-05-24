/**
 * Auth gate for the save flow — shared by the single-row save path and
 * the photo-batch save path so the two can't drift on policy.
 *
 * Pure, side-effect-free, no React. Inputs are the four auth-store
 * selectors the save flow needs; output is a discriminated union the
 * caller branches on to either run the save or surface the matching
 * SignInPanel variant.
 *
 * Lives in `features/auth/` alongside SignInPanel so the gate + the UI
 * it routes to are co-located.
 */

import type { ConnectedSheet } from "@/lib/api";
import type { AuthStatus } from "@/stores/auth";

/**
 * The decision the save flow needs from the auth state before it
 * touches the queue. Discriminated union so the call site can branch
 * on `kind` and either run the save or route to the matching auth
 * panel.
 */
export type SaveAuthDecision =
  | { kind: "allow" }
  | { kind: "needs-sign-in" }
  | { kind: "needs-retry" };

export interface SaveAuthInput {
  authConfigured: boolean | null;
  authStatus: AuthStatus;
  hasDriveAccess: boolean;
  connectedSheet: ConnectedSheet | null;
}

/**
 * Single source of truth for the "should we save, or pop the sign-in
 * panel?" question. Used by both the single-row save path
 * (`handleSave`) and the photo-batch save path
 * (`handleSaveAllPhotoRows`) so the rules don't drift.
 *
 * Five cases, in order:
 *   1. Backend not OAuth-configured (dev / half-set env) → allow,
 *      the dev service-account path handles it.
 *   2. Signed-in + drive + already-picked sheet → allow.
 *   3. Signed-in + drive + NO sheet picked → needs-sign-in. The
 *      Google Sheet Picker would belong here once that slice lands;
 *      for now we route the user back through sign-in so they get a
 *      visible nudge rather than a silent failure.
 *   4. Signed-in + NO drive → needs-retry (they skipped the Drive
 *      permission checkbox on Google's consent screen).
 *   5. Otherwise (signed-out / unknown) → needs-sign-in.
 */
export function checkSaveAuth(input: SaveAuthInput): SaveAuthDecision {
  if (input.authConfigured === false) {
    return { kind: "allow" };
  }
  if (
    input.authStatus === "signed-in" &&
    input.hasDriveAccess &&
    input.connectedSheet !== null
  ) {
    return { kind: "allow" };
  }
  if (input.authStatus === "signed-in" && !input.hasDriveAccess) {
    return { kind: "needs-retry" };
  }
  return { kind: "needs-sign-in" };
}
