/**
 * Live-captions session telemetry recorder.
 *
 * One recorder per `useLiveCaptions` session. Accumulates structural
 * metrics — timing only, no transcript text — and ships them to the
 * backend in a single fire-and-forget POST when the session reaches a
 * terminal state. Powers the `/telemetry/live-captions` dashboard's
 * fallback-rate / first-partial / cadence views.
 *
 * Why a separate recorder (rather than inlining the counters into the
 * hook): keeps the hook readable, keeps the percentile math out of the
 * React component tree, and makes the unit tests trivial — drive the
 * recorder with synthesized events and assert the submitted payload
 * shape directly.
 *
 * Privacy: this module sees every partial that flows through the hook.
 * It MUST NOT keep the transcript text. The recorder only stores
 * timestamps + lengths; the only string ever sent on the wire is the
 * session ID, an outcome label, an error kind, and the user agent.
 */

import {
  reportLiveCaptionsTelemetry,
  type LiveCaptionsTelemetryPayload,
  type LiveCaptionsTelemetryOutcome,
} from "@/lib/api";

export type { LiveCaptionsTelemetryOutcome };

/** What the hook tells the recorder about each Turn message. We don't
 *  pass the transcript text — only its length, so we can record the
 *  final transcript_length without ever holding the words in memory
 *  past the hook's existing transcript state. */
interface PartialMark {
  /** `performance.now()` at the moment the message arrived. */
  at: number;
  /** Whether this was a finalised (end-of-turn) message. */
  isFinal: boolean;
}

export interface SessionTelemetryRecorder {
  /** Call when a non-empty partial / final transcript message lands. */
  markPartial: (mark: PartialMark) => void;
  /** Call once the final transcript handoff happens (or, on error /
   *  stop, with the in-hand transcript). The `chars` value seeds the
   *  payload's `transcript_length`. */
  markTranscriptLength: (chars: number) => void;
  /** Record a short error tag (e.g. `"connect_timeout"`). Overwrites
   *  prior tags — the latest one is the most actionable. */
  markErrorKind: (kind: string) => void;
  /** Terminal — ship the summary. Idempotent: repeat calls are no-ops. */
  submit: (outcome: LiveCaptionsTelemetryOutcome) => void;
  /** Snapshot the in-flight payload without submitting. Test-only;
   *  not exported through the package barrel. */
  snapshot: () => LiveCaptionsTelemetryPayload;
}

export interface SessionTelemetryOptions {
  /** Override the wall clock for tests. Defaults to `performance.now()`. */
  now?: () => number;
  /** Override the network sink for tests. Defaults to the real fetch
   *  helper in `lib/api`. */
  submit?: (payload: LiveCaptionsTelemetryPayload) => void;
  /** Override the session-ID generator for tests. Defaults to
   *  `crypto.randomUUID()` (or a fallback for the rare runtime where
   *  it isn't available). */
  generateId?: () => string;
  /** Override the user-agent string for tests. Defaults to
   *  `navigator.userAgent` capped at 512 chars (matches the backend
   *  schema's max_length). */
  userAgent?: string | null;
}

const USER_AGENT_CAP = 512;

export function createSessionTelemetryRecorder(
  options: SessionTelemetryOptions = {},
): SessionTelemetryRecorder {
  const now = options.now ?? (() => performance.now());
  const submitFn = options.submit ?? reportLiveCaptionsTelemetry;
  const generateId = options.generateId ?? _defaultGenerateId;
  const userAgent =
    options.userAgent !== undefined ? options.userAgent : _defaultUserAgent();

  const sessionId = generateId();
  const startedAt = now();
  const partialTimes: number[] = [];
  let lastFinalAt: number | null = null;
  let transcriptLength = 0;
  let errorKind: string | null = null;
  let submitted = false;

  const markPartial: SessionTelemetryRecorder["markPartial"] = ({
    at,
    isFinal,
  }) => {
    partialTimes.push(at);
    if (isFinal) lastFinalAt = at;
  };

  const markTranscriptLength: SessionTelemetryRecorder["markTranscriptLength"] = (
    chars,
  ) => {
    transcriptLength = Math.max(0, Math.floor(chars));
  };

  const markErrorKind: SessionTelemetryRecorder["markErrorKind"] = (kind) => {
    errorKind = kind.slice(0, 64);
  };

  const buildPayload = (
    outcome: LiveCaptionsTelemetryOutcome,
  ): LiveCaptionsTelemetryPayload => {
    const endedAt = now();
    const totalMs = Math.max(0, Math.round(endedAt - startedAt));
    const firstPartialMs =
      partialTimes.length > 0
        ? Math.max(0, Math.round(partialTimes[0] - startedAt))
        : null;
    const gaps = _interGaps(partialTimes);
    const p90 = gaps.length >= 3 ? _percentile(gaps, 0.9) : null;
    const maxGap = gaps.length >= 1 ? Math.max(...gaps) : null;
    return {
      session_id: sessionId,
      provider: "assemblyai",
      outcome,
      total_session_ms: totalMs,
      first_partial_ms: firstPartialMs,
      partial_count: partialTimes.length,
      p90_inter_partial_ms: p90,
      max_inter_partial_ms: maxGap,
      transcript_length: transcriptLength,
      error_kind: errorKind,
      user_agent: userAgent,
    };
  };

  const submit: SessionTelemetryRecorder["submit"] = (outcome) => {
    if (submitted) return;
    submitted = true;
    const payload = buildPayload(outcome);
    try {
      submitFn(payload);
    } catch {
      // Sink swallows failures itself; this catch is defence-in-depth
      // for a malformed override in tests. Never escalate.
    }
  };

  const snapshot: SessionTelemetryRecorder["snapshot"] = () =>
    // Default to `streamed` for the snapshot — callers use this only
    // to inspect timings, not to claim an outcome.
    buildPayload("streamed");
  // `lastFinalAt` is recorded for future use (last-partial-to-final
  // metric); referenced here so the unused-var lint stays quiet without
  // changing the public shape.
  void lastFinalAt;

  return { markPartial, markTranscriptLength, markErrorKind, submit, snapshot };
}

function _interGaps(times: number[]): number[] {
  if (times.length < 2) return [];
  const gaps: number[] = [];
  for (let i = 1; i < times.length; i++) {
    gaps.push(Math.max(0, Math.round(times[i] - times[i - 1])));
  }
  return gaps;
}

function _percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  // Nearest-rank method — fine for the small samples we ship per
  // session (a 30-second dictation is ~10 partials, so the percentile
  // is more of a directional smoke than a stats-textbook reading).
  const rank = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(p * sorted.length) - 1),
  );
  return sorted[rank];
}

function _defaultGenerateId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    /* fall through to manual generator */
  }
  // Fallback — `crypto.randomUUID` ships in every browser on our
  // persona's floor (iOS 15.4+ / Chrome 92+), but a manual generator
  // keeps unit tests in jsdom-without-crypto from blowing up.
  const r = Math.random().toString(16).slice(2, 10);
  const s = Math.random().toString(16).slice(2, 10);
  return `lc-${Date.now().toString(16)}-${r}${s}`;
}

function _defaultUserAgent(): string | null {
  try {
    if (typeof navigator !== "undefined" && navigator.userAgent) {
      return navigator.userAgent.slice(0, USER_AGENT_CAP);
    }
  } catch {
    /* fall through */
  }
  return null;
}
