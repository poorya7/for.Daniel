// Test #9 — Japanese-source video → switch to English.
//
// CJK / Japanese-vs-zh-tw disambiguation is the most fragile area of the
// font system per the architecture doc (Han unification, etc.). Persian
// is well-covered; CJK is not. This is cheap insurance for the
// highest-risk script regression.
//
// SKIPPED until the user provides a known Japanese-source video URL.
// Add the URL to FIXTURE_JAPANESE_SOURCE_URL in _helpers.js to enable.

import { test, expect } from '@playwright/test';
import {
  FIXTURE_JAPANESE_SOURCE_URL,
  awaitFullPipeline,
  failOnConsoleError,
} from './_helpers.js';

test.skip(
  !FIXTURE_JAPANESE_SOURCE_URL,
  'Need a known Japanese-source YouTube URL — see _helpers.js TODO'
);

test('Japanese source → renders with Noto Sans JP, not zh-CN fallback', async ({ page }) => {
  test.setTimeout(120_000);

  failOnConsoleError(page);
  await page.goto(`/app.html?url=${encodeURIComponent(FIXTURE_JAPANESE_SOURCE_URL)}`);
  await awaitFullPipeline(page);

  // Verify Noto Sans JP is in the loaded fonts.
  const jpFontLoaded = await page.evaluate(async () => {
    return await document.fonts.check('1em "Noto Sans JP"');
  });
  expect(jpFontLoaded, 'Noto Sans JP should be loaded for JP source').toBe(true);

  // Switch to English and verify the language flips correctly.
  await page.locator('#langToggleBtn, .mobile-lang-globe, .tab-btn-language').first().click();
  await page.waitForSelector('[data-lang="en"]', { timeout: 5_000, state: 'visible' });
  await page.locator('[data-lang="en"]').first().click();

  // Wait for English summary to land.
  await page.waitForFunction(
    () => {
      const candidates = [
        document.getElementById('summaryDisplayA'),
        document.getElementById('summaryDisplayHost'),
        document.getElementById('summaryWheelHost'),
        document.getElementById('summaryContent'),
      ].filter(Boolean);
      return candidates.some((el) => /[a-z]{4,}/i.test(el.innerText));
    },
    null,
    { timeout: 60_000 }
  );
});
