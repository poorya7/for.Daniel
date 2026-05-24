// api/data-loader.js
//
// Owns: the three data-loading entry points (loadData / loadFromApi /
//       updateFromApi) plus the first-paint coordinator (renderAll).
// Reads/writes AppState: videoData, transcriptRawText, isMostlyMusic,
//   transcriptSegments, currentSummary, currentChapters, transcriptEntities,
//   subtitleSegments, segmentTimestamps, formattedTranscript, currentLang,
//   currentVideoId, currentVideoInfo, summaryFinal, chaptersFinal,
//   _lastChaptersKey, _lastSummaryKey, totalLines.
// Imports: core/state, core/helpers, api/data, api/entities, ui/renderer,
//   player/player, ui/search, ui/transcript-buffer, ui/loading-state
//   (updatePlaceholderTitlesLang only), ui/font-loader,
//   translation/translation (for the lang-panel rebuild),
//   analytics/analytics, transcript/music-detection, transcript/groups.

import { AppState } from '../core/state.js';
import { Helpers } from '../core/helpers.js';
import { DataService } from './data.js';
import { fetchEntitiesForLang } from './entities.js';
import { Renderer } from '../ui/renderer.js';
import { PlayerManager } from '../player/player.js';
import { SearchManager } from '../ui/search.js';
import { TranscriptBuffer } from '../ui/transcript-buffer.js';
import { TranslationManager } from '../translation/translation.js';
import { _gbs } from '../translation/translation-bilingual.js';
import { updatePlaceholderTitlesLang } from '../ui/loading-state.js';
import { setLangClass, awaitFontForLang } from '../ui/font-loader.js';
import { Analytics } from '../analytics/analytics.js';
import { detectMostlyMusic, applyMusicOnlyClass } from '../transcript/music-detection.js';
import { computeParagraphGroups } from '../transcript/groups.js';

// Phase 4a A3 (2026-05-08): UI deps injected via setup({deps}) instead of
// being reached for via window.* on every call. The 5 consumer sites below
// (loadFromApi entity registration, updateFromApi entity refresh + lang
// resync, renderAll chapter switcher dispatch + applyFontSizes) all run
// inside async functions invoked AFTER main.js's bridge block, so the
// boot-bridge trap from REFACTORING_LESSONS lesson 24 doesn't apply.
// `null` defaults keep the legacy `if (X) { ... }` guards working until
// setup() lands; main.js calls it once at boot.
const _deps = {
  entityHighlighter: null,  // EntityHighlighter from ../ui/entity-highlighter.js
  chapterSwitcher: null,    // _css from ../ui/chapter-switcher.js
  applyFontSizes: null,     // applyFontSizes from ../ui/controls.js
};

export function setup({ entityHighlighter, chapterSwitcher, applyFontSizes } = {}) {
  if (entityHighlighter) _deps.entityHighlighter = entityHighlighter;
  if (chapterSwitcher) _deps.chapterSwitcher = chapterSwitcher;
  if (typeof applyFontSizes === 'function') _deps.applyFontSizes = applyFontSizes;
}

function _updateVideoLangPanel() {
  if (typeof TranslationManager !== 'undefined' && TranslationManager.rebuildLangPanel) {
    TranslationManager.rebuildLangPanel();
  }
}

function _buildFormattedTranscript(segs) {
  if (!segs || !segs.length) return '';
  return segs.filter(s => s.text).map(s => {
    const total = Math.floor(s.start || 0);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const sec = total % 60;
    const ts = h > 0
      ? `[${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}]`
      : `[${m}:${String(sec).padStart(2,'0')}]`;
    return `${ts} ${s.text}`;
  }).join('\n');
}

/* ── Load / Update Data ─────────────────────────────── */

export function loadData() {
  AppState.videoData = window.VIDEO_DATA;
  const rawText = window.TRANSCRIPT_RAW;
  AppState.transcriptRawText = rawText;
  AppState.isMostlyMusic = detectMostlyMusic(rawText);
  applyMusicOnlyClass();
  computeParagraphGroups();

  DataService.parseTranscript(rawText);
  DataService.addTimestampsToTopics();

  /* Pre-baked VIDEO_DATA is always the final summary for static/export loads */
  AppState.summaryFinal = true;
  AppState.chaptersFinal = true;

  renderAll();
}

