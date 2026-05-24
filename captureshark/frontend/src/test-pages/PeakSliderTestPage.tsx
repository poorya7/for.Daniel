/**
 * Test page — water + a single static shark fin + one slider that
 * moves the fin up and down. Used to dial in the peak Y values
 * visually before baking them back into the live loader.
 *
 * Mounted via `?test=peak-slider` or `/peak-slider` (see main.tsx).
 */

import { useState } from "react";

import { SharkFin } from "@/components/SharkFin/SharkFin";
import "@/components/SharkLoader/SharkLoader.css";

export function PeakSliderTestPage(): React.ReactElement {
  const [y, setY] = useState(5);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "var(--color-bg)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 32,
        color: "rgba(220, 234, 246, 0.85)",
        fontFamily: "inherit",
        touchAction: "pan-y",
      }}
    >
      <div className="shark-loader" style={{ width: 400, height: 200 }}>
        <div className="shark-loader__field">
          <div className="shark-loader__water">
            <span
              className="shark-loader__ripple shark-loader__ripple--steady"
              style={{ animationDelay: "0s", animationIterationCount: "infinite" }}
            />
            <span
              className="shark-loader__ripple shark-loader__ripple--steady"
              style={{ animationDelay: "-2.3s", animationIterationCount: "infinite" }}
            />
            <span
              className="shark-loader__ripple shark-loader__ripple--steady"
              style={{ animationDelay: "-4.5s", animationIterationCount: "infinite" }}
            />
          </div>
          <div className="shark-loader__fin-clip" aria-hidden="true">
            <div
              className="shark-loader__fin-wrap"
              style={{ transform: `translateY(${String(y)}px)` }}
            >
              <SharkFin className="shark-loader__fin" />
            </div>
          </div>
        </div>
      </div>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 8,
          width: 320,
        }}
      >
        <div style={{ fontSize: 13, opacity: 0.8 }}>Y = {y.toFixed(1)}</div>
        <input
          className="peak-slider-input"
          type="range"
          min={-10}
          max={50}
          step={0.5}
          value={y}
          onChange={(e) => { setY(Number.parseFloat(e.target.value)); }}
          onInput={(e) => { setY(Number.parseFloat((e.target as HTMLInputElement).value)); }}
        />
        <style>{`
          .peak-slider-input {
            width: 100%;
            height: 44px;
            -webkit-appearance: none;
            appearance: none;
            background: transparent;
            touch-action: pan-x;
          }
          .peak-slider-input::-webkit-slider-runnable-track {
            height: 6px;
            background: rgba(255, 255, 255, 0.18);
            border-radius: 3px;
          }
          .peak-slider-input::-moz-range-track {
            height: 6px;
            background: rgba(255, 255, 255, 0.18);
            border-radius: 3px;
          }
          .peak-slider-input::-webkit-slider-thumb {
            -webkit-appearance: none;
            appearance: none;
            width: 28px;
            height: 28px;
            border-radius: 50%;
            background: rgb(103, 232, 249);
            border: none;
            margin-top: -11px;
            cursor: pointer;
          }
          .peak-slider-input::-moz-range-thumb {
            width: 28px;
            height: 28px;
            border-radius: 50%;
            background: rgb(103, 232, 249);
            border: none;
            cursor: pointer;
          }
        `}</style>
      </div>
    </div>
  );
}
