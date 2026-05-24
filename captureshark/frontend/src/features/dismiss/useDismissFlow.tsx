/**
 * useDismissFlow — backdrop-tap dismiss flow as a self-contained hook.
 *
 * Encapsulates the "tap outside the active panel to go back one layer"
 * feature: the per-phase pop targets and the confirm Dialog that
 * protects unsaved work. The orchestrator (AppCanvas) just wires
 * inputs in and renders the returned dialog node — it does not see
 * any of the policy.
 *
 * Durable architecture reference: `docs/_spec/dismiss_flow.md` covers
 * the principle, the CSS / DOM mechanics, the inner-dismiss escape
 * hatch, and the anti-patterns we already tried.
 *
 * Contract (per docs/_workflow/02_PRINCIPLES + product spec):
 *   - Tap on bare cream pops one layer.
 *   - text-input with non-empty draft → confirm "Discard your note?"
 *   - text-input empty → silent GoToHome.
 *   - review → ALWAYS confirm save-or-discard (the extracted lead
 *     itself IS user work — losing it without a prompt would surprise
 *     Linda).
 *   - photo-review → ALWAYS confirm discard (the extracted rows are
 *     the work).
 *   - voice + photo-row-edit: silent pop (no data loss — voice has no
 *     pre-extraction state to lose, photo-row-edit auto-saves).
 *   - saving + saved → silent CaptureAnother. Safe because the save is
 *     offline-first (lead persists to IndexedDB BEFORE the saving
 *     screen even shows; the drainer pushes to the sheet in the
 *     background regardless of UI state).
 *   - home / loading / photo: tap is a no-op. NEVER intercept an
 *     extraction in progress — the user has no local safety net for
 *     that work yet.
 */

import {
  useEffect,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
} from "react";

import { Dialog } from "@/components/Dialog/Dialog";
import type { AppAction, AppState } from "@/features/app-state/appState";
import type { Lead } from "@/features/review/Lead";

/**
 * Result the orchestrator returns from `attemptInnerDismiss` describing
 * how (or whether) an inner UI element handled the tap.
 *
 *   `none`         — nothing inner was open; fall through to layer pop.
 *   `closed-clean` — the inner element closed itself silently (e.g. a
 *                    field-edit panel whose draft matched the original
 *                    value). The layer stays put.
 *   `has-changes`  — the inner element has unsaved edits. The dismiss
 *                    flow raises its own confirm Dialog using the
 *                    supplied commit / discard callbacks so the user
 *                    can Save / Don't Save / Cancel without the layer
 *                    moving.
 */
export type InnerDismissResult =
  | { kind: "none" }
  | { kind: "closed-clean" }
  | { kind: "has-changes"; commit: () => void; discard: () => void };

export interface UseDismissFlowParams {
  state: AppState;
  dispatch: (action: AppAction) => void;
  /** Called when the user picks "Save to sheet" in the review-state confirm. */
  onSaveFromReview: () => void;
  /** Called when the user picks "Discard" on the photo-review confirm. */
  onDiscardPhoto: () => void;
  /**
   * Called when photo-row-edit pops silently. The orchestrator's photo
   * session hook owns the merge-back-into-row semantic.
   */
  onBackToPhotoList: (lead: Lead) => void;
  /**
   * Called BEFORE any layer-pop to give inner UI (e.g. a field-edit
   * panel inside the review card) a chance to handle the tap. See
   * `InnerDismissResult` for the three outcomes the orchestrator can
   * return. Defaults to "nothing inner" when omitted.
   */
  attemptInnerDismiss?: () => InnerDismissResult;
}

export interface UseDismissFlowResult {
  /** Wire to the dedicated backdrop catcher in the app shell. */
  handleBackdropTap: (e: ReactMouseEvent<HTMLDivElement>) => void;
  /**
   * The confirm Dialog node. Renders into a portal on document.body,
   * so it can be dropped anywhere in the tree without parenting.
   */
  dismissDialog: ReactElement | null;
}

