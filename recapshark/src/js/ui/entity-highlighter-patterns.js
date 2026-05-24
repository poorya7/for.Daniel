/**
 * Entity Highlighter — Regex Patterns + Range Finder
 * ---------------------------------------------------
 * Hardcoded regex patterns for entity detection (date, num, stretch,
 * discourse, exclaim, punct, bracket) plus the masking pipeline that
 * runs them. NER-driven entities (names, orgs, places, events) come
 * from the sibling `entity-highlighter-ner.js` module and slot in at
 * step 5 of the pipeline.
 *
 * Conflict order (highest → lowest priority):
 *   bracket > date > stretch > discourse > exclaim > NER > num
 * Each step works on text with all higher-priority claims masked out,
 * so overlaps resolve cleanly. Letter-based categories (stretch /
 * discourse / name) and digit-based ones (date / num) physically can't
 * overlap, so cross-family masking is mostly belt-and-suspenders.
 *
 * Persian (۰-۹) and Arabic (٠-٩) digits are recognized for date / num.
 * Name detection is Latin-script only — Persian / Arabic don't have case.
 *
 * Phase 4c #5 (2026-05-08): extracted from entity-highlighter.js as
 * part of the layer-by-layer SRP split.
 */
import { getEntityRegexByType } from './entity-highlighter-ner.js';

// ── Digit class: ASCII + Persian + Arabic ─────────────────────────────────
const D = '[0-9\\u06F0-\\u06F9\\u0660-\\u0669]';

// "Word boundary" replacement that handles non-ASCII digits. JS `\b` only
// recognizes ASCII word chars so Persian "۲۰۲۴" embedded in a sentence
// wouldn't bound correctly with `\b`. These lookarounds reject any letter
// or digit (incl. Persian/Arabic) on either side.
const WL = '(?<![\\w\\u06F0-\\u06F9\\u0660-\\u0669])';
const WR = '(?![\\w\\u06F0-\\u06F9\\u0660-\\u0669])';

const MONTHS = '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';
const ORD = '(?:st|nd|rd|th)';
const SCALE = '(?:million|billion|trillion|thousand)';

// ── Date patterns (alternation: most-specific first) ──────────────────────
// Order matters: longer/more-specific patterns must match before bare year.
const DATE_PATTERNS = [
  // ISO date: 2024-12-25
  `${D}{4}-${D}{2}-${D}{2}`,
  // Slash date: 12/25/2024 or 12-25-24
  `${D}{1,2}[\\/\\-]${D}{1,2}[\\/\\-]${D}{2,4}`,
  // Month + day + optional year:  March 12 / March 12th / March 12, 2024
  `${MONTHS}\\s+${D}{1,2}${ORD}?(?:,?\\s+${D}{2,4})?`,
  // Day + month + optional year:  12 March / 12th March 2022
  `${D}{1,2}${ORD}?\\s+${MONTHS}(?:\\s+${D}{2,4})?`,
  // Month + year:  March 2024
  `${MONTHS}\\s+${D}{4}`,
  // Times: 10:30, 10:30 AM, 5pm, 5 PM
  `${D}{1,2}:${D}{2}(?:\\s*[ap]\\.?m\\.?)?`,
  `${D}{1,2}\\s*[ap]\\.?m\\.?`,
  // Decade with apostrophe:  '90s, '80
  `'${D}{2}s?`,
  // Decade:  1990s, 2000s
  `${D}{4}s`,
  // Century:  21st century, 13th-century
  `${D}{1,2}${ORD}[\\s\\-]century`,
  // Bare year: 1500-2099 (avoid matching arbitrary 4-digit numbers like prices).
  // Three parallel patterns so tight-range filtering works in each digit
  // family — using a single mixed-family pattern would force loosening to
  // 1000-2999, which would mis-flag many non-year numbers as dates.
  // ASCII 1500-2099:
  `(?:1[5-9]|20)[0-9]{2}`,
  // Persian (۰-۹ = U+06F0-U+06F9), 1500-2099:
  `(?:\\u06F1[\\u06F5-\\u06F9]|\\u06F2\\u06F0)[\\u06F0-\\u06F9]{2}`,
  // Arabic (٠-٩ = U+0660-U+0669), 1500-2099:
  `(?:\\u0661[\\u0665-\\u0669]|\\u0662\\u0660)[\\u0660-\\u0669]{2}`,
];

