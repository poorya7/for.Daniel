import { describe, expect, it, vi } from "vitest";

import { createSessionTelemetryRecorder } from "./sessionTelemetry";

function makeRecorder(): {
  submit: ReturnType<typeof vi.fn>;
  clock: () => number;
  setNow: (ms: number) => void;
  recorder: ReturnType<typeof createSessionTelemetryRecorder>;
} {
  let now = 0;
  const clock = (): number => now;
  const setNow = (ms: number): void => {
    now = ms;
  };
  const submit = vi.fn();
  const recorder = createSessionTelemetryRecorder({
    now: clock,
    submit,
    generateId: () => "test-session-deterministic-id-1234",
    userAgent: "Test/1.0",
  });
  return { submit, clock, setNow, recorder };
}

describe("createSessionTelemetryRecorder", () => {
  it("ships a clean record for a no-event stopped session", () => {
    const { submit, setNow, recorder } = makeRecorder();
    setNow(2_500);
    recorder.submit("stopped");

    expect(submit).toHaveBeenCalledTimes(1);
    const payload = submit.mock.calls[0][0];
    expect(payload).toMatchObject({
      session_id: "test-session-deterministic-id-1234",
      provider: "assemblyai",
      outcome: "stopped",
      total_session_ms: 2_500,
      first_partial_ms: null,
      partial_count: 0,
      p90_inter_partial_ms: null,
      max_inter_partial_ms: null,
      transcript_length: 0,
      error_kind: null,
      user_agent: "Test/1.0",
    });
  });

  it("computes first_partial_ms, partial_count, and gap percentiles", () => {
    const { submit, setNow, recorder } = makeRecorder();

    // Simulate the typical cadence: first partial at ~750ms, then
    // continuous partials roughly every 3s, plus a final at the end.
    setNow(800);
    recorder.markPartial({ at: 800, isFinal: false });
    setNow(3_900);
    recorder.markPartial({ at: 3_900, isFinal: false });
    setNow(7_050);
    recorder.markPartial({ at: 7_050, isFinal: false });
    setNow(10_400);
    recorder.markPartial({ at: 10_400, isFinal: false });
    setNow(12_000);
    recorder.markPartial({ at: 12_000, isFinal: true });

    recorder.markTranscriptLength(135);
    setNow(12_400);
    recorder.submit("streamed");

    const payload = submit.mock.calls[0][0];
    expect(payload.outcome).toBe("streamed");
    expect(payload.first_partial_ms).toBe(800);
    expect(payload.partial_count).toBe(5);
    expect(payload.transcript_length).toBe(135);
    expect(payload.total_session_ms).toBe(12_400);
    // Gaps: 3100, 3150, 3350, 1600 → max 3350, P90 nearest-rank = 3350.
    expect(payload.max_inter_partial_ms).toBe(3_350);
    expect(payload.p90_inter_partial_ms).toBe(3_350);
  });

  it("returns null percentile for too-small samples", () => {
    const { submit, recorder } = makeRecorder();
    recorder.markPartial({ at: 100, isFinal: false });
    recorder.markPartial({ at: 600, isFinal: true });
    recorder.submit("streamed");

    const payload = submit.mock.calls[0][0];
    // Two partials = one gap → not enough for a percentile.
    expect(payload.p90_inter_partial_ms).toBeNull();
    // But max is meaningful with just one gap.
    expect(payload.max_inter_partial_ms).toBe(500);
  });

  it("is idempotent across repeat submit calls", () => {
    const { submit, recorder } = makeRecorder();
    recorder.submit("stopped");
    recorder.submit("error");
    recorder.submit("streamed");

    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0][0].outcome).toBe("stopped");
  });

  it("caps error_kind at 64 chars", () => {
    const { submit, recorder } = makeRecorder();
    const tag = "x".repeat(200);
    recorder.markErrorKind(tag);
    recorder.submit("error");

    expect(submit.mock.calls[0][0].error_kind).toHaveLength(64);
  });

  it("never panics if the sink throws", () => {
    const submit = vi.fn(() => {
      throw new Error("network down");
    });
    const recorder = createSessionTelemetryRecorder({
      now: () => 0,
      submit,
      generateId: () => "test-session-deterministic-id-1234",
      userAgent: null,
    });

    expect(() => recorder.submit("error")).not.toThrow();
  });
});
