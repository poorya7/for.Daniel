/**
 * Summary Switcher — double-buffer display for summary panel.
 *
 * Two permanent .ss-display panels (A/B) stacked in #summaryDisplayHost.
 * Content rendered into standby, crossfade to reveal. Matches the
 * title-switcher / chapter-switcher pattern exactly.
 */

const SUMMARY_FADE_MS = 400;

// `_sss` is the public summary-switcher API. Exported here and bound to
// window._sss from main.js (single bridge surface).
export const _sss = {
  _fading: false,
  _activeId: 'A',

  _getActive() {
    return this._activeId === 'A'
      ? document.getElementById('summaryDisplayA')
      : document.getElementById('summaryDisplayB');
  },

  _getStandby() {
    return this._activeId === 'A'
      ? document.getElementById('summaryDisplayB')
      : document.getElementById('summaryDisplayA');
  },

  /**
   * Public accessor — other modules (renderer, casual-mode) use this
   * to read the currently-visible summary panel.
   */
  getActivePanel() {
    return this._getActive();
  },

  /**
   * Apply lang/direction classes on a display element (per-display, not #resultsView).
   */
  _applyLangClasses(displayEl, lang) {
    displayEl.classList.remove('rtl', 'ltr', 'lang-fa', 'lang-ar', 'lang-he');
    const isRTL = typeof Helpers !== 'undefined' && Helpers.isRTL(lang);
    displayEl.classList.add(isRTL ? 'rtl' : 'ltr');
    if (lang === 'fa' || (lang && lang.startsWith('fa-'))) displayEl.classList.add('lang-fa');
    else if (lang === 'ar' || (lang && lang.startsWith('ar-'))) displayEl.classList.add('lang-ar');
    else if (lang === 'he' || (lang && lang.startsWith('he-'))) displayEl.classList.add('lang-he');
  },

  /**
   * Render summary HTML into standby and crossfade if content changed.
   * @param {string} html — full innerHTML for the summary panel
   * @param {string} lang — target language code
   */
  update(html, lang) {
    if (this._fading) return;
    if (!html) return;

    const active = this._getActive();
    const standby = this._getStandby();
    if (!active || !standby) return;

    // Compare text content to skip unnecessary crossfade
    const activeText = active.textContent.trim();
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    const newText = tmp.textContent.trim();

    if (activeText === newText) return; // same content, skip — lang classes apply only with new content

    if (!activeText) {
      // First render — instant, no animation
      active.innerHTML = html;
      this._applyLangClasses(active, lang);
      return;
    }

    // ── Crossfade: fade old out, new is solid underneath ──
    // Container size is stable (flex-fill chain in summary.css), so no height
    // animation is needed — this mirrors chapter-switcher / title-switcher.
    this._fading = true;

    // Render new content into standby (opacity 0, hidden under active)
    standby.innerHTML = html;
    this._applyLangClasses(standby, lang);
    standby.scrollTop = 0; // new content starts at the top

    // Make standby visible immediately (solid, no transition)
    standby.style.opacity = '1';

    // Fade active out on top
    active.style.transition = 'opacity ' + SUMMARY_FADE_MS + 'ms ease-out';
    void active.offsetHeight;
    active.style.opacity = '0';

    let done = false;
    const self = this;
    const finish = () => {
      if (done) return;
      done = true;

      active.style.transition = '';
      standby.style.transition = '';

      active.classList.remove('ss-display-active');
      active.classList.add('ss-display-standby');
      active.style.pointerEvents = 'none';

      standby.classList.remove('ss-display-standby');
      standby.classList.add('ss-display-active');
      standby.style.pointerEvents = '';

      self._activeId = self._activeId === 'A' ? 'B' : 'A';
      self._fading = false;
    };

    active.addEventListener('transitionend', finish, { once: true });
    setTimeout(finish, SUMMARY_FADE_MS + 100); // safety
  },

  /**
   * Tear down — called when loading a new video.
   */
  reset() {
    const a = document.getElementById('summaryDisplayA');
    const b = document.getElementById('summaryDisplayB');
    if (a) { a.innerHTML = ''; a.className = 'ss-display ss-display-active summary-quick-card'; a.style.cssText = ''; }
    if (b) { b.innerHTML = ''; b.className = 'ss-display ss-display-standby summary-quick-card'; b.style.cssText = ''; }
    this._activeId = 'A';
    this._fading = false;
  }
};
