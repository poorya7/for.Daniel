/**
 * TranscriptBuffer — double-buffer manager for crossfade transitions.
 *
 * Two identical buffer divs sit inside #fullTranscriptPanel. Only one is
 * visible at a time. On language switch, new content renders into the
 * standby buffer, then both swap opacity simultaneously for a pixel-perfect
 * crossfade with zero layout shifts.
 */

const CROSSFADE_MS = 300;
const SAFETY_MS = CROSSFADE_MS + 100;

const _state = {
  transcript: { a: null, b: null, active: 'a', fading: false },
};

/**
 * Initialize buffers for a given mode. Call once per mode after DOM is ready.
 * @param {'transcript'} mode
 */
function init(mode) {
  const wrapper = document.getElementById('fullTranscriptPanel');
  if (!wrapper) return;
  _state[mode].a = document.getElementById('transcriptBufferA');
  _state[mode].b = document.getElementById('transcriptBufferB');
}

/**
 * Get the currently visible (active) buffer element.
 * @param {'transcript'} mode
 * @returns {HTMLElement|null}
 */
function getActive(mode) {
  const s = _state[mode];
  return s.active === 'a' ? s.a : s.b;
}

/**
 * Get the hidden (standby) buffer element.
 * @param {'transcript'} mode
 * @returns {HTMLElement|null}
 */
function getStandby(mode) {
  const s = _state[mode];
  return s.active === 'a' ? s.b : s.a;
}

/**
 * Whether a crossfade is currently in progress for this mode.
 * @param {'transcript'} mode
 * @returns {boolean}
 */
function isFading(mode) {
  return _state[mode].fading;
}

/**
 * Execute a crossfade: active fades out, standby fades in.
 * Caller must have already rendered content + restored scroll on the standby buffer.
 * @param {'transcript'} mode
 * @param {Function} [onComplete] - called after swap is done
 */
function crossfade(mode, onComplete) {
  const s = _state[mode];
  if (s.fading) return;
  s.fading = true;

  const active = getActive(mode);
  const standby = getStandby(mode);
  if (!active || !standby) { s.fading = false; return; }

  // Set transitions on both
  const t = 'opacity ' + CROSSFADE_MS + 'ms ease-in-out';
  active.style.transition = t;
  standby.style.transition = t;

  // Crossfade
  active.style.opacity = '0';
  standby.style.opacity = '1';

  let done = false;
  function finish() {
    if (done) return;
    done = true;

    // Clear transitions
    active.style.transition = '';
    standby.style.transition = '';

    // Swap roles
    active.classList.remove('active');
    active.classList.add('standby');
    active.style.pointerEvents = 'none';

    standby.classList.remove('standby');
    standby.classList.add('active');
    standby.style.pointerEvents = 'auto';

    s.active = s.active === 'a' ? 'b' : 'a';
    s.fading = false;

    if (onComplete) onComplete();
  }

  // Normal completion
  active.addEventListener('transitionend', finish, { once: true });

  // Safety net: force-complete if transitionend never fires
  setTimeout(() => {
    if (!done) {
      console.warn('[TranscriptBuffer] Safety timeout — forcing crossfade completion');
      finish();
    }
  }, SAFETY_MS);
}

/**
 * Instantly swap standby to active (no animation). Used for first render,
 * cached language switches, and non-crossfade scenarios.
 * @param {'transcript'} mode
 */
function snapSwap(mode) {
  const s = _state[mode];
  const active = getActive(mode);
  const standby = getStandby(mode);
  if (!active || !standby) return;

  active.classList.remove('active');
  active.classList.add('standby');
  active.style.opacity = '0';
  active.style.pointerEvents = 'none';
  active.style.transition = '';

  standby.classList.remove('standby');
  standby.classList.add('active');
  standby.style.opacity = '1';
  standby.style.pointerEvents = 'auto';
  standby.style.transition = '';

  s.active = s.active === 'a' ? 'b' : 'a';
}

export const TranscriptBuffer = {
  init,
  getActive,
  getStandby,
  isFading,
  crossfade,
  snapSwap,
};
