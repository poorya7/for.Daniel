# Live captions during voice capture — tech reference

**Last updated:** 2026-05-23 — small `ReviewCard` → `LeadReviewCard` rename in the phase-B telemetry implementation order (no behavioural change; the canvas migration renamed the component).

**Status:** Shipped 2026-05-15. **Currently default OFF in code** (see
"Privacy & DPA reality" below for why). Flipping back to ON requires
upgrading the AssemblyAI account to paid (pay-as-you-go) and emailing
`data-opt-out@assemblyai.com` to opt out of model training — both
gated on the lawyer-review milestone when paid customers arrive.

Pipeline is code-complete and field-tested. Whisper batch is the
fallback and the current default voice path while the flag is OFF.

Companion to:
- [`02_PRINCIPLES.md`](../_workflow/02_PRINCIPLES.md) — persona, ASMR, perf bar
- [`/docs/_dev/05_agent-pitfalls.md`](../_dev/05_agent-pitfalls.md) — gotchas across the repo
- [`/docs/_dev/09_TODO.md`](../_dev/09_TODO.md) — parked follow-ups

---

## TL;DR

- Provider: **AssemblyAI Universal-3 Pro Streaming** (`u3-rt-pro`). Picked after a 186-clip bakeoff on ElevenLabs-generated broker dictations. Tied or beat the field on phone-digit + name + budget accuracy; competitive on first-partial latency.
- Architecture: browser captures raw 16 kHz Int16 PCM via `AudioWorklet`, streams it to AssemblyAI over WebSocket using a **short-lived temp token minted by our backend**. Raw AssemblyAI API key never reaches the browser.
- AssemblyAI is the **single source of truth** for both the live captions AND the final transcript that feeds extraction. No dual pipeline. Whisper batch exists ONLY as a fallback when the WebSocket can't connect or drops mid-session.
- UI: stable-partial buffer (~200 ms) + interim partials at light/muted weight + finalised turns at full weight. **Not** word-by-word karaoke — Universal-3 Pro emits stable segments at ~3 s cadence with `continuous_partials=true`.
- Fallback: WebSocket connect fails / drops → silently fall back to MediaRecorder → Whisper batch. The user sees no error UI for the swap.
- Flag: `LIVE_CAPTIONS_ENABLED` (env + code default). Currently `False` — flip to `True` ONLY after the paid upgrade + opt-out email is on file (see "Privacy & DPA reality").

---

## Code surface map

### Backend

- `backend/src/captureshark/config.py` — `live_captions_enabled` flag + `assemblyai_api_key`.
- `backend/src/captureshark/api/routes/features.py` — `GET /api/v1/features` exposes the flag to the frontend at boot.
- `backend/src/captureshark/domain/live_captions.py` — `LiveCaptionTokenPort` + `LiveCaptionTokenOutcome` + error kinds.
- `backend/src/captureshark/adapters/assemblyai_token_provider.py` — mints temp tokens via AssemblyAI's `GET /v3/token` REST endpoint.
- `backend/src/captureshark/services/live_captions_service.py` — policy gate (flag + key) + adapter dispatch.
- `backend/src/captureshark/api/routes/live_captions.py` — `POST /api/v1/captures/live-token` (404 when the flag is off, 503 when no key, 502 on upstream fail).
- `backend/src/captureshark/api/routes/live_captions_telemetry.py` — phase-A session telemetry sink (logs only).
- `backend/tests/unit/test_assemblyai_token_provider.py` + integration tests.

### Frontend

- `frontend/src/lib/liveCaptions/pcm-capture-worklet.js` — `AudioWorklet` that downsamples mic input to 16 kHz Int16 PCM and posts 50 ms chunks to the main thread.
- `frontend/src/lib/liveCaptions/audioCapture.ts` — wraps the worklet + mic stream lifecycle.
- `frontend/src/lib/liveCaptions/assemblyaiClient.ts` — opens the AssemblyAI WS, parses Turn / Begin / Termination messages, exposes `sendPcm` / `forceEndpoint` / `terminate`.
- `frontend/src/lib/liveCaptions/stablePartialBuffer.ts` — paints append-only growth immediately, holds real revisions for ~200 ms.
- `frontend/src/lib/liveCaptions/useLiveCaptions.ts` — React hook orchestrating start / stop / finalize + phase-A telemetry recorder.
- `frontend/src/lib/liveCaptions/sessionTelemetry.ts` — collects + submits the phase-A record.
- `frontend/src/stores/features.ts` — Zustand store exposing `useLiveCaptionsEnabled()`.
- `frontend/src/components/CanvasVoice/CanvasVoice.tsx` — the voice surface that will host the captions hook + the one-time "Just so you know" disclosure on first voice tap. **Currently NOT wired to `useLiveCaptions`** — the post-CaptureSheet migration left captions parked until the paid AssemblyAI upgrade lands. See `docs/_dev/09_TODO.md` ("Live captions on the canvas voice surface").
- `frontend/src/test-pages/LiveCaptionsTestPage.tsx` — debug page at `?test=live-captions`. Raw stream events + copy-log button. Use when tuning AssemblyAI params.

