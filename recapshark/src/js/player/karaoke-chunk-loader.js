// karaoke-chunk-loader.js
//
// All chunk-fetching I/O for the lazy karaoke pipeline.
//
// Owns: heartbeat-throttled scheduling, seek-debounce accelerator, visibility
//       recovery, the uniform 600s chunk grid, the short-video bypass
//       (<=300s → single-call endpoint), per-chunk fetch with retryable /
//       non-retryable / Sentry-capture handling.
// Reads from karaoke-store: isOriginalVisible() (translation gate), addWords +
//       addLoadedRange (success path).
// Writes to karaoke-store: words + loaded-ranges (via addWords/addLoadedRange);
//       NEVER touches DOM-bound state directly — the success path calls back
//       into the apply-path via the `applyWordSpans` callback wired in setup().
// Does NOT own: word data shape, DOM building, alignment, wave loop, session
//       lifecycle (those live in karaoke.js / karaoke-store.js / karaoke-analytics.js).
// Imports allowed: ../core/state, ../api/client, ./karaoke-store.
// Coupling notes: cross-module callbacks via setup({applyWordSpans}) keeps the
//       import DAG acyclic — chunk-loader doesn't back-import karaoke.js.
import { AppState } from '../core/state.js';
import { RecapSharkAPI } from '../api/client.js';
import { KaraokeStore } from './karaoke-store.js';
import {
  FIRST_CHUNK_DUR,
  STEADY_CHUNK_DUR,
  SHORT_VIDEO_THRESHOLD_SEC,
} from './karaoke-constants.js';

