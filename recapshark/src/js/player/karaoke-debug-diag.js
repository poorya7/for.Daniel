// karaoke-debug-diag.js
//
// Diagnostic state-dump for the karaoke debug panel. Single-shot snapshot
// of every value relevant to "why isn't karaoke appearing right now?" —
// kill switch, mode, display mode, player state, counters, words / loaded
// ranges, panels + their row counts, applied span counts, active in-flight
// chunks, error cooldowns. Designed for one-tap copy on mobile without
// DevTools.
//
// Extracted from karaoke-debug.js by Phase 4c #1 (2026-05-08) for SRP —
// the floating panel UI + the __KaraokeDebug bridge wiring stayed in
// karaoke-debug.js, the eight scripted test suites moved to
// karaoke-debug-tests.js, and this dump-the-world function lives here.
//
// Imports allowed: ../core/state, ../core/helpers,
//       ../translation/translation-state, ../ui/transcript-buffer,
//       ./karaoke-store. Other karaoke-side internals (_chunksLoaded,
//       _errorCooldown, _seekDebounceFires, _sessionEndLogFired, etc.)
//       flow in via the factory deps (cli + ana) so this file stays
//       agnostic about how those internals are exposed.
// Does NOT own: any production code path. Same dev-only chunk as
//       karaoke-debug.js (gated at karaoke.js's `import.meta.env.DEV`
//       dynamic import).

import { AppState } from '../core/state.js';
import { Helpers } from '../core/helpers.js';
import { tState } from '../translation/translation-state.js';
import { TranscriptBuffer } from '../ui/transcript-buffer.js';
import { KaraokeStore } from './karaoke-store.js';

/**
 * Build a `_runDiagnosticDump()` closure bound to live debug-internals
 * references from KaraokeChunkLoader + KaraokeAnalytics, and the active
 * highlight lookahead ms. Called once at karaoke-debug.js install time;
 * the returned function reads through to KaraokeStore + AppState on
 * every invocation so the snapshot is always fresh.
 *
 * `cli` and `ana` are the same objects returned by
 * `KaraokeChunkLoader._debugInternals()` and
 * `KaraokeAnalytics._debugInternals()` — by passing them in once at
 * setup we avoid re-fetching on every dump (and keep the dump file
 * import-free of those modules' debug entry points).
 */
