/**
 * Audio capture wrapper — turns a mic stream into a flow of 16 kHz Int16
 * PCM chunks via the `pcm-capture-worklet` AudioWorklet.
 *
 * Lifecycle:
 *   1. `await startPcmCapture({ onChunk, ... })` — prompts for mic
 *      access (if not already granted), spins up an AudioContext,
 *      attaches the worklet, and begins emitting chunks.
 *   2. `stop()` (returned from `startPcmCapture`) — disconnects every
 *      node, closes the AudioContext, releases the mic.
 *
 * The chunk callback is invoked from the main thread (the worklet
 * MessagePort posts onto the main thread's event loop). Keep work in
 * the callback cheap — typical use is `ws.send(chunk.buffer)` and
 * nothing else.
 */

import workletUrl from "./pcm-capture-worklet.js?url";

export interface PcmCaptureHandle {
  /** Tear everything down: worklet → source → context → mic tracks. Idempotent. */
  stop: () => Promise<void>;
  /** The active MediaStream, exposed so callers can wire a parallel
   *  MediaRecorder for the batch fallback path without re-requesting
   *  mic access (which would re-prompt on iOS). */
  mediaStream: MediaStream;
}

export interface PcmCaptureOptions {
  /** Called with every 50 ms (800-sample) Int16 PCM chunk produced by
   *  the worklet. Runs on the main thread; keep it light. */
  onChunk: (samples: Int16Array) => void;
  /** Optional override of `getUserMedia` for tests. */
  getUserMedia?: (
    constraints: MediaStreamConstraints,
  ) => Promise<MediaStream>;
}

export async function startPcmCapture(
  options: PcmCaptureOptions,
): Promise<PcmCaptureHandle> {
  const getUserMedia =
    options.getUserMedia ??
    ((c) => navigator.mediaDevices.getUserMedia(c));

  // Mono audio, no echo cancellation tweaks — the broker's environment
  // (open house) wants the room sound captured, not "phone-call" -style
  // processing that would chew up quiet speech.
  const stream = await getUserMedia({ audio: true, video: false });

  // The browser picks the AudioContext's sample rate from the input
  // device — typically 48000 on desktop, 44100 or 48000 on mobile. The
  // worklet handles downsampling to 16000.
  const AudioContextCtor: typeof AudioContext =
    window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext!;
  const ctx = new AudioContextCtor();

  try {
    await ctx.audioWorklet.addModule(workletUrl);
  } catch (err) {
    // If the worklet can't load (older browser, file 404, etc.) we
    // can't capture PCM at all. Surface the error after releasing the
    // mic so the caller can fall back to MediaRecorder cleanly.
    stream.getTracks().forEach((t) => t.stop());
    await ctx.close().catch(() => undefined);
    throw err;
  }

  const sourceNode = ctx.createMediaStreamSource(stream);
  const workletNode = new AudioWorkletNode(ctx, "pcm-capture-processor");

  workletNode.port.onmessage = (event: MessageEvent<{ type: string; samples: Int16Array }>) => {
    if (event.data?.type === "pcm" && event.data.samples) {
      options.onChunk(event.data.samples);
    }
  };

  sourceNode.connect(workletNode);
  // The worklet has no audible output — we do NOT connect it to
  // ctx.destination, which would route the user's voice back to the
  // speakers and cause feedback.

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    try {
      workletNode.port.onmessage = null;
      workletNode.disconnect();
    } catch {
      /* node may already be disconnected */
    }
    try {
      sourceNode.disconnect();
    } catch {
      /* idem */
    }
    stream.getTracks().forEach((t) => t.stop());
    await ctx.close().catch(() => undefined);
  };

  return { stop, mediaStream: stream };
}
