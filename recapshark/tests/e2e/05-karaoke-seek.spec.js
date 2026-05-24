// Test #5 — Seek to 5:00, wait for karaoke to catch up.
//
// A fresh seek triggers a lazy chunk fetch (~45-75s on cold cache).
// This test verifies the full seek-then-fetch-then-light-up loop.

import { test, expect } from '@playwright/test';
import {
  pasteUrlAndAwaitResultsView,
  awaitFullPipeline,
  failOnConsoleError,
} from './_helpers.js';

test('seek to 5:00 → karaoke catches up within 90s', async ({ page }) => {
  test.setTimeout(180_000); // long fetch + buffer

  failOnConsoleError(page);
  await pasteUrlAndAwaitResultsView(page);
  await awaitFullPipeline(page);

  // Start playback then seek to t=300.
  await page.evaluate(async () => {
    if (typeof window.PlayerManager?.play === 'function') {
      try {
        await window.PlayerManager.play();
      } catch {}
    }
    if (typeof window.PlayerManager?.seekTo === 'function') {
      await window.PlayerManager.seekTo(300);
    } else if (typeof window.PlayerManager?.seek === 'function') {
      await window.PlayerManager.seek(300);
    }
  });

  // Wait for at least one .k-ch.lit to appear (karaoke caught up).
  // 90s budget covers worst-case AsrProvider chunk fetch + processing.
  await page.waitForSelector('.k-ch.lit', { timeout: 90_000, state: 'attached' });

  const litCount = await page.locator('.k-ch.lit').count();
  expect(litCount, 'should have ≥1 lit char after seek catches up').toBeGreaterThan(0);
});