const DATE_RE = new RegExp('(?:' + DATE_PATTERNS.join('|') + ')', 'gi');
// Wrap with non-word lookarounds so partial matches inside a word are excluded
// (e.g. "log20240" shouldn't pull "2024" as a year).
const DATE_RE_BOUNDED = new RegExp(WL + '(?:' + DATE_PATTERNS.join('|') + ')' + WR, 'gi');

// ── Number patterns (alternation: most-specific first) ────────────────────
const NUM_PATTERNS = [
  // Currency with scale word: $50 million, €3.5 billion
  `[\\$€£¥₹]${D}+(?:[.,]${D}+)*\\s+${SCALE}`,
  // Currency with k/m/b/t suffix: $50K, $3.2M
  `[\\$€£¥₹]${D}+(?:[.,]${D}+)*[kKmMbBtT]?`,
  // Plain number with scale word: 50 million, 3.5 billion
  `${D}+(?:\\.${D}+)?\\s+${SCALE}`,
  // Percentage: 50%, 3.5%
  `${D}+(?:\\.${D}+)?%`,
  // Number with thousand separators: 1,000 / 3,500,000
  `${D}{1,3}(?:,${D}{3})+(?:\\.${D}+)?`,
  // Decimal: 3.5, 0.99
  `${D}+\\.${D}+`,
  // Plain integer
  `${D}+`,
];

const NUM_RE_BOUNDED = new RegExp(WL + '(?:' + NUM_PATTERNS.join('|') + ')' + WR, 'gi');

// ── Stretched / elongated words ───────────────────────────────────────────
// Any Latin-script word containing the same letter 3+ times in a row
// ("soooo", "nooo", "yeahhh", "whaaat"). Backreference \1 enforces the
// "same letter" requirement. Length cap keeps "Mississippi" / "coffee" /
// "noon" out (each only has runs of 2). Latin-only on purpose: Persian /
// Arabic / Cyrillic equivalents would need their own classes and aren't
// usually a stylistic-stretch language anyway.
const STRETCH_RE = /(?<![A-Za-z])[A-Za-z]*([A-Za-z])\1{2,}[A-Za-z]*(?![A-Za-z])/g;

// ── Discourse particles (affirmation/negation only) ───────────────────────
// Slimmed down to just the affirmation/negation bucket — pronouns ("I",
// "you", "me", "we"), generic interjections ("oh", "ah", "hmm", "huh",
// "well", "hey"), and longer affirmations ("yes", "yep", "yup", "sure",
// "no", "nope") were dropping out of focus because there were too many of
// them and they crowded the page. Kept only the four that actually scan
// as content beats in transcripts.
//
// Trailing negative lookahead `(?![''])` excludes contractions ("ok'd",
// etc.) — keeps the punctuation/contraction edges clean.
const DISCOURSE_LIST = ['yeah', 'nah', 'ok', 'okay'];
const DISCOURSE_RE = new RegExp(
  '\\b(?:' + DISCOURSE_LIST.join('|') + ')\\b(?![\'\u2019])',
  'gi'
);

// ── Exclaim (excited reactions) ───────────────────────────────────────────
// "wow" / "whoa" / "woww" / "wowww" — the standalone exclamations that
// signal a reaction beat in the transcript. Distinct color from discourse
// because they're sparse and visually punchy. `wow+` matches one or more
// trailing `w`s so stretched forms ("woww", "wowww") get caught without
// duplicating entries. The discourse contraction guard isn't needed —
// these aren't contractable.
const EXCLAIM_RE = /\b(?:whoa|wow+)\b/gi;

// ── Sentence-end punctuation accent ───────────────────────────────────────
// Clusters of `!` / `?` (`?`, `!`, `!!`, `??`, `?!`, `!?`). Currently
// disabled in the pipeline (see step 2 in findEntityRanges); kept as
// harmless dead code in case we want to re-enable a different punct
// accent later. The PUNCT_TAIL absorption logic at the end of
// findEntityRanges still uses `!?` matching as a tail-extender for
// adjacent entities (e.g. "Disney World?" reads as one blue chunk).
// eslint-disable-next-line no-unused-vars
const PUNCT_RE = /[!?]+/g;

