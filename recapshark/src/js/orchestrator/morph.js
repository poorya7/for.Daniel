// orchestrator/morph.js
//
// Owns: the staggered home → results morph (exit choreography on home
//       elements + entry choreography on results panels) plus the
//       diagnostic instrumentation (?morphDebug=N URL flag / window
//       global) that scales animation durations for slow-motion
//       inspection.
// Reads from AppState: rewindMode (decides the rewind variant of the
//                      enter classes + B&W title prep).
// Writes to AppState: nothing (visual-only side effects on the DOM).
// Imports: core/state, core/helpers.
// Coupling notes: stateless w.r.t. processUrl — receives homeEl,
//   resultsEl, sharkBubble as explicit params (sharkBubble is needed
//   so the morph can restore its `_originalHTML` after homeView hides).

import { AppState } from '../core/state.js';
import { Helpers } from '../core/helpers.js';

// Morph logger — silent unless dbg.on. Takes the dbg state as 1st arg
// so it can sit at module scope without depending on an enclosing
// closure for state.
function _morphLog(dbg, label, sel, extra) {
  if (!dbg.on) return;
  const t = Math.round(performance.now() - dbg.t0);
  const tStr = String(t).padStart(5, ' ');
  const labelStr = String(label).padEnd(10, ' ');
  const selStr = String(sel || '').padEnd(22, ' ');
  let extraStr = '';
  if (extra) {
    extraStr = Object.entries(extra)
      .map(([k, v]) => `${k}=${v}`).join('  ');
  }
  // eslint-disable-next-line no-console
  console.log(`[MORPH t=${tStr}ms] ${labelStr} ${selStr} ${extraStr}`);
}

