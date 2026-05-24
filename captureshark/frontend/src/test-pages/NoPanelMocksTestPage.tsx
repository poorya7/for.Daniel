/**
 * NoPanelMocksTestPage — 7 mock layouts exploring idea #2: kill the
 * sheet/panel entirely. Each card shows the two stress-test states
 * (edit textarea + shark loader) as the same canvas, with the water
 * permanently anchored at the bottom — it does NOT move when the
 * phase swaps. That's the product proof.
 *
 * Swipe left/right to flip between variants. Tap Extract to flip
 * to the loader state on the current variant. No transition animation
 * on the swap (per spec — just snap content so the layout can be
 * judged on its own).
 */

import { useEffect, useRef, useState, type ReactElement, type TouchEvent } from "react";

import { SharkLoader } from "@/components/SharkLoader/SharkLoader";

import "./NoPanelMocksTestPage.css";

interface Variant {
  id: string;
  label: string;
  loaderScale: number;
}

const VARIANTS: ReadonlyArray<Variant> = [
  { id: "anchor-bottom",   label: "Anchor bottom",   loaderScale: 2.2 },
  { id: "floating-center", label: "Floating center", loaderScale: 2.0 },
  { id: "hero-top",        label: "Hero top",        loaderScale: 2.2 },
  { id: "edge-textarea",   label: "Edge textarea",   loaderScale: 2.2 },
  { id: "wide-horizon",    label: "Wide horizon",    loaderScale: 2.8 },
  { id: "tight-top",       label: "Tight top",       loaderScale: 2.2 },
  { id: "glass-whisper",   label: "Glass whisper",   loaderScale: 2.2 },
];

type Phase = "edit" | "loader";

export function NoPanelMocksTestPage(): ReactElement {
  const [index, setIndex] = useState(0);
  const [phase, setPhase] = useState<Phase>("edit");
  const [text, setText] = useState("");
  const touchStart = useRef<{ x: number; y: number } | null>(null);

  const variant = VARIANTS[index];

  const goTo = (next: number): void => {
    if (next < 0 || next >= VARIANTS.length) return;
    setIndex(next);
    setPhase("edit");
    setText("");
  };

  const onTouchStart = (e: TouchEvent<HTMLDivElement>): void => {
    const t = e.touches[0];
    touchStart.current = { x: t.clientX, y: t.clientY };
  };

  const onTouchEnd = (e: TouchEvent<HTMLDivElement>): void => {
    if (touchStart.current === null) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - touchStart.current.x;
    const dy = t.clientY - touchStart.current.y;
    touchStart.current = null;
    if (Math.abs(dx) < 50 || Math.abs(dx) <= Math.abs(dy)) return;
    goTo(index + (dx < 0 ? 1 : -1));
  };

  // Desktop arrow-key navigation — mobile users use swipe; this is a
  // convenience for testing on a laptop without a touchscreen.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "ArrowRight") goTo(index + 1);
      else if (e.key === "ArrowLeft") goTo(index - 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div
      className={`np np--${variant.id} np--${phase}`}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
    >
      <header className="np__head">
        <span className="np__counter">{index + 1} / {VARIANTS.length}</span>
        <span className="np__name">{variant.label}</span>
      </header>

      <div className="np__water" aria-hidden="true">
        <SharkLoader
          key={variant.id}
          size="md"
          scale={variant.loaderScale}
          phase="play"
          waterAlreadyOn
        />
      </div>

      {phase === "edit" ? (
        <div className="np__edit">
          <textarea
            className="np__textarea"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Type a note about your lead…"
          />
          <button
            type="button"
            className="np__extract"
            onClick={() => setPhase("loader")}
          >
            Extract
          </button>
        </div>
      ) : (
        <div className="np__loader-text">
          <div className="np__eyebrow">EXTRACTING</div>
          <div className="np__subtext">Pulling out the details…</div>
        </div>
      )}

      {index === 0 && phase === "edit" ? (
        <div className="np__hint">← swipe →</div>
      ) : null}
    </div>
  );
}
