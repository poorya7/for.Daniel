// karaoke-analytics.js
//
// Session-end telemetry for the karaoke pipeline.
//
// Owns: the [KARAOKE-SESSION] Sentry breadcrumb fired exactly once per session
//       (gated by `_sessionEndLogFired`), the pagehide / visibilitychange→hidden
//       lifecycle hooks that drive it.
// Reads from karaoke-store: nothing — this module reads AppState directly for
//       the per-session counters (karaokeChunksRequested / Fetched / CacheHits
//       / Failed / SessionFatal). Those are set by the chunk-loader on the
//       happy path; analytics just summarises them at end-of-session.
// Writes to karaoke-store: nothing.
// Does NOT own: chunk fetching, DOM building, wave loop, the Sentry wiring for
//       chunk-fetch exceptions (that lives in karaoke-chunk-loader.js — there
//       Sentry is the FAILURE channel; here it's the OPERATIONAL-METRICS channel).
// Imports allowed: ../core/state.
// Coupling notes: analytics is leaf-only — no other karaoke module imports it.
//       KaraokeManager.init() calls attachLifecycleListeners() once.
//       KaraokeManager.reset() calls resetState() per video.
import { AppState } from '../core/state.js';

export const KaraokeAnalytics = (function () {
  'use strict';

  // ── Module-private state ────────────────────────────────────────────────
  let _sessionEndLogFired = false;             // Stage 5: once-per-session guard
  let _sessionLifecycleListenersAttached = false;  // init() guard

  // Telemetry counters — debug only.
  let _sessionEndLogFiredCount = 0;

  // ── Public lifecycle hooks ──────────────────────────────────────────────

  /** init guard for the pagehide + visibilitychange→hidden listeners.
   *  Called from KaraokeManager.init(); idempotent.
   *
   *  Why two hooks: `pagehide` is the modern best-practice for "session
   *  ended" but iOS Safari doesn't always fire it on app-switch (the user's
   *  thumb leaves the screen mid-session). `visibilitychange→hidden` covers
   *  the iOS app-switch case + tab-switch on desktop, even if the user later
   *  returns. The guard inside `_emitSessionEndLog` keeps it idempotent —
   *  first fire wins. */
  function attachLifecycleListeners() {
    if (_sessionLifecycleListenersAttached) return;
    if (typeof window === 'undefined') return;
    window.addEventListener('pagehide', _onSessionLifecycleEvent);
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', _onSessionLifecycleEvent);
    }
    _sessionLifecycleListenersAttached = true;
  }

  /** Reset the once-per-video log guard so a fresh paste can emit its own
   *  end-of-session line. Called from KaraokeManager.reset(). */
  function resetState() {
    _sessionEndLogFired = false;
  }

  // ── Internals ───────────────────────────────────────────────────────────

  /** Either of the two listeners (`pagehide` / `visibilitychange→hidden`)
   *  calls this; the guard inside `_emitSessionEndLog` ensures it fires
   *  exactly once per session regardless of which / how many events arrived. */
  function _onSessionLifecycleEvent(event) {
    if (event && event.type === 'visibilitychange' && document.visibilityState !== 'hidden') return;
    _emitSessionEndLog();
  }

  /** Stage 5: Emit a one-shot per-session telemetry line summarizing chunk
   *  activity. Fires AT MOST ONCE per session (gated by `_sessionEndLogFired`)
   *  even if both `pagehide` AND `visibilitychange→hidden` fire — which they
   *  often do in succession on real navigation. Hook order doesn't matter:
   *  whichever fires first wins, the other is a no-op.
   *
   *  Skipped silently when no chunks were ever requested (no signal) so the
   *  log doesn't pollute with empty sessions where the user never enabled
   *  karaoke (which is the production default until launch). */
  function _emitSessionEndLog() {
    if (_sessionEndLogFired) return;
    var requested = AppState.karaokeChunksRequested || 0;
    if (requested === 0) return;  // no signal — don't log empty sessions
    _sessionEndLogFired = true;
    _sessionEndLogFiredCount++;
    var fetched = AppState.karaokeChunksFetched || 0;
    var cacheHits = AppState.karaokeChunksCacheHits || 0;
    var failed = AppState.karaokeChunksFailed || 0;
    var sessionFatal = AppState.karaokeSessionFatal === true;
    var vid = AppState.currentVideoId || '(unknown)';
    var cacheHitRate = requested > 0
      ? ((cacheHits / requested) * 100).toFixed(1) + '%'
      : 'n/a';
    // Operational metrics flow through the Sentry breadcrumb below — that's
    // the real telemetry channel. The mirrored console.log was removed
    // 2026-05-06 after a console-noise cleanup pass.
    // Sentry breadcrumb (NOT an exception — these are operational metrics,
    // not bugs). Lets us see karaoke usage stats per real user error session
    // without manually correlating logs. Safe no-op when Sentry isn't loaded.
    if (typeof window !== 'undefined' && window.Sentry &&
        typeof window.Sentry.addBreadcrumb === 'function') {
      try {
        window.Sentry.addBreadcrumb({
          category: 'lazy-karaoke',
          level: 'info',
          message: 'session-end',
          data: {
            videoId: vid,
            requested: requested,
            fetched: fetched,
            cache_hits: cacheHits,
            cache_hit_rate: cacheHitRate,
            failed: failed,
            session_fatal: sessionFatal,
          },
        });
      } catch (_swallow) {
        // Sentry SDK should never throw, but if it does, don't break the
        // page-unload path. (Pre-2026-05-06 a mirrored console.log was the
        // canonical fallback; that was removed in a console-noise cleanup
        // pass — sessions where Sentry fails to emit have no telemetry now.)
      }
    }
  }

  // ── Debug-panel access (only used by __KaraokeDebug in karaoke.js) ───────
  function _debugInternals() {
    return {
      get _sessionEndLogFired() { return _sessionEndLogFired; },
      get _sessionEndLogFiredCount() { return _sessionEndLogFiredCount; },
      get _sessionLifecycleListenersAttached() { return _sessionLifecycleListenersAttached; },
      _emitSessionEndLog,
      _onSessionLifecycleEvent,
    };
  }

  return {
    // Lifecycle
    attachLifecycleListeners, resetState,
    // Debug-only
    _debugInternals,
  };
})();
