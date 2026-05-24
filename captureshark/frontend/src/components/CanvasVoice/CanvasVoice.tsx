/**
 * CanvasVoice — voice-capture surface for the no-panel canvas.
 *
 * Ported from `components/CaptureSheet/VoicePhase.tsx` with the
 * legacy timings and recording state machine preserved, animations
 * deliberately omitted (this is the structural slice — motion lands
 * in the post-migration polish pass). The dark stacked consent
 * modal from the legacy is replaced with an inline consent card
 * that occupies the same hero slot as the mic UI — no scrim, cream
 * surface, matches the no-panel philosophy.
 *
 * State machine (mirrors legacy 1:1):
 *   idle       → ready, mic not open
 *   requesting → waiting on getUserMedia / MediaRecorder init
 *   recording  → MediaRecorder is capturing audio
 *   denied     → mic permission refused
 *   error      → mic / recorder init failed
 *
 * On stop with a non-empty blob over the 700ms floor, the parent's
 * `onCaptured(blob)` runs the upload + extraction stream and flips
 * the canvas phase to review. Caps + silence give-up + intentional-
 * stop tracking are all ported from the legacy.
 */

import { useEffect, useRef, useState, type ReactElement } from "react";

import { hasVoiceConsent, recordVoiceConsent } from "@/lib/voiceConsent";

import "./CanvasVoice.css";

// 60s hard cap — anything past this is almost certainly a stuck mic
// or a confused user. Auto-stops and lets the broker start over.
const MAX_RECORDING_MS = 60_000;

// 0.7s floor — below this the tap was accidental. Suppress the
// capture, bounce back to idle with a calm hint.
const MIN_RECORDING_MS = 700;

// 15s of continuous silence → Siri-style graceful give-up. Bails
// the phase entirely so a forgotten mic doesn't sit hot.
const SILENCE_TIMEOUT_MS = 15_000;

// Per-sample deviation from 128 (8-bit time-domain PCM midpoint).
// 12 cleanly separates speech from ambient on every device we've
// tested; lift if real users in noisy rooms trip the gate.
const SILENCE_AMPLITUDE_THRESHOLD = 12;

// Poll cadence for the silence detector + elapsed-seconds ticker.
const SILENCE_POLL_MS = 250;

type RecState =
  | { kind: "idle" }
  | { kind: "requesting" }
  | { kind: "recording"; startedAt: number }
  | { kind: "denied" }
  | { kind: "error"; message: string };

interface CanvasVoiceProps {
  /** True when this surface is the active phase on the canvas. The
   *  component tears down any in-flight recording the moment this
   *  flips false (matches the legacy `sheetOpen` discipline). */
  active: boolean;
  /** Fired the instant the broker taps Stop on a recording over the
   *  MIN floor. Parent owns the upload + extraction stream + phase
   *  transition to review. */
  onCaptured: (audio: Blob) => void;
  /** Fired when the phase decides to give up on its own (silence
   *  timeout) — parent returns the broker to home. */
  onClose: () => void;
  /** Fired when the broker dismisses the consent card (tap "Maybe
   *  later"). Parent returns the broker to home. Consent is NOT
   *  persisted on dismiss — the next voice tap shows the card again. */
  onConsentDismiss: () => void;
}

