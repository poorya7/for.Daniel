/**
 * Test page — dial in the input → loading → review water-morph
 * choreography in isolation, with no live LLM call and no real
 * textarea (so the iOS keyboard never pops up and breaks the
 * timing comparison).
 *
 * The big idea: the existing extracting-panel-light page uses
 * `mode="wait"` between layers — each layer fully exits before
 * the next enters, which adds dead beats. THIS page overlaps the
 * layers so the surface always has something moving on it:
 *   • Input content fades out WHILE water blooms in
 *   • Water fades out WHILE the review cascade surfaces
 *
 * Mounted via `/water-morph` (preferred) or `?test=water-morph`.
 *
 * Delay selector at the top picks how long the fake fetch takes
 * (0.5s / 1s / 2s / 3s / 5s). Tap Extract → after that delay the
 * loader auto-exits → review surfaces. Reset returns to the input
 * panel (fresh remount so the entry animation re-plays).
 */

import { AnimatePresence, motion, type MotionStyle } from "framer-motion";
import { useEffect, useRef, useState, type CSSProperties } from "react";

import { SharkLoader } from "@/components/SharkLoader/SharkLoader";

const PHRASES = ["Reading the details", "Understanding", "Organizing"];
const PHRASE_INTERVAL_MS = 5500;

const LOADER_SCALE = 2.2;
const FIN_SCALE = 0.7;

const INPUT_PANEL_HEIGHT = 320;
const LOADING_PANEL_HEIGHT = 580;
const REVIEW_PANEL_HEIGHT = LOADING_PANEL_HEIGHT;

/* Panel height morph — the inhale that takes the surface from
   the short input rectangle to the tall loading/review one.
   Apple's standard decel curve. */
const MORPH_DURATION_S = 0.6;
const MORPH_EASE: [number, number, number, number] = [0.4, 0, 0.2, 1];

/* Input → loading overlap: input dissolves over 500ms; loading
   layer fades in over 450ms starting 200ms BEFORE the input is
   fully gone. So the water is already painting before the
   textarea has finished leaving. Same idea on the exit side
   (loading → review): the review cascade kicks off the moment
   the loader signals its last ripple is draining. */
const INPUT_EXIT_DURATION_S = 0.5;
const INPUT_EXIT_Y = 6;
const LOADING_ENTER_DURATION_S = 0.45;
const LOADING_ENTER_Y = 6;
const LOADING_STAGGER_S = 0.15;

/* Review reveal — same asymmetric cascade as the live page so
   the timings we tune here transfer cleanly. */
const REVIEW_REVEAL_DELAY_S = {
  freeBadge: 0.00,
  eyebrow: 0.04,
  name: 0.16,
  budget: 0.32,
  rowName: 0.54,
  rowPhone: 0.66,
  rowEmail: 0.80,
  rowAgent: 0.94,
  showOriginal: 1.10,
  pagination: 1.20,
  save: 1.32,
  discard: 1.44,
} as const;
const REVEAL_DURATION_S = 0.55;
const REVEAL_EASE: [number, number, number, number] = [0.16, 1, 0.3, 1];
const REVEAL_Y = 8;
const REVEAL_SCALE_FROM = 0.985;
const REVEAL_BLUR_FROM_PX = 3;

/* Loading layer exit — runs in parallel with the review cascade
   beginning to surface, so the water "fades through" the rising
   fields instead of leaving a blank beat. */
const LOADING_EXIT_DURATION_S = 0.6;

type Stage = "input" | "extracting" | "review";

const DELAY_OPTIONS_MS = [500, 1000, 2000, 3000, 5000];

