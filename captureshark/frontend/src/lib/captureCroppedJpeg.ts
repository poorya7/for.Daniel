/**
 * Shared "crop region → JPEG blob" encoder.
 *
 * Owns the canvas + drawImage + toBlob pipeline so both the live
 * camera shutter path and the gallery-upload crop confirmation
 * path produce captures the exact same way. Also owns the upscale
 * floor: if the user zoomed in hard enough that the cropped region
 * is below the backend's 200 px minimum-dimension gate, the output
 * is upscaled so the AI gets a fair shot.
 *
 * Source is any `CanvasImageSource` — typically `HTMLVideoElement`
 * (camera shutter) or `HTMLImageElement` (gallery picker). The
 * caller supplies the source's intrinsic dimensions because video
 * and image elements expose them differently (`videoWidth/Height`
 * vs `naturalWidth/Height`).
 */

import type { CropRegion } from "@/components/PinchPanCropSurface/cropMath";

export interface CaptureCroppedJpegParams {
  source: CanvasImageSource;
  /** Intrinsic source width in source pixels (videoWidth / naturalWidth). */
  sourceWidth: number;
  /** Intrinsic source height in source pixels (videoHeight / naturalHeight). */
  sourceHeight: number;
  region: CropRegion;
  /**
   * Minimum output short edge in pixels. Below this we upscale the
   * canvas so the backend preprocessor's 200 px floor cannot fire on
   * a heavy-zoom capture. Default 800 — comfortable margin above
   * the floor without producing oversized uploads.
   */
  minOutputShortEdge?: number;
  /** JPEG quality 0–1. Default 0.92 — visually lossless on phone screens. */
  quality?: number;
}

export interface CaptureCroppedJpegResult {
  blob: Blob;
  outputWidth: number;
  outputHeight: number;
}

const DEFAULT_MIN_OUTPUT_SHORT_EDGE = 800;
const DEFAULT_QUALITY = 0.92;

export async function captureCroppedJpeg(
  params: CaptureCroppedJpegParams,
): Promise<CaptureCroppedJpegResult> {
  const {
    source,
    sourceWidth,
    sourceHeight,
    region,
    minOutputShortEdge = DEFAULT_MIN_OUTPUT_SHORT_EDGE,
    quality = DEFAULT_QUALITY,
  } = params;

  if (!sourceWidth || !sourceHeight) {
    throw new Error("Source has no intrinsic dimensions.");
  }

  const cropW = Math.max(1, Math.round(region.sw));
  const cropH = Math.max(1, Math.round(region.sh));

  const shortEdge = Math.min(cropW, cropH);
  const outputScale =
    shortEdge < minOutputShortEdge ? minOutputShortEdge / shortEdge : 1;
  const outputW = Math.max(1, Math.round(cropW * outputScale));
  const outputH = Math.max(1, Math.round(cropH * outputScale));

  const canvas = document.createElement("canvas");
  canvas.width = outputW;
  canvas.height = outputH;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Could not acquire 2D canvas context.");
  }
  ctx.drawImage(
    source,
    region.sx,
    region.sy,
    region.sw,
    region.sh,
    0,
    0,
    outputW,
    outputH,
  );

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => {
        if (b) resolve(b);
        else reject(new Error("Canvas toBlob returned null."));
      },
      "image/jpeg",
      quality,
    );
  });

  return { blob, outputWidth: outputW, outputHeight: outputH };
}
