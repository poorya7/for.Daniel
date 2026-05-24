/**
 * title-resolve.js — Language-aware title HTML resolution.
 *
 * Owns: deciding which colorized HTML to show for a given language —
 * either the original-language colorized HTML, a translated+colorized
 * variant, or a plain-text fallback. Returns null while a translated
 * variant is mid-flight so the caller defers the fade and we don't
 * flash plain English / plain-translated text on screen.
 *
 * Imports: nothing. Reads AppState + Helpers via the window bridge.
 */

/**
 * Resolve the correct title HTML for a given language.
 * Returns colorized HTML if available, null if not ready yet (caller bails).
 *
 * Translated-language gate: `cache._titleReady` is set by translation.js
 * ONLY after both translateTitle AND titleColors have resolved. Returning
 * null here while the translated title is mid-flight keeps the original
 * (already-colorized) title on screen — no plain-translated flash, no
 * English flash-back, just one clean crossfade once the translated +
 * colorized HTML lands.
 */
export function resolveHTMLForLang(lang) {
  if (typeof AppState === 'undefined') return null;
  const videoLang = AppState.videoData?.lang || 'en';
  const fallback = AppState.videoData?.title
    ? (typeof Helpers !== 'undefined' ? Helpers.escapeHtml(AppState.videoData.title) : AppState.videoData.title)
    : null;

  if (lang === videoLang) {
    return AppState._titleColorHTML || fallback;
  }

  const cache = AppState.translationCache[lang];
  // Defer until the translated colorized HTML is fully ready. The active
  // panel keeps showing whatever it had before (the original colorized
  // title in the add-2nd-language flow).
  if (!cache?._titleReady) return null;
  return cache._titleColorHTML
    || AppState._titleColorHTML
    || fallback;
}

/**
 * Resolve the correct title HTML for the current language.
 */
export function resolveHTML() {
  const lang = (typeof AppState !== 'undefined' && AppState.currentLang) || 'en';
  return resolveHTMLForLang(lang);
}
