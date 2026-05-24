// Test #1 — Paste a known YouTube URL → wait for full pipeline.
//
// Verifies: short summary, chapters, full summary, transcript all visible.
// Runs on desktop + mobile viewports.

import { test, expect } from '@playwright/test';
import {
  pasteUrlAndAwaitResultsView,
  awaitFullPipeline,
  failOnConsoleError,
} from './_helpers.js';

test('paste URL → full pipeline renders all four panels', async ({ page }) => {
  failOnConsoleError(page);
  await pasteUrlAndAwaitResultsView(page);
  await awaitFullPipeline(page);

  // Chapters present
  const chapterCount = await page.locator('.chapter-item').count();
  expect(chapterCount, 'should render at least one chapter').toBeGreaterThan(0);

  // Summary content present (read from whichever active display panel exists)
  const summaryText = await page.evaluate(() => {
    const candidates = [
      document.getElementById('summaryDisplayA'),
      document.getElementById('summaryDisplayHost'),
      document.getElementById('summaryWheelHost'),
      document.getElementById('summaryContent'),
    ].filter(Boolean);
    for (const el of candidates) {
      const t = el.innerText.trim();
      if (t.length > 50) return t;
    }
    return '';
  });
  expect(summaryText.length, 'summary should have content').toBeGreaterThan(50);

  // Transcript present
  const transcriptLines = await page.locator('.ts-text').count();
  expect(transcriptLines, 'should render multiple transcript lines').toBeGreaterThan(5);
});
