/**
 * Gallery crop confirmation screen.
 *
 * Mounted after the OS file picker hands us a photo. Wraps the
 * picked image in the same `PinchPanCropSurface` the camera path
 * uses — so the broker pinches and pans to frame the part they
 * want to send, then taps "Use this part." The cropped JPEG is
 * encoded via the shared `captureCroppedJpeg` helper so both paths
 * stay byte-identical in how they shape the upload.
 *
 * Why this exists: iOS's "Move and Scale" UI in the file picker
 * is just a preview — it does NOT modify the file delivered to
 * us. So if the broker wants to send only part of the gallery
 * photo, we have to provide our own in-app crop step.
 */

import { useEffect, useRef, useState } from "react";

import {
  PinchPanCropSurface,
  type PinchPanCropSurfaceHandle,
} from "@/components/PinchPanCropSurface/PinchPanCropSurface";
import { computeCropRegion } from "@/components/PinchPanCropSurface/cropMath";
import { captureCroppedJpeg } from "@/lib/captureCroppedJpeg";

import "./GalleryCropScreen.css";

export interface GalleryCropResult {
  blob: Blob;
  outputWidth: number;
  outputHeight: number;
  sourceWidth: number;
  sourceHeight: number;
  cropSx: number;
  cropSy: number;
  cropSw: number;
  cropSh: number;
}

export interface GalleryCropScreenProps {
  /** Object URL for the picked image. The screen revokes it on unmount. */
  imageUrl: string;
  /** User tapped "Use this part" and the crop was encoded successfully. */
  onConfirm: (result: GalleryCropResult) => void;
  /** User wants to swap photos — parent re-opens the file picker. */
  onPickDifferent: () => void;
  /** User backed out of the gallery flow entirely. */
  onCancel: () => void;
}

export function GalleryCropScreen({
  imageUrl,
  onConfirm,
  onPickDifferent,
  onCancel,
}: GalleryCropScreenProps): React.ReactElement {
  const cropSurfaceRef = useRef<PinchPanCropSurfaceHandle | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlightRef = useRef(false);

  // Revoke the object URL when this screen unmounts so we don't
  // leak the blob slot. Parent created the URL; we own its lifetime
  // from here on.
  useEffect(() => {
    return () => {
      URL.revokeObjectURL(imageUrl);
    };
  }, [imageUrl]);

  const handleImageLoad = () => {
    setReady(true);
  };

  const handleImageError = () => {
    setError("Couldn't load that photo. Try a different one?");
  };

  const handleConfirm = async () => {
    if (inFlightRef.current) return;
    const img = imgRef.current;
    const surface = cropSurfaceRef.current;
    if (!img || !surface) return;
    if (!img.naturalWidth || !img.naturalHeight) return;

    inFlightRef.current = true;
    try {
      const { zoom, translateX, translateY } = surface.getTransform();
      const { width: surfaceWidth, height: surfaceHeight } =
        surface.getSurfaceSize();
      const region = computeCropRegion({
        zoom,
        translateX,
        translateY,
        surfaceWidth,
        surfaceHeight,
        sourceWidth: img.naturalWidth,
        sourceHeight: img.naturalHeight,
      });
      const result = await captureCroppedJpeg({
        source: img,
        sourceWidth: img.naturalWidth,
        sourceHeight: img.naturalHeight,
        region,
      });
      onConfirm({
        blob: result.blob,
        outputWidth: result.outputWidth,
        outputHeight: result.outputHeight,
        sourceWidth: img.naturalWidth,
        sourceHeight: img.naturalHeight,
        cropSx: Math.round(region.sx),
        cropSy: Math.round(region.sy),
        cropSw: Math.round(region.sw),
        cropSh: Math.round(region.sh),
      });
    } catch (err) {
      inFlightRef.current = false;
      setError(
        err instanceof Error
          ? err.message
          : "Couldn't crop that photo. Try again?",
      );
    }
  };

  return (
    <div className="gallery-crop-screen" role="dialog" aria-modal="true">
      <button
        type="button"
        className="gallery-crop-screen__cancel"
        onClick={onCancel}
        aria-label="Cancel"
      >
        ×
      </button>

      <div className="gallery-crop-screen__surface-wrap">
        <PinchPanCropSurface
          ref={cropSurfaceRef}
          minZoom={1}
          maxZoom={4}
          className="gallery-crop-screen__crop-surface"
        >
          <img
            ref={imgRef}
            src={imageUrl}
            alt=""
            draggable={false}
            onLoad={handleImageLoad}
            onError={handleImageError}
            className="gallery-crop-screen__image"
          />
        </PinchPanCropSurface>
      </div>

      {error && (
        <div className="gallery-crop-screen__error" role="alert">
          {error}
        </div>
      )}

      <div className="gallery-crop-screen__actions">
        <button
          type="button"
          className="gallery-crop-screen__secondary"
          onClick={onPickDifferent}
        >
          Pick a different photo
        </button>
        <button
          type="button"
          className="gallery-crop-screen__primary"
          onClick={handleConfirm}
          disabled={!ready || !!error}
        >
          Use this part
        </button>
      </div>
    </div>
  );
}
