import { Analytics } from '../analytics/analytics.js';
import { Helpers } from '../core/helpers.js';
import { TranslationLangMeta } from '../translation/lang-meta.js';

export function toggleOverlay(id) {
  const panel = document.getElementById(id), backdrop = document.getElementById('backdrop'), isOpen = panel.classList.contains('show');
  closeAllOverlays();
  if (!isOpen) { panel.classList.add('show'); backdrop.classList.add('show'); }
}

export function closeAllOverlays() {
  document.querySelectorAll('.overlay-panel').forEach(p => p.classList.remove('show'));
  document.getElementById('backdrop').classList.remove('show');
}

export function selectExport(el) {
  document.querySelectorAll('.export-option').forEach(o => o.classList.remove('selected'));
  el.classList.add('selected');
  const label = el.querySelector('.export-label')?.textContent || '';
  Analytics.exportSelected(label);
}

export function selectLang(el) {
  document.querySelectorAll('.lang-option').forEach(o => { o.classList.remove('active'); o.querySelector('.lang-check')?.remove(); });
  el.classList.add('active');
  const check = document.createElement('span'); check.className = 'lang-check'; check.textContent = '\u2713';
  el.appendChild(check);
  closeAllOverlays();
  const code = el.dataset.lang || '';
}

let toastTimer = null;
export function showToast(msg, { duration = 6000 } = {}) {
  const t = document.getElementById('toast');
  t.innerHTML = msg;
  t.classList.remove('show');
  void t.offsetWidth;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), duration);
}

export function toggleUserMenu(e) {
  if (e) e.stopPropagation();
  const dd = document.getElementById('userDropdown');
  const wasHidden = !dd.classList.contains('show');
  dd.classList.toggle('show');
  if (wasHidden && e && e.currentTarget) {
    const rect = e.currentTarget.getBoundingClientRect();
    dd.style.top = (rect.bottom + 8) + 'px';
    dd.style.right = (window.innerWidth - rect.right) + 'px';
    dd.style.left = '';
    Analytics.profileMenuOpened();
  }
}

document.addEventListener('click', e => {
  if (!e.target.closest('.user-menu-wrap') && !e.target.closest('.user-avatar-btn') && !e.target.closest('.user-dropdown'))
    document.getElementById('userDropdown').classList.remove('show');
});

let fontDelta = 0;
const FONT_SELECTORS = ['.chapter-name','.chapter-num','.section-label','.summary-quick-label','.summary-quick-text','.context-label','.context-text','.rs-badge','.ts-chip','.ts-text','.bilingual-sub','.chat-bubble','.bubble-label','.chat-hint','.bm-ts','.bm-note','.bm-chapter','.video-title-text','.vtag','.vc-time','.chat-title','.overlay-title','.history-title','.history-meta','.history-date','.export-label','.export-desc','.lang-name','.lang-native','.toggle-btn','.search-input','.chat-input','.nw-title','.nw-meta','.nw-label'].join(', ');

export function initFontSizes() {
  document.querySelectorAll(FONT_SELECTORS).forEach(el => { el.dataset.baseFs = parseFloat(getComputedStyle(el).fontSize); });
}

export function applyFontSizes() {
  document.querySelectorAll(FONT_SELECTORS).forEach(el => {
    // Clear inline fontSize to read the current CSS base (not a stale cached value)
    el.style.fontSize = '';
    const cssBase = parseFloat(getComputedStyle(el).fontSize);
    el.style.fontSize = (cssBase + fontDelta) + 'px';
  });
}

export function changeFontSize(delta) {
  fontDelta = Math.max(-4, Math.min(8, fontDelta + delta));
  applyFontSizes();
  // Karaoke caches per-cluster horizontal mid-fractions per .k-word for
  // the wave loop's timing math; A+/A− changes the rendered widths and
  // those caches need to invalidate. Emitting a window event keeps the
  // coupling one-way — controls doesn't need to know karaoke exists.
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('rs:layout-change', { detail: { source: 'font-size' } }));
  }
}

const dashboard = document.querySelector('.dashboard');
let leftWidth = 320, chatWidth = 330, activeHandle = null;
const mobileBreakpoint = window.matchMedia(Helpers.NARROW_VIEWPORT_MEDIA);

function isBrutalist() { return document.body.classList.contains('theme-brutalist'); }

