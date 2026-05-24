/**
 * TestDevPanel — keepable dev tool, NOT a `test-pages/` scratchpad.
 *
 * Lives under `frontend/src/dev-tools/` so it survives the regular
 * `test-pages/` cleanup. Import + mount anywhere you need to dial in
 * CSS animation timings live on real DOM (delay + duration per
 * element, with enable/disable toggles).
 *
 * Current targets are the capture-sheet input → loading morph
 * (`.capture-phase--input` exit cascade + `.capture-phase--loading`
 * enter cascade). To reuse for a different morph, fork the file and
 * swap the `TARGETS` array + the `applyPanelResize` selector to the
 * elements you care about; everything else (UI, copy-values, the
 * `body[data-test-<row>]` mirror) is animation-agnostic.
 *
 * Each row exposes:
 *   - Label-toggle (tap label to enable/disable).
 *   - − / value / + buttons for delay (50ms steps).
 *   - − / value / + buttons for duration (50ms steps).
 *
 * Enabled  → inline `animation-delay` / `animation-duration` written
 *            to the element (`!important`) so the underlying CSS
 *            keyframe runs at the chosen timing.
 * Disabled → `animation: none !important` on the element. `fullHide`
 *            targets also get `opacity: 0`; `animOnly` targets
 *            (textarea / button — anything you still need to tap
 *            while disabled) stay visible.
 *
 * "Copy values" copies the whole config (incl. enabled/disabled
 * state) to clipboard as plain text — paste into a chat / commit
 * message / spec.
 *
 * The panel also mirrors each row's enabled state onto
 * `body[data-test-<row>="on"]` so CSS can hold morph-end states
 * across phase transitions (see the test-mode block in
 * `CaptureSheet.css`). If you reuse this panel for a different
 * morph and want the same end-state hold, add matching CSS rules
 * gated on those body data attributes.
 */

import { useEffect, useState } from "react";

const STEP_MS = 50;
// Reapply interval is short so that elements which mount mid-flow
// (e.g. the loading-phase eyebrow / subtext / shark loader, which only
// exist in the DOM once extraction starts) pick up the panel's
// inline-style overrides within a frame or two — before their CSS
// animations have meaningfully advanced. Previously this was 250ms,
// which meant the first ~quarter-second of the morph could play with
// raw CSS defaults rather than the user's tuned values.
const REAPPLY_INTERVAL_MS = 50;
const INPUT_HEIGHT_PX = 320;

type ItemKey =
  | "heading"
  | "textarea"
  | "button"
  | "panelResize"
  | "eyebrow"
  | "subtext"
  | "loader";

interface ItemValues {
  delay: number;
  duration: number;
}

type Values = Record<ItemKey, ItemValues>;
type EnabledMap = Record<ItemKey, boolean>;

const DEFAULT_VALUES: Values = {
  heading: { delay: 0, duration: 450 },
  textarea: { delay: 150, duration: 550 },
  button: { delay: 0, duration: 350 },
  panelResize: { delay: 300, duration: 450 },
  eyebrow: { delay: 300, duration: 500 },
  subtext: { delay: 850, duration: 300 },
  loader: { delay: 50, duration: 0 },
};

const DEFAULT_ENABLED: EnabledMap = {
  heading: true,
  textarea: true,
  button: true,
  panelResize: true,
  eyebrow: true,
  subtext: true,
  loader: true,
};

// "fullHide" — opacity:0 when disabled (item never visually appears).
// "animOnly" — stays visible when disabled (only animation gated).
type HideMode = "fullHide" | "animOnly";

interface Target {
  key: ItemKey;
  label: string;
  selector: string;
  hideMode: HideMode;
}

