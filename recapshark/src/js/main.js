/**
 * RecapShark ES Module Entry Point
 * Imports all modules and bridges them to window for onclick handlers.
 */

// Sentry init MUST be the very first import so boot-time errors in any
// downstream module get captured. Gated on VITE_SENTRY_DSN_FRONTEND;
// silent no-op when the DSN isn't set. Side-effect import: core/sentry.js
// binds window.Sentry + window.__sentryInitialized inline (boot bridge).
import './core/sentry.js';

// Mobile-debug error/event relay — pipes console errors + uncaught
// exceptions + a #mechPlayBtn DOM probe to /api/debug/clientlog when
// `?debug=1` is on the URL. No-op without the flag. Imported here so
// the relay arms before any module-eval code in downstream imports.
import './core/debug-relay.js';

// Asset URL bridge — side-effect import: core/assets.js binds
// window.RS_ASSETS inline (boot bridge — chat.js / lang-meta.js read it
// at module-eval time, before this file's bridge block runs).
import './core/assets.js';

// Shark logo aspect-ratio sizing — runs as early as possible so the SVG
// dimensions are corrected before users see it. Imported here (was a separate
// classic <script> tag before Phase 9a; now bundled).
import './ui/shark-logo.js';

// Core
import { AppState } from './core/state.js';
import { Helpers } from './core/helpers.js';
import { uiString } from './core/ui-strings.js';

// Analytics
import { Analytics } from './analytics/analytics.js';

// UI utilities
import { cycleLightTheme, cycleDarkTheme, cycleBrutalistTheme } from './ui/themes.js';
import {
  toggleOverlay, closeAllOverlays, selectExport, selectLang,
  showToast, toggleUserMenu, initFontSizes, applyFontSizes, changeFontSize,
} from './ui/controls.js';

// API layer
import { RecapSharkAPI } from './api/client.js';
import './api/pipeline.js';
import { DataService } from './api/data.js';

// Translation
import { TranslationLangMeta } from './translation/lang-meta.js';
import { TranslationManager } from './translation/translation.js';

// UI rendering
import { Renderer } from './ui/renderer.js';
import { PipelineUI } from './ui/pipeline-ui.js';
import { SearchManager } from './ui/search.js';

// Player
import { PlayerManager } from './player/player.js';
import { KaraokeManager } from './player/karaoke.js';
import { RewindEffect } from './player/rewind.js';

// Chat
import { ChatManager } from './chat/chat.js';

// App orchestrator
// Perf overlay — must load BEFORE app.js (which strips ?url= and friends
// from location.search via history.replaceState on auto-paste). No-op
// unless URL has ?perf=1. Tiny, safe to ship always.
import './ui/perf-overlay.js';

import { App } from './app.js';

// Cascade-in the home greeting bubble text on first paint. Bubble itself
// (bg, drop-shadow, tail) renders with the rest of the page; the text
// cascades in via the V6 letter-cascade animation. See loading-state.js
// cascadeInBubble + .bubble-content[data-cascade-init] in home.css.
import { cascadeInBubble } from './ui/loading-state.js';
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', cascadeInBubble, { once: true });
} else {
  cascadeInBubble();
}
// Modules whose surface is still bridged to window OR consumed inline below.
// Bundle 5b (2026-05-09) of the cleanup follow-up converted most consumers
// to direct ES imports — the previously-bridged `_*` symbols (font-loader,
// title-colors, casual-mode, music-detection, renderer-mobile-panels, most
// of translation-bilingual) are now imported wherever they're called. The
// remaining named imports here are EITHER (a) used inline in this file
// (clearStaleInlineFontFamily — DCL sweep below; EntityHighlighter — passed
// into setupDataLoader DI), OR (b) still bridged because the consumer would
// otherwise create a circular dep through casual-mode.js / renderer.js
// (`_updateCollapseBtnAvailability`, `_evalPendingForCurrentTab` — see the
// `Bridges that intentionally STAY` comment below the bridge block).
import { EntityHighlighter } from './ui/entity-highlighter.js';
import { clearStaleInlineFontFamily } from './ui/font-loader.js';
import {
  _updateCollapseBtnAvailability, _evalPendingForCurrentTab,
} from './translation/translation-bilingual.js';
// `mobile-sticky.js` — side-effect import. Its IIFE installs the
// resize + MutationObserver listeners that maintain mobile sticky
// offsets. main.js is the only importer in the tree, and previously
// pulled it in via a named import (`updateOffsets as _mobileUpdateOffsets`)
// for a window bridge with zero consumers — the bridge was deleted in
// Bundle 5a of the cleanup follow-up (2026-05-09); this side-effect
// import preserves the IIFE-runs-at-boot guarantee.
import './ui/mobile-sticky.js';

