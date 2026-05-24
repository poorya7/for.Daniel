/**
 * RecapShark Translation Manager
 * Orchestrates translation API calls and delegates rendering to translation-ui.
 *
 * Phase 4c #3 (2026-05-08): SRP file split.
 *   - Wave crossfade transition  → translation-wave.js
 *   - Chunked GPT fallback path  → translation-chunked.js
 *   This file keeps the orchestrator (setLanguage), init, reset, the
 *   _gatherContent payload assembler, and the entity-fetch hook.
 *
 *   DEFERRED (see REFACTOR_PLAN.md → 4c → translation.js): converting
 *   the direct calls to ChatManager / Renderer into events. Real
 *   architectural decoupling, not a file split — own session.
 */
import { tState } from './translation-state.js';
import * as UI from './translation-ui.js';
import { TranslationLangMeta } from './lang-meta.js';
import { waveTransition } from './translation-wave.js';
import { translateChunked } from './translation-chunked.js';
import { AppState } from '../core/state.js';
import { Helpers } from '../core/helpers.js';
import { TRANSLATION_MAX_TRANSCRIPT } from '../core/constants.js';
import { debugLog } from '../core/debug-log.js';
import { RecapSharkAPI } from '../api/client.js';
import { fetchEntitiesForLang } from '../api/entities.js';
import { Renderer } from '../ui/renderer.js';
import { ChatManager } from '../chat/chat.js';
import { _segmentsToHTML, _rebuildFromOriginal } from '../ui/title-colors.js';
import { awaitFontForLang } from '../ui/font-loader.js';
import { scheduleRender } from '../ui/casual-mode.js';
import { applyMusicOnlyClass } from '../transcript/music-detection.js';
import { EntityHighlighter } from '../ui/entity-highlighter.js';

const { ADVANCED_MODEL_LANGS, LANG_META } = TranslationLangMeta;

/* ── Gather current content for API call ────────────── */

function _gatherContent() {
  const summaryParagraphs = AppState.videoData?.summary || [];
  const summaryText = Array.isArray(summaryParagraphs)
    ? summaryParagraphs.map(p => p.startsWith('Context:')
        ? 'Context from RecapShark.com:' + p.slice('Context:'.length)
        : p).join('\n\n')
    : String(summaryParagraphs);

  const chapters = (AppState.videoData?.topics || []).map(t => ({
    title: t.title || '',
    start_time: t.timestamp || 0,
  }));

  const rawLines = UI._getTranscriptLines();
  let totalChars = 0;
  const transcriptLines = [];
  for (let i = 0; i < rawLines.length; i++) {
    if (totalChars + rawLines[i].length > TRANSLATION_MAX_TRANSCRIPT) break;
    transcriptLines.push({ id: i, text: rawLines[i] });
    totalChars += rawLines[i].length;
  }

  return { summaryText, chapters, transcriptLines };
}

/* ══════════════════════════════════════════════════════
   ENTITY FETCH HOOK (multilingual NER)
   ══════════════════════════════════════════════════════ */

/**
 * Fire `/api/entities` for the freshly-translated transcript so the
 * highlighter colors names in the new language. Called from both the
 * bulk and chunked translation completion paths so the trigger fires
 * exactly once per (video, lang) regardless of which path translated.
 *
 * Reconstructs the translated transcript text from `cache.transcriptMap`
 * (segments are keyed by their original line ID; we sort to match the
 * order the user actually reads). The text gets sent to the backend
 * which routes to spaCy or LLM based on lang support — same path used
 * for original-lang lazy fetching from app.js.
 *
 * `makeActive` is true only if the user is still viewing this lang when
 * translation completes — they may have switched away mid-translation,
 * in which case we still register the entities under that lang (free
 * for the next switch back) but don't activate them.
 */
function _fireEntityFetchForLang(langCode, cache) {
  const videoId = AppState.currentVideoId;
  if (!videoId || !langCode || !cache?.transcriptMap?.size) return;
  const sortedIds = Array.from(cache.transcriptMap.keys()).sort((a, b) => a - b);
  const translatedText = sortedIds.map(id => cache.transcriptMap.get(id) || '').join('\n');
  if (translatedText.trim().length < 20) return;
  const makeActive = AppState.currentLang === langCode;
  fetchEntitiesForLang(videoId, langCode, translatedText, { makeActive });
}