const TARGETS: Target[] = [
  {
    key: "heading",
    label: "heading",
    selector: ".capture-phase--input .capture-heading-row",
    hideMode: "fullHide",
  },
  {
    key: "textarea",
    label: "textarea",
    selector: ".capture-phase--input .capture-textarea",
    hideMode: "animOnly",
  },
  {
    key: "button",
    label: "button",
    selector: ".capture-phase--input .capture-primary",
    hideMode: "animOnly",
  },
  // panelResize handled separately (it's a transition on .capture-sheet)
  {
    key: "eyebrow",
    label: "eyebrow",
    selector: ".capture-phase--loading .capture-loading__eyebrow",
    hideMode: "fullHide",
  },
  {
    key: "subtext",
    label: "subtext",
    selector: ".capture-phase--loading .capture-loading__phrase",
    hideMode: "fullHide",
  },
  {
    key: "loader",
    label: "shark loader",
    selector: ".capture-phase--loading .capture-loading__stage > *",
    hideMode: "fullHide",
  },
];

function applyAnimationItem(
  selector: string,
  delay: number,
  duration: number,
  enabled: boolean,
  hideMode: HideMode,
  isButton = false,
): void {
  // querySelectorAll (not querySelector) so a selector that matches
  // multiple elements — e.g. `.capture-loading__stage > *` if the
  // stage ever holds more than one child — overrides every match
  // instead of silently skipping the rest. Cheap; the targets are
  // small in number.
  const els = document.querySelectorAll<HTMLElement>(selector);
  if (els.length === 0) return;
  for (const el of els) {
    if (enabled) {
      el.style.removeProperty("animation");
      el.style.removeProperty("opacity");
      if (isButton) {
        // Button has TWO animations (slide + fade) — keep fade tied to slide.
        el.style.setProperty(
          "animation-delay",
          `${delay}ms, ${delay + 100}ms`,
          "important",
        );
        el.style.setProperty(
          "animation-duration",
          `${duration}ms, 100ms`,
          "important",
        );
      } else {
        el.style.setProperty("animation-delay", `${delay}ms`, "important");
        el.style.setProperty("animation-duration", `${duration}ms`, "important");
      }
    } else {
      el.style.removeProperty("animation-delay");
      el.style.removeProperty("animation-duration");
      el.style.setProperty("animation", "none", "important");
      if (hideMode === "fullHide") {
        el.style.setProperty("opacity", "0", "important");
      } else {
        el.style.removeProperty("opacity");
      }
    }
  }
}

function applyPanelResize(
  delay: number,
  duration: number,
  enabled: boolean,
): void {
  const sheet = document.querySelector(".capture-sheet") as HTMLElement | null;
  if (!sheet) return;
  if (enabled) {
    sheet.classList.remove("test-panel-height-locked");
    sheet.style.setProperty(
      "transition-delay",
      `0ms, ${delay}ms`,
      "important",
    );
    sheet.style.setProperty(
      "transition-duration",
      `500ms, ${duration}ms`,
      "important",
    );
  } else {
    // Use a class with !important so React's inline height (which
    // lacks priority) can't overwrite it between re-renders.
    sheet.classList.add("test-panel-height-locked");
    sheet.style.setProperty(
      "transition-duration",
      `500ms, 1ms`,
      "important",
    );
  }
}

function applyAll(v: Values, en: EnabledMap): void {
  for (const t of TARGETS) {
    applyAnimationItem(
      t.selector,
      v[t.key].delay,
      v[t.key].duration,
      en[t.key],
      t.hideMode,
      t.key === "button",
    );
  }
  applyPanelResize(
    v.panelResize.delay,
    v.panelResize.duration,
    en.panelResize,
  );
  // Mirror per-row toggle state onto <body> data attributes so the
  // CSS can hold the input-exit morph-end states after the `.exit`
  // class is stripped at 1480ms. Without this, enabled rows snap
  // back to their rest state the moment CaptureSheet clears
  // `exiting`. Disabled rows get no attribute → no end-state hold,
  // so they stay visually at rest.
  for (const t of TARGETS) {
    const attr = `data-test-${t.key.toLowerCase()}`;
    if (en[t.key]) document.body.setAttribute(attr, "on");
    else document.body.removeAttribute(attr);
  }
  if (en.panelResize) document.body.setAttribute("data-test-panelresize", "on");
  else document.body.removeAttribute("data-test-panelresize");
}

