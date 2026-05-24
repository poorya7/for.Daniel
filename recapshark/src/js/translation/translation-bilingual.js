/**
 * Translation Bilingual UI — simplified for data-driven rendering.
 *
 * This module only handles:
 * - Bilingual control buttons (create, show, hide, enable/disable)
 * - Translation progress display
 * - Quality warnings
 * - Chat greeting translation
 * - Utility: remove all bilingual subs, flag lookup
 *
 * All rendering (title, summary, chapters, transcript, bilingual annotations)
 * is handled by renderCurrentState() in casual-mode.js.
 */
import { tState, greetingCache } from './translation-state.js';
import { TranslationLangMeta } from './lang-meta.js';
import { AppState } from '../core/state.js';
import { Helpers } from '../core/helpers.js';
import { RecapSharkAPI } from '../api/client.js';
import { scheduleRender } from '../ui/casual-mode.js';

const { LANG_META } = TranslationLangMeta;

/* ── Helpers ─────────────────────────────────────────── */

function _getLangFlag(langCode) {
  const meta = LANG_META[langCode];
  return meta ? meta.flag : '\u{1F310}';
}

/* ── Update dual-flag button to reflect current column order ── */
function _updateCollapseFlags() {
  const el = document.querySelector('#bilingualCollapseBtn .bilingual-btn-flags');
  if (!el) return;
  const videoLang = AppState.videoData?.lang || 'en';
  const targetLang = (AppState.currentLang && AppState.currentLang !== videoLang)
    ? AppState.currentLang
    : (tState._lastTargetLang || AppState.currentLang || videoLang);
  const swapped = tState.displayMode === 'bilingual-swapped';
  // The mobile bilingual paragraph carries `direction: rtl` when the primary
  // (target) lang is RTL, which physically reverses CSS grid column order.
  // So "swapped" in code != visually swapped: an RTL primary already puts
  // the primary cell on the right, and pressing the swap button moves it
  // back to the left. XOR resolves this — primaryOnLeft is true only when
  // exactly one of {swapped, RTL} is set.
  const isRTL = (typeof Helpers !== 'undefined' && Helpers.isRTL)
    ? Helpers.isRTL(targetLang) : false;
  const primaryOnLeft = swapped === isRTL;  // XNOR: true when both same
  const left = primaryOnLeft ? _getLangFlag(targetLang) : _getLangFlag(videoLang);
  const right = primaryOnLeft ? _getLangFlag(videoLang) : _getLangFlag(targetLang);
  // Skip innerHTML rewrite when content is unchanged. Reassigning innerHTML
  // with identical markup still destroys and recreates DOM nodes, causing a
  // visible flash on emoji glyphs (the "flag blink" during lang switches).
  const next = '<span>' + left + '</span><span>' + right + '</span>';
  if (el.innerHTML !== next) el.innerHTML = next;
}

/* ── Mobile single-button cycle ──────────────────────── */
/* Mobile shows ONE cycling button instead of the desktop's three-button
   bar. Each tap advances to the next mode in the per-tab sequence:
     - transcript / subtitles → original → translated → bilingual →
       bilingual-swapped → original → …  (full 4-mode cycle)
     - chapters / summary     → original → translated → original → …
       (no dual mode — those panels don't render bilingual side-by-side)
   When the user navigates between tabs, the displayMode persists. If
   the new tab's sequence doesn't include the current mode (e.g., was
   in `bilingual` on transcript, now on chapters), indexOf returns -1
   and the next tap snaps back to sequence[0] = 'original'.
   Mode-transition logic mirrors the desktop click handler in
   _createBilingualControls so behavior stays identical there.

   The button graphic always reflects the CURRENT rendered mode for the
   active tab — see _currentTabMode() and the mobile branch of
   _updateSwitchBtn. The cycle progression itself is computed off the
   raw displayMode (not the per-tab effective mode), so taps advance the
   global cycle the same way regardless of which tab the user is on.

   Init special case (tState._freshFromInit): right after the user picks
   lang2 from the panel, the page renders lang2 immediately (matches the
   user's explicit pick) but the cycle is in a "pre-cycle" state. The
   FIRST tap jumps to 'original' (lang1) regardless of the current
   displayMode, giving the user a natural lang1 → lang2 → bilingual →
   bilingual-swapped walkthrough that starts with the source language.
   Without this, the first tap would advance translated → bilingual,
   skipping the lang1 stop. Cleared on first tap. */