// ── Bracket annotations ───────────────────────────────────────────────────
// Stage directions and audio cues like [LAUGHTER], [CHEERS], [BLEEP],
// [APPLAUSE], [MUSIC], [SIGH], [crosstalk], etc. The bracket pair is
// included in the match so the whole `[..]` block gets one color span.
//   - Length cap (40) avoids runaway matches if some user content
//     accidentally has unmatched `[` followed by hundreds of chars.
//   - First char must be a letter (`\p{L}` + `u` flag = any Unicode
//     letter, so Persian/Arabic/CJK/etc. brackets like [صدای بوق] or
//     [拍手] match the same way English ones do) so `[1]` footnote
//     markers and `[]` empty brackets aren't claimed.
//   - `[^\]\n]` keeps the match on a single line and stops at the
//     closing bracket.
const BRACKET_RE = /\[\p{L}[^\]\n]{0,40}\]/gu;

// ── Range computation ─────────────────────────────────────────────────────

/**
 * Find date + number + name + ... ranges in a plain text string.
 * Returns ranges sorted by start position. Resolution order:
 *   0. Brackets (claim entire [..] blocks first, including chars inside)
 *   1. Dates (greedy, claims most chars per match)
 *   2. Punct (currently disabled)
 *   3. Stretched words
 *   4a. Discourse particles
 *   4b. Exclaim words
 *   5. NER entities (PERSON / ORG / GPE / EVENT / DATE / NUM)
 *   6. Numbers (last)
 *
 * @param {string} text
 * @returns {Array<{start:number, end:number, type:string}>}
 */
