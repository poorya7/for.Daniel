// chat-chips.js — suggested-question chip rendering, sizing, lifecycle,
// and language-switch orchestration.
//
// Owns: _usedDynamicQuestions set (per-conversation tracking of which
//       dynamic questions have been shown), chip DOM rendering (initial
//       rail + follow-up rails), per-chip width sizing via Range
//       getClientRects(), entity highlighting on chip text, ResizeObserver
//       on chatMessages for re-measurement, language-switch handling
//       (translation cache + relocalize).
// Reads from AppState: currentLang, videoData, chipTranslationCache,
//                      suggestedQuestions.
// Writes to AppState: chipTranslationCache (under target lang).
// Imports: core/state, core/helpers, api/client, ui/entity-highlighter,
//          core/debug-log, AND ChatPrefetch (one-way: handleLanguageChange
//          calls Prefetch.prefetchTranslations to warm up cached-answer
//          translations alongside chip-text translations).
// Public API: FIXED_CHIPS constant + ChatChips namespace
//             (setup, renderRail, sizeRail, removeRail, removeFollowupRails,
//              appendFollowups, refresh, relocalize, handleLanguageChange,
//              highlightAll, ensureFixedInVideoLang).

import { AppState } from '../core/state.js';
import { Helpers } from '../core/helpers.js';
import { RecapSharkAPI } from '../api/client.js';
import { highlightTextNodes } from '../ui/entity-highlighter.js';
import { debugLog } from '../core/debug-log.js';
import { ChatPrefetch } from './chat-prefetch.js';

// Two questions are always present (work for any video); the rest
// come from the LLM (Phase 2). Backend returns up to 10 dynamic
// questions; we use the first 2 as initial chips under the greeting
// and rotate through the remaining ones as follow-up chips after
// each AI answer (FOLLOWUPS_PER_ANSWER per turn).
export const FIXED_CHIPS = ['What\'s the video about?', 'Summarize the video'];

// No generic fallback pool: every chip beyond the two fixed ones must
// be video-specific (LLM-generated). If the LLM hasn't responded yet
// — or returned fewer than expected — we render fewer chips rather
// than padding the rail with generic filler.
const FOLLOWUPS_PER_ANSWER = 2;

// Tracks which dynamic questions have already been shown (initial
// rail + every follow-up rail), so each chip is unique across the
// whole conversation. Reset by reset() on new video load.
let _usedDynamicQuestions = new Set();

// One-time wiring done by chat.js core during setup. Holds the host
// DOM element (chatMessages) so ResizeObserver + relocalize can find chips.
let _chatMessages = null;

function _getDynamicPool() {
  // LLM-generated only. Generic fallbacks were intentionally dropped
  // — empty rail is preferable to a generic-looking suggestion under
  // the answer. Read from AppState.suggestedQuestions (stable across
  // partial transcript updates), NOT AppState.videoData (which gets
  // rebuilt by every loadFromApi/updateFromApi call and would drop
  // questions added between rebuilds).
  return Array.isArray(AppState.suggestedQuestions)
    ? AppState.suggestedQuestions.filter(q => typeof q === 'string' && q.trim())
    : [];
}

function _pickUnused(n) {
  const pool = _getDynamicPool();
  const out = [];
  for (const q of pool) {
    if (out.length >= n) break;
    if (!_usedDynamicQuestions.has(q)) out.push(q);
  }
  out.forEach(q => _usedDynamicQuestions.add(q));
  return out;
}

// Resolve the display text for a chip given its canonical source-language
// string. Reads AppState.currentLang + chipTranslationCache so the chips
// track whichever language the rest of the UI is showing. Falls back to
// the source text when no translation is cached yet (e.g. the user just
// switched to a fresh language and the API call hasn't returned).
//
// Stored on its own AppState.chipTranslationCache rather than nested inside
// AppState.translationCache because translation.setLanguage() treats a
// truthy translationCache[lang] as "already translated, take the cached
// path" — populating it from the chip side made setLanguage skip the
// summary/chapters/transcript API calls entirely. Independent cache,
// independent lifecycle.
// Fixed chips are authored in English (FIXED_CHIPS); dynamic chips
// come from the LLM in the video's source language. So the chip's
// "source of truth" language differs by type — fixed = 'en', dynamic
// = videoLang. Both _displayChip and _displayChipLang need to
// know that distinction so the cache lookup and the lang/dir tagging
// resolve correctly even when the user is reading a Persian-original
// video (where lang === videoLang would otherwise short-circuit fixed
// chips into staying English — the bug we fixed here).
function _chipSourceLang(sourceText) {
  return FIXED_CHIPS.includes(sourceText) ? 'en' : (AppState.videoData?.lang || 'en');
}

