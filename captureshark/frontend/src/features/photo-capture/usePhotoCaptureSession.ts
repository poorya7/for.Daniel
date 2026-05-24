/**
 * usePhotoCaptureSession — the entire photo capture lifecycle.
 *
 * Owns:
 *   - Camera lifecycle (getUserMedia stream promise, consent gating,
 *     retake re-arming, cancel teardown).
 *   - Multi-row extraction stream + 6s heartbeat watchdog for sustained
 *     silence (signal-drop detection).
 *   - Collected row state + per-row edit indexing + remove-row splice.
 *   - Save-All batch flow (auth gate → enqueue all N rows in one IDB
 *     transaction → cascade plays on local durable write).
 *   - Offline raw-photo fallback (network errors + watchdog trips drop
 *     the raw photo into the queue so the drainer can extract when
 *     signal returns).
 *
 * Communicates back to the orchestrator (AppCanvas) via callbacks
 * passed in `params`. The orchestrator keeps the screen-state machine
 * (`phase`), the unified review surface's lead (`currentLead`), the
 * auth-panel slot, the saved-summary, and the save-target. The hook
 * never touches those directly.
 *
 * Pure cross-boundary wires:
 *   - Tap a photo row → hook calls `onEnterRowEdit(lead, index)`;
 *     orchestrator opens the unified review surface in row-edit mode.
 *   - Tap Back-to-list in the review footer → orchestrator calls
 *     `handleBackToPhotoList(editedLead)`; hook merges + calls
 *     `onReturnFromRowEdit()`.
 *   - Save All flight → hook fires `onSavingStart()` / `onSaved(summary,
 *     target)` / `onAuthNeeded(panel)`; orchestrator flips the screen.
 */

import { useRef, useState } from "react";

import {
  applyLeadEditsToPhotoRow,
  photoRowToLead,
  type Lead,
} from "@/features/review/Lead";
import {
  composeSavedSummary,
  type SavedSummary,
} from "@/features/review/SavedConfirmation";
import { checkSaveAuth } from "@/features/auth/saveAuth";
import {
  streamPhotoCaptureRows,
  type ConnectedSheet,
  type PhotoDone,
  type PhotoRow,
  type SheetTarget,
} from "@/lib/api";
import { hasPhotoConsent } from "@/lib/photoConsent";
import {
  enqueueExtractedPhotoRows,
  enqueueRawPhoto,
} from "@/lib/queue/actions";
import { drainNow } from "@/lib/queue/drainer";
import type { QueueSheetTarget } from "@/lib/queue/types";
import type { AuthStatus } from "@/stores/auth";

// Same 6s budget the legacy App.tsx uses. Long enough that a slow
// backend with a real signal can't trip it; short enough that genuine
// connection loss bounces fast.
const STREAM_IDLE_TIMEOUT_MS = 6_000;

/**
 * Translate a backend error code from the photo extraction stream
 * into calm plain-English copy the photo failure overlay renders.
 * Returns `{ headline, subline }` so the failure card renders the
 * verb-style headline in the sage Outfit + glow treatment and the
 * muted subline below it. Tone rule (per the photo plan): copy OWNS
 * the difficulty of the photo — not the user, not the system.
 */
export function photoErrorCopy(
  code: string | undefined,
  fallback: string,
): { headline: string; subline: string | null } {
  switch (code) {
    case "no_signal":
      return {
        headline: "Reading didn't work",
        subline: "Photo was a bit messy. Want to try another?",
      };
    case "image_decode_failed":
    case "unsupported_image":
      return {
        headline: "Photo didn't work",
        subline: "Try a different one?",
      };
    case "image_too_large":
    case "image_too_small":
      // Same honest copy for both directions — the user doesn't have
      // (or need) the file-size vocabulary; what they care about is
      // that the photo couldn't be read. Was previously "Photo's a
      // bit big" for BOTH cases, which mis-described too-small
      // captures (e.g. heavy zoom shrinking the crop below the
      // backend minimum).
      return {
        headline: "Couldn't read this photo",
        subline: "Try another shot?",
      };
    case "image_preprocess_failed":
      return {
        headline: "Something looked off",
        subline: "Want to try another?",
      };
    case "image_moderation_refused":
      return {
        headline: "Reading didn't work",
        subline: "Want to try another photo?",
      };
    case "network":
      return {
        headline: "No internet",
        subline: "Try again in a moment.",
      };
    case "ai_busy":
    case "ai_unavailable":
    case "upstream_unavailable":
    case "upstream_rate_limited":
      return {
        headline: "Reader is busy",
        subline: "Try again in a moment.",
      };
    default:
      return { headline: fallback, subline: null };
  }
}

