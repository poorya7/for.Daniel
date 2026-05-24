# RecapShark — Architecture & Design Decisions

## Overview

RecapShark takes a YouTube URL, fetches its transcript (subtitles or audio transcription), and generates summaries, chapters, and a chat interface -- all powered by GPT. The UI supports bilingual translation into 100+ languages.

**Stack:** FastAPI backend (Python) + vanilla JS frontend (no framework). Single-page app served as static files by the same FastAPI server.

---

## Pipeline Flow

The display order is fixed for fast first paint (see `PROJECT_RULES.md` for the rule):

1. **On paste, immediately and in parallel (non-blocking):**
   - **`/api/video/meta`** (~0.5-2s) — YouTube Data API; awaited synchronously in `process-url.js` for the duration cap (>10h reject in tier-4O langs) and the rewind-mode decision (<10s skip rewind). The same response also provides title + channel for the hero / NOW WATCHING bar — populated synchronously the moment meta lands. (Pre-Phase-4a a parallel noembed.com call won the title race; that third-party endpoint is now bot-blocked by YouTube — KB3 — so the meta payload is the single source. Path was `/api/test/video-meta` pre-Phase-4a A8.)
   - **Subs fetch** (`/api/transcript/subs`, ~500ms via SubsProvider) — the actual gate for first paint.
2. **Short summary + chapters** — fire as 4 parallel LLM calls the moment subs arrive (`chapters-v1-even`, `chapters-v3`, `full-summary`, `suggested-questions`); chapters render in 1-2s
3. **Full summary** — replaces the transcript-preview placeholder when the LLM finishes (~3-8s)
4. **Transcript display** — shown last (or after rewind animation finishes on first paste)

If subs are unavailable (race timeout 5s or content < 100 chars), the app falls back to AsrProvider audio transcription (currently disabled to avoid costs; shows a placeholder instead).

### Key files

**Backend (Python — `pipeline/`):**

| File | Role |
|------|------|
| `server.py` | FastAPI entry point, mounts routes + static frontend |
| `routes.py` | Core endpoints (summary, chapters, chat, translation) + sub-router aggregation |
| `youtube_routes.py` | YouTube Data API metadata + preview summary routes |
| `karaoke/` | AsrProvider / karaoke transcription subpackage — owns the chunked-karaoke pipeline + 6 routes (`/karaoke-chunk`, `/karaoke-words-short`, `/test/asr_provider-transcript`, `/admin/karaoke-words-full`, `/admin/karaoke/purge`, `/admin/karaoke-chunk-cache-stats`). Cycle 6 of the SRP refactor (2026-05-06) split the old 1,919-LOC `asr_provider_routes.py` into 7 focused modules; Phase 4e (2026-05-09) added 2 more leaf modules (`stats.py` for the admin sanity dashboard fetchers, `_constants.py` for the cross-cutting `_ASR_PROVIDER_COST_PER_SECOND` + chunk-grid sizes). `routes.py` imports `asr_provider_router` directly from this package. Shared `poll_asr_provider_until_done` lives in `client.py` (Phase 4e). |
| `_lib/rate_limit.py` | `AsyncTokenBucket` — general-infra rate limiter (NOT karaoke-specific). Extracted in cycle 6 so future OpenAI / Translate clients can reuse it. |
| `transcript_routes.py` | SubsProvider subtitle/transcript fetch routes |
| `chat_log_routes.py` | Chat log endpoints (persistence + retrieval) |
| `analytics/` | BigQuery analytics dashboard subpackage — owns every `/api/analytics/bq/*` endpoint (V2 pipeline — see `06_ANALYTICS.md` for the file inventory). Cycle 2 of the SRP refactor (2026-05-06) split the old 3,740-LOC `bq_analytics_routes.py` into 12 focused modules; Phase 4e (2026-05-09) added `_session_filter.py` (single source of truth for the per-row `_keep(...)` predicate previously triplicated across `sessions_list.py` + `overview.py`). `routes.py` imports `router` directly from this package. |
| `owner_routes.py` | Owner-only / admin endpoints |
| `deps.py` | Shared dependencies (rate limiter) |
| `translate.py` | GPT translation (fallback for 13 complex-script languages), quality checks |
| `google_translate.py` | Google Translate API wrapper (primary path, batch requests) |
| `summarize.py` | Summarization prompts |
| `worker.py` | Summary/chapter generation logic, map-reduce chapters |
| `openai_client.py` | OpenAI client factory |
| `constants.py` | Backend magic numbers (char limits, timeouts) |
| `langs.py` | Centralized language metadata |
| `get_audio.py` | Video ID extraction, metadata |
| `ner.py` | spaCy-based named-entity recognition for the transcript (people / places / dates), plus auto-recase for all-caps transcripts. Fed into the frontend's entity highlighter. |
| `narrative.py` | Template-based narrative generator for analytics dashboard summaries (zero-cost alternative to LLM narratives — see `06_ANALYTICS.md`). |
| `etl_sessions.py` | Hourly cron — pulls last 2 days from BigQuery and upserts into Supabase `rs_sessions`. Runs as the `etl-sessions` PM2 process. Imports `derive_landed_via` from `traffic_source.py` (Phase 4e). |
| `traffic_source.py` | Leaf module: GA4 medium/source bucketing (`derive_landed_via` + `SOCIAL_HOSTS`). Single source of truth — used by both `etl_sessions.py` (writes `landed_via` on upsert) and `analytics/filters.py` (reads it back, with this as a fallback for old rows). New file (Phase 4e, 2026-05-09). |
| `chat_messages_store.py` | Supabase persistence layer for chat history. |
| `supabase_owner_store.py` | Supabase persistence for owner/admin data. |
| `supabase_sessions_store.py` | Supabase persistence for analytics sessions. |
| `_subs_provider_fetch.py` | Subprocess wrapper for the SubsProvider transcript fetch (avoids long-running blocking calls in the main FastAPI loop). |
| `video_titles.py` | Video title fetching helpers. |
| `run.py` | Local convenience runner. |

**Frontend (vanilla JS ES modules — `src/js/`):**

