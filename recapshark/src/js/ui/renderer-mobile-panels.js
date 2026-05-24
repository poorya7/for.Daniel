// renderer-mobile-panels.js
//
// Owns: mobile-only panel registry (the FlatTranscript instance per
//       `transcript`/`subtitles` mode + the SummaryNativeScroll instance for
//       `summary`), active-panel tracking, the floating auto-scroll +
//       jump-to-now buttons, lifecycle prepare/refresh/destroy across
//       language switches and bilingual toggles, the script-font preload,
//       summary scroller show/hide/refresh on the mobile path.
//
// Reads from AppState: player, videoData, currentLang, transcriptRawText,
//                      translationCache.
// Imports allowed: ../core/state, ../core/helpers, ./flat-transcript,
//                  ./summary-native-scroll, ./font-loader.
//
// Coupling notes: receives no callbacks from siblings — the mobile panels
//                 are self-contained. Core registers each mode by calling
//                 register({mode, dataSource, dataBuilder, ...}) and reads
//                 active state via getActivePanel()/getActiveMode().
//
// Naming history: this module replaced the older "wheel" naming —
// `_wheels` Map → `_mobilePanels`, `_activeWheel` → `_activeMobilePanel`,
// `_summaryCylinder` → `_summaryMobilePanel`, etc. The mobile UI used to
// be 3D cylinders (cylinder-scroll.js, deprecated) then later wheels —
// both replaced by FlatTranscript + SummaryNativeScroll in late April
// 2026. The stale names lingered through several refactors; cycle 4 of
// the SRP refactor (2026-05-06) cleaned them up. The cylinder/wheel
// terminology should not appear in new code.

import { AppState } from '../core/state.js';
import { Helpers } from '../core/helpers.js';
import { FlatTranscript, createFlatTranscript } from './flat-transcript.js';
import { createSummaryNativeScroll } from './summary-native-scroll.js';
import { applyLangStyle, setLangClass } from './font-loader.js';

/* ── Mobile panel registry ─────────────────────────────── */
const _mobilePanels = new Map();
let _activeMobilePanel = null;
let _activeMode = null;
const _jumpBtnIntervals = new Set();

// Module-level bilingual state for mobile panel rendering.
// Read by buildMobilePanelItems (in core) via the `getBilingualState()` getter.
const _mobileBilingual = { active: false, swapped: false };

/**
 * Mark the rewind-end blur lift dependency satisfied once a transcript-style
 * panel has been prepared with non-empty real items. process-url-view.js'
 * rewind-end reveal awaits `rs:transcript-painted` (with a 5s safety timeout)
 * before lifting the blur, so the user never sees the placeholder skeleton
 * exposed by a half-lifted blur on slower-pipeline videos.
 *
 * Safe to call repeatedly — sets a flag and fires a one-shot event. If no
 * one is listening (subsequent paste, no rewind), it's a no-op.
 */
function _markTranscriptPaintedIfTranscriptPanel(entry, items) {
  if (!items || !items.length) return;
  if (entry.containerId !== 'fullTranscriptPanel') return;
  if (AppState.transcriptPainted) return;  // already marked this paste
  AppState.transcriptPainted = true;
  try { window.dispatchEvent(new CustomEvent('rs:transcript-painted')); } catch (_) {}
}

function register(mode, config) {
  if (_mobilePanels.has(mode)) return;
  if (!config.containerId) throw new Error(`registerMobilePanel("${mode}") missing containerId`);
  _mobilePanels.set(mode, {
    panel: config.panel || null,
    panelConfig: config.panelConfig || {},
    containerId: config.containerId,
    dataSource: config.dataSource,
    dataBuilder: config.dataBuilder,
    supportsTimeSync: config.supportsTimeSync !== false,
    desktopRender: config.desktopRender || null,
  });
}

function _getOrCreatePanel(entry) {
  if (!entry.panel) {
    entry.panel = createFlatTranscript(entry.panelConfig);
  }
  return entry.panel;
}

function getEntry(mode) {
  return _mobilePanels.get(mode);
}

function getActivePanel() {
  return _activeMobilePanel;
}

