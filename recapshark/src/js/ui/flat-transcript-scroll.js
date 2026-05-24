/**
 * FlatTranscript scroll engine — math + GPU motion.
 *
 * Created 2026-05-08 (Phase 4c #4) by extracting the read/write/follow/mode-swap
 * helpers out of `flat-transcript.js`. The orchestrator owns the `state`
 * object and creates ONE engine instance per FlatTranscript factory; the
 * engine's methods close over `state` + `tunables` so they can be passed
 * around without binding ceremony.
 *
 * Two scroll modes (see header comment in flat-transcript.js for full
 * rationale):
 *   "native"  — `scroller.scrollTop` is the source of truth; user input
 *               drives the scroller directly via the iOS UIScrollView.
 *   "follow"  — `scroller.scrollTop` is parked at 0; `_content` is moved
 *               via `transform: translate3d(0, -y, 0)` so we get sub-pixel
 *               motion the platform's scrollTop integer-clamping forbids.
 *
 * Auto-follow target (2026-05-09):
 *   - Single / paragraph rows: time-based lerp between consecutive
 *     row.offsetTop values → smooth constant velocity through the row.
 *   - Bilingual rows: KB1 active-line anchor (so primary stays in view
 *     instead of drifting toward the top edge). KB1 includes a 220ms
 *     handoff lerp on first appearance plus a 200ms sticky cache to
 *     absorb the row-mismatch flip-flop where active briefly lands in
 *     nextRow before chip-time advances.
 *
 * Mirrors player.js _activeAnchorContentY / _isBilingualRow.
 */

import { AppState } from '../core/state.js';

const KB1_STATE_PRE = 'pre';
const KB1_STATE_DONE = 'done';
const ACTIVE_STICKY_MS = 5000;

