// renderer-chapters.js
//
// Owns: chapter list HTML build, click delegation (desktop + mobile),
//       active-row highlight, chapters-preview render path used while the
//       full chapters list is still streaming.
// Reads from AppState: videoData.topics, currentChapters, currentLang,
//                      activeTopicIdx.
// Imports allowed: ../core/state, ../core/helpers, ../analytics/analytics.
// Coupling notes: receives a `showTranscriptAt(seconds)` callback via
//                 setup() — the only piece of core behavior chapters
//                 needs, and going through a callback avoids a back-import.

import { AppState } from '../core/state.js';
import { Helpers } from '../core/helpers.js';
import { Analytics } from '../analytics/analytics.js';

let _showTranscriptAt = () => {};

function topicsHTML() {
  const lang = AppState.currentLang || AppState.videoData?.lang || '';
  return AppState.videoData.topics.map((t, i) =>
    `<div class="chapter-item" data-chapter="${i}">` +
      `<span class="chapter-num">${Helpers.localizeNum(i + 1, lang)}.</span>` +
      `<span class="chapter-name">${Helpers.escapeHtml(t.title)}</span>` +
    `</div>`
  ).join('');
}

let _topicsClickBound = false;

function _bindTopicsClick() {
  if (_topicsClickBound) return;
  const wrap = document.getElementById('topicsList');
  if (!wrap) return;
  _topicsClickBound = true;
  wrap.addEventListener('click', e => {
    const item = e.target.closest('.chapter-item');
    if (!item) return;
    const idx = Number(item.dataset.chapter);
    let time;
    if (AppState.videoData.topics[idx]) {
      time = AppState.videoData.topics[idx].timestamp;
    } else if (AppState.currentChapters && AppState.currentChapters[idx]) {
      time = AppState.currentChapters[idx].start_time;
    } else {
      return;
    }
    setActiveTopic(idx);
    Analytics.chapterClicked(idx, item.querySelector('.chapter-name')?.textContent || '');
    Helpers.seekTo(time);
    _showTranscriptAt(time);
  });
}

let _chaptersTabClickBound = false;

function _syncChaptersToTab() {
  const dest = document.getElementById('chaptersTabList');
  if (!dest) return;

  // When switcher is active, it handles the innerHTML copy via _syncToMobile()
  if (typeof window._css === 'undefined') {
    const src = document.getElementById('topicsList');
    if (src) dest.innerHTML = src.innerHTML;
  }

  // Bind mobile click handler once
  if (_chaptersTabClickBound) return;
  _chaptersTabClickBound = true;
  dest.addEventListener('click', e => {
    const item = e.target.closest('.chapter-item');
    if (!item) return;
    const idx = Number(item.dataset.chapter);
    let time;
    if (AppState.videoData.topics[idx]) {
      time = AppState.videoData.topics[idx].timestamp;
    } else if (AppState.currentChapters && AppState.currentChapters[idx]) {
      time = AppState.currentChapters[idx].start_time;
    } else {
      return;
    }
    setActiveTopic(idx);
    Analytics.chapterClicked(idx, item.querySelector('.chapter-name')?.textContent || '');
    Helpers.seekTo(time);
    _showTranscriptAt(time);
  });
}

function renderTopics() {
  const lang = AppState.currentLang || AppState.videoData?.lang || '';
  const topics = AppState.videoData.topics;

  // Skip the render entirely until real chapters arrive — without this we'd
  // overwrite the loading-skeleton with the placeholder topics that
  // data.js generates ("Section 1, Section 2, ...") whenever currentChapters
  // is empty/null. The skeleton stays visible until the pipeline emits real
  // chapters (either from the YouTube description or from chapters-v3),
  // at which point this gets called again with real data.
  const _hasReal = AppState.currentChapters && AppState.currentChapters.length > 0;
  if (!_hasReal) return;

  if (typeof window._css !== 'undefined') {
    window._css.update(topics, lang);
  } else {
    const wrap = document.getElementById('topicsList');
    wrap.innerHTML = topicsHTML();
  }

  const countEl = document.querySelector('.chapters-count');
  if (countEl) countEl.textContent = topics.length;

  _bindTopicsClick();
  _syncChaptersToTab();

  if (typeof window.applyFontSizes === 'function') window.applyFontSizes();
}

function renderChaptersPreview(chapters) {
  if (!chapters || !chapters.length) return;
  const lang = AppState.currentLang || AppState.videoData?.lang || '';

  // Desktop chapter-switcher (window._css) crossfades A/B panels in
  // #topicsList. On mobile that host is hidden — #chaptersTabList is
  // the visible mobile list, populated by _syncChaptersToTab() below.
  // Skip the desktop switcher on mobile to avoid the hidden-panel
  // innerHTML rebuild + 400ms opacity animation (pure wasted work). */
  const _isMobileChapters = Helpers.isNarrowViewport();
  if (!_isMobileChapters) {
    if (typeof window._css !== 'undefined') {
      window._css.update(chapters, lang);
    } else {
      const wrap = document.getElementById('topicsList');
      if (!wrap) return;
      wrap.innerHTML = chapters.map((ch, i) =>
        `<div class="chapter-item" data-chapter="${i}">` +
          `<span class="chapter-num">${Helpers.localizeNum(i + 1, lang)}.</span>` +
          `<span class="chapter-name">${Helpers.escapeHtml(ch.title || 'Introduction')}</span>` +
        `</div>`
      ).join('');
    }
  }

  _bindTopicsClick();
  _syncChaptersToTab();

  if (typeof window.applyFontSizes === 'function') window.applyFontSizes();
}

function setActiveTopic(idx) {
  // Desktop: target active panel when switcher is available
  const desktopEl = (typeof window._css !== 'undefined')
    ? window._css.getActivePanel()
    : document.getElementById('topicsList');
  if (desktopEl) desktopEl.querySelectorAll('.chapter-item').forEach((c, i) => c.classList.toggle('active', i === idx));

  // Mobile: always target chaptersTabList directly
  const mobileEl = document.getElementById('chaptersTabList');
  if (mobileEl) mobileEl.querySelectorAll('.chapter-item').forEach((c, i) => c.classList.toggle('active', i === idx));

  AppState.activeTopicIdx = idx;
}

export const RendererChapters = {
  setup({ showTranscriptAt }) {
    _showTranscriptAt = showTranscriptAt;
  },
  topicsHTML,
  renderTopics,
  renderChaptersPreview,
  setActiveTopic,
};
