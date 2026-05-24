/**
 * Test page for the picker-mode morph rewrite.
 *
 * Mounted via `?test=picker-morph` (see main.tsx). The goal is to lock
 * down a SINGLE Framer Motion sequence that drives:
 *   - the sheet shrinking from rest height to picker height
 *   - the picker cell fading + scaling in
 *   - the pills appearing
 *   - reverse on close
 *
 * No CSS transitions on the sheet height. No Web Animations API.
 * No `:has()` rules. Just one Framer timeline so all the moving
 * parts of the gesture stay synchronised — per the project rule
 * "one animation library per coordinated gesture" (see
 * `docs/_dev/05_agent-pitfalls.md`).
 *
 * Once the pattern feels right here, port it back to CaptureSheet +
 * EditMorphCell.
 */

import { motion } from "framer-motion";
import { useState } from "react";

import "./PickerMorphTestPage.css";

const REST_HEIGHT = 558;
const PICKER_HEIGHT = 180;
const MORPH_DURATION = 0.55;
const EASE_OUT = [0.4, 0, 0.2, 1] as const;

const FINANCING_OPTIONS = [
  { value: "cash", label: "Cash" },
  { value: "pre_approved", label: "Pre-app" },
  { value: "needs_lender", label: "Lender" },
  { value: "unknown", label: "Unknown" },
];

type Phase = "rest" | "picker";

export function PickerMorphTestPage(): React.ReactElement {
  const [phase, setPhase] = useState<Phase>("rest");
  const [picked, setPicked] = useState<string | null>(null);

  function openPicker(): void {
    setPhase("picker");
  }

  function closePicker(commitValue?: string): void {
    if (commitValue !== undefined) setPicked(commitValue);
    setPhase("rest");
  }

  return (
    <div className="picker-test-stage">
      <div
        className="picker-test-sheet"
        // Inline height as explicit pixel ALWAYS (even at rest), so
        // the CSS height transition has a numeric start value to
        // animate FROM. Going from `auto` (no inline style) to a
        // fixed pixel value doesn't trigger a CSS transition — the
        // browser snaps. That was the silent bug the entire time.
        style={{ height: phase === "picker" ? PICKER_HEIGHT : REST_HEIGHT }}
      >
        {/* Title — always shown, just relabels in picker mode. */}
        <motion.div
          className="picker-test-title"
          animate={{
            color: phase === "picker" ? "#22d3ee" : "rgba(255,255,255,0.6)",
          }}
          transition={{ duration: MORPH_DURATION, ease: EASE_OUT }}
        >
          {phase === "picker" ? "Financing" : "EXTRACTED"}
        </motion.div>

        {/* Rest-phase content — fades out when picker opens. */}
        <motion.div
          className="picker-test-rest-content"
          animate={{
            opacity: phase === "rest" ? 1 : 0,
            pointerEvents: phase === "rest" ? "auto" : "none",
          }}
          transition={{ duration: MORPH_DURATION, ease: EASE_OUT }}
        >
          <div className="picker-test-row">
            <span className="picker-test-row-label">Financing</span>
            <span className="picker-test-row-value">
              {picked
                ? (FINANCING_OPTIONS.find((o) => o.value === picked)?.label ?? picked)
                : "not mentioned"}
            </span>
            <button
              type="button"
              className="picker-test-row-edit"
              onClick={openPicker}
            >
              Edit
            </button>
          </div>
          <div className="picker-test-row picker-test-row--filler">
            <span className="picker-test-row-label">Other rows…</span>
          </div>
          <div className="picker-test-row picker-test-row--filler">
            <span className="picker-test-row-label">Other rows…</span>
          </div>
        </motion.div>

        {/* Picker pills — fade in when picker opens. Backdrop sibling
            catches outside taps for cancel-style dismissal. */}
        <motion.div
          className="picker-test-pills"
          animate={{
            opacity: phase === "picker" ? 1 : 0,
            pointerEvents: phase === "picker" ? "auto" : "none",
          }}
          transition={{
            duration: MORPH_DURATION,
            ease: EASE_OUT,
            // Pills land slightly after the sheet starts shrinking so
            // the user sees the panel reshape FIRST, then the pills
            // resolve. Symmetric on close — pills fade out before the
            // panel grows back.
            delay: phase === "picker" ? MORPH_DURATION * 0.4 : 0,
          }}
        >
          {FINANCING_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              className={`picker-test-pill${picked === option.value ? " picker-test-pill--active" : ""}`}
              onMouseDown={(e) => {
                e.preventDefault();
                closePicker(option.value);
              }}
            >
              {option.label}
            </button>
          ))}
        </motion.div>

        {/* Backdrop — only catches taps when picker is open. */}
        {phase === "picker" && (
          <div
            className="picker-test-backdrop"
            onMouseDown={(e) => {
              e.preventDefault();
              closePicker();
            }}
          />
        )}
      </div>

      <p className="picker-test-help">
        Tap "Edit" to open. Tap a pill to commit. Tap outside the pills (the
        empty area below) to cancel. Hard-reload to reset state.
      </p>
    </div>
  );
}
