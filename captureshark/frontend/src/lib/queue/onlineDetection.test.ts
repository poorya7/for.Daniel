/**
 * Unit tests for the online-state detector.
 *
 * Strategy:
 *   - Use vitest's fake timers so polling cadence is deterministic.
 *   - Inject `fetch` so we can script reachability outcomes.
 *   - Reuse the real jsdom `window` and `document` for the
 *     subscription surface — they support `addEventListener` /
 *     `dispatchEvent` / `visibilityState`, which is everything we
 *     need.
 *
 * The contract these tests pin (plan §6.1, locked-principle §1.3):
 *   - Initial state is seeded from `navigator.onLine`.
 *   - First probe runs immediately on construction; the result
 *     overrides the seed.
 *   - Subscribers are only notified on actual state transitions
 *     (duplicate signals are coalesced).
 *   - `offline` event immediately marks offline (no probe needed).
 *   - `online` event triggers a probe, NOT an immediate transition
 *     (the event has been observed to fire before the connection
 *     is usable).
 *   - `visibilitychange → visible` triggers an immediate probe.
 *   - `stop()` removes all listeners and timers.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createOnlineDetector } from "@/lib/queue/onlineDetection";

function makeOkResponse(): Response {
  return new Response("{}", {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function makeFailResponse(): Response {
  return new Response("{}", { status: 503 });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("createOnlineDetector — initial state", () => {
  it("seeds from navigator.onLine when online", async () => {
    Object.defineProperty(window.navigator, "onLine", {
      configurable: true,
      get: () => true,
    });
    const fetchFn = vi.fn(async () => makeOkResponse());
    const detector = createOnlineDetector({
      dependencies: { fetch: fetchFn as typeof fetch },
    });
    expect(detector.current()).toBe("online");
    detector.stop();
  });

  it("seeds from navigator.onLine when offline", () => {
    Object.defineProperty(window.navigator, "onLine", {
      configurable: true,
      get: () => false,
    });
    const fetchFn = vi.fn(async () => makeFailResponse());
    const detector = createOnlineDetector({
      dependencies: { fetch: fetchFn as typeof fetch },
    });
    expect(detector.current()).toBe("offline");
    detector.stop();
  });
});

describe("createOnlineDetector — probing", () => {
  it("fires an immediate probe after construction", async () => {
    const fetchFn = vi.fn(async () => makeOkResponse());
    const detector = createOnlineDetector({
      dependencies: { fetch: fetchFn as typeof fetch },
    });
    // Flush pending microtasks so the kick-off probe resolves.
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledWith(
      "/api/v1/health",
      expect.objectContaining({ method: "GET", cache: "no-store" }),
    );
    detector.stop();
  });

  it("notifies subscribers only on actual transitions", async () => {
    Object.defineProperty(window.navigator, "onLine", {
      configurable: true,
      get: () => true,
    });
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(makeOkResponse()) // first probe — still online, no notify
      .mockResolvedValueOnce(makeFailResponse()); // second probe — flip to offline
    const detector = createOnlineDetector({
      intervalOnlineMs: 1_000,
      dependencies: { fetch: fetchFn as typeof fetch },
    });

    const seen: string[] = [];
    detector.subscribe((state) => seen.push(state));

    await vi.advanceTimersByTimeAsync(0); // boot probe
    expect(seen).toEqual([]); // still online → no notify
    await vi.advanceTimersByTimeAsync(1_000); // next tick → offline
    expect(seen).toEqual(["offline"]);
    detector.stop();
  });

  it("uses the offline interval when offline", async () => {
    Object.defineProperty(window.navigator, "onLine", {
      configurable: true,
      get: () => false,
    });
    const fetchFn = vi.fn(async () => makeFailResponse());
    createOnlineDetector({
      intervalOnlineMs: 30_000,
      intervalOfflineMs: 1_000,
      dependencies: { fetch: fetchFn as typeof fetch },
    });
    await vi.advanceTimersByTimeAsync(0); // boot probe
    // After boot probe, state is offline. Schedule should use 1s.
    await vi.advanceTimersByTimeAsync(900);
    expect(fetchFn).toHaveBeenCalledTimes(1); // still only boot
    await vi.advanceTimersByTimeAsync(200);
    expect(fetchFn).toHaveBeenCalledTimes(2); // tick fired
  });

  it("transitions to offline when probe times out", async () => {
    Object.defineProperty(window.navigator, "onLine", {
      configurable: true,
      get: () => true,
    });
    const fetchFn = vi.fn(
      async (_url: string | URL, init?: RequestInit): Promise<Response> => {
        await new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        });
        return makeOkResponse();
      },
    );
    const detector = createOnlineDetector({
      probeTimeoutMs: 500,
      dependencies: { fetch: fetchFn as typeof fetch },
    });
    const seen: string[] = [];
    detector.subscribe((state) => seen.push(state));

    await vi.advanceTimersByTimeAsync(600); // past timeout
    expect(seen).toEqual(["offline"]);
    detector.stop();
  });
});

describe("createOnlineDetector — events", () => {
  it("offline event marks offline immediately (no probe needed)", async () => {
    Object.defineProperty(window.navigator, "onLine", {
      configurable: true,
      get: () => true,
    });
    const fetchFn = vi.fn(async () => makeOkResponse());
    const detector = createOnlineDetector({
      dependencies: { fetch: fetchFn as typeof fetch },
    });
    await vi.advanceTimersByTimeAsync(0);

    const seen: string[] = [];
    detector.subscribe((state) => seen.push(state));

    window.dispatchEvent(new Event("offline"));
    expect(seen).toEqual(["offline"]);
    expect(detector.current()).toBe("offline");
    detector.stop();
  });

  it("online event fires a probe and transitions on success", async () => {
    Object.defineProperty(window.navigator, "onLine", {
      configurable: true,
      get: () => false,
    });
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(makeFailResponse()) // boot probe — still offline
      .mockResolvedValueOnce(makeOkResponse()); // online-event probe
    const detector = createOnlineDetector({
      dependencies: { fetch: fetchFn as typeof fetch },
    });
    await vi.advanceTimersByTimeAsync(0);

    const seen: string[] = [];
    detector.subscribe((state) => seen.push(state));

    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(0);

    expect(seen).toEqual(["online"]);
    expect(detector.current()).toBe("online");
    detector.stop();
  });

  it("visibilitychange → visible fires an immediate probe", async () => {
    Object.defineProperty(window.navigator, "onLine", {
      configurable: true,
      get: () => false,
    });
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(makeFailResponse())
      .mockResolvedValueOnce(makeOkResponse());
    const detector = createOnlineDetector({
      dependencies: { fetch: fetchFn as typeof fetch },
    });
    await vi.advanceTimersByTimeAsync(0);

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(detector.current()).toBe("online");
    detector.stop();
  });
});

describe("createOnlineDetector — stop()", () => {
  it("stops further polling", async () => {
    Object.defineProperty(window.navigator, "onLine", {
      configurable: true,
      get: () => true,
    });
    const fetchFn = vi.fn(async () => makeOkResponse());
    const detector = createOnlineDetector({
      intervalOnlineMs: 100,
      dependencies: { fetch: fetchFn as typeof fetch },
    });
    await vi.advanceTimersByTimeAsync(0);
    detector.stop();
    const callsAtStop = fetchFn.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchFn.mock.calls.length).toBe(callsAtStop);
  });
});