export function makeDiagnosticDump({ cli, ana, lookaheadMs }) {
  return function _runDiagnosticDump() {
    var lines = [];
    function add(k, v) { lines.push(k + ': ' + v); }
    function safe(fn, fallback) { try { return fn(); } catch (_e) { return fallback; } }

    add('--- karaoke kill switch ---', '');
    add('AppState.karaokeEnabled', AppState.karaokeEnabled);
    add('AppState.karaokeMode', AppState.karaokeMode);
    add('AppState.karaokeSessionFatal', AppState.karaokeSessionFatal);
    add('highlight lookahead (ms)', lookaheadMs +
      ' (override via ?karaoke_lookahead=N)');
    add('AppState.currentVideoId', AppState.currentVideoId);
    add('AppState.videoData?.lang', (AppState.videoData && AppState.videoData.lang) || '(none)');
    add('AppState.videoData?.duration', (AppState.videoData && AppState.videoData.duration) || '(none)');
    add('AppState.currentLang', AppState.currentLang);

    add('', '');
    add('--- display state ---', '');
    add('tState.displayMode', safe(function() { return tState.displayMode; }, 'ERR'));
    add('_hasOriginalTextVisible()', safe(function() { return KaraokeStore.isOriginalVisible(); }, 'ERR'));

    add('', '');
    add('--- player state ---', '');
    var ps = (AppState.player && typeof AppState.player.getPlayerState === 'function')
      ? AppState.player.getPlayerState() : '(no player)';
    add('player.getPlayerState()', ps + ' (1=playing, 2=paused, 3=buffering)');
    var ct = (AppState.player && typeof AppState.player.getCurrentTime === 'function')
      ? AppState.player.getCurrentTime() : '(no player)';
    add('player.getCurrentTime()', ct);

    add('', '');
    add('--- chunk counters ---', '');
    add('chunks requested', AppState.karaokeChunksRequested || 0);
    add('chunks fetched (AsrProvider)', AppState.karaokeChunksFetched || 0);
    add('chunks cache hits', AppState.karaokeChunksCacheHits || 0);
    add('chunks failed', AppState.karaokeChunksFailed || 0);
    add('heartbeat-load calls (debug)', cli._maybeScheduleChunkLoadCalls);
    add('AppState.transcriptSyncRaf', AppState.transcriptSyncRaf == null ? 'null (heartbeat NOT running)' : 'set (heartbeat running)');
    add('AppState.trackerInterval', AppState.trackerInterval == null ? 'null' : 'set');
    add('seek-debounce fires (debug)', cli._seekDebounceFires);
    add('seek-debounce timer pending', cli._seekDebounceTimer !== null);
    add('visibility-recovery fires (debug)', cli._visibilityRecoveryFires);
    add('document.visibilityState', (typeof document !== 'undefined' ? document.visibilityState : 'n/a'));
    add('session-fatal toast shown (debug)', cli._sessionFatalToastShown);
    add('session-fatal toast count (debug)', cli._sessionFatalToastShownCount);
    add('Sentry captures from _fetchChunk (debug)', cli._sentryCapturesFromFetch);
    add('session-end log fired (debug)', ana._sessionEndLogFired);
    add('session-end log fired count (debug)', ana._sessionEndLogFiredCount);
    add('short-video bypass fired (debug)', cli._shortVideoBypassFired);
    add('short-video bypass in-flight (debug)', cli._shortVideoBypassInFlight);
    add('short-video bypass fired count (debug)', cli._shortVideoBypassFiredCount);
    add('short-video threshold (sec)', cli.SHORT_VIDEO_THRESHOLD_SEC);

    // Read words + loaded ranges fresh from the store on every dump (the
    // store's in-place mutation discipline means any closed-over ref from
    // install time would also be valid, but reading via KaraokeStore keeps
    // this file independent of install-time wiring).
    var words = KaraokeStore.getWords();
    var loadedRanges = KaraokeStore.getLoadedRanges();

    add('', '');
    add('--- words + ranges ---', '');
    add('_words.length', words.length);
    add('_loadedRanges', JSON.stringify(loadedRanges));
    add('_chunksLoaded', JSON.stringify(Array.from(cli._chunksLoaded)));
    add('_chunksReadyOrFatal', JSON.stringify(Array.from(cli._chunksReadyOrFatal)));
    add('_inFlight (keys)', JSON.stringify(Array.from(cli._inFlight.keys())));
    var cdNow = Date.now(); var cdOut = {};
    cli._errorCooldown.forEach(function(until, key) {
      cdOut[key] = Math.max(0, Math.round((until - cdNow) / 1000)) + 's left';
    });
    add('_errorCooldown', JSON.stringify(cdOut));

    add('', '');
    add('--- panels (transcript buffer) ---', '');
    var transBuf = safe(function() { return TranscriptBuffer.getActive('transcript'); });
    add('transcript buffer present', !!transBuf);
    if (transBuf) {
      add('  rows in transcript buffer',
        transBuf.querySelectorAll('.transcript-line, .transcript-paragraph').length);
      add('  bilingual-subs in transcript buffer',
        transBuf.querySelectorAll('.bilingual-sub').length);
      add('  k-word spans in transcript buffer',
        transBuf.querySelectorAll('.k-word').length);
    }

    add('', '');
    add('--- outer panel wrapper (mobile flat-transcript lives here) ---', '');
    var transWrap = document.getElementById('fullTranscriptPanel');
    add('#fullTranscriptPanel present', !!transWrap);
    if (transWrap) {
      add('  rows in #fullTranscriptPanel',
        transWrap.querySelectorAll('.transcript-line, .transcript-paragraph').length);
      add('  k-word spans in #fullTranscriptPanel',
        transWrap.querySelectorAll('.k-word').length);
      add('  display style (computed)',
        window.getComputedStyle(transWrap).display);
    }

    add('', '');
    add('--- doc-wide (sanity totals) ---', '');
    add('total .transcript-line/-paragraph in document',
      document.querySelectorAll('.transcript-line, .transcript-paragraph').length);
    add('total .bilingual-sub in document',
      document.querySelectorAll('.bilingual-sub').length);
    add('total .ts-sub in document',
      document.querySelectorAll('.ts-sub').length);
    add('total .ts-sub WITH text in document',
      Array.from(document.querySelectorAll('.ts-sub')).filter(function(s) { return (s.textContent || '').trim().length > 0; }).length);
    add('total .k-word in document',
      document.querySelectorAll('.k-word').length);
    add('panel.bilingual-active classes',
      Array.from(document.querySelectorAll('.bilingual-active')).map(function(p) { return p.id || p.tagName; }).join(', ') || '(none)');
    // Sample first 2 .ts-sub elements: text + visibility
    var sampleSubs = Array.from(document.querySelectorAll('.ts-sub')).slice(0, 2);
    sampleSubs.forEach(function(s, idx) {
      add('  sample .ts-sub[' + idx + '] text', JSON.stringify((s.textContent || '').slice(0, 60)));
      add('  sample .ts-sub[' + idx + '] computed display',
        window.getComputedStyle(s).display);
    });

    add('', '');
    add('--- asr_provider vs transcript word count ---', '');
    var rawText = AppState.transcriptRawText || '';
    var rawWordCount = rawText.split(/\s+/).filter(Boolean).length;
    add('words in AppState.transcriptRawText', rawWordCount);
    add('words from AsrProvider (_words.length)', words.length);
    add('  ratio asr_provider/raw',
      rawWordCount ? (words.length / rawWordCount).toFixed(2) : 'n/a');
    // First few transcript lines (raw) for visual comparison
    var rawSample = rawText.split('\n').filter(function(l) { return l.trim(); }).slice(0, 3);
    add('first 3 raw transcript lines', JSON.stringify(rawSample));

    add('', '');
    add('--- per-row sample (first 3 rows of transcript panel) ---', '');
    if (transWrap) {
      var sampleRows = Array.from(
        transWrap.querySelectorAll('.transcript-line, .transcript-paragraph')
      ).slice(0, 3);
      sampleRows.forEach(function(row, i) {
        var chip = row.querySelector('.ts-chip');
        var tsText = row.querySelector('.ts-text');
        var rowStart = chip ? Number(chip.dataset.time) : 'n/a';
        var spans = tsText ? tsText.querySelectorAll('.k-word') : [];
        var spanWords = Array.from(spans).map(function(s) { return s.textContent; }).join(' ');
        add('row ' + i + ' rowStart', rowStart);
        add('row ' + i + ' span count', spans.length);
        add('row ' + i + ' span text', spanWords || '(empty)');
        add('row ' + i + ' tsText.textContent length', tsText ? tsText.textContent.length : 'n/a');
      });
    } else {
      add('transcript panel not found', '');
    }

    add('', '');
    add('--- entity highlighter audit ---', '');
    add('window.EntityHighlighter present', !!window.EntityHighlighter);
    add('total entity-class spans in #fullTranscriptPanel',
      transWrap ? transWrap.querySelectorAll('.tx-name, .tx-org, .tx-date, .tx-num, .tx-gpe, .tx-event').length : 'n/a');

    add('', '');
    add('--- viewport ---', '');
    add('window.innerWidth', window.innerWidth);
    add('matches (max-width: 900px) [mobile]',
      Helpers.isNarrowViewport());

    return { text: lines.join('\n'), passed: 0, failed: 0 };
  };
}
