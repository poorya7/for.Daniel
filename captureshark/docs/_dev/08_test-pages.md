# Test pages — the scratchpad catalog

**Last updated:** 2026-05-23 — added `/no-panel-mocks` entry. After the no-panel migration cleanup pass on 2026-05-22, the legacy capture-sheet morph sandbox is the only entry from that era still mounted (kept for reference).

Standalone debug / dial-in pages that live alongside the main app. They share the same Vite build but mount a different root component based on the URL, so they're zero-overhead and always reachable on the live tunnel.

**How they're wired:** `frontend/src/main.tsx` reads the URL on boot and mounts the matching component from `frontend/src/test-pages/`. Two URL forms work:

- **Path form** (preferred): `https://dev.captureshark.com/<name>` — survives the iOS Safari address bar reliably.
- **Query form** (legacy, still works): `https://dev.captureshark.com/?test=<name>`.

When you delete a test page, remove its `.tsx` file AND its line in `main.tsx`.

---

## Current pages — mobile URLs (tap to open)

### Shark-loader polish

The water-and-fin loader that plays during extracting. Locked motion; this page lets you spot-check timings or stage the loader against the real capture-sheet surface.

**Loader on a mock capture sheet (closest to live):**

https://dev.captureshark.com/extracting-shell

**Peak-height dial (single fin + one slider):**

https://dev.captureshark.com/peak-slider

**Loader on the new warm cream theme (color check before porting):**

https://dev.captureshark.com/shark-loader-light

**Exit-timing measurement (bare loader, water stays, big timer + event log + delay buttons for diagnosing how long the exit actually takes):**

https://dev.captureshark.com/shark-timing

**Loading-state panel mock (loader + eyebrow + rotating phrases, in the review-card panel envelope):**

https://dev.captureshark.com/extracting-panel-light

**Input → loading → review water-morph (no real LLM, simulated fetch with delay buttons 0.5s / 1s / 2s / 3s / 5s — tests how the choreography behaves across different data arrival times):**

https://dev.captureshark.com/water-morph

---

### Capture-sheet morph polish

The picker-mode + edit-cell morph rewrite. One Framer timeline drives the sheet shrink + cell fade + pills appear, all in sync.

**Picker morph timeline sandbox:**

https://dev.captureshark.com/?test=picker-morph

---

### No-panel canvas migration

**Review pager (Embla-based gesture + chrome + compress in isolation, without the full canvas flow):**

https://dev.captureshark.com/review-pager

**No-panel layout mocks (the 7 layout directions from the variant choice; variant 3 "Hero top" is the one that shipped):**

https://dev.captureshark.com/no-panel-mocks

---

### Photo zoom + crop

**Pinch + pan gesture sandbox (Phase 2 of `docs/photo-zoom-crop/01_PLAN.md`). Coloured grid as the source — pinch to zoom, drag to pan, tap Capture to read the resulting source-pixel rectangle in the HUD):**

https://dev.captureshark.com/pinch-pan

**Last capture (dev-only verification — shows the EXACT JPEG bytes the camera path last shipped to the AI, plus dimensions / crop coordinates / file size. Take a photo in the main flow, then open this URL to see what was sent. Tree-shaken from production builds):**

https://dev.captureshark.com/last-capture

---

### iOS Safari diagnostics

Pages that log on-screen so you can read events from a phone without a remote inspector.

**Tap-outside event log (figuring out which iOS events fire when you tap outside a focused textarea while the keyboard is up):**

https://dev.captureshark.com/?test=tap-outside

**Live-captions event log (every AssemblyAI message + timestamps + the stable-buffer painted to the UI):**

https://dev.captureshark.com/?test=live-captions

---

### App-level launchpads

Not really "test pages" — proper landing surfaces that have a path of their own.

**Dev simulator panel (fresh-user / simfail launchpad — every dev shortcut in one place):**

https://dev.captureshark.com/sim

**Home-lab landing design experiment:**

https://dev.captureshark.com/home-lab

**Wordmark lab (six candidate fonts for the CaptureShark mark, stacked for scroll-compare on phone):**

https://dev.captureshark.com/wordmark-lab

---

## Adding a new test page

1. Drop the component at `frontend/src/test-pages/<Name>TestPage.tsx`.
2. Add a route line in `frontend/src/main.tsx` (both `?test=` and `/path` forms — keeps muscle-memory bookmarks alive).
3. Add an entry to this doc with the mobile URL on its own line (owner taps from the phone; surrounding prose breaks the tap target).

## Deleting a test page

1. Delete the `.tsx` (and any sibling `.css`).
2. Remove the import + route line from `main.tsx`.
3. Remove its entry from this doc.
4. Grep for the route string across the repo to catch any old references (`docs/`, READMEs, etc.).
