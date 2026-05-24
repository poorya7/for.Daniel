/**
 * Test page — mocks the FULL capture surface flow on the cream/teal
 * theme. Three panel modes, all morphing inside the SAME outer
 * panel (no page navigation, no panel swap):
 *
 *   1. INPUT    — short panel with a real <textarea> so the iOS
 *                 keyboard actually pops up.
 *   2. LOADING  — taller panel with eyebrow + scaled SharkLoader +
 *                 rotating calm phrases. Hand-off cue: SharkLoader's
 *                 `onExited` fires when the water surface is silent.
 *   3. REVIEW   — full extracted view (eyebrow + headline + 5 field
 *                 rows + Discard / Save). Reveals element-by-element
 *                 with ASYMMETRIC per-element delays (see
 *                 REVIEW_REVEAL_DELAY_S). Motion primitive shared
 *                 with the saving→saved row morph: fade + slight
 *                 rise + faint scale + faint blur. The saving-only
 *                 scanner line stays in the saving surface — not
 *                 reused here.
 *
 * Positioning recipe copied from the main app's `.capture-sheet-root`
 * (see CaptureSheet.css):
 *   • `position: fixed; inset: 0; height: 100svh` — SVH is the
 *     small viewport height (assumes keyboard is up always), so the
 *     calc doesn't change when the iOS keyboard rises.
 *   • `align-items: flex-start` + `padding-top: calc((100svh - H) / 2)`
 *     pins the panel to the TOP at a STATIC position that LOOKS
 *     visually centered. H is the TALLEST possible panel height so
 *     the panel stays comfortably above the bottom edge in every
 *     mode. When the panel height morphs, only the bottom edge
 *     moves — the top stays put by construction. No transform,
 *     no counter-animation, no keyboard jump.
 *
 * Mounted via `?test=extracting-panel-light` or
 * `/extracting-panel-light` (see main.tsx).
 */

import { AnimatePresence, motion, type MotionStyle } from "framer-motion";
import { useEffect, useState, type CSSProperties } from "react";

import { SharkLoader } from "@/components/SharkLoader/SharkLoader";

const PHRASES = ["Reading the details", "Understanding", "Organizing"];
const PHRASE_INTERVAL_MS = 5500;

const LOADER_SCALE = 2.2;
/* Default fin sub-scale — multiplies INSIDE the loader's overall
   scale so the fin can be smaller / larger than the rest of the
   loader as a separate balance. 0.70 makes the fin sit smaller
   relative to the water than the artist-intended 1.0. */
const FIN_SCALE = 0.7;

const INPUT_PANEL_HEIGHT = 320;
/* Bumped from 520 → 580 to fit the bigger Linda-readable type
   in the review state. The loading state has plenty of head-
   room and is unaffected. Review tracks this exact value so
   the panel still doesn't twitch between loading and review. */
const LOADING_PANEL_HEIGHT = 580;
/* Review panel reuses the loading panel height exactly. Owner-locked
   rule: after the input→loading morph, the panel surface must NOT
   change size again through loading, review, saving, or saved. Any
   resize between those phases reads as a "twitch" and breaks the
   ASMR feel. If you ever feel tempted to bump this for content fit,
   adjust internal padding/spacing instead — never the outer height. */
const REVIEW_PANEL_HEIGHT = LOADING_PANEL_HEIGHT;

/* Yoga choreography: input sinks down → panel takes a slow breath
   taller → loading rises up with a module-by-module stagger. The
   panel-morph easing is Apple's standard decel curve so the height
   change reads as a deliberate inhale rather than a snap. */
const MORPH_DURATION_S = 0.6;
const MORPH_EASE: [number, number, number, number] = [0.4, 0, 0.2, 1];

const EXIT_DURATION_S = 0.35;
const EXIT_Y = 6;
const ENTER_DURATION_S = 0.45;
const ENTER_Y = 6;
const STAGGER_S = 0.15;

/* Review-card reveal — ASYMMETRIC per-element delays (not uniform
   stagger). Borrows the saving→saved family DNA (fade + slight rise
   + faint scale + faint blur) but with bespoke beats so the reveal
   reads as a deliberate cascade rather than a metronome.
   Headline first as the "wow" payoff, then fields in a wave with
   uneven pacing, actions last so the user sees the data before the
   call-to-act. */
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
  /* Reading order — Save is the dominant primary action sitting
     above the subtle Discard text link, so it reveals first; the
     cascade ends on the quiet escape-hatch beat. */
  save: 1.32,
  discard: 1.44,
} as const;
const REVEAL_DURATION_S = 0.55;
const REVEAL_EASE: [number, number, number, number] = [0.16, 1, 0.3, 1];
const REVEAL_Y = 8;
const REVEAL_SCALE_FROM = 0.985;
const REVEAL_BLUR_FROM_PX = 3;

