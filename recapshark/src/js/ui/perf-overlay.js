/**
 * Perf Overlay — `?perf=1` floating diagnostics panel.
 *
 * Tiny, dependency-free, self-mounting. Tracks FPS, frame times,
 * long tasks, and live `.k-ch.lit` count over a rolling 60s window.
 *
 * Per-second time-series samples capture displayMode + playerState so
 * the export shows when dual mode kicked in, when playback started, etc.
 * Plus a "📍 mark" button for the user to tag specific moments live.
 *
 * "📋 copy" dumps a JSON snapshot to clipboard for pasting into a
 * debugging chat without any dev tools.
 *
 * Usage: load any page with `?perf=1` in the URL.
 *
 * IMPORTANT: this module MUST be imported BEFORE app.js, because
 * app.js's auto-paste handler calls history.replaceState to strip
 * `?url=...` from location.search — and that wipes our `?perf=1` too.
 * See main.js import order.
 */

import { COPY_BUTTON_RESET_MS } from '../core/constants.js';
import { Helpers } from '../core/helpers.js';

const ENABLED = typeof location !== 'undefined' &&
                /[?&]perf=1\b/.test(location.search);

export function initPerfOverlay() {
  if (!ENABLED) return;
  if (typeof document === 'undefined') return;
  if (document.body) {
    _start();
  } else {
    document.addEventListener('DOMContentLoaded', _start);
  }
}

// ── Snapshot helpers ──────────────────────────────────────────

function _detectDisplayMode() {
  // Real signal for dual mode is `.bilingual-active` class on the transcript
  // panel. `.ts-sub` exists in single mode too (empty), so it's not a reliable
  // dual-mode flag.
  const dualPanel = document.querySelector(
    '#fullTranscriptPanel.bilingual-active, .bilingual-active'
  );
  if (dualPanel) return 'dual';
  try {
    const cur = window.AppState && window.AppState.currentLang;
    const vid = window.AppState && window.AppState.videoData && window.AppState.videoData.lang;
    if (cur && vid && cur !== vid) return 'translated';
  } catch (e) { Helpers.reportError(e, 'perf-overlay._detectDisplayMode'); }
  return 'original';
}

function _detectPlayerState() {
  try {
    const p = window.AppState && window.AppState.player;
    if (p && typeof p.getPlayerState === 'function') {
      const s = p.getPlayerState();
      switch (s) {
        case -1: return 'unstarted';
        case 0: return 'ended';
        case 1: return 'playing';
        case 2: return 'paused';
        case 3: return 'buffering';
        case 5: return 'cued';
        default: return 'unknown';
      }
    }
  } catch (e) { Helpers.reportError(e, 'perf-overlay._detectPlayerState'); }
  return 'unknown';
}

function _detectCurrentTime() {
  try {
    const p = window.AppState && window.AppState.player;
    if (p && typeof p.getCurrentTime === 'function') {
      const t = p.getCurrentTime();
      return typeof t === 'number' && isFinite(t) ? Number(t.toFixed(1)) : null;
    }
  } catch (e) { Helpers.reportError(e, 'perf-overlay._detectCurrentTime'); }
  return null;
}

// ── Main ──────────────────────────────────────────────────────