function _displayChip(sourceText) {
  const lang = AppState.currentLang || 'en';
  const sourceLang = _chipSourceLang(sourceText);
  if (!lang || lang === sourceLang) return sourceText;
  return AppState.chipTranslationCache?.[lang]?.[sourceText] || sourceText;
}

// Returns the language code the chip's TEXT is currently rendered in.
// Used for `.lang-XX` class tagging so CSS font rules match the actual
// glyphs being shown (e.g. Vazirmatn applies only when text is Persian).
// When the user picks a target lang but its translation hasn't landed
// yet, the chip displays the source text — return sourceLang so the
// font matches the visible characters, not the requested-but-unloaded
// translation. Once the translation arrives + relocalizeChips runs,
// the class flips and the font swaps in. */
function _displayChipLang(sourceText) {
  const lang = AppState.currentLang || 'en';
  const sourceLang = _chipSourceLang(sourceText);
  if (!lang || lang === sourceLang) return sourceLang;
  const cached = AppState.chipTranslationCache?.[lang]?.[sourceText];
  return cached ? lang : sourceLang;
}

function _chipHtml(sourceText, extraClass) {
  const display = _displayChip(sourceText);
  const displayLang = _displayChipLang(sourceText);
  const base = displayLang.split('-')[0];
  const dir = Helpers.isRTL(displayLang) ? 'rtl' : 'ltr';
  const cls = 'chat-chip lang-' + base + ' ' + dir + (extraClass ? ' ' + extraClass : '');
  // data-chip-src is the canonical (untranslated) text — the lookup key for
  // re-localising later. data-chip-q is the version actually sent to the
  // chat backend; relocalizeChips() rewrites both .textContent and chipQ
  // when the language switches, so a tap always sends the question in the
  // user's current reading language.
  return '<button type="button" class="' + cls + '"' +
    ' data-chip-src="' + Helpers.escapeHtml(sourceText) + '"' +
    ' data-chip-q="' + Helpers.escapeHtml(display) + '">' +
    Helpers.escapeHtml(display) +
    '</button>';
}

function renderRail() {
  // Initial chip rail under the greeting: 2 fixed + 2 fresh dynamic.
  const dynamic = _pickUnused(2);
  const all = [...FIXED_CHIPS, ...dynamic];
  const chips = all.map(q => _chipHtml(q)).join('');
  return `<div class="chat-chip-rail" id="chatChipRail">${chips}</div>`;
}

// Chip width sizing.
// The CSS gives chips `max-width: 86%` so long questions wrap. Once
// wrapped, `text-wrap: balance` produces two short-ish lines, but the
// box stays at 86% wide — `text-align: right` then leaves a visible
// empty gap on the LEFT inside the box. Measure each wrapped line via
// Range.getClientRects() and set explicit width = longest line + side
// padding/border, so the box hugs the actual rendered text.
function _sizeChipToContent(chip) {
  /* Range over the whole chip rather than its first text node — that
     way the measurement still works after entity-highlighter wraps
     parts of the chip text in `tx-*` spans. The previous version bailed
     (firstChild was a SPAN, not a TEXT_NODE) and chips would render
     at their default 86%-of-rail width. */
  chip.style.width = '';
  const range = document.createRange();
  range.selectNodeContents(chip);
  const rects = range.getClientRects();
  if (!rects.length) return;
  let maxLineWidth = 0;
  for (const r of rects) if (r.width > maxLineWidth) maxLineWidth = r.width;
  // Bail when the chip isn't laid out yet (e.g. mobile chat panel is
  // still display:none before mobile-sticky.js relocates it). The
  // ResizeObserver below re-runs sizing once the panel gains real
  // dimensions, so we'd just clobber the width with garbage here.
  if (maxLineWidth <= 0) return;
  const cs = getComputedStyle(chip);
  const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
  const borderX = parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth);
  chip.style.width = Math.ceil(maxLineWidth + padX + borderX) + 'px';
}

