import { AppState } from '../core/state.js';
import { Helpers } from '../core/helpers.js';
import { KaraokeStore } from './karaoke-store.js';
import { KaraokeChunkLoader } from './karaoke-chunk-loader.js';
import { KaraokeAnalytics } from './karaoke-analytics.js';
import { KaraokeAlign } from './karaoke-align.js';
import { KaraokeDom } from './karaoke-dom.js';
import { KaraokeWave } from './karaoke-wave.js';

/**
 * RecapShark Karaoke Module — public coordinator.
 *
 * After cycles 7a + 7b (2026-05-06), this file is the public KaraokeManager
 * façade plus the in-page debug panel. ALL implementation lives in sibling
 * modules:
 *   - karaoke-store.js          shared state hub (star-pattern center)
 *   - karaoke-chunk-loader.js   all chunk-fetch I/O + heartbeat throttle
 *   - karaoke-analytics.js      session-end Sentry breadcrumb
 *   - karaoke-align.js          pure align math + binary search
 *   - karaoke-dom.js            DOM building + apply paths
 *   - karaoke-wave.js           rAF wave loop + per-char highlight
 *
 * This file keeps:
 *   - Public API (init / syncWord / reset / invalidate / onPlayOrSeek)
 *   - Lookahead URL flag init (consumed by syncWord + wave)
 *   - The ?karaoke=1 soft-launch kill switch
 *   - The ?karaoke_debug=1 floating debug panel (~1.4k LOC of test
 *     suites + diagnostic dump that bridges to the new modules)
 */