export async function loadFromApi(videoId, videoInfo, transcript, summary, chapters, lang) {
  AppState.currentVideoId = videoId;
  AppState.currentVideoInfo = videoInfo;
  AppState.apiTranscriptData = transcript;
  AppState.currentSummary = summary || null;
  if (chapters && chapters.length > 0) AppState.currentChapters = chapters;

  AppState.transcriptSegments = [];

  const converted = DataService.convertApiResponse(videoId, videoInfo, transcript, AppState.currentSummary, AppState.currentChapters, lang);
  AppState.videoData = converted.videoData;
  AppState.transcriptRawText = converted.rawText;
  // Pipeline can flag no-spoken-content videos (no captions at all, or
  // captions dominated by [Music]/[Applause]) via transcript.is_mostly_music.
  // detectMostlyMusic guards rawText < 20 chars to avoid false-positives on
  // genuine short transcripts, so the explicit flag is the only signal for
  // truly silent / caption-less videos.
  AppState.isMostlyMusic = (transcript && transcript.is_mostly_music) || detectMostlyMusic(AppState.transcriptRawText);
  applyMusicOnlyClass();
  /* NER entities (PERSON/ORG/GPE/EVENT/DATE/NUM) from the backend pipeline.
   * The highlighter now stores entity lists per-language so a translation
   * switch is a pointer-swap instead of a refetch — register under the
   * video's original lang and activate that lang so first-paint highlights
   * use it immediately. Empty list = highlighter falls back to date/num
   * regex-only (current behaviour for langs spaCy can't handle, until the
   * lazy /api/entities fetch fills them in). */
  AppState.transcriptEntities = (transcript && transcript.entities) || [];
  const _origLang = lang || 'en';
  if (_deps.entityHighlighter) {
    _deps.entityHighlighter.setEntities?.(_origLang, AppState.transcriptEntities);
    _deps.entityHighlighter.setActiveLang?.(_origLang);
  }
  /* Lazy NER for unsupported languages.
   *
   * If the backend returned no entities (lang has no spaCy model — Persian,
   * Arabic, Hindi, Korean, Thai, Vietnamese, etc.), fire `/api/entities`
   * AFTER first paint to extract them via LLM. The page renders fully
   * without waiting (preserves the fast-first-paint contract from
   * docs/_workflow/PROJECT_RULES.md); names "fade in" 3-15s later.
   *
   * setTimeout(0) defers until the current synchronous task — including
   * renderAll() below — finishes, so the browser gets a paint frame
   * before any extra work. The call is idempotent + de-duped against
   * concurrent triggers (see api/entities.js). For supported langs the
   * `transcript.entities` list arrives populated and this branch is a
   * no-op. */
  if (!AppState.transcriptEntities.length && AppState.transcriptRawText && !AppState.isMostlyMusic) {
    const _videoIdSnap = videoId;
    const _langSnap = _origLang;
    const _textSnap = AppState.transcriptRawText;
    setTimeout(() => {
      fetchEntitiesForLang(_videoIdSnap, _langSnap, _textSnap, { makeActive: true });
    }, 0);
  }
  computeParagraphGroups();
  AppState.segmentTimestamps = converted.segmentTimes;
  AppState.subtitleSegments = converted.subs;
  AppState.formattedTranscript = _buildFormattedTranscript(converted.subs);

  DataService.parseTranscript(AppState.transcriptRawText);
  DataService.addTimestampsToTopics();
  PlayerManager.initSubtitles();

  if (lang) {
    // Sync currentLang to the video's own language *before* renderAll() so
    // every per-display panel (.cs-display, .ss-display, .ts-display,
    // .transcript-buffer) gets the right .lang-xx / .rtl / .ltr classes
    // applied on first paint. Without this, a Persian-original video would
    // render with the default 'en' fallback (no Vazirmatn, LTR timestamps,
    // left-aligned chapters) until the user manually picks a translation.
    AppState.currentLang = lang;
    _updateVideoLangPanel();
    // Swap the chapters-skeleton placeholder titles into the video's
    // language while the rewind blur is still active — kills the EN→FA
    // (or AR/HE) flash on the unblur frame. No-op once real chapters land.
    updatePlaceholderTitlesLang(lang);
    Analytics.videoLangDetected(videoId, lang);

    // Font readiness gate (Phase 3 of font-system-plan-v2.1).
    // Wait for the source-language script font to be loaded in the
    // browser BEFORE first paint, so the user never sees the recap in a
    // system-ugly fallback. 800ms timeout — recap speed is core UX, so a
    // stalled font fetch must never delay first paint. Persian / Arabic
    // / Hebrew are preloaded statically in index.html and resolve
    // immediately. CJK / Devanagari / etc. pay a one-time ~50–300ms wait
    // the first time they're encountered in a session; that wait is
    // hidden inside translation latency the user already sees. On
    // non-OK status (timeout / network), paint anyway — the cascade
    // fallback still produces readable output.
    const _fontStatus = await awaitFontForLang(lang, { timeoutMs: 800 });
    if (!_fontStatus.ok) {
      // Telemetry already logged inside awaitFontForLang. Continue to paint.
    }
  }

  renderAll();
}