export function WaterMorphTestPage(): React.ReactElement {
  const [stage, setStage] = useState<Stage>("input");
  const [simulatedDelayMs, setSimulatedDelayMs] = useState<number>(2000);
  /* Bump to force panel remount (used by Reset) so the entry fade
     plays from scratch — same trick the live page uses for fresh
     sheet opens. */
  const [entryKey, setEntryKey] = useState(0);
  /* Bump to remount the shark loader on each extract — guarantees
     a fresh play cycle (no stale phase from a previous run). */
  const [loaderKey, setLoaderKey] = useState(0);
  const [phase, setPhase] = useState<"play" | "exit">("play");
  const [exited, setExited] = useState(false);
  const [phraseIdx, setPhraseIdx] = useState(0);

  /* Timer that fires the shark exit after the simulated fetch
     elapses. Stored in a ref so Reset can cancel a pending exit
     and a fresh extract can start cleanly. */
  const exitTimerRef = useRef<number | null>(null);

  /* Phrase rotation — only while the loader is in play mode (not
     during exit, not after exited). Restarts from index 0 on each
     fresh extract. */
  useEffect(() => {
    if (stage !== "extracting") return undefined;
    if (exited || phase === "exit") return undefined;
    const id = window.setInterval(() => {
      setPhraseIdx((i) => (i + 1) % PHRASES.length);
    }, PHRASE_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [stage, exited, phase]);

  /* Cleanup on unmount — make sure no stray timer fires after we're
     gone. */
  useEffect(() => {
    return () => {
      if (exitTimerRef.current !== null) {
        window.clearTimeout(exitTimerRef.current);
      }
    };
  }, []);

  function handleExtract(): void {
    /* Cancel any prior pending timer (defensive — UI disables the
       button while extracting, but a Reset-mid-flow could leave one
       armed). */
    if (exitTimerRef.current !== null) {
      window.clearTimeout(exitTimerRef.current);
      exitTimerRef.current = null;
    }
    setLoaderKey((k) => k + 1);
    setPhase("play");
    setExited(false);
    setPhraseIdx(0);
    setStage("extracting");

    /* Simulated fetch: after the chosen delay we flip the loader
       to exit. The loader's own onExited then advances stage to
       "review". This mirrors the live flow's timing — the stream
       finishes, the loader sinks gracefully, the review cascade
       kicks in. */
    exitTimerRef.current = window.setTimeout(() => {
      setPhase("exit");
      exitTimerRef.current = null;
    }, simulatedDelayMs);
  }

  function handleReset(): void {
    if (exitTimerRef.current !== null) {
      window.clearTimeout(exitTimerRef.current);
      exitTimerRef.current = null;
    }
    setStage("input");
    setPhase("play");
    setExited(false);
    setPhraseIdx(0);
    setEntryKey((k) => k + 1);
  }

  const targetHeight =
    stage === "input"
      ? INPUT_PANEL_HEIGHT
      : stage === "extracting"
        ? LOADING_PANEL_HEIGHT
        : REVIEW_PANEL_HEIGHT;

  return (
    <div style={PAGE_STYLE}>
      {/* Delay selector — picks how long the fake fetch takes.
          Disabled while a fetch is in flight so the user doesn't
          mid-run flip from 5s → 0.5s. */}
      <div style={DELAY_ROW_STYLE}>
        <span style={DELAY_LABEL_STYLE}>Fake fetch</span>
        {DELAY_OPTIONS_MS.map((ms) => {
          const active = ms === simulatedDelayMs;
          return (
            <button
              key={ms}
              type="button"
              onClick={() => setSimulatedDelayMs(ms)}
              disabled={stage === "extracting"}
              style={{
                ...DELAY_BUTTON_STYLE,
                ...(active ? DELAY_BUTTON_ACTIVE_STYLE : null),
                ...(stage === "extracting" ? DELAY_BUTTON_DISABLED_STYLE : null),
              }}
            >
              {formatDelayLabel(ms)}
            </button>
          );
        })}
      </div>

      <motion.div
        key={entryKey}
        initial={{ opacity: 0, height: INPUT_PANEL_HEIGHT }}
        animate={{ opacity: 1, height: targetHeight }}
        transition={{
          opacity: { duration: 0.45, ease: "easeOut" },
          height: { duration: MORPH_DURATION_S, ease: MORPH_EASE },
        }}
        style={{
          ...PANEL_STYLE,
          ...CREAM_THEME_VARS,
          ["--shark-fin-scale" as string]: FIN_SCALE,
        } as MotionStyle}
      >
        {/* No `mode="wait"` — layers OVERLAP so the surface never
            has a dead beat. Input is fading out while the water is
            already blooming in; loading is fading out while the
            review cascade is already surfacing. */}
        <AnimatePresence>
          {stage === "input" && (
            <motion.div
              key="input"
              initial={{ opacity: 1, y: 0 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: INPUT_EXIT_Y }}
              transition={{ duration: INPUT_EXIT_DURATION_S, ease: "easeIn" }}
              style={CONTENT_LAYER_STYLE as MotionStyle}
            >
              <InputContent onExtract={handleExtract} />
            </motion.div>
          )}
          {stage === "extracting" && (
            <motion.div
              key="loading"
              initial="hidden"
              animate="shown"
              exit={{
                opacity: 0,
                transition: { duration: LOADING_EXIT_DURATION_S, ease: "easeIn" },
              }}
              variants={LOADING_LAYER_VARIANTS}
              style={CONTENT_LAYER_STYLE as MotionStyle}
            >
              <LoadingContent
                loaderKey={loaderKey}
                phase={phase}
                exited={exited}
                phraseIdx={phraseIdx}
                scale={LOADER_SCALE}
                onExited={() => {
                  setExited(true);
                  setStage("review");
                }}
              />
            </motion.div>
          )}
          {stage === "review" && (
            <motion.div
              key="review"
              initial={{ opacity: 1 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.3, ease: "easeOut" }}
              style={CONTENT_LAYER_STYLE as MotionStyle}
            >
              <ReviewContent />
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>

      <div style={CONTROL_ROW_STYLE}>
        <button
          type="button"
          style={SECONDARY_BUTTON_STYLE}
          onClick={handleReset}
          disabled={stage === "input"}
        >
          ← Reset
        </button>
      </div>
    </div>
  );
}

function formatDelayLabel(ms: number): string {
  return ms >= 1000 ? `${ms / 1000}s` : `${ms}ms`;
}

const LOADING_LAYER_VARIANTS = {
  hidden: { opacity: 1 },
  shown: {
    opacity: 1,
    transition: {
      staggerChildren: LOADING_STAGGER_S,
    },
  },
};

const MODULE_VARIANTS = {
  hidden: { opacity: 0, y: LOADING_ENTER_Y },
  shown: {
    opacity: 1,
    y: 0,
    transition: { duration: LOADING_ENTER_DURATION_S, ease: "easeOut" },
  },
};

function revealVariants(delay: number) {
  return {
    hidden: {
      opacity: 0,
      y: REVEAL_Y,
      scale: REVEAL_SCALE_FROM,
      filter: `blur(${REVEAL_BLUR_FROM_PX}px)`,
    },
    shown: {
      opacity: 1,
      y: 0,
      scale: 1,
      filter: "blur(0px)",
      transition: { duration: REVEAL_DURATION_S, ease: REVEAL_EASE, delay },
    },
  };
}

/* Input content — hardcoded text rendered as a styled DIV (not a
   real textarea) so taps don't pop the iOS keyboard. Visually
   matches the live input panel chrome so the morph reads the same
   as the production flow. */
function InputContent({
  onExtract,
}: {
  onExtract: () => void;
}): React.ReactElement {
  return (
    <>
      <div style={INPUT_AREA_STYLE} aria-label="Mock note text">
        John ramone budget 5567 no agent
      </div>
      <button type="button" style={EXTRACT_BUTTON_STYLE} onClick={onExtract}>
        Extract details
      </button>
    </>
  );
}

interface LoadingContentProps {
  loaderKey: number;
  phase: "play" | "exit";
  exited: boolean;
  phraseIdx: number;
  scale: number;
  onExited: () => void;
}

function LoadingContent({
  loaderKey,
  phase,
  exited,
  phraseIdx,
  scale,
  onExited,
}: LoadingContentProps): React.ReactElement {
  return (
    <>
      <motion.span variants={MODULE_VARIANTS} style={EYEBROW_STYLE as MotionStyle}>
        EXTRACTING
      </motion.span>

      <motion.div variants={MODULE_VARIANTS} style={LOADER_STAGE_STYLE as MotionStyle}>
        {!exited && (
          <SharkLoader
            key={loaderKey}
            size="md"
            scale={scale}
            phase={phase}
            /* Water is already alive at mount — no slow ripple
               cascade. Matches the live page's setup so the
               surface reads "calm water that's been here for a
               beat" the moment the loader appears. */
            waterAlreadyOn={true}
            /* Zero wait — fin starts rising the instant the water
               appears. The pre-seeded ripples from waterAlreadyOn
               already sell "calm water" without a separate settle
               beat, so we save the 1.5s that used to sit dead
               before the fin emerged. */
            preFinWaitSeconds={0}
            onExited={onExited}
          />
        )}
      </motion.div>

      <motion.div variants={MODULE_VARIANTS} style={PHRASE_STAGE_STYLE as MotionStyle}>
        <AnimatePresence mode="wait">
          {!exited && (
            <motion.span
              key={phraseIdx}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 1.0, ease: "easeInOut" }}
              style={PHRASE_TEXT_STYLE as MotionStyle}
            >
              {PHRASES[phraseIdx]}
            </motion.span>
          )}
        </AnimatePresence>
      </motion.div>
    </>
  );
}

/* Mock review-card content — hardcoded John Ramone data matching
   the screenshot used to discuss the flow. Visually faithful to
   the live ReviewCard so the asymmetric cascade tunes against the
   real shapes. All interactions are inert on this test page. */
function ReviewContent(): React.ReactElement {
  return (
    <>
      <motion.div
        variants={revealVariants(REVIEW_REVEAL_DELAY_S.freeBadge)}
        initial="hidden"
        animate="shown"
        style={FREE_BADGE_STYLE as MotionStyle}
        aria-hidden="true"
      >
        FREE
      </motion.div>

      <motion.span
        variants={revealVariants(REVIEW_REVEAL_DELAY_S.eyebrow)}
        initial="hidden"
        animate="shown"
        style={EYEBROW_STYLE as MotionStyle}
      >
        EXTRACTED
      </motion.span>

      <motion.div
        variants={revealVariants(REVIEW_REVEAL_DELAY_S.name)}
        initial="hidden"
        animate="shown"
        style={NAME_HEADLINE_STYLE as MotionStyle}
      >
        John Ramone
      </motion.div>

      <motion.div
        variants={revealVariants(REVIEW_REVEAL_DELAY_S.budget)}
        initial="hidden"
        animate="shown"
        style={BUDGET_HEADLINE_STYLE as MotionStyle}
      >
        $5,567
      </motion.div>

      <div style={ROWS_CARD_STYLE}>
        <ReviewRow
          label="Name"
          value="John Ramone"
          delay={REVIEW_REVEAL_DELAY_S.rowName}
          tone="warning"
          showCheckPill
        />
        <ReviewRow
          label="Phone"
          value="—"
          delay={REVIEW_REVEAL_DELAY_S.rowPhone}
          tone="neutral"
        />
        <ReviewRow
          label="Email"
          value="—"
          delay={REVIEW_REVEAL_DELAY_S.rowEmail}
          tone="neutral"
        />
        <AgentPickerRow delay={REVIEW_REVEAL_DELAY_S.rowAgent} />
      </div>

      <motion.button
        type="button"
        variants={revealVariants(REVIEW_REVEAL_DELAY_S.showOriginal)}
        initial="hidden"
        animate="shown"
        style={SHOW_ORIGINAL_STYLE as MotionStyle}
      >
        <span style={SHOW_ORIGINAL_CHEVRON_STYLE}>▸</span>
        Show the original note
      </motion.button>

      <motion.div
        variants={revealVariants(REVIEW_REVEAL_DELAY_S.pagination)}
        initial="hidden"
        animate="shown"
        style={PAGINATION_WRAP_STYLE as MotionStyle}
      >
        <div style={DOTS_STYLE}>
          <span style={{ ...DOT_STYLE, ...DOT_ACTIVE_STYLE }} />
        </div>
        <span style={PAGE_INDICATOR_STYLE}>1 of 1</span>
      </motion.div>

      <div style={ACTIONS_STACK_STYLE}>
        <motion.button
          type="button"
          variants={revealVariants(REVIEW_REVEAL_DELAY_S.save)}
          initial="hidden"
          animate="shown"
          style={SAVE_BUTTON_STYLE as MotionStyle}
        >
          Save to Sheet
        </motion.button>
        <motion.button
          type="button"
          variants={revealVariants(REVIEW_REVEAL_DELAY_S.discard)}
          initial="hidden"
          animate="shown"
          style={DISCARD_LINK_STYLE as MotionStyle}
        >
          Discard
        </motion.button>
      </div>
    </>
  );
}

type RowTone = "neutral" | "confident" | "warning";

function ReviewRow({
  label,
  value,
  delay,
  tone = "neutral",
  showCheckPill = false,
}: {
  label: string;
  value: string;
  delay: number;
  tone?: RowTone;
  showCheckPill?: boolean;
}): React.ReactElement {
  const valueStyle =
    tone === "confident"
      ? ROW_VALUE_CONFIDENT_STYLE
      : tone === "warning"
        ? ROW_VALUE_WARNING_STYLE
        : ROW_VALUE_NEUTRAL_STYLE;
  return (
    <motion.div
      variants={revealVariants(delay)}
      initial="hidden"
      animate="shown"
      style={ROW_STYLE as MotionStyle}
    >
      <span style={ROW_LABEL_STYLE}>{label}</span>
      <span style={ROW_VALUE_WRAP_STYLE}>
        <span style={valueStyle}>{value}</span>
        {showCheckPill && <span style={CHECK_PILL_STYLE}>check this</span>}
      </span>
      <PencilIcon />
    </motion.div>
  );
}

function AgentPickerRow({ delay }: { delay: number }): React.ReactElement {
  return (
    <motion.div
      variants={revealVariants(delay)}
      initial="hidden"
      animate="shown"
      style={{ ...ROW_STYLE, borderBottom: "none" } as MotionStyle}
    >
      <span style={ROW_LABEL_STYLE}>Agent?</span>
      <span style={PICKER_PILLS_STYLE}>
        <span style={PICKER_PILL_STYLE}>Yes</span>
        <span style={{ ...PICKER_PILL_STYLE, ...PICKER_PILL_ACTIVE_STYLE }}>
          No
        </span>
      </span>
    </motion.div>
  );
}

function PencilIcon(): React.ReactElement {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={PENCIL_ICON_STYLE}
      aria-hidden="true"
    >
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
    </svg>
  );
}

const PAGE_STYLE: CSSProperties = {
  position: "fixed",
  inset: 0,
  height: "100svh",
  background: "#FAF6EE",
  color: "#1F1A14",
  fontFamily:
    '"Outfit", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "flex-start",
  paddingTop: `max(16px, calc((100svh - ${REVIEW_PANEL_HEIGHT}px) / 2))`,
  paddingLeft: 24,
  paddingRight: 24,
  paddingBottom: 16,
  gap: 16,
  overflow: "hidden",
};

const PANEL_STYLE: CSSProperties = {
  position: "relative",
  width: "100%",
  maxWidth: 380,
  background: "linear-gradient(180deg, #FFFEFB 0%, #FAF6EE 100%)",
  border: "1px solid #ECE3D5",
  borderRadius: 22,
  boxShadow:
    "0 1px 2px rgba(60, 40, 20, 0.04), 0 6px 20px rgba(60, 40, 20, 0.06), inset 0 1px 0 rgba(255, 255, 255, 0.6)",
  overflow: "hidden",
  flexShrink: 0,
};

const CONTENT_LAYER_STYLE: CSSProperties = {
  position: "absolute",
  top: 26,
  right: 22,
  bottom: 22,
  left: 22,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 12,
};

/* Same dimensions / type as the real textarea so the morph reads
   identical, but it's a plain div — no focus, no caret, no
   keyboard. Sits at the TOP of the panel where the live textarea
   would be. */
const INPUT_AREA_STYLE: CSSProperties = {
  width: "100%",
  height: 120,
  flex: "0 0 auto",
  border: "1px solid #ECE3D5",
  borderRadius: 14,
  background: "#FAF6EE",
  padding: 14,
  fontFamily: "inherit",
  fontSize: 22,
  fontWeight: 500,
  color: "#2A1F12",
  boxSizing: "border-box",
  display: "flex",
  alignItems: "flex-start",
  overflow: "hidden",
  /* Suppress the dark tap-highlight overlay iOS Safari paints on
     anything tappable. */
  WebkitTapHighlightColor: "transparent",
  /* Disable text selection so a long-press on a phone doesn't
     pull up the selection menu — we want the surface to feel
     like a static label, not a real input. */
  userSelect: "none",
  WebkitUserSelect: "none",
};

const EXTRACT_BUTTON_STYLE: CSSProperties = {
  alignSelf: "stretch",
  padding: "17px 22px",
  borderRadius: 14,
  border: "none",
  background: "#2A1F12",
  color: "#FBF6E8",
  fontFamily: "inherit",
  fontSize: 18,
  fontWeight: 700,
  letterSpacing: "-0.005em",
  cursor: "pointer",
};

const EYEBROW_STYLE: CSSProperties = {
  fontSize: 15,
  fontWeight: 600,
  letterSpacing: "0.18em",
  textTransform: "uppercase",
  color: "rgba(31, 26, 20, 0.5)",
  lineHeight: 1.4,
};

const LOADER_STAGE_STYLE: CSSProperties = {
  flex: 1,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  minHeight: 220,
  width: "100%",
};

const PHRASE_STAGE_STYLE: CSSProperties = {
  position: "relative",
  height: 28,
  width: "100%",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

const PHRASE_TEXT_STYLE: CSSProperties = {
  position: "absolute",
  fontSize: 18,
  color: "rgba(31, 26, 20, 0.55)",
  letterSpacing: "-0.005em",
};

const NAME_HEADLINE_STYLE: CSSProperties = {
  fontSize: 31,
  marginTop: -6,
  fontWeight: 800,
  color: "#2A1F12",
  letterSpacing: "-0.025em",
  lineHeight: 1.05,
  textAlign: "center",
  width: "100%",
};

const BUDGET_HEADLINE_STYLE: CSSProperties = {
  fontSize: 20,
  fontWeight: 700,
  color: "#8C7A1F",
  letterSpacing: "-0.005em",
  textAlign: "center",
  width: "100%",
  marginTop: -10,
};

const ROWS_CARD_STYLE: CSSProperties = {
  width: "100%",
  background: "rgba(250, 246, 238, 0.55)",
  border: "1px solid #ECE3D5",
  borderRadius: 16,
  padding: "2px 14px",
  display: "flex",
  flexDirection: "column",
};

const ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "10px 0",
  borderBottom: "1px solid rgba(236, 227, 213, 0.7)",
};

const ROW_LABEL_STYLE: CSSProperties = {
  flex: "0 0 80px",
  fontSize: 16,
  fontWeight: 600,
  color: "rgba(31, 26, 20, 0.55)",
  letterSpacing: "-0.005em",
};

const ROW_VALUE_WRAP_STYLE: CSSProperties = {
  flex: "1 1 auto",
  display: "flex",
  alignItems: "center",
  gap: 8,
  minWidth: 0,
};

const ROW_VALUE_NEUTRAL_STYLE: CSSProperties = {
  fontSize: 18,
  fontWeight: 700,
  color: "#2A1F12",
  letterSpacing: "-0.005em",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const ROW_VALUE_CONFIDENT_STYLE: CSSProperties = {
  ...ROW_VALUE_NEUTRAL_STYLE,
  color: "#404E22",
};

const ROW_VALUE_WARNING_STYLE: CSSProperties = {
  ...ROW_VALUE_NEUTRAL_STYLE,
  color: "#8C7A1F",
};

const CHECK_PILL_STYLE: CSSProperties = {
  flex: "0 0 auto",
  background: "rgba(140, 122, 31, 0.18)",
  color: "#8C7A1F",
  fontSize: 12,
  fontWeight: 700,
  letterSpacing: "0.01em",
  padding: "5px 11px",
  borderRadius: 10,
  whiteSpace: "nowrap",
};

const PENCIL_ICON_STYLE: CSSProperties = {
  flex: "0 0 18px",
  color: "rgba(64, 78, 34, 0.7)",
};

const PICKER_PILLS_STYLE: CSSProperties = {
  flex: "1 1 auto",
  display: "flex",
  gap: 8,
};

const PICKER_PILL_STYLE: CSSProperties = {
  padding: "8px 18px",
  borderRadius: 999,
  border: "1px solid rgba(31, 26, 20, 0.18)",
  background: "transparent",
  color: "#2A1F12",
  fontSize: 16,
  fontWeight: 700,
  letterSpacing: "-0.005em",
};

const PICKER_PILL_ACTIVE_STYLE: CSSProperties = {
  background: "#2A1F12",
  border: "1px solid #2A1F12",
  color: "#FBF6E8",
};

const SHOW_ORIGINAL_STYLE: CSSProperties = {
  alignSelf: "flex-start",
  background: "transparent",
  border: "none",
  color: "rgba(31, 26, 20, 0.62)",
  fontFamily: "inherit",
  fontSize: 15,
  fontWeight: 600,
  letterSpacing: "-0.005em",
  padding: "2px 0",
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  gap: 6,
};

const SHOW_ORIGINAL_CHEVRON_STYLE: CSSProperties = {
  fontSize: 11,
  color: "rgba(31, 26, 20, 0.45)",
};

const PAGINATION_WRAP_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 6,
};

const DOTS_STYLE: CSSProperties = {
  display: "flex",
  gap: 6,
};

const DOT_STYLE: CSSProperties = {
  width: 22,
  height: 6,
  borderRadius: 3,
  background: "rgba(31, 26, 20, 0.16)",
};

const DOT_ACTIVE_STYLE: CSSProperties = {
  background: "#2A1F12",
};

const PAGE_INDICATOR_STYLE: CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  color: "rgba(31, 26, 20, 0.5)",
  letterSpacing: "0.02em",
};

