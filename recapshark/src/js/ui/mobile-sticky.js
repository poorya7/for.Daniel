/**
 * Mobile sticky offsets: set `top` values so the tab bar, transcript search
 * row, and lang bar stack flush below the sticky nav.
 * CSS handles `position: sticky`; this JS only calculates stacking heights.
 * Only active when viewport width <= 900px.
 *
 * Module shape: IIFE-with-return that captures the public `updateOffsets`
 * function as a module export. main.js binds it to window._mobileUpdateOffsets
 * (single bridge surface) — IIFE pattern preserved per architectural rule.
 */
import { Helpers } from '../core/helpers.js';

export const updateOffsets = (function () {
  const MQ = window.matchMedia(Helpers.NARROW_VIEWPORT_MEDIA);

  var _scrubberOrigParent = null;
  var _scrubberOrigNext = null;
  var _searchOrigParent = null;
  var _searchOrigNext = null;
  var _transportOrigParent = null;
  var _transportOrigNext = null;
  var _ccOrigParent = null;
  var _ccOrigNext = null;
  var _themeOrigParent = null;
  var _themeOrigNext = null;

  function moveSearchForMobile() {
    var search = document.getElementById('transcriptSearchSection');
    var tabBar = document.querySelector('.tab-bar');
    if (!search || !tabBar) return;

    if (MQ.matches) {
      if (!_searchOrigParent) {
        _searchOrigParent = search.parentNode;
        _searchOrigNext = search.nextSibling;
      }
      tabBar.insertAdjacentElement('afterend', search);
    } else if (_searchOrigParent) {
      _searchOrigParent.insertBefore(search, _searchOrigNext);
      _searchOrigParent = null;
      _searchOrigNext = null;
    }
  }

  function moveTransportForMobile() {
    var transport = document.querySelector('.mech-transport');
    var ccWrap = document.querySelector('.mech-cc-wrap');
    var videoMeta = document.querySelector('.video-meta');
    var videoEmbed = document.querySelector('.video-embed');
    if (!transport || !videoMeta) return;

    if (MQ.matches) {
      if (!_transportOrigParent) {
        _transportOrigParent = transport.parentNode;
        _transportOrigNext = transport.nextSibling;
      }
      if (ccWrap && !_ccOrigParent) {
        _ccOrigParent = ccWrap.parentNode;
        _ccOrigNext = ccWrap.nextSibling;
      }
      var row = videoMeta.querySelector('.mobile-controls-row');
      if (!row) {
        row = document.createElement('div');
        row.className = 'mobile-controls-row';
        videoMeta.appendChild(row);
      }
      // CC button goes to the top-right of the video frame, not the controls row.
      if (ccWrap && videoEmbed) videoEmbed.appendChild(ccWrap);
      row.appendChild(transport);
    } else {
      if (_transportOrigParent) {
        _transportOrigParent.insertBefore(transport, _transportOrigNext);
        _transportOrigParent = null;
        _transportOrigNext = null;
      }
      if (_ccOrigParent && ccWrap) {
        _ccOrigParent.insertBefore(ccWrap, _ccOrigNext);
        _ccOrigParent = null;
        _ccOrigNext = null;
      }
      var row = videoMeta ? videoMeta.querySelector('.mobile-controls-row') : null;
      if (row) row.remove();
    }
  }

  function moveThemeForMobile() {
    var theme = document.querySelector('.nw-style-group');
    var channelLabel = document.getElementById('frameChannelLabel');
    if (!theme || !channelLabel) return;

    if (MQ.matches) {
      if (!_themeOrigParent) {
        _themeOrigParent = theme.parentNode;
        _themeOrigNext = theme.nextSibling;
      }
      channelLabel.insertAdjacentElement('afterend', theme);
    } else if (_themeOrigParent) {
      _themeOrigParent.insertBefore(theme, _themeOrigNext);
      _themeOrigParent = null;
      _themeOrigNext = null;
    }
  }

  function moveScrubberForMobile() {
    var scrubber = document.getElementById('videoScrubber');
    var block = document.querySelector('.video-block');
    if (!scrubber || !block) return;

    if (MQ.matches) {
      if (scrubber.parentNode === block || !_scrubberOrigParent) {
        if (!_scrubberOrigParent) {
          _scrubberOrigParent = scrubber.parentNode;
          _scrubberOrigNext = scrubber.nextSibling;
        }
        block.insertAdjacentElement('afterend', scrubber);
      }
    } else if (_scrubberOrigParent) {
      _scrubberOrigParent.insertBefore(scrubber, _scrubberOrigNext);
      _scrubberOrigParent = null;
      _scrubberOrigNext = null;
    }
  }

  function updateOffsets() {
    if (!MQ.matches) return;

    /*
     * Mobile no longer uses document-level scroll. The header stack
     * (nav + now-watching-bar + video + tab-bar) is pinned naturally by
     * the bounded flex chain inside #resultsView. The legacy approach of
     * setting position-sticky `top:` offsets via JS is now actively
     * HARMFUL: with `position: sticky` in a non-scrolling parent, an inline
     * `top: 44px` pushes the element 44px down from its normal flow
     * position, leaving a visible gap.
     *
     * So the new behavior of updateOffsets() is simply: clear any inline
     * `top` values that the legacy machinery (or any of the callers below)
     * may have set. Existing call sites continue to work — they just become
     * no-ops in the bounded-flex model.
     */
    clearOffsets();
  }

  function clearOffsets() {
    ['.now-watching-bar', '.video-embed', '.tab-bar', '#transcriptSearchSection', '#langBar'].forEach(function (sel) {
      var el = document.querySelector(sel);
      if (el) el.style.top = '';
    });
  }

  function init() {
    moveScrubberForMobile();
    moveSearchForMobile();
    moveTransportForMobile();
    moveThemeForMobile();
    if (!MQ.matches) return;
    var rv = document.getElementById('resultsView');
    if (!rv || rv.classList.contains('hidden')) return;
    updateOffsets();
  }

  function observeResultsView() {
    var rv = document.getElementById('resultsView');
    if (!rv) return;
    var obs = new MutationObserver(function () {
      if (!rv.classList.contains('hidden')) init();
    });
    obs.observe(rv, { attributes: true, attributeFilter: ['class'] });
    if (!rv.classList.contains('hidden')) init();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      moveScrubberForMobile();
      moveSearchForMobile();
      moveTransportForMobile();
      moveThemeForMobile();
      observeResultsView();
    });
  } else {
    moveScrubberForMobile();
    moveSearchForMobile();
    moveTransportForMobile();
    moveThemeForMobile();
    observeResultsView();
  }

  MQ.addEventListener('change', function () {
    moveScrubberForMobile();
    moveSearchForMobile();
    moveTransportForMobile();
    moveThemeForMobile();
    if (MQ.matches) init();
    else clearOffsets();
  });

  var transcriptTab = document.getElementById('tab-transcript');
  if (transcriptTab) {
    new MutationObserver(function () { updateOffsets(); })
      .observe(transcriptTab, { attributes: true, attributeFilter: ['class'], childList: true });
  }
  var summaryTab = document.getElementById('tab-summary');
  if (summaryTab) {
    new MutationObserver(function () { updateOffsets(); })
      .observe(summaryTab, { attributes: true, attributeFilter: ['class'], childList: true });
  }
  var centerPanel = document.querySelector('.center-panel');
  if (centerPanel) {
    new MutationObserver(function () { updateOffsets(); })
      .observe(centerPanel, { childList: true });
  }

  window.addEventListener('resize', function () { if (MQ.matches) updateOffsets(); });

  return updateOffsets;
})();
