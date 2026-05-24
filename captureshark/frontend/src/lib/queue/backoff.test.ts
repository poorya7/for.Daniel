/**
 * Unit tests for the backoff schedule.
 *
 * Pure functions, no IO, no clocks at module scope — these tests are
 * fast (sub-millisecond each) and don't need the full test-page DOM.
 *
 * Jitter is exercised by injecting a deterministic `random()` source
 * (returning 0, 0.5, or 1) so we can assert the exact ms boundary
 * for each attempt without depending on a real Math.random.
 */

import { describe, expect, it } from "vitest";

import { isReadyForAttempt, nextDelayMs } from "@/lib/queue/backoff";

// Deterministic randoms — these correspond to:
//   shift = -JITTER_RATIO  (random() returns 0  → shift = (0  * 2 - 1) * 0.2 = -0.2)
//   shift = 0              (random() returns 0.5 → shift = (1 - 1)        *  0.2 =  0  )
//   shift = +JITTER_RATIO  (random() returns 1  → shift = (2 - 1)        *  0.2 = +0.2)
const RANDOM_MIN = () => 0;
const RANDOM_MID = () => 0.5;
const RANDOM_MAX = () => 0.99999;

describe("nextDelayMs — schedule (no jitter, mid-random)", () => {
  it("first attempt is immediate", () => {
    expect(nextDelayMs(0, RANDOM_MID)).toBe(0);
  });

  it.each([
    [1, 2_000],
    [2, 5_000],
    [3, 15_000],
    [4, 45_000],
    [5, 120_000],
  ])("attempt %i → %i ms (no jitter)", (attempts, expected) => {
    expect(nextDelayMs(attempts, RANDOM_MID)).toBe(expected);
  });

  it("caps at 120s for attempts beyond the schedule", () => {
    expect(nextDelayMs(10, RANDOM_MID)).toBe(120_000);
    expect(nextDelayMs(100, RANDOM_MID)).toBe(120_000);
  });
});

describe("nextDelayMs — jitter bounds", () => {
  it("0-base stays 0 even with max-positive jitter", () => {
    expect(nextDelayMs(0, RANDOM_MAX)).toBe(0);
    expect(nextDelayMs(0, RANDOM_MIN)).toBe(0);
  });

  it("attempt 1 (base 2000) jittered to 80%-120% range", () => {
    const low = nextDelayMs(1, RANDOM_MIN); // -20%
    const high = nextDelayMs(1, RANDOM_MAX); // +20%
    expect(low).toBe(1_600);
    // Allow rounding wiggle: at random()=0.99999 the shift is just
    // under +0.2, so the result lands at 2400 modulo rounding noise.
    expect(high).toBeGreaterThanOrEqual(2_390);
    expect(high).toBeLessThanOrEqual(2_400);
  });

  it("never produces a negative delay", () => {
    for (let attempts = 0; attempts < 10; attempts++) {
      for (const rng of [RANDOM_MIN, RANDOM_MID, RANDOM_MAX]) {
        expect(nextDelayMs(attempts, rng)).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe("isReadyForAttempt", () => {
  it("returns true on first attempt (last_attempt_at is null)", () => {
    expect(isReadyForAttempt(0, null, 0, RANDOM_MID)).toBe(true);
  });

  it("returns false when the backoff hasn't elapsed", () => {
    // attempt 2 → 5000 ms base. Now is 1000 ms after last attempt.
    expect(isReadyForAttempt(2, 0, 1_000, RANDOM_MID)).toBe(false);
  });

  it("returns true once the backoff has elapsed", () => {
    expect(isReadyForAttempt(2, 0, 5_000, RANDOM_MID)).toBe(true);
    expect(isReadyForAttempt(2, 0, 10_000, RANDOM_MID)).toBe(true);
  });

  it("respects the cap for high attempt counts", () => {
    // attempt 20 → 120s cap. Now is 60s after last attempt → not ready.
    expect(isReadyForAttempt(20, 0, 60_000, RANDOM_MID)).toBe(false);
    expect(isReadyForAttempt(20, 0, 120_000, RANDOM_MID)).toBe(true);
  });
});
