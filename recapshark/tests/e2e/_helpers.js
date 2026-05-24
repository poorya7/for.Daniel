// Shared helpers for the refactor-protection e2e suite.
//
// Convention: every public helper takes a `page` first; named-options object
// last so callers can spread / extend without positional churn.

import { expect } from '@playwright/test';

// User's go-to test URL — short pop-science clip with subs available.
// Lands the full pipeline (subs → short summary + chapters → full summary
// → transcript) in ~5-8s on a warm cache.
export const FIXTURE_VIDEO_URL = 'https://youtu.be/qADTr7d6gMU';

// Provided by user 2026-05-06. Each one targets a specific code path:
//   - MUSIC_ONLY → _detectMostlyMusic friendly placeholder + tab badge
//   - OVER_10H → cap-fail UX (we DON'T support 10h+; this verifies the
//                guardrail's rejection message renders correctly)
//   - JAPANESE_SOURCE → CJK font path (Han unification, Noto Sans JP vs zh)
export const FIXTURE_MUSIC_ONLY_URL = 'https://www.youtube.com/live/r9wj7Dwe--E';
export const FIXTURE_OVER_10H_URL = 'https://youtu.be/8il34Br1F3I';
export const FIXTURE_JAPANESE_SOURCE_URL = 'https://youtu.be/4NCO7TES0lA';

// Land on the app with the auto-paste shortcut + wait for the results view
// to have at least one chapter rendered. Chapters land first in the pipeline
// (~1-2s after subs arrive, before the full summary).
export async function pasteUrlAndAwaitResultsView(page, videoUrl = FIXTURE_VIDEO_URL) {
  const target = `/app.html?url=${encodeURIComponent(videoUrl)}`;
  await page.goto(target);
  await page.waitForSelector('.chapter-item', { timeout: 30_000 });
}

// Wait for the FULL pipeline to settle: chapters + summary + transcript
// all rendered. Used by test #1.
//
// Note: signature for waitForFunction is (fn, arg, options) — pass null for
// arg when you have no per-call data, then pass timeout in the options slot.
export async function awaitFullPipeline(page) {
  await page.waitForSelector('.chapter-item', { timeout: 30_000 });
  // Summary content lands when full-summary LLM call completes.
  // Desktop uses #summaryDisplayA / #summaryDisplayHost (flat panel);
  // mobile uses #summaryWheelHost (SummaryNativeScroll mounts inside).
  // Either path counts.
  await page.waitForFunction(
    () => {
      const candidates = [
        document.getElementById('summaryDisplayA'),
        document.getElementById('summaryDisplayHost'),
        document.getElementById('summaryWheelHost'),
        document.getElementById('summaryContent'),
      ].filter(Boolean);
      return candidates.some((el) => el.innerText.trim().length > 50);
    },
    null,
    { timeout: 30_000 }
  );
  // Transcript renders last. The renderer creates `.ts-text` spans inside
  // `.transcript-paragraph` divs; the legacy `.transcript-line` class isn't
  // emitted by the current path. Use 'attached' since transcript may be in
  // a non-active tab pane on desktop (Summary tab default).
  await page.waitForSelector('.ts-text', { timeout: 30_000, state: 'attached' });
}

// Capture frame-time samples while karaoke is playing.
// Used by tests #4 + #5 + the perf budget capture.
//
// Returns { mean, p50, p95, p99, n, samples } in ms.
//
// Methodology contract (perf-budget protocol — see docs/_tech/14_TESTING_HARNESS.md):
//   - Caller is responsible for the N=10 protocol — this helper captures
//     ONE batch. Caller orchestrates 10 separate page.reload() + capture
//     cycles, discards the warmup, and computes summary stats over the 9.
//   - Quiesced-machine assumption is the operator's responsibility — this
//     helper can't enforce it.
export async function captureFrameTimes(page, observationMs = 30_000) {
  return await page.evaluate(async (ms) => {
    return await new Promise((resolve) => {
      const samples = [];
      let last = performance.now();
      let frames = 0;
      const start = last;

      function tick(now) {
        const dt = now - last;
        last = now;
        if (frames > 5) samples.push(dt); // skip first few frames (settling)
        frames++;
        if (now - start < ms) {
          requestAnimationFrame(tick);
        } else {
          samples.sort((a, b) => a - b);
          const mean = samples.reduce((s, v) => s + v, 0) / samples.length;
          const pct = (p) => samples[Math.floor(samples.length * p)];
          resolve({
            mean,
            p50: pct(0.5),
            p95: pct(0.95),
            p99: pct(0.99),
            n: samples.length,
            samples,
          });
        }
      }
      requestAnimationFrame(tick);
    });
  }, observationMs);
}

