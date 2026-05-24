# Photo model bake-off — single source of truth

**Last updated:** 2026-05-23 — production status flipped to OpenAI GPT-5 minimal-reasoning at the top of the doc; production-wiring paths updated (cost cap at `api/middleware/`, harness moved to `docs/_tests/vision_bakeoff/`). Original bake-off matrix preserved as decision history.

**Read this if you're touching the photo capture flow, picking a
vision provider, comparing latency/cost trade-offs, or wondering
"why Doc AI and not GPT/Claude/Gemini?".**

This is the only place this story is told end-to-end. Older drafts
that lived in `docs/_spec/photo_capture.md` (formerly the
`04_REFERENCE.md §1` content) and `docs/_tests/photo_capture_bakeoff/evidence/README.md`
now point here.

---

> **Current production provider: OpenAI GPT-5 with `reasoning_effort="minimal"`** (locked 2026-05-17).
> The bake-off below is preserved as the *original-decision history*
> — Doc AI shipped 2026-05-16 and was unshipped 24 hours later when
> real-world testing showed 0% accuracy on the structural layouts
> visitors actually create (multi-person stacked into one entry
> block, handwriting across printed lines). The v1.3.1 prompt +
> GPT-5 minimal-reasoning replacement scored **97% accuracy / 2.8s
> p50 latency** on the structural-challenge corpus. Doc AI stays
> wired as a one-line rollback target (`VISION_PROVIDER=docai`) —
> see [`06_read-before-deploy.md`](06_read-before-deploy.md) §7.
>
> For the current photo architecture (SSE contract, preprocessor,
> error handling) see
> [`docs/_spec/photo_capture.md`](../_spec/photo_capture.md). For
> session-by-session eval history, see
> [`docs/_tests/photo_capture_bakeoff/sessions/`](../_tests/photo_capture_bakeoff/sessions/).

---

## TL;DR

We tested **6 vision models** across **3 photo tiers** (clean →
slightly worn → trashed real photos) on 2026-05-16. The bake-off
picked **Google Document AI Form Parser** on speed + clean-case
accuracy. **That decision was reversed 24 hours later** after real
sign-in sheets came back at 0% — the bake-off corpus didn't include
the structural layouts visitors actually create. The current
production provider is **OpenAI GPT-5 minimal-reasoning** with the
v1.3.1 prompt (see
[`docs/_spec/photo_capture.md`](../_spec/photo_capture.md)).

The matrix below is preserved as the original-decision history.
Read it for context on why Doc AI looked right at the time, but
**don't use it to pick a provider today** — the structural layouts
that broke Doc AI weren't in any of the three corpus tiers.

---

## The matrix (this is the table to remember)

Headline metric: **contactable rate** = % of ground-truth rows
where the model captured name AND (phone OR email). That's the
metric that actually matters to Linda — a row is "useful" if she
can follow up on it.

| Model | Clean | Slightly worn | Trashed | Typical wait | Cost/photo |
|---|---:|---:|---:|---:|---:|
| gpt-4o | 93% | 92% | 22% | ~7s | $0.013 |
| gpt-4o-mini | 93% | 92% | 14% | ~13s | $0.005 |
| Claude Opus 4.7 | 92% | 92% | **44%** ⭐ | ~17s | **~$0.08** ✱ |
| Claude Sonnet 4.6 | 80% | 85% | 0% (see notes) | ~21s | $0.039 |
| **Google Doc AI Form Parser** ✅ shipped | 89% | 88% | 0% (see notes) | **~3s** ⚡ | $0.03 |
| Gemini 2.5 Pro | 92% | 92% | 39% | ~19s | **~$0.016** ✱ |

Accuracy + speed numbers are computed from the raw `summary.csv`
files in `docs/_tests/photo_capture_bakeoff/evidence/` —
contactable count ÷ tier truth-row count for accuracy,
`latency_p50_ms` for speed. **Cost numbers** are corrected for
the model-vendor pricing rates that were live on 2026-05-16
(verified against the official pricing pages — see Sources at the
bottom of this doc).

