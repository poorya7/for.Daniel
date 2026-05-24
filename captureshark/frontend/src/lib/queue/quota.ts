/**
 * Byte-based + count-based quota gate for the capture queue.
 *
 * Plan §4.4 / §9.7. Two limits, both consulted before the capture
 * submit path writes a new record:
 *
 *   - **Hard ceiling: 95% of `navigator.storage.estimate()` quota.**
 *     At this point the browser is at real risk of evicting our
 *     IndexedDB content under pressure. New captures are refused
 *     with the calm "you've got a backlog — get on Wi-Fi to clear
 *     it" surface. Existing queued captures still drain normally.
 *
 *   - **Soft cap (warn but accept):**
 *       - 50 text/voice captures, OR
 *       - 20 photo captures, OR
 *       - 80% byte usage,
 *     whichever fires first. UI surfaces can use this as a hint
 *     ("queue is getting full"); the capture submit still accepts.
 *
 * Counts are per source kind because the dominant constraint differs
 * by source — 30 text notes is 30 KB and basically free; 30 photos
 * is 90 MB and a real load. A flat count would either let photo
 * users blow the quota silently or block text users for no reason.
 *
 * Persistent-storage request (`navigator.storage.persist()`) is
 * fired ONCE on first queue write — that's the moment we're asking
 * the user to trust us with their offline-captured leads, and the
 * browser's permission prompt is much more likely to be granted in
 * that context than on cold boot.
 *
 * The module owns:
 *   - The four threshold constants.
 *   - The `checkQuotaForNewCapture(source)` decision function.
 *   - The `requestPersistentStorageOnce` idempotent kick-off.
 * It does NOT own the UI ("when the cap is hit, what does the
 * surface look like?") — that's the capture-submit caller's job,
 * since the right copy depends on which surface the user is on.
 */

import { queueDb } from "@/lib/queue/db";
import type { QueueSource } from "@/lib/queue/types";

/** Soft-cap count for text + voice captures (combined). */
export const SOFT_CAP_TEXT_VOICE_COUNT = 50;
/** Soft-cap count for photo captures. */
export const SOFT_CAP_PHOTO_COUNT = 20;
/** Soft-cap byte usage as a fraction of `navigator.storage.estimate()` quota. */
export const SOFT_CAP_QUOTA_RATIO = 0.8;
/** Hard-cap byte usage as a fraction of quota. New captures refused beyond this. */
export const HARD_CAP_QUOTA_RATIO = 0.95;

export type QuotaSeverity = "ok" | "soft_cap" | "hard_cap";

/**
 * The drainer-side decision the capture submit path reads. `severity`
 * controls the accept/refuse branch; `reason` is the plain-English
 * line a UI surface can show; `usage_ratio` is exposed so a
 * progress-pill in the queue UI can render a fill bar.
 */
export interface QuotaStatus {
  severity: QuotaSeverity;
  /** User-readable reason, null when severity is "ok". */
  reason: string | null;
  /**
   * Bytes used / quota, in [0, 1]. `null` when the browser doesn't
   * expose `navigator.storage.estimate()` or returns undefined
   * fields. Treat null as "unknown — don't gate on it".
   */
  usage_ratio: number | null;
  /** Counts behind the soft-cap count check, for UI surfaces. */
  counts: {
    text_voice: number;
    photo: number;
  };
}

/**
 * Decide whether a new capture of the given `source` should be
 * accepted into the queue. Caller branches on `status.severity`:
 *
 *   - `"ok"`:        accept silently.
 *   - `"soft_cap"`:  accept, but the calling UI can surface a hint
 *                    so the user knows the queue is filling up.
 *   - `"hard_cap"`:  REFUSE. Surface the calm "get on Wi-Fi" message
 *                    so the user can resolve before another capture
 *                    pushes IndexedDB to the eviction edge.
 */