export function CanvasVoice({
  active,
  onCaptured,
  onClose,
  onConsentDismiss,
}: CanvasVoiceProps): ReactElement {
  const [state, setState] = useState<RecState>({ kind: "idle" });
  const [elapsedSec, setElapsedSec] = useState(0);
  // First-time consent gate. Read once on mount; flipped optimistically
  // when the broker taps "Got it" so the auto-start fires within the
  // same user-gesture frame the consent was accepted in.
  const [consentGiven, setConsentGiven] = useState<boolean>(() =>
    hasVoiceConsent(),
  );
  // Calm bounce-back hint for the sub-MIN_RECORDING_MS case. Set when
  // the recorder stops too soon; cleared the moment a fresh recording
  // actually starts.
  const [rejectedTooShort, setRejectedTooShort] = useState(false);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  // True the moment we explicitly call recorder.stop() (user tap or
  // 60s cap). Browsers can fire onstop on their own (iOS Safari closes
  // the audio input after silence); without this flag those silent
  // blobs would ship to extraction and the broker would mystery-exit
  // mid-pause.
  const intentionalStopRef = useRef(false);
  const audioContextRef = useRef<AudioContext | null>(null);
  const silenceIntervalRef = useRef<number | null>(null);
  // Stable refs for callbacks the recorder's onstop closure needs.
  const onCapturedRef = useRef(onCaptured);
  useEffect(() => {
    onCapturedRef.current = onCaptured;
  }, [onCaptured]);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  // Tear down recording the moment the phase becomes inactive. Without
  // this the mic light stays on if the broker navigates away mid-flight.
  //
  // The teardown is deferred to the next macrotask so the phase-swap
  // paint lands FIRST. `track.stop()` can stall the main thread for
  // ~100ms on iOS Safari, and if we ran it synchronously here the
  // broker would see the voice panel freeze on screen during that
  // window — exactly the "laggy / hiccupy" feel we're avoiding.
  // setTimeout(0) hands control back to the browser so the cream
  // home phase paints, then the mic teardown happens off-screen.
  useEffect(() => {
    if (!(!active && state.kind === "recording")) return undefined;
    const id = window.setTimeout(() => {
      _teardownAnalyser();
      _stopTracks(streamRef.current);
      streamRef.current = null;
      recorderRef.current = null;
      chunksRef.current = [];
      setState({ kind: "idle" });
    }, 0);
    return () => {
      window.clearTimeout(id);
    };
  }, [active, state.kind]);

  // Reset to idle whenever the phase re-activates so a stale error /
  // denied state doesn't greet the broker on their next try.
  useEffect(() => {
    if (active) {
      setState((s) =>
        s.kind === "recording" || s.kind === "requesting"
          ? s
          : { kind: "idle" },
      );
      setElapsedSec(0);
    }
  }, [active]);

  // Auto-start recording once the phase is active and consent is on
  // file. One tap (Voice button on home) instead of two (Voice +
  // Start). The user-gesture token from the home tap propagates
  // through React's commit into this effect, which iOS Safari
  // accepts for getUserMedia.
  useEffect(() => {
    if (!(active && consentGiven && state.kind === "idle")) return;
    void _start();
    // _start is a fresh function on every render; including it would
    // cause an infinite re-run. Effect intentionally fires off the
    // three orthogonal flags only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, consentGiven, state.kind]);

  // Tick the elapsed-seconds counter while recording. Math.floor over
  // ceil — display reads "0:00" the moment recording starts, not "0:01".
  useEffect(() => {
    if (state.kind !== "recording") return;
    const id = window.setInterval(() => {
      setElapsedSec(Math.floor((Date.now() - state.startedAt) / 1000));
    }, SILENCE_POLL_MS);
    return () => {
      window.clearInterval(id);
    };
  }, [state]);

  // Hard 60s cap — auto-stop the moment we cross it.
  useEffect(() => {
    if (state.kind !== "recording") return;
    const id = window.setTimeout(() => {
      _stop();
    }, MAX_RECORDING_MS);
    return () => {
      window.clearTimeout(id);
    };
  }, [state]);

  // Lock-screen / tab-switch — iOS Safari kills the mic stream on
  // visibilitychange:hidden. Race the OS by calling _stop() the
  // moment we see hidden, preserving whatever was captured up to
  // that point.
  useEffect(() => {
    if (state.kind !== "recording") return;
    const handle = (): void => {
      if (document.visibilityState === "hidden") {
        _stop();
      }
    };
    document.addEventListener("visibilitychange", handle);
    return () => {
      document.removeEventListener("visibilitychange", handle);
    };
  }, [state.kind]);

  async function _start(): Promise<void> {
    setRejectedTooShort(false);
    setState({ kind: "requesting" });
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      const denied =
        err instanceof DOMException &&
        (err.name === "NotAllowedError" ||
          err.name === "PermissionDeniedError");
      setState(
        denied
          ? { kind: "denied" }
          : { kind: "error", message: "Couldn't open the mic." },
      );
      return;
    }

    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream);
    } catch {
      _stopTracks(stream);
      setState({
        kind: "error",
        message: "This browser can't record audio.",
      });
      return;
    }

    chunksRef.current = [];
    intentionalStopRef.current = false;
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunksRef.current.push(event.data);
    };
    const startedAt = Date.now();
    recorder.onstop = () => {
      const wasIntentional = intentionalStopRef.current;
      intentionalStopRef.current = false;
      const durationMs = Date.now() - startedAt;
      const type = recorder.mimeType || "audio/webm";
      const blob = new Blob(chunksRef.current, { type });
      chunksRef.current = [];
      _teardownAnalyser();
      _stopTracks(streamRef.current);
      streamRef.current = null;
      recorderRef.current = null;
      setState({ kind: "idle" });
      setElapsedSec(0);
      if (!wasIntentional) return;
      if (blob.size === 0) return;
      if (durationMs < MIN_RECORDING_MS) {
        setRejectedTooShort(true);
        return;
      }
      onCapturedRef.current(blob);
    };

    recorderRef.current = recorder;
    streamRef.current = stream;
    recorder.start();
    setState({ kind: "recording", startedAt });
    _startSilenceDetector(stream);
  }

  function _stop(): void {
    const r = recorderRef.current;
    if (r && r.state === "recording") {
      intentionalStopRef.current = true;
      r.stop();
    }
  }

  function _teardownAnalyser(): void {
    if (silenceIntervalRef.current !== null) {
      window.clearInterval(silenceIntervalRef.current);
      silenceIntervalRef.current = null;
    }
    if (audioContextRef.current !== null) {
      void audioContextRef.current.close().catch(() => {
        /* swallow — context may already be closed */
      });
      audioContextRef.current = null;
    }
  }

  function _startSilenceDetector(stream: MediaStream): void {
    let audioCtx: AudioContext;
    try {
      // Modern browsers (including iOS 14.5+) ship AudioContext as
      // standard. Strict-privacy modes can still throw on construction;
      // the 60s hard cap is the fallback when this branch bails.
      audioCtx = new AudioContext();
    } catch {
      return;
    }
    try {
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      audioContextRef.current = audioCtx;
      const buffer = new Uint8Array(analyser.fftSize);
      let lastAudioAt = Date.now();
      silenceIntervalRef.current = window.setInterval(() => {
        analyser.getByteTimeDomainData(buffer);
        let peak = 0;
        for (let i = 0; i < buffer.length; i++) {
          const dev = Math.abs((buffer[i] ?? 128) - 128);
          if (dev > peak) peak = dev;
        }
        if (peak > SILENCE_AMPLITUDE_THRESHOLD) {
          lastAudioAt = Date.now();
          return;
        }
        if (Date.now() - lastAudioAt > SILENCE_TIMEOUT_MS) {
          _teardownAnalyser();
          onCloseRef.current();
        }
      }, SILENCE_POLL_MS);
    } catch {
      // Strict-privacy mode can block AudioContext creation. The 60s
      // hard cap still catches abandoned mics.
    }
  }

  function _stopTracks(stream: MediaStream | null): void {
    if (!stream) return;
    for (const track of stream.getTracks()) {
      track.stop();
    }
  }

  function _onAcceptConsent(): void {
    recordVoiceConsent();
    setConsentGiven(true);
  }

  // --- Render --------------------------------------------------------

  if (!consentGiven) {
    return (
      <div className="canvas-voice">
        <div className="canvas-voice__consent">
          <p className="canvas-voice__consent-title">Just so you know</p>
          <p className="canvas-voice__consent-body">
            We send your audio to an AI in the US to turn it into text.
            They don&apos;t keep it.
          </p>
          <button
            type="button"
            className="canvas-voice__primary"
            onClick={_onAcceptConsent}
          >
            Got it
          </button>
          <button
            type="button"
            className="canvas-voice__secondary"
            onClick={onConsentDismiss}
          >
            Maybe later
          </button>
        </div>
      </div>
    );
  }

  if (state.kind === "denied" || state.kind === "error") {
    return (
      <div className="canvas-voice">
        <p className="canvas-voice__eyebrow">Mic unavailable</p>
        <p className="canvas-voice__hint">
          {state.kind === "denied"
            ? "Mic access was blocked. Open browser settings to allow it, then try again."
            : state.message}
        </p>
        <button
          type="button"
          className="canvas-voice__primary"
          onClick={() => {
            void _start();
          }}
        >
          Try again
        </button>
      </div>
    );
  }

  const isRecording = state.kind === "recording";

  return (
    <div className="canvas-voice">
      <p className="canvas-voice__eyebrow">Voice note</p>
      <div className="canvas-voice__stage" aria-hidden="true">
        <div
          className={
            "canvas-voice__pulse" +
            (isRecording ? " canvas-voice__pulse--recording" : "")
          }
        />
        <p className="canvas-voice__elapsed">{_formatElapsed(elapsedSec)}</p>
      </div>
      <p className="canvas-voice__hint">
        {rejectedTooShort
          ? "Speak a moment, then tap Extract."
          : isRecording
            ? "Speak naturally — tap Extract when you’re done."
            : "Opening the mic…"}
      </p>
      <button
        type="button"
        className="canvas-voice__primary"
        disabled={!isRecording}
        onClick={() => {
          _stop();
        }}
      >
        Extract
      </button>
    </div>
  );
}

function _formatElapsed(totalSec: number): string {
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m)}:${s < 10 ? `0${String(s)}` : String(s)}`;
}
