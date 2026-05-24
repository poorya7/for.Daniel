# Agent pitfalls — things that have actually bitten an agent here

**Last updated:** 2026-05-23 — removed 7 dead items about `CaptureSheet` / `EditMorphCell` / `EditTitleMorph` (deleted in the no-panel migration). Items renumbered: total went from 32 to 26.

A short, blunt list of mistakes that have already cost time on this
codebase. Future agents: read this BEFORE making changes to the
photo / voice / live-captions code paths. None of these are obvious
from reading the code in isolation; they all came from real debug
sessions where the agent shipped a broken "fix" and the project owner
had to call it out.

This is **not** an architecture doc — `docs/_spec/` covers that.
This file is "what to watch out for so we don't waste the user's
time".

> **History note (2026-05-23):** items 1, 2, 4, 5, 6, 7, 11 in earlier
> versions of this file were about `EditMorphCell.tsx`,
> `EditTitleMorph.tsx`, and `.capture-sheet:has()` — all part of the
> legacy `CaptureSheet/` surface that was deleted during the no-panel
> cream-canvas migration (commit `f650320`, "Step 9 + docs reorg"). They
> were removed in this cleanup pass. The remaining items have been
> renumbered to close the gaps. If you're reading an older agent's
> reference to "pitfall #N", check the topic — the numbering shifted.

---

## 1. Type-check passing ≠ feature working

**Symptom:** You make a CSS / layout / morph change, run
`pnpm exec tsc --noEmit`, see green, report "fixed". The user opens
the page and nothing changed.

**Root cause:** TypeScript verifies the code compiles. It does not
verify the browser renders 60px when you said 60px. CSS specificity
battles, conditional inline styles that don't reach the DOM, Framer
Motion ignoring an `animate` target, `:has()` rules getting beaten
by source-order — none of these break the type check.

**What to do (in order):**
1. After any layout / sizing / positioning change, use Chrome MCP
   (`mcp__Claude_in_Chrome__javascript_tool`) to measure the actual
   rendered values. Read `getBoundingClientRect()` widths/heights,
   `getComputedStyle()` for the property you intended to change,
   and `el.style.<prop>` to confirm any inline style you set
   actually reached the DOM.
2. Verify the value matches what you designed. If it doesn't, the
   bug is in your code — diagnose before claiming fixed.
3. For "feel" judgements (animations, smoothness, alignment) hand
   the link to the user instead — Chrome MCP screenshots compress
   visual detail and you'll miss what a human sees in a real browser.

---

## 2. Don't blame the user's cache when something looks unchanged

**Symptom:** User reports a fix didn't work. Your first reaction is
"hard-reload your tab, it's probably cached." User wastes time
hard-reloading, opens private mode, etc. — same result.

**Root cause:** This stack doesn't have a meaningful cache layer
between your editor and the user's browser:
- The dev backend runs uvicorn + Vite locally on the laptop.
- `dev.captureshark.com` is a Cloudflare **tunnel** to that local
  Vite — no edge cache, no CDN.
- Vite HMR pushes changes to open tabs within ~200ms.

So if the user is on `dev.captureshark.com`, they're hitting your
laptop's live Vite. The bug is almost certainly in your code, not
in their cache.

**What to do:**
1. Verify the file is actually being served fresh. One quick check:
   `Invoke-WebRequest -Uri "https://dev.captureshark.com/src/<path>"`
   and grep the response for the new symbol/value you added. If it's
   there, the user has the new code.