function _start() {
  if (document.getElementById('__perf_overlay')) return;

  const WINDOW_SEC = 60;
  const samples = [];
  const longTasks = [];
  const litCounts = [];
  const timeline = [];
  let startedAt = performance.now();
  let lastFrame = startedAt;
  let frameCount = 0;
  let lastDisplayMode = null;
  let lastPlayerState = null;
  let lastSampleTime = startedAt;
  let longTasksAtLastSample = 0;
  let frameSampleStartFrames = 0;

  const el = document.createElement('div');
  el.id = '__perf_overlay';
  el.style.cssText = [
    'position:fixed', 'top:8px', 'right:8px',
    'background:rgba(0,0,0,0.85)', 'color:#0f0',
    'font:11px/1.3 ui-monospace,Menlo,Consolas,monospace',
    'padding:8px 10px', 'border-radius:6px',
    'z-index:999999', 'min-width:170px',
    'pointer-events:auto', 'user-select:none',
    'box-shadow:0 2px 12px rgba(0,0,0,0.4)',
  ].join(';');
  // Karaoke wave-tuning sliders. All visual effects stay ON; the operator
  // tweaks the wave's shape parameters live to find the smoothest perceived
  // motion. CSS-var changes apply instantly because the wave loop reads them
  // every frame (radius is also cached → goes through _setRadiusOverride to
  // invalidate). Defaults match :root in dashboard.css.
  const KK_TUNERS = [
    { id: 'radius', label: 'radius (s)', min: 0.20, max: 2.00, step: 0.05, def: 0.45, prop: '--karaoke-radius-sec' },
    { id: 'scale',  label: 'scale',      min: 0.04, max: 0.40, step: 0.01, def: 0.20, prop: '--karaoke-scale'      },
  ];

  function _tunerRowHTML(t) {
    return (
      '<div style="display:flex;align-items:center;gap:4px;margin-top:3px">' +
        '<span style="color:#aaa;font-size:10px;min-width:64px">' + t.label + '</span>' +
        '<input class="__perf_tuner" data-kk="' + t.id + '" type="range" min="' + t.min + '" max="' + t.max + '" step="' + t.step + '" value="' + t.def + '" style="flex:1;accent-color:#0f0;height:14px">' +
        '<span class="__perf_tuner_val" data-kk-val="' + t.id + '" style="color:#0f0;font-size:10px;min-width:36px;text-align:right">' + t.def.toFixed(2) + '</span>' +
      '</div>'
    );
  }
  const tunersHTML = KK_TUNERS.map(_tunerRowHTML).join('');

  el.innerHTML = (
    '<div style="display:flex;justify-content:space-between;align-items:center;color:#fff;font-weight:bold;margin-bottom:6px">' +
      '<span>⚡ perf</span>' +
      '<span id="__perf_close" style="cursor:pointer;color:#888;padding:0 4px">×</span>' +
    '</div>' +
    '<div id="__perf_lines"></div>' +
    '<button id="__perf_mark" style="margin-top:8px;background:#222;color:#ff0;border:1px solid #ff0;border-radius:4px;padding:4px 6px;font:11px ui-monospace,Menlo,monospace;cursor:pointer;width:100%">📍 mark</button>' +
    '<button id="__perf_copy" style="margin-top:4px;background:#222;color:#0f0;border:1px solid #0f0;border-radius:4px;padding:4px 6px;font:11px ui-monospace,Menlo,monospace;cursor:pointer;width:100%">📋 copy</button>' +
    '<button id="__perf_reset" style="margin-top:4px;background:#222;color:#888;border:1px solid #444;border-radius:4px;padding:4px 6px;font:11px ui-monospace,Menlo,monospace;cursor:pointer;width:100%">⟲ reset window</button>' +
    '<button id="__perf_kk_toggle" style="margin-top:8px;background:#222;color:#888;border:1px solid #444;border-radius:4px;padding:3px 5px;font:10px ui-monospace,Menlo,monospace;cursor:pointer;width:100%;text-align:left">▸ wave tuning</button>' +
    '<div id="__perf_kk_panel" style="display:none;margin-top:4px">' +
      tunersHTML +
      '<button id="__perf_kk_clear" style="margin-top:6px;background:#222;color:#888;border:1px solid #444;border-radius:3px;padding:2px 4px;font:10px ui-monospace,Menlo,monospace;cursor:pointer;width:100%">⟲ defaults</button>' +
    '</div>'
  );
  document.body.appendChild(el);

  const linesEl = el.querySelector('#__perf_lines');

  function _trim(now) {
    const cutoff = now - WINDOW_SEC * 1000;
    while (samples.length && samples[0].t < cutoff) samples.shift();
    while (longTasks.length && longTasks[0].t < cutoff) longTasks.shift();
    while (litCounts.length && litCounts[0].t < cutoff) litCounts.shift();
    // timeline NOT trimmed — small (~1 entry/sec); we want full history.
  }

  function _tick(now) {
    const dt = now - lastFrame;
    lastFrame = now;
    samples.push({ t: now, frameMs: dt });
    frameCount++;
    _trim(now);
    requestAnimationFrame(_tick);
  }
  requestAnimationFrame(_tick);

  if (typeof PerformanceObserver !== 'undefined') {
    try {
      const po = new PerformanceObserver(function(list) {
        for (const entry of list.getEntries()) {
          longTasks.push({ t: performance.now(), duration: entry.duration });
        }
      });
      po.observe({ entryTypes: ['longtask'] });
    } catch (e) { Helpers.reportError(e, 'perf-overlay.PerformanceObserver'); }
  }

  setInterval(function() {
    try {
      const n = document.querySelectorAll('.k-ch.lit').length;
      litCounts.push({ t: performance.now(), count: n });
    } catch (e) { Helpers.reportError(e, 'perf-overlay.litCount'); }
  }, 1000);

  // Per-second time-series sampler + transition detector.
  setInterval(function() {
    const now = performance.now();
    const dt = now - lastSampleTime;
    lastSampleTime = now;

    const dispMode = _detectDisplayMode();
    const playerState = _detectPlayerState();
    const currentTime = _detectCurrentTime();
    const litNow = litCounts.length ? litCounts[litCounts.length - 1].count : 0;
    const longTasksThisSec = longTasks.length - longTasksAtLastSample;
    longTasksAtLastSample = longTasks.length;

    const framesSince = frameCount - frameSampleStartFrames;
    const fps1s = framesSince / (dt / 1000);
    frameSampleStartFrames = frameCount;

    const oneSecAgo = now - 1100;
    let frameMax1s = 0;
    for (let i = samples.length - 1; i >= 0; i--) {
      if (samples[i].t < oneSecAgo) break;
      if (samples[i].frameMs > frameMax1s) frameMax1s = samples[i].frameMs;
    }

    timeline.push({
      t: Number(((now - startedAt) / 1000).toFixed(1)),
      kind: 'sample',
      fps: Number(fps1s.toFixed(0)),
      frame_max_ms: Number(frameMax1s.toFixed(0)),
      lit: litNow,
      long_tasks: longTasksThisSec,
      mode: dispMode,
      player: playerState,
      vt: currentTime,
    });

    if (dispMode !== lastDisplayMode) {
      timeline.push({
        t: Number(((now - startedAt) / 1000).toFixed(1)),
        kind: 'transition',
        what: 'displayMode',
        from: lastDisplayMode,
        to: dispMode,
      });
      lastDisplayMode = dispMode;
    }
    if (playerState !== lastPlayerState) {
      timeline.push({
        t: Number(((now - startedAt) / 1000).toFixed(1)),
        kind: 'transition',
        what: 'playerState',
        from: lastPlayerState,
        to: playerState,
      });
      lastPlayerState = playerState;
    }
  }, 1000);

  function _percentile(sortedArr, p) {
    if (!sortedArr.length) return 0;
    const idx = Math.min(sortedArr.length - 1, Math.floor(sortedArr.length * p));
    return sortedArr[idx];
  }

  function _stats() {
    if (samples.length < 2) return null;
    const frameMs = samples.map(function(s) { return s.frameMs; })
                           .filter(function(m) { return m > 0 && m < 2000; });
    if (!frameMs.length) return null;
    const sorted = frameMs.slice().sort(function(a,b) { return a-b; });
    const sum = frameMs.reduce(function(a,b) { return a+b; }, 0);
    const avg = sum / frameMs.length;
    return {
      sample_count: frameMs.length,
      fps_avg: 1000 / avg,
      frame_avg_ms: avg,
      frame_p50_ms: _percentile(sorted, 0.5),
      frame_p95_ms: _percentile(sorted, 0.95),
      frame_p99_ms: _percentile(sorted, 0.99),
      frame_max_ms: sorted[sorted.length - 1],
      long_task_count: longTasks.length,
      long_task_total_ms: longTasks.reduce(function(a, t) { return a + t.duration; }, 0),
      lit_avg: litCounts.length
        ? litCounts.reduce(function(a, l) { return a + l.count; }, 0) / litCounts.length
        : 0,
      lit_max: litCounts.length
        ? litCounts.reduce(function(a, l) { return Math.max(a, l.count); }, 0)
        : 0,
    };
  }

  function _render() {
    const s = _stats();
    if (!s) {
      linesEl.textContent = 'collecting…';
      return;
    }
    const dur = ((performance.now() - startedAt) / 1000).toFixed(0);
    const fpsColor = s.fps_avg >= 50 ? '#0f0' : s.fps_avg >= 30 ? '#fc0' : '#f33';
    const mode = lastDisplayMode || _detectDisplayMode();
    const ps = lastPlayerState || _detectPlayerState();
    const markCnt = timeline.filter(function(e) { return e.kind === 'mark'; }).length;
    linesEl.innerHTML = (
      '<div>fps: <b style="color:' + fpsColor + '">' + s.fps_avg.toFixed(0) + '</b></div>' +
      '<div>frame avg: ' + s.frame_avg_ms.toFixed(1) + 'ms</div>' +
      '<div>frame p95: ' + s.frame_p95_ms.toFixed(1) + 'ms</div>' +
      '<div>frame max: ' + s.frame_max_ms.toFixed(0) + 'ms</div>' +
      '<div>long tasks: <b>' + s.long_task_count + '</b></div>' +
      '<div>blocked: ' + s.long_task_total_ms.toFixed(0) + 'ms</div>' +
      '<div>lit chars: avg ' + s.lit_avg.toFixed(0) + ' / max ' + s.lit_max + '</div>' +
      '<div style="margin-top:4px;color:#0cf">mode: ' + mode + '</div>' +
      '<div style="color:#0cf">player: ' + ps + '</div>' +
      '<div style="color:#888;margin-top:4px">window: ' + dur + 's · marks: ' + markCnt + '</div>'
    );
  }
  setInterval(_render, 333);

  function _flash(btn, msg) {
    const orig = btn.textContent;
    btn.textContent = msg;
    setTimeout(function() { btn.textContent = orig; }, COPY_BUTTON_RESET_MS);
  }

  let markCount = 0;
  el.querySelector('#__perf_mark').addEventListener('click', function() {
    markCount++;
    const now = performance.now();
    timeline.push({
      t: Number(((now - startedAt) / 1000).toFixed(1)),
      kind: 'mark',
      n: markCount,
      mode: _detectDisplayMode(),
      player: _detectPlayerState(),
      vt: _detectCurrentTime(),
    });
    _flash(el.querySelector('#__perf_mark'), '📍 mark #' + markCount);
  });

  el.querySelector('#__perf_copy').addEventListener('click', function() {
    const s = _stats() || {};
    const dump = {
      timestamp: new Date().toISOString(),
      url: location.href,
      ua: navigator.userAgent,
      viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio || 1 },
      window_seconds: Number(((performance.now() - startedAt) / 1000).toFixed(1)),
      frame_count_total: frameCount,
      stats: s,
      app: {
        useActiveLineAnchor: window.AppState && window.AppState.useActiveLineAnchor,
        karaokeEnabled: window.AppState && window.AppState.karaokeEnabled,
        currentLang: window.AppState && window.AppState.currentLang,
        videoLang: window.AppState && window.AppState.videoData && window.AppState.videoData.lang,
        sessionFatal: window.AppState && window.AppState.karaokeSessionFatal,
      },
      timeline: timeline,
      long_tasks: longTasks.map(function(lt) {
        return {
          t: Number(((lt.t - startedAt) / 1000).toFixed(1)),
          duration_ms: Math.round(lt.duration),
        };
      }),
      frame_ms_distribution: _bucket(samples.map(function(s) { return s.frameMs; })),
      lit_count_distribution: _bucket(litCounts.map(function(l) { return l.count; })),
    };
    const txt = JSON.stringify(dump, null, 2);
    const btn = el.querySelector('#__perf_copy');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).then(
        function() { _flash(btn, '✅ copied'); },
        function() { _fallbackCopy(txt, btn); }
      );
    } else {
      _fallbackCopy(txt, btn);
    }
  });

  el.querySelector('#__perf_reset').addEventListener('click', function() {
    samples.length = 0;
    longTasks.length = 0;
    litCounts.length = 0;
    timeline.length = 0;
    frameCount = 0;
    markCount = 0;
    startedAt = performance.now();
    lastSampleTime = startedAt;
    longTasksAtLastSample = 0;
    frameSampleStartFrames = 0;
    lastDisplayMode = null;
    lastPlayerState = null;
    _flash(el.querySelector('#__perf_reset'), '⟲ reset');
  });

  // ── Karaoke wave-tuning wiring ──────────────────────────────────────────
  // Sliders write to body's inline custom-property style. The wave loop reads
  // --karaoke-radius-sec via getComputedStyle (with a one-time cache → goes
  // through KaraokeManager._setRadiusOverride to invalidate). --karaoke-scale
  // is consumed directly by the .k-ch.lit CSS rule so updating it on body's
  // inline style applies live with no JS plumbing.
  function _applyTuner(id, value) {
    const tuner = KK_TUNERS.find(function (t) { return t.id === id; });
    if (!tuner) return;
    if (id === 'radius') {
      const km = window.KaraokeManager;
      if (km && typeof km._setRadiusOverride === 'function') {
        km._setRadiusOverride(value);
      } else {
        // Fallback: KaraokeManager not yet attached. Set the var anyway —
        // wave loop will pick it up after its next reset/invalidate cycle.
        document.body.style.setProperty(tuner.prop, String(value));
      }
    } else {
      document.body.style.setProperty(tuner.prop, String(value));
    }
  }

  // Wave-tuning section is collapsed by default; click the header to expand.
  el.querySelector('#__perf_kk_toggle').addEventListener('click', function () {
    const panel = el.querySelector('#__perf_kk_panel');
    const btn = el.querySelector('#__perf_kk_toggle');
    const open = panel.style.display === 'none';
    panel.style.display = open ? 'block' : 'none';
    btn.textContent = (open ? '▾' : '▸') + ' wave tuning';
  });

  el.querySelectorAll('.__perf_tuner').forEach(function (slider) {
    slider.addEventListener('input', function () {
      const id = slider.dataset.kk;
      const value = parseFloat(slider.value);
      _applyTuner(id, value);
      const valEl = el.querySelector('[data-kk-val="' + id + '"]');
      if (valEl) valEl.textContent = value.toFixed(2);
    });
  });

  el.querySelector('#__perf_kk_clear').addEventListener('click', function () {
    KK_TUNERS.forEach(function (t) {
      const slider = el.querySelector('.__perf_tuner[data-kk="' + t.id + '"]');
      if (slider) slider.value = String(t.def);
      const valEl = el.querySelector('[data-kk-val="' + t.id + '"]');
      if (valEl) valEl.textContent = t.def.toFixed(2);
      // Pass null for radius so KaraokeManager removes the body-style override
      // and the wave loop falls back to the dashboard.css :root default.
      if (t.id === 'radius') {
        const km = window.KaraokeManager;
        if (km && typeof km._setRadiusOverride === 'function') {
          km._setRadiusOverride(null);
        }
      } else {
        document.body.style.removeProperty(t.prop);
      }
    });
    _flash(el.querySelector('#__perf_kk_clear'), '⟲ defaults');
  });

  el.querySelector('#__perf_close').addEventListener('click', function() {
    el.style.display = 'none';
  });
}

function _bucket(arr) {
  if (!arr.length) return null;
  const sorted = arr.slice().sort(function(a,b) { return a-b; });
  return {
    count: arr.length,
    min: sorted[0],
    p50: sorted[Math.floor(sorted.length * 0.5)],
    p95: sorted[Math.floor(sorted.length * 0.95)],
    p99: sorted[Math.floor(sorted.length * 0.99)],
    max: sorted[sorted.length - 1],
    avg: Number((sorted.reduce(function(a,b) { return a+b; }, 0) / sorted.length).toFixed(2)),
  };
}

function _fallbackCopy(txt, btn) {
  try {
    const ta = document.createElement('textarea');
    ta.value = txt;
    ta.style.position = 'fixed'; ta.style.top = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    btn.textContent = ok ? '✅ copied' : '❌ failed';
  } catch (e) {
    btn.textContent = '❌ failed';
  }
  setTimeout(function() { btn.textContent = '📋 copy'; }, COPY_BUTTON_RESET_MS);
}

// Auto-init when imported. Idempotent — safe to import once from main.js.
initPerfOverlay();
