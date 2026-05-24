/**
 * AppCanvas state machine.
 *
 * The orchestrator's screen-level state, modelled as a discriminated
 * union plus a pure reducer. Each screen ("kind") carries ONLY the
 * data that's meaningful while it's active, so impossible states (a
 * "saved" screen with no summary, a "review" screen with no lead, a
 * stale lead lingering after capture-another) cannot be represented.
 *
 * What lives here:
 *   - `AppState` — every screen the orchestrator can be on, with its
 *     per-screen data co-located.
 *   - `AppAction` — every transition the orchestrator (or the photo
 *     session hook) can dispatch.
 *   - `appReducer` — the pure transition function. No React, no side
 *     effects, no IO. Easy to test the whole transition table.
 *   - `computeInitialAppState` — the resumed-from-sign-in case
 *     (URL `?signed_in=1` + localStorage stash) plus the standard home
 *     start. Side effects (URL strip + stash clear) happen exactly
 *     once, guarded by a module-scope cache so StrictMode double-
 *     invocation can't re-fire them.
 *
 * What does NOT live here:
 *   - Side effects (extraction stream calls, queue enqueue, drainer
 *     kicks, localStorage stash writes). Those stay in AppCanvas /
 *     usePhotoCaptureSession; the reducer only models what the screen
 *     looks like, never how it got there.
 *   - The auth store. It's a separate Zustand store; the reducer
 *     reads its values when needed (via the orchestrator passing them
 *     into dispatched actions).
 *   - Per-field edit state. That lives inside LeadReviewCard.
 *   - Photo session internal state (camera lifecycle, multi-row
 *     collection, etc.). That lives inside usePhotoCaptureSession.
 *     The reducer only knows "we're on the photo-review screen" or
 *     "we're editing a photo row" — the actual rows live in the hook.
 */

import {
  clearPendingCapture,
  loadPendingCapture,
} from "@/lib/pendingCapture";
import { stashedResultToLead, type Lead } from "@/features/review/Lead";
import type { SavedSummary } from "@/features/review/SavedConfirmation";
import type { SheetTarget } from "@/lib/api";

/**
 * Which auth-panel variant is showing in place of the Save/Discard
 * cluster (or the photo Save All button). Null when no panel is up.
 */
export type AuthPanel = "needs-sign-in" | "needs-retry";

/**
 * Which capture mode produced the lead the user is currently
 * reviewing or saving. Photo flows manage their own state inside
 * usePhotoCaptureSession — only text + voice carry through this
 * source tag.
 */
export type CaptureSource = "text" | "voice";

/**
 * The discriminated union of every screen the AppCanvas can be on.
 * `kind` is the discriminator; the rest of the fields are co-located
 * per-screen so impossible combinations are unrepresentable.
 */
export type AppState =
  | { kind: "home" }
  | {
      kind: "text-input";
      /** User's draft. Preserved across error bounce-backs from loading. */
      text: string;
      /** Plain-English error from the most recent failed extraction. */
      extractError: string | null;
    }
  | { kind: "voice" }
  | {
      kind: "loading";
      source: CaptureSource;
      /**
       * The text draft, preserved for the error bounce-back to
       * text-input. Null when source is "voice" (audio can't be
       * edited like text can — error sends the user back to home).
       */
      preservedText: string | null;
    }
  | {
      kind: "review";
      /** The lead being reviewed. */
      lead: Lead;
      /** Which capture mode produced this lead. */
      source: CaptureSource;
      /**
       * Text draft preserved across the extraction round-trip — only
       * meaningful for `source === "text"`. Kept so a future
       * "edit the input" affordance has the original text on hand.
       */
      preservedText: string | null;
      /** Plain-English error from the most recent failed save. */
      saveError: string | null;
      /** Sign-in panel variant currently showing, if any. */
      authPanel: AuthPanel | null;
    }
  | {
      kind: "saving";
      /**
       * First-name to show in the saving-screen subhead. Null for
       * photo batch saves (no single name fits N rows).
       */
      subheadName: string | null;
      /** Cycling phrase index — driven by the orchestrator's interval. */
      phraseIdx: number;
      /**
       * The lead being saved on the text/voice path — preserved so a
       * SaveLocalWriteFailed bounce-back to review keeps the user's
       * reviewed data intact. Null for photo batch saves (the photo
       * session hook owns the row state, not the orchestrator).
       */
      lead: Lead | null;
      /** Capture source for the in-flight save. Null for photo batch. */
      source: CaptureSource | null;
      /** Preserved text draft — same shape as on the review screen. */
      preservedText: string | null;
    }
  | {
      kind: "saved";
      summary: SavedSummary;
      /** Server-returned target — drives the open-in-sheets link. */
      target: SheetTarget | null;
    }
  | { kind: "photo" }
  | {
      kind: "photo-review";
      /** Sign-in panel variant currently showing, if any. */
      authPanel: AuthPanel | null;
    }
  | {
      kind: "photo-row-edit";
      /**
       * The lead currently being edited. The photo session hook owns
       * the row index + the merge-back-on-return logic.
       */
      lead: Lead;
    };

