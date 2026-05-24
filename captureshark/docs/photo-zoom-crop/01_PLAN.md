# Photo zoom + crop — implementation plan

**Status:** planning. Not yet started.
**Owner:** Josh.
**Last updated:** 2026-05-23.

Companion docs:
- [`docs/_spec/photo_capture.md`](../_spec/photo_capture.md) — locked photo architecture.
- [`docs/_workflow/02_PRINCIPLES.md`](../_workflow/02_PRINCIPLES.md) — persona + ASMR + perf bar.
- [`docs/_dev/05_agent-pitfalls.md`](../_dev/05_agent-pitfalls.md) — photo-specific traps (items 17, 22–26).

---

## 1. Goal

The broker can pinch to zoom and pan to frame the part of the photo they care about — and **only the framed region** gets sent to the AI. This applies to BOTH capture paths:

- **Live camera** — pinch inside the camera surface zooms the camera feed (not the page).
- **Gallery upload** — after the file picker hands us a photo, the broker sees the same pinch+pan surface and confirms with a "Use this part" action.

Today neither path supports this. Camera pinch zooms the whole web page (bug). Gallery upload sends whatever file the OS picker returns, full size.

---

## 2. Current state (what's actually there today)

- Camera UI is a full-bleed `<video>` with no gesture handling. Pinching falls through to the browser → page zooms.
- Capture path draws the entire video frame to a canvas at native resolution.
- Gallery path hands the picked `File` directly to the parent — no preview, no crop.
- iOS Photos shows its own zoom UI inside the picker, but the file it hands back is the unmodified original. This was previously assumed (incorrectly) to deliver a cropped file.

Result: regardless of platform, the AI receives the full photo today.

---

## 3. Architecture decision — single crop pipeline for both paths

Two approaches were considered.

### Option A — Hardware zoom for camera, in-app crop for gallery

Uses the phone's camera-track zoom capability for the live preview, plus a separate crop UI for gallery.

- Hardware zoom centers on the lens; pan isn't supported → still need a software crop for the pan dimension.
- Different code paths between camera and gallery → drift over time.
- Cross-browser support for `MediaTrackCapabilities.zoom` is uneven on Android (Chrome OK; Samsung Internet partial; Firefox mobile no).

### Option B — Software pinch+pan + post-capture crop, used by BOTH paths ← chosen

- Live preview applies the gesture via CSS transform (`scale` + `translate`) on the video / image element.
- On capture, `canvas.drawImage(source, sx, sy, sw, sh, 0, 0, ow, oh)` reads from the **full-resolution source** and writes only the visible window to the output canvas.
- Same code, same UX, same quality on both paths.
- Cross-platform: standard Web APIs, works on every supported browser.
- Quality stays high because we crop from the full source frame — we never ship a CSS-stretched bitmap.

### Why B wins on this product

- Single visual + interaction model across camera and gallery — the broker learns one gesture and trusts it everywhere.
- One code path = one set of edge cases to test = lower bug surface.
- Hardware zoom would let us zoom past digital-crop limits, but the sign-in-sheet capture is read at 1500 px long-edge anyway (see preprocessor cap in `02_PRINCIPLES.md` companion section). The source resolution is far above what zoom × output requires.
- Hardware zoom can be added later as a transparent enhancement if a real device makes it valuable. The gesture surface won't need to change.

---

## 4. UX shape

### 4.1 Live camera path

1. User opens camera, sees the framing surface as today.
2. Two-finger pinch: feed scales centred on the pinch midpoint; pinch + drag reframes during the gesture.
3. Single-finger drag (only available at zoom > 1×): pans within the zoomed view.
4. Boundaries: pan clamps to source-frame edges. Cannot pan into empty space.
5. Pinch back below 1× snaps to fit (with a calm spring, not a hard jump).
6. Shutter tap captures **only the visible region** as a JPEG.

### 4.2 Gallery upload path

1. User taps "Upload from gallery."
2. OS file picker opens (existing behaviour, unchanged).
3. After the file is picked, a new in-app screen mounts with the picked image inside the same pinch+pan surface.
4. Same gesture rules as the camera path.
5. Bottom bar: **"Use this part"** (primary) + **"Pick a different photo"** (secondary).
6. "Use this part" produces the cropped JPEG and hands it to the same downstream path the camera shutter uses.

### 4.3 Page must never zoom during either flow

- `touch-action: none` on the gesture surface so the browser does not interpret the pinch as a page-zoom gesture.
- Viewport meta already disables user-scalable globally; double-check no platform leaks past it.

