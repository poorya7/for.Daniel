import { AppState } from '../core/state.js';
import { Helpers } from '../core/helpers.js';
import { Analytics } from '../analytics/analytics.js';
import { FlatTranscript } from './flat-transcript.js';
import { TranscriptBuffer } from './transcript-buffer.js';
import { applyLangStyle, setLangClass } from './font-loader.js';
import { EntityHighlighter } from './entity-highlighter.js';
import { RendererProgress } from './renderer-progress.js';
import { RendererMeta } from './renderer-meta.js';
import { RendererSummary } from './renderer-summary.js';
import { RendererChapters } from './renderer-chapters.js';
import { RendererMobilePanels } from './renderer-mobile-panels.js';

/**
 * RecapShark Renderer — coordinator.
 *
 * Owns: desktop transcript render path (the buffer-swap engine for the
 *       transcript / subtitles tabs), the central setMode tab router, the
 *       full Renderer public API surface.
 *
 * Sub-modules (split out 2026-05-06, cycle 4 of SRP refactor):
 *   - renderer-progress.js          summary / per-panel / transcript
 *                                   progress banners
 *   - renderer-meta.js              video metadata DOM (title, channel,
 *                                   date, now-watching bar)
 *   - renderer-summary.js           summary HTML + paragraph render path
 *   - renderer-chapters.js          chapter list HTML, click delegation,
 *                                   active-row highlight
 *   - renderer-mobile-panels.js     mobile transcript/subtitles
 *                                   FlatTranscript instances + summary
 *                                   SummaryNativeScroll + lifecycle
 *
 * Public API contract: byte-identical to the pre-cycle-4 surface except
 * for an intentional cleanup-rename pass on the wheel/cylinder names —
 *   syncActiveWheelToTime         → syncActiveMobilePanelToTime
 *   toggleActiveWheelAutoScroll   → toggleActiveMobilePanelAutoScroll
 *   destroyAllWheels              → destroyAllMobilePanels
 * The window-bridge `_refreshMobileWheels` follows the same rename:
 *   window._refreshMobileWheels   → window._refreshMobilePanels
 * (callers updated in cycle 4: player.js core, loading-state.js,
 *  casual-mode.js). The original "wheel"/"cylinder" terminology dates
 * back to a 3D-cylinder mobile UI that was replaced with native flat
 * scroll in late April 2026; the symbol names lingered until this cycle.
 */