2. Then debug your own code (Chrome MCP, see #2). Don't ask the user
   to hard-reload as a first step — it's a cop-out.

---

## 3. Don't fix the sub-problem you reasoned about — fix the visible defect

**Symptom:** User reports "the text overflows the pills." You think
about it, decide the cause is "uneven column widths," switch flex →
grid, ship. User says "still overflows." Repeat with another
hypothesis. The user gets understandably angry.

**Root cause:** You debugged a *related* sub-problem, not the one the
user actually saw. Real example from this codebase: the pills had
two issues — uneven column widths (caused by `flex 1 1 0` letting
min-content from longer labels push some columns wider) AND text
overflowing the pill border (the pill is too narrow for the text).
Switching to CSS Grid fixed the FIRST issue. It did nothing for the
second — and removing `text-overflow: ellipsis` at the same time
made the overflow worse (text now visibly bleeds outside the pill
instead of being truncated).

**What to do:**
1. Before coding, restate the user's exact visible defect in one
   sentence. "The word 'Unknown' renders past the right edge of its
   pill." Not: "the picker layout is broken."
2. Sanity-check your hypothesis against the visible defect. "Will
   making columns equal-width make 'Unknown' fit inside its pill?"
   If the answer is no, your hypothesis is wrong.
3. Measure the actual numbers. "Pill width is 74px. 'Unknown' at
   15px Inter is ~62px text + 20px padding = 82px." Now you know
   the pill needs to be ≥82px or the text needs to be smaller.
4. Fix THAT, not a parallel issue you can articulate more easily.

---

## 4. The "is this actually fixed?" checklist — run it before saying "done"

After any change that affects what the user sees, run through these
in order. If you skip any, do not say "fixed":

1. **The source change is on disk.** `Read` the file, scan for the
   exact symbol/string you added.
2. **The dev server is serving the new code.**
   `Invoke-WebRequest` the served file URL (e.g.
   `https://dev.captureshark.com/src/components/PhotoCapture/PhotoCapture.tsx`)
   and grep the response for your new symbol. If missing, vite's
   HMR is dead — restart it.
3. **The DOM has what you expect.** Chrome MCP →
   `querySelector` for the element, dump its `dataset`, attributes,
   and structure. Confirm it matches what your JSX renders.
4. **The computed style matches intent.** `getComputedStyle(el)` on
   the property you intended to change. Did the actual rendered
   value land where you said? If not, find the rule that's
   beating yours (specificity battle, source order, inline-style
   miss, etc.).
5. **The bounding rect makes sense.** `getBoundingClientRect()` for
   sizes and positions. Math out what they should be from your
   constants; compare to what you got.
6. **The defect the user reported is actually gone.** Re-read their
   message. Look at the new state through their lens. If you can
   only verify "a related thing is now better," you haven't fixed
   the bug they reported.

This is ~3 minutes of MCP work and saves 30+ minutes of "still
broken" round trips.

---

## 5. Don't measure during an in-flight animation

**Symptom:** You read `getComputedStyle(cell).transform` and see
`matrix(0.68, 0, 0, 0.75, ...)` instead of identity. You panic that
"Framer Motion isn't animating." You spend an hour chasing a
phantom bug.

**Root cause:** You measured while the morph was mid-flight. The
cell IS animating from rest scale (0.68) to identity (1.0) — your
read landed at frame 200ms of a 550ms animation.

**What to do:**
1. Always wait at least `animationDuration + 100ms` before
   measuring final state. For the cell morph that's `550 + 100 = 650ms`
   minimum after the trigger.
2. Better: poll `el.getAnimations()` and wait until the array is
   empty (= no in-flight animations on that element).
3. Better still: if you genuinely need the rest-state value,
   programmatically suppress motion via
   `prefers-reduced-motion: reduce` (e.g. with the Chrome MCP
   evaluator: `matchMedia` overrides) so animations skip and you
   read the steady state immediately.

---

## 6. Pointer-events transitions during animation can cause click-through

**Symptom:** User taps "outside" a modal/picker to dismiss. Modal
closes — and the user gets dumped to a page they didn't tap on
(home, a different screen, an unrelated button).

**Root cause:** Your dismiss handler fires on `mousedown` (or
`touchstart`), flips state, the dismissable element starts its
exit animation. During that animation the dismiss element's
`pointer-events` transitions from `auto` to `none`. Then the
trailing `mouseup` → `click` event fires AFTER pointer-events flipped
off. The click no longer hits your dismiss element — it hits whatever
is BELOW in z-order. If that's a "Discard" / "Delete" / "Sign out"
button, congratulations, the user just unintentionally invoked it.

**What to do:**
1. Backdrop / dismiss layers should keep `pointer-events: auto`
   for their **entire mounted lifetime**, including the exit
   animation. Only transition opacity, never pointer-events.
2. Alternatively, listen for the `click` event (not `mousedown`)
   for dismiss — by the time click fires, mousedown has already
   completed and the user can't see the difference.
3. Consider `event.stopPropagation()` on the dismiss handler as a
   defensive belt — but the real fix is keeping pointer-events
   active.

This was originally observed on the legacy `EditMorphCell.tsx`
picker backdrop in 2026-05-15. The component was deleted with the
no-panel migration, but the lesson holds for any dismissable
backdrop you write going forward.

---

## 7. CSS Grid implicit rows + `height: 100%` on items = collapse

**Symptom:** You set up a grid container with `height: 100%` and put
items inside with `height: 100%`. Items render at intrinsic content
size instead of filling the container. Layout looks "collapsed."

**Root cause:** Without explicit `grid-template-rows`, the grid
creates implicit rows sized via `grid-auto-rows` (default `auto`).
An auto row sizes to its content. An item with `height: 100%`
resolves to 100% of its grid cell = 100% of the row = 100% of its
own content height — circular, browsers resolve to `auto` =
content height. Result: items at content size, not container size.

**Caveat:** Sometimes `align-content: normal` on a grid container
with one auto row stretches that row to the container's height
(spec says "normal behaves as stretch" for grid). So in that case
items get the container's full height. Browser-version dependent —
don't rely on it.

**What to do:** be explicit. If you want one row filling the
container:
```css
.container {
  display: grid;
  grid-template-columns: repeat(N, 1fr);
  grid-template-rows: 1fr;        /* ← this */
  height: 100%;
  align-items: stretch;
}
```
Then items with `height: 100%` work the way you'd expect.

---

## 8. Mobile Safari quirks that bite this codebase

The persona target (Linda, old Android — but most testing
happens on iOS first) means iOS Safari quirks bite us regularly.
Things to know:

- **`:has()` shipped in iOS Safari 15.4 (2022).** Anyone on iOS 15.0–15.3
  silently won't get `:has()` rules. Project minimum is iOS 16
  per the perf principles, so we use `:has()` freely — but be
  aware if a user reports a bug only on a specific device.
- **`100vh` vs `100svh` on iOS Safari** — `vh` includes the URL
  bar's tallest state, causing layout overflow when the bar
  collapses. Always use `svh` / `dvh` / `lvh` for viewport-relative
  layout. The sheet's rest-height variable does this already.
- **iOS Safari ignores `inputMode` on `<textarea>`** — phone fields
  must use `<input type="tel">`, not a textarea with
  `inputMode="tel"`, to get the numeric keypad.
- **`autoCorrect="off"` is per-input**, but iOS sometimes ignores
  it for fields it heuristically classifies as "free text." We use
  `spellCheck={false}` + `autoCorrect="off"` + `autoCapitalize` set
  appropriately to fight this.
- **`overflow-y: auto` inside scroll-snap container** can fight the
  snap on iOS Safari mid-flick. Be careful when nesting scrolls.
- **`event.preventDefault()` on `touchstart`** can suppress the
  follow-up `click` event entirely on iOS — useful for chip
  buttons that mustn't blur the input, but breaks click handlers
  if used carelessly.

---

## 9. The reduced-motion branch is easy to forget — and easy to break

**Symptom:** Your animation/morph change works for 95% of users but
the 5% with `prefers-reduced-motion: reduce` see a broken /
unstyled / mis-positioned variant. You probably never noticed
because your dev environment doesn't have reduced motion on.

**Root cause:** Morph components sometimes have a
`useReducedMotion()` early-return branch with a simpler render.
That branch tends to drift over time because most edits land on the
full-motion path. The legacy `EditMorphCell` was the worst offender
(now deleted); the pattern can re-appear anywhere a component branches
on `useReducedMotion()`.

**What to do:**
1. When changing a morph component, search for `useReducedMotion`
   or `shouldReduceMotion` in the file. If present, plan to update
   BOTH branches.
2. Test the reduced-motion path explicitly: in DevTools, toggle
   "Emulate prefers-reduced-motion: reduce" and re-run the flow.
   In Chrome MCP, you can override via `matchMedia` in an
   evaluator.
3. If a feature only makes sense on the full-motion path, decide
   if reduced-motion needs a degraded version or can skip the
   feature entirely. Document the choice in code.

---

## 10. `replace_all` only replaces EXACT matches — Grep first

**Symptom:** You use `Edit` with `replace_all: true` to update
"every instance of this button across the file." Some instances
get updated, others don't. You assume the matcher is broken.

**Root cause:** The matcher requires `old_string` to appear
**character-for-character identical** at every match site. Two JSX
blocks that look "the same" can differ by:
- A nearby comment (one block has it, the other doesn't)
- A trailing comma in props
- Different whitespace / indentation
- A `data-*` attribute that's only on one
- A different import alias

Even a one-character difference breaks the match. `replace_all`
silently updates only the matches it finds — no error.

**What to do:**
1. Before any `replace_all` edit, `Grep` for the unique class /
   attribute / function name you're targeting. Note how many
   occurrences exist.
2. If multiple occurrences, look at each one with surrounding
   context. If they differ, do separate `Edit` calls with
   precisely-tailored `old_string` for each.
3. After the edit, `Grep` again to confirm every occurrence now
   contains the new code. If counts don't match, you missed some.

This is the single most common "I thought it was fixed" failure
mode on this codebase.

---

## 11. Trust your measurements over your screenshots

**Symptom:** User sends a screenshot. You squint at it, conclude
"pills look 140px tall and roughly square." You design a fix
around that estimate. You ship. The actual rendered pills are 60px
tall, your fix targets the wrong size, the user is angry.

**Root cause:** Screenshots compress visual detail and lose absolute
scale. A 60px pill on a 380px-wide phone screenshot can look
identical in proportion to a 140px pill on a 1024px-wide tablet
screenshot if they're both cropped/zoomed for sharing. Your eye is
not a measuring tape.

**What to do:**
1. When the user sends a screenshot, treat it as evidence of the
   USER-VISIBLE PROBLEM, not as a measurement of dimensions.
2. Reproduce the state via Chrome MCP and measure with
   `getBoundingClientRect()` / `getComputedStyle()`. THAT is the
   ground truth.
3. Your code change is informed by the measured value, not the
   screenshot estimate.

---

## 12. "It works in my window" — viewport size matters

**Symptom:** You test the change in your browser. Looks great. User
reports the same screen looks broken on their phone. You can't
reproduce.

**Root cause:** The CSS does respond to viewport differences but you
tested at desktop dimensions and the layout breaks at mobile sizes
(or vice versa). The persona here is a 75-year-old broker on a
narrow Android — that's the layout you must verify, not your
laptop's wide browser.

**What to do:**
1. When testing visually via Chrome MCP, resize to a portrait
   mobile viewport first (`resize_window` with width: 380-420,
   height: 720-860). That matches Linda's phone.
2. After confirming mobile, optionally re-check at desktop too —
   but mobile is the bar.
3. Check responsive-CSS rules (`@media`, `@container`) that might
   apply differently across the two sizes.

---

## 13. MediaRecorder fires `onstop` on its own — only submit when YOU stopped it

**Symptom:** User taps voice, doesn't say anything, and after ~5
seconds the phase mysteriously exits to the review card with empty
fields. Sometimes it happens, sometimes it doesn't. Hard to reproduce.

**Root cause:** Browsers — iOS Safari especially — close the audio
input on their own after a few seconds of silence. `MediaRecorder`
then fires `onstop` *without anyone calling `stop()`*. If the handler
treats every `onstop` as "the user submitted this," the silent blob
gets shipped off to extraction. That's why the bug is intermittent —
it depends on whether the browser decides to auto-close.

**What to do:**
1. Track a `intentionalStopRef = useRef(false)`. Set it `true` JUST
   before calling `recorder.stop()` (user tap, or any other code
   path that meant to end the recording). Reset to `false` inside
   `onstop`.
2. In `onstop`, branch on `wasIntentional`. Discard the blob and
   silently teardown if `false` — let the auto-restart effect bring
   the mic back. The user shouldn't notice the blip.
3. Don't try to detect this via duration — a 5-second auto-stop
   passes the `MIN_RECORDING_MS` floor. Source-of-truth has to be
   "did *we* call stop?".

The current implementation lives in
`frontend/src/components/CanvasVoice/CanvasVoice.tsx` (the legacy
`VoicePhase.tsx` got renamed during the no-panel migration). The
exact flag is named `intentionalStopRef` — search there before
adding a parallel mechanism.

---

## 14. Two "empty" code paths converge on voice — handle both

**Symptom:** User submits a 3-second silent voice recording. Backend
correctly refuses to extract. Frontend bounces back to the voice
phase as expected for *some* silent recordings, but for others it
gets stuck in the review state showing ghost skeleton fields with an
ugly error message ("Couldn't read your note — it looked empty.")
pinned at the bottom.

**Root cause:** Two distinct error codes can come back from the voice
flow when there's no usable signal, and they look identical to the
user:

| Code | Triggered by | Friendly copy |
|---|---|---|
| `empty_input` | Whisper itself returns "no speech detected" (audible silence before the gate ever runs) | "Couldn't read your note — it looked empty." |
| `no_signal` | Our backend gate caught the post-Whisper transcript (empty/garbage/known hallucination like "Thank you for watching") | "Didn't catch that — try once more." |

If the bounce-back logic only matches one of these, the other falls
through to the generic error display.

**What to do:**
1. In `App.canvas.tsx`'s `handleVoiceCaptured` onError handler, match
   **both** `no_signal` AND `empty_input` and route them to the
   same calm "back to voice phase with bounce hint" recovery.
2. Whisper has its own "no speech" detector; our gate handles the
   case where Whisper *did* produce a transcript but it's garbage.
   Both are the same UX moment from the user's perspective.

---

## 15. The signal gate is two-tier — keep the rules in sync

**Symptom:** Frontend lets `"u"` through to submit but the backend
rejects it with `no_signal`. Or vice versa — backend accepts input
the frontend would have blocked. User experience feels inconsistent.

**Root cause:** There are TWO copies of the same signal-gate rule:

| Layer | Where | Job |
|---|---|---|
| Frontend (UX) | Text-input enable check in `App.canvas.tsx` (handleExtract) + duration / silence guards in `CanvasVoice.tsx` | Don't make the user wait for nothing — disable submit / suppress capture before any round-trip |
| Backend (defense) | `domain/signal_gate.py::passes_signal_gate` | Don't get bombed by scripted clients, AND catch post-Whisper transcripts (the only path the frontend can't see) |

Both implement the same rule: empty → block, length < 2 → block,
length < 3 without `\d`/`@`/whitespace → block. **If you change one,
change the other.** They're intentionally redundant — UX gate is
generous (knows about paste, focus, recording duration); defense
gate is dumb-and-strict.

**What to do:**
1. Touching the text heuristic? Edit BOTH `_isReady` and
   `passes_signal_gate` in the same change.
2. The backend gate also carries a Whisper-hallucination denylist
   (`_WHISPER_HALLUCINATIONS`) — the frontend doesn't need one
   because the frontend never sees the transcript. Don't try to
   mirror it.
3. When the photo path lands, the rule extends: NO frontend gate
   (the user physically invested in framing/shooting), backend
   gates after OCR. Same `passes_signal_gate` function gets reused.

---

## 16. Network errors — single bounce-back path, never inline red text

**Symptom:** A future agent adds a new endpoint or a new capture
flow, calls `fetch()`, and on error renders a red `<p
className="capture-error">` inline below the existing UI. The user
ends up stranded on a half-loaded screen with a dev-jargon sentence
like *"Network error — is the backend running?"* and no way to
recover. Owner sees it on a flaky open-house connection and rightly
calls it a regression.

**Root cause:** This codebase had exactly that bug. The "fail clean"
v1 spec calls for **one** network-failure recovery pattern across
the whole app — bounce back to the originating phase with content
preserved, plus a calm offline indicator. Anywhere that adds its own
inline error display defeats that contract.

**What to do:**
1. In `lib/api.ts`, every fetch failure tags the error with
   `code: "network"` before calling `handlers.onError`. The SSE
   stream reader is wrapped in try/catch so a mid-stream TCP drop
   (cell handoff, brief outage) lands in the same code path as an
   initial connect failure — not as an unhandled rejection.
2. In `App.canvas.tsx`'s extraction-stream `onError` handlers
   (`handleExtract` for text, `handleVoiceCaptured` for voice), branch
   on `code === "network"` and bounce back to the relevant input
   phase with the typed/recorded context preserved + a calm inline
   error.
3. Surfaces should listen to `navigator.onLine` + `online`/`offline`
   events to surface an offline pill on the review and disable the
   primary CTA. (The cream canvas doesn't render this pill yet — the
   wire-up is open in [`03_polish_pass.md`](03_polish_pass.md) under
   the network-bounce items.)
4. Adding a new fetching flow? Plug into this pipeline — accept a
   `StreamHandlers`-shaped `onError(code: "network")` contract, let
   the parent route. **Don't** invent a new error-surface component.

**Why:** The baseline persona is a 75-year-old broker on a phone in
a noisy environment. Red dev-jargon errors freeze her. The single
bounce-back path is automatic, never blames the user, and resolves
itself the instant signal returns (the `online` listener re-enables
the button in place). One pattern, every failure, every phase.

**Dev triggers preserved for QA** (stripped from prod by Vite DCE
on `import.meta.env.DEV`):
- `?simfail=net` — fakes the SSE fetch failure (test the extraction
  bounce end-to-end without going truly offline).
- `?simfail=save` — forces the review card's offline UI (preview the
  pill + disabled-Save state without taking the device offline).

