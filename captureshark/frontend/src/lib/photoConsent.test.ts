import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clearPhotoConsent,
  hasPhotoConsent,
  readPhotoConsent,
  recordPhotoConsent,
} from "./photoConsent";

describe("photoConsent", () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    localStorage.clear();
  });

  it("returns null when nothing is stored", () => {
    expect(readPhotoConsent()).toBeNull();
    expect(hasPhotoConsent()).toBe(false);
  });

  it("round-trips a recorded consent", () => {
    const at = new Date("2026-05-17T20:34:12.123Z");
    const written = recordPhotoConsent(at);
    expect(written.v).toBe(1);
    expect(written.acceptedAt).toBe("2026-05-17T20:34:12.123Z");

    const read = readPhotoConsent();
    expect(read).toEqual(written);
    expect(hasPhotoConsent()).toBe(true);
  });

  it("treats a bumped schema version as no-consent (forces re-prompt)", () => {
    localStorage.setItem(
      "captureshark.photoConsent.v1",
      JSON.stringify({ v: 99, acceptedAt: "2026-05-17T00:00:00.000Z" }),
    );
    expect(readPhotoConsent()).toBeNull();
    expect(hasPhotoConsent()).toBe(false);
  });

  it("treats corrupt JSON as no-consent", () => {
    localStorage.setItem("captureshark.photoConsent.v1", "{not json");
    expect(readPhotoConsent()).toBeNull();
  });

  it("treats a missing acceptedAt as no-consent", () => {
    localStorage.setItem(
      "captureshark.photoConsent.v1",
      JSON.stringify({ v: 1 }),
    );
    expect(readPhotoConsent()).toBeNull();
  });

  it("clears the record", () => {
    recordPhotoConsent();
    expect(hasPhotoConsent()).toBe(true);
    clearPhotoConsent();
    expect(hasPhotoConsent()).toBe(false);
  });

  it("is stored separately from the voice consent (independent keys)", () => {
    recordPhotoConsent();
    // Voice consent should not be implied by photo consent — they're
    // different data shipments to different providers.
    expect(localStorage.getItem("captureshark.voiceConsent.v1")).toBeNull();
    expect(localStorage.getItem("captureshark.photoConsent.v1")).not.toBeNull();
  });
});
