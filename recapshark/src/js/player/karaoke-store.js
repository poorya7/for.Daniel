// karaoke-store.js
//
// The karaoke shared-state hub (star-pattern center).
//
// Owns: ALL shared mutable state for the karaoke pipeline — _words, _wordKeySet,
//       _loadedRanges, _wordEls, _wordElByKey, _wordElsByKey, _synthWords,
//       _waveLit / _waveNewLit, _waveRadiusSecCached, _lastWaveTime, _activeKey
//       and friends, _applied flags. Plus the _hasOriginalTextVisible() translation
//       gate (single source of truth for "is karaoke painting allowed").
// Reads from karaoke-store: itself only.
// Writes to karaoke-store: only via the exposed methods.
// Does NOT own: word data computation, DOM building, chunk loading, alignment math,
//               session lifecycle, the rAF wave loop itself.
// Imports allowed: ../core/state, ../translation/translation-state.
// Coupling notes: every other karaoke file reads/writes through this module.
//                 No sibling-to-sibling state imports — that's the whole point
//                 of the store extraction (plan section 7 cycle 7a).
// Performance invariants:
//   - State references are returned by `getLitSets()` so the wave loop reads
//     refs once per frame and iterates directly — no method-call overhead per
//     char per frame.
//   - `addWords` runs an O(N log N) sort only when at least one new word
//     actually arrives (early-return on empty / fully-deduped input).
import { AppState } from '../core/state.js';
import { tState } from '../translation/translation-state.js';

