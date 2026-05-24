/**
 * Test page — drops the <SharkLoader /> into a faithful mirror of the
 * extracting-panel structure (capture-sheet card + eyebrow above) so
 * the loader's visual can be reviewed against the production surface.
 *
 * Mounted via `?test=extracting-shell` or `/extracting-shell` (see
 * main.tsx).
 *
 * Controls:
 *   • Trigger exit          — flip the loader into its exit sequence.
 *   • Replay                — remount the loader to start a fresh cycle.
 *   • Last-ripple fade (ms) — tune ONLY the duration of the WAAPI
 *                             fade overlay applied to the final
 *                             surviving ripple of the drain. Other
 *                             ripples keep their natural 6s life;
 *                             the grow rate of the last ripple is
 *                             also unchanged — only its alpha exits
 *                             faster.
 */

import { useEffect, useState, type CSSProperties } from "react";

import { SharkLoader } from "@/components/SharkLoader/SharkLoader";

/* Pulls the loader UP from where the natural flex layout puts it, so
 * the visible water-line sits closer to the eyebrow (matches the
 * reference screenshot where the fin emerges right under EXTRACTING).
 * The loader has ~75px of waterline-from-top inside its own frame,
 * which is why the eyebrow→waterline gap looks too tall without this
 * pull-up. */
const LOADER_PULL_UP = -48;

export function ExtractingShellTestPage(): React.ReactElement {
  /* loaderKey: remounts the loader fresh when we want to replay.
     phase:     "play" → autonomous cycle; "exit" → run the exit
                sequence using the component's locked defaults.
     exited:    latched true when the loader fires onExited, so we can
                show the post-exit state until the user taps replay. */
  const [loaderKey, setLoaderKey] = useState(0);
  const [phase, setPhase] = useState<"play" | "exit">("play");
  const [exited, setExited] = useState(false);
  const [lastRippleFadeMs, setLastRippleFadeMs] = useState(500);

  useEffect(() => {
    setExited(false);
    setPhase("play");
  }, [loaderKey]);

  return (
    <div style={PAGE_STYLE}>
      <div style={SHEET_STYLE}>
        <div style={SHEEN_STYLE} aria-hidden="true" />
        <div style={PHASE_STYLE}>
          <span style={EYEBROW_STYLE}>EXTRACTING</span>
          {!exited && (
            <div style={{ marginTop: LOADER_PULL_UP }}>
              <SharkLoader
                key={loaderKey}
                size="sm"
                phase={phase}
                lastRippleFadeMs={lastRippleFadeMs}
                onExited={() => setExited(true)}
              />
            </div>
          )}
          {exited && (
            <p style={EXITED_STYLE}>
              Exit complete — tap <strong>Replay</strong> to remount.
            </p>
          )}
        </div>
      </div>

      <div style={CONTROL_RAIL_STYLE}>
        <div style={BUTTON_ROW_STYLE}>
          <button
            type="button"
            style={PRIMARY_BUTTON_STYLE}
            disabled={phase === "exit" || exited}
            onClick={() => setPhase("exit")}
          >
            Trigger exit
          </button>
          <button
            type="button"
            style={SECONDARY_BUTTON_STYLE}
            onClick={() => setLoaderKey((k) => k + 1)}
          >
            Replay from start
          </button>
        </div>

        <div style={SLIDER_ROW_STYLE}>
          <div style={SLIDER_LABEL_ROW_STYLE}>
            <span style={SLIDER_LABEL_STYLE}>Last-ripple fade</span>
            <span style={SLIDER_VALUE_STYLE}>{lastRippleFadeMs} ms</span>
          </div>
          <input
            type="range"
            min={100}
            max={3000}
            step={50}
            value={lastRippleFadeMs}
            onChange={(e) => setLastRippleFadeMs(Number(e.target.value))}
            style={SLIDER_INPUT_STYLE}
          />
          <p style={SLIDER_HINT_STYLE}>
            Fallback only — when an outer ripple is alive, the inner
            now auto-syncs to its remaining natural life so the two
            land together. This slider kicks in only when there's
            nothing to sync to (rare sub-emission-interval exits).
          </p>
        </div>
      </div>

    </div>
  );
}

const PAGE_STYLE: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "var(--color-bg)",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "flex-start",
  gap: 32,
  padding: 32,
  overflowY: "auto",
};