function sizeRail() {
  const rail = document.getElementById('chatChipRail');
  if (!rail) return;
  /* Order matters: SIZE first (locks width based on the raw text the
     chip was rendered with), THEN highlight (wraps matched entities
     in spans). If we highlighted first, _sizeChipToContent would
     still measure correctly thanks to the Range fallback above, but
     sizing-then-highlighting is cheaper because the range walks
     fewer DOM nodes. */
  rail.querySelectorAll('.chat-chip').forEach(_sizeChipToContent);
  highlightAll(rail);
}

/* Wrap entity spans inside every chat chip in a given root. Same
   palette as bubbles minus stretch/bracket — a question pill that
   happens to mention a known person / place / date should colorize
   it just like the AI reply would. */
function highlightAll(root) {
  const target = root || _chatMessages;
  if (!target) return;
  target.querySelectorAll('.chat-chip').forEach(chip => {
    highlightTextNodes(chip, {
      types: ['date', 'num', 'name', 'org', 'gpe', 'event', 'discourse', 'exclaim', 'punct'],
    });
  });
}

// Follow-up chips appended after each AI answer. Horizontal layout
// (CSS .chat-followup-chips) so they read like YouTube's "more
// questions" row. Returns null when the dynamic pool is exhausted —
// caller skips the rail rather than showing nothing.
function _renderFollowupChips() {
  const picks = _pickUnused(FOLLOWUPS_PER_ANSWER);
  if (!picks.length) return null;
  const chips = picks.map(q => _chipHtml(q, 'chat-chip-followup')).join('');
  return `<div class="chat-followup-chips">${chips}</div>`;
}

function removeRail() {
  const rail = document.getElementById('chatChipRail');
  if (rail) rail.remove();
}

function removeFollowupRails() {
  _chatMessages?.querySelectorAll('.chat-followup-chips').forEach(el => el.remove());
}

// Append a follow-up chip rail after the freshly-rendered AI bubble.
// No-op if the dynamic pool is exhausted (returns null), keeping the
// tail of the chat clean rather than showing a stale rail.
function appendFollowups({ scrollToBottom } = {}) {
  const poolSize = _getDynamicPool().length;
  const usedSize = _usedDynamicQuestions.size;
  const html = _renderFollowupChips();
  if (!html) {
    debugLog('[CHAT] under-pills skipped: pool exhausted',
             { poolSize, usedSize });
    return;
  }
  const wrap = document.createElement('div');
  wrap.innerHTML = html;
  const rail = wrap.firstElementChild;
  if (rail && _chatMessages) {
    _chatMessages.appendChild(rail);
    /* Highlight entities in the freshly-appended follow-up rail.
     * Initial-render rails go through sizeRail which calls
     * highlightAll; follow-up rails don't trigger that path
     * (they're sized via CSS), so we apply highlights directly. */
    highlightAll(rail);
    if (typeof scrollToBottom === 'function') scrollToBottom(_chatMessages);
  }
}

// Called from app.js after suggested_questions arrive from the
// backend (Phase 2). reset() runs at the start of loading with the
// fallback pair; this swaps in the LLM-generated questions if the
// user hasn't already engaged with the chat. If the rail is gone
// (user typed or tapped), we leave it gone — no surprise re-appear.
function refresh() {
  // The previously-rendered chips were drawn from the fallback pool;
  // the LLM pool is different content, so the used-set entries don't
  // apply. Wipe unconditionally so follow-up rails (which may render
  // long after the initial rail is gone) draw from the fresh pool.
  _usedDynamicQuestions = new Set();
  const rail = document.getElementById('chatChipRail');
  if (!rail) return;
  rail.outerHTML = renderRail();
  requestAnimationFrame(sizeRail);
  // If we're in a translated language, the dynamic questions just landed
  // AFTER the original setLanguage() call, so they were not in the pool
  // when handleLanguageChange last ran — kick off translation for them
  // now so follow-up rails appearing later don't flash English first.
  const lang = AppState.currentLang;
  const videoLang = AppState.videoData?.lang || 'en';
  if (lang && lang !== videoLang) handleLanguageChange(lang, videoLang);
}

