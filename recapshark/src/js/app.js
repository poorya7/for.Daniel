import { TranslationManager } from './translation/translation.js';
import { initOwnerAuth } from './owner/owner-auth.js';
import { processUrl } from './orchestrator/process-url.js';
import { loadData } from './api/data-loader.js';

/**
 * RecapShark App (Orchestrator)
 * Thin wiring shell: paste listener, desktop-search proxy, init block.
 * Heavy lifting lives in the orchestrator (process-url) + api/data-loader
 * (load/update/render) + transcript/* (music-detection, paragraph groups).
 */
export const App = (() => {

  /* ── Paste Listener ─────────────────────────────────── */

  async function triggerPaste() {
    try {
      const text = await navigator.clipboard.readText();
      if (text && text.trim()) {
        const urlInput = document.getElementById('urlInput');
        if (urlInput) urlInput.value = text.trim();
        processUrl(text.trim());
      } else if (typeof window.showToast === 'function') {
        window.showToast('Copy a YouTube link first, then tap Paste');
      }
    } catch (_) {
      if (typeof window.showToast === 'function') window.showToast('Copy a YouTube link first, then tap Paste');
    }
  }

  /* Home landing: paste pill (input + "Recap →" button).
     Input handles paste natively → no clipboard permission popup.
     Button + Enter both submit the typed/pasted value. The global
     document-level paste listener below still catches paste-anywhere. */
  const homeInput = document.getElementById('homePasteInput');
  const homeGo = document.getElementById('homePasteGo');
  function submitHomeUrl() {
    if (!homeInput) return;
    const val = (homeInput.value || '').trim();
    if (val) processUrl(val);
    else if (typeof window.showToast === 'function') window.showToast('Paste a YouTube link first');
  }
  if (homeGo) homeGo.addEventListener('click', submitHomeUrl);
  if (homeInput) homeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submitHomeUrl(); }
  });

  document.addEventListener('paste', (e) => {
    const text = (e.clipboardData || window.clipboardData).getData('text');
    if (text && text.trim()) {
      const urlInput = document.getElementById('urlInput');
      if (urlInput) urlInput.value = text.trim();
      processUrl(text.trim());
    }
  });

  /* ── Init ───────────────────────────────────────────── */

  if (window.VIDEO_DATA && window.TRANSCRIPT_RAW) {
    loadData();
  }

  // ── Desktop tab-bar search → mirror to existing #searchInput ──
  // The new desktop search input lives in the tab-bar (V10 layout).
  // We proxy its input/clear events to the original #searchInput so
  // SearchManager (and the in-transcript chips/results) keep working
  // without needing to know about the new field.
  (function wireDesktopSearch() {
    const dInput = document.getElementById('desktopSearchInput');
    const oInput = document.getElementById('searchInput');
    if (!dInput || !oInput) return;
    let syncing = false;
    dInput.addEventListener('input', () => {
      if (syncing) return;
      syncing = true;
      oInput.value = dInput.value;
      oInput.dispatchEvent(new Event('input', { bubbles: true }));
      syncing = false;
    });
    // Reflect external resets (e.g. clear button) back into the desktop input
    oInput.addEventListener('input', () => {
      if (syncing) return;
      if (dInput.value !== oInput.value) dInput.value = oInput.value;
    });
    // Auto-switch to transcript tab when user starts typing in desktop search
    dInput.addEventListener('focus', () => {
      const transcriptTab = document.querySelector('.tab-btn[data-mode="transcript"]');
      if (transcriptTab && !transcriptTab.classList.contains('active')) {
        transcriptTab.click();
      }
    });
  })();

  if (typeof window.initFontSizes === 'function') setTimeout(window.initFontSizes, 200);
  if (typeof TranslationManager !== 'undefined') TranslationManager.init();

  initOwnerAuth();

  const params = new URLSearchParams(window.location.search);
  const autoUrl = params.get('url');
  if (autoUrl) {
    history.replaceState(null, '', window.location.pathname);
    setTimeout(() => processUrl(autoUrl), 300);
  }

  // `triggerPaste` is exposed via the App namespace so main.js can bind it
  // to window.triggerPaste (single bridge surface). External callers:
  // HTML onclick="triggerPaste()" + click-handlers.js paste buttons.
  return { processUrl, triggerPaste };
})();
