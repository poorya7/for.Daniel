/**
 * title-lang.js — Script + RTL + font class resolution for title displays.
 *
 * Owns: per-script CSS class system (lang-*), RTL/LTR direction, lazy
 * webfont loading on language switch. Pure helpers — no module state.
 *
 * Imports `ensureFontForLang` from font-loader directly (was a window
 * bridge until Bundle 5b of the cleanup follow-up, 2026-05-09).
 * `Helpers.isRTL` still read via the window bridge (boot bridge).
 */
import { ensureFontForLang } from './font-loader.js';

// CSS in title.css defines per-script font/line-height rules using these
// classes (e.g. .ts-display.lang-zh, .ts1-wrap.lang-hi). Keep this set in
// sync with the rules in title.css and with SCRIPT_FONTS in font-loader.js.
// Languages NOT in this set fall through to the default Latin font rules.
const SUPPORTED_SCRIPT_LANGS = new Set([
  // Arabic-script
  'fa', 'ur', 'ku', 'ar', 'ps',
  // Hebrew
  'he',
  // CJK
  'zh', 'zh-TW', 'ja', 'ko',
  // Devanagari
  'hi', 'mr', 'ne',
  // Other Indic
  'bn', 'ta', 'te', 'gu', 'kn', 'ml', 'pa', 'si',
  // Southeast Asian
  'th', 'lo', 'km', 'my',
  // Ethiopic, Armenian, Georgian
  'am', 'hy', 'ka',
]);

// Resolve a language code to its CSS class (e.g. 'zh-TW' → 'lang-zh-tw',
// 'fa' → 'lang-fa', 'es' → null since Spanish uses the Latin default).
export function scriptClassFor(lang) {
  if (!lang) return null;
  if (SUPPORTED_SCRIPT_LANGS.has(lang)) {
    return 'lang-' + lang.toLowerCase();
  }
  const base = lang.split('-')[0];
  if (SUPPORTED_SCRIPT_LANGS.has(base)) {
    return 'lang-' + base;
  }
  return null;
}

// Lazy-load the webfont for a given language. Idempotent — the underlying
// helper dedups against already-loaded fonts and the static <link> in index.html.
export function ensureFont(lang) {
  ensureFontForLang(lang);
}

// Return CSS class string for a language (direction + per-script font class).
// Direction comes from Helpers.isRTL; script class comes from scriptClassFor
// which covers every script in title.css's per-language rules.
export function langClassesFor(lang) {
  const classes = [];
  if (typeof Helpers !== 'undefined' && Helpers.isRTL(lang)) classes.push('rtl');
  else classes.push('ltr');
  const langCls = scriptClassFor(lang);
  if (langCls) classes.push(langCls);
  // Trigger lazy webfont load for this script (no-op for Latin, deduped
  // against already-loaded fonts).
  ensureFont(lang);
  return classes.join(' ');
}

// Strip every direction + lang-* class from an element. Used in bilingual
// desktop mode where lang classes live on each .ts1-wrap column instead of
// the outer display, so the display itself must be class-free.
export function stripLangClasses(el) {
  Array.from(el.classList)
    .filter(c => c.startsWith('lang-'))
    .forEach(c => el.classList.remove(c));
  el.classList.remove('rtl', 'ltr');
}

// Apply lang/direction classes on an element. Removes ALL prior lang-*
// classes (any of the supported scripts may have been applied previously)
// before adding the new one.
export function applyLangClasses(el, lang) {
  stripLangClasses(el);
  const isRTL = typeof Helpers !== 'undefined' && Helpers.isRTL(lang);
  el.classList.add(isRTL ? 'rtl' : 'ltr');
  const langCls = scriptClassFor(lang);
  if (langCls) el.classList.add(langCls);
  ensureFont(lang);
}
