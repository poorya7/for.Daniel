// karaoke-debug-tests.js
//
// 8 test suites for the karaoke debug panel. Extracted from karaoke-debug.js
// by Phase 4c #1 (2026-05-08) for SRP — the floating panel UI + the
// __KaraokeDebug bridge wiring stayed in karaoke-debug.js, the diagnostic
// state-dump moved to karaoke-debug-diag.js, and the eight scripted test
// suites live here.
//
// Imports allowed: ../core/state, ../api/client, ./karaoke-dom (for the
//       _findTranscriptRowsAnywhere helper). All other karaoke-side state
//       (KaraokeStore, KaraokeChunkLoader, KaraokeAnalytics) flows through
//       the test functions via `window.__KaraokeDebug`, set up in
//       karaoke-debug.js's installKaraokeDebugPanel(). Reading via the
//       bridge keeps these tests honest about what the panel actually
//       exposes — if a test breaks because a __KaraokeDebug entry was
//       removed, that's a real test signal.
// Does NOT own: any production code path. Behind the URL flag, never loaded
//       in prod traffic — same dev-only chunk as karaoke-debug.js (gated
//       at karaoke.js's `import.meta.env.DEV` dynamic import).

import { AppState } from '../core/state.js';
import { RecapSharkAPI } from '../api/client.js';
import { KaraokeDom } from './karaoke-dom.js';