const SHEET_STYLE: CSSProperties = {
  position: "relative",
  width: 380,
  height: 335,
  flexShrink: 0,
  background:
    "radial-gradient(circle at 50% 0%, rgba(34, 211, 238, 0.12), transparent 42%), " +
    "linear-gradient(160deg, rgb(30, 41, 59), rgb(15, 23, 42))",
  borderRadius: 22,
  border: "1px solid rgba(6, 182, 212, 0.18)",
  overflow: "hidden",
  isolation: "isolate",
  boxShadow:
    "0 14px 32px -10px rgba(0, 0, 0, 0.6), " +
    "0 4px 12px -6px rgba(6, 182, 212, 0.22), " +
    "inset 0 1px 0 rgba(255, 255, 255, 0.05)",
};

const SHEEN_STYLE: CSSProperties = {
  position: "absolute",
  inset: 0,
  zIndex: 1,
  pointerEvents: "none",
  background:
    "linear-gradient(115deg, rgba(255, 255, 255, 0.055), transparent 23% 78%, rgba(255, 255, 255, 0.025))",
};

const PHASE_STYLE: CSSProperties = {
  position: "relative",
  zIndex: 2,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 14,
  padding: "24px 22px 20px",
};

const EYEBROW_STYLE: CSSProperties = {
  fontFamily: '"Inter", var(--font-sans)',
  fontSize: 11,
  fontWeight: 500,
  letterSpacing: "0.18em",
  textTransform: "uppercase",
  color: "rgba(255, 255, 255, 0.4)",
  lineHeight: 1.4,
  marginBottom: 8,
};

const EXITED_STYLE: CSSProperties = {
  marginTop: 40,
  color: "rgba(255, 255, 255, 0.55)",
  fontFamily: '"Inter", var(--font-sans)',
  fontSize: 13,
  textAlign: "center",
};

const CONTROL_RAIL_STYLE: CSSProperties = {
  width: 380,
  display: "flex",
  flexDirection: "column",
  gap: 14,
  padding: 18,
  borderRadius: 16,
  background: "rgba(15, 23, 42, 0.55)",
  border: "1px solid rgba(6, 182, 212, 0.18)",
  fontFamily: '"Inter", var(--font-sans)',
  color: "rgba(255, 255, 255, 0.78)",
  fontSize: 13,
};

const BUTTON_ROW_STYLE: CSSProperties = {
  display: "flex",
  gap: 10,
};

const PRIMARY_BUTTON_STYLE: CSSProperties = {
  flex: 1,
  padding: "10px 14px",
  borderRadius: 10,
  border: "1px solid rgba(34, 211, 238, 0.55)",
  background: "rgba(34, 211, 238, 0.18)",
  color: "rgb(190, 240, 255)",
  fontFamily: '"Inter", var(--font-sans)',
  fontSize: 13,
  fontWeight: 500,
  cursor: "pointer",
};

const SECONDARY_BUTTON_STYLE: CSSProperties = {
  flex: 1,
  padding: "10px 14px",
  borderRadius: 10,
  border: "1px solid rgba(255, 255, 255, 0.18)",
  background: "transparent",
  color: "rgba(255, 255, 255, 0.78)",
  fontFamily: '"Inter", var(--font-sans)',
  fontSize: 13,
  fontWeight: 500,
  cursor: "pointer",
};

const SLIDER_ROW_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
  paddingTop: 4,
};

const SLIDER_LABEL_ROW_STYLE: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "baseline",
};

const SLIDER_LABEL_STYLE: CSSProperties = {
  fontSize: 12,
  fontWeight: 500,
  letterSpacing: "0.04em",
  color: "rgba(255, 255, 255, 0.78)",
};

const SLIDER_VALUE_STYLE: CSSProperties = {
  fontFamily: '"JetBrains Mono", ui-monospace, monospace',
  fontSize: 12,
  color: "rgb(190, 240, 255)",
  fontVariantNumeric: "tabular-nums",
};

const SLIDER_INPUT_STYLE: CSSProperties = {
  width: "100%",
  accentColor: "rgb(34, 211, 238)",
  cursor: "pointer",
};

const SLIDER_HINT_STYLE: CSSProperties = {
  margin: 0,
  fontSize: 11,
  color: "rgba(255, 255, 255, 0.48)",
  lineHeight: 1.4,
};
