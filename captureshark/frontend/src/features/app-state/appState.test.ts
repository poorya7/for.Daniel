/**
 * Reducer tests for the AppCanvas state machine.
 *
 * Coverage approach: each action gets exercised against
 *   - the screens it's valid from (asserts the right transition + payload),
 *   - at least one screen it's invalid from (asserts no-op).
 *
 * Reducer is a pure function — no React, no mocking needed.
 */

import { describe, expect, it } from "vitest";

import { appReducer, type AppAction, type AppState } from "./appState";
import type { Lead } from "@/features/review/Lead";
import type { SavedSummary } from "@/features/review/SavedConfirmation";

function makeLead(name: string): Lead {
  return {
    name: { value: name, confidence: "high" },
    phone: { value: "", confidence: "high" },
    email: { value: "", confidence: "high" },
    has_agent: "no",
    intent: { value: "", confidence: "high" },
    timeline: { value: "", confidence: "high" },
    financing_status: { value: "", confidence: "high" },
    budget: { value: "", confidence: "high" },
    area: { value: "", confidence: "high" },
    follow_up: { value: "", confidence: "high" },
    notes: { value: "", confidence: "high" },
    original_note: "Maria from Tustin",
  };
}

const savedSummary: SavedSummary = {
  prefix: "Saved",
  name: "Maria",
  connector: " from ",
  area: "Tustin",
  fallback: "",
};

const target = { spreadsheet_id: "abc", display_name: "My leads" };

describe("appReducer — navigation", () => {
  it("GoToHome from any phase resets to home", () => {
    const next = appReducer(
      { kind: "review", lead: makeLead("Maria"), source: "text", preservedText: null, saveError: null, authPanel: null },
      { type: "GoToHome" },
    );
    expect(next).toEqual({ kind: "home" });
  });

  it("GoToTextInput lands on a fresh text-input screen", () => {
    expect(appReducer({ kind: "home" }, { type: "GoToTextInput" })).toEqual({
      kind: "text-input",
      text: "",
      extractError: null,
    });
  });

  it("GoToVoice lands on the voice screen", () => {
    expect(appReducer({ kind: "home" }, { type: "GoToVoice" })).toEqual({
      kind: "voice",
    });
  });

  it("GoToPhoto lands on the photo screen", () => {
    expect(appReducer({ kind: "home" }, { type: "GoToPhoto" })).toEqual({
      kind: "photo",
    });
  });
});

describe("appReducer — text input", () => {
  it("SetText updates the draft on text-input", () => {
    const next = appReducer(
      { kind: "text-input", text: "", extractError: null },
      { type: "SetText", text: "Hi Maria" },
    );
    expect(next).toEqual({ kind: "text-input", text: "Hi Maria", extractError: null });
  });

  it("SetText is a no-op on any other phase", () => {
    const state: AppState = { kind: "home" };
    expect(appReducer(state, { type: "SetText", text: "x" })).toBe(state);
  });

  it("StartExtractText transitions text-input → loading, preserving the text", () => {
    const next = appReducer(
      { kind: "text-input", text: "Maria Lopez", extractError: null },
      { type: "StartExtractText" },
    );
    expect(next).toEqual({
      kind: "loading",
      source: "text",
      preservedText: "Maria Lopez",
    });
  });

  it("StartExtractVoice transitions voice → loading", () => {
    const next = appReducer({ kind: "voice" }, { type: "StartExtractVoice" });
    expect(next).toEqual({ kind: "loading", source: "voice", preservedText: null });
  });
});