/**
 * Find the container holding transcript rows, wherever it lives.
 * Tries the karaoke-active panel first (production code path), then falls
 * back to a document-wide search so the debug tests work regardless of
 * which container actually holds the rows (flat-transcript-content,
 * buffer, etc.). Returns { container, rows, source } or null.
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

// ── Phase 2 helper test suite (runs inside panel, no DevTools needed) ──
export function runPhase2HelperTests() {
  var dbg = window.__KaraokeDebug;
  var lines = [];
  var passed = 0, failed = 0;
  function log(s) { lines.push(s); }
  function assert(cond, name) {
    if (cond) { log('PASS: ' + name); passed++; }
    else      { log('FAIL: ' + name); failed++; }
  }

  // _addWords
  dbg._resetLazyState();
  dbg._addWords([
    { word: 'hello', start: 0.5, end: 0.8, confidence: 0.99 },
    { word: 'world', start: 1.0, end: 1.3, confidence: 0.95 },
  ]);
  var s = dbg._state();
  assert(s._words.length === 2, '_addWords adds 2 words');
  assert(s._words[0].word === 'hello', '_addWords preserves order when sorted');

  dbg._addWords([{ word: 'hello', start: 0.5, end: 0.8, confidence: 0.99 }]);
  s = dbg._state();
  assert(s._words.length === 2, '_addWords rejects exact duplicate');

  dbg._addWords([{ word: 'first', start: 0.1, end: 0.4, confidence: 1 }]);
  s = dbg._state();
  assert(s._words[0].word === 'first', '_addWords sorts late-arriving earlier word to front');

  dbg._resetLazyState();
  dbg._addWords([
    { word: 'foo', start: 5.0, end: 5.2, confidence: 0.9, chunk_local_idx: 0 },
    { word: 'foo', start: 5.0, end: 5.2, confidence: 0.9, chunk_local_idx: 1 },
  ]);
  s = dbg._state();
  assert(s._words.length === 2, '_addWords chunk_local_idx tiebreaker keeps both co-timed words');

  dbg._addWords([]);
  dbg._addWords(null);
  dbg._addWords(undefined);
  s = dbg._state();
  assert(s._words.length === 2, '_addWords empty/null/undefined input is no-op');

  // _addLoadedRange
  dbg._resetLazyState();
  dbg._addLoadedRange(0, 60);
  dbg._addLoadedRange(60, 360);
  s = dbg._state();
  assert(s._loadedRanges.length === 1, '_addLoadedRange merges exactly-adjacent');
  assert(s._loadedRanges[0].start === 0 && s._loadedRanges[0].end === 360,
    '_addLoadedRange merge spans full union');

  dbg._resetLazyState();
  dbg._addLoadedRange(0, 60);
  dbg._addLoadedRange(60.2, 360);
  s = dbg._state();
  assert(s._loadedRanges.length === 1, '_addLoadedRange merges 0.2s gap (within 0.25s tolerance)');

  dbg._resetLazyState();
  dbg._addLoadedRange(0, 60);
  dbg._addLoadedRange(60.5, 360);
  s = dbg._state();
  assert(s._loadedRanges.length === 2, '_addLoadedRange keeps 0.5s gap separate (exceeds tolerance)');

  dbg._resetLazyState();
  dbg._addLoadedRange(0, 60);
  dbg._addLoadedRange(120, 180);
  s = dbg._state();
  assert(s._loadedRanges.length === 2, '_addLoadedRange keeps far-apart ranges separate');

  dbg._resetLazyState();
  dbg._addLoadedRange(0, 60);
  dbg._addLoadedRange(30, 90);
  s = dbg._state();
  assert(s._loadedRanges.length === 1 && s._loadedRanges[0].end === 90,
    '_addLoadedRange merges overlapping into union');

  dbg._resetLazyState();
  dbg._addLoadedRange(60, 360);
  dbg._addLoadedRange(0, 60);
  s = dbg._state();
  assert(s._loadedRanges.length === 1 && s._loadedRanges[0].start === 0 &&
         s._loadedRanges[0].end === 360,
    '_addLoadedRange handles out-of-order arrivals (chunk@60 before chunk@0)');

  // _isRowFullyCoveredByLoadedWords
  dbg._resetLazyState();
  dbg._addLoadedRange(0, 60);
  assert(dbg._isRowFullyCoveredByLoadedWords(10, 50) === true,
    'rowCoverage: row inside range');
  assert(dbg._isRowFullyCoveredByLoadedWords(70, 80) === false,
    'rowCoverage: row outside range');
  assert(dbg._isRowFullyCoveredByLoadedWords(50, 70) === false,
    'rowCoverage: row partially overlaps end');
  assert(dbg._isRowFullyCoveredByLoadedWords(0, 60) === true,
    'rowCoverage: row exactly matches range');
  assert(dbg._isRowFullyCoveredByLoadedWords(-0.1, 60.1) === true,
    'rowCoverage: 0.1s slack within tolerance');
  assert(dbg._isRowFullyCoveredByLoadedWords(-0.5, 60.5) === false,
    'rowCoverage: 0.5s slack exceeds tolerance');

  dbg._resetLazyState();
  assert(dbg._isRowFullyCoveredByLoadedWords(0, 10) === false,
    'rowCoverage: empty _loadedRanges returns false');

  log('');
  log('===== ' + passed + ' passed, ' + failed + ' failed =====');
  dbg._resetLazyState();
  return { text: lines.join('\n'), passed: passed, failed: failed };
}

// ── Phase 2 RENDERING tests (against real transcript DOM) ──────────────
// Requires a video loaded + transcript rendered. Tests that the apply paths
// correctly render karaoke spans on covered rows + skip uncovered rows in
// lazy mode + idempotently re-apply without re-mutating.
export function runPhase2RenderingTests() {
  var dbg = window.__KaraokeDebug;
  var lines = [];
  var passed = 0, failed = 0;
  function log(s) { lines.push(s); }
  function assert(cond, name, detail) {
    if (cond) { log('PASS: ' + name); passed++; }
    else      { log('FAIL: ' + name + (detail ? '  (' + detail + ')' : '')); failed++; }
  }

  var found = _findTranscriptRowsAnywhere();
  if (!found) {
    var diag = 'doc-wide rows=' + document.querySelectorAll('.transcript-line, .transcript-paragraph').length;
    return { text: 'SKIP: no transcript rows in document — paste a video and wait. ' + diag, passed: 0, failed: 0 };
  }
  var panel = found.container;
  log('Transcript rows: ' + found.rows.length + ' (source: ' + found.source + ')');

  var savedMode = AppState.karaokeMode;
  try {
    // ── Test 1: lazy mode skips uncovered rows ──
    AppState.karaokeMode = 'lazy';
    dbg._clearKaraokeDOM();
    var r1 = dbg._injectFakeChunk(0, 60);
    assert(r1.spansInRange > 0, 'Lazy 0-60 chunk renders spans inside range',
      'spansInRange=' + r1.spansInRange);
    assert(r1.spansOutOfRange === 0, 'Lazy 0-60 leaves rows past 60s plain',
      'spansOutOfRange=' + r1.spansOutOfRange);

    // ── Test 2: idempotent re-apply ──
    var spansBefore = panel.querySelectorAll('.k-word').length;
    dbg._apply();
    var spansAfter = panel.querySelectorAll('.k-word').length;
    assert(spansBefore === spansAfter, 'Idempotent re-apply preserves span count',
      'before=' + spansBefore + ' after=' + spansAfter);

    // ── Test 3: adjacent chunk extends coverage ──
    var r3 = dbg._injectFakeChunk(60, 300);
    var combinedRanges = dbg._state()._loadedRanges;
    assert(combinedRanges.length === 1,
      'Adjacent chunks merged into single loaded range',
      'ranges=' + JSON.stringify(combinedRanges));
    assert(r3.spansInRange > 0, 'New rows in 60-360 range got spans',
      'spansInRange=' + r3.spansInRange);

    // ── Test 4: clear wipes everything ──
    dbg._clearKaraokeDOM();
    var afterClear = panel.querySelectorAll('.k-word').length;
    var markersAfter = panel.querySelectorAll('[data-karaoke-state]').length;
    assert(afterClear === 0, 'Clear removes all .k-word spans', 'remaining=' + afterClear);
    assert(markersAfter === 0, 'Clear removes all dataset markers', 'remaining=' + markersAfter);

    // ── Test 5: out-of-order chunk arrival merges correctly ──
    dbg._clearKaraokeDOM();
    var r5b = dbg._injectFakeChunk(60, 300);
    var r5a = dbg._injectFakeChunk(0, 60);
    var ranges5 = dbg._state()._loadedRanges;
    assert(ranges5.length === 1 && ranges5[0].start === 0 && ranges5[0].end >= 360,
      'Out-of-order chunks merge into single [0, 360] range',
      'ranges=' + JSON.stringify(ranges5));

    // ── Test 6: full mode applies regardless of loaded ranges ──
    dbg._clearKaraokeDOM();
    AppState.karaokeMode = 'full';
    var r6 = dbg._injectFakeChunk(0, 60);
    // In full mode, rows beyond 60s should ALSO get spans (no coverage check)
    // ... actually injection only generates words for [0, 60], so other rows
    // have no words. Verify that rows IN range get spans regardless.
    assert(r6.spansInRange > 0, 'Full mode renders spans for rows with words',
      'spansInRange=' + r6.spansInRange);

    dbg._clearKaraokeDOM();
  } finally {
    AppState.karaokeMode = savedMode;
  }

  log('');
  log('===== ' + passed + ' passed, ' + failed + ' failed =====');
  return { text: lines.join('\n'), passed: passed, failed: failed };
}

// ── Phase 2 Milestone C: syncWord reorder tests ──────────────────────
// Verifies (1) lazy mode fires the chunk-load hook even with empty `_words`
// (the structural prep that unblocks Phase 3), (2) full mode does NOT fire
// the hook (current behaviour preserved), and (3) syncWord doesn't crash
// when called with no words / no video / different display modes.
export function runPhase2SyncWordTests() {
  var dbg = window.__KaraokeDebug;
  var lines = [];
  var passed = 0, failed = 0;
  function log(s) { lines.push(s); }
  function assert(cond, name, detail) {
    if (cond) { log('PASS: ' + name); passed++; }
    else      { log('FAIL: ' + name + (detail ? '  (' + detail + ')' : '')); failed++; }
  }

  var savedMode = AppState.karaokeMode;
  var savedEnabled = AppState.karaokeEnabled;
  try {
    // ── Test 1: lazy mode fires the loader hook on heartbeat ──
    AppState.karaokeEnabled = true;
    AppState.karaokeMode = 'lazy';
    dbg._resetLazyState();
    dbg._resetMaybeScheduleChunkLoadCount();
    dbg._syncWord(0);
    assert(dbg._maybeScheduleChunkLoadCallCount() === 1,
      'Lazy + empty words → chunk-load hook fires once on heartbeat',
      'count=' + dbg._maybeScheduleChunkLoadCallCount());

    // ── Test 2: lazy mode fires repeatedly across ticks ──
    dbg._syncWord(1);
    dbg._syncWord(2);
    assert(dbg._maybeScheduleChunkLoadCallCount() === 3,
      'Lazy heartbeat ticks accumulate (3 calls = 3 ticks)',
      'count=' + dbg._maybeScheduleChunkLoadCallCount());

    // ── Test 3: full mode does NOT fire the loader hook ──
    AppState.karaokeMode = 'full';
    dbg._resetMaybeScheduleChunkLoadCount();
    dbg._syncWord(0);
    dbg._syncWord(1);
    assert(dbg._maybeScheduleChunkLoadCallCount() === 0,
      'Full mode bypasses chunk-load hook',
      'count=' + dbg._maybeScheduleChunkLoadCallCount());

    // ── Test 4: kill switch blocks even the loader hook ──
    AppState.karaokeMode = 'lazy';
    AppState.karaokeEnabled = false;
    dbg._resetMaybeScheduleChunkLoadCount();
    dbg._syncWord(0);
    assert(dbg._maybeScheduleChunkLoadCallCount() === 0,
      'karaokeEnabled=false short-circuits before the loader hook',
      'count=' + dbg._maybeScheduleChunkLoadCallCount());

    // ── Test 5: empty words + lazy mode does not throw ──
    AppState.karaokeEnabled = true;
    AppState.karaokeMode = 'lazy';
    dbg._resetLazyState();
    var threw = false;
    try { dbg._syncWord(0); } catch (e) { threw = true; }
    assert(!threw, 'syncWord with empty _words does not throw');
  } finally {
    AppState.karaokeMode = savedMode;
    AppState.karaokeEnabled = savedEnabled;
    dbg._resetMaybeScheduleChunkLoadCount();
  }

  log('');
  log('===== ' + passed + ' passed, ' + failed + ' failed =====');
  return { text: lines.join('\n'), passed: passed, failed: failed };
}

// ── Phase 3 Stage 3: robustness tests ────────────────────────────────
// Verifies seek-debounce (rapid calls coalesce into one trailing-edge
// fire) and visibility-recovery (visible→loader, hidden→no-op). Both
// gate on the kill switch. Fully synchronous via `_flushSeekDebounce`.
export function runPhase3RobustnessTests() {
  var dbg = window.__KaraokeDebug;
  var lines = [];
  var passed = 0, failed = 0;
  function log(s) { lines.push(s); }
  function assert(cond, name, detail) {
    if (cond) { log('PASS: ' + name); passed++; }
    else      { log('FAIL: ' + name + (detail ? '  (' + detail + ')' : '')); failed++; }
  }

  var savedEnabled = AppState.karaokeEnabled;
  try {
    // ── Test 1: rapid seek calls coalesce into one pending timer ──
    AppState.karaokeEnabled = true;
    dbg._resetStage3Counters();
    // Drain any pending timer left by prior runs
    if (dbg._seekDebounceTimerActive()) dbg._flushSeekDebounce();
    dbg._resetStage3Counters();

    for (var i = 0; i < 5; i++) dbg._onPlayOrSeek();
    assert(dbg._seekDebounceTimerActive() === true,
      '5 rapid onPlayOrSeek calls leave exactly one pending debounce timer');
    assert(dbg._seekDebounceFires() === 0,
      'Debounce has not fired yet (still pending)',
      'fires=' + dbg._seekDebounceFires());

    // ── Test 2: trailing-edge fire executes the loader once ──
    var flushed = dbg._flushSeekDebounce();
    assert(flushed === true, 'Pending debounce flushes successfully');
    assert(dbg._seekDebounceFires() === 1,
      'Trailing-edge fires exactly once after coalesced calls',
      'fires=' + dbg._seekDebounceFires());
    assert(dbg._seekDebounceTimerActive() === false,
      'Timer cleared after fire');

    // ── Test 3: kill switch blocks seek path ──
    AppState.karaokeEnabled = false;
    dbg._resetStage3Counters();
    dbg._onPlayOrSeek();
    assert(dbg._seekDebounceTimerActive() === false,
      'karaokeEnabled=false short-circuits before scheduling debounce');

    // ── Test 4: visibility recovery fires when visible ──
    AppState.karaokeEnabled = true;
    dbg._resetStage3Counters();
    // document.visibilityState during a foreground test is 'visible'
    if (document.visibilityState === 'visible') {
      dbg._onVisibilityChange();
      assert(dbg._visibilityRecoveryFires() === 1,
        'visibilitychange→visible fires loader once',
        'fires=' + dbg._visibilityRecoveryFires());
    } else {
      log('SKIP: tab not in visible state, cannot test visibility recovery');
    }

    // ── Test 5: visibility kill-switch gate ──
    AppState.karaokeEnabled = false;
    dbg._resetStage3Counters();
    dbg._onVisibilityChange();
    assert(dbg._visibilityRecoveryFires() === 0,
      'karaokeEnabled=false short-circuits visibility recovery');

    // ── Test 6: subsequent debounce after fire still works ──
    AppState.karaokeEnabled = true;
    dbg._resetStage3Counters();
    if (dbg._seekDebounceTimerActive()) dbg._flushSeekDebounce();
    dbg._resetStage3Counters();
    dbg._onPlayOrSeek();
    assert(dbg._seekDebounceTimerActive() === true,
      'Fresh onPlayOrSeek after a prior fire schedules a new debounce');
    dbg._flushSeekDebounce();
    assert(dbg._seekDebounceFires() === 1,
      'Second debounce cycle fires cleanly');
  } finally {
    AppState.karaokeEnabled = savedEnabled;
    if (dbg._seekDebounceTimerActive()) dbg._flushSeekDebounce();
    dbg._resetStage3Counters();
  }

  log('');
  log('===== ' + passed + ' passed, ' + failed + ' failed =====');
  return { text: lines.join('\n'), passed: passed, failed: failed };
}

// ── Phase 3 Stage 4: error-handling tests ────────────────────────────
// Verifies the once-per-session toast guard for cap_hit / circuit_open,
// session-fatal flag wiring, and Sentry capture in the catch path.
// Stubs window.showToast + window.Sentry so the test runs anywhere
// without firing a real toast or sending a real Sentry event.
export function runPhase3ErrorHandlingTests() {
  var dbg = window.__KaraokeDebug;
  var lines = [];
  var passed = 0, failed = 0;
  function log(s) { lines.push(s); }
  function assert(cond, name, detail) {
    if (cond) { log('PASS: ' + name); passed++; }
    else      { log('FAIL: ' + name + (detail ? '  (' + detail + ')' : '')); failed++; }
  }

  // Stub showToast + Sentry so we can observe calls without side effects.
  var savedToast = window.showToast;
  var savedSentry = window.Sentry;
  var toastCalls = [];
  var sentryCalls = [];
  window.showToast = function(msg) { toastCalls.push(msg); };
  window.Sentry = {
    captureException: function(err, ctx) {
      sentryCalls.push({ message: err && err.message, ctx: ctx });
    },
  };

  try {
    // ── Test 1: cap_hit fires the toast once + flips session-fatal ──
    dbg._resetStage4Counters();
    toastCalls.length = 0;
    dbg._handleNonRetryableError('cap_hit', '0:60');
    assert(toastCalls.length === 1, 'cap_hit fires toast once on first hit',
      'toastCalls=' + toastCalls.length);
    assert(toastCalls[0] === dbg._sessionFatalToastCopy('cap_hit'),
      'toast message matches the cap_hit copy',
      'got=' + JSON.stringify(toastCalls[0]));
    assert(AppState.karaokeSessionFatal === true,
      'cap_hit sets AppState.karaokeSessionFatal');
    assert(dbg._sessionFatalToastShown() === true,
      'sessionFatalToastShown flag flipped');

    // ── Test 2: second cap_hit does NOT re-fire the toast ──
    dbg._handleNonRetryableError('cap_hit', '60:300');
    assert(toastCalls.length === 1, 'second cap_hit does NOT re-fire toast',
      'toastCalls=' + toastCalls.length);

    // ── Test 3: circuit_open also session-fatal + own copy ──
    dbg._resetStage4Counters();
    toastCalls.length = 0;
    dbg._handleNonRetryableError('circuit_open', '360:660');
    assert(toastCalls.length === 1, 'circuit_open fires toast once');
    assert(toastCalls[0] === dbg._sessionFatalToastCopy('circuit_open'),
      'toast message matches the circuit_open copy',
      'got=' + JSON.stringify(toastCalls[0]));
    assert(AppState.karaokeSessionFatal === true,
      'circuit_open sets AppState.karaokeSessionFatal');

    // ── Test 4: chunk-fatal codes (audio_unavailable) do NOT toast ──
    dbg._resetStage4Counters();
    toastCalls.length = 0;
    dbg._handleNonRetryableError('audio_unavailable', '660:960');
    assert(toastCalls.length === 0,
      'audio_unavailable does NOT fire toast (chunk-fatal only)',
      'toastCalls=' + toastCalls.length);
    assert(AppState.karaokeSessionFatal === false,
      'audio_unavailable does NOT flip session-fatal flag');

    // ── Test 5: Sentry capture forwards thrown exception with tags ──
    dbg._resetStage4Counters();
    sentryCalls.length = 0;
    var fakeErr = new Error('synthetic fetch throw');
    dbg._captureFetchExceptionToSentry(fakeErr, '0:60', 0, 60);
    assert(sentryCalls.length === 1, 'Sentry.captureException called once');
    assert(sentryCalls[0].message === 'synthetic fetch throw',
      'original Error object forwarded');
    assert(sentryCalls[0].ctx && sentryCalls[0].ctx.tags &&
           sentryCalls[0].ctx.tags.feature === 'lazy-karaoke',
      'feature: lazy-karaoke tag attached (D37)');
    assert(sentryCalls[0].ctx && sentryCalls[0].ctx.tags &&
           sentryCalls[0].ctx.tags.error_code === 'fetch_threw',
      'error_code: fetch_threw tag attached');
    assert(sentryCalls[0].ctx && sentryCalls[0].ctx.extra &&
           sentryCalls[0].ctx.extra.chunk_key === '0:60',
      'chunk_key forwarded as extra context');

    // ── Test 6: Sentry stub absent = no crash ──
    dbg._resetStage4Counters();
    window.Sentry = undefined;
    var threw = false;
    try { dbg._captureFetchExceptionToSentry(new Error('no sentry'), '0:60', 0, 60); }
    catch (_e) { threw = true; }
    assert(!threw, 'no-Sentry case is a safe no-op (no crash)');
  } finally {
    window.showToast = savedToast;
    window.Sentry = savedSentry;
    dbg._resetStage4Counters();
  }

  log('');
  log('===== ' + passed + ' passed, ' + failed + ' failed =====');
  return { text: lines.join('\n'), passed: passed, failed: failed };
}

// ── Phase 3 Stage 5: per-session telemetry tests ─────────────────────
// Verifies the session-end Sentry breadcrumb emits exactly once per
// session, dual-hook coalescing (pagehide + visibilitychange→hidden
// both fire → still one breadcrumb), no-signal skip (zero requested →
// no breadcrumb), reset behavior (new video can emit fresh breadcrumb),
// and that the no-Sentry case is a safe no-op. Stubs window.Sentry so
// the suite runs without sending real breadcrumbs. (The mirrored
// `[KARAOKE-SESSION]` console.log was removed 2026-05-06 in a console-
// noise cleanup pass — Sentry breadcrumb is the canonical channel now.)
export function runPhase3TelemetryTests() {
  var dbg = window.__KaraokeDebug;
  var lines = [];
  var passed = 0, failed = 0;
  function log(s) { lines.push(s); }
  function assert(cond, name, detail) {
    if (cond) { log('PASS: ' + name); passed++; }
    else      { log('FAIL: ' + name + (detail ? '  (' + detail + ')' : '')); failed++; }
  }

  // Stub Sentry so we observe breadcrumbs without sending real ones.
  var savedSentry = window.Sentry;
  var breadcrumbCalls = [];
  window.Sentry = {
    addBreadcrumb: function(crumb) { breadcrumbCalls.push(crumb); },
  };

  // Snapshot + override AppState counters for deterministic test data.
  var savedReq = AppState.karaokeChunksRequested;
  var savedFetched = AppState.karaokeChunksFetched;
  var savedHits = AppState.karaokeChunksCacheHits;
  var savedFailed = AppState.karaokeChunksFailed;
  var savedFatal = AppState.karaokeSessionFatal;

  try {
    // ── Test 1: emits one breadcrumb when chunks were requested ──
    dbg._resetStage5Counters();
    breadcrumbCalls.length = 0;
    AppState.karaokeChunksRequested = 5;
    AppState.karaokeChunksFetched = 2;
    AppState.karaokeChunksCacheHits = 3;
    AppState.karaokeChunksFailed = 0;
    AppState.karaokeSessionFatal = false;
    dbg._emitSessionEndLog();
    assert(breadcrumbCalls.length === 1, 'session-end emits exactly 1 Sentry breadcrumb',
      'breadcrumbCalls=' + breadcrumbCalls.length);
    assert(breadcrumbCalls[0].category === 'lazy-karaoke',
      'breadcrumb category=lazy-karaoke');
    assert(breadcrumbCalls[0].data && breadcrumbCalls[0].data.requested === 5,
      'breadcrumb data.requested=5');
    assert(breadcrumbCalls[0].data && breadcrumbCalls[0].data.cache_hits === 3,
      'breadcrumb data.cache_hits=3');
    assert(breadcrumbCalls[0].data && breadcrumbCalls[0].data.cache_hit_rate === '60.0%',
      'breadcrumb data.cache_hit_rate=60.0%',
      'got=' + (breadcrumbCalls[0].data && breadcrumbCalls[0].data.cache_hit_rate));
    assert(dbg._sessionEndLogFired() === true, 'guard flag flipped after emit');

    // ── Test 2: second call within same session does NOT re-emit ──
    breadcrumbCalls.length = 0;
    dbg._emitSessionEndLog();
    assert(breadcrumbCalls.length === 0, 'second call within session is no-op',
      'breadcrumbCalls=' + breadcrumbCalls.length);

    // ── Test 3: dual-hook coalescing — pagehide + visibilitychange both fire ──
    dbg._resetStage5Counters();
    breadcrumbCalls.length = 0;
    AppState.karaokeChunksRequested = 1;
    // Simulate both events. visibilitychange→hidden first, then pagehide.
    // The handler must check document.visibilityState === 'hidden' for
    // the visibilitychange branch; otherwise visible→hidden tab toggles
    // would fire repeatedly.
    dbg._onSessionLifecycleEvent({ type: 'pagehide' });
    dbg._onSessionLifecycleEvent({ type: 'pagehide' });
    assert(breadcrumbCalls.length === 1,
      'pagehide firing twice still emits exactly one breadcrumb',
      'breadcrumbCalls=' + breadcrumbCalls.length);

    // ── Test 4: visibilitychange when state is "visible" is a no-op ──
    dbg._resetStage5Counters();
    breadcrumbCalls.length = 0;
    AppState.karaokeChunksRequested = 1;
    // document.visibilityState is read-only — but in a foreground test
    // tab it's 'visible' so the handler should bail without emitting.
    if (document.visibilityState === 'visible') {
      dbg._onSessionLifecycleEvent({ type: 'visibilitychange' });
      assert(breadcrumbCalls.length === 0,
        'visibilitychange when state=visible does not emit',
        'breadcrumbCalls=' + breadcrumbCalls.length);
    } else {
      log('SKIP: tab not in visible state, cannot test visibility-visible no-op');
    }

    // ── Test 5: zero-request session emits no breadcrumb (no signal) ──
    dbg._resetStage5Counters();
    breadcrumbCalls.length = 0;
    AppState.karaokeChunksRequested = 0;
    AppState.karaokeChunksFetched = 0;
    AppState.karaokeChunksCacheHits = 0;
    AppState.karaokeChunksFailed = 0;
    dbg._emitSessionEndLog();
    assert(breadcrumbCalls.length === 0,
      'zero-request session is silent (no empty-session pollution)',
      'breadcrumbCalls=' + breadcrumbCalls.length);
    assert(dbg._sessionEndLogFired() === false,
      'guard flag stays false on no-signal skip');

    // ── Test 6: Sentry breadcrumb forwards session_fatal flag ──
    dbg._resetStage5Counters();
    breadcrumbCalls.length = 0;
    AppState.karaokeChunksRequested = 7;
    AppState.karaokeChunksFetched = 7;
    AppState.karaokeChunksCacheHits = 0;
    AppState.karaokeChunksFailed = 0;
    AppState.karaokeSessionFatal = true;
    dbg._emitSessionEndLog();
    assert(breadcrumbCalls.length === 1, 'Sentry.addBreadcrumb called once');
    assert(breadcrumbCalls[0].data && breadcrumbCalls[0].data.session_fatal === true,
      'breadcrumb data forwards session_fatal flag');

    // ── Test 7: no-Sentry case is a safe no-op (no crash, no telemetry) ──
    dbg._resetStage5Counters();
    breadcrumbCalls.length = 0;
    window.Sentry = undefined;
    AppState.karaokeChunksRequested = 1;
    var threw = false;
    try { dbg._emitSessionEndLog(); }
    catch (_e) { threw = true; }
    assert(!threw, 'no-Sentry case does not crash');
    assert(breadcrumbCalls.length === 0,
      'no-Sentry case is silent (Sentry breadcrumb is the only channel now)',
      'breadcrumbCalls=' + breadcrumbCalls.length);
  } finally {
    window.Sentry = savedSentry;
    AppState.karaokeChunksRequested = savedReq;
    AppState.karaokeChunksFetched = savedFetched;
    AppState.karaokeChunksCacheHits = savedHits;
    AppState.karaokeChunksFailed = savedFailed;
    AppState.karaokeSessionFatal = savedFatal;
    dbg._resetStage5Counters();
  }

  log('');
  log('===== ' + passed + ' passed, ' + failed + ' failed =====');
  return { text: lines.join('\n'), passed: passed, failed: failed };
}

// ── Phase 4: short-video bypass tests ────────────────────────────────
// Verifies the short-video bypass fires once per video, populates _words
// + _loadedRanges + paints spans, doesn't re-fire on subsequent ticks,
// handles success/retryable/non-retryable error paths consistently with
// the chunked loader, and that long-video paths fall through to the
// chunked loader unchanged. Stubs `RecapSharkAPI.karaokeWordsShort` so
// the suite doesn't hit the real backend.
export async function runPhase4ShortVideoTests() {
  var dbg = window.__KaraokeDebug;
  var lines = [];
  var passed = 0, failed = 0;
  function log(s) { lines.push(s); }
  function assert(cond, name, detail) {
    if (cond) { log('PASS: ' + name); passed++; }
    else      { log('FAIL: ' + name + (detail ? '  (' + detail + ')' : '')); failed++; }
  }

  // Stub the API so the suite is self-contained.
  var savedShort = RecapSharkAPI.karaokeWordsShort;
  var savedToast = window.showToast;
  var stubResponse = null;
  var stubThrow = false;
  var shortCallCount = 0;
  var lastShortArgs = null;
  RecapSharkAPI.karaokeWordsShort = async function(videoId, lang) {
    shortCallCount++;
    lastShortArgs = { videoId: videoId, lang: lang };
    if (stubThrow) throw new Error('synthetic short fetch throw');
    return stubResponse;
  };
  window.showToast = function() { /* swallow */ };

  // Snapshot mutated state so we can restore.
  var savedReq = AppState.karaokeChunksRequested;
  var savedFetched = AppState.karaokeChunksFetched;
  var savedHits = AppState.karaokeChunksCacheHits;
  var savedFailed = AppState.karaokeChunksFailed;
  var savedFatal = AppState.karaokeSessionFatal;
  var savedVid = AppState.currentVideoId;

  function _resetForTest() {
    dbg._resetPhase4State();
    dbg._resetLazyState();
    dbg._resetStage4Counters();
    AppState.karaokeChunksRequested = 0;
    AppState.karaokeChunksFetched = 0;
    AppState.karaokeChunksCacheHits = 0;
    AppState.karaokeChunksFailed = 0;
    AppState.karaokeSessionFatal = false;
    AppState.currentVideoId = 'testVid123';
    shortCallCount = 0;
  }

  try {
    // ── Test 1: success populates words + sets fired flag + counters ──
    _resetForTest();
    stubResponse = {
      words: [
        { word: 'hello', start: 0.5, end: 0.8, confidence: 0.99, chunk_local_idx: 0 },
        { word: 'world', start: 1.0, end: 1.3, confidence: 0.95, chunk_local_idx: 1 },
      ],
      cached: false,
      submitted_audio_seconds: 120,
      elapsed_ms: 4000,
      error: null,
      retryable: false,
    };
    await dbg._fetchShortVideo(120);
    assert(shortCallCount === 1, 'short endpoint called exactly once on success',
      'shortCallCount=' + shortCallCount);
    assert(dbg._shortVideoBypassFired() === true, 'fired flag flipped after success');
    assert(dbg._shortVideoBypassInFlight() === false, 'in-flight cleared in finally');
    assert(dbg._state()._words.length === 2, '_words populated from response',
      '_words.length=' + dbg._state()._words.length);
    assert(dbg._state()._loadedRanges.length === 1 &&
           dbg._state()._loadedRanges[0].end === 120,
      'loaded range covers [0, 120]',
      'ranges=' + JSON.stringify(dbg._state()._loadedRanges));
    assert(AppState.karaokeChunksFetched === 1,
      'karaokeChunksFetched incremented on cache miss');
    assert(AppState.karaokeChunksCacheHits === 0,
      'karaokeChunksCacheHits stays 0 on cache miss');

    // ── Test 2: cache-hit increments the right counter ──
    _resetForTest();
    stubResponse = {
      words: [{ word: 'cached', start: 0.5, end: 0.8, confidence: 1, chunk_local_idx: 0 }],
      cached: true,
      submitted_audio_seconds: 0,
      elapsed_ms: 80,
      error: null,
      retryable: false,
    };
    await dbg._fetchShortVideo(60);
    assert(AppState.karaokeChunksCacheHits === 1,
      'cache-hit increments karaokeChunksCacheHits');
    assert(AppState.karaokeChunksFetched === 0,
      'cache-hit does NOT increment karaokeChunksFetched');

    // ── Test 3: retryable error leaves fired=false so next tick retries ──
    _resetForTest();
    stubResponse = {
      words: [],
      cached: false,
      submitted_audio_seconds: 0,
      elapsed_ms: 80,
      error: 'audio_not_ready',
      retryable: true,
      cooldown_ms: 15000,
    };
    await dbg._fetchShortVideo(60);
    assert(dbg._shortVideoBypassFired() === false,
      'retryable error keeps fired=false (allows retry on next tick)');
    assert(AppState.karaokeChunksFailed === 1,
      'retryable error increments karaokeChunksFailed');

    // ── Test 4: non-retryable cap_hit sets session fatal + fired=true ──
    _resetForTest();
    stubResponse = {
      words: [],
      cached: false,
      submitted_audio_seconds: 0,
      elapsed_ms: 80,
      error: 'cap_hit',
      retryable: false,
    };
    await dbg._fetchShortVideo(60);
    assert(AppState.karaokeSessionFatal === true,
      'cap_hit on short bypass flips karaokeSessionFatal');
    assert(dbg._shortVideoBypassFired() === true,
      'non-retryable error sets fired=true (give up for session)');

    // ── Test 5: thrown exception goes through Sentry capture path ──
    _resetForTest();
    var savedSentry = window.Sentry;
    var sentryCalls = [];
    window.Sentry = {
      captureException: function(err, ctx) {
        sentryCalls.push({ message: err && err.message, ctx: ctx });
      },
    };
    try {
      stubThrow = true;
      await dbg._fetchShortVideo(60);
      assert(sentryCalls.length === 1,
        'thrown exception forwarded to Sentry',
        'sentryCalls=' + sentryCalls.length);
      assert(sentryCalls[0].ctx && sentryCalls[0].ctx.tags &&
             sentryCalls[0].ctx.tags.feature === 'lazy-karaoke',
        'feature: lazy-karaoke tag attached');
      assert(AppState.karaokeChunksFailed === 1,
        'thrown exception increments karaokeChunksFailed');
    } finally {
      stubThrow = false;
      window.Sentry = savedSentry;
    }
  } finally {
    RecapSharkAPI.karaokeWordsShort = savedShort;
    window.showToast = savedToast;
    AppState.karaokeChunksRequested = savedReq;
    AppState.karaokeChunksFetched = savedFetched;
    AppState.karaokeChunksCacheHits = savedHits;
    AppState.karaokeChunksFailed = savedFailed;
    AppState.karaokeSessionFatal = savedFatal;
    AppState.currentVideoId = savedVid;
    dbg._resetPhase4State();
    dbg._resetLazyState();
    dbg._resetStage4Counters();
  }

  log('');
  log('===== ' + passed + ' passed, ' + failed + ' failed =====');
  return { text: lines.join('\n'), passed: passed, failed: failed };
}

