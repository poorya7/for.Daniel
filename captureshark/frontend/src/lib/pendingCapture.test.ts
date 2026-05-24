/**
 * Unit tests for `pendingCapture.ts` — the localStorage round-trip that
 * survives the OAuth redirect.
 *
 * This module is the *one* thing that has to survive a sign-in redirect
 * intact; if it loses or corrupts the in-progress capture, the broker
 * lands back on a blank screen after Google's consent flow. Every
 * branch matters.
 *
 * Defensive parsing pinned: malformed JSON, wrong version envelope,
 * missing fields, invalid confidence — all return null cleanly.
 * `localStorage` itself can throw (private mode, quota); save / load
 * both swallow.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearPendingCapture,
  loadPendingCapture,
  savePendingCapture,
  type PendingCapture,
} from "@/lib/pendingCapture";
import type { StreamingResult } from "@/lib/api";

const STORAGE_KEY = "captureshark.pendingCapture.v1";

const fakeResult: StreamingResult = {
  fields: {
    name: { value: "Maria Lopez", confidence: "high", alternatives: [] },
    phone: { value: "555-0192", confidence: "medium", alternatives: ["555-0182"] },
    email: { value: null, confidence: "high", alternatives: [] },
    has_agent: { value: null, confidence: "high", alternatives: [] },
    intent: { value: null, confidence: "high", alternatives: [] },
    timeline: { value: null, confidence: "high", alternatives: [] },
    financing_status: { value: null, confidence: "high", alternatives: [] },
    area: { value: "Maple St", confidence: "high", alternatives: [] },
    budget: { value: "600k", confidence: "medium", alternatives: [] },
    follow_up: { value: null, confidence: "high", alternatives: [] },
    notes: { value: null, confidence: "high", alternatives: [] },
  },
  original_text: "Maria 555-0192",
};

describe("pendingCapture", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- happy path ---------------------------------------------------------

  it("save → load round-trips the capture losslessly", () => {
    savePendingCapture({ source: "text", result: fakeResult });
    const loaded = loadPendingCapture();
    expect(loaded).not.toBeNull();
    expect(loaded?.source).toBe("text");
    expect(loaded?.result.original_text).toBe("Maria 555-0192");
    expect(loaded?.result.fields.name?.value).toBe("Maria Lopez");
    expect(loaded?.result.fields.phone?.confidence).toBe("medium");
  });

  it("save stamps a `storedAt` timestamp", () => {
    const before = Date.now();
    savePendingCapture({ source: "text", result: fakeResult });
    const loaded = loadPendingCapture() as PendingCapture;
    expect(loaded.storedAt).toBeGreaterThanOrEqual(before);
    expect(loaded.storedAt).toBeLessThanOrEqual(Date.now());
  });

  it("clearPendingCapture removes the entry", () => {
    savePendingCapture({ source: "text", result: fakeResult });
    expect(loadPendingCapture()).not.toBeNull();
    clearPendingCapture();
    expect(loadPendingCapture()).toBeNull();
  });

  // --- defensive parsing --------------------------------------------------

  it("returns null when nothing has been saved", () => {
    expect(loadPendingCapture()).toBeNull();
  });

  it("rejects a wrong-version envelope", () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: 99, capture: fakeResult }),
    );
    expect(loadPendingCapture()).toBeNull();
  });

  it("rejects malformed JSON", () => {
    window.localStorage.setItem(STORAGE_KEY, "{this is not json");
    expect(loadPendingCapture()).toBeNull();
  });

  it("rejects an envelope missing the capture object", () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: 1 }),
    );
    expect(loadPendingCapture()).toBeNull();
  });

  it("rejects a capture with an unknown source", () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        capture: {
          source: "telepathy",
          storedAt: Date.now(),
          result: fakeResult,
        },
      }),
    );
    expect(loadPendingCapture()).toBeNull();
  });

  it("rejects a capture missing required field keys", () => {
    const incomplete = {
      ...fakeResult,
      fields: { name: fakeResult.fields.name },
    };
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        capture: {
          source: "text",
          storedAt: Date.now(),
          result: incomplete,
        },
      }),
    );
    expect(loadPendingCapture()).toBeNull();
  });

  it("rejects a capture whose confidence value is outside the enum", () => {
    // Tampered localStorage: confidence = "lol-whatever". Without the
    // enum check this would round-trip and end up as a stray CSS class
    // name when the review card renders.
    const tampered = {
      ...fakeResult,
      fields: {
        ...fakeResult.fields,
        name: {
          value: "Maria",
          confidence: "lol-whatever",  // not in the enum
          alternatives: [],
        },
      },
    };
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        capture: {
          source: "text",
          storedAt: Date.now(),
          result: tampered,
        },
      }),
    );
    expect(loadPendingCapture()).toBeNull();
  });

  // --- localStorage failure -----------------------------------------------

  it("save silently degrades when localStorage throws", () => {
    vi.spyOn(window.localStorage.__proto__, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });
    // Must not throw — caller should still be able to navigate to Google.
    expect(() => savePendingCapture({ source: "text", result: fakeResult })).not.toThrow();
  });

  it("load returns null when localStorage throws", () => {
    vi.spyOn(window.localStorage.__proto__, "getItem").mockImplementation(() => {
      throw new Error("disabled");
    });
    expect(loadPendingCapture()).toBeNull();
  });

  it("clear silently degrades when localStorage throws", () => {
    vi.spyOn(window.localStorage.__proto__, "removeItem").mockImplementation(() => {
      throw new Error("disabled");
    });
    expect(() => clearPendingCapture()).not.toThrow();
  });
});