// ── Staggered morph: landing pieces exit + video page pieces enter ──
// Desktop: panels enter from left/right/up since layout is horizontal.
// Mobile: panels enter from top (nav, now-watching) or bottom (video, tabs)
//         since layout is vertical. Chat panel is skipped (display:none on mobile).
export function runStaggeredMorph(homeEl, resultsEl, sharkBubble) {
  const isRewind = AppState.rewindMode;
  const isMobile = Helpers.isNarrowViewport();

  // ── Diagnostic instrumentation (opt-in via ?morphDebug=N) ──
  // ?morphDebug=1 → enable timing logs + visual outlines, real-time speed.
  // ?morphDebug=N (N>1) → also slow-motion: setTimeout delays *N AND the
  // CSS animation durations *N, so the morph plays N× slower for visual
  // inspection. Default behavior is completely unchanged when the param
  // is absent. All injected DOM/CSS is removed at morph end.
  // Accept morphDebug from either the URL (?morphDebug=5) OR a global
  // (window.morphDebug = 5 in DevTools then trigger morph). The window
  // path lets you toggle without round-tripping through the URL bar.
  const _dbgUrl = new URLSearchParams(location.search).get('morphDebug');
  const _dbgWin = (typeof window !== 'undefined' && window.morphDebug != null)
    ? String(window.morphDebug) : null;
  const _dbgRaw = _dbgUrl != null ? _dbgUrl : _dbgWin;
  const _dbg = {
    on: _dbgRaw !== null && _dbgRaw !== '',
    mult: Math.max(1, Number(_dbgRaw) || 1),
    t0: performance.now(),
    styleEl: null,
  };
  // Build-detection ping — gated behind _dbg.on so production runs
  // are silent. Confirms (a) HMR picked up the latest module and
  // (b) the morphDebug flag was actually parsed from the URL/global.
  if (_dbg.on) {
    // eslint-disable-next-line no-console
    console.log('[MORPH] runStaggeredMorph called  dbgUrl=' + _dbgUrl +
      '  dbgWin=' + _dbgWin + '  on=' + _dbg.on + '  mult=' + _dbg.mult +
      '  href=' + location.href);
  }
  function _snap(el) {
    if (!el) return { z: '∅', op: '∅' };
    const cs = getComputedStyle(el);
    return { z: cs.zIndex, op: Number(cs.opacity).toFixed(2) };
  }
  // setTimeout wrapper that applies the slow-motion multiplier exactly
  // once per call. Used everywhere below so a single _dbg.mult uniformly
  // scales the schedule. When _dbg.on is false, mult is always 1 → no-op.
  function _t(fn, ms) { return setTimeout(fn, ms * _dbg.mult); }

  if (_dbg.on) {
    const styleEl = document.createElement('style');
    styleEl.id = 'morph-debug-styles';
    // Slow-motion: scale every morph-* CSS animation-duration by mult.
    // Numbers below mirror the existing keyframe durations in
    // home.css (.morph-exit-*) and dashboard.css (.morph-enter-*).
    const mult = _dbg.mult;
    styleEl.textContent = `
      .morph-exit-up,
      .morph-exit-down       { animation-duration: ${400 * mult}ms !important; }
      .morph-exit-scale,
      .morph-exit-fade       { animation-duration: ${350 * mult}ms !important; }
      .morph-enter-down,
      .morph-enter-down-dim  { animation-duration: ${400 * mult}ms !important; }
      .morph-enter-up,
      .morph-enter-up-dim,
      .morph-enter-left,
      .morph-enter-right,
      .morph-enter-right-dim { animation-duration: ${450 * mult}ms !important; }

      /* Visual debug outlines: each panel gets a unique colour so we can
         see at a glance which element is where during the morph and
         whether it's covered by the home-view (magenta). */
      .morph-overlay         { outline: 3px dashed #ff00ff !important; outline-offset: -3px; }
      body.morphing nav                { outline: 3px dashed #00e5ff !important; outline-offset: -3px; }
      body.morphing .now-watching-bar  { outline: 3px dashed #ffd600 !important; outline-offset: -3px; }
      body.morphing .left-panel        { outline: 3px dashed #00e676 !important; outline-offset: -3px; }
      body.morphing .center-panel      { outline: 3px dashed #ff9100 !important; outline-offset: -3px; }
      body.morphing .chat-panel        { outline: 3px dashed #ff4081 !important; outline-offset: -3px; }
    `;
    document.head.appendChild(styleEl);
    _dbg.styleEl = styleEl;
    _morphLog(_dbg, 'start', '', {
      isMobile, isRewind, mult: `${mult}x`,
      'home-view': JSON.stringify(_snap(homeEl)),
    });
  }

  // 1. Prepare resultsView: un-hide but keep enter targets invisible
  resultsEl.classList.remove('hidden');
  resultsEl.style.display = '';
  resultsEl.scrollTop = 0;

  const enterTargets = (isMobile ? [
    // Mobile enter delays start after the exit pass (~1210ms) completes —
    // the vertical layout means panels share the same screen area as the
    // exiting home content, so letting exits finish first gives a
    // cleaner reveal. ~50ms gap keeps the transition continuous.
    { sel: 'nav',               delay: 1260, cls: 'morph-enter-down' },
    { sel: '.now-watching-bar', delay: 1360, cls: 'morph-enter-down' },
    { sel: '.left-panel',       delay: 1460, cls: 'morph-enter-up' },
    { sel: '#mechPanel',        delay: 1560, cls: isRewind ? 'morph-enter-up-dim' : 'morph-enter-up' },
    // Mobile .center-panel uses non-dim; rewind-state uses blur via body.rewinding-mobile
    { sel: '.center-panel',     delay: 1660, cls: 'morph-enter-up' },
  ] : [
    // Desktop enter delays start after the exit pass (~1210ms) — same
    // contract as mobile. The home-view stays opaque (z-index 600 via
    // .morph-overlay) until display:none at maxExitEnd, so any enters
    // scheduled before that are hidden under the cover and read as a
    // "snap" the moment the cover lifts. 100ms gaps match mobile cadence
    // for a consistent feel across breakpoints.
    //
    // nav + .now-watching-bar slide as a STACK using morph-enter-down-stack
    // (translateY(-90px) — combined height of both panels). Same delay,
    // same fixed pixel distance, same duration → identical speed and
    // identical opacity at every moment. They arrive as one cohesive
    // dark block. Previously each used morph-enter-down-far (translateY
    // -100% of own height), so nav slid 52px and now-watching-bar slid
    // 38px in the same 400ms — different speeds, staggered start, the
    // user perceived this as "one is more transparent than the other."
    // .chat-panel keeps -right-far since it's a single solo panel.
    // .left-panel and .center-panel keep the short variants — full-
    // distance slides on those would overlap the other panels mid-flight.
    { sel: 'nav',                delay: 1260, cls: 'morph-enter-down-stack' },
    { sel: '.now-watching-bar',  delay: 1260, cls: 'morph-enter-down-stack' },
    { sel: '.left-panel',        delay: 1460, cls: 'morph-enter-left' },
    { sel: '.center-panel',      delay: 1560, cls: isRewind ? 'morph-enter-up-dim' : 'morph-enter-up' },
    // chat-panel is intentionally NOT dimmed in rewind mode — chat is
    // independent of the video being rewound (it's a Q&A surface, not a
    // video control), so dimming it created two visible problems:
    //   1) The slide ended at opacity 0.3 (dim) instead of fully opaque,
    //      so the panel visibly settled into place still semi-transparent.
    //   2) When the staggered rewind-reveal later fired (chat at index 1,
    //      so +2100ms after rewind end via _revealDelays in this file), it
    //      ramped chat from 0.3 → 1 — read as a "snap to opaque" on top
    //      of the already-completed slide.
    // Slide in fully opaque both modes; the rewind-reveal step on chat is
    // now a no-op (sets opacity:1 on an element already at 1).
    { sel: '.chat-panel',        delay: 1660, cls: 'morph-enter-right-far' },
  ]).map(t => ({ ...t, el: resultsEl.querySelector(t.sel) })).filter(t => t.el);

  // Set all enter targets invisible before showing
  enterTargets.forEach(t => { t.el.style.opacity = '0'; });

  // 2. Float homeView on top so both views overlap
  homeEl.classList.add('morph-overlay');
  document.body.classList.add('morphing');
  _morphLog(_dbg, 'overlay+', '.home-view', _snap(homeEl));

  // Mobile rewind: lock down video controls IMMEDIATELY (rewind starts at
  // 0ms on mobile, so controls become tappable as soon as panels enter at
  // ~1600ms). Adding the classes here closes the gap where transport
  // buttons and the YouTube iframe could be tapped while rewind is running.
  // Three scoped classes (title / menus / controls) instead of a single
  // blanket one so the post-rewind reveal can un-blur each zone in
  // sequence — see staggered reveal below.
  if (isRewind && isMobile) {
    document.body.classList.add('rewind-mobile-title');
    document.body.classList.add('rewind-mobile-menus');
    document.body.classList.add('rewind-mobile-controls');
    const _cp = document.querySelector('.center-panel');
    if (_cp) _cp.style.pointerEvents = 'none';
  }
  // Desktop: blur the chat panel during rewind. The class is removed
  // in the staggered reveal block below at +800ms (after rewind ends),
  // before the video controls (#mechPanel at +1200ms) come alive.
  if (isRewind && !isMobile) {
    document.body.classList.add('rewind-desktop-chat');
  }

  // 3. Apply B&W to title/chapters before morph so they're already dimmed when visible
  if (isRewind) {
    const _titleHost = document.getElementById('titleDisplayHost');
    const _chaptersBlock = document.querySelector('.chapters-block');
    [_titleHost, _chaptersBlock].filter(Boolean).forEach(el => {
      if (el === _chaptersBlock) el.style.position = 'relative';
      el.classList.add('title-bw');
    });

    // Hide the title TEXT (not the host) until AFTER the .left-panel
    // finishes sliding in + a 400ms beat. Fading the host itself made
    // its dark `--nav-bg` background go transparent, exposing the
    // light .video-meta / .left-panel surface underneath as a white
    // strip during the slide. Targeting only the active .ts-display
    // child keeps the host opaque (background intact) while the text
    // is what fades.
    //
    // The standby buffer (.ts-display-standby) is intentionally left
    // alone — it already sits at opacity:0 via title.css, and the
    // double-buffer swap logic in title-switcher.js owns its
    // visibility. Touching it here would make it visible after the
    // first language/title swap.
    //
    // Choreography (desktop rewind only):
    //   1) left-panel slides in empty       (1460 → 1910ms)
    //   2) 400ms beat with panel settled    (1910 → 2310ms)
    //   3) title text fades in              (2310 → 2610ms)
    //   4) rewind starts on completed frame (2700ms, see switchToResults)
    // Mobile is unchanged — its rewind starts at 0ms via _rewindDelay
    // and the staggered appearance doesn't fit that flow.
    const _titleActive = _titleHost && _titleHost.querySelector('.ts-display-active');
    if (!isMobile && _titleActive) {
      _titleActive.style.opacity = '0';
      _titleActive.style.transition = 'opacity 300ms ease-out';
      // 2310ms = .left-panel slide-end (1460 + 450 = 1910) + 400ms beat.
      // Routed through _t() so morphDebug slow-mo (?morphDebug=N)
      // scales this in lockstep with the slide — otherwise the fade
      // would fire mid-slide in slow-mo and break the staged reveal.
      _t(() => {
        _titleActive.style.opacity = '1';
        _titleActive.addEventListener('transitionend', () => {
          _titleActive.style.transition = '';
        }, { once: true });
        _morphLog(_dbg, 'title↑', '.ts-display-active', { 'opacity': '1' });
      }, 2310);
    }
  }

  // 4. Schedule exit animations on home elements.
  // Staggered delays give a clearly one-by-one cadence; each element's
  // own animation is snappy (~350-400ms in CSS) so the whole exit pass
  // finishes by ~1210ms while still reading as five distinct departures.
  // `dur` below must match the CSS animation duration for each class
  // (home.css morph-exit-*), since it drives maxExitEnd for display:none.
  const exitPlan = [
    { sel: '.features-row',     delay: 0,   cls: 'morph-exit-fade',  dur: 350 },
    { sel: '.home-stats',       delay: 180, cls: 'morph-exit-down',  dur: 400 },
    { sel: '.shark-bubble-wrap', delay: 460, cls: 'morph-exit-scale', dur: 350 },
    { sel: '.hero h1',          delay: 650, cls: 'morph-exit-up',    dur: 400 },
    { sel: '.home-topbar',      delay: 810, cls: 'morph-exit-up',    dur: 400 },
  ];

  exitPlan.forEach(({ sel, delay, cls }) => {
    const el = homeEl.querySelector(sel);
    if (el) _t(() => {
      el.classList.add(cls);
      _morphLog(_dbg, 'exit+', sel, { cls, ..._snap(el), 'home-z': _snap(homeEl).z });
      el.addEventListener('animationend', () => {
        _morphLog(_dbg, 'exit✓', sel, _snap(el));
      }, { once: true });
    }, delay);
  });

  // 5. Schedule enter animations on results elements
  enterTargets.forEach(({ el, sel, delay, cls }) => {
    _t(() => {
      el.style.opacity = '';
      el.classList.add(cls);
      // Snapshot at the moment the enter animation starts — and also
      // capture the home-view's computed z-index/opacity at this exact
      // frame, so we can prove (or disprove) that the cover is still
      // sitting on top while the panel tries to animate in.
      _morphLog(_dbg, 'enter+', sel, {
        cls, ..._snap(el),
        'home-z': _snap(homeEl).z, 'home-op': _snap(homeEl).op,
      });
      el.addEventListener('animationend', () => {
        _morphLog(_dbg, 'enter✓', sel, _snap(el));
        el.classList.remove(cls);
        // For dim variants, set resting dimmed state for rewind reveal to pick up
        if (cls.includes('-dim')) {
          el.style.opacity = '0.3';
          el.style.pointerEvents = 'none';
        }
      }, { once: true });
    }, delay);
  });

  // Dim .nw-left and #mechPanel children at the moment .now-watching-bar
  // begins its enter animation (desktop only). Must stay in lockstep with
  // the now-watching-bar enter delay above (currently 1360ms) so the
  // children appear pre-dimmed as the bar fades in. On mobile, #mechPanel
  // uses morph-enter-up-dim (handled in enterTargets), and .nw-left is
  // display:none on mobile.
  if (isRewind && !isMobile) {
    _t(() => {
      ['.nw-left', '#mechPanel'].forEach(s => {
        const child = document.querySelector(s);
        if (child) { child.style.opacity = '0.3'; child.style.pointerEvents = 'none'; }
      });
    }, 1360);
  }
  // (rewind-mobile-* classes are applied at morph start above, so video
  //  controls are disabled the entire time rewind is running.)

  // 6. Hide homeView after all exits complete + restore shark bubble
  //    (bubble text was kept as "Preparing…" during the morph for continuity)
  //    body.morphing stays on past this point — it's removed only after
  //    the last enter finishes (see step 7) so the `body.morphing
  //    #resultsView { background: var(--bg) }` rule can provide a
  //    contrasting backdrop for the dark nav/now-watching/chat to slide
  //    over. Without that, the body's --nav-bg (dark navy in brutalist)
  //    is identical to those elements' backgrounds and the slide reads
  //    as a "bg snap" — the dark rectangle appears the instant the cover
  //    lifts, then the content fades in on top.
  const maxExitEnd = Math.max(...exitPlan.map(e => e.delay + e.dur));
  _t(() => {
    homeEl.classList.remove('morph-overlay');
    homeEl.style.cssText = 'display:none';
    exitPlan.forEach(({ sel, cls }) => {
      const el = homeEl.querySelector(sel);
      if (el) el.classList.remove(cls);
    });
    // Restore bubble text now that homeView is hidden (user won't see the change)
    if (sharkBubble && sharkBubble._originalHTML) {
      sharkBubble.innerHTML = sharkBubble._originalHTML;
      sharkBubble._originalHTML = null;
    }
    _morphLog(_dbg, 'cover✗', '.home-view', { 'display': 'none' });
  }, maxExitEnd + 50);

  // 7. Remove body.morphing only after the final enter animation has
  //    finished painting. Until this runs, `body.morphing #resultsView
  //    { background: var(--bg) }` keeps a cream backdrop behind the
  //    sliding dark panels (nav / now-watching / chat) so their motion
  //    is visible instead of dark-on-dark. Animation durations: 400ms
  //    for -down-far / -down-stack (nav, now-watching — 400ms), 450ms
  //    for -left / -up / -right-far (left / center / chat). +100ms
  //    buffer absorbs the forwards fill-mode hand-off so the bg flip
  //    is never visible mid-slide.
  const _enterDurFor = cls => (cls && (cls.indexOf('-down-far') !== -1 || cls.indexOf('-down-stack') !== -1) ? 400 : 450);
  const maxEnterEnd = enterTargets.length
    ? Math.max(...enterTargets.map(t => t.delay + _enterDurFor(t.cls)))
    : maxExitEnd;
  _t(() => {
    document.body.classList.remove('morphing');
    _morphLog(_dbg, 'morph✗', 'body', { 'morphing': 'removed' });
    if (_dbg.styleEl && _dbg.styleEl.parentNode) {
      _dbg.styleEl.parentNode.removeChild(_dbg.styleEl);
      _morphLog(_dbg, 'cleanup', '', { 'styles': 'removed' });
    }
  }, maxEnterEnd + 100);
}
