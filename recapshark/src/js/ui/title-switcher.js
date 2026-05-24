/**
 * title-switcher.js — Double-buffer crossfade orchestrator for video title.
 *
 * Two permanent .ts-display panels (A/B) stacked in #titleDisplayHost.
 * Content rendered into standby, crossfade to reveal. No MutationObserver.
 * renderCurrentState() drives updates via _tss.update().
 *
 * Phase 9b (2026-05-07) split helpers out into:
 *   - title-parts.js   — HTML building (parse, count, style, bilingual)
 *   - title-fit.js     — responsive hero font sizing
 *   - title-lang.js    — script + RTL + font class helpers
 *   - title-resolve.js — language-aware HTML resolution
 *
 * This file owns: the `_tss` object (state + lifecycle), `update` /
 * `forceUpdate` orchestration, the crossfade machinery, and the
 * mobile-breakpoint listener.
 *
 * Public surface (window._tss): update / forceUpdate / apply / reset —
 * byte-identical with pre-9b. External callers: casual-mode, title-colors,
 * the breakpoint listener at the bottom of this file.
 */

import { Helpers } from '../core/helpers.js';
import { parseParts, stylePipe, buildDisplayHTML, buildBilingualHTML } from './title-parts.js';
import { fitHero } from './title-fit.js';
import { stripLangClasses, applyLangClasses } from './title-lang.js';
import { resolveHTML, resolveHTMLForLang } from './title-resolve.js';

const TITLE_FADE_MS = 400;