/**
 * Two desktop layouts:
 *  - Brutalist: 3-col grid (left, handle, main). Chat is OUTSIDE the grid
 *    (fixed-positioned via CSS). Width, dashboard margin, handle offset,
 *    nav + now-watching margins are stamped as inline styles by
 *    applyChatWidth() so the chat floats above the grid with correct offsets.
 *  - Non-brutalist: 5-col grid (left, handle, main, handle, chat). Chat is
 *    IN the grid — its width is the 5th column's width. NO inline styles
 *    are needed on chat/dashboard/handle/nav; they would actively conflict
 *    with the grid layout (stale margins from a previous brutalist session,
 *    for example, push the dashboard too narrow).
 *
 * syncPanelLayout() is the single authoritative function that applies the
 * correct layout for the current theme + widths. It is called on every
 * theme switch (from themes.js) and after every resize tick. This prevents
 * inline styles stamped in one theme from leaking into the other.
 */
function getColumns() {
  if (isBrutalist()) return `${leftWidth}px 6px 1fr`;
  return `${leftWidth}px 6px 1fr 6px ${chatWidth}px`;
}

function applyChatWidth() {
  const chat = document.querySelector('.chat-panel');
  if (!chat) return;
  const rtl = document.getElementById('resultsView')?.classList.contains('rtl-layout');
  chat.style.width = chatWidth + 'px';
  dashboard.style.marginRight = rtl ? '' : chatWidth + 'px';
  dashboard.style.marginLeft = rtl ? chatWidth + 'px' : '';
  const handle = document.getElementById('resizeHandle');
  if (handle) {
    handle.style.right = rtl ? '' : chatWidth + 'px';
    handle.style.left = rtl ? chatWidth + 'px' : '';
  }
  document.querySelectorAll('nav, .now-watching-bar').forEach(el => {
    el.style.marginRight = rtl ? '' : chatWidth + 'px';
    el.style.marginLeft = rtl ? chatWidth + 'px' : '';
  });
}

function clearChatInlineStyles() {
  const chat = document.querySelector('.chat-panel');
  if (chat) chat.style.width = '';
  dashboard.style.marginRight = '';
  dashboard.style.marginLeft = '';
  const handle = document.getElementById('resizeHandle');
  if (handle) {
    handle.style.right = '';
    handle.style.left = '';
  }
  document.querySelectorAll('nav, .now-watching-bar').forEach(el => {
    el.style.marginRight = '';
    el.style.marginLeft = '';
  });
}

export function syncPanelLayout() {
  // Mobile uses a completely different layout; panel grid/inline state
  // must not leak into it.
  if (mobileBreakpoint.matches) {
    dashboard.style.gridTemplateColumns = '';
    clearChatInlineStyles();
    return;
  }
  dashboard.style.gridTemplateColumns = getColumns();
  if (isBrutalist()) applyChatWidth();
  else clearChatInlineStyles();
}

mobileBreakpoint.addEventListener('change', () => syncPanelLayout());

function startResize(handleId) {
  if (mobileBreakpoint.matches) return;
  activeHandle = handleId;
  document.getElementById(handleId).classList.add('dragging');
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
}

document.getElementById('leftResizeHandle').addEventListener('mousedown', () => startResize('leftResizeHandle'));
document.getElementById('resizeHandle').addEventListener('mousedown', () => startResize('resizeHandle'));

document.addEventListener('mousemove', e => {
  if (!activeHandle) return;
  const rect = dashboard.getBoundingClientRect();
  const rtl = document.getElementById('resultsView')?.classList.contains('rtl-layout');
  if (activeHandle === 'leftResizeHandle') {
    leftWidth = rtl
      ? Math.max(100, Math.min(600, rect.right - e.clientX))
      : Math.max(100, Math.min(600, e.clientX - rect.left));
  } else {
    const rightEdge = isBrutalist() ? window.innerWidth : rect.right;
    chatWidth = rtl
      ? Math.max(100, Math.min(1000, e.clientX - rect.left))
      : Math.max(100, Math.min(1000, rightEdge - e.clientX));
  }
  syncPanelLayout();
});

document.addEventListener('mouseup', () => {
  if (!activeHandle) return;
  document.getElementById(activeHandle).classList.remove('dragging');
  activeHandle = null;
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
});