describe("appReducer — extraction outcomes", () => {
  it("ExtractionDone from loading lands on review with the lead", () => {
    const lead = makeLead("Maria");
    const next = appReducer(
      { kind: "loading", source: "text", preservedText: "n/p" },
      { type: "ExtractionDone", lead, source: "text" },
    );
    expect(next).toEqual({
      kind: "review",
      lead,
      source: "text",
      preservedText: "n/p",
      saveError: null,
      authPanel: null,
    });
  });

  it("ExtractionDone is a no-op outside loading (late callback safety)", () => {
    const state: AppState = { kind: "home" };
    const next = appReducer(state, {
      type: "ExtractionDone",
      lead: makeLead("Maria"),
      source: "text",
    });
    expect(next).toBe(state);
  });

  it("ExtractionFailed on text bounces back to text-input with preserved text + error", () => {
    const next = appReducer(
      { kind: "loading", source: "text", preservedText: "Hi Maria" },
      { type: "ExtractionFailed", message: "Couldn't reach the AI.", source: "text" },
    );
    expect(next).toEqual({
      kind: "text-input",
      text: "Hi Maria",
      extractError: "Couldn't reach the AI.",
    });
  });

  it("ExtractionFailed on voice bounces back to home (audio can't be edited)", () => {
    const next = appReducer(
      { kind: "loading", source: "voice", preservedText: null },
      { type: "ExtractionFailed", message: "x", source: "voice" },
    );
    expect(next).toEqual({ kind: "home" });
  });
});

describe("appReducer — review surface", () => {
  const reviewState: AppState = {
    kind: "review",
    lead: makeLead("Maria"),
    source: "text",
    preservedText: null,
    saveError: null,
    authPanel: null,
  };

  it("UpdateLead merges a new lead reference on the review surface", () => {
    const updated = makeLead("Maria Lopez");
    const next = appReducer(reviewState, { type: "UpdateLead", lead: updated });
    if (next.kind !== "review") throw new Error("unexpected kind");
    expect(next.lead).toBe(updated);
    expect(next.source).toBe("text");
  });

  it("UpdateLead also works while editing a photo row", () => {
    const updated = makeLead("Maria Lopez");
    const next = appReducer(
      { kind: "photo-row-edit", lead: makeLead("Maria") },
      { type: "UpdateLead", lead: updated },
    );
    if (next.kind !== "photo-row-edit") throw new Error("unexpected kind");
    expect(next.lead).toBe(updated);
  });

  it("StartSave from review enters saving with the supplied subhead + lead context", () => {
    const lead = makeLead("Maria");
    const next = appReducer(reviewState, {
      type: "StartSave",
      subheadName: "Maria",
      lead,
      source: "text",
      preservedText: null,
    });
    expect(next).toEqual({
      kind: "saving",
      subheadName: "Maria",
      phraseIdx: 0,
      lead,
      source: "text",
      preservedText: null,
    });
  });

  it("StartSave from photo-review enters saving with null subhead + null lead context", () => {
    const next = appReducer(
      { kind: "photo-review", authPanel: null },
      {
        type: "StartSave",
        subheadName: null,
        lead: null,
        source: null,
        preservedText: null,
      },
    );
    expect(next).toEqual({
      kind: "saving",
      subheadName: null,
      phraseIdx: 0,
      lead: null,
      source: null,
      preservedText: null,
    });
  });

  it("SaveAuthGateFailed sets the auth panel on review", () => {
    const next = appReducer(reviewState, {
      type: "SaveAuthGateFailed",
      panel: "needs-sign-in",
    });
    if (next.kind !== "review") throw new Error("unexpected kind");
    expect(next.authPanel).toBe("needs-sign-in");
  });

  it("DismissAuthPanel clears it on review", () => {
    const withPanel: AppState = { ...reviewState, authPanel: "needs-retry" };
    const next = appReducer(withPanel, { type: "DismissAuthPanel" });
    if (next.kind !== "review") throw new Error("unexpected kind");
    expect(next.authPanel).toBeNull();
  });

  it("DismissAuthPanel clears it on photo-review too", () => {
    const next = appReducer(
      { kind: "photo-review", authPanel: "needs-sign-in" },
      { type: "DismissAuthPanel" },
    );
    expect(next).toEqual({ kind: "photo-review", authPanel: null });
  });
});

