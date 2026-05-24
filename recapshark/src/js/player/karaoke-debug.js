// karaoke-debug.js
//
// Floating debug panel + ?karaoke_debug=1 entry point.
//
// Owns: __KaraokeDebug exposure (the bridge object that lets test suites
//       and diagnostics reach into the karaoke subsystem without importing
//       internals), _injectFakeChunk + _clearKaraokeDOM debug actions,
//       the floating panel UI with mobile-friendly button row, button
//       click wiring.
// Does NOT own: the eight scripted test suites (live in
//       `karaoke-debug-tests.js`) or the diagnostic state-dump (lives
//       in `karaoke-debug-diag.js`). Phase 4c #1 (2026-05-08) split this
//       file from 1391 LOC down to ~360 LOC by extracting tests + diag —
//       the panel UI + the bridge object are now the only two concerns
//       this file carries.
// Reads from karaoke-store / karaoke-chunk-loader / karaoke-analytics /
//       karaoke-dom — every state slot the bridge exposes lives in those
//       modules; this file just rewires them to a window.__KaraokeDebug
//       shape the tests + diag both expect.
// Imports allowed: ../core/state, ../core/helpers, ../core/constants,
//       ./karaoke-store, ./karaoke-chunk-loader, ./karaoke-analytics,
//       ./karaoke-dom, ./karaoke-debug-tests, ./karaoke-debug-diag.
// Coupling notes: receives `syncWord` (the public KaraokeManager.syncWord)
//       via installKaraokeDebugPanel({ syncWord }) instead of importing
//       karaoke.js — keeps the import DAG acyclic (karaoke.js dynamic-
//       imports this file only when ?karaoke_debug=1 is in the URL,
//       never the other way around).
//
// Production bundle gate: dynamic import in karaoke.js is wrapped in
//       `import.meta.env.DEV`, so all three files (this one + tests +
//       diag) end up in dev-only chunks that Vite drops from the prod
//       build. Verified post-build at K3 (2026-05-07) — see
//       docs/_logs/STATUS.md Done table for the verification receipts.

import { AppState } from '../core/state.js';
import { Helpers } from '../core/helpers.js';
import { COPY_BUTTON_RESET_MS } from '../core/constants.js';
import { KaraokeStore } from './karaoke-store.js';
import { KaraokeChunkLoader } from './karaoke-chunk-loader.js';
import { KaraokeAnalytics } from './karaoke-analytics.js';
import { KaraokeDom } from './karaoke-dom.js';
import {
  runPhase2HelperTests,
  runPhase2RenderingTests,
  runPhase2SyncWordTests,
  runPhase3RobustnessTests,
  runPhase3ErrorHandlingTests,
  runPhase3TelemetryTests,
  runPhase4ShortVideoTests,
  runPhase2SentryTest,
} from './karaoke-debug-tests.js';
import { makeDiagnosticDump } from './karaoke-debug-diag.js';

/**
 * Install the __KaraokeDebug exposure + inject the floating panel into the page.
 *
 * Called by karaoke.js's URL-flag-gated dynamic import block. Receives the
 * public `syncWord` function and the active `lookaheadMs` value as deps so
 * we don't have to back-import the KaraokeManager (load-order tangle) and
 * so the diagnostic dump can show the live lookahead value.
 *
 * Idempotent: a second call is a no-op (the `_injectPanel` guard checks
 * `document.getElementById('__karaoke-dbg-panel')`).
 */
