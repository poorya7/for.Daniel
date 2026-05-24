# Refactoring Lessons

Durable lessons accumulated from refactor work in this codebase. Use these as a checklist when planning the next refactor — not as gospel. If new evidence contradicts any of them, update or replace.

---

## Pre-flight

1. **Tag main BEFORE the first split.** Per-commit revert works but a one-command panic-revert via tag is cheap insurance.
2. **Per-function LOC inventory at the start saves an hour of reshuffling per cycle.** A regex extractor (`re.match(r'^(async\s+def|def)\s+(\w+)', line)` for Python; similar for JS) gives the actual function-by-function distribution. Plan estimates are systematically off by 20–30%; inventory truth-checks them before any code moves.
3. **Dependency graphs (`madge` / `pydeps`) miss `window.*` cross-file refs.** ES module `import` statements are visible; window-bridge calls are not. Mitigation: a `git grep "window\..*"` baseline saved BEFORE each split, re-run after. New post-split window refs that weren't pre-split = silent coupling regression.

## Doing a split

4. **Map functions to modules by ACTUAL coupling, not the plan's high-level guess.** Plan estimates often miss by 20–30% once measured. Adapt the split shape to the inventory before code moves; don't be precious about plan numbers.
5. **Cross-module callbacks via `setup({deps})` keep the import DAG acyclic.** When module B needs to call back into A's domain, A passes the callback in once via `B.setup({ callbackName })` instead of B importing A.
6. **Public `window.X` surface stays byte-identical via thin delegation.** External consumers read `window.KaraokeManager.foo` etc.; the post-split objects forward methods to the new sister files. Zero diff for callers.
7. **In-place mutation discipline keeps bridge refs lasting forever.** When extracting a shared-state hub, the store NEVER reassigns its arrays/sets/maps. Consumers grab `var _words = KaraokeStore.getWords()` once at IIFE init; the ref stays valid across resets / video swaps because the underlying object identity never changes. Without this discipline, every reset would invalidate every bridge ref.
8. **Drop `this._method()` indirection when extracting pure helpers.** When methods on an object literal don't read `this`, they're hidden free functions. Extract them as named exports in their own files; rewrite call sites to call them directly.
9. **Where cross-cutting constants live matters.** Put cross-cutting constants where they're conceptually owned, not where they're most used. (Example: `_ASR_PROVIDER_COST_PER_SECOND` lives in `billing.py` where the daily counters live, not in `client.py` where the HTTP primitives live.)
10. **General-infra goes in `_lib/`, not the domain subpackage.** `AsyncTokenBucket` has nothing to do with karaoke specifically — any vendor with rate limits could use it. Put it in `pipeline/_lib/rate_limit.py` so future OpenAI / Translate clients can reuse without importing from karaoke.

## Stale-name cleanup

11. **Stale-name cleanup is FIRST-CLASS during a split, NOT a final-pass chore.** Parroting stale names into newly-extracted files would entrench them. The cheapest moment to fix stale names is when they're MOST visible — during the split.
12. **Public-API rename = blast-radius audit FIRST.** Before renaming any exported symbol, `git grep` for all callers, then update atomically with the rename. Internal-only names (no exported callers) renamed freely.
13. **Don't rename inside historical-context comments.** Keep old terminology in migration history notes ("3D-cylinder UI replaced with native flat scroll in late April 2026") so future agents can map old code references to the new structure. Renaming THOSE mentions erases the migration trail.

## Backend-specific (Python / FastAPI)

14. **3-commit shim pattern (extract+shim → rewrite imports → delete shim) for big extractions.** Each commit is independently buildable + testable. Rule of thumb: 3-commit if >2,500 LOC; single commit if smaller.
15. **Delete shims in-cycle once all callers re-pointed.** A shim with a single trivial caller costs more in cognitive load (extra import-graph hop, dead-weight file) than the one-line edit costs to retire. Don't defer shim deletion.
16. **Live-server template extraction beats raw-bytes extraction.** Pulling out a large HTML/CSS/JS string literal from a Python function via raw file bytes leaves stale escape sequences (e.g. `\\u2026`) that the parser would have collapsed at runtime. Curl the live server (which produces the runtime-correct string) and use THAT as the template, then sub `{{PLACEHOLDER}}` for the inline JSON.
17. **Verify byte-identical HTML/JSON output post-extraction (after stripping dynamic payloads).** Use a regex on `const FACETS = {.*?};` (or equivalent) to strip volatile JSON before diffing; otherwise data drift between calls flags as a "regression" that isn't one.
18. **Keep atomic invariants atomic.** Atomic-claim patterns (e.g. POST + 409-fallback-to-fetch in `_supabase_try_claim_pending`) MUST NOT regress to "check-then-insert" pairs — concurrent requests for the same key would duplicate work. Verify by reading the post-split function.