export const KaraokeStore = (function () {
  'use strict';

  // Slack window for "is this row fully covered by loaded chunks?" checks.
  // Boundary-aligned chunks (chunk@60 + chunk@60-360) merge cleanly with this
  // tolerance; bigger gaps stay separate. Used by `_isRowFullyCoveredByLoadedWords`.
  const ROW_COVERAGE_TOLERANCE_SEC = 0.25;

  // ── Word data (preserved across language swaps; cleared on reset() between videos) ──
  let _words = [];                        // [{word, start, end, confidence, chunk_local_idx?}, ...] sorted by start
  let _wordKeySet = new Set();            // dedup guard for addWords
  let _loadedRanges = [];                 // merged sorted intervals [{start, end}, ...]

  // Synthetic word timeline for tokens that the original transcript has but
  // AsrProvider didn't transcribe. Filled in by `_buildWordSpans` via proportional
  // time interpolation between matched anchors. Same shape as `_words` so the
  // active-highlight loop can search both arrays. Cleared on reset(); rebuilt
  // every render-pass so it stays in sync with the visible DOM.
  let _synthWords = [];                   // [{word, start, end, key, synthetic:true}, ...] sorted by start

  // ── DOM-bound state (cleared in invalidate() because translation rebuilds DOM) ──
  let _wordEls = [];                      // span refs indexed by global word idx (drives bilingual sub-row mapping)
  let _wordElByKey = new Map();           // stable word key → span element
  let _wordElsByKey = new Map();          // .k-word elements indexed by data-key (perf: O(1) lookup vs full doc qSA)

  // ── Apply-path state (DOM-bound) ──
  let _activeWordIdx = -1;
  let _activeKey = null;                  // current karaoke-active span's data-key (AsrProvider or synth)
  let _activeWordKey = null;              // active-line scroll anchor: highest-`--k` k-word's data-key
  let _activeSubEl = null;                // currently highlighted .bilingual-sub
  let _applied = false;
  let _appliedPanel = null;
  let _lastApplyAttempt = 0;

  // ── Wave-loop state ──
  let _waveLit = new Set();               // chars currently lit
  let _waveNewLit = new Set();            // scratch reused per frame; swapped with _waveLit
  let _waveRadiusSecCached = null;        // perf: cached --karaoke-radius-sec; invalidated to null on theme change
  let _lastWaveTime = -1;                 // perf: idle-skip when getCurrentTime() returned the same value last frame

  // ── Translation gate ──────────────────────────────────────────────────────
  // Karaoke runs ONLY on original-language words (§5 C1). True when:
  //   1. currentLang === videoLang (no translation active at all)
  //   2. displayMode === 'original' (translation toggled off)
  //   3. displayMode === 'bilingual' / 'bilingual-swapped' (original rows still rendered)
  function isOriginalVisible() {
    var videoLang = AppState.videoData?.lang || 'en';
    var currentLang = AppState.currentLang || videoLang;
    if (currentLang === videoLang) return true;
    if (tState.displayMode === 'original') return true;
    if (tState.displayMode === 'bilingual') return true;
    if (tState.displayMode === 'bilingual-swapped') return true;
    return false;
  }

  // ── Word key (stable cross-DOM/lang-swap identifier) ─────────────────────
  function wordKey(w) {
    var idx = (typeof w.chunk_local_idx === 'number') ? w.chunk_local_idx : 0;
    return Math.round(w.start * 1000) + ':' + Math.round(w.end * 1000) + ':' + w.word + ':' + idx;
  }

  // ── Word data writers ────────────────────────────────────────────────────

  /** Merge a chunk's words into the global _words array. Dedups via _wordKeySet
   *  (stable key per word). Sorts merged result by start time. Caller is
   *  responsible for re-running the apply-path after this.
   *
   *  In-place mutation: the array reference never changes, so consumers
   *  (e.g. karaoke.js) can hold a long-lived reference without re-fetching. */
  function addWords(newWords) {
    if (!newWords || !newWords.length) return;
    var added = 0;
    for (var i = 0; i < newWords.length; i++) {
      var w = newWords[i];
      var key = wordKey(w);
      if (_wordKeySet.has(key)) continue;
      _wordKeySet.add(key);
      _words.push(w);
      added++;
    }
    if (added > 0) {
      _words.sort(function (a, b) { return a.start - b.start; });
    }
  }

  /** Track that we've loaded word data covering [start, end] in global time.
   *  Sorts and merges overlapping/adjacent ranges (with ROW_COVERAGE_TOLERANCE_SEC
   *  slack so boundary-aligned chunks merge cleanly).
   *
   *  In-place mutation: empty + push the merged result back into the same
   *  array, so the live reference stays valid for consumers. */
  function addLoadedRange(start, end) {
    _loadedRanges.push({ start: start, end: end });
    _loadedRanges.sort(function (a, b) { return a.start - b.start; });
    var merged = [];
    for (var i = 0; i < _loadedRanges.length; i++) {
      var r = _loadedRanges[i];
      var last = merged.length ? merged[merged.length - 1] : null;
      if (last && r.start <= last.end + ROW_COVERAGE_TOLERANCE_SEC) {
        last.end = Math.max(last.end, r.end);
      } else {
        merged.push({ start: r.start, end: r.end });
      }
    }
    _loadedRanges.length = 0;
    for (var k = 0; k < merged.length; k++) _loadedRanges.push(merged[k]);
  }

  /** Is the entire [rowStart, rowEnd] interval covered by some merged loaded range?
   *  Interval coverage ONLY — NO defensive boundary checks (T5), NO internal-gap
   *  heuristic (T6). Real speech has natural pauses; the renderer is text-preserving
   *  (early-returns on empty rowWords, leaving plain text inside covered rows). */
  function isRowFullyCoveredByLoadedWords(rowStart, rowEnd) {
    for (var i = 0; i < _loadedRanges.length; i++) {
      var r = _loadedRanges[i];
      if (r.start <= rowStart + ROW_COVERAGE_TOLERANCE_SEC &&
          r.end   >= rowEnd   - ROW_COVERAGE_TOLERANCE_SEC) {
        return true;
      }
    }
    return false;
  }

  /** Find all _words whose `start` time falls in [rowStart - tolerance, rowEnd + tolerance].
   *  Binary search + linear walk; O(log N + k). Returns each word with its `globalIdx`
   *  so callers can populate the legacy `_wordEls` array.
   *
   *  Tolerance exists because AsrProvider's word-start times can drift a second or two
   *  from SubsProvider's row boundaries (different transcribers, different timing models);
   *  the per-row text-alignment in `_alignAndBuildSpans` ignores false candidates,
   *  so a wide tolerance is safe and prevents words from being lost at boundaries. */
  function wordsForRowRange(rowStart, rowEnd) {
    if (!_words.length) return [];
    var TOL = 1.5;
    var lo = rowStart - TOL;
    var hi = rowEnd + TOL;
    // Binary search: first idx where _words[idx].start >= lo
    var l = 0, r = _words.length - 1, first = _words.length;
    while (l <= r) {
      var m = (l + r) >> 1;
      if (_words[m].start >= lo) { first = m; r = m - 1; }
      else { l = m + 1; }
    }
    var out = [];
    for (var i = first; i < _words.length && _words[i].start <= hi; i++) {
      var w = _words[i];
      out.push({
        word: w.word, start: w.start, end: w.end,
        confidence: w.confidence, chunk_local_idx: w.chunk_local_idx,
        globalIdx: i,
      });
    }
    return out;
  }

  // ── Wave-loop state access (perf-sensitive — called every frame) ─────────

  /** Returns refs to the two lit-char Sets so the wave loop reads them ONCE per
   *  frame and iterates directly — no method-call overhead per char per frame. */
  function getLitSets() {
    return { lit: _waveLit, newLit: _waveNewLit };
  }

  /** Swap _waveLit ↔ _waveNewLit (called by wave loop at end of frame so the
   *  reused scratch becomes the current lit set). Avoids per-frame Set allocation. */
  function swapLitSets() {
    var tmp = _waveLit;
    _waveLit = _waveNewLit;
    _waveNewLit = tmp;
    _waveNewLit.clear();
  }

  /** Clear the new-lit scratch (used on first frame of a fresh video). */
  function clearNewLit() {
    _waveNewLit.clear();
  }

  function getRadiusSecCache() { return _waveRadiusSecCached; }
  function setRadiusSecCache(v) { _waveRadiusSecCached = v; }
  function invalidateRadiusSecCache() { _waveRadiusSecCached = null; }

  function getLastWaveTime() { return _lastWaveTime; }
  function setLastWaveTime(v) { _lastWaveTime = v; }

  // ── DOM-index access (read/write per word) ───────────────────────────────

  function setWordEl(key, el) { _wordElsByKey.set(key, el); }
  function getWordEl(key) { return _wordElsByKey.get(key); }
  function hasWordEl(key) { return _wordElsByKey.has(key); }
  function getWordElsByKeyMap() { return _wordElsByKey; }

  function setWordElByKey(key, el) { _wordElByKey.set(key, el); }
  function getWordElByKey(key) { return _wordElByKey.get(key); }
  function getWordElByKeyMap() { return _wordElByKey; }

  // ── Active-word tracking (DOM-bound, cleared on invalidate) ──────────────

  function getActiveWordKey() { return _activeWordKey; }
  function setActiveWordKey(v) { _activeWordKey = v; }

  function getActiveKey() { return _activeKey; }
  function setActiveKey(v) { _activeKey = v; }

  function getActiveWordIdx() { return _activeWordIdx; }
  function setActiveWordIdx(v) { _activeWordIdx = v; }

  function getActiveSubEl() { return _activeSubEl; }
  function setActiveSubEl(v) { _activeSubEl = v; }

  // ── Apply-path coordination ─────────────────────────────────────────────

  function getApplied() { return _applied; }
  function setApplied(v) { _applied = v; }

  function getAppliedPanel() { return _appliedPanel; }
  function setAppliedPanel(v) { _appliedPanel = v; }

  function getLastApplyAttempt() { return _lastApplyAttempt; }
  function setLastApplyAttempt(v) { _lastApplyAttempt = v; }

  // ── Direct array access (perf — apply paths walk these in tight loops) ──
  // Returning a reference, not a copy. Callers MUST NOT replace the array;
  // mutate-in-place ops only via the writer methods above (push/sort/etc are
  // the writers' job). Read-only direct iteration is fine.

  function getWords() { return _words; }
  function getSynthWords() { return _synthWords; }
  /** Replace the synthetic-word timeline. In-place mutation so consumers'
   *  long-lived references stay valid. */
  function replaceSynthWords(arr) {
    _synthWords.length = 0;
    if (arr && arr.length) {
      for (var i = 0; i < arr.length; i++) _synthWords.push(arr[i]);
    }
  }
  function getLoadedRanges() { return _loadedRanges; }

  function getWordEls() { return _wordEls; }
  /** Replace the wordEls index. In-place mutation. */
  function replaceWordEls(arr) {
    _wordEls.length = 0;
    if (arr && arr.length) {
      for (var i = 0; i < arr.length; i++) _wordEls.push(arr[i]);
    }
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  /** Called from KaraokeManager.reset() between videos. Clears EVERYTHING —
   *  cache state AND DOM-bound state. Wave loop state cleared too (the rAF
   *  loop itself keeps running; it's a no-op when _words is empty).
   *
   *  ALL clears are in-place (Array.length=0 / Set.clear() / Map.clear()) so
   *  consumers' long-lived references stay valid across resets. */
  function resetState() {
    _words.length = 0;
    _wordKeySet.clear();
    _loadedRanges.length = 0;
    _synthWords.length = 0;
    _wordEls.length = 0;
    _wordElByKey.clear();
    _wordElsByKey.clear();
    _activeWordIdx = -1;
    _activeKey = null;
    _activeWordKey = null;
    _activeSubEl = null;
    _applied = false;
    _appliedPanel = null;
    _lastApplyAttempt = 0;
    // Wave: clear the scratch (the actually-lit set is cleared by the caller's
    // _waveClearAllLit() which also nukes per-char inline styles).
    _waveNewLit.clear();
    _waveRadiusSecCached = null;  // re-read on next tick (handles theme changes between videos)
    _lastWaveTime = -1;           // first tick of a fresh video always recomputes
  }

  /** Called from KaraokeManager.invalidate() on language/translation change.
   *  Clears DOM-bound state ONLY — cache state (_words, _loadedRanges) survives
   *  so language swaps don't re-fetch chunks the user already paid for.
   *  In-place mutation, same as resetState. */
  function invalidateDomState() {
    _wordEls.length = 0;
    _wordElByKey.clear();
    _wordElsByKey.clear();
    _activeWordIdx = -1;
    _activeKey = null;
    _activeWordKey = null;
    _activeSubEl = null;
    _applied = false;
    _appliedPanel = null;
    _lastApplyAttempt = 0;
    _synthWords.length = 0;  // synthetic timeline is rebuilt per render-pass; safe to drop
  }

  return {
    // Translation gate
    isOriginalVisible,
    // Word key utility
    wordKey,
    // Word data writers
    addWords, addLoadedRange,
    // Word data readers
    isRowFullyCoveredByLoadedWords, wordsForRowRange,
    getWords, getSynthWords, replaceSynthWords, getLoadedRanges,
    // Wave-loop state
    getLitSets, swapLitSets, clearNewLit,
    getRadiusSecCache, setRadiusSecCache, invalidateRadiusSecCache,
    getLastWaveTime, setLastWaveTime,
    // DOM index
    setWordEl, getWordEl, hasWordEl, getWordElsByKeyMap,
    setWordElByKey, getWordElByKey, getWordElByKeyMap,
    getWordEls, replaceWordEls,
    // Active-word tracking
    getActiveWordKey, setActiveWordKey,
    getActiveKey, setActiveKey,
    getActiveWordIdx, setActiveWordIdx,
    getActiveSubEl, setActiveSubEl,
    // Apply-path coordination
    getApplied, setApplied,
    getAppliedPanel, setAppliedPanel,
    getLastApplyAttempt, setLastApplyAttempt,
    // Lifecycle
    resetState, invalidateDomState,
  };
})();
