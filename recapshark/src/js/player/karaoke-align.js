// karaoke-align.js
//
// Owns: pure alignment math + binary search. Cross-source word matching
//       (AsrProvider ASR vs SubsProvider transcript), synthetic-timing interpolation
//       for tokens AsrProvider missed, row-end resolution, row-state hashing,
//       active-word lookup at a given playhead.
// Reads from karaoke-store: nothing in pure helpers; rebuildSynthWordsFromDOM
//                           writes the rebuilt array via replaceSynthWords.
// Writes to karaoke-store: replaceSynthWords (only inside rebuildSynthWordsFromDOM).
// Does NOT own: word data, DOM building, chunk loading, the wave loop,
//               session lifecycle.
// Imports allowed: ../core/state, ./karaoke-store.
// Coupling notes: pure functions used by both karaoke-dom (build path) and
//                 karaoke-wave (per-frame anchor lookup) and karaoke.js core
//                 (syncWord active-word lookup). No callers cross-import.
// Performance invariants:
//   - findWordAt is O(log N) binary search. Wave loop calls it once per
//     frame per word array (AsrProvider + synth) — must stay logarithmic.
//   - assignSyntheticTimes is O(N·M) where N = unmatched tokens in a row
//     (~10) and M = segments overlapping the row (~3). Called once per row
//     per build (not per frame).
import { AppState } from '../core/state.js';
import { KaraokeStore } from './karaoke-store.js';

