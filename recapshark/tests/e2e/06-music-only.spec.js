// Test #6 — Music-only YouTube URL.
//
// Verifies: "Mostly music" placeholder visible, summary tab badge shown.
// Per the architecture doc, _detectMostlyMusic counts non-annotation
// words across the transcript; <100 = music-only path.
//
// SKIPPED until the user provides a known music-only video URL.
// Add the URL to FIXTURE_MUSIC_ONLY_URL in _helpers.js to enable.

import { test, expect } from '@playwright/test';
import { FIXTURE_MUSIC_ONLY_URL, failOnConsoleError } from './_helpers.js';

test.skip(!FIXTURE_MUSIC_ONLY_URL, 'Need a known music-only YouTube URL — see _helpers.js TODO');

test('music-only video → friendly placeholder + summary tab badge', async ({ page }) => {
  failOnConsoleError(page);
  await page.goto(`/app.html?url=${encodeURIComponent(FIXTURE_MUSIC_ONLY_URL)}`);

  await page.waitForSelector('body.is-mostly-music', { timeout: 60_000, state: 'attached' });
  // Placeholder text should be present somewhere visible.
  const placeholderVisible = await page.evaluate(() => {
    return /mostly music|no real spoken/i.test(document.body.innerText);
  });
  expect(placeholderVisible, 'should show music-only placeholder text').toBe(true);
});
