// Test #8 — Open chat → tap fixed chip → answer arrives.
//
// Per the architecture doc, chat has 2 fixed chips ("What's the video about?",
// "Summarize the video") that arrive after the pipeline lands. Tapping one
// produces a typing bubble then an AI answer (cached or live).

import { test, expect } from '@playwright/test';
import {
  pasteUrlAndAwaitResultsView,
  awaitFullPipeline,
  failOnConsoleError,
} from './_helpers.js';

test('open chat → tap fixed chip → AI answer arrives within 12s', async ({ page }) => {
  test.setTimeout(60_000);

  failOnConsoleError(page);
  await pasteUrlAndAwaitResultsView(page);
  await awaitFullPipeline(page);

  // Open chat — desktop has chat panel resident; mobile opens via top-nav button.
  const navChatBtn = page.locator('#navChatBtnM');
  if ((await navChatBtn.count()) > 0 && (await navChatBtn.isVisible())) {
    await navChatBtn.click();
  }

  // Wait for chips to appear (chat panel must be open + suggested questions
  // pulled from AppState.suggestedQuestions or fixed defaults).
  await page.waitForSelector('.chat-chip', { timeout: 15_000, state: 'visible' });

  // Capture initial AI bubble count (greeting only).
  const aiBubblesBefore = await page.locator('#chatMessages .bubble-ai').count();

  // Tap the first fixed chip.
  await page.locator('.chat-chip').first().click();

  // Wait for a NEW AI bubble (the answer) to appear above the prior count.
  // Cached answers land in <2s; live LLM in 4-12s. Budget 12s + buffer.
  await page.waitForFunction(
    (priorCount) => {
      const cur = document.querySelectorAll('#chatMessages .bubble-ai').length;
      return cur > priorCount;
    },
    aiBubblesBefore,
    { timeout: 15_000 }
  );

  // Validate the answer has actual content (not an empty placeholder).
  const answerText = await page.locator('#chatMessages .bubble-ai').last().innerText();
  expect(answerText.trim().length, 'AI answer should have content').toBeGreaterThan(20);
});
