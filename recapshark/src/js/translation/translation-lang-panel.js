import { TranslationLangMeta } from './lang-meta.js';
import { AppState } from '../core/state.js';
import { Analytics } from '../analytics/analytics.js';
import { MAX_VIDEO_DURATION_SEC, TIER_4O_LANGS } from '../core/constants.js';

const { POPULAR_LANGS, ADVANCED_MODEL_LANGS, LANG_META } = TranslationLangMeta;

/* ── Build language panel ────────────────────────────── */

export function _buildLangPanel() {
  // Source-language section lives in its own container ABOVE the search
  // box; the rest (popular + all) lives below. Splitting these two so
  // the source label is always visible at the top of the panel without
  // depending on scroll position, and so the user sees what they're
  // translating FROM before deciding what to translate TO.
  const sourceEl = document.getElementById('langPanelSource');
  const container = document.getElementById('langPanelContent');
  if (!container) return;

  const videoLang = AppState.videoData?.lang || 'en';
  const videoMeta = LANG_META[videoLang] || LANG_META.en;

  // \u2500\u2500 Above the search: video-language label \u2500\u2500
  if (sourceEl) {
    let sourceHtml = '<div class="lang-section-label">Video Language</div>';
    // Source-language row is rendered as an informative label, not a
    // clickable option. _selectLangOption short-circuits on currentLang
    // anyway, but the visual cue should match the behaviour \u2014 no border,
    // no hover, no pointer cursor. See .lang-option--source in dashboard.css.
    sourceHtml += _langOptionHTML(videoLang, videoMeta, /*isActive*/ false, /*isSource*/ true);
    sourceEl.innerHTML = sourceHtml;
  }

  // \u2500\u2500 Below the search: popular + all languages \u2500\u2500
  let html = '';
  html += '<div class="lang-section-label">Popular</div>';
  POPULAR_LANGS.forEach(code => {
    if (code === videoLang) return;
    const m = LANG_META[code];
    if (m) html += _langOptionHTML(code, m, false);
  });

  html += '<div class="lang-section-label" style="margin-top:14px;">All Languages</div>';
  const allSorted = Object.entries(LANG_META)
    .filter(([code]) => code !== videoLang && code !== 'en' && !POPULAR_LANGS.includes(code))
    .sort((a, b) => a[1].name.localeCompare(b[1].name));
  allSorted.forEach(([code, m]) => {
    html += _langOptionHTML(code, m, false);
  });

  container.innerHTML = html;

  // Wire click handlers on the searchable list. Source row is in
  // #langPanelSource (separate container) AND has .lang-option--source
  // for belt-and-braces \u2014 it's a label, not a button.
  container.querySelectorAll('.lang-option:not(.lang-option--source)').forEach(el => {
    el.addEventListener('click', function () {
      const code = this.dataset.lang;
      if (!code) return;
      _selectLangOption(this, code);
    });
  });
}

function _langOptionHTML(code, meta, isActive, isSource) {
  const flagContent = meta.flagIsHTML ? meta.flag : meta.flag;
  const cls = 'lang-option'
    + (isActive ? ' active' : '')
    + (isSource ? ' lang-option--source' : '');
  return '<div class="' + cls + '" data-lang="' + code + '">' +
    '<span class="lang-flag">' + flagContent + '</span>' +
    '<div><div class="lang-name">' + meta.name + '</div>' +
    '<div class="lang-native">' + meta.native + '</div></div>' +
    (isActive ? '<span class="lang-check">\u2713</span>' : '') +
    '</div>';
}

/* ── Reposition lang bar ─────────────────────────────── */

export function _repositionLangBar() {
  const langBar = document.getElementById('langBar');
  if (!langBar) return;
  const transcriptTab = document.getElementById('tab-transcript');
  const searchSection = document.getElementById('transcriptSearchSection');
  const tabContent = document.querySelector('.tab-content');

  var ph = langBar.nextElementSibling;
  if (ph && ph.classList.contains('lang-bar-placeholder')) ph.remove();

  if (transcriptTab && transcriptTab.classList.contains('active') && searchSection) {
    searchSection.after(langBar);
  } else if (tabContent && langBar.parentElement !== tabContent.parentElement) {
    tabContent.parentElement.insertBefore(langBar, tabContent);
  }
}

/* ── Lang panel selection helper ────────────────────── */

function _selectLangOption(el, langCode) {
  // Tier-4O × long-video gate: translating to Sinhala/Burmese/Yoruba/etc.
  // routes through gpt-4o (~10× the cost of gpt-4o-mini). For 4h+ videos
  // this can run $3-5 per translation. Block here so the user picks
  // something else; keep the panel open so they can continue browsing.
  // Mirrors the paste-time gate in app.js processUrl.
  let _dur = 0;
  try { _dur = AppState.player?.getDuration?.() || 0; } catch (_) {}
  if (!_dur) _dur = AppState.videoData?.duration || AppState.videoData?.durationEstimate || 0;
  if (_dur > MAX_VIDEO_DURATION_SEC && TIER_4O_LANGS.has(langCode)) {
    const maxH = Math.floor(MAX_VIDEO_DURATION_SEC / 3600);
    const _meta = TranslationLangMeta.LANG_META[langCode] || {};
    const langName = _meta.native || _meta.english || langCode;
    if (typeof window.showToast === 'function') {
      window.showToast(`${langName} translation isn't supported for videos over ${maxH} hours during early access.`);
    }
    return;
  }

  document.querySelectorAll('#langPanel .lang-option').forEach(o => {
    o.classList.remove('active');
    const check = o.querySelector('.lang-check');
    if (check) check.remove();
  });
  el.classList.add('active');
  const check = document.createElement('span');
  check.className = 'lang-check';
  check.textContent = '\u2713';
  el.appendChild(check);

  window.closeAllOverlays();
  Analytics.languageChanged(langCode);
  window.TranslationManager.setLanguage(langCode);

  // Toast removed — inline progress overlay handles translation status
}
