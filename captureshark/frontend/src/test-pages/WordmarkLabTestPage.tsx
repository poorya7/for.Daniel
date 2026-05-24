/**
 * Wordmark lab — six full home-page mockups, swipe horizontally to compare.
 *
 * Reached at `/wordmark-lab` or `?test=wordmark-lab`. Each slide is a
 * full-bleed replica of the HomeLab landing with one candidate font
 * applied to wordmark + tagline. Native scroll-snap drives the swipe;
 * an IntersectionObserver derives the current slide for the "n of 6"
 * indicator pinned at the top.
 *
 * No nav buttons — pure swipe, per owner's ask. Tap targets in each
 * slide are inert (look only).
 */

import { useEffect, useRef, useState } from "react";
import "./WordmarkLabTestPage.css";

interface FontOption {
  key: string;
  label: string;
  slideClass: string;
}

const FONT_OPTIONS: ReadonlyArray<FontOption> = [
  { key: "outfit", label: "Outfit (current)", slideClass: "wm-lab__slide--outfit" },
  { key: "fraunces", label: "Fraunces", slideClass: "wm-lab__slide--fraunces" },
  { key: "playfair", label: "Playfair Display", slideClass: "wm-lab__slide--playfair" },
  { key: "dm-serif", label: "DM Serif Display", slideClass: "wm-lab__slide--dm-serif" },
  { key: "instrument", label: "Instrument Serif", slideClass: "wm-lab__slide--instrument" },
  { key: "cormorant", label: "Cormorant Garamond", slideClass: "wm-lab__slide--cormorant" },
];

export function WordmarkLabTestPage(): React.ReactElement {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;

    // Pick the slide whose centre is closest to the track's centre.
    // IntersectionObserver alone reports "most visible," which can
    // bounce mid-swipe; a single scroll-handler with centre distance
    // gives a stable index.
    const update = (): void => {
      const slides = Array.from(
        track.querySelectorAll<HTMLDivElement>(".wm-lab__slide"),
      );
      if (slides.length === 0) return;
      const trackCentre = track.scrollLeft + track.clientWidth / 2;
      let bestIndex = 0;
      let bestDistance = Number.POSITIVE_INFINITY;
      slides.forEach((slide, index) => {
        const centre = slide.offsetLeft + slide.clientWidth / 2;
        const distance = Math.abs(centre - trackCentre);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestIndex = index;
        }
      });
      setActiveIndex(bestIndex);
    };

    update();
    track.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      track.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, []);

  const activeFont = FONT_OPTIONS[activeIndex] ?? FONT_OPTIONS[0];

  return (
    <main className="wm-lab">
      <div className="wm-lab__indicator" aria-live="polite">
        <span className="wm-lab__indicator-count">
          {activeIndex + 1} of {FONT_OPTIONS.length}
        </span>
        <span className="wm-lab__indicator-name">{activeFont.label}</span>
      </div>

      <div className="wm-lab__track" ref={trackRef}>
        {FONT_OPTIONS.map((option) => (
          <SlideContent key={option.key} slideClass={option.slideClass} />
        ))}
      </div>

      <div className="wm-lab__hint" aria-hidden="true">
        ← swipe →
      </div>
    </main>
  );
}

interface SlideContentProps {
  slideClass: string;
}

function SlideContent({ slideClass }: SlideContentProps): React.ReactElement {
  return (
    <section className={`wm-lab__slide ${slideClass}`}>
      <div className="wm-lab__cluster">
        <header className="wm-lab__hero">
          <h1 className="wm-lab__wordmark" aria-label="CaptureShark">
            <span className="wm-lab__wordmark-capture">Capture</span>
            <span className="wm-lab__wordmark-shark">Shark</span>
          </h1>
          <div
            className="wm-lab__mascot"
            role="img"
            aria-label="CaptureShark mascot"
          />
          <div className="wm-lab__tagline-group">
            <p className="wm-lab__tagline">
              Field lead{" "}
              <span className="wm-lab__arrow" aria-hidden="true">→</span>{" "}
              <span className="wm-lab__accent">Google Sheet</span> in seconds
            </p>
            <p className="wm-lab__subtagline">
              Photo, voice, or text. AI does the rest.
            </p>
          </div>
        </header>

        <nav className="wm-lab__modes" aria-label="Capture mode">
          <LabModeButton label="Photo" icon={<CameraIcon />} />
          <LabModeButton label="Voice" icon={<MicIcon />} />
          <LabModeButton label="Text" icon={<FileTextIcon />} />
        </nav>

        <a
          className="wm-lab__sheet-link"
          href="#"
          onClick={(e) => e.preventDefault()}
        >
          <span className="wm-lab__sheet-name">CaptureShark Dev Leads</span>
          <span className="wm-lab__sheet-arrow" aria-hidden="true">↗</span>
        </a>
      </div>
    </section>
  );
}

interface LabModeButtonProps {
  label: string;
  icon: React.ReactElement;
}

function LabModeButton({ label, icon }: LabModeButtonProps): React.ReactElement {
  return (
    <button
      type="button"
      className="wm-lab__mode"
      aria-label={label}
      onClick={(e) => e.preventDefault()}
    >
      <span className="wm-lab__mode-icon" aria-hidden="true">{icon}</span>
      <span className="wm-lab__mode-label">{label}</span>
    </button>
  );
}

function CameraIcon(): React.ReactElement {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none"
         stroke="currentColor" strokeWidth="1.75" strokeLinecap="round"
         strokeLinejoin="round" aria-hidden="true">
      <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" />
      <circle cx="12" cy="13" r="3" />
    </svg>
  );
}

function MicIcon(): React.ReactElement {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none"
         stroke="currentColor" strokeWidth="1.75" strokeLinecap="round"
         strokeLinejoin="round" aria-hidden="true">
      <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" y1="19" x2="12" y2="22" />
    </svg>
  );
}

function FileTextIcon(): React.ReactElement {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none"
         stroke="currentColor" strokeWidth="1.75" strokeLinecap="round"
         strokeLinejoin="round" aria-hidden="true">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
      <polyline points="10 9 9 9 8 9" />
    </svg>
  );
}
