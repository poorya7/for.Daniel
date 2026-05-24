// karaoke-dom.js
//
// Owns: span DOM construction (.k-word + .k-ch wrapping), per-row apply paths
//       for the transcript and bilingual-sub layouts, the dispatcher that
//       paints both the transcript and subtitle buffers per chunk arrival,
//       and the panel/render-target resolution helpers used to find where
//       to paint.
// Reads from karaoke-store: words, wordKey, wordsForRowRange,
//       isRowFullyCoveredByLoadedWords, isOriginalVisible, and the DOM-index
//       Maps (wordElByKey + wordElsByKey + wordEls). Writes the same Maps
//       during build, plus apply-path scalars (applied, appliedPanel).
// Reads from karaoke-align: resolveRowEnd, rowStateHash, normalizeForMatch,
//       countWordTokens, segmentsForRow, assignSyntheticTimes,
//       rebuildSynthWordsFromDOM.
// Does NOT own: word fetching (chunk-loader), the rAF wave loop, alignment
//               math (lives in karaoke-align), session lifecycle.
// Imports allowed: ../core/state, ../core/helpers, ../translation/translation-state,
//                  ../ui/transcript-buffer, ../ui/entity-highlighter,
//                  ./karaoke-store, ./karaoke-align.
// Coupling notes: chunk-loader's success callback re-points at this module's
//                 applyWordSpansForActivePanel via setup({deps}); no back-import
//                 to karaoke.js core.
// Performance invariants:
//   - wrapCharsIntoSpan caches the char list directly on the parent .k-word
//     element (`__kchars`) so the wave loop reads it via wordEl.__kchars
//     instead of running a fresh querySelectorAll('.k-ch') on every word per
//     frame. Without this, the wave loop ran 360-600 doc lookups/sec on a
//     long transcript.
//   - applyWordSpans / applyWordSpansToSubs are idempotent via the per-row
//     dataset.karaokeState hash; rebuilding the same word set is a no-op.
//   - In lazy mode, rows whose audio range hasn't been fetched yet are left
//     as plain text (text-preserving) — adjacent chunk arrival fills them
//     later without forcing a re-render of the whole transcript.
import { AppState } from '../core/state.js';
import { tState } from '../translation/translation-state.js';
import { TranscriptBuffer } from '../ui/transcript-buffer.js';
import { EntityHighlighter } from '../ui/entity-highlighter.js';
import { KaraokeStore } from './karaoke-store.js';
import { KaraokeAlign } from './karaoke-align.js';