/**
 * Build the saved-summary structure for a multi-row photo save. For
 * N=1, surface the row's name + area same shape as text / voice
 * saves. For N>1, surface the count — "Saved 4 leads" in the saved
 * surface's line slot.
 */
export function buildPhotoSavedSummary(rows: PhotoRow[]): SavedSummary {
  if (rows.length === 1) {
    const onlyRow = rows[0];
    return composeSavedSummary(
      onlyRow.fields.name.value,
      onlyRow.fields.area.value,
    );
  }
  return composeSavedSummary(`${String(rows.length)} leads`, null);
}

/**
 * Build the QueueSheetTarget for the current auth state. Centralised
 * so the three call sites (single-row save, photo-batch save, raw
 * offline photo) can't drift.
 */
function buildSheetTarget(
  connectedSheet: ConnectedSheet | null,
): QueueSheetTarget {
  if (connectedSheet !== null) {
    return {
      spreadsheet_id: connectedSheet.spreadsheet_id,
      tab_name: connectedSheet.worksheet_title,
      display_name: connectedSheet.display_name,
    };
  }
  return {
    spreadsheet_id: "dev",
    tab_name: "",
    display_name: "your sheet",
  };
}

function buildSheetTargetForLink(
  connectedSheet: ConnectedSheet | null,
): SheetTarget | null {
  if (connectedSheet === null) return null;
  return {
    spreadsheet_id: connectedSheet.spreadsheet_id,
    display_name: connectedSheet.display_name,
  };
}

interface PhotoCaptureSessionParams {
  /** Current screen phase — used to guard handlers that only fire in a specific phase. */
  phase: string;
  connectedSheet: ConnectedSheet | null;
  authConfigured: boolean | null;
  authStatus: AuthStatus;
  hasDriveAccess: boolean;

  /**
   * User tapped a row on the multi-row summary — open the unified
   * review surface with this lead and remember the row index so the
   * "Back to list" footer can merge edits back later.
   */
  onEnterRowEdit: (lead: Lead) => void;
  /**
   * "Back to list" tapped from the review footer — orchestrator should
   * clear `currentLead` and return to the photo-review screen.
   */
  onReturnFromRowEdit: () => void;

  /** Save-All flight started — flip to the saving screen. */
  onSavingStart: () => void;
  /**
   * Save-All local write committed — flip to the saved screen with the
   * given summary line + open-in-sheets target.
   */
  onSaved: (summary: SavedSummary, target: SheetTarget | null) => void;
  /**
   * Auth gate failed — surface the SignInPanel with the matching variant.
   */
  onAuthNeeded: (panel: "needs-sign-in" | "needs-retry") => void;
  /** Discard from any photo surface — full reset back to home. */
  onDiscardComplete: () => void;
  /**
   * "Or type it in instead?" escape from the in-camera failure overlay
   * — switch to the text-input screen.
   */
  onTypeInstead: () => void;
  /**
   * Camera surface should open — orchestrator flips phase to "photo".
   * Kept as a callback (not just a phase-flip inside the hook) so the
   * orchestrator owns the screen-state machine even though the hook
   * owns the stream promise.
   */
  onEnterPhotoPhase: () => void;
  /**
   * Stream landed N>=1 rows — orchestrator flips phase to "photo-review".
   */
  onEnterPhotoReviewPhase: () => void;
}

export interface PhotoCaptureSession {
  // ----- Stream + camera state -----
  photoStreamPromise: Promise<MediaStream> | null;
  photoExtracting: boolean;
  photoExtractionError: { headline: string; subline: string | null } | null;
  photoBounceCount: number;

  // ----- Multi-row state -----
  photoRows: PhotoRow[];
  photoDone: PhotoDone | null;
  photoEditingIndex: number | null;
  photoSaveError: string | null;

