// karaoke-wave.js
//
// Owns: the per-frame rAF wave loop. Char-level continuous-highlight loop
//       running at the browser frame rate — every char near the playhead
//       gets a smooth `--k` value (0..1) producing sub-letter motion with
//       multiple chars lit at once and falloff to neighbors. Also owns the
//       active-line tracker (`.karaoke-active-word` class on the wave-peak
//       .k-word) used by flat-transcript / player.js scroll anchoring.
// Reads from karaoke-store: words, synthWords, isOriginalVisible,
//       wordElsByKeyMap (per-word .k-word lookup), the lit Sets, the
//       cached --karaoke-radius-sec, lastWaveTime, activeWordKey.
// Writes to karaoke-store: lit Sets (via swap), radiusSecCache, lastWaveTime,
//       activeWordKey.
// Reads from karaoke-align: findWordAt (binary search anchor for the wave
//       window).
// Does NOT own: word data, DOM building, chunk loading, alignment math,
//               session lifecycle.
// Imports allowed: ../core/state, ./karaoke-store, ./karaoke-align.
// Coupling notes: subscribes to no other karaoke module beyond store +
//                 align — the wave reads everything it needs from the
//                 store. setup({lookaheadMs}) supplies the audio-buffer
//                 compensation read once at init.
// Performance invariants:
//   - No per-frame querySelectorAll. The .k-word lookup is O(1) via the
//     store's wordElsByKey Map; per-word char lists are cached on
//     `wordEl.__kchars` by karaoke-dom (set at wrap time).
//   - No per-frame allocation of large arrays/sets. The two lit Sets are
//     reused via swap; words/synthWords arrays come from the store.
//   - No DOM rebuild during wave tick. The loop only sets style.--k and
//     toggles the .lit class on existing chars.
//   - Idle-skip: when getCurrentTime() returns the same value as the
//     previous frame (paused player, scroll without playback), the loop
//     skips the per-char scan entirely. The current --k values + .lit
//     classes stay correct as-is — visually identical, but the loop cost
//     drops to a single number compare.
//   - Non-lit chars must remain visually cheap (no transform / no glow /
//     no color-mix). All visual cost lives on `.k-ch.lit` per the CSS
//     contract in karaoke.css.
//   - --karaoke-radius-sec is cached after first read; invalidated on
//     reset() (handles theme changes between videos).
import { AppState } from '../core/state.js';
import { KaraokeStore } from './karaoke-store.js';
import { KaraokeAlign } from './karaoke-align.js';