function getActiveMode() {
  return _activeMode;
}

function setActiveMode(mode) {
  _activeMode = mode;
}

function clearActivePanel() {
  if (_activeMobilePanel) {
    _activeMobilePanel.hide();
    _activeMobilePanel = null;
  }
}

function getBilingualState() {
  return _mobileBilingual;
}

/* ── Mobile auto-scroll toggle (floating button) ───────── */

function ensureAutoScrollToggle(container, panel) {
  if (container.querySelector('.mobile-autoscroll-toggle')) return;

  const btn = document.createElement('button');
  btn.className = 'mobile-autoscroll-toggle on'; // starts on
  btn.setAttribute('aria-label', 'Toggle auto-scroll');
  btn.setAttribute('title', 'Auto-scroll with video');

  btn.addEventListener('click', function (e) {
    e.preventDefault();
    e.stopPropagation();

    const newVal = !panel.getAutoScroll();
    panel.setAutoScroll(newVal);
    this.classList.toggle('on', newVal);

    // Sync desktop toggle to active panel's state
    syncDesktopAutoScrollToggle();
  });

  btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><path d="M12 5v14"/><polyline points="8 15 12 19 16 15"/><polyline points="8 9 12 5 16 9"/></svg>`;

  container.appendChild(btn);
}

/* ── Mobile "Jump to Now" button ──────────────────────── */

function ensureJumpToNowBtn(container) {
  if (container.querySelector('.mobile-jump-to-now')) return;

  const btn = document.createElement('button');
  btn.className = 'mobile-jump-to-now';
  btn.setAttribute('aria-label', 'Jump to current position');
  btn.setAttribute('title', 'Jump to now');

  // Crosshair / locate icon
  btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><circle cx="12" cy="12" r="3"/><line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/></svg>`;

  btn.addEventListener('click', function (e) {
    e.preventDefault();
    e.stopPropagation();
    if (!AppState.player || !AppState.player.getCurrentTime || !_activeMobilePanel) return;
    _activeMobilePanel.clearInteraction();
    const t = AppState.player.getCurrentTime();
    _activeMobilePanel.scrollToTime(t, true);
  });

  container.appendChild(btn);

  // Periodic visibility check — show only when auto-scroll OFF and current time not visible
  const intervalId = setInterval(function () {
    if (!AppState.player || !AppState.player.getCurrentTime || !_activeMobilePanel) { btn.classList.remove('visible'); return; }
    const t = AppState.player.getCurrentTime();
    const shouldShow = _activeMobilePanel && !_activeMobilePanel.getAutoScroll() && !_activeMobilePanel.isTimeVisible(t);
    btn.classList.toggle('visible', shouldShow);
  }, 500);
  _jumpBtnIntervals.add(intervalId);
}

function syncAutoScrollButton(container, panel) {
  const btn = container.querySelector('.mobile-autoscroll-toggle');
  if (btn) btn.classList.toggle('on', panel.getAutoScroll());
}

function syncDesktopAutoScrollToggle() {
  const val = _activeMobilePanel ? _activeMobilePanel.getAutoScroll() : false;
  document.querySelectorAll('.desktop-autoscroll-toggle').forEach(function (btn) {
    btn.classList.toggle('on', val);
  });
}

/* ── Layout coercion helper ──────────────────────────── */

function _ensureLayoutForAll(containerEls) {
  const fixes = [];
  for (const container of containerEls) {
    let el = container;
    while (el && el !== document.body) {
      const style = getComputedStyle(el);
      if (style.display === 'none' && !fixes.some(f => f.el === el)) {
        const orig = el.style.cssText;
        el.style.cssText += ';display:block!important;visibility:hidden!important;position:absolute!important;pointer-events:none!important;left:0!important;right:0!important;';
        fixes.push({ el, orig });
      }
      el = el.parentElement;
    }
  }
  return fixes;
}

/* ── Prepare every registered panel (mobile only) ──────── */

