/**
 * Reusable pinch-to-zoom + pan crop surface.
 *
 * Owns the gesture state for a single piece of content (a <video>,
 * an <img>, etc.). Applies a CSS transform to the child to scale +
 * translate; never modifies the child's intrinsic dimensions.
 *
 * Exposes the current zoom + pan via a ref handle so the caller
 * can compute a crop region at capture time (via `cropMath.ts`).
 * Self-contained — no app coupling, no knowledge of cameras /
 * images / sheets.
 *
 * Gestures (mobile-first, touch events):
 * - Two fingers down → pinch. Distance ratio drives zoom; midpoint
 *   anchors the focal point. Mid-gesture pan via the midpoint delta.
 * - One finger down at zoom > 1 → pan. Drag offset adds to translate.
 * - Touch end below minZoom → animated snap back to minZoom + 0,0.
 * - Translate is always clamped so the child cannot leave the surface.
 */

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import {
  clampTranslate,
  clampZoom,
  touchDistance,
  touchMidpoint,
} from "./cropMath";

import "./PinchPanCropSurface.css";

export interface SurfaceTransform {
  zoom: number;
  translateX: number;
  translateY: number;
}

export interface PinchPanCropSurfaceHandle {
  getTransform(): SurfaceTransform;
  getSurfaceSize(): { width: number; height: number };
  reset(): void;
}

export interface PinchPanCropSurfaceProps {
  /** Minimum zoom factor. Default 1. */
  minZoom?: number;
  /** Maximum zoom factor. Default 4. */
  maxZoom?: number;
  /** Fires whenever the transform changes — useful for live overlays. */
  onTransformChange?: (transform: SurfaceTransform) => void;
  /** The content to be scaled + translated. Should fill the surface. */
  children: React.ReactNode;
  /** Optional className for the outer surface element. */
  className?: string;
}

const DEFAULT_MIN_ZOOM = 1;
const DEFAULT_MAX_ZOOM = 4;

interface GestureState {
  kind: "idle" | "pan" | "pinch";
  // Pinch:
  initialDistance?: number;
  initialMidpoint?: { x: number; y: number };
  initialZoom?: number;
  initialTranslateX?: number;
  initialTranslateY?: number;
  // Pan:
  startX?: number;
  startY?: number;
  startTranslateX?: number;
  startTranslateY?: number;
}

export const PinchPanCropSurface = forwardRef<
  PinchPanCropSurfaceHandle,
  PinchPanCropSurfaceProps