Match these with `.startsWith()` not strict equality — markdown-bold
URLs copied out of chat (`**...**`) can leave trailing `**` on the
value, and we'd rather have the QA flag fire than have the path go
silently dead on a typo.

---

## 17. iOS Safari lies about `navigator.onLine` — don't trust it as a pre-flight

**Symptom:** Broker is on iPhone in airplane mode (or briefly out of
range). They submit a capture. The app flips straight to the
extracting/review surface, ghost skeletons spin for ~10s, THEN it
bounces back to the originating phase with the "No internet" pill.
Owner sees it and rightly calls it unprofessional limbo.

**Root cause:** `navigator.onLine` on iOS Safari keeps returning
`true` in airplane mode (and on weak signal) until the first real
fetch actually fails. So a pre-flight `if (!navigator.onLine) bounce`
check passes, we commit to the review surface, fetch hangs, and only
~10s later does the OS admit it's offline. The clean switch we wired
up looked right but was reading a broken signal.

**What to do:**
1. Don't pre-flight on `navigator.onLine` alone — it's a lie on iOS.
2. Instead, pre-flight with a real reachability probe to our own
   `/api/v1/health` endpoint, wrapped in an `AbortController` with a
   short budget (~800ms). Any non-ok / network error / timeout =
   treat as offline and bounce BEFORE flipping to the review surface.
