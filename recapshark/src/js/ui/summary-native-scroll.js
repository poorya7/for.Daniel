/**
 * SummaryNativeScroll — native-scroll mobile summary view.
 *
 * Replaces the clone-and-clip CylinderScroll for the summary panel on mobile.
 * The cylinder approach rendered the rich summary HTML once per slice
 * (~42 slices × ~30 elements per clone = ~1,260 promoted DOM nodes for a
 * single short summary) — the highest-cost / lowest-value structural
 * decision in the mobile cylinder system. Summary is read once, linearly,
 * with no video-time sync requirement, so native scroll is the right
 * primitive.
 *
 * Visual identity: a `mask-image` gradient on the scroll container fades
 * the top + bottom edges, preserving the "viewport window" feel of the
 * old cylinder. Zero extra DOM, hardware-accelerated, no overlay z-index
 * management, no pointer-events interception over native scroll.
 *
 * `content-visibility: auto` is applied to block-level summary elements
 * as a hedge against summary first-paint regression (cylinder painted
 * incrementally per slice; native scroll paints the full summary HTML in
 * one layout pass — content-visibility lets the browser skip rendering
 * off-screen blocks until they're near the viewport).
 *
 * Public API (factory — returns plain object, no `new`) — matches the
 * surface of cylinder-scroll.js so renderer.js integration is a one-line
 * swap. show()/hide() are essentially no-ops because the parent host
 * toggles its own display:none — kept on the API for symmetry with the
 * cylinder so callers don't have to special-case.
 *
 *   prepare(container, html)   — build DOM, mount HTML
 *   update(html)               — replace HTML, preserves scroll position
 *                                if it still resolves
 *   show(durationMs?)          — no-op; parent handles visibility
 *   hide(durationMs?)          — no-op
 *   destroy()                  — full teardown
 *   isReady()                  — true after prepare() completes
 */

/* Block-level selectors that get `content-visibility: auto` + intrinsic
   size hints inside the summary scroller. Covers every semantic block
   currently emitted by the summary renderer. The two orphan class
   selectors `.summary-block, .summary-context` were dropped 2026-05-08
   (Phase 3 B3) — they never matched anything in the rendered DOM (the
   real cards are `.summary-context-card` etc., already covered by the
   element selectors above). */
const _BLOCK_SELECTOR = 'p, h1, h2, h3, h4, h5, h6, ul, ol, blockquote, pre';

export function createSummaryNativeScroll(config = {}) {

  let _container = null;
  let _scroller  = null;
  let _content   = null;
  let _ready     = false;
  let _destroyed = false;

  function prepare(container, html) {
    if (_destroyed) return;
    _cleanup();
    _container = container;

    _scroller = document.createElement('div');
    _scroller.className = 'summary-native-scroll';

    _content = document.createElement('div');
    _content.className = 'summary-native-content';
    _content.innerHTML = html || '';

    _scroller.appendChild(_content);

    container.innerHTML = '';
    container.appendChild(_scroller);

    _applyContentVisibility();

    _ready = true;
  }

  function update(html) {
    if (_destroyed || !_content) return;

    /* Preserve scroll position across content swaps (e.g. language switch).
       If new content is shorter, scrollTop is automatically clamped by the
       browser. */
    const prevScroll = _scroller ? _scroller.scrollTop : 0;
    _content.innerHTML = html || '';
    _applyContentVisibility();
    if (_scroller) _scroller.scrollTop = prevScroll;
  }

  function show() {
    /* No-op. The parent host (summaryWheelHost) toggles its own display.
       Kept on the API so renderer.js's call sites don't special-case. */
  }

  function hide() {
    /* No-op — see show(). */
  }

  function destroy() {
    _destroyed = true;
    _cleanup();
    _container = null;
    _ready = false;
  }

  function isReady() { return _ready; }

  /* ── Internals ───────────────────────────────────────────────── */

  function _applyContentVisibility() {
    if (!_content) return;
    /* `content-visibility: auto` lets the browser skip rendering off-screen
       blocks. Combined with `contain-intrinsic-size`, the browser still
       reserves estimated layout space for skipped blocks so scrollbar
       length is approximately correct. The intrinsic-size value is a
       guess (24px is conservative — block elements are usually taller) and
       gets refined the first time the block enters the viewport.

       Inline-style assignment over a CSS rule because the rule would have
       to be ID-scoped to #summaryWheelHost-mobile-only and it's cleaner
       to keep this self-contained inside the adapter. */
    const blocks = _content.querySelectorAll(_BLOCK_SELECTOR);
    for (let i = 0; i < blocks.length; i++) {
      const el = blocks[i];
      el.style.contentVisibility    = 'auto';
      el.style.containIntrinsicSize = 'auto 24px';
    }
  }

  function _cleanup() {
    if (_container && _container.contains(_scroller)) {
      _container.removeChild(_scroller);
    }
    _scroller = _content = null;
  }

  return { prepare, update, show, hide, destroy, isReady };
}
