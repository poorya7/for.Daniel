/**
 * `useLiveCaptions` — orchestrates token fetch + mic capture + AssemblyAI
 * streaming WebSocket, exposing a transcript state for UI consumption.
 *
 * The lifecycle is caller-driven (start / finalize / stop), NOT mount-driven —
 * the VoicePhase component calls `start()` when recording begins,
 * `finalize()` when the user taps stop (graceful: waits for AssemblyAI's
 * pending turn to flush so the resulting transcript is complete), and
 * `stop()` for hard teardown (sheet close, unmount).
 *
 * Partial-flicker suppression:
 *   Incoming partials run through a `createStablePartialBuffer` — a
 *   new partial is held unrendered for ~200 ms; if a revised partial
 *   arrives within that window, the previous one never paints. Only
 *   hypotheses that settle for the full window reach the screen.
 *   Finalised turns (`end_of_turn: true`) bypass the buffer.
 *
 * Failure model:
 *   * Token fetch fails (404 = flag off, 503 = no key, network) →
 *     `status = "error"`, caller falls back to MediaRecorder-only.
 *   * WS handshake times out within 1.5 s → same.
 *   * WS drops mid-session → `status = "error"`; partials already
 *     displayed remain visible.
 *   * Any successful turn flips `status` to `"streaming"`.
 *
 * All errors are logged to the console for now; structured telemetry
 * lands when the broader telemetry pass arrives (see plan §Telemetry).
 */

import { useCallback, useRef, useState } from "react";

import { fetchLiveCaptionToken } from "@/lib/api";

import {
  openAssemblyAIClient,
  type AssemblyAIClient,
} from "./assemblyaiClient";
import { startPcmCapture, type PcmCaptureHandle } from "./audioCapture";
import {
  createSessionTelemetryRecorder,
  type SessionTelemetryRecorder,
} from "./sessionTelemetry";
import {
  createStablePartialBuffer,
  type StablePartialBuffer,
} from "./stablePartialBuffer";

export type LiveCaptionStatus =
  | "idle"
  | "connecting"
  | "streaming"
  | "error"
  | "stopped";

export interface LiveCaptionTranscript {
  /** Turns the server has finalised (`end_of_turn: true`), oldest first. */
  finalized: string[];
  /** The current in-flight partial turn — replaced as new partials arrive. */
  partial: string;
}

export interface UseLiveCaptionsResult {
  status: LiveCaptionStatus;
  transcript: LiveCaptionTranscript;
  /** Open mic + WS, begin streaming captions. Idempotent — calling twice
   *  while already streaming is a no-op. */
  start: () => Promise<void>;
  /** Hard teardown — WS + mic + buffers, no waiting. Use for sheet close
   *  / unmount where the transcript isn't going to be used. Idempotent. */
  stop: () => void;
  /** Graceful shutdown — send Terminate, wait up to `flushTimeoutMs` for
   *  AssemblyAI's final Turn + Termination, return the concatenated
   *  transcript (finalised turns + any trailing partial). Then teardown.
   *  Returns "" if no transcript ever arrived (caller falls back to the
   *  batch Whisper path). Idempotent — repeat calls resolve to "". */
  finalize: (flushTimeoutMs?: number) => Promise<string>;
}

const EMPTY_TRANSCRIPT: LiveCaptionTranscript = {
  finalized: [],
  partial: "",
};

const DEFAULT_FLUSH_TIMEOUT_MS = 1500;

function joinTranscript(t: LiveCaptionTranscript): string {
  const finalized = t.finalized.join(" ").trim();
  const partial = t.partial.trim();
  if (finalized && partial) return `${finalized} ${partial}`.trim();
  return finalized || partial;
}