export function useDismissFlow({
  state,
  dispatch,
  onSaveFromReview,
  onDiscardPhoto,
  onBackToPhotoList,
  attemptInnerDismiss,
}: UseDismissFlowParams): UseDismissFlowResult {
  // Pending confirm Dialog state — a discriminated union so the same
  // slot covers both "layer pop with unsaved work" (phase) AND
  // "field-edit pop with unsaved draft" (inner-edit).
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(
    null,
  );

  // Close any open confirm Dialog whenever the phase changes — the
  // previous phase's confirm isn't meaningful on the new one.
  useEffect(() => {
    setPendingConfirm(null);
  }, [state.kind]);

  function handleBackdropTap(_e: ReactMouseEvent<HTMLDivElement>): void {
    if (pendingConfirm !== null) return;

    // Multilevel pop: inner UI gets the first crack at the tap.
    // Three outcomes — see `InnerDismissResult`.
    if (attemptInnerDismiss !== undefined) {
      const inner = attemptInnerDismiss();
      if (inner.kind === "closed-clean") return;
      if (inner.kind === "has-changes") {
        setPendingConfirm({
          kind: "inner-edit",
          commit: inner.commit,
          discard: inner.discard,
        });
        return;
      }
      // 'none' — fall through to layer-pop policy.
    }

    switch (state.kind) {
      case "home":
      case "loading":
      case "photo":
        // Already-home or in-flight extraction — taps ignored. We
        // never bail mid-extraction because the user has no local
        // safety net for that work yet (no draft persisted).
        return;

      case "saving":
      case "saved": {
        // Tap during saving OR after saved both dismiss to landing.
        // Safe because the save is offline-first: the lead is written
        // to IndexedDB the moment the Save button is pressed, BEFORE
        // the saving screen even shows. The background sheet push
        // (drainer) keeps running regardless of UI state — the
        // reducer's saving → saved transition guard simply no-ops if
        // the user has already moved on, but the data is durably
        // saved and Linda's sheet still gets the row.
        dispatch({ type: "CaptureAnother" });
        return;
      }

      case "text-input": {
        if (state.text.trim() === "") {
          dispatch({ type: "GoToHome" });
        } else {
          setPendingConfirm({ kind: "phase", state });
        }
        return;
      }

      case "voice": {
        dispatch({ type: "GoToHome" });
        return;
      }

      case "review":
      case "photo-review": {
        // The extracted lead / row batch IS the user's work. Always
        // confirm before discarding — no silent path here.
        setPendingConfirm({ kind: "phase", state });
        return;
      }

      case "photo-row-edit": {
        onBackToPhotoList(state.lead);
        return;
      }
    }
  }

  const dismissDialog = renderDismissDialog({
    pendingConfirm,
    closeDialog: () => {
      setPendingConfirm(null);
    },
    dispatch,
    onSaveFromReview,
    onDiscardPhoto,
  });

  return {
    handleBackdropTap,
    dismissDialog,
  };
}

/**
 * The two shapes a pending confirm Dialog can take. `phase` covers the
 * layer-pop confirms (text/voice review, photo-review); `inner-edit`
 * covers the per-field edit confirm raised when a field-edit panel
 * dismisses with unsaved changes.
 */
type PendingConfirm =
  | { kind: "phase"; state: AppState }
  | { kind: "inner-edit"; commit: () => void; discard: () => void };

/**
 * Internal renderer for the confirm Dialog. Pulled out of the hook
 * body to keep `useDismissFlow` itself focused on state + policy;
 * copy + button wiring live here.
 */
interface RenderDismissDialogParams {
  pendingConfirm: PendingConfirm | null;
  closeDialog: () => void;
  dispatch: (action: AppAction) => void;
  onSaveFromReview: () => void;
  onDiscardPhoto: () => void;
}

function renderDismissDialog({
  pendingConfirm,
  closeDialog,
  dispatch,
  onSaveFromReview,
  onDiscardPhoto,
}: RenderDismissDialogParams): ReactElement | null {
  if (pendingConfirm === null) return null;

  if (pendingConfirm.kind === "inner-edit") {
    return (
      <Dialog
        open
        icon="question"
        title="Save your changes?"
        body="Your edit isn't saved yet."
        onDismiss={closeDialog}
        actions={[
          {
            label: "Save",
            kind: "primary",
            onPress: () => {
              closeDialog();
              pendingConfirm.commit();
            },
          },
          {
            label: "Don't save",
            kind: "destructive",
            onPress: () => {
              closeDialog();
              pendingConfirm.discard();
            },
          },
          {
            label: "Cancel",
            kind: "secondary",
            onPress: closeDialog,
          },
        ]}
      />
    );
  }

  const phase = pendingConfirm.state;

  if (phase.kind === "text-input") {
    return (
      <Dialog
        open
        icon="question"
        title="Discard your note?"
        body="What you typed will go away."
        onDismiss={closeDialog}
        actions={[
          {
            label: "Discard",
            kind: "destructive",
            onPress: () => {
              closeDialog();
              dispatch({ type: "GoToHome" });
            },
          },
          {
            label: "Keep typing",
            kind: "secondary",
            onPress: closeDialog,
          },
        ]}
      />
    );
  }

  if (phase.kind === "review") {
    return (
      <Dialog
        open
        icon="question"
        title="Save before going back?"
        body="Your edits aren't on the sheet yet."
        onDismiss={closeDialog}
        actions={[
          {
            label: "Save to sheet",
            kind: "primary",
            onPress: () => {
              closeDialog();
              onSaveFromReview();
            },
          },
          {
            label: "Discard",
            kind: "destructive",
            onPress: () => {
              closeDialog();
              dispatch({ type: "Discard" });
            },
          },
          {
            label: "Cancel",
            kind: "secondary",
            onPress: closeDialog,
          },
        ]}
      />
    );
  }

  if (phase.kind === "photo-review") {
    return (
      <Dialog
        open
        icon="question"
        title="Discard your photo rows?"
        body="The rows from this photo will go away."
        onDismiss={closeDialog}
        actions={[
          {
            label: "Discard",
            kind: "destructive",
            onPress: () => {
              closeDialog();
              onDiscardPhoto();
            },
          },
          {
            label: "Cancel",
            kind: "secondary",
            onPress: closeDialog,
          },
        ]}
      />
    );
  }

  return null;
}