>(function PinchPanCropSurface(props, ref) {
  const {
    minZoom = DEFAULT_MIN_ZOOM,
    maxZoom = DEFAULT_MAX_ZOOM,
    onTransformChange,
    children,
    className,
  } = props;

  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const childWrapperRef = useRef<HTMLDivElement | null>(null);
  const gestureRef = useRef<GestureState>({ kind: "idle" });

  const [transform, setTransform] = useState<SurfaceTransform>({
    zoom: minZoom,
    translateX: 0,
    translateY: 0,
  });

  // Fire onTransformChange whenever the transform changes. Skipping
  // the initial render avoids a spurious callback on mount.
  const firstRenderRef = useRef(true);
  useEffect(() => {
    if (firstRenderRef.current) {
      firstRenderRef.current = false;
      return;
    }
    onTransformChange?.(transform);
  }, [transform, onTransformChange]);

  // Apply the transform via inline style + transform-origin centre.
  // Done in useLayoutEffect so the visual update is in sync with the
  // gesture frame — no perceptible lag between finger and content.
  useLayoutEffect(() => {
    const wrapper = childWrapperRef.current;
    if (!wrapper) return;
    wrapper.style.transform = `translate(${transform.translateX}px, ${transform.translateY}px) scale(${transform.zoom})`;
  }, [transform]);

  const getSurfaceSize = useCallback((): { width: number; height: number } => {
    const surface = surfaceRef.current;
    if (!surface) return { width: 0, height: 0 };
    const rect = surface.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  }, []);

  const reset = useCallback(() => {
    setTransform({ zoom: minZoom, translateX: 0, translateY: 0 });
  }, [minZoom]);

  useImperativeHandle(
    ref,
    () => ({
      getTransform: () => transform,
      getSurfaceSize,
      reset,
    }),
    [transform, getSurfaceSize, reset],
  );

  // --- Touch handlers ------------------------------------------------

  const handleTouchStart = useCallback(
    (e: React.TouchEvent<HTMLDivElement>) => {
      const surface = surfaceRef.current;
      if (!surface) return;
      const rect = surface.getBoundingClientRect();
      const touches = e.touches;

      if (touches.length >= 2) {
        const a = touches[0];
        const b = touches[1];
        const aX = a.clientX - rect.left;
        const aY = a.clientY - rect.top;
        const bX = b.clientX - rect.left;
        const bY = b.clientY - rect.top;
        gestureRef.current = {
          kind: "pinch",
          initialDistance: touchDistance(aX, aY, bX, bY),
          initialMidpoint: touchMidpoint(aX, aY, bX, bY),
          initialZoom: transform.zoom,
          initialTranslateX: transform.translateX,
          initialTranslateY: transform.translateY,
        };
        return;
      }

      if (touches.length === 1 && transform.zoom > minZoom) {
        const t = touches[0];
        gestureRef.current = {
          kind: "pan",
          startX: t.clientX - rect.left,
          startY: t.clientY - rect.top,
          startTranslateX: transform.translateX,
          startTranslateY: transform.translateY,
        };
        return;
      }

      gestureRef.current = { kind: "idle" };
    },
    [transform, minZoom],
  );

  const handleTouchMove = useCallback(
    (e: React.TouchEvent<HTMLDivElement>) => {
      const gesture = gestureRef.current;
      const surface = surfaceRef.current;
      if (!surface) return;
      const rect = surface.getBoundingClientRect();
      const touches = e.touches;

      if (
        gesture.kind === "pinch" &&
        gesture.initialDistance !== undefined &&
        gesture.initialMidpoint !== undefined &&
        gesture.initialZoom !== undefined &&
        gesture.initialTranslateX !== undefined &&
        gesture.initialTranslateY !== undefined &&
        touches.length >= 2
      ) {
        const a = touches[0];
        const b = touches[1];
        const aX = a.clientX - rect.left;
        const aY = a.clientY - rect.top;
        const bX = b.clientX - rect.left;
        const bY = b.clientY - rect.top;
        const currentDistance = touchDistance(aX, aY, bX, bY);
        const currentMidpoint = touchMidpoint(aX, aY, bX, bY);

        const scaleRatio = currentDistance / gesture.initialDistance;
        const nextZoom = clampZoom(
          gesture.initialZoom * scaleRatio,
          minZoom,
          maxZoom,
        );

        // Midpoint pan: the user's fingers might have moved their
        // midpoint since the gesture started — apply that delta to
        // the translate so the gesture feels anchored.
        const midpointDX = currentMidpoint.x - gesture.initialMidpoint.x;
        const midpointDY = currentMidpoint.y - gesture.initialMidpoint.y;

        const clamped = clampTranslate(
          gesture.initialTranslateX + midpointDX,
          gesture.initialTranslateY + midpointDY,
          nextZoom,
          rect.width,
          rect.height,
        );

        setTransform({
          zoom: nextZoom,
          translateX: clamped.translateX,
          translateY: clamped.translateY,
        });
        return;
      }

      if (
        gesture.kind === "pan" &&
        gesture.startX !== undefined &&
        gesture.startY !== undefined &&
        gesture.startTranslateX !== undefined &&
        gesture.startTranslateY !== undefined &&
        touches.length === 1
      ) {
        const t = touches[0];
        const currentX = t.clientX - rect.left;
        const currentY = t.clientY - rect.top;
        const dx = currentX - gesture.startX;
        const dy = currentY - gesture.startY;

        const clamped = clampTranslate(
          gesture.startTranslateX + dx,
          gesture.startTranslateY + dy,
          transform.zoom,
          rect.width,
          rect.height,
        );

        setTransform((prev) => ({
          ...prev,
          translateX: clamped.translateX,
          translateY: clamped.translateY,
        }));
      }
    },
    [transform.zoom, minZoom, maxZoom],
  );

  const handleTouchEnd = useCallback(
    (e: React.TouchEvent<HTMLDivElement>) => {
      // Either gesture ended (no touches left), or pinch became a
      // one-finger pan (one touch left). Re-derive the gesture state.
      const surface = surfaceRef.current;
      if (!surface) return;
      const rect = surface.getBoundingClientRect();
      const touches = e.touches;

      if (touches.length === 0) {
        gestureRef.current = { kind: "idle" };
        return;
      }

      if (touches.length === 1 && transform.zoom > minZoom) {
        const t = touches[0];
        gestureRef.current = {
          kind: "pan",
          startX: t.clientX - rect.left,
          startY: t.clientY - rect.top,
          startTranslateX: transform.translateX,
          startTranslateY: transform.translateY,
        };
        return;
      }

      gestureRef.current = { kind: "idle" };
    },
    [transform, minZoom],
  );

  return (
    <div
      ref={surfaceRef}
      className={`pinch-pan-crop-surface${className ? ` ${className}` : ""}`}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={handleTouchEnd}
    >
      <div ref={childWrapperRef} className="pinch-pan-crop-surface__child">
        {children}
      </div>
    </div>
  );
});
