// Test #4 — Karaoke wave shape valid.
//
// Tightened per the 2026-05-06 review pass: the original assertion
// `count('.lit') > 0 over 30 frames` would pass even if a single char
// got stuck lit forever. The new invariant is the lit-count timeseries
// shows ≥3 distinct peaks (rise → fall → rise → fall...) in 5s of
// playback, validating the actual bell-shape wave behavior.
//
// IMPORTANT: this test plays a YouTube video. YT may need user gesture
// to autoplay; we attempt programmatic play() and bail clearly if blocked.

import { test, expect } from '@playwright/test';
import {
  pasteUrlAndAwaitResultsView,
  awaitFullPipeline,
  captureLitCountTimeseries,
  assertWaveShapeValid,
  failOnConsoleError,
} from './_helpers.js';

test('karaoke wave shape: lit-count timeseries shows ≥3 peaks in 5s', async ({ page }) => {
  failOnConsoleError(page);
  await pasteUrlAndAwaitResultsView(page);
  await awaitFullPipeline(page);

  // Force karaoke to load + start playing programmatically. The YT iframe
  // sits inside .video-embed. We use the player wrapper exposed via the
  // window bridge (window.PlayerManager).
  const playOk = await page.evaluate(async () => {
    if (typeof window.PlayerManager?.play !== 'function') return false;
    try {
      await window.PlayerManager.play();
      return true;
    } catch {
      return false;
    }
  });
  expect(playOk, 'PlayerManager.play() must succeed (YT iframe ready, autoplay not blocked)').toBe(
    true
  );

  // Give karaoke a moment to load chunks + start emitting lit chars.
  await page.waitForTimeout(2_000);
  await page.waitForSelector('.k-ch.lit', { timeout: 30_000, state: 'attached' });

  // Capture 5 seconds of lit-count samples and assert the wave-shape invariant.
  const samples = await captureLitCountTimeseries(page, 5_000, 50);
  assertWaveShapeValid(samples, { minPeaks: 3 });
});