function prepareAll() {
  const isMobile = Helpers.isNarrowViewport();
  if (!isMobile) return;

  // Gather pending panels (not yet ready, have data + container)
  const pending = [];
  for (const [mode, entry] of _mobilePanels) {
    const panel = _getOrCreatePanel(entry);
    if (panel.isReady()) continue;
    const el = document.getElementById(entry.containerId);
    const rawData = entry.dataSource?.();
    if (el && rawData) pending.push({ mode, entry, el, rawData });
  }
  if (!pending.length) return;

  // Resolve lang once for the whole batch — same source of truth as
  // refreshAll so first-paint and lang-switch produce identical container
  // classes (`.flat-transcript.lang-fa` etc.). Without this, a Persian-
  // original video paints the transcript with .ts-text's default 'Inter'
  // font (loses against the script-specific rule because `.lang-fa` was
  // never on the container at first paint).
  const initLang = AppState.currentLang || AppState.videoData?.lang || 'en';

  // Single layout scope for all containers
  const containers = pending.map(p => p.el);
  const fixes = _ensureLayoutForAll(containers);
  void containers[0].offsetWidth;

  for (const { entry, el, rawData } of pending) {
    applyMobilePanelLangClasses(el, initLang);
    const items = entry.dataBuilder(rawData);
    const panel = _getOrCreatePanel(entry);
    panel.prepare(el, items, { skipLayout: true });
    _markTranscriptPaintedIfTranscriptPanel(entry, items);
    // Create the floating auto-scroll + jump-to-now buttons now, at prep
    // time, so they're present on the initial transcript/subtitles tab
    // render. Previously these were only created inside setMode (tab
    // click handler), so the first-visible tab loaded without its
    // floating buttons until the user tapped a tab — the buttons then
    // appeared on both tabs because setMode ran. Calling the ensure
    // helpers here closes that gap. Both are idempotent — safe to call
    // again from setMode on later tab switches.
    ensureAutoScrollToggle(el, panel);
    if (entry.supportsTimeSync) {
      ensureJumpToNowBtn(el);
    }
  }

  for (const fix of fixes) fix.el.style.cssText = fix.orig;
}

/**
 * Apply rtl/ltr/lang-xx classes to a mobile panel so CSS can flip
 * layout (chip to the right, text right-aligned) and swap in the correct
 * script-specific font.
 */
function applyMobilePanelLangClasses(panel, lang) {
  panel.classList.remove('rtl', 'ltr', 'lang-fa', 'lang-ar', 'lang-he');
  panel.classList.add(Helpers.isRTL(lang) ? 'rtl' : 'ltr');
  setLangClass(panel, lang);
  // Apply correct script font/direction inline on every primary text span.
  // Covers the long tail of supported languages (CJK, Devanagari, etc.) for
  // which there's no per-script CSS rule. The .lang-fa/ar/he classes above
  // remain for layout-related overrides; the font/direction are now
  // canonical per-element via applyLangStyle.
  panel.querySelectorAll('.ts-text').forEach(el => applyLangStyle(el, lang));
}

/**
 * Wait for the script-specific webfont to be loaded before swapping
 * content over to a new language. Returns immediately if already
 * loaded. Without this, switching to Persian/Arabic/Hebrew would
 * paint one frame in the fallback Inter font (FOUT) before the real
 * font arrives — visible flash.
 *
 * Uses CSS Font Loading API (document.fonts.load), supported on all
 * iOS Safari + modern browsers. No-ops if unavailable.
 */