function _peekNextMode() {
  const tabMode = _getActiveTabMode();
  const isFourMode = tabMode === 'transcript';
  const sequence = isFourMode
    ? ['original', 'translated', 'bilingual', 'bilingual-swapped']
    : ['original', 'translated'];
  if (tState._freshFromInit) return sequence[0];
  const currentIdx = sequence.indexOf(tState.displayMode);
  const nextIdx = currentIdx === -1 ? 0 : (currentIdx + 1) % sequence.length;
  return sequence[nextIdx];
}

/* Effective mode for the active tab — what's actually rendered. On 4-mode
   tabs this is just the raw displayMode; on 2-mode tabs (chapters /
   summary) the bilingual variants normalize to 'translated' since those
   panels render single-lang translated content for currentLang≠videoLang.
   Drives the mobile button graphic so it always matches what the user
   sees on screen, even when the global displayMode is a value the
   current tab can't render. */
function _currentTabMode() {
  const tabMode = _getActiveTabMode();
  const isFourMode = tabMode === 'transcript';
  if (isFourMode) return tState.displayMode;
  if (tState.displayMode === 'bilingual' || tState.displayMode === 'bilingual-swapped') {
    return 'translated';
  }
  return tState.displayMode;
}

function _cycleMobileMode() {
  const videoLang = AppState.videoData?.lang || 'en';
  const nextMode = _peekNextMode();
  // Clear AFTER peek — first tap consumes the init pointer; subsequent
  // taps follow normal next-in-sequence cycling.
  tState._freshFromInit = false;

  if (nextMode === 'original') {
    if (AppState.currentLang !== videoLang) {
      tState._lastTargetLang = AppState.currentLang;
    }
    AppState.currentLang = videoLang;
    tState.displayMode = 'original';
    delete document.body.dataset.translateLang;
  } else {
    // translated / bilingual / bilingual-swapped — all need targetLang as primary
    const targetLang = tState._lastTargetLang || document.body.dataset.translateLang;
    if (targetLang && targetLang !== videoLang) {
      AppState.currentLang = targetLang;
      document.body.dataset.translateLang = targetLang;
    }
    tState.displayMode = nextMode;
  }

  // Schedule the heavy renderCurrentState work for the next animation frame
  // instead of running it synchronously inside the click handler. The handler
  // returns immediately → browser paints the click-feedback frame → next
  // frame, all panels rebuild. Without this, the title/summary/chapters
  // innerHTML rebuilds (~300ms total for a 10-min video) block the first
  // paint, so the user perceives ~half a second of "frozen" before any
  // visual change. _scheduleRender uses rAF + a re-entry guard, so multiple
  // rapid taps coalesce into one render. */
  scheduleRender();
  _updateCollapseFlags();
  _updateSwitchBtn();
}

/* ── Remove all bilingual sub elements ───────────────── */

export function _removeAllSubs() {
  document.querySelectorAll('.bilingual-sub').forEach(el => el.remove());
}

/* ── Bilingual controls ──────────────────────────────── */

