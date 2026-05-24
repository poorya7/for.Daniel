/**
 * Mobile-debug error/event relay.
 *
 * Only activates when the page URL has `?debug=1`. When on, it pipes
 * `console.error`, `console.warn`, uncaught `window.onerror`,
 * `unhandledrejection`, click/touch events on the video frame, page
 * visibility transitions, and a multi-element DOM probe (#mechPlayBtn,
 * #ytPlayer, #ytFacade, #ytOverlay + YT API state + AppState.player
 * state) to the backend `/api/debug/clientlog` endpoint as batched POSTs.
 *
 * The on-call agent tails pm2 logs and reads the events live while the
 * user reproduces a bug on a device without DevTools access (iOS
 * Safari). Probes fire on lifecycle ticks AND on user actions (taps,
 * paste, tab-switch) so we catch the actual moment-of-bug regardless of
 * when the user gets to it.
 *
 * No-op without `?debug=1`. Best-effort throughout — never throw, never
 * recurse into itself, drop the buffer on a POST failure so a network
 * blip can't snowball into a memory leak.
 *
 * Lifecycle: self-mounting side-effect import from `main.js`. The
 * activation check + hooks all run inline at module load.
 */
import { API_TOKEN } from '../api/client.js';

const _DEBUG = (() => {
  try {
    if (typeof window === 'undefined') return false;
    const v = new URLSearchParams(window.location.search).get('debug');
    return v != null && v !== '' && v !== '0' && v.toLowerCase() !== 'false';
  } catch (_) {
    return false;
  }
})();

