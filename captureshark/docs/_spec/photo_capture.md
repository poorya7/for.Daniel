# Photo capture — durable tech reference

**Last updated:** 2026-05-23 — refreshed agent-pitfalls cross-ref (22–26 after the May 2026 renumber); pointed the production prompt line at `vision_extraction_v1_3_1.txt` (the file the OpenAI adapter actually loads).

The locked architecture for the photo path. The model behind the vision
adapter has changed twice (OpenAI → Doc AI → GPT-5 fast mode) — the
shape below has not. Treat this as the contract every photo-related
change is checked against.

**Companion docs:**
- [`02_PRINCIPLES.md`](02_PRINCIPLES.md) — persona + ASMR feel + perf budget
- [`docs/_dev/07_photo-model-bakeoff.md`](../_dev/07_photo-model-bakeoff.md) — the full bake-off / model-pick story
- [`docs/_tests/photo_capture_bakeoff/`](../_tests/photo_capture_bakeoff/) — raw bake-off CSVs + 9 session evals (the path to the GPT-5 + minimal-reasoning winner that's live in prod)

---

## 1. Production targets

- **Latency:** result returned ≤ 5 seconds for a typical photo.
- **Accuracy:** ≥ 90% of leads captured correctly on clean / lightly worn photos. Heavily damaged photos: best-effort or clean "retake" surface.
- **Cost ceiling:** ≤ $1 / user / month at projected usage (~50 photos / agent / month).
- **Production provider:** swappable behind `VISION_PROVIDER` env var. Today: `openai` (GPT-5 fast mode, image shrink cap 1500 px). Doc AI adapter kept in-tree as a one-env-flip rollback.

The bake-off + LLM-replacement history that produced these targets lives in [`docs/_dev/07_photo-model-bakeoff.md`](../_dev/07_photo-model-bakeoff.md) and the session chapters under [`docs/_tests/photo_capture_bakeoff/sessions/`](../_tests/photo_capture_bakeoff/sessions/).

---

## 2. Architecture

### 2.1 Hexagonal layout

Domain has zero I/O dependencies. Adapters implement ports. Services orchestrate. Routes are thin. The vision provider sits behind `VisionExtractorPort`, so swapping providers is a one-adapter change plus DI wiring in `api/deps.py`.

### 2.2 Domain types

- `PhotoCaptureInput` (`domain/capture.py`)
- `PhotoExtractionRow`, `PhotoExtractionResult`, `VisionExtractorPort` (`domain/vision.py`)
- Image-specific error kinds: `IMAGE_TOO_LARGE`, `UNSUPPORTED_IMAGE`, `IMAGE_DECODE_FAILED`, `IMAGE_TOO_SMALL`, `IMAGE_PREPROCESS_FAILED`, `IMAGE_MODERATION_REFUSED`, `NO_SIGNAL`, `EMPTY_INPUT`

### 2.3 Multi-row from day one

The backend contract emits 0..N `PhotoExtractionRow` objects per photo. The wire is row-aware end-to-end (see §2.4).

### 2.4 Photo SSE contract (locked)

Photo gets its own per-row event vocabulary. Text + voice contracts unchanged.

**Events:**

- **`photo_row`** — one per extracted row, in document reading order. Payload:
  - `row_index` (zero-based, dense, monotonic)
  - `idempotency_key` (server-generated, deterministic, `<capture_id>:<row_index>:<sha8_of_canonical_fields>` — coordinates with the offline-queue adapter's per-row dedupe)
  - Per-field `{value, confidence}` for name / phone / email
  - Aggregated `row_confidence` (min of contact-triple)

- **`photo_done`** — terminal success event. Payload:
  - `status: "ok" | "partial" | "no_signal"`
  - `total_rows` (client validates against rows actually received)
  - `provider` (current provider name; future values when v2 fallback lands)
  - `warnings` (batch-level string codes; `[]` on the clean path)

- **`photo_warning`** — non-terminal advisory. No warning codes ship today; the event exists for future use.

- **`error`** — terminal hard failure (network, upstream 5xx, auth). Unchanged from existing contract.

- **`heartbeat`** — non-terminal "still alive" pulse. Server emits one every ~2 s while the upstream call is in flight. Payload `{}`; carries no semantics beyond its arrival. Client resets its connection watchdog on each one, so the watchdog only fires on real sustained silence (~6 s = 3× the heartbeat interval) — never on a slow-but-alive AI call. Generic across capture types: voice and any future SSE route can opt in by wrapping their stream in `with_heartbeat` (see `backend/src/captureshark/api/sse_heartbeat.py`).

**Contract guarantees:**

- Terminal event always emitted (`photo_done` OR `error`, never both, never neither).
- Rows arrive in document order with no duplicate `row_index`.
- Single-row case uses the same wire (one `photo_row` + one `photo_done`). Uniformity over saving 30 bytes.
- Additive-only versioning. Optional fields may be added; existing fields are never renamed or removed without a new event name.

**Failure semantics:**

- *Zero rows extracted:* `photo_done { status: "no_signal" }`, NOT `error`. Extraction succeeded; the photo just had no readable data. The retake-overlay branches on `status`. `error` is reserved for true failures so the frontend can surface "something broke" vs "try a clearer photo" cleanly.
- *Mid-stream row parse failure (row 2 of 4):* emit `photo_row` for rows 1 / 3 / 4, then `photo_done { status: "partial" }` with a warning code naming the failure. Don't drop the user's data — see `02_PRINCIPLES.md §8`.
- *Hard upstream failure mid-stream:* `error` event as today. Retake overlay surfaces.

### 2.5 Mandatory preprocessor

`adapters/image_preprocessor.normalize` runs before any vision adapter sees the image: magic-number sniff, HEIC decode, EXIF rotate, RGB JPEG, **1500 long-edge cap**, 25 MP cap.

- The 1500 px long-edge cap was tuned in eval session 09; 1500 matched 1600 / 2000 / no-shrink for accuracy and saved bandwidth + latency.
- The 25 MP cap was bumped from 12 MP during the bake-off — standard iPhone photos are 12.19 MP and were failing the original cap.

### 2.6 Capability guard pattern

The service exposes `supports_photo: bool` (true when both preprocessor AND vision adapter are wired). The route checks this *before* opening the SSE response — wrong configuration returns a clean 503 JSON, not a broken mid-stream error. Same guard backported to the voice route.

### 2.7 Backend-deterministic SSE

The service emits per-field SSE deltas in canonical order, NOT raw upstream tokens. Most production vision providers (Doc AI, GPT-5 fast mode) are non-streaming under the hood; the service takes the full structured response and replays it into the SSE vocabulary for the frontend's skeleton-then-fill UX.

### 2.8 Frontend full-bleed camera

Photo is the one capture mode that takes over the full viewport. iOS Safari camera APIs effectively require the viewport to belong to the camera. `<PhotoCapture />` mounts above the rest of the canvas during `state.kind === "photo"` (per the App-canvas state machine in `features/app-state/`).

`getUserMedia` is called **synchronously** from the Photo button's `onClick` handler. Deferring through `useEffect` breaks iOS Safari's user-gesture token. There is also a known StrictMode trap where `track.stop()` inside a useEffect cleanup kills the stream before the permission promise resolves — see `docs/_dev/05_agent-pitfalls.md`.

### 2.9 Other locked rules

- **Server-delete the photo bytes** immediately after extraction.
- **No PII in logs** — names, phones, emails, OCR text, raw model response bodies. Structural metadata only (bytes-in, dimensions, row count, error kind).
- **No client-side content gating** — the photo is a high-investment capture; gate on backend post-OCR, not on frontend pre-upload.
- **`inFlightRef` idempotency** on the capture button — disabling visually isn't enough; on slow renders the tap can land before the disable hits.

---

## 3. UX copy / tone — non-negotiable

Every error or low-confidence surface **owns the difficulty of the photo**, not the user or the system. Distilled from the engineer consults:

- "This sheet is a bit messy — want to try one more photo?" *(0-row / damaged-photo case)*
- "Got the photo, but the writing's hard to read here. Retake, or save what we found?" *(low-confidence case)*
- "Looks a little blurry — try one more shot?" *(blur detected)*

**Avoid:** "Error," "Failed," "Couldn't process," "Invalid image," "unsupported," "We couldn't read this." Those read as the system or user being at fault. The right tone is **calm + collaborative + clear next step**.

Low-confidence individual fields in the review UI get a yellow indicator with "we weren't sure about this" rather than a red "error" pill. Confidence is not failure.

---

## 4. v2 parking lot — architecture / UX, not model swaps

Model-swap candidates (LLM fallback, custom-trained Doc AI, etc.) live in [`docs/_dev/07_photo-model-bakeoff.md`](../_dev/07_photo-model-bakeoff.md). This section is the architecture / UX ideas parked for after launch.

### 4.1 Lightweight preprocessing

Optional thin pre-processing pass before the vision adapter — grayscale + CLAHE, denoise, deskew, mild sharpen. Can turn many "slightly worn" photos into "clean" for the adapter's purposes. Heavy preprocessing destroys real handwriting texture; stay light, no binarization or aggressive thresholding. Test before shipping.

### 4.2 Hybrid merge strategies

If a v2 LLM fallback ships, the merge between the primary adapter's rows and the fallback's rows is non-trivial. Initial heuristic from the engineer consult:

- **Prefer primary** when: high confidence, validates cleanly, row alignment is clear.
- **Prefer fallback** when: primary missed a row, malformed email / phone, split one row into two, merged two rows together.
- **Mark for review** when: models disagree, partial value, name without contact, contact without name.

Initial confidence thresholds (tune against production):
```
maxMissingContactRate = 0.30
maxInvalidEmailRate   = 0.25
maxInvalidPhoneRate   = 0.25
minAverageFieldConfidence = 0.72
```

### 4.3 Hallucination tracking

A fabricated lead is worse than a missed lead — it silently poisons the user's sheet. The bake-off scorer classified `extra_row` separately from `missed_row` for exactly this reason. Production doesn't currently surface a "model invented this" signal to the user. Worth adding once there's telemetry on how often it happens.

### 4.4 Schema / row-association safeguards

Wrong-name-with-right-phone is `bad_row` — a worse error than `missed_row`. In production this manifests as a row that *looks* right but has Mary's phone next to John's name. Layout-based row-clustering helps but isn't bulletproof. Future ideas:

- Detect rows where contact info doesn't match an obvious name nearby.
- Surface "this looks like a mismatch" review flags.
- Log row-level positional confidence for offline analysis.

---

## 5. Known unknowns / pre-launch checklist

Verify before claiming a production accuracy number externally:

- [ ] **Real-cursive bake-off** — every tier in the bake-off used font-rendered handwriting with jitter. Real human cursive (stroke-pressure variation, slant, ligature differences) shifts accuracy ±10pp. Full procedure in the bake-off doc.
- [ ] **Multiple phone makes / models** in the test corpus (currently single-iPhone-only).
- [ ] **User-error edge cases** tested: finger over lens, motion blur, two-sheets-overlapping, vertical orientation, photo of the sheet's back. No accuracy targets — just need graceful failure modes and clear retake prompts.
- [ ] **Production telemetry** to measure the `0 rows` rate. If it's much higher than the bake-off suggests, the photo conditions in the wild are different and v2 LLM fallback should ship sooner.
- [ ] **Privacy disclosure** mentions the vision provider by name. Verify the provider's data-retention configuration before launch.

---

## 6. Pointers

- Preprocessor: `backend/src/captureshark/adapters/image_preprocessor.py`
- Production prompt (LLM adapters): `backend/src/captureshark/prompts/vision_extraction_v1_3_1.txt` (v1.3.1 — loaded by `_PROMPT_FILENAME` in `openai_vision_extractor.py`). The older `vision_extraction_v1.txt` is kept around for historical comparison.
- DI wiring (which adapter the route gets): `backend/src/captureshark/api/deps.py`
- Domain types: `backend/src/captureshark/domain/vision.py`, `domain/extraction.py`
- Photo route: `backend/src/captureshark/api/routes/captures.py`
- Photo service: `backend/src/captureshark/services/extraction_service.py`
- Photo frontend:
  - `frontend/src/components/PhotoCapture/PhotoCapture.tsx` — the camera surface UI
  - `frontend/src/features/photo-capture/usePhotoCaptureSession.ts` — the hook that owns camera lifecycle, watchdog, multi-row collection, and the save-all + offline raw-photo paths
  - `frontend/src/App.canvas.tsx` — orchestrator; renders `<PhotoCapture />` when `state.kind === "photo"`
  - `frontend/src/lib/api.ts` — `streamPhotoCaptureRows` SSE client
- SSE heartbeat helper: `backend/src/captureshark/api/sse_heartbeat.py`
- Agent pitfalls (photo-specific traps in items 22-26): `docs/_dev/05_agent-pitfalls.md`