export function _createBilingualControls() {
  const wrap = document.createElement('div');
  wrap.className = 'bilingual-controls';
  wrap.id = 'bilingualControls';
  wrap.innerHTML =
    '<button class="lang-flag-btn" id="bilingualLangVideo">' + _getLangFlag(AppState.videoData?.lang || 'en') + '</button>' +
    '<button class="lang-flag-btn" id="bilingualLangTarget">' + _getLangFlag(AppState.currentLang || 'en') + '</button>' +
    '<span class="bilingual-progress" id="bilingualProgress"></span>' +
    '<button class="lang-collapse-btn" id="bilingualCollapseBtn" title="Toggle translations">' +
      '<span class="bilingual-btn-flags">' +
        '<span>' + _getLangFlag(AppState.videoData?.lang || 'en') + '</span>' +
        '<span>' + _getLangFlag(AppState.currentLang || 'en') + '</span>' +
      '</span>' +
    '</button>';

  wrap.addEventListener('click', function(e) {
    // Mobile gets a SINGLE cycle button (the other two are CSS-hidden in
    // #mobileFloatingFlags). Any click on the visible flag button advances
    // through the per-tab mode sequence — see _cycleMobileMode below.
    const isMobile = Helpers.isNarrowViewport();
    if (isMobile && e.target.closest('.lang-flag-btn, .lang-collapse-btn')) {
      _cycleMobileMode();
      return;
    }
    // Flag button: switch to that language as primary
    const flagBtn = e.target.closest('.lang-flag-btn');
    if (flagBtn) {
      const videoLang = AppState.videoData?.lang || 'en';

      // No-op guard: clicking the already-active flag should do nothing.
      // Without this, _renderCurrentState() runs and triggers a full rebuild
      // (including the mobile wheel crossfade), which the user perceives as
      // a "reload" of the panel.
      const isBilingual = tState.displayMode === 'bilingual'
        || tState.displayMode === 'bilingual-swapped';
      if (flagBtn.id === 'bilingualLangVideo'
          && tState.displayMode === 'original') return;
      if (flagBtn.id === 'bilingualLangTarget'
          && tState.displayMode !== 'original' && !isBilingual) return;

      if (flagBtn.id === 'bilingualLangVideo') {
        // Clicked original language flag → show original, keep controls visible
        // Store the target lang so we can switch back (only if currently on a translated lang)
        if (AppState.currentLang !== videoLang) {
          tState._lastTargetLang = AppState.currentLang;
        }
        AppState.currentLang = videoLang;
        tState.displayMode = 'original';
        delete document.body.dataset.translateLang;
      } else if (flagBtn.id === 'bilingualLangTarget') {
        // Clicked translated language flag → switch back to translated
        const targetLang = tState._lastTargetLang || document.body.dataset.translateLang;
        if (targetLang && targetLang !== videoLang) {
          AppState.currentLang = targetLang;
          document.body.dataset.translateLang = targetLang;
        }
        tState.displayMode = 'translated';
      }
      // Schedule the heavy renderCurrentState work for the next animation frame
  // instead of running it synchronously inside the click handler. The handler
  // returns immediately → browser paints the click-feedback frame → next
  // frame, all panels rebuild and crossfade. Without this, the title/summary/
  // chapters innerHTML rebuilds (~300ms total for a 10-min video) block the
  // first paint, so the user perceives ~half a second of "frozen" before any
  // visual change. _scheduleRender uses rAF + a re-entry guard, so multiple
  // rapid taps coalesce into one render. */
  scheduleRender();
      _updateSwitchBtn();
      return;
    }

    // Collapse button: swap bilingual sides (never turns off — use flags to exit)
    const collapseBtn = e.target.closest('.lang-collapse-btn');
    if (collapseBtn) {
      const videoLang = AppState.videoData?.lang || 'en';
      // If currently on original, restore the translated language first
      if (tState.displayMode === 'original' || AppState.currentLang === videoLang) {
        const targetLang = tState._lastTargetLang || document.body.dataset.translateLang;
        if (targetLang && targetLang !== videoLang) {
          AppState.currentLang = targetLang;
          document.body.dataset.translateLang = targetLang;
        }
      }
      tState.displayMode = tState.displayMode === 'bilingual' ? 'bilingual-swapped' : 'bilingual';
      _updateCollapseFlags();
      _updateSwitchBtn();
      scheduleRender();
    }
  });

  return wrap;
}

export function _showBilingualControls() {
  if (!tState.bilingualControls) return;
  tState.bilingualControls.classList.add('visible');
  // Mobile: hide the whole bar until the FIRST translation section completes
  // (summary, chapters, or transcript — whichever wins). _markSectionReady()
  // strips this class on first completion. Desktop ignores .hide-pre-ready
  // (CSS rule is mobile-only).
  tState.bilingualControls.classList.add('hide-pre-ready');
  const langBar = document.getElementById('langBar');
  if (langBar) langBar.classList.add('visible');
  _setBilingualEnabled(false);
  // Sync the collapse-btn availability to whichever tab is active right now,
  // so it appears correctly disabled on first show (not just on subsequent
  // tab switches via setMode).
  const activePane = document.querySelector('.tab-pane.active');
  const mode = activePane ? activePane.id.replace('tab-', '') : '';
  _updateCollapseBtnAvailability(mode);
}

