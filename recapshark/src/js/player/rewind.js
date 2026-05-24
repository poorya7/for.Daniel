import { AppState } from '../core/state.js';
import { Helpers } from '../core/helpers.js';

/**
 * VHS Rewind Loading Effect
 * Plays a VHS-style rewind animation on the YouTube player during page load.
 * Self-contained module — injects/removes its own DOM, manages its own YT player events.
 */
export const RewindEffect = (() => {

  // ── Config ──
  const REWIND_DURATION_MS = 6500;
  const FRAME_INTERVAL_MS  = 350;
  const MIN_DURATION_SEC   = 10;

  // Console-only logger — silenced after the iOS 18.7 / Safari 26.1
  // autoplay regression was diagnosed and the degraded-mode fallback
  // shipped. Earlier iterations had a visible green debug overlay on
  // mobile (stripped); the [REW] console logs that remained were just
  // residue. Re-enable by un-commenting the `console.log` line if
  // future rewind debugging is needed.
  function _log() {
    // try {
    //   const args = Array.prototype.slice.call(arguments);
    //   console.log.apply(console, ['[REW]'].concat(args));
    // } catch (_) {}
  }
  // Snapshot helper kept as no-op so existing call sites (_onReady) still
  // work; redirect to _log if anyone wants to revive on-device debugging.
  function _snapshot() {}

  // ── State ──
  let _running = false;
  let _rafId = null;
  let _frameTimerId = null;
  let _startTs = 0;
  let _startPos = 1;
  let _duration = 0;
  let _player = null;
  let _resolvePromise = null;
  let _autoStarted = false;
  let _videoFrame = null;
  // Preload state: when prepare() runs early (during the morph), the YT
  // iframe loads + seeks + pauses in the background. By the time start()
  // fires, _preloaded is true and we skip straight to _beginRewind instead
  // of repeating the (slow) iframe-load → autoplay → seek → 400ms cushion
  // chain. _preloadStartReq holds the start() promise resolver if start()
  // was called before preload finished — _onStateChange completes it.
  let _preloaded = false;
  let _preloadVideoId = null;
  let _preloadStartReq = false;
  // Tracks the videoId of the rewind currently in-flight (set by start()).
  // Used by _injectOverlays to mount the frameless facade with the right id
  // so its resume-mode onclick can later play THIS video.
  let _activeVideoId = null;
  // iOS Safari 18.7 / Safari 26.1 silently denies cross-origin YT iframe
  // autoplay even with mute:1 + playsinline:1 in async paste flows (the
  // user-gesture transient activation expires during our awaits before
  // the iframe is constructed). Symptom: state goes BUFFERING → UNSTARTED
  // and never reaches PLAYING. Detected by AUTOPLAY_TIMEOUT_MS firing
  // without _running having been set. In that mode we run the rewind UI
  // animation (scrubber, time label, REW badge, scan lines) without the
  // frame-seek loop — the iframe stays static behind the black cover.
  // Same rewind feel, no dependency on iOS autoplay.
  const AUTOPLAY_TIMEOUT_MS = 1500;
  let _autoplayFailed = false;
  let _autoplayTimeoutId = null;

  // ── DOM refs (injected) ──
  let _cover = null;
  let _overlay = null;
  let _badge = null;
  let _seekbar = null;
  let _progress = null;
  let _scrubber = null;
  let _timeLabel = null;

  // ── Helpers ──
  // Time labels route through Helpers.fmtTime (Phase 4b, 2026-05-08) so the
  // rewind label format stays consistent with every other clock label in the
  // app (scrubber, chapter chips, transcript timestamps). Pre-Phase-4b this
  // module had a local _fmtTime that always returned `m:ss` regardless of
  // duration, so a 2-hour video showed `120:00` here but `2:00:00` everywhere
  // else; Helpers.fmtTime's `h:mm:ss when ≥1h` format is the honest one.

  function _getPosition(now) {
    const elapsed = now - _startTs;
    const t = Math.min(1, elapsed / REWIND_DURATION_MS);
    return Math.max(0.001, _startPos - t * _startPos);
  }

  // ── DOM injection ──
  function _injectOverlays() {
    _videoFrame = document.querySelector('.video-frame');
    if (!_videoFrame) { _log('injectOverlays: NO .video-frame'); return; }
    _log('injectOverlays: mounting');

    // Black cover to hide YT spinner — reuse early cover if present
    const _existing = document.getElementById('rewindEarlyCover');
    if (_existing) {
      _cover = _existing;
      _cover.removeAttribute('id');
    } else {
      _cover = document.createElement('div');
      _cover.className = 'rewind-cover';
      _videoFrame.appendChild(_cover);
    }

    // VHS overlay (scanlines + tracking line)
    _overlay = document.createElement('div');
    _overlay.className = 'rewind-overlay';
    _overlay.innerHTML =
      '<div class="overlay-vhs"></div>' +
      '<div class="overlay-tracking-band"><div class="band"></div></div>';
    _videoFrame.appendChild(_overlay);

    // REW badge
    _badge = document.createElement('div');
    _badge.className = 'rew-badge';
    // SVG chevrons (not unicode chars) so iOS doesn't render the
    // triangles as full-color emoji glyphs. Same layout: dot, two
    // chevrons, "REW".
    _badge.innerHTML =
      '<span class="rew-dot"></span>' +
      '<svg class="rew-chev" width="16" height="10" viewBox="0 0 16 10" aria-hidden="true">' +
        '<path d="M6 0L0 5L6 10Z" fill="currentColor"/>' +
        '<path d="M14 0L8 5L14 10Z" fill="currentColor"/>' +
      '</svg>' +
      '<span>REW</span>';
    _videoFrame.appendChild(_badge);

    // Time label — initialise to the rewind start position (95% of duration)
    // so the user sees a meaningful timestamp instantly instead of "0:00 / 0:00"
    // during the wait for YT player ready.
    _timeLabel = document.createElement('div');
    _timeLabel.className = 'rewind-time-label';
    if (_duration > 0) {
      _timeLabel.textContent = Helpers.fmtTime(_duration * 0.95) + ' / ' + Helpers.fmtTime(_duration);
    } else {
      _timeLabel.textContent = '0:00 / 0:00';
    }
    _videoFrame.appendChild(_timeLabel);

    // Seekbar — REUSE the real #scrubberFill (the existing .video-scrubber's
    // fill bar) for rewind progress. No separate rewind seekbar is created;
    // _tickSeekbar drives #scrubberFill's width directly. This guarantees
    // the rewind progress visually aligns with the regular scrubber position.

    // Apply .rewinding class immediately so the rewind UI overlays (REW badge,
    // time label) become visible the instant they're injected. Without this,
    // the class is only added in _beginRewind, which on mobile waits ~1.5s
    // for YT iframe load → PLAYING event → cushion. During that window the
    // overlays sit at opacity:0 and the user sees only a blank black cover
    // instead of the VHS rewind aesthetic.
    _videoFrame.classList.add('rewinding');

    // Mount the frameless facade (z=3, above iframe, below cover/scanlines)
    // so a single white play button is visible from rewind start through to
    // user click. Covers YT's own grey play button that bleeds through the
    // iframe when paused. Stays up through _finish (PlayerManager.dismissFacadeAndPlay
    // tears it down on play). On abort() we hide it via cleanup below.
    if (_activeVideoId && window.PlayerManager && window.PlayerManager.showFacade) {
      try { window.PlayerManager.showFacade(_activeVideoId, { resume: true, frameless: true }); } catch (e) { Helpers.reportError(e, 'rewind.PlayerManager.showFacade'); }
    }

    // Paint the YouTube poster onto the cover RIGHT NOW so the user never
    // sees a plain black square. If iframe autoplay succeeds, the cover
    // fades out in _beginRewind (.hidden class) and frames are visible
    // behind. If autoplay fails (iOS 18.7+), the cover stays up showing
    // the poster, with the rewind UI animating over it. Same setup; the
    // cover just chooses whether to reveal what's behind based on whether
    // the iframe is playing. hqdefault is universally available — load it
    // immediately as the visible bg, then swap in maxresdefault if/when
    // it loads (some older uploads 404 max).
    if (_activeVideoId && _cover) {
      _cover.classList.add('rewind-cover--thumbnail');
      const _maxUrl = 'https://img.youtube.com/vi/' + _activeVideoId + '/maxresdefault.jpg';
      const _hqUrl  = 'https://img.youtube.com/vi/' + _activeVideoId + '/hqdefault.jpg';
      _cover.style.backgroundImage = 'url(' + _hqUrl + ')';
      const _probe = new Image();
      _probe.onload = () => {
        if (_cover) _cover.style.backgroundImage = 'url(' + _maxUrl + ')';
      };
      _probe.src = _maxUrl;
    }
  }

  function _removeOverlays() {
    [_cover, _overlay, _badge, _timeLabel, _seekbar].forEach(el => {
      if (el && el.parentNode) el.parentNode.removeChild(el);
    });
    // Defensive: also remove any orphan .rewind-cover elements still in
    // the DOM. The early cover (created in app.js as #rewindEarlyCover)
    // can leak if RewindEffect.start() never ran — _injectOverlays didn't
    // get a chance to claim it via the module-local _cover ref, so the
    // line above can't see it. Without this sweep, an interrupted/errored
    // pipeline leaves a black box stuck on the video frame.
    document.querySelectorAll('.rewind-cover').forEach(el => el.remove());
    if (_videoFrame) _videoFrame.classList.remove('rewinding');
    _cover = _overlay = _badge = _seekbar = _progress = _scrubber = _timeLabel = _videoFrame = null;
  }

  // ── Seekbar animation (rAF — smooth, never touches YT player) ──
  function _tickSeekbar(ts) {
    if (!_running) return;
    const pos = _getPosition(ts);
    const pct = pos * 100;
    // Drive the REAL .scrubber-fill width (and current-time text) instead of
    // a separate rewind seekbar. The fill shrinks from _startPos*100% → 0%.
    const _fillEl = document.getElementById('scrubberFill');
    if (_fillEl) _fillEl.style.width = pct + '%';
    if (_duration > 0) {
      const currentTime = Helpers.fmtTime(pos * _duration);
      if (_timeLabel) _timeLabel.textContent = currentTime + ' / ' + Helpers.fmtTime(_duration);
      // Sync the real scrubber current time
      const scrubberEl = document.getElementById('scrubberCurrent');
      if (scrubberEl) scrubberEl.textContent = currentTime;
    }
    if (pos > 0.002) {
      _rafId = requestAnimationFrame(_tickSeekbar);
    } else {
      _finish();
    }
  }

  // ── Frame seeks (slow interval — actually moves the YT player) ──
  function _seekFrame() {
    if (!_running || !_player) return;
    const pos = _getPosition(performance.now());
    const seekTime = pos * _duration;
    try { _player.seekTo(seekTime, true); } catch (e) { Helpers.reportError(e, 'rewind._seekFrame.seekTo'); }
  }

  // ── Start the rewind animation (called after player is playing) ──
  function _beginRewind() {
    if (_running) return; // idempotent — guards against double-fire when both
                          // the autoplay-timeout fallback AND a late PLAYING
                          // event try to start the rewind.
    _log('beginRewind: entered, _player =', !!_player, '_autoplayFailed =', _autoplayFailed);
    // Clear the autoplay-timeout — we're starting now, either from a
    // legitimate PLAYING event or from the fallback timer firing.
    if (_autoplayTimeoutId) {
      clearTimeout(_autoplayTimeoutId);
      _autoplayTimeoutId = null;
    }

    const havePlayer = !!_player && !_autoplayFailed;

    if (havePlayer) {
      try { _duration = _player.getDuration() || _duration; } catch (e) { Helpers.reportError(e, 'rewind._beginRewind.getDuration'); }
      try { _player.pauseVideo(); } catch (e) { Helpers.reportError(e, 'rewind._beginRewind.pauseVideo'); }
      let currentTime = 0;
      try { currentTime = _player.getCurrentTime() || 0; } catch (e) { Helpers.reportError(e, 'rewind._beginRewind.getCurrentTime'); }
      _startPos = currentTime / _duration;
      if (_startPos < 0.05) {
        _startPos = 0.95;
        try { _player.seekTo(_startPos * _duration, true); } catch (e) { Helpers.reportError(e, 'rewind._beginRewind.seekTo'); }
      }
    } else {
      // Degraded mode: no iframe playback (iOS autoplay denied). _duration
      // is set from the prepare() arg, so the time-based animations
      // (scrubber, time label, REW badge) all still run correctly.
      // Thumbnail is already painted on the cover from _injectOverlays;
      // it just stays visible (no .hidden fade) for the whole rewind.
      _startPos = 0.95;
    }

    _running = true;
    // .rewinding class is normally added in _injectOverlays so the UI lights
    // up instantly. Re-applying here is a defensive no-op — covers any path
    // that bypasses _injectOverlays.
    if (_videoFrame) _videoFrame.classList.add('rewinding');
    _startTs = performance.now();

    // Fade the cover ONLY when we have a working iframe behind it. In
    // degraded mode the iframe behind shows YouTube's default thumbnail +
    // red play button (state=-1 leaves the embed parked there) — fading
    // the cover would expose that and undo the frameless-facade design.
    // Keep the cover up; the REW badge / time / scrubber animate over it.
    if (_cover && havePlayer) {
      _cover.classList.add('hidden');
    }

    // Smooth seekbar via rAF
    cancelAnimationFrame(_rafId);
    _rafId = requestAnimationFrame(_tickSeekbar);

    // Frame seeks only when we have a working player. In degraded mode
    // _player.seekTo() on a state=-1 player would either no-op or trigger
    // another spurious state change; skip the interval entirely.
    if (havePlayer) {
      clearInterval(_frameTimerId);
      _frameTimerId = setInterval(_seekFrame, FRAME_INTERVAL_MS);
    }
  }

  // ── Finish ──
  // Smooth post-rewind transition staged in three phases so the colorization
  // animates instead of snapping:
  //
  //   Phase 1 — Resolve the rewind promise. The awaiting consumer
  //     (PlayerManager.transitionFromRewind in app.js) runs in the next
  //     microtask and mounts the thumbnail facade. .rewinding is still on
  //     .video-frame, so the facade appears in B&W (CSS rule
  //     `.rewinding .yt-facade { filter: grayscale ... }`) — slotted in as
  //     if it were the next frame after the rewind reached zero.
  //
  //   Phase 2 — After a 200ms hold (lets the eye register the B&W thumbnail),
  //     remove .rewinding from .video-frame. CSS transitions on `filter`
  //     (#ytPlayer + .yt-facade) animate grayscale → natural over 600ms. In
  //     parallel, the REW badge / time label / scanlines fade to opacity 0
  //     via their own existing transitions.
  //
  //   Phase 3 — After 700ms (transitions complete), tear down the now-
  //     invisible rewind overlay DOM. Doing this earlier would snap the
  //     elements out instead of letting them fade.
  function _finish() {
    clearInterval(_frameTimerId);
    cancelAnimationFrame(_rafId);
    if (_autoplayTimeoutId) { clearTimeout(_autoplayTimeoutId); _autoplayTimeoutId = null; }
    // Capture degraded-mode flag BEFORE clearing it. Used in the Phase 3
    // cleanup closure: in degraded mode the cover (with thumbnail painted)
    // is the only thing standing between the user and a black iframe
    // (autoplay-denied YT renders no frames). Keep it up until the user
    // taps play; dismissFacadeAndPlay() in player.js does the final sweep.
    const _wasDegraded = _autoplayFailed;
    _autoplayFailed = false;
    _running = false;

    // Reset real scrubber to 0:00 / 0% so it's clean for normal playback
    const scrubberEl = document.getElementById('scrubberCurrent');
    if (scrubberEl) scrubberEl.textContent = '0:00';
    const _fillEl = document.getElementById('scrubberFill');
    if (_fillEl) _fillEl.style.width = '0%';

    if (_player) {
      try { _player.seekTo(0, true); } catch (e) { Helpers.reportError(e, 'rewind._finish.seekTo'); }
    }
    // Null the module ref so leftover YT event handlers become no-ops
    // (AppState.player still holds the instance for normal playback)
    _player = null;
    _preloaded = false;
    _preloadVideoId = null;
    _preloadStartReq = false;

    if (_resolvePromise) {
      _resolvePromise();
      _resolvePromise = null;
    }

    // Capture overlay refs into a closure and detach module state immediately.
    // The post-rewind transition spans ~900ms, and if a new rewind starts in
    // that window (subsequent paste), abort() + start() would reset the module
    // refs to NEW elements; relying on module state in the delayed cleanup
    // could then nuke the new rewind's UI. The closure refs guarantee we only
    // ever touch the OLD elements we mounted.
    const _captured = {
      vf: _videoFrame,
      cover: _cover,
      overlay: _overlay,
      badge: _badge,
      timeLabel: _timeLabel,
      seekbar: _seekbar,
    };
    _videoFrame = _cover = _overlay = _badge = _timeLabel = _seekbar = _progress = _scrubber = null;

    Promise.resolve().then(() => {
      setTimeout(() => {
        // Skip class removal if a new rewind has taken over .video-frame —
        // its _injectOverlays would have re-added the class for the new run.
        if (!_running && _captured.vf) {
          _captured.vf.classList.remove('rewinding');
        }
        setTimeout(() => {
          // In degraded mode (autoplay denied), keep the cover in the DOM —
          // it's the only element holding the thumbnail; removing it would
          // expose the black autoplay-denied iframe behind the (transparent)
          // frameless facade. dismissFacadeAndPlay() in player.js sweeps any
          // leftover .rewind-cover elements when the user taps play.
          //
          // Cover sits at z-index 5 (above the frameless facade at z-index 3),
          // so without pointer-events:none it would swallow the play tap and
          // dismissFacadeAndPlay would never fire. Disable hit-testing here so
          // taps fall through to the facade — which is what the user clicks
          // to start playback in the first place.
          if (_wasDegraded && _captured.cover) {
            _captured.cover.style.pointerEvents = 'none';
          }
          const _toRemove = _wasDegraded
            ? [_captured.overlay, _captured.badge, _captured.timeLabel, _captured.seekbar]
            : [_captured.cover, _captured.overlay, _captured.badge, _captured.timeLabel, _captured.seekbar];
          _toRemove.forEach(el => {
            if (el && el.parentNode) el.parentNode.removeChild(el);
          });
        }, 700);
      }, 200);
    });
  }

  // ── YT event handlers (temporary, only during rewind) ──
  function _onReady() {
    _log('onReady fired');
    const iframe = document.querySelector('#ytPlayer iframe');
    if (iframe) {
      iframe.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:0;';
      iframe.addEventListener('load', function () { _log('iframe LOAD event'); });
      iframe.addEventListener('error', function (e) { _log('iframe ERROR event:', String(e)); });
    }
    _snapshot();
    // Defensive playVideo() — original 9ddc617 fix for iOS Safari 18.7
    // BUFFERING-stall. Verified via 2026-05-01 experiment that removing it
    // doesn't change the iOS 18.7 / Safari 26.1 outcome (state still goes
    // BUFFERING → UNSTARTED on its own — Apple tightened autoplay further
    // and the embed is now denied silently regardless). Kept here because:
    // (a) it's a no-op on browsers that autoplay successfully, and (b) on
    // older iOS / non-iOS where the original BUFFERING-stall bug applied,
    // this still kicks the player out of stall. The actual iOS 18.7+
    // recovery is handled by the AUTOPLAY_TIMEOUT_MS fallback in start().
    try {
      if (_player && _player.playVideo) {
        _log('onReady: calling playVideo() defensively');
        _player.playVideo();
      }
    } catch (e) { _log('onReady playVideo() ERR:', String(e)); }
  }

  function _onStateChange(e) {
    _log('onStateChange:', e && e.data, '_player =', !!_player);
    if (!_player) return; // rewind finished — let PlayerManager handle events
    if (e.data === YT.PlayerState.PLAYING && !_autoStarted) {
      _autoStarted = true;
      _duration = _player.getDuration() || _duration;
      _player.seekTo(_duration * 0.95, true);
      _player.pauseVideo();
      _preloaded = true;
      // Three cases at this point:
      //   (a) We're in the legacy non-preload flow — start() was called
      //       directly, no prepare(). The 100ms cushion lets YT settle
      //       after seek+pause before _beginRewind reads currentTime
      //       (was 400ms — pre-warm refactor proved 100ms is enough since
      //       in the preload path we hit _beginRewind with zero cushion
      //       and it works fine).
      //   (b) prepare() was called and start() has already fired (race —
      //       start() ran before the iframe finished loading). _preloadStartReq
      //       is true, so kick off rewind now.
      //   (c) prepare() was called but start() hasn't fired yet. Just sit
      //       paused at 95% and wait — start() will trigger _beginRewind
      //       directly when it sees _preloaded=true.
      if (_preloadStartReq) {
        _preloadStartReq = false;
        setTimeout(_beginRewind, 100);
      } else if (_preloadVideoId == null) {
        setTimeout(_beginRewind, 100);
      }
    }
    if (e.data === YT.PlayerState.PLAYING || e.data === YT.PlayerState.PAUSED) {
      _duration = _player.getDuration() || _duration;
    }
  }

  function _onError(e) {
    _log('YT onError:', e && e.data);
    // Embed disabled or other error — abort rewind, let normal flow handle it
    abort();
  }

  // ── Public API ──

  // Shared player-creation helper used by both prepare() and start().
  // Loads the YT iframe API on demand if needed, then creates the player
  // wired to the rewind module's onReady / onStateChange / onError handlers.
  function _spawnPlayer(videoId) {
    _log('spawnPlayer: videoId =', videoId, ', YT defined =', typeof YT !== 'undefined');
    const wrap = document.getElementById('ytPlayer');
    if (!wrap) { _log('spawnPlayer: NO #ytPlayer'); return false; }
    wrap.innerHTML = '';

    function _createPlayer() {
      _log('createPlayer: instantiating YT.Player');
      _player = new YT.Player('ytPlayer', {
        videoId,
        host: 'https://www.youtube-nocookie.com',
        playerVars: {
          autoplay: 1,
          controls: 0,
          mute: 1,
          modestbranding: 1,
          rel: 0,
          playsinline: 1,
          disablekb: 1,
          fs: 0,
          iv_load_policy: 3,
          cc_load_policy: 0,
        },
        events: {
          onReady: _onReady,
          onStateChange: _onStateChange,
          onError: _onError,
        },
      });
      AppState.player = _player;
    }

    if (typeof YT !== 'undefined' && YT.Player) {
      _createPlayer();
    } else {
      AppState._pendingRewindCreate = _createPlayer;
      if (!AppState.ytApiLoaded) {
        AppState.ytApiLoaded = true;
        const tag = document.createElement('script');
        tag.src = 'https://www.youtube.com/iframe_api';
        document.head.appendChild(tag);
      }
    }
    return true;
  }

  /**
   * Pre-warm the YT player in the background so start() can fire instantly.
   * Call this as early as possible (e.g. as soon as resultsView is mounted
   * and #ytPlayer exists in the DOM). The iframe loads, autoplays muted,
   * seeks to 95%, and pauses — all while the morph is animating. By the
   * time start() is called the player is sitting paused and ready, so
   * _beginRewind fires within ~10ms instead of the 700-1500ms iframe load.
   *
   * Safe to call multiple times — only the first call for a given videoId
   * does work; subsequent calls are no-ops. No overlays are injected here;
   * those wait for start().
   *
   * @param {string} videoId
   * @param {number} durationSec
   */
  function prepare(videoId, durationSec) {
    if (!durationSec || durationSec < MIN_DURATION_SEC) return;
    if (_preloadVideoId === videoId) return; // already preloading this one
    if (_running) return; // can't preload while running
    _preloadVideoId = videoId;
    _preloaded = false;
    _autoStarted = false;
    _duration = durationSec;
    _spawnPlayer(videoId);
  }

  /**
   * Start the VHS rewind effect.
   * If prepare() was called earlier with the same videoId, the iframe is
   * already loaded + paused at 95% and rewind begins immediately. Otherwise
   * falls back to the original flow (create player → load → seek → 100ms
   * cushion → rewind).
   *
   * @param {string} videoId
   * @param {number} durationSec - video duration (from meta endpoint)
   * @returns {Promise<void>} resolves when rewind finishes
   */
  function start(videoId, durationSec) {
    _log('start: videoId =', videoId, ', durationSec =', durationSec, ', _preloaded =', _preloaded);
    if (_running) abort();
    if (!durationSec || durationSec < MIN_DURATION_SEC) {
      _log('start: skipping — duration too short');
      return Promise.resolve();
    }

    _duration = durationSec;
    // Captured for _injectOverlays so it can mount the frameless facade
    // with the correct id (resume-mode onclick will play THIS video).
    _activeVideoId = videoId;
    // Reset autoplay-failed state for this run.
    _autoplayFailed = false;

    // Arm the autoplay-failed fallback timer. If the iframe doesn't reach
    // PLAYING within AUTOPLAY_TIMEOUT_MS — typical iOS Safari 18.7+
    // outcome on async paste flows — we kick off the rewind animation in
    // degraded mode (no frame seeks, just visual UI). Cleared in
    // _beginRewind, _finish, and abort().
    if (_autoplayTimeoutId) clearTimeout(_autoplayTimeoutId);
    _autoplayTimeoutId = setTimeout(() => {
      _autoplayTimeoutId = null;
      if (_running) return; // already started via PLAYING event
      _log('autoplay timeout fired — running degraded rewind animation');
      _autoplayFailed = true;
      _beginRewind();
    }, AUTOPLAY_TIMEOUT_MS);

    // Fast path: prepare() already loaded the iframe AND finished seek+pause.
    // Inject overlays and kick off rewind on the next frame so the overlay
    // DOM is mounted before _beginRewind triggers the video-frame fade-in.
    if (_preloaded && _preloadVideoId === videoId && _player) {
      _injectOverlays();
      _preloadVideoId = null;
      const p = new Promise(resolve => { _resolvePromise = resolve; });
      requestAnimationFrame(_beginRewind);
      return p;
    }

    // Mid-load path: prepare() was called but iframe hasn't finished yet.
    // Inject overlays now, flag start-was-requested, and let _onStateChange
    // call _beginRewind when the player finally enters PLAYING.
    if (_preloadVideoId === videoId && _player) {
      _injectOverlays();
      _preloadStartReq = true;
      _preloadVideoId = null;
      return new Promise(resolve => { _resolvePromise = resolve; });
    }

    // Cold path (no prepare): original flow.
    _autoStarted = false;
    _injectOverlays();
    if (!_spawnPlayer(videoId)) return Promise.resolve();
    return new Promise(resolve => { _resolvePromise = resolve; });
  }

  function abort() {
    // KEEP the frameless facade up — used to be torn down here, but that
    // exposed the bare YT iframe (default thumbnail + native red play
    // button) when the watchdog fired before the rewind ever started.
    // Leaving the white frameless button up means the user keeps a
    // consistent, controlled handoff: their tap routes through the
    // facade's onclick (dismissFacadeAndPlay) and plays normally.
    _activeVideoId = null;
    if (_autoplayTimeoutId) { clearTimeout(_autoplayTimeoutId); _autoplayTimeoutId = null; }
    _autoplayFailed = false;
    if (!_running && !_autoStarted) {
      _removeOverlays();
      if (_resolvePromise) { _resolvePromise(); _resolvePromise = null; }
      _preloaded = false;
      _preloadVideoId = null;
      _preloadStartReq = false;
      // Null _player so the ghost _onStateChange handler (still wired to
      // the YT iframe via the addEventListener call in _spawnPlayer)
      // can't fire _beginRewind when the user later taps to play —
      // _onStateChange's first line (`if (!_player) return`) becomes the
      // safe early-out. AppState.player still holds the same instance
      // for normal playback; only the rewind module disowns it.
      _player = null;
      return;
    }
    clearInterval(_frameTimerId);
    cancelAnimationFrame(_rafId);
    _running = false;
    _autoStarted = false;
    _preloaded = false;
    _preloadVideoId = null;
    _preloadStartReq = false;
    _removeOverlays();
    if (_resolvePromise) { _resolvePromise(); _resolvePromise = null; }
    _player = null;
  }

  function isRunning() {
    return _running;
  }

  return { prepare, start, abort, isRunning };
})();
