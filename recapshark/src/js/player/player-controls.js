// player-controls.js
//
// Owns: mech panel UI — play/pause icon + status, prev/next nudge, scrubber
//       (drag + click), volume slider/icon, fullscreen button, time render,
//       module-load wiring of the mech buttons + scrubber + CC button.
// Reads from AppState: player, videoData, ccEnabled, _mechTimeInterval.
// Imports allowed: ../core/state, ../core/helpers, ./player-facade,
//                  ./player-subtitles.
// Coupling notes: receives `syncTranscriptHighlight`, `setSeeking`, and
//                 `activatePlayer` callbacks via setup() — those are the
//                 only references back into player.js core. No back-import
//                 from controls → core, so the import DAG stays acyclic.

import { AppState } from '../core/state.js';
import { Helpers } from '../core/helpers.js';
import { PlayerFacade } from './player-facade.js';
import { PlayerSubtitles } from './player-subtitles.js';

const MECH_PLAY_SVG  = '<path d="M8 5v14l11-7z"/>';
const MECH_PAUSE_SVG = '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>';

let _syncTranscriptHighlight = () => {};
let _setSeeking = () => {};
let _activatePlayerFn = () => {};

function updateMechState(playing) {
  const panel = document.getElementById('mechPanel');
  const btn   = document.getElementById('mechPlayBtn');
  const icon  = document.getElementById('mechPlayIcon');
  const dot   = document.getElementById('mechStatusDot');
  const label = document.getElementById('mechStatusLabel');
  if (panel) panel.classList.toggle('playing', playing);
  if (btn)   btn.classList.toggle('playing', playing);
  if (icon)  icon.innerHTML = playing ? MECH_PAUSE_SVG : MECH_PLAY_SVG;
  if (dot)   dot.classList.toggle('live', playing);
  if (label) label.textContent = playing ? 'LIVE' : 'IDLE';
}

function toggleMechPlay() {
  const panel = document.getElementById('mechPanel');
  if (panel && panel.classList.contains('embed-unavailable')) return;
  const vid = AppState.videoData?.videoId || AppState.currentVideoId;
  if (!AppState.player || typeof AppState.player.getPlayerState !== 'function') {
    if (vid) _activatePlayerFn(vid);
    return;
  }
  const state = AppState.player.getPlayerState();
  if (state === YT.PlayerState.PLAYING) {
    AppState.player.pauseVideo();
  } else {
    AppState.player.playVideo();
  }
}

function mechSeek(delta) {
  const panel = document.getElementById('mechPanel');
  if (panel && panel.classList.contains('embed-unavailable')) return;
  if (!AppState.player || typeof AppState.player.getCurrentTime !== 'function') return;
  _setSeeking(true);
  const current = AppState.player.getCurrentTime();
  const dur = AppState.player.getDuration ? AppState.player.getDuration() : 0;
  const next = Math.max(0, dur > 0 ? Math.min(dur, current + delta) : (current + delta));
  AppState.player.seekTo(next, true);
  renderMechTime(next, dur);
  // Keep transcript highlight in sync even when playback is paused.
  _syncTranscriptHighlight();
  setTimeout(_syncTranscriptHighlight, 80);
}

function renderMechTime(t, knownDuration) {
  const el = document.getElementById('mechTimeCurrent');
  if (el) el.textContent = Helpers.fmtTime(Math.floor(t));
  const totalEl = document.querySelector('.mech-time-total');
  const scrubberCurrent = document.getElementById('scrubberCurrent');
  const scrubberTotal = document.getElementById('scrubberTotal');
  const scrubberFill = document.getElementById('scrubberFill');
  const dur = knownDuration != null ? knownDuration : (AppState.player?.getDuration ? AppState.player.getDuration() : 0);
  if (totalEl && dur > 0) {
    totalEl.textContent = Helpers.fmtTime(Math.floor(dur));
    if (scrubberTotal) scrubberTotal.textContent = Helpers.fmtTime(Math.floor(dur));
    if (scrubberFill) scrubberFill.style.width = Math.min(100, (t / dur) * 100) + '%';
  }
  if (scrubberCurrent) scrubberCurrent.textContent = Helpers.fmtTime(Math.floor(t));
}

function startMechTimeSync() {
  if (AppState._mechTimeInterval) return;
  AppState._mechTimeInterval = setInterval(() => {
    if (!AppState.player || typeof AppState.player.getCurrentTime !== 'function') return;
    const t = AppState.player.getCurrentTime();
    renderMechTime(t);
  }, 500);
}

