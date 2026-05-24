// Test #7 — URL >10h.
//
// Verifies: cap-fail message renders in the shark bubble (not a generic
// error). Per the architecture doc the cap is enforced via the
// /api/video/meta duration check (>10h reject).
//
// SKIPPED until the user provides a known >10h video URL.
// Add the URL to FIXTURE_OVER_10H_URL in _helpers.js to enable.

import { test, expect } from '@playwright/test';
import { FIXTURE_OVER_10H_URL, failOnConsoleError } from './_helpers.js';

test.skip(!FIXTURE_OVER_10H_URL, 'Need a known >10h YouTube URL — see _helpers.js TODO');

test('URL >10h → cap-fail message in shark bubble', async ({ page }) => {
  failOnConsoleError(page);
  await page.goto(`/app.html?url=${encodeURIComponent(FIXTURE_OVER_10H_URL)}`);

  // The shark bubble should land a cap-fail message text matching the cap copy.
  await page.waitForFunction(
    () => {
      const bubble = document.querySelector('.shark-bubble, .shark-message, .bubble-loading-text');
      return bubble && /too long|10 hours?|cap|limit/i.test(bubble.innerText);
    },
    null,
    { timeout: 30_000 }
  );
});
