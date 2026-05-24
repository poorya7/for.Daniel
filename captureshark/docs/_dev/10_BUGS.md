# Open bugs — handoff for next agent

**Last updated:** 2026-05-23 — Bug #2 marked "needs re-triage" (the legacy `CaptureSheet.tsx` it cited was deleted in the no-panel migration; the offline-pill caller now lives on `PhotoSummaryCard`). Bugs #6, #7, #8 added during the May 2026 refactor pass.

**Written 2026-05-18 by Josh (UI polish agent) after a session with the owner.** Three bugs surfaced during a SharkLoader exit-animation polish pass. None are blocking. All three should land before v1.

The session also produced **two uncommitted SharkLoader changes** sitting in the working tree (described in bug #1) — fold those into the test of bug #1, and either commit or revert with the owner before touching anything else.

---

## Bug #1 — Ripple drain tail might feel too long after the 6s slowdown

**Status:** pending visual validation by the owner. Code change is in the working tree, not committed.

**Background.** The SharkLoader runs water (expanding ripples) + a periodic shark visit. When the data finishes streaming, the parent flips the loader's `phase` prop to `"exit"`; the shark sinks, emission stops, and in-flight ripples die naturally on their own animation lifetime. That natural-death pattern is locked — the owner loves it and rejected every alternative.

**What the owner reported this session.** Two related complaints, in order:
1. Even with the existing exit logic, occasionally 1–2 fresh ripples spawn AFTER the shark starts sinking. They die together at the end of their own lifetime, dragging the total exit duration out by 3+ seconds while the user is waiting on data that's already arrived.
2. When the owner had asked a previous agent to slow the ripple speed from ~3.4s lifetime to ~6s, the straggler problem became dramatically worse (visible new ripples after the shark sank). That earlier slowdown was reverted in commit `927ed75`.

**Root cause found.** The emission gate was a React `useState` flag. `setEmitting(false)` is async — there was a real window between "we asked to stop emitting" and "the `setInterval` actually stops firing." Two parts to that window:
- React's state update is batched/scheduled; a queued ticker callback can fire before the effect cleanup runs.
- `runExit` (which called `setEmitting(false)`) was called from an async polling loop that lags up to ~80ms behind the phase prop changing.

A straggler ripple at 3.4s lifetime extends the drain by 3.4s. At 6s lifetime, by 6s. That's why doubling the speed amplified the perceived bug.

**What landed in the working tree today (not yet committed).**

1. **Race fix in `frontend/src/components/SharkLoader/SharkLoader.tsx`.** Three edits:
   - Added a synchronous emission-ref check inside the `setInterval` callback — any tick that fires after the ref is flipped no-ops instead of spawning a ripple.
   - In `runExit`, flip `emittingRef.current = false` synchronously BEFORE calling `setEmitting(false)`.
   - In the phase-change `useEffect` (the one that runs the moment the parent commits `phase="exit"`), synchronously: flip the emission ref AND `clearInterval` directly via a new `emissionIntervalIdRef`. This closes the ~80ms polling-lag window.

2. **Ripple slowdown.**
   - `EMISSION_INTERVAL_MS`: 1100 → 1900 ms
   - `RIPPLE_LIFETIME_SECONDS`: 3.4 → 6.0 seconds
   - CSS animations on `.shark-loader__ripple--steady`: 3.4s → 6s in `frontend/src/components/SharkLoader/SharkLoader.css`
   - Ratio preserved so ~3 ripples stay alive on screen at any moment.

**What the owner needs to validate next session.** Open `https://dev.captureshark.com` on a phone, do 3-5 text captures, and watch the exit:
- Are stragglers fully gone? (The race fix should have eliminated them. Owner saw 1 slip through after the first fix iteration; the second iteration moved the gate flip to the phase-change effect.)
- After the shark fully sinks, does the gap until the water is completely gone read as a calm fade or as a dead beat? Up to ~6 seconds is the theoretical maximum — the legitimate drain time of the oldest in-flight ripple.

**Parked option if the drain reads as dead.** Short-circuit the LAST in-flight ripple's fade on exit: keep every other ripple's natural lifetime, but when only one is left, accelerate its remaining fade so the surface clears in ~1-1.5s instead of waiting the full lifetime. Implementation sketch:
- `onLastRippleDraining` already fires when count drops to 1 with emission stopped (signal exists). Use it to add a CSS class to the surviving ripple that overrides its `animation-duration` with a shorter tail.
- Owner's exact words: *"we might fade the last one out earlier. That's fine. Let's slow it down and see what it looks like first."* So this is a contingent fix — only land if the natural drain doesn't feel right.

**Decision rule for the next agent:** test bug #1 BEFORE the user touches anything else. The uncommitted changes block clean commits for any other bug. Either path-scope commit the SharkLoader files (with owner's git permission), or revert.

### Update — 2026-05-20 session

The slow-water tuning (1.9s emission, 6s lifetime) landed in commit `f60b054` along with the synchronous emission gate. The stragglers (case 1 above) are gone. What remains:

1. **The youngest 1–2 ripples that WERE emitted just before exit are still in their early-grow phase when the fin sinks** — they keep growing visibly during the sink window, so the user reads them as "new ripples appearing during the sink." Not actually new; just immature.
2. **The inner-ripple accelerated fade (`accelerateLastRippleFade`) catches a young survivor and force-fades it to opacity 0 while it's still mid-grow** — the ripple visibly "disappears in the middle of its motion" instead of finishing its arc.

**Attempted fix this session — reverted.** Added a `killInfantRipples` function that fast-fades (~220ms) any ripple under a maturity threshold the moment phase commits to `exit`. Idea: prune the visible "infants" before the fin sink starts so only mature ripples remain to drain naturally. Two problems surfaced:

- With threshold 0.6 (kill anything < 60% mature), AND `accelerateLastRippleFade` ALSO running afterward: the kill removed 2 of 3 ripples, then the accelerator caught the lone mature survivor and fast-faded that one too. Surface went silent in <300ms — owner described it as "all ripples disappear immediately."
- Added a guard (`infantsKilledOnExitRef`) so the accelerator skips when the kill step has already pruned. Owner still saw all ripples disappear — likely because the kill threshold was still too aggressive (only 1 mature survivor left, and natural death of that single one was visually fast).

**Reverted.** All `killInfantRipples` work removed from SharkLoader.tsx. Loader is back to the pre-attempt state with the regression still visible.

**Next attempt direction (for whoever picks this up):** lower the kill threshold to ~0.35 (kill only ripples <35% mature, which is the visibly-infant set), AND keep the `infantsKilledOnExitRef` guard so the accelerator doesn't double-fade. That should leave 2+ mature ripples to drain naturally, no force-fade, no abrupt cut-off. Test on `/extracting-shell` or `/extracting-panel-light` standalone, NOT in the live flow.

**Parked, not blocking.** The regression is a polish-pass quality issue, not a functional break. (Cream-theme migration shipped end of May 2026; this is left over from that work.)

---

## Bug #2 — "Offline" pill shows on a real-online user when the previous extract attempt errored

**Status:** needs re-triage on the cream canvas (2026-05-23). The original sighting was on the legacy `CaptureSheet/CaptureSheet.tsx:554` line — that whole component was deleted during the no-panel migration. The "offline pill" UI now lives on `frontend/src/features/review/PhotoSummaryCard.tsx` (the only remaining caller of the `.capture-offline-pill` class). Before designing the fix, confirm whether the same `isOffline || !!error` conflation still exists in the canvas flow.

**Original sighting (legacy code, kept for context).**

```
const showOfflinePill = isOffline || !!error;
```

Plus the JSX a few lines down that renders the wifi-slash glyph + literal text `Offline`.

**Behaviour.** The pill is wired to fire on EITHER actual offline state (`isOffline`, driven by the periodic `/api/v1/health` probe in `frontend/src/lib/queue/onlineDetection.ts`) OR a previous extract attempt errored (`error` prop set). Both states use the same `Offline` label + wifi-slash icon. The code comment at line 552 justifies the conflation: *"the user's recovery is the same (wait + retry), and 'Offline' is friendlier than 'Couldn't reach the app' for a 75-year-old broker."*

**Why it's wrong.** A real-online user who just had a transient network hiccup, a failed-fetch, or a backend 500 sees the wifi-slash + "Offline" and reads it as "the servers are down." The owner literally asked *"are the servers down?"* this session — checked the backend, both `localhost:8002` and the public tunnel returned `200 OK` in < 200 ms. The pill lied.

**Two cheap fix options (no preference set yet — owner picks):**
- **Option A — two labels.** Keep the pill, branch the label: `Offline` for truly offline, something like `Tap to retry` or `Last try failed` for the error case. Drop the wifi-slash icon when in the error case (it's the lie). Same pill chrome, different copy + icon.
- **Option B — drop the pill on error, surface the error inline.** When `error` is set and `isOffline` is false, show a one-line inline notice under the textarea like `Last try didn't go through — tap Extract again` instead of badging it as an offline indicator. Pill stays reserved for the actual offline state.

**Owner's stated preference style.** Linda persona — non-technical, calm. Never red-banner panic, never jargon. Either option above fits. Recommend Option B; the wifi-slash glyph carries the offline semantic so strongly that any text override fights the icon.

---

## Bug #3 — `OperationalError: no such table: idempotency_keys` (immediate crash gone; underlying fragility remains)

**Status:** the immediate crash is GONE — the migration has been applied to the local SQLite DB (confirmed `alembic_version = c9d2f1e84b3a`, the latest). But the root-cause fragility remains.

**What happened today.** Backend log at `backend/logs/captureshark.log` shows an ERROR at `2026-05-18T04:41:05Z` from `captureshark.api.routes.sheets`: a photo save crashed because the `idempotency_keys` table didn't exist. The migration `backend/migrations/versions/20260518_0001_add_idempotency_keys_table.py` was authored in commit `ba0147c` ("Save path fix: idempotency_keys table + persistent log file") but the local DB was behind the code — whoever pulled the new code forgot to run `alembic upgrade head` before exercising a sheets save.

**Why this happens.** The backend has no auto-migration on startup. The lifespan hook in `backend/src/captureshark/main.py` (or wherever the FastAPI startup is wired) does not run `alembic upgrade head`. So every time a new migration lands in code and someone restarts uvicorn against an un-migrated DB, the next request that touches the new table 500s.

**Recommended fix (needs owner sign-off — backend code change).** Add an `alembic upgrade head` call to the backend's lifespan startup hook. Standard pattern — Alembic exposes `Config` + `command.upgrade(config, "head")` for in-process invocation. SQLite-safe. Skips when already at head (no-op). Permanently prevents this class of "I forgot to migrate" crash.

**Why this brushes the photo agent's territory.** The crash trace is from `backend/src/captureshark/api/routes/sheets.py` (shared backend code, not Alex's exclusive paths) but the offending migration was added in commit `ba0147c` which looks like it came in alongside photo capture work. Confirm with Alex before touching `main.py`'s lifespan — the auto-migration hook isn't exclusive to either of us but it touches startup behaviour that's effectively shared infrastructure.

**Files that matter:**
- `backend/src/captureshark/adapters/sqlite_idempotency_store.py` — caller that hit the error.
- `backend/src/captureshark/adapters/idempotency_orm.py` — table definition.
- `backend/migrations/versions/20260518_0001_add_idempotency_keys_table.py` — the migration itself.
- `backend/src/captureshark/main.py` (or wherever the lifespan hook lives) — where the auto-upgrade call would land.
- `backend/alembic.ini` + `backend/migrations/env.py` — Alembic config.

---

## Bug #4 — Pre-commit hook splits commands at `;` inside quoted strings, falsely blocking commits

**Status:** open, no code changed. Workaround documented.

**Where it lives.** `.githooks/check-git-command.py`, lines 51-55. The regex on line 52 is:

```python
tail = re.split(r"(?:\|\||&&|;|\|)\s", tail, maxsplit=1)[0]
```

This splits the command tail at the next pipeline separator (`||`, `&&`, `;`, `|`) followed by whitespace, then only inspects the first piece for the path-scope (` -- <paths>`) requirement.

**Why it's wrong.** The split doesn't account for quoted strings. If a `git commit -m "..."` message body contains a `;` followed by a space (perfectly normal English punctuation), the hook splits the command at that semicolon — chopping off the actual `-- <paths>` argument list that lives after the closing quote. The hook then claims the commit is "bare" and refuses it.

**Reproduce:** any one-line commit message with a semicolon, e.g.

```
git commit -m "Fix X; this is the why" -- path/to/file
```

…falsely fails the path-scope check.

**Workaround in use today.** Drop the `;` from commit messages. Use periods or em-dashes instead. Painful but functional.

**Recommended fix.** Either:
- (a) Strip quoted regions from the command string before running the pipeline-split regex (a 6-line state-machine that tracks `"..."` and `'...'` boundaries).
- (b) Tighten the pipeline-split regex to exclude content inside quotes (harder to get right in pure regex).
- (c) Use `shlex.split(command)` to tokenize first, then check the resulting argv list for `git commit` + `--` token presence. Cleanest but changes the hook's structure.

Recommend (c) — `shlex` already handles quoted strings correctly and the resulting check (`"--" in args`) is one line.

**Why it's surfaced here.** Hit this during the Item 5 build-hygiene commit on 2026-05-23 — first commit attempt with a `;` got falsely blocked, second attempt with `;` replaced by `.` went through. Low-priority, but every future agent will hit it.

---

## Bug #5 — Picker fields (intent / timeline / financing) lose the AI-extracted value's display label, and Linda's sheet ends up with mixed vocabularies

**Status:** open. Architectural fix needed. M-size. Surfaced by the owner during the 2026-05-23 refactor session.

**Where it lives.**
- Backend canonical tokens: `backend/src/captureshark/domain/extraction.py` lines 86-88 (`INTENT_VALUES`, `TIMELINE_VALUES`, `FINANCING_STATUS_VALUES`). These are locked into the OpenAI strict-schema validator — the AI literally cannot return anything else.
- Frontend display labels: `frontend/src/features/review/LeadReviewCard.tsx` lines 114-131 — inline string lists in the `FIELD_EDITORS` constant. Not factored into any domain module.

**Why it's wrong.** The two vocabularies don't match and no translation layer connects them:

| Field | Backend token | Frontend pill label |
|---|---|---|
| intent | `buyer` / `seller` / `both` / `browsing` | `Buyer` / `Seller` / `Both` / `Browsing` |
| timeline | `now` / `3mo` / `6mo` / `12mo+` | `ASAP` / `1-3 months` / `3-6 months` / `6-12 months` / `Not sure` |
| financing_status | `cash` / `pre_approved` / `needs_lender` / `unknown` | `Cash` / `Pre-approved` / `Not yet` / `Not sure` |

Today's behaviour:
1. AI extracts `intent: "browsing"` → review card shows raw `browsing` instead of highlighting the `Browsing` pill.
2. User opens picker, taps `Browsing` → field value becomes `Browsing` (TitleCase) — completely off-schema from the backend token.
3. Linda's sheet ends up with a mix: `browsing` from AI-extracted leads, `Browsing` from user-picked leads. Same logical value, two visual forms, no consistency for anything downstream that filters/sorts by intent.
4. Timeline + financing are worse — backend `3mo` has no relationship at all to frontend `1-3 months`, so the AI's extraction silently becomes unrecognisable in the UI.

**Reproduce:** voice-capture "browsing" or "I'm just browsing" → review card. The intent field shows raw `browsing`, no pill highlighted. Save → sheet column shows `browsing`. Now do another capture, pick `Browsing` manually → sheet column shows `Browsing`. Two visual forms of the same logical value in the same column.

**Recommended fix (Apple-grade, M-size).**

One canonical translation table on the frontend, used everywhere a picker shows up. Architecture:

1. **New module** — `frontend/src/features/review/pickerOptions.ts`. One typed list per field, each entry shaped `{ token: "buyer", label: "Buyer" }`. The token column mirrors the backend's locked constants 1:1; the label column owns the display vocabulary.
2. **Review card** reads from it. No more inline string lists in `LeadReviewCard.tsx`. Field value internally is always the canonical token; UI does token → label lookup for display + pill highlight.
3. **Save path** (`leadToSavePayload` in `frontend/src/features/review/Lead.ts`) translates token → pretty label for picker fields before sending. Backend stays in token-land for its strict-schema extraction; the wire to the sheet writer is always pretty labels (consistent with today's user-pick behaviour).
4. **Type future-proofing.** The hand-maintained token list survives until the OpenAPI type generation lands (tech plan §11). Design the module so swapping to generated tokens is a one-import-line change.

**UX side effect (needs owner sign-off before implementation starts).** Linda's sheet for AI-extracted picker fields will switch from raw tokens (`pre_approved`, `3mo`) to pretty labels (`Pre-approved`, `1-3 months`). That's the same shape user-picked leads already produce today — the fix just makes both paths consistent. Owner already flagged the bug; the proposed fix shape is in the chat transcript. Parked here because mid-refactor session was the wrong moment for an M-size side quest.

**Why not just a quick cosmetic patch?** Considered and rejected. Inline string lists with mismatched vocabularies is the hacky version of this; doing it again somewhere else (e.g. mapping in `App.canvas.tsx`'s onCommit handler) just moves the inconsistency. The clean fix is the dedicated module — anything less ships the same bug shape next time we add a picker.

**Files that matter:**
- `frontend/src/features/review/LeadReviewCard.tsx` lines 114-131 (`FIELD_EDITORS`).
- `frontend/src/features/review/Lead.ts` (`leadToSavePayload`).
- `backend/src/captureshark/domain/extraction.py` lines 86-88 (source of canonical tokens — frontend mirrors these).
- New file: `frontend/src/features/review/pickerOptions.ts`.

---

## Bug #6 — Offline raw-photo flow auto-saves to sheet without user review

**Status:** open. UX redesign needed. M-L size. Surfaced by the owner during 2026-05-23 session-4 mobile testing.

**Where it lives.**
- Hook: `frontend/src/features/photo-capture/usePhotoCaptureSession.ts` — the `enqueueRawPhotoAsOfflineSave` function inside `handlePhotoCaptured`, plus the watchdog + network-error branches.
- Drainer: `frontend/src/lib/queue/drainer.ts` — the `_attemptPhotoExtractThenFanOut` path that runs when signal returns.

**Behaviour today.** When the user snaps a photo while completely offline (or signal drops mid-extraction), Item 1b drops the raw photo into the safety net and plays a "Saved — offline, we'll add the leads when signal returns" cascade. When signal returns, the drainer reads the photo via the AI in the background and writes each extracted row STRAIGHT to the user's sheet. The user never sees the rows, never edits them, never confirms.

**Why it's wrong.** Multiple violations of the locked principles:
1. **"Saved" cascade is dishonest** — the user didn't tap Save, the photo is just being held. The locked principle (Item 1a rule) says cascades only play after a deliberate Save action; here it plays as soon as the photo is captured.
2. **No review surface for offline-extracted rows.** Online photo flow always shows the multi-row review surface before saving. Offline flow skips it entirely, breaking the "messy in → clean out" promise — a sign-in sheet with 8 unclear entries dumps all 8 into the sheet unchecked.
3. **No home-screen indicator** that a photo is queued. Per the principles ("above the fold — no hunting"), the user should be able to see something is pending on home without digging.

**Recommended shape (Apple-grade, M-L size).**

Three coordinated changes:

1. **Capture-time copy + screen.** Instead of the "Saved" cascade, route offline raw-photo captures to a different screen — "Photo held — we'll read it when you're back online." Honest. No fake save confirmation.
2. **Review-on-return.** When the drainer extracts an offline-held photo, do NOT auto-write rows to the sheet. Surface a pill on the home screen — "8 leads ready to review" — that opens the same multi-row review surface the online photo flow uses. User taps Save All like a normal photo capture.
3. **Home-screen pill, two visible states.**
   - "1 photo waiting for signal" (offline-held, not yet extracted).
   - "N leads ready to review" (extracted, awaiting user review + Save All).
   - Multi-photo handling: "3 photos · 24 leads ready".

**Why this shape.** Matches the "no surprise" ASMR principle — the app never auto-flows or interrupts mid-task. If the user is mid-typing a new lead when signal returns and extraction completes, their typing isn't interrupted; the pill just appears on home for next time. Also keeps online + offline review flows architecturally consistent (same review surface, same Save All button).

**Edge cases to think through during implementation.**
- AI extraction fails on signal return (image unreadable, AI errors) → pill shows "1 photo couldn't be read — tap to retry".
- User offline-captures multiple photos → drainer extracts them sequentially; pill aggregates the count.
- User closes the app between offline-capture and signal-return → photo stays in the queue, pill appears next time the app opens.

**Files that matter:**
- `frontend/src/features/photo-capture/usePhotoCaptureSession.ts` — `handlePhotoCaptured` + `enqueueRawPhotoAsOfflineSave`.
- `frontend/src/lib/queue/drainer.ts` — `_attemptPhotoExtractThenFanOut`.
- `frontend/src/App.canvas.tsx` — home screen JSX where the pill would land.

---

## Bug #7 — Empty voice recording calls the LLM, and extracting screen has no Cancel

**Status:** open. M-size combined fix. Surfaced by the owner during 2026-05-23 Phase 11 verification.

**Reproduce.**
1. Open the app, tap Voice.
2. Don't say anything (or tap Stop immediately without speaking).
3. Tap Extract.
4. App goes to the extracting screen with the fin and stays there forever — no way back without restarting the browser tab.

**Two distinct problems compounded.**

1. **Silent / empty voice captures still call the LLM.** No pre-flight check on the captured blob — if the user records nothing (or hits Stop before saying anything), the audio still goes to the AI extraction endpoint. Wastes a real API call, AND the AI's behaviour on silent audio is undefined (often hangs because there's nothing to extract).
2. **No Cancel / back action on the extracting screen.** If the in-flight extraction hangs OR errors silently OR just takes too long, the user is stranded. Same problem applies to text extraction — a backend slow-loris would trap the user too.

**Why it's wrong.** Enterprise app + Linda persona requirements:
- Wasted LLM calls are sloppy (cost + carbon + bad signal-to-noise for telemetry).
- A user-visible dead-end is the kind of thing Linda would interpret as "the app is broken" and never reopen. The locked principle "fast-first UX" says acknowledge instantly and never freeze without an escape.

**Recommended fix shape (Apple-grade, M-size, ~2 hours).**

Two coordinated changes:

1. **Pre-flight check on voice captures.** Inside `CanvasVoice` (or in the orchestrator's `handleVoiceCaptured` before dispatching StartExtractVoice), detect "no sound" — either:
   - Audio blob duration shorter than a minimum threshold (e.g. 500ms), OR
   - Audio waveform energy below a silence threshold (a tiny WebAudio analyser pass on the captured PCM).
   The latter is more honest (catches "user held the mic but didn't say anything" cases), but the duration check alone solves the immediate dead-end. Start with duration; promote to energy-based if real users still hit it.
   - On detection: surface a calm inline "Didn't hear anything — try again?" on the voice screen, dispatch nothing to the state machine, do NOT call the LLM.

2. **Cancel back-action on the extracting screen.** Add a small Cancel link (or a back-gesture handle) on the loading screen that:
   - Calls `AbortController.abort()` on the in-flight `streamTextCapture` / `streamVoiceCapture`.
   - Dispatches a new `CancelExtraction` action to the state machine.
   - The reducer's `CancelExtraction` case: if loading-from-text, bounce to text-input with text preserved; if loading-from-voice, bounce to voice screen. (Same shape as ExtractionFailed but no error copy — quiet cancel, not failure.)

**Files that matter:**
- `frontend/src/components/CanvasVoice/CanvasVoice.tsx` — where the captured blob is handed up; the duration check fits naturally before that handoff.
- `frontend/src/lib/api.ts` — `streamTextCapture` / `streamVoiceCapture` need an AbortSignal param so the orchestrator can cancel them.
- `frontend/src/App.canvas.tsx` — Cancel UI on the loading screen + AbortController wiring.
- `frontend/src/features/app-state/appState.ts` — new `CancelExtraction` action + reducer case + tests.

**Why two coordinated changes, not one.** The pre-flight check solves the immediate "empty voice trap" but the Cancel back-action is the broader safety net — a slow / hung backend would strand any extraction (text or voice) the same way. Ship them together so the user is never stuck on the extracting screen.

---

## Bug #8 — Confidence display collapses three levels into two

**Status:** open. Pre-launch UX gap. Surfaced 2026-05-23 during the May 2026 refactor's "smaller smells" pass.

**Where it lives.** `frontend/src/features/review/LeadReviewCard.tsx` — the per-field confidence indicator. Currently renders one of two visual states (`fine` and `check this`); the underlying data has three (`high`, `medium`, `low`).

**Behaviour today.** The AI's extraction returns one of three confidence levels per field. The review card paints "fine" for `high` and "check this" for both `medium` and `low`, collapsing the latter two into one visual state.

**Why it's wrong.** "We genuinely don't know" deserves its own treatment. For Linda, an AI that hedges (`medium` — "could be Maria, could be Marina") is very different from an AI that's stumped (`low` — "couldn't read this row"). Flattening them removes signal she'd act on — she'd verify a hedge differently than she'd retype a stumped read.

**Recommended fix shape.** Add a third visual treatment for `low` — something visually distinct from `check this` (which stays on `medium`). Plain-English copy options to pick from at design time:
- `medium` → "Check this" (keep)
- `low` → "Couldn't read" or "Type this in"

The exact copy is owner-call; the architectural fix is "three states, three visuals, one is unmistakably 'we don't know.'"

**Why before launch.** Item 4 of the locked principles (`docs/_workflow/02_PRINCIPLES.md`) says "Confidence shown as plain words, not colored dots." The 3→2 collapse violates that — it's hiding signal Linda is supposed to act on. Tagged pre-launch because demo-realistic scope doesn't mean shipping with known UX gaps the persona would notice.

**Files that matter:**
- `frontend/src/features/review/LeadReviewCard.tsx` — the per-field confidence rendering.
- `frontend/src/features/review/Lead.ts` — the `Confidence` type (already carries `high | medium | low`, no data-layer change needed).

---

## How to use this doc

The next agent should:
1. Read this top-to-bottom before touching the working tree.
2. Resolve bug #1 first (validate visually + commit or revert the SharkLoader changes).
3. Pick a fix direction with the owner for bug #2 and ship.
4. Get owner approval to add the auto-migration hook for bug #3.
5. Bug #5 is M-size — coordinate with the owner before opening that work; the proposed architecture is in the bug entry.
6. Bug #6 is M-L — the offline raw-photo UX redesign needs its own slice. Owner-aligned on the shape but no design doc yet.
7. Bug #7 is M-size — empty voice + extracting-screen cancel are a combined fix; owner-aligned on the shape.
8. Bug #8 is S — confidence-display 3→2 gap. Pre-launch fix. Owner picks the exact `low` copy.

Owner is on phone for visual testing. Test links go at the END of "ready to test" messages. Path-scoped commits only. No bundled commits across these bugs.
