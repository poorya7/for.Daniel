/**
 * AssemblyAI streaming WebSocket client.
 *
 * Opens a WS to AssemblyAI's `v3` streaming endpoint using a short-lived
 * temp token (minted by our backend at `/captures/live-token`). Pushes
 * PCM frames as binary messages; parses `Begin` / `Turn` / `Termination`
 * JSON messages and routes them to caller-supplied handlers.
 *
 * Captured docs:
 *   docs/_tests/stt_bakeoff/vendor-docs/assemblyai_streaming_getting_started.md
 *   docs/_tests/stt_bakeoff/vendor-docs/assemblyai_temporary_token.md
 *
 * Browsers can't set the `Authorization` header on a WS handshake, so the
 * token rides in the URL as a query parameter. The token is single-use
 * — each session needs its own.
 *
 * This module is transport-only. It does NOT capture audio, NOT manage
 * UI state, NOT implement the stable-partial buffer. Those live one
 * layer up in `useLiveCaptions`.
 */

// The temp-token-authed streaming endpoint lives at /v3/ws (NOT /v3 —
// that path 404s). Verified against AssemblyAI live on 2026-05-15.
// The temp-token-authed streaming endpoint lives at /v3/ws (NOT /v3 —
// that path 404s). Verified against AssemblyAI live on 2026-05-15.
const STREAMING_URL_BASE = "wss://streaming.assemblyai.com/v3/ws";
const SAMPLE_RATE = 16_000;
// Universal-3 Pro — the bakeoff winner. Engineer feedback round 3
// (2026-05-15) explicitly says: stay on `u3-rt-pro`; the alternate
// `universal-streaming-english` is an older model with a different
// accuracy profile and was a mistaken downgrade.
const SPEECH_MODEL = "u3-rt-pro";
// `continuous_partials=true` is the param we missed. From AssemblyAI's
// Universal-3 Pro docs:
//   "For long, uninterrupted turns ... silence-based partials may not
//    fire often enough ... Enable continuous_partials to receive a
//    steady stream of non-final transcripts approximately every 3
//    seconds while speech continues, regardless of silence."
// Each partial carries the full turn-so-far (replace, not append).
// `include_partial_turns=true` is set explicitly so we keep partials
// in scope if PII redaction is ever turned on (which can suppress
// them by default).
// `interruption_delay=0` minimises the early-partial gate (server-side
// minimum is ~300ms regardless of what we pass).
// `min_turn_silence=100` is the cadence the engineers asked for —
// micro-pause sensitivity is still useful as a complement to
// continuous_partials.
// `end_of_turn_confidence_threshold` is INTENTIONALLY OMITTED. It's a
// no-op for U3-Pro (which uses punctuation-based turn detection, not
// confidence-threshold), so passing it just adds noise.
const MIN_TURN_SILENCE_MS = 100;
const INTERRUPTION_DELAY_MS = 0;

/** Shape of the messages AssemblyAI sends back on the wire. */
export interface BeginMessage {
  type: "Begin";
  id: string;
  expires_at: number;
}
export interface TurnMessage {
  type: "Turn";
  transcript: string;
  end_of_turn: boolean;
}
export interface TerminationMessage {
  type: "Termination";
  audio_duration_seconds: number;
  session_duration_seconds: number;
}

export type AssemblyAIMessage = BeginMessage | TurnMessage | TerminationMessage;

export interface AssemblyAIClientHandlers {
  /** Server confirmed the session opened. Safe to start streaming audio. */
  onBegin?: (msg: BeginMessage) => void;
  /** A transcript update — partial (`end_of_turn: false`) or final (`true`). */
  onTurn: (msg: TurnMessage) => void;
  /** Server closed cleanly with audio + session duration totals. */
  onTermination?: (msg: TerminationMessage) => void;
  /** WebSocket error or unexpected protocol violation. */
  onError?: (err: Error) => void;
  /** WebSocket closed (either side). Includes the close code/reason. */
  onClose?: (code: number, reason: string) => void;
}

export interface AssemblyAIClient {
  /** Push a chunk of 16 kHz, mono, Int16 PCM. Silently no-ops if the
   *  socket isn't open yet (queued by AssemblyAI on their end is not a
   *  thing — chunks sent before `Begin` are dropped). */
  sendPcm: (samples: Int16Array) => void;
  /** Tell AssemblyAI to immediately end the current turn and emit the
   *  final transcript, without waiting for the silence timeout. Use
   *  this on user-initiated stop so the broker doesn't sit through
   *  `max_turn_silence` of dead time. */
  forceEndpoint: () => void;
  /** Send `{type:"Terminate"}` then close. Idempotent. */
  terminate: () => void;
  /** Current ready state, exposed so callers can branch on connectivity. */
  readyState: () => number;
}