// Re-localise every chip currently in the DOM (initial rail + every
// follow-up rail under previous AI answers) using the current language's
// translation cache. data-chip-src holds the canonical key; the visible
// text and data-chip-q both update so a tap on a re-localised chip sends
// the question in the user's current reading language.
function relocalize() {
  // Query against a live DOM lookup rather than the module-local closure
  // ref — on mobile the chat panel gets reparented when the chat overlay
  // opens, and depending on timing the closure ref can outlive a stale
  // reference. Belt-and-suspenders: search globally too in case any
  // follow-up rails ended up appended outside chatMessages.
  const root = _chatMessages || document.getElementById('chatMessages');
  const chips = root
    ? root.querySelectorAll('.chat-chip[data-chip-src]')
    : document.querySelectorAll('.chat-chip[data-chip-src]');
  if (!chips || !chips.length) return;
  chips.forEach(chip => {
    const src = chip.dataset.chipSrc;
    if (!src) return;
    const display = _displayChip(src);
    const displayLang = _displayChipLang(src);
    const base = displayLang.split('-')[0];
    chip.textContent = display;
    chip.dataset.chipQ = display;
    // Re-tag with the new display lang/dir so CSS font rules
    // (.chat-chip.lang-fa { font-family: Vazirmatn }, etc.) follow the
    // actual visible text. Without this, a chip rendered in English
    // initially keeps `.lang-en` even after relocalize swaps the text
    // to Persian, and the wrong font wins.
    [...chip.classList].forEach(c => {
      if (/^lang-/.test(c) || c === 'rtl' || c === 'ltr') chip.classList.remove(c);
    });
    chip.classList.add('lang-' + base);
    chip.classList.add(Helpers.isRTL(displayLang) ? 'rtl' : 'ltr');
  });
  // Width is set explicitly via _sizeChipToContent; the new text length
  // can change wrapping/longest-line, so re-measure after the DOM update.
  // Also re-highlight all chips — the textContent assignment above wiped
  // any tx-* spans wrapped from the previous language. sizeRail
  // covers the initial rail; the broader highlightAll pass also
  // catches every follow-up chip rail.
  requestAnimationFrame(() => {
    sizeRail();
    highlightAll(root);
  });
}

// Called from translation.setLanguage() on every language switch. Always
// re-localises immediately (so chips reflect what's already cached, or fall
// back to the source text). Then, for any chip that has no translation in
// the target-language cache, fires translateTitle in parallel and re-
// localises again as each result lands. Also kicks off cached-answer
// translation prefetch via ChatPrefetch (so chip taps land on translated
// answers fast).
//   - Switching back to the original (langCode === sourceLang): re-localise
//     uses source text directly; no API calls fire.
//   - Switching to an already-cached language: re-localise hits cached
//     translations instantly; no API calls.
//   - Switching to a fresh language: chips show source-language text first,
//     then morph to translated text as each translation arrives.
function handleLanguageChange(langCode, sourceLang) {
  relocalize();
  // Always kick off translation of any prefetched chat answers — even on
  // original-revert (no-op there because cached answers are stored in
  // sourceLang already, so no translation is needed and the cached answer
  // path resolves directly).
  ChatPrefetch.prefetchTranslations(langCode, sourceLang);
  if (!langCode || langCode === sourceLang) return;
  if (!AppState.chipTranslationCache) AppState.chipTranslationCache = {};
  if (!AppState.chipTranslationCache[langCode]) AppState.chipTranslationCache[langCode] = {};
  const cache = AppState.chipTranslationCache[langCode];

  // Translate the FULL chip pool (fixed pair + every dynamic question from
  // the LLM), not just chips currently in the DOM. Follow-up chips render
  // later from the same pool — pre-translating everything avoids an
  // English-then-translated flash on each new follow-up rail. Worst case
  // is ~12 short translateTitle calls, all in parallel.
  const sourcesNeeded = new Set();
  FIXED_CHIPS.forEach(s => { if (!cache[s]) sourcesNeeded.add(s); });
  if (Array.isArray(AppState.suggestedQuestions)) {
    AppState.suggestedQuestions.forEach(s => {
      if (typeof s === 'string' && s.trim() && !cache[s]) sourcesNeeded.add(s);
    });
  }
  if (!sourcesNeeded.size) return;

  sourcesNeeded.forEach(src => {
    RecapSharkAPI.translateTitle(src, sourceLang || 'en', langCode)
      .then(data => {
        // Verify the cache entry still exists — the user may have hit
        // reset() (new video) before this resolved.
        if (!AppState.chipTranslationCache || !AppState.chipTranslationCache[langCode]) return;
        if (!AppState.chipTranslationCache[langCode][src]) {
          AppState.chipTranslationCache[langCode][src] = (data && data.title) || src;
        }
        // Re-localise only if the user is still on the same target language;
        // otherwise we'd be overwriting the chips with stale-target text.
        if (AppState.currentLang === langCode) relocalize();
      })
      .catch(() => {});
  });
}

