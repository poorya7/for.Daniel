# CaptureShark — TODO / Ideas

**Last updated:** 2026-05-23 — added 2 entries surfaced during the docs-cleanup review pass (no CI, in-memory cost-cap state). Earlier same-day: 4 entries from the May 2026 refactor's "smaller smells" pass (framer-motion bundle audit, lead-worth-saving consolidation, dead Lead.ts constant, App.canvas.tsx module-scope cache), and `App.tsx` / `ReviewCard.tsx` rename in the live-captions telemetry item.

Persistent backlog. Things that aren't urgent enough for the polish pass but worth remembering. Differs from [`docs/_dev/03_polish_pass.md`](_dev/03_polish_pass.md) in that *that* doc tracks issues we'll definitely fix before v1; this one is for "nice to have / maybe one day" ideas.

> **🚨 2026-05-17 note:** the "Photo capture v2 — LLM fallback for damaged photos" entry below has been promoted out of TODO and is now actively being implemented as **Slice E** (LLM replacement, not fallback — Doc AI proved broken on real-world structural layouts). See [`docs/_spec/photo_capture.md`](_spec/photo_capture.md) for the current photo architecture reference. The "custom-train Doc AI" and "lightweight Doc AI preprocessing" entries are moot if we ship the LLM swap (Doc AI exits the prod path) — keeping them for history.

---

## Live captions on the canvas voice surface

Bring the legacy AssemblyAI Universal-3 streaming captions over to the cream canvas voice phase.

**Why:** the legacy app showed live STT text as the user spoke — comforting feedback that recording is working, useful in noisy open-house environments. The canvas voice port deliberately omitted it to keep the structural migration simple.

**How:** the existing `lib/liveCaptions/useLiveCaptions.ts` hook + the AssemblyAI session plumbing all still exist. Wire it into `CanvasVoice` with the cream-themed caption strip below the mic.

**Logged:** preserved from the no-panel-migration handover (2026-05-22).

---

## Optional "Original note" column in the user's sheet