export async function updateFromApi(transcript, summary, chapters, lang) {
  if (!AppState.currentVideoId) return;
  AppState.apiTranscriptData = transcript;
  if (summary && summary.length > 0) AppState.currentSummary = summary;
  if (chapters && chapters.length > 0) AppState.currentChapters = chapters;

  AppState.transcriptSegments = [];
  AppState.totalLines = 0;

  const converted = DataService.convertApiResponse(AppState.currentVideoId, AppState.currentVideoInfo, transcript, AppState.currentSummary, AppState.currentChapters, lang);
  AppState.videoData = converted.videoData;
  AppState.transcriptRawText = converted.rawText;
  AppState.isMostlyMusic = (transcript && transcript.is_mostly_music) || detectMostlyMusic(AppState.transcriptRawText);
  applyMusicOnlyClass();
  /* Refresh NER entities from the latest streaming response.
   *
   * IMPORTANT: only re-register if the new list is non-empty. Streaming
   * chunks (summary / chapter updates) usually carry the same entities
   * the original /test/subs returned — but for unsupported langs that
   * means an empty list, and by the time later chunks arrive the lazy
   * /api/entities fetch may already have populated the highlighter
   * with real LLM-extracted entities. Re-registering an empty list
   * here would clobber them.
   *
   * Lazy fetch is NOT re-triggered from updateFromApi — loadFromApi
   * fires it exactly once per video load, which is correct: entities
   * are stable across the streaming flow. */
  const _newEntities = (transcript && transcript.entities) || [];
  const _origLang = lang || AppState.currentLang || 'en';
  if (_newEntities.length) {
    AppState.transcriptEntities = _newEntities;
    if (_deps.entityHighlighter) {
      _deps.entityHighlighter.setEntities?.(_origLang, _newEntities);
      _deps.entityHighlighter.setActiveLang?.(_origLang);
    }
  } else if (_deps.entityHighlighter) {
    // No new entities — but still keep the active lang in sync in case
    // it changed between calls (e.g. lang re-detection during streaming).
    _deps.entityHighlighter.setActiveLang?.(_origLang);
  }
  computeParagraphGroups();
  AppState.segmentTimestamps = converted.segmentTimes;
  AppState.subtitleSegments = converted.subs;
  AppState.formattedTranscript = _buildFormattedTranscript(converted.subs);

  DataService.parseTranscript(AppState.transcriptRawText);
  DataService.addTimestampsToTopics();
  PlayerManager.initSubtitles();

  if (lang) {
    // Only adopt the new lang as currentLang if the user hasn't already
    // picked a translation target (i.e. they're still showing original).
    // Otherwise we'd clobber their language choice when a late AsrProvider
    // update arrives. See loadFromApi for the full rationale.
    const showingOriginal = !AppState.currentLang
      || AppState.currentLang === 'en'
      || AppState.currentLang === AppState.videoData?.lang;
    if (showingOriginal) AppState.currentLang = lang;
    Analytics.videoLangDetected(AppState.currentVideoId, lang);

    // Font readiness gate (idempotent — a successful load is cached;
    // streaming updates that re-detect the same lang resolve instantly).
    // 800ms cap so streaming chunks never block the wave-replace render.
    await awaitFontForLang(lang, { timeoutMs: 800 });
  }

  const topicsList = document.getElementById('topicsList');
  const _hasRealChapters = AppState.currentChapters && AppState.currentChapters.length > 0;
  const chaptersKey = JSON.stringify(AppState.currentChapters);
  // Skip the diff/wave-replace until real chapters arrive — same logic as
  // renderTopics(): keep the skeleton visible instead of clobbering it with
  // the placeholder "Section 1, Section 2..." topics that data.js generates
  // when chapters is empty.
  if (_hasRealChapters && chaptersKey !== AppState._lastChaptersKey) {
    AppState._lastChaptersKey = chaptersKey;
    const newChaptersHTML = Renderer.topicsHTML();
    if (_deps.chapterSwitcher) {
      const lang = AppState.videoData?.lang || '';
      _deps.chapterSwitcher.update(AppState.videoData.topics, lang);
    } else {
      Helpers.waveReplace(topicsList, newChaptersHTML);
    }
    const chaptersTabDest = document.getElementById('chaptersTabList');
    if (chaptersTabDest) Helpers.waveReplace(chaptersTabDest, newChaptersHTML);
  }

  const summaryKey = JSON.stringify(AppState.videoData.summary);
  if (summaryKey !== AppState._lastSummaryKey) {
    AppState._lastSummaryKey = summaryKey;
    Renderer.renderSummaryDirect(AppState.videoData.summary);
  }

  const dur = AppState.videoData?.durationEstimate;
  if (dur > 0) {
    const totalEl = document.querySelector('.mech-time-total');
    if (totalEl) totalEl.textContent = Helpers.fmtTime(Math.floor(dur));
    const scrubberTotal = document.getElementById('scrubberTotal');
    if (scrubberTotal) scrubberTotal.textContent = Helpers.fmtTime(Math.floor(dur));
    Renderer.renderMeta();
  }

  Renderer.hideTranscriptProgress();
  setTimeout(() => Renderer.initSummaryTranscriptToggle(), 230);
}