/* ── Fixed-chip translation for non-English original videos ──
 * Fixed chips ('What's the video about?', 'Summarize the video') are
 * always authored in English. When the video's own language isn't
 * English (Persian, Arabic, Spanish, etc.), the user sees the dynamic
 * chips in the video's language but the fixed chips stay in English
 * unless we translate them. handleLanguageChange handles the
 * translation-switch case (user picks a target lang ≠ source); this
 * helper handles the original-lang-isn't-en case where no translation
 * switch ever fires.
 *
 * Idempotent — caches under chipTranslationCache[videoLang], so a
 * later translation switch back to videoLang gets a free hit. */
function ensureFixedInVideoLang() {
  const videoLang = AppState.videoData?.lang;
  if (!videoLang || videoLang === 'en') return;
  if (!AppState.chipTranslationCache) AppState.chipTranslationCache = {};
  if (!AppState.chipTranslationCache[videoLang]) AppState.chipTranslationCache[videoLang] = {};
  const cache = AppState.chipTranslationCache[videoLang];
  FIXED_CHIPS.forEach(src => {
    if (cache[src]) return;
    RecapSharkAPI.translateTitle(src, 'en', videoLang)
      .then(data => {
        if (!AppState.chipTranslationCache?.[videoLang]) return;
        if (!AppState.chipTranslationCache[videoLang][src]) {
          AppState.chipTranslationCache[videoLang][src] = (data && data.title) || src;
        }
        if (AppState.currentLang === videoLang) relocalize();
      })
      .catch(() => {});
  });
}

// Reset internal state on new-video load. Called from chat.js core's reset().
function resetState() {
  _usedDynamicQuestions = new Set();
}

// One-time wiring from chat.js core. Stashes the chatMessages DOM ref so
// later relocalize/append/remove operations can find chips. Also installs
// the resize listener + ResizeObserver so chip sizing recovers when the
// panel gains layout (mobile gotcha: .chat-panel starts display:none).
function setup({ chatMessages }) {
  _chatMessages = chatMessages;

  // Re-measure on viewport changes (panel width drives the 86% cap, and
  // line breaks shift with width). Debounced so a drag-resize doesn't
  // hammer layout.
  let _resizeTimer = 0;
  window.addEventListener('resize', () => {
    if (_resizeTimer) clearTimeout(_resizeTimer);
    _resizeTimer = setTimeout(sizeRail, 120);
  });

  // Mobile gotcha: .chat-panel is display:none until the chat overlay
  // opens, so initial measurement during reset() reads zero-width rects
  // and bails. Watch chatMessages for size changes — the first non-zero
  // size fires this and the chips get measured with real layout values.
  if (chatMessages && window.ResizeObserver) {
    let _lastWidth = 0;
    new ResizeObserver(entries => {
      const w = entries[0]?.contentRect?.width || 0;
      if (w > 0 && w !== _lastWidth) {
        _lastWidth = w;
        sizeRail();
      }
    }).observe(chatMessages);
  }
}

export const ChatChips = {
  setup,
  renderRail,
  sizeRail,
  removeRail,
  removeFollowupRails,
  appendFollowups,
  refresh,
  relocalize,
  handleLanguageChange,
  highlightAll,
  ensureFixedInVideoLang,
  resetState,
};