export const KaraokeChunkLoader = (function () {
  'use strict';

  // ── Grid + window constants ─────────────────────────────────────────────
  // FIRST_CHUNK_DUR / STEADY_CHUNK_DUR / SHORT_VIDEO_THRESHOLD_SEC live in
  // karaoke-constants.js (tiny dep-free module — keeps the main bundle
  // light so the rest of this file can lazy-load). Backend validator at
  // routes.py rejects requests off-grid (400) — `npm run check:chunk-grid`
  // asserts FE/BE equality.
  const WINDOW_BACK = 30;
  const WINDOW_FWD = 120;
  const MAX_INFLIGHT = 3;
  const HEARTBEAT_THROTTLE_MS = 1500;
  const SEEK_DEBOUNCE_MS = 1500;            // §10 pseudocode — coalesces scrubbing into one fetch
  const DEFAULT_ERROR_COOLDOWN_MS = 5000;

  /** Karaoke heartbeat can beat loadFromApi (e.g. while colorizeP awaits) —
   *  currentVideoId isn't set yet but processingVideoId / videoData.videoId is. */
  function _resolvedVideoIdForKaraoke() {
    return AppState.currentVideoId
      || (AppState.videoData && AppState.videoData.videoId)
      || AppState.processingVideoId
      || null;
  }

  // Stage 4: user-visible toast copy for the two session-fatal error codes.
  // Both fire AT MOST ONCE per session (guarded by `_sessionFatalToastShown`)
  // and only when `window.showToast` is available. Plain transcript continues
  // silently afterward — karaoke just doesn't appear, which is the intended
  // graceful-degrade per D7 / §12.
  const SESSION_FATAL_TOASTS = {
    cap_hit: 'Today\'s karaoke is all used up! More tomorrow 🌙',
    circuit_open: 'Karaoke\'s down right now. Try again in a few 🔧',
  };

  // ── Module-private state ─────────────────────────────────────────────────
  let _chunksLoaded = new Set();           // chunk keys we got words for
  let _chunksReadyOrFatal = new Set();     // success-or-permanent-fail
  let _inFlight = new Map();               // chunk keys currently fetching
  let _errorCooldown = new Map();          // key -> ts (ms since epoch) when retry allowed
  let _lastHeartbeatLoad = 0;
  let _seekDebounceTimer = null;           // trailing-edge debounce; cleared on reset()
  let _visibilityListenerAttached = false; // init() guard so we don't double-attach
  let _sessionFatalToastShown = false;     // Stage 4: once-per-session guard
  let _shortVideoBypassFired = false;      // Phase 4: per-video guard
  let _shortVideoBypassInFlight = false;   // Phase 4: prevents re-fire while in-flight

  // Telemetry counters — debug only.
  let _maybeScheduleChunkLoadCalls = 0;
  let _seekDebounceFires = 0;
  let _visibilityRecoveryFires = 0;
  let _sessionFatalToastShownCount = 0;
  let _sentryCapturesFromFetch = 0;
  let _shortVideoBypassFiredCount = 0;

  // ── Cross-module callback (wired by KaraokeManager.init via setup()) ────
  // Success paths call this to repaint spans on the active panel. Default is
  // a no-op so the module is safe to import standalone (e.g., tests).
  let _applyWordSpansForActivePanel = function () {};

  function setup(deps) {
    if (deps && typeof deps.applyWordSpansForActivePanel === 'function') {
      _applyWordSpansForActivePanel = deps.applyWordSpansForActivePanel;
    }
  }

  // ── Public lifecycle hooks ──────────────────────────────────────────────

  /** init guard for the visibility-recovery listener. Called from
   *  KaraokeManager.init(); idempotent. */
  function attachVisibilityListener() {
    if (_visibilityListenerAttached) return;
    if (typeof document === 'undefined') return;
    document.addEventListener('visibilitychange', _onVisibilityChange);
    _visibilityListenerAttached = true;
  }

  /** Clear all cache + flag state for a new video. Called from
   *  KaraokeManager.reset(). */
  function resetState() {
    _chunksLoaded = new Set();
    _chunksReadyOrFatal = new Set();
    _inFlight = new Map();
    _errorCooldown = new Map();
    _lastHeartbeatLoad = 0;
    if (_seekDebounceTimer) { clearTimeout(_seekDebounceTimer); _seekDebounceTimer = null; }
    _sessionFatalToastShown = false;
    _shortVideoBypassFired = false;
    _shortVideoBypassInFlight = false;
  }

  /** ⚠️ DEBUG-TEST-ONLY reset. MUST NOT be called from any production code path.
   *
   *  The Stage 3-5 + Phase 4 test suites assert exact fire counts after stubbing
   *  dependencies and need a clean slate to start the next sub-test. This zeroes
   *  the telemetry counters AND resets four per-session prod guards:
   *
   *    - `_sessionFatalToastShown`     (cap_hit/circuit_open one-time toast)
   *    - `_shortVideoBypassFired`      (per-video once-only short-video call)
   *    - `_shortVideoBypassInFlight`   (in-flight prevention for that call)
   *    - `_seekDebounceTimer`          (cancels any pending seek-debounce fire)
   *
   *  Tests need those resets to verify "fires-once-per-video" semantics by
   *  re-running the same code path multiple times in one session. PRODUCTION
   *  code MUST NOT call this — resetting the guards mid-session would let a
   *  user see the same fatal toast twice, double-fire the short-video bypass,
   *  or cancel an in-flight seek. The per-video lifecycle reset (`resetState`
   *  above, called from KaraokeManager.reset()) is the correct prod path.
   *
   *  Renamed from `_resetDebugCounters` (2026-05-07, K5) to make the leak risk
   *  obvious — the old name implied "just counters" and any future grep could
   *  have miscategorized it as safe. Routed in via __KaraokeDebug.* wrappers
   *  in karaoke-debug.js (debug-panel-only, gated by ?karaoke_debug=1 +
   *  import.meta.env.DEV — never reaches prod users). */
  function _resetForDebugTest() {
    _maybeScheduleChunkLoadCalls = 0;
    _seekDebounceFires = 0;
    _visibilityRecoveryFires = 0;
    _sessionFatalToastShownCount = 0;
    _sentryCapturesFromFetch = 0;
    _shortVideoBypassFiredCount = 0;
    _sessionFatalToastShown = false;
    _shortVideoBypassFired = false;
    _shortVideoBypassInFlight = false;
    if (_seekDebounceTimer) { clearTimeout(_seekDebounceTimer); _seekDebounceTimer = null; }
  }

  // ── Chunk-key + grid math ───────────────────────────────────────────────

  function _chunkKey(start, dur) { return start + ':' + dur; }

  /** Compute the chunks needed to cover [t-WINDOW_BACK, t+WINDOW_FWD],
   *  snapped to the uniform 600s grid: [0,600], [600,1200], [1200,1800], ...
   *  Last chunk dur is truncated when videoDur isn't a grid multiple;
   *  backend validator is lenient on dur upper bound for that case.
   *
   *  Prefetch (Stage 3 step 4) is implicit in the WINDOW_FWD lookahead:
   *  with WINDOW_FWD=120, the next chunk enters the needed list as soon
   *  as the playhead crosses (chunk_end − 120). Spec asked for prefetch
   *  at "last 30s of current chunk" — we trigger 90s earlier, well before
   *  AsrProvider's ~13s processing time would create an audible gap. The seek
   *  debounce + visibility recovery paths (Stage 3 steps 5-6) cover the
   *  edge cases where heartbeat hasn't been firing (paused, hidden tab).
   *  No separate prefetch trigger needed. */
  function _neededChunks(t, videoDur) {
    if (!videoDur || videoDur <= 0) return [];
    var t0 = Math.max(0, t - WINDOW_BACK);
    var t1 = Math.min(videoDur, t + WINDOW_FWD);
    var firstIdx = Math.floor(t0 / STEADY_CHUNK_DUR);
    var lastIdx = Math.floor((t1 - 0.001) / STEADY_CHUNK_DUR);
    var out = [];
    for (var i = firstIdx; i <= lastIdx; i++) {
      var s = i * STEADY_CHUNK_DUR;
      if (s >= videoDur) break;
      var d = Math.min(STEADY_CHUNK_DUR, videoDur - s);
      if (d > 0) out.push({ start: s, dur: Math.round(d) });
    }
    return out;
  }

  // ── Trigger paths ───────────────────────────────────────────────────────

  /** Throttled entry point called from syncWord on every heartbeat tick.
   *  Cheap when nothing needs to happen — only walks the needed-chunk list
   *  once every HEARTBEAT_THROTTLE_MS. */
  function maybeScheduleChunkLoad(t) {
    _maybeScheduleChunkLoadCalls++;
    var now = Date.now();
    if (now - _lastHeartbeatLoad < HEARTBEAT_THROTTLE_MS) return;
    _lastHeartbeatLoad = now;
    _loadChunksForCurrentTime(t);
  }

  /** Seek/play accelerator (Stage 3). Called from `onPlayerStateChange` when
   *  YT enters PLAYING — covers resume-from-pause AND scrub-then-release
   *  (YT emits BUFFERING during the drag, PLAYING when the user lets go).
   *  Trailing-edge debounce coalesces rapid scrubbing into one fetch so we
   *  don't burn AsrProvider budget on chunks the user scrubbed past. The heartbeat
   *  path remains the primary trigger; this just accelerates response after
   *  user-initiated jumps. Both feed the same idempotent loader, so a missed
   *  fire here is harmless — the next heartbeat will cover it. */
  /** Trailing-edge callback for the seek-debounce timer. Extracted as a named
   *  function so the debug-panel `_flushSeekDebounce` test hook can fire it
   *  synchronously without waiting for setTimeout. */
  function _seekDebounceFire() {
    _seekDebounceTimer = null;
    _seekDebounceFires++;
    var t = (AppState.player && typeof AppState.player.getCurrentTime === 'function')
      ? AppState.player.getCurrentTime() : 0;
    _loadChunksForCurrentTime(t);
  }

  function onPlayOrSeek() {
    if (!AppState.karaokeEnabled) return;
    if (_seekDebounceTimer) clearTimeout(_seekDebounceTimer);
    _seekDebounceTimer = setTimeout(_seekDebounceFire, SEEK_DEBOUNCE_MS);
  }

  /** Synchronously fire the pending trailing-edge callback (debug-panel only).
   *  Returns true if a timer was pending and got flushed; false if there was
   *  nothing to flush. Lets the Stage-3 robustness tests assert exact fire
   *  counts without sleeping past SEEK_DEBOUNCE_MS. */
  function _flushSeekDebounce() {
    if (_seekDebounceTimer === null) return false;
    clearTimeout(_seekDebounceTimer);
    _seekDebounceFire();
    return true;
  }

  /** Visibility recovery (Stage 3). When the tab returns to visible, kick the
   *  loader once with the current time. Browser throttles or fully suspends
   *  rAF / setInterval / setTimeout in background tabs (especially aggressive
   *  on iOS Safari), so the heartbeat may not have advanced for minutes while
   *  hidden. Without this hook, the user resuming a backgrounded tab waits up
   *  to one heartbeat tick before the next chunk request — visible as a
   *  karaoke gap right at the moment they refocus. The hidden-side transition
   *  is intentionally a no-op: there's nothing to do when leaving the tab. */
  function _onVisibilityChange() {
    if (typeof document === 'undefined') return;
    if (document.visibilityState !== 'visible') return;
    if (!AppState.karaokeEnabled) return;
    _visibilityRecoveryFires++;
    var t = (AppState.player && typeof AppState.player.getCurrentTime === 'function')
      ? AppState.player.getCurrentTime() : 0;
    _loadChunksForCurrentTime(t);
  }

  /** The actual scheduling loop. Honors all the gates per §6 Phase 3 step 5
   *  (pause gating) and §5 C1 (skip when not original language).
   *
   *  Phase 4: short-video bypass takes priority. When duration is known AND
   *  ≤ SHORT_VIDEO_THRESHOLD_SEC (300s), one call to /api/karaoke-words-short
   *  fetches the entire video's words in a single shot and we skip the
   *  chunked loader entirely (chunking has more overhead than value at that
   *  size). Same Supabase cache, same RPC accounting on the server. */
  function _loadChunksForCurrentTime(t) {
    if (!AppState.karaokeEnabled) return;
    if (AppState.karaokeSessionFatal) return;
    if (!KaraokeStore.isOriginalVisible()) return;     // §5 C1
    // Pause gating per §6 Phase 3 step 5: only fire while playing. The
    // YT player state enum: 1 = playing.
    var ps = AppState.player && typeof AppState.player.getPlayerState === 'function'
      ? AppState.player.getPlayerState() : -1;
    if (ps !== 1) return;

    var dur = (AppState.player && typeof AppState.player.getDuration === 'function')
      ? AppState.player.getDuration() : 0;

    // Phase 4: short-video bypass. If duration is known AND ≤ threshold,
    // route to the single-call short endpoint instead of chunking. The
    // bypass owns the rest of this tick; chunked loader doesn't fall through.
    // Once the call is in-flight or done, subsequent ticks no-op via the
    // guard flags (same idempotency pattern as the chunk loader's
    // `_chunksLoaded` / `_inFlight`).
    if (dur > 0 && dur <= SHORT_VIDEO_THRESHOLD_SEC) {
      if (_shortVideoBypassFired || _shortVideoBypassInFlight) return;
      _fetchShortVideo(dur);
      return;
    }

    var needed = _neededChunks(t, dur);
    for (var i = 0; i < needed.length; i++) {
      var c = needed[i];
      var key = _chunkKey(c.start, c.dur);
      if (_chunksLoaded.has(key)) continue;
      if (_chunksReadyOrFatal.has(key)) continue;
      if (_inFlight.has(key)) continue;
      if (_inFlight.size >= MAX_INFLIGHT) break;
      var cooldownUntil = _errorCooldown.get(key) || 0;
      if (Date.now() < cooldownUntil) continue;
      _fetchChunk(key, c.start, c.dur);
    }
  }

  /** Phase 4: short-video single-call fetch. Fires AT MOST ONCE per video
   *  (gated by `_shortVideoBypassFired` + `_shortVideoBypassInFlight`).
   *  Reuses the chunk-loader's success/error machinery so behavior is
   *  consistent: success path populates _words + _loadedRanges + paints
   *  spans; retryable errors set a cooldown and clear the in-flight flag so
   *  the next heartbeat tick can retry; non-retryable errors call the same
   *  `_handleNonRetryableError` (cap_hit / circuit_open → session-fatal +
   *  toast). Network/parse failures route through `_captureFetchExceptionToSentry`. */
  async function _fetchShortVideo(dur) {
    _shortVideoBypassInFlight = true;
    AppState.karaokeChunksRequested = (AppState.karaokeChunksRequested || 0) + 1;
    var key = 'short:0:' + Math.round(dur);

    try {
      var lang = (AppState.videoData && AppState.videoData.lang) || '';
      var videoIdForChunk = _resolvedVideoIdForKaraoke();
      if (!videoIdForChunk) {
        return;
      }
      var res = await RecapSharkAPI.karaokeWordsShort(
        videoIdForChunk, lang
      );

      if (res && res.error) {
        if (res.retryable) {
          var cd = (typeof res.cooldown_ms === 'number' && res.cooldown_ms > 0)
            ? res.cooldown_ms : DEFAULT_ERROR_COOLDOWN_MS;
          _errorCooldown.set(key, Date.now() + cd);
          // Schedule another attempt by clearing only the in-flight flag,
          // not the fired flag — next heartbeat will retry once cooldown elapses.
        } else {
          _handleNonRetryableError(res.error, key);
          _shortVideoBypassFired = true;  // give up for this session
        }
        AppState.karaokeChunksFailed = (AppState.karaokeChunksFailed || 0) + 1;
        return;
      }

      // Success path
      _shortVideoBypassFired = true;
      _shortVideoBypassFiredCount++;
      if (res && res.cached) {
        AppState.karaokeChunksCacheHits = (AppState.karaokeChunksCacheHits || 0) + 1;
      } else {
        AppState.karaokeChunksFetched = (AppState.karaokeChunksFetched || 0) + 1;
      }

      KaraokeStore.addLoadedRange(0, dur);
      KaraokeStore.addWords(res.words || []);

      if (KaraokeStore.isOriginalVisible()) {
        _applyWordSpansForActivePanel();
      }
    } catch (e) {
      _errorCooldown.set(key, Date.now() + DEFAULT_ERROR_COOLDOWN_MS);
      AppState.karaokeChunksFailed = (AppState.karaokeChunksFailed || 0) + 1;
      _captureFetchExceptionToSentry(e, key, 0, dur);
    } finally {
      _shortVideoBypassInFlight = false;
    }
  }

  /** Stage 4 helper. Forwards a thrown exception from `_fetchChunk` to Sentry
   *  with the canonical `feature: 'lazy-karaoke'` tag (D37) plus error_code +
   *  chunk coordinates as breadcrumb context. Safe no-op when Sentry isn't
   *  loaded (DSN missing or SDK init skipped) so dev / token-less builds
   *  don't crash. */
  function _captureFetchExceptionToSentry(err, key, start, dur) {
    _sentryCapturesFromFetch++;
    if (typeof window === 'undefined') return;
    if (!window.Sentry || typeof window.Sentry.captureException !== 'function') return;
    try {
      window.Sentry.captureException(err, {
        tags: {
          feature: 'lazy-karaoke',
          error_code: 'fetch_threw',
        },
        extra: {
          chunk_key: key,
          chunk_start: start,
          chunk_dur: dur,
          videoId: _resolvedVideoIdForKaraoke() || '(unknown)',
        },
      });
    } catch (_swallow) {
      // Sentry SDK should never throw, but if it does, don't take down the
      // chunk loader. The original exception is already accounted for via
      // the cooldown + counter increment in the caller.
    }
  }

  /** Stage 4 helper. Handles a non-retryable graceful error envelope from the
   *  chunk endpoint. cap_hit / circuit_open are session-fatal (sets the
   *  AppState flag so `_loadChunksForCurrentTime` early-returns for the rest
   *  of the session, AND fires a single user-visible toast). audio_unavailable
   *  is chunk-fatal only (just stop retrying THAT chunk). Per D37 graceful
   *  errors (200-with-error-body) are NOT raised exceptions, so they do NOT
   *  go to Sentry — that fire-hose stays for actual unhandled bugs. */
  function _handleNonRetryableError(errorCode, key) {
    _chunksReadyOrFatal.add(key);
    if (Object.prototype.hasOwnProperty.call(SESSION_FATAL_TOASTS, errorCode)) {
      AppState.karaokeSessionFatal = true;
      if (!_sessionFatalToastShown) {
        _sessionFatalToastShown = true;
        _sessionFatalToastShownCount++;
        if (typeof window !== 'undefined' && typeof window.showToast === 'function') {
          window.showToast(SESSION_FATAL_TOASTS[errorCode]);
        }
      }
    }
  }

  /** Single-chunk fetch + merge. Stage 2 brought success + retryable
   *  cooldown + non-retryable chunk-fatal marking; Stage 4 adds session-fatal
   *  toast (cap_hit / circuit_open) and Sentry capture for thrown exceptions
   *  in the catch block. Graceful 200-with-error responses (cap_hit,
   *  audio_not_ready, etc.) intentionally do NOT go to Sentry per D37 — only
   *  actual unhandled exceptions do. */
  async function _fetchChunk(key, start, dur) {
    _inFlight.set(key, true);
    AppState.karaokeChunksRequested = (AppState.karaokeChunksRequested || 0) + 1;

    try {
      var lang = (AppState.videoData && AppState.videoData.lang) || '';
      var videoIdForChunk = _resolvedVideoIdForKaraoke();
      if (!videoIdForChunk) {
        return;
      }
      // Phase 5 telemetry: pass video_duration so the [KARAOKE-DAILY] savings
      // metric uses the real number, not a chunk-end fallback. Pulled from
      // the YT player API; falls back to AppState.videoData.duration if the
      // player isn't ready (rare — by the time chunks fire, it usually is).
      var vidDur =
        (AppState.player && typeof AppState.player.getDuration === 'function' && AppState.player.getDuration()) ||
        (AppState.videoData && AppState.videoData.duration) ||
        0;
      var res = await RecapSharkAPI.karaokeChunk(
        videoIdForChunk, start, dur, lang, vidDur
      );

      if (res && res.error) {
        if (res.retryable) {
          // Server-driven cooldown per §14 D33 — fall back to a default
          // when the envelope omits it, but normal envelopes always include.
          var cd = (typeof res.cooldown_ms === 'number' && res.cooldown_ms > 0)
            ? res.cooldown_ms : DEFAULT_ERROR_COOLDOWN_MS;
          _errorCooldown.set(key, Date.now() + cd);
        } else {
          // Non-retryable terminal error: chunk-fatal for audio_unavailable,
          // session-fatal + toast for cap_hit / circuit_open (Stage 4 helper).
          _handleNonRetryableError(res.error, key);
        }
        AppState.karaokeChunksFailed = (AppState.karaokeChunksFailed || 0) + 1;
        return;
      }

      // Success path
      _chunksLoaded.add(key);
      _chunksReadyOrFatal.add(key);
      if (res && res.cached) {
        AppState.karaokeChunksCacheHits = (AppState.karaokeChunksCacheHits || 0) + 1;
      } else {
        AppState.karaokeChunksFetched = (AppState.karaokeChunksFetched || 0) + 1;
      }

      KaraokeStore.addLoadedRange(start, start + dur);
      KaraokeStore.addWords(res.words || []);

      // Only paint spans if the user is currently looking at the original
      // language. If they switched to translated mid-flight, words land in
      // _words for later — syncWord's apply-path self-heal will pick them
      // up when the user switches back. §5 C1 / C7.
      if (KaraokeStore.isOriginalVisible()) {
        _applyWordSpansForActivePanel();
      }
    } catch (e) {
      // Network/parse failure — actual thrown exception, NOT a graceful
      // 200-with-error response. Short cooldown + Sentry capture per D37 so
      // real bugs surface in the inbox without flooding it with the routine
      // graceful failures the server returns as 200s.
      _errorCooldown.set(key, Date.now() + DEFAULT_ERROR_COOLDOWN_MS);
      AppState.karaokeChunksFailed = (AppState.karaokeChunksFailed || 0) + 1;
      _captureFetchExceptionToSentry(e, key, start, dur);
    } finally {
      _inFlight.delete(key);
    }
  }

  // ── Debug-panel access (only used by __KaraokeDebug in karaoke.js) ───────
  // The debug panel + test suites need to inspect / reset internals to assert
  // behaviour. Production code MUST NOT use these; only the gated test panel.
  function _debugInternals() {
    return {
      // State refs (test inspect / mutate)
      _chunksLoaded, _chunksReadyOrFatal, _inFlight, _errorCooldown,
      get _seekDebounceTimer() { return _seekDebounceTimer; },
      // Counters (test assertions)
      get _maybeScheduleChunkLoadCalls() { return _maybeScheduleChunkLoadCalls; },
      get _seekDebounceFires() { return _seekDebounceFires; },
      get _visibilityRecoveryFires() { return _visibilityRecoveryFires; },
      get _sessionFatalToastShownCount() { return _sessionFatalToastShownCount; },
      get _sentryCapturesFromFetch() { return _sentryCapturesFromFetch; },
      get _shortVideoBypassFiredCount() { return _shortVideoBypassFiredCount; },
      get _sessionFatalToastShown() { return _sessionFatalToastShown; },
      get _shortVideoBypassFired() { return _shortVideoBypassFired; },
      get _shortVideoBypassInFlight() { return _shortVideoBypassInFlight; },
      // Internals exposed for direct test calls
      _chunkKey,
      _neededChunks,
      _captureFetchExceptionToSentry,
      _handleNonRetryableError,
      _onVisibilityChange,
      _loadChunksForCurrentTime,
      _flushSeekDebounce,
      _resetForDebugTest,
      _fetchShortVideo,
      // Constants
      FIRST_CHUNK_DUR, STEADY_CHUNK_DUR, WINDOW_BACK, WINDOW_FWD,
      MAX_INFLIGHT, HEARTBEAT_THROTTLE_MS, SEEK_DEBOUNCE_MS,
      DEFAULT_ERROR_COOLDOWN_MS, SHORT_VIDEO_THRESHOLD_SEC,
      SESSION_FATAL_TOASTS,
    };
  }

  return {
    // Lifecycle
    setup, attachVisibilityListener, resetState,
    // Trigger paths
    maybeScheduleChunkLoad, onPlayOrSeek,
    // Public constants — exported so callers outside this module (e.g. the
    // paste-time karaoke warm in `orchestrator/process-url-fetch.js`) can
    // route through the SAME values the chunk-loader uses, instead of
    // re-hardcoding magic numbers that would silently desync if the grid
    // is ever retuned. `npm run check:chunk-grid` only validates FE↔BE
    // parity — these exports cover the within-FE side.
    FIRST_CHUNK_DUR,
    STEADY_CHUNK_DUR,
    SHORT_VIDEO_THRESHOLD_SEC,
    // Debug-only (gated behind ?karaoke_debug=1)
    _debugInternals,
  };
})();
