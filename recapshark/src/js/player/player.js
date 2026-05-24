import { AppState } from '../core/state.js';
import { Helpers } from '../core/helpers.js';
import { Renderer } from '../ui/renderer.js';
import { TranscriptBuffer } from '../ui/transcript-buffer.js';
import { RewindEffect } from './rewind.js';
import { PlayerFacade } from './player-facade.js';
import { PlayerControls } from './player-controls.js';
import { PlayerSubtitles } from './player-subtitles.js';

/**
 * RecapShark Player Manager — core / coordinator.
 *
 * Owns: YouTube IFrame Player lifecycle (init / cue / swap / state-change /
 *       error / API-ready), topic tracker, desktop transcript-sync (the
 *       large continuous-smooth-scroll engine), and the public PlayerManager
 *       API surface.
 *
 * Reads from AppState: player, videoData, currentVideoId, rewindMode,
 *                      _pendingSeek, _pendingVideoId, _pendingAutoplay,
 *                      ytApiLoaded, _pendingRewindCreate, trackerInterval,
 *                      transcriptSyncRaf, lastHighlightedRow,
 *                      autoScrollEnabled, useActiveLineAnchor,
 *                      activeTopicIdx, subtitleSegments, ccEnabled.
 *
 * Sub-modules (split out 2026-05-06, cycle 3 of SRP refactor):
 *   - player-facade.js     facade + overlay + embed-fallback DOM
 *   - player-controls.js   mech panel UI (transport / scrubber / volume)
 *   - player-subtitles.js  CC overlay + sync loop
 *
 * Transcript-sync stays here intentionally: the engine is deeply tied to
 * the YT player state events (start/stop on PLAYING/PAUSED) and to the
 * scroll DOM that already lives next to lifecycle code. Marked as a
 * future extraction candidate once the karaoke store pattern proves
 * itself — cycle 3 SRP rationale documented in
 * docs/_tech/01_ARCHITECTURE.md (player.js entry).
 */
