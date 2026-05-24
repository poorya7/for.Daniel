/**
 * Chapter Switcher — double-buffer display for chapter header + list.
 *
 * Two permanent .cs-display panels (A/B) stacked in #topicsList host.
 * Each panel contains its own .chapters-header (section label) and
 * .chapters-list, so header + items crossfade together as one unit.
 * Content rendered into standby, crossfade to reveal. Desktop only.
 * renderCurrentState() drives updates via _css.update().
 */

const CHAPTER_FADE_MS = 400;

// `_css` is the public chapter-switcher API. Exported here and bound to
// window._css from main.js (single bridge surface). External callers:
// renderer-chapters.js, renderer.js, casual-mode.js, click-handlers.js.
export const _css = {
  _activeId: 'A',
  _fading: false,

  _getActive() {
    return this._activeId === 'A'
      ? document.getElementById('chapterDisplayA')
      : document.getElementById('chapterDisplayB');
  },

  _getStandby() {
    return this._activeId === 'A'
      ? document.getElementById('chapterDisplayB')
      : document.getElementById('chapterDisplayA');
  },

  /**
   * Public: get the currently visible panel element.
   */
  getActivePanel() {
    return this._getActive();
  },

  /**
   * Build chapter list HTML (items only — goes into .chapters-list).
   */
  _buildListHTML(chapters, lang) {
    return chapters.map((ch, i) =>
      `<div class="chapter-item" data-chapter="${i}">` +
        `<span class="chapter-num">${Helpers.localizeNum(i + 1, lang)}.</span>` +
        `<span class="chapter-name">${Helpers.escapeHtml(ch.title || 'Introduction')}</span>` +
      `</div>`
    ).join('');
  },

  /**
   * Resolve the translated "Chapters" label for a language.
   */
  _getLabelText(lang) {
    if (typeof window.uiString === 'function') {
      return window.uiString('chapters', lang);
    }
    return 'Chapters';
  },

  /**
   * Apply lang/direction classes on a display panel.
   */
  _applyLangClasses(panel, lang) {
    panel.classList.remove('rtl', 'ltr', 'lang-fa', 'lang-ar', 'lang-he');
    const isRTL = typeof Helpers !== 'undefined' && Helpers.isRTL(lang);
    panel.classList.add(isRTL ? 'rtl' : 'ltr');
    if (lang === 'fa' || (lang && lang.startsWith('fa-'))) panel.classList.add('lang-fa');
    else if (lang === 'ar' || (lang && lang.startsWith('ar-'))) panel.classList.add('lang-ar');
    else if (lang === 'he' || (lang && lang.startsWith('he-'))) panel.classList.add('lang-he');
  },

  /**
   * Apply active chapter highlight to a panel.
   */
  _applyActiveState(panel) {
    const idx = (typeof AppState !== 'undefined') ? AppState.activeTopicIdx : -1;
    if (idx == null || idx < 0) return;
    const items = panel.querySelectorAll('.chapter-item');
    items.forEach((c, i) => c.classList.toggle('active', i === idx));
  },

  /**
   * Write header label + list HTML into a panel's child nodes.
   */
  _writePanel(panel, listHTML, labelText) {
    const labelEl = panel.querySelector('.chapters-header .section-label');
    const listEl = panel.querySelector('.chapters-list');
    if (labelEl) labelEl.textContent = labelText;
    if (listEl) listEl.innerHTML = listHTML;
  },

  /**
   * Copy a panel's chapter list innerHTML to mobile #chaptersTabList.
   * Mobile only needs the items (it has no header).
   *
   * @param {HTMLElement} [sourcePanel] - Optional explicit source. Pass
   *   `standby` when calling this BEFORE the fade swap (early-sync path) —
   *   `getActive()` still points at the OLD panel at that point, so without
   *   passing standby explicitly the early sync would copy stale content
   *   and mobile would only update at end-of-fade (the original double-jump
   *   bug). Defaults to the current active panel for the legacy end-of-fade
   *   sync where active has just been swapped to the new content.
   */
  _syncToMobile(sourcePanel) {
    const dest = document.getElementById('chaptersTabList');
    const panel = sourcePanel || this._getActive();
    const src = panel?.querySelector('.chapters-list');
    if (dest && src) dest.innerHTML = src.innerHTML;
  },

  /**
   * Called by renderChaptersPreview(). Renders into standby and crossfades if content changed.
   */
  update(chapters, lang) {
    if (this._fading) return;
    if (!chapters || !chapters.length) return;

    const active = this._getActive();
    const standby = this._getStandby();
    if (!active || !standby) return;

    const newListHTML = this._buildListHTML(chapters, lang);
    const newLabel = this._getLabelText(lang);

    // Compare: both list content and label must match current active
    const activeListEl = active.querySelector('.chapters-list');
    const activeLabelEl = active.querySelector('.chapters-header .section-label');
    const activeListText = activeListEl ? activeListEl.textContent.trim() : '';
    const activeLabelText = activeLabelEl ? activeLabelEl.textContent.trim() : '';

    const tmp = document.createElement('div');
    tmp.innerHTML = newListHTML;
    const newListText = tmp.textContent.trim();

    if (activeListText === newListText && activeLabelText === newLabel) return; // same, skip

    // Resolve display language for RTL/font classes
    const displayLang = (typeof AppState !== 'undefined' && AppState.currentLang)
      || lang || 'en';

    // Render into standby (header + list together)
    this._writePanel(standby, newListHTML, newLabel);
    this._applyLangClasses(standby, displayLang);
    this._applyActiveState(standby);

    // Mobile #chaptersTabList sync — runs the MOMENT new content lands in
    // standby, BEFORE the desktop fade kicks off. Mobile has no fade
    // machinery (it just snap-swaps innerHTML), so without this early sync
    // the mobile list stayed on old content for the full 400ms of the
    // desktop fade while _updateDirection (in casual-mode.js) had already
    // flipped #resultsView to the new RTL/LTR state — producing a visible
    // double-jump on mobile language switch (direction flip first, content
    // swap 400ms later). Doing it here lets mobile get content + direction
    // in the same paint. The end-of-fade sync below is now redundant but
    // kept as a safety net in case standby is mutated mid-fade.
    this._syncToMobile(standby);

    if (!activeListText) {
      // First render — instant, no animation
      this._writePanel(active, newListHTML, newLabel);
      this._applyLangClasses(active, displayLang);
      this._applyActiveState(active);
      this._syncToMobile();
      return;
    }

    // ── Crossfade: fade old out — new is already solid underneath ──
    this._fading = true;

    // Make standby visible immediately (solid, no transition)
    standby.style.opacity = '1';

    // Fade active out on top
    active.style.transition = 'opacity ' + CHAPTER_FADE_MS + 'ms ease-out';
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

      active.classList.remove('cs-display-active');
      active.classList.add('cs-display-standby');
      active.style.pointerEvents = 'none';

      standby.classList.remove('cs-display-standby');
      standby.classList.add('cs-display-active');
      standby.style.pointerEvents = '';

      self._activeId = self._activeId === 'A' ? 'B' : 'A';
      self._fading = false;
      self._syncToMobile();
    };

    active.addEventListener('transitionend', finish, { once: true });
    setTimeout(finish, CHAPTER_FADE_MS + 100); // safety
  },

  /**
   * Tear down — called when loading new video.
   * Restores the default header + empty list scaffolding inside each panel.
   */
  reset() {
    const scaffold = '<div class="chapters-header"><span class="section-label">Chapters</span></div>' +
                     '<div class="chapters-list"></div>';
    const a = document.getElementById('chapterDisplayA');
    const b = document.getElementById('chapterDisplayB');
    if (a) { a.innerHTML = scaffold; a.className = 'cs-display cs-display-active'; a.style.cssText = ''; }
    if (b) { b.innerHTML = scaffold; b.className = 'cs-display cs-display-standby'; b.style.cssText = ''; }
    this._activeId = 'A';
    this._fading = false;
  }
};