export const KaraokeManager = (function() {
  'use strict';

  // ── Bridge refs to karaoke-store arrays (in-place mutation discipline
  // keeps these valid forever; store NEVER reassigns the arrays). ──
  var _words = KaraokeStore.getWords();
  var _loadedRanges = KaraokeStore.getLoadedRanges();

  // ── Soft-launch kill switch (?karaoke=1) ───────────────
  // Per-session opt-in for testing the lazy karaoke pipeline before the
  // global flip. When the URL contains `?karaoke=1`, karaoke turns on
  // for THIS session only — production traffic without the flag stays
  // gated by the AppState.karaokeEnabled default in state.js (false).
  // This pulls forward the rollout-step "Flip karaokeEnabled: true for a
  // single test session via ?karaoke=1 debug param" from plan §6 Phase 5
  // step 7, because we need it to verify Phase 3 work end-to-end.
  if (typeof window !== 'undefined' && window.location &&
      /[?&]karaoke=1\b/.test(window.location.search)) {
    AppState.karaokeEnabled = true;
    // eslint-disable-next-line no-console
    console.info('[karaoke] enabled for this session via ?karaoke=1');
  }

  // ── Active-highlight lookahead (audio-output latency compensation) ──
  //
  // The YT iframe's `getCurrentTime()` reports a source-clock position
  // that is AHEAD of the audio the user actually hears. The OS audio
  // compositor + the iframe's internal output pipeline together give a
  // latency where the user hears time T while `getCurrentTime()` returns
  // ~T + Δ. Without compensation, the active-word highlight fires before
  // the user hears the word.
  //
  // Compensation: shift the active-word lookup BACKWARD by this many ms
  // so the highlight aligns with what the user HEARS.
  //
  // Default: -150 ms on both desktop and mobile. Originally -350 desktop /
  // -150 mobile (2026-05-04 by-ear tuning), but after the matcher fix in
  // 2026-05-10 (e9981a0) made more words land on AsrProvider anchors, the wave
  // started reading 3-4 chars BEHIND the audio on desktop. Re-tuned by
  // ear: -150 feels locked on both platforms now. The platform branch is
  // kept (currently degenerate) so per-device divergence is a 1-char edit
  // if it ever matters again.
  //
  // Tunable per-device via `?karaoke_lookahead=N` (signed ms) — useful
  // for re-tuning if YT's iframe pipeline changes its buffering.
  //
  // Historical note: this used to be +200 ms (mobile) / 0 ms (desktop),
  // based on the assumption that audio TRAILED the source clock and
  // needed positive compensation. Those values appeared to work because
  // a perf bug in the wave loop (per-frame `querySelectorAll('.k-ch')`,
  // base-rule `color-mix()` on every char, no idle-skip) was silently
  // delaying the visible highlight by ~200-400 ms. Once the perf bug
  // was fixed, the real offset became visible AND pointed the other
  // direction.
  var _highlightLookaheadMs = (function _initHighlightLookahead() {
    if (typeof window === 'undefined') return -150;
    var loc = window.location;
    if (loc) {
      var m = loc.search.match(/[?&]karaoke_lookahead=(-?\d+)/);
      if (m) return Number(m[1]);
    }
    // Currently the same value on both platforms (-150 ms). The platform
    // branch was dropped 2026-05-11 — by-ear tuning post-matcher-fix landed
    // both desktop and mobile on -150. If per-device divergence is ever
    // re-needed, re-introduce a `Helpers.isNarrowViewport()` check here.
    return -150;
  })();

  // ── Public API ─────────────────────────────────────────

  function init() {
    // Wire chunk-loader's success callback so it can repaint spans on chunk
    // arrival. Passed via setup() instead of imported back, so the chunk
    // loader's DAG stays acyclic (it doesn't import karaoke.js or karaoke-dom).
    KaraokeChunkLoader.setup({
      applyWordSpansForActivePanel: KaraokeDom.applyWordSpansForActivePanel,
    });
    // Wire the audio-buffer compensation into the wave loop's per-frame
    // playhead lookup. Same value as the syncWord lookahead below.
    KaraokeWave.setup({ lookaheadMs: _highlightLookaheadMs });
    // Visibility-recovery + session-end listeners (idempotent).
    KaraokeChunkLoader.attachVisibilityListener();
    KaraokeAnalytics.attachLifecycleListeners();
    // Kick off the rAF wave loop ONLY when karaoke is enabled. The loop
    // self-stops if the flag flips to false at runtime (see karaoke-wave
    // loopTick). If something flips karaokeEnabled back to true mid-session
    // it must call KaraokeWave.start() to re-arm — same pattern as the
    // heartbeat-driven chunk loader.
    if (AppState.karaokeEnabled) {
      KaraokeWave.start();
    }
    // Layout-cache invalidation hooks. The wave loop's per-cluster timing
    // math depends on cached BCR mid-fractions per .k-word that go stale
    // when the rendered widths change — font load, viewport resize, theme
    // switch, A+/A− font-size adjust. All four route through one debounced
    // helper that nulls the caches and re-measures only the words inside
    // currently-visible rows (cheap), OUTSIDE the rAF loop. Idempotent;
    // safe to call multiple times.
    _attachLayoutInvalidationHooks();
  }

  // ── Layout-cache invalidation ────────────────────────────────────────
  //
  // Wave loop reads per-cluster horizontal mid-fractions from
  // `.k-word.__kmids` to align letter peak times with actual visual
  // positions. Caches go stale on layout shifts (font load, resize,
  // theme, A+/A−). One shared 100ms-debounced handler nulls all
  // caches + re-measures words inside currently-visible rows. The
  // wave loop's fallback path covers the ≤100ms gap with the pre-fix
  // uniform-fraction math — visually invisible.
  //
  // We re-measure only VISIBLE rows (filtered by viewport-rect overlap)
  // because a 4-hour transcript can have ~30k+ .k-words; walking all of
  // them on every resize event would be measurable jank on mobile, and
  // is wasted work either way (the wave loop only ever paints words in
  // the radius window around the playhead).
  var _layoutInvalidateTimer = 0;
  var _layoutHooksAttached = false;
  var _resizeObserver = null;

  function _attachLayoutInvalidationHooks() {
    if (_layoutHooksAttached) return;
    _layoutHooksAttached = true;
    if (typeof window === 'undefined') return;

    // 1. Initial font readiness. Resolves once at first paint.
    if (document && document.fonts && document.fonts.ready) {
      document.fonts.ready.then(function () {
        _scheduleLayoutInvalidate();
      }).catch(function () { /* swallow — non-fatal */ });
    }
    // 2. Subsequent font activations (lazy unicode-range fetches: Vazirmatn
    //    on the first Persian char, Noto Sans Arabic, Noto Sans CJK, etc.).
    //    `loadingdone` fires per FontFaceSet activation batch; multiple
    //    fonts in close succession all coalesce through the debounce.
    if (document && document.fonts && typeof document.fonts.addEventListener === 'function') {
      document.fonts.addEventListener('loadingdone', _scheduleLayoutInvalidate);
    }
    // 3. Viewport resize (one observer on the transcript outer panel).
    //    Per-row observers would be much heavier on long transcripts —
    //    observing the panel catches every internal re-flow that affects
    //    word widths.
    if (typeof ResizeObserver === 'function') {
      _resizeObserver = new ResizeObserver(_scheduleLayoutInvalidate);
      var transcriptEl = document.getElementById('fullTranscriptPanel');
      if (transcriptEl) _resizeObserver.observe(transcriptEl);
    }
    // 4. Theme switch + A+/A− font-size adjust. Both emit
    //    `rs:layout-change` (wired in themes.js applyTheme +
    //    controls.js changeFontSize). One-way coupling: the
    //    karaoke module is the only listener; emitters don't need
    //    to know it exists.
    window.addEventListener('rs:layout-change', _scheduleLayoutInvalidate);
  }

  function _scheduleLayoutInvalidate() {
    if (_layoutInvalidateTimer) return;  // already pending
    _layoutInvalidateTimer = setTimeout(function () {
      _layoutInvalidateTimer = 0;
      _runLayoutInvalidate();
    }, 100);
  }

  function _runLayoutInvalidate() {
    // Radius cache: theme switch could have changed --karaoke-radius-sec.
    KaraokeStore.invalidateRadiusSecCache();
    // Visible-rows-only pass: null + re-measure each .k-word's __kmids in
    // ONE walk. Previously a doc-wide `querySelectorAll('.k-word').forEach
    // (__kmids = null)` ran first, then the visible-rows re-measure below.
    // On a 2h video that's 10k+ spans walked just to null a cache — visible
    // jank on mobile every time a font-load / resize / theme / A+/A− event
    // fires. Off-screen rows now keep their old __kmids; slightly stale
    // measured fractions are closer to truth than the `null → uniform`
    // fallback the wave loop would otherwise hit when the playhead reaches
    // them. The next invalidation event picks them up when they're visible.
    var rows = document.querySelectorAll('.transcript-line, .transcript-paragraph');
    if (!rows.length) return;
    var vh = (window.innerHeight || document.documentElement.clientHeight) || 0;
    if (vh <= 0) return;
    // Small margin so rows about to scroll into view also get measured.
    var topMargin = -200;
    var botMargin = vh + 200;
    rows.forEach(function (row) {
      var r = row.getBoundingClientRect();
      if (r.bottom < topMargin) return;
      if (r.top > botMargin) return;
      row.querySelectorAll('.k-word').forEach(function (w) {
        w.__kmids = null;
        KaraokeDom.measureClusterMids(w);
      });
    });
    // After a successful re-measure pass, reset the fallback-warn counter.
    // Otherwise transient fallback during the ≤100ms invalidation window
    // would accumulate across many invalidation events and trip the warn
    // on what is by-design degraded-but-recovering behaviour.
    if (typeof KaraokeWave.resetKmidsFallbackCounter === 'function') {
      KaraokeWave.resetKmidsFallbackCounter();
    }
  }

  /**
   * Sync the active word highlight to the given playback time.
   * Handles both original and translated word spans.
   *
   * Order matters (T23): in lazy mode, chunk scheduling MUST run before the
   * `!_words.length` early return — otherwise the loader never fires when no
   * words have arrived yet, which is exactly the state lazy mode boots in.
   * The apply-path self-heal further down handles the in-flight race where
   * words arrive between two heartbeat ticks.
   */
  function syncWord(t) {
    if (!AppState.karaokeEnabled) return;

    // Lazy mode: kick the chunk loader on every heartbeat tick.
    if (AppState.karaokeMode === 'lazy') {
      KaraokeChunkLoader.maybeScheduleChunkLoad(t);
    }

    // Don't apply original-language word spans over translated-only text.
    if (!KaraokeStore.isOriginalVisible()) return;
    if (!_words.length) return;

    // Re-apply word spans if needed (DOM rebuilt, language switch, etc.).
    //
    // The OLD `_appliedPanel !== currentPanel` reset was a left-over from when
    // karaoke painted only the active panel — a tab switch then needed a
    // re-apply. The Phase-3 dispatcher always paints BOTH panels per chunk
    // arrival, so a tab switch alone doesn't invalidate anything. Removing the
    // reset keeps `applied` stable across tab switches and stops the throttle
    // from firing on every heartbeat tick after a switch — which would freeze
    // the active-word highlight on whatever span it was on at switch time.
    if (!KaraokeStore.getApplied() || !KaraokeDom.isApplied()) {
      // Throttle re-apply attempts to once per second
      var now = Date.now();
      if (now - KaraokeStore.getLastApplyAttempt() < 600) return;
      KaraokeStore.setLastApplyAttempt(now);
      KaraokeDom.applyWordSpansForActivePanel();
    }
    if (!KaraokeStore.getApplied()) return;

    // ── Active word lookup ─────────────────────────────────────────────
    //
    // Look up the active word at `t + lookahead` to compensate for the
    // mobile audio-output buffer (see `_highlightLookaheadMs` block above
    // for the full rationale). The chunk-loader still uses the raw `t` so
    // prefetch boundaries don't shift.
    //
    // We search BOTH AsrProvider's `_words` (real ASR timing) AND the synth-
    // word timeline (interpolated timing for tokens AsrProvider didn't
    // transcribe — see karaoke-dom.buildWordSpans synthetic-timing block).
    // The "winner" is the entry with the LATER start time among those with
    // `start <= t` — i.e., the most recently-started span at the current
    // playhead. Without the synth path, the highlight would skip over
    // ~40% of words; with it, the highlight visits every rendered word
    // in sequence.
    var lookaheadT = t + (_highlightLookaheadMs / 1000);
    var synthWords = KaraokeStore.getSynthWords();
    var wordEls = KaraokeStore.getWordEls();
    var gIdx = KaraokeAlign.findWordAt(lookaheadT, _words);
    var sIdx = KaraokeAlign.findWordAt(lookaheadT, synthWords);
    var gW = gIdx >= 0 ? _words[gIdx] : null;
    var sW = sIdx >= 0 ? synthWords[sIdx] : null;
    var activeKey = null;
    var activeIsAsrProvider = false;
    if (gW && (!sW || gW.start >= sW.start)) {
      activeKey = KaraokeStore.wordKey(gW);
      activeIsAsrProvider = true;
    } else if (sW) {
      activeKey = sW.key;
    }

    if (activeKey !== KaraokeStore.getActiveKey()) {
      // Note: word-level highlight is driven by the per-frame wave loop
      // (karaoke-wave), not by a class toggle here. We still track
      // active-word identity for the bilingual-sub line highlight
      // below + lazy-mode chunk loader hooks.
      KaraokeStore.setActiveKey(activeKey);
      var activeWordIdx = activeIsAsrProvider ? gIdx : -1;
      KaraokeStore.setActiveWordIdx(activeWordIdx);

      // ── Bilingual sentence highlight ──
      // Only AsrProvider-matched words drive the bilingual sub highlight (the
      // synthetic words don't have a meaningful row→sub mapping).
      if (activeIsAsrProvider && activeWordIdx >= 0 && wordEls[activeWordIdx]) {
        var row = wordEls[activeWordIdx].closest('.transcript-line, .transcript-paragraph');
        if (row) {
          var activePanel = KaraokeDom.getActivePanel();
          var sub = activePanel && activePanel.querySelector('.bilingual-sub[data-for-idx="' + row.dataset.idx + '"]');
          var prevSubEl = KaraokeStore.getActiveSubEl();
          if (sub) {
            var target = sub;
            var wordStart = Number(wordEls[activeWordIdx].dataset.start);
            var times = AppState.segmentTimestamps;
            if (times && times.length) {
              var lineIdx = 0;
              for (var j = times.length - 1; j >= 0; j--) {
                if (times[j] <= wordStart + 0.05) { lineIdx = j; break; }
              }
              var lineSpan = sub.querySelector('span[data-line-idx="' + lineIdx + '"]');
              if (lineSpan) target = lineSpan;
            }
            if (target !== prevSubEl) {
              if (prevSubEl) prevSubEl.classList.remove('karaoke-sub-active');
              target.classList.add('karaoke-sub-active');
              KaraokeStore.setActiveSubEl(target);
            }
          } else {
            if (prevSubEl) prevSubEl.classList.remove('karaoke-sub-active');
            KaraokeStore.setActiveSubEl(null);
          }
        }
      }
    }

  }

  function reset() {
    // Wave: clear the per-frame --k state + .lit class on every char that was
    // lit. Must run BEFORE the store reset so the lit-set still holds the
    // DOM refs we need to scrub.
    KaraokeWave.clearAllLit();
    // Delegate the data-side reset to each module. Each clears its own state
    // in place (Array.length=0 / Set.clear() / Map.clear()) so consumers'
    // long-lived bridge refs (_words, _loadedRanges) stay valid across resets.
    KaraokeStore.resetState();
    KaraokeChunkLoader.resetState();
    KaraokeAnalytics.resetState();
    // AppState counters + session-fatal flag.
    AppState.karaokeWords = null;
    AppState.karaokeSessionFatal = false;
    AppState.karaokeChunksRequested = 0;
    AppState.karaokeChunksCacheHits = 0;
    AppState.karaokeChunksFetched = 0;
    AppState.karaokeChunksFailed = 0;
  }

  // ── Internals (extracted to sibling modules in cycle 7b) ────────────
  //
  // Panel resolution (getActivePanel / resolveRenderTarget / isApplied),
  // align math (resolveRowEnd / rowStateHash / normalizeForMatch /
  // countWordTokens / segmentsForRow / assignSyntheticTimes / findWordAt /
  // rebuildSynthWordsFromDOM), DOM building (wrapCharsIntoSpan /
  // buildWordSpans / applyWordSpans / applyWordSpansToSubs /
  // applyWordSpansForActivePanel), and the rAF wave loop (waveBell /
  // readKaraokeRadiusSec / waveClearAllLit / waveApplyWord / waveScanWords /
  // waveLoopTick) all moved out of this file in cycle 7b. The store now
  // holds every piece of shared mutable state; karaoke.js is the public
  // façade + lookahead init + ?karaoke_debug=1 panel. See:
  //   - karaoke-align.js   pure align math + binary search
  //   - karaoke-dom.js     DOM building + apply paths
  //   - karaoke-wave.js    rAF wave loop + per-char highlight

  // ── Auto-init on DOM ready ─────────────────────────────
  document.addEventListener('DOMContentLoaded', init);

  /** Call when translation changes DOM — forces karaoke to re-apply word spans on next tick.
   *  Per §13 lifecycle: DOM-bound state (wordEls / wordElByKey / wordElsByKey
   *  / synthWords / lit sets / activeWordKey / radius cache / lastWaveTime)
   *  is cleared by store.invalidateDomState because span refs are dead after
   *  a translation rebuild. Cache state (_words, _loadedRanges, _wordKeySet)
   *  survives so language swaps don't re-fetch chunks. */
  function invalidate() {
    KaraokeStore.invalidateDomState();
    // Lit-char refs from the previous DOM are now stale (next buildWordSpans
    // replaces nodes wholesale). Drop them — DOM is about to be replaced
    // anyway, no need to scrub --k / .lit on chars that won't exist.
    KaraokeWave.dropLitRefs();
    KaraokeStore.invalidateRadiusSecCache();
    KaraokeStore.setLastWaveTime(-1);
    // Clear stale `dataset.karaokeState` markers from rows. The marker is the
    // idempotency hash that prevents re-rendering a row whose word set hasn't
    // changed. After a language / bilingual switch, the mobile flat-transcript
    // (and desktop renderer) WIPE row textContent — but they don't clear this
    // dataset attribute. The next karaoke apply then computes the same hash,
    // matches the stale marker, and SKIPS the row, leaving it as plain text
    // forever (until the next chunk arrives and changes the hash). Clearing
    // here forces a fresh render of every row on the next apply tick.
    document.querySelectorAll('[data-karaoke-state]').forEach(function(el) {
      delete el.dataset.karaokeState;
    });
  }

  // ── Debug panel (dev build only — opt-in via ?karaoke_debug=1) ─────
  // The debug-panel + test-suite + diagnostic-dump code lives in three
  // sibling files (`karaoke-debug.js` panel UI + bridge, `karaoke-debug-tests.js`
  // 8 scripted suites, `karaoke-debug-diag.js` state dump — Phase 4c #1
  // SRP split, 2026-05-08). All three are pulled into one dev-only chunk
  // via the static imports inside karaoke-debug.js. The chunk is gated TWICE:
  //   1. `import.meta.env.DEV` — build-time constant. Vite/Rollup substitutes
  //      `false` in `npm run build`, so the entire branch (including the
  //      dynamic import('./karaoke-debug.js') target) is dead-code-eliminated
  //      and the chunk is NEVER emitted to dist/. Verified by checking
  //      dist/assets/ post-build for the absence of `karaoke-debug` chunks.
  //   2. URL flag — runtime check, only in dev/tunnel where DEV is true.
  // Net effect: production users have zero bytes + zero attack surface for
  // the panel (it can't be loaded by flipping the URL flag in prod). Local
  // `npm run dev` + Cloudflare Tunnel dev sessions still expose the panel via the flag.
  if (import.meta.env.DEV && typeof window !== 'undefined' && window.location && /[?&]karaoke_debug=1(?:&|$)/.test(window.location.search)) {
    import('./karaoke-debug.js')
      .then(function (m) {
        m.installKaraokeDebugPanel({
          syncWord: syncWord,
          lookaheadMs: _highlightLookaheadMs,
        });
      })
      .catch(function (e) { console.error('[karaoke] debug panel failed to load', e); });
  }

  /** Debug-only — used by the ?perf=1 overlay's wave-tuning sliders.
   *  Setting null restores the CSS-default radius (currently 0.45s — see
   *  :root in dashboard.css). Updates the body's inline custom property
   *  AND invalidates the wave loop's cached radius so the next frame picks
   *  the new value up. */
  function _setRadiusOverride(seconds) {
    if (seconds == null) {
      document.body.style.removeProperty('--karaoke-radius-sec');
    } else {
      document.body.style.setProperty('--karaoke-radius-sec', String(seconds));
    }
    KaraokeStore.invalidateRadiusSecCache();
  }

  return {
    init, syncWord, reset, invalidate,
    onPlayOrSeek: KaraokeChunkLoader.onPlayOrSeek,
    _setRadiusOverride,
  };
})();
