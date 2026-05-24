/**
 * Pending-capture round-trip via localStorage.
 *
 * The OAuth sign-in flow takes the user out of the SPA and back
 * (Google's consent screen → our `/auth/google/return`). Anything in
 * React state during that round-trip is gone by the time we get back
 * unless we persist it. This module is the persistence boundary for the
 * single in-progress capture the user was reviewing.
 *
 * Per spec §3 ("CRITICAL: post-OAuth landing must preserve the
 * captured row"), the user must land back on the *same* review screen
 * with Save armed — not on a triage prompt. This file is what makes
 * that work.
 *
 * Storage shape is versioned (`v1`). Bumping `_VERSION` invalidates
 * pre-existing pending captures across deploys instead of trying to
 * read a stale incompatible blob and crashing.
 */

import type { ExtractedField, StreamingResult } from "@/lib/api";

const STORAGE_KEY = "captureshark.pendingCapture.v1";
const _VERSION = 1;

/** What we serialise into localStorage during the OAuth round-trip. */
export interface PendingCapture {
  /** The capture mode the result came from — restored as `source` in the API call. */
  source: "text" | "voice" | "photo";
  /** The fully extracted fields, same shape `ReviewCard` reads. */
  result: StreamingResult;
  /** Wall-clock timestamp the capture was stashed (ms epoch). */
  storedAt: number;
}

/** Storage envelope — keeps the version separate from the payload. */
interface Envelope {
  version: number;
  capture: PendingCapture;
}

/**
 * Stash a capture for the OAuth round-trip. Safe to call repeatedly;
 * the latest call wins (we only ever round-trip one capture at a time).
 *
 * Catches storage failures (quota, disabled storage in private mode)
 * so a quirky browser doesn't break the sign-in click. The worst
 * downside of a silent failure is that the user has to retype the
 * note after sign-in — same outcome we have without this feature.
 */
export function savePendingCapture(capture: Omit<PendingCapture, "storedAt">): void {
  const envelope: Envelope = {
    version: _VERSION,
    capture: { ...capture, storedAt: Date.now() },
  };
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(envelope));
  } catch {
    // Disabled / full / private mode — silently degrade.
  }
}

/**
 * Read the stashed capture if any. Returns `null` for any of:
 *   - no stashed capture
 *   - localStorage unavailable
 *   - stale schema version (bumped `_VERSION`)
 *   - malformed payload (manual tampering, browser bug)
 *
 * Defensive parsing because the data round-trips through a hostile
 * surface (the user's local storage, editable in devtools).
 */
export function loadPendingCapture(): PendingCapture | null {
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!_isEnvelope(parsed) || parsed.version !== _VERSION) return null;
  if (!_isPendingCapture(parsed.capture)) return null;
  return parsed.capture;
}

/**
 * Clear the stashed capture once it's been processed (auto-saved,
 * dismissed, or restored into React state). Idempotent; safe to call
 * even if nothing was stored.
 */
export function clearPendingCapture(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // No-op — same fallback as save.
  }
}

// --- Validation helpers ----------------------------------------------------

function _isEnvelope(value: unknown): value is Envelope {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.version === "number" && typeof v.capture === "object";
}

function _isPendingCapture(value: unknown): value is PendingCapture {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v.source !== "text" && v.source !== "voice" && v.source !== "photo") return false;
  if (typeof v.storedAt !== "number") return false;
  if (!v.result || typeof v.result !== "object") return false;
  const result = v.result as Record<string, unknown>;
  if (typeof result.original_text !== "string") return false;
  if (!result.fields || typeof result.fields !== "object") return false;
  // We don't deep-validate every field shape — the consumer (`ReviewCard`)
  // tolerates partials anyway, and shallow validation is enough to reject
  // truly malformed payloads.
  const fields = result.fields as Record<string, unknown>;
  const required = ["name", "phone", "email", "area", "budget", "follow_up", "notes"];
  for (const key of required) {
    if (!(key in fields)) return false;
    const f = fields[key];
    if (f !== null && (typeof f !== "object" || !_isExtractedField(f))) return false;
  }
  return true;
}

function _isExtractedField(value: unknown): value is ExtractedField {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    "value" in v &&
    "confidence" in v &&
    _isConfidence(v.confidence) &&
    Array.isArray(v.alternatives)
  );
}

/**
 * Pin the confidence value to the canonical enum. Without this guard,
 * a tampered localStorage entry with `confidence: "lol-whatever"` would
 * round-trip and end up as a stray CSS class name (`review-row--lol-whatever`).
 * Cheap to validate at the boundary, eliminates a class of bugs.
 */
function _isConfidence(value: unknown): value is "high" | "medium" | "low" {
  return value === "high" || value === "medium" || value === "low";
}