## Frontend-specific (vanilla JS / Vite)

19. **Bottom-of-IIFE `return { ... }` blocks are common forgotten spots.** When extracting symbols, grep the WHOLE file for trailing references — bodies, debug panels, AND export blocks. Missing one = boot-time `ReferenceError`.
20. **For pure file-move refactors, perf measurement is a confirmation step, not a discovery step.** Don't burn cycles measuring unless the inner-loop data-access pattern actually changed. Spot-check via headless Chromium instead.
21. **Big deletions via Python file-surgery beat Edit tool calls.** For deletions over ~200 LOC, `Edit`'s `old_string` would be unreliable. Use a Python snippet to find start/end markers and replace the span with a brief pointer comment. ~10s end-to-end.
22. **For script-tag → ES-module migration, replicate original script-tag ordering via import order in the entry module.** A script that originally ran BEFORE `main.js` (e.g. `shark-logo.js` sized SVG aspect ratio) goes at the TOP of `main.js`. Scripts that ran AFTER (DOMContentLoaded handlers expecting `window.*` bridges) go at the BOTTOM, after the bridge assignments.
23. **Bundle delta from "inline all the things" is acceptable up to a point.** Inlining 1,366 LOC of UI scripts added +5.38 kB gz, in exchange for fewer dist artifacts and easier cache/version. HTTP/2 already handles parallelism for bundled chunks; the extra round-trips you save by inlining are small.

23b. **`print → logger.info` conversions need a `logging.basicConfig()` in the same patch — otherwise everything silently drops.** Phase 4e converted 51 `print(..., flush=True)` calls to `logger.info` / `logger.warning` across 10 backend files. Each module declared `logger = logging.getLogger(__name__)`. Build was clean, lints clean, no errors. **But every info-level line was being silently dropped on prod** — Python's root logger defaults to WARNING, and `getLogger(__name__)` children inherit from root, NOT from uvicorn's named loggers (`uvicorn`, `uvicorn.access`, `uvicorn.error`). Fix: add `logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO").upper(), format="%(asctime)s [%(levelname)s] %(name)s: %(message)s", force=True)` at every entry point — both `server.py` AND any standalone script invoked as a separate process (e.g. `etl_sessions.py` `__main__` for the cron). Detection in practice: the gap is invisible on local dev because pm2's stdio handling is more permissive; surfaces only when "where did the [KARAOKE-CHUNK] lines go?" hits prod ops. Lesson: pair every print → logger sweep with a basicConfig audit at every entry point, in the same patch.
23c. **`async function reveal() { return rewindPromise; }` + caller `await reveal()` → Promise auto-unwrap silently waits for the inner promise.** JavaScript Promise resolution chain-unwraps nested Promises: returning a Promise from an `async` function makes the outer Promise resolve with the inner Promise's resolved VALUE, not with the Promise itself. So `await reveal()` blocks until BOTH the outer (reveal's setup) AND the inner (the rewind animation) complete — even though the call site looked like it was only waiting for reveal's setup. Symptom: transcript painted ~10s after subs arrived because `loadFromApi` (which paints) ran AFTER `await reveal()` returned, and that return was actually gated on the entire rewind animation finishing. Fix: wrap the inner Promise in an object/array so resolution doesn't chain-unwrap (`return { rewindPromise }` + caller `({ rewindPromise } = await reveal())`). Detection in practice: invisible from code review (looks correct) — surfaces as a timing bug. Trace-driven probe (per-50ms timeline snapshots correlated with network log) is what pinned it. **General rule:** when an `async` function exposes a long-lived inner Promise for the caller to await SEPARATELY, never return it bare — always wrap.