// `_tss` is the public title-switcher API. Exported here and bound to
// window._tss from main.js (single bridge surface). External callers:
// casual-mode.js, title-colors.js, the breakpoint listener at the bottom
// of this file.
export const _tss = {
  current: 0,
  _fading: false,
  _activeId: 'A', // which display is currently visible
  _lockedHeight: 0, // locked after first render — subsequent renders shrink hero to fit

  /**
   * Get the active (visible) display element.
   */
  _getActive() {
    return this._activeId === 'A'
      ? document.getElementById('titleDisplayA')
      : document.getElementById('titleDisplayB');
  },

  /**
   * Get the standby (hidden) display element.
   */
  _getStandby() {
    return this._activeId === 'A'
      ? document.getElementById('titleDisplayB')
      : document.getElementById('titleDisplayA');
  },

  /**
   * Check if we're in bilingual display mode.
   * Reads tState.displayMode via the window bridge (set by casual-mode.js).
   */
  _isBilingual() {
    const mode = window._tssDisplayMode;
    return mode === 'bilingual' || mode === 'bilingual-swapped';
  },

  _isSwapped() {
    return window._tssDisplayMode === 'bilingual-swapped';
  },

  /**
   * Called by renderCurrentState(). Renders title into standby and
   * crossfades if content changed. Does nothing if content hasn't
   * changed or colorization isn't ready.
   */
  update() {
    if (this._fading) return;

    const html = resolveHTML();
    if (!html) return;

    // Defer if container isn't visible yet (results page still hidden) —
    // offsetParent is null inside display:none ancestors; locking height
    // there would collapse the host to 0px. renderMeta() calls us again once visible.
    const _host = document.getElementById('titleDisplayHost');
    if (_host && _host.offsetParent === null && !this._lockedHeight) return;

    const meta = document.querySelector('.video-meta');
    if (!meta) return;

    // Hide raw title data + tags, style meta for display mode
    const titleData = document.getElementById('videoTitleData');
    if (titleData) titleData.style.display = 'none';
    const tagsEl = meta.querySelector('.video-tags');
    if (tagsEl) tagsEl.style.display = 'none';
    meta.style.padding = '0';
    meta.style.background = 'transparent';

    const lang = (typeof AppState !== 'undefined' && AppState.currentLang) || 'en';
    const videoLang = (typeof AppState !== 'undefined' && AppState.videoData?.lang) || 'en';

    let newHTML;
    let renderLang = lang; // language used for direction/font classes on the display
    const channel = (typeof AppState !== 'undefined' && AppState.videoData?.channel) || '';
    const isMobileViewport = Helpers.isNarrowViewport();
    if (this._isBilingual() && lang !== videoLang) {
      // Bilingual: resolve both languages
      const origHTML = resolveHTMLForLang(videoLang);
      if (!origHTML) return; // original colorization not ready yet
      if (isMobileViewport) {
        // Mobile: dual-title side-by-side doesn't fit. Show only lang1
        // (original video language) title; summary/chapters/transcript
        // continue to render bilingually elsewhere.
        const p = parseParts(origHTML);
        newHTML = stylePipe(buildDisplayHTML(p));
        renderLang = videoLang;
      } else {
        newHTML = buildBilingualHTML(html, origHTML, lang, videoLang, this._isSwapped());
      }
    } else {
      // Single language
      const p = parseParts(html);
      newHTML = stylePipe(buildDisplayHTML(p));
    }

    const active = this._getActive();
    const standby = this._getStandby();
    if (!active || !standby) return;

    // Compare against a render key that includes HTML structure (not just text).
    // Plain text → colorized HTML has the same text but different markup — must re-render.
    const newKey = newHTML.length + ':' + newHTML.substring(0, 100);
    if (active.dataset.tsKey === newKey) return;

    const activeText = active.textContent.trim();

    // Render into standby
    standby.innerHTML = newHTML;
    standby.dataset.tsKey = newKey;
    // Bilingual desktop: lang classes are on each .ts1-wrap column, not the display.
    // Bilingual mobile: we rendered a single-column (lang1/videoLang) — apply its classes.
    // Single language: apply current-language classes.
    const bilingualMultiCol = this._isBilingual() && lang !== videoLang && !isMobileViewport;
    if (bilingualMultiCol) stripLangClasses(standby);
    else applyLangClasses(standby, renderLang);

    if (!activeText) {
      // First render — instant, no animation
      active.innerHTML = newHTML;
      active.dataset.tsKey = newKey;
      if (bilingualMultiCol) stripLangClasses(active);
      else applyLangClasses(active, renderLang);
      // Two different sizing strategies by viewport:
      //   DESKTOP: lock host height to first-render natural size. Prevents
      //            layout jumps when user switches language (different
      //            translations have different heights). Deferred until
      //            fonts.ready so the lock captures final-font metrics.
      //   MOBILE:  CSS (.title-display-host flex:1 in title.css) makes the
      //            host fill all available space between the top of
      //            .video-meta and the controls row. fitHero shrinks the
      //            hero to fit that space.
      const host = document.getElementById('titleDisplayHost');
      const isMobile = Helpers.isNarrowViewport();
      // Lock-readiness gate: the desktop _lockedHeight is the title host's
      // final-form height — captured once and reused across language
      // switches. If we lock while .ts1-channel is empty (yt-dlp metadata
      // in flight AND title has no `| Channel` pipe suffix to fall back on),
      // captured height misses ~12px, and when the channel later populates
      // the next render's content overflows → fitHero shrinks the hero from
      // ~32px down to ~20px. Defer the lock until channel is rendered.
      const _channelEl = active.querySelector('.ts1-channel');
      const _lockReady = !!(_channelEl && _channelEl.textContent.trim().length > 0);
      if (host && active.querySelector('.ts1-hero')) {
        const self = this;
        if (!isMobile && !this._lockedHeight && _lockReady) {
          const lockNow = () => {
            if (self._lockedHeight) return;
            self._lockedHeight = Math.max(host.offsetHeight, host.scrollHeight);
            host.style.height = self._lockedHeight + 'px';
            host.style.overflow = 'hidden';
            fitHero(active, self._lockedHeight);
          };
          if (document.fonts && document.fonts.ready) {
            document.fonts.ready.then(lockNow);
          } else {
            lockNow();
          }
        } else if (isMobile) {
          // Fit now with whatever fonts are loaded, then re-fit once web
          // fonts finish loading (hero font may inflate content).
          fitHero(active, this._lockedHeight);
          if (document.fonts && document.fonts.ready) {
            document.fonts.ready.then(() => fitHero(active, self._lockedHeight));
          }
        }
      }
      // Update frame channel label
      const frameLbl = document.getElementById('frameChannelLabel');
      if (frameLbl) frameLbl.textContent = channel;
      this.current = 1;
      return;
    }

    // Late-lock path: first render landed before .ts1-channel was populated
    // (no pipe in title and yt-dlp metadata not in yet), so we deferred the
    // height lock. Now that we're rendering again with the channel in, lock
    // based on standby's natural height — the host doesn't reflect standby's
    // size yet (active is still on top), so use scrollHeight directly. After
    // this, fitHero is a no-op (locked == natural).
    const _standbyChannel = standby.querySelector('.ts1-channel');
    const _standbyChannelReady = !!(_standbyChannel && _standbyChannel.textContent.trim().length > 0);
    if (!Helpers.isNarrowViewport()
        && !this._lockedHeight
        && _standbyChannelReady
        && standby.querySelector('.ts1-hero')) {
      const _host = document.getElementById('titleDisplayHost');
      if (_host) {
        this._lockedHeight = Math.max(standby.scrollHeight, _host.offsetHeight);
        _host.style.height = this._lockedHeight + 'px';
        _host.style.overflow = 'hidden';
      }
    }

    // Shrink hero font if content exceeds locked height
    fitHero(standby, this._lockedHeight);

    // ── Crossfade: only fade old out — new is already solid underneath ──
    this._fading = true;
    this.current = 1;

    // Lock host height during crossfade to prevent layout jump
    const host = document.getElementById('titleDisplayHost');
    if (host) {
      host.style.height = host.offsetHeight + 'px';
      host.style.overflow = 'hidden';
    }

    // Make standby visible immediately (solid, no transition)
    standby.style.opacity = '1';

    // Fade active out on top
    active.style.transition = 'opacity ' + TITLE_FADE_MS + 'ms ease-out';
    void active.offsetHeight;
    active.style.opacity = '0';

    let done = false;
    const self = this;
    const finish = () => {
      if (done) return;
      done = true;

      // Swap roles
      active.style.transition = '';
      standby.style.transition = '';

      active.classList.remove('ts-display-active');
      active.classList.add('ts-display-standby');
      active.style.pointerEvents = 'none';

      standby.classList.remove('ts-display-standby');
      standby.classList.add('ts-display-active');
      standby.style.pointerEvents = '';

      self._activeId = self._activeId === 'A' ? 'B' : 'A';
      self._fading = false;

      // Restore permanent height lock (don't clear it)
      if (host) {
        host.style.height = self._lockedHeight ? self._lockedHeight + 'px' : '';
        host.style.overflow = self._lockedHeight ? 'hidden' : '';
      }
    };

    active.addEventListener('transitionend', finish, { once: true });
    setTimeout(finish, TITLE_FADE_MS + 100); // safety

    // Update frame channel label
    const frameLbl = document.getElementById('frameChannelLabel');
    if (frameLbl) frameLbl.textContent = channel;
  },

  /**
   * Initial setup — called once when video loads.
   */
  apply(n) {
    this.current = n;
    this.update();
  },

  /**
   * Re-render the title bypassing the crossfade machinery. Called when the
   * language switches — the fade path is not safe across rapid language
   * toggles because cancelling an in-flight transition leaves a stale
   * transitionend / safety-timeout that fires later with stale closures
   * and desyncs _activeId from what's visible. Symptoms: title text stuck
   * on previous language, OR text correct but lang-fa/lang-ar class lost
   * (so the per-language font reverts to default). Both come from the
   * fade swap not landing as expected on the second-or-later switch.
   *
   * This path renders the new HTML directly into whichever panel currently
   * carries the .ts-display-active class and re-applies the correct lang
   * classes inline. No fade, no swap, no race. Crossfade is reserved for
   * content updates within a single language (initial colorize landing,
   * formal/casual toggles, etc.) where the fade machinery is reliable.
   */
  forceUpdate() {
    const a = document.getElementById('titleDisplayA');
    const b = document.getElementById('titleDisplayB');
    if (!a || !b) return;

    // Cancel any in-flight fade — clear inline transitions so the safety
    // timeout from a previous update() can't fire stale finish() against
    // closure-captured panels and flip _activeId after we're done here.
    this._fading = false;
    [a, b].forEach(el => {
      el.style.transition = '';
      el.style.opacity = '';
    });

    // Resolve the new HTML (replicates the language/bilingual branching
    // from update() — keep them in sync if either changes).
    const html = resolveHTML();
    if (!html) return;

    const lang = (typeof AppState !== 'undefined' && AppState.currentLang) || 'en';
    const videoLang = (typeof AppState !== 'undefined' && AppState.videoData && AppState.videoData.lang) || 'en';
    const isMobileViewport = Helpers.isNarrowViewport();

    let newHTML;
    let renderLang = lang;
    if (this._isBilingual() && lang !== videoLang) {
      const origHTML = resolveHTMLForLang(videoLang);
      if (!origHTML) return;
      if (isMobileViewport) {
        const p = parseParts(origHTML);
        newHTML = stylePipe(buildDisplayHTML(p));
        renderLang = videoLang;
      } else {
        newHTML = buildBilingualHTML(html, origHTML, lang, videoLang, this._isSwapped());
      }
    } else {
      const p = parseParts(html);
      newHTML = stylePipe(buildDisplayHTML(p));
    }
    const newKey = newHTML.length + ':' + newHTML.substring(0, 100);

    // Sync _activeId to whichever panel actually carries the .ts-display-active
    // class — it's the source of truth for what the user is looking at, and
    // it's robust against the kind of races that can desync the internal flag.
    if (a.classList.contains('ts-display-active')) this._activeId = 'A';
    else if (b.classList.contains('ts-display-active')) this._activeId = 'B';
    const active = this._getActive();
    const standby = this._getStandby();
    if (!active || !standby) return;

    const bilingualMultiCol = this._isBilingual() && lang !== videoLang && !isMobileViewport;

    // Render directly into the active panel. Apply lang classes here so the
    // per-language font (.ts-display.lang-fa .ts1-top, etc.) lands with the
    // content. Standby gets a parallel write so it's ready for the next
    // single-language fade-driven update without flashing stale content.
    [active, standby].forEach(panel => {
      panel.innerHTML = newHTML;
      panel.dataset.tsKey = newKey;
      if (bilingualMultiCol) {
        stripLangClasses(panel);
      } else {
        applyLangClasses(panel, renderLang);
      }
    });

    // Mobile: re-fit hero for the new content (font sizes track viewport).
    if (isMobileViewport && active.querySelector('.ts1-hero')) {
      fitHero(active, this._lockedHeight);
      const self = this;
      if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(() => fitHero(active, self._lockedHeight));
      }
    }

    // Frame channel label sync (mirrors update()'s tail).
    const channel = (typeof AppState !== 'undefined' && AppState.videoData && AppState.videoData.channel) || '';
    const frameLbl = document.getElementById('frameChannelLabel');
    if (frameLbl) frameLbl.textContent = channel;
  },

  /**
   * Tear down — called when loading new video.
   */
  reset() {
    const meta = document.querySelector('.video-meta');
    if (!meta) return;

    const a = document.getElementById('titleDisplayA');
    const b = document.getElementById('titleDisplayB');
    if (a) { a.innerHTML = ''; a.className = 'ts-display ts-display-active'; a.style.cssText = ''; }
    if (b) { b.innerHTML = ''; b.className = 'ts-display ts-display-standby'; b.style.cssText = ''; }
    this._activeId = 'A';
    this._fading = false;
    this._lockedHeight = 0;
    const host = document.getElementById('titleDisplayHost');
    if (host) { host.style.height = ''; host.style.overflow = ''; }

    const tagsEl = meta.querySelector('.video-tags');
    if (tagsEl) tagsEl.style.display = '';
    meta.style.padding = '';
    meta.style.background = '';
    const frameLbl = document.getElementById('frameChannelLabel');
    if (frameLbl) frameLbl.textContent = '';
    this.current = 0;
  }
};

// Re-render title when crossing the mobile breakpoint (rotation, resize).
// matchMedia('change') fires only on boundary crossings, not per-pixel.
// Mobile in dual mode renders single-lang title; desktop renders side-by-side.
(function setupBreakpointListener() {
  if (window._tssBreakpointBound) return;
  window._tssBreakpointBound = true;
  const mql = window.matchMedia(Helpers.NARROW_VIEWPORT_MEDIA);
  const handler = () => {
    if (window._tss && typeof window._tss.update === 'function') {
      window._tss.update();
    }
  };
  if (mql.addEventListener) mql.addEventListener('change', handler);
  else if (mql.addListener) mql.addListener(handler); // legacy Safari
})();