export const KaraokeWave = (function () {
  'use strict';

  // ── Bridge refs to store-owned arrays/maps (in-place mutation discipline
  // keeps these refs valid forever; store NEVER reassigns them). ──
  // The lit Sets are NOT bridged — swapLitSets() re-points the store's two
  // pointers, so we re-fetch them at the top of each frame to stay current.
  var _words = KaraokeStore.getWords();
  var _synthWords = KaraokeStore.getSynthWords();
  var _wordElsByKey = KaraokeStore.getWordElsByKeyMap();

  // ── Wave-local state (rAF handle + setup config) ───────────────────────
  let _waveRaf = 0;
  let _waveStarted = false;
  let _lookaheadMs = -350;  // overridden by setup({lookaheadMs}); see karaoke.js init

  // Per-frame scratch for the active-line peak (wave maximum). Reused
  // across frames — same discipline as the lit Sets / radius cache. The
  // peak is tracked DURING applyWord (where `k` is already in scope), so
  // the post-scan tracker block doesn't need a read-after-write pass over
  // newLit (which would force a style recalc per lit char via
  // getPropertyValue('--k')). Reset at the top of each active frame.
  var _peakState = { bestCh: null, bestK: -1 };

  // Fallback-warn state. The wave loop falls back to uniform per-char
  // fractions (the pre-fix math) when a .k-word has no `__kmids` cache —
  // either the build-path post-pass hasn't run yet (transient race) or
  // an invalidation event nulled the cache and the re-measure hasn't
  // landed yet (≤100ms window). Both are expected; what we want to
  // surface is a SUSTAINED fallback, which means a hook is broken or
  // the post-pass never ran. Counter resets every time the build path
  // populates a fresh cache (`measureClusterMids` succeeds), so the
  // warn only fires when fallback is genuinely persistent.
  var _kmidsFallbackFires = 0;
  var _kmidsFallbackWarned = false;
  var _radiusFallbackWarned = false;

  // ── Setup (one-time wiring at init) ────────────────────────────────────
  function setup(deps) {
    if (deps && typeof deps.lookaheadMs === 'number') {
      _lookaheadMs = deps.lookaheadMs;
    }
  }

  /** Kick off the rAF loop. Idempotent — second call is a no-op.
   *  Caller is responsible for gating on `AppState.karaokeEnabled`; the
   *  loop self-stops if the flag flips to false (see loopTick). */
  function start() {
    if (_waveStarted) return;
    _waveStarted = true;
    _waveRaf = requestAnimationFrame(loopTick);
  }

  /* K1 #2 (2026-05-07) added a `stop()` helper here for symmetry with
   * `start()` and exported it for callers that wanted an explicit
   * cancel. Removed in K6 (2026-05-07): the only path that ever wanted
   * to halt the loop was `loopTick` itself when `karaokeEnabled` flips
   * to false, and it inlines the same 3 lines (cancelAnimationFrame +
   * `_waveRaf = 0` + `_waveStarted = false`) — a separate helper added
   * an exported-but-dead surface that the K6 audit flagged. The 3-line
   * inline cancel is the single source of truth now.
   *
   * If a future caller wants explicit-stop semantics (e.g., on video
   * swap before the disable flag flips), restore this helper rather
   * than re-inlining a third copy. The shape was:
   *   function stop() {
   *     if (_waveRaf) cancelAnimationFrame(_waveRaf);
   *     _waveRaf = 0;
   *     _waveStarted = false;
   *   }
   */

  // ── Wave math ──────────────────────────────────────────────────────────

  function bell(t) {
    // Hann window: 1 at t=0, smoothly to 0 at t>=1.
    if (t >= 1) return 0;
    var c = Math.cos(t * Math.PI / 2);
    return c * c;
  }

  function readKaraokeRadiusSec() {
    var cached = KaraokeStore.getRadiusSecCache();
    if (cached !== null) return cached;
    var v = parseFloat(getComputedStyle(document.body).getPropertyValue('--karaoke-radius-sec'));
    var ok = isFinite(v) && v > 0;
    // Fallback matches the dashboard.css :root default (0.45). The
    // CSS var is set unconditionally on :root so this branch firing
    // means something is wrong (CSS not loaded, var redefined to a
    // bad value, etc.) — surface it once so it doesn't hide.
    if (!ok && !_radiusFallbackWarned) {
      _radiusFallbackWarned = true;
      // eslint-disable-next-line no-console
      console.warn('[karaoke-wave] --karaoke-radius-sec unset/invalid; using 0.45s fallback');
    }
    var resolved = ok ? v : 0.45;
    KaraokeStore.setRadiusSecCache(resolved);
    return resolved;
  }

  /**
   * Strip every visible lit-char effect + clear the active-word class.
   * Called between videos (reset) and on hard pauses where we want a
   * clean visual state. The lit Sets are emptied; per-char inline `--k`
   * styles + `.lit` classes are removed.
   */
  function clearAllLit() {
    // Clear the active-word class first — scroll anchor falls back to row-top.
    var activeKey = KaraokeStore.getActiveWordKey();
    if (activeKey) {
      var els = _wordElsByKey.get(activeKey);
      if (els) {
        for (var i = 0; i < els.length; i++) {
          els[i].classList.remove('karaoke-active-word');
        }
      }
      KaraokeStore.setActiveWordKey(null);
    }
    var sets = KaraokeStore.getLitSets();
    if (!sets.lit.size) return;
    sets.lit.forEach(function (ch) {
      ch.style.removeProperty('--k');
      ch.classList.remove('lit');
      // Invalidate the __lastK1000 cache (see applyWord). Without this,
      // a re-entry with the same k value would skip setProperty and the
      // char would stay visually un-lit.
      ch.__lastK1000 = -1;
    });
    sets.lit.clear();
  }

  /**
   * Drop the lit-set entries WITHOUT touching the visible DOM. Used by
   * invalidate() on translation switches: the old DOM is about to be
   * replaced wholesale (next buildWordSpans rebuilds nodes), so the lit
   * char refs are stale anyway and the new spans start fresh.
   */
  function dropLitRefs() {
    var sets = KaraokeStore.getLitSets();
    sets.lit.clear();
    sets.newLit.clear();
  }

  function applyWord(w, t, radiusSec, lit, newLit) {
    var key = w.key || KaraokeStore.wordKey(w);
    var els = _wordElsByKey.get(key);
    if (!els || !els.length) return;
    var dur = Math.max(0.001, w.end - w.start);
    for (var ei = 0; ei < els.length; ei++) {
      var wordEl = els[ei];
      // Read the cached char list off the .k-word element. Falls back to
      // a one-time querySelectorAll if the element predates the cache
      // (defensive — should never happen because wrapCharsIntoSpan now
      // always populates __kchars; the fallback also caches on read so
      // the next frame uses the fast path).
      var chars = wordEl.__kchars;
      if (!chars) {
        chars = wordEl.querySelectorAll('.k-ch');
        wordEl.__kchars = chars;
      }
      var n = chars.length;
      if (!n) continue;
      // Per-cluster horizontal mid-fractions (populated by
      // measureClusterMids during the buildWordSpans post-pass). When
      // present, each char's wave-peak time is anchored on its actual
      // visual mid-point in the word — wider letters get more time,
      // narrower letters less. When absent (pre-build race or invalidation
      // gap waiting on re-measure), fall back to uniform `(ci + 0.5) / n`
      // and increment a counter so a sustained fallback (broken hook,
      // post-pass never ran) surfaces as a one-time console warn.
      var fracs = wordEl.__kmids;
      var usingFallback = !fracs;
      for (var ci = 0; ci < n; ci++) {
        var frac = fracs ? fracs[ci] : (ci + 0.5) / n;
        var midTime = w.start + frac * dur;
        var d = Math.abs(midTime - t);
        if (d >= radiusSec) continue;
        var k = bell(d / radiusSec);
        if (k > 0.001) {
          var ch = chars[ci];
          // Skip setProperty when k hasn't materially changed — avoids
          // style invalidation churn when the wave moves slowly. Cache
          // the last-set value as an INTEGER on the element (`__lastK1000`,
          // k×1000 truncated, 0..1000 range). Avoids the per-frame
          // `getPropertyValue('--k')` style-read + the `toFixed(3)` string
          // alloc that previously ran for every lit char every frame
          // (~21 chars × 60fps = 1260 string allocs/sec on the hot path).
          // Cache is invalidated to -1 in clearAllLit + the per-frame
          // cleanup loop below so a re-entry after un-lit always re-sets.
          var k1000 = (k * 1000) | 0;
          if (ch.__lastK1000 !== k1000) {
            ch.style.setProperty('--k', (k1000 / 1000).toFixed(3));
            ch.__lastK1000 = k1000;
          }
          // The `.lit` class gates ALL the visual effects (color tint,
          // transform, glow). Non-lit chars stay as bare inline-blocks
          // with no calc / no compositor layer / no per-paint work.
          if (!lit.has(ch)) ch.classList.add('lit');
          newLit.add(ch);
          // Track wave peak inline — `k` is already computed; updating
          // a module-level scratch here is free and lets the post-scan
          // active-word block skip a read-after-write pass over newLit.
          if (k > _peakState.bestK) {
            _peakState.bestK = k;
            _peakState.bestCh = ch;
          }
        }
      }
      // Fallback bookkeeping. Counter increments per-word, not per-char —
      // a single .k-word stuck on uniform is one event, regardless of how
      // many chars it has. Warns once per session at >100 fires (~1.5s of
      // 60fps fallback on a 5-word window) so transient gaps during chunk
      // arrival or invalidation don't false-positive.
      if (usingFallback) {
        _kmidsFallbackFires++;
        if (!_kmidsFallbackWarned && _kmidsFallbackFires > 100) {
          _kmidsFallbackWarned = true;
          // eslint-disable-next-line no-console
          console.warn('[karaoke-wave] sustained per-cluster mid-fraction fallback —',
            _kmidsFallbackFires, 'fires; check buildWordSpans post-pass + invalidation hooks');
        }
      }
    }
  }

  /** Reset the fallback-warn counter. Called by `karaoke.js`'s invalidation
   *  helper after a successful re-measure pass — counter accumulating
   *  across re-measures would conflate transient re-measure-windows with
   *  genuine sustained fallback (the bug we want to surface). */
  function resetKmidsFallbackCounter() {
    _kmidsFallbackFires = 0;
  }

  function scanWords(words, lo, hi, t, radiusSec, lit, newLit) {
    if (!words || !words.length) return;
    var anchor = KaraokeAlign.findWordAt(t, words);
    if (anchor < 0) {
      // No word contains t — find the first word with start > lo.
      for (var i = 0; i < words.length; i++) {
        if (words[i].end >= lo) { anchor = i; break; }
      }
      if (anchor < 0) return;
    }
    // Walk back: include words whose end >= lo (their tail still glows).
    for (var ib = anchor; ib >= 0; ib--) {
      var wb = words[ib];
      if (wb.end < lo) break;
      if (wb.start > hi) continue;
      applyWord(wb, t, radiusSec, lit, newLit);
    }
    // Walk forward: include words whose start <= hi.
    for (var ifw = anchor + 1; ifw < words.length; ifw++) {
      var wf = words[ifw];
      if (wf.start > hi) break;
      applyWord(wf, t, radiusSec, lit, newLit);
    }
  }

  // ── The rAF tick ───────────────────────────────────────────────────────

  function loopTick() {
    // Master kill switch — when disabled, STOP the loop entirely instead
    // of bailing per-frame. Restart requires an explicit start() call from
    // whoever flips karaokeEnabled back on (same pattern as the heartbeat-
    // driven chunk loader: it doesn't poll the flag, it gets re-engaged).
    if (!AppState.karaokeEnabled) {
      clearAllLit();
      KaraokeStore.setLastWaveTime(-1);
      _waveRaf = 0;
      _waveStarted = false;
      return;
    }

    // Schedule the next frame BEFORE the transient-bail checks below — those
    // are auto-recovering states (words arrive, translation toggles back to
    // original, player init completes) so the loop must keep ticking.
    _waveRaf = requestAnimationFrame(loopTick);

    // No data / showing translated text → nothing to highlight this frame.
    if (!_words.length || !KaraokeStore.isOriginalVisible()) {
      clearAllLit();
      KaraokeStore.setLastWaveTime(-1);
      return;
    }
    var player = AppState.player;
    if (!player || typeof player.getCurrentTime !== 'function') {
      clearAllLit();
      KaraokeStore.setLastWaveTime(-1);
      return;
    }
    var t = player.getCurrentTime();
    if (typeof t !== 'number' || isNaN(t) || t < 0) {
      clearAllLit();
      KaraokeStore.setLastWaveTime(-1);
      return;
    }
    // Audio-buffer compensation (mobile mainly) — same shift as syncWord.
    t += (_lookaheadMs / 1000);

    // Idle skip: same playhead as last frame = nothing to recompute. Hits
    // when the player is paused (getCurrentTime is constant) or while the
    // user scrolls without playback advancing. The current --k values +
    // .lit classes stay correct as-is, so visually identical, but skips
    // the per-char scan + the prev-frame-cleanup loop. Massive scroll-lag
    // win on desktop where every visible row repaints during scroll.
    var lastT = KaraokeStore.getLastWaveTime();
    if (Math.abs(t - lastT) < 0.0001) return;
    KaraokeStore.setLastWaveTime(t);

    var radiusSec = readKaraokeRadiusSec();
    var lo = t - radiusSec;
    var hi = t + radiusSec;

    // Re-fetch the lit-Set pair each frame (swapLitSets re-points the
    // store's two pointers, so a long-lived bridge ref would go stale).
    // Reuse the scratch set instead of allocating a new one per frame.
    var sets = KaraokeStore.getLitSets();
    var lit = sets.lit;
    var newLit = sets.newLit;
    newLit.clear();

    // Reset the peak scratch — applyWord will fill it during scanWords.
    _peakState.bestCh = null;
    _peakState.bestK = -1;

    scanWords(_words, lo, hi, t, radiusSec, lit, newLit);
    scanWords(_synthWords, lo, hi, t, radiusSec, lit, newLit);

    // Clear chars lit last frame but not this one.
    lit.forEach(function (ch) {
      if (!newLit.has(ch)) {
        ch.style.removeProperty('--k');
        ch.classList.remove('lit');
        ch.__lastK1000 = -1;  // see applyWord — invalidate cache on un-lit
      }
    });
    // Swap the two sets — store's _waveLit pointer now points at THIS
    // frame's lit chars (our `newLit` ref), _waveNewLit pointer points at
    // the just-cleared scratch (our `lit` ref, .clear()'d by swap). The
    // underlying Set OBJECTS don't move, only the store's pointers swap;
    // our local `newLit` still references this frame's lit-char set.
    KaraokeStore.swapLitSets();

    // Active-word tracking for scroll anchoring. The wave peak (highest --k
    // char) was tracked DURING applyWord via _peakState — no second pass
    // needed. Walk to the peak char's .k-word parent and toggle
    // .karaoke-active-word so the scroll fns can anchor on the active line.
    // Cost is just one pointer read + a class swap on the rare frame when
    // the peak word changes (was ~O(litSize) parseFloats + getPropertyValue
    // forced-recalc reads pre-fix).
    var bestCh = _peakState.bestCh;
    var peakWord = bestCh ? bestCh.closest('.k-word') : null;
    var peakKey = peakWord ? peakWord.dataset.key : null;
    var prevActiveKey = KaraokeStore.getActiveWordKey();
    if (peakKey !== prevActiveKey) {
      if (prevActiveKey) {
        var oldEls = _wordElsByKey.get(prevActiveKey);
        if (oldEls) {
          for (var i = 0; i < oldEls.length; i++) {
            oldEls[i].classList.remove('karaoke-active-word');
          }
        }
      }
      if (peakKey) {
        var newEls = _wordElsByKey.get(peakKey);
        if (newEls) {
          for (var j = 0; j < newEls.length; j++) {
            newEls[j].classList.add('karaoke-active-word');
          }
        }
      }
      KaraokeStore.setActiveWordKey(peakKey);
    }
  }

  return {
    setup,
    start,
    clearAllLit,
    dropLitRefs,
    resetKmidsFallbackCounter,
    // Exposed for tests (debug panel / future Playwright probes)
    _bell: bell,
    _readKaraokeRadiusSec: readKaraokeRadiusSec,
  };
})();
