/**
 * Unit tests for the drainer trigger pump.
 *
 * Strategy: inject a stub `OnlineDetector` so we control transitions
 * deterministically, plus spies for `drainFn` and `recoverySweep`.
 * That keeps the test focused on the trigger logic itself, not on
 * the underlying probe machinery (covered by `onlineDetection.test.ts`).
 *
 * The contract these tests pin (plan §6.1, §6.2):
 *   - Boot sequence: recovery sweep → drain if queue non-empty.
 *   - No boot drain when queue is empty.
 *   - Online-state transitions to "online" fire a drain.
 *   - Online-state stays at "online" (or stays at "offline") → no
 *     fire (handled by detector's coalescing, validated here).
 *   - `triggerDrain()` calls the drain fn directly.
 *   - `stop()` unsubscribes — subsequent transitions don't fire.
 */

import "fake-indexeddb/auto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { _resetForTests, queueDb } from "@/lib/queue/db";
import { startQueueRunner } from "@/lib/queue/triggers";
import type {
  OnlineDetector,
  OnlineState,
} from "@/lib/queue/onlineDetection";
import type { DrainResult } from "@/lib/queue/drainer";
import type { ExtractedFields } from "@/lib/api";

// --- Fake detector --------------------------------------------------------

interface FakeDetector extends OnlineDetector {
  /** Force a transition + notify subscribers (mirrors real coalescing). */
  emit(state: OnlineState): void;
}

function createFakeDetector(initial: OnlineState = "online"): FakeDetector {
  let state = initial;
  const listeners = new Set<(s: OnlineState) => void>();
  return {
    current: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async probeNow() {
      // no-op in the fake
    },
    stop() {
      listeners.clear();
    },
    emit(next) {
      if (next === state) return;
      state = next;
      for (const listener of listeners) listener(next);
    },
  };
}

// --- Fixtures -------------------------------------------------------------

const EMPTY_DRAIN_RESULT: DrainResult = {
  saved: 0,
  transient_failures: 0,
  auth_failures: 0,
  permanent_failures: 0,
  skipped_for_backoff: 0,
  lock_unavailable: false,
};

const fakeFields: ExtractedFields = {
  name: { value: "x", confidence: "high", alternatives: [] },
  phone: { value: null, confidence: "high", alternatives: [] },
  email: { value: null, confidence: "high", alternatives: [] },
  has_agent: { value: null, confidence: "high", alternatives: [] },
  intent: { value: null, confidence: "high", alternatives: [] },
  timeline: { value: null, confidence: "high", alternatives: [] },
  financing_status: { value: null, confidence: "high", alternatives: [] },
  budget: { value: null, confidence: "high", alternatives: [] },
  area: { value: null, confidence: "high", alternatives: [] },
  follow_up: { value: null, confidence: "high", alternatives: [] },
  notes: { value: null, confidence: "high", alternatives: [] },
};

async function seedOneCapture(): Promise<void> {
  const id = crypto.randomUUID();
  await queueDb.captures.add({
    id,
    created_at: Date.now(),
    source: "text",
    state: "pending_save",
    attempts: 0,
    last_attempt_at: null,
    last_error: null,
    idempotency_key: id,
    sheet_target: { spreadsheet_id: "s", tab_name: "t", display_name: "d" },
    raw_input: { text: "hi", audio_blob_id: null, photo_blob_id: null },
    extracted: { fields: fakeFields, original_text: "hi" },
  });
}

beforeEach(async () => {
  await _resetForTests();
});

afterEach(async () => {
  await _resetForTests();
});

// --- Helper: flush microtasks until predicate ----------------------------

