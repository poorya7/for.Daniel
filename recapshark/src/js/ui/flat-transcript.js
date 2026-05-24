/**
 * FlatTranscript — hybrid-scroll transcript / subtitle list (mobile).
 *
 * A flat scrollable list of paragraph rows that mirror the desktop's
 * `.transcript-paragraph` rendering: timestamp chip + text + optional
 * bilingual subtext, with alt-row backgrounds and EntityHighlighter
 * applied per row.
 *
 * Architecture — two modes, swapped seamlessly:
 *
 *   "native" mode (default; user input wins here):
 *     - Scroller is `overflow-y: auto`. iOS runs it on the compositor
 *       thread (UIScrollView under the hood) → free 120Hz Pro Motion,
 *       native momentum, sub-pixel rendering, can't be janked by main
 *       thread. Touch drag and inertia live here.
 *
 *   "follow" mode (auto-follow during playback):
 *     - Scroller's scrollTop is parked at 0. The content is positioned
 *       via `transform: translate3d(0, -y, 0)` instead. We own a
 *       sub-pixel `state.y` and ease it via rAF. translate3d goes
 *       straight to the GPU compositor → genuinely sub-pixel motion, no
 *       integer quantization that programmatic scrollTop suffers from.
 *
 *   Mode swaps:
 *     - native → follow on first auto-follow target: snapshot scrollTop
 *       into `state.y`, zero scrollTop, apply matching translate3d.
 *       Visually identical at the moment of the swap.
 *     - follow → native on touchstart / idle stop: read `state.y`, set
 *       scrollTop to its rounded value, drop the transform. Worst case
 *       sub-pixel error of <0.5px — imperceptible.
 *
 * Why hybrid: programmatic `scrollTop` writes are integer-clamped on
 * iOS Safari. A 220ms exponential ease toward a slowly-advancing target
 * produces sub-pixel per-frame deltas that round to zero most frames,
 * then accumulate to a 1px jump — visible "tiny mini-jumps to catch up"
 * during auto-follow. transform: translate3d has no such limitation.
 *
 * SRP split (Phase 4c #4, 2026-05-08):
 *   flat-transcript.js          — this file: orchestrator + factory +
 *                                  public API + state + event handlers.
 *   flat-transcript-render.js   — DOM building (renderRows + fast-path
 *                                  updateItems + el helper).
 *   flat-transcript-scroll.js   — math + GPU motion (read/write/bounds,
 *                                  follow loop, mode swaps, anchor calc,
 *                                  KB1 smooth handoff).
 *
 * Public API (factory — returns plain object, no `new`):
 *   prepare(container, items, opts)  — build list, mount hidden
 *   show()                           — reveal, bind events
 *   hide()                           — hide, unbind
 *   destroy()                        — full teardown
 *   isReady()                        — true after prepare()
 *   scrollToTime(seconds, smooth)    — scroll target paragraph to center
 *   isUserInteracting()              — true while user is touching/coasting
 *   isTimeVisible(seconds)           — true if active row is in viewport
 *   clearInteraction()               — cancel cooldown so scrollToTime works now
 *   getAutoScroll() / setAutoScroll(val)
 */

import { renderRows, tryUpdateItemsFast } from './flat-transcript-render.js';
import { createScrollEngine } from './flat-transcript-scroll.js';