3. Keep the mid-stream `try/catch` in `api.ts` and the photo
   heartbeat watchdog in `App.canvas.tsx::handlePhotoCaptured` — they
   are still the safety net for connections that drop AFTER first byte
   arrives.
4. The probe is cheap (~50ms on good network) and invisible to the
   persona. Never use it as an excuse to skip the mid-stream
   safety nets — they catch a different failure mode (online when we
   started, offline by the time we're streaming).

Status on the canvas: text + voice flows do NOT currently run a
pre-flight probe. They flip to `phase="loading"` immediately on
submit, then rely on the stream's own error handler to bounce back if
the network is dead. The probe is logged as a follow-up if iOS
Safari's `onLine` lies surface again in real-user testing.

---

## 18. AssemblyAI U3-Pro: `end_of_turn_confidence_threshold` is a no-op

**Symptom:** You tune `end_of_turn_confidence_threshold` to fix a
cadence or finalisation problem on Universal-3 Pro streaming. Nothing
changes. You tune it further. Still nothing.

**Root cause:** Universal-3 Pro uses **punctuation-based turn detection**,
not the confidence-threshold mechanism of older Universal-Streaming
models. The parameter exists in the API surface for consistency but is
inert on U3-Pro — AssemblyAI documents this explicitly.

**What to do:**
1. Remove `end_of_turn_confidence_threshold` from any U3-Pro param set
   you see it in.
2. For the long-uninterrupted-speech case (16 s of dead air before the
   first partial), the actual knob is `continuous_partials=true`. Add
   that to the connection params; partials then fire every ~3 s during
   continuous speech regardless of silence.
3. `min_turn_silence` and `max_turn_silence` only fire when there IS
   silence. Useful as complements, not as the primary cadence knob.
4. On user-stop, send `{"type": "ForceEndpoint"}` over the WS before
   terminating — saves up to `max_turn_silence` of dead time waiting
   for the final.

---

## 19. Bakeoff harness: `--provider X` is silently ignored when `--all` is set

**Symptom:** You want to re-run only one provider against the full
corpus to validate a fix. You pass `bakeoff.py run --all --provider
google`. The orchestrator re-runs EVERY provider. Hours of wasted API
spend.

**Root cause:** The CLI treats `--all` as "all providers" regardless of
the `--provider` filter. The 2026-05-15 Google re-run hit this exact
trap.

**What to do:**
1. To run a single provider against the full corpus, either temporarily
   remove the others from `_KNOWN_PROVIDERS` OR add an `--only` flag
   to the CLI.
2. For a quick smoke check on one provider against ONE clip, omit
   `--all` and pass `--audio <one-file>`.

Lives in `docs/_tests/stt_bakeoff/bakeoff.py`. See
[`docs/_spec/live_captions.md`](../_spec/live_captions.md)
for the full re-run procedure.

---

## 20. Google Cloud Speech-to-Text V2: needs `Cloud Speech Editor`, not Client

**Symptom:** Bakeoff smoke test against Google Cloud Speech-to-Text V2
returns 403 / `permission denied` / `speech.recognizers.recognize` not
authorised, even though the service account is granted "Cloud Speech
Client."

**Root cause:** The "Cloud Speech Client" role is **V1-only**. It does
not include `speech.recognizers.recognize`, which is the V2 verb. V2
requires the `Cloud Speech Editor` role (or a custom role that includes
the verb).

**What to do:**
1. In Google Cloud Console → IAM, change the bakeoff service account's
   role from "Cloud Speech Client" to "Cloud Speech Editor."
2. Confirm the project has the Cloud Speech-to-Text API enabled.
3. Re-run the smoke test — the 403 should disappear.

`GOOGLE_SERVICE_ACCOUNT_PATH` in `.env` points at the JSON key.
Provider lives at
`docs/_tests/stt_bakeoff/providers/google_streaming.py`.

---

## 21. "AssemblyAI self-serve dashboard" for DPA / opt-out / data zone is a myth

**Symptom:** You read a plan/progress doc that says "self-serve DPA in
the AssemblyAI dashboard, flip the no-training + US-zone toggles, ship
— afternoon's work, free." You go hunting in the dashboard. The
toggles aren't there. You assume you're on the wrong page; you click
through every settings section, Trust Center, billing, organisation.
Still no toggles. You ping support. You waste an afternoon.

**Root cause:** Those toggles don't exist on any tier. The plan was
wrong. Verified facts (2026-05-15):

| Thing | Reality |
|---|---|
| **DPA** | Auto-applied via ToS on account creation. No separate signing. ([source](https://www.assemblyai.com/docs/faq/can-i-sign-a-dpa-agreement-with-assemblyai)) |
| **Training opt-out** | Email `data-opt-out@assemblyai.com` from the account email. **Paid tier only** — free users cannot opt out. Forward-looking only. ([source](https://www.assemblyai.com/docs/faq/how-to-opt-out-of-data-sharing-for-our-model-improvement-program)) |
| **Streaming zero-retention** | Coupled to the opt-out — same gate. Paid tier first. |
| **US data zone** | Already the default. `api.assemblyai.com` / `streaming.assemblyai.com` route to AWS us-west-2. No toggle to find. ([source](https://www.assemblyai.com/docs/pre-recorded-audio/select-the-region)) |
| **Paid vs free dashboard** | Identical. Going paid doesn't unlock new toggles; it only makes you eligible to send the opt-out email. |

**What to do:**
1. Don't go hunting for dashboard toggles. They don't exist.
2. When the account is upgraded, send the opt-out email and save the
   confirmation reply in the compliance folder.
3. Until then, leave `LIVE_CAPTIONS_ENABLED=false` — free-tier audio
   is training-eligible per AssemblyAI's ToS.

See [`docs/_spec/live_captions.md`](../_spec/live_captions.md)
§"Privacy & DPA reality" for the full receipts.

---

## 22. Google Doc AI Form Parser — tables and form_fields are different API surfaces

**Symptom:** You wire up Doc AI Form Parser, run it against a clean
synthetic form with handwritten data in clearly-labelled cells, and
get **zero `form_fields`** back. You assume Doc AI doesn't work for
this case. Or, conversely, you run it against a real labelled form
("Name: ___ / Phone: ___") and get good `form_fields` but you ignored
`tables` and missed half the data.

**Root cause:** Form Parser populates two different response surfaces
depending on the document shape:
- `document.pages[].tables` — for documents that look like tables
  (header row + body rows, explicit column structure).
- `document.pages[].form_fields` — for documents with labelled fields
  ("Name: ___ / Phone: ___ / Email: ___" pairs).

Neither one is a superset. A clean 3-column table with column headers
emits `tables` but **zero** `form_fields`. A typical sign-in form
with field labels emits `form_fields` but no `tables`. The candidate
needs to read both surfaces.

**What to do:**
1. Try `tables` first — if any `body_rows` exist, parse those (header
   row labels each column).
2. Fall back to `form_fields` — cluster by y-coordinate (the API
   doesn't surface "this is row N") and label by `field_name` text.
3. Working implementation lives at
   `docs/_tests/vision_bakeoff/candidates/google_docai.py`; the
   bake-off proved both paths are needed.

---

## 23. Corpus agent CSVs may double-encode non-ASCII characters

**Symptom:** Bake-off scorer marks "Hans Müller" as wrong for every
model that read it correctly. Or the labeler UI displays "Ã‰tienne"
instead of "Étienne." You read the source CSV and see exactly
`Hans MÃ¼ller` in the raw bytes.

**Root cause:** Some upstream pipeline writes UTF-8 bytes, then
re-encodes the file as if it were Latin-1 — `ü` (UTF-8: `c3 bc`)
becomes `Ã¼` (UTF-8 bytes for `c3 83 c2 bc`). The file is "valid
UTF-8" but the strings inside are mojibake.

**What to do:**
1. Read the CSV with `encoding="utf-8"`.
2. For each string cell that contains `Ã` or `Â`, repair via
   `value.encode("latin-1").decode("utf-8")`.
3. This is a no-op for clean ASCII strings, so applying it
   defensively at the read boundary is safe.
4. There's a working `_fix_mojibake` helper in
   `docs/_tests/vision_bakeoff/render_clean_corpus.py`.

---

## 24. Pillow can't open some "handwriting" .ttf fonts standalone

**Symptom:** You loop through a handwriting fonts folder via
`ImageFont.truetype(path, size)` and one font throws
`OSError: unknown file format` — entire render script crashes.

**Root cause:** Pillow's freetype backend can't parse variable-weight
fonts (e.g. `Caveat_wght.ttf`) or certain quirky display fonts
(e.g. `HomemadeApple-Regular.ttf`, `PermanentMarker-Regular.ttf` —
specific to the ones we tried, others may exist). Some need an explicit
weight axis; others have a TTF table layout Pillow rejects.

**What to do:**
1. Don't hard-fail. Wrap each font load in a try/except and skip the
   unreadable ones.
2. Log which fonts you skipped so the user knows the corpus has
   slightly less variety.
3. Working pattern in
   `docs/_tests/vision_bakeoff/render_clean_corpus.py`.

---

## 25. iPhone photos are 12.19 MP — production cap of 12 MP rejects every gallery upload

**Symptom:** Real-device testing shows every iPhone gallery upload
fails with `IMAGE_TOO_LARGE`. Live camera capture works fine.

**Root cause:** The preprocessor's `max_megapixels` cap was originally
12. iPhones (12+) take photos at 4032 × 3024 = 12.19 MP — every one
fails the cap on gallery upload. Live camera capture works because the
video feed from `getUserMedia` is ~1920×1080 (≈2 MP), well under the
cap.

**What to do:**
1. The cap was raised to 25 MP during the bake-off
   (`_DEFAULT_MAX_MEGAPIXELS` in
   `backend/src/captureshark/adapters/image_preprocessor.py`). Don't
   lower it back to 12 without verifying iPhone gallery upload still
   works end-to-end.
2. Pixel-bomb protection: 25 MP × 3 bytes/px = ~75 MB decoded peak.
   Comfortable for one uvicorn worker. If you raise further, profile
   memory before shipping.

---

## 26. Gemini's structured-output schema is a subset of JSON Schema

**Symptom:** You hand Gemini a JSON Schema that works fine for
OpenAI's Structured Outputs (and Anthropic tool-use). Gemini throws
a pydantic enum validation error on `type` — something like
"Input should be 'STRING', 'NUMBER', ... but got ['string', 'null']."

**Root cause:** Gemini's `response_schema` field accepts JSON Schema
syntax with **subset semantics**:
- Union types (`"type": ["string", "null"]`) are not supported. Use
  a concrete `type` + `"nullable": true`.
- `additionalProperties` is rejected silently in some SDK versions.
  Strip it.

**What to do:**
1. Translate the schema at the boundary, don't rewrite your domain
   schema to satisfy Gemini.
2. Working translator lives at
   `docs/_tests/vision_bakeoff/candidates/gemini.py`
   (`_strip_unsupported_schema_fields`).

---

(Add new entries below as they come up — keep them blunt, with a
"symptom / cause / what to do" shape so the next agent can scan and
self-correct.)
