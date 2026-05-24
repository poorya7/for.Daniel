/**
 * Live captions debug page.
 *
 * Open via `?test=live-captions`. Shows every AssemblyAI message as it
 * arrives, with timestamps and a separate display of what the stable
 * buffer is exposing to the UI.
 *
 * Use case: figuring out whether sparse / bursty captions are coming
 * from AssemblyAI's emission cadence or from the buffer suppressing
 * fast revisions. The log is on-page so we can read it on a phone
 * without remote inspection.
 *
 * To use:
 *   1. Open `dev.captureshark.com/?test=live-captions` on the phone.
 *   2. Tap "Start" — mic permission prompt → recording begins.
 *   3. Speak (try both fast continuous and slow-paused).
 *   4. Watch the log: every Turn message gets a row with `t+Xms`,
 *      `partial|final`, and the text.
 *   5. Compare to the "Painted to UI" pane below — anything that
 *      arrived but never appears there is being held by the buffer.
 *   6. Tap "Stop" when done.
 */

import { useRef, useState } from "react";

import { fetchLiveCaptionToken } from "@/lib/api";
import {
  openAssemblyAIClient,
  startPcmCapture,
  createStablePartialBuffer,
  type AssemblyAIClient,
  type PcmCaptureHandle,
  type StablePartialBuffer,
} from "@/lib/liveCaptions";

interface LogRow {
  tMs: number;
  kind: "partial" | "final" | "begin" | "termination" | "error" | "info";
  text: string;
}