export function _hideBilingualControls() {
  if (!tState.bilingualControls) return;
  tState.bilingualControls.classList.remove('visible');
  const langBar = document.getElementById('langBar');
  if (langBar) langBar.classList.remove('visible');
}

export function _setBilingualEnabled(enabled) {
  const videoBtn = document.getElementById('bilingualLangVideo');
  const targetBtn = document.getElementById('bilingualLangTarget');
  const collapseBtn = document.getElementById('bilingualCollapseBtn');
  [videoBtn, targetBtn, collapseBtn].forEach(btn => {
    if (!btn) return;
    btn.disabled = !enabled;
    btn.style.opacity = enabled ? '' : '0.4';
    btn.style.pointerEvents = enabled ? '' : 'none';
  });
  // Collapse button always full opacity when enabled (it swaps sides, never turns off)
  if (enabled && collapseBtn) {
    collapseBtn.style.opacity = '';
  }
  // .pending = disabled visual state (greyed buttons + pointer-events:none).
  // Used for both desktop (always visible, just disabled) and mobile (visible-
  // but-disabled state that appears when the user navigates to a tab whose
  // content isn't translated yet, while OTHER tabs already are). Mobile-hide
  // is now controlled separately by .hide-pre-ready (only present until the
  // first section completes).
  if (tState.bilingualControls) {
    tState.bilingualControls.classList.toggle('pending', !enabled);
  }
}

/**
 * Look up which tab is active right now. Pattern matches _showBilingualControls
 * — `.tab-pane.active` has id `tab-<mode>` (e.g., `tab-transcript`).
 * Returns the mode string or '' if nothing is active.
 *
 * NOTE: callers that already have the mode in hand (e.g., the renderer's
 * setMode hook receives `mode` as an argument) should pass it explicitly to
 * _evalPendingForCurrentTab() instead — this DOM lookup only works for tabs
 * that mount a real .tab-pane (mobile summary uses a separate cylinder
 * widget and has no .tab-pane.active, which would otherwise return '').
 */
function _getActiveTabMode() {
  const activePane = document.querySelector('.tab-pane.active');
  return activePane ? activePane.id.replace('tab-', '') : '';
}

/**
 * Check whether the active translation TARGET language has the cache
 * slice required for the given tab. Returns true once that tab's
 * content is ready; false otherwise. Bookmarks isn't translation-gated,
 * so it's always true.
 *
 * NOTE: we deliberately resolve the translation TARGET, not
 * AppState.currentLang. Clicking the video-lang flag swaps currentLang
 * back to the source (e.g., 'en') so the user sees the original — but
 * the bar must STAY enabled at that point (so they can click back to
 * translated). The target is preserved across that swap in
 * tState._lastTargetLang; fall back to currentLang only when it
 * differs from the source.
 */
function _isTabContentReady(tabMode) {
  const videoLang = (AppState.videoData && AppState.videoData.lang) || 'en';
  const targetLang = tState._lastTargetLang
    || (AppState.currentLang && AppState.currentLang !== videoLang ? AppState.currentLang : null);
  const cache = targetLang ? AppState.translationCache[targetLang] : null;
  if (!cache) return false;
  switch (tabMode) {
    case 'summary':    return !!cache.summary;
    case 'chapters':   return !!(cache.chapters && cache.chapters.length);
    case 'transcript': return !!(cache.transcriptMap && cache.transcriptMap.size > 0);
    case 'bookmarks':  return true;
    default:           return false;
  }
}