// One-time DOM sweep: returning users with bfcache or service-worker-cached
// pages may carry stale inline font-family pins from a previously deployed
// version of this app (the iteration-5 code path inlined font-family
// !important on script-tagged elements). The cascade-driven design needs
// those cleared so the per-codepoint fallback can do its work. Safe no-op
// on a clean first load.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', clearStaleInlineFontFamily, { once: true });
} else {
  clearStaleInlineFontFamily();
}

// Bridge: expose on window for HTML onclick handlers and cross-module typeof checks
window.AppState = AppState;
window.Helpers = Helpers;
window.uiString = uiString;
window.Analytics = Analytics;
window.RecapSharkAPI = RecapSharkAPI;
window.DataService = DataService;
window.Renderer = Renderer;
window.PipelineUI = PipelineUI;
window.PlayerManager = PlayerManager;
window.RewindEffect = RewindEffect;
window.SearchManager = SearchManager;
window.TranslationManager = TranslationManager;
window.TranslationLangMeta = TranslationLangMeta;
window.ChatManager = ChatManager;
window.KaraokeManager = KaraokeManager;
window.App = App;

// Functions needed by HTML onclick handlers
window.toggleOverlay = toggleOverlay;
window.closeAllOverlays = closeAllOverlays;
window.selectExport = selectExport;
window.selectLang = selectLang;
window.showToast = showToast;
window.toggleUserMenu = toggleUserMenu;
window.initFontSizes = initFontSizes;
window.applyFontSizes = applyFontSizes;
window.changeFontSize = changeFontSize;
window.cycleLightTheme = cycleLightTheme;
window.cycleDarkTheme = cycleDarkTheme;
window.cycleBrutalistTheme = cycleBrutalistTheme;

// App orchestrator surface
window.triggerPaste = App.triggerPaste;

// (window.Sentry / __sentryInitialized / RS_ASSETS are BOOT BRIDGES — set
//  inline by core/sentry.js + core/assets.js because karaoke modules and
//  chat.js read them at module-eval time, BEFORE main.js's bridge block
//  runs. See those files' header comments for full reasoning.)

// Bridges that intentionally STAY (Bundle 5b finish, 2026-05-09):
//   `_updateCollapseBtnAvailability` + `_evalPendingForCurrentTab` are
//   read from `ui/renderer.js` `setMode` to update the bilingual collapse
//   button + per-tab `.pending` state. Importing them directly into
//   renderer.js would create a circular dep:
//     renderer.js → translation-bilingual.js → casual-mode.js → renderer.js
//   (the third edge already exists; the bridge sidesteps the cycle). Kept
//   on window so renderer.js can call them through the bridge as a
//   deliberate decoupling layer. Don't promote these to imports without
//   first breaking the casual-mode → renderer dep.
window._updateCollapseBtnAvailability = _updateCollapseBtnAvailability;
window._evalPendingForCurrentTab = _evalPendingForCurrentTab;

// Phase 9a (2026-05-07) migrated six legacy non-module scripts from
// src/public/js/ui/ into the Vite bundle. Phase 2 of the cleanup
// (2026-05-08) consolidated their window.* assignments into the bridge
// block below so all bridges live in main.js.
//   - title-switcher / chapter-switcher / summary-switcher / mobile-chat
//     now export their public surface; main.js binds it (see below).
//   - scrollbar.js stays side-effect-only (no public surface).
//   - click-handlers.js owns DCL event binding (side-effect import).
import './ui/scrollbar.js';
import { _tss } from './ui/title-switcher.js';
import { _css } from './ui/chapter-switcher.js';
import { _sss } from './ui/summary-switcher.js';
import { openMobileChat, closeMobileChat } from './ui/mobile-chat.js';
// `click-handlers.js` — side-effect import. It owns the DCL event-binding
// for language menu / bookmarks / export buttons + a bunch of other click
// delegations.
import './ui/click-handlers.js';

// Phase 9a/9b cluster bridges (consolidated 2026-05-08).
window._tss = _tss;
window._css = _css;
window._sss = _sss;
window.openMobileChat = openMobileChat;
window.closeMobileChat = closeMobileChat;

// Phase 4a A3 (2026-05-08): inject UI deps into data-loader instead of
// having it reach for window.EntityHighlighter / window._css /
// window.applyFontSizes at every call. Runs after the cluster bridges
// above so _css is already imported in this module.
import { setup as setupDataLoader } from './api/data-loader.js';
setupDataLoader({
  entityHighlighter: EntityHighlighter,
  chapterSwitcher: _css,
  applyFontSizes,
});
