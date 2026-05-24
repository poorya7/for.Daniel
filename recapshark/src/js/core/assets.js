/**
 * Bridges bundled asset URLs to runtime JS.
 *
 * Vite rewrites paths in HTML/CSS but NOT in JS string literals. So code like
 *   div.innerHTML = '<img src="art/logo/sharky.png">';
 * works locally (Vite dev server serves src/ directly) but 404s on prod
 * (nginx serves dist/, where src/art/ doesn't exist; Vite hashes the file
 * into dist/assets/sharky-XXXX.png).
 *
 * Importing the asset here makes Vite track + hash it; `RS_ASSETS` is
 * also exported as a named ES export so main.js can re-bind it (the
 * inline `window.RS_ASSETS = ...` below is the canonical assignment;
 * main.js just re-affirms it idempotently for the bridge audit trail).
 *
 * BOOT BRIDGE — kept inline (NOT moved to main.js):
 * `window.RS_ASSETS` must be defined at module-eval time because other
 * modules (e.g. chat.js, lang-meta.js, translation-bilingual.js) read
 * `window.RS_ASSETS.sharky` from inside IIFEs that run during their own
 * module-load, BEFORE main.js's bridge block executes. main.js's bridge
 * runs after all imports finish, so it's too late for these consumers.
 * Per Phase 2 architectural decision (single bridge in main.js), this is
 * one of two documented exceptions; the other is `core/sentry.js`.
 */
import sharky from '../../art/logo/sharky.png';
// Wavy version (hand-drawn by a graphic-designer friend) — no Pahlavi
// Lion-and-Sun emoji exists in Unicode, so we ship a static PNG that
// matches the wavy aesthetic of the regional-indicator emoji flags
// rendered by iOS/Android. Replaces the earlier flat iran-flag.png.
// Importing here makes Vite track + hash it into dist/assets/ on build.
import iranFlag from '../../img/iran-flag-wavy.png';

export const RS_ASSETS = Object.freeze({
  sharky,
  iranFlag,
});

window.RS_ASSETS = RS_ASSETS;
