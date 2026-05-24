/**
 * Entity Highlighter — NER-driven Entity Registry
 * ------------------------------------------------
 * Names, organizations, places, and events are detected on the backend by
 * a real NER model (spaCy, or LLM fallback for non-spaCy langs) and
 * shipped to the frontend as a flat list of {text, type}. This module
 * owns that list per-language, recompiles a unified per-type regex on
 * any update, and exposes the compiled regex back to the patterns module
 * via `getEntityRegexByType()`.
 *
 * Why this beats the old "capital-letter-then-stoplist" heuristic:
 *   - NER catches all-lowercase mentions (recased all-caps captions
 *     where "trump" no longer has a leading capital to detect via regex).
 *   - NER avoids the giant English stoplist that had to be hand-tuned
 *     for every common sentence-starter capital, every contraction
 *     edge case, and every "Will/Mark/Hope" name-or-verb collision.
 *   - NER produces ORG / GPE / EVENT in addition to PERSON, opening up
 *     differentiated colors instead of one purple-for-everything bucket.
 *
 * Combined-lang regex
 * -------------------
 * The compiled regex covers entities from EVERY registered lang at once,
 * not just one "active" lang. This is critical for bilingual mode (both
 * langs visible simultaneously — Persian and English text need to match
 * their respective name lists in the same render pass), and also avoids
 * the "switch back to original loses highlights" trap where a cached row
 * keeps stale per-lang span classes.
 *
 * Same surface form across langs (e.g. "Trump" in both en and fa lists)
 * dedupes by (lowercased text, type) inside `_compileRegexes`, so the
 * alternation stays compact even with many langs registered.
 *
 * Cache-invalidation contract
 * ---------------------------
 * This module is intentionally cache-free — it doesn't know the
 * orchestrator's `_highlightCache` exists. The orchestrator
 * (entity-highlighter.js) wraps `setEntities` with a thin shim that
 * calls our `setEntities` AND clears its local cache. Keeps coupling
 * one-directional: orchestrator -> ner, never the reverse.
 *
 * Phase 4c #5 (2026-05-08): extracted from entity-highlighter.js as
 * part of the layer-by-layer SRP split.
 */

const _NAMED_ENTITY_TYPE_TO_CLASS = {
  PERSON: 'name',  // -> tx-name (purple)
  ORG:    'org',   // -> tx-org  (deep blue)
  GPE:    'gpe',   // -> tx-gpe  (teal)
  EVENT:  'event', // -> tx-event (red)
  // DATE/NUM share buckets with the regex pipeline so word-form
  // ("seventy four", "yesterday") and digit-form ("31", "2024") render
  // in the same color. Regex runs first so digit-form claims first;
  // NER pass sees the masked text and only catches the word-form ones.
  DATE:   'date', // -> tx-date (orange)
  NUM:    'num',  // -> tx-num  (green)
};

// Per-language entity registry — keyed by lang code ('en', 'fa', 'es', ...).
// Values are the raw entity arrays from /api/entities or /api/transcript/subs.
const _entityListsByLang = Object.create(null);

let _entityRegexByType = null;   // compiled regexes covering all registered langs

// Kept for backwards compatibility with callers that still call setActiveLang.
// No longer drives the regex — it's a no-op stored only for debug introspection.
let _activeLang = null;

function _escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* Build per-type regexes from a flat entity list. Internal helper —
   public callers go through setEntities/setActiveLang.

   Multi-word entities ("Stephen Colbert") become a single alternation arm —
   the range-application code handles ranges spanning multiple karaoke spans.
   Entities are deduplicated and sorted longest-first per type so prefix-
   overlap pairs ("Trump" / "Trump Jr.") resolve to the longer match —
   without that ordering, `Trump|Trump Jr.` matches the shorter form first
   and leaves " Jr." dangling. */
