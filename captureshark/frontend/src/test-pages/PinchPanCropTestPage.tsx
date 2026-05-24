/**
 * Pinch + pan gesture sandbox.
 *
 * Standalone surface to verify the PinchPanCropSurface component on
 * a real touch device before wiring it into the camera (Phase 3) or
 * gallery (Phase 4) of the photo zoom + crop plan.
 *
 * Renders a numbered grid as the source so the gesture is obvious:
 * zoom centres on the pinch midpoint; pan reveals the corner labels.
 * Live readout shows zoom + translate values + the source-pixel
 * crop rectangle that would be sent to the AI.
 */

import { useCallback, useRef, useState } from "react";

import {
  PinchPanCropSurface,
  type PinchPanCropSurfaceHandle,
  type SurfaceTransform,
} from "@/components/PinchPanCropSurface/PinchPanCropSurface";
import { computeCropRegion, type CropRegion } from "@/components/PinchPanCropSurface/cropMath";

import "./PinchPanCropTestPage.css";

// Synthetic source: 1200×1800 grid, 6 cols × 9 rows of 200×200 cells.
// Each cell labelled (col, row) so the user can read where they're
// looking. Bright colour gradient across the grid so direction of
// pan is obvious without reading labels.
const SOURCE_WIDTH = 1200;
const SOURCE_HEIGHT = 1800;
const COLS = 6;
const ROWS = 9;

function buildGridSvg(): string {
  const cellW = SOURCE_WIDTH / COLS;
  const cellH = SOURCE_HEIGHT / ROWS;
  const cells: string[] = [];
  for (let r = 0; r < ROWS; r += 1) {
    for (let c = 0; c < COLS; c += 1) {
      const x = c * cellW;
      const y = r * cellH;
      const hue = Math.round((c / COLS) * 360);
      const lightness = 50 + Math.round((r / ROWS) * 30);
      const fill = `hsl(${hue}, 65%, ${lightness}%)`;
      cells.push(
        `<rect x="${x}" y="${y}" width="${cellW}" height="${cellH}" fill="${fill}" />`,
        `<text x="${x + cellW / 2}" y="${y + cellH / 2}" font-family="Inter, system-ui, sans-serif" font-size="32" font-weight="600" fill="#0f172a" text-anchor="middle" dominant-baseline="central">${c},${r}</text>`,
      );
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SOURCE_WIDTH} ${SOURCE_HEIGHT}" preserveAspectRatio="xMidYMid slice">${cells.join("")}</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

const GRID_DATA_URL = buildGridSvg();

export function PinchPanCropTestPage(): React.ReactElement {
  const surfaceRef = useRef<PinchPanCropSurfaceHandle | null>(null);
  const [transform, setTransform] = useState<SurfaceTransform>({
    zoom: 1,
    translateX: 0,
    translateY: 0,
  });
  const [crop, setCrop] = useState<CropRegion | null>(null);

  const handleTransformChange = useCallback((next: SurfaceTransform) => {
    setTransform(next);
  }, []);

  const handleCapture = useCallback(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const size = surface.getSurfaceSize();
    const t = surface.getTransform();
    const region = computeCropRegion({
      zoom: t.zoom,
      translateX: t.translateX,
      translateY: t.translateY,
      surfaceWidth: size.width,
      surfaceHeight: size.height,
      sourceWidth: SOURCE_WIDTH,
      sourceHeight: SOURCE_HEIGHT,
    });
    setCrop(region);
  }, []);

  const handleReset = useCallback(() => {
    surfaceRef.current?.reset();
    setCrop(null);
  }, []);

  return (
    <div className="pinch-pan-test-page">
      <div className="pinch-pan-test-page__surface-wrap">
        <PinchPanCropSurface
          ref={surfaceRef}
          minZoom={1}
          maxZoom={4}
          onTransformChange={handleTransformChange}
        >
          <img
            src={GRID_DATA_URL}
            alt=""
            draggable={false}
            className="pinch-pan-test-page__source"
          />
        </PinchPanCropSurface>
      </div>

      <div className="pinch-pan-test-page__hud">
        <div className="pinch-pan-test-page__readout">
          <span>zoom {transform.zoom.toFixed(2)}×</span>
          <span>
            pan {Math.round(transform.translateX)}, {Math.round(transform.translateY)}
          </span>
        </div>
        {crop && (
          <div className="pinch-pan-test-page__crop">
            <span>crop in source px:</span>
            <span>
              sx={Math.round(crop.sx)} sy={Math.round(crop.sy)} sw=
              {Math.round(crop.sw)} sh={Math.round(crop.sh)}
            </span>
          </div>
        )}
        <div className="pinch-pan-test-page__actions">
          <button type="button" onClick={handleReset}>
            Reset
          </button>
          <button type="button" onClick={handleCapture}>
            Capture
          </button>
        </div>
      </div>
    </div>
  );
}