/* ══════════════════════════════════════════════════════
   PUBLIC: SET LANGUAGE (async — calls API)
   ══════════════════════════════════════════════════════ */

async function setLanguage(langCode) {
  if (langCode === AppState.currentLang) return;

  // Font readiness gate (Phase 3 of font-system-plan-v2.1).
  // Wait for the target-language script font to be loaded BEFORE the
  // wave-transition kicks off the DOM swap. 1500ms timeout — translation
  // already shows visible loading state, so a longer wait is acceptable
  // here (vs the 800ms cap on the source-lang initial-render path).
  // No-op for Latin / already-loaded scripts; ~50–300ms one-time wait
  // the first time a non-Latin script is used in a session.
  await awaitFontForLang(langCode, { timeoutMs: 1500 });

  const videoLang = AppState.videoData?.lang || 'en';

  if (AppState.currentLang && AppState.currentLang !== videoLang) {
    tState._lastTargetLang = AppState.currentLang;
  }

  AppState.currentLang = langCode;

  // Re-localise the music-only badge + placeholder text. No-op when the
  // current video isn't music-only (helper toggles class + text only when
  // AppState.isMostlyMusic is true). Same pattern as chat greeting below.
  applyMusicOnlyClass();

  /* Activate this lang's entity list in the highlighter immediately, even
     before translation completes. If we have entities cached for langCode
     (from a prior switch), highlights swap on the spot. If not, the regex
     is cleared (no name highlights for this lang yet) and `_fireEntityFetchForLang`
     will populate + reapply once translation finishes. Either way, the
     highlighter never shows stale entities from the previous lang. */
  EntityHighlighter.setActiveLang?.(langCode);

  // Re-localise chat suggestion chips — kicks off translation for any chip
  // strings missing from the target-language cache and re-renders existing
  // chips (initial rail + follow-ups) with cached translations. Single call
  // covers all three branches below: original-revert (no API fire), cached
  // switch (instant relocalize), and first-load (relocalize fallback +
  // background API fires).
  ChatManager.handleLanguageChange(langCode, videoLang);

  if (langCode === videoLang) {
    // Switching back to original — wave R→L, all DOM mutations run under overlays
    tState.displayMode = 'original';
    waveTransition(() => {
      UI._removeAllSubs();
      UI._hideQualityWarning();
      UI._hideBilingualControls();
      // Picking the source lang from the panel = exit translation flow.
      // Drop any in-flight translation banners so the user isn't left
      // with "Translating to Persian…" hanging around after they bailed.
      Renderer.hidePanelProgress('tab-summary');
      Renderer.hidePanelProgress('tab-chapters');
      Renderer.hidePanelProgress('tab-transcript');
      delete document.body.dataset.translateLang;
      scheduleRender();
    }, /* goingRight */ false);
    return;
  }

  // Switching to a translated language. displayMode='translated' on both
  // platforms so the rendered content matches what the user picked.
  // On mobile we additionally set tState._freshFromInit so the cycle
  // button shows lang1 as the next preview and the FIRST tap jumps to
  // 'original' (lang1) — giving the user the full lang1 → lang2 → dual1
  // → dual2 walkthrough starting from a "preview lang1" affordance.
  // Without this, the desync between displayMode='original' and the
  // already-rendered lang2 content made the first tap a visible no-op.
  // See _peekNextMode / _cycleMobileMode in translation-bilingual.js.
  tState.displayMode = 'translated';
  const _isMobileCycle = Helpers.isNarrowViewport();
  if (_isMobileCycle) tState._freshFromInit = true;
  UI._precacheGreeting(langCode);  // fires API, no DOM side effects — safe before wave

  const cached = AppState.translationCache[langCode];
  if (cached) {
    // Cached — wave L→R, all DOM mutations happen under overlays
    waveTransition(() => {
      UI._removeAllSubs();
      UI._showBilingualControls();
      UI._updateSwitchBtn();
      // Cached lang — every section is already populated. _markSectionReady
      // strips the mobile .hide-pre-ready gate (added by _showBilingualControls)
      // and re-evaluates .pending for the active tab (turns out enabled since
      // all cache slices exist). Without this, the freshly-added .hide-pre-ready
      // would keep the bar hidden on mobile even though content is fully ready.
      UI._markSectionReady('cached');
      // Also re-trigger the entity fetch for this lang. Idempotent (no-op
      // when highlighter already has entities). Catches the edge case where
      // translation was cached in a prior session but entity fetch never
      // landed — e.g. user closed the tab mid-extraction.
      _fireEntityFetchForLang(langCode, cached);
      // Hide any leftover translation-progress banners. If the user requested
      // a previous (non-cached) translation that finished section-by-section,
      // each section's .then() handler hides its own banner — but if they
      // jump to a cached lang BEFORE the first translation finished, banners
      // for the old in-flight target would remain visible on the new lang's
      // panels. Cached content is ready instantly so no banners are needed.
      Renderer.hidePanelProgress('tab-summary');
      Renderer.hidePanelProgress('tab-chapters');
      Renderer.hidePanelProgress('tab-transcript');
      document.body.dataset.translateLang = langCode;
      scheduleRender();
    }, /* goingRight */ true);
    return;
  }

  // First-load path — wave fires immediately; APIs run in parallel.
  // Overlay hides the pre-wave DOM mutations (RTL flip, etc.) and any content
  // that dribbles in during the ~1.2s fade. Remaining APIs that finish after
  // the wave ends will still re-render normally underneath.
  waveTransition(() => {
    UI._removeAllSubs();
    UI._showBilingualControls();
    UI._updateSwitchBtn();
    UI._setBilingualEnabled(false);
    document.body.dataset.translateLang = langCode;
  }, /* goingRight */ true);

  const content = _gatherContent();
  const sourceLang = AppState.videoData?.lang || 'en';
  const requestId = langCode + ':' + Date.now();
  tState.pendingRequest = requestId;

  const langLabel = (LANG_META[langCode] && LANG_META[langCode].name) || langCode.toUpperCase();
  const isAdvanced = ADVANCED_MODEL_LANGS.has(langCode);
  const advTag = isAdvanced ? ' \u26A1 Using enhanced model' : '';
  const tTitle = isAdvanced ? 45000 : undefined;
  const tChapters = isAdvanced ? 90000 : undefined;
  const tChunk = isAdvanced ? 180000 : undefined;

  debugLog('[Translation] Requesting:', langCode, 'from:', sourceLang, isAdvanced ? '(advanced model)' : '');

  const cache = { summary: '', chapters: [], transcript: '', title: '' };
  AppState.translationCache[langCode] = cache;

  // Per-panel "Translating … to {lang}…" banners. Show all three at
  // translation start so whichever tab the user is on, they get
  // immediate visual feedback that work is in progress (the OG bug:
  // user picked Persian on the summary tab, summary takes 30-40s, and
  // the only progress UI was attached to a hidden mobile host → user
  // saw silent English summary the whole time and had no idea anything
  // was happening). Each banner is hidden in its section's .then()
  // handler below as cache fills in.
  Renderer.showPanelProgress('tab-summary',    'Translating summary to '    + langLabel + '…');
  Renderer.showPanelProgress('tab-chapters',   'Translating chapters to '   + langLabel + '…');
  Renderer.showPanelProgress('tab-transcript', 'Translating transcript to ' + langLabel + '…');

  // First-load: NO wave animation — sections appear as they arrive (current behavior)
  // Wave only fires on cached switches (see above)

  // Translate video title (fire-and-forget — just update cache, render picks it up)
  const originalTitle = AppState.videoData?.title || '';
  if (originalTitle) {
    // Wait for BOTH translateTitle AND titleColors before exposing the
    // translated title to the renderer. This kills the 3-blink jump
    // (plain-translated → original → colorized-translated) by gating
    // _resolveHTMLForLang on cache._titleReady — see title-switcher.js.
    // Result: the title stays on the original (already colorized) until
    // the translated+colorized HTML is ready, then a single _tss crossfade.
    RecapSharkAPI.translateTitle(originalTitle, sourceLang, langCode, tTitle)
      .then(data => {
        if (!AppState.translationCache[langCode]) return;
        const translated = (data && data.title) || '';
        cache.title = translated || originalTitle;

        if (!translated) {
          // Translation failed — fall back to original colorized HTML so we
          // don't strand the user staring at no title; mark ready so the
          // gate in title-switcher releases.
          cache._titleColorHTML = AppState._titleColorHTML
            || Helpers.escapeHtml(originalTitle);
          cache._titleReady = true;
          scheduleRender();
          return;
        }

        RecapSharkAPI.titleColors(translated)
          .then(colorData => {
            if (!AppState.translationCache[langCode]) return;
            const segs = colorData && colorData.segments;
            if (segs && segs.length) {
              const joined = segs.map(s => (s && s.text) || '').join('');
              cache._titleColorHTML = (joined === translated)
                ? _segmentsToHTML(segs)
                : _rebuildFromOriginal(translated, segs);
            } else {
              cache._titleColorHTML = Helpers.escapeHtml(translated);
            }
            cache._titleReady = true;
            scheduleRender();
          })
          .catch(() => {
            if (!AppState.translationCache[langCode]) return;
            // Colorize failed — fall back to plain translated HTML; still
            // mark ready so the user sees the translated title.
            cache._titleColorHTML = Helpers.escapeHtml(translated);
            cache._titleReady = true;
            scheduleRender();
          });
      })
      .catch(err => {
        // Title is fire-and-forget normally, but a cap-hit here means
        // chapters/transcript will hit the same wall — surface it now so the
        // user gets the notice immediately instead of waiting for the slower
        // calls to fail too.
        _handleTranslateError(err, 'title');
      });
  }

  let completed = 0;
  const total = 3;
  let hasQualityWarning = false;
  // Cap-hit fires once per setLanguage invocation. Even if chapters AND
  // transcript both come back 429 (same root cause), the user only sees
  // one notice and one revert-to-original — not three.
  let capHitHandled = false;

  function _handleTranslateError(err, sourceForLog) {
    if (!err || !err.code) return false;
    if (err.code !== 'global_daily_cap_hit'
        && err.code !== 'per_ip_daily_cap_hit'
        && err.code !== 'translate_cap_accounting_unavailable') {
      return false;
    }
    if (capHitHandled) return true;
    capHitHandled = true;
    debugLog('[Translation] cap_hit', err.code, 'from', sourceForLog);

    // Hide every spinner so user isn't stuck mid-translation.
    Renderer.hidePanelProgress('tab-summary');
    Renderer.hidePanelProgress('tab-chapters');
    Renderer.hidePanelProgress('tab-transcript');
    Renderer.hideSummaryProgress?.();
    UI._hideTranslateProgress();
    tState.pendingRequest = null;

    // Drop the half-built cache for this lang so the next try starts clean
    // (cap might be released tomorrow OR they might switch to a cached lang).
    delete AppState.translationCache[langCode];

    // Show informative notice (not a warning — the user did nothing wrong).
    UI._showCapHitNotice(err.message || 'Daily translation limit reached for today. Try again tomorrow.');

    // Revert to original language so the page isn't stuck on a blank
    // translated state. setLanguage() is async but fire-and-forget here —
    // the user can pick another lang from the panel if they want.
    if (AppState.currentLang !== videoLang) {
      // Force the cycle by clearing currentLang — setLanguage no-ops if
      // langCode === currentLang, and we need it to actually run.
      AppState.currentLang = langCode;  // ensure setLanguage(videoLang) sees a diff
      setLanguage(videoLang).catch(() => {});
    }
    return true;
  }

  function _onSectionDone(warning) {
    completed++;
    if (warning === 'low_quality') hasQualityWarning = true;
    if (completed >= total) {
      tState.pendingRequest = null;
      UI._hideTranslateProgress();
      if (hasQualityWarning && !capHitHandled) UI._showQualityWarning(langLabel);
      scheduleRender();
    }
  }

  // Summary + Chapters share the summary progress bar
  let summaryDone = false, chaptersDone = false;
  function _checkSummaryBarDone() {
    if (summaryDone && chaptersDone) {
      Renderer.hideSummaryProgress();
      _fetchFormalForLang(langCode, cache);
    }
    else if (summaryDone) Renderer.showSummaryProgress('Translating chapters to ' + langLabel + '...' + advTag);
    else if (chaptersDone) Renderer.showSummaryProgress('Translating summary to ' + langLabel + '...' + advTag);
  }

  function _fetchFormalForLang(lang, translationCache) {
    if (!translationCache.summary && (!translationCache.chapters || !translationCache.chapters.length)) return;
    debugLog('[FORMAL] Fetching formal rewrite for language:', lang);
    RecapSharkAPI.formalRewrite({
      summary: translationCache.summary || '',
      chapters: translationCache.chapters || [],
      lang: lang,
    })
    .then(data => {
      if (!AppState.translationCache[lang]) return;
      AppState.translationCache[lang].formalSummary = data.summary || null;
      AppState.translationCache[lang].formalChapters = data.chapters || null;
      debugLog('[FORMAL] Ready for', lang, '— summary:', !!data.summary, 'chapters:', data.chapters?.length || 0);
      if (!AppState.casualMode && AppState.currentLang === lang) {
        scheduleRender();
      }
    })
    .catch(err => console.warn('[FORMAL] Failed for', lang, ':', err.message));
  }

  Renderer.showSummaryProgress('Generating ' + langLabel + ' summary...' + advTag);
  const _videoUrl = AppState.currentVideoId ? 'https://www.youtube.com/watch?v=' + AppState.currentVideoId : '';
  RecapSharkAPI.generateSummaryInLang(AppState.transcriptRawText || '', _videoUrl, langCode)
    .then(data => {
      if (tState.pendingRequest !== requestId) return;
      const paragraphs = Array.isArray(data.summary) ? data.summary : [data.summary || ''];
      cache.summary = paragraphs.join('\n\n');
      Renderer.hidePanelProgress('tab-summary');
      // Was: UI._setBilingualEnabled(true) — single gate that revealed the
      // mobile bar only after summary completion. Replaced with per-section
      // readiness so the bar appears the moment the FIRST section (any of
      // summary/chapters/transcript) lands, then per-tab .pending controls
      // the enabled state as the user navigates between tabs.
      UI._markSectionReady('summary');
      summaryDone = true;
      _checkSummaryBarDone();
      scheduleRender();
      _onSectionDone();
    })
    .catch(err => {
      console.error('[Translation:summary]', err);
      Renderer.hidePanelProgress('tab-summary');
      summaryDone = true;
      _checkSummaryBarDone();
      _onSectionDone();
    });

  // Chapters
  RecapSharkAPI.translateChapters(content.chapters, sourceLang, langCode, tChapters)
    .then(data => {
      if (tState.pendingRequest !== requestId) return;
      cache.chapters = data.chapters || [];
      Renderer.hidePanelProgress('tab-chapters');
      // Mark this section ready so the bar reveals (if not already) and the
      // chapters tab becomes enabled if it's the active one.
      UI._markSectionReady('chapters');
      chaptersDone = true;
      _checkSummaryBarDone();
      scheduleRender();
      _onSectionDone();
    })
    .catch(err => {
      if (_handleTranslateError(err, 'chapters')) return;
      console.error('[Translation:chapters]', err);
      Renderer.hidePanelProgress('tab-chapters');
      chaptersDone = true;
      _checkSummaryBarDone();
      _onSectionDone();
    });

  // Transcript — try bulk (Google, 1 request) first, fall back to chunked (GPT)
  const allLines = content.transcriptLines;
  if (!cache.transcriptMap) cache.transcriptMap = new Map();

  if (allLines.length === 0) {
    _onSectionDone();
    return;
  }

  UI._showTranslateProgress(10);

  const _runChunkedFallback = () => translateChunked({
    allLines, cache, sourceLang, langCode, requestId, tChunk,
    onSectionDone: _onSectionDone,
    onTranscriptComplete: () => _fireEntityFetchForLang(langCode, cache),
  });

  // Try bulk endpoint first (Google Translate — 1 request for entire transcript)
  RecapSharkAPI.translateTranscriptBulk(allLines, sourceLang, langCode)
    .then(data => {
      if (tState.pendingRequest !== requestId) return;

      if (data.fallback) {
        // Backend says use GPT — fall back to chunked path
        debugLog('[Translation] Bulk not available, falling back to chunked GPT');
        _runChunkedFallback();
        return;
      }

      // Bulk success — populate entire transcriptMap at once
      const lines = data.lines || [];
      for (const item of lines) {
        cache.transcriptMap.set(Number(item.id), item.text);
      }
      UI._showTranslateProgress(100);
      UI._hideTranslateProgress();
      Renderer.hidePanelProgress('tab-transcript');
      // Transcript fully translated — mark ready so the bar reveals (if
      // summary/chapters haven't already) and the transcript tab enables
      // when active.
      UI._markSectionReady('transcript');
      _fireEntityFetchForLang(langCode, cache);
      scheduleRender();
      _onSectionDone();
    })
    .catch(err => {
      // Cap-hit must NOT silently fall back to GPT chunked — that would
      // bypass the spend control the user just set up (Google cap stops
      // Google spend, but the GPT path bills OpenAI and would re-burn the
      // budget under a different SKU). Show the notice and stop.
      if (_handleTranslateError(err, 'bulk')) return;
      console.error('[Translation:bulk] Error, falling back to chunked:', err);
      _runChunkedFallback();
    });
}