✱ **Cost correction note (2026-05-16):** the bake-off candidate
code captured Opus 4.7 at the legacy Opus 4.1 rate ($15/$75 per
MTok instead of the current $5/$25) and captured Gemini 2.5 Pro
with the wrong output rate ($5 instead of $10 per MTok). Real
per-photo costs are recomputed from the recorded token counts at
the correct rates: **Opus = recorded ÷ 3 ≈ $0.08**; **Gemini ≈
$0.016** (estimated; exact figure requires a re-run with corrected
constants — token-split between input vs output drives the
adjustment). All other models match the official rates. Constants
in `docs/_tests/vision_bakeoff/candidates/*.py` have been
fixed; re-runs from now on will land in the CSVs directly.

Notes on the matrix:
- **Opus** is the accuracy king on damaged photos (44%, more than
  double the next-best). Cost is ~$0.08/photo at current
  Anthropic rates — see the correction note below.
- **Sonnet's 0% on trashed** is "no data", not a real failure
  rating — every Sonnet call on the shady tier errored in ~400ms
  with `api_status_error`. Could be a wiring bug in our candidate,
  a content-policy false positive on damaged forms, or a
  rate-limit cascade. Don't write Sonnet off based on this.
- **Doc AI's 0% on trashed** means "0 useful rows," NOT "0 rows
  returned." Doc AI confidently emits rows on damaged photos —
  they're just garbage (empty names, the form's own printed
  labels stuffed into the phone/email field, fabricated rows
  with no truth match). On the shady tier: 0 contactable, 8
  partial, 6 wrong-name-wrong-contact, 86 missed, **42
  fabricated**. The garbage looks legitimate to the UI, which is
  worse than returning nothing — Linda would have to manually
  delete fabricated leads. This is what real-world testing also
  surfaces (see [pitfall #22](05_agent-pitfalls.md) +
  conversation logs from 2026-05-16).

---

## How to read the bake-off result CSVs (don't fall for this trap)

The per-run summary CSVs live at
`docs/_tests/vision_bakeoff/results/<run-id>/summary.csv`.
Columns include:

| Column | What it is | Use for |
|---|---|---|
| `contactable` | count of rows with name + phone/email | **headline accuracy** (divide by tier truth-row count for %) |
| `partial` | some fields correct, contact triple broken | "kinda useful" |
| `bad_row` | wrong name attached to wrong contact | **worst outcome** — silently poisons Linda's CRM |
| `missed_row` | truth row had no candidate match | lost lead |
| `extra_row` | candidate fabricated a row | fabricated lead |
| `total_score` | weighted composite (correct fields × weight, **wrong fields × -2× weight**) | ⚠️ **NOT** the headline metric — penalizes hallucinations 2×, so a model that fabricates a lot can look dramatically worse than its raw `contactable` count suggests |
| `latency_p50_ms` / `latency_p95_ms` | wall-clock per call | speed ranking |
| `cost_per_contactable_usd` | total spend ÷ contactable rows | dollar efficiency |

If you read `total_score` as "accuracy", **gpt-4o-mini looks
negative on every tier even though its contactable rate matches
gpt-4o**. That's not the model being broken — that's the
hallucination penalty doing its job. For "which model captures
more useful leads," use `contactable`. For "which model is safer
to ship," look at `bad_row` + `extra_row` (hallucination signals).

---

## The three photo tiers

| Tier | Photos | Truth rows | Folder | Source |
|---|---:|---:|---|---|
| `truly_clean` | 30 | 115 | `docs/_tests/vision_bakeoff/data/truly_clean/` | Custom-rendered Name/Phone/Email tables with handwriting fonts cleanly positioned in each cell. The honest "best case." |
| `good_synthetic` | 30 | 115 | `docs/_tests/vision_bakeoff/data/good_synthetic/` | `truly_clean` + mild filter (small rotation, light blur, JPEG noise). Tests light photo-noise tolerance. |
| `shady_real` | 25 | 100 | `docs/_tests/vision_bakeoff/data/shady_real/` | Real iPhone photos of printed sheets, deliberately abused (coffee, crumple, fold, glare). 2 of the original 27 were unreadable and dropped. |

The **average synthetic** and **clean buggy** tiers from earlier
runs were dropped — see [methodology](#methodology--what-wed-keep--change-next-run).

---

## Why Doc AI specifically (the decision reasoning)

Doc AI was picked on **speed** + **accuracy on the common case**, not
on raw accuracy ranking. The reasoning, distilled:

1. **Latency target was < 5s** for a typical photo. Only Doc AI
   meets it (~3s). Every LLM is 7-21s. The ASMR feel of the app
   collapses if photos hang for 20 seconds.
2. **Real Linda photos are ~90% clean to slightly worn** (sheet
   on a clipboard, indoor light, light handling). The "trashed"
   tier is the worst-case stress test, not representative volume.
3. On clean + slightly worn, Doc AI's **88-89%** is within the
   same band as the LLM flagships (92-93%). A 3-4pp gap is
   recoverable in the review UI; a 15-second latency gap is not.
4. **The model choice is a 10% problem; the review UI is a 90%
   problem.** Four engineers consulted independently before the
   pick — all four ranked "improve the review UI" above "pick a
   better model" in expected impact.
5. The 10% of damaged photos that Doc AI fails on go to a calm
   "this sheet is a bit messy — want to try one more photo?"
   retake surface (Slice B). That's a better Linda experience than
   waiting 20s for an LLM to recover 39% of rows.

---

## Production targets (locked)

- **Latency:** result returned ≤ 5 seconds for a typical photo.
- **Accuracy:** ≥ 90% of leads captured correctly on clean/worn
  photos. Heavily damaged photos: best-effort or clean "retake".
- **Cost ceiling:** ≤ $1/user/month at projected usage (~50
  photos per agent per month).

---

## Where the production wiring lives

- **Production adapter (default):**
  [`backend/src/captureshark/adapters/openai_vision_extractor.py`](../../backend/src/captureshark/adapters/openai_vision_extractor.py)
  — GPT-5 + `reasoning_effort="minimal"` + v1.3.1 prompt.
- **Rollback adapter:**
  [`backend/src/captureshark/adapters/google_docai_vision_extractor.py`](../../backend/src/captureshark/adapters/google_docai_vision_extractor.py)
  — wired but only used when `VISION_PROVIDER=docai`.
- **Port (the interface every adapter implements):**
  `backend/src/captureshark/domain/vision.py` (`VisionExtractorPort`)
- **DI wiring (which adapter the route gets):**
  [`backend/src/captureshark/api/deps.py`](../../backend/src/captureshark/api/deps.py)
  `get_vision_extractor()` — branches on `VISION_PROVIDER` env var.
  Default (unset or any value other than `"docai"`) selects the
  OpenAI adapter; `"docai"` selects the rollback per
  [`06_read-before-deploy.md`](06_read-before-deploy.md) §7.
- **Cost cap:**
  [`backend/src/captureshark/api/middleware/cost_cap.py`](../../backend/src/captureshark/api/middleware/cost_cap.py)
  — per-IP rate limit + optional daily $-spend kill-switch. Photo
  estimate is $0.025/call (conservative; real GPT-5 cost is ~$0.02).
  Full env-var docs in [`11_caps_and_costs.md`](11_caps_and_costs.md).
- **Preprocessor (runs before any vision adapter):**
  `backend/src/captureshark/adapters/image_preprocessor.py` —
  HEIC decode, EXIF rotate, RGB JPEG, 1600 long-edge cap, 25 MP
  cap (bumped from 12 MP during the bake-off because iPhones
  shoot at 12.19 MP).
- **Production prompt:** v1.3.1 lives in the OpenAI adapter
  module itself (see the docstring at the top of
  `openai_vision_extractor.py`); historical text-file variants
  live under `backend/src/captureshark/prompts/`.

---

## Evidence — raw bake-off outputs

All preserved at `docs/_tests/photo_capture_bakeoff/evidence/`:

| File | What |
|---|---|
| `sweep_truly_clean_summary.csv` | 4-model sweep (gpt-4o, gpt-4o-mini, Opus, Sonnet) on the truly_clean tier. |
| `sweep_good_synthetic_summary.csv` | Same 4 models on good_synthetic. |
| `sweep_shady_real_summary.csv` | 5-model sweep (4 LLMs + Doc AI) on the trashed real photos. |
| `docai_truly_clean_summary.csv` | Doc AI backfill on truly_clean. |
| `docai_good_synthetic_summary.csv` | Doc AI backfill on good_synthetic. |
| `gemini_truly_clean_summary.csv` | Gemini 2.5 Pro on truly_clean. |
| `gemini_good_synthetic_summary.csv` | Gemini 2.5 Pro on good_synthetic. |
| `gemini_shady_real_summary.csv` | Gemini 2.5 Pro on shady_real. |

Per-photo CSVs (one row per photo, with row-level scoring) lived
at `docs/_tests/vision_bakeoff/results/<run-id>/<model>.csv`
on the machine where the bake-off ran — gitignored because of
their volume. Re-run the harness to regenerate.

---

## Harness — how to re-run a single model

The harness was moved out of `scripts/` to
`docs/_tests/vision_bakeoff/` during the May 2026 cleanup pass
(see [`03_polish_pass.md`](03_polish_pass.md) §10). From the repo
root with `uv`:

```bash
# Smoke check — one model, full clean tier
uv --project backend run python -m docs._tests.vision_bakeoff.bakeoff \
  --corpus-dir docs/_tests/vision_bakeoff/data/truly_clean \
  --models google-docai-form-parser

# Full sweep — every wired model against one tier
uv --project backend run python -m docs._tests.vision_bakeoff.bakeoff \
  --corpus-dir docs/_tests/vision_bakeoff/data/shady_real \
  --models openai-gpt-4o,openai-gpt-4o-mini,anthropic-claude-opus-4-7,anthropic-claude-sonnet-4-6,gemini-gemini-2-5-pro,google-docai-form-parser
```

Output lands at `docs/_tests/vision_bakeoff/results/<timestamp>/`.

The harness README at
[`docs/_tests/vision_bakeoff/README.md`](../_tests/vision_bakeoff/README.md)
covers the candidate plug-in pattern + scoring rubric in depth.

---

## Methodology — what we'd keep + change next run

### Keep
- **Hexagonal candidate pattern.** Adding a new vendor is one
  file in `docs/_tests/vision_bakeoff/candidates/`. The
  harness reads `VisionExtractorPort` semantics so candidates
  can't accidentally diverge from production behavior.
- **Per-tier corpora as separate folders.** Re-running the
  harness against the same tiers gives apples-to-apples
  comparison over time.
- **Per-photo + summary + calibration CSVs.** The per-photo CSV
  is where actual debugging happens; the summary is the
  leaderboard.
- **The labeler tool** — a hand-built HTML page for mapping
  IMG_XXXX files to template_NN. Real-world corpus collection is
  shoot-first, label-second; a labeler is more reliable than
  asking the photographer to shoot in template order.

### Change
- **Drop the "average synthetic" tier.** Adding rotation + blur
  on top of clean digital data tests image preprocessing, not
  OCR. Not useful for ranking models.
- **Drop the "clean buggy" tier.** When sourcing from a render
  pipeline that has overlap bugs (text on top of form labels),
  the resulting corpus tests "AI's ability to parse soup" rather
  than "AI's ability to extract from a form."
- **Render our own clean baseline.** The corpus agent's rendered
  forms had handwriting overlapping with field labels. A
  from-scratch simple Name/Phone/Email table with handwriting
  font cleanly positioned in each cell gave a much more honest
  "best case" tier.
- **Fix source CSV mojibake at read time.** The corpus agent's
  answer key double-encoded UTF-8 (`Müller` → `MÃ¼ller`). Without
  the fix, this unfairly penalized models that read the names
  correctly. See [agent pitfall #23](05_agent-pitfalls.md).
- **Score "visible names only" on the shady tier.** Strip ground
  truth rows that are cropped off / crossed out / heavily
  obscured. The current numbers likely understate real recovery
  by ~5-10pp.

---

## The biggest blind spot: real cursive

**Every tier in this bake-off used font-rendered handwriting with
jitter.** Real human cursive has stroke-pressure variation, slant
inconsistency, ligature differences, and individual quirks that
no font (jittered or not) reproduces. All four reviewing engineers
flagged this as the #1 gap.

**Best estimate:** absolute accuracy numbers shift ±10pp on real
cursive. Relative ranking between models may or may not hold.

**Before claiming any production accuracy number externally:**
- Print 30-50 sheets, get real humans (~20-30 of them) to fill
  them in at varying pen pressures + styles.
- Photograph under normal phone conditions (NOT trashed).
- Re-run the full bake-off against this set.
- Compare rankings to the synthetic results.

If the rankings flip, revisit the v1 choice.

---

## v2 candidates — if real users hit a wall

Everything below is **parked**, not killed. If production
telemetry reveals a gap, this is the next-most-promising direction.

### v2.1 — LLM fallback for damaged photos

If users report a common case where the photo can't easily be
retaken (e.g. event already over, sheet thrown away), add a
fallback that fires only when Doc AI returns 0 rows OR mean field
confidence < threshold. Don't fall back on every photo — defeats
Doc AI's latency advantage.

Best candidates from the bake-off:
- **Gemini 2.5 Pro** — 39% on trashed, ~$0.016/photo. Cheapest
  LLM with meaningful trashed performance. **Most likely v2
  winner.**
- **Claude Opus 4.7** — 44% on trashed, ~$0.08/photo at current
  Anthropic rates. About 5× more expensive than Gemini for 5pp
  accuracy.

Plumbing is ready: each candidate under
`docs/_tests/vision_bakeoff/candidates/` is a wired
implementation of `VisionExtractorPort` semantics. Promoting one
to prod is a deps.py + service-layer change.

### v2.2 — Custom-train the Doc AI processor

The bake-off used the **pre-trained** Form Parser. Doc AI
supports custom processors trained on 20-50 labeled examples.
Google's own benchmarks suggest 5-10pp accuracy gain on the
specific form layouts you train against. Worth doing once you
have ~50 real-broker photos in the wild.

Custom training adds little for clean in-cell handwriting on
standard table layouts — the pre-trained model already handles
that. Gain is real on non-standard layouts, cursive variants, and
unusual field labels. Worth trying **after** the real-cursive
bake-off (above).

### v2.3 — Sonnet 4.6 re-test

Resolve the "every shady_real call errored in 400ms" mystery. If
real, the cheaper-than-Opus alternative is gone. If a wiring bug
in our candidate, Sonnet might be a viable v2 fallback at
~$0.035/photo.

---

## Related docs (intentionally not duplicating their content)

- **Photo capture architecture (SSE contract, preprocessor, error
  handling, UX copy rules):**
  [`docs/_spec/photo_capture.md`](../_spec/photo_capture.md) §2+
- **Photo agent pitfalls (Doc AI's two API surfaces, mojibake,
  Gemini schema subset, iPhone 12 MP cap, etc.):**
  [`05_agent-pitfalls.md`](05_agent-pitfalls.md) items 22-26
- **Production deploy gotchas (env vars, rollback to OpenAI,
  Doc AI processor permissions):**
  [`06_read-before-deploy.md`](06_read-before-deploy.md) §3a + §7
- **Current photo capture architecture reference:**
  [`docs/_spec/photo_capture.md`](../_spec/photo_capture.md)
  (session-by-session bake-off history at
  [`docs/_tests/photo_capture_bakeoff/sessions/`](../_tests/photo_capture_bakeoff/sessions/))

---

**Original 2026-05-16 ship:** bake-off complete, Doc AI shipped behind
`VISION_PROVIDER=docai`. Reverted 2026-05-17 — see the banner at the
top of this doc.
