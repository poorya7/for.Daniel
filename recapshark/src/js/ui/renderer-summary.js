// renderer-summary.js
//
// Owns: summary HTML build (Quick / Context / Body sections), summary
//       paragraph render orchestration including the desktop summary-
//       switcher A/B crossfade and the mobile summary scroller refresh
//       call.
// Reads from AppState: currentSummary, videoData, currentLang,
//                      summaryFinal.
// Imports allowed: ../core/state, ../core/helpers, ../core/ui-strings,
//                  ./renderer-mobile-panels (for refreshMobileSummary).

import { AppState } from '../core/state.js';
import { Helpers } from '../core/helpers.js';
import { uiString } from '../core/ui-strings.js';
import { RendererMobilePanels } from './renderer-mobile-panels.js';

function summaryHTML(paragraphs) {
  // Resolve original paragraphs to detect context blocks by index (survives translation)
  const orig = AppState.currentSummary;
  const origArr = orig ? (Array.isArray(orig) ? orig : orig.split('\n').filter(s => s.trim())) : null;

  let quickParts = [];
  let contextParts = [];
  let bodyParts = [];
  let contextLabel = 'Context';

  paragraphs.forEach((s, idx) => {
    const isContext = s.startsWith('Context:') ||
      (origArr && origArr[idx]?.startsWith('Context:'));
    if (isContext) {
      // Strip prefix — "Context:" for English, or "TranslatedWord:" for other langs
      let text;
      if (s.startsWith('Context:')) {
        text = s.slice('Context:'.length).trim();
      } else if (s.includes(':')) {
        contextLabel = s.slice(0, s.indexOf(':')).trim();
        text = s.slice(s.indexOf(':') + 1).trim();
      } else {
        text = s;
      }
      contextParts.push(text);
    } else if (quickParts.length === 0 && contextParts.length === 0 && bodyParts.length === 0) {
      quickParts.push(s);
    } else {
      bodyParts.push(s);
    }
  });

  function toHighlighted(s) {
    return Helpers.applySummaryHighlights(Helpers.escapeHtml(s));
  }
  let html = '';
  if (quickParts.length) {
    html += `<p class="summary-quick-text" id="summaryQuick">${quickParts.map(toHighlighted).join('<br><br>')}</p>`;
  }
  if (contextParts.length) {
    html += '<div class="summary-inline-divider"></div>';
    const headerText = contextLabel === 'Context'
      ? '🦈 Context from <span class="context-brand">RecapShark.com</span>'
      : `🦈 ${Helpers.escapeHtml(contextLabel)}`;
    html += `<div class="context-block"><div class="context-block-header"><span class="context-label">${headerText}</span></div>`;
    html += `<p class="context-text" id="summaryContext">${contextParts.map(toHighlighted).join('<br><br>')}</p></div>`;
  }
  if (bodyParts.length) {
    if (quickParts.length || contextParts.length) html += '<div class="summary-inline-divider"></div>';
    html += `<p class="summary-quick-text" id="summaryBody">${bodyParts.map(toHighlighted).join('<br><br>')}</p>`;
  }
  return html;
}

function _showSummaryParagraphs(paragraphs) {
  const skeleton = document.getElementById('summarySkeleton');
  if (skeleton) skeleton.remove();

  const videoLang = AppState.videoData?.lang || 'en';
  const targetLang = AppState.currentLang && AppState.currentLang !== 'en'
    ? AppState.currentLang : videoLang;
  const lang = AppState.currentLang || videoLang;
  const baseHTML = summaryHTML(paragraphs);

  // Both labels resolve SYNCHRONOUSLY through the static UI_STRINGS dict
  // (ui-strings.js). Was previously two RecapSharkAPI.translateTitle calls
  // per language switch — instant on cache hit, ~5s combined on cold first
  // switch. Static lookup eliminates the round-trips entirely (no Promise.all,
  // no immediate-render-with-fallback workaround). recapTemplate is a
  // deliberately static "Here's your 1 minute recap" regardless of actual
  // video length (product call, simpler localization).
  const recapLabel = AppState.summaryFinal ? uiString('recapTemplate', lang) : null;
  const contextHeader = targetLang !== 'en' ? uiString('contextHeader', lang) : null;

  // Build final HTML — fully synchronous now that translations are static.
  const doUpdate = () => {
    const tmp = document.createElement('div');
    tmp.innerHTML = baseHTML;

    if (recapLabel && AppState.summaryFinal) {
      const lbl = document.createElement('div');
      lbl.className = 'summary-title-label';
      lbl.textContent = recapLabel;
      tmp.insertBefore(lbl, tmp.firstChild);
    }

    if (contextHeader) {
      const label = tmp.querySelector('.context-label');
      if (label && label.textContent.includes('Context from')) {
        label.textContent = '🦈 ' + contextHeader;
      }
    }

    // The desktop summary-switcher (window._sss) crossfades two A/B
    // panels in #summaryDisplayHost. On mobile that host is hidden by
    // CSS — only #summaryWheelHost (the SummaryNativeScroll) is
    // visible — so the switcher's innerHTML rebuild + 400ms opacity
    // animation is pure wasted work. Skip it on mobile and let the
    // mobile summary refresh below own the swap.
    const _isMobileLangSwitch = Helpers.isNarrowViewport();
    if (!_isMobileLangSwitch) {
      if (typeof window._sss !== 'undefined') {
        window._sss.update(tmp.innerHTML, lang);
      } else {
        const container = document.getElementById('summaryDisplayA');
        if (container) container.innerHTML = tmp.innerHTML;
      }
    }

    if (typeof window.applyFontSizes === 'function') window.applyFontSizes();
    // Pass the freshly-built HTML directly so the mobile summary scroller
    // refreshes even mid-crossfade (when getActivePanel still points at the
    // OLD panel).
    RendererMobilePanels.refreshMobileSummary(tmp.innerHTML);
  };

  doUpdate();
}

function renderSummary() {
  if (!AppState.videoData?.summary) return;
  _showSummaryParagraphs(AppState.videoData.summary);
}

function renderSummaryDirect(paragraphs) {
  _showSummaryParagraphs(paragraphs);
}

export const RendererSummary = {
  summaryHTML,
  renderSummary,
  renderSummaryDirect,
};
