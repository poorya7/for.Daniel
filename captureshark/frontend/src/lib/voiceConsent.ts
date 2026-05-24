/**
 * Voice-transcription consent — local persistence.
 *
 * Thin facade over the generic `createConsentStorage` factory in
 * `consentStorage.ts`. Existed as a standalone implementation
 * until 2026-05-17, when the photo consent landed and the duplication
 * became obvious; the read/write/clear logic now lives in one place
 * (the factory), and this file just binds it to the voice-specific
 * storage key.
 *
 * Voice and photo consents are stored under separate keys —
 * agreeing to one isn't an agreement to the other. They are
 * different data shipments to different providers.
 *
 * Public surface is unchanged for callers: `readVoiceConsent`,
 * `hasVoiceConsent`, `recordVoiceConsent`, `clearVoiceConsent`,
 * and the `VoiceConsentRecord` type alias all still exist.
 */

import {
  type ConsentRecord,
  createConsentStorage,
} from "./consentStorage";

const STORAGE_KEY = "captureshark.voiceConsent.v1";
const CURRENT_VERSION = 1;

const _storage = createConsentStorage({
  storageKey: STORAGE_KEY,
  currentVersion: CURRENT_VERSION,
});

/** @deprecated alias — use `ConsentRecord` directly going forward. */
export type VoiceConsentRecord = ConsentRecord;

export const readVoiceConsent = _storage.read;
export const hasVoiceConsent = _storage.has;
export const recordVoiceConsent = _storage.record;
export const clearVoiceConsent = _storage.clear;

// Dev-only URL trigger so the consent overlay can be re-tested on a
// phone without manually clearing storage. Visit
// `dev.captureshark.com/?reset-consent=1` once and the next voice
// tap shows the overlay again. Stripped from production builds by
// Vite's dead-code elimination on `import.meta.env.DEV`. The same
// pattern is used for the `?simfail=*` QA flags elsewhere in the
// codebase.
if (import.meta.env.DEV && typeof window !== "undefined") {
  try {
    const params = new URLSearchParams(window.location.search);
    if ((params.get("reset-consent") ?? "").startsWith("1")) {
      clearVoiceConsent();
    }
  } catch {
    /* swallow — dev-only convenience, never escalate */
  }
}