export function useLiveCaptions(): UseLiveCaptionsResult {
  const [status, setStatus] = useState<LiveCaptionStatus>("idle");
  const [transcript, setTranscript] =
    useState<LiveCaptionTranscript>(EMPTY_TRANSCRIPT);

  // Mutable refs hold the active resources so the cleanup path doesn't
  // need to chase them through React state. State holds the user-visible
  // values; refs hold the connection plumbing.
  const captureRef = useRef<PcmCaptureHandle | null>(null);
  const clientRef = useRef<AssemblyAIClient | null>(null);
  const stoppingRef = useRef(false);
  const partialBufferRef = useRef<StablePartialBuffer | null>(null);
  // Shadow the transcript state so finalize() can read the latest value
  // synchronously without setState-as-getter contortions.
  const transcriptRef = useRef<LiveCaptionTranscript>(EMPTY_TRANSCRIPT);
  // Resolver wired up by finalize() — when AssemblyAI sends Termination
  // (or the WS closes), we call this to release the awaiting caller.
  const flushResolverRef = useRef<(() => void) | null>(null);
  // Per-session telemetry recorder. Created in start(); submitted in
  // the terminal paths (finalize / error / hard stop). Best-effort —
  // the recorder owns its own failure handling, no impact on UX.
  const telemetryRef = useRef<SessionTelemetryRecorder | null>(null);

  const writeTranscript = useCallback(
    (
      updater: (prev: LiveCaptionTranscript) => LiveCaptionTranscript,
    ): void => {
      setTranscript((prev) => {
        const next = updater(prev);
        transcriptRef.current = next;
        return next;
      });
    },
    [],
  );

  const teardown = useCallback(() => {
    stoppingRef.current = true;
    const client = clientRef.current;
    const capture = captureRef.current;
    const buffer = partialBufferRef.current;
    clientRef.current = null;
    captureRef.current = null;
    partialBufferRef.current = null;
    buffer?.dispose();
    try {
      client?.terminate();
    } catch {
      /* socket already closing */
    }
    if (capture) {
      void capture.stop();
    }
  }, []);

  const start = useCallback(async () => {
    if (clientRef.current || captureRef.current) {
      return;
    }
    stoppingRef.current = false;
    setStatus("connecting");
    writeTranscript(() => EMPTY_TRANSCRIPT);

    partialBufferRef.current = createStablePartialBuffer({
      onStable: (text) => {
        writeTranscript((prev) => ({ finalized: prev.finalized, partial: text }));
      },
    });
    telemetryRef.current = createSessionTelemetryRecorder();

    try {
      const tokenResponse = await fetchLiveCaptionToken();
      if (stoppingRef.current) return;

      const client = await openAssemblyAIClient({
        token: tokenResponse.token,
        handlers: {
          onBegin: () => {
            setStatus("streaming");
          },
          onTurn: (msg) => {
            const text = msg.transcript ?? "";
            // Record the message's arrival timing for telemetry. Empty
            // partials (the server emits these as warmup pings) don't
            // count — they'd skew first-partial latency and cadence
            // toward "instant" without representing actual transcript.
            if (text) {
              telemetryRef.current?.markPartial({
                at: performance.now(),
                isFinal: msg.end_of_turn,
              });
            }
            if (msg.end_of_turn) {
              partialBufferRef.current?.clear();
              writeTranscript((prev) => ({
                finalized: text ? [...prev.finalized, text] : prev.finalized,
                partial: "",
              }));
              return;
            }
            partialBufferRef.current?.push(text);
          },
          onTermination: () => {
            // Server flushed cleanly — release any caller waiting in
            // finalize(). The actual teardown happens after they read
            // the transcript via the awaited promise.
            flushResolverRef.current?.();
            flushResolverRef.current = null;
          },
          onError: (err) => {
            console.warn("liveCaptions.assemblyai.error", err);
            setStatus("error");
            const recorder = telemetryRef.current;
            telemetryRef.current = null;
            if (recorder) {
              recorder.markErrorKind("ws_error");
              recorder.submit("error");
            }
            // Surface the error to a waiting finalize() — it'll take
            // whatever transcript is in hand rather than hang.
            flushResolverRef.current?.();
            flushResolverRef.current = null;
          },
          onClose: () => {
            setStatus((prev) => (prev === "error" ? prev : "stopped"));
            // Close without prior Termination (network blip, etc.) also
            // releases finalize() — same "use what we have" outcome.
            flushResolverRef.current?.();
            flushResolverRef.current = null;
          },
        },
      });

      if (stoppingRef.current) {
        client.terminate();
        return;
      }
      clientRef.current = client;

      const capture = await startPcmCapture({
        onChunk: (samples) => {
          clientRef.current?.sendPcm(samples);
        },
      });

      if (stoppingRef.current) {
        await capture.stop();
        return;
      }
      captureRef.current = capture;
    } catch (err) {
      console.warn("liveCaptions.start.failed", err);
      setStatus("error");
      // Tag the error kind from common failure shapes so the dashboard
      // can split "token mint failed" from "WS handshake timed out"
      // from "everything else."
      const recorder = telemetryRef.current;
      telemetryRef.current = null;
      if (recorder) {
        recorder.markErrorKind(_classifyStartError(err));
        recorder.submit("error");
      }
      teardown();
    }
  }, [teardown, writeTranscript]);

  const stop = useCallback(() => {
    teardown();
    // Claim the recorder atomically so a concurrent finalize() can't
    // double-submit. Whichever path nulls the ref first wins; the other
    // sees null and skips. Sheet-close + user-stop can both arrive in
    // the same tick on iOS Safari, so this matters.
    const recorder = telemetryRef.current;
    telemetryRef.current = null;
    recorder?.submit("stopped");
    setStatus((prev) => (prev === "error" ? prev : "stopped"));
  }, [teardown]);

  const finalize = useCallback(
    async (flushTimeoutMs: number = DEFAULT_FLUSH_TIMEOUT_MS): Promise<string> => {
      const client = clientRef.current;
      // Claim the recorder atomically up-front. A concurrent stop()
      // from the effect-cleanup will then see null and won't race us
      // to submit a "stopped" outcome before finalize ships the real
      // "streamed" / "empty" one.
      const recorder = telemetryRef.current;
      telemetryRef.current = null;
      // No active session — there's nothing to flush. Return whatever
      // text might already be in state (typically empty).
      if (!client) {
        const text = joinTranscript(transcriptRef.current);
        if (recorder) {
          recorder.markTranscriptLength(text.length);
          recorder.submit(text ? "streamed" : "empty");
        }
        return text;
      }

      // Stop the mic FIRST so no new audio races the Terminate signal.
      // The AssemblyAI session stays open until the server flushes;
      // teardown happens after we resolve below.
      const capture = captureRef.current;
      captureRef.current = null;
      if (capture) {
        await capture.stop().catch(() => undefined);
      }

      // Force AssemblyAI to emit the final transcript NOW (saves up to
      // max_turn_silence of waiting). Then race the server's final
      // Turn / Termination event against a hard timeout — either way
      // we walk away with whatever transcript is in hand. The timeout
      // is the upper bound on stop latency from the user's perspective.
      await new Promise<void>((resolve) => {
        const timeoutId = window.setTimeout(() => {
          flushResolverRef.current = null;
          resolve();
        }, flushTimeoutMs);
        flushResolverRef.current = () => {
          window.clearTimeout(timeoutId);
          resolve();
        };
        try {
          client.forceEndpoint();
          client.terminate();
        } catch {
          // Already closing — the resolver will fire from onClose if
          // we wired one, else the timeout will catch us.
        }
      });

      // Wait one tick so any final setTranscript from a late Turn
      // message lands in transcriptRef before we read it.
      await Promise.resolve();

      const text = joinTranscript(transcriptRef.current);
      // Now safe to fully tear down.
      clientRef.current = null;
      const buffer = partialBufferRef.current;
      partialBufferRef.current = null;
      buffer?.dispose();
      // Ship the session summary. `streamed` when text actually
      // reached the caller, `empty` when the WS ran but produced no
      // transcript — the downstream consumer will fall back to the
      // Whisper batch path in that case, which is exactly the signal
      // the dashboard wants to count as a fallback.
      if (recorder) {
        recorder.markTranscriptLength(text.length);
        recorder.submit(text ? "streamed" : "empty");
      }
      setStatus((prev) => (prev === "error" ? prev : "stopped"));
      return text;
    },
    [],
  );

  return { status, transcript, start, stop, finalize };
}

function _classifyStartError(err: unknown): string {
  // Short, low-cardinality tags so the dashboard can split common
  // failure modes without explosion. The hook's own console.warn
  // still carries the full message for live debugging.
  const message = err instanceof Error ? err.message : String(err ?? "");
  const lower = message.toLowerCase();
  if (lower.includes("timed out")) return "connect_timeout";
  if (lower.includes("websocket")) return "ws_handshake_failed";
  // ApiError messages from fetchLiveCaptionToken — surface the path
  // distinctly so a server-side regression doesn't mask as a client bug.
  if (lower.includes("no internet")) return "network";
  if (lower.includes("aren't") || lower.includes("captions")) {
    return "token_fetch_failed";
  }
  return "unexpected";
}
