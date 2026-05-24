# CaptureShark — Product Principles

**Status:** persistent. Version-agnostic. Every spec (v1, v2, …) defers to this doc for *who we're building for* and *how it should feel*. Individual specs override only if they call out the override explicitly and explain why.

**Last updated:** 2026-05-10

---

## 1. The persona — Linda (the bar)

Every UX decision is checked against one specific user:

- **Linda.** Real-life 75-year-old real-estate broker. Respected in her field. Uses Google Sheets daily. **Not tech-savvy at all.** Carries an **old, slow phone** with **flaky cell signal** at open houses.
- She must use this app **comfortably, on her phone, at an open house, in 30 seconds, without help.**
- The app must still feel **professional and elegant** — never dumbed-down, never cartoonish. She is a respected pro; the tool should look like a respected pro's tool.

**Test bar:** if Linda would feel overwhelmed, lost, or impatient on a screen, that screen is wrong. Severe-ADHD usability is the second bar — both apply at once.

---

## 2. ASMR — the feel of the app

The app should feel **smooth, calm, polished, and quietly fast**. Like an ASMR video — never jumpy, never abrupt, never loud.

- **No instant pop-ups.** Every appearance / dismissal is a smooth transition.
- **No twitch.** Layouts don't shift while content loads. Skeletons hold their final size; content swaps in place.
- **No surprise.** State changes are predictable; the user always knows what's next.
- **One persistent stage.** When the user moves between phases, the *container* stays put — only the contents change. (See sketch §5 for the live implementation.)
- **Motion is generous, not frantic.** Phase transitions land in the ~500ms range (with a calm decelerating curve and matched fade duration); shorter than ~300ms reads as nervous, longer than ~800ms drags. In-place content morphs (e.g. saving → saved within the outcome phase) ride a top-to-bottom wave so the surface is always partially in motion rather than snapping. Easing always starts moving on frame 1 (no perceptual dead zone).

If a screen feels "snappy but jittery," that's wrong. Calm beats snappy. (Both is the goal.)

---

## 3. Above the fold — no hunting

**The primary action and the current decision must be visible without scrolling.** Always.

- **Home screen, capture screen, review screen, save screen — never scroll.**
- **Documented exceptions** (kept narrow): the Recent Captures expanded view (multi-row entries) and the photo review screen (long row lists) may scroll *inside their own panels*. Page-level scroll is never the answer.
- A slightly tall card that scrolls naturally inside its container is fine. **Hidden critical actions are the real failure mode** — that's what we ban.
- **Nothing important hidden behind "click to expand", "see more", or collapsed defaults.** Secondary controls (Disconnect, About) can live behind one tap on the persistent header. Primary controls cannot.

---

## 4. One decision at a time

Linda should never have to evaluate two things at once.

- **Choices = one button, two-button select, or swipe.** No dropdowns, no multi-step wizards, no modal stacks.
- **Two questions in one screen = wrong screen.** Split them.
- **Tradeoff questions Linda has no framework for = don't ask.** Decide for her using the spec / persona, or pick the safer default.
- **Confirmation copy is plain-English, leaves no ambiguity.** *"Add as another lead"* / *"Update the existing one"* / *"Skip this one"* — three buttons, three plain verbs.

This rule applies to the AI's voice too: when the AI is uncertain, it asks one specific clarifying question, never a menu.

---

## 5. Old phone, weak signal — the perf bar

Linda's phone is slow and her signal is bad. Build for that as the **default target**, not the edge case.

- **First meaningful paint on home screen ≤ 2s on a slow 4G / mid-2018 Android.** If we have to choose between a 200ms-faster page that costs Linda a layout shift, the layout shift loses.
- **Perceived latency beats actual latency.** Stream everything that can stream. Show the review skeleton the *instant* the user submits — never freeze the input screen waiting for the model.
- **Optimistic UI for save.** Show "Saved ✓" the moment the API request goes out (with rollback on error). Don't make Linda stare at a spinner because the network is slow.
- **Image / asset budget:** keep total page weight modest (mid-double-digit KB for the initial route ideal; low-MB for full PWA cache). Lazy-load anything not on the first screen.
- **Animations honor `prefers-reduced-motion`** — Linda may have it on without knowing.
- **Capture survives network drops mid-flow.** Queue locally, retry transparently when signal returns. Never lose data because the bar dropped to one bar.
- **No layout shift on slow networks.** Skeletons reserve their final dimensions; fonts load with `font-display: swap` *and* matched fallback metrics so swap-in doesn't reflow.

Concrete numbers (perf budget, revisited per release):
- Initial JS payload: ≤ ~150KB gzipped.
- LCP on slow 4G mid-tier Android: ≤ 2.5s.
- CLS: ≤ 0.05 (anything visible to Linda = wrong).
- INP on tap interactions: ≤ 150ms.

---

## 6. Plain-English everywhere — no jargon

Linda doesn't know what an OAuth scope is. She doesn't need to.

- **No tech words in user copy.** *"Sign in with Google"* yes; *"OAuth"*, *"API"*, *"scope"*, *"JSON"*, *"token"* never.
- **No abbreviations Linda doesn't say.** *"Temp name"* → *"need a name typed in"*. *"Auth"* → *"Sign in"*.
- **Confidence shown as plain words, not colored dots.** *"Check this"* / *"Couldn't read this"* — readable for older eyes, colorblind users, ADHD users.
- **Icons always paired with plain-English labels** for primary actions. No icon-only buttons.
- **Error messages explain what to do, not what failed.** Not *"403 insufficient_authentication_scopes"* — instead *"We don't have permission to write to your Google Sheet. Reconnect it and try again?"*
- **When the AI is admitting uncertainty, use the most plain, longest, most explicit copy.** Long copy is fine when the alternative is confusion.

---

## 7. Apple-grade craft, demo-realistic scope (two axes — don't conflate)

**Craft axis — Apple-grade, always.** Code, structure, architecture, naming, error handling: done right. No band-aids, no "we'll clean it up later." Schemas and module boundaries leave room for predicted growth.

**Scope axis — demo-realistic until traction.** Solo-dev, pre-launch. Don't gold-plate features for users who haven't shown up. Ship lean, learn, then invest.

Concretely:
- The cases we handle, we handle cleanly.
- Edge cases handled = the common ones, not all.
- Polish = enough for Linda to feel comfortable; defer ornamental polish that doesn't move the demo.
- Code itself = always clean, tested, properly architected, no shortcuts.

When something not in the spec comes up: **default to the simplest answer that doesn't break Linda's bar — but build that simple answer Apple-clean.**

---

## 8. Never lose Linda's data

The app **never silently drops a capture, an edit, or a save.**

- Capture persists to local storage **before** the network call.
- Failed saves stay queued + visible in Recent Captures with a Retry, never pretended-saved.
- Destructive actions (delete, disconnect, overwrite) require an explicit plain-English confirmation.
- Undo is available for ~10s after destructive-feeling actions when feasible.

---

## 9. How specs use this doc

- New specs (v2, v3, …) **link here** for persona + ASMR + above-fold + one-decision + perf + plain-English. They don't restate.
- A spec **may override** a principle for a specific feature, but must call the override out explicitly with a one-line reason. (Example: *"Photo capture goes full-bleed instead of inside the sheet — see §5 of v1 sketch — because mobile camera APIs require the viewport."*)
- If a principle is wrong (Linda's profile shifts, perf budget needs revisiting), update **this doc**, not the spec. Then specs inherit the change automatically.

---

**End of principles.** Anything Linda-related, ASMR-related, or perf-budget-related belongs here.