/**
 * Every transition the orchestrator (or photo session) can dispatch.
 * Action names are imperative and verb-first so they read as commands
 * at the call site.
 */
export type AppAction =
  // --- Navigation between top-level screens ---------------------------
  | { type: "GoToHome" }
  | { type: "GoToTextInput" }
  | { type: "GoToVoice" }
  | { type: "GoToPhoto" }

  // --- Text input ----------------------------------------------------
  | { type: "SetText"; text: string }
  | { type: "StartExtractText" }
  | { type: "StartExtractVoice" }
  | { type: "ExtractionDone"; lead: Lead; source: CaptureSource }
  | { type: "ExtractionFailed"; message: string; source: CaptureSource }

  // --- Review surface ------------------------------------------------
  | { type: "UpdateLead"; lead: Lead }
  | {
      type: "StartSave";
      subheadName: string | null;
      /**
       * For text/voice saves: pass the lead + source + preservedText so
       * a SaveLocalWriteFailed can recover them. For photo batch saves:
       * pass null for all three (the hook owns the photo row state).
       */
      lead: Lead | null;
      source: CaptureSource | null;
      preservedText: string | null;
    }
  | { type: "SaveAuthGateFailed"; panel: AuthPanel }
  | { type: "DismissAuthPanel" }
  | {
      type: "SaveLocalWriteCommitted";
      summary: SavedSummary;
      target: SheetTarget | null;
    }
  | { type: "SaveLocalWriteFailed"; message: string }
  | { type: "CycleSavingPhrase" }

  // --- Discard / capture-another -------------------------------------
  | { type: "Discard" }
  | { type: "CaptureAnother" }

  // --- Photo flow (most photo state inside the hook) -----------------
  | { type: "EnterPhotoReview" }
  | { type: "EnterPhotoRowEdit"; lead: Lead }
  | { type: "ReturnFromPhotoRowEdit" }
  | { type: "PhotoSaveAuthGateFailed"; panel: AuthPanel };

/**
 * The pure transition function. Every screen change in the app goes
 * through here. Returns the same state object if the action is a
 * no-op or invalid for the current screen — never throws, never
 * loses data unrelated to the transition.
 *
 * Invalid transitions (e.g. dispatching ExtractionDone while on the
 * home screen) are silently ignored: the corresponding state field
 * already prevents the impossible case at the type level, so a
 * misfire is a programming error, not a user-recoverable state.
 */
export function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    // --- Navigation --------------------------------------------------
    case "GoToHome":
      return { kind: "home" };

    case "GoToTextInput":
      return { kind: "text-input", text: "", extractError: null };

    case "GoToVoice":
      return { kind: "voice" };

    case "GoToPhoto":
      return { kind: "photo" };

    // --- Text input --------------------------------------------------
    case "SetText":
      if (state.kind !== "text-input") return state;
      return { ...state, text: action.text };

    case "StartExtractText":
      if (state.kind !== "text-input") return state;
      return {
        kind: "loading",
        source: "text",
        preservedText: state.text,
      };

    case "StartExtractVoice":
      if (state.kind !== "voice") return state;
      return { kind: "loading", source: "voice", preservedText: null };

    case "ExtractionDone":
      // Allowed from "loading" only — guards against late callbacks
      // landing after the user has navigated away.
      if (state.kind !== "loading") return state;
      return {
        kind: "review",
        lead: action.lead,
        source: action.source,
        preservedText: state.preservedText,
        saveError: null,
        authPanel: null,
      };

    case "ExtractionFailed":
      // Text extraction errors bounce back to text-input so the user
      // can edit + retry. Voice errors bounce to home (audio can't
      // be edited like text).
      if (state.kind !== "loading") return state;
      if (action.source === "text") {
        return {
          kind: "text-input",
          text: state.preservedText ?? "",
          extractError: action.message,
        };
      }
      return { kind: "home" };

    // --- Review surface ----------------------------------------------
    case "UpdateLead":
      if (state.kind === "review") {
        return { ...state, lead: action.lead };
      }
      if (state.kind === "photo-row-edit") {
        return { ...state, lead: action.lead };
      }
      return state;

    case "StartSave":
      // Triggered from review OR photo-review (the photo session
      // dispatches StartSave with subheadName/lead/source all null
      // for batch saves — its hook owns the row state).
      if (state.kind !== "review" && state.kind !== "photo-review") {
        return state;
      }
      return {
        kind: "saving",
        subheadName: action.subheadName,
        phraseIdx: 0,
        lead: action.lead,
        source: action.source,
        preservedText: action.preservedText,
      };

    case "SaveAuthGateFailed":
      if (state.kind !== "review") return state;
      return { ...state, authPanel: action.panel };

    case "DismissAuthPanel":
      if (state.kind === "review") {
        return { ...state, authPanel: null };
      }
      if (state.kind === "photo-review") {
        return { ...state, authPanel: null };
      }
      return state;

    case "SaveLocalWriteCommitted":
      // Allowed from "saving". Late callbacks from a stray earlier
      // save are silently dropped.
      if (state.kind !== "saving") return state;
      return { kind: "saved", summary: action.summary, target: action.target };

    case "SaveLocalWriteFailed":
      // Text/voice path: saving → review with the in-flight lead
      // restored from the saving state's payload + the error surfaced.
      // Photo batch save failure does NOT dispatch this — the hook
      // surfaces the error via photoSaveError and dispatches
      // EnterPhotoReview separately, so the lead/source fields will
      // be null and we just return state unchanged.
      if (state.kind !== "saving") return state;
      if (state.lead === null || state.source === null) return state;
      return {
        kind: "review",
        lead: state.lead,
        source: state.source,
        preservedText: state.preservedText,
        saveError: action.message,
        authPanel: null,
      };

    case "CycleSavingPhrase":
      if (state.kind !== "saving") return state;
      // Three phrases — cycle the index. The orchestrator owns the
      // interval that fires this; the reducer just advances.
      return { ...state, phraseIdx: (state.phraseIdx + 1) % 3 };

    // --- Discard / capture-another -----------------------------------
    case "Discard":
    case "CaptureAnother":
      // Full reset to home from any phase. Same effect for both
      // intents; the labels are user-facing only.
      return { kind: "home" };

    // --- Photo flow --------------------------------------------------
    case "EnterPhotoReview":
      return { kind: "photo-review", authPanel: null };

    case "EnterPhotoRowEdit":
      // Allowed from photo-review only. The hook stores the row
      // index; the reducer just tracks "we're editing a photo row".
      if (state.kind !== "photo-review") return state;
      return { kind: "photo-row-edit", lead: action.lead };

    case "ReturnFromPhotoRowEdit":
      if (state.kind !== "photo-row-edit") return state;
      return { kind: "photo-review", authPanel: null };

    case "PhotoSaveAuthGateFailed":
      if (state.kind !== "photo-review") return state;
      return { ...state, authPanel: action.panel };
  }
}

