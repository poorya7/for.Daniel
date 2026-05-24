// Test #2 — Switch to Persian (fa).
//
// Verifies: all four panels re-render in Persian, RTL applied, Vazirmatn
// font loads. Persian is the user's primary non-English path so a
// regression here = high signal.

import { test, expect } from '@playwright/test';
import {
  pasteUrlAndAwaitResultsView,
  awaitFullPipeline,
  failOnConsoleError,
} from './_helpers.js';

test('switch to Persian → panels re-render with RTL + Vazirmatn', async ({ page }) => {
  failOnConsoleError(page);
  await pasteUrlAndAwaitResultsView(page);
  await awaitFullPipeline(page);

  // Open language picker. Desktop has #langToggleBtn; mobile has
  // .mobile-lang-globe + .tab-btn-language. Click whichever is visible.
  const langTriggers = page.locator('#langToggleBtn, .mobile-lang-globe, .tab-btn-language');
  await langTriggers.first().click();
  await page.waitForSelector('[data-lang="fa"]', { timeout: 5_000, state: 'visible' });

  // Click Persian.
  await page.locator('[data-lang="fa"]').first().click();

  // Wait for results view to flip RTL.
  await page.waitForSelector('#resultsView.rtl, body.rtl', { timeout: 30_000 });

  // Verify Vazirmatn loaded into the document fonts cache.
  const vazirmatnLoaded = await page.evaluate(async () => {
    return await document.fonts.check('1em "Vazirmatn"');
  });
  expect(vazirmatnLoaded, 'Vazirmatn font should be loaded post-switch').toBe(true);

  // Verify summary text actually changed to Persian (Arabic-script range).
  const hasPersian = await page.evaluate(() => {
    const candidates = [
      document.getElementById('summaryDisplayA'),
      document.getElementById('summaryDisplayHost'),
      document.getElementById('summaryWheelHost'),
      document.getElementById('summaryContent'),
    ].filter(Boolean);
    for (const el of candidates) {
      if (/[؀-ۿ]/.test(el.innerText)) return true;
    }
    return false;
  });
  expect(hasPersian, 'summary should contain Persian characters post-switch').toBe(true);
});
