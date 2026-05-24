/**
 * Photo-extraction consent — local persistence.
 *
 * Thin facade over the generic `createConsentStorage` factory in
 * `consentStorage.ts`. Sibling to `voiceConsent.ts`; both bind the
 * same factory to their feature-specific storage keys.
 *
 * Voice and photo consents are stored under separate keys —
 * agreeing to one isn't an agreement to the other. They are
 * different data shipments to different providers.
 *
 * Public surface mirrors `voiceConsent.ts`: `readPhotoConsent`,
 * `hasPhotoConsent`, `recordPhotoConsent`, `clearPhotoConsent`,
 * and the `PhotoConsentRecord` type alias.
 */

import {
  type ConsentRecord,
  createConsentStorage,
} from "./consentStorage";

const STORAGE_KEY = "captureshark.photoConsent.v1";
const CURRENT_VERSION = 1;

const _storage = createConsentStorage({
  storageKey: STORAGE_KEY,
  currentVersion: CURRENT_VERSION,
});

/** @deprecated alias — use `ConsentRecord` directly going forward. */
export type PhotoConsentRecord = ConsentRecord;

export const readPhotoConsent = _storage.read;
export const hasPhotoConsent = _storage.has;
export const recordPhotoConsent = _storage.record;
export const clearPhotoConsent = _storage.clear;

// Dev-only URL trigger so the consent overlay can be re-tested on a
// phone without manually clearing storage. Visit
// `dev.captureshark.com/?reset-photo-consent=1` once and the next
// photo tap shows the overlay again. Stripped from production
// builds by Vite's dead-code elimination on `import.meta.env.DEV`.
if (import.meta.env.DEV && typeof window !== "undefined") {
  try {
    const params = new URLSearchParams(window.location.search);
    if ((params.get("reset-photo-consent") ?? "").startsWith("1")) {
      clearPhotoConsent();
    }
  } catch {
    /* swallow — dev-only convenience, never escalate */
  }
}