interface RowProps {
  itemKey: ItemKey;
  label: string;
  enabled: boolean;
  delay: number;
  duration: number;
  onToggle: () => void;
  onDelay: (next: number) => void;
  onDuration: (next: number) => void;
}

function Row({
  itemKey: _key,
  label,
  enabled,
  delay,
  duration,
  onToggle,
  onDelay,
  onDuration,
}: RowProps): React.ReactElement {
  return (
    <div style={enabled ? rowStyleOn : rowStyleOff}>
      <button
        type="button"
        onClick={onToggle}
        style={enabled ? labelToggleOn : labelToggleOff}
        aria-pressed={enabled}
        aria-label={`Toggle ${label}`}
      >
        {label}
      </button>
      <button
        type="button"
        style={btnStyle}
        onClick={() => onDelay(Math.max(0, delay - STEP_MS))}
        aria-label={`${label} delay −`}
      >−</button>
      <span style={valueStyle}>{delay}</span>
      <button
        type="button"
        style={btnStyle}
        onClick={() => onDelay(delay + STEP_MS)}
        aria-label={`${label} delay +`}
      >+</button>
      <button
        type="button"
        style={btnStyle}
        onClick={() => onDuration(Math.max(0, duration - STEP_MS))}
        aria-label={`${label} duration −`}
      >−</button>
      <span style={valueStyle}>{duration}</span>
      <button
        type="button"
        style={btnStyle}
        onClick={() => onDuration(duration + STEP_MS)}
        aria-label={`${label} duration +`}
      >+</button>
    </div>
  );
}

const ROW_ORDER: { section: "A" | "B"; key: ItemKey; label: string }[] = [
  { section: "A", key: "heading", label: "heading" },
  { section: "A", key: "textarea", label: "textarea" },
  { section: "A", key: "button", label: "button" },
  { section: "B", key: "panelResize", label: "panel resize" },
  { section: "B", key: "eyebrow", label: "eyebrow" },
  { section: "B", key: "subtext", label: "subtext" },
  { section: "B", key: "loader", label: "shark loader" },
];


export function TestDevPanel(): React.ReactElement {
  const [v, setV] = useState<Values>(DEFAULT_VALUES);
  const [en, setEn] = useState<EnabledMap>(DEFAULT_ENABLED);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    applyAll(v, en);
    const id = window.setInterval(() => applyAll(v, en), REAPPLY_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [v, en]);

  function updateValue(key: ItemKey, field: "delay" | "duration", next: number): void {
    setV((curr) => ({ ...curr, [key]: { ...curr[key], [field]: next } }));
  }

  function toggle(key: ItemKey): void {
    setEn((curr) => ({ ...curr, [key]: !curr[key] }));
  }

  function handleCopy(): void {
    const lines = [
      "A — INPUT EXIT",
      ...ROW_ORDER.filter((r) => r.section === "A").map(
        (r) =>
          `  ${r.label.padEnd(12)} ${en[r.key] ? "ON " : "OFF"}  delay=${v[r.key].delay}ms  duration=${v[r.key].duration}ms`,
      ),
      "B — LOADING ENTER",
      ...ROW_ORDER.filter((r) => r.section === "B").map(
        (r) =>
          `  ${r.label.padEnd(12)} ${en[r.key] ? "ON " : "OFF"}  delay=${v[r.key].delay}ms  duration=${v[r.key].duration}ms`,
      ),
    ];
    const text = lines.join("\n");
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      })
      .catch(() => {
        const ta = document.createElement("textarea");
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        try {
          document.execCommand("copy");
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1200);
        } catch {
          // ignore
        }
        document.body.removeChild(ta);
      });
  }

  return (
    <div style={panelStyle}>
      <style>{`
        .capture-sheet.test-panel-height-locked { height: ${INPUT_HEIGHT_PX}px !important; }
        /* When the capture sheet is open, the home cluster is faded
           to opacity 0 but its descendants (incl. this dev panel)
           still capture taps. Disable pointer events so the backdrop
           / sheet receive everything. */
        body.sheet-open .home-cluster { pointer-events: none !important; }
      `}</style>
      <div style={columnHeaderStyle}>
        <span style={{ width: 92 }} />
        <span style={columnLabelStyle}>delay</span>
        <span style={columnLabelStyle}>duration</span>
      </div>
      <div style={sectionHeaderStyle}>A — INPUT EXIT</div>
      {ROW_ORDER.filter((r) => r.section === "A").map((r) => (
        <Row
          key={r.key}
          itemKey={r.key}
          label={r.label}
          enabled={en[r.key]}
          delay={v[r.key].delay}
          duration={v[r.key].duration}
          onToggle={() => toggle(r.key)}
          onDelay={(n) => updateValue(r.key, "delay", n)}
          onDuration={(n) => updateValue(r.key, "duration", n)}
        />
      ))}
      <div style={sectionHeaderStyle}>B — LOADING ENTER</div>
      {ROW_ORDER.filter((r) => r.section === "B").map((r) => (
        <Row
          key={r.key}
          itemKey={r.key}
          label={r.label}
          enabled={en[r.key]}
          delay={v[r.key].delay}
          duration={v[r.key].duration}
          onToggle={() => toggle(r.key)}
          onDelay={(n) => updateValue(r.key, "delay", n)}
          onDuration={(n) => updateValue(r.key, "duration", n)}
        />
      ))}
      <button type="button" onClick={handleCopy} style={copyBtnStyle}>
        {copied ? "Copied ✓" : "Copy values"}
      </button>
    </div>
  );
}