export const KaraokeAlign = (function () {
  'use strict';

  /**
   * Resolve a row's end time. Last row falls back to video duration so coverage
   * checks still work; NEVER returns Infinity (per plan §6 Phase 2 step 1 —
   * Infinity would mark every last row as uncovered in lazy mode and karaoke
   * would never apply there).
   */
  function resolveRowEnd(nextChip, rowStart) {
    if (nextChip) return Number(nextChip.dataset.time);
    var dur =
      (AppState.videoData && AppState.videoData.duration) ||
      (AppState.player && typeof AppState.player.getDuration === 'function' && AppState.player.getDuration()) ||
      0;
    return dur > 0 ? dur : (rowStart + 30);
  }

  /**
   * Compact deterministic hash for a row's word set. Used as `dataset.karaokeState`
   * to skip re-rendering rows that already match. Same word set in / same hash out.
   */
  function rowStateHash(rowWords) {
    if (!rowWords.length) return '';
    var first = rowWords[0];
    var last = rowWords[rowWords.length - 1];
    return rowWords.length + ':' + Math.round(first.start * 1000) + ':' + Math.round(last.end * 1000);
  }

  /**
   * Normalize a word for cross-source matching (AsrProvider ASR vs SubsProvider transcript).
   * Lowercase + strip non-word chars. Keeps apostrophes (we've / don't / Noem's).
   * Two words match if their normalized forms are equal.
   *
   * Unicode-aware: \p{L} / \p{N} so Persian / Arabic / CJK / Cyrillic / etc.
   * normalize to themselves instead of an empty string. ASCII \w would strip
   * every non-Latin codepoint and `wordTokenIdxs` would come up empty for
   * non-English videos — no .k-word spans built, no karaoke. The /u flag is
   * required to enable Unicode property escapes.
   */
  function normalizeForMatch(s) {
    return (s || '').toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');
  }

  /**
   * Count the WORD tokens in a chunk of text (whitespace-split, drops pure-punct
   * and bracketed annotations like `[CHEERING]`). Used to map a mobile-merged
   * row's tokens back to their source SubsProvider segments.
   */
  function countWordTokens(text) {
    if (!text) return 0;
    var n = 0;
    var parts = text.split(/\s+/);
    for (var i = 0; i < parts.length; i++) {
      var p = (parts[i] || '').trim();
      if (!p) continue;
      if (/^\[[^\]]+\][.,!?;:]?$/.test(p)) continue;
      if (!normalizeForMatch(p)) continue;
      n++;
    }
    return n;
  }

  /**
   * Return the SubsProvider subtitle segments overlapping the row's time range.
   * Used as anchors for synthetic-timing interpolation: an unmatched token's
   * synth time is clamped within its containing segment's [start, end] (much
   * tighter than the row's [start, end] which can span multiple segments on
   * mobile-merged rows). Linear scan — segments are typically a few hundred
   * per video, well under any need for binary search.
   */
  function segmentsForRow(rowStart, rowEnd) {
    var segs = AppState.subtitleSegments;
    if (!segs || !segs.length) return [];
    var out = [];
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i];
      if (s.start < rowEnd && s.end > rowStart) out.push(s);
    }
    return out;
  }

  /**
   * Assign synthetic { start, end } timing to each unmatched word token.
   *
   * Anchoring strategy:
   *   1. For each unmatched token, find its containing SubsProvider segment by
   *      looking up the segment whose [start, end] contains the token's
   *      expected position (rowStart + ti/N * rowDur).
   *   2. Group consecutive unmatched tokens that share the SAME segment into
   *      one run.
   *   3. The run's bounds are tightened by:
   *        - lower = max(segment.start, previous matched word's end)
   *        - upper = min(segment.end, next matched word's start)
   *      so synth never crosses a AsrProvider anchor or a segment boundary.
   *   4. Tokens in the run are distributed evenly across [lower, upper].
   *
   * Falls back to row-bound interpolation if no segments are passed (e.g.,
   * when AppState.subtitleSegments is empty).
   */
  function assignSyntheticTimes(parsed, wordTokenIdxs, rowStart, rowEnd, segments) {
    var numWordTokens = wordTokenIdxs.length;
    var rowDur = rowEnd - rowStart;
    var hasSegs = segments && segments.length > 0;

    // Map each row word-token to its containing SubsProvider segment by counting
    // how many words each segment contributes. Mobile rows are concatenations
    // of one or more whole segments, so the first N tokens belong to seg0,
    // the next M belong to seg1, etc. This is far more accurate than mapping
    // by expected time — expected-time mapping crams all extra tokens into
    // whichever segment overlaps most of the row, even if the text-position
    // of those tokens clearly belongs to a later segment (e.g., "I'm Desi
    // Lydic." text-wise in seg1 but expected-time in seg0).
    var tokenToSeg = new Array(numWordTokens).fill(null);
    if (hasSegs) {
      var segIdx = 0;
      var consumedInSeg = 0;
      var segWordCount = countWordTokens(segments[0].text);
      for (var ti = 0; ti < numWordTokens; ti++) {
        // Advance past empty / exhausted segments.
        while (segIdx < segments.length && consumedInSeg >= segWordCount) {
          segIdx++;
          consumedInSeg = 0;
          segWordCount = (segIdx < segments.length) ? countWordTokens(segments[segIdx].text) : 0;
        }
        if (segIdx >= segments.length) break;
        tokenToSeg[ti] = segments[segIdx];
        consumedInSeg++;
      }
      // Trailing tokens with no segment fall back to last seg (rare — would
      // mean row text is longer than the segments cover, e.g., row contains
      // text from a segment we missed).
      for (var ti2 = 0; ti2 < numWordTokens; ti2++) {
        if (!tokenToSeg[ti2]) tokenToSeg[ti2] = segments[segments.length - 1];
      }
    }

    var i = 0;
    while (i < numWordTokens) {
      if (parsed[wordTokenIdxs[i]].matched) { i++; continue; }

      var runStart = i;
      var runSeg = tokenToSeg[i];
      // Extend run while the next token is also unmatched AND maps to the
      // same segment — splitting at segment boundaries is what gives synth
      // its tight per-segment timing.
      while (
        i + 1 < numWordTokens &&
        !parsed[wordTokenIdxs[i + 1]].matched &&
        tokenToSeg[i + 1] === runSeg
      ) {
        i++;
      }
      var runEnd = i;
      var runLen = runEnd - runStart + 1;

      // Anchor bounds for this run. Default to row, refine with segment
      // heuristic, then prefer adjacent matched-word anchors when the
      // immediately adjacent token IS that matched anchor (no intermediate
      // run on that side). This is load-bearing for the "synth crammed at
      // gap start" bug: when AsrProvider has a multi-second gap that segment.end
      // is too tight to span, next-matched.start gives the actual reach.
      var lower = rowStart;
      var upper = rowEnd;
      if (runSeg) {
        lower = Math.max(lower, runSeg.start);
        upper = Math.min(upper, runSeg.end);
      }
      if (runStart > 0 && parsed[wordTokenIdxs[runStart - 1]].matched) {
        var prevEnd = parsed[wordTokenIdxs[runStart - 1]].matched.end;
        if (prevEnd > lower) lower = prevEnd;
      }
      if (runEnd + 1 < numWordTokens && parsed[wordTokenIdxs[runEnd + 1]].matched) {
        var nextStart = parsed[wordTokenIdxs[runEnd + 1]].matched.start;
        if (nextStart > lower) upper = Math.min(rowEnd, nextStart);
      }

      var span = upper - lower;
      if (!(span > 0)) span = 0.001 * runLen;
      var perTokenDur = span / runLen;
      for (var ri = 0; ri < runLen; ri++) {
        parsed[wordTokenIdxs[runStart + ri]].synthetic = {
          start: lower + ri * perTokenDur,
          end: lower + (ri + 1) * perTokenDur,
        };
      }
      i++;
    }
  }

  /**
   * Binary search: find the last word where word.start <= t.
   * Works with any array of {start, end} objects.
   */
  function findWordAt(t, wordsArr) {
    if (!wordsArr.length) return -1;
    var lo = 0, hi = wordsArr.length - 1, best = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (wordsArr[mid].start <= t) { best = mid; lo = mid + 1; }
      else { hi = mid - 1; }
    }
    if (best >= 0 && wordsArr[best].end < t - 0.3) {
      if (best + 1 < wordsArr.length && wordsArr[best + 1].start <= t) return best + 1;
    }
    return best;
  }

  /**
   * Sync the karaoke-store synth-words timeline with the synthetic karaoke
   * spans currently in the DOM. Synthetic spans (`.k-word.k-word-synth`) are
   * produced by karaoke-dom's buildWordSpans for original word tokens that
   * AsrProvider didn't transcribe, with interpolated timing between matched
   * anchors. The active-highlight loop searches BOTH _words (AsrProvider) and
   * _synthWords (interpolated) so the highlight visits every rendered word.
   *
   * Rebuild from DOM (not from a push at construction time) because rows that
   * hash-skip the rebuild path would otherwise leave stale entries in the
   * array, and panels that share row content (transcript + subtitle) would
   * each push duplicates.
   */
  function rebuildSynthWordsFromDOM() {
    var spans = document.querySelectorAll('.k-word.k-word-synth');
    var out = [];
    for (var i = 0; i < spans.length; i++) {
      var s = spans[i];
      var st = +s.dataset.start;
      var en = +s.dataset.end;
      if (isNaN(st) || isNaN(en)) continue;
      out.push({
        word: s.textContent, start: st, end: en,
        key: s.dataset.key, synthetic: true,
      });
    }
    out.sort(function (a, b) { return a.start - b.start; });
    KaraokeStore.replaceSynthWords(out);
  }

  return {
    resolveRowEnd,
    rowStateHash,
    normalizeForMatch,
    countWordTokens,
    segmentsForRow,
    assignSyntheticTimes,
    findWordAt,
    rebuildSynthWordsFromDOM,
  };
})();