const FREE_BADGE_STYLE: CSSProperties = {
  position: "absolute",
  top: -2,
  right: -32,
  background: "#404E22",
  color: "#FBF6E8",
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: "0.14em",
  padding: "5px 28px",
  transform: "rotate(45deg)",
  textTransform: "uppercase",
  zIndex: 2,
  pointerEvents: "none",
};

const ACTIONS_STACK_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  width: "100%",
  marginTop: "auto",
  gap: 8,
};

const SAVE_BUTTON_STYLE: CSSProperties = {
  width: "100%",
  padding: "17px 22px",
  borderRadius: 14,
  border: "none",
  background: "#2A1F12",
  color: "#FBF6E8",
  fontFamily: "inherit",
  fontSize: 18,
  fontWeight: 700,
  letterSpacing: "-0.005em",
  cursor: "pointer",
};

const DISCARD_LINK_STYLE: CSSProperties = {
  padding: "10px 14px",
  border: "none",
  background: "transparent",
  color: "rgba(31, 26, 20, 0.55)",
  fontFamily: "inherit",
  fontSize: 16,
  fontWeight: 600,
  cursor: "pointer",
};

const CONTROL_ROW_STYLE: CSSProperties = {
  display: "flex",
  gap: 10,
  flexWrap: "wrap",
  justifyContent: "center",
};