// Count `.lit` chars at frequent intervals to validate the wave-shape
// invariant (test #4 tightened per the 2026-05-06 review pass).
//
// Returns an array of { tMs, litCount } samples. Caller asserts
// peaks-and-falls invariant.
export async function captureLitCountTimeseries(page, observationMs = 5_000, intervalMs = 50) {
  return await page.evaluate(async ({ obs, ival }) => {
    const samples = [];
    const start = performance.now();
    return await new Promise((resolve) => {
      const id = setInterval(() => {
        const t = performance.now() - start;
        const litCount = document.querySelectorAll('.k-ch.lit').length;
        samples.push({ tMs: t, litCount });
        if (t >= obs) {
          clearInterval(id);
          resolve(samples);
        }
      }, ival);
    });
  }, { obs: observationMs, ival: intervalMs });
}

// Validate the "wave shape" invariant: lit-count timeseries shows ≥3 distinct
// peaks (rise → fall → rise → fall → ...) over the observation window.
// Rules out the false-pass case where a single char gets stuck lit.
export function assertWaveShapeValid(samples, { minPeaks = 3 } = {}) {
  // Find peaks: a sample is a peak if its litCount is > both neighbors.
  // Smoothing window = 1 sample (50ms) is enough since the wave is slow.
  let peaks = 0;
  let lastDirection = 0; // -1 falling, +1 rising
  let prev = samples[0]?.litCount ?? 0;
  for (let i = 1; i < samples.length; i++) {
    const cur = samples[i].litCount;
    if (cur > prev && lastDirection !== 1) {
      lastDirection = 1;
    } else if (cur < prev && lastDirection === 1) {
      // We just went from rising to falling = peak
      peaks++;
      lastDirection = -1;
    }
    prev = cur;
  }
  expect(peaks, `wave shape invalid — only ${peaks} peaks observed (need ≥${minPeaks}). Samples: ${JSON.stringify(samples.slice(0, 20))}…`).toBeGreaterThanOrEqual(minPeaks);
}

// Known console noise that is NOT our bug — third-party iframe / browser
// policy / Sentry chatter that shouldn't fail tests. Add patterns sparingly,
// only after confirming they're truly third-party.
const CONSOLE_NOISE_PATTERNS = [
  /compute-pressure is not allowed/i,        // YouTube iframe permissions policy
  /Permissions policy violation/i,           // Same family
  /failed to load resource.*youtube/i,       // YT thumbnail / image fetch noise
  /\[GA4\]/i,                                // GA4 dev-mode warnings
  /sentry/i,                                 // Sentry breadcrumb chatter
  /youtube-nocookie\.com.*CORS/i,            // YT iframe cross-origin chatter
  /blocked by CORS policy.*youtube/i,        // Same family
  /XMLHttpRequest.*youtube/i,                // YT iframe XHR noise
  /^Failed to load resource: net::ERR_FAILED$/i,  // Generic CORS-blocked
                                                  // resource (almost always
                                                  // third-party iframe; URL
                                                  // not in msg.text() so we
                                                  // can't match by domain)
];

// Subscribe to console errors — fail the test if any error/exception fires
// during the test body. Filters out known third-party noise. Call right
// after page is created.
//
// Pass `extraIgnore` (array of RegExps) to add per-test exceptions. Don't
// loosen this lightly — console errors are often the first signal of a real
// regression.
export function failOnConsoleError(page, { extraIgnore = [] } = {}) {
  const ignore = [...CONSOLE_NOISE_PATTERNS, ...extraIgnore];
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (ignore.some((rx) => rx.test(text))) return;
    throw new Error(`Console error during test: ${text}`);
  });
  page.on('pageerror', (err) => {
    if (ignore.some((rx) => rx.test(err.message))) return;
    throw new Error(`Page error during test: ${err.message}`);
  });
}