if (_DEBUG) {
  const _session = Math.random().toString(16).slice(2, 10);

  const _BUFFER_MAX = 50;
  const _buffer = [];
  const _FLUSH_AT_COUNT = 10;
  const _FLUSH_INTERVAL_MS = 1500;

  function _push(level, msg, extra) {
    try {
      if (_buffer.length >= _BUFFER_MAX) _buffer.shift();
      _buffer.push({
        ts: Date.now(),
        level: String(level || 'log'),
        msg: String(msg == null ? '' : msg),
        extra: extra == null ? null : String(extra),
      });
      if (_buffer.length >= _FLUSH_AT_COUNT) _flush();
    } catch (_) {}
  }

  let _flushing = false;
  async function _flush() {
    if (_flushing) return;
    if (_buffer.length === 0) return;
    _flushing = true;
    const batch = _buffer.splice(0, _buffer.length);
    try {
      await fetch('/api/debug/clientlog', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Token': API_TOKEN },
        body: JSON.stringify({ session: _session, events: batch }),
        keepalive: true,
      });
    } catch (_) {} finally {
      _flushing = false;
    }
  }

  setInterval(_flush, _FLUSH_INTERVAL_MS);
  window.addEventListener('pagehide', _flush);
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') _flush();
  });

  // ── Console hooks ──
  const _origErr = console.error.bind(console);
  const _origWarn = console.warn.bind(console);
  console.error = function (...args) {
    try { _push('error', args.map(_stringify).join(' ')); } catch (_) {}
    return _origErr(...args);
  };
  console.warn = function (...args) {
    try { _push('warn', args.map(_stringify).join(' ')); } catch (_) {}
    return _origWarn(...args);
  };

  // ── Uncaught errors + rejections ──
  window.addEventListener('error', (e) => {
    const where = e?.filename ? `${e.filename}:${e.lineno}:${e.colno}` : '';
    _push('uncaught', `${e?.message || 'unknown error'} ${where}`.trim(), e?.error?.stack);
  });
  window.addEventListener('unhandledrejection', (e) => {
    const reason = e?.reason;
    const msg = reason?.message || (typeof reason === 'string' ? reason : 'unhandled rejection');
    _push('unhandled', msg, reason?.stack);
  });

  // ── DOM + state probe ──
  // Captures everything that could be relevant to the "play button missing
  // / video frame black" bug class: facade visibility + thumbnail load
  // state, YT iframe presence + src, overlay state, mech button geometry,
  // YT API availability, our wrapped player's reported state, and the
  // browser's own visibility state. One probe = one log line.
  function _probe(reason) {
    try {
      const parts = [];
      const add = (k, v) => parts.push(`${k}=${v}`);

      const btn = document.getElementById('mechPlayBtn');
      if (btn) {
        const cs = window.getComputedStyle(btn);
        const r = btn.getBoundingClientRect();
        add(
          'mechBtn',
          `${cs.display}/${cs.visibility}/op=${cs.opacity}/pe=${cs.pointerEvents}/${Math.round(r.width)}x${Math.round(r.height)}`
        );
      } else add('mechBtn', 'NOT_IN_DOM');

      const player = document.getElementById('ytPlayer');
      if (player) {
        const cs = window.getComputedStyle(player);
        const r = player.getBoundingClientRect();
        const child = player.firstElementChild;
        const childTag = child?.tagName || 'EMPTY';
        const childSrc = child?.src ? child.src.slice(-60) : '';
        add(
          'ytPlayer',
          `${cs.display}/${Math.round(r.width)}x${Math.round(r.height)}/child=${childTag}${childSrc ? '@…' + childSrc : ''}`
        );
      } else add('ytPlayer', 'NOT_IN_DOM');

      const facade = document.getElementById('ytFacade');
      if (facade) {
        const cs = window.getComputedStyle(facade);
        const img = document.getElementById('ytFacadeImg');
        const imgPart = img
          ? `imgSrc=${(img.src || '(empty)').slice(-50)}/complete=${img.complete}/natW=${img.naturalWidth}`
          : 'no-img';
        add('facade', `${cs.display}/${imgPart}`);
      } else add('facade', 'NOT_IN_DOM');

      const overlay = document.getElementById('ytOverlay');
      if (overlay) {
        const cs = window.getComputedStyle(overlay);
        const r = overlay.getBoundingClientRect();
        add(
          'overlay',
          `${cs.display}/${Math.round(r.width)}x${Math.round(r.height)}/pe=${cs.pointerEvents}`
        );
      } else add('overlay', 'NOT_IN_DOM');

      // YT iframe API + our wrapped player.
      add('YT_API', typeof window.YT !== 'undefined' ? 'loaded' : 'NOT_LOADED');
      try {
        const p = window.AppState?.player;
        if (!p) {
          add('player', 'NONE');
        } else if (typeof p.getPlayerState !== 'function') {
          add('player', 'STUB');
        } else {
          // YT.PlayerState enum: -1=unstarted, 0=ended, 1=playing, 2=paused, 3=buffering, 5=cued
          add('player', `state=${p.getPlayerState()}`);
        }
      } catch (_) {
        add('player', 'threw');
      }

      add('vis', document.visibilityState);
      add('vid', window.AppState?.currentVideoId || window.AppState?.videoData?.videoId || '-');

      _push('probe', `[${reason}] ${parts.join(' | ')}`);
    } catch (err) {
      _push('probe', `[${reason}] probe-threw: ${err?.message}`);
    }
  }

  // Timed probes — cover the first 2 minutes of page lifetime.
  [0, 3000, 10000, 30000, 60000, 120000].forEach((t) =>
    setTimeout(() => _probe(`t=${t}ms`), t)
  );

  // Visibility transition probes — captures iOS Safari backgrounding the
  // tab and coming back, which is the suspected cause of "switched to
  // Claude, came back, nothing works."
  window.addEventListener('visibilitychange', () => {
    _probe(`vis=${document.visibilityState}`);
  });

  // Tap/click capture. The current bug class is "tapping on the video
  // frame does nothing" — so log every tap inside .video-frame (and the
  // mech panel) along with which element actually received it, in
  // capture phase so we see it even if something else stops propagation.
  ['click', 'touchend'].forEach((ev) => {
    window.addEventListener(
      ev,
      (e) => {
        try {
          const target = e.target;
          const closest = target?.closest?.(
            '#ytPlayer, #ytFacade, #ytOverlay, #mechPlayBtn, .video-frame, .video-embed, #mechPanel'
          );
          const targetDesc = target
            ? `${target.tagName}${target.id ? '#' + target.id : ''}${target.className ? '.' + String(target.className).split(/\s+/).slice(0, 2).join('.') : ''}`
            : 'null';
          _push(
            'event',
            `${ev} target=${targetDesc} closest=${closest?.id || closest?.className?.split?.(/\s+/)[0] || 'OUTSIDE'}`
          );
          // Follow-up probe after the click — captures whether play
          // actually started or the tap was a no-op.
          setTimeout(() => _probe(`after-${ev}`), 800);
        } catch (_) {}
      },
      true
    );
  });

  // Paste event — captures the moment the user pastes a URL, even if
  // the paste field is a custom element that doesn't bubble.
  window.addEventListener(
    'paste',
    (e) => {
      try {
        const text = e.clipboardData?.getData?.('text') || '';
        _push('event', `paste len=${text.length} startsWith=${text.slice(0, 40)}`);
        setTimeout(() => _probe('after-paste'), 1500);
        setTimeout(() => _probe('after-paste-5s'), 5000);
      } catch (_) {}
    },
    true
  );

  // Ad-hoc probe trigger from console or URL bar.
  window.__dbg = function (label, extra) {
    _push('probe', String(label), extra == null ? null : _stringify(extra));
  };

  _push(
    'log',
    'debug-relay armed',
    `ua=${navigator.userAgent} viewport=${window.innerWidth}x${window.innerHeight} dpr=${window.devicePixelRatio} url=${window.location.pathname}${window.location.search}`
  );
}

function _stringify(v) {
  if (v == null) return String(v);
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    return JSON.stringify(v);
  } catch (_) {
    return Object.prototype.toString.call(v);
  }
}

export {};
