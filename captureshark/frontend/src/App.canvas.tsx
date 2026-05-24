/**
 * AppCanvas — the no-panel app shell.
 *
 * Four-layer architecture (post-Phase-11):
 *
 *   1. Data — `Lead` type + adapters live in features/review/Lead.ts.
 *      Pure data shape, no UI, no awareness of canvas / photo / save.
 *
 *   2. Screen state — `features/app-state/appState.ts` defines the
 *      discriminated-union AppState (one shape per screen), the
 *      AppAction union of every transition, and the pure reducer that
 *      enforces "you can only be on one screen at a time, and each
 *      screen only carries the data it actually needs." No impossible
 *      states are representable.
 *
 *   3. Rendering — features/review/LeadReviewCard.tsx is the review card.
 *      Takes a `lead` prop, draws it, fires `onCommitField` /
 *      `onCommitAgent` when the user edits. Owns its own per-field edit
 *      panel (which field is open, draft buffer, focus management, live
 *      formatters). No knowledge of where the lead came from or what
 *      the footer button does.
 *
 *   4. Orchestration — THIS file. Wires the screen-state machine to
 *      side effects: extraction streams, queue enqueue, drainer kicks,
 *      pending-capture stash. Mounts LeadReviewCard with the right
 *      footer for the current screen (Save+Discard for capture flow,
 *      Back-to-list for photo-row-edit, SignInPanel when auth is needed).
 *
 * The review surface is mounted from TWO screen kinds using the SAME
 * card component:
 *   - Text / voice capture lands on `kind === "review"` with a fresh
 *     extraction result loaded into the state's `lead` field.
 *   - Tapping a photo row from the multi-row summary lands on
 *     `kind === "photo-row-edit"` — same card, same edit affordances,
 *     but the footer slot becomes "Back to list" instead of
 *     Save+Discard. The photo session hook owns the row index +
 *     merge-back-on-return logic.
 *
 * Phase swaps are instant. The only animated transition in the app
 * is the saving → saved cascade (scanner sweep + staggered fade-ins
 * on the outcome surface).
 */

import { useEffect, useReducer, useRef, type ReactElement } from "react";

import { CanvasVoice } from "@/components/CanvasVoice/CanvasVoice";
import { PhotoCapture } from "@/components/PhotoCapture/PhotoCapture";
import { SharkLoader } from "@/components/SharkLoader/SharkLoader";
import { useDismissFlow } from "@/features/dismiss/useDismissFlow";
import {
  appReducer,
  computeInitialAppState,
  type AppState,
} from "@/features/app-state/appState";
import { checkSaveAuth } from "@/features/auth/saveAuth";
import { SignInPanel } from "@/features/auth/SignInPanel";
import { usePhotoCaptureSession } from "@/features/photo-capture/usePhotoCaptureSession";
import {
  leadToExtractedFields,
  leadToStashStreamingResult,
  setLeadAgent,
  setLeadField,
  streamingResultToLead,
  type AgentState,
  type EditableLeadFieldKey,
  type Lead,
} from "@/features/review/Lead";
import {
  LeadReviewCard,
  type LeadReviewCardHandle,
} from "@/features/review/LeadReviewCard";
import { PhotoSummaryCard } from "@/features/review/PhotoSummaryCard";
import {
  composeSavedSummary,
  type SavedSummary,
} from "@/features/review/SavedConfirmation";
import { streamTextCapture, streamVoiceCapture } from "@/lib/api";
import { savePendingCapture } from "@/lib/pendingCapture";
import { enqueueExtractedLead } from "@/lib/queue/actions";
import { drainNow } from "@/lib/queue/drainer";
import type { QueueSheetTarget } from "@/lib/queue/types";
import { useAuthStore } from "@/stores/auth";

import "./App.canvas.css";

// Cycling phrases shown under the SAVING eyebrow during the save
// flight — same family the legacy outcome panel uses, with the
// "Writing to … sheet" first phrase opening warm.
const SAVING_PHRASES = [
  "Writing to your sheet",
  "Saving the details",
  "Almost there",
] as const;

// Same interval the legacy LoadingPhase uses for the phrase carousel.
// Long enough to read; short enough that a slow save shows multiple
// phrases (so the surface never reads as frozen).
const SAVING_PHRASE_INTERVAL_MS = 5500;

