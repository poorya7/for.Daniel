# Frontend Testing Harness — pattern + standard

> **Standing rule:** every major frontend module gets its own URL-flagged debug
> panel + auto-runnable test buttons before the module is considered done. No
> "trust me, I tested it manually." If the test can't be run from a phone with
> one tap, it doesn't count as verified.

## Why this exists

RecapShark has no Jest/Vitest/Cypress setup, and adding one is overkill at this
stage. But "I made a change, it looks fine on my screen" is not enough — the
user has burned hours chasing regressions that a one-button test would have
caught immediately.

The user reads + acts on phone, where DevTools doesn't exist. A test that
requires opening a console isn't a test the user can run. So the standard is:
**a floating button in the page itself, gated by a URL flag, that runs the
tests and shows a copy-paste-ready PASS/FAIL report.**

## Canonical example

The lazy karaoke Phase 2 panel — see `src/js/player/karaoke.js` (search for
`__KaraokeDebug` and `_runPhase2HelperTests` / `_runPhase2RenderingTests`).
Activated by appending `?karaoke_debug=1` to any URL.

Two test suites:

1. **Helper unit tests (Milestone A)** — pure-logic helpers (deduplication,
   range merging, coverage checks). Don't need a video loaded; runnable any
   time. ~20 assertions.
2. **Rendering tests (Milestone B)** — exercises the real apply paths against
   the real rendered transcript DOM. Inject fake-but-correctly-timed words,
   call the apply path, assert rows got the spans (or didn't, in the
   coverage-gated cases). ~9 assertions.

Both produce a tally: `===== N passed, M failed =====`.

## The pattern (apply this to every major module going forward)

### 1. URL-flag gate

Pick a flag name that matches the module: `?karaoke_debug=1`,
`?translation_debug=1`, `?chunk_loader_debug=1`. Production users never see
this — only the tester (or future agent verifying a regression).

```js
if (typeof window !== 'undefined' &&
    /[?&]MODULE_debug=1\b/.test(window.location.search)) {
  // expose helpers + inject panel
}
```

### 2. Expose private helpers + state under the flag

Attach a `window.__ModuleDebug` object holding:
- The helpers worth testing (dedup logic, range math, parsers, etc.)
- A `_state()` snapshot function (returns plain JSON, no internals)
- A `_resetState()` to wipe the module clean between tests
- Any "inject fake data" helpers needed for rendering tests

Production code never references `window.__ModuleDebug`. The flag check keeps
the bytes from running for normal users.

### 3. Floating panel UI

A fixed-position dark panel in the top-right with:
- One button per test suite
- "Copy" button — copies the result text to clipboard for pasting back to
  chat / commit / etc.
- "Close" button — dismisses the panel without reloading

iOS-friendly: `env(safe-area-inset-top)` for the notch, large tap targets,
clear PASS/FAIL color (green on success, red on any failure).

### 4. Test types — match the module

- **Helper tests** for any module with pure-logic functions: dedup, sort,
  merge, parse, format. These run anywhere, no DOM needed.