// --- Initial state --------------------------------------------------

interface AuthCallbackParams {
  signedIn: boolean;
  authError: string | null;
}

/**
 * Reads `?signed_in=1` / `?auth_error=<code>` from the URL, strips
 * them via replaceState so a refresh doesn't re-trigger the
 * auto-resume path, and returns what we found.
 */
function consumeAuthCallbackParams(): AuthCallbackParams {
  if (typeof window === "undefined") {
    return { signedIn: false, authError: null };
  }
  const params = new URLSearchParams(window.location.search);
  const signedIn = params.get("signed_in") === "1";
  const authError = params.get("auth_error");
  if (signedIn || authError !== null) {
    params.delete("signed_in");
    params.delete("auth_error");
    const remaining = params.toString();
    const newUrl =
      window.location.pathname +
      (remaining ? `?${remaining}` : "") +
      window.location.hash;
    window.history.replaceState({}, "", newUrl);
  }
  return { signedIn, authError };
}

// Module-scope cache so StrictMode double-invocation of useState /
// useReducer initializers doesn't re-strip the URL or re-consume the
// pending-capture stash. The side effects inside computeInitialAppState
// (replaceState + localStorage clear) MUST happen exactly once per
// page load — the cache guarantees that.
let _initialStateCache: AppState | null = null;

/**
 * The initial AppState for AppCanvas. When the URL carries
 * `?signed_in=1` AND localStorage has a stashed capture, we land
 * straight on the review screen with the lead hydrated — the user
 * picks right back up where Save bounced them out. Otherwise, home.
 */
export function computeInitialAppState(): AppState {
  if (_initialStateCache !== null) return _initialStateCache;
  _initialStateCache = _deriveInitialAppState();
  return _initialStateCache;
}

function _deriveInitialAppState(): AppState {
  const { signedIn } = consumeAuthCallbackParams();
  if (!signedIn) return { kind: "home" };
  const pending = loadPendingCapture();
  clearPendingCapture();
  if (pending === null) return { kind: "home" };
  return {
    kind: "review",
    lead: stashedResultToLead(pending.result),
    // Pending stash carries text/voice/photo, but only text + voice
    // can reach this resumed-review path (photo capture saves as a
    // batch and doesn't use the OAuth stash). Narrow defensively.
    source: pending.source === "voice" ? "voice" : "text",
    preservedText: null,
    saveError: null,
    authPanel: null,
  };
}

/**
 * Reset the module-scope cache. Test-only — production code path
 * relies on the cache surviving for the lifetime of the page load.
 */
export function _resetInitialStateCacheForTests(): void {
  _initialStateCache = null;
}
