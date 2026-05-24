/**
 * title-fit.js — Responsive hero font sizing for title displays.
 *
 * Owns: the shrink-then-scale-up algorithm that fits the hero text within
 * the title host height, with script-aware tuning (tall scripts get more
 * vertical headroom; mobile scales up to compensate for the stroke buffer
 * + discrete 2px shrink steps that leave extra slack on Latin).
 *
 * Imports: Helpers (for the `isNarrowViewport()` mobile check — single
 * source of truth for the 900px breakpoint, see core/helpers.js). No
 * other state — caller (title-switcher core) still passes lockedHeight
 * as an explicit arg.
 */
import { Helpers } from '../core/helpers.js';

// Tall scripts (Arabic-script with descender chains, Devanagari/Bengali
// with ascender bars, CJK, Ethiopic, etc.) render with intrinsically
// taller line-boxes than Latin even at the same font-size + line-height.
// The Latin-tuned shrink loop would over-shrink them because scrollHeight
// reflects line-box height, not glyph height. Detected here so we can:
//   - allow more vertical headroom (the scrollHeight overshoot is mostly
//     font-metric padding, not visible content)
//   - use a more generous mobile scale-up (matches Latin's optical size)
const TALL_SCRIPT_CLASSES = [
  'lang-fa', 'lang-ar', 'lang-ur', 'lang-ku', 'lang-ps', 'lang-he',
  'lang-zh', 'lang-zh-tw', 'lang-ja', 'lang-ko',
  'lang-hi', 'lang-mr', 'lang-ne', 'lang-bn', 'lang-ta', 'lang-te',
  'lang-gu', 'lang-kn', 'lang-ml', 'lang-pa', 'lang-si',
  'lang-th', 'lang-lo', 'lang-km', 'lang-my',
  'lang-am', 'lang-hy', 'lang-ka',
];

/**
 * Shrink hero font(s) until panel content fits within target height.
 * In bilingual mode there are two heroes — shrink both together.
 *
 * @param {HTMLElement} panel        - .ts-display panel containing .ts1-hero(es)
 * @param {number}      lockedHeight - desktop's locked host height; pass 0 on mobile
 *                                     (we fall back to host.clientHeight)
 */
export function fitHero(panel, lockedHeight) {
  // Target height: on desktop we use the locked height (set once to
  // prevent layout shifts on language switch). On mobile we let the host
  // flex-grow to fill available space in .video-meta, so the target is
  // the host's current clientHeight.
  const host = document.getElementById('titleDisplayHost');
  const targetH = lockedHeight || (host ? host.clientHeight : 0);
  if (!targetH) return;
  const heroes = panel.querySelectorAll('.ts1-hero');
  if (!heroes.length) return;

  const isTallScript = TALL_SCRIPT_CLASSES.some(c => panel.classList.contains(c));
  const heightTolerance = isTallScript ? 1.18 : 1.0;
  const effectiveTargetH = targetH * heightTolerance;

  heroes.forEach(h => { h.style.removeProperty('font-size'); });
  let fontSize = parseFloat(getComputedStyle(heroes[0]).fontSize);
  const minSize = 16;
  // Horizontal overflow check:
  //   - Width buffer: 2.5px text-stroke renders outside the measured glyph
  //     box, AND on mobile there's a 48px right-edge gradient fade
  //     (.video-meta::after) that should not be encroached on. We measure
  //     against the host's right edge + fade allowance rather than the
  //     hero's direct parent, because the hero parent's clientWidth can be
  //     expanded by the gradient's overflow.
  //   - getBoundingClientRect() works for inline heroes too (scrollWidth
  //     returns 0 for display:inline elements).
  const strokeBuffer = 8;
  const fadeAllowance =
    Helpers.isNarrowViewport() ? 24 : 0;
  const hostRight = host
    ? host.getBoundingClientRect().right
    : Infinity;
  const heroOverflowsX = () =>
    Array.from(heroes).some((h) => {
      const r = h.getBoundingClientRect();
      return r.right > hostRight - strokeBuffer - fadeAllowance;
    });
  while (
    (panel.scrollHeight > effectiveTargetH || heroOverflowsX()) &&
    fontSize > minSize
  ) {
    fontSize -= 2;
    heroes.forEach(h => {
      h.style.setProperty('font-size', fontSize + 'px', 'important');
    });
  }

  // Mobile only: the strict fit is visually too conservative (stroke
  // buffer + discrete 2px steps leave extra slack, and long heroes that
  // wrap shrink to fit the longest word strictly). Scale up so the hero
  // fills more of the column; some bleed into the video's transparent
  // mask zone is intentional. Desktop uses lockedHeight and requires
  // strict fit to prevent layout jumps on language switch.
  //
  // Tall scripts get a bigger boost (1.30x vs 1.15x) to compensate for
  // their taller line-boxes — the un-boosted size would leave the hero
  // looking smaller than the body text, which is the exact bug we're
  // fixing.
  const isMobile = Helpers.isNarrowViewport();
  if (isMobile) {
    const scaleFactor = isTallScript ? 1.30 : 1.15;
    let finalSize = Math.round(fontSize * scaleFactor);
    heroes.forEach(h => {
      h.style.setProperty('font-size', finalSize + 'px', 'important');
    });
    while (panel.scrollHeight > effectiveTargetH && finalSize > minSize) {
      finalSize -= 2;
      heroes.forEach(h => {
        h.style.setProperty('font-size', finalSize + 'px', 'important');
      });
    }
  }
}