/**
 * Re-evaluate the .pending state based on the currently-active tab. Called:
 *   - after each translation section completes (in case the active tab is
 *     the one that just got its content),
 *   - after a tab switch (so the user sees the right enabled/disabled state
 *     for the tab they just landed on).
 *
 * @param {string} [tabMode] - Optional explicit mode. Callers that already
 *   know the mode (e.g., the renderer's setMode hook) should pass it —
 *   relying on the DOM fallback breaks on mobile summary, which uses a
 *   cylinder widget and has no .tab-pane.active.
 *
 * No-op if the bilingual bar isn't mounted or not visible.
 */
export function _evalPendingForCurrentTab(tabMode) {
  if (!tState.bilingualControls) return;
  if (!tState.bilingualControls.classList.contains('visible')) return;
  const mode = tabMode || _getActiveTabMode();
  const ready = _isTabContentReady(mode);
  _setBilingualEnabled(ready);
  // _setBilingualEnabled toggles ALL three buttons (incl. collapse). On
  // chapters/summary the collapse btn must stay disabled regardless of
  // content readiness (those tabs don't support side-by-side bilingual
  // mode). Re-apply the per-tab collapse rule AFTER the global enable so
  // the tab-specific override wins.
  _updateCollapseBtnAvailability(mode);
  // Refresh the mobile cycle button so its graphic matches the active
  // tab's effective rendered mode (see _currentTabMode). Without this,
  // switching transcript(bilingual) → chapters would leave the button
  // frozen on the dual-flag graphic even though chapters renders only
  // single translated content; the effective-mode mapping handles that.
  _updateSwitchBtn();
}

/**
 * Mark a translation section as completed. First completion strips the
 * mobile-only .hide-pre-ready class (the whole bar appears). Every call
 * also re-evaluates .pending for the active tab so the user sees the
 * correct enabled/disabled state immediately.
 *
 * @param {'summary'|'chapters'|'transcript'} _sectionKey - informational;
 *   the helper relies on the underlying cache, not on this argument
 */
export function _markSectionReady(_sectionKey) {
  if (!tState.bilingualControls) return;
  tState.bilingualControls.classList.remove('hide-pre-ready');
  _evalPendingForCurrentTab();
}

/**
 * Mobile-only: enable the 3rd (bilingual collapse) button only on the
 * transcript tab. Bilingual mode in chapters/summary still works if
 * previously enabled — this just prevents toggling from those tabs (where
 * the side-by-side layout is less useful).
 *
 * Independent from `_setBilingualEnabled` (which gates ALL 3 buttons during
 * translation in-flight). Call after every tab switch.
 *
 * @param {string} tabMode - 'transcript' | 'chapters' | 'summary' | 'bookmarks'
 */
export function _updateCollapseBtnAvailability(tabMode) {
  const collapseBtn = document.getElementById('bilingualCollapseBtn');
  if (!collapseBtn) return;
  const isMobile = Helpers.isNarrowViewport();
  if (!isMobile) {
    collapseBtn.disabled = false;
    collapseBtn.style.pointerEvents = '';
    collapseBtn.style.opacity = '';
    return;
  }
  const allowed = tabMode === 'transcript';
  collapseBtn.disabled = !allowed;
  collapseBtn.style.pointerEvents = allowed ? '' : 'none';
  collapseBtn.style.opacity = allowed ? '' : '0.35';
}