---

## 5. Phases

Each phase ships independently. Don't bundle.

### Phase 1 — Kill the page-zoom regression

Apply `touch-action: none` and equivalent guards on the camera surface so pinching no longer zooms the page. No new feature added — just stops the broken behaviour. This phase alone resolves the immediate user-reported bug.

### Phase 2 — Build the gesture primitive

New shared component `PinchPanCropSurface`:
- Owns zoom + pan state internally.
- Renders an arbitrary child (the live `<video>` or an `<img>`) scaled and translated by the gesture.
- Exposes `getCropRegion()` returning `{ sx, sy, sw, sh }` in source-image coordinates.
- Self-contained, no app coupling. Unit-tested for boundary clamping, snap-back, multi-touch handling, reduced-motion.

### Phase 3 — Camera integration

- Wrap the live `<video>` in the new surface.
- Update the capture path to read crop coordinates from the surface before drawing to the output canvas.
- No backend changes.

### Phase 4 — Gallery integration

- After file pick, mount the surface with the picked image (decoded via `URL.createObjectURL`).
- Replace the direct `onCaptured(file)` with a "Use this part" button that emits the cropped JPEG via the same path the camera shutter uses.
- Revoke the object URL on teardown.

### Phase 5 — Visual polish

- Soft frame indicating the crop region.
- Smooth pinch easing matching the app's ASMR motion language.
- `prefers-reduced-motion` path: instant snap, no zoom animation.

### Phase 6 — Real-device verification

- iPhone (latest iOS Safari) — primary persona device.
- Android Chrome on a mid-tier device — the Linda perf bar.
- Samsung Internet — second-most-common Android browser.
- Confirm the captured JPEG matches the visible region pixel-for-pixel (Chrome MCP measurement, not eyeballing).
- Confirm the existing AI extraction is unchanged when the broker doesn't zoom (no-op crop = full image).

---

## 6. Edge cases

- **Reduced motion** — no animated transitions; gesture state still works, just snaps without easing.
- **Single-finger drag at zoom = 1×** — disabled. No accidental drift when the user isn't zoomed in.
- **EXIF rotation on gallery uploads** — must be applied **before** the crop-coordinate math. Rotated source = wrong crop without it.
- **Very large gallery images** — decode lazily; revoke object URLs promptly. Don't keep a 50 MP image decoded longer than needed.
- **Multi-touch ending mid-gesture** — finger lifted while still mid-pinch should leave the surface in the last clean state, not snap.
- **No-op gesture** — opening gallery + not zooming + tapping "Use this part" produces the full image. Same as today's behaviour. No regression.
- **Pinch outside the surface** — must not zoom the page. `touch-action: none` on the surface; the rest of the app surface gets the existing viewport-meta guard.

---

## 7. Files to add / change

- **New:** `frontend/src/components/PinchPanCropSurface/` (component + CSS + tests).
- **Edit:** `frontend/src/components/PhotoCapture/PhotoCapture.tsx` — wrap the video in the new surface; add the gallery sub-screen.
- **Edit:** the capture path inside `PhotoCapture.tsx` — read crop coordinates from the surface before `drawImage`.
- **Possibly:** `frontend/index.html` viewport meta tweak, only if a platform leaks pinch past `touch-action: none`.
- **No backend changes.** The image is still preprocessed and sent through the existing pipeline.

---

## 8. Open questions (owner picks before Phase 5)

- Visual chrome for the in-app gallery crop screen — minimal floating bar, or full-bleed with action drawer?
- Reset gesture — double-tap to fit, dedicated button, or no reset?
- Aspect-ratio lock — free-form or constrained to a rectangle? Recommended free-form (sign-in sheets vary in shape).

---

## 9. Not in scope

- Hardware zoom via `MediaStreamTrack.applyConstraints`. Parked as a later transparent enhancement.
- Rotation correction beyond automatic EXIF auto-rotate.
- Multi-photo carousel.
- Cropping aids (grid overlay, edge detection, perspective correction).

---

## 10. Success criteria

- Pinching inside the camera surface zooms the camera feed only. Page does not zoom. Verified on iPhone + Android.
- Captured JPEG bytes match the visible region (verified by measurement, not screenshot).
- Gallery upload presents the in-app crop screen on every platform.
- AI extraction accuracy is unchanged at zoom = 1× (no regression on the baseline path).
- The broker can finish the whole flow in ≤ 30 seconds end to end on a slow 4G mid-tier Android.
