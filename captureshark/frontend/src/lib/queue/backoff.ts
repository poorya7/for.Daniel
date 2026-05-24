/**
 * Backoff schedule for the queue drainer.
 *
 * Pure functions — no globals, no clocks injected at the seam. The
 * drainer wires real `Date.now()` in; tests pass a fake clock.
 *
 * Schedule (plan §6.4):
 *
 *   attempt 1: immediate (0 ms)
 *   attempt 2: 2 s
 *   attempt 3: 5 s
 *   attempt 4: 15 s
 *   attempt 5: 45 s
 *   attempt 6+: 120 s (cap)
 *
 * Plus a ±20% jitter so a flotilla of queued captures doesn't synchronise
 * its retry hits when connectivity returns.
 *
 * For NETWORK failures we never stop retrying — that's the locked
 * principle (offline → no user task required). The "give up" decision
 * is the drainer's, not the schedule's; this module just answers
 * "how long until the next attempt for a record with N attempts so far?".
 */

const SCHEDULE_MS: readonly number[] = [0, 2_000, 5_000, 15_000, 45_000, 120_000];
const MAX_DELAY_MS = 120_000;
const JITTER_RATIO = 0.2;

/**
 * Backoff in ms for the *next* attempt, given the number of attempts
 * already made (zero-indexed). `attempts === 0` means "we've never
 * tried" — first attempt is immediate.
 *
 * Capped at `MAX_DELAY_MS` so a record that's been failing for ages
 * still gets retried every two minutes without unbounded growth.
 *
 * `random` is injected so tests can pin jitter to 0 / 0.5 / 1 without
 * monkeypatching `Math.random`. Production callers use `Math.random`.
 */
export function nextDelayMs(
  attempts: number,
  random: () => number = Math.random,
): number {
  const base =
    attempts < SCHEDULE_MS.length
      ? SCHEDULE_MS[attempts]!
      : MAX_DELAY_MS;
  return _applyJitter(base, random);
}

/**
 * Has enough time elapsed since `lastAttemptAt` for another attempt?
 *
 * Used by the drainer to decide whether to skip a record this cycle
 * (it tried recently, give the network a moment) vs. retry now.
 *
 * Returns true when `lastAttemptAt` is null (never attempted) so a
 * fresh record drains immediately on the first cycle.
 */
export function isReadyForAttempt(
  attempts: number,
  lastAttemptAt: number | null,
  now: number,
  random: () => number = Math.random,
): boolean {
  if (lastAttemptAt === null) return true;
  const delay = nextDelayMs(attempts, random);
  return now - lastAttemptAt >= delay;
}

/**
 * Apply ±`JITTER_RATIO` jitter symmetrically around `base`. Zero base
 * stays zero (first attempt is always immediate); jittering zero
 * would just produce a tiny positive delay for no benefit.
 */
function _applyJitter(base: number, random: () => number): number {
  if (base === 0) return 0;
  // `random()` ∈ [0, 1); shift to [-1, 1).
  const shift = (random() * 2 - 1) * JITTER_RATIO;
  // Clamp to non-negative — `1 - JITTER_RATIO` is always positive
  // (0.8) for our schedule, but defence in depth keeps the contract
  // "delay is never negative" inviolable.
  return Math.max(0, Math.round(base * (1 + shift)));
}