Add the captured original input (text / voice transcript / OCR'd photo text) as an opt-in column in the user's sheet.

**Why:** audit trail when the AI extracts wrong — Linda can see what she actually said versus what landed in the row. Useful for "I knew I said X" disputes and for users who want a second copy of the source.

**How:**
- Default OFF — most users want a clean sheet.
- Surface as a mapping option on the column-confirmation screen ("Add a column for the original note?").
- Mechanically: extend the writer's payload with `original_note`, register as another `LeadField` in the mapping system. The existing column-projection logic handles the rest — if the user doesn't map it, nothing gets written.

**Logged:** 2026-05-10 by project owner.

---

## Photo path — gate after OCR on backend, not on frontend

When the photo path lands (step 8), skip any client-side gating. A photo is high physical investment — point, frame, shoot — and a frontend block would reject legit captures (blurry-but-readable, partial sheets) that OCR can still extract from. Run the same `no_signal` check post-OCR that the voice path runs post-Whisper.

**Logged:** 2026-05-14, from the second-opinion review on input gating.

---

## Beautiful submit → review waiting state

If the LLM round-trip felt like 600ms instead of 3 seconds, half the value of input gating evaporates. A calm, clearly-progressing waiting state means even an accidentally-sent garbage submission is forgivable.

**How:** streaming-first paint (show the review card with skeleton fields the moment we hit submit, fill in as deltas arrive), tighter visual progress cues, and a "still working…" cue at ~2s for slow paths.

**Logged:** 2026-05-14.

---

## "Add a name or detail" hint after stalled typing — revisit if real users complain

Deliberately skipped from v1 of the input gate. The dim Extract button alone is the affordance. If real users find it mysterious, add a one-line gentle hint that fades in once after ~3s of stalled typing in below-threshold state. Never animated repeatedly, never scolding. One-shot per session.

**Logged:** 2026-05-14.

---

## Live captions — flip back ON after paid upgrade + opt-out

The live-captions pipeline (AssemblyAI Universal-3 Pro Streaming) is shipped and code-complete but **currently default OFF** because the free tier makes audio/transcripts training-eligible per AssemblyAI's ToS. Voice capture currently rides the Whisper-batch fallback path, which is fine privacy-wise (no training, no retention) but loses the karaoke wow moment.

**When to flip back ON:**

1. Upgrade the AssemblyAI account to pay-as-you-go (no minimum tier; the dashboard pricing page is at <https://www.assemblyai.com/app/pricing>).
2. From the account email (`dev@captureshark.com`), email `data-opt-out@assemblyai.com` asking to opt out of model training. Forward-looking only — opt out BEFORE flipping the flag.
3. Save the written confirmation in a compliance folder.
4. Open one AssemblyAI support ticket asking for:
   - confirmation that `streaming.assemblyai.com` traffic stays in AWS us-west-2 (the public docs only cover this explicitly for pre-recorded);
   - what their free-tier PII redaction covers — specifically whether it removes financial NPI like spoken budgets, not just standard PII (names, phones, emails).
5. Flip `LIVE_CAPTIONS_ENABLED=true` in `.env` (or remove the env override so the code default applies — but note the code default is also currently `False`; revert that in `backend/src/captureshark/config.py` once compliance is on file).

**Bundle with:** the lawyer consultation that lands the same moment paid customers arrive. The lawyer reviews the AssemblyAI posture + Whisper posture + broker consent flow + privacy policy together.

**Don't:** flip the flag back ON without the opt-out confirmation in writing. The whole point of the OFF default is that free-tier audio is training-eligible.

Full tech reference: [`_spec/live_captions.md`](_spec/live_captions.md). Pitfall #27 in [`_dev/05_agent-pitfalls.md`](_dev/05_agent-pitfalls.md) documents the "self-serve dashboard" myth.

**Logged:** 2026-05-15.

---

## Live captions telemetry — phase B (correction-rate)

Phase A (session-level: latency, cadence, fallback rate, errors) is shipped, logs only. Phase B — "did the broker edit any extracted field before saving?" joined to the session via session ID — is the only proxy for accuracy short of a manual audit.

**Why parked:** solo-dev pre-revenue, no real users yet → signal would be near-zero. No analytics destination picked. Touches shared files (`App.canvas.tsx`, `LeadReviewCard.tsx`) that overlap with the photo-capture agent's territory.

**Pick up when:** real users are actually capturing leads (not just the owner testing) AND a destination is picked. SQLite recommended.

**Note:** label this "correction rate" in dashboards, NOT "implicit WER." Brokers only correct mistakes they NOTICE; biased low. Pair with a quarterly manual audit on a small sampled set.

Implementation order documented in [`_spec/live_captions.md`](_spec/live_captions.md) §Telemetry.

**Logged:** 2026-05-15.

---

## Quarterly bakeoff re-run — vendor-swap insurance

After live captions ship for real (post flag-flip back to ON), re-run the bakeoff harness quarterly with a fresh ~30 min broker audio sample. Diff scores against the previous quarter; flag any >2-point regression on phone-digit accuracy as a swap trigger.

**Before each re-run:**
- Get explicit broker consent for the corpus audio (PII).
- Rotate the sample set every 2 quarters so we're not over-fitting to the same voices.
- Re-baseline the ground-truth JSONs if the harness scoring scripts changed (the 2026-05-15 PM run had a budget-column drift from a ground-truth regeneration).
- Re-confirm Google Cloud's service account still has `Cloud Speech Editor` (not Client — pitfall #26).

Harness lives in `docs/_tests/stt_bakeoff/`. Re-run commands documented in [`_spec/live_captions.md`](_spec/live_captions.md) §"Re-running the bakeoff."

**Logged:** 2026-05-15.

---

## AssemblyAI keyterm prompting — revisit if broker words get misheard

AssemblyAI Universal-3 Pro supports "keyterm prompting" — pre-loading domain words (street names, common first names, agent-specific vocabulary) to bias the recognizer. Skipped on day 1 because the bakeoff didn't show a need.

Revisit if small-town street names or unusual first names start showing up misheard at scale. Implementation is a single connection-param change; the cost is correctness regression risk, so it needs its own narrow test.

**Logged:** 2026-05-15.

---

## Photo capture v2 — LLM fallback for damaged photos

V1 ships **Doc AI only**. Heavily damaged photos (coffee stains, deep creases, etc.) currently surface a calm "retake?" prompt instead of running an LLM fallback. If real users report unrecoverable cases where retaking isn't possible, add a fallback.

**Best candidate from the bake-off:** Gemini 2.5 Pro — 39% on trashed photos at ~$0.016/photo (about 5× cheaper than Claude Opus 4.7, which scored 44% at ~$0.08/photo at current rates). Confidence gate: trigger fallback only when Doc AI returns 0 rows or mean field confidence below threshold — don't fall back on every photo (kills the latency advantage).

Full reasoning + architecture in [`_dev/07_photo-model-bakeoff.md`](_dev/07_photo-model-bakeoff.md).

**Logged:** 2026-05-16, from the photo bake-off review.

---

## Photo capture v2 — custom-train the Doc AI processor

Doc AI Form Parser was tested with its **pre-trained** processor. Once you have ~50 real photos from early customers, train a custom processor — Google's own benchmarks suggest 5-10pp accuracy bump on the specific form layouts you train against. Training is a Cloud Console UI flow + 20-50 labeled photos.

**Caveat:** custom training adds little on standard table layouts with neat in-cell printing — the pre-trained model already nails those. The win is on cursive variants and unusual form layouts. So pair this with the real-cursive bake-off (next entry) before deciding.

**Logged:** 2026-05-16.

---

## Photo capture pre-launch — real-cursive bake-off

**The biggest blind spot in the v1 bake-off.** All models were tested against font-rendered handwriting with jitter. Real cursive has stroke-pressure variation, ligature differences, slant inconsistency — none of which fonts reproduce. Expect absolute accuracy ±10pp on real cursive; relative model ranking may or may not hold.

Before claiming any production accuracy number externally: print ~30-50 sheets, get 20-30 real humans to fill them in with varying pens/styles at normal photo conditions, re-run the bake-off harness. If the rankings flip, revisit the v1 choice (Doc AI).

**Logged:** 2026-05-16.

---

## Photo capture v2 — lightweight image preprocessing

Engineer 01 recommended a thin pre-processing pass before Doc AI: grayscale + CLAHE contrast + light denoising + simple deskew. Can turn many "slightly worn" photos into "clean" for Doc AI's purposes.

**Catch:** heavy preprocessing destroys handwriting texture. Stay light — no binarization, no aggressive thresholding, no sharpening that creates fake strokes. Worth a small A/B in v2 once real-world telemetry shows how often Doc AI struggles.

**Logged:** 2026-05-16.

---

## Photo capture v2 — Sonnet 4.6 investigation

Anthropic Sonnet 4.6 errored on every trashed photo in the v1 bake-off (25/25 `api_status_error`, ~400ms each — way too fast to be real failures). Could be a wiring bug in our candidate adapter, a content-policy false positive on the damaged forms, or a transient rate-limit cascade. Treat Sonnet's 0% on shady_real as "no data" rather than a real failure rating.

If it turns out to be real Sonnet behavior, no action needed. If it's a wiring bug, Sonnet might be a viable v2 fallback at ~$0.035/photo (cheaper than Opus, comparable accuracy).

**Logged:** 2026-05-16.

---

## Photo capture v2 — hallucination tracking

The v1 bake-off classified "fabricated rows" (model invented a person not on the sheet) separately from "missed rows" because a fake lead is meaningfully worse than a missed one — it silently poisons Linda's CRM. The current production path doesn't surface a "this looked invented" signal to the user. Worth adding once we have real telemetry on how often it happens.

**Logged:** 2026-05-16.

---

## Photo prompt v2 — three micro-tightenings parked from peer review

Three small rule additions the v1-v1.3 reviewers (gpt-5, opus, gemini) flagged that we didn't land in v1.3.1 because they were defensive rather than measurable. Bundle into a future v1.4 if real-world precision regresses.

- **Ambiguity tie-breaker:** "If a token could be template text or visitor data, treat it as template; exclude it." (gpt-5 R3)
- **Multi-candidate per cluster:** "If a cluster has multiple phones or emails, pick the one nearest the name; for phones prefer the longest digit run; for emails prefer the un-crossed entry." (gpt-5 R2/R3)
- **Plausible-name hardening:** current row-emission gate accepts any "two alphabetic words." Bare tokens like "Agent" can still slip through. Add a stronger filter (e.g. "must not match form-label vocabulary OR must contain at least one mid-string capital"). (opus R2)

All three are sub-50 tokens added. Worth landing only if eval shows label-bleed creeping back in.

**Logged:** 2026-05-18, from the photo capture peer-review archive.

---

## Photo eval — determinism + per-photo failure-mode tags

Two eval-harness upgrades flagged in every round of peer review but never landed. Both are cheap and meaningfully improve signal quality before any future prompt change.

- **Determinism sanity (N=3):** GPT-5 vision isn't perfectly deterministic even at temp=0. Run v1.3.1 three times against the 65-photo corpus, diff the results — measures our actual run-to-run noise floor. Without this, small prompt deltas can't be trusted: a "+0.3pp F1" might just be noise. ~30 min.
- **Per-photo failure-mode tags:** Richard's corpus already classifies photos by profile (over-line-only, multi-stack, cross-outs, etc.). Surface those tags in eval CSVs so a prompt regression names which pattern broke (segmentation vs label-bleed vs cross-out), instead of just dropping an aggregate number.

**Logged:** 2026-05-18.

---

## Photo eval — corpus extensions for real-world validation

Two corpus gaps that matter before claiming an external accuracy number. Pairs with the "real-cursive bake-off" entry above (which is broader — printing 30-50 sheets + recruiting humans). These two are tighter scope.

- **Real-Linda-photo holdout set:** 25-50 photos Linda actually takes on her iPhone of real sign-in sheets in real conditions (lighting, glare, finger). Synthetic structural accuracy ≠ real-cursive accuracy ≠ Linda-in-the-field accuracy. The docs predict ±10pp drift; real photos surface where.
- **Form-template diversity in corpus:** current eval uses ONE printed form layout across all 65 photos. The "ignore uniform printed font matching typical labels" rule can't be measured for generalization until the corpus has 5-10 different brokerage layouts.

**Logged:** 2026-05-18.

---

## Photo accuracy — server-side email domain Levenshtein-1 autocorrect

Cheap post-extraction fix that rescues a non-trivial slice of real-cursive misses. Map single-character typos of the top ~20 email domains (gmail / yahoo / hotmail / outlook / icloud / comcast …) to the canonical domain when Levenshtein distance = 1.

**Examples:** `gmall.com` → `gmail.com`, `hotmial.com` → `hotmail.com`, `yahoocom` → `yahoo.com`. Distance > 1: leave alone. The model returns what it sees; the server normalises after.

Deterministic, no AI in the loop, zero downside. Pairs naturally with phone E.164 formatting (also server-side, also deferred).

**Logged:** 2026-05-18, from gpt-5 R3 brainstorm.

---

## Photo v2 latency — two-stage OCR + text-only LLM hybrid

Architecture idea for when 2.4s/photo isn't fast enough: split the vision step (slow) from the reasoning step (fast). Run a fast classical OCR (PaddleOCR or Tesseract LSTM) to get raw text + per-word bounding boxes, then feed `"y=0.12 'Marcus Williams'  y=0.15 '555-9245'  …"` into a cheap text-only LLM (or even deterministic clustering heuristics) for grouping + extraction.

**Why it's interesting:** the vision forward pass is the latency hog. A text-only LLM call is 5-10× faster. Potential p95 < 2s.

**Why it's parked:** the current 2.4s path is already inside our 5s target. Worth ressurecting only if (a) real-world latency proves worse than synthetic, or (b) we want to add an LLM fallback for damaged photos without paying its full latency cost.

**Logged:** 2026-05-18, from gpt-5 R3.

---

## Photo v2 latency — CV pre-triage for "no handwriting" cases

50ms classical-CV check (Canny + Hough lines, or a tiny CNN classifier) that runs BEFORE the vision API call. If it detects no handwriting (blank form, dog photo, receipt, photo of the sheet's back), short-circuit to `{"people": []}` and skip the LLM call entirely.

**Why:** saves the full vision-call cost ($0.02 + 2.4s) on every "user took a wrong photo" case. The friendly retake prompt fires the same way.

**Why parked:** the case is rare enough today that the engineering cost outweighs the saved API calls. Promote if production telemetry shows >5% of photos hit it.

**Logged:** 2026-05-18, from gpt-5 R3.

---

## Photo v2 polish — small latency-and-craft ideas (3 bundled)

Three small ideas worth knowing about but not blocking. Each is independent.

- **Image cropping to sheet area before send.** Detect the sheet's edges with a quick CV pass, crop the background out, send only the sheet. Cuts tokens + upload bytes. ~50-100ms win typical, more on photos with lots of background.
- **Streaming partial JSON for perceived latency.** Different from our current row-streaming SSE wire (which streams BACKEND → FRONTEND once the model returns everything). This is configuring GPT-5 to stream JSON tokens so we can show the first parsed row at t=1s while the rest arrives. Real win only if latency creeps back up; today's 2.4s is fast enough to feel instant.
- **Multi-vendor prompt cache strategy.** When we add a v2 fallback (Anthropic / Gemini), design the prompt so the cacheable prefix is stable across vendors and only the per-call payload varies at the end. Cheap to set up if planned in; expensive to retrofit.

**Logged:** 2026-05-18, from gpt-5 R3 + opus R3 + gemini R3.

---

## Framer-motion bundle audit

Biggest remaining lever to get the gzipped JS bundle back under the 150 KB target. After the May 2026 refactor we sit at ~182 KB gzipped (~32 KB over). `framer-motion@11` alone eyeballs at ~40 KB; an audit of which animations actually need it (most ASMR work is already CSS transitions + `data-phase`-keyed selectors) could plausibly reclaim 15-20 KB without UX regressions.

**How:**
- Grep for `framer-motion` imports across `frontend/src/`. Each call site decides: is this animation really impossible in CSS?
- Where CSS can do it (entrance/exit on phase swap, scanner sweep, basic fades), drop the Framer call and use a CSS keyframe / transition keyed off `data-phase`.
- Where Framer earns its keep (drag gestures, layout-id morphs, spring physics the design actually leans on), keep it.
- If after the audit only one or two surfaces still need Framer, consider whether `motion/react`'s slim entry point covers them (~20 KB saving vs the full library).

**Logged:** 2026-05-23, surfaced during the May 2026 refactor's Item 5 bundle audit follow-up.

---

## Lead-worth-saving check — consolidate to one source of truth

The queue's record-write path rolls its own "is this row worth saving?" check (does the row have name OR phone OR email?). The backend's signal-gate has a more nuanced version of the same predicate. Future bug shape: the two drift, and a future capture mode (live captions transcript?) is gated by one but not the other.

**Fix shape:** the queue trusts the backend's answer — if the backend accepted the row at extraction time, the queue doesn't second-guess. Drop the queue's local predicate, lean on the upstream signal-gate as the only authority.

**Logged:** 2026-05-23, surfaced during the May 2026 refactor's "smaller smells" pass.

---

## Dead exported constant in the data layer

There's an exported constant in `frontend/src/features/review/Lead.ts` whose own comment reads "unused-but-exported placeholder." Delete it. Trivial S-size cleanup — only logged because it'd be a shame to keep tripping over it.

**Logged:** 2026-05-23, surfaced during the May 2026 refactor.

---

## No CI — pre-launch operational gap

There's no continuous-integration pipeline. Backend tests + frontend type-check + lint all run locally via the multi-agent pre-commit hook discipline, but there's no GitHub Actions / equivalent that catches a regression after a push. A senior reviewer would flag this as a launch blocker.

**Why parked:** solo-dev, single checkout, no other contributors. Local hooks are doing the job a CI matrix would, just without the audit trail. The cost is "what if I push a broken commit at 1am" — real but contained while it's just one person.

**When to ship:** before opening the repo to a second human contributor, or before launch with paying customers (whichever comes first). GitHub Actions is the obvious target — backend `uv run pytest` + frontend `pnpm test` + `pnpm exec tsc --noEmit` on every push to `main`. ~half-day of YAML.

**Logged:** 2026-05-23, surfaced during the docs-cleanup review pass.

---

## Cost-cap state is in-memory single-process

Per [`11_caps_and_costs.md`](_dev/11_caps_and_costs.md), the rate-limit + daily $-spend trackers live in a Python `dict` inside one uvicorn process. Fine for a single-host deploy. The moment we scale to multiple workers (or multiple hosts behind a load balancer), each process has its own copy of the counters and the global cap stops working.

**Fix shape:** swap the in-memory state for a Redis-backed store (or Postgres atomic RPC, mirroring the RecapShark `reserve_translate_chars` pattern). Same middleware, same API; just the storage backend changes.

**When to ship:** before the first multi-worker / multi-host deploy. Until then, the in-memory version is correct AND simpler — don't pre-build the Redis dependency.

**Logged:** 2026-05-23, surfaced during the docs-cleanup review pass.

---

## Module-scope mutable cache in App.canvas.tsx

`_initialStateCache` is a module-scope `let` that memoises the result of `computeInitialAppState()` so React's StrictMode double-invocation doesn't re-strip URL params + re-consume the pending-capture stash. It works, but module-scope mutable state fights React's lifecycle and is hard to test in isolation. Standard "one-time-effect via a ref" pattern is cleaner and survives StrictMode without the global.

**Fix shape:** move the initial-state computation into a `useEffect` that runs once via a `useRef` guard, OR use the standard "useState lazy initializer" pattern with the cache lifted out of module scope into a `useMemo` keyed on something stable.

**Logged:** 2026-05-23, surfaced during the May 2026 refactor's "smaller smells" pass.

---

(Add new "maybe later" ideas below as they come up.)