export function LiveCaptionsTestPage(): React.ReactElement {
  const [rows, setRows] = useState<LogRow[]>([]);
  const [painted, setPainted] = useState<string>("");
  const [recording, setRecording] = useState(false);
  const startTimeRef = useRef<number>(0);
  const captureRef = useRef<PcmCaptureHandle | null>(null);
  const clientRef = useRef<AssemblyAIClient | null>(null);
  const bufferRef = useRef<StablePartialBuffer | null>(null);

  const append = (row: Omit<LogRow, "tMs">): void => {
    const tMs = Math.round(performance.now() - startTimeRef.current);
    setRows((prev) => [...prev, { ...row, tMs }]);
  };

  const start = async (): Promise<void> => {
    setRows([]);
    setPainted("");
    startTimeRef.current = performance.now();
    setRecording(true);
    append({ kind: "info", text: "Fetching temp token…" });

    try {
      const token = await fetchLiveCaptionToken();
      append({ kind: "info", text: "Token in hand. Opening WS…" });

      bufferRef.current = createStablePartialBuffer({
        onStable: (text) => setPainted(text),
      });

      const client = await openAssemblyAIClient({
        token: token.token,
        onUrlBuilt: (url) => {
          // Strip the token so the log can be copy-pasted safely.
          const safe = url.replace(/token=[^&]+/, "token=…");
          append({ kind: "info", text: `WS URL: ${safe}` });
        },
        handlers: {
          onBegin: (msg) => {
            append({ kind: "begin", text: `session ${msg.id}` });
          },
          onTurn: (msg) => {
            const text = msg.transcript ?? "";
            append({
              kind: msg.end_of_turn ? "final" : "partial",
              text,
            });
            if (msg.end_of_turn) {
              bufferRef.current?.clear();
              setPainted("");
            } else {
              bufferRef.current?.push(text);
            }
          },
          onTermination: (msg) => {
            append({
              kind: "termination",
              text: `audio=${msg.audio_duration_seconds}s session=${msg.session_duration_seconds}s`,
            });
          },
          onError: (err) => {
            append({ kind: "error", text: err.message });
          },
          onClose: (code, reason) => {
            append({ kind: "info", text: `WS closed (${code}) ${reason}` });
          },
        },
      });
      clientRef.current = client;
      append({ kind: "info", text: "WS open. Starting mic…" });

      const capture = await startPcmCapture({
        onChunk: (samples) => {
          clientRef.current?.sendPcm(samples);
        },
      });
      captureRef.current = capture;
      append({ kind: "info", text: "Mic open. Speak now." });
    } catch (err) {
      append({
        kind: "error",
        text: err instanceof Error ? err.message : String(err),
      });
      await teardown();
      setRecording(false);
    }
  };

  const teardown = async (): Promise<void> => {
    try {
      clientRef.current?.terminate();
    } catch {
      /* ignore */
    }
    clientRef.current = null;
    if (captureRef.current) {
      await captureRef.current.stop();
      captureRef.current = null;
    }
    bufferRef.current?.dispose();
    bufferRef.current = null;
  };

  const stop = async (): Promise<void> => {
    append({ kind: "info", text: "Stopping…" });
    await teardown();
    setRecording(false);
  };

  return (
    <div
      style={{
        font: "14px ui-sans-serif, system-ui, -apple-system",
        background: "#0b1220",
        color: "#e5e7eb",
        minHeight: "100vh",
        padding: "16px",
      }}
    >
      <h1 style={{ fontSize: 18, margin: "0 0 12px" }}>Live captions debug</h1>

      <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
        <button
          onClick={() => void (recording ? stop() : start())}
          style={{
            padding: "10px 20px",
            fontSize: 16,
            borderRadius: 8,
            border: "none",
            background: recording ? "#ef4444" : "#22c55e",
            color: "white",
            fontWeight: 600,
          }}
        >
          {recording ? "Stop" : "Start"}
        </button>
        <button
          onClick={() => setRows([])}
          disabled={recording}
          style={{
            padding: "10px 16px",
            fontSize: 14,
            borderRadius: 8,
            border: "1px solid #334155",
            background: "transparent",
            color: "#e5e7eb",
          }}
        >
          Clear log
        </button>
        <button
          onClick={() => {
            const text = rows
              .map((r) => `+${r.tMs}ms\t${r.kind}\t${r.text}`)
              .join("\n");
            void navigator.clipboard?.writeText(text);
          }}
          disabled={rows.length === 0}
          style={{
            padding: "10px 16px",
            fontSize: 14,
            borderRadius: 8,
            border: "1px solid #334155",
            background: "transparent",
            color: "#e5e7eb",
          }}
        >
          Copy log
        </button>
      </div>

      <div
        style={{
          marginBottom: 16,
          padding: 12,
          background: "#111827",
          borderRadius: 8,
          minHeight: 60,
        }}
      >
        <div
          style={{
            fontSize: 11,
            color: "#94a3b8",
            textTransform: "uppercase",
            letterSpacing: 0.5,
            marginBottom: 6,
          }}
        >
          Painted to UI (what main app shows)
        </div>
        <div style={{ fontSize: 16, lineHeight: 1.4, minHeight: 22 }}>
          {painted || <span style={{ color: "#475569" }}>(empty)</span>}
        </div>
      </div>

      <div
        style={{
          padding: 12,
          background: "#111827",
          borderRadius: 8,
        }}
      >
        <div
          style={{
            fontSize: 11,
            color: "#94a3b8",
            textTransform: "uppercase",
            letterSpacing: 0.5,
            marginBottom: 8,
          }}
        >
          Raw stream log ({rows.length} events)
        </div>
        <div style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12 }}>
          {rows.length === 0 && (
            <div style={{ color: "#475569" }}>No events yet.</div>
          )}
          {rows.map((row, i) => {
            const color =
              row.kind === "final" ? "#86efac"
                : row.kind === "partial" ? "#7dd3fc"
                : row.kind === "error" ? "#fca5a5"
                : row.kind === "begin" ? "#fde68a"
                : "#94a3b8";
            return (
              <div key={i} style={{ marginBottom: 2, color }}>
                <span style={{ display: "inline-block", width: 60, opacity: 0.6 }}>
                  +{row.tMs}ms
                </span>
                <span style={{ display: "inline-block", width: 70, opacity: 0.8 }}>
                  {row.kind}
                </span>
                <span>{row.text}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
