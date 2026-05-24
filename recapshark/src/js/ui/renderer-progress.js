// renderer-progress.js
//
// Owns: the four progress banners that ride on top of summary / per-panel /
//       transcript content. Pure DOM ops — show/hide a banner with text.
//       Decisions about WHEN a banner appears live in the orchestrator
//       (translation pipeline / setMode), not here.
// Reads from AppState: nothing.
// Imports allowed: nothing from siblings.

function showSummaryProgress(text) {
  const host = document.getElementById('summaryDisplayHost');
  if (!host) return;
  let el = host.querySelector('.summary-progress-inline');
  if (!el) {
    el = document.createElement('div');
    el.className = 'summary-progress-inline';
    el.innerHTML = '<span class="sp-dots"><span></span><span></span><span></span></span><span class="sp-text"></span>';
    host.prepend(el);
  }
  el.querySelector('.sp-text').textContent = text;
  // Sequence: wait for panel slide-out (250ms) + small pause, then fade in
  el.classList.remove('visible');
  clearTimeout(showSummaryProgress._timer);
  showSummaryProgress._timer = setTimeout(() => el.classList.add('visible'), 400);
}

function hideSummaryProgress() {
  const el = document.querySelector('.summary-progress-inline');
  if (el) el.classList.remove('visible');
}

/* ── Generic per-panel progress banner ──────────────────────
   Used during language translation to show "Translating {section}
   to {lang}…" inside whichever panel the user happens to be on.
   Mounts on `.tab-pane` (one per tab) instead of the inner display
   host — the inner host can be `display:none` on mobile (e.g.,
   #summaryDisplayHost is hidden when the summary scroller is shown), which
   was hiding the legacy summary-progress-inline banner during lang
   switch and leaving the user with zero feedback for the ~30-40s
   summary translation. Living on .tab-pane means visibility tracks
   the active tab automatically — banner is in the DOM tree of every
   panel, only the active panel's banner is on-screen. */
function showPanelProgress(tabId, text) {
  const pane = document.getElementById(tabId);
  if (!pane) return;
  let el = pane.querySelector(':scope > .panel-progress-banner');
  if (!el) {
    el = document.createElement('div');
    el.className = 'panel-progress-banner';
    el.innerHTML = '<span class="sp-dots"><span></span><span></span><span></span></span><span class="sp-text"></span>';
    pane.prepend(el);
  }
  el.querySelector('.sp-text').textContent = text;
  // rAF flush so the .visible class transitions in (instead of paint-
  // jumping when the banner is mounted + class set in the same frame).
  el.classList.remove('visible');
  requestAnimationFrame(() => el.classList.add('visible'));
}

function hidePanelProgress(tabId) {
  const pane = document.getElementById(tabId);
  if (!pane) return;
  const el = pane.querySelector(':scope > .panel-progress-banner');
  if (el) el.classList.remove('visible');
}

function showTranscriptProgress(text) {
  let slot = document.getElementById('transcriptProgressSlot');
  let el = document.getElementById('transcriptProgressMsg');
  if (!slot) {
    slot = document.createElement('div');
    slot.id = 'transcriptProgressSlot';
    slot.className = 'progress-slot';
    el = document.createElement('div');
    el.id = 'transcriptProgressMsg';
    el.className = 'summary-progress-msg';
    el.innerHTML = '<span class="sp-text"></span>';
    slot.appendChild(el);
    const panel = document.getElementById('fullTranscriptPanel');
    if (panel) panel.prepend(slot);
  }
  slot.classList.remove('collapsed');
  el.querySelector('.sp-text').textContent = text;
}

function hideTranscriptProgress() {
  const slot = document.getElementById('transcriptProgressSlot');
  if (slot) slot.classList.add('collapsed');
}

export const RendererProgress = {
  showSummaryProgress,
  hideSummaryProgress,
  showPanelProgress,
  hidePanelProgress,
  showTranscriptProgress,
  hideTranscriptProgress,
};