24. **Boot-bridge trap: `window.X` consolidation breaks if a consumer reads X at module-eval time.** When moving `window.X = X` assignments out of source modules into a single bridge block in `main.js`, the bridge runs AFTER all `import` statements complete. Any IMPORTED module that touches `window.X` at module-load time (top-level code, IIFE bodies that execute on definition, prefill loops in the file body) crashes with `Cannot read properties of undefined`. Phase 2 caught this for `window.RS_ASSETS` (read inside the chat.js IIFE during init) and `window.Sentry` (read inside karaoke modules). Mitigation: any bridge whose value is consumed at module-eval time must STAY inline in its owning core file (boot bridge); only bridges accessed inside post-init function bodies or DOMContentLoaded callbacks can move to `main.js`. Document each boot-bridge exception with a header comment explaining WHY it can't move. Detection in practice: real consumers that touch the bridge during their own IIFE init = fast crash on first page load; lazy consumers = no failure until the function is called. So boot-bridge violations surface immediately in a browser smoke test, while lazy-bridge violations can hide for days. **Addendum (2026-05-09):** `core/sentry.js` is also the right home for dev-only `beforeSend` noise filters (e.g. transient `Failed to fetch` during local Vite) — same module owns init + early `window.Sentry`, so capture policy stays coherent.

## Architectural decisions during refactor

24. **Be explicit about which split is a "real" architectural change vs. pure file moves.** When in doubt, default to pure file moves — they're verifiable byte-for-byte. The one cycle that introduced a real architectural change (the karaoke shared-state hub) was explicitly flagged upfront and approved by the user.
25. **Pragmatic store scope: only SHARED state moves to the store.** State that's used by ONE consumer stays local to that consumer. **Define the store by who CONSUMES the state, not by what state EXISTS.**

## Process

26. **Worktrees were optional, not mandatory.** For solo dev with no in-flight parallel work, the per-cycle branch isolation a worktree gives is overhead. Squash-merge worktree branches OR commit directly on main — pick per cycle.
27. **Scope the prod-soak window to the actual user impact.** Local Chrome testing (desktop + mobile-shrunk windows) + the in-page debug panel cover regression risk without a 3–5 day wait when the blast radius is small. Worst case, `git revert` + redeploy is minutes.
28. **Defer in-cycle DRY opportunities, fix in followup.** Splitting and DRYing in the same commit makes both harder to review. Spot the DRY opportunity, ticket it, ship the split, then DRY in the next commit.

29. **For tab-specific (or panel-specific, mode-specific, route-specific) perf bugs, A/B against a CLEAN single-state baseline.** During the 2026-05-12 karaoke perf pass I drew a confident "Fix #5 took subtitle fps from 13 → 55" conclusion from a perf log that secretly included transcript-tab samples too (user had tab-switched mid-run without me asking how the log was collected). The transcript samples dragged the average way up; my "huge win" was mostly noise on the subtitle path. A follow-up clean subtitle-only run showed Fix #5's actual impact was 13.4 → 13.85 fps_avg — within margin of error. **Rule:** before drawing any conclusion from a perf log on a tab-specific bug, confirm the run was single-tab. If the harness doesn't enforce single-tab (most don't — perf overlays are global), explicitly instruct the tester ("stay on tab X the whole time, do NOT switch") AND verify post-hoc by asking how the run was conducted. Mixed-state averages can confidently lie about whether a fix worked.

30. **Pre-existing bugs surface when their masker is removed.** Fix #1 in the same session removed a continuous mobile lag affecting both tabs equally; once gone, the user could finally see a separate periodic-degradation bug that had always been present on the subtitle tab but was visually drowned by the bigger continuous-lag noise. The right framing here is NOT "your fix broke something else" — it's "the bug you just fixed was hiding a second bug." Surface this honestly to the user instead of doubling down on the fix in question. Same dynamic shows up in audio mixing ("now I can hear the hum I couldn't hear before"), database query plans (one slow join was masking another), and perf optimization generally.

---

## Last updated
2026-05-12 — added lessons 29 (single-state baseline for tab-specific perf bugs) + 30 (pre-existing bugs surface when their masker is removed) from the karaoke perf pass session.
2026-05-09 — added lesson 23b (print → logger silent-drop trap) from Phase 5 closure of the Phase 4e gap.
2026-05-08 — added lesson 24 (boot-bridge trap) from Phase 2 honesty pass.
2026-05-07 — initial migration from `15_REFACTOR_RETROSPECTIVE.md` (deleted as part of doc-honesty pass).
