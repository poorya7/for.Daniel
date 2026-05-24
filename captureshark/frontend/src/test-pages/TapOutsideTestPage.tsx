/**
 * Tap-outside diagnostic test page.
 *
 * Open via `?test=tap-outside`. Renders a focused textarea on top of
 * a tappable backdrop, with an on-screen event log that records EVERY
 * relevant event in the order it fires.
 *
 * Use case: figuring out which events iOS Safari actually delivers
 * (and in what order) when the user taps outside a focused textarea
 * while the soft keyboard is up. The log is rendered on-page so we
 * can read it without a remote inspector — just take a screenshot.
 *
 * To use:
 *   1. Open `dev.captureshark.com/?test=tap-outside` on the phone.
 *   2. Tap the textarea — keyboard rises, log records `focus`.
 *   3. Tap anywhere on the dark background.
 *   4. Read the log. Each row shows the event name + target + a
 *      timestamp delta from the previous event.
 *   5. Tap "Reset" between tries.
 */

import { useEffect, useRef, useState } from "react";

interface LogEntry {
  t: number;
  event: string;
  target: string;
  detail?: string | undefined;
}

function describe(el: EventTarget | null): string {
  if (!el || !(el instanceof HTMLElement)) return "—";
  const tag = el.tagName.toLowerCase();
  const cls = el.className && typeof el.className === "string" ? `.${el.className.split(" ")[0]}` : "";
  return `${tag}${cls}`;
}

export function TapOutsideTestPage(): React.ReactElement {
  const [log, setLog] = useState<LogEntry[]>([]);
  const startRef = useRef<number>(performance.now());
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  function push(event: string, target: EventTarget | null, detail?: string): void {
    const now = performance.now() - startRef.current;
    setLog((prev) => [...prev, { t: Math.round(now), event, target: describe(target), detail }]);
  }

  // Window-level listeners so we capture stuff that might not bubble
  // through React's synthetic event system (e.g. focusout during
  // iOS keyboard dismissal).
  useEffect(() => {
    const events = [
      "touchstart",
      "touchend",
      "mousedown",
      "mouseup",
      "click",
      "focusin",
      "focusout",
      "blur",
      "focus",
    ] as const;
    const handlers: Array<{ name: string; fn: (e: Event) => void }> = events.map((name) => {
      const fn = (e: Event): void => {
        const fe = e as FocusEvent;
        const rt = fe.relatedTarget ?? null;
        const detail = rt ? `→ ${describe(rt)}` : undefined;
        push(name, e.target, detail);
      };
      window.addEventListener(name, fn, true); // capture, so we see everything
      return { name, fn };
    });
    return () => {
      handlers.forEach(({ name, fn }) => window.removeEventListener(name, fn, true));
    };
  }, []);

  function reset(): void {
    startRef.current = performance.now();
    setLog([]);
  }

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "#0f172a",
        color: "#fff",
        fontFamily: "Inter, sans-serif",
        display: "flex",
        flexDirection: "column",
      }}
      data-role="page-bg"
    >
      <div
        style={{
          padding: "20px 16px",
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        <h2 style={{ margin: 0, fontSize: 18 }}>Tap-outside event log</h2>
        <p style={{ margin: 0, fontSize: 13, opacity: 0.7 }}>
          1. Tap the textarea (keyboard rises). 2. Tap the dark area
          below. 3. Read the log. Screenshot + send.
        </p>
        <textarea
          ref={taRef}
          placeholder="Tap here to focus, then tap below"
          style={{
            width: "100%",
            height: 90,
            padding: 12,
            background: "rgba(2,6,23,0.5)",
            color: "#fff",
            border: "1px solid rgba(255,255,255,0.15)",
            borderRadius: 10,
            fontSize: 16,
          }}
        />
        <button
          type="button"
          onClick={reset}
          style={{
            alignSelf: "flex-start",
            padding: "8px 16px",
            background: "#22d3ee",
            color: "#06112a",
            border: "none",
            borderRadius: 8,
            fontSize: 14,
            fontWeight: 600,
          }}
        >
          Reset log
        </button>
      </div>

      <div
        style={{
          flex: 1,
          margin: "0 16px 16px",
          padding: 12,
          background: "rgba(0,0,0,0.3)",
          border: "1px solid rgba(255,255,255,0.1)",
          borderRadius: 10,
          fontFamily: "ui-monospace, SF Mono, monospace",
          fontSize: 12,
          lineHeight: 1.4,
          overflow: "auto",
        }}
      >
        {log.length === 0 ? (
          <div style={{ opacity: 0.5 }}>(no events yet)</div>
        ) : (
          log.map((e, i) => (
            <div key={i} style={{ display: "flex", gap: 8 }}>
              <span style={{ opacity: 0.5, minWidth: 50 }}>{e.t}ms</span>
              <span style={{ color: "#22d3ee", minWidth: 80 }}>{e.event}</span>
              <span style={{ opacity: 0.8 }}>{e.target}</span>
              {e.detail ? <span style={{ opacity: 0.6 }}>{e.detail}</span> : null}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
