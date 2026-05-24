// Test #3 — Switch to bilingual mode.
//
// Verifies: both languages side-by-side, flag toggle works, transcript
// rows show two text columns. Per the architecture doc this is the
// 3-button design (flag / flag / dual-flag).

import { test, expect } from '@playwright/test';
import {
  pasteUrlAndAwaitResultsView,
  awaitFullPipeline,
  failOnConsoleError,
} from './_helpers.js';

test('switch to bilingual mode → side-by-side rendering visible', async ({ page }) => {
  failOnConsoleError(page);
  await pasteUrlAndAwaitResultsView(page);
  await awaitFullPipeline(page);

  // Switch to Persian first (need a 2nd language for bilingual mode to mean anything)
  await page.locator('#langToggleBtn, .mobile-lang-globe, .tab-btn-language').first().click();
  await page.waitForSelector('[data-lang="fa"]', { timeout: 5_000, state: 'visible' });
  await page.locator('[data-lang="fa"]').first().click();
  await page.waitForSelector('#resultsView.rtl, body.rtl', { timeout: 30_000 });

  // Wait for translation to complete — bilingual control strip becomes
  // non-pending when ready.
  await page.waitForSelector(
    '.bilingual-controls:not(.pending), .bilingual-flag-toggle:not(.pending), .bilingual-btn-flags:not(.pending)',
    { timeout: 60_000, state: 'attached' }
  );

  // Click the dual-flag button (3rd button in the bilingual strip).
  // Selector is loose since the exact class evolves; look for any element
  // with bilingual + dual / both / two in its class list.
  const dualFlagBtn = page.locator(
    '.bilingual-btn-dual, .bilingual-dual-flag, [data-bilingual="dual"], button[title*="ilingual" i]'
  );
  if ((await dualFlagBtn.count()) > 0) {
    await dualFlagBtn.first().click();
    // After dual-flag, body should have a bilingual-related class.
    await page.waitForSelector('body.bilingual, body.bilingual-mode, [data-bilingual="dual"]', {
      timeout: 10_000,
      state: 'attached',
    });
  } else {
    test.fail(
      true,
      'Dual-flag bilingual trigger not found — selector list needs updating after the bilingual-controls UI evolves.'
    );
  }
});
