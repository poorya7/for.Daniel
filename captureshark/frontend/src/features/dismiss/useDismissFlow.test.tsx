/**
 * Unit tests for useDismissFlow.
 *
 * Scope:
 *   - The phase pop policy fires the right action / callback for each
 *     AppState kind.
 *   - The dirty check raises the confirm Dialog (pendingDismiss) for
 *     phases that carry unsaved work, and dispatches the silent pop
 *     when there's nothing to lose.
 *   - The inner-dismiss escape hatch (e.g. a review card's open field
 *     edit panel) takes priority over the layer-pop.
 *   - markPhaseDirty is reset whenever the phase changes (a new phase
 *     is always a clean slate).
 *
 * Out of scope:
 *   - The Dialog component's render output (visual). The hook returns
 *     a React node; we only check that it goes from null → non-null
 *     and back to null around the right transitions.
 *   - Real DOM event objects. The hook ignores the event payload;
 *     the dedicated `.app-canvas__backdrop` catcher already filters
 *     which clicks reach the handler.
 */

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi, type Mock } from "vitest";

import type {
  AppAction,
  AppState,
} from "@/features/app-state/appState";
import type { Lead } from "@/features/review/Lead";

import { useDismissFlow, type InnerDismissResult } from "./useDismissFlow";

// Minimal Lead — the hook only forwards it to onBackToPhotoList, never
// reads any fields, so a blank shell is enough.
function makeLead(): Lead {
  return {
    name: { value: "", confidence: "high", alternatives: [] },
    phone: { value: "", confidence: "high", alternatives: [] },
    email: { value: "", confidence: "high", alternatives: [] },
    has_agent: { value: null, confidence: "high", alternatives: [] },
    intent: { value: "", confidence: "high", alternatives: [] },
    timeline: { value: "", confidence: "high", alternatives: [] },
    financing_status: { value: "", confidence: "high", alternatives: [] },
    budget: { value: "", confidence: "high", alternatives: [] },
    area: { value: "", confidence: "high", alternatives: [] },
    follow_up: { value: "", confidence: "high", alternatives: [] },
    notes: { value: "", confidence: "high", alternatives: [] },
    original_note: "",
  };
}

interface HarnessParams {
  state: AppState;
  attemptInnerDismiss?: () => InnerDismissResult;
}

interface Harness {
  dispatch: Mock<(action: AppAction) => void>;
  onSaveFromReview: Mock<() => void>;
  onDiscardPhoto: Mock<() => void>;
  onBackToPhotoList: Mock<(lead: Lead) => void>;
}

function renderDismiss(params: HarnessParams): {
  result: ReturnType<typeof renderHook<ReturnType<typeof useDismissFlow>, HarnessParams>>["result"];
  rerender: (next: HarnessParams) => void;
  spies: Harness;
} {
  const spies: Harness = {
    dispatch: vi.fn(),
    onSaveFromReview: vi.fn(),
    onDiscardPhoto: vi.fn(),
    onBackToPhotoList: vi.fn(),
  };

  const { result, rerender } = renderHook(
    (p: HarnessParams) =>
      useDismissFlow({
        state: p.state,
        dispatch: spies.dispatch,
        onSaveFromReview: spies.onSaveFromReview,
        onDiscardPhoto: spies.onDiscardPhoto,
        onBackToPhotoList: spies.onBackToPhotoList,
        attemptInnerDismiss: p.attemptInnerDismiss,
      }),
    { initialProps: params },
  );

  return { result, rerender, spies };
}

// Dummy MouseEvent — the hook ignores it; we just need something to pass.
const E = {} as React.MouseEvent<HTMLDivElement>;

