import { AppState } from '../core/state.js';
import { Helpers } from '../core/helpers.js';
import { RecapSharkAPI } from '../api/client.js';

// Trailing punctuation that visually "belongs" to the previous word — when a
// highlighted word is followed by these chars, the highlight should extend
// over them so we don't get unstyled "!" or "?" floating after a hero word.
// Conservative set: standard ASCII + Spanish inverted + ellipsis. Excludes
// quotes/parens (those usually wrap text, not trail it) and emojis.
const _TRAILING_PUNCT_RE = /^[!?.,:;…¡¿]+/;

function _isHighlighted(color) {
  return color === 'yellow' || color === 'red' || color === 'cyan';
}

// Absorb the leading punctuation of an unhighlighted segment into the
// preceding highlighted segment, so the visual highlight runs continuously
// across e.g. "MELTDOWN!" instead of breaking before "!".
function _absorbTrailingPunct(segments) {
  const out = segments.map(s => ({ ...s }));
  for (let i = 0; i < out.length - 1; i++) {
    if (!_isHighlighted(out[i].color)) continue;
    const next = out[i + 1];
    if (_isHighlighted(next.color)) continue;
    const m = next.text.match(_TRAILING_PUNCT_RE);
    if (!m) continue;
    out[i].text += m[0];
    next.text = next.text.slice(m[0].length);
  }
  return out.filter(s => s.text.length > 0);
}

export function _segmentsToHTML(segments) {
  return _absorbTrailingPunct(segments).map(s => {
    const escaped = Helpers.escapeHtml(s.text);
    if (s.color === 'yellow') {
      return '<span class="ts1-hero-inline" style="color:#FF2D78;-webkit-text-stroke:2.5px #0C1E2A;paint-order:stroke fill;font-size:clamp(38px,8vw,72px);font-weight:900;letter-spacing:-0.03em;line-height:0.9">' + escaped + '</span>';
    }
    if (s.color === 'red') {
      return '<span style="color:#FF3B3B">' + escaped + '</span>';
    }
    if (s.color === 'cyan') {
      return '<span style="color:#5ABCD4;font-weight:700;font-style:italic">' + escaped + '</span>';
    }
    return escaped;
  }).join('');
}

export function applyTitleColors() {
  if (!AppState._titleColorHTML) return;
  // Title display is handled by title-switcher — trigger a render on any theme
  if (typeof window._tss !== 'undefined') window._tss.update();
}

export function _rebuildFromOriginal(title, segments) {
  const colored = segments.filter(s => s.color === 'red' || s.color === 'yellow' || s.color === 'cyan');
  if (!colored.length) return Helpers.escapeHtml(title);
  colored.sort((a, b) => b.text.trim().length - a.text.trim().length);
  let html = Helpers.escapeHtml(title);
  for (const seg of colored) {
    const trimmed = seg.text.trim();
    const escaped = Helpers.escapeHtml(trimmed);
    // Optionally capture trailing punctuation so the highlight visually
    // extends over e.g. "MELTDOWN!" rather than stopping before "!".
    // See _TRAILING_PUNCT_RE above for the matching set.
    const re = new RegExp('(?<![\\w>])' + Helpers.escapeRegex(escaped) + '([!?.,:;…¡¿]*)(?![\\w<])', 'i');
    if (seg.color === 'yellow') {
      html = html.replace(re, (_, punct) => '<span class="ts1-hero-inline" style="color:#FF2D78;-webkit-text-stroke:2.5px #0C1E2A;paint-order:stroke fill;font-size:clamp(38px,8vw,72px);font-weight:900;letter-spacing:-0.03em;line-height:0.9">' + escaped + punct + '</span>');
    } else if (seg.color === 'red') {
      html = html.replace(re, (_, punct) => '<span style="color:#FF3B3B">' + escaped + punct + '</span>');
    } else if (seg.color === 'cyan') {
      html = html.replace(re, (_, punct) => '<span style="color:#5ABCD4;font-weight:700;font-style:italic">' + escaped + punct + '</span>');
    }
  }
  return html;
}

export function colorizeTitle(title) {
  const p = RecapSharkAPI.titleColors(title).then(data => {
    if (!data || !data.segments || !data.segments.length) {
      // API returned empty — fall back to plain title
      AppState._titleColorHTML = Helpers.escapeHtml(title);
      applyTitleColors();
      return;
    }
    const joined = data.segments.map(s => s.text).join('');
    if (joined === title) {
      AppState._titleColorHTML = _segmentsToHTML(data.segments);
    } else {
      AppState._titleColorHTML = _rebuildFromOriginal(title, data.segments);
    }
    applyTitleColors();
  }).catch(() => {
    // API failed — fall back to plain title so it still renders
    AppState._titleColorHTML = Helpers.escapeHtml(title);
    applyTitleColors();
  });
  return p;
}

export function colorizeTitleSub(title) {
  const lang = AppState.currentLang;
  const cache = lang && AppState.translationCache[lang];
  if (cache && cache._titleColorHTML) {
    const sub = document.querySelector('.title-bilingual-sub');
    if (sub) sub.innerHTML = cache._titleColorHTML;
    return;
  }
  RecapSharkAPI.titleColors(title).then(data => {
    if (!data || !data.segments || !data.segments.length) return;
    const html = _segmentsToHTML(data.segments);
    if (lang && AppState.translationCache[lang]) {
      AppState.translationCache[lang]._titleColorHTML = html;
    }
    const sub = document.querySelector('.title-bilingual-sub');
    if (sub) sub.innerHTML = html;
  }).catch(() => {});
}

// window._applyTitleColors / _colorizeTitleSub are bound from main.js
// (single bridge surface).