export function installKaraokeDebugPanel({ syncWord, lookaheadMs }) {
  // Cycles 7a + 7b: __KaraokeDebug bridges to the extracted modules (store /
  // chunk-loader / analytics / align / dom / wave) for the symbols those
  // modules own. Same exposed shape as before so the test suites + the
  // diagnostic dump don't need changes.
  var _cli = KaraokeChunkLoader._debugInternals();
  var _ana = KaraokeAnalytics._debugInternals();
  // Bridge refs to store-owned arrays (in-place mutation discipline means
  // these refs stay valid across resets / video swaps — store NEVER
  // reassigns the underlying arrays). Same pattern as karaoke-wave.js.
  // Re-fetch via KaraokeStore.get*() in any test that needs a fresh view
  // post-reset; the panel-level dump + _injectFakeChunk paths read these.
  var _words = KaraokeStore.getWords();
  var _loadedRanges = KaraokeStore.getLoadedRanges();
  // Defensive default mirrors karaoke.js's desktop fallback so the dump
  // shows a real number even if someone calls install without the dep.
  var _lookaheadMs = (typeof lookaheadMs === 'number') ? lookaheadMs : -350;
  window.__KaraokeDebug = {
    _addWords: KaraokeStore.addWords,
    _addLoadedRange: KaraokeStore.addLoadedRange,
    _isRowFullyCoveredByLoadedWords: KaraokeStore.isRowFullyCoveredByLoadedWords,
    _hasOriginalTextVisible: KaraokeStore.isOriginalVisible,
    _wordKey: KaraokeStore.wordKey,
    _state: function() {
      var loaded = KaraokeStore.getLoadedRanges();
      return {
        _words: KaraokeStore.getWords().slice(),
        _wordKeySet: [],  // moved to store-internal; size + presence checks live in tests via _addWords flow
        _loadedRanges: loaded.map(function(r) { return { start: r.start, end: r.end }; }),
        _wordElByKeySize: KaraokeStore.getWordElByKeyMap().size,
        _synthWords: KaraokeStore.getSynthWords().slice(),
      };
    },
    _resetLazyState: function() {
      // Store.resetState() already clears every Map/array/scalar including
      // _wordElByKey + _wordElsByKey + _wordEls + _synthWords. No manual
      // reset needed here.
      KaraokeStore.resetState();
      KaraokeChunkLoader.resetState();
    },
    // ── Milestone B exposures ──
    _apply: KaraokeDom.applyWordSpansForActivePanel,
    _getActivePanel: KaraokeDom.getActivePanel,
    // ── Milestone C exposures ──
    _syncWord: syncWord,
    _maybeScheduleChunkLoadCallCount: function() { return _cli._maybeScheduleChunkLoadCalls; },
    _resetMaybeScheduleChunkLoadCount: function() { _cli._resetForDebugTest(); },
    // ── Phase 3 exposures ──
    _chunksLoaded: function() { return Array.from(_cli._chunksLoaded); },
    _chunksReadyOrFatal: function() { return Array.from(_cli._chunksReadyOrFatal); },
    _inFlight: function() { return Array.from(_cli._inFlight.keys()); },
    _errorCooldown: function() {
      var out = {};
      var now = Date.now();
      _cli._errorCooldown.forEach(function(until, key) {
        out[key] = Math.max(0, Math.round((until - now) / 1000)) + 's';
      });
      return out;
    },
    // ── Stage 3 robustness exposures ──
    _onPlayOrSeek: KaraokeChunkLoader.onPlayOrSeek,
    _onVisibilityChange: _cli._onVisibilityChange,
    _seekDebounceFires: function() { return _cli._seekDebounceFires; },
    _visibilityRecoveryFires: function() { return _cli._visibilityRecoveryFires; },
    _resetStage3Counters: function() { _cli._resetForDebugTest(); },
    _seekDebounceTimerActive: function() { return _cli._seekDebounceTimer !== null; },
    _flushSeekDebounce: function() { return _cli._flushSeekDebounce(); },
    // ── Stage 4 error-handling exposures ──
    _handleNonRetryableError: _cli._handleNonRetryableError,
    _captureFetchExceptionToSentry: _cli._captureFetchExceptionToSentry,
    _sessionFatalToastShown: function() { return _cli._sessionFatalToastShown; },
    _sessionFatalToastShownCount: function() { return _cli._sessionFatalToastShownCount; },
    _sentryCapturesFromFetch: function() { return _cli._sentryCapturesFromFetch; },
    _sessionFatalToastCopy: function(code) { return _cli.SESSION_FATAL_TOASTS[code] || null; },
    _resetStage4Counters: function() { AppState.karaokeSessionFatal = false; _cli._resetForDebugTest(); },
    // ── Stage 5 telemetry exposures ──
    _emitSessionEndLog: _ana._emitSessionEndLog,
    _onSessionLifecycleEvent: _ana._onSessionLifecycleEvent,
    _sessionEndLogFired: function() { return _ana._sessionEndLogFired; },
    _sessionEndLogFiredCount: function() { return _ana._sessionEndLogFiredCount; },
    _resetStage5Counters: function() { KaraokeAnalytics.resetState(); },
    // ── Phase 4 short-video bypass exposures ──
    _fetchShortVideo: function(dur) { return _cli._fetchShortVideo(dur); },
    _shortVideoBypassFired: function() { return _cli._shortVideoBypassFired; },
    _shortVideoBypassInFlight: function() { return _cli._shortVideoBypassInFlight; },
    _shortVideoBypassFiredCount: function() { return _cli._shortVideoBypassFiredCount; },
    _shortVideoThresholdSec: function() { return _cli.SHORT_VIDEO_THRESHOLD_SEC; },
    _resetPhase4State: function() { _cli._resetForDebugTest(); },
    /**
     * Generate fake-but-correctly-timed words from the real rendered transcript
     * for rows whose start time lies in [start, start + dur). Adds them to
     * `_words` + extends `_loadedRanges` by [start, start + dur]. Returns a
     * report so the panel can show how many rows/words were touched.
     * Used for visual + DOM-assertion testing of the apply paths without
     * needing a real AsrProvider call.
     */
    _injectFakeChunk: function(start, dur) {
      var found = _findTranscriptRowsAnywhere();
      if (!found) return { error: 'no transcript rows in document — paste a video and wait' };
      var panel = found.container;
      var allRows = Array.from(found.rows);

      var rangeEnd = start + dur;
      var fakeWords = [];
      var rowsConsidered = 0;

      allRows.forEach(function(row, i) {
        var chip = row.querySelector('.ts-chip');
        var tsText = row.querySelector('.ts-text');
        if (!chip || !tsText) return;
        var rowStart = Number(chip.dataset.time);
        if (rowStart >= rangeEnd || rowStart < start) return;

        var text = (tsText.textContent || '').trim();
        if (!text) return;
        var words = text.split(/\s+/);

        var nextChip = null;
        for (var j = i + 1; j < allRows.length; j++) {
          nextChip = allRows[j].querySelector('.ts-chip');
          if (nextChip) break;
        }
        var rowEnd = nextChip ? Number(nextChip.dataset.time) : rangeEnd;
        if (rowEnd <= rowStart) rowEnd = rowStart + 5;
        var per = (rowEnd - rowStart) / Math.max(1, words.length);

        words.forEach(function(w, wi) {
          var s = rowStart + wi * per;
          var e = s + Math.max(0.05, per * 0.9);
          fakeWords.push({ word: w, start: s, end: e, confidence: 0.95, chunk_local_idx: wi });
        });
        rowsConsidered++;
      });

      KaraokeStore.addWords(fakeWords);
      KaraokeStore.addLoadedRange(start, rangeEnd);
      KaraokeDom.applyWordSpansForActivePanel();

      var spansInRange = 0, spansOutOfRange = 0;
      allRows.forEach(function(row) {
        var chip = row.querySelector('.ts-chip');
        var tsText = row.querySelector('.ts-text');
        if (!chip || !tsText) return;
        var rowStart = Number(chip.dataset.time);
        var count = tsText.querySelectorAll('.k-word').length;
        if (rowStart < rangeEnd && rowStart >= 0) spansInRange += count;
        else spansOutOfRange += count;
      });

      return {
        rangeRequested: '[' + start + ', ' + rangeEnd + ']',
        rowsConsidered: rowsConsidered,
        fakeWordsAdded: fakeWords.length,
        totalWordsNow: _words.length,
        loadedRangesNow: _loadedRanges.map(function(r) { return '[' + r.start + ', ' + r.end + ']'; }).join(' '),
        spansInRange: spansInRange,
        spansOutOfRange: spansOutOfRange,
      };
    },
    /**
     * Wipe karaoke spans + dataset markers from the active panel and clear
     * the lazy state. Lets us re-test from a clean slate without reloading.
     */
    _clearKaraokeDOM: function() {
      var found = _findTranscriptRowsAnywhere();
      var spansRemoved = 0, markersCleared = 0;
      if (found) {
        var panel = found.container;
        var marked = panel.querySelectorAll('[data-karaoke-state]');
        spansRemoved = panel.querySelectorAll('.k-word').length;
        marked.forEach(function(el) {
          // Setting textContent collapses all child spans+text-nodes into one
          // plain text node, restoring the row to its pre-karaoke state.
          el.textContent = el.textContent;
          delete el.dataset.karaokeState;
          markersCleared++;
        });
      }
      KaraokeStore.resetState();
      KaraokeChunkLoader.resetState();
      return { spansRemovedReportPre: spansRemoved, markersCleared: markersCleared };
    },
  };

  /**
   * Find the container holding transcript rows, wherever it lives.
   * Tries the karaoke-active panel first (production code path), then falls
   * back to a document-wide search so the debug actions work regardless of
   * which container actually holds the rows. Returns { container, rows,
   * source } or null. Mirrors the same-named helper in
   * karaoke-debug-tests.js — kept local here so the bridge's
   * _injectFakeChunk + _clearKaraokeDOM don't have to reach across files.
   */
  function _findTranscriptRowsAnywhere() {
    var panel = KaraokeDom.getActivePanel();
    if (panel) {
      var rows = panel.querySelectorAll('.transcript-line, .transcript-paragraph');
      if (rows.length) return { container: panel, rows: rows, source: 'active panel' };
    }
    var docRows = document.querySelectorAll('.transcript-line, .transcript-paragraph');
    if (!docRows.length) return null;
    // Walk up from the first row to find the nearest ancestor that contains
    // ALL of them — that's the real "container".
    var parent = docRows[0].parentElement;
    while (parent && parent.querySelectorAll('.transcript-line, .transcript-paragraph').length < docRows.length) {
      parent = parent.parentElement;
    }
    return { container: parent || docRows[0].parentElement, rows: docRows, source: 'doc-wide fallback' };
  }

  // The diagnostic dump needs cli/ana/lookaheadMs from this closure;
  // the test suites read all their state through window.__KaraokeDebug
  // (which we just set up above), so they don't need any deps.
  var _runDiagnosticDump = makeDiagnosticDump({
    cli: _cli,
    ana: _ana,
    lookaheadMs: _lookaheadMs,
  });

  // ── Inject floating debug panel ──
  function _injectPanel() {
    if (!document.body) { setTimeout(_injectPanel, 100); return; }
    if (document.getElementById('__karaoke-dbg-panel')) return;

    var panel = document.createElement('div');
    panel.id = '__karaoke-dbg-panel';
    // Anchor to bottom-right (used to be top-right) so on mobile the
    // panel doesn't sit ON TOP of the video frame and block the play
    // button. Mobile keeps the panel collapsed to ~30vh so most of
    // the video stays tappable; user can scroll inside the panel for
    // the rest of the diagnostics.
    var _isNarrow = window.matchMedia && Helpers.isNarrowViewport();
    panel.style.cssText = [
      'position:fixed', 'bottom:max(8px,env(safe-area-inset-bottom))',
      'right:max(8px,env(safe-area-inset-right))', 'z-index:2147483647',
      'background:#101418', 'color:#e8edf2',
      'font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace',
      'padding:10px', 'border:1px solid #2a3038', 'border-radius:8px',
      _isNarrow ? 'max-width:min(360px,92vw)' : 'max-width:min(420px,92vw)',
      _isNarrow ? 'max-height:30vh' : 'max-height:75vh',
      'overflow:auto',
      'box-shadow:0 8px 24px rgba(0,0,0,0.55)'
    ].join(';');
    var btnStyle = 'font:12px ui-monospace,monospace;padding:6px 10px;color:#fff;border:0;border-radius:4px;cursor:pointer;';
    panel.innerHTML =
      '<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">' +
        '<strong style="margin-right:4px;color:#7cd4ff;">karaoke debug</strong>' +
        '<button id="__karaoke-dbg-run-a" style="' + btnStyle + 'background:#3a86ff;">▶ A: helpers</button>' +
        '<button id="__karaoke-dbg-run-b" style="' + btnStyle + 'background:#7c3aff;">▶ B: rendering</button>' +
        '<button id="__karaoke-dbg-run-c" style="' + btnStyle + 'background:#0fb88a;">▶ C: syncWord</button>' +
        '<button id="__karaoke-dbg-run-d" style="' + btnStyle + 'background:#9b59b6;">▶ D: robustness</button>' +
        '<button id="__karaoke-dbg-run-f" style="' + btnStyle + 'background:#e74c3c;">▶ F: errors</button>' +
        '<button id="__karaoke-dbg-run-g" style="' + btnStyle + 'background:#16a085;">▶ G: telemetry</button>' +
        '<button id="__karaoke-dbg-run-h" style="' + btnStyle + 'background:#2980b9;">▶ H: short-video</button>' +
        '<button id="__karaoke-dbg-run-e" style="' + btnStyle + 'background:#ff6b3a;">▶ E: Sentry</button>' +
        '<button id="__karaoke-dbg-run-diag" style="' + btnStyle + 'background:#d4a017;">🔍 Diagnose</button>' +
        '<button id="__karaoke-dbg-copy" style="' + btnStyle + 'background:#2a3038;">📋 Copy</button>' +
        '<button id="__karaoke-dbg-close" style="' + btnStyle + 'background:#2a3038;margin-left:auto;">✕</button>' +
      '</div>' +
      '<pre id="__karaoke-dbg-out" style="margin:10px 0 0 0;white-space:pre-wrap;word-break:break-word;color:#cfd8e3;">A = helper unit tests (no video needed)\nB = rendering tests (paste a video first)\nC = syncWord reorder tests (no video needed)\nD = stage-3 robustness: seek debounce + visibility recovery (no video needed)\nF = stage-4 error handling: cap_hit/circuit_open toast + Sentry capture (no video needed)\nG = stage-5 telemetry: per-session Sentry breadcrumb on session end (no video needed)\nH = phase-4 short-video bypass: ≤300s videos use single-call endpoint (no video needed)\nE = Sentry test exception (then check Sentry inbox)</pre>';
    document.body.appendChild(panel);

    var out = panel.querySelector('#__karaoke-dbg-out');
    var copyBtn = panel.querySelector('#__karaoke-dbg-copy');

    function _runAndShow(testFn) {
      function _show(res) {
        out.textContent = res.text;
        out.style.color = res.failed === 0 ? '#9be29b' : '#ff8a8a';
      }
      try {
        var ret = testFn();
        // Async-aware: some suites (e.g. ▶ H short-video) await stubbed
        // fetches, so the runner returns a Promise. Sync suites still
        // return the result object directly.
        if (ret && typeof ret.then === 'function') {
          out.textContent = 'Running…';
          out.style.color = '#cfd8e3';
          ret.then(_show).catch(function(e) {
            out.textContent = 'ERROR: ' + (e && e.stack || e);
            out.style.color = '#ff8a8a';
          });
        } else {
          _show(ret);
        }
      } catch (e) {
        out.textContent = 'ERROR: ' + (e && e.stack || e);
        out.style.color = '#ff8a8a';
      }
    }

    panel.querySelector('#__karaoke-dbg-run-a').addEventListener('click', function() {
      _runAndShow(runPhase2HelperTests);
    });
    panel.querySelector('#__karaoke-dbg-run-b').addEventListener('click', function() {
      _runAndShow(runPhase2RenderingTests);
    });
    panel.querySelector('#__karaoke-dbg-run-c').addEventListener('click', function() {
      _runAndShow(runPhase2SyncWordTests);
    });
    panel.querySelector('#__karaoke-dbg-run-d').addEventListener('click', function() {
      _runAndShow(runPhase3RobustnessTests);
    });
    panel.querySelector('#__karaoke-dbg-run-f').addEventListener('click', function() {
      _runAndShow(runPhase3ErrorHandlingTests);
    });
    panel.querySelector('#__karaoke-dbg-run-g').addEventListener('click', function() {
      _runAndShow(runPhase3TelemetryTests);
    });
    panel.querySelector('#__karaoke-dbg-run-h').addEventListener('click', function() {
      _runAndShow(runPhase4ShortVideoTests);
    });
    panel.querySelector('#__karaoke-dbg-run-e').addEventListener('click', function() {
      _runAndShow(runPhase2SentryTest);
    });
    panel.querySelector('#__karaoke-dbg-run-diag').addEventListener('click', function() {
      _runAndShow(_runDiagnosticDump);
    });

    copyBtn.addEventListener('click', function() {
      var text = out.textContent || '';
      if (!text) return;
      var done = function() {
        var orig = copyBtn.textContent;
        copyBtn.textContent = '✓ Copied';
        setTimeout(function() { copyBtn.textContent = orig; }, COPY_BUTTON_RESET_MS);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, function() {
          // Fallback for non-secure contexts
          var ta = document.createElement('textarea');
          ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
          document.body.appendChild(ta); ta.select();
          try { document.execCommand('copy'); done(); } catch (_) {}
          document.body.removeChild(ta);
        });
      }
    });

    panel.querySelector('#__karaoke-dbg-close').addEventListener('click', function() {
      panel.remove();
    });
  }
  _injectPanel();

}