describe("useDismissFlow — phase pop policy", () => {
  it("home: tap is a no-op", () => {
    const { result, spies } = renderDismiss({ state: { kind: "home" } });
    act(() => {
      result.current.handleBackdropTap(E);
    });
    expect(spies.dispatch).not.toHaveBeenCalled();
    expect(result.current.dismissDialog).toBeNull();
  });

  it.each(["loading", "photo"] as const)(
    "%s: tap is a no-op (never interrupt in-flight extraction)",
    (kind) => {
      const state =
        kind === "loading"
          ? ({ kind: "loading", source: "text", preservedText: null } as AppState)
          : ({ kind: "photo" } as AppState);
      const { result, spies } = renderDismiss({ state });
      act(() => {
        result.current.handleBackdropTap(E);
      });
      expect(spies.dispatch).not.toHaveBeenCalled();
      expect(result.current.dismissDialog).toBeNull();
    },
  );

  it.each(["saving", "saved"] as const)(
    "%s: silent CaptureAnother (save is offline-first, UI safe to leave)",
    (kind) => {
      const state =
        kind === "saving"
          ? ({
              kind: "saving",
              subheadName: null,
              phraseIdx: 0,
              lead: null,
              source: null,
              preservedText: null,
            } as AppState)
          : ({
              kind: "saved",
              summary: { name: null, area: null, fallback: "", connector: "" },
              target: null,
            } as AppState);
      const { result, spies } = renderDismiss({ state });
      act(() => {
        result.current.handleBackdropTap(E);
      });
      expect(spies.dispatch).toHaveBeenCalledWith({ type: "CaptureAnother" });
      expect(result.current.dismissDialog).toBeNull();
    },
  );

  it("text-input empty: silent GoToHome", () => {
    const { result, spies } = renderDismiss({
      state: { kind: "text-input", text: "", extractError: null },
    });
    act(() => {
      result.current.handleBackdropTap(E);
    });
    expect(spies.dispatch).toHaveBeenCalledWith({ type: "GoToHome" });
    expect(result.current.dismissDialog).toBeNull();
  });

  it("text-input whitespace-only: still silent GoToHome", () => {
    const { result, spies } = renderDismiss({
      state: { kind: "text-input", text: "   \n  ", extractError: null },
    });
    act(() => {
      result.current.handleBackdropTap(E);
    });
    expect(spies.dispatch).toHaveBeenCalledWith({ type: "GoToHome" });
  });

  it("text-input with typed text: confirm Dialog appears, no dispatch", () => {
    const { result, spies } = renderDismiss({
      state: { kind: "text-input", text: "hello", extractError: null },
    });
    act(() => {
      result.current.handleBackdropTap(E);
    });
    expect(spies.dispatch).not.toHaveBeenCalled();
    expect(result.current.dismissDialog).not.toBeNull();
  });

  it("voice: silent GoToHome (no data loss)", () => {
    const { result, spies } = renderDismiss({ state: { kind: "voice" } });
    act(() => {
      result.current.handleBackdropTap(E);
    });
    expect(spies.dispatch).toHaveBeenCalledWith({ type: "GoToHome" });
  });

  it("review: ALWAYS raises the confirm Dialog (the extracted lead is work)", () => {
    const lead = makeLead();
    const { result, spies } = renderDismiss({
      state: {
        kind: "review",
        lead,
        source: "text",
        preservedText: null,
        saveError: null,
        authPanel: null,
      },
    });
    act(() => {
      result.current.handleBackdropTap(E);
    });
    expect(spies.dispatch).not.toHaveBeenCalled();
    expect(spies.onDiscardPhoto).not.toHaveBeenCalled();
    expect(result.current.dismissDialog).not.toBeNull();
  });

  it("photo-review: ALWAYS raises the confirm Dialog (the rows are work)", () => {
    const { result, spies } = renderDismiss({
      state: { kind: "photo-review", authPanel: null },
    });
    act(() => {
      result.current.handleBackdropTap(E);
    });
    expect(spies.onDiscardPhoto).not.toHaveBeenCalled();
    expect(spies.dispatch).not.toHaveBeenCalled();
    expect(result.current.dismissDialog).not.toBeNull();
  });

  it("photo-row-edit: silent onBackToPhotoList with the lead", () => {
    const lead = makeLead();
    const { result, spies } = renderDismiss({
      state: { kind: "photo-row-edit", lead },
    });
    act(() => {
      result.current.handleBackdropTap(E);
    });
    expect(spies.onBackToPhotoList).toHaveBeenCalledWith(lead);
  });
});

describe("useDismissFlow — inner dismiss escape hatch", () => {
  it("inner returns 'closed-clean': no layer pop, no Dialog raised", () => {
    const lead = makeLead();
    const innerDismiss = vi.fn(
      (): InnerDismissResult => ({ kind: "closed-clean" }),
    );
    const { result, spies } = renderDismiss({
      state: {
        kind: "review",
        lead,
        source: "text",
        preservedText: null,
        saveError: null,
        authPanel: null,
      },
      attemptInnerDismiss: innerDismiss,
    });
    act(() => {
      result.current.handleBackdropTap(E);
    });
    expect(innerDismiss).toHaveBeenCalledTimes(1);
    expect(spies.dispatch).not.toHaveBeenCalled();
    expect(result.current.dismissDialog).toBeNull();
  });

  it("inner returns 'has-changes': raises field-edit confirm Dialog", () => {
    const lead = makeLead();
    const commit = vi.fn();
    const discard = vi.fn();
    const innerDismiss = vi.fn(
      (): InnerDismissResult => ({ kind: "has-changes", commit, discard }),
    );
    const { result, spies } = renderDismiss({
      state: {
        kind: "review",
        lead,
        source: "text",
        preservedText: null,
        saveError: null,
        authPanel: null,
      },
      attemptInnerDismiss: innerDismiss,
    });
    act(() => {
      result.current.handleBackdropTap(E);
    });
    expect(innerDismiss).toHaveBeenCalledTimes(1);
    expect(spies.dispatch).not.toHaveBeenCalled();
    // No layer-pop dispatched — the field-edit confirm covers the
    // user's choice. Dialog is rendered (non-null).
    expect(result.current.dismissDialog).not.toBeNull();
    // Commit / discard wired through but not auto-fired — they wait
    // on the user picking Save vs Don't Save.
    expect(commit).not.toHaveBeenCalled();
    expect(discard).not.toHaveBeenCalled();
  });

  it("inner returns 'none': falls through to layer pop", () => {
    const lead = makeLead();
    const innerDismiss = vi.fn((): InnerDismissResult => ({ kind: "none" }));
    const { result, spies } = renderDismiss({
      state: { kind: "photo-row-edit", lead },
      attemptInnerDismiss: innerDismiss,
    });
    act(() => {
      result.current.handleBackdropTap(E);
    });
    expect(innerDismiss).toHaveBeenCalledTimes(1);
    expect(spies.onBackToPhotoList).toHaveBeenCalledWith(lead);
  });
});

describe("useDismissFlow — confirm Dialog lifecycle", () => {
  it("phase change closes any open confirm Dialog", () => {
    const { result, rerender } = renderDismiss({
      state: { kind: "text-input", text: "hello", extractError: null },
    });
    act(() => {
      result.current.handleBackdropTap(E);
    });
    expect(result.current.dismissDialog).not.toBeNull();
    rerender({ state: { kind: "home" } });
    expect(result.current.dismissDialog).toBeNull();
  });
});