export function renderAll() {
  Renderer.renderMeta();
  Renderer.renderSummary();
  Renderer.renderTopics();
  SearchManager.renderChips();
  TranscriptBuffer.init('transcript');
  Renderer.initSummaryTranscriptToggle();
  PlayerManager.init();
  const dur = AppState.videoData?.durationEstimate;
  if (dur > 0) {
    const totalEl = document.querySelector('.mech-time-total');
    if (totalEl) totalEl.textContent = Helpers.fmtTime(Math.floor(dur));
    const scrubberTotal = document.getElementById('scrubberTotal');
    if (scrubberTotal) scrubberTotal.textContent = Helpers.fmtTime(Math.floor(dur));
  }
  const resultsView = document.getElementById('resultsView');
  const lang = AppState.videoData?.lang || '';
  const rtl = Helpers.isRTL(lang);
  const isPersian = lang === 'fa' || lang.startsWith('fa-');
  const isArabic = lang === 'ar' || lang.startsWith('ar-');
  const isHebrew = lang === 'he' || lang.startsWith('he-');
  if (resultsView) {
    resultsView.classList.toggle('rtl', rtl);
    // rtl-layout disabled — chapters always left, chat always right regardless of lang
    resultsView.classList.toggle('rtl-layout', false);
    // Stamp the canonical .lang-XX class (lang-ja, lang-zh-tw, etc.).
    // Replaces fa/ar/he-only hardcode so all 30+ scripts drive the
    // disambiguation CSS rules. The isPersian/isArabic/isHebrew flags
    // above are still consumed by other branches in this file (RTL
    // layout, etc.) so they stay.
    setLangClass(resultsView, AppState.currentLang);
  }
  const nwLeft = document.querySelector('.nw-left');
  const nwRight = document.querySelector('.nw-right');
  const nwTitleEl = document.querySelector('.nw-title');
  const nwMetaEl = document.querySelector('.nw-meta');
  if (nwLeft && nwRight && nwTitleEl && nwMetaEl) {
    if (rtl) {
      nwRight.appendChild(nwTitleEl);
      nwLeft.appendChild(nwMetaEl);
    } else {
      nwLeft.appendChild(nwTitleEl);
      nwRight.appendChild(nwMetaEl);
    }
  }
  if (AppState.videoData?.lang && AppState.videoData.lang !== 'en') {
    // Greeting is now resolved synchronously via the static UI_STRINGS dict
    // (was: RecapSharkAPI.translateSummary round-trip per language switch).
    const targetLang = AppState.videoData.lang;
    const localized = Helpers.chatGreeting(targetLang);
    const label = '<div class="bubble-label"><img src="' + window.RS_ASSETS.sharky + '" alt="" class="label-shark"> RecapShark.com</div>';
    _gbs.update(label + Helpers.escapeHtml(localized), targetLang);
  }
  if (_deps.applyFontSizes) _deps.applyFontSizes();
}