### Bakeoff harness (vendor-swap insurance)

- `docs/_tests/stt_bakeoff/bakeoff.py` — orchestrator (`prep` / `run` / `score`).
- `docs/_tests/stt_bakeoff/_aggregate.py` — per-provider averages across all clips.
- `docs/_tests/stt_bakeoff/providers/` — per-provider streaming clients (AssemblyAI, Deepgram, OpenAI gpt-4o-transcribe, OpenAI realtime-whisper, Whisper-1 batch, Google Cloud Speech-to-Text V2).
- `docs/_tests/stt_bakeoff/samples/` — synthetic broker dictations (mp3 + ground-truth .json + .txt). **Gitignored.** Treat as PII even though synthetic.
- `docs/_tests/stt_bakeoff/vendor-docs/` — captured streaming-API references (AssemblyAI, OpenAI, Deepgram, ElevenLabs). Look here before guessing from training data.

---

## Architectural decisions (DON'T relitigate)

These were settled across three rounds of senior-engineer review + field testing. If they need revisiting, surface the reason explicitly rather than rolling them back silently:

1. **AssemblyAI Universal-3 Pro stays.** Bakeoff winner on accuracy-primary (phone digits / names / budgets). Cadence concern was resolved by `continuous_partials`, not by switching providers.
2. **Single source of truth.** AssemblyAI drives BOTH live captions AND the final transcript that feeds extraction. No dual pipeline. The dual-pipeline option was rejected because reconciliation visibly changed text post-stop ("Mariah" → "Maria") and killed trust.
3. **Browser → AssemblyAI direct via temp token.** Audio never proxies through our backend. Raw API key never reaches the browser.
4. **No word-by-word UI promise.** U3-Pro emits stable segments at ~3 s cadence; UI shows interim partials light/muted + finalised full weight. Don't introduce karaoke / FaceTime expectations in product copy.
5. **No Web Speech API fallback.** Flaky, network-dependent. Off the table even as degraded mode.
6. **No offline audio buffering.** Online-first. If network drops mid-recording, degrade to MediaRecorder → Whisper batch when signal returns.
7. **Whisper batch stays in the codebase as the fallback** — and currently as the default path while the flag is OFF.

---

## AssemblyAI connection params (the cadence fix)

Universal-3 Pro defaults to sparse, stable partials — fine for short utterances, but during fast continuous speech a single turn can run 16 s before the first partial fires. Both round-3 engineers independently converged on `continuous_partials=true` as the fix.

Baseline params used in `frontend/src/lib/liveCaptions/assemblyaiClient.ts`:

```ts
{
  sample_rate: 16000,
  encoding: "pcm_s16le",
  speech_model: "u3-rt-pro",
  format_turns: true,
  include_partial_turns: true,

  continuous_partials: true,     // mid-turn partials every ~3 s
  interruption_delay: 0,         // first partial as early as possible (~300 ms server floor)
  min_turn_silence: 100,
}
```

On user-stop, send `{"type": "ForceEndpoint"}` over the same WebSocket before terminating — saves up to `max_turn_silence` of dead time waiting for the final.

### Knobs that DON'T work for U3-Pro

- `end_of_turn_confidence_threshold` is a **no-op** for U3-Pro. The model uses punctuation-based turn detection, not the confidence-threshold mechanism of older Universal-Streaming models. Don't bother tuning it; remove it from any param set you find it in.
- Lowering `min_turn_silence` only affects when silence-based partials fire. During continuous speech there IS no silence, so silence-based partials don't fire regardless of the threshold. `continuous_partials` is the only knob that matters for the long-turn case.

---

## UI behaviour

### Phases

1. **Idle** (before first partial) — calm waveform/breathing indicator. No "Listening…" text.
2. **Partial** — interim text at ~60% opacity / lighter weight. Each new partial **replaces** the active preview (it carries the full turn-so-far; do NOT append).
3. **Finalised** — full opacity / normal weight. ~150 ms ease between states.