export const KaraokeDom = (function () {
  'use strict';

  // ── Bridge refs to store-owned state (in-place mutation discipline keeps
  // these refs valid forever; store NEVER reassigns the Maps/arrays). ──
  var _words = KaraokeStore.getWords();
  var _wordEls = KaraokeStore.getWordEls();
  var _wordElByKey = KaraokeStore.getWordElByKeyMap();
  var _wordElsByKey = KaraokeStore.getWordElsByKeyMap();

  // ── Panel + render-target resolution ───────────────────────────────────

  /** Return the visible transcript panel (desktop-aware). */
  function getActivePanel() {
    return TranscriptBuffer.getActive('transcript');
  }

  /**
   * Resolve the actual container holding the rendered transcript rows.
   * Tries the active panel first (production crossfade-buffer path), then
   * falls back to a document-wide search so the apply paths still work when
   * content lives outside the buffer (e.g., mobile flat-transcript layout
   * renders into `.flat-transcript-content` which can sit in a different
   * wrapper). Without this fallback, karaoke would silently no-op in any
   * layout where the buffer isn't the direct ancestor of the rows.
   */
  function resolveRenderTarget() {
    var panel = getActivePanel();
    if (panel) {
      var hasRows = panel.querySelector('.transcript-line, .transcript-paragraph') ||
                    panel.querySelector('.bilingual-sub');
      if (hasRows) return panel;
    }
    var docRows = document.querySelectorAll('.transcript-line, .transcript-paragraph');
    if (!docRows.length) return panel || null;
    var p = docRows[0].parentElement;
    while (p && p.querySelectorAll('.transcript-line, .transcript-paragraph').length < docRows.length) {
      p = p.parentElement;
    }
    return p || docRows[0].parentElement;
  }

  function isApplied() {
    // Doc-wide check (not active-panel only) because on mobile the active
    // panel returned by `getActivePanel()` is the empty crossfade buffer —
    // the actual rendered content lives in `.flat-transcript-content` inside
    // the outer panel wrapper, not in the buffer. A panel-only check returned
    // false on mobile, made syncWord hit its throttle, and the active-word
    // highlight never advanced past whatever span it picked on the first tick.
    return document.querySelector('.k-word') !== null;
  }

  // ── DOM building ────────────────────────────────────────────────────────

  // Scripts that break under per-codepoint span splitting. See wrapCharsIntoSpan.
  // Hebrew U+0590-05FF, Arabic family U+0600-08FF + presentation forms,
  // Indic U+0900-0DFF, SE Asian U+0E00-0FFF + U+1000-109F + U+1780-17FF,
  // Mongolian U+1800-18AF, Syloti Nagri / Phags-pa U+A800-A82F + U+A840-A87F,
  // Meetei Mayek U+AA80-AAFF, Arabic Pres-A/B U+FB1D-FDFF + U+FE70-FEFF.
  var COMPLEX_SHAPING_RE = /[֐-׿؀-ࣿऀ-෿฀-࿿က-႟ក-៿᠀-᢯ꠀ-꠯ꡀ-꡿ꪀ-꫿יִ-﷿ﹰ-﻿]/;

  /**
   * Wrap each character of `text` as `<span class="k-ch">` inside `span`.
   * The wave loop sets a per-frame `--k` (0..1) on each .k-ch based on the
   * char's distance to the playback head; the CSS rule on .k-ch (in
   * karaoke.css) turns --k into the visible scale + glow. textContent of
   * the parent .k-word remains semantically equal to `text`.
   *
   * Cursive / complex-shaping scripts (Arabic family, Hebrew, Indic, Thai,
   * Lao, Khmer, Tibetan, Myanmar, Mongolian, Syriac, N'Ko) are wrapped as
   * a SINGLE .k-ch covering the whole word. Splitting these per codepoint
   * destroys the text run the engine needs for cursive joining / vowel-mark
   * positioning / conjuncts (Persian "سلام" rendered as disconnected letters
   * was the original bug report). The wave loop still drives `--k` on the
   * single .k-ch, so the highlight pulses once per word instead of sweeping
   * across chars — the right call for these scripts visually anyway.
   * Latin / Cyrillic / Greek / CJK ideographs split cleanly per codepoint.
   */
  function wrapCharsIntoSpan(span, text) {
    span.textContent = '';
    var chars;
    if (COMPLEX_SHAPING_RE.test(text)) {
      var oneCh = document.createElement('span');
      oneCh.className = 'k-ch';
      oneCh.textContent = text;
      span.appendChild(oneCh);
      chars = [oneCh];
    } else {
      chars = new Array(text.length);
      for (var i = 0; i < text.length; i++) {
        var ch = document.createElement('span');
        ch.className = 'k-ch';
        ch.textContent = text[i];
        span.appendChild(ch);
        chars[i] = ch;
      }
    }
    // Cache the char span list directly on the parent .k-word element so
    // the wave loop can read it via `wordEl.__kchars` instead of running a
    // fresh `querySelectorAll('.k-ch')` on every word, every frame. With
    // ~3-5 words in the wave window × 1-2 panels × 60 fps, that was 360-600
    // doc lookups per second on the prior implementation — the dominant
    // cause of desktop scroll lag.
    span.__kchars = chars;
    // __kmids (per-cluster horizontal mid-fractions) is populated by the
    // post-pass `measureClusterMids` AFTER `frag` is appended to the live
    // DOM — `getBoundingClientRect()` on a detached element returns 0×0,
    // which would silently make the wave's per-letter timing math worse,
    // not better. The wave loop falls back to uniform fractions until the
    // cache is populated; the build path is responsible for populating it.
    span.__kmids = null;
  }

  /**
   * Measure each `.k-ch`'s horizontal mid-point as a fraction of the parent
   * `.k-word`'s width. Caches the array on `wordEl.__kmids`. Used by the
   * wave loop to align per-letter peak times with the letter's actual
   * on-screen position rather than a uniform `(ci + 0.5) / n` fraction.
   *
   * REQUIRES the `.k-word` to be in the live DOM with stable layout.
   * Calling this on a detached element returns 0×0 from BCR; the function
   * detects that case and bails (leaves `__kmids` null → wave falls back
   * to uniform fractions, which is the documented degraded path).
   *
   * Cost: one read-only layout flush per `.k-word`. Build time runs at
   * ~1-2 calls/min/panel during steady playback (chunk arrivals on the
   * 5-min grid), so the amortized per-frame cost is essentially zero.
   * Invalidation events (font-load, resize, theme, A+/A−) re-run this
   * via `karaoke.js`'s debounced helper, OUTSIDE the rAF loop.
   */
  function measureClusterMids(wordEl) {
    var chars = wordEl.__kchars;
    if (!chars || !chars.length) return;
    if (chars.length === 1) {
      // Cursive / complex-shaping fallback (one .k-ch covers the whole
      // word). Math is identical to uniform (n=1, frac=0.5), but we set
      // __kmids = [0.5] explicitly so the wave loop hits the measured
      // path rather than the missing-cache fallback. This keeps the
      // fallback warn reserved for the genuine "missing or invalidated"
      // case it's meant to detect.
      wordEl.__kmids = [0.5];
      return;
    }
    var wRect = wordEl.getBoundingClientRect();
    var wordLeft = wRect.left;
    var wordWidth = wRect.width;
    if (wordWidth < 1) {
      // Detached, hidden, or zero-width. Leave __kmids null; wave will
      // fall back to uniform fractions on this word until the next
      // re-measure pass picks it up with valid layout.
      wordEl.__kmids = null;
      return;
    }
    var fracs = new Array(chars.length);
    for (var i = 0; i < chars.length; i++) {
      var r = chars[i].getBoundingClientRect();
      fracs[i] = ((r.left + r.width / 2) - wordLeft) / wordWidth;
    }
    wordEl.__kmids = fracs;
  }

  /**
   * Render karaoke spans into a container WITHOUT destroying its original text.
   *
   * Background: AsrProvider (ASR) and SubsProvider (subtitle) tokenize the same audio
   * differently — same words, slightly different timings, sometimes split/merged
   * differently. The OLD `_buildWordSpans` did `container.textContent = ''` and
   * wrote ONLY AsrProvider's matched words, which destroyed the original SubsProvider
   * text whenever alignment was imperfect. On mobile subtitle rows (~3s wide),
   * a single word leaking into a neighboring row's time bucket reduced rows
   * like "Welcome to The Daily Show. I'm Desi Lydic." down to just "We've".
   *
   * New behavior:
   *   1. Read original text from `container.textContent` (the SubsProvider source).
   *   2. Tokenize preserving whitespace (split into [word, space, word, ...]).
   *   3. For each AsrProvider word in `rowWords`, greedy-sequential match it to the
   *      next unmatched word-token by normalized text (lowercase, alpha+apostrophe).
   *   4. Rebuild the container preserving every original token; matched word
   *      tokens become `<span class="k-word" data-start="..." data-end="..." data-key="...">word</span>`,
   *      everything else (whitespace + unmatched words) stays as plain text.
   *
   * Result: the row text is ALWAYS preserved; karaoke timing is overlaid where
   * AsrProvider matched, no-op where it didn't. Rows are never gutted.
   *
   * Populates BOTH the global word-idx → span lookup (used by the active-word
   * highlight loop) AND the stable-key Map (for lazy-mode chunk rebinding).
   * Re-runs EntityHighlighter (C3) so spaCy NER coloring survives the rebuild.
   */
  function buildWordSpans(container, rowWords, rowStart, rowEnd) {
    var origText = container.textContent || '';
    if (!origText.trim() || !rowWords.length) return;

    // Tokenize preserving whitespace runs as separate tokens.
    var rawTokens = origText.split(/(\s+)/).filter(function (t) { return t.length > 0; });
    var parsed = [];
    for (var i = 0; i < rawTokens.length; i++) {
      var t = rawTokens[i];
      parsed.push({ text: t, isSpace: /^\s+$/.test(t), matched: null });
    }

    // Word-token-only index list (skip whitespace, pure-punct tokens, and
    // bracketed sound annotations like [LAUGHTER] / [CHEERING] / [BLEEP]).
    // Bracketed annotations are NOT spoken words — AsrProvider can't transcribe
    // them and the user shouldn't see a karaoke highlight pass through
    // them. Filtering them out here means they're left as plain text in
    // the row, never matched against AsrProvider, never given synthetic timing.
    var wordTokenIdxs = [];
    for (var iw = 0; iw < parsed.length; iw++) {
      if (parsed[iw].isSpace) continue;
      if (!KaraokeAlign.normalizeForMatch(parsed[iw].text)) continue;
      // Bracketed annotation, possibly with trailing punct: [CHEERING], [LAUGHTER].
      // Strip surrounding spaces (AsrProvider words sometimes carry leading whitespace).
      var trimmed = parsed[iw].text.trim();
      if (/^\[[^\]]+\][.,!?;:]?$/.test(trimmed)) continue;
      wordTokenIdxs.push(iw);
    }
    var numWordTokens = wordTokenIdxs.length;
    if (numWordTokens === 0) return;

    // Time-proximity matcher (replaces the earlier sequential-cursor approach).
    //
    // Why proximity, not sequential cursor: candidates within the row's time
    // window (with tolerance) can include words from neighboring rows. A
    // sequential cursor that advances on every match can be "starved" by an
    // earlier wrong-row candidate matching first and consuming all the cursor
    // positions that a later, correct candidate would have used. Example
    // (row 0:07, "Major League Baseball is giving you a stomachache."): the
    // PREVIOUS row's AsrProvider "is" leaks into candidates, claims the original
    // "is" slot at token-position 3, advances cursor past 0, and starves the
    // actual row-aligned "Major"/"League"/"Baseball" matches that should have
    // landed at token-positions 0/1/2.
    //
    // Proximity fix: for each original word token, find ALL unclaimed AsrProvider
    // candidates with matching text, score each by |asr_provider.start - expected
    // time of this token in the row|, and pick the closest. Wrong-row
    // candidates score badly (far from expected time) and lose to in-row
    // candidates whenever those exist; if no in-row candidate exists, the
    // wrong-row candidate is rejected by `MAX_SCORE` rather than producing
    // misaligned timing the user would visibly see.
    //
    // Falls back to sequence-only matching if rowStart/rowEnd weren't passed
    // (legacy callers). Same complexity O(n·m) per row, with n=tokens and
    // m=candidates — both small in practice (~10·15 = 150 ops).
    var hasTime = (typeof rowStart === 'number') && (typeof rowEnd === 'number') && rowEnd > rowStart;
    var rowDur = hasTime ? (rowEnd - rowStart) : 0;
    // A candidate this far (or further) from the token's expected position
    // is treated as wrong-row and refused. Half the row duration is the
    // sweet spot — wide enough to absorb ASR drift inside the row, narrow
    // enough to reject neighbor-row leakage. Capped at 1.0s on the row-half
    // term so very short subtitle rows (~1.5s) don't get a tolerance wider
    // than the row's own audio span, which would let neighbor-row words
    // win the proximity match.
    var MAX_SCORE = hasTime ? (Math.min(rowDur * 0.5, 1.0) + 0.25) : Infinity;
    var claimed = {};

    for (var ti = 0; ti < numWordTokens; ti++) {
      var pt = parsed[wordTokenIdxs[ti]];
      var pNorm = KaraokeAlign.normalizeForMatch(pt.text);
      var expectedTime = hasTime
        ? rowStart + (ti / Math.max(1, numWordTokens - 1)) * rowDur
        : 0;

      // Collect ALL unclaimed candidates whose normalized text matches.
      // Then:
      //   - If exactly one candidate exists in this row's range, it's
      //     UNAMBIGUOUS — accept it regardless of expected-time score.
      //     `wordsForRowRange` already filtered candidates to a window
      //     near the row, so a unique text-match is genuinely the right
      //     word; rejecting it on a tight expected-time score (which
      //     fails when AsrProvider has multi-second gaps) is what was leaving
      //     names like "Kristi" / "Noem" as synth and producing the
      //     "wave runs ahead and drifts" pattern in long single-row
      //     paragraphs.
      //   - If multiple candidates exist (same word said twice in the
      //     row), use proximity to disambiguate. MAX_SCORE still
      //     applies here as the tiebreaker against far-row leakage.
      var candidates = [];
      for (var wi = 0; wi < rowWords.length; wi++) {
        if (claimed[wi]) continue;
        if (KaraokeAlign.normalizeForMatch(rowWords[wi].word) !== pNorm) continue;
        candidates.push(wi);
      }
      var bestIdx = -1;
      if (candidates.length === 1) {
        bestIdx = candidates[0];
      } else if (candidates.length > 1) {
        var bestScore = Infinity;
        for (var ci = 0; ci < candidates.length; ci++) {
          var wiC = candidates[ci];
          var score = hasTime
            ? Math.abs(rowWords[wiC].start - expectedTime)
            : wiC;
          if (score < bestScore) {
            bestScore = score;
            bestIdx = wiC;
          }
        }
        if (bestScore > MAX_SCORE) bestIdx = -1;
      }
      if (bestIdx >= 0) {
        pt.matched = rowWords[bestIdx];
        claimed[bestIdx] = true;
      }
    }

    // ── Synthetic timing for unmatched tokens (segment-anchored) ───────
    //
    // Why interpolate at all: AsrProvider covers ~96% of words but the missing
    // 4% (mostly silent leading intros, sound annotations AsrProvider can't
    // hear) leave gaps in the karaoke timing. With matched-only spans the
    // active-word highlight has nowhere to land in those gaps and visibly
    // skips. Filling unmatched tokens with interpolated timing keeps the
    // highlight smoothly visiting every rendered word.
    //
    // Why anchor on SubsProvider segments (not just row bounds): a mobile-merged
    // row can span 3+ SubsProvider segments (~3s each). Interpolating linearly
    // across the WHOLE row distributes time uniformly across content that
    // actually has natural pauses + variable speech rate at segment
    // boundaries — synth runs ahead during pauses, then the next real
    // AsrProvider anchor snaps the highlight backward (visible "jump-back").
    // Each SubsProvider segment IS a known timing boundary; clamping synth
    // tokens to their containing segment's [start, end] tightens the
    // anchors ~3x and keeps the highlight inside the actual segment that
    // contains the speech for those words. This is the same pattern Apple
    // Music sync'd lyrics use: line-level timestamps as hard anchors,
    // word-level interpolation only WITHIN each line.
    //
    // Synthetic spans are tagged with a `.k-word-synth` class so styling
    // can distinguish them if needed (currently identical visual to
    // matched). Their data-key uses a `synth:` prefix to never collide
    // with AsrProvider's wordKey format.
    if (hasTime) {
      var rowSegments = KaraokeAlign.segmentsForRow(rowStart, rowEnd);
      KaraokeAlign.assignSyntheticTimes(parsed, wordTokenIdxs, rowStart, rowEnd, rowSegments);
    }

    // Build the result fragment: every original token contributes; matched
    // word-tokens become .k-word spans with AsrProvider timing, unmatched word
    // tokens become .k-word.k-word-synth spans with interpolated timing,
    // whitespace + non-word tokens stay as plain text nodes.
    var frag = document.createDocumentFragment();
    var matchedAny = false;
    for (var pi = 0; pi < parsed.length; pi++) {
      var pt2 = parsed[pi];
      if (pt2.matched) {
        var key = KaraokeStore.wordKey(pt2.matched);
        var span = document.createElement('span');
        span.className = 'k-word';
        wrapCharsIntoSpan(span, pt2.text);
        span.dataset.start = pt2.matched.start;
        span.dataset.end = pt2.matched.end;
        span.dataset.key = key;
        frag.appendChild(span);
        _wordElByKey.set(key, span);
        // Perf: also push into the multi-element index used by the wave
        // loop. Multiple .k-word spans can share the same data-key when
        // the same word is painted into both the transcript panel AND
        // the subtitle panel — we need to light all of them in sync.
        var arr = _wordElsByKey.get(key);
        if (!arr) { arr = []; _wordElsByKey.set(key, arr); }
        if (arr.indexOf(span) < 0) arr.push(span);
        if (typeof pt2.matched.globalIdx === 'number') {
          _wordEls[pt2.matched.globalIdx] = span;
        }
        matchedAny = true;
      } else if (pt2.synthetic) {
        var sStart = pt2.synthetic.start;
        var sEnd = pt2.synthetic.end;
        // Synthetic key never collides with AsrProvider's wordKey (`<ms>:<ms>:<word>:<idx>`)
        // because of the `synth:` prefix.
        var synthKey = 'synth:' + Math.round(sStart * 1000) + ':' + Math.round(sEnd * 1000) + ':' + pi;
        var ssp = document.createElement('span');
        ssp.className = 'k-word k-word-synth';
        wrapCharsIntoSpan(ssp, pt2.text);
        ssp.dataset.start = sStart;
        ssp.dataset.end = sEnd;
        ssp.dataset.key = synthKey;
        frag.appendChild(ssp);
        // Perf: index synth spans by key too (same reasoning as above).
        var sarr = _wordElsByKey.get(synthKey);
        if (!sarr) { sarr = []; _wordElsByKey.set(synthKey, sarr); }
        if (sarr.indexOf(ssp) < 0) sarr.push(ssp);
        // Note: synth-words timeline is rebuilt from DOM by the dispatcher
        // after all panels render — see KaraokeAlign.rebuildSynthWordsFromDOM.
        // We do NOT push here because rows that hash-skip wouldn't push,
        // leaving their DOM synth spans orphaned from the active-highlight
        // lookup.
        matchedAny = true;
      } else {
        frag.appendChild(document.createTextNode(pt2.text));
      }
    }

    // Skip the swap if nothing matched — leaves the row's existing DOM intact
    // (avoids a needless reflow + preserves any prior EntityHighlighter spans).
    if (!matchedAny) return;

    // Drop the about-to-be-detached .k-word elements from the wave-loop
    // index so we don't leak stale refs across chunk re-applies. The
    // new spans we just built were pushed in above; only the *old*
    // children of `container` need cleaning.
    container.querySelectorAll('.k-word').forEach(function (oldKw) {
      var k = oldKw.dataset.key;
      if (!k) return;
      var arr2 = _wordElsByKey.get(k);
      if (!arr2) return;
      var idx = arr2.indexOf(oldKw);
      if (idx >= 0) arr2.splice(idx, 1);
      if (!arr2.length) _wordElsByKey.delete(k);
    });
    container.textContent = '';
    container.appendChild(frag);
    EntityHighlighter.highlightEntities(container);

    // Post-pass: measure per-cluster horizontal mid-fractions on every
    // `.k-word` we just attached. MUST run after `appendChild(frag)` —
    // BCR on a detached element returns 0×0 and would make every char's
    // wave-peak time collapse to `w.start`, strictly worse than uniform.
    // One read-only layout flush per chunk-arrival rebuild; well under
    // the rAF perf invariants since build runs at 1-2/min/panel during
    // steady playback. (See `measureClusterMids` for full rationale.)
    var newKwords = container.querySelectorAll('.k-word');
    for (var mi = 0; mi < newKwords.length; mi++) {
      measureClusterMids(newKwords[mi]);
    }
  }

  // ── Apply paths ─────────────────────────────────────────────────────────

  /**
   * Apply word spans to `.ts-text` containers in the active panel.
   * - Idempotent: per-row `dataset.karaokeState` hash skip avoids re-mutation
   *   of rows already rendered with the same word set.
   * - Lazy-aware: in `karaokeMode === 'lazy'`, skips rows not fully covered by
   *   the loaded ranges (text-preserving — leaves plain text; adjacent chunk
   *   arrival fills them later).
   */
  function applyWordSpans(panel) {
    if (!panel || !_words.length) return;
    var rows = panel.querySelectorAll('.transcript-line, .transcript-paragraph');
    if (!rows.length) return;

    var isLazyMode = AppState.karaokeMode === 'lazy';

    rows.forEach(function (row) {
      var chip = row.querySelector('.ts-chip');
      var tsText = row.querySelector('.ts-text');
      if (!chip || !tsText) return;

      var rowStart = Number(chip.dataset.time);
      var nextRow = row.nextElementSibling;
      while (nextRow && nextRow.classList.contains('bilingual-sub')) nextRow = nextRow.nextElementSibling;
      var rowEnd = KaraokeAlign.resolveRowEnd(nextRow ? nextRow.querySelector('.ts-chip') : null, rowStart);

      // Lazy mode: skip rows whose audio range hasn't been fetched yet — the
      // adjacent chunk's arrival will fill them later. Text-preserving so the
      // user sees the original transcript text in the meantime.
      if (isLazyMode && !KaraokeStore.isRowFullyCoveredByLoadedWords(rowStart, rowEnd)) return;

      // Per-row candidate scan via binary search. Each row gets ALL words in
      // its time range (with tolerance for ASR-vs-subtitle clock drift), and
      // the text-alignment matcher in buildWordSpans picks the ones whose
      // text actually appears in the row. No shared walker → no word can be
      // "stolen" from a row by an earlier neighbor across a fuzzy boundary.
      var rowWords = KaraokeStore.wordsForRowRange(rowStart, rowEnd);
      if (!rowWords.length) return;

      var hash = KaraokeAlign.rowStateHash(rowWords);
      // Idempotent skip — but ALSO require .k-word spans to be present.
      // Without the DOM check, a stale `dataset.karaokeState` from a previous
      // render whose spans were later wiped by `flat-transcript.updateItems`
      // (translation streaming, lang switch, bilingual toggle — anything that
      // does `text.textContent = item.text`) would make us skip re-rendering
      // a row that's now plain text. Result before this fix: rows stuck as
      // plain text after rapid cycling. With the DOM check, hash-skip is
      // correct only when the spans actually still exist.
      if (tsText.dataset.karaokeState === hash && tsText.querySelector('.k-word')) return;

      buildWordSpans(tsText, rowWords, rowStart, rowEnd);
      tsText.dataset.karaokeState = hash;
    });

    if (_wordElByKey.size > 0) {
      KaraokeStore.setApplied(true);
      KaraokeStore.setAppliedPanel(panel);
    }
  }

  /**
   * Apply word spans to `.bilingual-sub` containers (original-text annotations
   * shown in dual mode under translated `.ts-text`). Same idempotency + lazy
   * coverage as applyWordSpans.
   */
  function applyWordSpansToSubs(panel) {
    if (!panel || !_words.length) return;
    // Original-language text lives in different elements depending on layout:
    //   - Desktop bilingual: `.bilingual-sub` (added by casual-mode's
    //     `_addTranscriptAnnotations` after the row is rendered).
    //   - Mobile bilingual: `.ts-sub` (built into the flat-transcript row's
    //     2-column grid). casual-mode SKIPS the bilingual-sub path on mobile
    //     (`if (!isMobileCheck)`), so `.bilingual-sub` is never created there.
    // Querying BOTH catches whichever layout is active. We ALSO accept .ts-sub
    // wherever it lives in the panel (not just under .flat-transcript-content)
    // because mobile rebuild paths can briefly remove the wrapper. Empty
    // .ts-sub elements (single-lang mode where subText is unset) get filtered
    // out by buildWordSpans's `if (!origText.trim())` guard.
    var subs = panel.querySelectorAll('.bilingual-sub:not(.bilingual-sub-hidden), .ts-sub');
    if (!subs.length) return;

    var isLazyMode = AppState.karaokeMode === 'lazy';

    subs.forEach(function (sub) {
      // .bilingual-sub is a CHILD of the row (.transcript-paragraph /
      // .transcript-line), not a sibling — closest() walks up the tree to
      // find the containing row. The earlier sibling-walk implementation
      // landed on .ts-text or .ts-chip and silently skipped every sub.
      var row = sub.closest('.transcript-paragraph, .transcript-line');
      if (!row) return;
      var chip = row.querySelector('.ts-chip');
      if (!chip) return;

      var rowStart = Number(chip.dataset.time);
      // Next row's chip → this row's end. Walk forward through row siblings
      // (rows are direct siblings to each other in the panel; non-row
      // intermediates are skipped). Falls through to KaraokeAlign.resolveRowEnd's
      // duration-based fallback when this is the last row.
      var nextRow = row.nextElementSibling;
      while (nextRow && !nextRow.classList.contains('transcript-paragraph') &&
             !nextRow.classList.contains('transcript-line')) {
        nextRow = nextRow.nextElementSibling;
      }
      var rowEnd = KaraokeAlign.resolveRowEnd(nextRow ? nextRow.querySelector('.ts-chip') : null, rowStart);

      // Lazy: leave uncovered rows as plain text; adjacent chunk arrival
      // backfills them later. Same per-row binary-search scan as the main
      // path so original text is preserved (see applyWordSpans comments).
      if (isLazyMode && !KaraokeStore.isRowFullyCoveredByLoadedWords(rowStart, rowEnd)) return;

      var rowWords = KaraokeStore.wordsForRowRange(rowStart, rowEnd);
      if (!rowWords.length) return;

      var hash = KaraokeAlign.rowStateHash(rowWords);
      // Same stale-marker guard as the main path — see applyWordSpans for
      // the full rationale. Hash-skip requires both the marker AND the actual
      // .k-word spans to be present, otherwise an external wipe leaves the
      // row stuck plain.
      if (sub.dataset.karaokeState === hash && sub.querySelector('.k-word')) return;

      buildWordSpans(sub, rowWords, rowStart, rowEnd);
      sub.dataset.karaokeState = hash;
    });

    if (_wordElByKey.size > 0) {
      KaraokeStore.setApplied(true);
      KaraokeStore.setAppliedPanel(panel);
    }
  }

  /**
   * Shared dispatcher: paints word spans into BOTH the transcript and subtitle
   * buffers per chunk-arrival. On desktop both panels are visible side-by-side;
   * if we only painted the "active" one, the other would silently flicker
   * empty (or stale) until syncWord's tab-switch self-heal eventually caught
   * up. On mobile only one buffer is shown at a time, but painting both is
   * harmless (hidden DOM, no visible cost).
   *
   * Routing per buffer:
   *   - displayMode === 'bilingual' / 'bilingual-swapped' → ToSubs
   *     (original text lives in `.bilingual-sub` children of each row)
   *   - else → main (original text lives in `.ts-text`)
   *
   * Easing reseed only on the active panel — that's the one user sees scroll;
   * the hidden buffer doesn't drive the easing loop, so reseeding there is a
   * waste.
   *
   * Falls back to a doc-wide row search if neither buffer contains rows
   * (mobile flat-transcript layout puts content in `.flat-transcript-content`
   * inside one of the wrappers; this catches edge cases where the buffer
   * isn't the direct ancestor of the rendered rows).
   */
  function applyWordSpansForActivePanel() {
    var isBilingual = tState.displayMode === 'bilingual' ||
                      tState.displayMode === 'bilingual-swapped';

    // Iterate the OUTER panel wrapper. It exists + contains rows on BOTH
    // layouts: desktop nests an active buffer (one of two crossfade buffers)
    // inside; mobile nests a flat-transcript-content directly (no buffer).
    // Iterating buffers alone misses mobile (buffers are empty); the outer-
    // panel pass gets the walker the right host on either layout.
    [
      { id: 'fullTranscriptPanel', mode: 'transcript' },
    ].forEach(function (p) {
      var outer = document.getElementById(p.id);
      if (!outer) return;
      // Prefer the active crossfade buffer when present (desktop) so we don't
      // double-apply across active + standby buffers; fall back to the outer
      // panel itself when there's no buffer with rows (mobile flat-transcript).
      var target = TranscriptBuffer.getActive(p.mode);
      var targetHasRows = target && (
        target.querySelector('.transcript-line, .transcript-paragraph') ||
        target.querySelector('.bilingual-sub')
      );
      if (!targetHasRows) {
        var outerHasRows = outer.querySelector('.transcript-line, .transcript-paragraph') ||
                           outer.querySelector('.bilingual-sub');
        if (!outerHasRows) return;
        target = outer;
      }
      if (isBilingual) {
        applyWordSpansToSubs(target);
      } else {
        applyWordSpans(target);
      }
    });

    // Rebuild the synthetic-word timeline from the actual rendered DOM. We
    // do this after BOTH panels have been processed so we capture every
    // synth span regardless of which row hash-skipped or freshly rebuilt.
    // Source-of-truth = DOM (not buildWordSpans push) avoids drift between
    // the rendered spans and the active-highlight lookup.
    KaraokeAlign.rebuildSynthWordsFromDOM();

    var activePanel = getActivePanel();
    if (activePanel && window.PlayerManager &&
        typeof window.PlayerManager.reseedEasingCurrent === 'function') {
      window.PlayerManager.reseedEasingCurrent(activePanel);
    }
  }

  return {
    // Panel resolution
    getActivePanel,
    resolveRenderTarget,
    isApplied,
    // DOM building (exposed for test-suite injectFakeChunk path)
    wrapCharsIntoSpan,
    buildWordSpans,
    // Layout cache (exposed so karaoke.js's invalidation helper can
    // re-measure visible .k-words after font/resize/theme/A+/A−).
    measureClusterMids,
    // Apply paths
    applyWordSpans,
    applyWordSpansToSubs,
    applyWordSpansForActivePanel,
  };
})();