- **Rendering tests** for any module that mutates the DOM: inject fixture
  data, call the render path, assert the DOM changed (or didn't) in the
  expected way. Idempotency, coverage gates, reset behavior — all fair game.
- **Integration tests** for any module that hits the network or talks to
  another module: mock the upstream, assert the downstream behavior.

Add suites as the module grows. One suite is fine; ten suites is fine; the
button list scales.

### 5. Self-contained — no external test framework

The whole harness lives in the module file. Functions, assertions, panel HTML
— all of it. No imports needed beyond what the module already pulls in. This
keeps the harness alive even if Vite / npm / the test runner of the day
breaks. Bytes are ~5 KB per module, gated behind the flag.

## When to apply

For ANY major implementation that:
- Has non-trivial logic worth verifying programmatically
- Touches the DOM in ways that could regress silently
- Has a measurable "did it work" outcome (counts, hashes, presence/absence
  of elements)

For trivial changes (CSS tweaks, typo fixes, single-line bug fixes), skip the
harness — diff review is enough.

## Standing requirement going forward

Every new major module / phase / milestone gets its own debug panel + test
suite **before** the work is considered done. The verify-then-push rule
(`feedback_verify_before_push.md`) enforces this — if there's no test, there's
no verification, so there's no push.

If you find yourself thinking "I'll just verify this manually one time" —
that's a sign you should add the test instead. Future-you will thank
present-you when something breaks six months from now.

---

## Addendum: Playwright as a refactor-protection layer (added 2026-05-06)

The standing rule above ("no Jest/Vitest/Cypress, in-page panels are enough")
applies to **feature verification** — does this module work correctly as
features evolve? In-page debug panels solve that problem cleanly:
mobile-runnable, no external framework, lives next to the code it tests.

**Refactor protection is a different problem.** When splitting a 3,282-LOC
monolith into 7 files, the question isn't "does the feature work?" — the
question is "did behavior get preserved across module boundaries that didn't
exist before?" That requires:

- **Cross-viewport runs in one go** (8 tests × desktop + mobile × N runs for
  perf budget statistical hygiene = 100+ runs per cycle)
- **Screenshot snapshots** for visual-diff regression catching (in-page panels
  can't capture themselves)
- **Headless automation** — runs unattended during the karaoke 3-5 day soak
- **Frame-time perf budget** with N=10 quiesced-machine protocol —
  orchestrated outside the page, can't be done from inside it

For that specific need (and only that need), the SRP refactor introduced
**Playwright** as a `devDependencies` package. The 10-test happy-path harness
lives in `tests/e2e/`; see [`REFACTORING_LESSONS.md`](./REFACTORING_LESSONS.md)
for the rationale + perf-budget protocol.

### Why this doesn't violate the "vanilla JS" stance

"Vanilla JS" applies to the **runtime bundle** — what users download. Keeping
that framework-free keeps the bundle small and avoids React/Vue churn.
**Test infra is dev-only**, never shipped to `dist/`. Same logic as spaCy on
the backend: it's a Python package the user never sees, used to build the
product. Playwright lives in `devDependencies`, browser binaries stay in
`~/.cache/ms-playwright/`, never reaches the user.

### Where each tool fits

| Need | Tool |
|---|---|
| Verify a single module works after a feature change | In-page debug panel (`?MODULE_debug=1`) |
| Mobile-runnable smoke check from a phone, no laptop in the loop | In-page debug panel |
| Verify behavior preserved across module boundaries during refactor | Playwright e2e suite (`tests/e2e/`) |
| Perf budget enforcement with statistical hygiene | Playwright + N=10 quiesced protocol |
| Headless runs during karaoke prod soak | Playwright |
| Cross-viewport regression sweep (desktop + mobile in one run) | Playwright |
| Screenshot snapshots / visual diff | Playwright (toPHaveScreenshot) |
| Accessibility regression check (axe-core) | Playwright (`@axe-core/playwright`) |

The two layers complement each other. Playwright doesn't replace the in-page
panels — `?karaoke_debug=1` and friends remain the standing rule for
feature verification. Playwright sits on top, scoped to refactor protection
and budget enforcement.

### CI status (Phase 5, 2026-05-09)

`.github/workflows/build.yml` has a separate `playwright-list` job that runs
`npx playwright test --list` only — config parse + spec discovery, **no actual
test execution**. Real runs need a live FastAPI with paid API keys (SubsProvider /
OpenAI / AsrProvider); wiring those into CI is its own project (mock-backend layer
+ key management). `continue-on-error: true` so a failure here surfaces as a
yellow PR warning, not a red merge-block. Catches config drift / spec-file
syntax errors cheaply (~30 sec). Promote to a blocking job once the suite is
stable enough to gate on (currently ~5/20 pass, mostly quota / network noise).

---

## Karaoke perf baseline (Firefox, 2026-05-09)

Captured during a "user-perceives-hiccups" investigation. The Firefox
profiler (DevTools → Performance) recorded ~30s of karaoke playback on a
HiDPI Windows desktop (1280×534 viewport at DPR 3).

**Result: zero measurable jank.** The user's perceived hiccups were NOT
attributable to JS, paint, or compositor work. Likely the wave's natural
on/off behavior at audio gaps (lit-char count drops to 0 during silences,
then resumes) reading as visual stuttering even though fps is locked.

Headline numbers (page content thread, 27,316 samples over the recording):

| Metric | Value |
|---|---|
| Sample-gap p50 | 1.99 ms |
| Sample-gap p95 | 2.53 ms |
| Sample-gap p99 | 2.73 ms |
| Sample-gap max (worst single block) | **17.67 ms** (one missed frame, never repeated) |
| Gaps >16.7 ms (1+ frame missed) | **3** out of 27,316 (~0.01%) |
| Gaps >50 ms (visible jank) | **0** |
| Gaps >100 ms (clear hitch) | **0** |
| Compositor max gap | 3.30 ms |
| Renderer (WebRender) max gap | 16.61 ms (vsync alignment) |

The full profile (~30 MB compressed) is archived at
`tests/baselines/karaoke-perf/firefox-2026-05-09-clean.json.gz`. Drag-drop
into [profiler.firefox.com](https://profiler.firefox.com) to inspect.

**Use this as the regression baseline.** If a future change makes karaoke
feel laggy AND the profiler shows gaps >50 ms / dozens of >16.7 ms misses
on the page thread / compositor max-gap above ~10 ms, that's a real perf
regression. If those numbers stay clean and "lag" is still reported, look
at the wave's behavioral characteristics (lit-count gaps during silences,
radius vs perceived motion, audio-buffer lookahead per browser) — not at
JS or paint costs.

The companion `tests/e2e/perf-capture.mjs` can capture frame-time stats
under headless Chromium for CI-style budget tracking; the Firefox profile
above is the gold-standard manual capture against a real machine + real
playback.