function _compileRegexes(entities) {
  if (!entities || !entities.length) return null;
  /* Lazy-init buckets per class so adding a new entity type to
     _NAMED_ENTITY_TYPE_TO_CLASS doesn't require also pre-populating an
     empty array here. The previous fixed shape `{ name, org, gpe, event }`
     crashed with "byType[cls] is undefined" when DATE / NUM were added. */
  const byType = {};
  const seen = new Set();
  for (const ent of entities) {
    const cls = _NAMED_ENTITY_TYPE_TO_CLASS[ent && ent.type];
    if (!cls) continue;
    const text = (ent.text || '').trim();
    if (text.length < 2) continue;
    const key = cls + '|' + text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (!byType[cls]) byType[cls] = [];
    byType[cls].push(text);
  }
  const out = {};
  for (const [cls, terms] of Object.entries(byType)) {
    if (!terms.length) continue;
    terms.sort((a, b) => b.length - a.length);
    const alternation = terms.map(_escapeRe).join('|');
    /* Unicode-aware word boundary. JavaScript's `\b` only treats ASCII
       letters / digits as word chars, so an entity like "محمدرضا" (PERSON
       in Persian) NEVER matches inside Persian text — the engine sees
       Persian letters as non-word, so there's no boundary transition.
       `\p{L}` matches any Unicode letter, `\p{N}` any digit; combined
       with the `u` flag this gives proper boundary detection for every
       script we care about (Latin, Persian, Arabic, Hebrew, Devanagari,
       Cyrillic, CJK, Thai, etc.). Critical for the multilingual NER
       fallback — without this fix, LLM-extracted Persian / Arabic /
       Hindi names register in setEntities but never visually highlight. */
    out[cls] = new RegExp(
      '(?<![\\p{L}\\p{N}])(?:' + alternation + ')(?![\\p{L}\\p{N}])',
      'giu'
    );
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Recompile the regex from the union of every registered lang's entity
 * list. Dedupe across langs is implicit — `_compileRegexes` already
 * dedupes by (lowercased text, type), so a name appearing in multiple
 * lang lists collapses to one alternation arm.
 */
function _rebuildCombinedRegex() {
  const allEntities = [];
  for (const lang of Object.keys(_entityListsByLang)) {
    const list = _entityListsByLang[lang];
    if (Array.isArray(list)) allEntities.push(...list);
  }
  _entityRegexByType = _compileRegexes(allEntities);
}

/**
 * Register the NER entity list for a specific language. Recompiles the
 * combined regex (covering entities from EVERY registered lang).
 *
 * The orchestrator wraps this to also clear its highlight cache; this
 * module deliberately doesn't reach into the cache itself.
 *
 * @param {string}    lang      - language code ('en', 'fa', 'es', ...)
 * @param {object[]}  entities  - flat list of {text, type} from the backend
 */
export function setEntities(lang, entities) {
  if (!lang) return;
  _entityListsByLang[lang] = Array.isArray(entities) ? entities : [];
  _rebuildCombinedRegex();
}

/**
 * No-op kept for backwards compatibility with callers that still call
 * `setActiveLang`. Highlighting now uses the union of every registered
 * lang's entities, so there's no notion of an "active" one. The lang
 * value is stored only for debug / introspection.
 */
export function setActiveLang(lang) {
  _activeLang = lang;
}

/**
 * True iff we have a non-empty entity list registered under `lang`.
 * Used by `fetchEntitiesForLang` to decide whether to skip a refetch.
 */
export function hasEntitiesFor(lang) {
  const list = _entityListsByLang[lang];
  return Array.isArray(list) && list.length > 0;
}

/**
 * Read accessor for the patterns module — returns the live compiled
 * regex map (or null if no entities registered).
 *
 * Returning the live object instead of a snapshot is fine: the patterns
 * module reads it once per `findEntityRanges` call and uses each per-type
 * regex synchronously inside the same call; mid-call mutation isn't a
 * concern in the current single-threaded JS execution model.
 */
export function getEntityRegexByType() {
  return _entityRegexByType;
}