export async function checkQuotaForNewCapture(
  source: QueueSource,
): Promise<QuotaStatus> {
  const [textVoiceCount, photoCount, usageRatio] = await Promise.all([
    _countTextVoice(),
    _countPhoto(),
    _estimateUsageRatio(),
  ]);

  const counts = { text_voice: textVoiceCount, photo: photoCount };

  // Hard cap fires first — bytes are the actual eviction risk; the
  // count-based soft cap is a hint, not a safety boundary.
  if (usageRatio !== null && usageRatio >= HARD_CAP_QUOTA_RATIO) {
    return {
      severity: "hard_cap",
      reason: _hardCapMessage(),
      usage_ratio: usageRatio,
      counts,
    };
  }

  // Soft caps: any one of the three fires.
  const sourceCount = source === "photo" ? photoCount : textVoiceCount;
  const sourceLimit =
    source === "photo" ? SOFT_CAP_PHOTO_COUNT : SOFT_CAP_TEXT_VOICE_COUNT;

  if (sourceCount >= sourceLimit) {
    return {
      severity: "soft_cap",
      reason: _softCapCountMessage(source),
      usage_ratio: usageRatio,
      counts,
    };
  }

  if (usageRatio !== null && usageRatio >= SOFT_CAP_QUOTA_RATIO) {
    return {
      severity: "soft_cap",
      reason: _softCapQuotaMessage(),
      usage_ratio: usageRatio,
      counts,
    };
  }

  return {
    severity: "ok",
    reason: null,
    usage_ratio: usageRatio,
    counts,
  };
}

/**
 * Ask the browser to mark our IndexedDB as "persistent" so it isn't
 * evicted under pressure. iOS Safari ignores this on non-PWA installs
 * (eviction still applies after 7 idle days) but Chrome / Edge
 * respect it. Fires at most once per session — repeated calls are
 * cheap but pointless.
 *
 * Returns `true` if the browser confirmed persistence (either now or
 * already), `false` if it refused or the API isn't available.
 */
let _persistRequested = false;
let _persistResult: boolean | null = null;
export async function requestPersistentStorageOnce(): Promise<boolean> {
  if (_persistRequested) {
    return _persistResult ?? false;
  }
  _persistRequested = true;

  // Feature-detect. Older Safari + WebView builds expose
  // `navigator.storage` without `persist`, so check the method
  // specifically.
  const storage = _storageManagerOrNull();
  if (!storage || typeof storage.persist !== "function") {
    _persistResult = false;
    return false;
  }
  try {
    const granted = await storage.persist();
    _persistResult = granted === true;
    return _persistResult;
  } catch {
    // Some embedded WebViews reject permission requests synchronously
    // via a thrown error rather than a `false` resolve. Treat as a
    // soft "no" — we still queue, we just don't have eviction
    // protection.
    _persistResult = false;
    return false;
  }
}

/** Test-only reset for the persistent-storage memoised result. */
export function _resetPersistentStorageMemoForTests(): void {
  _persistRequested = false;
  _persistResult = null;
}

// --- internals -------------------------------------------------------------

async function _countTextVoice(): Promise<number> {
  // Full-table filter — `source` isn't a Dexie secondary index (we
  // don't want to bloat IndexedDB metadata for a field with three
  // values), so we scan. The queue is bounded by the soft cap
  // itself (~50 records), making the scan trivial in practice.
  return queueDb.captures
    .filter((r) => r.source === "text" || r.source === "voice")
    .count();
}

async function _countPhoto(): Promise<number> {
  return queueDb.captures.filter((r) => r.source === "photo").count();
}

/**
 * Bytes used / quota in [0, 1], or `null` when the browser doesn't
 * support `navigator.storage.estimate()` or returns partial data.
 *
 * Older iOS Safari + some WebView builds return an estimate with
 * `quota: 0`, which would divide-by-zero into Infinity. Treat any
 * non-positive quota as unknown.
 */
async function _estimateUsageRatio(): Promise<number | null> {
  const storage = _storageManagerOrNull();
  if (!storage || typeof storage.estimate !== "function") {
    return null;
  }
  try {
    const estimate = await storage.estimate();
    const usage = typeof estimate.usage === "number" ? estimate.usage : null;
    const quota = typeof estimate.quota === "number" ? estimate.quota : null;
    if (usage === null || quota === null || quota <= 0) {
      return null;
    }
    return Math.min(1, Math.max(0, usage / quota));
  } catch {
    return null;
  }
}

function _storageManagerOrNull(): StorageManager | null {
  if (typeof navigator === "undefined") return null;
  const storage = (navigator as Navigator & { storage?: StorageManager })
    .storage;
  return storage ?? null;
}

function _hardCapMessage(): string {
  return "You have a lot of captures waiting. Get on Wi-Fi for a moment to clear the backlog before adding more.";
}

function _softCapQuotaMessage(): string {
  return "Your captures are taking up a lot of space. Get on Wi-Fi soon to clear the backlog.";
}

function _softCapCountMessage(source: QueueSource): string {
  if (source === "photo") {
    return "You have a lot of photos waiting. Get on Wi-Fi soon to clear the backlog.";
  }
  return "You have a lot of notes waiting. Get on Wi-Fi soon to clear the backlog.";
}
