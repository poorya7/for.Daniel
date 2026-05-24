/**
 * Generic localStorage-backed consent record.
 *
 * Each "we send X to a remote service" disclosure in the app needs
 * to remember whether the broker has tapped "Got it" so we don't
 * re-prompt every session. The shape, serialisation, and
 * defensiveness around schema drift / parse errors / private-mode
 * storage are identical across every such dialog — voice goes to a
 * transcription service, photo goes to a vision model, and any
 * future feature that ships data off-device follows the same
 * pattern.
 *
 * Rather than copy-pasting the read / write / clear / version-check
 * logic per feature (the lazy move), feature consents are built by
 * calling `createConsentStorage({ storageKey, currentVersion })`.
 * Each call returns its own set of helpers bound to that specific
 * localStorage key, so the records stay independent — agreeing to
 * the voice disclosure does NOT imply agreement to the photo one,
 * and vice versa.
 *
 * Schema is a single JSON object with a version number so the legal
 * copy can change in the future without invalidating older records
 * (bump `currentVersion` to force a re-prompt).
 *
 *   { v: 1, acceptedAt: "2026-05-17T20:34:12.123Z" }
 *
 * If parsing fails (cleared storage, corrupted blob, schema drift
 * we don't yet recognise) we treat that as "no consent on file" and
 * re-prompt. Safer than silently letting an unknown shape count as
 * consent.
 */

export interface ConsentRecord {
  /** Schema version. Bump if the legal copy changes meaningfully. */
  v: number;
  /** ISO-8601 instant the broker tapped "Got it". */
  acceptedAt: string;
}

export interface ConsentStorage {
  /**
   * Read the stored consent, if any. Returns `null` when nothing is
   * stored, the record fails to parse, or the schema version is
   * unrecognised (forces a re-prompt on a future schema bump).
   */
  read: () => ConsentRecord | null;
  /** True iff a valid consent record is on file. */
  has: () => boolean;
  /**
   * Record consent right now. Best-effort — if storage is unavailable
   * (private mode, quota exceeded), we silently swallow rather than
   * blocking the user's capture. Worst case: they see the disclosure
   * once per session in private mode, which is acceptable.
   */
  record: (now?: Date) => ConsentRecord;
  /** Test / "reset onboarding" helper. Not wired into the UI. */
  clear: () => void;
}

export interface CreateConsentStorageOptions {
  /** Fully-qualified localStorage key. Convention:
   *  `"captureshark.<feature>Consent.v<n>"`. */
  storageKey: string;
  /** Schema version. Anything else stored under the key is treated
   *  as a no-consent state (forces a re-prompt). */
  currentVersion: number;
}

/**
 * Build a feature-specific consent helper bound to one localStorage
 * key. See `voiceConsent.ts` and `photoConsent.ts` for the two
 * current callers; future features (location, contacts, etc.)
 * follow the same one-liner pattern.
 */
export function createConsentStorage(
  opts: CreateConsentStorageOptions,
): ConsentStorage {
  const { storageKey, currentVersion } = opts;

  function read(): ConsentRecord | null {
    if (typeof localStorage === "undefined") return null;
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Partial<ConsentRecord>;
      if (parsed.v !== currentVersion) return null;
      if (typeof parsed.acceptedAt !== "string" || !parsed.acceptedAt) {
        return null;
      }
      return { v: parsed.v, acceptedAt: parsed.acceptedAt };
    } catch {
      return null;
    }
  }

  function has(): boolean {
    return read() !== null;
  }

  function record(now: Date = new Date()): ConsentRecord {
    const rec: ConsentRecord = {
      v: currentVersion,
      acceptedAt: now.toISOString(),
    };
    if (typeof localStorage === "undefined") return rec;
    try {
      localStorage.setItem(storageKey, JSON.stringify(rec));
    } catch {
      /* swallow — see ConsentStorage.record docstring */
    }
    return rec;
  }

  function clear(): void {
    if (typeof localStorage === "undefined") return;
    try {
      localStorage.removeItem(storageKey);
    } catch {
      /* swallow */
    }
  }

  return { read, has, record, clear };
}
