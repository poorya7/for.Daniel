import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clearVoiceConsent,
  hasVoiceConsent,
  readVoiceConsent,
  recordVoiceConsent,
} from "./voiceConsent";

describe("voiceConsent", () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    localStorage.clear();
  });

  it("returns null when nothing is stored", () => {
    expect(readVoiceConsent()).toBeNull();
    expect(hasVoiceConsent()).toBe(false);
  });

  it("round-trips a recorded consent", () => {
    const at = new Date("2026-05-15T20:34:12.123Z");
    const written = recordVoiceConsent(at);
    expect(written.v).toBe(1);
    expect(written.acceptedAt).toBe("2026-05-15T20:34:12.123Z");

    const read = readVoiceConsent();
    expect(read).toEqual(written);
    expect(hasVoiceConsent()).toBe(true);
  });

  it("treats a bumped schema version as no-consent (forces re-prompt)", () => {
    localStorage.setItem(
      "captureshark.voiceConsent.v1",
      JSON.stringify({ v: 99, acceptedAt: "2026-05-15T00:00:00.000Z" }),
    );
    expect(readVoiceConsent()).toBeNull();
    expect(hasVoiceConsent()).toBe(false);
  });

  it("treats corrupt JSON as no-consent", () => {
    localStorage.setItem("captureshark.voiceConsent.v1", "{not json");
    expect(readVoiceConsent()).toBeNull();
  });

  it("treats a missing acceptedAt as no-consent", () => {
    localStorage.setItem(
      "captureshark.voiceConsent.v1",
      JSON.stringify({ v: 1 }),
    );
    expect(readVoiceConsent()).toBeNull();
  });

  it("clears the record", () => {
    recordVoiceConsent();
    expect(hasVoiceConsent()).toBe(true);
    clearVoiceConsent();
    expect(hasVoiceConsent()).toBe(false);
  });
});