/**
 * Open a streaming session.
 *
 * Resolves with the client when the WebSocket reaches `OPEN`. Rejects if
 * the handshake fails within `connectTimeoutMs` (default 1500 ms per the
 * plan's fallback section: "silently fall back to local-record-only" if
 * the WS doesn't open in 1.5 s).
 */
export function openAssemblyAIClient(args: {
  token: string;
  handlers: AssemblyAIClientHandlers;
  connectTimeoutMs?: number;
  /** Override `WebSocket` for tests. */
  WebSocketCtor?: typeof WebSocket;
  /** Called once with the fully-built WS URL — used by the debug page
   *  to surface what params actually reached the server. */
  onUrlBuilt?: (url: string) => void;
}): Promise<AssemblyAIClient> {
  const {
    token,
    handlers,
    connectTimeoutMs = 1500,
    WebSocketCtor = WebSocket,
  } = args;

  const url =
    `${STREAMING_URL_BASE}` +
    `?token=${encodeURIComponent(token)}` +
    `&speech_model=${SPEECH_MODEL}` +
    `&sample_rate=${SAMPLE_RATE}` +
    `&continuous_partials=true` +
    `&include_partial_turns=true` +
    `&format_turns=true` +
    `&interruption_delay=${INTERRUPTION_DELAY_MS}` +
    `&min_turn_silence=${MIN_TURN_SILENCE_MS}`;
  args.onUrlBuilt?.(url);
  const ws = new WebSocketCtor(url);
  ws.binaryType = "arraybuffer";

  return new Promise<AssemblyAIClient>((resolve, reject) => {
    let settled = false;
    let terminated = false;

    const connectTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        /* already closing */
      }
      reject(new Error("AssemblyAI connection timed out"));
    }, connectTimeoutMs);

    ws.onopen = () => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      resolve({
        sendPcm: (samples: Int16Array) => {
          if (ws.readyState !== WebSocketCtor.OPEN) return;
          ws.send(samples.buffer);
        },
        forceEndpoint: () => {
          if (ws.readyState !== WebSocketCtor.OPEN) return;
          try {
            ws.send(JSON.stringify({ type: "ForceEndpoint" }));
          } catch {
            /* socket already closing — final won't fire, caller falls back */
          }
        },
        terminate: () => {
          if (terminated) return;
          terminated = true;
          try {
            if (ws.readyState === WebSocketCtor.OPEN) {
              ws.send(JSON.stringify({ type: "Terminate" }));
            }
          } catch {
            /* socket may already be closing */
          }
          try {
            ws.close();
          } catch {
            /* idem */
          }
        },
        readyState: () => ws.readyState,
      });
    };

    ws.onmessage = (event: MessageEvent) => {
      // We only emit JSON text frames; audio is one-way. Anything binary
      // here would be a protocol violation — surface as an error so the
      // app can drop to the fallback path.
      if (typeof event.data !== "string") {
        handlers.onError?.(new Error("Unexpected binary frame from AssemblyAI"));
        return;
      }
      try {
        const parsed = JSON.parse(event.data) as AssemblyAIMessage;
        switch (parsed.type) {
          case "Begin":
            handlers.onBegin?.(parsed);
            break;
          case "Turn":
            handlers.onTurn(parsed);
            break;
          case "Termination":
            handlers.onTermination?.(parsed);
            break;
          default:
            // Unknown message types are non-fatal — AssemblyAI may add
            // new ones server-side. Ignore so we don't break on upgrade.
            break;
        }
      } catch (err) {
        handlers.onError?.(
          err instanceof Error ? err : new Error("Malformed JSON from AssemblyAI"),
        );
      }
    };

    ws.onerror = () => {
      // The DOM `error` event doesn't carry meaningful detail. Wrap as
      // a generic Error so the caller's handler sees a consistent shape.
      handlers.onError?.(new Error("AssemblyAI WebSocket error"));
      if (!settled) {
        settled = true;
        clearTimeout(connectTimer);
        reject(new Error("AssemblyAI WebSocket error"));
      }
    };

    ws.onclose = (event: CloseEvent) => {
      handlers.onClose?.(event.code, event.reason);
      if (!settled) {
        settled = true;
        clearTimeout(connectTimer);
        reject(
          new Error(`AssemblyAI WebSocket closed before open (code ${event.code})`),
        );
      }
    };
  });
}
