/**
 * FlatTranscript render — DOM building for paragraph rows.
 *
 * Created 2026-05-08 (Phase 4c #4) by extracting `_renderRows` + the `_el`
 * helper out of `flat-transcript.js`. Stateless aside from reading/writing
 * the orchestrator's `state.items` / `state.content` / `state.rows`.
 *
 * Row structure (matches desktop's `.transcript-paragraph` rendering):
 *
 *   .transcript-paragraph
 *     .ts-primary           ← chip + primary text, share inline flow
 *       .ts-chip
 *       .ts-text
 *     .ts-sub               ← secondary lang, hidden unless bilingual-active
 *
 * The .ts-primary wrapper exists so chip can flow inline-block at the start
 * of primary text in BOTH modes — single-language (.ts-primary is the full
 * row) and bilingual side-by-side (.ts-primary is column 1 of a 2-col grid).
 * Without the wrapper, bilingual mode would put the chip in its own grid
 * cell and leave empty space below it on multi-line paragraphs.
 */

import { applyLangStyle } from './font-loader.js';
import { EntityHighlighter } from './entity-highlighter.js';

export function el(tag, cls) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  return node;
}

export function renderRows(state) {
  if (!state.content) return;
  state.content.innerHTML = '';
  state.rows = [];

  const items = state.items;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const row = el('div', 'transcript-paragraph');
    if (i % 2 === 1) row.classList.add('alt-row');
    row.setAttribute('data-idx', String(i));

    const primary = el('div', 'ts-primary');

    const chip = el('span', 'ts-chip');
    chip.textContent = item.display || '';
    if (typeof item.time === 'number') chip.setAttribute('data-time', String(item.time));

    const text = el('span', 'ts-text');
    text.textContent = item.text || '';

    primary.appendChild(chip);
    primary.appendChild(text);

    const sub = el('span', 'ts-sub');
    sub.textContent = item.subText || '';

    row.appendChild(primary);
    row.appendChild(sub);

    /* Apply correct script direction + lang-script-dense class inline based
     * on which language each element actually holds. Apply on subLang
     * presence even when textContent is briefly empty — streaming
     * translation may populate textContent later, and we need direction set
     * before then so a Persian-source bilingual sub renders RTL the moment
     * content arrives. */
    if (item.primaryLang) applyLangStyle(text, item.primaryLang);
    if (item.subLang) applyLangStyle(sub, item.subLang);

    /* Entity coloring (numbers, dates, names, etc.) — same hook the desktop
     * renderer uses. Highlighter failure shouldn't block render. */
    try {
      EntityHighlighter.highlightEntities(text);
      if (sub.textContent) EntityHighlighter.highlightEntities(sub);
    } catch (_) { /* intentional silent — EntityHighlighter optional */ }

    state.content.appendChild(row);
    state.rows.push(row);
  }

  /* K5.5 (2026-05-07): drop PlayerManager's row-index cache for this
   * scroller — we just rebuilt every .transcript-paragraph row, so the
   * cached time→row index is stale. Defensive: flat-transcript is mobile-
   * only today (mobile path early-returns from the desktop scroll-offset
   * code in player.js:syncTranscriptHighlight), but if a desktop variant
   * ever uses _content as its scroll panel the cache stays consistent.
   * Bridge-pattern call (matches the established window.PlayerManager.*
   * pattern used elsewhere). */
  window.PlayerManager?.invalidateRowIndex?.(state.content);
}

/**
 * Fast-path: replace items WITHOUT rebuilding the DOM. Used on language
 * switch and bilingual toggle, where the row count is unchanged (same
 * paragraphs, same timestamps) but text content / subtext / language has
 * changed. The full-rebuild path (destroy + prepare) produces a visible
 * flicker on language switch because hundreds of nodes are torn down and
 * recreated; mutating textContent in place avoids that entirely — single
 * repaint, no layout thrash.
 *
 * Returns true if the fast path was used (rows reused), false if a full
 * rebuild is required (row count changed). The caller is responsible for
 * calling renderRows() in that case.
 */
export function tryUpdateItemsFast(state, newItems) {
  state.items = newItems || [];
  if (state.rows.length !== state.items.length) return false;

  for (let i = 0; i < state.items.length; i++) {
    const item = state.items[i];
    const row = state.rows[i];
    /* Direct child indexing — rows are built in renderRows as:
         row.children[0] = .ts-primary (wrapper)
           primary.children[0] = .ts-chip
           primary.children[1] = .ts-text
         row.children[1] = .ts-sub
       Faster than querySelector for long transcripts (7hr podcasts can
       have 1000+ rows). */
    const primary = row.children[0];
    const sub     = row.children[1];
    const chip = primary && primary.children[0];
    const text = primary && primary.children[1];
    if (chip) {
      chip.textContent = item.display || '';
      if (typeof item.time === 'number') chip.setAttribute('data-time', String(item.time));
    }
    if (text) {
      /* textContent collapses any existing children (including
         EntityHighlighter spans from the previous language) into a single
         text node — clean slate for the new highlight pass. */
      text.textContent = item.text || '';
      /* Re-apply per-element font/direction. updateItems is the fast path
         for lang switches and bilingual toggles, where the content
         language changes but the DOM nodes don't — without this, the rows
         keep the previous language's inline styling (or no styling) and
         non-Latin scripts render in the default font. */
      if (item.primaryLang) applyLangStyle(text, item.primaryLang);
      try { EntityHighlighter.highlightEntities(text); } catch (_) { /* optional */ }
    }
    if (sub) {
      sub.textContent = item.subText || '';
      /* Apply lang style unconditionally on subLang presence — direction
         and lang-script-dense class must be set even when textContent is
         briefly empty during streaming, so a Persian-source video in
         bilingual mode renders the sub side RTL once content arrives
         instead of inheriting the Latin-LTR default from .ts-sub CSS. */
      if (item.subLang) applyLangStyle(sub, item.subLang);
      if (sub.textContent) {
        try { EntityHighlighter.highlightEntities(sub); } catch (_) { /* optional */ }
      }
    }
  }
  return true;
}
