# tests/e2e/ — Playwright refactor-protection harness

**Purpose:** Refactor-protection only. Verifies behavior is preserved across module boundaries that didn't exist before. NOT a general test suite — per `docs/_tech/14_TESTING_HARNESS.md`, the standing pattern for feature verification is in-page debug panels (`?MODULE_debug=1`).

See [`docs/_tech/14_TESTING_HARNESS.md`](../../docs/_tech/14_TESTING_HARNESS.md) for the harness rationale + perf-budget protocol.

## How to run

```
npm run test:e2e             # all tests, both projects (desktop + mobile)
npm run test:e2e:headed      # same, with visible browser windows
npm run test:e2e:ui          # interactive UI mode (great for debugging)
npm run test:e2e:report      # open the HTML report from the last run
```

Tests assume `vite` (port 5173) + `uvicorn` (port 8001) are already running locally — the user starts them manually (memory rule, never auto-started by tests).

## Current state (2026-05-06)

| # | Test | Desktop | Mobile | Notes |
|---|---|---|---|---|
| 01 | paste URL → full pipeline | ✅ pass | ✅ pass | The core gate. Pipeline renders chapters + summary + transcript. |
| 02 | switch to Persian | ⚠️ | ⚠️ | Selector for lang-picker overlay needs DOM inspection. Iterate per cycle. |
| 03 | bilingual mode | ⚠️ | ⚠️ | Loose selectors for the dual-flag button — needs UI exploration. |
| 04 | karaoke wave shape | ⚠️ | ⚠️ | Blocked by Chromium autoplay policy — `PlayerManager.play()` returns false. Either expose a programmatic-play API or use `page.click()` on the play button. Iterate when cycle 7 needs it. |
| 05 | karaoke seek | ✅ pass | — | Most timing-sensitive flow works. |
| 06 | music-only video | ⚠️ | — | Selector `body.is-mostly-music` doesn't match the live `r9wj7Dwe--E` URL. May need different detection or different fixture. |
| 07 | URL >10h cap-fail | ⚠️ | — | Shark-bubble selector for cap-fail message doesn't match. Need DOM inspection. |
| 08 | open chat → chip | ⚠️ | ⚠️ | Chip click works but answer doesn't appear within 12s budget. May need longer timeout or different completion signal. |
| 09 | Japanese-source CJK | ✅ pass | — | Noto Sans JP loads correctly. |
| 10 | a11y baseline mode | ✅ pass | — | Pre-refactor baseline of 4 known violations recorded. Test fails only on NEW violations. |

**Status:** 4/10 tests pass as the working refactor-protection baseline (#01 + #05 + #09 + #10). Tests 02/03/04/06/07/08 are scaffolded with TODOs — iterate when each cycle's checklist needs them.

## Maintenance

- **A11y baseline regen:** if you intentionally fix one of the 4 baseline violations, set `BASELINE_REGENERATE_MODE = true` in [`10-a11y.spec.js`](./10-a11y.spec.js), run, paste the new baseline back in, set the flag to false, commit.
- **Adding a new test:** new file `NN-name.spec.js`, import helpers, follow the `failOnConsoleError(page) → pasteUrlAndAwaitResultsView(page) → awaitFullPipeline(page)` pattern.
- **Fixture URLs:** all in [`_helpers.js`](./_helpers.js). Don't inline test URLs in spec files.
- **Console noise filtering:** add patterns to `CONSOLE_NOISE_PATTERNS` in `_helpers.js`. Be conservative — console errors are often the first signal of a real regression.