export function findEntityRanges(text) {
  if (!text) return [];

  const ranges = [];
  let m;

  // Helper: build a same-length space-replaced copy of `text` with every
  // claimed range blanked out, so later regex passes can't re-claim chars
  // that already belong to a higher-priority category. Same-length keeps
  // all match indices stable into the ORIGINAL text — important because
  // we always store/return ranges into the original.
  function _rebuildMasked() {
    if (!ranges.length) return text;
    const arr = text.split('');
    for (const r of ranges) {
      for (let i = r.start; i < r.end; i++) arr[i] = ' ';
    }
    return arr.join('');
  }

  // 0. Bracket annotations first — `[LAUGHTER]`, `[BLEEP]`, etc. are
  //    well-defined boundaries so we claim them before any other pass
  //    can find tokens INSIDE the brackets (e.g. NER tagging "LAUGHTER"
  //    as ORG, or NUM matching a digit inside brackets).
  BRACKET_RE.lastIndex = 0;
  while ((m = BRACKET_RE.exec(text)) !== null) {
    ranges.push({ start: m.index, end: m.index + m[0].length, type: 'bracket' });
    if (m.index === BRACKET_RE.lastIndex) BRACKET_RE.lastIndex++;
  }

  // 1. Dates next — they win remaining overlaps because they often contain
  //    capitalized month names (would otherwise be mis-tagged as names).
  let masked0 = _rebuildMasked();
  DATE_RE_BOUNDED.lastIndex = 0;
  while ((m = DATE_RE_BOUNDED.exec(masked0)) !== null) {
    ranges.push({ start: m.index, end: m.index + m[0].length, type: 'date' });
    if (m.index === DATE_RE_BOUNDED.lastIndex) DATE_RE_BOUNDED.lastIndex++;
  }

  // 2. Punct (`!?` clusters) — DISABLED.
  //    Previously coloured `!` and `?` clusters in their own amber/red
  //    accent. Removed because the standalone punctuation-mark coloring
  //    read as visual noise (and on warm bubbles it looked vaguely red,
  //    which the user disliked). Punctuation now inherits the surrounding
  //    word's text color, both in chat (AI + user bubbles + chips) and in
  //    transcripts/subtitles.
  //    The downstream STRETCH / DISCOURSE / NAME regexes use `\b` word
  //    boundaries which already treat `!` and `?` as boundaries, so
  //    skipping the masking step doesn't break their matching.
  //    The PUNCT_RE constant + .tx-punct CSS rules are kept harmless dead
  //    code in case we want to re-enable a different punct accent later.
  let masked = _rebuildMasked();

  // 3. Stretched words (soooo, yeahhh) — claim before discourse/name so a
  //    stretched-out form of a discourse word ("yesss!", "noooo") gets the
  //    more specific stretch tag instead of the generic discourse one.
  masked = _rebuildMasked();
  STRETCH_RE.lastIndex = 0;
  while ((m = STRETCH_RE.exec(masked)) !== null) {
    ranges.push({ start: m.index, end: m.index + m[0].length, type: 'stretch' });
    if (m.index === STRETCH_RE.lastIndex) STRETCH_RE.lastIndex++;
  }

  // 4a. Discourse particles (yeah, nah, ok, okay) — case-insensitive,
  //     contractions excluded by the lookahead in DISCOURSE_RE.
  masked = _rebuildMasked();
  DISCOURSE_RE.lastIndex = 0;
  while ((m = DISCOURSE_RE.exec(masked)) !== null) {
    ranges.push({ start: m.index, end: m.index + m[0].length, type: 'discourse' });
    if (m.index === DISCOURSE_RE.lastIndex) DISCOURSE_RE.lastIndex++;
  }

  // 4b. Exclaim (wow / whoa / stretched variants) — distinct fuchsia
  //     color from discourse since these are reaction beats, not generic
  //     conversational filler.
  masked = _rebuildMasked();
  EXCLAIM_RE.lastIndex = 0;
  while ((m = EXCLAIM_RE.exec(masked)) !== null) {
    ranges.push({ start: m.index, end: m.index + m[0].length, type: 'exclaim' });
    if (m.index === EXCLAIM_RE.lastIndex) EXCLAIM_RE.lastIndex++;
  }

  // 5. Named entities — sourced from the backend NER service via
  //    setEntities(). One regex pass per entity type (PERSON / ORG /
  //    GPE / EVENT / DATE / NUM), each adding its own range type.
  //    Skipped entirely when no entities have been registered
  //    (ENABLE_NER off server-side, or video pre-dates the NER deploy).
  //
  //    `masked` is REBUILT between each type so a span already claimed
  //    by an earlier type can't be re-claimed by a later one. Without
  //    this, spaCy returning the same surface form under multiple
  //    types ("Piers Morgan" as PERSON + "Piers" as ORG) produces
  //    overlapping ranges and the renderer corrupts output by walking
  //    its cursor backwards on the second claim.
  const entityRegexByType = getEntityRegexByType();
  if (entityRegexByType) {
    for (const [type, re] of Object.entries(entityRegexByType)) {
      masked = _rebuildMasked();
      re.lastIndex = 0;
      while ((m = re.exec(masked)) !== null) {
        ranges.push({ start: m.index, end: m.index + m[0].length, type });
        if (m.index === re.lastIndex) re.lastIndex++;
      }
    }
  }

  // 6. Numbers — last (lowest priority among numerics; date already won).
  masked = _rebuildMasked();
  NUM_RE_BOUNDED.lastIndex = 0;
  while ((m = NUM_RE_BOUNDED.exec(masked)) !== null) {
    ranges.push({ start: m.index, end: m.index + m[0].length, type: 'num' });
    if (m.index === NUM_RE_BOUNDED.lastIndex) NUM_RE_BOUNDED.lastIndex++;
  }

  ranges.sort((a, b) => a.start - b.start);

  // ── Absorb trailing punctuation into the preceding entity ──
  // After all entity types are detected, look at each range and check if
  // the chars immediately following it are `?` / `!`. If so, extend the
  // range to include them. The punctuation then inherits the entity's
  // tx-* color via the span wrap, so "Disney World?" reads as a single
  // blue chunk instead of "Disney World" (blue) + "?" (body color).
  // Standalone punctuation after plain text gets no extension and stays
  // the body text color, which is the desired behaviour.
  // Safety: only extend when the new end wouldn't overlap the next range
  // (defensive — entity regexes don't normally produce ranges that meet
  // exactly at a punctuation boundary, but cheap to guard).
  const PUNCT_TAIL = /^[!?]+/;
  for (let i = 0; i < ranges.length; i++) {
    const r = ranges[i];
    const tail = PUNCT_TAIL.exec(text.slice(r.end));
    if (!tail) continue;
    const newEnd = r.end + tail[0].length;
    const next = ranges[i + 1];
    if (!next || newEnd <= next.start) r.end = newEnd;
  }

  return ranges;
}
