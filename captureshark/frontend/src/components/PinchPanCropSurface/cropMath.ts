/**
 * Pure math for translating gesture state (zoom + pan) into a
 * source-pixel crop region.
 *
 * The PinchPanCropSurface component owns the gesture state; this
 * module owns the math that turns that state into a rectangle in
 * the underlying source image's coordinates. Kept pure + separate
 * so it can be unit-tested exhaustively without mocking touch
 * events or React state.
 *
 * Assumes the source content fills the surface via `object-fit:
 * cover` semantics — i.e. the source is scaled to fill both
 * dimensions of the surface, and the long dimension is cropped to
 * preserve aspect ratio.
 */

export interface CropRegion {
  /** Source-pixel rectangle visible to the user. */
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

export interface ComputeCropRegionParams {
  /** Current zoom scale factor (1 = no zoom; > 1 = zoomed in). */
  zoom: number;
  /** Pan offset in surface pixels. Positive X = child shifted right. */
  translateX: number;
  /** Pan offset in surface pixels. Positive Y = child shifted down. */
  translateY: number;
  /** Surface element dimensions in CSS pixels. */
  surfaceWidth: number;
  surfaceHeight: number;
  /** Source content intrinsic dimensions in source pixels. */
  sourceWidth: number;
  sourceHeight: number;
}

/**
 * Returns the rectangle in source-pixel coordinates that the user
 * currently sees on the surface, given the gesture state and the
 * intrinsic dimensions of the source.
 *
 * At zoom = 1 with no pan, this is the cover-fit slice of the
 * source (centered, aspect-preserving, cropping the long edge).
 * At zoom > 1, the rectangle shrinks proportionally and shifts by
 * the pan offset (converted from surface pixels to source pixels
 * via the cover-fit scale ratio).
 */
export function computeCropRegion(params: ComputeCropRegionParams): CropRegion {
  const {
    zoom,
    translateX,
    translateY,
    surfaceWidth,
    surfaceHeight,
    sourceWidth,
    sourceHeight,
  } = params;

  const sourceAspect = sourceWidth / sourceHeight;
  const surfaceAspect = surfaceWidth / surfaceHeight;

  // Cover-fit math: figure out how much of the source is visible at
  // zoom = 1 and where it starts in source coordinates.
  let coverScale: number;
  let visibleSourceWidth: number;
  let visibleSourceHeight: number;
  let sourceOffsetX: number;
  let sourceOffsetY: number;

  if (sourceAspect > surfaceAspect) {
    // Source wider than surface — cover-fit crops left + right.
    coverScale = sourceHeight / surfaceHeight;
    visibleSourceWidth = surfaceWidth * coverScale;
    visibleSourceHeight = sourceHeight;
    sourceOffsetX = (sourceWidth - visibleSourceWidth) / 2;
    sourceOffsetY = 0;
  } else {
    // Source taller than surface — cover-fit crops top + bottom.
    coverScale = sourceWidth / surfaceWidth;
    visibleSourceWidth = sourceWidth;
    visibleSourceHeight = surfaceHeight * coverScale;
    sourceOffsetX = 0;
    sourceOffsetY = (sourceHeight - visibleSourceHeight) / 2;
  }

  // Zoom shrinks the visible window proportionally.
  const sw = visibleSourceWidth / zoom;
  const sh = visibleSourceHeight / zoom;

  // Pan shifts the visible window. The CSS transform applied to
  // the child is `translate(tx, ty) scale(zoom)` with transform-
  // origin centred, so a positive tx means the child moves right
  // and the user sees content from the LEFT of centre.
  // Mapping: source_x = sourceOffset + (surfaceWidth*(zoom-1))/(2*zoom)*coverScale - (translateX/zoom)*coverScale.
  const sx =
    sourceOffsetX +
    ((surfaceWidth * (zoom - 1)) / (2 * zoom) - translateX / zoom) * coverScale;
  const sy =
    sourceOffsetY +
    ((surfaceHeight * (zoom - 1)) / (2 * zoom) - translateY / zoom) * coverScale;

  return { sx, sy, sw, sh };
}

/**
 * Clamps a pan offset so the child cannot be dragged past the
 * surface edges. At zoom = 1 the only valid pan is (0, 0); at
 * higher zoom the allowed range grows.
 */
export function clampTranslate(
  translateX: number,
  translateY: number,
  zoom: number,
  surfaceWidth: number,
  surfaceHeight: number,
): { translateX: number; translateY: number } {
  const maxAbsX = ((zoom - 1) * surfaceWidth) / 2;
  const maxAbsY = ((zoom - 1) * surfaceHeight) / 2;
  return {
    translateX: clamp(translateX, -maxAbsX, maxAbsX),
    translateY: clamp(translateY, -maxAbsY, maxAbsY),
  };
}

/**
 * Clamps a zoom value into the configured min/max range.
 */
export function clampZoom(zoom: number, minZoom: number, maxZoom: number): number {
  return clamp(zoom, minZoom, maxZoom);
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * Euclidean distance between two touch points. Used to detect
 * pinch gesture magnitude.
 */
export function touchDistance(
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = ax - bx;
  const dy = ay - by;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Midpoint between two touch points. Used as the pinch focal point
 * so the zoom feels anchored to where the fingers are.
 */
export function touchMidpoint(
  ax: number,
  ay: number,
  bx: number,
  by: number,
): { x: number; y: number } {
  return {
    x: (ax + bx) / 2,
    y: (ay + by) / 2,
  };
}