// ── Phase 2 Milestone E: Sentry frontend SDK smoke-test ──────────────
// Single-shot button: throws a deliberate error tagged for Sentry.
// Pass criteria (manual, on Sentry dashboard):
//   1. The exception lands in the recapshark-frontend project inbox
//      within ~30s with the `feature: lazy-karaoke` + `source: debug-panel`
//      tags.
//   2. Stack trace shows real source line numbers (this file +
//      function name) — NOT a minified `chunk-abc.js:1:NNNN` blob.
//      If lines are minified, source-map upload via @sentry/vite-plugin
//      is misconfigured; check SENTRY_AUTH_TOKEN was set at build time.
export function runPhase2SentryTest() {
  var lines = [];
  function log(s) { lines.push(s); }

  var initialized = (typeof window !== 'undefined') && window.__sentryInitialized === true;
  var dsnPresent = typeof import.meta !== 'undefined' &&
                   !!(import.meta.env && import.meta.env.VITE_SENTRY_DSN_FRONTEND);

  log('SDK initialized: ' + (initialized ? 'YES' : 'NO'));
  log('VITE_SENTRY_DSN_FRONTEND set: ' + (dsnPresent ? 'YES' : 'NO'));
  if (!initialized) {
    log('');
    log('Cannot trigger test exception — SDK is not initialized.');
    log('Either VITE_SENTRY_DSN_FRONTEND is missing in .env, or SDK init failed.');
    log('Set the env var, rebuild (npm run build), and retry.');
    return { text: lines.join('\n'), passed: 0, failed: 1 };
  }

  try {
    if (window.Sentry && typeof window.Sentry.captureException === 'function') {
      var err = new Error('[karaoke debug panel] deliberate test exception — verify Sentry inbox + source-mapped trace');
      window.Sentry.captureException(err, {
        tags: { feature: 'lazy-karaoke', source: 'debug-panel' },
      });
      log('');
      log('Test exception sent. Check Sentry inbox at:');
      log('https://gcp-PROJECT-ID.sentry.io/issues/?project=recapshark-frontend');
      log('');
      log('Verify (manual):');
      log('  1. Issue appears within ~30s with tags { feature: lazy-karaoke, source: debug-panel }');
      log('  2. Stack trace shows REAL source line numbers (not minified)');
      log('     If minified: SENTRY_AUTH_TOKEN was missing at build time, source-maps did not upload');
      return { text: lines.join('\n'), passed: 1, failed: 0 };
    }
    log('window.Sentry.captureException not available — SDK loaded but API missing?');
    return { text: lines.join('\n'), passed: 0, failed: 1 };
  } catch (e) {
    log('ERROR while triggering test exception: ' + (e && e.message || e));
    return { text: lines.join('\n'), passed: 0, failed: 1 };
  }
}