export function _updateSwitchBtn() {
  const videoBtn = document.getElementById('bilingualLangVideo');
  const targetBtn = document.getElementById('bilingualLangTarget');
  if (!videoBtn || !targetBtn) return;

  const videoLang = AppState.videoData?.lang || 'en';
  const targetLang = (AppState.currentLang && AppState.currentLang !== videoLang)
    ? AppState.currentLang
    : (tState._lastTargetLang || AppState.currentLang || videoLang);

  const videoFlag = _getLangFlag(videoLang);
  const targetFlag = _getLangFlag(targetLang);
  const mode = tState.displayMode;
  const isBilingual = mode === 'bilingual' || mode === 'bilingual-swapped';
  const isOriginal = mode === 'original';

  // ── Mobile: single cycle button ──
  // The other two buttons are CSS-hidden in #mobileFloatingFlags, so this
  // is the only flag the user sees. Its graphic shows the CURRENT rendered
  // mode for the active tab — i.e. what the user is seeing right now —
  // not where the next tap will go. This matches the dominant convention
  // for language flags across web/mobile UIs (Google, YouTube, etc.) and
  // matches what the rest of the page already shows.
  //
  // _currentTabMode() handles the 4-mode-vs-2-mode normalization: on
  // chapters / summary, bilingual variants collapse to 'translated' since
  // those panels render single-lang translated content. Without that,
  // switching transcript(bilingual)→summary would leave the button on the
  // dual-flag graphic while summary actually shows single-Persian.
  const isMobile = Helpers.isNarrowViewport();
  if (isMobile) {
    const currentMode = _currentTabMode();
    const isBilingualEff = currentMode === 'bilingual' || currentMode === 'bilingual-swapped';
    if (isBilingualEff) {
      // Reuse the same RTL-aware column-order math as _updateCollapseFlags
      // so the inline mobile graphic matches the actual rendered layout.
      const swapped = currentMode === 'bilingual-swapped';
      const isRTL = (typeof Helpers !== 'undefined' && Helpers.isRTL)
        ? Helpers.isRTL(targetLang) : false;
      const primaryOnLeft = swapped === isRTL;  // XNOR — see _updateCollapseFlags
      // Position, z-index and rotation are all slot-based (first-child =
      // top-left/front/−3°, nth-child(2) = bottom-right/back/+3°), so the
      // two cycle modes are exact mirrors regardless of which language
      // sits in each slot.
      const leftLang = primaryOnLeft ? targetLang : videoLang;
      const rightLang = primaryOnLeft ? videoLang : targetLang;
      const left = _getLangFlag(leftLang);
      const right = _getLangFlag(rightLang);
      const dualHTML = '<span class="bilingual-btn-flags">'
        + '<span>' + left + '</span>'
        + '<span>' + right + '</span>'
        + '</span>';
      videoBtn.classList.add('has-dual-flags');
      if (videoBtn.innerHTML !== dualHTML) videoBtn.innerHTML = dualHTML;
    } else {
      videoBtn.classList.remove('has-dual-flags');
      const flag = currentMode === 'translated' ? targetFlag : videoFlag;
      if (videoBtn.innerHTML !== flag) videoBtn.innerHTML = flag;
    }
    // No active/inactive state on mobile — there's only one button.
    // Strip any leftover .lang-btn-active that may have been applied
    // from a previous render or viewport-resize-from-desktop.
    videoBtn.classList.remove('lang-btn-active');
    return;
  }

  // ── Desktop: original 3-button bar ──
  // Skip innerHTML rewrite when content is unchanged. Reassigning innerHTML
  // with identical markup still destroys and recreates DOM nodes, causing a
  // visible flash on emoji glyphs (the "flag blink" during lang switches).
  if (videoBtn.innerHTML !== videoFlag) videoBtn.innerHTML = videoFlag;
  if (targetBtn.innerHTML !== targetFlag) targetBtn.innerHTML = targetFlag;

  _updateCollapseFlags();

  // Active state: exactly one of the 3 buttons is active
  const collapseBtn = document.getElementById('bilingualCollapseBtn');
  videoBtn.classList.toggle('lang-btn-active', isOriginal);
  targetBtn.classList.toggle('lang-btn-active', !isOriginal && !isBilingual);
  if (collapseBtn) collapseBtn.classList.toggle('lang-btn-active', isBilingual);
  // Strip the mobile-only marker class in case the viewport was just resized
  // from mobile to desktop — leftover .has-dual-flags would otherwise force
  // the dual graphic on the desktop videoBtn.
  videoBtn.classList.remove('has-dual-flags');
}

export function _updateToggleLabel(langCode) {
  // No-op: globe button stays as globe always
}

/* ── Progress display ────────────────────────────────── */

export function _showTranslateProgress(pct) {
  const el = document.getElementById('bilingualProgress');
  if (!el) return;
  el.textContent = pct + '%';
  el.style.display = '';
}

export function _hideTranslateProgress() {
  const el = document.getElementById('bilingualProgress');
  if (!el) return;
  el.textContent = '';
  el.style.display = 'none';
}

