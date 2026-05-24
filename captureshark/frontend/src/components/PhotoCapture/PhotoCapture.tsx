/**
 * Photo capture — full-bleed camera surface.
 *
 * The one capture mode that bypasses `CaptureSheet`. Mobile camera
 * APIs (especially iOS Safari) effectively require the viewport to
 * belong to the camera; fighting that in a 380×558 modal is a lost
 * battle. PhotoCapture is rendered at the top level by `App.tsx`
 * INSTEAD of CaptureSheet when `sheet.kind === "photo"`.
 *
 * Lifecycle (state machine):
 *   opening    → getUserMedia promise pending, "Opening camera…" UI
 *   live       → stream attached to <video>, framing UI shown
 *   capturing  → user tapped Capture, freeze controls, "Reading photo…"
 *   denied     → getUserMedia rejected (permission denied)
 *                → switches to gallery-only mode
 *   error      → other getUserMedia failure (no camera, hardware issue)
 *
 * Critical iOS pattern (PHOTO_PLAN.md §2.9):
 * `getUserMedia` MUST be called synchronously from the original
 * user-gesture handler (the tap on the Home Photo button). This
 * component receives the resulting `streamPromise` from the parent,
 * NOT a fresh call kicked off from a `useEffect`. The deferred
 * pattern (state-flip → mount → useEffect → getUserMedia) drops the
 * gesture token on iOS and fails silently.
 *
 * Cleanup: tracks stopped on cancel, successful capture, unmount,
 * `pagehide`, `visibilitychange` to hidden, and error transitions.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { ConsentOverlay } from "@/components/ConsentOverlay/ConsentOverlay";
import {
  PinchPanCropSurface,
  type PinchPanCropSurfaceHandle,
} from "@/components/PinchPanCropSurface/PinchPanCropSurface";
import { computeCropRegion } from "@/components/PinchPanCropSurface/cropMath";
import { captureCroppedJpeg } from "@/lib/captureCroppedJpeg";
import { saveLastCapture } from "@/lib/devLastCapture";
import { hasPhotoConsent, recordPhotoConsent } from "@/lib/photoConsent";

import { GalleryCropScreen, type GalleryCropResult } from "./GalleryCropScreen";

import "./PhotoCapture.css";

export interface PhotoCaptureProps {
  /**
   * Promise the parent kicks off synchronously from the user's
   * tap on the Home Photo button — see component-level comment
   * for why this isn't called inside the component. `null` means
   * the user opened straight into gallery-only mode (e.g. camera
   * access was previously refused at the browser level).
   *
   * The parent supplies a FRESH promise on each Retake (user-gesture
   * driven, so iOS gives us the camera back without a fresh prompt).
   */
  streamPromise: Promise<MediaStream> | null;
  /** Captured image bytes are handed off here; parent owns upload. */
  onCaptured: (image: Blob, contentType: string) => void;
  /** User tapped Cancel; parent closes the photo surface. */
  onCancel: () => void;
  /**
   * True while the parent is extracting the captured photo — the
   * ~2s window between shutter and result. Renders the calm
   * "Reading photo…" overlay; framing controls are hidden during
   * this window. The camera tracks are already stopped by the
   * capture path so the OS camera light is off.
   */
  extracting: boolean;
  /**
   * Calm copy to render as a retake prompt when extraction fails.
   * `null` clears the overlay (fresh session or after a successful
   * retake). Split into `headline` (verb slot — sage Outfit, big)
   * and optional `subline` (line slot — muted, smaller) so the
   * failure card mirrors the saving panel's "verb + line" shape.
   */
  extractionError: { headline: string; subline: string | null } | null;
  /**
   * Consecutive failures in this photo session. When ≥2, the
   * failure overlay shows a quiet "Or type it in instead?" link
   * so the user has an escape from a stubbornly unreadable sheet.
   */
  bounceCount: number;
  /**
   * User tapped Retake on the failure overlay. The parent re-acquires
   * the camera (fresh getUserMedia inside this user-gesture frame)
   * and supplies a new `streamPromise`.
   */
  onRetake: () => void;
  /**
   * User tapped the "Or type it in instead?" escape from the failure
   * overlay. Parent closes the camera surface and opens the text input.
   */
  onTypeInstead: () => void;
  /**
   * Fired the first time a broker on this device taps "Got it" on the
   * photo-AI consent overlay. The parent is expected to kick off
   * `getUserMedia` from THIS callback (the Got-It tap is a valid iOS
   * user-gesture frame) and supply a fresh `streamPromise` via prop
   * update so the camera surface can open.
   *
   * Why deferred to here: if `getUserMedia` fires before the consent
   * overlay shows, the OS camera permission prompt races our overlay
   * and the broker sees two stacked dialogs. Splitting the two
   * moments puts ours first, the OS prompt second.
   */
  onConsentGiven?: () => void;
}

