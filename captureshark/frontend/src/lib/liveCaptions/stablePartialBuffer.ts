/**
 * Stable-partial buffer — paints append-only growth instantly, holds
 * actual revisions for a short settling window before exposing them.
 *
 * Why this shape (from PLAN.md §UI + 2026-05-15 field test):
 *   AssemblyAI's streaming model revises partials as more audio
 *   arrives. MOST revisions are append-only — "Maria" grows into
 *   "Maria five" grows into "Maria five five five". Painting those
 *   immediately gives a word-by-word "real-time" feel.
 *
 *   ACTUAL revisions (where an earlier word changes — "Maria" →
 *   "Mariah" → "Maria") are the flicker risk. Those are held for
 *   ~200 ms; if a newer hypothesis arrives inside the window, the
 *   prior one never paints.
 *
 *   A naive "always wait 200ms" buffer (the prior version of this
 *   file) suppressed flicker but also ate every append-only growth
 *   that arrived faster than 200ms — the broker saw "At Alex—"
 *   freeze for 7 seconds, then the whole sentence land at once.
 *   Splitting append vs revision is the fix.
 *
 * This is intentionally a small standalone module, not a hook — keeps
 * the math testable without a renderer + simplifies the caller's
 * lifecycle (one buffer per session, disposed on stop).
 */

const DEFAULT_STABLE_WINDOW_MS = 200;

export interface StablePartialBuffer {
  /** Receive a new partial. Replaces any pending one and resets the
   *  window. The text is exposed via `onStable` only if no further
   *  push arrives within `stableMs`. */
  push: (text: string) => void;
  /** Flush state — drop any pending partial without exposing it.
   *  Used at end-of-turn (the finalised text is the authoritative
   *  version; whatever was pending is no longer relevant). */
  clear: () => void;
  /** Cancel any pending timer + release references. Idempotent. */
  dispose: () => void;
}

export interface StablePartialBufferOptions {
  /** Called with text that's been stable for `stableMs`. Fires at
   *  most once per stable window — if the same text arrives twice
   *  in a row, downstream consumers can still no-op. */
  onStable: (text: string) => void;
  /** Settling window in milliseconds. Default 200. */
  stableMs?: number;
  /** Inject timer fns for tests. Defaults to the platform globals. */
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

export function createStablePartialBuffer(
  options: StablePartialBufferOptions,
): StablePartialBuffer {
  const stableMs = options.stableMs ?? DEFAULT_STABLE_WINDOW_MS;
  const setTimeoutFn = options.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;

  let pendingText: string | null = null;
  let lastPainted = "";
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const cancelTimer = (): void => {
    if (timer !== null) {
      clearTimeoutFn(timer);
      timer = null;
    }
  };

  const paint = (text: string): void => {
    lastPainted = text;
    pendingText = null;
    cancelTimer();
    options.onStable(text);
  };

  return {
    push(text: string): void {
      if (disposed) return;
      // Append-only growth (or the very first partial of a turn):
      // safe to paint immediately. No flicker risk because no earlier
      // word is being rewritten.
      if (text.startsWith(lastPainted)) {
        paint(text);
        return;
      }
      // Revision — an earlier word changed. Hold for the settling
      // window; if a newer hypothesis lands inside it, that one takes
      // over and the prior revision never paints.
      pendingText = text;
      cancelTimer();
      const snapshot = text;
      timer = setTimeoutFn(() => {
        timer = null;
        if (disposed) return;
        if (pendingText === snapshot) {
          paint(snapshot);
        }
      }, stableMs);
    },
    clear(): void {
      pendingText = null;
      lastPainted = "";
      cancelTimer();
    },
    dispose(): void {
      disposed = true;
      pendingText = null;
      lastPainted = "";
      cancelTimer();
    },
  };
}