function stopMechTimeSync() {
  if (AppState._mechTimeInterval) { clearInterval(AppState._mechTimeInterval); AppState._mechTimeInterval = null; }
}

function initMechControls() {
  const playBtn = document.getElementById('mechPlayBtn');
  if (playBtn) {
    playBtn.removeAttribute('onclick');
    playBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      // If the post-rewind frameless facade is still up, tearing it down
      // here switches the user from a "facade-only tap target" state into
      // the normal "tap anywhere on .yt-overlay to toggle" state. Without
      // this, the facade stays up forever (mobile never auto-dismisses),
      // ytOverlay stays display:none (set by showFacade), and tapping
      // anywhere except this exact button does nothing.
      const facade = document.getElementById('ytFacade');
      if (facade && facade.style.display !== 'none') {
        PlayerFacade.dismissFacadeAndPlay();
        return;
      }
      toggleMechPlay();
    });
  }
  const ytOverlay = document.getElementById('ytOverlay');
  if (ytOverlay) ytOverlay.addEventListener('click', function () {
    // If the post-rewind frameless facade is still up, this is the user's
    // first interaction — route through dismissFacadeAndPlay so volume +
    // unmute + play happen as a unit. Subsequent taps (facade dismissed)
    // fall through to plain toggleMechPlay.
    const facade = document.getElementById('ytFacade');
    if (facade && facade.style.display !== 'none') {
      PlayerFacade.dismissFacadeAndPlay();
      return;
    }
    toggleMechPlay();
  });
  const videoMeta = document.querySelector('.video-meta');
  if (videoMeta) videoMeta.addEventListener('click', toggleMechPlay);
  const prevBtn = document.querySelector('.mech-nav-btn[title="Previous"]');
  if (prevBtn) prevBtn.addEventListener('click', function (e) { e.stopPropagation(); mechSeek(-10); });
  const nextBtn = document.querySelector('.mech-nav-btn[title="Next"]');
  if (nextBtn) nextBtn.addEventListener('click', function (e) { e.stopPropagation(); mechSeek(10); });
  const ccBtn = document.getElementById('mechCcBtn');
  if (ccBtn) {
    ccBtn.removeAttribute('onclick');
    ccBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      PlayerSubtitles.toggleCC();
      ccBtn.classList.toggle('on', AppState.ccEnabled);
    });
    if (AppState.ccEnabled) {
      ccBtn.classList.add('on');
      PlayerSubtitles.startSubtitleSync();
    }
  }
  initScrubber();
}

