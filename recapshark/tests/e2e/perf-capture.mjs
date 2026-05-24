// One-off perf capture script — cycle 7b verification.
// Runs the full pipeline + 30s of karaoke playback, captures frame-time stats.
// Usage:
//   node tests/e2e/perf-capture.mjs              # default 3 runs
//   node tests/e2e/perf-capture.mjs --runs=5     # custom run count
//
// Launches Chromium with --autoplay-policy=no-user-gesture-required so the
// YT iframe can autoplay unattended. Each run is a fresh context (cold cache
// for AsrProvider chunks); discards run 0 as warmup, reports median of remaining.
//
// Output: JSON to stdout — { runs: [...], median: { mean, p50, p95 } }.
// Companion to the perf-budget protocol — see docs/_tech/14_TESTING_HARNESS.md.

import { chromium } from '@playwright/test';

const RUNS = Number(
  (process.argv.find((a) => a.startsWith('--runs=')) || '--runs=3').split('=')[1]
);
const VIDEO_URL = 'https://youtu.be/qADTr7d6gMU';
const OBSERVATION_MS = 30_000;

async function captureOnce(browser, label) {
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => process.stderr.write(`[${label}] pageerror: ${e.message}\n`));

  const target = `http://localhost:5173/app.html?url=${encodeURIComponent(VIDEO_URL)}`;
  await page.goto(target, { waitUntil: 'domcontentloaded' });

  // Pipeline: chapters → summary → transcript
  await page.waitForSelector('.chapter-item', { timeout: 30_000 });
  await page.waitForFunction(
    () => {
      const c = ['summaryDisplayA', 'summaryDisplayHost', 'summaryWheelHost', 'summaryContent']
        .map((id) => document.getElementById(id))
        .filter(Boolean);
      return c.some((el) => el.innerText.trim().length > 50);
    },
    null,
    { timeout: 30_000 }
  );
  await page.waitForSelector('.ts-text', { timeout: 30_000, state: 'attached' });

  // Start playback (autoplay-allow flag set on browser launch).
  await page.evaluate(async () => {
    if (window.PlayerManager?.play) {
      try {
        await window.PlayerManager.play();
      } catch {}
    }
  });

  // Wait for first lit char (karaoke loaded + wave running).
  await page.waitForSelector('.k-ch.lit', { timeout: 60_000, state: 'attached' });

  // Capture frame times for OBSERVATION_MS.
  const stats = await page.evaluate(async (ms) => {
    return await new Promise((resolve) => {
      const samples = [];
      let last = performance.now();
      let frames = 0;
      const start = last;
      const litCounts = [];
      function tick(now) {
        const dt = now - last;
        last = now;
        if (frames > 5) {
          samples.push(dt);
          litCounts.push(document.querySelectorAll('.k-ch.lit').length);
        }
        frames++;
        if (now - start < ms) {
          requestAnimationFrame(tick);
        } else {
          samples.sort((a, b) => a - b);
          const mean = samples.reduce((s, v) => s + v, 0) / samples.length;
          const pct = (p) => samples[Math.floor(samples.length * p)];
          const litMean = litCounts.reduce((s, v) => s + v, 0) / litCounts.length;
          resolve({
            mean,
            p50: pct(0.5),
            p95: pct(0.95),
            p99: pct(0.99),
            n: samples.length,
            durationMs: ms,
            litMean,
          });
        }
      }
      requestAnimationFrame(tick);
    });
  }, OBSERVATION_MS);

  await ctx.close();
  return stats;
}

const browser = await chromium.launch({
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required'],
});

const runs = [];
for (let i = 0; i < RUNS; i++) {
  const label = i === 0 ? 'warmup' : `run${i}`;
  process.stderr.write(`[perf] ${label} starting...\n`);
  try {
    const r = await captureOnce(browser, label);
    runs.push({ label, ...r });
    process.stderr.write(
      `[perf] ${label}: mean=${r.mean.toFixed(2)}ms p95=${r.p95.toFixed(2)}ms litMean=${r.litMean.toFixed(1)}\n`
    );
  } catch (e) {
    process.stderr.write(`[perf] ${label} FAILED: ${e.message}\n`);
    runs.push({ label, error: e.message });
  }
}

await browser.close();

// Drop warmup, compute median of remaining.
const valid = runs.slice(1).filter((r) => !r.error);
const median = (arr) => {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
};
const summary = valid.length
  ? {
      meanMedian: median(valid.map((r) => r.mean)),
      p95Median: median(valid.map((r) => r.p95)),
      p99Median: median(valid.map((r) => r.p99)),
      litMeanAvg: valid.reduce((s, r) => s + r.litMean, 0) / valid.length,
    }
  : null;

console.log(JSON.stringify({ runs, validCount: valid.length, summary }, null, 2));
