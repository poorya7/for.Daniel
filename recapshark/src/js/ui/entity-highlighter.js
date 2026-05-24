/**
 * Entity Highlighter — Orchestrator + DOM Application
 * ----------------------------------------------------
 * Public entry point for entity coloring on transcripts, subtitles, and
 * chat content. Delegates regex matching to `entity-highlighter-patterns.js`
 * (hardcoded patterns) + `entity-highlighter-ner.js` (NER-driven entities)
 * and keeps DOM-application logic + the highlight cache here.
 *
 * Six categories rendered as `tx-*` CSS classes:
 *   - tx-date      (years, decades, centuries, ISO/slash dates, month-name dates, times)
 *   - tx-num       (everything else numeric: integers, decimals, currency, percent, scale words)
 *   - tx-name / tx-org / tx-gpe / tx-event   (NER-driven, multilingual)
 *   - tx-stretch   (words with the same letter 3+ in a row: soooo, nooo, yeahhh)
 *   - tx-discourse (yeah, nah, ok, okay)
 *   - tx-exclaim   (wow / whoa / wowww)
 *   - tx-bracket   (stage directions like [LAUGHTER], [BLEEP])
 *   - tx-punct     (currently disabled in pipeline; CSS class kept for future re-enable)
 *
 * Karaoke compatibility
 * ---------------------
 * Transcript / subtitle rows are word-by-word karaoke (each word is its
 * own `.k-word` span). To avoid breaking karaoke, multi-word matches like
 * "12 March 2022" are NOT wrapped as one span — instead each word's
 * existing span receives the `tx-date` class. Visually identical,
 * karaoke-safe.
 *
 * Two render paths (single entry point: `highlightEntities(textEl)`):
 *   1. textEl has `.k-word` children   → add classes to existing word spans
 *   2. textEl has plain text content   → wrap matched substrings in tx-* spans
 *
 * Cache-invalidation contract
 * ---------------------------
 * The plain-text wrap path memoises `text -> innerHTML`. When the NER
 * registry changes the cached HTML is stale, so the orchestrator's
 * wrapped `setEntities` calls into the NER module AND clears the local
 * cache. The NER module is intentionally unaware of the cache to keep
 * the dependency direction one-way (orchestrator -> ner / patterns).
 *
 * Phase 4c #5 (2026-05-08): split into 3 sibling files. This file
 * shrank from 720 LOC to ~325 LOC, with the regex layer in
 * `-patterns.js` and the NER registry in `-ner.js`.
 */
import { findEntityRanges } from './entity-highlighter-patterns.js';
import {
  setEntities as _nerSetEntities,
  setActiveLang as _nerSetActiveLang,
  hasEntitiesFor as _nerHasEntitiesFor,
} from './entity-highlighter-ner.js';

// Re-export the range finder so existing direct importers keep working
// (the public `EntityHighlighter` API exposes it; some internal callers
// also `import { findEntityRanges }` from this file's old location).
export { findEntityRanges };

// ── Highlight cache ───────────────────────────────────────────────────────
// Memoization cache — keyed by raw text, value is the resulting innerHTML.
// Skips both the regex pass (findEntityRanges) and the DOM wrap pass
// (_wrapPlainText) on repeat calls with the same input text. Hot path on
// language switch: a 300-row bilingual transcript triggers ~600 calls
// per switch; second switch back to a previously-rendered language is now
// pointer-swap fast.
//
// Sentinel `null` = "no ranges, no rewrite needed" (negative cache hit).
// _CACHE_MAX bounds memory at ~tens of thousands of strings; on overflow
// we clear the whole cache (simpler than full LRU, behaviour identical
// after a brief warm-up).
const _highlightCache = new Map();
const _HIGHLIGHT_CACHE_MAX = 8000;

// ── Entity registry surface (re-exports + cache-invalidating wrappers) ───

/**
 * Register the NER entity list for a specific language. Wraps the NER
 * module's `setEntities` to also clear the local highlight cache, since
 * cached innerHTML strings keyed only by raw text become stale when the
 * entity set changes.
 */
export function setEntities(lang, entities) {
  _nerSetEntities(lang, entities);
  _highlightCache.clear();
}

// Pure no-op pass-through; preserved here so the public `EntityHighlighter`
// surface keeps the symbol callers expect. Cache wipe not needed —
// setActiveLang doesn't change the regex or the highlight output.
export function setActiveLang(lang) {
  _nerSetActiveLang(lang);
}

export function hasEntitiesFor(lang) {
  return _nerHasEntitiesFor(lang);
}