async function _ensureScriptFontLoaded(lang) {
  if (typeof document === 'undefined' || !document.fonts || !document.fonts.load) return;
  let family = null;
  /* Sample text in the script — passed to document.fonts.load() as the
   * second arg so the browser actually downloads the unicode-range
   * subset that contains those glyphs. Google Fonts splits each font
   * into per-script subsets (Latin, Arabic, etc.); calling fonts.load
   * WITHOUT a text sample only fetches the default (Latin) subset, so
   * Persian/Arabic/Hebrew glyphs still arrive on-demand at first paint
   * — the visible "second jump" where the font swaps from system
   * fallback to the real face. With a sample, the right subset is in
   * cache before we render. */
  let sample = null;
  if (lang === 'fa' || lang.startsWith('fa-'))      { family = 'Vazirmatn';          sample = 'سلام جهان'; }
  else if (lang === 'ar' || lang.startsWith('ar-')) { family = 'Noto Sans Arabic';   sample = 'مرحبا بالعالم'; }
  else if (lang === 'he' || lang.startsWith('he-')) { family = 'Noto Sans Hebrew';   sample = 'שלום עולם'; }
  if (!family) return;
  /* Load every weight the transcript uses — `1em <family>` defaults to
   * weight 400, but `.ts-text` is weight 500, `.ts-chip` is 500, entity
   * highlights bump to 600/700. Loading 400 alone leaves the actual
   * rendered weights in fallback on first paint. */
  const specs = [
    `400 1em "${family}"`,
    `500 1em "${family}"`,
    `600 1em "${family}"`,
    `700 1em "${family}"`,
  ];
  try { await Promise.all(specs.map(s => document.fonts.load(s, sample))); }
  catch (_) { /* font load failure shouldn't block render */ }
}

/**
 * Force-rebuild all mobile panels with fresh data. Applies direction/font
 * classes, toggles bilingual state, swaps content atomically.
 *
 * bilingualState: { isBilingual, swapped } — when isBilingual is true,
 * panel items render with primary + original side-by-side.
 *
 * Implementation: panel classes + content swap happen in the SAME
 * synchronous batch, so the browser sees one combined mutation and
 * paints exactly one frame. Earlier versions used a snapshot-overlay
 * crossfade to hide a multi-stage DOM teardown — that produced a
 * visible 5-6-blink sequence on language switch (font flash, content
 * rebuild, class application, layout settle). Replaced by `updateItems`
 * on flat-transcript which mutates row text in place: no teardown,
 * no overlay needed, single repaint.
 */
