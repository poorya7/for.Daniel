import { AppState } from '../core/state.js';
import { Renderer } from './renderer.js';
import { TranslationManager } from '../translation/translation.js';
import { tState } from '../translation/translation-state.js';
import { Analytics } from '../analytics/analytics.js';
import { TranscriptBuffer } from './transcript-buffer.js';
import { RecapSharkAPI } from '../api/client.js';
import { Helpers } from '../core/helpers.js';
import { ChatManager } from '../chat/chat.js';
import { _segmentsToHTML, _rebuildFromOriginal } from './title-colors.js';
import { debugLog } from '../core/debug-log.js';
import { applyLangStyle, setLangClass } from './font-loader.js';
import { refreshAll as refreshMobilePanels } from './renderer-mobile-panels.js';

function _toArray(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val;
  return val.split('\n').filter(s => s.trim());
}

/* ── RAF-debounced render ─────────────────────────────── */

let _scheduled = false;
// Track the last language we rendered so the title-switcher can be
// force-invalidated on a language change. Without this, a render whose new
// HTML happens to match a stale tsKey cached on the active panel can short-
// circuit inside _tss.update() and the title sticks on the previous language.
let _lastRenderedLang = null;

export function scheduleRender() {
  if (_scheduled) return;
  _scheduled = true;
  requestAnimationFrame(() => {
    _scheduled = false;
    renderCurrentState();
  });
}

/* ── Single authoritative render function ─────────────── */

export function renderCurrentState() {
  const videoLang = AppState.videoData?.lang || 'en';
  const lang = AppState.currentLang || videoLang;
  const mode = tState.displayMode;
  const isBilingual = mode === 'bilingual' || mode === 'bilingual-swapped';
  const isTranslated = mode !== 'original' && lang !== videoLang;

  // Bridge display mode to title-switcher (no ES module import there)
  window._tssDisplayMode = mode;

  // ── 1. Resolve primary content (correct language + formal/casual) ──
  const title = AppState.getContent('title');
  const summary = _toArray(AppState.getContent('summary'));
  const chapters = AppState.getContent('chapters') || [];

  // ── 2. Render title ──
  // Store raw title in hidden data element (for bilingual annotations + colorize API)
  const titleDataEl = document.getElementById('videoTitleData');
  if (titleDataEl && title) titleDataEl.textContent = title;

  const meta = document.querySelector('.video-meta');

  // Translated-title colorization is now owned by translation.js: it fires
  // titleColors AFTER translateTitle resolves and sets cache._titleReady
  // only when both succeed. The title-switcher gates its render on that
  // flag, so we don't need a brutalist-only gate here anymore — every
  // theme gets colorized translated titles, and there's no race where
  // we'd colorize the WRONG title (the old block ran during the brief
  // window where currentLang='fa' but cache.title was still empty, so
  // getContent('title') returned the ENGLISH title and we colorized that).

  // Let the title-switcher handle display + crossfade via its A/B panels.
  // On a language change, force-invalidate the dedup keys first so the
  // switcher cannot bail out on a cached render key (the bug where the
  // title gets stuck on the previous language after switch-away-and-back).
  if (typeof window._tss !== 'undefined') {
    if (_lastRenderedLang !== null && _lastRenderedLang !== lang && window._tss.forceUpdate) {
      window._tss.forceUpdate();
    } else {
      window._tss.update();
    }
  }
  _lastRenderedLang = lang;

  // ── 3. Render summary + chapters ──
  if (summary.length) Renderer.renderSummaryDirect(summary);
  if (chapters.length) Renderer.renderChaptersPreview(chapters);

  // ── 4. Render desktop transcript/subtitles ──
  const cache = AppState.translationCache[lang];
  const hasTranslatedContent = isTranslated && cache &&
    cache.transcriptMap && cache.transcriptMap.size > 0;
  const directionTarget = hasTranslatedContent ? lang : videoLang;

  // #resultsView direction/lang classes only affect non-crossfading elements
  // (chat-bubble, vtag). Transcript/summary/chapters use their own buffer/display
  // scoped classes, so applying this synchronously never races with a crossfade.
  _updateDirection(directionTarget);

  const isMobileCheck = Helpers.isNarrowViewport();
  if (!isMobileCheck) {
    // Set annotation callback so renderer can add bilingual subs to standby before crossfade
    if (isTranslated && isBilingual) {
      const swapped = mode === 'bilingual-swapped';
      Renderer.setAnnotationCallback((panelEl) => {
        _addTranscriptAnnotations(videoLang, panelEl);
        panelEl.classList.toggle('bilingual-cols-swapped', swapped);
      }, swapped);
    } else {
      Renderer.setAnnotationCallback(null, false);
    }

    Renderer.renderTranscriptContent();
  } else {
    // Mobile: rebuild transcript + subtitles wheels with the new language's
    // content. In bilingual mode, the wheel is replaced with a flat two-
    // column list.
    //
    // Deferred to the next animation frame so the visible panels (summary,
    // chapters, chat — already rendered above) paint immediately. Without
    // this defer, a 200-row transcript update piggybacks onto the same
    // frame as the other renders, pushing the lang-switch repaint to
    // ~250-450ms. With it, the user-visible content swaps in <16ms while
    // the transcript catches up one frame later — invisible to anyone not
    // staring at the transcript tab, and even there the difference is one
    // frame (sub-perceptible). Standard "yield to main thread" pattern. */
    const _panelArgs = {
      isBilingual: isTranslated && isBilingual,
      swapped: mode === 'bilingual-swapped',
    };
    requestAnimationFrame(() => {
      refreshMobilePanels(_panelArgs);
    });
  }

  // Re-apply font sizes
  if (typeof window.applyFontSizes === 'function') window.applyFontSizes();

  // ── 6. Bilingual annotations (summary + chapters only — transcript + title handled elsewhere) ──
  if (isTranslated && isBilingual) {
    const origSummary = _toArray(AppState.casualMode ? AppState.currentSummary
      : (AppState.formalSummary || AppState.currentSummary));
    const origChapters = AppState.casualMode ? AppState.currentChapters
      : (AppState.formalChapters?.length ? AppState.formalChapters : AppState.currentChapters);

    // Title bilingual is now handled by title-switcher.js (side-by-side)

    // Summary annotations
    _addSummaryAnnotations(origSummary);

    // Chapter annotations
    _addChapterAnnotations(origChapters);

    // Transcript annotations are now added by renderer.js on the standby buffer
  }

  // ── 7. Update subtitle overlay text ──
  if (isTranslated) {
    _updateSubtitles(lang);
  } else {
    _restoreSubtitles();
  }

  // ── 8. Chat greeting ──
  if (typeof TranslationManager !== 'undefined' && TranslationManager.translateChatGreeting) {
    TranslationManager.translateChatGreeting(isTranslated ? lang : videoLang);
  }

  // ── 9. Chat chip re-localise ──
  // Sync the chat suggestion chips (initial rail + follow-up rails) to the
  // current language. handleLanguageChange() runs at the top of setLanguage()
  // for the immediate update, but every renderCurrentState() pass also re-
  // localises as a safety net — covers any path where the rail HTML gets
  // rebuilt or the chips render before chipTranslationCache is populated.
  if (ChatManager && ChatManager.relocalizeChips) ChatManager.relocalizeChips();

  // ── 10. Karaoke invalidate ──
  if (typeof window.KaraokeManager !== 'undefined') window.KaraokeManager.invalidate();
}

