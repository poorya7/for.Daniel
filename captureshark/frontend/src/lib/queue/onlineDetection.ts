/**
 * Online-state detection for the queue runner.
 *
 * Goal: tell the rest of the queue layer "is the backend reachable
 * RIGHT NOW?" with a single source of truth, fed by three signals
 * (in order of trust):
 *
 *   1. A periodic `/health` HTTP probe — slow but authoritative. iOS
 *      Safari lies about `navigator.onLine` in airplane mode + weak
 *      signal; the probe is what catches that.
 *   2. `window.online` / `window.offline` events — fast, but flaky
 *      on iOS Safari (often misses entirely). We honour them when
 *      they fire but don't depend on them.
 *   3. `navigator.onLine` — initial-state hint only. Cheap to read,
 *      good enough for boot-time defaulting before the first probe
 *      lands.
 *
 * Plus a `visibilitychange` listener: when the tab becomes visible
 * (Linda pulls her phone out of her pocket after a dead-zone walk),
 * we kick an immediate probe instead of waiting for the next polling
 * tick — that's the real-world common case per plan §6.1 #3.
 *
 * Polling cadence is asymmetric: while online, probe every 30 s; while
 * offline, probe every 10 s (so connectivity-return latency stays low
 * for the user, without burning CPU at the same rate when online).
 *
 * This module is pure aside from its event subscriptions and timer —
 * fetch + window + document are injectable for tests via the
 * `dependencies` parameter on `createOnlineDetector`.
 */

const DEFAULT_PROBE_URL = "/api/v1/health";
const DEFAULT_ONLINE_INTERVAL_MS = 30_000;
const DEFAULT_OFFLINE_INTERVAL_MS = 10_000;
const DEFAULT_PROBE_TIMEOUT_MS = 4_000;

export type OnlineState = "online" | "offline";

export interface OnlineDetector {
  /** Current best estimate. Synchronous; cheap to read. */
  current(): OnlineState;
  /**
   * Subscribe to state transitions. The listener fires only when the
   * state actually changes — duplicate signals are coalesced.
   * Returns an unsubscribe function.
   */
  subscribe(listener: (state: OnlineState) => void): () => void;
  /** Force an immediate probe (e.g. user-tapped retry). */
  probeNow(): Promise<void>;
  /** Tear down listeners + timer. For tests / app shutdown. */
  stop(): void;
}

/** Injectable seams for tests. All optional in production. */
export interface OnlineDetectorDependencies {
  fetch?: typeof fetch;
  /** Used to read `navigator.onLine` and subscribe to `online`/`offline`. */
  window?: Window;
  /** Used for the `visibilitychange` listener. */
  document?: Document;
}

export interface OnlineDetectorOptions {
  probeUrl?: string;
  intervalOnlineMs?: number;
  intervalOfflineMs?: number;
  probeTimeoutMs?: number;
  dependencies?: OnlineDetectorDependencies;
}

export function createOnlineDetector(
  options: OnlineDetectorOptions = {},
): OnlineDetector {
  const probeUrl = options.probeUrl ?? DEFAULT_PROBE_URL;
  const onlineIntervalMs = options.intervalOnlineMs ?? DEFAULT_ONLINE_INTERVAL_MS;
  const offlineIntervalMs = options.intervalOfflineMs ?? DEFAULT_OFFLINE_INTERVAL_MS;
  const probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;

  const win = options.dependencies?.window ?? globalThis.window;
  const doc = options.dependencies?.document ?? globalThis.document;
  const fetchFn = options.dependencies?.fetch ?? globalThis.fetch.bind(globalThis);

  // Seed from `navigator.onLine` — best initial hint we have without
  // burning a probe before listeners are attached. The first probe
  // tick happens immediately after construction, so a wrong seed
  // self-corrects within `probeTimeoutMs`.
  let state: OnlineState = win.navigator.onLine ? "online" : "offline";
  const listeners = new Set<(state: OnlineState) => void>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  function notify(next: OnlineState): void {
    if (next === state) return;
    state = next;
    for (const listener of listeners) {
      // Each listener runs synchronously in subscription order. A
      // throwing listener doesn't affect siblings — the queue UI and
      // the drainer trigger module are both downstream, neither can
      // afford to be cancelled by the other's bug.
      try {
        listener(next);
      } catch {
        // Silently swallowed. We don't have a logger seam here.
      }
    }
  }

  async function probe(): Promise<void> {
    if (stopped) return;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, probeTimeoutMs);
    try {
      const response = await fetchFn(probeUrl, {
        method: "GET",
        signal: controller.signal,
        // No-store so a stale 200 in the HTTP cache can't fool us
        // into thinking we're online when we're not. Same defence
        // we already had in App.tsx's pre-flight probe.
        cache: "no-store",
      });
      notify(response.ok ? "online" : "offline");
    } catch {
      notify("offline");
    } finally {
      clearTimeout(timeoutId);
    }
  }

  function scheduleNext(): void {
    if (stopped) return;
    const interval = state === "online" ? onlineIntervalMs : offlineIntervalMs;
    timer = setTimeout(async () => {
      await probe();
      scheduleNext();
    }, interval);
  }

  function handleOnlineEvent(): void {
    // The browser thinks we're online — believe it long enough to fire
    // a confirming probe right away, but don't notify state until the
    // probe confirms. The `online` event has been observed to fire
    // before the connection is actually usable.
    void probe();
  }

  function handleOfflineEvent(): void {
    // `offline` event is rarely wrong — when the browser is confident
    // we're disconnected, we trust it immediately.
    notify("offline");
  }

  function handleVisibilityChange(): void {
    if (doc.visibilityState === "visible") {
      // Linda pulled her phone out of her pocket after the dead zone.
      // Fire an immediate probe; the timer will resync from there.
      void probe();
    }
  }

  win.addEventListener("online", handleOnlineEvent);
  win.addEventListener("offline", handleOfflineEvent);
  doc.addEventListener("visibilitychange", handleVisibilityChange);

  // Kick the first probe immediately so the initial `navigator.onLine`
  // seed is replaced with a real signal as fast as we can. Don't
  // block construction on it — the detector is usable from the
  // moment this function returns.
  void probe().then(scheduleNext);

  return {
    current(): OnlineState {
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async probeNow() {
      await probe();
    },
    stop() {
      stopped = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      win.removeEventListener("online", handleOnlineEvent);
      win.removeEventListener("offline", handleOfflineEvent);
      doc.removeEventListener("visibilitychange", handleVisibilityChange);
      listeners.clear();
    },
  };
}