function refreshAll(bilingualState) {
  const { isBilingual = false, swapped = false } = bilingualState || {};
  _mobileBilingual.active = isBilingual;
  _mobileBilingual.swapped = swapped;
  _refreshAllImpl(isBilingual, swapped);
}
async function _refreshAllImpl(isBilingual, swapped) {
  const isMobile = Helpers.isNarrowViewport();
  if (!isMobile) return;

  const pending = [];
  for (const [mode, entry] of _mobilePanels) {
    const el = document.getElementById(entry.containerId);
    const rawData = entry.dataSource?.();
    if (el && rawData) pending.push({ mode, entry, el, rawData });
  }
  if (!pending.length) return;

  const lang = AppState.currentLang || AppState.videoData?.lang || 'en';
  const videoLang = AppState.videoData?.lang || 'en';

  /* Translation-pending guard. The render pipeline fires _scheduleRender
   * the moment the user picks a new language, BEFORE the translation
   * API has returned. With nothing in the cache, AppState.getContent
   * silently falls back to the original transcript ([state.js:91]) —
   * so this premature render would apply Persian/Arabic/Hebrew lang+RTL
   * classes to STILL-ENGLISH content. The user sees:
   *   1. English content with chip flipped to the right (jump 1)
   *   2. ...then translation arrives, content swaps to Persian (jump 2)
   * Skipping the premature render collapses both into one atomic swap
   * when translation lands. transcriptMap.size is the canonical "ready"
   * signal — it's populated only after the translation API responds. */
  if (lang !== videoLang) {
    const cache = AppState.translationCache?.[lang];
    if (!cache?.transcriptMap?.size) return;
  }

  /* Dedup: translation streaming fires _scheduleRender for every chunk
   * (transcript, title, summary, chapters, formal-summary, etc.) — most
   * of those don't change anything we render here. Re-running classes
   * + updateItems each time triggers DOM mutations that can race with
   * applyFontSizes (called outside, sync, before our async work
   * finishes), leading to the visible "second jump 2 seconds later"
   * the user sees. Cache state per panel; skip if nothing relevant
   * changed since last render. rawData references are stable within
   * a translation cache (state.js:93 caches _rebuiltTranscript), so
   * reference equality is a good signal here. */
  let anyChanged = false;
  for (const p of pending) {
    const last = p.entry._lastRender;
    if (!last
        || last.rawData !== p.rawData
        || last.lang !== lang
        || last.isBilingual !== isBilingual
        || last.swapped !== swapped) {
      anyChanged = true;
      break;
    }
  }
  if (!anyChanged) return;

  /* Preload the script font BEFORE swapping content so the new language
   * paints in the correct font on the first frame. Already-cached fonts
   * resolve synchronously; first-time loads add a few ms but kill the FOUT. */
  await _ensureScriptFontLoaded(lang);

  /* Atomic swap: classes + content in one synchronous batch per panel.
   * Browser sees a single mutation, paints one frame, no flicker.
   *
   * Fast path (panel already prepared, common case): updateItems mutates
   * existing row textContent in place. Wrapper/scroller/event listeners /
   * floating buttons all stay; scroll position preserved.
   *
   * Slow path (first render): full prepare, layout fixes, button setup. */
  for (const { entry, el, rawData } of pending) {
    applyMobilePanelLangClasses(el, lang);
    el.classList.toggle('bilingual-active', isBilingual);
    el.classList.toggle('bilingual-cols-swapped', isBilingual && swapped);

    const items = entry.dataBuilder(rawData);
    const panel = _getOrCreatePanel(entry);

    if (panel.isReady()) {
      panel.updateItems(items);
      _markTranscriptPaintedIfTranscriptPanel(entry, items);
    } else {
      const fixes = _ensureLayoutForAll([el]);
      void el.offsetWidth;
      panel.prepare(el, items, { skipLayout: true });
      _markTranscriptPaintedIfTranscriptPanel(entry, items);
      for (const fix of fixes) fix.el.style.cssText = fix.orig;
      ensureAutoScrollToggle(el, panel);
      if (entry.supportsTimeSync) ensureJumpToNowBtn(el);
    }
  }

  if (_activeMobilePanel && _activeMobilePanel.isReady()) {
    _activeMobilePanel.show();
    const t = AppState.player?.getCurrentTime?.() || 0;
    const entry = _activeMode ? _mobilePanels.get(_activeMode) : null;
    /* Re-center on current time after the swap. Row heights may have
     * shifted slightly (Persian/Arabic/Hebrew often render taller than
     * Latin) so the active row position relative to scrollTop has
     * changed; scrollToTime fixes it. */
    if (entry?.supportsTimeSync) _activeMobilePanel.scrollToTime(t, 'instant');
  }

  /* Store the rendered state per panel so the dedup check at the top
   * of the next call can skip if nothing changed. */
  for (const p of pending) {
    p.entry._lastRender = { rawData: p.rawData, lang, isBilingual, swapped };
  }

  /* Apply font sizes ourselves NOW, after the panel has finished its
   * async work and the new content/classes are live. casual-mode.js
   * calls applyFontSizes immediately after the refresh (sync, unawaited)
   * — which runs BEFORE we resume past the font-load await, so it
   * captures stale fontSize from the OLD lang's content. Calling it
   * here, post-update, captures the correct state. The outer call still
   * happens but is now idempotent on already-correct values. */
  if (typeof window.applyFontSizes === 'function') window.applyFontSizes();
}

// Public window-bridge entry point — `refreshAll` is exported and bound to
// window._refreshMobilePanels from main.js (single bridge surface).
// External callers: casual-mode.js.
export { refreshAll };

/* ── Mobile summary scroller (FlatTranscript-cousin: SummaryNativeScroll)
   ──────────────────────────────────────────────────────
   This is the mobile-only summary surface. Lives outside _mobilePanels
   because it isn't a FlatTranscript (different scroll model — no
   time-sync, no floating buttons) — it's a plain native scroller with
   a mask-image fade. */

let _summaryMobilePanel = null;