### Stable-partial buffer

Paints append-only growth immediately; holds genuine revisions for ~200 ms before rendering. Kills the "Maria → Mariah → Maria" flicker without making the captions feel laggy.

### Reduced-motion

The component skips the fade and renders at final opacity. Handled in CSS via `prefers-reduced-motion: reduce` — no JS branch needed.

### Empty / no-speech / connection drop

- Empty → keep today's calm bounce-back ("Didn't catch that — try once more").
- WS connect fails within 1.5 s → silent fallback to MediaRecorder → Whisper batch. No error UI.
- WS drops mid-session → keep recording locally, hide the partial preview, finalise via batch on the same MediaRecorder blob we've been collecting in parallel.

The capture flow must NEVER break because of a streaming-provider outage. Live captions are a polish layer; lead capture is the product.

---

## iOS Safari / PWA specifics

- **Mic permission.** iOS PWAs don't reliably remember `getUserMedia` permission across sessions. On voice-phase mount, if `navigator.permissions.query({name: "microphone"})` reports `prompt`, show the "Just so you know" overlay first so the prompt feels expected.
- **Lock-screen / visibility-hidden.** iOS kills the audio stream when the page goes hidden. Detect `visibilitychange: hidden`, stop the recording cleanly, finalise via the batch path, surface a calm "recording stopped (phone locked)" message. Don't pretend it kept going.
- **MediaRecorder auto-`onstop`** during silence is real — see pitfalls #19 (`intentionalStopRef`).
- **No IndexedDB audio buffering** on the voice path. Online-first.

---

## Privacy & DPA reality (corrected 2026-05-15)

Earlier drafts of the plan framed AssemblyAI compliance as "self-serve dashboard toggles, afternoon's work, free." That was wrong. The verified facts, with verbatim sources:

### What's actually true