const SECONDARY_BUTTON_STYLE: CSSProperties = {
  padding: "10px 18px",
  borderRadius: 10,
  border: "1px solid rgba(31, 26, 20, 0.18)",
  background: "transparent",
  color: "rgba(31, 26, 20, 0.78)",
  fontFamily: "inherit",
  fontSize: 13,
  fontWeight: 500,
  cursor: "pointer",
};

const DELAY_ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  flexWrap: "wrap",
  justifyContent: "center",
};

const DELAY_LABEL_STYLE: CSSProperties = {
  fontSize: 11,
  letterSpacing: "0.12em",
  textTransform: "uppercase",
  color: "rgba(31, 26, 20, 0.4)",
  fontWeight: 500,
};

const DELAY_BUTTON_STYLE: CSSProperties = {
  padding: "6px 12px",
  borderRadius: 999,
  border: "1px solid rgba(31, 26, 20, 0.18)",
  background: "transparent",
  color: "rgba(31, 26, 20, 0.7)",
  fontFamily: "inherit",
  fontSize: 12,
  fontWeight: 600,
  letterSpacing: "-0.005em",
  cursor: "pointer",
};

const DELAY_BUTTON_ACTIVE_STYLE: CSSProperties = {
  background: "#2A1F12",
  borderColor: "#2A1F12",
  color: "#FBF6E8",
};

const DELAY_BUTTON_DISABLED_STYLE: CSSProperties = {
  opacity: 0.45,
  cursor: "not-allowed",
};

const CREAM_THEME_VARS = {
  "--shark-loader-tint": "74, 47, 24",
  "--shark-loader-tint-alpha": "0.35",
  "--shark-fin-fill-0": "#A07550",
  "--shark-fin-fill-45": "#6B4828",
  "--shark-fin-fill-80": "#4A2F18",
  "--shark-fin-fill-100": "#2D1B0A",
  "--shark-fin-edge-0": "rgba(220, 185, 140, 0)",
  "--shark-fin-edge-60": "rgba(220, 185, 140, 0.35)",
  "--shark-fin-edge-100": "rgba(235, 205, 165, 0.55)",
  "--shark-fin-shadow": "rgba(40, 24, 12, 0.32)",
} as CSSProperties;