describe("appReducer — saving + saved", () => {
  const savingState: AppState = {
    kind: "saving",
    subheadName: "Maria",
    phraseIdx: 0,
    lead: makeLead("Maria"),
    source: "text",
    preservedText: null,
  };

  it("SaveLocalWriteCommitted transitions saving → saved", () => {
    const next = appReducer(savingState, {
      type: "SaveLocalWriteCommitted",
      summary: savedSummary,
      target,
    });
    expect(next).toEqual({ kind: "saved", summary: savedSummary, target });
  });

  it("SaveLocalWriteCommitted is a no-op outside saving", () => {
    const home: AppState = { kind: "home" };
    expect(
      appReducer(home, {
        type: "SaveLocalWriteCommitted",
        summary: savedSummary,
        target,
      }),
    ).toBe(home);
  });

  it("CycleSavingPhrase advances the index modulo 3", () => {
    const tick1 = appReducer(savingState, { type: "CycleSavingPhrase" });
    if (tick1.kind !== "saving") throw new Error("unexpected kind");
    expect(tick1.phraseIdx).toBe(1);
    const tick2 = appReducer(tick1, { type: "CycleSavingPhrase" });
    if (tick2.kind !== "saving") throw new Error("unexpected kind");
    expect(tick2.phraseIdx).toBe(2);
    const tick3 = appReducer(tick2, { type: "CycleSavingPhrase" });
    if (tick3.kind !== "saving") throw new Error("unexpected kind");
    expect(tick3.phraseIdx).toBe(0);
  });

  it("CycleSavingPhrase is a no-op outside saving", () => {
    const home: AppState = { kind: "home" };
    expect(appReducer(home, { type: "CycleSavingPhrase" })).toBe(home);
  });

  it("SaveLocalWriteFailed on text/voice path restores the lead + bounces to review with the error", () => {
    const lead = makeLead("Maria");
    const next = appReducer(
      {
        kind: "saving",
        subheadName: "Maria",
        phraseIdx: 1,
        lead,
        source: "text",
        preservedText: "draft",
      },
      { type: "SaveLocalWriteFailed", message: "Storage full" },
    );
    expect(next).toEqual({
      kind: "review",
      lead,
      source: "text",
      preservedText: "draft",
      saveError: "Storage full",
      authPanel: null,
    });
  });

  it("SaveLocalWriteFailed on photo-batch saving (null lead) is a no-op (hook handles its own error surface)", () => {
    const photoSaving: AppState = {
      kind: "saving",
      subheadName: null,
      phraseIdx: 0,
      lead: null,
      source: null,
      preservedText: null,
    };
    const next = appReducer(photoSaving, {
      type: "SaveLocalWriteFailed",
      message: "x",
    });
    expect(next).toBe(photoSaving);
  });
});

describe("appReducer — discard / capture-another", () => {
  it("Discard resets to home from any state", () => {
    expect(
      appReducer(
        { kind: "saved", summary: savedSummary, target },
        { type: "Discard" },
      ),
    ).toEqual({ kind: "home" });
  });

  it("CaptureAnother resets to home from saved", () => {
    expect(
      appReducer(
        { kind: "saved", summary: savedSummary, target },
        { type: "CaptureAnother" },
      ),
    ).toEqual({ kind: "home" });
  });
});

describe("appReducer — photo flow", () => {
  it("EnterPhotoReview lands on a fresh photo-review screen", () => {
    const next = appReducer({ kind: "photo" }, { type: "EnterPhotoReview" });
    expect(next).toEqual({ kind: "photo-review", authPanel: null });
  });

  it("EnterPhotoRowEdit only fires from photo-review", () => {
    const valid = appReducer(
      { kind: "photo-review", authPanel: null },
      { type: "EnterPhotoRowEdit", lead: makeLead("Maria") },
    );
    if (valid.kind !== "photo-row-edit") throw new Error("unexpected kind");
    expect(valid.lead.name.value).toBe("Maria");

    const home: AppState = { kind: "home" };
    expect(
      appReducer(home, {
        type: "EnterPhotoRowEdit",
        lead: makeLead("Maria"),
      }),
    ).toBe(home);
  });

  it("ReturnFromPhotoRowEdit takes us back to photo-review with no panel", () => {
    const next = appReducer(
      { kind: "photo-row-edit", lead: makeLead("Maria") },
      { type: "ReturnFromPhotoRowEdit" },
    );
    expect(next).toEqual({ kind: "photo-review", authPanel: null });
  });

  it("PhotoSaveAuthGateFailed sets the photo-review auth panel", () => {
    const next = appReducer(
      { kind: "photo-review", authPanel: null },
      { type: "PhotoSaveAuthGateFailed", panel: "needs-sign-in" },
    );
    expect(next).toEqual({ kind: "photo-review", authPanel: "needs-sign-in" });
  });
});