  // ----- Handlers -----
  /** Tap Photo on the home screen. Kicks getUserMedia in the user-gesture frame. */
  startPhotoCapture: () => void;
  /** Consent overlay accepted — re-attempt getUserMedia in the new gesture frame. */
  handlePhotoConsentGiven: () => void;
  /** Retake from the in-camera failure overlay. */
  handlePhotoRetake: () => void;
  /** X / Cancel from the camera surface. */
  handlePhotoCancel: () => void;
  /** "Or type it in instead?" from the failure overlay. */
  handleTypeInsteadFromPhoto: () => void;
  /** Tap a row on the multi-row summary — open the unified review surface. */
  handleTapPhotoRow: (index: number) => void;
  /** Remove a row from the multi-row summary. */
  handleRemovePhotoRow: (index: number) => void;
  /**
   * "Back to list" tapped on the review footer when editing a row.
   * Merges the parent's edited lead back into the row, clears the
   * editing index, returns the user to the photo-review screen.
   */
  handleBackToPhotoList: (editedLead: Lead | null) => void;
  /** Retake from the multi-row summary surface. */
  handleRetakeFromPhotoSummary: () => void;
  /** Discard from the multi-row summary surface. */
  handleDiscardPhoto: () => void;
  /** Save-All on the multi-row summary surface. */
  handleSaveAllPhotoRows: () => void;
  /** Camera shutter or gallery file pick — fires the extraction stream. */
  handlePhotoCaptured: (image: Blob) => void;
}

