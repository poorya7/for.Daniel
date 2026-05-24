// transcript/music-detection.js
//
// Owns: detecting "mostly music" transcripts (videos dominated by [Music]/
//       [Applause]/etc. annotations) and syncing the body.is-mostly-music
//       class + data-i18n-key labels for the music-only badges/placeholder.
// Reads from AppState: transcriptRawText (via caller arg), isMostlyMusic,
//                      currentLang.
// Writes to AppState: nothing (caller is responsible for setting
//                     AppState.isMostlyMusic from detectMostlyMusic's return).
// Imports allowed: core/state.
// Public window-bridge: applyMusicOnlyClass is exported and bound to
//   window.__syncMusicOnlyLang in main.js so the translation module can
//   re-localise the music-only labels after a lang switch without a
//   circular import.

import { AppState } from '../core/state.js';

/**
 * Music-only detector. A "mostly music" video is one whose transcript is
 * dominated by `[Music]` / `[Applause]` / `[Laughter]` / `[BLEEP]` etc.
 * caption annotations with essentially no spoken content. Strips
 * timestamps, strips bracketed annotations, then counts what's left;
 * if real word count is <100 across the entire video, treat as music-only.
 *
 * Threshold is intentionally generous — a 4h video with only 50 spoken
 * words is functionally silent for summary purposes. Edge case: a video
 * with foreign-language captions SubsProvider couldn't decode might also
 * trip this; that's acceptable, the badge text says "limited spoken
 * content" which covers both cases.
 */
export function detectMostlyMusic(rawText) {
  if (!rawText || rawText.length < 20) return false;
  // Drop leading [hh:mm:ss]/[m:ss] timestamps line by line.
  const noTimestamps = rawText.replace(/^\s*\[?\d+:\d+(?::\d+)?\]?\s*/gm, '');
  // Drop bracketed annotations and parens-style cues.
  const noAnnotations = noTimestamps.replace(/\[[^\]]*\]/g, ' ').replace(/\([^)]*\)/g, ' ');
  // Count real words (Unicode-aware, length >= 2 to skip stray punctuation).
  const words = noAnnotations.match(/[\p{L}\p{N}]{2,}/gu) || [];
  return words.length < 100;
}

/**
 * Sync the `body.is-mostly-music` class to AppState.isMostlyMusic AND
 * re-localise any `[data-i18n-key]` elements inside the music-only
 * badges/placeholder to the current language. CSS rules in dashboard.css
 * use the body class to reveal the badge on summary/chapters and
 * replace the transcript content with a friendly placeholder.
 * Re-runs on language switch so the message follows the active lang
 * (matches summary/title translation behaviour). Idempotent.
 */
export function applyMusicOnlyClass() {
  document.body.classList.toggle('is-mostly-music', !!AppState.isMostlyMusic);
  if (!AppState.isMostlyMusic) return;
  const lang = AppState.currentLang || 'en';
  const _ui = window.uiString;
  if (typeof _ui !== 'function') return;
  document.querySelectorAll('.music-only-badge[data-i18n-key], .transcript-music-only-placeholder [data-i18n-key]').forEach(el => {
    const key = el.getAttribute('data-i18n-key');
    const text = _ui(key, lang);
    if (text) el.textContent = text;
  });
}

// (window.__syncMusicOnlyLang is bound from main.js so all bridge
//  assignments live in one place — see main.js bridge block.)