function initScrubber() {
  const track = document.getElementById('scrubberTrack');
  const fill = document.getElementById('scrubberFill');
  const currentEl = document.getElementById('scrubberCurrent');
  if (!track) return;
  function ratioFromEvent(e) {
    const rect = track.getBoundingClientRect();
    const x = e.clientX - rect.left;
    return Math.max(0, Math.min(1, x / rect.width));
  }
  function seekFromEvent(e) {
    if (!AppState.player || typeof AppState.player.seekTo !== 'function') return;
    const ratio = ratioFromEvent(e);
    const dur = AppState.player.getDuration ? AppState.player.getDuration() : 0;
    if (dur > 0) {
      AppState.player.seekTo(ratio * dur, true);
      if (fill) fill.style.width = ratio * 100 + '%';
      if (currentEl) currentEl.textContent = Helpers.fmtTime(Math.floor(ratio * dur));
    }
  }
  track.addEventListener('click', (e) => { e.stopPropagation(); seekFromEvent(e); });
  let dragging = false;
  track.addEventListener('mousedown', (e) => {
    e.preventDefault();
    dragging = true;
    seekFromEvent(e);
  });
  document.addEventListener('mousemove', (e) => {
    if (dragging) seekFromEvent(e);
  });
  document.addEventListener('mouseup', () => { dragging = false; });

  const ytBtn = document.getElementById('scrubberYtBtn');
  if (ytBtn) ytBtn.addEventListener('click', () => {
    const vid = AppState.videoData?.videoId || AppState.currentVideoId;
    if (vid) window.open(`https://www.youtube.com/watch?v=${vid}`, '_blank');
  });

  const volBtn = document.getElementById('scrubberVolBtn');
  const volTrack = document.getElementById('scrubberVolTrack');
  const volFill = document.getElementById('scrubberVolFill');
  const volIcon = document.getElementById('scrubberVolIcon');
  const VOL_HIGH = '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>';
  const VOL_LOW = '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>';
  const VOL_MUTE = '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/>';

  function updateVolIcon(vol) {
    if (!volIcon) return;
    if (vol === 0) volIcon.innerHTML = VOL_MUTE;
    else if (vol < 50) volIcon.innerHTML = VOL_LOW;
    else volIcon.innerHTML = VOL_HIGH;
  }

  function setVolume(ratio) {
    const vol = Math.round(Math.max(0, Math.min(1, ratio)) * 100);
    if (volFill) volFill.style.height = vol + '%';
    if (AppState.player && typeof AppState.player.setVolume === 'function') {
      AppState.player.setVolume(vol);
      if (vol === 0) AppState.player.mute(); else AppState.player.unMute();
    }
    updateVolIcon(vol);
  }

  if (volBtn) volBtn.addEventListener('click', () => {
    if (!AppState.player || typeof AppState.player.isMuted !== 'function') return;
    if (AppState.player.isMuted() || AppState.player.getVolume() === 0) {
      AppState.player.unMute();
      const vol = AppState.player.getVolume() || 100;
      if (volFill) volFill.style.height = vol + '%';
      updateVolIcon(vol);
    } else {
      AppState.player.mute();
      if (volFill) volFill.style.height = '0%';
      updateVolIcon(0);
    }
  });

  const volWrap = document.getElementById('scrubberVolWrap');
  const volSlider = document.getElementById('scrubberVolSlider');
  let volHideTimer = null;
  let volDragging = false;
  let lastPointerX = -1;
  let lastPointerY = -1;
  function volShow() { clearTimeout(volHideTimer); if (volWrap) volWrap.classList.add('vol-open'); }
  function pointerInsideVolZone(x, y) {
    if (!volBtn) return false;
    const btnRect = volBtn.getBoundingClientRect();
    // Virtual zone: button footprint + expanded area above for slider travel.
    const left = btnRect.left - 16;
    const right = btnRect.right + 16;
    const top = btnRect.top - 96;
    const bottom = btnRect.bottom + 10;
    return x >= left && x <= right && y >= top && y <= bottom;
  }
  function volHide() {
    clearTimeout(volHideTimer);
    volHideTimer = setTimeout(() => {
      if (!volWrap) return;
      if (volDragging) return;
      if (volWrap.matches(':hover')) return;
      volWrap.classList.remove('vol-open');
    }, 220);
  }
  if (volWrap) {
    volWrap.addEventListener('mouseenter', volShow);
    volWrap.addEventListener('mouseleave', () => { if (!volDragging) volHide(); });
  }
  if (volBtn) {
    volBtn.addEventListener('mouseenter', volShow);
  }
  document.addEventListener('mousemove', (e) => {
    lastPointerX = e.clientX;
    lastPointerY = e.clientY;
    if (!volWrap || volDragging) return;
    if (!volWrap.classList.contains('vol-open')) return;
    if (pointerInsideVolZone(e.clientX, e.clientY)) volShow();
    else volHide();
  });

  if (volTrack) {
    function volFromEvent(e) {
      const rect = volTrack.getBoundingClientRect();
      return Math.max(0, Math.min(1, (rect.bottom - e.clientY) / rect.height));
    }
    volTrack.addEventListener('click', (e) => { e.stopPropagation(); setVolume(volFromEvent(e)); });
    volTrack.addEventListener('mousedown', (e) => { e.preventDefault(); volDragging = true; volShow(); setVolume(volFromEvent(e)); });
    document.addEventListener('mousemove', (e) => { if (volDragging) setVolume(volFromEvent(e)); });
    document.addEventListener('mouseup', () => {
      if (!volDragging) return;
      volDragging = false;
      if (!pointerInsideVolZone(lastPointerX, lastPointerY)) volHide();
    });
  }

  const fsBtn = document.getElementById('scrubberFullscreenBtn');
  if (fsBtn) fsBtn.addEventListener('click', () => {
    const doc = document;
    const isFs = doc.fullscreenElement ?? doc.webkitFullscreenElement;
    if (isFs) {
      (doc.exitFullscreen || doc.webkitExitFullscreen || doc.webkitCancelFullScreen).call(doc);
      return;
    }
    const el = document.querySelector('.video-embed');
    if (!el) return;
    const req = el.requestFullscreen || el.webkitRequestFullscreen || el.webkitRequestFullScreen;
    if (req) req.call(el);
  });
}

export const PlayerControls = {
  setup({ syncTranscriptHighlight, setSeeking, activatePlayer }) {
    _syncTranscriptHighlight = syncTranscriptHighlight;
    _setSeeking = setSeeking;
    _activatePlayerFn = activatePlayer;
    initMechControls();
  },
  updateMechState,
  startMechTimeSync,
  stopMechTimeSync,
  renderMechTime,
};