// Compute the first-name to show in the saving subhead. Empty / pure-
// whitespace name yields null (the JSX collapses the subhead slot).
function subheadNameFor(lead: Lead): string | null {
  const trimmed = lead.name.value.trim();
  if (trimmed === "") return null;
  return trimmed.split(/\s+/)[0];
}

// Helper to read the lead off of any state-kind that carries one.
// Returns null on screens that don't have a lead in scope.
function leadFromState(state: AppState): Lead | null {
  if (state.kind === "review") return state.lead;
  if (state.kind === "photo-row-edit") return state.lead;
  if (state.kind === "saving") return state.lead;
  return null;
}

export function AppCanvas(): ReactElement {
  // The screen-state machine. Single source of truth for which screen
  // is showing AND what data that screen needs. Initial state is
  // computed once (URL strip + pending-capture stash consume happen
  // exactly once per page load, guarded inside computeInitialAppState).
  const [state, dispatch] = useReducer(appReducer, undefined, computeInitialAppState);

  // Auth store subscriptions. Read individual selectors so a change to
  // an unrelated slice (e.g. user picture URL) doesn't re-render the
  // canvas. The save gate reads all four of these to decide whether
  // to fire the save or surface the sign-in panel.
  const authStatus = useAuthStore((s) => s.status);
  const hasDriveAccess = useAuthStore((s) => s.hasDriveAccess);
  const connectedSheet = useAuthStore((s) => s.connectedSheet);
  const authConfigured = useAuthStore((s) => s.configured);
  const refreshAuth = useAuthStore((s) => s.refresh);

  // First-mount auth resolve. The store boots in `unknown`; this call
  // flips it to `signed-in` or `signed-out` before the user can tap
  // Save. If they came back via `?signed_in=1`, the cookie is already
  // valid and this confirms it.
  useEffect(() => {
    void refreshAuth();
  }, [refreshAuth]);

  // Phrase carousel — only ticks while the save flight is in progress.
  // The reducer's CycleSavingPhrase action advances the index modulo
  // the phrase count; the interval just fires the dispatch.
  useEffect(() => {
    if (state.kind !== "saving") return undefined;
    const id = window.setInterval(() => {
      dispatch({ type: "CycleSavingPhrase" });
    }, SAVING_PHRASE_INTERVAL_MS);
    return () => {
      window.clearInterval(id);
    };
  }, [state.kind]);

  // Kicks off a real streaming extraction against the backend. On
  // success, dispatches ExtractionDone (loading → review). On failure,
  // dispatches ExtractionFailed (loading → text-input with the
  // preserved text + a calm inline error line). Streaming-reveal during
  // loading is parked — the loading phase already IS the streaming-time
  // beat, and keeping the storage simple matches the no-twitch ASMR
  // principle in `docs/_workflow/02_PRINCIPLES.md §2`.
  function handleExtract(): void {
    if (state.kind !== "text-input") return;
    const trimmed = state.text.trim();
    if (trimmed === "") return;
    const textToSend = state.text;
    dispatch({ type: "StartExtractText" });
    void streamTextCapture(textToSend, {
      onDelta: () => {
        /* intentionally empty */
      },
      onDone: (result) => {
        dispatch({
          type: "ExtractionDone",
          lead: streamingResultToLead(result),
          source: "text",
        });
      },
      onError: (message) => {
        dispatch({ type: "ExtractionFailed", message, source: "text" });
      },
    });
  }

  // Voice capture — fires when CanvasVoice finishes a valid recording.
  // Same backend / state path as text extraction: dispatch
  // StartExtractVoice (voice → loading), kick off the stream, dispatch
  // ExtractionDone or ExtractionFailed on completion.
  function handleVoiceCaptured(audio: Blob): void {
    dispatch({ type: "StartExtractVoice" });
    void streamVoiceCapture(audio, {
      onDelta: () => {
        /* intentionally empty — review paints on done */
      },
      onDone: (result) => {
        dispatch({
          type: "ExtractionDone",
          lead: streamingResultToLead(result),
          source: "voice",
        });
      },
      onError: (message) => {
        dispatch({ type: "ExtractionFailed", message, source: "voice" });
      },
    });
  }

  // --- Photo capture session --------------------------------------------
  //
  // All photo-mode state + handlers live in usePhotoCaptureSession.
  // The hook owns the camera lifecycle, watchdog, multi-row extraction,
  // row collection, save-all flight, and the offline raw-photo path.
  // The orchestrator owns the screen-state machine — the hook's
  // ten callbacks each dispatch an action; same callback contract,
  // dispatch-driven implementations.
  const photo = usePhotoCaptureSession({
    phase: state.kind,
    connectedSheet,
    authConfigured,
    authStatus,
    hasDriveAccess,
    onEnterRowEdit: (lead) => {
      dispatch({ type: "EnterPhotoRowEdit", lead });
    },
    onReturnFromRowEdit: () => {
      dispatch({ type: "ReturnFromPhotoRowEdit" });
    },
    onSavingStart: () => {
      dispatch({
        type: "StartSave",
        subheadName: null,
        lead: null,
        source: null,
        preservedText: null,
      });
    },
    onSaved: (summary, target) => {
      dispatch({ type: "SaveLocalWriteCommitted", summary, target });
    },
    onAuthNeeded: (panel) => {
      dispatch({ type: "PhotoSaveAuthGateFailed", panel });
    },
    onDiscardComplete: () => {
      dispatch({ type: "Discard" });
    },
    onTypeInstead: () => {
      dispatch({ type: "GoToTextInput" });
    },
    onEnterPhotoPhase: () => {
      dispatch({ type: "GoToPhoto" });
    },
    onEnterPhotoReviewPhase: () => {
      dispatch({ type: "EnterPhotoReview" });
    },
  });

  // Tap Save on the review surface. Gates by auth — see checkSaveAuth's
  // docstring for the five cases. The actual save flight is split into
  // runSave so the picker path (deferred) and the direct path can
  // share the body without duplication.
  function handleSave(): void {
    if (state.kind !== "review") return;
    const decision = checkSaveAuth({
      authConfigured,
      authStatus,
      hasDriveAccess,
      connectedSheet,
    });
    if (decision.kind === "allow") {
      runSave(state);
      return;
    }
    dispatch({ type: "SaveAuthGateFailed", panel: decision.kind });
  }

  // Kicks off the save flight via the offline-resilient queue (Item 0).
  // Dispatches StartSave (review → saving) so the fin resurfaces and
  // the SAVING copy paints; the moment the LOCAL IndexedDB write
  // commits — Linda's lead is durably on her device, even if signal
  // drops the next second — we dispatch SaveLocalWriteCommitted with
  // the composed summary so the cascade plays. The actual sheet write
  // happens in the background via the drainer; transient failures,
  // auth needs, and retry state are surfaced by the queue UI rather
  // than blocking the user here.
  //
  // The only honest failure case for the cascade is the local write
  // itself failing (quota, disabled IndexedDB in privacy mode); we
  // dispatch SaveLocalWriteFailed, which the reducer maps back to
  // review with the in-flight lead + a calm inline error.
  function runSave(reviewState: AppState & { kind: "review" }): void {
    const lead = reviewState.lead;
    const source = reviewState.source;
    dispatch({
      type: "StartSave",
      subheadName: subheadNameFor(lead),
      lead,
      source,
      preservedText: reviewState.preservedText,
    });
    void (async () => {
      const sheetTarget: QueueSheetTarget =
        connectedSheet !== null
          ? {
              spreadsheet_id: connectedSheet.spreadsheet_id,
              tab_name: connectedSheet.worksheet_title,
              display_name: connectedSheet.display_name,
            }
          : {
              // Dev placeholder. The drainer doesn't read this for the
              // wire payload (the backend picks the real target from
              // the session); this label is only ever shown by the
              // queue UI if the save stays pending.
              spreadsheet_id: "dev",
              tab_name: "",
              display_name: "your sheet",
            };

      try {
        await enqueueExtractedLead({
          source,
          fields: leadToExtractedFields(lead),
          originalText: lead.original_note,
          sheetTarget,
        });
      } catch {
        dispatch({
          type: "SaveLocalWriteFailed",
          message:
            "Couldn't save on this phone — storage may be full. Try again.",
        });
        return;
      }

      // Durable local write confirmed — the cascade is honest now.
      dispatch({
        type: "SaveLocalWriteCommitted",
        summary: composeSavedSummary(
          lead.name.value === "" ? null : lead.name.value,
          lead.area.value === "" ? null : lead.area.value,
        ),
        target:
          connectedSheet !== null
            ? {
                spreadsheet_id: connectedSheet.spreadsheet_id,
                display_name: connectedSheet.display_name,
              }
            : null,
      });

      // Nudge the drainer to push the new record up to the sheet now,
      // on top of the runner's online + visibility triggers. Fire-
      // and-forget — any failure (transient network, expired auth)
      // surfaces via the queue UI, not here.
      void drainNow();
    })();
  }

  // Called from inside the SignInPanel just before it navigates the
  // browser to Google. Stashes the current lead so the post-OAuth
  // landing lands the user back on the same review screen with values
  // hydrated, instead of dumping them at a blank home.
  function stashForSignIn(): void {
    const lead = leadFromState(state);
    if (lead === null) return;
    // Source only relevant for review state; photo-row-edit shouldn't
    // hit this path (SignInPanel isn't rendered there). Default to text.
    const source = state.kind === "review" ? state.source : "text";
    savePendingCapture({
      source,
      result: leadToStashStreamingResult(lead),
    });
  }

  // Imperative handle into the review card so a backdrop tap can ask
  // it to close any open per-field edit panel BEFORE the canvas pops
  // the outer layer. Lets the multilevel pop rule extend down into
  // the card without lifting the field-edit state up.
  const reviewCardRef = useRef<LeadReviewCardHandle | null>(null);

  // Backdrop-tap dismiss. Policy + confirm Dialog live in
  // useDismissFlow — the orchestrator just wires inputs in and renders
  // the returned dialog node.
  const { handleBackdropTap, dismissDialog } = useDismissFlow({
    state,
    dispatch,
    onSaveFromReview: handleSave,
    onDiscardPhoto: photo.handleDiscardPhoto,
    onBackToPhotoList: photo.handleBackToPhotoList,
    attemptInnerDismiss: () =>
      reviewCardRef.current?.dismissOpenFieldEdit() ?? { kind: "none" },
  });

  // Per-field edit state lives INSIDE LeadReviewCard. The card owns
  // editingField / editDraft / editInputRef + the live phone / budget
  // formatters + the focus useEffect. The parent only sees commits
  // (via onCommitField / onCommitAgent props on the card).
  function handleCommitLeadField(
    key: EditableLeadFieldKey,
    value: string,
  ): void {
    const lead = leadFromState(state);
    if (lead === null) return;
    dispatch({ type: "UpdateLead", lead: setLeadField(lead, key, value) });
  }

  // Yes / No agent toggle handler — merges into the current lead.
  function handleCommitLeadAgent(agent: AgentState): void {
    const lead = leadFromState(state);
    if (lead === null) return;
    dispatch({ type: "UpdateLead", lead: setLeadAgent(lead, agent) });
  }

  // URL to the open-in-sheets link on the saved surface. Built once
  // we have a target; null before then keeps the link inert.
  const saveTarget = state.kind === "saved" ? state.target : null;
  const sheetUrl = saveTarget
    ? `https://docs.google.com/spreadsheets/d/${saveTarget.spreadsheet_id}/edit`
    : null;

  // The lead the review surface should mount. Comes from review state
  // (text/voice flow) OR photo-row-edit (tapped row from photo summary).
  const reviewLead: Lead | null =
    state.kind === "review"
      ? state.lead
      : state.kind === "photo-row-edit"
        ? state.lead
        : null;

  // The footer the LeadReviewCard renders at the bottom of its review
  // surface. Three context-specific shapes:
  //   - Editing a row tapped from the photo list → just "Back to list"
  //   - Auth gate triggered → SignInPanel (Save bounced off needing auth)
  //   - Default capture flow → Save + optional inline error + Discard
  // The card itself is agnostic — it just slots whatever we hand it.
  // Computed inline (not memoized) so the handlers always close over
  // the latest state — memoization would risk stale-handler bugs and
  // the JSX cost is negligible compared to the rest of the render.
  const reviewFooter: ReactElement =
    state.kind === "photo-row-edit" ? (
      <button
        type="button"
        className="app-canvas__save"
        onClick={() => {
          photo.handleBackToPhotoList(state.lead);
        }}
      >
        Back to list
      </button>
    ) : state.kind === "review" && state.authPanel !== null ? (
      <div className="app-canvas__sign-in">
        <SignInPanel
          variant={state.authPanel}
          onDismiss={() => {
            dispatch({ type: "DismissAuthPanel" });
          }}
          onBeforeRedirect={stashForSignIn}
        />
      </div>
    ) : (
      <>
        <button
          type="button"
          className="app-canvas__save"
          onClick={handleSave}
        >
          Save to sheet
        </button>
        {state.kind === "review" && state.saveError !== null ? (
          <p className="app-canvas__save-error" role="status">
            {state.saveError}
          </p>
        ) : null}
        <button
          type="button"
          className="app-canvas__discard"
          onClick={() => {
            dispatch({ type: "Discard" });
          }}
        >
          Discard
        </button>
      </>
    );

  // Photo-review auth panel — separate state.kind branch, separate
  // SignInPanel mount point so the photo summary slot can swap to it.
  const photoReviewAuthPanel =
    state.kind === "photo-review" ? state.authPanel : null;

  // Current text-input draft + error (only meaningful when kind ===
  // "text-input"; collapsed to defaults otherwise so the JSX doesn't
  // need to branch on kind for the textarea).
  const textValue = state.kind === "text-input" ? state.text : "";
  const extractError =
    state.kind === "text-input" ? state.extractError : null;
  const isExtracting = state.kind === "loading";

  // Saving-surface subhead name — read from the saving state's
  // payload, set at StartSave dispatch time so it survives mid-save
  // edits.
  const savingSubhead =
    state.kind === "saving" ? state.subheadName : null;
  const savingPhraseIdx =
    state.kind === "saving" ? state.phraseIdx : 0;

  return (
    <div
      className="app-canvas"
      data-phase={state.kind}
      data-fin={state.kind === "loading" || state.kind === "saving" ? "visible" : "hidden"}
    >
      {/* Backdrop catcher — sits behind every content panel so any
          tap that falls through (i.e. lands on bare cream, never on
          an active interactive panel) routes to handleBackdropTap.
          Inactive panels already have `pointer-events: none` per
          phase, so their footprint passes through. Active panels
          absorb their own taps. This separates "real backdrop tap"
          from "tap on a row inside the active panel" without any
          target/currentTarget heuristic. */}
      <div
        className="app-canvas__backdrop"
        onClick={handleBackdropTap}
        aria-hidden="true"
      />
      <div className="app-canvas__home">
        <header className="app-canvas__hero">
          <h1 className="app-canvas__wordmark" aria-label="CaptureShark">
            <span className="app-canvas__wordmark-capture">Capture</span>
            <span className="app-canvas__wordmark-shark">Shark</span>
          </h1>
          <div className="app-canvas__tagline-group">
            <p className="app-canvas__tagline">
              Field lead{" "}
              <span aria-hidden="true">→</span>{" "}
              <span className="app-canvas__tagline-accent">Google Sheet</span>{" "}
              in seconds
            </p>
            <p className="app-canvas__subtagline">
              Photo, voice, or text. AI does the rest.
            </p>
          </div>
        </header>

        <nav className="app-canvas__modes" aria-label="Capture mode">
          <button
            type="button"
            className="app-canvas__mode"
            aria-label="Photo"
            onClick={photo.startPhotoCapture}
          >
            <span className="app-canvas__mode-icon" aria-hidden="true"><CameraIcon /></span>
            <span>Photo</span>
          </button>
          <button
            type="button"
            className="app-canvas__mode"
            aria-label="Voice"
            onClick={() => {
              dispatch({ type: "GoToVoice" });
            }}
          >
            <span className="app-canvas__mode-icon" aria-hidden="true"><MicIcon /></span>
            <span>Voice</span>
          </button>
          <button
            type="button"
            className="app-canvas__mode"
            aria-label="Text"
            onClick={() => {
              dispatch({ type: "GoToTextInput" });
            }}
          >
            <span className="app-canvas__mode-icon" aria-hidden="true"><FileTextIcon /></span>
            <span>Text</span>
          </button>
        </nav>
      </div>

      {/* New-lead text input panel. Per-field editing lives INSIDE
          LeadReviewCard (the card owns its own edit panel under the
          same `app-canvas__input`-slot positioning the parent assigns
          it). Cleaner separation of concerns: this surface is for
          capturing a new lead from a free-form note; lead-internal
          edits live with the lead UI. */}
      <div className="app-canvas__input">
        <p className="app-canvas__lead">New lead</p>
        <textarea
          className="app-canvas__textarea"
          value={textValue}
          onChange={(e) => {
            dispatch({ type: "SetText", text: e.target.value });
          }}
          placeholder="Type a note about your lead…"
        />
        <button
          type="button"
          className="app-canvas__extract"
          disabled={textValue.trim() === "" || isExtracting}
          onClick={handleExtract}
        >
          Extract details
        </button>
        {extractError !== null ? (
          <p className="app-canvas__extract-error" role="status">
            {extractError}
          </p>
        ) : null}
      </div>

      <div className="app-canvas__loader" aria-live="polite">
        <p className="app-canvas__eyebrow">Extracting</p>
        <p className="app-canvas__subtext">Pulling out the details…</p>
      </div>

      {/* Voice phase — inline consent on first visit, then mic +
          recording + stop. On a valid recording the blob lands in
          handleVoiceCaptured, which kicks the same loading → review
          flow text extraction uses. */}
      <div className="app-canvas__voice-section">
        <CanvasVoice
          active={state.kind === "voice"}
          onCaptured={handleVoiceCaptured}
          onClose={() => {
            dispatch({ type: "GoToHome" });
          }}
          onConsentDismiss={() => {
            dispatch({ type: "GoToHome" });
          }}
        />
      </div>

      {/* Review surface — the slot positioning lives in App.canvas.css
          under .app-canvas__review; the LeadReviewCard component owns
          everything that renders INSIDE the slot (heading, paged rows,
          per-field edit panel, internal data-editing toggle). */}
      <section
        className="app-canvas__review"
        aria-labelledby="lead-review-heading"
      >
        {reviewLead !== null ? (
          <LeadReviewCard
            ref={reviewCardRef}
            lead={reviewLead}
            onCommitField={handleCommitLeadField}
            onCommitAgent={handleCommitLeadAgent}
            footer={reviewFooter}
          />
        ) : null}
      </section>

      {/* Saving copy — same family as the loading copy (eyebrow +
          subhead + cycling phrase) so the surface reads as "the system
          is doing work" the same way it did during extraction. Fin is
          visible during this phase (data-fin="visible"), driven by the
          same ambient water layer below — no separate SharkLoader
          overlay is needed because the canvas water never unmounts. */}
      <div className="app-canvas__saving" aria-live="polite">
        <p className="app-canvas__eyebrow">Saving</p>
        {savingSubhead !== null ? (
          <p className="app-canvas__saving-subhead">{savingSubhead}</p>
        ) : null}
        <p className="app-canvas__subtext">
          {SAVING_PHRASES[savingPhraseIdx]}
        </p>
      </div>

      {/* Outcome / saved surface — ported from the legacy OutcomePanel
          with the scanner sweep + per-element cascade preserved 1:1.
          The .app-canvas__outcome--done modifier (driven by
          data-phase="saved" on the root) triggers the scanner sweep
          plus the staggered scanner-in animations on check / verb /
          line / actions. */}
      <section
        className={
          "app-canvas__outcome" +
          (state.kind === "saved" ? " app-canvas__outcome--done" : "")
        }
        aria-labelledby="outcome-heading"
      >
        <div className="app-canvas__outcome-scanner" aria-hidden="true" />
        <div className="app-canvas__outcome-indicator" aria-hidden="true">
          <div className="app-canvas__outcome-check">✓</div>
        </div>
        <h2
          id="outcome-heading"
          className="app-canvas__outcome-verb-area"
        >
          <span className="app-canvas__outcome-verb">Saved</span>
        </h2>
        <div className="app-canvas__outcome-line-area">
          <p className="app-canvas__outcome-line">
            {state.kind === "saved" ? renderSavedLine(state.summary) : null}
          </p>
        </div>
        <div className="app-canvas__outcome-actions">
          <button
            type="button"
            className="app-canvas__outcome-primary"
            onClick={() => {
              dispatch({ type: "CaptureAnother" });
            }}
            tabIndex={state.kind === "saved" ? 0 : -1}
            aria-hidden={state.kind !== "saved"}
          >
            Capture another
          </button>
          <a
            className="app-canvas__outcome-link"
            href={sheetUrl ?? "#"}
            target="_blank"
            rel="noreferrer"
            tabIndex={state.kind === "saved" && sheetUrl !== null ? 0 : -1}
            aria-hidden={state.kind !== "saved"}
          >
            Open in Google Sheets
          </a>
        </div>
      </section>

      <div className="app-canvas__water" aria-hidden="true">
        <SharkLoader size="md" scale={2.2} phase="play" waterAlreadyOn />
      </div>

      {/* Photo capture surface — full-bleed takeover. Mobile camera
          APIs need the whole viewport (iOS Safari especially), so
          this renders ABOVE the rest of the canvas content rather
          than inside it. */}
      {state.kind === "photo" ? (
        <PhotoCapture
          streamPromise={photo.photoStreamPromise}
          onCaptured={photo.handlePhotoCaptured}
          onCancel={photo.handlePhotoCancel}
          extracting={photo.photoExtracting}
          extractionError={photo.photoExtractionError}
          bounceCount={photo.photoBounceCount}
          onRetake={photo.handlePhotoRetake}
          onTypeInstead={photo.handleTypeInsteadFromPhoto}
          onConsentGiven={photo.handlePhotoConsentGiven}
        />
      ) : null}

      {/* Photo summary (multi-row list) — shows the rows extracted
          from the most recent photo. The user can tap any row to
          edit, then Save All to write them all to the sheet at once.
          Auth gate is shared with the single-row Save path: same
          SignInPanel surfaces here if the user isn't signed in. */}
      {state.kind === "photo-review" ? (
        <section
          className="app-canvas__photo-summary"
          aria-labelledby="photo-summary-heading"
        >
          {photoReviewAuthPanel === null ? (
            <PhotoSummaryCard
              rows={photo.photoRows}
              totalRows={photo.photoDone?.total_rows ?? photo.photoRows.length}
              saving={false}
              saveError={photo.photoSaveError}
              onRetake={photo.handleRetakeFromPhotoSummary}
              onSaveAll={photo.handleSaveAllPhotoRows}
              onTapRow={photo.handleTapPhotoRow}
              onDiscard={photo.handleDiscardPhoto}
              onRemoveRow={photo.handleRemovePhotoRow}
            />
          ) : (
            <div className="app-canvas__sign-in">
              <SignInPanel
                variant={photoReviewAuthPanel}
                onDismiss={() => {
                  dispatch({ type: "DismissAuthPanel" });
                }}
                onBeforeRedirect={stashForSignIn}
              />
            </div>
          )}
        </section>
      ) : null}

      {dismissDialog}
    </div>
  );
}