function refreshMobileSummary(htmlOverride) {
  const isMobile = Helpers.isNarrowViewport();
  if (!isMobile) return;

  const host = document.getElementById('summaryWheelHost');
  if (!host) return;

  // Apply rtl/ltr/lang-XX classes to the summary-scroll host so the same
  // Persian/Arabic/Hebrew font + RTL CSS rules used by .ss-display panels
  // also match here. Without this, the mobile summary stays LTR + default
  // font even when the video lang is Persian. Mirrors _applyLangClasses
  // in summary-switcher.js.
  const langForSummary = AppState.currentLang || AppState.videoData?.lang || 'en';
  host.classList.remove('rtl', 'ltr', 'lang-fa', 'lang-ar', 'lang-he');
  host.classList.add(Helpers.isRTL(langForSummary) ? 'rtl' : 'ltr');
  setLangClass(host, langForSummary);

  // Prefer the freshly-built HTML passed in (avoids the mid-crossfade
  // stale-panel problem). Fall back to reading whichever A/B panel is active.
  let html = htmlOverride;
  if (!html) {
    const content = window._sss?.getActivePanel() || document.getElementById('summaryDisplayA');
    if (!content) return;
    html = content.innerHTML;
  }
  if (!html || !html.trim()) return;

  if (!_summaryMobilePanel) {
    _summaryMobilePanel = createSummaryNativeScroll();
  }

  if (_summaryMobilePanel.isReady()) {
    _summaryMobilePanel.update(html);
  } else {
    _summaryMobilePanel.prepare(host, html);
  }

  if (_activeMode === 'summary') {
    showMobileSummary();
  }
}

function showMobileSummary() {
  const host = document.getElementById('summaryWheelHost');
  const displayHost = document.getElementById('summaryDisplayHost');
  if (!host || !displayHost) return;

  displayHost.style.display = 'none';
  host.style.display = '';

  if (_summaryMobilePanel && _summaryMobilePanel.isReady()) {
    _summaryMobilePanel.show();
  }
}

function hideMobileSummary() {
  const host = document.getElementById('summaryWheelHost');
  const displayHost = document.getElementById('summaryDisplayHost');

  if (_summaryMobilePanel) _summaryMobilePanel.hide();
  if (host) host.style.display = 'none';
  if (displayHost) displayHost.style.display = '';
}

function _destroyMobileSummary() {
  if (_summaryMobilePanel) {
    _summaryMobilePanel.destroy();
    _summaryMobilePanel = null;
  }
  const host = document.getElementById('summaryWheelHost');
  if (host) host.style.display = 'none';
  const displayHost = document.getElementById('summaryDisplayHost');
  if (displayHost) displayHost.style.display = '';
}

/* ── Destroy everything (call on new video load) ──────── */

function destroyAll() {
  for (const entry of _mobilePanels.values()) {
    if (entry.panel) entry.panel.destroy();
  }
  for (const id of _jumpBtnIntervals) clearInterval(id);
  _jumpBtnIntervals.clear();
  _destroyMobileSummary();
  _activeMobilePanel = null;
  _activeMode = null;
}

/* ── Mode entry/exit (called from core's setMode) ──────── */

/**
 * Show the mobile panel for `mode` (a registered transcript-style mode).
 * Hides any currently active panel first. Idempotent — safe to call
 * repeatedly with the same mode.
 *
 * Returns the panel handle (or null if mode isn't registered).
 */
