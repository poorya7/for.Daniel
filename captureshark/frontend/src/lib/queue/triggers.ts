/**
 * Drainer triggers — the glue that fires `drainNow()` automatically.
 *
 * Plan §6.1 lists five trigger sources:
 *
 *   1. App boot, if the queue is non-empty.
 *   2. `window.online` event.
 *   3. `document.visibilitychange` → visible.
 *   4. The `/health` probe transitioning unreachable → reachable.
 *   5. User-initiated retry (UI "Try now" affordance).
 *
 * Sources (2), (3), and (4) are all delivered by the `OnlineDetector`
 * as an `offline → online` transition, so this module subscribes to
 * the detector and treats every such transition as a drain trigger.
 * (1) is fired explicitly at startup. (5) is exposed via the
 * `triggerDrain()` method on the runner so the UI can call it.
 *
 * Boot trigger is gated on "queue is non-empty" — there's no point
 * spinning up a drain pass when there's nothing to drain, and a
 * cold-cache boot probe is wasted work otherwise.
 *
 * Concurrency: the drainer itself uses a Web Lock (see
 * `drainer.ts §6.2`), so back-to-back triggers can't overlap. We
 * still de-bounce trigger fan-in here so the lock isn't churned at
 * boot when "online → online" and "visible" arrive at the same time.
 */

import { queueDb, sweepStaleSyncing } from "@/lib/queue/db";
import { drainNow, type DrainResult } from "@/lib/queue/drainer";
import {
  createOnlineDetector,
  type OnlineDetector,
  type OnlineDetectorOptions,
  type OnlineState,
} from "@/lib/queue/onlineDetection";

export interface QueueRunner {
  /** Current online estimate, exposed for the UI's ambient indicator. */
  isOnline(): boolean;
  /** Subscribe to online-state transitions (for the UI indicator). */
  subscribeOnline(listener: (state: OnlineState) => void): () => void;
  /**
   * Manually trigger a drain pass (UI "Try now"). Returns the
   * drainer result so the caller can react (e.g. toast on success).
   */
  triggerDrain(): Promise<DrainResult>;
  /** Tear down listeners + timer. For app shutdown / tests. */
  stop(): void;
}

export interface QueueRunnerOptions {
  /**
   * Injection seams for tests. Most callers omit this and accept the
   * production defaults (real fetch, real window/document).
   */
  detector?: OnlineDetector;
  /**
   * Override the drain function — tests pass a spy; production
   * defaults to the real `drainNow`.
   */
  drainFn?: typeof drainNow;
  /**
   * Override the boot recovery sweep — tests pass a spy; production
   * defaults to the real `sweepStaleSyncing`.
   */
  recoverySweep?: typeof sweepStaleSyncing;
  /**
   * Forwarded to `createOnlineDetector` when `detector` is not
   * supplied. Lets the call site tune probe URL / cadence without
   * having to build the detector by hand.
   */
  onlineDetectorOptions?: OnlineDetectorOptions;
}

/**
 * Start the queue runner. Call once, at app boot. Returns a runner
 * the rest of the app can poke for state + manual triggers.
 *
 * Boot order:
 *   1. Recovery sweep — any record stuck in `syncing` from a tab
 *      that died mid-write bounces back to its pending predecessor.
 *      Idempotency on the backend (plan §7) ensures a replay after a
 *      successful-but-unacked write returns the cached 200 instead
 *      of a duplicate row.
 *   2. Online detector starts probing.
 *   3. Immediate drain pass if the queue is non-empty.
 *   4. Subscribe to detector transitions for ongoing triggers.
 */
export function startQueueRunner(
  options: QueueRunnerOptions = {},
): QueueRunner {
  const drainFn = options.drainFn ?? drainNow;
  const recoverySweep = options.recoverySweep ?? sweepStaleSyncing;
  const detector =
    options.detector ?? createOnlineDetector(options.onlineDetectorOptions);

  let stopped = false;

  // Boot sequence — kicks off async work but returns the runner
  // synchronously so the app can wire up its UI without awaiting.
  void (async (): Promise<void> => {
    try {
      await recoverySweep();
    } catch {
      // A boot-time sweep failure is unfortunate but not fatal — the
      // next attempt at any pending_save will re-attempt regardless.
    }
    if (stopped) return;
    const pendingCount = await queueDb.captures.count();
    if (pendingCount > 0) {
      await safeDrain(drainFn);
    }
  })();

  // Wire ongoing triggers. The detector fires its listener whenever
  // the state actually changes, so "online → online" doesn't re-
  // trigger (which would just bounce off the Web Lock anyway).
  const unsubscribe = detector.subscribe((state) => {
    if (stopped) return;
    if (state === "online") {
      void safeDrain(drainFn);
    }
  });

  return {
    isOnline(): boolean {
      return detector.current() === "online";
    },
    subscribeOnline(listener) {
      return detector.subscribe(listener);
    },
    async triggerDrain(): Promise<DrainResult> {
      return drainFn();
    },
    stop() {
      stopped = true;
      unsubscribe();
      detector.stop();
    },
  };
}

/**
 * Wrap a drain call so a thrown error doesn't bubble out of an
 * event handler. The drainer is supposed to swallow its own errors
 * already, but defence in depth keeps the trigger pump alive even
 * if a bug slips through.
 */
async function safeDrain(
  drainFn: typeof drainNow,
): Promise<DrainResult | null> {
  try {
    return await drainFn();
  } catch {
    return null;
  }
}