1. **DPA is automatic via ToS.** AssemblyAI:
   > "You automatically agree to a Data Processing Addendum (DPA) as part of our terms of service. You do not need to sign a separate agreement."
   ([source](https://www.assemblyai.com/docs/faq/can-i-sign-a-dpa-agreement-with-assemblyai))

2. **Model-training opt-out is email-based AND paid-tier only.** Email `data-opt-out@assemblyai.com` from the account email. Verbatim from AssemblyAI:
   > "Free users do not have the ability to opt out of model improvement program."
   > "Opt-out requests are forward-looking only."
   ([source](https://www.assemblyai.com/docs/faq/how-to-opt-out-of-data-sharing-for-our-model-improvement-program))

3. **Streaming zero-retention is coupled to opt-out.** Same gate as #2 — paid tier first. ([source](https://www.assemblyai.com/docs/data-retention-and-model-training))

4. **US data zone — already there by default.** The default endpoint (`api.assemblyai.com`, `streaming.assemblyai.com`) processes in AWS us-west-2. There is no "US data zone selector" because there is no toggle to find. EU is the opt-in variant (`api.eu.assemblyai.com`). ([source](https://www.assemblyai.com/docs/pre-recorded-audio/select-the-region))

5. **No dashboard toggles for any of this at any tier.** Paid customers see the same dashboard as free customers — the only thing that changes with paid is *eligibility to send the opt-out email*. The mechanism doesn't get fancier with tier.

### Why the flag is currently OFF

We are on AssemblyAI's free tier. AssemblyAI's data-retention doc says:

> "We will not use files you submit for model training if you are subject to a Business Associate Addendum, are utilizing our European servers, or if you have opted out from model training."

We are none of those three. So audio/transcripts streamed to AssemblyAI from this account are eligible for use in their model improvement program (subject to their best-effort PII redaction, which is not guaranteed and doesn't cleanly map to GLBA NPI like spoken budget figures). For a lead-capture app, that's not acceptable beyond owner-only test data.

Engineer recommendation (both round-3 reviewers converged): keep `LIVE_CAPTIONS_ENABLED=false` by default until the account is upgraded to pay-as-you-go AND opt-out is confirmed in writing. Until then, voice capture rides the Whisper batch path.

### Whisper privacy posture (the current default path)

While the flag is OFF, voice goes to OpenAI Whisper instead. Their official policy:

> "Your data is your data. As of March 1, 2023, data sent to the OpenAI API is not used to train or improve OpenAI models (unless you explicitly opt in to share data with us)."

For audio transcription specifically: **no retention even for abuse monitoring** ([source](https://developers.openai.com/api/docs/guides/your-data)). So the current default path is actually the cleaner privacy posture; the flag flip back to ON is gated on AssemblyAI getting to the same place.

### Broker consent overlay

A one-time "Just so you know" overlay shows the first time a broker hits the voice phase — regardless of which transcript path runs. Audio leaves the device either way, so consent is always required. Copy is plain English ("we send your audio to an AI in the US to turn it into text. They don't keep it.") — accurate for Whisper today and remains accurate post-AssemblyAI-opt-out.

### Lawyer review

Parked for when paid customers arrive (~$500 one-shot consultation, not a recurring engagement). Will bundle with the AssemblyAI paid upgrade + opt-out + the BAA-vs-GLBA conversation.

---

## Telemetry

### Phase A — session-level (SHIPPED)

One record per live-captions session. Logs only — no analytics destination wired yet. Tail FastAPI stdout to read; each session is a JSON-ish record with `lc_*` fields.

**Recorded:** outcome (`streamed` / `empty` / `error` / `stopped`), session ID, total duration, first-partial latency, partial count, P90/max inter-partial gap, final transcript length (chars only — no text), error tag, user-agent. Schema is `extra="forbid"`; no transcript, no audio, no extracted field values.

**Code:**
- Backend route: `backend/src/captureshark/api/routes/live_captions_telemetry.py`
- Frontend collector: `frontend/src/lib/liveCaptions/sessionTelemetry.ts`
- Backend tests: `backend/tests/integration/test_live_captions_telemetry.py`
- Frontend tests: `frontend/src/lib/liveCaptions/sessionTelemetry.test.ts`
- Hook wiring: `frontend/src/lib/liveCaptions/useLiveCaptions.ts`
- API client helper: `frontend/src/lib/api.ts::reportLiveCaptionsTelemetry`

### Phase B — correction-rate (PARKED)

"Did the broker edit any extracted field before saving?" — joined to phase A via the session ID. Best proxy for accuracy short of a quarterly manual audit.

Parked because:
1. Solo-dev pre-revenue — no real users yet, signal would be near-zero.
2. No analytics destination picked.
3. Touches shared files (`App.canvas.tsx`, `LeadReviewCard.tsx`) — overlaps with the photo-capture agent's territory.

**Note this is *correction rate*, not "implicit WER."** Brokers only correct mistakes they NOTICE; a wrong digit in a phone number that still routes a call may never be corrected. Pair with a quarterly manual audit on a small sampled set.

**Implementation order (when picked up):**
1. Expose `sessionId: string | null` from `useLiveCaptions`.
2. Thread it through `CanvasVoice` → `App.canvas.tsx` → `LeadReviewCard` via `onCapturedTranscript`.
3. Add backend route: `POST /api/v1/telemetry/live-captions/correction` (bounded schema: `session_id` + `field_key` + `edited_at`; no values).
4. Wire frontend correction event into `LeadReviewCard.onCommitEdit`, dedupe per field per session.
5. Type-check + tests + commit + push as ONE slice.

### Destination decision (PARKED)

| Option | Effort | Notes |
|---|---|---|
| Keep logging only + grep / `jq` | Zero | Fine while traffic is near-zero. |
| Local SQLite table | ~half-day | Cheapest "real" home. Queryable. No external service. |
| Sentry | ~1 hour | Errors yes, custom metrics weak. |
| Logfire (Pydantic's) | ~1 hour | Aligns with FastAPI / Pydantic stack. Free tier covers small scale. |
| Datadog / New Relic / Honeycomb | ~half-day | Overkill at current scale. |

Recommendation: **SQLite when picked up** (local, private, queryable, no vendor lock-in). Revisit once there's enough traffic for real dashboards.

---

## Re-running the bakeoff (vendor-swap insurance)

Re-run quarterly with a fresh ~30 min broker audio sample. Diff scores against the previous quarter; flag any >2-point regression on phone-digit accuracy as a swap trigger.

```powershell
# Re-prep ground truth if scripts have changed (otherwise skip).
.\backend\.venv\Scripts\python.exe docs\_tests\stt_bakeoff\bakeoff.py prep `
  --samples-dir docs\_tests\stt_bakeoff\samples

# Run all providers. NOTE: --provider X is IGNORED when --all is set;
# --all means EVERY provider runs. To run just one, omit --all and
# pass --audio <one-file>, or remove others from _KNOWN_PROVIDERS.
.\backend\.venv\Scripts\python.exe docs\_tests\stt_bakeoff\bakeoff.py run --all `
  --samples-dir docs\_tests\stt_bakeoff\samples

# Per-clip scoring.
.\backend\.venv\Scripts\python.exe docs\_tests\stt_bakeoff\bakeoff.py score `
  --samples-dir docs\_tests\stt_bakeoff\samples

# Aggregate across all clips.
.\backend\.venv\Scripts\python.exe docs\_tests\stt_bakeoff\_aggregate.py `
  docs\_tests\stt_bakeoff\samples
```

### Env keys needed in `.env`

- `OPENAI_API_KEY` (Whisper + gpt-4o-transcribe)
- `ASSEMBLYAI_API_KEY`
- `DEEPGRAM_API_KEY`
- `GOOGLE_SERVICE_ACCOUNT_PATH` — service-account JSON for a project with **Cloud Speech-to-Text API enabled** and the service account granted **`Cloud Speech Editor`** role. The "Cloud Speech Client" role is V1-only and lacks `speech.recognizers.recognize` — the smoke test 403s if you pick the wrong role.

### Bakeoff result snapshot (2026-05-15, 186 clips)

| Provider | Phone | Name | Budget | WER | First partial (median) |
|---|---|---|---|---|---|
| whisper-batch (baseline) | 79.0% | 92.7% | 71.0% | 0.232 | — |
| **assemblyai (PICKED)** | **78.5%** | **95.2%** | **71.0%** | **0.232** | **959 ms** |
| deepgram | 74.7% | 94.1% | 69.4% | 0.250 | 1016 ms |
| openai-gpt4o-streaming | 78.0% | 94.6% | 73.1% | 0.234 | 666 ms |
| openai-realtime-whisper | 5.9% | 91.4% | 84.9% | 0.180 | 1050 ms |
| google (re-verify run) | 69.9% | 92.5% | 22.9%* | — | 503 ms |

*Budget delta vs the morning run was a ground-truth regeneration artifact, not a provider regression. Re-baseline the ground-truth before the next quarterly run.

### Why each non-winner was eliminated

- **openai-realtime-whisper** transcribes "five five five twelve thirty four" literally instead of normalising to "555-1234". 5.9% phone accuracy is disqualifying.
- **deepgram** is fine but ~4 points behind on phone accuracy. Stays in the harness as the natural swap-in if AssemblyAI regresses.
- **openai-gpt4o-streaming** isn't true live streaming — it's `stream=True` on a completed file upload (deltas arrive 666 ms after the server starts processing, not after the broker started speaking). Doesn't deliver the karaoke effect.
- **google** is fastest first-partial but ~8 points behind AssemblyAI on phone accuracy. Plan's rubric is accuracy-primary.

---

## Open questions / things to confirm before the flag flips back

When the time comes to upgrade + opt out, also send AssemblyAI support these in one ticket so the lawyer-review packet is complete:

1. **Confirm streaming endpoint stays in US.** The `select-the-region` docs cover pre-recorded only. Get one sentence in writing: *"streaming traffic on the default `streaming.assemblyai.com` endpoint is processed in AWS us-west-2 only."*
2. **PII redaction scope on free-tier streaming.** What specifically does the redaction process cover? Does it remove financial NPI (e.g., spoken budgets like "six hundred k") or only standard PII fields (names, phones, emails)? Useful to have on file for the lawyer review.
3. **Confirm Streaming zero-retention applies after opt-out.** Cross-check the support article wording against the actual contract.

Other items kept on the backlog (see `docs/_dev/09_TODO.md`):
- Telemetry phase B + destination pick (when real users exist).
- Quarterly bakeoff re-run with consent for the corpus audio.
- "Keyterm prompting" experiment — AssemblyAI lets you pre-load domain words (street names, agent vocabulary). Skipped on day 1; revisit if broker-specific words get misheard at scale.

---

## Acceptance criteria carried forward

The original plan's pilot exit criteria, restated here for the post-flag-flip moment:

- Live-caption fallback rate < 5% of sessions.
- Review-phase correction rate ≤ today's Whisper-batch correction rate (phase-B telemetry needed to measure).
- P90 first-partial-on-screen latency < 1.2 s from start of speech.
- P90 inter-partial gap during continuous speech ≤ 4 s (target ~3 s, allow 1 s slack for network + processing).
- No regression in the existing Whisper-batch voice flow when the flag is off (regression tested before each release).