describe("appReducer — impossible-state protection", () => {
  it("ExtractionDone in review (late callback) is dropped", () => {
    const review: AppState = {
      kind: "review",
      lead: makeLead("Maria"),
      source: "text",
      preservedText: null,
      saveError: null,
      authPanel: null,
    };
    const next = appReducer(review, {
      type: "ExtractionDone",
      lead: makeLead("Different"),
      source: "text",
    });
    expect(next).toBe(review);
  });

  it("SaveAuthGateFailed in saving (race) is dropped", () => {
    const saving: AppState = {
      kind: "saving",
      subheadName: "Maria",
      phraseIdx: 0,
      lead: makeLead("Maria"),
      source: "text",
      preservedText: null,
    };
    const next = appReducer(saving, {
      type: "SaveAuthGateFailed",
      panel: "needs-sign-in",
    });
    expect(next).toBe(saving);
  });

  it("StartSave in voice phase (impossible) is dropped", () => {
    const voice: AppState = { kind: "voice" };
    const next = appReducer(voice, {
      type: "StartSave",
      subheadName: null,
      lead: null,
      source: null,
      preservedText: null,
    });
    expect(next).toBe(voice);
  });
});

describe("appReducer — exhaustive transition smoke", () => {
  // Quick smoke that no action throws on any state combination.
  const allStates: AppState[] = [
    { kind: "home" },
    { kind: "text-input", text: "x", extractError: null },
    { kind: "voice" },
    { kind: "loading", source: "text", preservedText: "x" },
    {
      kind: "review",
      lead: makeLead("Maria"),
      source: "text",
      preservedText: null,
      saveError: null,
      authPanel: null,
    },
    {
      kind: "saving",
      subheadName: "Maria",
      phraseIdx: 0,
      lead: makeLead("Maria"),
      source: "text",
      preservedText: null,
    },
    { kind: "saved", summary: savedSummary, target },
    { kind: "photo" },
    { kind: "photo-review", authPanel: null },
    { kind: "photo-row-edit", lead: makeLead("Maria") },
  ];

  const allActions: AppAction[] = [
    { type: "GoToHome" },
    { type: "GoToTextInput" },
    { type: "GoToVoice" },
    { type: "GoToPhoto" },
    { type: "SetText", text: "x" },
    { type: "StartExtractText" },
    { type: "StartExtractVoice" },
    { type: "ExtractionDone", lead: makeLead("Maria"), source: "text" },
    { type: "ExtractionFailed", message: "x", source: "text" },
    { type: "UpdateLead", lead: makeLead("Maria") },
    {
      type: "StartSave",
      subheadName: "Maria",
      lead: makeLead("Maria"),
      source: "text",
      preservedText: null,
    },
    { type: "SaveAuthGateFailed", panel: "needs-sign-in" },
    { type: "DismissAuthPanel" },
    { type: "SaveLocalWriteCommitted", summary: savedSummary, target },
    { type: "SaveLocalWriteFailed", message: "x" },
    { type: "CycleSavingPhrase" },
    { type: "Discard" },
    { type: "CaptureAnother" },
    { type: "EnterPhotoReview" },
    { type: "EnterPhotoRowEdit", lead: makeLead("Maria") },
    { type: "ReturnFromPhotoRowEdit" },
    { type: "PhotoSaveAuthGateFailed", panel: "needs-sign-in" },
  ];

  it("every action × every state combination is safe", () => {
    for (const s of allStates) {
      for (const a of allActions) {
        expect(() => appReducer(s, a)).not.toThrow();
      }
    }
  });
});