| File | Role |
|------|------|
| `main.js` | ES module entry point, window bridge for onclick handlers |
| `core/state.js` | AppState — central state object |
| `core/helpers.js` | Pure utility functions (formatting, escaping, paragraph grouping) |
| `core/constants.js` | Shared magic numbers (paragraph sizing, translation limits) |
| `core/sentry.js` | `@sentry/browser` init when `VITE_SENTRY_DSN_FRONTEND` is set. `beforeSend` drops extension-URL events always; in `import.meta.env.DEV` also drops transient fetch/network exception text (`Failed to fetch`, etc.) so local Vite + visibility-recovery noise does not flood Sentry. Sets `window.Sentry` + `window.__sentryInitialized` at module-eval time — **boot bridge** imported first from `main.js` (same pattern as `core/assets.js`). |
| `api/client.js` | HTTP client, API call wrappers |
| `api/pipeline.js` | Pipeline orchestration (subs → summary → transcript) |
| `api/data.js` | Transcript data processing, segment parsing |
| `translation/translation.js` | TranslationManager — orchestrates API calls, init/reset lifecycle (Phase 4c #3: wave + chunked extracted). |
| `translation/translation-wave.js` | Wave crossfade between language columns (Phase 4c #3). |
| `translation/translation-chunked.js` | Chunked GPT transcript fallback for advanced langs (Phase 4c #3). |
| `translation/translation-bilingual.js` | Bilingual controls, flag toggles, progress display |
| `translation/translation-lang-panel.js` | Language selection UI (search, popular/all sections) |
| `translation/translation-transcript.js` | Transcript parsing, HTML building, translated container management |
| `translation/translation-ui.js` | Subtitle language switching, bilingual DOM rendering |
| `translation/translation-state.js` | Translation module shared mutable state |
| `translation/lang-meta.js` | Language metadata (100+ languages, flags, names) |
| `ui/renderer.js` | Coordinator: desktop transcript render path (buffer-swap engine), the central `setMode` tab router, public Renderer API surface. Slimmed from 1,637 → 739 LOC in cycle 4 of the SRP refactor (2026-05-06). |
| `ui/renderer-progress.js` | Summary / per-panel / transcript progress banners (4 banner types). New file (cycle 4, 98 LOC). |
| `ui/renderer-meta.js` | Video metadata DOM (title with brutalist colorized override, channel badge, URL input, upload date, now-watching bar). New file (cycle 4, 48 LOC). |
| `ui/renderer-summary.js` | Summary HTML build (Quick / Context / Body sections), paragraph render orchestration including the desktop summary-switcher A/B crossfade and the mobile summary scroller refresh call. New file (cycle 4, 149 LOC). |
| `ui/renderer-chapters.js` | Chapter list HTML build, click delegation (desktop + mobile), active-row highlight, chapters-preview render path. Receives `showTranscriptAt` callback via setup() to avoid a back-import. New file (cycle 4, 171 LOC). |
| `ui/renderer-mobile-panels.js` | Mobile panel registry: FlatTranscript instance per `transcript`/`subtitles` mode + SummaryNativeScroll for `summary`. Owns lifecycle prepare/refresh/destroy across language switches and bilingual toggles, the floating auto-scroll + jump-to-now buttons, the script-font preload, and the public `window._refreshMobilePanels` window-bridge entry. Cycle 4 also renamed the stale "wheel"/"cylinder" terminology that lingered from the old 3D-cylinder + wheel UIs (replaced by FlatTranscript + SummaryNativeScroll in late April 2026). New file (cycle 4, 644 LOC). |
| `ui/flat-transcript.js` | FlatTranscript — mobile transcript/subtitle list (orchestrator: factory, state bag, event handlers). **Active mobile transcript implementation.** Hybrid native-scroll + transform-based auto-follow. |
| `ui/flat-transcript-render.js` | Row DOM for FlatTranscript — `renderRows`, `tryUpdateItemsFast` (same-row-count fast path). Split from `flat-transcript.js` 2026-05-08 (Phase 4c #4). |
| `ui/flat-transcript-scroll.js` | Scroll math + GPU follow mode + **per-row anchor mode** (KB5, 2026-05-09): time-based row.top lerp for single/paragraph; KB1 active-line anchor (`activeAnchorContentY` state machine + 5s sticky, scoped to primary `.ts-text`) for bilingual rows. Split from `flat-transcript.js` 2026-05-08. |
| `ui/summary-native-scroll.js` | SummaryNativeScroll — mobile summary view. Native overflow-y scroll with `mask-image` edge fade + `content-visibility: auto`. **Active mobile summary implementation** (replaced CylinderScroll). |
| `ui/entity-highlighter.js` | Entity highlighting orchestrator — cache, DOM application, `EntityHighlighter` bridge. Patterns + NER live in sibling modules (Phase 4c #5). |
| `ui/entity-highlighter-patterns.js` | Hardcoded regex + masking pipeline (`findEntityRanges`). |
| `ui/entity-highlighter-ner.js` | NER registry (`setEntities`, compiled per-type regex accessors). |
| `ui/font-loader.js` | Script-font metadata + readiness gate. Exports `awaitFontForLang(lang, {timeoutMs})`, `applyLangStyle(el, lang)`, `setLangClass(el, lang)`, `clearStaleInlineFontFamily()`. See [`13_LANGUAGE_AND_FONTS.md`](./13_LANGUAGE_AND_FONTS.md). |
| `ui/title-colors.js` | Animated title color treatment. |
| `ui/transcript-buffer.js` | Desktop transcript scroll buffer / virtualization. |
| `ui/casual-mode.js` | "Casual" tone toggle. |
| `ui/feature-toggle.js` | Generic feature-flag toggles. |
| `ui/pipeline-ui.js` | Pipeline progress UI. |
| `ui/controls.js` | Overlay toggles, font size, export, toast |
| `ui/search.js` | Transcript search |
| `ui/themes.js` | Theme registry (brutalist + 6 light + 5 dark), `applyTheme()`, cycle functions. Sets CSS custom properties (design tokens) on `:root`. See **Theming System** section below. |
| `ui/loading-state.js` | Loading skeleton UI, resets mobile scrollers on new video |
| `ui/mobile-sticky.js` | Mobile sticky offsets, moves transport controls into `.mobile-controls-row` |
| `player/player.js` | Coordinator: YT IFrame Player lifecycle, topic tracker, desktop transcript-sync engine, public PlayerManager API surface. Slimmed from 1,365 → 842 LOC in cycle 3 of the SRP refactor (2026-05-06). Transcript-sync stays here (deeply tied to YT events) — flagged as a Phase 2 extraction candidate. |
| `player/player-facade.js` | Facade overlay (thumbnail + tap-to-play), embed-fallback panel, click-blocker overlay, mech-controls disabled-state when embed fails. New file (cycle 3, 141 LOC). |
| `player/player-controls.js` | Mech panel UI: play/pause icon + status, prev/next nudge, scrubber drag, volume slider, fullscreen, time render, and the module-load wiring of all those buttons. New file (cycle 3, 313 LOC). |
| `player/player-subtitles.js` | CC overlay — toggle, 200ms sync loop, long-segment chunking + display-text resolution, binary-search lookup of the active segment. New file (cycle 3, 197 LOC). |
| `player/karaoke.js` | Public KaraokeManager façade (init / syncWord / reset / invalidate / onPlayOrSeek). All implementation moved out across cycles 7a + 7b + Phase 8. Slimmed 3,271 → 2,635 (cycle 7a) → 1,649 (cycle 7b) → **303** (Phase 8, debug panel extracted to `karaoke-debug.js` and dynamic-imported only on `?karaoke_debug=1`). |
| `player/karaoke-debug.js` | The `?karaoke_debug=1` floating debug panel + bridge. **Phase 4c #1 split:** orchestrator ~390 LOC + `karaoke-debug-tests.js` + `karaoke-debug-diag.js` (dev-only chunk via `import.meta.env.DEV` dynamic import from `karaoke.js`). |
| `player/karaoke-store.js` | Karaoke shared-state hub (the star-pattern center, the only intentional architectural decoupling in the refactor). Owns ALL shared mutable state: `_words` / `_loadedRanges` / `_wordKeySet` (cycle 7a) plus `_synthWords` / `_wordEls` / `_wordElByKey` / `_wordElsByKey` / lit Sets / `_radiusSecCache` / `_lastWaveTime` / `_activeWordKey` / apply-path bookkeeping (cycle 7b). The `isOriginalVisible()` translation gate + `wordKey()` utility live here too. In-place mutation discipline (Array.length=0 / Set.clear() / Map.clear() in resets) means consumers' long-lived bridge refs stay valid across video swaps. New file (cycle 7a, 351 LOC; unchanged in 7b — 7a pre-built every accessor 7b would need). |
| `player/karaoke-chunk-loader.js` | All chunk-fetching I/O for the lazy karaoke pipeline: heartbeat-throttled scheduling, seek-debounce accelerator, visibility recovery, uniform 600s chunk grid, short-video bypass (≤300s → single-call endpoint), per-chunk fetch with retryable / non-retryable / Sentry-capture handling. Cross-module callback via `setup({ applyWordSpansForActivePanel })` keeps the import DAG acyclic. New file (cycle 7a, 472 LOC; cycle 7b grew to 511 — added `_seekDebounceFire` extraction + `_resetDebugCounters` + `_flushSeekDebounce` so the 7a-deferred no-op test bridges actually work). FIRST_CHUNK_DUR / STEADY_CHUNK_DUR / SHORT_VIDEO_THRESHOLD_SEC are exported on the public surface (2026-05-11) so callers like `orchestrator/process-url-fetch.js`'s warm path route through the same constants — `npm run check:chunk-grid` only validates FE↔BE parity, not within-FE. |
| `player/karaoke-analytics.js` | Session-end telemetry: the `[KARAOKE-SESSION]` Sentry breadcrumb fired exactly once per session (gated by `_sessionEndLogFired`), pagehide / visibilitychange→hidden lifecycle hooks, idempotent across both events. New file (cycle 7a, 141 LOC). |
| `player/karaoke-align.js` | Pure alignment math + binary search: row-end resolution, row-state hashing, normalize-for-match, word-token counting, segment lookup, segment-anchored synthetic timing for tokens AsrProvider missed, `findWordAt` binary search (O(log N) anchor for the wave loop), `rebuildSynthWordsFromDOM`. No DOM mutation, no AppState writes (only reads for video duration / segments). New file (cycle 7b, 273 LOC). |
| `player/karaoke-dom.js` | Span DOM construction + apply paths: `buildWordSpans` (the gnarly 200-LOC text-preserving renderer that overlays AsrProvider matches without destroying original SubsProvider text), `wrapCharsIntoSpan` (caches `__kchars` on each .k-word to avoid per-frame querySelectorAll), per-row `applyWordSpans` + `applyWordSpansToSubs` with idempotent `dataset.karaokeState` hash skip, the dispatcher `applyWordSpansForActivePanel` that paints both transcript AND subtitle buffers per chunk arrival. New file (cycle 7b, 570 LOC). |
| `player/karaoke-wave.js` | The per-frame rAF wave loop. Char-level continuous-highlight running at the browser frame rate — every char near the playhead gets a smooth `--k` (0..1) value via Hann-window bell. Idle-skip via `_lastWaveTime`, reused scratch sets via `swapLitSets()`, O(1) `.k-word` lookup via the store's `wordElsByKey` Map. Active-line tracker (`.karaoke-active-word` class on the wave-peak `.k-word`) used by flat-transcript / player.js scroll anchoring. New file (cycle 7b, 311 LOC). |
| `player/rewind.js` | Rewind / morph animation engine (with 10s watchdog so a hung rewind can't lock the app). |
| `chat/chat.js` | Chat coordinator: send/receive cycle, bubble DOM, click delegation, public `ChatManager` facade. Slimmed from 1,078 → 432 LOC in cycle 1 of the SRP refactor (2026-05-06). |
| `chat/chat-chips.js` | Suggested-question chips: pool tracking, rendering, sizing, follow-up rails, language-switch handling. Exports `FIXED_CHIPS` constant + `ChatChips` namespace. New file (cycle 1, 460 LOC). |
| `chat/chat-prefetch.js` | Background answer prefetch + cached-answer resolution + on-demand translation of cached answers. Exports `ChatPrefetch` namespace. New file (cycle 1, 157 LOC). |
| `chat/chat-voice.js` | Web Speech API + waveform overlay. Exports `setupVoice({ chatInput, sendChat })`. New file (cycle 1, 177 LOC). |
| `analytics/analytics.js` | Usage event tracking |
| `owner/...` | Owner / admin dashboard panels (analytics, sessions, controls). |
| `orchestrator/process-url.js` | URL → meta → pipeline → results reveal orchestration (Phase 4c #2 split). |
| `orchestrator/process-url-state.js` | `AppState` reads/writes for process flow. |
| `orchestrator/process-url-fetch.js` | Meta fetch, cap eval, `processVideoTestPipeline` wrapper. |
| `orchestrator/process-url-view.js` | DOM/UI: reveal factory, toasts, loading chrome, post-rewind playback. |
| `app.js` | App initialization, event wiring |

---

## Language & Fonts (i18n)

105+ language support: source detection, translation of every panel,
bilingual display, correct script-aware font rendering for any combination
of languages on screen (including mixed-script content like a Persian
title quoted inside an English summary).

**Translation pipeline**: Google Translate API primary (~1–2s for full
transcript), GPT-4o fallback for 16 complex-script / low-resource
languages (`TIER_4O_LANGS`: si, my, km, gu, yo, ig, zu, xh, mi, sm,
haw, lo, am, bo, ti, wo). Bilingual UI is a 3-button design (flag /
flag / dual-flag) with column-swap. Quality safeguards
(`_fix_repetition`, `check_quality`, `_strip_prompt_leak`) guard
GPT-translated output.

**Music-only video detection (added 2026-05-04)**: After transcript
loads, `_detectMostlyMusic` (in `app.js`) counts non-annotation words
across the whole transcript; if < 100, sets `AppState.isMostlyMusic`
+ `body.is-mostly-music`. CSS hides the transcript/subtitles content
and reveals a friendly placeholder ("This video is mostly music — no
real spoken content to transcribe"); summary + chapters tabs show a
small badge. The placeholder + badge text re-localise on language
switch via `data-i18n-key` attributes resolving against `UI_STRINGS`.
Same detection mirrored in `pipeline.js` so the initial 1000-char
subs-preview substitutes the friendly line instead of rendering
"[Music] [Music] [Music]…" while the real summary streams in.

**Font system (v2.1, shipped 2026-04-30)**: Single Google Fonts `<link>`
declaring all 31+ script families; browser fetches each binary lazily via
`unicode-range`. Role-based CSS tokens (`--font-content-body / -heading
/ -chat`, `--font-brand-*`) used by user-content selectors;
`var(--font-i18n)` cascade tail handles per-codepoint script selection.
JS gate `awaitFontForLang(lang, sample)` awaits the right script font
before paint (800ms cap on source-lang render, 1500ms on translation
swaps). Disambiguation block forces correct face for Arabic / JP /
zh-tw / KO across 14 surfaces (where Unicode block sharing means the
cascade alone can't disambiguate).

→ Full details, decision log, file map, edge cases, and external review
in [`13_LANGUAGE_AND_FONTS.md`](./13_LANGUAGE_AND_FONTS.md).

---

## Subtitle Language Switching

When the user switches to a translated language and the bilingual display is in "switched" mode (translated text on top), subtitles in the video overlay also switch to the translated language.

### Why timestamp-based mapping (not index-based)

Whisper/SubsProvider segments and merged transcript lines do NOT have a 1:1 correspondence. Subtitles come from raw segments (many short fragments), while transcript lines are merged/grouped for display. An index-based mapping (`subtitle[i] = translatedLine[i]`) would be wrong because the arrays have different lengths.

Instead, `_updateSubtitleLang()` in `translation/translation-ui.js` maps each subtitle segment to a transcript line by timestamp:
1. For each subtitle segment, find the transcript line whose timestamp range covers the subtitle's start time
2. Look up the translated text for that line from the translation cache
3. Fallback: if no exact match, use the nearest earlier translated line

This uses `AppState.segmentTimestamps` (the start time of each merged transcript line) as the lookup index.

---

## Mobile Flat Scroll System

> **History note:** RecapShark previously used a 3D-cylinder UI on mobile (text wrapped around a rotating drum). It was **replaced with flat native scroll** in late April 2026 (commit `20b670e — changed to flat on mobile instead of cylinders`). Reasons: the cylinder approach promoted hundreds of DOM nodes per render (~1,260 for a single short summary in CylinderScroll), competed with the iOS compositor for input, and produced visible "mini-jumps to catch up" during auto-follow because programmatic `scrollTop` writes integer-clamp on iOS Safari. The flat system below is the active mobile UI.

On mobile (≤ 900px viewport), flat scrollable panels replace the desktop layout:

| Component | File | Used by | Approach |
|---|---|---|---|
| **FlatTranscript** | `flat-transcript.js` | Transcript, Subtitles | Hybrid native scroll + transform-based auto-follow. Two factory instances (one per tab). Auto-scroll synced to video. |
| **SummaryNativeScroll** | `summary-native-scroll.js` | Summary | Plain native `overflow-y: auto` with `mask-image` edge fade and `content-visibility: auto` for off-screen blocks. No video sync. |

Both are factory functions (no `new`), matching the API surface they replaced (`prepare`, `show`, `hide`, `destroy`, `isReady`) so `renderer.js` integration was a near-1:1 swap.

### FlatTranscript (Transcript + Subtitles)

The mobile transcript / subtitle list. Two independent factory instances are created from `renderer.js`:

- **`_transcriptFlat`** — paragraph-grouped items (Transcript tab, container `#fullTranscriptPanel`)
- **`_subtitleFlat`** — line-by-line items (Subtitles tab, container `#fullSubtitlePanel`)

Each instance owns its own scroll position, its own floating buttons (auto-scroll toggle, jump-to-now), and its own user-interaction state. Only one is visible at a time; `setMode()` in `renderer.js` toggles which container is shown and re-syncs to the current player time.

#### Hybrid scroll (the key trick)

FlatTranscript runs in one of two modes, swapped seamlessly:

1. **`'native'` mode (default — user input wins here):** the inner scroller is `overflow-y: auto`. iOS Safari handles it on the compositor thread (UIScrollView) — free 120Hz ProMotion, native momentum, sub-pixel rendering. Touch drag and inertia live here.

2. **`'follow'` mode (auto-follow during playback):** scroller's `scrollTop` is parked at 0; the content is positioned via `transform: translate3d(0, -y, 0)` instead. We own a sub-pixel `_y` value and ease it via `requestAnimationFrame`. translate3d goes straight to the GPU compositor, no integer clamping → genuinely sub-pixel motion.

**Why hybrid:** programmatic `scrollTop` writes are integer-clamped on iOS Safari. A 220ms exponential ease toward a slowly-advancing playback target produces sub-pixel per-frame deltas that round to zero most frames, then accumulate into a 1px jump — visible "tiny mini-jumps to catch up" during auto-follow. Transform-based motion has no such limitation, but you can't drag a transform with your finger naturally — hence the swap on touchstart / scroll-from-other-input.

**Mode swaps are visually identical** at the moment of swap (worst case sub-pixel rounding error <0.5px when leaving follow mode).

#### Auto-follow loop

A single rAF loop eases the content's `_y` toward the latest target with an exponential time constant (`FOLLOW_TAU_MS = 220ms`, same shape as the desktop `_dsScrollTo`). The loop **does not exit on threshold convergence** — it only exits when no new target has arrived for `FOLLOW_IDLE_STOP_MS = 300ms` (i.e. the external 100ms sync loop has stopped, meaning playback paused). Exiting on convergence and idling between the 100ms ticks is exactly what produced the old "mini-jumps" symptom.

#### User-interaction gating

- `touchstart` → set `_userInteracting = true`, exit follow mode immediately so the touch drag picks up at the correct visual position.
- `touchend` → wait for momentum scroll events to settle (`SCROLL_SETTLE_MS = 100ms` of no scroll), then start a `USER_COOLDOWN_MS = 1500ms` cooldown before auto-follow resumes.
- Programmatic `scrollTop` writes set a 50ms `PROGRAMMATIC_GRACE_MS` window so the scroll handler doesn't misclassify them as user input.
- All listeners are passive — we never `preventDefault`, so iOS keeps native scroll on the compositor.

#### Active row anchoring

`ACTIVE_ROW_TOP_FRAC = 0.4` — the active row's **top** sits at 40% of viewport height. Anchoring the top (not the center) keeps placement stable across mixed row heights — bilingual rows are ~2× taller than single-language rows, and a center anchor would push tall rows up against the top edge.

The target Y is computed by **linearly interpolating between the current and next paragraph centers** based on playback time, so motion is continuous across paragraph boundaries (no snap-then-wait).

#### updateItems (language switch without rebuild)

Language switches and bilingual toggles call `updateItems()` instead of `prepare()`. When the row count is unchanged (same paragraphs, same timestamps, just different text/subtext/language), it mutates `textContent` in place — single repaint, no DOM teardown, no flicker. Hundreds of nodes don't have to be torn down on every language switch (which used to cause visible flash).

If the row count differs (rare — translation can occasionally split/merge paragraphs), it falls back to a content rebuild but keeps the wrapper, scroller, and event listeners alive.

#### Public API

`prepare(container, items, opts)`, `updateItems(newItems)`, `show()`, `hide()`, `destroy()`, `isReady()`, `scrollToTime(seconds, smooth)`, `isUserInteracting()`, `isTimeVisible(seconds)`, `clearInteraction()`, `getAutoScroll()`, `setAutoScroll(val)`.

`scrollToTime`'s `smooth` param: `'instant'` = jump, no auto-scroll suppression; `false` = jump + suppress auto-scroll for 1s; `true` = continuous follow when auto-scroll is on, one-shot animated jump otherwise. `prefers-reduced-motion: reduce` collapses smooth → instant.

### SummaryNativeScroll (Summary)

Replaces the old `CylinderScroll` for the mobile summary panel. Summary content is read once, linearly, with no video-time sync requirement — native scroll is the right primitive.

- **Plain `overflow-y: auto` scroller** wrapping the rich summary HTML (`p`, `h1-6`, `ul`, `ol`, `blockquote`, `pre`).
- **Edge fade via `mask-image`** — gradient on the scroll container fades the top and bottom edges. Zero extra DOM, hardware-accelerated, no overlay z-index management.
- **`content-visibility: auto` on block elements** — lets the browser skip rendering off-screen blocks. Combined with `contain-intrinsic-size: auto 24px` (a deliberately conservative guess that gets refined as blocks scroll into view), the scrollbar length stays approximately correct.
- **`update(html)` preserves scroll position** across language switches.

`show()` and `hide()` are intentional **no-ops** — the parent host (`#summaryWheelHost`) toggles its own `display`. Kept on the API for symmetry with the cylinder so renderer call sites don't need to special-case.

#### HTML structure

```html
<div id="summaryPanel" class="summary-pane">
  <div id="summaryContent"><!-- desktop flat summary (hidden on mobile) --></div>
  <div id="summaryWheelHost" class="summary-wheel-host" style="display:none">
    <!-- SummaryNativeScroll mounts here on mobile -->
  </div>
</div>
```

(The `summaryWheelHost` ID is a holdover from the cylinder era — kept to avoid touching CSS / renderer wiring.)

#### Public API

`prepare(container, html)`, `update(html)`, `show()`, `hide()`, `destroy()`, `isReady()`.

### Mobile Default Tab + Loading Skeleton (2026-05-11)

**Default active tab on mobile is Transcript** (not Chapters or Summary). Desktop keeps Summary as its default — the mobile-only flip is what made this shipping work non-trivial. The flip lives in `loading-state.js` `showLoadingState()`:

```js
const defaultMode = isMobile ? 'transcript' : 'summary';
Renderer.setTranscriptMode(defaultMode);
```

The reset path **routes through the central `Renderer.setTranscriptMode()`** tab router, not a manual `.active` class flip. Routing through `setTranscriptMode` keeps JS state (`RendererMobilePanels._activeMode` / `_activeMobilePanel`) in sync with CSS state (`.tab-btn.active` / `.tab-pane.active`); without it, the mobile FlatTranscript lifecycle has no idea which tab the user is on, so the prepare-on-demand path never fires for the default tab.

**Mobile transcript-pane skeleton.** `loading-state.js` injects a `.flat-transcript-placeholder` div into `#fullTranscriptPanel` at reset time, parallel to the chapters-mobile skeleton in `#chaptersTabList`. The placeholder renders ~6 fake paragraph rows inside a `<div class="flat-transcript-content">` wrapper so every real-transcript CSS rule (block layout, 8px 14px padding, `.alt-row` zebra tint, no border between rows) applies verbatim — under the rewind blur the placeholder silhouette is indistinguishable from the real rows that replace it. Lang-aware placeholder text in **en + fa + ar + he + ja + zh + ko + hi** (`_TRANSCRIPT_PLACEHOLDER_BY_LANG`), swapped on language detection by `updatePlaceholderTitlesLang(lang)` — same idempotency check as chapters (only swap if `.transcript-paragraph-placeholder` is still present). `FlatTranscript.prepare()` later does `container.innerHTML = ''` on `#fullTranscriptPanel`, wiping the placeholder when real data lands — no explicit teardown needed.

**Data-arrival lifecycle hook.** `Renderer.renderTranscriptContent()` in `renderer.js` was a no-op on mobile pre-2026-05-11 (the comment said "panels are managed by setMode()"). That worked while Chapters was the default because users inevitably tap-switched to Transcript, firing `setTranscriptMode('transcript')`. With Transcript as default, no implicit tap happens, so the FlatTranscript panel never `prepare()`-d. The hook now reads `RendererMobilePanels.getActiveMode()` and re-fires `showMode(activeMode)` for `'transcript'` / `'subtitles'` — idempotent + prepare-on-demand, safe to call repeatedly, guarded on active mode so other tabs aren't surprise-prepared.

**`.component-enter` exemption.** `process-url-view.js` adds `.component-enter` (opacity:0 fade-in-on-data) to `#topicsList`, `#summaryDisplayHost`, and `#fullTranscriptPanel` during rewind. When Transcript is the mobile default, `#fullTranscriptPanel` is exempt so the placeholder rides in WITH the morph (visible under the rewind blur) instead of fading in after data lands. Other panels still use the original fade-in pattern.

### Mobile morph cream-bg paint chain

The landing→video morph keeps a cream backdrop visible while dark panels slide in over it ("ASMR" continuity — no dark/cream snap). The mobile paint chain has four contributors, in stack order from bottom:

| Element | Bg | When | Why |
|---|---|---|---|
| `body` | `--nav-bg` (dark navy) | always | iOS safe-area tint via `body::before` |
| `.dashboard` (mobile) | `--nav-bg` normally, **cream during `body.morphing`** | always | panel-gap fallback. The `body.morphing .dashboard { background: var(--bg) }` override (mobile-layout.css) prevents the dashboard's navy from leaking through `.center-panel` while its `morph-enter-up` animation has it at opacity:0 |
| `#resultsView` | transparent normally, cream during `body.morphing` | `body.morphing #resultsView { background: var(--bg) }` rule in dashboard.css | dark sliding panels read against cream |
| `.home-view.morph-overlay` | solid cream (`var(--bg) !important`) | during morph-overlay overlay state | flattens the home page's natural `linear-gradient(--bg → --nav-bg)` so the dark-navy bottom of the gradient (designed for iOS URL-bar collapse on the standalone landing page) doesn't read as a "dark-blue snap" when the home content fades out mid-morph |
| `.tab-pane.active` | cream | always | the bottom mobile pane |

Each lower layer needs cream during the morph; remove any one and the next-darker ancestor shows through. The most common regression: someone touches `.tab-pane.active`, `.tab-content`, `.dashboard`, or `.home-view.morph-overlay` background while debugging something adjacent. **Don't touch any of those backgrounds without re-checking the chain.**

### Mobile Transport Buttons

On mobile, the play/pause, prev (-10s), next (+10s), and CC buttons are moved from the desktop mech-panel strip into a `.mobile-controls-row` inside `.video-meta` by `mobile-sticky.js`. These buttons visually overlap the video player area. The z-index stacking fix (`video-meta` z-index: 6 > `video-embed` z-index: 5) ensures buttons capture taps in the overlap zone, while `.video-meta`'s empty background area passes clicks through to the video player's overlay for play/pause.

---

## Chat System

Chat lives in `src/js/chat/chat.js` plus the bilingual greeting switcher in `translation-bilingual.js`. The chat panel is desktop-resident; on mobile it lives behind the FAB and gets reparented into a fullscreen overlay by `mobile-chat.js` on open.

### Greeting Bubble (top of chat)

The greeting is **pinned to the top** (YouTube/Gemini pattern) — `.gb-host` contains two stacked `.gb-display` slots (A/B). Language switches render the new greeting into standby and crossfade. Per-bubble `.lang-fa` / `.rtl` classes drive font + direction, so an old bubble keeps its original Persian font even when the rest of the UI is in English (and vice versa). `_applyBubbleDirection()` is exposed as `window._applyBubbleDirection` for chat.js to use on the very first paint.

### Suggested-Question Pills

- **2 fixed pills** ("What's the video about?", "Summarize the video") + **2 dynamic pills** appear under the greeting. Dynamic pills are LLM-generated by the pipeline (10-question pool returned via the dedicated `/api/suggested-questions` endpoint, stored in `AppState.suggestedQuestions`).
- After every AI answer, **2 follow-up pills** are appended below the new bubble, drawn from the same pool. A used-set (`_usedDynamicQuestions`) ensures every pill is unique across the conversation.
- Pills are translated lazily via `chipTranslationCache` (separate from `translationCache` so chip translations don't make `setLanguage` skip the summary/chapters/transcript API calls).
- Width sizing: chips wrap at 86% max-width, then `_sizeChipToContent()` measures the longest wrapped line via `Range.getClientRects()` and pins the box to that width — avoids the visible empty gap that `text-align: right` leaves inside an over-wide box.

### Prefetched Answer Cache

`prefetchAnswers()` runs after the pipeline completes. For each pill question, it sends a background `chatWithVideo` call in the video's source language and stashes the answer in `AppState.chatAnswerCache`. When the user taps a pill, `_resolveCachedAnswer()` returns the cached answer (translated if needed via `chatAnswerTranslations`) and `sendChat({ precomputedAnswer })` short-circuits the live LLM call. A `CACHED_THINKING_MS` (800ms) hold on the typing bubble keeps cached and live answers feeling consistent.

### Mobile Maximize Toggle

The mobile chat overlay has a maximize button that toggles `.mobile-chat-overlay.maximized` for a near-fullscreen view. State and label sync are handled inline in `mobile-chat.js` / `click-handlers.js`.

---

## Entity Highlighting System

`src/js/ui/entity-highlighter.js` is the shared highlighter for transcript, chat bubbles, and summary. Two layers stack:

### Layer 1: Regex-based (dates, numbers, stretch, discourse, punct)

`highlightTextNodes(el, { types })` walks text nodes and wraps regex matches with type-specific classes (`.tx-date`, `.tx-num`, `.tx-stretch`, `.tx-discourse`, `.tx-punct`). Per-mode/theme palette in `dashboard.css` colors these in a way that reads cleanly across light/dark/brutalist. Skips text inside `.summary-highlight`, `.chat-ts`, `.bubble-label`, etc., to avoid double-marking.

### Layer 2: LLM markers (`[[people]]`, `((places))`, `**terms**`)

The summary/chat prompts ask the LLM to emit `[[Name]]` for people, `((Place))` for locations, and `**term**` for key concepts. `Helpers.applySummaryHighlights()` parses these markers and wraps them in styled spans. A typo-tolerant normalizer fixes common LLM output bugs (mismatched bracket counts, stray spaces inside brackets).

### Why both layers

LLM markers are *curated* (only the entities the model thinks matter); regex is *exhaustive* (every date/number gets coloured for visual scanning). They're complementary — for chat bubbles, the regex pass deliberately skips the `name` type so it doesn't second-guess the LLM's curated picks.

---

## Theming System

The app supports multiple visual styles via CSS custom properties (design tokens) set on `:root` by `src/js/ui/themes.js`. Three categories cycle via three buttons:

- **Brutalist** (default) — sharp/chunky aesthetic. Syne / Space Grotesk / Unbounded fonts, 2–6px radii, 2–3px borders, hard-offset shadows (`2px 2px 0 …`), uppercase 700 headings with 0.05em tracking. Signature colours: teal `#0891B2` accent, red `#DC2626` accent2, yellow `#FFD100` highlight-warm, coral `#EE5E48` highlight-pop, hot pink `#FF2D78` title hero, teal/cyan neon chat tab button.
- **Light** (6 themes) — Cyber Ocean, Violet Dreams, Cherry Blossom, Terracotta, Classic Blue, Emerald Scholar.
- **Dark** (5 themes) — Gold & Obsidian, Deep Space, Midnight Crimson, Shadow Emerald, Carbon.

### Design tokens

Every theme defines **colour tokens** in its `theme.vars` object: `--accent`, `--accent2`, `--accent-light/-hover`, `--accent2-light`, `--bg`, `--surface`, `--surface2`, `--border`, `--separator`, `--nav-bg`, `--nav-muted`, `--chip-bg`, `--chip-text`, `--text-primary/-secondary/-muted`, `--vc-bg/-border/-text/-text-bright/-cc-bg/-cc-border`, `--bubble-ai-bg/-text/-border`, `--bubble-label-color`, `--highlight-kw/-name/-date/-tr/-karaoke/-warm/-pop`.

Brutalist uniquely defines **structural tokens** (fonts, radii, borders, shadows, heading styling) in its `theme.vars`:

| Token | Brutalist | `:root` default (light/dark inherit) |
|---|---|---|
| `--font-heading` | `"Syne", sans-serif` | `"Space Grotesk", sans-serif` |
| `--font-body` | `"Space Grotesk", sans-serif` | `"Inter", sans-serif` |
| `--font-mono` | `"JetBrains Mono", monospace` | same |
| `--font-display` | `"Unbounded", sans-serif` | `"Bebas Neue", sans-serif` |
| `--radius-sm/--radius/--radius-lg` | `2px / 4px / 6px` | `6px / 10px / 16px` |
| `--border-width` / `--border-width-thick` | `2px / 3px` | `1px / 2px` |
| `--shadow-sm/md/lg` | hard offset (`2px 2px 0 …`, etc.) | soft blur (`0 4px 16px rgba(0,0,0,…)`, etc.) |
| `--heading-weight` / `--heading-case` / `--heading-letter-spacing` | `700 / uppercase / 0.05em` | `600 / none / normal` |

This is the key architectural move: brutalist gets its aesthetic from **token values**, not from hundreds of per-rule `body.theme-brutalist` overrides throughout the CSS.

### `applyTheme()` flow (`themes.js`)

1. Flush brutalist structural tokens from the previous apply via `STRUCTURAL_TOKEN_KEYS.forEach(k => root.style.removeProperty(k))`. Without this, brutalist's radius/font/shadow values would "stick" when cycling to a light/dark theme (which don't define them).
2. Push `theme.vars` onto `:root` via `root.style.setProperty`.
3. Set **derived `--mech-*` tokens** — the video-controls colour set: `--mech-accent` = accent, `--mech-bright` = `lightenHex(accent, 0.35)`, `--mech-glow` = `hexToRgba(accent, 0.4)`, `--mech-dim` = `--vc-border`, `--mech-icon/--mech-text` = `--vc-text`, `--mech-sep` = `darkenHex(--vc-text, 0.5)`.
4. Update inline styles on `.now-watching-bar` / `.nw-label` (those use multi-stop RGBA mixes that can't be expressed as CSS vars).
5. Toggle `body.theme-brutalist` class.

### FOUC prevention — baked theme classes in `index.html`

The default theme classes `theme-brutalist theme-mode-brutalist` are written **directly into the `<body>` tag** in `src/index.html`. Without this, the first paint would use the `:root` default tokens (light blue `#EFF9FB`), then `applyTheme()` runs on `DOMContentLoaded` and flips the body to brutalist's `#F5F0E8` — a visible flash. The baked class makes brutalist's tokens win from the very first frame. JS still cycles themes normally — `applyTheme()` removes any existing `theme-*` class before adding the new one (line 122 in `themes.js`).

### CSS rule pattern: "generic + brutalist preservation"

Every UI element follows:

```css
/* Generic rule — themes on every theme via tokens */
.element { background: var(--accent); font-family: var(--font-body); }

/* One short override only where brutalist needs a value tokens can't produce */
body.theme-brutalist .element { background: var(--highlight-warm); }  /* signature yellow */
```

Brutalist-preservation overrides remain for a small set of elements where the signature value doesn't map to a token: yellow scrubber fill/current-time/vol-fill, hot-pink title hero (`--accent2` is red `#DC2626`, signature is pink `#FF2D78`), cyan live-time glow on `.mech-time-current`, and the teal/cyan chat tab button. Everything else is fully token-driven.

### Casual mode

`body.casual-mode` (on by default, toggled by the 🙂 button) re-colours the now-watching bar + chat "RecapShark.com" label + tab-btn.active + a few other elements to feel more casual. Colours route through **`var(--accent2)`** (the theme's secondary accent) — was hardcoded red `#DC2626` until the theme refactor. Brutalist's `--accent2` is `#DC2626` so brutalist looks identical; other themes get their own secondary accent (pink on Deep Space, cyan on Midnight Crimson, coral on Classic Blue, etc.).

**Removed** (major fix): `body.casual-mode .now-watching-bar { --accent: var(--accent2); }`. That remap silently rewrote `--accent` inside the now-watching bar, so the middle controller (inside) and the scrubber (outside) would resolve `var(--accent)` to two different theme variables — the two sections rendered in different colours on every non-brutalist theme.

### Mobile theme coverage highlights

- **Scrubber** (under video) + **middle controller** (inside now-watching bar) share the same two-colour palette per theme: `var(--accent)` full for play/CC/fill/elapsed; `var(--accent)` at 50% opacity for total times.
- **Prev/next buttons** on desktop use explicit CSS `fill: var(--mech-icon)` instead of the HTML `fill="var(--mech-icon)"` attribute (some browsers don't re-evaluate var() in presentation attributes on CSS variable change).
- **Unified video-meta background** on mobile: `.video-meta` + `.title-display-host` + `.video-meta::after` right-edge fade all use `var(--nav-bg)` → one seamless panel behind title + controls on every theme.
- **Mobile flat-transcript inherits theme tokens via CSS** (no JS color blending). The previous cylinder/wheel mobile UI computed text colors in JS by blending `--text-secondary` and `--accent`; the flat list defers entirely to CSS variables on `.flat-transcript-content` rows.

### Files

| File | Role |
|---|---|
| `src/js/ui/themes.js` | Theme registry, `applyTheme()`, cycle functions, `STRUCTURAL_TOKEN_KEYS` |
| `src/css/dashboard.css` | `:root` default tokens (single source of truth post-2026-05-08 — also holds `--mech-*` and `--karaoke-*` consolidated from `home.css` / `karaoke.css`) + most element rules. Brutalist-preservation overrides live in the sibling files below. |
| `src/css/brutalist.css` | All `body.theme-brutalist` reskin rules — nav, theme switcher, user menu, now-watching bar, mech panel, video controls, transcript, chat, RTL, etc. Loaded after `dashboard.css` so the brutalist token redefine wins via cascade order. (Phase 3 D3 ext, 2026-05-08.) |
| `src/css/mobile-layout.css` | The single big `@media (max-width: 900px)` Mobile Layout block that owns nearly all mobile reflow (dashboard 1-column, mobile nav, mech panel, tab bar, flag picker, overlays). Includes ~12 nested `body.theme-brutalist` mobile-only overrides. Loaded between `dashboard.css` and `brutalist.css`. (Phase 3 D3 ext2, 2026-05-08.) |
| `src/css/home.css` | Home page + mech-panel + title display styling (all token-driven). `--mech-*` token defaults moved to `dashboard.css :root`. |
| `src/css/title.css` | Video title double-buffer + hero word (mobile) |
| `src/css/transcript.css`, `summary.css`, `chapters.css` | Section-specific rules (token-driven where relevant) |

---

## Other Non-Obvious Design Decisions

### Dedicated title translation endpoint
Reusing the summary translation prompt for short title text caused hallucination -- the model would generate explanatory text, context notes, or expand the title. The dedicated `/translate/title` endpoint uses a minimal prompt that explicitly asks for one-line output only.

### Named-Entity Recognition (transcript highlighting)

`pipeline/ner.py` runs spaCy over the fetched transcript to extract person names, places, dates, and other entities, plus auto-recases the transcript when it arrives in all-caps (some auto-captions do). The result feeds the frontend's `entity-highlighter.js`, which colours the entities inline. spaCy is venv-only — running uvicorn outside the venv silently disables NER (no `[NER]` log line, names render plain).

### Karaoke (character-level wave highlight)

`player/karaoke.js` provides real-time character-level highlighting synced
to video playback using AsrProvider word timestamps. Highlight is a continuous
wave (peak + falloff to neighbors) rather than a single-word toggle.

- **Data source:** `/api/karaoke-chunk` (lazy / chunked).
- **Word + char spans:** `_buildWordSpans()` replaces `.ts-text` content with
  `<span class="k-word">` per token; inside each k-word, every character is
  wrapped in `<span class="k-ch">`.
- **Wave loop:** a separate rAF loop computes a per-frame intensity `--k`
  (0..1) on each char near the playhead via a Hann-window bell. Char midpoint
  time is interpolated within its parent word's `[start, end]`, so the wave
  always tracks ~3-letter spread sub-letter-smooth across word boundaries.
- **Effects (single source of truth in `css/karaoke.css`):** ALL visual
  cost — color tint, scale-up, 2-layer outer-wash glow (14/30px) — lives
  ONLY on `.k-ch.lit`. The base `.k-ch` rule is intentionally minimal so
  the thousands of non-lit chars in a long transcript pay nothing per
  paint or scroll. Three tunable CSS knobs: `--karaoke-glow-color`
  (defaults to each theme's `--highlight-karaoke`, falling back to
  `--accent`), `--karaoke-scale`, `--karaoke-radius-sec`. Shape-based —
  even if a future palette tweak collides the glow color with another,
  the scale + glow shape still reads.
- **Perf (post-2026-05-04 cleanup):**
  - Effects gated behind `.lit` class so non-lit chars have no transform
    / glow / color-mix = no compositor layer + no per-paint calc.
  - `.k-word` elements indexed by `data-key` into `_wordElsByKey` Map for
    O(1) lookups in the wave loop (no per-frame `querySelectorAll`).
  - `__kchars` array cached on each `.k-word` at wrap time, so the wave
    loop reads the char list directly off the element instead of running
    a fresh `querySelectorAll('.k-ch')` per word per frame.
  - Idle-skip via `_lastWaveTime`: when `getCurrentTime()` returns the
    same value as the previous frame (paused, scrolling, iframe yet to
    tick), the loop returns immediately — visually identical, near-zero
    cost.
  - Scratch `_waveNewLit` Set reused across frames (swapped with
    `_waveLit`) — no per-frame allocation.
  - `--karaoke-radius-sec` cached after first read; invalidated on `reset()`.
- **`syncWord(t)`:** still heartbeat-driven (~100ms) — owns the lazy chunk
  loader trigger AND the bilingual sub line-level highlight
  (`karaoke-sub-active`, lang-2 line treatment per
  `project_lang2_line_highlight`). Word-level visual is now the wave
  loop's responsibility.
- **Translation-aware:** `_hasOriginalTextVisible()` gates BOTH the apply
  path and the wave loop. When showing translated-only text, the wave
  parks (clears all lit chars) — AsrProvider words are in the original language.
- **Bilingual mode:** original text gets the char wave; the corresponding
  bilingual sub sentence gets a line-level `karaoke-sub-active` color tint.

### CC defaults to OFF
`AppState.ccEnabled = false` in `initSubtitles()` (`player.js`). Users can tap the CC button to enable.

### SubsProvider subprocess isolation
`_subs_provider_via_subprocess()` and the subs endpoint use `subprocess.Popen` with curl instead of making HTTP requests directly from the FastAPI process. This avoids Cloudflare 1010 blocks that occur on second and subsequent requests when the server process is long-lived.

### Subs endpoint retry logic
The `/test/subs` endpoint retries up to 3 times with 1s/2s backoff. After 3 failures, it returns empty content (not an error) so the frontend pipeline can fall back to AsrProvider or show the no-subs placeholder gracefully.

### Language detection override
After fetching subtitles, `langdetect` re-detects the actual language from the text content. SubsProvider sometimes reports the wrong language code, so this override ensures downstream processing (summary language, translation source language) uses the correct code.

### Chat transcript formatting
The `/chat` endpoint accepts pre-formatted transcript text from the frontend (with `[MM:SS]` timestamps already included). This avoids re-formatting on every chat request and lets the frontend control the format. Falls back to building from raw segments for backward compatibility.

### Persian (fa) prioritization
The user primarily works with Persian content. Persian is second in the `POPULAR_LANGS` list (after English) in `translation/lang-meta.js`, and second in `LANG_NAMES` in `translate.py`. Language dropdowns show Persian prominently.

### Mobile RTL chapter columns
Mobile chapters use CSS `column-count: 2` (`chapters.css`). For RTL languages (fa/ar/he/ur), `#resultsView.rtl .chapters-list-mobile` adds `direction: rtl` on the multi-column container, which flips per-column box order — first 5 chapters land on the right column, next 5 on the left. Chapter items inside still get their own RTL direction via existing `.cs-display.rtl` rules.

### Snapshot-overlay crossfade on language switch
On mobile, switching translation language triggers a snapshot-overlay crossfade so the user doesn't see partial re-renders during the rebuild. Implemented in `translation-bilingual.js` / `translation-ui.js`.

### Bilingual flags hidden while pending
While translation is in flight, the bilingual control strip is marked `.pending`. On mobile, CSS hides the entire strip during this window — desktop keeps the disabled buttons visible so the user gets immediate feedback that the bar exists. Bilingual progress percentage still shows via the separate `.summary-progress-inline` element.

### Brutalist mobile greeting font
The greeting bubble has `gb-display` class. The desktop `.gb-display.lang-fa` rule (specificity 0,2,0) loses to `body.theme-mode-brutalist .mobile-chat-overlay .chat-bubble` (0,3,1) which forces Space Grotesk. Regular bubbles win via `body.theme-brutalist .chat-bubble.lang-X:not(.gb-display)` (0,4,1) — but the `:not(.gb-display)` excludes the greeting. A dedicated `body.theme-brutalist .mobile-chat-overlay .gb-display.lang-X` rule (0,4,1) restores Vazirmatn / Noto for the greeting on brutalist mobile.

### Per-language title colorization
`title-colors.js` computes a per-language palette for the video title hero word. Title swaps go through `title-switcher.js` (double-buffer crossfade pattern, same as chapters/summary/greeting), driven from `renderCurrentState()`.

Phase 9b (2026-05-07) split title-switcher.js from 732 LOC into a 5-file cluster, all under `src/js/ui/`:
- `title-switcher.js` (395 LOC) — `_tss` state + lifecycle (`update`, `forceUpdate`, `apply`, `reset`), crossfade machinery, mobile-breakpoint listener.
- `title-parts.js` (148 LOC) — pure HTML building: `parseParts`, `wordCount`, `stylePipe`, `buildDisplayHTML`, `buildBilingualHTML`.
- `title-fit.js` (111 LOC) — pure responsive sizing: `fitHero(panel, lockedHeight)` plus `TALL_SCRIPT_CLASSES` for script-aware tuning.
- `title-lang.js` (90 LOC) — pure script + RTL + font helpers: `scriptClassFor`, `ensureFont`, `langClassesFor`, `stripLangClasses`, `applyLangClasses`, `SUPPORTED_SCRIPT_LANGS`.
- `title-resolve.js` (51 LOC) — pure language → HTML resolution with the translated-language readiness gate: `resolveHTMLForLang`, `resolveHTML`.

Phase 9a (same date) migrated 7 non-module classic scripts from `src/public/js/ui/` (no longer exists) into `src/js/ui/` and ES-module-imported them from `src/js/main.js` so Vite bundles them: `shark-logo`, `scrollbar`, `mobile-chat`, `summary-switcher`, `chapter-switcher`, `click-handlers`, `title-switcher`. Each kept its existing `window.X` assignment so cross-module consumers saw zero diff.

---

## Frontend Module System

The frontend uses **native ES modules** bundled by **Vite**. All JS files use `import`/`export` syntax with a single entry point at `src/js/main.js`.

`main.js` imports every module and exposes necessary functions/objects on `window` (the "bridge pattern") for compatibility with remaining `onclick=""` handlers in the HTML. Development uses `npm run dev` (Vite dev server with HMR, proxies `/api` to FastAPI on port 8001). Production uses `npm run build` → static files in `dist/`.

---

## Architectural Decisions

These are the deliberate choices that shaped the codebase. Each entry has the decision, the rationale, and the conditions under which it should be re-examined. **They're not gospel.** If new evidence (perf data, security audit, scaling pain, real-world bug) contradicts a decision, the decision changes. Just don't propose changes based on "best practice" alone — the reasoning below was already considered.

### 1. Vanilla JS, no framework

**Decision:** No React/Vue/Svelte. Frontend is vanilla JS with ES modules + Vite.

**Why:** Solo dev wanted full control + zero framework churn cost. Avoiding the framework version-treadmill (build pipeline migrations, deprecations, peer-dep churn) was worth the extra wiring code.

**Re-examine if:** the app grows past 1-2 senior devs working in parallel; OR a specific feature genuinely needs reactivity primitives the current pattern can't express; OR component reuse with another product becomes a real requirement.

### 2. `window.X` bridge pattern

**Decision:** Public modules are exposed on `window` in `src/js/main.js` for HTML `onclick=""` handlers and cross-module reads.

**Why:** With no framework + inline event handlers in `index.html`, modules need a global namespace to be callable from HTML attributes. The bridge is the explicit, documented surface — not pollution.

**Current surface (2026-05-09, post-Bundle-5b):** **36 explicit `window.X = ...` assignments in `main.js`**, down from 55 post-Phase-4d. The cleanup follow-up dropped 6 dead bridges (Bundle 5a) and converted 12 live bridges to direct ES imports across 11 consumer files (Bundle 5b — `EntityHighlighter`, `_awaitFontForLang`, `_ensureFontForLang`, `_applyLangStyle`, `_applyTitleColors`, `__syncMusicOnlyLang`, `_applyBubbleDirection`, `_markSectionReady`, `_gbs`, `toggleCasual`, `_renderCurrentState`, `_scheduleRender`, `_refreshMobilePanels`, `_setTranscriptMode`). Every remaining bridge is either an HTML onclick surface (toggleOverlay, showToast, selectLang, etc.) or one of the two architectural bridges below. **Not counted in the 55:** `window.Sentry` / `window.__sentryInitialized` and `window.RS_ASSETS` — **boot bridges** set at module-eval time inside `core/sentry.js` and `core/assets.js` (first imports in `main.js`), because karaoke modules and `chat.js` read them before the bridge block runs (`REFACTORING_LESSONS.md` § boot-bridge trap).

**Justified exceptions to the "all bridges in main.js" rule** (5 — keep as-is):

1. `player.js:161` — `window.onYouTubeIframeAPIReady` is the YouTube IFrame API's external entry point; the API calls it by name on `window`, so it must be assigned where the player module sets it up.
2. `player/karaoke-debug.js:61` — `window.__KaraokeDebug` lives in a dev-only chunk (gated by `import.meta.env.DEV` per K3); moving the assignment to `main.js` would defeat the gate by pulling the symbol into the prod bundle.
3. `casual-mode.js:48` `window._tssDisplayMode = mode` and `title-switcher.js:390` `window._tssBreakpointBound = true` — these are runtime *state mutations* inside function bodies, not init-time bridge exports, so they don't belong in the main.js block.
4. `karaoke-debug.js` (12 internal mutations) — test-time mocks of `window.Sentry` / `window.showToast` for in-page test suites; they save the existing window value, swap a stub in, and restore the original on teardown. Not public exports.

**Phase 4d outliers — CLOSED 2026-05-09:** the two closure-captured bridges (`_setTranscriptMode` in `renderer.js`, `_setTransSubMobileMode` in `click-handlers.js`) were hoisted to module scope, completing the bridge-honesty pass started in Phase 2. **Both have since been deleted entirely** — Bundle 5a (cleanup follow-up, 2026-05-09) removed `_setTransSubMobileMode` (zero callers); Bundle 5b removed `_setTranscriptMode` (`click-handlers.js` now imports `Renderer` directly and calls `Renderer.setTranscriptMode(mode)`). `Renderer.setTranscriptMode` remains the public API method on the Renderer object; `setTransSubMobileMode` remains a named export from `click-handlers.js` for `app.js`'s rewind-finish flow.

**Architectural bridges intentionally kept (Bundle 5b, 2026-05-09):** `_updateCollapseBtnAvailability` and `_evalPendingForCurrentTab` are still bridged. Both are read from `ui/renderer.js setMode` to update the bilingual collapse button + per-tab `.pending` state. Direct imports would create a circular dependency `renderer.js → translation-bilingual.js → casual-mode.js → renderer.js` (the third edge already exists; the bridge is the deliberate sidestep). The bridge stays as an explicit decoupling layer with a `Don't promote without breaking the cycle first` comment in `main.js`.

**Re-examine if:** all `onclick=""` handlers get migrated to `addEventListener` (then the bridge has no consumers); OR a real framework adoption removes the need entirely.

### 3. IIFE module pattern

**Decision:** Most modules wrap as `export const Foo = (() => { ... return { publicAPI }; })();`.

**Why:** Gives encapsulation in vanilla JS without classes. Matches the "single object with named methods" mental model used at `window.X` boundaries.

**Known drift:** Some modules (`controls.js`, `translation.js`, `renderer-chapters.js`) use plain object/function exports. Not a problem yet — convention applies to coordinator modules, less strictly to small utility modules. If you extract a new module and it reads `this`, IIFE is the pattern. If it doesn't, plain exports are fine.

**Re-examine if:** ES2022 class features start providing meaningful encapsulation wins; OR a refactor naturally aggregates many small utilities into one place.

### 4. Subprocess wrapper for SubsProvider (`pipeline/_subs_provider_fetch.py`)

**Decision:** The FastAPI process spawns a `curl` subprocess for SubsProvider calls instead of using `httpx`/`aiohttp` directly.

**Why:** Cloudflare blocks long-lived processes (1010 errors). A short-lived `curl` subprocess bypasses that.

**Re-examine if:** Cloudflare's behavior changes (verify with a controlled test); OR SubsProvider is replaced with a transcript provider that doesn't fingerprint the connection lifetime; OR concurrent burst load causes too many subprocesses (then add a queue/cap).

### 5. Hybrid scroll on mobile (`flat-transcript.js`)

**Decision:** Mobile transcript switches between native `overflow-y: auto` and `transform: translate3d(...)` depending on user input vs auto-follow.

**Why:** iOS Safari clamps `scrollTop` writes to integer pixels — the resulting "mini-jumps" during smooth auto-follow were visible. Transform-based motion has no such limitation, but you can't drag a transform with your finger naturally. Hence the swap on touchstart / scroll-from-other-input.

**Re-examine if:** iOS Safari fixes the integer-clamp behavior (verify with a fresh test page); OR a user-input pattern emerges where the swap timing is wrong.

### 6. Theme tokens

**Decision:** Themes are CSS custom properties on `:root`, set by JS (`src/js/ui/themes.js`). Brutalist (default) defines structural tokens (fonts, radii, shadows); light/dark themes inherit `:root` defaults.

**Why:** Token-driven theming gives O(themes) cost instead of O(themes × elements) for new themes. Adding a theme is one `theme.vars` object.

**Re-examine if:** a designed-in-Figma theme can't be expressed via the current token set (then expand the tokens, not the pattern).

### 7. Single-worker uvicorn

**Decision:** PM2 runs uvicorn in single-process / single-worker mode.

**Why:** The token bucket + in-process semaphore in `pipeline/karaoke/client.py` are per-worker. Multi-worker would need Redis-backed equivalents.

**Re-examine if:** traffic exceeds what a single worker can serve (measure CPU saturation under real load before changing); OR a feature requires shared state across workers (then introduce Redis, not just naive multi-worker).

### 8. AppState mutation everywhere

**Decision:** `AppState` is mutated directly across many modules. No setters, no events, no immutability.

**Why:** Acknowledged as "out of scope for current refactor work." Introducing setters/events/immutability is its own bigger project, not a side effect of file splits.

**Reality (2026-05-07 audit):** writes are scattered — top-10 hotspots are karaoke-debug (65), data-loader (36), process-url (17), player (15), karaoke-chunk-loader (11), loading-state (8), casual-mode (8), karaoke (8), translation (7), renderer (6).

**Re-examine if:** a state-related bug class (race conditions, stale UI, double-render) emerges that's hard to fix without ownership boundaries; OR a Phase 2 project explicitly takes this on. Until then, document write owners per field.

### 9. No real test suite, by choice

**Decision:** Playwright happy-path E2E suite exists (`tests/e2e/`) but no unit / integration test framework. The in-page debug-panel pattern is the canonical "what's the regression risk for THIS module" tool.

**Why:** Solo dev project; cost of building + maintaining a test suite was judged higher than the cost of regressions caught manually + via the debug panels.

**Re-examine if:** regressions start shipping to users repeatedly; OR a second contributor joins (their delta-detection is much cheaper with tests); OR a critical-path module needs guaranteed invariants (chat persistence, billing accounting, etc.). Add tests where the cost of a silent break is high.

---

## File Structure

```
RecapShark/
  pipeline/               # Backend (Python)
    server.py             # FastAPI app entry point
    routes.py             # Core endpoints + sub-router aggregation
    youtube_routes.py     # YouTube metadata + preview summary
    karaoke/              # AsrProvider transcription + karaoke chunk pipeline (cycle 6 split, Phase 4e additions)
      __init__.py         # exports asr_provider_router, startup_smoke_test, _daily_log_watchdog
      routes.py           # 6 endpoints + slowapi limits + admin-key gating + URL-direct shared helper
      chunk_orchestrator.py  # /karaoke-chunk single-flight + cache lookup + audio readiness + claim → ffmpeg slice → AsrProvider
      chunk_store.py      # Supabase claim/insert/mark_ready/mark_failed + _supa_write best-effort wrapper (Phase 4e)
      client.py           # _ASR_PROVIDER_SEMAPHORE (22), AsyncTokenBucket, _asr_provider_post/_get, poll_asr_provider_until_done (Phase 4e), admin-key + key helpers
      billing.py          # _asr_provider_daily_cap_usd (RPC reads cap), [KARAOKE-DAILY] summary log + watchdog, _DAILY_SUMMARY_COLUMNS spec (Phase 4e)
      stats.py            # Admin sanity dashboard fetchers (Phase 4e: chunk counts / daily usage / audio cache / circuit breaker)
      errors.py           # 200-with-error envelopes + cooldown_ms tagging
      _constants.py       # Karaoke shape constants (Phase 4e: _ASR_PROVIDER_COST_PER_SECOND, FIRST/STEADY_CHUNK_DUR_SEC — MUST_MATCH frontend)
    _lib/
      rate_limit.py       # AsyncTokenBucket (general-infra; karaoke uses it but any vendor can)
    analytics/
      _session_filter.py  # build_keep_predicate + compute_chat_count_map (Phase 4e: single source for the 3 _keep predicates)
      ...                 # see 06_ANALYTICS.md for the full subpackage inventory
    transcript_routes.py  # SubsProvider subtitle/transcript fetch
    deps.py               # Shared rate limiter
    translate.py          # GPT translation service (fallback for 16 advanced-model languages, ADVANCED_MODEL_LANGS)
    google_translate.py   # Google Translate API (primary, batch requests)
    summarize.py          # Summarization prompts
    worker.py             # Summary/chapter generation; _call_chat split into build/call/parse (Phase 4e)
    openai_client.py      # OpenAI client factory
    constants.py          # Backend constants
    config.py             # Lazy env-var getters (Phase 4b — single source of truth for os.environ reads)
    langs.py              # Centralized language metadata + ADVANCED_MODEL_LANGS (Phase 4e: was triplicated)
    traffic_source.py     # GA4 medium/source bucket (Phase 4e: leaf module shared by ETL + analytics)
    get_audio.py          # Video ID extraction, metadata
    _subs_provider_fetch.py    # Subprocess script for Cloudflare bypass
  src/                    # Frontend
    index.html            # Single-page app (sole entry; previously split into a redirect-stub index.html + app.html — consolidated to remove the redirect hop)
    js/
      main.js             # ES module entry point + window bridge
      app.js              # App init, event wiring
      core/
        state.js          # AppState
        helpers.js        # Pure utilities
        constants.js      # Shared magic numbers
      api/
        client.js         # HTTP client
        pipeline.js       # Pipeline orchestration
        data.js           # Transcript data processing
      translation/
        translation.js    # Manager (orchestration)
        translation-bilingual.js  # Bilingual controls, flag toggles, progress
        translation-lang-panel.js # Language selection UI (search, popular/all)
        translation-transcript.js # Transcript parsing, HTML building, translated containers
        translation-ui.js # Subtitle language switching, bilingual DOM rendering
        translation-state.js  # Shared mutable state
        lang-meta.js      # 100+ languages metadata
      ui/
        renderer.js       # Summary/chapter/transcript rendering + mobile flat-list management
        flat-transcript.js     # ACTIVE mobile transcript/subtitles — hybrid native scroll + transform follow
        summary-native-scroll.js  # ACTIVE mobile summary — native overflow + mask-image fade
        entity-highlighter.js # Date/number/name regex highlighting + LLM marker normalizer
        transcript-buffer.js  # Double-buffered transcript crossfade on lang switch (CROSSFADE_MS)
        font-loader.js    # Lazy-load non-Latin font subsets per translation language
        controls.js       # Overlays, font, export, toast
        pipeline-ui.js    # Progress bars
        search.js         # Transcript search
        themes.js         # Light/dark cycling
        title-colors.js   # Per-language title colorization palette
        casual-mode.js    # renderCurrentState() — single authoritative render path
        feature-toggle.js # Feature flag toggles (UI gating)
        loading-state.js  # Loading skeletons, mobile-list cleanup on new video
        mobile-sticky.js  # Mobile sticky offsets, transport button relocation
      player/
        player.js         # YouTube player + subtitle overlay + auto-scroll sync
        karaoke.js        # Word-level karaoke highlighting
        rewind.js         # Rewind animation choreography (10s watchdog)
      chat/
        chat.js           # Chat: greeting bubble, suggested-question pills, voice input, prefetched answers
      analytics/
        analytics.js      # Usage tracking
    css/
      dashboard.css       # Main stylesheet (:root design tokens + most element rules)
      brutalist.css       # body.theme-brutalist reskin (extracted 2026-05-08)
      mobile-layout.css   # @media (max-width: 900px) Mobile Layout block (extracted 2026-05-08)
      font-matrix.css     # Per-script font-family disambiguation (Ar/Ja/zh-TW/Ko)
      music-only.css      # body.is-mostly-music state rules
      transcript.css, summary.css, chapters.css, title.css,
      home.css, karaoke.css, ...         # Section-specific rules
  src/sandbox/            # Visual design playground
    _main/                # Master copy (NEVER edit)
    <copy>/               # Duplicate _main, experiment here
  docs/
    TODO.md               # Feature tracking
    ARCHITECTURE.md       # This file
    DEPLOYMENT.md         # Server setup and commands
    SERVICES_AND_APIS.md  # External service costs and tiers
    PROJECT_RULES.md      # Development rules and communication style
    PROJECT_RULES_SUMMARY.md  # Bullet summary of rules
    logs/                 # Conversation logs and test results (do not modify)
  vite.config.js          # Vite bundler config
  package.json            # npm dependencies (Vite)
  ecosystem.config.js     # PM2 process tree (recapshark + etl-sessions) — Phase 5
  CHANGELOG.md            # Phase-granular release notes — Phase 5
  .github/workflows/build.yml  # CI: build + smoke + chunk-grid drift + bundle-size gate (Phase 5) + non-blocking playwright-list
```

---

## Sandbox (Visual Design Playground)

`src/sandbox/` is for experimenting with the video page visuals without touching the live app.

- **`_main/`** — Static snapshot of the video page with hardcoded content. This is the **master copy — never edit it directly**.
- To experiment: **duplicate `_main/`** into a new folder, make changes in the copy.
- No server needed — everything is static/hardcoded, just open in browser.
- Real content + real layout, zero risk to production.

---

## Last Updated

2026-05-11 — Mobile default tab flipped from Chapters → Transcript. Five user-facing fixes shipped together: (1) `loading-state.js` reset routes through `Renderer.setTranscriptMode(defaultMode)` instead of manual `.active` flips (closes a latent bug where JS panel state diverged from CSS state); (2) `renderer.js` `renderTranscriptContent()` no longer no-ops on mobile — fires `RendererMobilePanels.showMode(activeMode)` on data arrival so the FlatTranscript panel actually `prepare()`-s without an implicit user tap; (3) mobile transcript-pane skeleton (`.flat-transcript-placeholder`) renders rows inside a `.flat-transcript-content` wrapper so all real-row styling (block layout, `.alt-row` zebra tint, no border) applies verbatim — placeholder under blur is silhouette-identical to real content; lang-aware placeholder text covers en + fa + ar + he + ja + zh + ko + hi (chapters skeleton coverage backfilled to match); (4) `.home-view.morph-overlay` background flattened to solid `var(--bg)` to neutralize the iOS-URL-bar `linear-gradient` during the morph; (5) `body.morphing .dashboard { background: var(--bg) }` keeps the dashboard cream while `.center-panel`'s `morph-enter-up` animation has it at opacity:0. `process-url-view.js` exempts `#fullTranscriptPanel` from the `.component-enter` opacity:0 fade-in when Transcript is the mobile default tab (placeholder rides in WITH the morph). See "Mobile Default Tab + Loading Skeleton" + "Mobile morph cream-bg paint chain" sections above.

2026-05-09 — Phase 4e closure: backend file-inventory entries added for the 4 new modules (`pipeline/traffic_source.py`, `pipeline/analytics/_session_filter.py`, `pipeline/karaoke/stats.py`, `pipeline/karaoke/_constants.py`); existing entries refreshed to call out the in-place additions (`langs.ADVANCED_MODEL_LANGS`, `worker._call_chat` split, `karaoke/client.poll_asr_provider_until_done`, `chunk_store._supa_write`, `billing._DAILY_SUMMARY_COLUMNS`). File-tree at the bottom updated to match. `config.py` (Phase 4b) was also missing from the tree — added.

2026-04-29 — major mobile-UI section rewrite: replaced "Mobile 3D Cylinder System" with "Mobile Flat Scroll System" (FlatTranscript + SummaryNativeScroll) to reflect the late-April migration from 3D cylinders to flat native scroll. Refreshed backend + frontend file inventories (added `ner.py`, `narrative.py`, `etl_sessions.py`, chat/owner/sessions stores, `chat_log_routes.py`, `bq_analytics_routes.py`, `owner_routes.py` on the backend; `flat-transcript.js`, `summary-native-scroll.js`, `font-loader.js`, `rewind.js` and several previously-missing UI files on the frontend). Marked `cylinder-scroll.js` as deprecated/orphaned. Added a brief NER subsystem note. Flagged the in-progress lazy-karaoke migration.