// Render the saved-summary line as a flex row of accented spans —
// name in espresso, area in olive-gold, plain connector words between.
// Matches the legacy OutcomePanel render exactly so the visual reads
// the same on the canvas as it did inside the legacy panel.
function renderSavedLine(summary: SavedSummary): ReactElement {
  return (
    <>
      {summary.name !== null ? (
        <span className="app-canvas__outcome-name">{summary.name}</span>
      ) : null}
      {summary.fallback !== "" ? (
        <span className="app-canvas__outcome-connector">{summary.fallback}</span>
      ) : null}
      {summary.connector !== "" && summary.area !== null ? (
        <>
          <span className="app-canvas__outcome-connector">
            {summary.connector}
          </span>
          <span className="app-canvas__outcome-area">{summary.area}</span>
        </>
      ) : null}
    </>
  );
}

function CameraIcon(): ReactElement {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none"
         stroke="currentColor" strokeWidth="1.75" strokeLinecap="round"
         strokeLinejoin="round" aria-hidden="true">
      <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" />
      <circle cx="12" cy="13" r="3" />
    </svg>
  );
}

function MicIcon(): ReactElement {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none"
         stroke="currentColor" strokeWidth="1.75" strokeLinecap="round"
         strokeLinejoin="round" aria-hidden="true">
      <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" y1="19" x2="12" y2="22" />
    </svg>
  );
}

function FileTextIcon(): ReactElement {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none"
         stroke="currentColor" strokeWidth="1.75" strokeLinecap="round"
         strokeLinejoin="round" aria-hidden="true">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
      <polyline points="10 9 9 9 8 9" />
    </svg>
  );
}