/* ── Quality warning ─────────────────────────────────── */

export function _showQualityWarning(langLabel) {
  const existing = document.getElementById('translationQualityWarning');
  if (existing) existing.remove();

  const banner = document.createElement('div');
  banner.id = 'translationQualityWarning';
  banner.className = 'translation-quality-warning';
  banner.innerHTML =
    '<span>Translation quality for ' + langLabel + ' may be limited. ' +
    'Some sections might contain inaccuracies or repetitions.</span>' +
    '<button onclick="this.parentElement.remove()">&times;</button>';

  const summaryContent = window._sss?.getActivePanel() || document.getElementById('summaryDisplayA');
  if (summaryContent) summaryContent.prepend(banner);
}

export function _hideQualityWarning() {
  const el = document.getElementById('translationQualityWarning');
  if (el) el.remove();
}

/* ── Cap-hit info notice ─────────────────────────────────
 * Shown when the backend returns a translate cap-hit (HTTP 429 with
 * error_code=global_daily_cap_hit / per_ip_daily_cap_hit). Informational
 * tone — not a warning — so styling is calm/blue, not yellow/red. */

export function _showCapHitNotice(message) {
  const existing = document.getElementById('translationCapNotice');
  if (existing) existing.remove();

  const banner = document.createElement('div');
  banner.id = 'translationCapNotice';
  banner.className = 'translation-info-notice';
  banner.innerHTML =
    '<span>' + (message || 'Daily translation limit reached for today. Try again tomorrow.') + '</span>' +
    '<button onclick="this.parentElement.remove()">&times;</button>';

  const summaryContent = window._sss?.getActivePanel() || document.getElementById('summaryDisplayA');
  if (summaryContent) summaryContent.prepend(banner);
}

export function _hideCapHitNotice() {
  const el = document.getElementById('translationCapNotice');
  if (el) el.remove();
}

/* ── Chat greeting translation ───────────────────────── */

export function _precacheGreeting(targetLang) {
  if (targetLang === 'en' || greetingCache[targetLang]) return;
  // Static UI_STRINGS lookup — no API round-trip needed. The greeting cache
  // entry stays around for backward compat with the rest of the bilingual
  // module, but it's now populated instantly instead of after a translateSummary
  // call (~1-3s) the first time a language is hit.
  greetingCache[targetLang] = Helpers.chatGreeting(targetLang);
}

/**
 * Apply per-bubble direction / text-align / font-family inline so the bubble
 * doesn't depend on the global #resultsView.rtl cascade (which can flip on
 * a different timeline than the text swap and cause a visible jump).
 * Inline styles beat class-based CSS, so this wins regardless of when the
 * global direction update fires.
 */
export function _applyBubbleDirection(bubble, lang) {
  if (!bubble) return;
  const isRTL = Helpers.isRTL(lang);
  const base = (lang || '').split('-')[0];

  // Toggle per-display lang/dir classes on the bubble. CSS rules (.gb-display.lang-fa,
  // .gb-display.rtl, etc.) scope styling per-bubble — body[data-translate-lang]
  // CSS no longer hijacks the active bubble during a lang switch (those rules now
  // exclude .gb-display via :not(.gb-display)). Mirrors chapters' .cs-display.lang-fa pattern.
  bubble.classList.remove('lang-fa', 'lang-ar', 'lang-he', 'rtl', 'ltr');
  bubble.classList.add(isRTL ? 'rtl' : 'ltr');
  if (base === 'fa' || base === 'ar' || base === 'he') {
    bubble.classList.add('lang-' + base);
  }
  // Default font (Poppins for default theme, JetBrains Mono for brutalist) is
  // covered by base .chat-bubble / .theme-brutalist .chat-bubble rules — no
  // explicit lang-en class needed since the absence of lang-fa/ar/he means default.
}

// _applyBubbleDirection / _updateCollapseBtnAvailability /
// _evalPendingForCurrentTab / _markSectionReady are exported above; main.js
// binds them to window._* names (single bridge surface). Used by chat.js
// initial render so the active bubble gets inline lang styles from the very
// first paint (not just after the first crossfade).