export function usePhotoCaptureSession(
  params: PhotoCaptureSessionParams,
): PhotoCaptureSession {
  // Latest params in a ref so the handlers (which we want to keep
  // referentially stable across renders) can read fresh callback +
  // auth values without re-binding. The handlers themselves are
  // plain closures over the ref, so a parent re-render with a new
  // `onSaved` doesn't bust caller references.
  const paramsRef = useRef(params);
  paramsRef.current = params;

  // ----- Stream / camera state -----
  // The promise the parent kicks off SYNCHRONOUSLY from the Photo
  // button click so iOS Safari honours the user-gesture frame
  // (see PhotoCapture component docs). Null when we open straight
  // into gallery-only mode (camera access previously refused) OR
  // when the photo phase isn't active.
  const [photoStreamPromise, setPhotoStreamPromise] =
    useState<Promise<MediaStream> | null>(null);
  // True while the captured photo is being extracted — the ~2s
  // window between shutter and result. PhotoCapture paints its
  // calm "Reading photo…" overlay while this is true.
  const [photoExtracting, setPhotoExtracting] = useState(false);
  // Friendly retake-prompt copy when extraction fails. Split into
  // headline (verb slot) + optional subline (line slot) so the
  // failure card mirrors the saving panel's verb+line shape.
  const [photoExtractionError, setPhotoExtractionError] = useState<
    { headline: string; subline: string | null } | null
  >(null);
  // Consecutive failures in the current photo session. When >=2, the
  // failure overlay shows a quiet "Or type it in instead?" escape.
  const [photoBounceCount, setPhotoBounceCount] = useState(0);

  // ----- Multi-row state -----
  // The rows extracted from the most recent photo capture. Populated
  // when the photo stream's terminal `photo_done` lands.
  const [photoRows, setPhotoRows] = useState<PhotoRow[]>([]);
  // The terminal photo_done payload — drives the row-count display
  // and supplies the total-rows count to the summary card.
  const [photoDone, setPhotoDone] = useState<PhotoDone | null>(null);
  // Index of the row currently open in the per-row edit surface.
  // Null whenever we're on the summary list (phase === "photo-review").
  const [photoEditingIndex, setPhotoEditingIndex] = useState<number | null>(
    null,
  );
  // Plain-English error from the most recent photo-batch save attempt.
  // Shown inline on the summary list so the user can retry without
  // losing the row list.
  const [photoSaveError, setPhotoSaveError] = useState<string | null>(null);

  // ----- Handlers -----

  // Tap Photo on home. iOS Safari REQUIRES `getUserMedia` to be called
  // synchronously inside the user-gesture handler — deferring via
  // setState/useEffect drops the gesture token. We kick off the promise
  // RIGHT HERE and stash it; PhotoCapture awaits it via prop.
  //
  // If the device has no mediaDevices API OR the user hasn't accepted
  // the in-app photo-AI consent yet, we pass null. PhotoCapture handles
  // both fallbacks (gallery-only OR consent overlay first).
  function startPhotoCapture(): void {
    setPhotoExtractionError(null);
    setPhotoBounceCount(0);
    setPhotoRows([]);
    setPhotoDone(null);
    setPhotoSaveError(null);
    const md = navigator.mediaDevices;
    const canCallGUM = typeof md.getUserMedia === "function";
    if (!canCallGUM || !hasPhotoConsent()) {
      setPhotoStreamPromise(null);
      paramsRef.current.onEnterPhotoPhase();
      return;
    }
    const promise = md.getUserMedia({
      video: { facingMode: "environment" },
      audio: false,
    });
    setPhotoStreamPromise(promise);
    paramsRef.current.onEnterPhotoPhase();
  }

  // Fires the first time a broker on this device taps "Got it" on the
  // photo-AI consent overlay inside PhotoCapture. That tap IS a valid
  // iOS user-gesture frame, so we can kick off `getUserMedia` from here.
  function handlePhotoConsentGiven(): void {
    const md = navigator.mediaDevices;
    if (typeof md.getUserMedia !== "function") {
      setPhotoStreamPromise(null);
      return;
    }
    const promise = md.getUserMedia({
      video: { facingMode: "environment" },
      audio: false,
    });
    setPhotoStreamPromise(promise);
  }

  // Re-arm the camera from inside the in-camera failure overlay. The
  // user tapped Retake, which IS a valid user-gesture frame on iOS —
  // calling getUserMedia here is safe.
  function handlePhotoRetake(): void {
    const md = navigator.mediaDevices;
    if (typeof md.getUserMedia !== "function") {
      setPhotoStreamPromise(null);
      setPhotoExtracting(false);
      setPhotoExtractionError(null);
      return;
    }
    const promise = md.getUserMedia({
      video: { facingMode: "environment" },
      audio: false,
    });
    setPhotoStreamPromise(promise);
    setPhotoExtracting(false);
    setPhotoExtractionError(null);
  }

  // X / Cancel from the camera surface — full reset back to home.
  function handlePhotoCancel(): void {
    setPhotoStreamPromise(null);
    setPhotoExtracting(false);
    setPhotoExtractionError(null);
    setPhotoBounceCount(0);
    paramsRef.current.onDiscardComplete();
  }

  // "Or type it in instead?" escape from the in-camera failure overlay
  // — close the camera, open the text input phase so the broker can
  // still capture the lead by hand.
  function handleTypeInsteadFromPhoto(): void {
    setPhotoStreamPromise(null);
    setPhotoExtracting(false);
    setPhotoExtractionError(null);
    setPhotoBounceCount(0);
    paramsRef.current.onTypeInstead();
  }

  // Tap a row on the multi-row summary → enters the SAME single-lead
  // review surface the text / voice flows use. We snapshot the row's
  // fields into the orchestrator's `currentLead`, set our local
  // editing index, and rely on the orchestrator's footer-shape logic
  // to swap Save/Discard for "Back to list".
  function handleTapPhotoRow(index: number): void {
    const row = photoRows[index];
    setPhotoEditingIndex(index);
    paramsRef.current.onEnterRowEdit(photoRowToLead(row));
  }

  // Hard-remove a row from the batch. Used to skip junk rows that the
  // AI surfaced from sign-in-sheet noise — header lines, hand-drawn
  // arrows, doodles. Splices the row out so the counter ("Save 3
  // leads") and the visible list both reflect the user's curated set.
  function handleRemovePhotoRow(index: number): void {
    setPhotoRows((rows) => rows.filter((_, i) => i !== index));
  }

  // "Back to list" from the unified review surface when we entered it
  // by tapping a photo row. Merges the (possibly edited) lead back
  // into photoRows[index] via applyLeadEditsToPhotoRow, clears the
  // index, asks the orchestrator to return to the photo-review list.
  function handleBackToPhotoList(editedLead: Lead | null): void {
    const editingIdx = photoEditingIndex;
    if (editingIdx === null || editedLead === null) {
      setPhotoEditingIndex(null);
      paramsRef.current.onReturnFromRowEdit();
      return;
    }
    setPhotoRows((rows) =>
      rows.map((row, i) =>
        i === editingIdx ? applyLeadEditsToPhotoRow(row, editedLead) : row,
      ),
    );
    setPhotoEditingIndex(null);
    paramsRef.current.onReturnFromRowEdit();
  }

  // Retake from the multi-row summary surface → re-arm the camera the
  // same way the in-camera failure overlay does (fresh getUserMedia
  // inside this user-gesture frame).
  function handleRetakeFromPhotoSummary(): void {
    setPhotoExtractionError(null);
    setPhotoBounceCount(0);
    setPhotoRows([]);
    setPhotoDone(null);
    setPhotoSaveError(null);
    const md = navigator.mediaDevices;
    if (typeof md.getUserMedia !== "function") {
      setPhotoStreamPromise(null);
      paramsRef.current.onEnterPhotoPhase();
      return;
    }
    const promise = md.getUserMedia({
      video: { facingMode: "environment" },
      audio: false,
    });
    setPhotoStreamPromise(promise);
    paramsRef.current.onEnterPhotoPhase();
  }

  // Discard from the multi-row summary surface — full reset back to
  // home. Mirrors the single-row Discard path.
  function handleDiscardPhoto(): void {
    setPhotoStreamPromise(null);
    setPhotoExtracting(false);
    setPhotoExtractionError(null);
    setPhotoBounceCount(0);
    setPhotoRows([]);
    setPhotoDone(null);
    setPhotoEditingIndex(null);
    setPhotoSaveError(null);
    paramsRef.current.onDiscardComplete();
  }

  // Save all photo rows. Routes through the shared `checkSaveAuth`
  // predicate so the photo-batch path and the single-row path can't
  // drift on auth policy. On gate fail → surface the SignInPanel via
  // onAuthNeeded, same UI as the single-row flow.
  function handleSaveAllPhotoRows(): void {
    if (paramsRef.current.phase !== "photo-review") return;
    setPhotoSaveError(null);
    const decision = checkSaveAuth({
      authConfigured: paramsRef.current.authConfigured,
      authStatus: paramsRef.current.authStatus,
      hasDriveAccess: paramsRef.current.hasDriveAccess,
      connectedSheet: paramsRef.current.connectedSheet,
    });
    if (decision.kind === "allow") {
      runSavePhotoBatch();
      return;
    }
    paramsRef.current.onAuthNeeded(decision.kind);
  }

  // Item 1a: route the photo batch through the offline-resilient queue
  // instead of looping `saveRowToSheet` calls directly. All N rows
  // drop into IndexedDB atomically; the cascade plays the moment the
  // local write commits (per the rev 2 plan's "Saved ✓ on local
  // durable write" rule). The drainer pushes each record to the sheet
  // in the background, using the row's server-minted idempotency key
  // so a mid-batch failure + retry can't write duplicate sheet rows.
  function runSavePhotoBatch(): void {
    const rowsAtStart = photoRows;
    if (rowsAtStart.length === 0) return;
    paramsRef.current.onSavingStart();
    void (async () => {
      const sheetTarget = buildSheetTarget(paramsRef.current.connectedSheet);
      try {
        await enqueueExtractedPhotoRows({
          rows: rowsAtStart,
          sheetTarget,
        });
      } catch {
        // Only honest failure case for the cascade — the local
        // transaction itself failed (quota, IDB disabled). The
        // reviewed row state is still intact, so let the user retry.
        setPhotoSaveError(
          "Couldn't save these leads on this phone — storage may be full. Try again.",
        );
        paramsRef.current.onEnterPhotoReviewPhase();
        return;
      }

      // Local durability confirmed for all N rows — cascade plays.
      paramsRef.current.onSaved(
        buildPhotoSavedSummary(rowsAtStart),
        buildSheetTargetForLink(paramsRef.current.connectedSheet),
      );

      // Background drain — fire-and-forget. Failures and auth-needed
      // states surface via the queue UI, not here.
      void drainNow();
    })();
  }

  // PhotoCapture handed us the captured blob (live camera shutter or
  // gallery file pick). Kicks off the multi-row extraction stream and
  // lands the collected rows in `photoRows` on success. A 6s heartbeat
  // watchdog detects sustained connection silence (re-armed on every
  // heartbeat / row / warning); zero rows OR `status === "no_signal"`
  // bounces to the calm "Reading didn't work" retake overlay on the
  // camera surface.
  function handlePhotoCaptured(image: Blob): void {
    setPhotoExtracting(true);
    setPhotoExtractionError(null);

    let watchdogId: number | null = null;
    let watchdogTripped = false;
    const armWatchdog = (onFire: () => void): void => {
      if (watchdogId !== null) window.clearTimeout(watchdogId);
      watchdogId = window.setTimeout(() => {
        watchdogId = null;
        watchdogTripped = true;
        onFire();
      }, STREAM_IDLE_TIMEOUT_MS);
    };
    const disarmWatchdog = (): void => {
      if (watchdogId !== null) {
        window.clearTimeout(watchdogId);
        watchdogId = null;
      }
    };

    const collected: PhotoRow[] = [];

    const surfaceError = (
      message: string,
      code: string | undefined,
    ): void => {
      const friendly = photoErrorCopy(code, message);
      setPhotoExtractionError(friendly);
      setPhotoExtracting(false);
      setPhotoBounceCount((n) => n + 1);
    };

    // Item 1b — when the extraction stream can't reach the server
    // (initial fetch failed, watchdog tripped on no-heartbeat, or
    // mid-stream error with code "network"), drop the raw photo into
    // the safety net instead of bouncing to the retake overlay. The
    // drainer extracts + fans it out into per-row records when signal
    // returns.
    const enqueueRawPhotoAsOfflineSave = async (): Promise<void> => {
      const sheetTarget = buildSheetTarget(paramsRef.current.connectedSheet);
      try {
        await enqueueRawPhoto({ blob: image, sheetTarget });
      } catch {
        // IDB write itself failed (quota, disabled). Fall back to the
        // standard retake overlay so the user doesn't think their
        // photo was saved when it wasn't.
        surfaceError(
          "Couldn't save on this phone — storage may be full.",
          "network",
        );
        return;
      }
      // Local durability confirmed. Play the cascade with offline-
      // specific copy so Linda knows the photo is safe AND that the
      // leads will land in her sheet later (not now).
      setPhotoExtracting(false);
      setPhotoStreamPromise(null);
      paramsRef.current.onSaved(
        {
          prefix: "Saved",
          name: null,
          connector: "",
          area: null,
          fallback: "offline — we'll add the leads when signal returns",
        },
        null,
      );
      void drainNow();
    };

    const armConnectionWatchdog = (): void => {
      armWatchdog(() => {
        // Item 1b — sustained silence almost always means signal
        // dropped. Route to the offline-save path so Linda's photo is
        // safe locally; the drainer extracts when signal returns.
        void enqueueRawPhotoAsOfflineSave();
      });
    };

    void streamPhotoCaptureRows(image, {
      onHeartbeat: () => {
        if (watchdogTripped) return;
        armConnectionWatchdog();
      },
      onPhotoWarning: () => {
        if (watchdogTripped) return;
        armConnectionWatchdog();
      },
      onPhotoRow: (row) => {
        if (watchdogTripped) return;
        armConnectionWatchdog();
        collected.push(row);
      },
      onPhotoDone: (done) => {
        if (watchdogTripped) return;
        disarmWatchdog();
        // Zero rows OR explicit "no_signal" → calm retake overlay on
        // the camera surface (NOT a teleport-to-home). The user-visible
        // outcome is identical regardless of which path the server
        // took to "no leads", so the canvas surfaces them the same way.
        if (done.status === "no_signal" || collected.length === 0) {
          surfaceError(
            "Couldn't extract any leads from the photo.",
            "no_signal",
          );
          return;
        }
        setPhotoRows(collected);
        setPhotoDone(done);
        setPhotoExtracting(false);
        paramsRef.current.onEnterPhotoReviewPhase();
      },
      onError: (message, code) => {
        if (watchdogTripped) return;
        disarmWatchdog();
        // Item 1b — network errors mean signal dropped. Save the raw
        // photo locally and let the drainer extract later. Other
        // codes (image_decode_failed, image_too_large, etc.) are
        // genuine photo problems, not connectivity — keep them on the
        // retake overlay.
        if (code === "network") {
          void enqueueRawPhotoAsOfflineSave();
          return;
        }
        surfaceError(message, code);
      },
    });
  }

  return {
    photoStreamPromise,
    photoExtracting,
    photoExtractionError,
    photoBounceCount,
    photoRows,
    photoDone,
    photoEditingIndex,
    photoSaveError,
    startPhotoCapture,
    handlePhotoConsentGiven,
    handlePhotoRetake,
    handlePhotoCancel,
    handleTypeInsteadFromPhoto,
    handleTapPhotoRow,
    handleRemovePhotoRow,
    handleBackToPhotoList,
    handleRetakeFromPhotoSummary,
    handleDiscardPhoto,
    handleSaveAllPhotoRows,
    handlePhotoCaptured,
  };
}
