/**
 * Shared frontend constants.
 * Single source of truth for magic numbers used across modules.
 */

/** Target character count per paragraph when grouping transcript lines. */
export const PARAGRAPH_TARGET_CHARS = 220;

/** Max lines per paragraph group. */
export const PARAGRAPH_MAX_LINES = 6;

/** Max characters of transcript text to send for translation (Infinity = no cap, safe with Google Translate). */
export const TRANSLATION_MAX_TRANSCRIPT = Infinity;

/** Characters per chunk when splitting transcript for translation API (legacy tagged format). */
export const TRANSLATION_CHUNK_SIZE = 2000;

/** Lines per chunk for JSON-based transcript translation. */
export const TRANSLATION_JSON_CHUNK_LINES = 25;

/** Max concurrent translation chunk requests. */
export const TRANSLATION_MAX_CONCURRENT = 8;

/** Max video duration allowed (seconds). Videos longer than this are rejected during testing. */
export const MAX_VIDEO_DURATION_SEC = 14400; // 4 hours

/**
 * Time (ms) to flash a "✅ copied" / "✓ Copied" / "❌ failed" status on a copy
 * button before reverting to the original label. Phase 4b/B3 (2026-05-08)
 * deduped 3 identical inline values across perf-overlay.js + karaoke-debug.js.
 */
export const COPY_BUTTON_RESET_MS = 1200;

/**
 * Search input debounce delay (ms) — wait this long after the last keystroke
 * before running the actual search to avoid thrashing on every character.
 */
export const SEARCH_DEBOUNCE_MS = 250;

/**
 * Languages that route through gpt-4o (instead of gpt-4o-mini) for
 * summary + translation because gpt-4o-mini produces garbled / hallucinated
 * output for them. Mirrors `TIER_4O_LANGS` in `pipeline/translate.py` and
 * `_SUMMARIZE_TIER_4O` in `pipeline/summarize.py` — keep all three in sync.
 *
 * gpt-4o is ~10× the cost of gpt-4o-mini, so for long-form videos these
 * languages can balloon the per-video bill into the $3-5 range. We gate
 * 4h+ videos against these languages to keep the worst-case session cost
 * under ~$2 instead of ~$15.
 */
export const TIER_4O_LANGS = new Set([
  'si',  // Sinhala
  'my',  // Burmese
  'km',  // Khmer
  'gu',  // Gujarati
  'yo',  // Yoruba
  'ig',  // Igbo
  'zu',  // Zulu
  'xh',  // Xhosa
  'mi',  // Maori
  'sm',  // Samoan
  'haw', // Hawaiian
  'lo',  // Lao
  'am',  // Amharic
  'bo',  // Tibetan
  'ti',  // Tigrinya
  'wo',  // Wolof
]);
