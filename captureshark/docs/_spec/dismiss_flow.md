# Dismiss flow — durable architecture reference

**Last updated:** 2026-05-23 — first version, written immediately after the subsystem landed (commit `0fd56b8`). The code is the ultimate truth; this doc captures the *why* + the per-phase policy so a future agent doesn't have to read the diff history to understand the design.

The locked architecture for "tap outside the active panel to go one step back." Covers the shared Dialog primitive, the `useDismissFlow` orchestrator hook, the per-phase policy, the inner-dismiss escape hatch used by the per-field edit panel, and the CSS / DOM mechanics that route stray taps to the backdrop catcher.

**Companion docs:**
- [`02_PRINCIPLES.md`](../_workflow/02_PRINCIPLES.md) — persona (Linda), ASMR feel, never-lose-data rule. Every decision below defers to these.
- [`docs/_dev/12_testing.md`](../_dev/12_testing.md) — what / how we unit-test (the hook is tested; the Dialog component isn't, per the rendering / human-test split).

---

## 1. The contract

A backdrop tap (any tap that lands on bare cream, not on a live control) pops **one** layer of the active panel. Per-phase rules below say *what* one layer means and *whether* the pop is silent or guarded by a confirm Dialog.

The single principle, in priority order:

1. **Never lose Linda's data.** A pop that would drop unsaved work raises a confirm Dialog — Save / Don't Save / Cancel — instead of going through silently. Cancel always returns the user to where they were with their draft intact.
2. **Minimize friction.** A pop that costs nothing (empty draft, already-persisted save, auto-merging field) is silent — no Dialog, no friction. ASMR > "are you sure?".
3. **Never interrupt in-flight work the user has no recovery for.** Loading + camera + raw extraction screens swallow taps because the user has no local snapshot of that work yet.

The combination above resolves every per-phase decision in §3 below.

---

## 2. Components

### 2.1 `Dialog` primitive — `frontend/src/components/Dialog/`

One reusable modal surface. Apple's `UIAlertController` model: a single component renders every confirm / warning / future picker prompt; everything else is props.

- `icon?` — `"warning" | "question"`. Drives the ring + glyph above the title.
- `title` — required headline.
- `body?` — optional supporting copy (plain English, no jargon).
- `actions` — vertical stack of `{ label, kind, onPress }`. `kind` is `"primary" | "secondary" | "destructive"`.
- `onDismiss?` — backdrop tap + Escape both fire it. Omit to make the Dialog blocking.

Portal-mounted to `document.body` so z-index always stacks above the canvas. `useId()` gives each instance a unique `aria-labelledby` target so two Dialogs at once would still be valid (rare today, but the cost is zero).

**Cream theme, always.** Backdrop is espresso @ 42%; card is `--cream-page-bg` with a hairline tan border; primary button is filled espresso. Matches the canvas surface — never the slate residue from the legacy CaptureSheet.

### 2.2 `useDismissFlow` hook — `frontend/src/features/dismiss/`

Owns the entire policy. The orchestrator (`AppCanvas`) wires inputs in and renders the returned dialog node — it does not see any of the per-phase logic.

Inputs:
- `state` — the current `AppState` (the screen we're on).
- `dispatch` — for layer-pop actions.
- `onSaveFromReview` — invoked when the user picks "Save to sheet" from the review confirm.
- `onDiscardPhoto` — invoked when the user picks "Discard" from the photo-review confirm.
- `onBackToPhotoList` — invoked when photo-row-edit pops silently (auto-merge semantic owned by the photo session hook).
- `attemptInnerDismiss?` — optional escape hatch (see §4).

Returns:
- `handleBackdropTap` — wire to the backdrop catcher.
- `dismissDialog` — the live confirm `Dialog` node (or `null`). Render it anywhere in the JSX tree.

The hook is the only place per-phase pop policy lives. Adding a phase or changing a rule is a one-file edit.

### 2.3 Backdrop catcher — `.app-canvas__backdrop`

A transparent `position: absolute; inset: 0; z-index: 0;` div, rendered as the first child of `.app-canvas`. Its only job is to be the click target for "real cream taps." Inactive phase panels already use `pointer-events: none` per phase, so their footprint falls through to the catcher. Active panels absorb their own taps via the wrapper-passthrough pattern in §5.

**Why a dedicated catcher and not the `.app-canvas` root with a `target === currentTarget` check:** the heuristic version shipped first and broke. React's synthetic event behaviour on nested phase swaps surfaced edge cases where the click would route to the canvas root mid-transition. The dedicated catcher only fires when the click *actually* lands on bare cream — no heuristic, no edge case.

---

## 3. Per-phase pop policy

| Phase (`state.kind`) | On backdrop tap | Confirm Dialog? |
|---|---|---|
| `home` | no-op | — |
| `loading` | no-op | — (extraction in-flight; user has no local snapshot to fall back on) |
| `photo` | no-op | — (camera takeover owns its own X — see §6) |
| `text-input` (empty draft) | silent `GoToHome` | — |
| `text-input` (typed draft) | open confirm | **"Discard your note?"** — Discard / Keep typing |
| `voice` | silent `GoToHome` | — |
| `review` (text/voice) | open confirm | **"Save before going back?"** — Save to sheet / Discard / Cancel |
| `photo-review` | open confirm | **"Discard your photo rows?"** — Discard / Cancel |
| `photo-row-edit` | silent back to multi-view | — (auto-saves; `photo.handleBackToPhotoList` merges the lead) |
| `saving` | silent `CaptureAnother` | — (see §7) |
| `saved` | silent `CaptureAnother` | — |

**Review and photo-review always confirm**, even when no field has been edited yet. The extracted lead / row batch IS the user's work — letting them lose it on an accidental tap would violate principle 1. The "did the user edit anything?" dirty check that an earlier draft used silently dropped clean extractions, which was wrong.

**Voice silent-pops** because pre-recording there's nothing to lose, and during a recording the recorder cancel happens via the active phase swap (see `CanvasVoice` mic-teardown defer below).

---

## 4. Inner-dismiss escape hatch (the per-field edit panel)

The `LeadReviewCard`'s per-field edit panel sits one layer deeper than the review screen. Tapping outside it should pop only that one layer — back to the lead view — not the whole review.

### 4.1 The handle

`LeadReviewCard` is wrapped in `forwardRef` and exposes a `LeadReviewCardHandle` via `useImperativeHandle`. One method:

```ts
dismissOpenFieldEdit: () => InnerDismissResult
```

`InnerDismissResult` is a three-case union:
- `{ kind: "none" }` — no field edit is open; the dismiss flow falls through to the layer-pop policy.
- `{ kind: "closed-clean" }` — the field edit was open with an unchanged draft. The handle silently closed it (called `cancelEdit`); the dismiss flow returns without popping the layer.
- `{ kind: "has-changes", commit, discard }` — the field edit has unsaved changes. The handle does NOT close it; instead it hands back two callbacks so the dismiss flow can raise its own "Save your changes?" confirm Dialog with Save / Don't save / Cancel actions wired to `commit` / `discard` / no-op. The field stays in editing mode until the user picks.

### 4.2 Dirty detection

The initial value is snapshotted in `editInitialValueRef` when `openEditor` runs. The dismiss handle compares the current draft against it:

- Picker + plain text fields → compare `editDraft` to the snapshot directly.
- Phone + budget → compare `editInputRef.current.value` (uncontrolled input, live-formatted) against `formatPhone(snapshot)` / `formatBudget(snapshot)` so the comparison is like-for-like.

If equal → `closed-clean`. If different → `has-changes`.

### 4.3 Why this lives in the card, not lifted up

The per-field edit state is genuinely card-internal — focus, formatter caret restoration, picker pill selection. Lifting it to the orchestrator would expose details the orchestrator has no reason to know. The imperative handle is the minimum surface needed for the dismiss flow to participate; the card retains ownership of everything else.

---

## 5. CSS / DOM mechanics — the wrapper passthrough pattern

The card-shaped sections (`.app-canvas__review`, `.app-canvas__photo-summary`, `.lead-review-card`, `.lead-review-card__edit`) are layout *slots* wider than their visible content. Their padding gutter reads as cream on screen, but the wrapper itself is `pointer-events: auto` by default — so without intervention, taps in the cream gutter get absorbed by the wrapper instead of routing to the backdrop catcher.

The fix is the **wrapper passthrough**:

```css
.app-canvas__photo-summary { pointer-events: none; }
.app-canvas__photo-summary > * { pointer-events: auto; }
```

The wrapper is transparent to clicks; its direct children (the card content) absorb. Cream gutters fall through to the backdrop, raising the confirm Dialog as the user expects. The same pattern is applied to:

- `.app-canvas__review` (review surface + photo-row-edit slot)
- `.lead-review-card` (LeadReviewCard root)
- `.lead-review-card__edit` when `data-editing="true"` (the per-field edit panel container — its label, input, and Done button absorb individually so taps in the cream above/below/beside the input fall through)

**Crucial corollary:** never give a layout-slot wrapper a background that the user reads as "the card." If you do, taps on the visible-but-pass-through area feel broken. Backgrounds belong on the inner content.

---

## 6. The camera exception

`state.kind === "photo"` is the full-bleed camera takeover. It opts out of the backdrop-tap flow entirely — `handleBackdropTap` returns immediately for that phase. The camera surface owns its own X button (top corner) for explicit cancel. Tap-anywhere-to-cancel would feel wrong on a viewfinder; the X is the conventional pattern and matches Linda's mental model.

When a photo extracts successfully the phase moves to `photo-review` and the rest of the dismiss flow takes over.

---

## 7. The save-during-saving safety guarantee

The `saving` and `saved` phases both silently dispatch `CaptureAnother` on backdrop tap. Doing this safely depends on the **offline-first** save architecture:

1. **`Save` tap → IndexedDB write happens first.** `enqueueExtractedLead` persists the lead to local storage *before* the saving screen renders. From that instant the lead is durably stored on Linda's device.
2. **State transition is independent of the in-flight async.** The `runSave` async function captures `dispatch` in its closure; when the user backdrop-dismisses, `state.kind` becomes `home` but the async function keeps running.
3. **Reducer guards drop late dispatches harmlessly.** `SaveLocalWriteCommitted` and `SaveLocalWriteFailed` both check `if (state.kind !== "saving") return state;` — if the user has already moved on, those actions no-op. The data is already saved.
4. **The drainer pushes to the sheet regardless of UI state.** `drainNow()` runs in the queue subsystem; it doesn't read `state.kind`. The row reaches Linda's sheet whether or not she watched the celebration.

The only visible cost of an early dismiss: the user skips the "Saved ✓" surface + the "Open in Sheets" link. The save itself is unaffected. This tradeoff is acceptable; it matches Linda's "I'm in the field, I tapped Save, I moved on" mental model.

---

## 8. Anti-patterns — things we tried that broke

These are documented so future agents don't reinvent them.

- **`target === currentTarget` check on the canvas root.** Shipped first; broke on iOS Safari + React's nested-phase-swap timing. The dedicated `.app-canvas__backdrop` catcher (§2.3) replaced it; never go back.
- **Synchronous mic teardown in `CanvasVoice`'s phase-becomes-inactive effect.** `track.stop()` stalls the main thread ~100ms on iOS Safari, freezing the cream phase swap. The teardown is now deferred via `setTimeout(0)` so the paint lands first — see `CanvasVoice.tsx` for the comment.
- **"Don't show confirm if nothing edited" guard on review / photo-review.** Felt minimal-friction, but quietly dropped clean extractions on accidental taps. Owner caught it on first test; the policy is now ALWAYS confirm on those phases (principle 1 beats principle 2 when work is at stake).
- **Phase-based `pointer-events: auto` on layout-slot wrappers.** Made the cream gutter inside the wrapper absorb taps that should have hit the backdrop. The wrapper-passthrough pattern (§5) is the replacement.
- **Lifting `editingField` state to the orchestrator** to let it close the panel directly. Over-coupled — the imperative handle (§4) is the minimum surface and preserves the card's internal ownership.

---

## 9. Testing

- The hook is unit-tested at `frontend/src/features/dismiss/useDismissFlow.test.tsx`. Every per-phase case from §3 has a matching `it("…")` line; the dirty flag → confirm transition and the inner-dismiss escape hatch are covered separately.
- The `Dialog` component is **not** unit-tested. Per [`docs/_dev/12_testing.md`](../_dev/12_testing.md), React components are human-tested in a browser — visual feel is what matters and a render-tree assertion buys nothing.
- The wrapper-passthrough CSS is also human-tested — it's a hit-test behaviour that can't be expressed in JSDOM cleanly. The anti-pattern in §8 documents why a unit test alone wouldn't have caught it (it caught the wrong rule, not a CSS bug).

---

**End of dismiss-flow spec.** Anything dismiss-policy-related, Dialog-primitive-related, or inner-edit-escape-related belongs here.