// ── DOM application ──────────────────────────────────────────────────────

const _ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function _escape(s) {
  return s.replace(/[&<>"']/g, ch => _ESCAPE_MAP[ch]);
}

function _classFor(type) {
  if (type === 'date') return 'tx-date';
  if (type === 'name') return 'tx-name';
  if (type === 'org') return 'tx-org';
  if (type === 'gpe') return 'tx-gpe';
  if (type === 'event') return 'tx-event';
  if (type === 'stretch') return 'tx-stretch';
  if (type === 'discourse') return 'tx-discourse';
  if (type === 'exclaim') return 'tx-exclaim';
  if (type === 'punct') return 'tx-punct';
  if (type === 'bracket') return 'tx-bracket';
  return 'tx-num';
}

/**
 * Apply entity highlighting to a transcript / subtitle text element.
 * Idempotent enough that calling it again on the same element after karaoke
 * has rebuilt it works correctly. (`tx-*` classes from a prior pass are
 * dropped before re-classifying.)
 *
 * @param {Element} textEl  - typically `.ts-text` or `.bilingual-sub`
 */
export function highlightEntities(textEl) {
  if (!textEl) return;
  const text = textEl.textContent;
  if (!text) return;

  // Karaoke / word-span path mutates classes on existing spans inline;
  // can't be served from a string cache. Take the fast path through the
  // regex but skip cache writes — those would conflict with the karaoke
  // class-toggling flow.
  const wordSpans = textEl.querySelectorAll('.k-word');
  if (wordSpans.length) {
    const ranges = findEntityRanges(text);
    _applyToWordSpans(textEl, wordSpans, ranges);
    return;
  }

  // Cache lookup for the plain-text wrap path.
  if (_highlightCache.has(text)) {
    const cached = _highlightCache.get(text);
    if (cached !== null) textEl.innerHTML = cached;
    // cached === null means "no ranges" — nothing to write.
    return;
  }

  const ranges = findEntityRanges(text);
  if (!ranges.length) {
    if (_highlightCache.size >= _HIGHLIGHT_CACHE_MAX) _highlightCache.clear();
    _highlightCache.set(text, null);
    return;
  }
  _wrapPlainText(textEl, text, ranges);

  if (_highlightCache.size >= _HIGHLIGHT_CACHE_MAX) _highlightCache.clear();
  _highlightCache.set(text, textEl.innerHTML);
}

function _applyToWordSpans(textEl, wordSpans, ranges) {
  // Reconstruct the same plain text the regex saw by joining word texts with
  // single spaces (matches how karaoke `_buildWordSpans` builds the fragment).
  // Compute each span's [start, end) in that reconstructed string, then check
  // overlap with each range.
  const positions = [];
  let cursor = 0;
  for (const w of wordSpans) {
    const t = w.textContent || '';
    positions.push({ el: w, start: cursor, end: cursor + t.length, text: t });
    cursor += t.length + 1; // +1 for the joining space
    // Always strip prior tx-* classes so re-applying after karaoke rebuilds
    // doesn't leave stale colors on words that no longer match.
    w.classList.remove('tx-date', 'tx-num', 'tx-name', 'tx-org', 'tx-gpe', 'tx-event', 'tx-stretch', 'tx-discourse', 'tx-exclaim', 'tx-punct', 'tx-bracket');
  }

  if (!ranges.length) return;

  // We computed ranges against textEl.textContent, which may differ slightly
  // from the word-joined reconstruction (extra punctuation glued to words,
  // collapsed whitespace, etc.). For robustness, recompute ranges from the
  // word-joined string when it diverges from textEl.textContent.
  const joined = wordSpans.length
    ? Array.from(wordSpans).map(w => w.textContent || '').join(' ')
    : '';
  const useJoined = joined && joined !== textEl.textContent;
  const effectiveRanges = useJoined ? findEntityRanges(joined) : ranges;

  for (const r of effectiveRanges) {
    const cls = _classFor(r.type);
    for (const p of positions) {
      if (p.start < r.end && p.end > r.start) {
        // Punct guard: in karaoke spans the `!`/`?` is usually glued to the
        // preceding word ("Yes!" is ONE k-word). Coloring the whole span
        // would also tint the letters, which is wrong. Only color the span
        // when its entire text is punct — otherwise skip and let the punct
        // stay the default text color. Plain-text (no karaoke) rendering
        // via _wrapPlainText is unaffected and gets char-level accuracy.
        if (r.type === 'punct' && !/^[!?]+$/.test(p.text)) continue;
        p.el.classList.add(cls);
      }
    }
  }
}

function _wrapPlainText(textEl, text, ranges) {
  let html = '';
  let cursor = 0;
  for (const r of ranges) {
    /* Defensive: skip any range that overlaps a prior emitted span.
       The find-time masking pipeline shouldn't produce these, but if it
       ever does (regex bug, stale ranges, etc.), walking the cursor
       backwards via `text.slice(r.start, r.end)` from a position the
       cursor has already passed corrupts the output by re-emitting the
       surrounding chars. Safer to drop the offending range. */
    if (r.start < cursor) continue;
    if (r.start > cursor) html += _escape(text.slice(cursor, r.start));
    html += '<span class="' + _classFor(r.type) + '">' + _escape(text.slice(r.start, r.end)) + '</span>';
    cursor = r.end;
  }
  if (cursor < text.length) html += _escape(text.slice(cursor));
  textEl.innerHTML = html;
}

/**
 * Sweep a container — find all eligible text rows and apply highlighting.
 * Used after large rebuilds (mode switch, language switch, karaoke apply).
 *
 * @param {Element|Document} root
 */
export function highlightAllInContainer(root) {
  if (!root) return;
  const targets = root.querySelectorAll('.ts-text, .bilingual-sub');
  for (const el of targets) highlightEntities(el);
}

/**
 * Highlight entities inside a rich-content root (e.g. a chat AI bubble)
 * WITHOUT touching its existing HTML structure. Walks text nodes only,
 * skips text inside elements matched by `skipSelector` (so already-
 * highlighted spans, anchors, labels are left intact), and wraps each
 * matched substring in a `tx-*` span in place.
 *
 * Use this — not `highlightEntities` — when the root contains other
 * inline elements you want to preserve (links, <mark>, <br>, etc.).
 * `highlightEntities`'s plain-text path rewrites innerHTML, which would
 * destroy them.
 *
 * @param {Element} rootEl
 * @param {Object}  opts
 * @param {string[]=} opts.types         Whitelist of entity types to apply
 *                                       (e.g. ['date','num','name']).
 *                                       Defaults to all categories.
 * @param {string=}   opts.skipSelector  CSS selector — text whose nearest
 *                                       ancestor matches this is left
 *                                       untouched.
 */
export function highlightTextNodes(rootEl, opts = {}) {
  if (!rootEl) return;
  const allowed = new Set(opts.types || ['date', 'num', 'name', 'org', 'gpe', 'event', 'stretch', 'discourse', 'exclaim', 'punct', 'bracket']);
  // Defaults cover chat: skip already-highlighted spans, the bubble's
  // label/byline, timestamp links, and any inline anchor/code so we
  // don't double-mark or break click targets.
  const skipSelector = opts.skipSelector ||
    '.tx-date, .tx-num, .tx-name, .tx-org, .tx-gpe, .tx-event, .tx-stretch, .tx-discourse, .tx-exclaim, .tx-punct, .tx-bracket, ' +
    '.summary-highlight, .bubble-label, a, code';

  const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT);
  const targets = [];
  let n;
  while ((n = walker.nextNode())) {
    if (!n.textContent || !n.textContent.trim()) continue;
    if (n.parentElement && n.parentElement.closest(skipSelector)) continue;
    targets.push(n);
  }

  for (const node of targets) {
    const text = node.textContent;
    const ranges = findEntityRanges(text).filter(r => allowed.has(r.type));
    if (!ranges.length) continue;
    const frag = document.createDocumentFragment();
    let cursor = 0;
    for (const r of ranges) {
      if (r.start > cursor) {
        frag.appendChild(document.createTextNode(text.slice(cursor, r.start)));
      }
      const span = document.createElement('span');
      span.className = _classFor(r.type);
      span.textContent = text.slice(r.start, r.end);
      frag.appendChild(span);
      cursor = r.end;
    }
    if (cursor < text.length) {
      frag.appendChild(document.createTextNode(text.slice(cursor)));
    }
    node.parentNode.replaceChild(frag, node);
  }
}

// `EntityHighlighter` is bound to window.EntityHighlighter from main.js
// (single bridge surface). External callers: translation.js, renderer.js,
// flat-transcript.js, data-loader.js, karaoke-dom.js, entities.js,
// karaoke-debug.js (introspection).
export const EntityHighlighter = {
  highlightEntities,
  highlightAllInContainer,
  highlightTextNodes,
  findEntityRanges,
  setEntities,
  setActiveLang,
  hasEntitiesFor,
};
