/**
 * ReviewPager — Embla-driven three-page card pager for the canvas
 * review surface.
 *
 * The chrome overlay (controlled disclosure + segmented dots + counter)
 * lives INSIDE the Embla viewport as an absolutely-positioned sibling of
 * the translated container. Because the chrome lives inside the
 * viewport, Embla's pointer handler owns every horizontal gesture —
 * cards AND chrome — and the slides follow the finger live no matter
 * where the touch starts. That was the round 2 fix for the
 * zone-difference bug discovered during the no-panel migration.
 *
 * Chrome height is measured by a ResizeObserver and written to the
 * --review-pager-chrome-height CSS var on the pager root. Slides
 * consume it via padding-bottom (see ReviewPager.css), so opening the
 * disclosure compresses the slide content cleanly instead of getting
 * covered by the overlay. After every observed resize, emblaApi.reInit()
 * recalculates slide geometry. That is the round 3 fix.
 *
 * Embla v8 is pinned — v9 RC has different method names.
 */
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
} from "react";

import useEmblaCarousel from "embla-carousel-react";

import "./ReviewPager.css";

interface ReviewPagerProps {
  pages: ReactNode[];
  originalNote: string;
}

export function ReviewPager({ pages, originalNote }: ReviewPagerProps): ReactElement {
  const [emblaRef, emblaApi] = useEmblaCarousel({
    align: "start",
    loop: false,
    containScroll: "trimSnaps",
    skipSnaps: false,
    dragFree: false,
  });
  const [activePage, setActivePage] = useState(0);
  const [isOriginalOpen, setIsOriginalOpen] = useState(false);
  // Reduced-motion is passed as Embla's `jump` argument on programmatic
  // navigation (dot click + keyboard) so those become instant cuts.
  // Drag is still natural — the user's finger is the input and
  // reduced-motion is about system-driven animations, not user-driven.
  // Initial value comes from matchMedia on first render so the very
  // first keyboard or dot interaction respects the setting even
  // before the listener-effect has run. Engineer 04 hygiene fix.
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const rootRef = useRef<HTMLDivElement | null>(null);
  const chromeRef = useRef<HTMLDivElement | null>(null);

  // Mirror Embla's selected snap into React state so the dots and
  // counter follow the active page. `select` fires on every commit,
  // including after a finger-driven drag releases.
  useEffect(() => {
    if (!emblaApi) return;
    function onSelect(): void {
      if (!emblaApi) return;
      setActivePage(emblaApi.selectedScrollSnap());
    }
    emblaApi.on("select", onSelect);
    onSelect();
    return () => {
      emblaApi.off("select", onSelect);
    };
  }, [emblaApi]);

  useEffect(() => {
    const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
    setPrefersReducedMotion(mql.matches);
    function onChange(event: MediaQueryListEvent): void {
      setPrefersReducedMotion(event.matches);
    }
    mql.addEventListener("change", onChange);
    return () => {
      mql.removeEventListener("change", onChange);
    };
  }, []);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (!emblaApi) return;
    if (event.key === "ArrowLeft") {
      emblaApi.scrollPrev(prefersReducedMotion);
      event.preventDefault();
    } else if (event.key === "ArrowRight") {
      emblaApi.scrollNext(prefersReducedMotion);
      event.preventDefault();
    }
  }

  // Chrome height reservation — slides reserve room at the bottom for
  // the absolutely-positioned chrome via a CSS var so the tan card
  // visually compresses when the disclosure opens. reInit recalculates
  // Embla's slide geometry whenever the chrome resizes.
  //
  // The ResizeObserver callback is collapsed via rAF so a burst of
  // observed entries (e.g. multiple intermediate heights during a
  // disclosure open / close, or browser-scheduled batch) only triggers
  // one reInit per frame. reInit is heavy. Engineer 04 hygiene fix.
  useEffect(() => {
    if (!emblaApi) return;
    const chromeNode = chromeRef.current;
    const rootNode = rootRef.current;
    if (!chromeNode || !rootNode) return;
    let rafId: number | null = null;
    const observer = new ResizeObserver(() => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        rafId = null;
        rootNode.style.setProperty(
          "--review-pager-chrome-height",
          `${String(chromeNode.offsetHeight)}px`,
        );
        emblaApi.reInit();
      });
    });
    observer.observe(chromeNode);
    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      observer.disconnect();
    };
  }, [emblaApi]);

  return (
    <div
      className="review-pager"
      ref={rootRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
    >
      <div className="review-pager__viewport" ref={emblaRef}>
        <div className="review-pager__container">
          {pages.map((page, idx) => (
            <article key={idx} className="review-pager__slide">
              {page}
            </article>
          ))}
        </div>

        {/* Chrome lives INSIDE the viewport so Embla's gesture handler
            sees touches on it — same engine as on the cards, no
            zone-difference. Absolute positioning keeps it visually
            anchored while the container above it translates. */}
        <div className="review-pager__chrome" ref={chromeRef}>
          {/* Photo rows have no single-source note (the image's text
              doesn't belong to any one row), so the toggle is hidden
              when there's nothing to reveal — keeps the row-edit
              surface honest. */}
          {originalNote !== "" ? (
            <>
              <button
                type="button"
                className="review-pager__original-toggle"
                aria-expanded={isOriginalOpen}
                onClick={() => {
                  setIsOriginalOpen((open) => !open);
                }}
              >
                <ChevronIcon />
                <span>
                  {isOriginalOpen ? "Hide" : "Show"} the original note
                </span>
              </button>

              {isOriginalOpen ? (
                <p className="review-pager__original-body">{originalNote}</p>
              ) : null}
            </>
          ) : null}

          <div
            className="review-pager__dots"
            role="tablist"
            aria-label="Review pages"
          >
            {pages.map((_, idx) => (
              <button
                key={idx}
                type="button"
                className={
                  "review-pager__dot" +
                  (activePage === idx ? " review-pager__dot--active" : "")
                }
                role="tab"
                aria-selected={activePage === idx}
                aria-label={`Page ${String(idx + 1)} of ${String(pages.length)}`}
                onClick={() => {
                  if (!emblaApi) return;
                  emblaApi.scrollTo(idx, prefersReducedMotion);
                }}
              />
            ))}
          </div>

          <div className="review-pager__counter" aria-hidden="true">
            {activePage + 1} of {pages.length}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Inline 14x14 chevron. Right-facing by default; CSS rotates it 90deg
 * via [aria-expanded="true"] when the disclosure opens.
 */
function ChevronIcon(): ReactElement {
  return (
    <svg
      className="review-pager__chevron"
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5 3l4 4-4 4" />
    </svg>
  );
}