async function flush(): Promise<void> {
  // Two ticks of microtask flushing handles the chained promise the
  // boot sequence kicks off (sweep → count → drain).
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

// --- Tests ----------------------------------------------------------------

describe("startQueueRunner — boot", () => {
  it("runs the recovery sweep on boot", async () => {
    const detector = createFakeDetector();
    const sweep = vi.fn(async () => 0);
    const drain = vi.fn(async () => EMPTY_DRAIN_RESULT);
    const runner = startQueueRunner({
      detector,
      drainFn: drain,
      recoverySweep: sweep,
    });
    await flush();
    expect(sweep).toHaveBeenCalledTimes(1);
    runner.stop();
  });

  it("drains immediately if the queue is non-empty at boot", async () => {
    await seedOneCapture();
    const detector = createFakeDetector();
    const sweep = vi.fn(async () => 0);
    const drain = vi.fn(async () => EMPTY_DRAIN_RESULT);
    const runner = startQueueRunner({
      detector,
      drainFn: drain,
      recoverySweep: sweep,
    });
    await flush();
    expect(drain).toHaveBeenCalled();
    runner.stop();
  });

  it("does NOT drain at boot if the queue is empty", async () => {
    const detector = createFakeDetector();
    const sweep = vi.fn(async () => 0);
    const drain = vi.fn(async () => EMPTY_DRAIN_RESULT);
    const runner = startQueueRunner({
      detector,
      drainFn: drain,
      recoverySweep: sweep,
    });
    await flush();
    expect(drain).not.toHaveBeenCalled();
    runner.stop();
  });
});

describe("startQueueRunner — ongoing triggers", () => {
  it("fires drainNow on an offline → online transition", async () => {
    const detector = createFakeDetector("offline");
    const sweep = vi.fn(async () => 0);
    const drain = vi.fn(async () => EMPTY_DRAIN_RESULT);
    const runner = startQueueRunner({
      detector,
      drainFn: drain,
      recoverySweep: sweep,
    });
    await flush();
    drain.mockClear();

    detector.emit("online");
    await flush();
    expect(drain).toHaveBeenCalledTimes(1);
    runner.stop();
  });

  it("does NOT re-fire drainNow on duplicate online emissions", async () => {
    const detector = createFakeDetector("offline");
    const sweep = vi.fn(async () => 0);
    const drain = vi.fn(async () => EMPTY_DRAIN_RESULT);
    const runner = startQueueRunner({
      detector,
      drainFn: drain,
      recoverySweep: sweep,
    });
    await flush();
    drain.mockClear();

    detector.emit("online");
    detector.emit("online"); // duplicate — fake coalesces
    detector.emit("online");
    await flush();
    expect(drain).toHaveBeenCalledTimes(1);
    runner.stop();
  });

  it("does NOT fire drainNow when going online → offline", async () => {
    const detector = createFakeDetector("online");
    const sweep = vi.fn(async () => 0);
    const drain = vi.fn(async () => EMPTY_DRAIN_RESULT);
    const runner = startQueueRunner({
      detector,
      drainFn: drain,
      recoverySweep: sweep,
    });
    await flush();
    drain.mockClear();

    detector.emit("offline");
    await flush();
    expect(drain).not.toHaveBeenCalled();
    runner.stop();
  });
});

describe("startQueueRunner — public surface", () => {
  it("isOnline reflects detector state", async () => {
    const detector = createFakeDetector("offline");
    const runner = startQueueRunner({
      detector,
      drainFn: async () => EMPTY_DRAIN_RESULT,
      recoverySweep: async () => 0,
    });
    expect(runner.isOnline()).toBe(false);
    detector.emit("online");
    expect(runner.isOnline()).toBe(true);
    runner.stop();
  });

  it("triggerDrain calls the drain fn", async () => {
    const detector = createFakeDetector();
    const drain = vi.fn(async () => EMPTY_DRAIN_RESULT);
    const runner = startQueueRunner({
      detector,
      drainFn: drain,
      recoverySweep: async () => 0,
    });
    await flush();
    drain.mockClear();
    const result = await runner.triggerDrain();
    expect(drain).toHaveBeenCalledTimes(1);
    expect(result).toEqual(EMPTY_DRAIN_RESULT);
    runner.stop();
  });

  it("stop() unsubscribes — later transitions are ignored", async () => {
    const detector = createFakeDetector("offline");
    const drain = vi.fn(async () => EMPTY_DRAIN_RESULT);
    const runner = startQueueRunner({
      detector,
      drainFn: drain,
      recoverySweep: async () => 0,
    });
    await flush();
    drain.mockClear();
    runner.stop();
    detector.emit("online");
    await flush();
    expect(drain).not.toHaveBeenCalled();
  });
});