type PanelMode = "input" | "loading" | "review";

/* Panel-background options to A/B compare against the cream page
   bg (#FAF6EE). Shifts are sized to be PERCEPTIBLE at a glance —
   the previous round was under the just-noticeable threshold and
   read as a single option three ways. Same border + shadow +
   radius on all four; only the surface tone changes. */
type PanelBgOption =
  | "A-buttered"
  | "B-warm-beige"
  | "C-same"
  | "D-deep-beige";
const PANEL_BG_BY_OPTION: Record<PanelBgOption, string> = {
  "A-buttered": "#FFFAEC",
  "B-warm-beige": "#F2E6CB",
  "C-same": "#FAF6EE",
  "D-deep-beige": "#E8D7B0",
};
const PANEL_BG_LABEL: Record<PanelBgOption, string> = {
  "A-buttered": "A · buttered",
  "B-warm-beige": "B · warm beige",
  "C-same": "C · same",
  "D-deep-beige": "D · deep beige",
};

export function ExtractingPanelLightTestPage(): React.ReactElement {
  const [loaderKey, setLoaderKey] = useState(0);
  const [phase, setPhase] = useState<"play" | "exit">("play");
  const [exited, setExited] = useState(false);
  const [phraseIdx, setPhraseIdx] = useState(0);
  const [panelMode, setPanelMode] = useState<PanelMode>("input");
  const [panelBgOption, setPanelBgOption] =
    useState<PanelBgOption>("D-deep-beige");
  /* Bumped whenever we want the panel to remount and re-play its
     fade-in entry (mirrors the production "open sheet" experience
     where the panel arrives fresh — no previous position for the
     iOS keyboard jump to be visible against). */
  const [entryKey, setEntryKey] = useState(0);

  useEffect(() => {
    /* Skip the reset when transitioning INTO review — the loading
       layer is mid-exit inside AnimatePresence and any state change
       here would re-render its cached subtree (flipping `exited`
       back to false re-mounts the SharkLoader, which then starts a
       fresh play loop with phase="play" since we'd reset that too).
       Reset only when arriving at a state that NEEDS a clean loader
       (a fresh "loading" run, or a return to "input"). */
    if (panelMode === "review") return;
    setExited(false);
    setPhase("play");
    setPhraseIdx(0);
  }, [loaderKey, panelMode]);

  useEffect(() => {
    if (panelMode !== "loading") return undefined;
    if (exited || phase === "exit") return undefined;
    const id = window.setInterval(() => {
      setPhraseIdx((i) => (i + 1) % PHRASES.length);
    }, PHRASE_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [exited, phase, panelMode]);

  const targetHeight =
    panelMode === "input"
      ? INPUT_PANEL_HEIGHT
      : panelMode === "loading"
        ? LOADING_PANEL_HEIGHT
        : REVIEW_PANEL_HEIGHT;

  return (
    <div style={PAGE_STYLE}>
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
          background: PANEL_BG_BY_OPTION[panelBgOption],
          ["--shark-fin-scale" as string]: FIN_SCALE,
        } as MotionStyle}
      >
        {/* mode="wait" — each layer fully exits before the next
            enters. The panel morphs height in parallel underneath
            so the empty beat between exit and enter is filled by
            the panel's breath. The loading→review hand-off uses
            the loader's `onExited` (water fully silent) as the
            trigger, so the cream surface is calm and empty for ~1
            beat before the review content starts cascading in. */}
        <AnimatePresence mode="wait">
          {panelMode === "input" && (
            <motion.div
              key="input"
              initial={{ opacity: 1, y: 0 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: EXIT_Y }}
              transition={{ duration: EXIT_DURATION_S, ease: "easeIn" }}
              style={CONTENT_LAYER_STYLE as MotionStyle}
            >
              <InputContent onExtract={() => setPanelMode("loading")} />
            </motion.div>
          )}
          {panelMode === "loading" && (
            <motion.div
              key="loading"
              initial="hidden"
              animate="shown"
              exit={{
                opacity: 0,
                transition: { duration: 0.25, ease: "easeIn" },
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
                  setPanelMode("review");
                }}
              />
            </motion.div>
          )}
          {panelMode === "review" && (
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
          onClick={() => {
            setPanelMode("input");
            /* Force panel remount so the fade-in entry plays again
               — mirrors the production experience (panel arrives
               fresh, no previous position for the iOS keyboard
               jump to be visible against). */
            setEntryKey((k) => k + 1);
          }}
          disabled={panelMode === "input"}
        >
          ← Back to Input (fresh)
        </button>
      </div>

      {panelMode === "loading" && (
        <div style={CONTROL_ROW_STYLE}>
          <button
            type="button"
            style={GHOST_BUTTON_STYLE}
            disabled={phase === "exit" || exited}
            onClick={() => setPhase("exit")}
          >
            Trigger exit
          </button>
          <button
            type="button"
            style={GHOST_BUTTON_STYLE}
            onClick={() => setLoaderKey((k) => k + 1)}
          >
            Replay loader
          </button>
        </div>
      )}

      {/* Panel-bg A/B/C compare — tap to flip the panel surface
          tone relative to the cream page bg. Live, no remount. */}
      <div style={BG_TOGGLE_ROW_STYLE}>
        <span style={BG_TOGGLE_LABEL_STYLE}>Panel bg</span>
        {(Object.keys(PANEL_BG_BY_OPTION) as PanelBgOption[]).map((opt) => {
          const active = opt === panelBgOption;
          return (
            <button
              key={opt}
              type="button"
              onClick={() => setPanelBgOption(opt)}
              style={{
                ...BG_TOGGLE_BUTTON_STYLE,
                ...(active ? BG_TOGGLE_BUTTON_ACTIVE_STYLE : null),
              }}
            >
              {PANEL_BG_LABEL[opt]}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* Variants on the loading layer — the layer itself is invisible
   and just orchestrates the stagger; each child module fades up
   from a slight y-offset in sequence (eyebrow → loader → phrase).
   `when: "beforeChildren"` is omitted so the children start
   immediately rather than after the layer itself "appears" — the
   layer has no visible state of its own. */
const LOADING_LAYER_VARIANTS = {
  hidden: { opacity: 1 },
  shown: {
    opacity: 1,
    transition: {
      staggerChildren: STAGGER_S,
    },
  },
};

const MODULE_VARIANTS = {
  hidden: { opacity: 0, y: ENTER_Y },
  shown: {
    opacity: 1,
    y: 0,
    transition: { duration: ENTER_DURATION_S, ease: "easeOut" },
  },
};

/* Per-element reveal for the review-card cascade. Each call returns
   a motion variants pair with a bespoke `delay` — the asymmetric
   pacing lives in the delay map at the top of the file, not here.
   Primitive: fade + slight y-rise + faint scale-in + faint blur-in.
   Same DNA as the saving→saved row morph (without the scanner
   line — that's the saving surface's signature). */
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

function InputContent({
  onExtract,
}: {
  onExtract: () => void;
}): React.ReactElement {
  return (
    <>
      <textarea style={INPUT_AREA_STYLE} placeholder="Type your lead here…" />
      <button type="button" style={EXTRACT_BUTTON_STYLE} onClick={onExtract}>
        Extract
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
            onExited={onExited}
          />
        )}
        {exited && (
          <p style={EXITED_STYLE}>
            Exit complete — tap <strong>Replay loader</strong> below.
          </p>
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

/* Mock review-card content — visually faithful to the live
   production ReviewCard (the dark-theme one the owner ships
   today), reskinned to the cream/teal palette. Same field set,
   same edit affordances (pencil icons), same "check this" pill
   for low-confidence values, same Yes/No picker pills, same
   "Show original note" toggle, same dot pagination + "1 of N",
   same FREE corner ribbon. INERT here on the test page — taps
   don't open editors yet — but every element sits in its real
   position so the asymmetric reveal cascade tunes against the
   real shapes and transfers cleanly when this is wired into the
   live component. */
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
        John Smith
      </motion.div>

      <motion.div
        variants={revealVariants(REVIEW_REVEAL_DELAY_S.budget)}
        initial="hidden"
        animate="shown"
        style={BUDGET_HEADLINE_STYLE as MotionStyle}
      >
        $2,500,000
      </motion.div>

      <div style={ROWS_CARD_STYLE}>
        <ReviewRow
          label="Name"
          value="John Smith"
          delay={REVIEW_REVEAL_DELAY_S.rowName}
          tone="warning"
          showCheckPill
        />
        <ReviewRow
          label="Phone"
          value="(555) 123-4567"
          delay={REVIEW_REVEAL_DELAY_S.rowPhone}
          tone="confident"
        />
        <ReviewRow
          label="Email"
          value="john@example.com"
          delay={REVIEW_REVEAL_DELAY_S.rowEmail}
          tone="confident"
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
          <span style={DOT_STYLE} />
          <span style={DOT_STYLE} />
        </div>
        <span style={PAGE_INDICATOR_STYLE}>1 of 3</span>
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

/* Agent? Yes/No picker — same row chrome as ReviewRow (label on
   left, pencil on right) but the value slot holds two pills, the
   selected one filled in teal. Inert in the mock — taps don't
   actually swap selection — but the production version will run
   the same swap-on-tap interaction. */
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

/* Tiny pencil glyph — universally readable "tap to edit" cue at
   the right edge of every editable row. Warm subtle stroke so it
   reads as affordance, not chrome. */
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

/* Top-anchored layout with calc'd padding-top — copied from the
   main app's `.capture-sheet-root` recipe. SVH is static so the
   keyboard never shifts this. */
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
  /* Subtle warm gradient from near-white at the top to cream at
     the bottom — keeps the surface from reading as a flat
     printed report while staying sunlight-readable. */
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
  /* Tighter than the loading layer's natural gap — the review
     surface has more elements (headline + budget + rows card +
     show-original + pagination + actions stack) and needs to
     fit in the same 520px panel. Per-element overrides via
     marginTop where needed. */
  gap: 12,
};

/* FIXED 120px height (NOT flex:1) — same as the main app's
   .capture-textarea. The textarea sits near the TOP of the panel
   so the iOS keyboard rises into empty space BELOW it, with no
   scroll-into-view needed → no panel jump. */
const INPUT_AREA_STYLE: CSSProperties = {
  width: "100%",
  height: 120,
  flex: "0 0 auto",
  border: "1px solid #ECE3D5",
  borderRadius: 14,
  background: "#FAF6EE",
  padding: 14,
  fontFamily: "inherit",
  /* Bumped to 22 for Linda's eyes (still above iOS-safe 16px
     floor so the keyboard won't auto-zoom). */
  fontSize: 22,
  fontWeight: 500,
  color: "#2A1F12",
  resize: "none",
  outline: "none",
  boxSizing: "border-box",
  /* Kill iOS Safari's dark tap-highlight overlay so taps don't
     "blink" the textarea. */
  WebkitTapHighlightColor: "transparent",
};

const EXTRACT_BUTTON_STYLE: CSSProperties = {
  alignSelf: "stretch",
  padding: "17px 22px",
  borderRadius: 14,
  border: "none",
  /* Espresso — matches the review-card Save CTA so the input
     panel and the review panel share one primary-action color.
     Was teal (lazy port from the dark theme), now in the new
     warm earth-tone system. */
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

const EXITED_STYLE: CSSProperties = {
  color: "rgba(31, 26, 20, 0.55)",
  fontSize: 14,
  textAlign: "center",
  margin: 0,
};

/* Review-card mock — visual styling for the post-loader state.
   Matches the live ReviewCard's element set (name + budget on
   their own lines, rows card with editable rows, picker pills,
   show-original toggle, dot pagination, FREE corner badge) on
   the cream/teal palette. Color hierarchy used:
     • Warm black  #1F1A14  — primary text
     • Deep teal   #0B7A95  — "editable / brand" cue on confident
                              values and the primary CTA
     • Warm honey  #B0771A  — budget headline + low-confidence
                              row values (paired with "check this")
     • Sage mint   #5FAE85  — FREE corner ribbon
     • Warm tan    #ECE3D5  — dividers + subtle outlines
   No saturated glow / drop shadow — every richness lever is
   color + iconography so the surface stays sunlight-readable. */

const NAME_HEADLINE_STYLE: CSSProperties = {
  fontSize: 31,
  /* Pull the whole hero (name + budget) closer to the eyebrow
     above — the budget rides this via its own marginTop. */
  marginTop: -6,
  /* Heavy weight per the reference — hero type carries the
     panel's character. Outfit 800 reads decisively bold without
     getting cramped at this size. */
  fontWeight: 800,
  /* Espresso — very dark warm brown, near-black but unmistakably
     warm. The dominant brand color, repeated on the Save CTA +
     picker active + active page-dot so the surface has ONE
     confident voice. Calm and premium on warm beige, none of
     the alert-red feel terracotta had. */
  color: "#2A1F12",
  letterSpacing: "-0.025em",
  lineHeight: 1.05,
  textAlign: "center",
  width: "100%",
};

const BUDGET_HEADLINE_STYLE: CSSProperties = {
  fontSize: 20,
  /* Bold non-italic — owner removed the italic. */
  fontWeight: 700,
  /* Olive gold — the warm "money / flag" accent, shifted more
     olive than the previous honey so it sits cleanly in the
     same earth-tone family as the olive-green editable values.
     Reused on the low-confidence row value below + its check
     pill. */
  color: "#8C7A1F",
  letterSpacing: "-0.005em",
  textAlign: "center",
  width: "100%",
  /* Pull tighter to the name — visually a single heading unit
     even though we reveal them on different beats. */
  marginTop: -10,
};

/* Inner rows card — a slightly warmer cream surface set against
   the gradient panel bg, framed with a subtle warm border. Gives
   the editable fields a "touchable container" feel without going
   loud. Internal rows handle their own padding + dividers. */
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
  /* Bold — the reference's row values read as decisive bold,
     not the lean 500. Lifts them above the labels (which sit
     at the same 600 but at a smaller size + lower contrast). */
  fontWeight: 700,
  color: "#2A1F12",
  letterSpacing: "-0.005em",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

/* Confident editable values — DARK OLIVE GREEN. The "alive /
   tap to edit" cue across the whole surface (also drives the
   pencil icon stroke and the FREE corner badge). Unifying
   green across values + badge + pencils is the move that
   makes the surface read as coherent instead of having a
   floating green accent island. Earth-toned, calm, never
   reads as alert. */
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
  /* Dark olive green at moderate opacity — same hue family as
     the editable values so the icon reads as part of the
     "interactive olive" system, not a stray gray glyph. */
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

/* FREE corner ribbon — sage mint diagonal across the top-right
   panel corner. The panel's `overflow: hidden` + border radius
   clip the rotated bar into a clean ribbon. Sits inside the
   review layer so it animates in with the cascade and unmounts
   when the panel mode flips away. */
const FREE_BADGE_STYLE: CSSProperties = {
  position: "absolute",
  top: -2,
  right: -32,
  /* Dark olive green — same color as the editable row values
     and the pencil icons. Tying the badge into the green
     "interactive / alive" system (instead of a floating sage
     accent) is what makes the green feel intentional. Cream
     text keeps the badge calm and premium. */
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

/* Vertical action stack — Save is the single dominant CTA at the
   bottom of the panel; Discard is a subtle text link below it as
   the escape hatch. One dominant decision, secondary tucked
   under it — matches the "one decision at a time" principle and
   Apple's bottom-sheet conventions (filled primary + plain text
   secondary). Whole stack anchors to the panel bottom via
   marginTop:auto so the rows above breathe naturally. */
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
  /* Espresso — same color as the hero name + picker active.
     Repeating ONE brand color across hero + primary action +
     selected state gives the surface a single confident voice.
     Cream text on espresso reads premium-ink, calm, never
     screamy. */
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

const GHOST_BUTTON_STYLE: CSSProperties = {
  padding: "8px 14px",
  borderRadius: 8,
  border: "1px solid rgba(31, 26, 20, 0.15)",
  background: "transparent",
  color: "rgba(31, 26, 20, 0.6)",
  fontFamily: "inherit",
  fontSize: 12,
  fontWeight: 500,
  cursor: "pointer",
};

const BG_TOGGLE_ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  flexWrap: "wrap",
  justifyContent: "center",
};


const BG_TOGGLE_LABEL_STYLE: CSSProperties = {
  fontSize: 11,
  letterSpacing: "0.12em",
  textTransform: "uppercase",
  color: "rgba(31, 26, 20, 0.4)",
  fontWeight: 500,
};

const BG_TOGGLE_BUTTON_STYLE: CSSProperties = {
  padding: "6px 12px",
  borderRadius: 999,
  border: "1px solid rgba(31, 26, 20, 0.18)",
  background: "transparent",
  color: "rgba(31, 26, 20, 0.7)",
  fontFamily: "inherit",
  fontSize: 12,
  fontWeight: 500,
  letterSpacing: "-0.005em",
  cursor: "pointer",
};

const BG_TOGGLE_BUTTON_ACTIVE_STYLE: CSSProperties = {
  background: "#0B7A95",
  borderColor: "#0B7A95",
  color: "#FFFFFF",
};

const CREAM_THEME_VARS = {
  /* Walnut shark — unmistakably warm brown across the gradient
     (the previous near-black espresso read as plain black on
     mobile). Highlights at the top of the fin show light warm
     amber, body sits at deep walnut. Water tint shares the
     family at low alpha for subtle warm-shadow ripples. */
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