function showMode(mode) {
  // Hide current panel
  if (_activeMobilePanel) {
    _activeMobilePanel.hide();
    _activeMobilePanel = null;
  }

  // Hide summary scroller when leaving summary tab
  if (_activeMode === 'summary' && mode !== 'summary') {
    hideMobileSummary();
  }
  _activeMode = null;

  const entry = _mobilePanels.get(mode);
  if (!entry) {
    if (mode === 'summary') {
      _activeMode = mode;
      showMobileSummary();
    }
    return null;
  }

  const panel = _getOrCreatePanel(entry);
  _activeMobilePanel = panel;
  _activeMode = mode;

  if (!panel.isReady()) {
    // Panel not prepared yet — prepare on demand
    const el = document.getElementById(entry.containerId);
    const rawData = entry.dataSource?.();
    if (el && rawData) {
      const items = entry.dataBuilder(rawData);
      panel.prepare(el, items);
      _markTranscriptPaintedIfTranscriptPanel(entry, items);
    }
  }

  if (panel.isReady()) {
    panel.show();
    // Skip the mount-time scroll while:
    //   1. rewind is running (the rewind effect scrubs the player to mid-
    //      video positions on every frame; reading getCurrentTime() here
    //      snaps the transcript to whatever the rewind is currently
    //      showing), OR
    //   2. we're in the post-rewind settling window (rewindMode is FALSE
    //      already, but the YT iframe hasn't yet propagated
    //      transitionFromRewind's seekTo(0)+pauseVideo — getCurrentTime()
    //      returns the stale rewind-end position for up to 500ms after
    //      clearRewindMode runs). Without this second guard the panel
    //      visibly jumped to mid-video then jumped back to 0 — root cause
    //      captured in the [SCROLL-TRACE] log session 2026-05-12.
    // Leaving the panel at its natural top position is the right behavior
    // — once playback starts, the normal auto-follow loop (syncActiveToTime)
    // picks up the real player time.
    if (entry.supportsTimeSync && !AppState.rewindMode && !AppState.postRewindSettling) {
      const t = AppState.player?.getCurrentTime?.() || 0;
      panel.scrollToTime(t, 'instant');
      if (panel.getAutoScroll()) {
        panel.scrollToTime(t, true);
      }
    }
  }

  // Floating buttons — generic, no per-mode branching
  const el = document.getElementById(entry.containerId);
  if (el) {
    ensureAutoScrollToggle(el, panel);
    if (entry.supportsTimeSync) {
      ensureJumpToNowBtn(el);
    }
    syncAutoScrollButton(el, panel);
  }

  syncDesktopAutoScrollToggle();
  return panel;
}

/* ── Public API for the Renderer namespace (used by player.js,
       loading-state.js, etc.) ────────────────────────────── */

function syncActiveToTime(seconds) {
  if (!_activeMobilePanel || !_activeMobilePanel.isReady()) return;
  if (AppState.rewindMode) return;
  // Post-rewind 500ms settling window — same rationale as showMode above.
  // getCurrentTime() can still report the stale rewind-end position even
  // after rewindMode is cleared; let the playerState gate below handle the
  // PAUSED case, but explicitly close this window too as defense-in-depth.
  if (AppState.postRewindSettling) return;
  // Only auto-follow when the player is ACTUALLY playing. The seekTo + pause
  // sequence in transitionFromRewind (and any future seek-while-paused path)
  // briefly fires PLAYING → BUFFERING → PAUSED state changes — during the
  // first two of those the YT iframe's getCurrentTime() can still return the
  // pre-seek time, which would scroll the transcript to that stale position.
  // Gating on the steady-state PLAYING (YT.PlayerState.PLAYING === 1) keeps
  // auto-follow tied to actual playback, not transient state flickers.
  const playerState = AppState.player?.getPlayerState?.();
  if (playerState !== 1) return;
  const entry = _activeMode ? _mobilePanels.get(_activeMode) : null;
  if (!entry?.supportsTimeSync) return;
  if (!_activeMobilePanel.getAutoScroll()) return;
  _activeMobilePanel.scrollToTime(seconds + 0.15, true);
}

function toggleActiveAutoScroll() {
  if (!_activeMobilePanel) return null;
  const newVal = !_activeMobilePanel.getAutoScroll();
  _activeMobilePanel.setAutoScroll(newVal);
  syncDesktopAutoScrollToggle();
  const entry = _activeMode ? _mobilePanels.get(_activeMode) : null;
  if (entry) {
    const el = document.getElementById(entry.containerId);
    if (el) syncAutoScrollButton(el, _activeMobilePanel);
  }
  return newVal;
}

export const RendererMobilePanels = {
  register,
  prepareAll,
  refreshAll,
  destroyAll,
  showMode,
  showMobileSummary,
  hideMobileSummary,
  refreshMobileSummary,
  syncActiveToTime,
  toggleActiveAutoScroll,
  syncDesktopAutoScrollToggle,
  getActivePanel,
  getActiveMode,
  setActiveMode,
  getEntry,
  getBilingualState,
};
