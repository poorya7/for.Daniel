# Unit tests — how we test the logic layer

**Last updated:** 2026-05-23 — first version, established post no-panel migration after the dismiss-flow refactor surfaced the need for an explicit guide. The convention already existed (20 test files / 252 tests at write-time), this doc just makes it discoverable.

Open this doc before adding a new reducer, hook, or library module — the rule is "if it carries logic, it carries tests."

---

## What we test (and what we don't)

**Test it:**
- Reducers / state machines (e.g. `features/app-state/appState.ts`).
- Custom hooks with policy in them (e.g. `features/photo-capture/usePhotoCaptureSession.ts`, `features/dismiss/useDismissFlow.tsx`).
- Library modules with branching logic (e.g. `lib/queue/*`, `lib/liveCaptions/*`, formatters, error mappers).
- Anything you can describe with the sentence *"given X, when Y, the system should Z"*.

**Don't test:**
- Pure presentational React components (`Dialog`, `LeadReviewCard`, etc.). Visual feel is judged by a human in a real browser — see `01_PROJECT_RULES.md §3.6` ("Chrome MCP is not a substitute for the user's eyeballs"). A passing render-tree assertion buys nothing here and reads as noise to a reviewer.
- Trivial wiring (a prop forwarded one level, a useEffect with a single setter call).
- Anything where the test would just restate the implementation line-for-line.

The split tracks the four-layer architecture noted at the top of `App.canvas.tsx`: **rendering** is human-tested, **logic / data / orchestration** is unit-tested.

---

## Where tests live

Co-located with the file they test, same folder, `.test.ts` or `.test.tsx`:

```
src/features/dismiss/useDismissFlow.tsx
src/features/dismiss/useDismissFlow.test.tsx     ← here
```

No separate `__tests__/` directory. The closer the test sits to the code, the more likely a future agent notices it when they change the code.

---

## How to run

```sh
# whole suite (CI-shaped, single pass)
pnpm vitest run

# whole suite, watch mode (re-runs on save)
pnpm vitest

# just one file or folder
pnpm vitest run src/features/dismiss

# coverage report (only when explicitly asked — slow)
pnpm vitest run --coverage
```

Tests do **not** ship to users — `vitest` runs in dev only, never gets bundled into the production app.

---

## The template — vitest + Testing Library

Copy-paste a working starting point from the closest existing test:

| You're testing… | Use this as the template |
|---|---|
| A reducer / pure function | [`features/app-state/appState.test.ts`](../../frontend/src/features/app-state/appState.test.ts) |
| A custom hook | [`features/dismiss/useDismissFlow.test.tsx`](../../frontend/src/features/dismiss/useDismissFlow.test.tsx) (uses `renderHook` + `act`) |
| A library module with mocks | [`features/photo-capture/usePhotoCaptureSession.test.ts`](../../frontend/src/features/photo-capture/usePhotoCaptureSession.test.ts) (shows `vi.mock` pattern for external deps) |
| Queue / IndexedDB | [`lib/queue/drainer.test.ts`](../../frontend/src/lib/queue/drainer.test.ts) |

Conventions across all of them:

- `describe` blocks group by behaviour, not by function name.
- `it("does X when Y")` — declarative sentence, present tense. The test name reads as a spec line.
- One assertion per `it` when possible; multiple are fine when they all describe the same behaviour.
- Mock the boundary, not the unit under test. If your code calls `fetch`, mock fetch; if it calls another hook, render the hook with stub callbacks. Never mock the file you're testing.

---

## When tests should fail you (the value)

A test exists to catch the moment a future change quietly breaks an agreed-upon rule. If your change breaks an existing test, the test is doing its job — read the failing assertion, decide whether the new behaviour is correct (then update the test) or the change is wrong (then fix the code). Never silence a test you don't understand.

The dismiss-flow test was added after a row-tap regression slipped through hand-testing on the photo-review screen: the unit test for *"on multi-view, tap a row → opens row edit, not landing"* would have caught it before the user ever saw it.

---

## Adding a test to an existing file

Find the closest `describe` block, add an `it("does X when Y")`. If the new behaviour is its own concern (e.g. an inner-dismiss escape hatch on top of the layer-pop policy), open a new `describe` block in the same file rather than nesting deep.

If a behaviour you're adding spans **multiple** existing test files, that's a smell — the units under test probably need a shared helper, not split coverage.