const GREETING_FADE_MS = 400;

/**
 * Greeting Bubble Switcher — double-buffer display for the AI greeting bubble.
 *
 * Two permanent .gb-display panels (A/B) grid-stacked inside #greetingBubbleHost
 * (see chat.js reset()). Content rendered into standby, crossfade to reveal.
 * Mirrors the chapter-switcher / summary-switcher pattern — same pure opacity
 * fade, no ghost-clone tricks. Host sizes to max(active, standby) naturally.
 */
export const _gbs = {
  _activeId: 'A',
  _fading: false,

  _getActive() {
    return this._activeId === 'A'
      ? document.getElementById('greetingBubbleA')
      : document.getElementById('greetingBubbleB');
  },

  _getStandby() {
    return this._activeId === 'A'
      ? document.getElementById('greetingBubbleB')
      : document.getElementById('greetingBubbleA');
  },

  getActivePanel() { return this._getActive(); },

  /**
   * Render greeting HTML into standby and crossfade if content changed.
   * @param {string} newHTML — full innerHTML for the bubble (incl. .bubble-label)
   * @param {string} lang — target language code
   */
  update(newHTML, lang) {
    if (this._fading) return;
    const active = this._getActive();
    const standby = this._getStandby();
    if (!active || !standby) return;

    if (active.dataset.greetingLang === lang) return; // already correct — skip

    // First apply (page load or after reset): no animation, just set state.
    if (!active.dataset.greetingLang) {
      active.innerHTML = newHTML;
      _applyBubbleDirection(active, lang);
      active.dataset.greetingLang = lang;
      return;
    }

    // Render new content into standby (currently hidden at opacity 0).
    standby.innerHTML = newHTML;
    _applyBubbleDirection(standby, lang);
    standby.dataset.greetingLang = lang;

    // ── Crossfade: fade old out — new is already solid underneath ──
    this._fading = true;

    // Make standby visible immediately (solid, no transition).
    standby.style.opacity = '1';

    // Fade active out on top.
    active.style.transition = 'opacity ' + GREETING_FADE_MS + 'ms ease-out';
    void active.offsetHeight;
    active.style.opacity = '0';

    const self = this;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;

      active.style.transition = '';
      standby.style.transition = '';

      active.classList.remove('gb-display-active');
      active.classList.add('gb-display-standby');
      active.style.pointerEvents = 'none';

      standby.classList.remove('gb-display-standby');
      standby.classList.add('gb-display-active');
      standby.style.pointerEvents = '';

      self._activeId = self._activeId === 'A' ? 'B' : 'A';
      self._fading = false;
    };

    active.addEventListener('transitionend', finish, { once: true });
    setTimeout(finish, GREETING_FADE_MS + 100); // safety
  },

  /**
   * Tear down — called from chat.js reset() when loading a new video.
   */
  reset() {
    const a = document.getElementById('greetingBubbleA');
    const b = document.getElementById('greetingBubbleB');
    if (a) {
      a.innerHTML = '';
      a.className = 'chat-bubble bubble-ai gb-display gb-display-active';
      a.style.cssText = '';
      delete a.dataset.greetingLang;
    }
    if (b) {
      b.innerHTML = '';
      b.className = 'chat-bubble bubble-ai gb-display gb-display-standby';
      b.style.cssText = '';
      delete b.dataset.greetingLang;
    }
    this._activeId = 'A';
    this._fading = false;
  },
};

// `_gbs` is exported above and bound to window._gbs from main.js
// (single bridge surface). Used by chat.js + app.js for reset / update.

export function _translateChatGreeting(targetLang) {
  const label = '<div class="bubble-label"><img src="' + window.RS_ASSETS.sharky + '" alt="" class="label-shark"> RecapShark.com</div>';
  // Static UI_STRINGS lookup — Helpers.chatGreeting(lang) returns the
  // pre-translated greeting instantly. Was an async translateSummary API
  // round-trip per language switch; now instant for all 105 supported langs.
  const localized = Helpers.chatGreeting(targetLang);
  _gbs.update(label + Helpers.escapeHtml(localized), targetLang);
}