/* ── Bilingual annotation helpers ─────────────────────── */

function _addSummaryAnnotations(origParagraphs) {
  const container = window._sss?.getActivePanel() || document.getElementById('summaryDisplayA');
  if (!container || !origParagraphs.length) return;

  const videoLang = AppState.videoData?.lang || 'en';

  const kids = Array.from(container.children).filter(el =>
    !el.classList.contains('bilingual-sub') &&
    !el.classList.contains('summary-inline-divider') &&
    !el.classList.contains('summary-title-label')
  );

  for (let i = 0; i < Math.min(kids.length, origParagraphs.length); i++) {
    const sub = document.createElement('div');
    sub.className = 'bilingual-sub';
    sub.textContent = origParagraphs[i];
    // Source-language content — apply correct script font/direction inline so
    // it works regardless of body[data-translate-lang] (which assumes target
    // is the non-Latin one, breaking when the source is non-Latin instead).
    applyLangStyle(sub, videoLang);
    kids[i].after(sub);
  }
}

function _addChapterAnnotations(origChapters) {
  const container = (typeof window._css !== 'undefined')
    ? window._css.getActivePanel()
    : document.getElementById('topicsList');
  if (!container || !origChapters?.length) return;

  const videoLang = AppState.videoData?.lang || 'en';

  const items = container.querySelectorAll('.chapter-item');
  for (let i = 0; i < Math.min(items.length, origChapters.length); i++) {
    const sub = document.createElement('div');
    sub.className = 'bilingual-sub chapter-sub';
    sub.textContent = origChapters[i]?.title || origChapters[i] || '';
    applyLangStyle(sub, videoLang);
    items[i].appendChild(sub);
  }
}

function _addTranscriptAnnotations(videoLang, panelEl) {
  // On desktop, add bilingual subs to transcript lines using the original text
  // The primary content is already translated (rendered by the transcript panel)
  // Annotations show the original language
  const panel = panelEl || TranscriptBuffer.getActive('transcript');
  if (!panel) return;

  const rows = panel.querySelectorAll('.transcript-line, .transcript-paragraph');
  if (!rows.length) return;

  // Original transcript lines (from raw text)
  const origLines = (AppState.transcriptRawText || '').split('\n')
    .map(l => l.replace(/^- /, '').trim()).filter(Boolean);

  // Use paragraph boundaries from the DOM (based on translated text grouping)
  // to slice the same range of original lines — lines are 1:1 between languages
  rows.forEach((row, ri) => {
    const startIdx = Number(row.dataset.idx);
    if (isNaN(startIdx)) return;

    // Skip if annotation already exists (inside the row as a child)
    if (row.querySelector('.bilingual-sub')) return;

    // End index = next row's start, or total line count
    const endIdx = ri + 1 < rows.length ? Number(rows[ri + 1].dataset.idx) : origLines.length;
    const text = origLines.slice(startIdx, endIdx).join(' ');
    if (!text) return;

    const sub = document.createElement('div');
    sub.className = 'bilingual-sub';
    sub.dataset.forIdx = startIdx;
    sub.textContent = text;
    applyLangStyle(sub, videoLang);
    row.appendChild(sub);
  });
}