export const Renderer = (() => {

  /* ── Transcript navigation ──────────────────────────── */

  function showTranscriptAt(seconds) {
    const isMobile = Helpers.isNarrowViewport();

    // Mobile: scroll the active panel (don't force tab switch)
    const activePanel = RendererMobilePanels.getActivePanel();
    if (isMobile && activePanel) {
      activePanel.scrollToTime(seconds, false);
      return;
    }

    // Desktop: switch to transcript tab
    setTranscriptMode('transcript');

    // Desktop: DOM scroll
    const panel = TranscriptBuffer.getActive('transcript');
    if (!panel) return;
    const chips = panel.querySelectorAll('.ts-chip[data-time]');
    let best = null;
    for (const chip of chips) {
      const t = Number(chip.dataset.time);
      if (t <= seconds) best = chip;
      else break;
    }
    if (!best && chips.length) best = chips[0];
    if (best) {
      const row = best.closest('.transcript-line') || best.closest('.transcript-paragraph');
      if (!row) return;
      const scrollContainer = panel;
      if (scrollContainer) {
        const containerTop = scrollContainer.getBoundingClientRect().top;
        const rowTop = row.getBoundingClientRect().top;
        const offset = rowTop - containerTop + scrollContainer.scrollTop - 8;
        scrollContainer.scrollTo({ top: offset, behavior: 'smooth' });
      }
    }
  }

  /* ── Transcript HTML builders ───────────────────────── */

  function buildTranscriptParagraphHtml(raw) {
    const lines = raw
      .split('\n')
      .map(line => line.replace(/^- /, '').trim())
      .filter(Boolean);

    const chipLang = AppState.currentLang || AppState.videoData?.lang || '';
    const groups = AppState.paragraphGroups.length ? AppState.paragraphGroups : Helpers.groupLinesByParagraph(lines);
    const paragraphs = [];

    for (let gi = 0; gi < groups.length; gi++) {
      const group = groups[gi];
      const t = Helpers.lineToTime(group.firstIdx);
      const text = group.lineIndices.map(i => lines[i]).join(' ');
      const alt = gi % 2 === 1 ? ' alt-row' : '';
      paragraphs.push(
        `<div class="transcript-paragraph${alt}" data-idx="${group.firstIdx}">` +
          `<span class="ts-chip" data-time="${t}">${Helpers.fmtTime(t, chipLang)}</span>` +
          `<span class="ts-text">${Helpers.escapeHtml(_cleanTranscriptText(text))}</span>` +
        `</div>`
      );
    }
    return paragraphs.join('');
  }

  /** Clean transcript text before it enters the mobile panel — one pass, one place */
  function _cleanTranscriptText(text) {
    if (!text) return text;
    // 1. Decode HTML entities (&nbsp; → space, &amp; → &, etc.)
    if (text.includes('&')) {
      const el = document.createElement('textarea');
      el.innerHTML = text;
      text = el.value;
    }
    // 2. Replace YouTube bleep markers: [ __ ], [__], [ ___ ], etc.
    text = text.replace(/\[\s*_+\s*\]/g, '[bleep]');
    return text;
  }

  /* ── Mobile panel data builder ── */

  function _parseRawLines(raw) {
    return (raw || '').split('\n').map(l => l.replace(/^- /, '').trim()).filter(Boolean);
  }

  function buildMobilePanelItems(raw, config = {}) {
    const lines = _parseRawLines(raw);
    const videoLang = AppState.videoData?.lang || 'en';
    const currentLang = AppState.currentLang || videoLang;
    const chipLang = currentLang || videoLang || '';

    // If we're on mobile in bilingual mode, build a parallel set of items
    // from the ORIGINAL (video-lang) transcript so each row can show both.
    // Primary text comes from `raw` (already translated via getContent),
    // secondary text is the matching original paragraph/line.
    const bilingualState = RendererMobilePanels.getBilingualState();
    const isBilingual = bilingualState.active
      && Helpers.isNarrowViewport()
      && AppState.transcriptRawText
      && AppState.transcriptRawText !== raw;
    const origLines = isBilingual ? _parseRawLines(AppState.transcriptRawText) : null;

    // Per-item lang tags so flat-transcript.js can apply the correct script
    // font/direction inline (covers all 105 supported languages without
    // per-script CSS rules — see applyLangStyle in font-loader.js).
    const primaryLang = currentLang;
    const subLang = videoLang;

    if (config.groupByParagraph) {
      const groups = AppState.paragraphGroups.length ? AppState.paragraphGroups : Helpers.groupLinesByParagraph(lines);
      return groups.map(group => {
        const t = Helpers.lineToTime(group.firstIdx);
        const text = group.lineIndices.map(i => lines[i]).join(' ');
        const item = { time: t, display: Helpers.fmtTime(t, chipLang), text: _cleanTranscriptText(text), primaryLang, subLang };
        if (origLines) {
          const origText = group.lineIndices.map(i => origLines[i] || '').join(' ');
          item.subText = _cleanTranscriptText(origText);
        }
        return item;
      });
    }

    return lines.map((line, i) => {
      const t = Helpers.lineToTime(i);
      const item = { time: t, display: Helpers.fmtTime(t, chipLang), text: _cleanTranscriptText(line), primaryLang, subLang };
      if (origLines && origLines[i]) {
        item.subText = _cleanTranscriptText(origLines[i]);
      }
      return item;
    });
  }

  /* ── Desktop transcript render path ─────────────────── */

  let _transcriptHtmlCache = { key: '', html: '' };

  // Callback for bilingual annotations — set by casual-mode.js via setAnnotationCallback()
  let _addTranscriptAnnotationsFn = null;
  let _bilingualSwapped = false;

  // Pending render flag — when a render is requested during a crossfade, we queue it
  // and flush after the fade completes (Fix 3: prevents silently dropped renders)
  let _pendingRender = { transcript: false };

  // Apply direction/font classes directly on a buffer element (per-buffer isolation)
  function _applyBufferLangClasses(buffer, lang) {
    buffer.classList.remove('rtl', 'ltr', 'lang-fa', 'lang-ar', 'lang-he');
    buffer.classList.add(Helpers.isRTL(lang) ? 'rtl' : 'ltr');
    setLangClass(buffer, lang);
    // Apply correct script font/direction inline on every primary text span.
    // Covers the long tail of supported languages (CJK, Devanagari, etc.) for
    // which there's no per-script CSS rule.
    buffer.querySelectorAll('.ts-text').forEach(el => applyLangStyle(el, lang));
  }

  /** Sync scroll position from one buffer to another by matching the topmost visible timestamp */
  function _syncScrollBetweenBuffers(from, to) {
    const fromRows = from.querySelectorAll('.transcript-line, .transcript-paragraph');
    const fromTop = from.scrollTop;
    let anchorTime = -1;
    let anchorOffset = 0;
    for (let i = 0; i < fromRows.length; i++) {
      if (fromRows[i].offsetTop + fromRows[i].offsetHeight > fromTop) {
        const chip = fromRows[i].querySelector('.ts-chip');
        anchorTime = chip ? Number(chip.dataset.time) : -1;
        anchorOffset = fromRows[i].offsetTop - fromTop;
        break;
      }
    }
    if (anchorTime < 0) return;
    const toRows = to.querySelectorAll('.transcript-line, .transcript-paragraph');
    for (let i = toRows.length - 1; i >= 0; i--) {
      const chip = toRows[i].querySelector('.ts-chip');
      if (chip && Number(chip.dataset.time) <= anchorTime) {
        to.scrollTop = toRows[i].offsetTop - anchorOffset;
        break;
      }
    }
  }

  function _renderDesktopTranscript() {
    const mode = 'transcript';
    const active = TranscriptBuffer.getActive(mode);
    if (!active) return;

    const searchSection = document.getElementById('transcriptSearchSection');
    if (searchSection) searchSection.style.display = '';
    const rawText = AppState.getContent('transcript') || AppState.transcriptRawText;

    // ── Cache key ──
    const panelId = 'fullTranscriptPanel';
    const textFingerprint = rawText ? rawText.length + ':' + rawText.substring(0, 40) : '0';
    const bilingualFlag = _addTranscriptAnnotationsFn ? ('bi' + (_bilingualSwapped ? 's' : '')) : '';
    const cacheKey = panelId + ':' + AppState.currentLang + ':' + textFingerprint + ':' + bilingualFlag;

    // If active buffer already has this content, just sync scroll to standby and swap
    if (active.dataset.renderedKey === cacheKey) {
      const standby = TranscriptBuffer.getStandby(mode);
      if (standby && standby.dataset.renderedKey) {
        _syncScrollBetweenBuffers(active, standby);
      }
      return;
    }

    // ── Bilingual-only fast path (in-place mutation, no buffer swap) ──
    // Detect: same language, same text, only the bilingual flag changed.
    // NOTE: textFingerprint contains ':' so we can't naively split the cacheKey.
    // Instead, compare the base (everything before last ':') and the flag (after last ':').
    const prevKey = active.dataset.renderedKey || '';
    const prevBi = prevKey.slice(prevKey.lastIndexOf(':') + 1);
    const prevBase = prevKey.slice(0, prevKey.lastIndexOf(':'));
    const currLang = AppState.currentLang || 'en';
    const currBase = panelId + ':' + currLang + ':' + textFingerprint;

    const isBilingualOnlyChange = prevKey &&
      prevBase === currBase &&
      prevBi !== bilingualFlag;

    if (isBilingualOnlyChange) {
      // Guard: don't race with an in-flight crossfade — queue for after fade completes
      if (TranscriptBuffer.isFading(mode)) {
        _pendingRender[mode] = true;
        return;
      }

      const panel = active;

      // Sub-case: swap-only (bi ↔ bis) — just toggle CSS class, no DOM mutation
      const isSwapOnly = (prevBi === 'bi' && bilingualFlag === 'bis') ||
                         (prevBi === 'bis' && bilingualFlag === 'bi');
      if (isSwapOnly) {
        panel.classList.toggle('bilingual-cols-swapped', _bilingualSwapped);
        panel.dataset.renderedKey = cacheKey;
        return;
      }

      // Sub-case: add or remove bilingual annotations
      // 1. Save anchor
      const rows = panel.querySelectorAll('.transcript-line, .transcript-paragraph');
      let anchorRow = null;
      let oldAnchorOffsetTop = 0;
      const oldScrollTop = panel.scrollTop;
      for (let i = 0; i < rows.length; i++) {
        if (rows[i].offsetTop + rows[i].offsetHeight > oldScrollTop) {
          anchorRow = rows[i];
          oldAnchorOffsetTop = rows[i].offsetTop;
          break;
        }
      }

      // 2. In-place mutation
      const hasBilingualNow = typeof _addTranscriptAnnotationsFn === 'function';
      if (hasBilingualNow) {
        // Remove stale subs first (covers re-entry / state mismatch)
        panel.querySelectorAll('.bilingual-sub').forEach(sub => sub.remove());
        _addTranscriptAnnotationsFn(panel);
        // Re-apply entity coloring to the freshly-injected bilingual subs.
        EntityHighlighter.highlightAllInContainer(panel);
      } else {
        panel.querySelectorAll('.bilingual-sub').forEach(sub => sub.remove());
      }

      // 3. Toggle layout classes
      panel.classList.toggle('bilingual-side-by-side', hasBilingualNow);
      panel.classList.toggle('bilingual-cols-swapped', hasBilingualNow && _bilingualSwapped);

      // 4. Re-apply direction/lang classes (bilingual annotations can affect RTL flex/grid)
      _applyBufferLangClasses(panel, currLang);

      // 5. Force layout so offsetTop reflects new row heights
      void panel.offsetHeight;

      // 6. Restore scroll position
      // Try playback-derived position first (correct for auto-scroll-on).
      // Fall back to delta anchor (correct for auto-scroll-off / paused / short panels).
      if (window.PlayerManager?.writePlaybackScrollTop) {
        const before = panel.scrollTop;
        window.PlayerManager.writePlaybackScrollTop(panel);
        // If writePlaybackScrollTop didn't change anything (returned early / not scrollable),
        // fall back to delta anchor
        if (panel.scrollTop === before && anchorRow) {
          const delta = anchorRow.offsetTop - oldAnchorOffsetTop;
          panel.scrollTop = Math.max(0, oldScrollTop + delta);
          panel.scrollTop = Math.min(panel.scrollTop, panel.scrollHeight - panel.clientHeight);
        }
      } else if (anchorRow) {
        const delta = anchorRow.offsetTop - oldAnchorOffsetTop;
        panel.scrollTop = Math.max(0, oldScrollTop + delta);
        panel.scrollTop = Math.min(panel.scrollTop, panel.scrollHeight - panel.clientHeight);
      }

      // 7. Update cache key
      panel.dataset.renderedKey = cacheKey;

      // 8. Apply font sizes (new .bilingual-sub divs need correct sizing)
      if (typeof window.applyFontSizes === 'function') window.applyFontSizes();

      // 9. Reseed easing engine (light-touch — syncs shadow state, doesn't interrupt RAF)
      if (window.PlayerManager?.reseedEasingCurrent) {
        window.PlayerManager.reseedEasingCurrent(panel);
      }

      // Do NOT clear AppState.lastHighlightedRow — DOM node is still alive
      return;
    }

    // ── Build HTML (full render path) ──
    let html;
    if (_transcriptHtmlCache.key === cacheKey) {
      html = _transcriptHtmlCache.html;
    } else {
      html = buildTranscriptParagraphHtml(rawText);
      _transcriptHtmlCache = { key: cacheKey, html };
    }

    // ── Crossfade decision ──
    const hasExisting = !!active.dataset.renderedKey;
    const prevFP = (active.dataset.renderedKey || '').split(':').slice(2).join(':');
    const nextFP = cacheKey.split(':').slice(2).join(':');
    const textChanged = prevFP !== nextFP;
    const sameLang = (active.dataset.renderedLang || 'en') === (AppState.currentLang || 'en');
    const shouldCrossfade = hasExisting && textChanged;

    // Re-entrancy guard: queue render if crossfade is in progress (don't silently drop)
    if (TranscriptBuffer.isFading(mode)) {
      _pendingRender[mode] = true;
      return;
    }

    // ── Save scroll anchor from active buffer ──
    let anchorRow = null;
    let anchorTime = -1;
    let anchorViewOffset = 0;
    const activeRows = active.querySelectorAll('.transcript-line, .transcript-paragraph');
    const bufferTop = active.scrollTop;
    for (let i = 0; i < activeRows.length; i++) {
      if (activeRows[i].offsetTop + activeRows[i].offsetHeight > bufferTop) {
        anchorRow = activeRows[i];
        const chip = anchorRow.querySelector('.ts-chip');
        anchorTime = chip ? Number(chip.dataset.time) : -1;
        anchorViewOffset = anchorRow.offsetTop - bufferTop;
        break;
      }
    }


    // ── Render into standby buffer ──
    const standby = TranscriptBuffer.getStandby(mode);
    standby.innerHTML = html;
    /* K5.5 (2026-05-07): drop PlayerManager's row-index cache for this
     * panel — its .transcript-line / .transcript-paragraph rows just
     * got rebuilt, so the cached time→row index is stale. This is the
     * primary invalidation hook (covers initial render, language switch,
     * video swap, paragraph/subtitle mode toggle, and bilingual toggle
     * which routes through _scheduleRender → this code path). The DEV-only
     * assert in _findActiveRowAt will warn if any rebuild path bypasses
     * this hook. Bridge-pattern call (matches L344, L367, L467, L479). */
    window.PlayerManager?.invalidateRowIndex?.(standby);
    standby.dataset.renderedKey = cacheKey;
    standby.dataset.renderedLang = AppState.currentLang || 'en';
    standby.classList.add('paragraph-mode');

    // Apply direction/font classes directly on standby buffer (per-buffer isolation)
    if (textChanged) {
      _applyBufferLangClasses(standby, AppState.currentLang || 'en');
    }

    // Add bilingual annotations BEFORE layout force + scroll restore
    // (annotations change row heights — anchor must use final geometry)
    const hasBilingual = typeof _addTranscriptAnnotationsFn === 'function';
    if (hasBilingual) _addTranscriptAnnotationsFn(standby);
    standby.classList.toggle('bilingual-side-by-side', hasBilingual);

    // Date/number entity coloring on every row text (and bilingual sub if
    // present). Cheap pure-regex pass on the standby buffer before swap. If
    // karaoke later wraps words in .k-word spans, KaraokeManager re-runs
    // entity coloring on the new spans (see karaoke.js _buildWordSpans).
    EntityHighlighter.highlightAllInContainer(standby);

    // Force layout calc so offsetTop reflects final geometry (including annotations)
    void standby.offsetHeight;

    // Restore scroll on standby so same timestamp row is at same visual position
    if (anchorTime >= 0) {
      const rows = standby.querySelectorAll('.transcript-line, .transcript-paragraph');
      for (let i = rows.length - 1; i >= 0; i--) {
        const chip = rows[i].querySelector('.ts-chip');
        if (chip && Number(chip.dataset.time) <= anchorTime) {
          const targetTop = rows[i].offsetTop - anchorViewOffset;
          const maxTop = Math.max(0, standby.scrollHeight - standby.clientHeight);
          standby.scrollTop = Math.max(0, Math.min(targetTop, maxTop));
          break;
        }
      }
    }

    // Apply font sizes after annotations are in the DOM
    if (typeof window.applyFontSizes === 'function') window.applyFontSizes();

    // ── Pre-crossfade: position standby at correct playback scroll ──
    // For language switches, the anchor is meaningless (different row heights).
    // Override standby scrollTop with playback position WHILE IT'S STILL HIDDEN,
    // so it fades in at the right spot. No visible jump.
    if (!sameLang && window.PlayerManager?.writePlaybackScrollTop) {
      window.PlayerManager.writePlaybackScrollTop(standby);
    }

    // ── Swap buffers + seed easing engine ──
    if (shouldCrossfade) {
      TranscriptBuffer.crossfade(mode, () => {
        AppState.lastHighlightedRow = null;
        if (typeof window.applyFontSizes === 'function') window.applyFontSizes();
        // Seed engine from current scrollTop (already at correct position for lang switch,
        // or at anchor position for same-lang update)
        const newActive = TranscriptBuffer.getActive(mode);
        if (window.PlayerManager?.seedEasingAfterSwap) {
          window.PlayerManager.seedEasingAfterSwap(newActive, mode);
        }
        // Flush any render that was queued during the crossfade
        if (_pendingRender[mode]) {
          _pendingRender[mode] = false;
          _renderDesktopTranscript();
        }
      });
    } else {
      TranscriptBuffer.snapSwap(mode);
      AppState.lastHighlightedRow = null;
      // Seed engine from current scrollTop
      const newActive = TranscriptBuffer.getActive(mode);
      if (window.PlayerManager?.seedEasingAfterSwap) {
        window.PlayerManager.seedEasingAfterSwap(newActive, mode);
      }
    }

  }

  function renderTranscriptContent() {
    const isMobile = Helpers.isNarrowViewport();
    if (isMobile) {
      // Drive panel lifecycle from data arrival. When the active mobile mode
      // is a transcript-style tab, re-fire showMode so the prepare-on-demand
      // path picks up the now-available rawData and flips the wrapper visible.
      // Idempotent — safe when data hasn't landed yet or the panel is ready.
      // Skip when the active mode is anything else: don't surprise-prepare a
      // panel whose tab isn't on screen.
      const activeMode = RendererMobilePanels.getActiveMode();
      if (activeMode === 'transcript') {
        RendererMobilePanels.showMode(activeMode);
      }
      return;
    }
    _renderDesktopTranscript();
  }

  /* ── setMode + tab toggle wiring ─────────────────────── */

  function initSummaryTranscriptToggle() {
    RendererMobilePanels.prepareAll();  // pre-build all mobile panels in background (hidden)
    const tabBtns = document.querySelectorAll('.tab-btn');
    const summaryPane = document.getElementById('tab-summary');
    const transcriptPane = document.getElementById('tab-transcript');
    const fullTranscriptEl = document.getElementById('fullTranscriptPanel');
    if (!tabBtns.length || !summaryPane || !transcriptPane || !fullTranscriptEl) return;

    renderTranscriptContent();
    fullTranscriptEl.addEventListener('click', e => {
      const chip = e.target.closest('.ts-chip');
      if (!chip) return;
      Helpers.seekTo(Number(chip.dataset.time));
    });

    const searchSection = document.getElementById('transcriptSearchSection');
    if (searchSection) searchSection.classList.toggle('hidden', AppState.totalLines === 0 || !AppState.processingDone);
    const hideControls = AppState.totalLines === 0 || !AppState.processingDone;
    document.querySelectorAll('.desktop-panel-btns').forEach(function (el) {
      el.classList.toggle('hidden', hideControls);
    });

    tabBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const mode = btn.dataset.mode || btn.textContent.trim().toLowerCase().split(/\s/)[0];
        setTranscriptMode(mode);
        Analytics.tabSwitched(mode);
      });
    });

    if (typeof window.applyFontSizes === 'function') window.applyFontSizes();
  }

  /* ── Central tab-router (Phase 4d): module-level so the public bridge no
     longer captures local closure state. Re-queries `.tab-btn` and
     `.tab-pane` per call (~10 nodes each, cheap) instead of caching. ── */
  function setTranscriptMode(mode) {
    // Desktop: skip re-render if already on this tab (prevents flash on seek)
    const isMobile = Helpers.isNarrowViewport();
    if (!isMobile && RendererMobilePanels.getActiveMode() === mode) return;

    // Tab button + pane active state via data-mode attribute
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.mode === mode));
    document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
    const target = document.getElementById('tab-' + mode);
    const entry = RendererMobilePanels.getEntry(mode);

    // Desktop with time-sync: hide pane so we can build content + pre-scroll before user sees it
    const needsDesktopPreScroll = !isMobile && entry?.supportsTimeSync && target;
    if (needsDesktopPreScroll) target.style.visibility = 'hidden';
    if (target) target.classList.add('active');

    if (isMobile && entry) {
      RendererMobilePanels.showMode(mode);
      const searchSection = document.getElementById('transcriptSearchSection');
      if (searchSection) searchSection.style.display = 'none';
    } else if (isMobile && mode === 'summary') {
      RendererMobilePanels.showMode(mode);
    } else if (!isMobile) {
      // Desktop: only re-render if active buffer is empty or language changed
      if (entry?.desktopRender) {
        const activeBuf = TranscriptBuffer.getActive('transcript');
        const needsRender = !activeBuf || !activeBuf.innerHTML.trim() ||
          activeBuf.dataset.renderedLang !== (AppState.currentLang || 'en');
        if (needsRender) entry.desktopRender();
      }

      // Atomic snap to current video time BEFORE visibility is restored.
      // PlayerManager resolves the real scrollable buffer (the wrapper
      // #fullTranscriptPanel is overflow:hidden — writing scrollTop on it
      // is a silent no-op).
      if (needsDesktopPreScroll) {
        const activeRow = window.PlayerManager?.snapDesktopAutoScrollToNow?.('transcript');
        if (activeRow) AppState.lastHighlightedRow = activeRow;
        target.style.visibility = '';
      }
    }

    // Desktop fallthrough: ensure mode is recorded even when mobile panels weren't touched
    if (!isMobile && RendererMobilePanels.getActiveMode() !== mode) {
      RendererMobilePanels.setActiveMode(mode);
    }

    const langBar = document.getElementById('langBar');
    if (langBar) langBar.style.display = (mode === 'summary' || mode === 'transcript' || mode === 'chapters' || mode === 'bookmarks') ? '' : 'none';

    // Bilingual collapse-button availability + per-tab .pending state.
    // Both live in translation-bilingual.js — bridged via window to avoid
    // a renderer → translation import cycle.
    if (typeof window._updateCollapseBtnAvailability === 'function') {
      window._updateCollapseBtnAvailability(mode);
    }
    if (typeof window._evalPendingForCurrentTab === 'function') {
      window._evalPendingForCurrentTab(mode);
    }
  }

  /* ── Sub-module wiring ──────────────────────────────── */

  RendererChapters.setup({ showTranscriptAt });

  // Register the two transcript-style mobile panels with the mobile-panels module.
  // dataSource + dataBuilder live in core (they need access to buildMobilePanelItems
  // and AppState.getContent). desktopRender is the per-mode re-render hook the
  // desktop tab path calls.
  RendererMobilePanels.register('transcript', {
    panel: FlatTranscript,
    containerId: 'fullTranscriptPanel',
    dataSource: () => AppState.getContent('transcript') || AppState.transcriptRawText,
    dataBuilder: (raw) => buildMobilePanelItems(raw, { groupByParagraph: true }),
    supportsTimeSync: true,
    desktopRender: () => { _renderDesktopTranscript(); },
  });

  /* ── Public API ─────────────────────────────────────── */

  return {
    showSummaryProgress: RendererProgress.showSummaryProgress,
    hideSummaryProgress: RendererProgress.hideSummaryProgress,
    showPanelProgress: RendererProgress.showPanelProgress,
    hidePanelProgress: RendererProgress.hidePanelProgress,
    showTranscriptProgress: RendererProgress.showTranscriptProgress,
    hideTranscriptProgress: RendererProgress.hideTranscriptProgress,
    renderMeta: RendererMeta.renderMeta,
    summaryHTML: RendererSummary.summaryHTML,
    renderSummary: RendererSummary.renderSummary,
    renderSummaryDirect: RendererSummary.renderSummaryDirect,
    topicsHTML: RendererChapters.topicsHTML,
    renderTopics: RendererChapters.renderTopics,
    renderChaptersPreview: RendererChapters.renderChaptersPreview,
    setActiveTopic: RendererChapters.setActiveTopic,
    showTranscriptAt,
    initSummaryTranscriptToggle,
    setTranscriptMode,
    syncActiveMobilePanelToTime: RendererMobilePanels.syncActiveToTime,
    toggleActiveMobilePanelAutoScroll: RendererMobilePanels.toggleActiveAutoScroll,
    destroyAllMobilePanels: RendererMobilePanels.destroyAll,
    renderTranscriptContent,
    setAnnotationCallback: (fn, swapped) => { _addTranscriptAnnotationsFn = fn; _bilingualSwapped = !!swapped; },
  };
})();
