// renderer-meta.js
//
// Owns: video metadata DOM updates — title (with brutalist colorized override),
//       channel badge, URL input value, upload-date label, now-watching bar.
// Reads from AppState: videoData, _titleColorHTML, currentUploadDate.
// Imports allowed: ../core/state, ../core/helpers, ./title-colors.

import { AppState } from '../core/state.js';
import { Helpers } from '../core/helpers.js';
import { applyTitleColors } from './title-colors.js';

function renderMeta() {
  const titleEl = document.getElementById('videoTitleData');
  // Ensure plain title fallback so _tss.update() renders immediately (colorized version crossfades in later)
  if (!AppState._titleColorHTML && AppState.videoData?.title) {
    AppState._titleColorHTML = Helpers.escapeHtml(AppState.videoData.title);
  }
  titleEl.innerHTML = (AppState._titleColorHTML && document.body.classList.contains('theme-brutalist'))
    ? AppState._titleColorHTML
    : Helpers.highlightTitleKeywords(AppState.videoData.title);
  applyTitleColors();
  const _chBadge = document.getElementById('videoChannel'); if (_chBadge) _chBadge.textContent = AppState.videoData.channel;
  document.getElementById('urlInput').value =
    `https://www.youtube.com/watch?v=${AppState.videoData.videoId}`;
  const dateEl = document.getElementById('videoDate');
  if (dateEl && AppState.currentUploadDate) {
    const [y, m, day] = AppState.currentUploadDate.split('-').map(Number);
    const d = new Date(y, m - 1, day);
    dateEl.textContent = d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    dateEl.style.display = '';
  } else if (dateEl) {
    dateEl.style.display = 'none';
  }

  const nwTitle = document.querySelector('.nw-title');
  const nwMeta = document.querySelector('.nw-meta');
  if (nwTitle) nwTitle.textContent = AppState.videoData.title || '';
  if (nwMeta) {
    let metaText = AppState.videoData.channel || '';
    if (AppState.videoData.durationEstimate > 0) {
      metaText += ' · ' + Helpers.fmtTime(AppState.videoData.durationEstimate);
    }
    nwMeta.textContent = metaText;
  }
}

export const RendererMeta = {
  renderMeta,
};