export function createScrollEngine(state, tunables) {

  /* ── Read/write current scroll position (mode-aware) ──────────────── */

  function readY() {
    if (state.mode === 'follow') return state.y;
    return state.scroller ? state.scroller.scrollTop : 0;
  }

  function writeY(y) {
    if (!state.scroller) return;
    refreshBoundsIfStale();
    y = Math.max(0, Math.min(state.maxY, y));
    state.y = y;
    if (state.mode === 'follow') {
      if (state.content) state.content.style.transform = `translate3d(0, ${-y}px, 0)`;
    } else {
      state.programmaticUntil = performance.now() + tunables.PROGRAMMATIC_GRACE_MS;
      state.scroller.scrollTop = y;
    }
  }

  /* ── Bounds (max scrollable Y) — refreshed lazily so we don't force
   *     layout every frame. Refresh on entering follow mode, on show,
   *     and when the cached value is older than 1s (typical row-render
   *     cycle). */

  function refreshBounds() {
    if (!state.scroller || !state.content) return;
    state.maxY = Math.max(0, state.content.offsetHeight - state.scroller.clientHeight);
  }

  function refreshBoundsIfStale() {
    const now = performance.now();
    if (state.maxY > 0 && now - state.boundsDirtyTime < 1000) return;
    refreshBounds();
    state.boundsDirtyTime = now;
  }

  /* ── Find the index of the item whose time is the latest <= seconds. */

  function findItemForTime(seconds) {
    const items = state.items;
    if (items.length === 0) return -1;
    let lo = 0, hi = items.length - 1, best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const t = items[mid].time;
      if (t <= seconds) { best = mid; lo = mid + 1; }
      else { hi = mid - 1; }
    }
    return best < 0 ? 0 : best;
  }


  /* ── Compute the target sub-pixel Y that anchors the active row top
   *     at ACTIVE_ROW_TOP_FRAC of the viewport. Linearly interpolates
   *     between current and next paragraph anchors so motion is
   *     continuous across paragraph boundaries. */

  /* Per-row anchor with KB1 handoff + 200ms sticky last-seen position.
   * Bilingual-only — single/paragraph rows use plain row.offsetTop in
   * computeTargetY for smooth constant velocity. Returns content-space Y.
   *
   * Why rect-difference against state.content, not raw offsetTop:
   * follow-mode positions content via transform: translate3d, so offsetTop
   * is pre-transform but BCR is post-transform. Both rects in the same
   * post-transform space → their difference is coordinate-safe content Y. */
  function activeAnchorContentY(row) {
    const rowRect = row.getBoundingClientRect();
    const rowTopContent = row.offsetTop;
    if (!AppState.useActiveLineAnchor) return rowTopContent;

    /* Scope to PRIMARY .ts-text — bilingual rows have karaoke spans in both
     * primary and .bilingual-sub. A row-level querySelector flip-flops
     * between them as different words light up, oscillating target between
     * top-of-row and bottom-of-row. Anchoring on primary keeps it stable. */
    const primary = row.querySelector('.ts-text');
    const active = primary && primary.querySelector('.karaoke-active-word');
    const map = state.karaokeArrivalAt;
    const lastY = state.rowLastActiveY;
    const lastAt = state.rowLastActiveAt;
    const now = performance.now();

    if (!active) {
      const cached = lastY.get(row);
      const at = lastAt.get(row) || 0;
      if (cached != null && now - at < ACTIVE_STICKY_MS) return cached;
      if (map.get(row) === undefined) map.set(row, KB1_STATE_PRE);
      return rowTopContent;
    }

    const activeRect = active.getBoundingClientRect();
    const activeContentY = rowTopContent + (activeRect.top - rowRect.top);
    lastY.set(row, activeContentY);
    lastAt.set(row, now);

    if (tunables.PREFERS_REDUCED_MOTION) return activeContentY;

    const s = map.get(row);
    if (s === KB1_STATE_PRE) {
      map.set(row, now);
      return rowTopContent;
    }
    if (typeof s === 'number') {
      const elapsed = now - s;
      if (elapsed < tunables.KB1_HANDOFF_MS) {
        const frac = elapsed / tunables.KB1_HANDOFF_MS;
        return rowTopContent + (activeContentY - rowTopContent) * frac;
      }
      map.set(row, KB1_STATE_DONE);
      return activeContentY;
    }
    if (s === undefined) map.set(row, KB1_STATE_DONE);
    return activeContentY;
  }

  function isBilingualRow(row) {
    return !!row.querySelector('.bilingual-sub:not(.bilingual-sub-hidden)');
  }

  function computeTargetY(seconds, idx) {
    const rows = state.rows;
    const items = state.items;
    const prevRow = rows[idx];
    if (!prevRow) return null;
    const scrollerH = state.scroller.clientHeight;
    const anchorOffset = scrollerH * tunables.ACTIVE_ROW_TOP_FRAC;

    const prevTime = items[idx].time;
    const nextItem = items[idx + 1];
    const nextRow  = rows[idx + 1];

    const useActive = isBilingualRow(prevRow) || (nextRow && isBilingualRow(nextRow));
    const prevTop = useActive ? activeAnchorContentY(prevRow) : prevRow.offsetTop;

    if (tunables.PREFERS_REDUCED_MOTION) {
      return Math.max(0, prevTop - anchorOffset);
    }

    let topY;
    if (!nextItem || !nextRow || nextItem.time <= prevTime) {
      topY = prevTop;
    } else {
      const nextTop = useActive ? activeAnchorContentY(nextRow) : nextRow.offsetTop;
      const span = nextItem.time - prevTime;
      const frac = Math.max(0, Math.min(1, (seconds - prevTime) / span));
      topY = prevTop + (nextTop - prevTop) * frac;
    }
    return Math.max(0, topY - anchorOffset);
  }

  /* ── Auto-follow loop ───────────────────────────────────────────────
   *     Runs continuously while the external sync loop is feeding fresh
   *     targets (every ~100ms during playback). Loop never exits on
   *     threshold convergence — exiting then idling for the rest of the
   *     100ms window is exactly what produces the "mini-jumps to catch
   *     up" symptom. Exit only when no new target has arrived for
   *     FOLLOW_IDLE_STOP_MS (i.e. video paused / sync stopped). */

  function setFollowTarget(target) {
    state.followTarget = target;
    state.lastTargetTime = performance.now();
    if (state.mode !== 'follow') enterFollowMode();
    if (state.followRaf == null) {
      state.followLast = state.lastTargetTime;
      state.followRaf = requestAnimationFrame(followTick);
    }
  }

  function stopFollow() {
    if (state.followRaf != null) {
      cancelAnimationFrame(state.followRaf);
      state.followRaf = null;
    }
    state.followTarget = null;
    if (state.mode === 'follow') exitFollowMode();
  }

  function followTick(now) {
    if (!state.scroller || state.followTarget == null) {
      state.followRaf = null;
      return;
    }
    if (state.userInteracting) {
      stopFollow();
      return;
    }
    if (now - state.lastTargetTime > tunables.FOLLOW_IDLE_STOP_MS) {
      writeY(state.followTarget);
      exitFollowMode();
      state.followRaf = null;
      state.followTarget = null;
      return;
    }

    const dt = Math.min(now - state.followLast, 50);
    state.followLast = now;
    const alpha = 1 - Math.exp(-dt / tunables.FOLLOW_TAU_MS);
    const cur = readY();
    const next = cur + (state.followTarget - cur) * alpha;
    writeY(next);

    state.followRaf = requestAnimationFrame(followTick);
  }

  /* ── Mode swaps — the whole point of having two modes is sub-pixel
   *     motion during auto-follow without sacrificing native scroll for
   *     user input. Swaps must be visually seamless: the on-screen
   *     position before and after the swap should be identical (modulo
   *     <0.5px rounding when landing on integer scrollTop). */

  function enterFollowMode() {
    if (state.mode === 'follow' || !state.scroller || !state.content) return;
    refreshBounds();
    state.y = state.scroller.scrollTop;
    state.content.style.willChange = 'transform';
    state.content.style.transform = `translate3d(0, ${-state.y}px, 0)`;
    state.programmaticUntil = performance.now() + tunables.PROGRAMMATIC_GRACE_MS;
    state.scroller.scrollTop = 0;
    state.mode = 'follow';
  }

  function exitFollowMode() {
    if (state.mode === 'native' || !state.scroller || !state.content) return;
    const finalY = state.y;
    state.content.style.transform = '';
    state.content.style.willChange = '';
    state.programmaticUntil = performance.now() + tunables.PROGRAMMATIC_GRACE_MS;
    state.scroller.scrollTop = Math.round(finalY);
    state.mode = 'native';
  }

  return {
    readY, writeY, refreshBounds, refreshBoundsIfStale,
    findItemForTime, computeTargetY,
    setFollowTarget, stopFollow, followTick,
    enterFollowMode, exitFollowMode,
  };
}