/* ── Subtitle overlay ─────────────────────────────────── */

function _updateSubtitles(lang) {
  const subs = AppState.subtitleSegments;
  if (!subs || !subs.length) return;

  if (!AppState._origSubtitleTexts) {
    AppState._origSubtitleTexts = subs.map(s => s.text);
  }

  const cache = AppState.translationCache[lang];
  const transMap = cache?.transcriptMap;
  if (!transMap || !transMap.size) return;

  const transEntries = Array.from(transMap.entries()).sort((a, b) => a[0] - b[0]);
  const times = AppState.segmentTimestamps;

  for (let i = 0; i < subs.length; i++) {
    const t = subs[i].start;
    let lineIdx = 0;
    for (let j = times.length - 1; j >= 0; j--) {
      if (times[j] <= t) { lineIdx = j; break; }
    }
    let translated = transMap.get(lineIdx);
    if (!translated && transEntries.length) {
      let best = transEntries[0];
      for (const entry of transEntries) {
        if (entry[0] <= lineIdx) best = entry;
        else break;
      }
      translated = best[1];
    }
    if (translated) subs[i].text = translated;
  }
}

function _restoreSubtitles() {
  const subs = AppState.subtitleSegments;
  const orig = AppState._origSubtitleTexts;
  if (!subs || !orig) return;
  for (let i = 0; i < subs.length; i++) {
    subs[i].text = orig[i] || '';
  }
}

/* ── RTL direction ────────────────────────────────────── */

function _updateDirection(primaryLang) {
  const resultsView = document.getElementById('resultsView');
  if (!resultsView) return;
  const isRTL = Helpers.isRTL(primaryLang);
  resultsView.classList.toggle('rtl', isRTL);
  // Stamp the canonical .lang-XX class (e.g. lang-ja, lang-zh-tw, lang-fa).
  // Replaces the previous fa/ar/he-only hardcode, so JP/KO/Devanagari/etc.
  // videos also drive the script-disambiguation CSS rules.
  setLangClass(resultsView, primaryLang);
}

/* ── Formal rewrite (unchanged) ───────────────────────── */

export function fetchFormalInBackground() {
  if (AppState.formalFetching || AppState.formalFetched) return;
  if (!AppState.currentSummary && (!AppState.currentChapters || !AppState.currentChapters.length)) return;

  AppState.formalFetching = true;
  debugLog('[FORMAL] Fetching formal rewrite in background…');

  const summaryText = Array.isArray(AppState.currentSummary)
    ? AppState.currentSummary.join('\n')
    : (AppState.currentSummary || '');

  RecapSharkAPI.formalRewrite({
    summary: summaryText,
    chapters: AppState.currentChapters || [],
    lang: AppState.videoData?.lang || '',
  })
  .then(data => {
    AppState.formalFetched = true;
    AppState.formalFetching = false;
    if (data.summary) AppState.formalSummary = data.summary;
    if (data.chapters && data.chapters.length) AppState.formalChapters = data.chapters;
    debugLog('[FORMAL] Ready — summary:', !!data.summary, 'chapters:', data.chapters?.length || 0);

    if (!AppState.casualMode) {
      scheduleRender();
    }
  })
  .catch(err => {
    AppState.formalFetching = false;
    console.warn('[FORMAL] Background fetch failed:', err.message);
  });
}

export function toggleCasual() {
  AppState.casualMode = !AppState.casualMode;
  document.body.classList.toggle('casual-mode', AppState.casualMode);
  Analytics.casualModeToggled(AppState.casualMode);
  const btn = document.getElementById('casualBtn');
  if (btn) btn.classList.toggle('on', AppState.casualMode);

  if (!AppState.casualMode && !AppState.formalFetched && !AppState.formalFetching) {
    fetchFormalInBackground();
  } else {
    scheduleRender();
  }

  const ind = document.getElementById('casualIndicator');
  if (ind) {
    const isOn = AppState.casualMode;
    ind.textContent = isOn ? '😎 CASUAL MODE ON' : '📋 Back to formal';
    ind.classList.remove('show', 'mode-on', 'mode-off');
    void ind.offsetWidth;
    ind.classList.add('show', isOn ? 'mode-on' : 'mode-off');
    setTimeout(() => ind.classList.remove('show'), 2900);
  }
}

// toggleCasual / renderCurrentState / scheduleRender are exported and
// bound to window.toggleCasual / window._renderCurrentState /
// window._scheduleRender from main.js (single bridge surface).