const panelStyle: React.CSSProperties = {
  background: "rgba(0, 0, 0, 0.88)",
  color: "white",
  padding: "14px 14px",
  borderRadius: 10,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: 13,
  lineHeight: 1.2,
  display: "flex",
  flexDirection: "column",
  gap: 6,
  width: "100%",
  maxWidth: 420,
  margin: "0 auto",
  boxSizing: "border-box",
};

const sectionHeaderStyle: React.CSSProperties = {
  fontSize: 11,
  letterSpacing: "0.14em",
  opacity: 0.6,
  marginTop: 10,
  marginBottom: 4,
};

const columnHeaderStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  fontSize: 10,
  opacity: 0.55,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
};

const columnLabelStyle: React.CSSProperties = {
  width: 164,
  textAlign: "center",
};

const rowStyleBase: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  flexWrap: "nowrap",
};

const rowStyleOn: React.CSSProperties = { ...rowStyleBase };
const rowStyleOff: React.CSSProperties = { ...rowStyleBase, opacity: 0.45 };

const labelToggleBase: React.CSSProperties = {
  flex: "0 0 92px",
  height: 44,
  padding: "0 8px",
  fontSize: 12,
  fontWeight: 600,
  textAlign: "left",
  border: "1px solid #444",
  borderRadius: 6,
  cursor: "pointer",
  fontFamily: "inherit",
  lineHeight: 1.1,
};

const labelToggleOn: React.CSSProperties = {
  ...labelToggleBase,
  background: "#2a6cf2",
  color: "white",
  borderColor: "#2a6cf2",
};

const labelToggleOff: React.CSSProperties = {
  ...labelToggleBase,
  background: "transparent",
  color: "white",
};

const btnStyle: React.CSSProperties = {
  flex: "0 0 44px",
  width: 44,
  height: 44,
  background: "#222",
  color: "white",
  border: "1px solid #444",
  borderRadius: 6,
  fontSize: 20,
  fontWeight: 600,
  cursor: "pointer",
  padding: 0,
  lineHeight: 1,
  fontFamily: "inherit",
};

const valueStyle: React.CSSProperties = {
  display: "inline-block",
  width: 56,
  textAlign: "center",
  fontSize: 13,
  fontVariantNumeric: "tabular-nums",
};

const copyBtnStyle: React.CSSProperties = {
  marginTop: 12,
  padding: "12px 16px",
  background: "#2a6cf2",
  color: "white",
  border: "none",
  borderRadius: 8,
  fontSize: 14,
  fontWeight: 600,
  cursor: "pointer",
  fontFamily: "inherit",
};
