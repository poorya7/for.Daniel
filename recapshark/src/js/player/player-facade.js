// player-facade.js
//
// Owns: facade overlay (thumbnail + tap-to-play), embed-fallback panel,
//       click-blocker overlay, mech-controls disabled state when embed fails.
// Reads from AppState: videoData, player.
// Imports allowed: ../core/state.
// Coupling notes: receives `activatePlayer` callback via setup() — that's the
//                 only piece of player-lifecycle behavior it needs. No back-
//                 import of player.js core, no sibling imports.

import { AppState } from '../core/state.js';

let _activatePlayerFn = () => {};
/** After playVideo() from facade — YT sometimes omits PLAYING in onStateChange
 *  during rewind / cue edge cases; this mirrors the hooks in onPlayerStateChange. */
let _afterStartPlaybackFn = () => {};

function setMechControlsEnabled(enabled) {
  const playBtn = document.getElementById('mechPlayBtn');
  const navBtns = document.querySelectorAll('.mech-nav-btn');
  if (playBtn) playBtn.disabled = !enabled;
  navBtns.forEach(btn => { btn.disabled = !enabled; });
  const panel = document.getElementById('mechPanel');
  if (panel) panel.classList.toggle('embed-unavailable', !enabled);
}

function showEmbedFallback(videoId) {
  const id = videoId || AppState.videoData?.videoId;
  const fallback = document.getElementById('ytFallback');
  const link = document.getElementById('ytFallbackLink');
  const img = document.getElementById('ytFallbackImg');
  const playerEl = document.getElementById('ytPlayer');
  if (!id || !fallback || !link || !img) return;
  hideFacade();
  hideOverlay();
  link.href = `https://www.youtube.com/watch?v=${id}`;
  img.src = `https://img.youtube.com/vi/${id}/maxresdefault.jpg`;
  img.onerror = function () { img.src = `https://img.youtube.com/vi/${id}/hqdefault.jpg`; };
  if (playerEl) playerEl.style.display = 'none';
  fallback.style.display = 'flex';
  fallback.setAttribute('aria-hidden', 'false');
  setMechControlsEnabled(false);
  const scrubber = document.getElementById('videoScrubber');
  if (scrubber) scrubber.style.display = 'none';
}

function hideEmbedFallback() {
  const fallback = document.getElementById('ytFallback');
  const playerEl = document.getElementById('ytPlayer');
  if (fallback) { fallback.style.display = 'none'; fallback.setAttribute('aria-hidden', 'true'); }
  if (playerEl) playerEl.style.display = '';
  setMechControlsEnabled(true);
  const scrubber = document.getElementById('videoScrubber');
  if (scrubber) scrubber.style.display = '';
}

function showFacade(videoId, opts) {
  const facade = document.getElementById('ytFacade');
  const img = document.getElementById('ytFacadeImg');
  const overlay = document.getElementById('ytOverlay');
  if (!facade || !img || !videoId) return;
  if (overlay) { overlay.style.display = 'none'; overlay.setAttribute('aria-hidden', 'true'); }
  // Frameless mode: hide the thumbnail img (no curated YT poster), go
  // transparent (iframe shows through), swap the red YT play SVG for a
  // white outlined circle. Used during VHS rewind handoff so a single
  // consistent play button sits over the iframe from rewind start through
  // user click — no jarring swap to YT's red button at the end.
  const _frameless = !!(opts && opts.frameless);
  facade.classList.toggle('yt-facade--frameless', _frameless);
  if (!_frameless) {
    img.src = `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`;
    img.onerror = function () { img.src = `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`; };
  } else {
    img.removeAttribute('src');
    img.onerror = null;
  }
  facade.style.display = '';
  // resume mode: player is already loaded (post-rewind), so a tap should
  // just dismiss the facade and resume playback — no loadVideoById reload.
  if (opts && opts.resume) {
    facade.onclick = () => dismissFacadeAndPlay();
  } else {
    facade.onclick = () => _activatePlayerFn(videoId);
  }
}

/**
 * Dismiss a resume-mode facade and start playback on the existing player.
 * Called by the facade's onclick handler (mobile tap path) and by the
 * desktop auto-play path in app.js when the post-rewind staggered reveal
 * completes — both need to hide the thumbnail, restore the click-blocker
 * overlay, and play. Centralised so the two paths can't drift.
 */
function dismissFacadeAndPlay() {
  hideFacade();
  showOverlay();
  // Sweep any leftover .rewind-cover. In degraded mode (iOS autoplay
  // denied), rewind._finish() intentionally leaves the cover in place
  // so the thumbnail stays visible behind the frameless facade —
  // removing it earlier would expose the black autoplay-denied iframe.
  // The user tapping play is the signal that the iframe is about to
  // render real frames, so the cover can finally come down.
  document.querySelectorAll('.rewind-cover').forEach(el => el.remove());
  if (AppState.player) {
    try {
      AppState.player.unMute();
      AppState.player.setVolume(40);
      AppState.player.playVideo();
      _afterStartPlaybackFn();
    } catch (_) {}
  }
}

function hideFacade() {
  const facade = document.getElementById('ytFacade');
  if (facade) {
    facade.style.display = 'none';
    facade.onclick = null;
    facade.classList.remove('yt-facade--frameless');
  }
}

function showOverlay() {
  const overlay = document.getElementById('ytOverlay');
  if (overlay) { overlay.style.display = ''; overlay.setAttribute('aria-hidden', 'false'); }
}

function hideOverlay() {
  const overlay = document.getElementById('ytOverlay');
  if (overlay) { overlay.style.display = 'none'; overlay.setAttribute('aria-hidden', 'true'); }
}

export const PlayerFacade = {
  setup({ activatePlayer, afterStartPlayback } = {}) {
    _activatePlayerFn = activatePlayer;
    if (typeof afterStartPlayback === 'function') _afterStartPlaybackFn = afterStartPlayback;
  },
  showFacade,
  dismissFacadeAndPlay,
  hideFacade,
  showOverlay,
  hideOverlay,
  showEmbedFallback,
  hideEmbedFallback,
  setMechControlsEnabled,
};