export const PlayerManager = (() => {

  /** Scroll-center fraction: 0.5 on both desktop and mobile (true center). */
  function _scrollCenterFrac() {
    return 0.5;
  }

  /* ── YT player lifecycle ────────────────────────────── */

  function _activatePlayer(videoId) {
    PlayerFacade.hideFacade();
    PlayerFacade.hideEmbedFallback();
    PlayerFacade.showOverlay();
    if (AppState.player && AppState.player.loadVideoById) {
      AppState.player.stopVideo();
      AppState.player.loadVideoById(videoId);
      return;
    }
    const wrap = document.getElementById('ytPlayer');
    if (!wrap) return;
    wrap.innerHTML = '';
    if (typeof YT !== 'undefined' && YT.Player) {
      AppState.player = new YT.Player('ytPlayer', {
        videoId,
        playerVars: { autoplay: 1, modestbranding: 1, rel: 0, playsinline: 1 },
        events: {
          onReady: onPlayerReady,
          onStateChange: onPlayerStateChange,
          onError: function () { PlayerFacade.showEmbedFallback(videoId); },
        },
      });
    } else {
      AppState._pendingVideoId = videoId;
      AppState._pendingAutoplay = true;
      if (!AppState.ytApiLoaded) {
        AppState.ytApiLoaded = true;
        const tag = document.createElement('script');
        tag.src = 'https://www.youtube.com/iframe_api';
        document.head.appendChild(tag);
      }
    }
  }

  function init() {
    const wrap = document.getElementById('ytPlayer');
    if (!wrap || !AppState.videoData?.videoId) return;

    // During VHS rewind, player is already live — don't show facade over it
    if (AppState.rewindMode) return;

    // Subsequent-paste path: the YT player is already alive (we cued the
    // new video into it via PlayerManager.swapVideo and may already be
    // playing it). Showing the facade now would slap a thumbnail+play-
    // button overlay on top of the working iframe, which is exactly the
    // bug the user hit ("video frame doesn't show it, just shows the
    // thumbnail and play button"). Skip facade whenever a live player
    // exists; cueVideo()/_activatePlayer() handle facade swaps explicitly
    // when they're actually needed.
    if (AppState.player && typeof AppState.player.getPlayerState === 'function') {
      PlayerFacade.hideEmbedFallback();
      return;
    }

    PlayerFacade.hideEmbedFallback();

    if (window.location.protocol === 'file:') {
      wrap.innerHTML = `
        <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;color:#888;font-size:12px;text-align:center;padding:16px">
          <div style="font-size:24px;margin-bottom:8px">&#x1F988;</div>
          <div>Open via the server to watch here</div>
          <div style="margin-top:4px;color:#666;font-size:11px">localhost:8000</div>
        </div>`;
      return;
    }

    PlayerFacade.showFacade(AppState.videoData.videoId);
  }

  function cueVideo(videoId) {
    if (!videoId) return;
    if (window.location.protocol === 'file:') return;
    if (AppState.player && typeof AppState.player.stopVideo === 'function') {
      AppState.player.stopVideo();
    }
    PlayerFacade.showFacade(videoId);
  }

  /**
   * Swap a new video into the existing YT player.
   * Used by the "subsequent paste" path in app.js — the user pasted a
   * new URL while the previous video was still playing on the results
   * view, so we want a seamless iframe-internal swap (no facade snap,
   * no full re-mount). Falls back to facade if the player isn't alive.
   *
   * @param {string} videoId
   * @param {{autoplay?: boolean}} opts — autoplay defaults to true. Pass
   *   `{ autoplay: false }` to CUE the video (load but don't play); caller
   *   must then call AppState.player.playVideo() when ready. This is how
   *   processUrl() avoids the "audio plays before content is visible" bug.
   */
  function swapVideo(videoId, opts) {
    if (!videoId) return;
    if (window.location.protocol === 'file:') return;
    const autoplay = !opts || opts.autoplay !== false;
    PlayerFacade.hideFacade();
    PlayerFacade.hideEmbedFallback();
    PlayerFacade.showOverlay();
    if (AppState.player && typeof AppState.player.loadVideoById === 'function') {
      try { AppState.player.stopVideo(); } catch (_) {}
      if (autoplay) {
        AppState.player.loadVideoById(videoId);
      } else if (typeof AppState.player.cueVideoById === 'function') {
        AppState.player.cueVideoById(videoId);
      } else {
        // Defensive: cueVideoById should exist on any real YT.Player, but
        // if somehow it doesn't we fall back to loadVideoById (noisy but
        // better than no video at all).
        AppState.player.loadVideoById(videoId);
      }
    } else {
      PlayerFacade.showFacade(videoId);
    }
  }

  window.onYouTubeIframeAPIReady = function () {
    // If rewind module queued a player creation, let it handle it
    if (AppState._pendingRewindCreate) {
      const createFn = AppState._pendingRewindCreate;
      AppState._pendingRewindCreate = null;
      createFn();
      return;
    }

    const vid = AppState._pendingVideoId || AppState.videoData?.videoId || AppState.currentVideoId;
    const autoplay = AppState._pendingAutoplay || false;
    AppState._pendingVideoId = null;
    AppState._pendingAutoplay = false;
    if (!vid) return;
    PlayerFacade.hideEmbedFallback();
    PlayerFacade.hideFacade();
    PlayerFacade.showOverlay();
    AppState.player = new YT.Player('ytPlayer', {
      videoId: vid,
      playerVars: { autoplay: autoplay ? 1 : 0, modestbranding: 1, rel: 0, playsinline: 1 },
      events: {
        onReady: onPlayerReady,
        onStateChange: onPlayerStateChange,
        onError: function () { PlayerFacade.showEmbedFallback(vid); },
      },
    });
  };

  function onPlayerReady(event) {
    if (AppState._pendingSeek != null) {
      const t = AppState._pendingSeek;
      AppState._pendingSeek = null;
      event.target.seekTo(t, true);
      event.target.playVideo();
    }
    const dur = event.target.getDuration();
    if (dur > 0) {
      const totalEl = document.querySelector('.mech-time-total');
      if (totalEl) totalEl.textContent = Helpers.fmtTime(Math.floor(dur));
      const scrubberTotal = document.getElementById('scrubberTotal');
      if (scrubberTotal) scrubberTotal.textContent = Helpers.fmtTime(Math.floor(dur));
    }
  }

  let _seeking = false;

  /** Shared by onPlayerStateChange(PLAYING) and dismissFacadeAndPlay — keeps
   *  mech clock, transcript sync, and mobile panel hooks alive when YT's
   *  state callback is missed around rewind / facade dismissal. Idempotent:
   *  startMechTimeSync / startTranscriptSync / startTopicTracker guard. */
  function kickPlaybackUiSync() {
    if (!AppState.player || typeof AppState.player.getCurrentTime !== 'function') return;
    _seeking = false;
    startTopicTracker();
    startTranscriptSync();
    PlayerControls.startMechTimeSync();
    PlayerControls.updateMechState(true);
    document.querySelectorAll('.transcript-list').forEach(el => el.classList.add('picker-playing'));
    if (typeof window.KaraokeManager !== 'undefined' &&
        typeof window.KaraokeManager.onPlayOrSeek === 'function') {
      window.KaraokeManager.onPlayOrSeek();
    }
    try {
      const t = AppState.player.getCurrentTime();
      const dur = AppState.player.getDuration ? AppState.player.getDuration() : 0;
      if (dur > 0) PlayerControls.renderMechTime(t, dur);
    } catch (_) { /* best-effort initial paint */ }
  }

  // Post-seek settling flag lives on AppState (see state.js definition) so
  // every read site can see it — showMode's mount-scroll in
  // renderer-mobile-panels.js needs the same gate as this state-change
  // handler. Set + cleared by transitionFromRewind() across the YT iframe's
  // post-seek settling window. The seekTo(0,true) issued there can briefly
  // fire PLAYING via postMessage (async) before the matching pauseVideo()
  // lands — letting that PLAYING through to kickPlaybackUiSync would start
  // the rAF auto-follow loop on a player whose currentTime is still the
  // stale rewind position, snapping the mobile transcript to mid-video.

  function onPlayerStateChange(event) {
    // During VHS rewind, skip normal playback sync
    if (RewindEffect.isRunning()) return;
    // Same idea for the brief post-rewind settling window — see AppState.postRewindSettling.
    if (AppState.postRewindSettling) return;

    const playing = event.data === YT.PlayerState.PLAYING;
    if (playing) {
      kickPlaybackUiSync();
    } else {
      stopTranscriptSync();
      PlayerControls.stopMechTimeSync();
      if (!_seeking) PlayerControls.updateMechState(false);
      document.querySelectorAll('.transcript-list').forEach(el => el.classList.remove('picker-playing'));
    }

    // Always-one-button: cover YT's native center play button (which it
    // draws inside its iframe on pause/end regardless of controls:0) with
    // our white frameless facade. PLAYING → hide ours (iframe shows real
    // video, no button visible). PAUSED/ENDED → show ours on top, blocking
    // YT's center button. resume:true wires the facade tap to
    // dismissFacadeAndPlay so a second click resumes without reloading.
    // Skipped for _seeking so a brief PAUSED during a scrub doesn't pop
    // the facade up mid-seek (mechSeek sets _seeking = true before issuing
    // seekTo; YT emits PAUSED→BUFFERING→PLAYING during the scrub).
    const _vid = AppState.videoData?.videoId || AppState.currentVideoId;
    if (_vid) {
      if (event.data === YT.PlayerState.PAUSED || event.data === YT.PlayerState.ENDED) {
        if (!_seeking) PlayerFacade.showFacade(_vid, { resume: true, frameless: true });
      } else if (event.data === YT.PlayerState.PLAYING) {
        PlayerFacade.hideFacade();
      }
    }
  }

  /* ── Topic Tracker ──────────────────────────────────── */

  function startTopicTracker() {
    if (AppState.trackerInterval) return;
    AppState.trackerInterval = setInterval(() => {
      if (!AppState.player || !AppState.player.getCurrentTime) return;
      const t = AppState.player.getCurrentTime();
      let best = -1;
      let bestTime = -1;
      const topics = AppState.videoData.topics;
      for (let i = 0; i < topics.length; i++) {
        const ts = topics[i].timestamp;
        if (ts != null && ts <= t && ts > bestTime) {
          best = i;
          bestTime = ts;
        }
      }
      if (best !== AppState.activeTopicIdx) Renderer.setActiveTopic(best);
    }, 1000);
  }

  /* ── Live Transcript Highlight ──────────────────────── */

  let _lastSyncTime = 0;
  const SYNC_INTERVAL_MS = 100;

  function _syncLoop() {
    const now = performance.now();
    if (now - _lastSyncTime >= SYNC_INTERVAL_MS) {
      _lastSyncTime = now;
      syncTranscriptHighlight();
    }
    AppState.transcriptSyncRaf = requestAnimationFrame(_syncLoop);
  }

  function startTranscriptSync() {
    if (AppState.transcriptSyncRaf) return;
    AppState.transcriptSyncRaf = requestAnimationFrame(_syncLoop);
  }

  function stopTranscriptSync() {
    if (AppState.transcriptSyncRaf) { cancelAnimationFrame(AppState.transcriptSyncRaf); AppState.transcriptSyncRaf = null; }
  }

  /* ── Desktop continuous smooth scroll (like mobile) ── */
  let _dsScrollTarget = -1;
  let _dsScrollCurrent = -1;
  let _dsLastPanel = null;
  let _dsRaf = null;
  let _dsLastTime = 0;
  const DS_TAU = 220; // exponential ease time constant (ms) — matches mobile FOLLOW_TAU_MS

  function _dsEaseStep(now) {
    if (!_dsLastPanel) { _dsRaf = null; return; }
    const dt = Math.min(now - _dsLastTime, 50); // cap to avoid huge jumps after tab switch
    _dsLastTime = now;
    const alpha = 1 - Math.exp(-dt / DS_TAU);
    _dsScrollCurrent += (_dsScrollTarget - _dsScrollCurrent) * alpha;
    _dsLastPanel.scrollTop = _dsScrollCurrent;
    if (Math.abs(_dsScrollTarget - _dsScrollCurrent) > 0.5) {
      _dsRaf = requestAnimationFrame(_dsEaseStep);
    } else {
      _dsLastPanel.scrollTop = _dsScrollTarget;
      _dsRaf = null;
    }
  }

  function _dsScrollTo(panel, targetOffset) {
    const clamped = Math.max(0, Math.min(targetOffset, panel.scrollHeight - panel.clientHeight));
    _dsScrollTarget = clamped;
    _dsLastPanel = panel;
    if (!_dsRaf) _dsScrollCurrent = panel.scrollTop;   // always sync to real position when starting fresh
    if (!_dsRaf) {
      _dsLastTime = performance.now();
      _dsRaf = requestAnimationFrame(_dsEaseStep);
    }
  }

  /**
   * Single source of truth for desktop scroll math.
   *
   * Given a scrollable buffer and a video time, compute the interpolated
   * scroll offset that centers the currently-spoken line ~30% from the top
   * of the viewport. Used by both the live sync loop and the tab-return
   * snap API so they can never drift.
   *
   * Returns null if the panel isn't scrollable (fits in viewport) or no
   * row matches the given time.
   */
  /* ── Row index cache (K5.5, 2026-05-07) ─────────────────────────────────
   * Per-panel cache of the .transcript-line / .transcript-paragraph rows
   * + their .ts-chip data-time values, plus a binary-search lookup for
   * the active row at time t. Replaces a per-tick querySelectorAll +
   * linear backward scan that was the dominant per-frame karaoke-side
   * cost in the K1 perf trace (300+ sampler hits in 10s on a long video,
   * 25× more than KaraokeWave.applyWord). See
   * docs/_logs/Trace-20260507T160214-analysis.md for the baseline.
   *
   * Two hot callers per heartbeat tick on desktop:
   *   - syncTranscriptHighlight (picker-band scan + AppState.lastHighlightedRow)
   *   - _computeDesktopScrollOffset (auto-scroll target + interpolation row)
   * Both call _findActiveRowAt(panel, t) → both hit the same cache.
   *
   * Cache invariants:
   *   - keyed by panel HTMLElement (WeakMap → auto-GC on buffer detach)
   *   - times[i] = chip data-time, ascending. Rows without a .ts-chip get
   *     -Infinity so the binary search will never return them as "active".
   *   - generation bumps on every invalidate; a DEV-only assert re-runs
   *     the linear scan on every lookup and warns on mismatch (catches
   *     missed invalidation hooks before they ship).
   *
   * Invalidation is EXPLICIT: any code path that mutates the row set must
   * call PlayerManager.invalidateRowIndex(panel) AFTER the DOM write.
   * Known sites (3, verified by `grep "invalidateRowIndex" src/`):
   *   1. src/js/ui/renderer.js : `standby.innerHTML = html` — main rebuild
   *      path; covers initial render + language switch + video swap +
   *      bilingual toggle (which re-routes through _scheduleRender → here).
   *   2. src/js/ui/flat-transcript.js : `_content.innerHTML = ''` + row
   *      appendChild loop — defensive (mobile-only today; if a desktop
   *      variant ever uses _content as scroll panel the cache stays
   *      consistent).
   *   3. src/js/ui/loading-state.js : skeleton wipe of both transcript
   *      and subtitle TranscriptBuffer panels on new-video processing.
   * Over-invalidating is cheap (one WeakMap delete); under-invalidating
   * gives stale rows → scroll anchor locks to wrong line → DEV assert
   * catches it during testing. Audit the next rebuild path you add against
   * this list before wiring it up. */
  const _rowIndex = new WeakMap();
  let _rowIndexGen = 0;

  function _buildRowIndex(panel) {
    /* K6 (2026-05-07) hardening: only include rows that have a finite
     * .ts-chip data-time. Chipless rows would have inserted -Infinity into
     * times[], breaking the ascending-sort assumption that the binary search
     * relies on (consider: [10, -Infinity, 20] is not sorted). The original
     * pre-K5.5 backward linear scan skipped chipless rows naturally; this
     * mirrors that behavior at build time so the cached lookup stays
     * monotonic-safe.
     *
     * Side effect: rows[] no longer 1:1 with the DOM querySelectorAll order
     * if any chipless rows exist (e.g., translation-transcript.js can emit
     * lines without timestamps). But all callers use rows[bestIdx] for the
     * "active row" or rows[1]/rows[2] for picker-band paragraph thresholds
     * — both semantics are MORE correct against the chipped subset (a
     * chipless row isn't really a paragraph in the picker-band sense). For
     * all-chipped transcripts (English source) behavior is byte-identical. */
    const nodeList = panel.querySelectorAll('.transcript-line, .transcript-paragraph');
    const rowsArr = [];
    const timesArr = [];
    for (let i = 0; i < nodeList.length; i++) {
      const row = nodeList[i];
      const chip = row.querySelector('.ts-chip');
      if (!chip) continue;
      const t = Number(chip.dataset.time);
      if (!Number.isFinite(t)) continue;
      rowsArr.push(row);
      timesArr.push(t);
    }
    const times = Float64Array.from(timesArr);
    return { rows: rowsArr, times, gen: _rowIndexGen };
  }

  function _getRowIndex(panel) {
    let entry = _rowIndex.get(panel);
    if (!entry) {
      entry = _buildRowIndex(panel);
      _rowIndex.set(panel, entry);
    }
    return entry;
  }

  function _invalidateRowIndex(panel) {
    if (panel) _rowIndex.delete(panel);
    _rowIndexGen++;
  }

  /** Find the latest row whose chip time <= t. Returns { row, idx } or
   *  null if no row qualifies (no rows yet, or all chip times > t).
   *  Binary search → O(log N) vs the previous O(N) backward linear scan. */
  function _findActiveRowAt(panel, t) {
    const entry = _getRowIndex(panel);
    const times = entry.times;
    const n = times.length;
    if (n === 0) return null;
    // upper_bound − 1: largest idx with times[idx] <= t
    let lo = 0, hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (times[mid] <= t) lo = mid + 1;
      else hi = mid;
    }
    const idx = lo - 1;
    if (idx < 0) return null;
    /* DEV-only sanity: re-run the linear scan and assert the binary search
     * agrees. Catches missed invalidation hooks (cache stale → wrong row →
     * user sees scroll anchor lock to wrong line). Stripped from prod via
     * Vite import.meta.env.DEV dead-code elimination — zero prod cost.
     * Post-K6 hardening: times[] no longer contains -Infinity (chipless
     * rows are filtered at build time), so the linear scan no longer needs
     * the chipless guard either — purely "largest idx with times[i] <= t". */
    if (import.meta.env.DEV) {
      let linearIdx = -1;
      for (let i = n - 1; i >= 0; i--) {
        if (times[i] <= t) { linearIdx = i; break; }
      }
      if (linearIdx !== idx) {
        console.warn('[K5.5] _findActiveRowAt mismatch — row-index cache likely stale', {
          panel, t, binaryIdx: idx, linearIdx, n, gen: entry.gen,
        });
      }
    }
    return { row: entry.rows[idx], idx };
  }

  /* Per-row anchor with KB1 handoff + 200ms sticky last-seen position.
   *
   * Used for the BILINGUAL path only. Single/paragraph rows use plain
   * row.top (smooth time-based interp). KB1 (2026-05-08) keeps the
   * "kissing top edge" drift out of bilingual; the sticky cache below
   * is the 2026-05-09 fix for the row-mismatch flip-flop where active
   * could land in nextRow before chip-time advanced, snapping bestAnchor
   * from active position back to row.top mid-stream.
   *
   * Cached Y is in CONTENT space (viewport - containerTop + scrollTop)
   * so it stays correct as the panel scrolls during the sticky window.
   *
   * Returns CONTENT-space Y. Caller subtracts panel.clientHeight*centerFrac
   * for the final offset; no further coordinate conversion needed. */
  const STATE_PRE_KARAOKE = 'pre';
  const STATE_DONE = 'done';
  const _kb1State = new WeakMap();
  const _rowLastActiveContentY = new WeakMap();
  const _rowLastActiveAt = new WeakMap();
  const KB1_HANDOFF_MS = 220;
  const ACTIVE_STICKY_MS = 5000;
  const KB1_PREFERS_REDUCED_MOTION =
    typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
      : false;

  function _activeAnchorContentY(row, panel, containerTop) {
    const rowTopContent = row.getBoundingClientRect().top - containerTop + panel.scrollTop;
    if (!AppState.useActiveLineAnchor) return rowTopContent;

    /* Scope to PRIMARY .ts-text — bilingual rows have karaoke spans in both
     * primary and .bilingual-sub. A row-level querySelector flip-flops
     * between them as different words light up, oscillating target between
     * top-of-row and bottom-of-row. Anchoring on primary keeps it stable. */
    const primary = row.querySelector('.ts-text');
    const active = primary && primary.querySelector('.karaoke-active-word');
    const now = performance.now();

    if (!active) {
      const cached = _rowLastActiveContentY.get(row);
      const lastAt = _rowLastActiveAt.get(row) || 0;
      if (cached != null && now - lastAt < ACTIVE_STICKY_MS) return cached;
      if (_kb1State.get(row) === undefined) _kb1State.set(row, STATE_PRE_KARAOKE);
      return rowTopContent;
    }

    const activeContentY = active.getBoundingClientRect().top - containerTop + panel.scrollTop;
    _rowLastActiveContentY.set(row, activeContentY);
    _rowLastActiveAt.set(row, now);

    if (KB1_PREFERS_REDUCED_MOTION) return activeContentY;

    const s = _kb1State.get(row);
    if (s === STATE_PRE_KARAOKE) {
      _kb1State.set(row, now);
      return rowTopContent;
    }
    if (typeof s === 'number') {
      const elapsed = now - s;
      if (elapsed < KB1_HANDOFF_MS) {
        const frac = elapsed / KB1_HANDOFF_MS;
        return rowTopContent + (activeContentY - rowTopContent) * frac;
      }
      _kb1State.set(row, STATE_DONE);
      return activeContentY;
    }
    if (s === undefined) _kb1State.set(row, STATE_DONE);
    return activeContentY;
  }

  function _isBilingualRow(row) {
    return !!row.querySelector('.bilingual-sub:not(.bilingual-sub-hidden)');
  }

  function _computeDesktopScrollOffset(panel, t) {
    if (!panel || panel.scrollHeight <= panel.clientHeight) return null;
    const found = _findActiveRowAt(panel, t);
    if (!found) return null;
    const { row: best, idx: bestIdx } = found;
    const entry = _getRowIndex(panel);
    const rows = entry.rows;
    const times = entry.times;

    const containerTop = panel.getBoundingClientRect().top;
    const centerFrac = _scrollCenterFrac();

    /* NOTE: rows[] only contains .transcript-line / .transcript-paragraph
     * (the querySelectorAll filter inside _buildRowIndex). .bilingual-sub
     * elements are CHILD nodes of those rows, not siblings — see comment
     * at karaoke-dom.js:437. The bilingual-sub skip below is vestigial in
     * the cached path; kept as a defensive guard in case row markup changes. */
    const bestTime = times[bestIdx];
    let nextRow = null;
    let nextTime = bestTime + 10;
    for (let j = bestIdx + 1; j < rows.length; j++) {
      if (!rows[j].classList.contains('bilingual-sub')) {
        nextRow = rows[j];
        nextTime = times[j];
        break;
      }
    }
    const span = nextTime - bestTime;
    const frac = span > 0 ? Math.min(1, (t - bestTime) / span) : 0;

    /* Bilingual rows: anchor on the karaoke active line so primary stays in
     * view (KB1's "kissing top edge" fix). Single/paragraph rows: plain
     * row.top so the rAF gets a smooth, constant time-based velocity through
     * the row instead of freezing between karaoke line transitions. */
    const useActive = _isBilingualRow(best) || (nextRow && _isBilingualRow(nextRow));
    const bestTopContent = useActive
      ? _activeAnchorContentY(best, panel, containerTop)
      : best.getBoundingClientRect().top - containerTop + panel.scrollTop;
    const bestOffset = bestTopContent - panel.clientHeight * centerFrac;

    let targetOffset = bestOffset;
    if (nextRow) {
      const nextTopContent = useActive
        ? _activeAnchorContentY(nextRow, panel, containerTop)
        : nextRow.getBoundingClientRect().top - containerTop + panel.scrollTop;
      const nextOffset = nextTopContent - panel.clientHeight * centerFrac;
      targetOffset = bestOffset + (nextOffset - bestOffset) * frac;
    }

    const clamped = Math.max(0, Math.min(targetOffset, panel.scrollHeight - panel.clientHeight));
    return { offset: clamped, row: best };
  }

  function syncTranscriptHighlight() {
    if (!AppState.player || typeof AppState.player.getCurrentTime !== 'function') return;

    const t = AppState.player.getCurrentTime();

    // ── Mobile path: clean sync via Renderer facade ──────
    const isMobile = Helpers.isNarrowViewport();
    if (isMobile) {
      Renderer.syncActiveMobilePanelToTime(t);
      // Karaoke must run on mobile too — the desktop path below calls
      // syncWord(t) after the auto-scroll work, but mobile early-returns
      // here. Without this call the chunk loader (heartbeat-driven) and
      // the active-word highlight loop never fire on mobile, so karaoke
      // is invisible there even when fully enabled.
      if (typeof window.KaraokeManager !== 'undefined') window.KaraokeManager.syncWord(t);
      return;
    }

    // ── Desktop path ────────────────────────────────────────────
    const transcriptPane = document.getElementById('tab-transcript');
    const onTranscript = transcriptPane && transcriptPane.classList.contains('active');
    if (!onTranscript) return;

    const activePaneId = 'tab-transcript';
    const bufMode = 'transcript';
    // Pause auto-scroll during crossfade transitions
    if (TranscriptBuffer.isFading(bufMode)) return;
    const panel = TranscriptBuffer.getActive(bufMode);
    if (!panel) return;

    // Reset easing state if panel changed (tab switch)
    if (panel !== _dsLastPanel) {
      // Kill stale easing so old target doesn't scroll the new panel
      if (_dsRaf) { cancelAnimationFrame(_dsRaf); _dsRaf = null; }
      _dsScrollCurrent = panel.scrollTop;
      _dsLastPanel = panel;
    }

    /* K5.5: shared row-index cache (see _findActiveRowAt above). One binary
     * search replaces the per-tick querySelectorAll + linear backward scan.
     * The picker-band block below reuses `rows` + `times` from the same
     * cache entry → both hot scans are now O(log N) instead of 2× O(N). */
    const found = _findActiveRowAt(panel, t);
    const entry = _getRowIndex(panel);
    const rows = entry.rows;
    const times = entry.times;
    const best = found ? found.row : null;
    const bestIdx = found ? found.idx : -1;

    // Karaoke word-level sync — must run every tick, not just on row change
    if (typeof window.KaraokeManager !== 'undefined') window.KaraokeManager.syncWord(t);

    if (_dsScrollSuppressUntil > performance.now()) {
      // suppress — language switch snap in progress
    } else if (_isDesktopAutoScrollOnFor(activePaneId)) {
      const result = _computeDesktopScrollOffset(panel, t);
      if (result) _dsScrollTo(panel, result.offset);
    }

    /* Activate/deactivate picker-band fades.
       Suppress the band only at the very start so the user can read paragraphs
       1 and the first half of 2 without them getting fade-masked while karaoke
       is still tracking them. Once we cross the midpoint of paragraph 2, flip
       the band on for the rest of the video.
       Switched from a flat "t < 15s" threshold (arbitrary, breaks on videos
       with longer/shorter paragraphs) to a paragraph-relative threshold:
         - bestIdx >= 2 (in paragraph 3 or later) → band ON
         - bestIdx === 1 AND t past midpoint of paragraph 2 → band ON
         - everything earlier → band OFF
       Midpoint = average of row1's chip-time and row2's chip-time (row1 start
       and row2 start = row1 end). If row2 doesn't exist (very short video,
       only 2 rows total), we keep the band off while in paragraph 2 — the
       user will see the fade once they hit the (non-existent) row 3, i.e.
       never, which is the right behavior for a degenerate 2-row video.
       Must run before the early return below. */
    let _bandOn = false;
    if (bestIdx >= 2) {
      _bandOn = true;
    } else if (bestIdx === 1 && rows.length > 2) {
      // K5.5: read times from the cached row index (Float64Array) instead
      // of two more per-tick querySelector('.ts-chip') + dataset.time reads.
      // Number.isFinite(-Infinity) is false, so chipless rows still fail
      // the check exactly like the original `if (chip)` guard.
      const _t1 = times[1];
      const _t2 = times[2];
      if (Number.isFinite(_t1) && Number.isFinite(_t2) && t >= (_t1 + _t2) / 2) {
        _bandOn = true;
      }
    }
    if (_bandOn) {
      document.querySelectorAll('.transcript-list:not(.picker-band-on)').forEach(
        el => el.classList.add('picker-band-on')
      );
    } else {
      document.querySelectorAll('.transcript-list.picker-band-on').forEach(
        el => el.classList.remove('picker-band-on')
      );
    }

    // Track which row is "current" for downstream consumers (desktop
    // jump-to-now visibility check reads `AppState.lastHighlightedRow != null`).
    // No `.active` class is applied — the line-level highlight feature was
    // intentionally removed (mobile UX + desktop's picker-band-blur replaces it).
    AppState.lastHighlightedRow = best;
  }

  /* ── Scroll controls ────────────────────────────────── */

  /* ── Helper: get a specific tab's button container ── */
  function _getDesktopBtnsForPane(paneId) {
    var pane = document.getElementById(paneId);
    return pane ? pane.querySelector('.desktop-panel-btns') : null;
  }
  function _isDesktopAutoScrollOnFor(paneId) {
    var container = _getDesktopBtnsForPane(paneId);
    if (!container) return AppState.autoScrollEnabled;
    var btn = container.querySelector('.desktop-autoscroll-toggle');
    return btn ? btn.classList.contains('on') : AppState.autoScrollEnabled;
  }

  /* ── Desktop auto-scroll toggle buttons (independent per tab) ── */
  document.querySelectorAll('.desktop-autoscroll-toggle').forEach(function (btn) {
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      var newVal = !this.classList.contains('on');
      this.classList.toggle('on', newVal);
      // Kill any in-flight easing animation when auto-scroll is turned off
      if (!newVal && _dsRaf) {
        cancelAnimationFrame(_dsRaf);
        _dsRaf = null;
      }
    });
  });

  /* ── Desktop jump-to-now buttons (scoped to own tab, no tab switch) ── */
  document.querySelectorAll('.desktop-jump-to-now').forEach(function (btn) {
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      if (!AppState.player || typeof AppState.player.getCurrentTime !== 'function') return;
      var t = AppState.player.getCurrentTime();

      // Use the transcript buffer directly (not Renderer.showTranscriptAt which switches to transcript)
      var panel = TranscriptBuffer.getActive('transcript');
      if (!panel) return;
      var result = _computeDesktopScrollOffset(panel, t);
      if (result) {
        _dsLastPanel = panel;
        if (_dsScrollCurrent < 0) _dsScrollCurrent = panel.scrollTop;
        _dsScrollTo(panel, result.offset);
      }
    });
  });

  /* ── Desktop jump-to-now visibility check (per tab) ── */
  setInterval(function () {
    var isMobile = Helpers.isNarrowViewport();
    if (isMobile) return;
    document.querySelectorAll('.desktop-panel-btns').forEach(function (container) {
      var toggle = container.querySelector('.desktop-autoscroll-toggle');
      var jumpBtn = container.querySelector('.desktop-jump-to-now');
      if (!toggle || !jumpBtn) return;
      var isOn = toggle.classList.contains('on');
      var shouldShow = !isOn && AppState.lastHighlightedRow != null;
      jumpBtn.classList.toggle('visible', shouldShow);
    });
  }, 500);

  const _scrollTopBtn = document.getElementById('scrollTopBtn');
  const _isMobile = () => Helpers.isNarrowViewport();
  function _getScroller() {
    if (_isMobile()) return document.getElementById('resultsView');
    return TranscriptBuffer.getActive('transcript');
  }
  function updateScrollTopVisible() {
    if (!_scrollTopBtn) return;
    var scroller = _getScroller();
    if (!scroller) return;
    const show = scroller.scrollTop > 300;
    _scrollTopBtn.classList.toggle('visible', show);
    _scrollTopBtn.classList.toggle('at-top', !show);
  }
  if (_scrollTopBtn && _scrollPanel) {
    _scrollTopBtn.addEventListener('click', () => {
      var scroller = _getScroller();
      if (scroller) scroller.scrollTo({ top: 0, behavior: 'smooth' });
    });
    _scrollPanel.addEventListener('scroll', updateScrollTopVisible, { passive: true });
    var rv = document.getElementById('resultsView');
    if (rv) rv.addEventListener('scroll', updateScrollTopVisible, { passive: true });
    const transcriptTab = document.getElementById('tab-transcript');
    if (transcriptTab) {
      const obs = new MutationObserver(() => {
        if (transcriptTab.classList.contains('active')) {
          updateScrollTopVisible();
        } else {
          _scrollTopBtn.classList.remove('visible');
        }
      });
      obs.observe(transcriptTab, { attributes: true, attributeFilter: ['class'] });
    }
    updateScrollTopVisible();
  }


  let _dsScrollSuppressUntil = 0;
  /** Suppress auto-scroll easing for a duration (ms) and snap to a position. */
  function resetScrollEasing(pos, suppressMs) {
    if (_dsRaf) { cancelAnimationFrame(_dsRaf); _dsRaf = null; }
    _dsScrollCurrent = -1;
    if (suppressMs) _dsScrollSuppressUntil = performance.now() + suppressMs;
  }

  /**
   * Snap the desktop auto-scroll to the current video time on the active
   * buffer for `bufMode`. Atomically seeds the easing engine's shadow state
   * (_dsLastPanel / _dsScrollCurrent / _dsScrollTarget / _dsLastTime) so the
   * next sync tick starts from the correct position with effectively zero
   * delta — no visible catch-up animation on tab return.
   *
   * Called by renderer.js during setMode() tab switch, while the target pane
   * is still visibility:hidden. The caller is responsible for keeping the
   * pane hidden until this returns, so the scroll write is never painted at
   * the wrong place.
   *
   * Behavior:
   * - If a crossfade is in progress, bail. The normal sync loop's eased
   *   catch-up will resolve to the correct position within ~220ms once
   *   the crossfade completes. Acceptable in this narrow race — defer was
   *   considered and rejected (would introduce an up-to-1s blank pane,
   *   which is worse UX than a smooth 220ms ease).
   * - If auto-scroll is off for this pane, no-op (respect the toggle).
   * - If the panel isn't scrollable (content fits in viewport), no-op.
   * - Returns the currently-active row for highlight application, or null.
   *
   * Thread safety: this runs synchronously from a click handler via setMode.
   * JavaScript is single-threaded, so no rAF tick from _syncLoop can
   * interleave with this. Safe to seed without locking. Do NOT add async
   * work to this path without reconsidering this guarantee.
   */
  function snapDesktopAutoScrollToNow(bufMode) {
    // Bail on in-flight crossfade — eased catch-up on next sync tick will
    // resolve to correct position within ~220ms. See "Why bail" in the
    // scroll sync implementation plan for the full reasoning.
    if (TranscriptBuffer.isFading(bufMode)) return null;

    const paneId = 'tab-transcript';
    if (!_isDesktopAutoScrollOnFor(paneId)) return null;

    const panel = TranscriptBuffer.getActive(bufMode);
    if (!panel) return null;
    if (!AppState.player || typeof AppState.player.getCurrentTime !== 'function') return null;

    const tNow = AppState.player.getCurrentTime();
    const targetResult = _computeDesktopScrollOffset(panel, tNow);
    if (!targetResult) return null;

    // Compute the natural STEADY-STATE LAG position. In normal operation,
    // the easing engine keeps _dsScrollCurrent lagging _dsScrollTarget by
    // roughly DS_TAU worth of playback (~220ms). If we just seed
    // current = target = "exact now", the ease engine has zero delta on
    // tab return, then has to accelerate from 0 to the natural rate over
    // the full time constant — visible as a "parked → jump-start" effect,
    // especially on subtitles which scroll faster.
    //
    // Fix: seed current = "offset for (now - tau)" (the lagged position
    // the user would naturally see in steady-state), target = "offset for
    // now" (where the engine should be heading). The ease engine then
    // starts with a natural non-zero delta and moves at the correct rate
    // from the very first frame.
    const LOOKBACK_SEC = DS_TAU / 1000;
    const laggedResult = _computeDesktopScrollOffset(panel, Math.max(0, tNow - LOOKBACK_SEC));
    const laggedOffset = laggedResult ? laggedResult.offset : targetResult.offset;

    // Atomic seed: cancel ease, write DOM at lagged position, sync shadow state
    if (_dsRaf) { cancelAnimationFrame(_dsRaf); _dsRaf = null; }
    panel.scrollTop  = laggedOffset;        // visible position = natural lag
    _dsLastPanel     = panel;
    _dsScrollCurrent = laggedOffset;        // ease starts from lag position
    _dsScrollTarget  = targetResult.offset; // ease heads toward exact-now position
    _dsLastTime      = performance.now();

    // Kick-start the ease loop RIGHT NOW so the first visible motion
    // happens on the very next frame instead of waiting for the next
    // sync tick (which could be up to 2 frames away).
    if (Math.abs(_dsScrollTarget - _dsScrollCurrent) > 0.5) {
      _dsRaf = requestAnimationFrame(_dsEaseStep);
    }

    // Return the "exact now" row so the highlight marks the line being
    // spoken right now, not the lagged row.
    return targetResult.row;
  }

  /**
   * Light-touch reseed for in-place layout mutations (e.g. bilingual toggle).
   * Syncs _dsScrollCurrent to the panel's new scrollTop and refreshes
   * _dsScrollTarget from current video time (row heights may have changed).
   * Does NOT cancel _dsRaf — the easing loop keeps running uninterrupted.
   */
  function reseedEasingCurrent(panel) {
    if (panel !== _dsLastPanel) return;
    const tNow = AppState.player?.getCurrentTime?.();
    const result = tNow != null ? _computeDesktopScrollOffset(panel, tNow) : null;
    if (result) _dsScrollTarget = result.offset;
    _dsScrollCurrent = panel.scrollTop;
    _dsLastTime = performance.now();
  }

  /**
   * Seed the easing engine after a buffer swap (crossfade completion or snapSwap).
   * Trusts the panel's current scrollTop (set by scroll-anchor restore) — does NOT
   * override it. Sets _dsScrollTarget from current video time so the engine eases
   * naturally from the anchor toward the playback position.
   *
   * Unlike snapDesktopAutoScrollToNow (which writes scrollTop for tab-return),
   * this preserves the renderer's carefully computed anchor position.
   *
   * @param {HTMLElement} panel - the newly-active buffer element
   * @param {string} bufMode - 'transcript' or 'subtitle'
   */
  function seedEasingAfterSwap(panel, bufMode) {
    if (!panel) return;
    if (!AppState.player || typeof AppState.player.getCurrentTime !== 'function') return;

    // Respect autoscroll toggle — if OFF, just align shadow state, don't drive motion
    const paneId = 'tab-transcript';
    if (!_isDesktopAutoScrollOnFor(paneId)) {
      if (_dsRaf) { cancelAnimationFrame(_dsRaf); _dsRaf = null; }
      _dsLastPanel = panel;
      _dsScrollCurrent = panel.scrollTop;
      return;
    }

    const tNow = AppState.player.getCurrentTime();
    const targetResult = _computeDesktopScrollOffset(panel, tNow);

    // Always update _dsLastPanel even if panel isn't scrollable.
    if (_dsRaf) { cancelAnimationFrame(_dsRaf); _dsRaf = null; }
    _dsLastPanel     = panel;
    _dsScrollCurrent = panel.scrollTop;

    if (!targetResult) return; // not scrollable — shadow state aligned, nothing to ease

    _dsScrollTarget  = targetResult.offset;
    _dsLastTime      = performance.now();

    if (Math.abs(_dsScrollTarget - _dsScrollCurrent) > 0.5) {
      _dsRaf = requestAnimationFrame(_dsEaseStep);
    }
  }

  /**
   * Write the correct playback-derived scrollTop to any panel (even standby).
   * Used to position a hidden buffer BEFORE a crossfade starts, so it fades in
   * at the right place. Uses lagged position for natural steady-state feel.
   * Does NOT touch easing engine state — caller seeds after swap.
   */
  function writePlaybackScrollTop(panel) {
    if (!panel) return;
    if (!AppState.player || typeof AppState.player.getCurrentTime !== 'function') return;
    const tNow = AppState.player.getCurrentTime();
    const targetResult = _computeDesktopScrollOffset(panel, tNow);
    if (!targetResult) return;
    const LOOKBACK_SEC = DS_TAU / 1000;
    const laggedResult = _computeDesktopScrollOffset(panel, Math.max(0, tNow - LOOKBACK_SEC));
    const pos = laggedResult ? laggedResult.offset : targetResult.offset;
    panel.scrollTop = pos;
  }

  /**
   * Transition the player from rewind mode to normal state.
   * Called after RewindEffect finishes — the YT.Player instance is already in AppState.player.
   */
  function transitionFromRewind() {
    if (!AppState.player) return;
    // Skip the reset-to-0+pause if the user has already started watching.
    // On iOS Safari (autoplay denied) the rewind animation runs in degraded
    // mode without touching the iframe; the user can tap play during that
    // window and end up watching real playback by the time this function
    // fires (pipeline-end, ~15s in on a fresh karaoke load). Yanking them
    // back to 0 + pausing mid-watch is the bug — detect it via current time
    // and skip the destructive part of the transition. unMute + facade
    // hide + event-handler registration still run so karaoke can sync.
    let userIsWatching = false;
    try {
      const t = AppState.player.getCurrentTime ? (AppState.player.getCurrentTime() || 0) : 0;
      const state = AppState.player.getPlayerState ? AppState.player.getPlayerState() : -1;
      userIsWatching = t > 0.5 || state === 1 /* YT.PlayerState.PLAYING */;
    } catch (_) {}
    if (!userIsWatching) {
      // Open the settling window before issuing the seek/pause so the
      // (async) PLAYING/PAUSED postMessages from YT are ignored when they
      // land. 500ms is generous for the iframe to process both calls.
      AppState.postRewindSettling = true;
      setTimeout(() => { AppState.postRewindSettling = false; }, 500);
      try {
        AppState.player.seekTo(0, true);
        AppState.player.pauseVideo();
      } catch (_) {}
    }
    try { AppState.player.unMute(); } catch (_) {}
    // Register normal playback handlers (rewind created the player with its own)
    try {
      AppState.player.addEventListener('onStateChange', onPlayerStateChange);
      AppState.player.addEventListener('onReady', onPlayerReady);
    } catch (_) {}
    // If the user was already watching when we got here (mobile-iOS path
    // described above), no fresh PLAYING state-change will fire after the
    // listeners attach — kick the playback UI sync manually so karaoke,
    // mech-time, and the rest of the per-tick loop start immediately
    // instead of waiting until the next pause/play cycle.
    if (userIsWatching) {
      try { kickPlaybackUiSync(); } catch (_) {}
    }
    // The frameless facade was mounted at REWIND START (rewind.js
    // _injectOverlays) so a single consistent white play button covers
    // YT's grey button during rewind and stays through to the user click.
    // We deliberately do NOT call showFacade here — that would swap the
    // already-up frameless facade for a thumbnail+red-button facade,
    // which is exactly the jarring jump we removed. The facade is already
    // in resume mode, so its existing onclick (dismissFacadeAndPlay) is
    // the right wiring; the desktop auto-play path in app.js calls the
    // same function when its reveal timeline completes.
    PlayerFacade.hideEmbedFallback();
    // Show the click-blocker / tap-catcher overlay (.yt-overlay, z=4)
    // above the facade (z=3). Without this, on mobile the overlay stays
    // display:none (set by showFacade during rewind) and the only working
    // tap target is the explicit play button — taps on the video frame
    // area do nothing. The overlay's click handler checks if the facade
    // is still visible and routes through dismissFacadeAndPlay (volume +
    // unmute + play) or plain toggleMechPlay accordingly.
    PlayerFacade.showOverlay();

    // Update duration in scrubber
    const dur = AppState.player.getDuration ? AppState.player.getDuration() : 0;
    if (dur > 0) {
      const totalEl = document.querySelector('.mech-time-total');
      if (totalEl) totalEl.textContent = Helpers.fmtTime(Math.floor(dur));
      const scrubberTotal = document.getElementById('scrubberTotal');
      if (scrubberTotal) scrubberTotal.textContent = Helpers.fmtTime(Math.floor(dur));
    }
  }

  /* ── Sub-module wiring ──────────────────────────────── */

  PlayerFacade.setup({
    activatePlayer: _activatePlayer,
    afterStartPlayback: kickPlaybackUiSync,
  });
  PlayerControls.setup({
    syncTranscriptHighlight,
    setSeeking: (val) => { _seeking = val; },
    activatePlayer: _activatePlayer,
  });

  return {
    init,
    cueVideo,
    swapVideo,
    initSubtitles: PlayerSubtitles.initSubtitles,
    startTopicTracker,
    startTranscriptSync,
    stopTranscriptSync,
    _activatePlayer,
    resetScrollEasing,
    snapDesktopAutoScrollToNow,
    reseedEasingCurrent,
    seedEasingAfterSwap,
    writePlaybackScrollTop,
    invalidateRowIndex: _invalidateRowIndex,
    transitionFromRewind,
    dismissFacadeAndPlay: PlayerFacade.dismissFacadeAndPlay,
    showFacade: PlayerFacade.showFacade,
    hideFacade: PlayerFacade.hideFacade,
  };
})();