export function createFlatTranscript(config = {}) {

  /* ── Tunables ─────────────────────────────────────────────────── */

  const tunables = {
    /* Cooldown after user touch ends + scroll settles, before auto-scroll
       resumes. Matches the desktop autoscroll feel. */
    USER_COOLDOWN_MS: config.userCooldownMs ?? 1500,
    /* After a programmatic scrollTop write, ignore scroll events for this
       long so our own writes aren't mistaken for user scroll. 50ms is
       plenty to cover the event firing on the next frame. */
    PROGRAMMATIC_GRACE_MS: 50,
    /* After touchend, wait for scroll events to stop firing for this long
       before starting the user cooldown. iOS momentum continues firing
       scroll events after the finger lifts; we don't want to start the
       cooldown until the page is actually still. */
    SCROLL_SETTLE_MS: 100,
    /* Auto-follow easing — exponential time-constant glide toward target.
       Same shape as desktop _dsScrollTo; 220ms feels glassy at 60-120Hz. */
    FOLLOW_TAU_MS: 220,
    /* If no new follow target arrives for this long, assume the external
       sync loop has stopped (video paused) and exit the rAF loop. Must
       comfortably exceed the 100ms sync interval; 300ms gives plenty of
       headroom for jitter. */
    FOLLOW_IDLE_STOP_MS: 300,
    /* Where the active row's TOP sits in the viewport, as a fraction of
       scroller height. 0.4 = a bit above center. Anchoring the row top
       (not its center) keeps placement stable when row height varies —
       dual-language rows are ~2× taller than single-language rows, and a
       center-anchor would push tall rows up against the top edge. */
    ACTIVE_ROW_TOP_FRAC: 0.4,
    /* KB1 handoff (bilingual path): when karaoke first arrives on a row,
       linearly interpolate the anchor from row.offsetTop to the active
       word's top within the row over this window so the rAF target shifts
       gradually instead of snapping. Matched to FOLLOW_TAU_MS so the
       handoff completes within one natural ease-in. */
    KB1_HANDOFF_MS: 220,
    PREFERS_REDUCED_MOTION: typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches : false,
  };

  /* ── Shared state ─────────────────────────────────────────────────
   * Single mutable bag passed to engine/render helpers by reference.
   * Only this file mutates `shown`/`ready`/`userInteracting`/timer
   * fields; engine owns `mode`/`y`/`maxY`/`follow*`; render owns
   * `items`/`rows` writes. No cross-mutation footguns. */

  const state = {
    container: null,
    wrapper:   null,    /* .flat-transcript-outer wrapper */
    scroller:  null,    /* the native overflow-y:auto viewport */
    content:   null,    /* paragraph list parent (transform target in follow mode) */
    items:     [],      /* {display, time, text, subText} per paragraph or line */
    rows:      [],      /* DOM nodes, one per item, indexed in items order */

    ready: false,
    shown: false,
    userInteracting:     false,
    touchActive:         false,
    cooldownTimer:       null,
    scrollSettleTimer:   null,
    pendingScrollTime:   null,
    explicitScrollUntil: 0,
    programmaticUntil:   0,
    autoScroll:          true,

    /* Hybrid scroll mode. In 'native' mode, scroller.scrollTop is the
       source of truth and `y` is unused. In 'follow' mode, scrollTop is
       parked at 0 and `y` (sub-pixel) drives `content`'s transform. */
    mode: 'native',
    y:    0,
    maxY: 0,
    boundsDirtyTime: 0,

    followTarget:   null,
    followRaf:      null,
    followLast:     0,
    lastTargetTime: 0,

    /* Bilingual-path state (engine.activeAnchorContentY).
       karaokeArrivalAt: per-row KB1 state machine (PRE → handoff timestamp → DONE).
       rowLastActiveY / rowLastActiveAt: 200ms sticky cache that absorbs the
         row-mismatch flip-flop (active word landing in nextRow before chip-time
         row index advances). All WeakMaps so entries auto-GC on row teardown. */
    karaokeArrivalAt: new WeakMap(),
    rowLastActiveY:   new WeakMap(),
    rowLastActiveAt:  new WeakMap(),
  };

  const engine = createScrollEngine(state, tunables);

  let _onScroll, _onTouchStart, _onTouchEnd, _onWheel;

  /* ── Public: prepare ──────────────────────────────────────────── */

  function prepare(container, items, opts) {
    destroy();
    state.container = container;
    state.items = items || [];
    state.pendingScrollTime = null;
    state.explicitScrollUntil = 0;
    container.classList.add('flat-transcript');

    /* DOM: .flat-transcript-outer > .flat-transcript-scroller > .flat-transcript-content > .transcript-paragraph × N
     * The outer wrapper carries the mobile container styling (margin, border,
     * shadow); the inner scroller does the actual native scrolling. */
    state.wrapper = document.createElement('div');
    state.wrapper.className = 'flat-transcript-outer';
    state.scroller = document.createElement('div');
    state.scroller.className = 'flat-transcript-scroller';
    state.content = document.createElement('div');
    state.content.className = 'flat-transcript-content';
    state.wrapper.appendChild(state.scroller);
    state.scroller.appendChild(state.content);

    renderRows(state);

    state.wrapper.style.visibility = 'hidden';
    container.innerHTML = '';
    container.appendChild(state.wrapper);

    state.mode = 'native';
    state.y = 0;

    state.ready = true;
  }

  /* ── Public: show / hide ──────────────────────────────────────── */

  function show() {
    if (!state.wrapper) return;
    state.wrapper.style.visibility = '';
    if (!state.shown) {
      _bindEvents();
      state.shown = true;
    }
    /* Flush any scroll requested before the scroller was visible. */
    if (state.pendingScrollTime !== null) {
      const t = state.pendingScrollTime;
      state.pendingScrollTime = null;
      scrollToTime(t, 'instant');
    }
  }

  function hide() {
    if (!state.wrapper) return;
    state.wrapper.style.visibility = 'hidden';
    state.pendingScrollTime = null;
    engine.stopFollow();
    if (state.shown) {
      _unbindEvents();
      clearTimeout(state.cooldownTimer);
      clearTimeout(state.scrollSettleTimer);
      state.userInteracting = false;
      state.touchActive = false;
      state.shown = false;
    }
  }

  /* ── Public: destroy ──────────────────────────────────────────── */

  function destroy() {
    if (!state.container) return;
    _unbindEvents();
    engine.stopFollow();
    clearTimeout(state.cooldownTimer);
    clearTimeout(state.scrollSettleTimer);
    state.container.classList.remove('flat-transcript');
    state.container.innerHTML = '';
    state.container = state.wrapper = state.scroller = state.content = null;
    state.items = [];
    state.rows = [];
    state.ready = false;
    state.shown = false;
    state.userInteracting = false;
    state.touchActive = false;
    state.explicitScrollUntil = 0;
    state.programmaticUntil = 0;
    state.mode = 'native';
    state.y = 0;
    state.maxY = 0;
    state.karaokeArrivalAt = new WeakMap();
    state.rowLastActiveY   = new WeakMap();
    state.rowLastActiveAt  = new WeakMap();
  }

  function isReady() { return state.ready; }
  function isUserInteracting() { return state.userInteracting; }
  function getAutoScroll() { return state.autoScroll; }
  function setAutoScroll(val) { state.autoScroll = !!val; }

  /* ── Public: updateItems ────────────────────────────────────────
   *
   * Replace items WITHOUT rebuilding the DOM (when row count is the
   * same — typical lang-switch / bilingual-toggle case). Falls back to
   * a row-content rebuild if the new item count differs from the
   * existing rows. The wrapper / scroller / event bindings / floating
   * buttons all stay either way.
   */
  function updateItems(newItems) {
    if (!state.ready || !state.content) return;
    if (tryUpdateItemsFast(state, newItems)) return;
    /* Slow path: row count changed. Rebuild the row list but keep the
       wrapper/scroller and all event listeners — buttons and bindings
       outlive the row teardown. */
    renderRows(state);
  }

  function clearInteraction() {
    clearTimeout(state.cooldownTimer);
    clearTimeout(state.scrollSettleTimer);
    state.userInteracting = false;
  }

  /* ── Public: scrollToTime ──────────────────────────────────────
   *
   * Scrolls so the active row at `seconds` is centered. Linear time-
   * interpolation between the current and next paragraph means motion
   * is continuous, not snap-then-wait.
   *
   *   smooth === 'instant'  → instant jump, do NOT suppress auto-scroll
   *   smooth === false      → instant jump, suppress auto-scroll for 1s
   *   smooth === true       → continuous follow (rAF ease) when auto-scroll
   *                           is on; one-shot animated jump when off
   */
  function scrollToTime(seconds, smooth) {
    if (!state.ready || !state.shown || state.items.length === 0 || !state.scroller) {
      state.pendingScrollTime = seconds;
      return;
    }
    if (state.userInteracting) {
      state.pendingScrollTime = seconds;
      return;
    }
    state.pendingScrollTime = null;

    const idx = engine.findItemForTime(seconds);
    if (idx < 0) return;

    const desired = engine.computeTargetY(seconds, idx);
    if (desired == null) return;

    /* Reduced motion — no continuous follow, just snap on paragraph change. */
    if (tunables.PREFERS_REDUCED_MOTION && smooth === true) smooth = 'instant';

    if (smooth === 'instant') {
      engine.stopFollow();
      engine.writeY(desired);
      return;
    }
    if (!smooth) {
      engine.stopFollow();
      engine.writeY(desired);
      state.explicitScrollUntil = Date.now() + 1000;
      return;
    }
    if (state.explicitScrollUntil > Date.now()) return;

    /* Smooth: feed the follow loop. The loop eases toward the latest
     * target every frame in follow mode (sub-pixel transform). */
    engine.setFollowTarget(desired);
  }

  function isTimeVisible(seconds) {
    if (!state.ready || !state.shown || state.items.length === 0 || !state.scroller) return true;
    const idx = engine.findItemForTime(seconds);
    if (idx < 0) return true;
    const target = state.rows[idx];
    if (!target) return true;
    const viewTop = engine.readY();
    const viewBot = viewTop + state.scroller.clientHeight;
    const itemTop = target.offsetTop;
    const itemBot = itemTop + target.offsetHeight;
    /* visible if any portion of the row is in the viewport */
    return itemBot > viewTop && itemTop < viewBot;
  }

  /* ── User-interaction detection ─────────────────────────────────
   * Touch is the authoritative signal — touchstart always means user
   * intent, even before any scroll movement. After touchend, iOS
   * momentum keeps firing scroll events; we wait for those to stop
   * (no scroll for SCROLL_SETTLE_MS) before starting the cooldown.
   *
   * The scroll listener is the fallback for non-touch user input
   * (wheel, scrollbar, keyboard). It also catches touch-driven scroll
   * during inertia (after touchend, before settle).
   *
   * Programmatic scrollTop writes set a short grace window so they
   * aren't misclassified as user input. Touch events bypass that
   * (you can't scroll programmatically with a finger).
   *
   * In follow mode we proactively swap back to native mode on any sign
   * of user input, BEFORE anything else can happen — the user must be
   * scrolling the real native scroller, not fighting our transform. */

  function _bindEvents() {
    if (!state.scroller) return;

    _onScroll = () => {
      /* Our own scrollTop writes? Ignore. */
      if (performance.now() < state.programmaticUntil) return;

      /* Defensive: a real scroll event in follow mode would mean
         something other than touch (scrollbar, keyboard) drove native
         scroll. Hand control back to native scrolling so the user gets
         a normal experience. */
      if (state.mode === 'follow') engine.exitFollowMode();

      state.userInteracting = true;
      engine.stopFollow();
      clearTimeout(state.cooldownTimer);
      clearTimeout(state.scrollSettleTimer);
      state.scrollSettleTimer = setTimeout(_onScrollSettled, tunables.SCROLL_SETTLE_MS);
    };

    _onTouchStart = () => {
      state.touchActive = true;
      state.userInteracting = true;
      /* engine.stopFollow() exits follow mode (if active) BEFORE the
         user's scroll begins — native scrollTop is now correct so the
         touch drag picks up at the right visual position. */
      engine.stopFollow();
      clearTimeout(state.cooldownTimer);
      clearTimeout(state.scrollSettleTimer);
    };

    _onTouchEnd = () => {
      state.touchActive = false;
      /* Don't start cooldown yet — momentum scroll continues firing
         scroll events. The scroll handler keeps resetting the settle
         timer; once scroll stops, _onScrollSettled fires and starts the
         cooldown. If finger lifts with no momentum (no further scroll
         events), we still need to start cooldown — arm it via settle. */
      clearTimeout(state.scrollSettleTimer);
      state.scrollSettleTimer = setTimeout(_onScrollSettled, tunables.SCROLL_SETTLE_MS);
    };

    _onWheel = () => {
      state.userInteracting = true;
      engine.stopFollow();
    };

    /* All listeners passive — we don't preventDefault on anything.
       Native scroll runs on the compositor thread, untouched. */
    state.scroller.addEventListener('scroll',      _onScroll,      { passive: true });
    state.scroller.addEventListener('touchstart',  _onTouchStart,  { passive: true });
    state.scroller.addEventListener('touchend',    _onTouchEnd,    { passive: true });
    state.scroller.addEventListener('touchcancel', _onTouchEnd,    { passive: true });
    state.scroller.addEventListener('wheel',       _onWheel,       { passive: true });
  }

  function _onScrollSettled() {
    state.scrollSettleTimer = null;
    if (state.touchActive) return;  /* finger still down — wait */
    _startCooldown();
  }

  function _startCooldown() {
    clearTimeout(state.cooldownTimer);
    state.cooldownTimer = setTimeout(() => {
      state.userInteracting = false;
      if (state.pendingScrollTime !== null) {
        const t = state.pendingScrollTime;
        state.pendingScrollTime = null;
        scrollToTime(t, true);
      }
    }, tunables.USER_COOLDOWN_MS);
  }

  function _unbindEvents() {
    if (!state.scroller) return;
    state.scroller.removeEventListener('scroll',      _onScroll);
    state.scroller.removeEventListener('touchstart',  _onTouchStart);
    state.scroller.removeEventListener('touchend',    _onTouchEnd);
    state.scroller.removeEventListener('touchcancel', _onTouchEnd);
    state.scroller.removeEventListener('wheel',       _onWheel);
  }

  return {
    prepare, updateItems, show, hide, destroy, isReady, scrollToTime,
    isUserInteracting, isTimeVisible, clearInteraction,
    getAutoScroll, setAutoScroll,
  };
}

/* Default singleton for backwards-compatibility with imports that use it
 * directly. (Renderer.js used to reference this as a singleton.) */
export const FlatTranscript = createFlatTranscript();