/* ══════════════════════════════════════════════════════
   PUBLIC: INIT
   ══════════════════════════════════════════════════════ */

function init() {
  tState.langToggleBtn = document.getElementById('langToggleBtn');

  tState.bilingualControls = UI._createBilingualControls();
  const langBar = document.getElementById('langBar');
  const switchAllBtn = document.getElementById('langSwitchAll');
  if (switchAllBtn) switchAllBtn.remove();
  // Desktop (V10 layout): bilingual controls live in the new tab-bar slot.
  // Mobile: float them as overlay on the top-right of the content area.
  const desktopSlot = document.getElementById('desktopBilingualSlot');
  const mobileFloat = document.getElementById('mobileFloatingFlags');
  const isDesktop = window.matchMedia('(min-width: 901px)').matches;
  if (isDesktop && desktopSlot) {
    desktopSlot.appendChild(tState.bilingualControls);
  } else if (mobileFloat) {
    mobileFloat.appendChild(tState.bilingualControls);
  } else if (langBar) {
    langBar.appendChild(tState.bilingualControls);
  }

  UI._repositionLangBar();
  document.querySelectorAll('.tab-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      requestAnimationFrame(UI._repositionLangBar);
    });
  });

  UI._buildLangPanel();
  const langSearchInput = document.querySelector('#langPanel .lang-search input');
  if (langSearchInput) {
    langSearchInput.addEventListener('input', function () {
      const q = this.value.toLowerCase().trim();
      const container = document.getElementById('langPanelContent');
      if (!container) return;
      container.querySelectorAll('.lang-option').forEach(el => {
        if (!q) { el.style.display = ''; return; }
        const name = (el.querySelector('.lang-name')?.textContent || '').toLowerCase();
        const native = (el.querySelector('.lang-native')?.textContent || '').toLowerCase();
        el.style.display = (name.includes(q) || native.includes(q)) ? '' : 'none';
      });
      container.querySelectorAll('.lang-section-label').forEach(label => {
        label.style.display = q ? 'none' : '';
      });
    });
  }
}

/* ══════════════════════════════════════════════════════
   PUBLIC: RESET
   ══════════════════════════════════════════════════════ */

function reset() {
  tState.pendingRequest = null;
  tState.displayMode = 'original';
  UI._removeAllSubs();
  UI._hideQualityWarning();
  UI._hideCapHitNotice();
  AppState._origSubtitleTexts = null;
  UI._hideBilingualControls();
  // New video loaded — drop any leftover translation banners.
  Renderer.hidePanelProgress('tab-summary');
  Renderer.hidePanelProgress('tab-chapters');
  Renderer.hidePanelProgress('tab-transcript');
  AppState.currentLang = 'en';
  AppState.translationCache = {};
  AppState.chipTranslationCache = {};
  delete document.body.dataset.translateLang;
}

/* ── Public API ─────────────────────────────────────── */

export const TranslationManager = {
  init,
  setLanguage,
  translateChatGreeting: UI._translateChatGreeting,
  reset,
  rebuildLangPanel: UI._buildLangPanel,
};
