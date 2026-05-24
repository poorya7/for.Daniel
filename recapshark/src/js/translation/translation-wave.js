/**
 * RecapShark Translation — Wave Crossfade Transition
 *
 * Each column's current content is snapshotted into a fixed-position overlay.
 * New content renders instantly beneath. The overlay fades out with a
 * staggered delay per column — the wave. No empty frames at any moment.
 * Transcript/subtitle panes are skipped (they have their own crossfade).
 *
 * Mobile: wave is bypassed (caller's `swapCallback` runs immediately).
 *
 * Public API: `waveTransition(swapCallback, goingRight)` only.
 * Module-private: cancel logic, column picker, wave id/timer state.
 *
 * Extracted from translation.js as part of Phase 4c #3 (SRP file split).
 * Behaviour byte-identical to the original: 192ms stagger × 800ms fade,
 * same overlay-styling rules (frozen direction/textAlign/fontFamily/
 * lineHeight + iframe/video visibility:hidden + body-attached fixed
 * overlays so panel re-renders can't clobber them mid-fade).
 */
import { Helpers } from '../core/helpers.js';

let _waveId = 0;
let _waveTimers = [];

const _WAVE_GAP = 192;    // ms stagger between columns (1.6x from sandbox testing)
const _WAVE_DUR = 800;    // ms fade duration per column

function _waveCancelPending() {
  _waveTimers.forEach(t => clearTimeout(t));
  _waveTimers = [];
  const dash = document.querySelector('.dashboard');
  if (dash) dash.querySelectorAll('.col-overlay').forEach(o => o.remove());
}

function _getWaveCols() {
  const dash = document.querySelector('.dashboard');
  if (!dash) return [];
  const left   = dash.querySelector('.left-panel');
  const center = dash.querySelector('.center-panel');
  const chat   = dash.querySelector('.chat-panel');

  // Skip center panel when transcript/subtitles tab is active — they have their
  // own double-buffer crossfade system that handles language switches.
  const summaryActive = document.getElementById('tab-summary')?.classList.contains('active');

  const cols = [];
  if (left)   cols.push(left);
  if (center && summaryActive) cols.push(center);
  if (chat)   cols.push(chat);
  return cols;
}

/**
 * Run the wave crossfade transition.
 * @param {Function} swapCallback — called under the overlays to render new content
 * @param {boolean}  goingRight   — true = L→M→R wave, false = R→M→L
 */
export function waveTransition(swapCallback, goingRight) {
  const isMobile = Helpers.isNarrowViewport();
  if (isMobile) { swapCallback(); return; }

  _waveCancelPending();
  const id = ++_waveId;
  const cols = _getWaveCols();
  if (!cols.length) { swapCallback(); return; }

  const gap = _WAVE_GAP;
  const delays = goingRight
    ? cols.map((_, i) => i * gap)
    : cols.map((_, i) => (cols.length - 1 - i) * gap);

  // 1. Snapshot current content as a FIXED-position overlay. Overlays are attached
  //    to <body>, NOT the panel — so panel re-renders from _scheduleRender can't
  //    remove or clobber them during the fade.
  const overlays = cols.map(col => {
    const srcEls = col.querySelectorAll('*');
    const frozen = [];
    for (let i = 0; i < srcEls.length; i++) {
      const s = getComputedStyle(srcEls[i]);
      frozen.push({
        direction: s.direction,
        textAlign: s.textAlign,
        fontFamily: s.fontFamily,
        lineHeight: s.lineHeight,
      });
    }

    const rect = col.getBoundingClientRect();
    const bg = getComputedStyle(col).backgroundColor;

    const overlay = document.createElement('div');
    overlay.className = 'col-overlay';
    overlay.style.cssText =
      'position:fixed;' +
      'top:' + rect.top + 'px;' +
      'left:' + rect.left + 'px;' +
      'width:' + rect.width + 'px;' +
      'height:' + rect.height + 'px;' +
      'overflow:hidden;' +
      'pointer-events:none;' +
      'z-index:9999;' +
      'background:' + bg + ';';
    overlay.innerHTML = col.innerHTML;

    // Freeze every property that body[data-translate-lang] rules can flip
    // during the fade. The overlay must be a pixel-perfect frozen snapshot of
    // the pre-swap state; any property that a body-level selector might change
    // mid-animation needs to be pinned inline here. Currently that's direction,
    // text-align, font-family, and line-height (see dashboard.css chat-bubble
    // rules scoped to body[data-translate-lang="..."]).
    const dstEls = overlay.querySelectorAll('*');
    const n = Math.min(dstEls.length, frozen.length);
    for (let i = 0; i < n; i++) {
      dstEls[i].style.direction = frozen[i].direction;
      dstEls[i].style.textAlign = frozen[i].textAlign;
      dstEls[i].style.fontFamily = frozen[i].fontFamily;
      dstEls[i].style.lineHeight = frozen[i].lineHeight;
    }

    overlay.querySelectorAll('iframe, video, .video-embed, .yt-facade').forEach(el => {
      el.style.visibility = 'hidden';
    });

    document.body.appendChild(overlay);
    return overlay;
  });

  // 2. Swap real content instantly (hidden under overlays)
  swapCallback();

  // 3. Fade each overlay out with staggered delay — the wave
  overlays.forEach((overlay, i) => {
    overlay.style.animation = `crossfadeOut ${_WAVE_DUR}ms ease ${delays[i]}ms both`;
  });

  // 4. Cleanup once all animations finish
  const totalMs = _WAVE_DUR + Math.max(...delays) + 50;
  const t = setTimeout(() => {
    if (_waveId !== id) return;
    overlays.forEach(o => o.remove());
  }, totalMs);
  _waveTimers.push(t);
}