type CaptureState =
  | { kind: "awaiting_consent" }
  | { kind: "opening" }
  | { kind: "live"; stream: MediaStream }
  | { kind: "capturing" }
  | { kind: "cropping_gallery"; imageUrl: string }
  | { kind: "denied" }
  | { kind: "error"; message: string };

// Constraint passed to the OUTPUT canvas. JPEG at quality 0.92 is the
// sweet spot for photo uploads — visually indistinguishable from the
// original on a phone screen, ~25% smaller than 0.95. The backend
// preprocessor will downscale to 1500px long edge anyway, so we
// don't sweat dimension caps here.
const OUTPUT_QUALITY = 0.92;

export function PhotoCapture({
  streamPromise,
  onCaptured,
  onCancel,
  extracting,
  extractionError,
  bounceCount,
  onRetake,
  onTypeInstead,
  onConsentGiven,
}: PhotoCaptureProps): React.ReactElement {
  // Photo-AI consent — read once on mount from localStorage. Drives
  // both the initial state machine (we sit in awaiting_consent if
  // missing, deferring any `getUserMedia` attempt) and the render
  // gates below (consent overlay shows alone, no camera chrome,
  // until they accept).
  const [photoConsentGiven, setPhotoConsentGiven] = useState<boolean>(() =>
    hasPhotoConsent(),
  );
  // Initial state branch: if consent is missing the parent passed
  // us `streamPromise: null` intentionally (no `getUserMedia` yet
  // — see HomeScreen `handleModeTap` for the deferral logic).
  // Otherwise fall through to the existing opening/denied split.
  const [state, setState] = useState<CaptureState>(() => {
    if (!hasPhotoConsent()) return { kind: "awaiting_consent" };
    return streamPromise ? { kind: "opening" } : { kind: "denied" };
  });
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // Survives across renders so a double-tap on Capture can't kick
  // off two parallel uploads. Set on the first tap, cleared by the
  // parent (effectively, by component unmount).
  const inFlightRef = useRef<boolean>(false);
  // Latest stream is mirrored to a ref so cleanup handlers can stop
  // tracks regardless of which render's closure they were attached in.
  const streamRef = useRef<MediaStream | null>(null);
  // Pinch + pan gesture surface wrapping the live <video>. Reads
  // current zoom + translate at capture time; the cropped region is
  // what gets sent to extraction. Reset on Retake so a new session
  // starts at 1× / centred.
  const cropSurfaceRef = useRef<PinchPanCropSurfaceHandle | null>(null);

  // --- Stream attachment + cleanup ---------------------------------

  // Resolve the parent-supplied promise once and flip to `live` when
  // ready. If the user denies permission, flip to `denied` (which
  // switches the UI to gallery-only mode without unmounting).
  //
  // CRITICAL: do NOT introduce a `cancelled` flag whose cleanup runs
  // `track.stop()`. React StrictMode in dev runs every effect twice
  // (mount → cleanup → remount). The cleanup of the first run flips
  // `cancelled = true` BEFORE the permission promise resolves; when
  // it does resolve, the cancelled branch ends the track, leaving the
  // remount attaching a dead stream. The visible symptom was
  // `t0.readyState === "ended"` with a 0×0 video. setState on an
  // unmounted component is a silent no-op in React 18, so we don't
  // need a guard for the unmount-during-permission case.
  //
  // Track ownership transfers to the component once we hold it in
  // `streamRef`; the user-action paths (cancel, capture, upload) and
  // the pagehide / visibilitychange handlers each stop tracks at the
  // right moment.
  const consumedPromiseRef = useRef<Promise<MediaStream> | null>(null);
  useEffect(() => {
    if (!streamPromise) return;
    if (consumedPromiseRef.current === streamPromise) return;
    consumedPromiseRef.current = streamPromise;
    // A new streamPromise after the first one means the parent
    // re-armed the camera (Retake from the failure overlay). Reset
    // internal state so we don't briefly flash a stale "capturing"
    // overlay while the new stream resolves.
    setState({ kind: "opening" });
    // Critical: clear the in-flight latch too. `inFlightRef` was set
    // to true on the previous shutter tap and never cleared — without
    // this reset, the shutter button on the new stream silently
    // refuses to fire.
    inFlightRef.current = false;
    // Reset the gesture surface so Retake starts at 1× / centred
    // rather than reusing the previous capture's zoom state.
    cropSurfaceRef.current?.reset();
    streamPromise
      .then((stream) => {
        streamRef.current = stream;
        setState({ kind: "live", stream });
      })
      .catch((err: unknown) => {
        const name = err instanceof Error ? err.name : "";
        if (name === "NotAllowedError" || name === "SecurityError") {
          setState({ kind: "denied" });
          return;
        }
        const message =
          err instanceof Error && err.message ? err.message : "Camera unavailable.";
        setState({ kind: "error", message });
      });
  }, [streamPromise]);

  // Wire the resolved stream into the <video> element. iOS Safari
  // is brittle here in several ways we have to defend against:
  //   1. `muted` + `playsInline` MUST be JS properties (not just
  //      JSX attributes) at the time `srcObject` is assigned, or
  //      WebKit refuses inline autoplay.
  //   2. Calling `play()` before `loadedmetadata` fires can succeed
  //      silently (no rejection) and still produce a black frame
  //      forever. Drive play from a `loadedmetadata` listener AND
  //      attempt immediately (in case the event already fired).
  //   3. The legacy `webkit-playsinline` attribute is still
  //      required by older iOS WKWebView wrappers (Gmail, Facebook
  //      in-app browsers).
  //   4. React StrictMode in dev re-runs effects (mount → cleanup →
  //      remount). Nulling `srcObject` in cleanup tears down the
  //      attach iOS just made, and WebKit doesn't always recover
  //      cleanly when you re-attach the SAME stream object. We
  //      track the attached stream via a ref and only re-assign
  //      when it actually changes; cleanup only nulls on real
  //      unmount.
  //   5. `useLayoutEffect` runs BEFORE the browser paints, which
  //      avoids a frame where the <video> exists but has no
  //      `srcObject` — iOS sometimes locks in "no source" state
  //      based on what it saw at first paint.
  const attachedStreamRef = useRef<MediaStream | null>(null);
  useLayoutEffect(() => {
    if (state.kind !== "live") return;
    const video = videoRef.current;
    if (!video) return;
    if (attachedStreamRef.current === state.stream) {
      // Same stream as already attached — don't re-set srcObject
      // (StrictMode re-run or unrelated re-render). Do still
      // attempt play() because the previous attempt might have
      // failed silently.
      void video.play().catch(() => {});
      return;
    }
    video.muted = true;
    video.playsInline = true;
    video.setAttribute("playsinline", "true");
    video.setAttribute("webkit-playsinline", "true");
    video.srcObject = state.stream;
    attachedStreamRef.current = state.stream;
    let cancelled = false;
    const attemptPlay = (): void => {
      if (cancelled) return;
      void video.play().catch(() => {
        if (!cancelled) {
          setState({ kind: "error", message: "Tap to start the camera." });
        }
      });
    };
    const handleLoaded = (): void => attemptPlay();
    video.addEventListener("loadedmetadata", handleLoaded);
    attemptPlay();
    return () => {
      cancelled = true;
      video.removeEventListener("loadedmetadata", handleLoaded);
      // Deliberately do NOT null srcObject here — that's what
      // unmount cleanup is for (handled by stopTracks). Nulling
      // here breaks iOS Safari on a normal re-render.
    };
  }, [state]);

  // --- Aggressive teardown -----------------------------------------

  const stopTracks = useCallback(() => {
    const stream = streamRef.current;
    if (!stream) return;
    stream.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  // Stop the camera when the OS backgrounds the app or the tab goes
  // away. The cleanup deliberately only REMOVES the listeners — it
  // does NOT call `stopTracks()`. React StrictMode runs cleanups in
  // dev as part of its mount/unmount pair, so stopping tracks here
  // would kill a freshly-acquired camera. Track teardown happens via
  // the user-action paths (cancel, capture, upload) and via the
  // visibility / pagehide HANDLERS themselves when fired.
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === "hidden") {
        stopTracks();
      }
    };
    const handlePageHide = () => {
      stopTracks();
    };
    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("pagehide", handlePageHide);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("pagehide", handlePageHide);
    };
  }, [stopTracks]);

  // --- Capture action ----------------------------------------------

  const handleCapture = useCallback(async () => {
    if (inFlightRef.current) return;
    if (state.kind !== "live") return;
    const video = videoRef.current;
    if (!video) return;
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) {
      // Stream attached but hasn't delivered a frame yet — typically
      // <100ms after `play()` resolves. Wait for the next tap.
      return;
    }

    inFlightRef.current = true;
    setState({ kind: "capturing" });

    // Crop to the region the user actually framed. At 1× / no pan
    // this is the cover-fit slice of the source visible on screen;
    // at higher zoom or with pan it's the sub-rectangle composed via
    // the pinch + drag gesture.
    const surface = cropSurfaceRef.current;
    let region = { sx: 0, sy: 0, sw: width, sh: height };
    if (surface) {
      const { zoom, translateX, translateY } = surface.getTransform();
      const { width: surfaceWidth, height: surfaceHeight } =
        surface.getSurfaceSize();
      if (surfaceWidth > 0 && surfaceHeight > 0) {
        region = computeCropRegion({
          zoom,
          translateX,
          translateY,
          surfaceWidth,
          surfaceHeight,
          sourceWidth: width,
          sourceHeight: height,
        });
      }
    }

    try {
      const result = await captureCroppedJpeg({
        source: video,
        sourceWidth: width,
        sourceHeight: height,
        region,
        quality: OUTPUT_QUALITY,
      });
      // Stop the live preview the moment we have bytes so the OS
      // camera light turns off as the user transitions past framing.
      stopTracks();
      if (import.meta.env.DEV) {
        void saveLastCapture(result.blob, {
          source: "camera",
          bytes: result.blob.size,
          outputWidth: result.outputWidth,
          outputHeight: result.outputHeight,
          sourceWidth: width,
          sourceHeight: height,
          cropSx: Math.round(region.sx),
          cropSy: Math.round(region.sy),
          cropSw: Math.round(region.sw),
          cropSh: Math.round(region.sh),
          capturedAt: new Date().toISOString(),
        }).catch(() => {
          // Storage write failed — not critical; AI call still goes.
        });
      }
      onCaptured(result.blob, "image/jpeg");
    } catch {
      inFlightRef.current = false;
      setState({
        kind: "error",
        message: "Couldn't capture the photo. Try again?",
      });
    }
  }, [state, onCaptured, stopTracks]);

  // --- Gallery upload ----------------------------------------------

  const handleGalleryClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      // inFlightRef is intentionally NOT consulted here — the user
      // can hit "Pick a different photo" inside the crop screen and
      // come back through this handler before any upload starts.
      // The latch is set when the user confirms the cropped JPEG.
      const file = e.target.files?.[0];
      // Reset the input so re-selecting the same file fires a fresh
      // change event (browsers suppress identical-value events).
      e.target.value = "";
      if (!file) return;
      if (file.size === 0) {
        setState({
          kind: "error",
          message: "That file was empty. Try a different photo.",
        });
        return;
      }
      if (!file.type.startsWith("image/")) {
        setState({
          kind: "error",
          message: "That file isn't a photo. Try a different one.",
        });
        return;
      }
      // Hand the file to the in-app crop confirmation screen. The
      // GalleryCropScreen owns the object URL's lifetime from this
      // point — its unmount-time effect revokes it. We give the
      // mount a fresh key per URL so a "Pick different photo" tap
      // produces a clean remount instead of stale state.
      const url = URL.createObjectURL(file);
      setState({ kind: "cropping_gallery", imageUrl: url });
    },
    [],
  );

  // --- Gallery crop confirmation handlers --------------------------

  const handleGalleryCropConfirm = useCallback(
    (result: GalleryCropResult) => {
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      stopTracks();
      if (import.meta.env.DEV) {
        void saveLastCapture(result.blob, {
          source: "gallery",
          bytes: result.blob.size,
          contentType: "image/jpeg",
          outputWidth: result.outputWidth,
          outputHeight: result.outputHeight,
          sourceWidth: result.sourceWidth,
          sourceHeight: result.sourceHeight,
          cropSx: result.cropSx,
          cropSy: result.cropSy,
          cropSw: result.cropSw,
          cropSh: result.cropSh,
          capturedAt: new Date().toISOString(),
        }).catch(() => {
          // Storage write failed — not critical.
        });
      }
      onCaptured(result.blob, "image/jpeg");
    },
    [onCaptured, stopTracks],
  );

  const handleGalleryCropPickDifferent = useCallback(() => {
    // Re-open the file picker without leaving the gallery crop flow.
    // handleFileChange will replace state with a fresh imageUrl when
    // the user picks. The current GalleryCropScreen instance will
    // unmount thanks to the `key={state.imageUrl}` in the render,
    // and its cleanup revokes the stale object URL.
    fileInputRef.current?.click();
  }, []);

  const handleGalleryCropCancel = useCallback(() => {
    stopTracks();
    onCancel();
  }, [stopTracks, onCancel]);

  // --- Render ------------------------------------------------------

  // The failure overlay (driven by `extractionError`) takes precedence
  // over every internal state. The "Reading photo…" overlay (driven by
  // `extracting` from the parent) is the next layer. Internal-state
  // overlays only show when neither parent-driven layer is active.
  const showFailureOverlay = extractionError !== null;
  const showReadingOverlay = !showFailureOverlay && extracting;
  // The consent overlay only appears on a fresh device session AND
  // only while the live camera surface would otherwise be reachable
  // — once the broker is mid-extraction or staring at a failure card,
  // they've already consented (or the prior session did). The
  // "showLiveControls" gate suppresses the shutter + gallery buttons
  // while the overlay is up so there is NO path to send a photo
  // without an explicit "Got it" first.
  const showConsentOverlay =
    !photoConsentGiven && !showFailureOverlay && !showReadingOverlay;
  const showLiveControls =
    !showFailureOverlay && !showReadingOverlay && !showConsentOverlay;

  // Tap-outside-to-close — matches the app-wide convention from the
  // CaptureSheet (every dialog dismisses when the user taps the
  // backdrop). Only active while the failure overlay is showing, so
  // a stray tap on the live camera surface during framing doesn't
  // accidentally cancel the whole flow. Taps inside the card itself,
  // or on the X cancel button, are ignored — those have their own
  // dedicated handlers.
  const handleBackdropClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!showFailureOverlay) return;
      const target = e.target as HTMLElement;
      if (target.closest(".photo-result-card")) return;
      if (target.closest(".photo-capture__cancel")) return;
      stopTracks();
      onCancel();
    },
    [showFailureOverlay, onCancel, stopTracks],
  );

  // Consent — accept persists the flag (never re-prompts on this
  // device) and unlocks the shutter + gallery on this session.
  // Crucially, signal the parent SYNCHRONOUSLY so it can fire
  // `getUserMedia` from inside this same Got-It tap's gesture
  // frame — iOS Safari accepts the gesture token from any button
  // click handler, not just the original Home Photo tap. See
  // HomeScreen + App.tsx `handlePhotoConsentGiven`.
  const handleConsentAccept = useCallback(() => {
    recordPhotoConsent();
    setPhotoConsentGiven(true);
    if (onConsentGiven) {
      onConsentGiven();
    }
  }, [onConsentGiven]);

  // Consent — dismiss closes the photo surface entirely (matches the
  // voice consent's "Maybe later"). We don't persist consent, so the
  // overlay returns on the next photo tap. Tracks are stopped on the
  // way out so the OS camera light clears immediately (no-op if the
  // camera never started — which is the case for the awaiting_consent
  // first-time path).
  const handleConsentDismiss = useCallback(() => {
    stopTracks();
    onCancel();
  }, [stopTracks, onCancel]);

  return (
    <div
      className="photo-capture"
      role="dialog"
      aria-modal="true"
      aria-label="Photo capture"
      onClick={handleBackdropClick}
    >
      <PinchPanCropSurface
        ref={cropSurfaceRef}
        minZoom={1}
        maxZoom={4}
        className="photo-capture__crop-surface"
      >
        <video
          ref={videoRef}
          className="photo-capture__video"
          playsInline
          muted
          autoPlay
          aria-hidden={state.kind !== "live"}
        />
      </PinchPanCropSurface>

      {showFailureOverlay && extractionError && (
        <div
          className="photo-result-card photo-result-card--failure"
          role="alert"
        >
          {/* Warning indicator — mirrors the saved-panel check-circle
              structure (same slot shape, same 64×64 circle, same halo)
              but in amber so the surface reads as "needs attention"
              instead of "success". */}
          <div className="photo-result-card__indicator" aria-hidden="true">
            <div className="photo-result-card__warning">!</div>
          </div>
          <p className="photo-result-card__verb photo-result-card__verb--failure">
            {extractionError.headline}
          </p>
          {extractionError.subline && (
            <p className="photo-result-card__line">{extractionError.subline}</p>
          )}
          <div className="photo-result-card__actions">
            <button
              type="button"
              className="photo-result-card__retake"
              onClick={onRetake}
            >
              Retake photo
            </button>
            {bounceCount >= 2 && (
              <button
                type="button"
                className="photo-result-card__type-instead"
                onClick={onTypeInstead}
              >
                Or type it in instead
              </button>
            )}
          </div>
        </div>
      )}

      {showReadingOverlay && (
        <div
          className="photo-result-card photo-result-card--reading"
          role="status"
        >
          <div className="photo-result-card__dots" aria-hidden="true">
            <span />
            <span />
            <span />
            <span />
            <span />
          </div>
          <p className="photo-result-card__verb">Reading photo</p>
        </div>
      )}

      {showConsentOverlay && (
        <ConsentOverlay
          title="Just so you know"
          body="We send your photo to an AI in the US to read the names and contact info. They don't keep it."
          titleId="photo-consent-title"
          onAccept={handleConsentAccept}
          onDismiss={handleConsentDismiss}
        />
      )}

      {showLiveControls && state.kind === "opening" && (
        <div className="photo-capture__status" role="status">
          Opening camera…
        </div>
      )}

      {showLiveControls && state.kind === "denied" && (
        <div className="photo-capture__status photo-capture__status--denied" role="alert">
          <p className="photo-capture__denied-headline">
            Camera access not available
          </p>
          <p className="photo-capture__denied-detail">
            You can still upload a photo from your gallery below.
          </p>
        </div>
      )}

      {showLiveControls && state.kind === "error" && (
        <div className="photo-capture__status photo-capture__status--error" role="alert">
          {state.message}
        </div>
      )}

      {showLiveControls && state.kind === "capturing" && (
        <div
          className="photo-result-card photo-result-card--reading"
          role="status"
        >
          <div className="photo-result-card__dots" aria-hidden="true">
            <span />
            <span />
            <span />
            <span />
            <span />
          </div>
          <p className="photo-result-card__verb">Reading photo</p>
        </div>
      )}

      <button
        type="button"
        className="photo-capture__cancel"
        onClick={() => {
          stopTracks();
          onCancel();
        }}
        aria-label="Cancel"
      >
        ×
      </button>

      {showLiveControls && (
        <div className="photo-capture__controls">
          <button
            type="button"
            className="photo-capture__control photo-capture__control--gallery"
            onClick={handleGalleryClick}
            disabled={state.kind === "capturing"}
          >
            <GalleryIcon />
            <span className="photo-capture__control-label">Upload</span>
          </button>

          <button
            type="button"
            className="photo-capture__shutter"
            onClick={handleCapture}
            disabled={state.kind !== "live"}
            aria-label="Take photo"
          >
            <span className="photo-capture__shutter-ring" aria-hidden="true" />
          </button>

          {/* Right-slot keeps the shutter visually centered between
              two equal-weight controls. Flip-camera + flash land in a
              polish slice once mobile testing surfaces which devices
              actually need them. */}
          <span className="photo-capture__control photo-capture__control--spacer" aria-hidden="true" />
        </div>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="photo-capture__file-input"
        onChange={handleFileChange}
        aria-hidden="true"
        tabIndex={-1}
      />

      {state.kind === "cropping_gallery" && (
        <GalleryCropScreen
          key={state.imageUrl}
          imageUrl={state.imageUrl}
          onConfirm={handleGalleryCropConfirm}
          onPickDifferent={handleGalleryCropPickDifferent}
          onCancel={handleGalleryCropCancel}
        />
      )}
    </div>
  );
}

// --- Icons (inline SVG so we don't ship an icon lib) ---------------

function GalleryIcon(): React.ReactElement {
  return (
    <svg
      width="28"
      height="28"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <polyline points="21 15 16 10 5 21" />
    </svg>
  );
}
