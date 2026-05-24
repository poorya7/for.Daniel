// Playwright config — refactor-protection harness.
// See docs/_tech/14_TESTING_HARNESS.md and docs/_tech/REFACTORING_LESSONS.md
// for context. Outputs (run artifacts + HTML report) live under tests/ to keep
// the repo root tidy; both subdirectories are gitignored.

import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  // Pipeline can be slow first time (subs fetch + 4 parallel LLM calls).
  // 60s gives headroom without masking real hangs.
  timeout: 60_000,
  expect: { timeout: 10_000 },

  // Refactor protection wants flakiness VISIBLE, not hidden by retries.
  retries: 0,

  // Single worker by default — perf-budget tests need a quiet machine,
  // running tests in parallel poisons frame-time measurements.
  // Override with `--workers=4` for the non-perf suites.
  workers: 1,

  // Test artifacts (traces, screenshots, videos) live under tests/output/.
  outputDir: './tests/output',

  // Reporter: list = clean console output, html = browseable report at
  // tests/report/ (gitignored).
  reporter: [
    ['list'],
    ['html', { outputFolder: 'tests/report', open: 'never' }],
  ],

  // Common settings — applied to every project below unless overridden.
  use: {
    baseURL: 'http://localhost:5173',
    // Capture trace on first retry (with retries:0, only manual reruns).
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    // Don't auto-accept dialogs — tests should handle them explicitly.
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },

  // Two viewports per the plan. Desktop = laptop default; mobile = iPhone X
  // dimensions but Chromium engine (saves the 150MB WebKit download — real
  // WebKit only matters for iOS-specific bugs, which the refactor isn't
  // expected to introduce. Add webkit project later if iOS-specific
  // regression hunts come up).
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
    },
    {
      name: 'mobile',
      use: {
        ...devices['Pixel 5'],
        viewport: { width: 375, height: 812 },
        userAgent:
          'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      },
    },
  ],

  // No webServer — user runs vite + uvicorn manually (memory rule).
  // If the servers aren't up, tests will fail fast with connection refused.
});
