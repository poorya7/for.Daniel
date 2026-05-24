import { describe, expect, it } from "vitest";

import {
  clampTranslate,
  clampZoom,
  computeCropRegion,
  touchDistance,
  touchMidpoint,
} from "./cropMath";

describe("computeCropRegion", () => {
  describe("when source matches surface aspect (no cover crop)", () => {
    const base = {
      surfaceWidth: 400,
      surfaceHeight: 600,
      sourceWidth: 400,
      sourceHeight: 600,
    };

    it("returns the full source when zoom=1 and no pan", () => {
      const region = computeCropRegion({
        ...base,
        zoom: 1,
        translateX: 0,
        translateY: 0,
      });
      expect(region).toEqual({ sx: 0, sy: 0, sw: 400, sh: 600 });
    });

    it("returns the centred quarter when zoom=2 and no pan", () => {
      const region = computeCropRegion({
        ...base,
        zoom: 2,
        translateX: 0,
        translateY: 0,
      });
      expect(region).toEqual({ sx: 100, sy: 150, sw: 200, sh: 300 });
    });

    it("shifts the visible window LEFT in source when pan moves child RIGHT (max pan)", () => {
      const region = computeCropRegion({
        ...base,
        zoom: 2,
        translateX: 200,
        translateY: 0,
      });
      // surfaceWidth=400, zoom=2 → pan range ±((2-1)*400/2) = ±200.
      // Pan=+200 = max right. Child moves right by 200 → user sees the
      // left edge of the source at sx=0.
      expect(region.sx).toBe(0);
      expect(region.sy).toBe(150);
      expect(region.sw).toBe(200);
      expect(region.sh).toBe(300);
    });

    it("shifts the visible window DOWN in source when pan moves child UP (max pan)", () => {
      const region = computeCropRegion({
        ...base,
        zoom: 2,
        translateX: 0,
        translateY: -300,
      });
      // surfaceHeight=600, zoom=2 → pan range ±((2-1)*600/2) = ±300.
      // Pan=-300 = max up. Child moves up → user sees the bottom half
      // of the source.
      expect(region.sx).toBe(100);
      expect(region.sy).toBe(300);
      expect(region.sw).toBe(200);
      expect(region.sh).toBe(300);
    });
  });

  describe("when source is wider than surface (cover crops horizontally)", () => {
    const base = {
      surfaceWidth: 400,
      surfaceHeight: 400,
      sourceWidth: 1600,
      sourceHeight: 800,
    };

    it("returns only the centred portion of the wider source at zoom=1", () => {
      const region = computeCropRegion({
        ...base,
        zoom: 1,
        translateX: 0,
        translateY: 0,
      });
      // Surface aspect = 1:1, source aspect = 2:1.
      // Cover fills surface height → 800 source pixels tall maps to 400 surface pixels.
      // coverScale = 800/400 = 2 source px per surface px.
      // Visible source width = 400 * 2 = 800. Source offset X = (1600-800)/2 = 400.
      expect(region).toEqual({ sx: 400, sy: 0, sw: 800, sh: 800 });
    });

    it("shrinks proportionally at zoom=2 while staying centred", () => {
      const region = computeCropRegion({
        ...base,
        zoom: 2,
        translateX: 0,
        translateY: 0,
      });
      // sw = 800/2 = 400. sh = 800/2 = 400. Centred: sx = 400+200 = 600, sy = 200.
      expect(region).toEqual({ sx: 600, sy: 200, sw: 400, sh: 400 });
    });
  });

  describe("when source is taller than surface (cover crops vertically)", () => {
    const base = {
      surfaceWidth: 400,
      surfaceHeight: 400,
      sourceWidth: 800,
      sourceHeight: 1600,
    };

    it("returns only the centred portion of the taller source at zoom=1", () => {
      const region = computeCropRegion({
        ...base,
        zoom: 1,
        translateX: 0,
        translateY: 0,
      });
      // coverScale = 800/400 = 2. visibleSourceHeight = 400*2 = 800.
      // sourceOffsetY = (1600-800)/2 = 400.
      expect(region).toEqual({ sx: 0, sy: 400, sw: 800, sh: 800 });
    });
  });

  describe("at the boundary: any pan at zoom=1 is a no-op for source", () => {
    // The component clamps translate to 0 at zoom=1, but the math
    // module should still produce a sensible value if called with a
    // non-zero pan + zoom=1 (defence in depth).
    it("a non-zero pan at zoom=1 still returns the full visible source", () => {
      const region = computeCropRegion({
        zoom: 1,
        translateX: 50,
        translateY: 50,
        surfaceWidth: 400,
        surfaceHeight: 600,
        sourceWidth: 400,
        sourceHeight: 600,
      });
      // At zoom=1, the (zoom-1)/zoom term is 0, so pan can't shift the
      // window in the formula. Pan only matters at zoom > 1.
      // BUT pan still subtracts: sx = -translateX = -50. Caller must
      // clamp pan to 0 at zoom=1 to avoid this. We test that the math
      // is correct given the inputs, not that it self-clamps.
      expect(region.sw).toBe(400);
      expect(region.sh).toBe(600);
      expect(region.sx).toBe(-50);
      expect(region.sy).toBe(-50);
    });
  });
});

describe("clampTranslate", () => {
  const surfaceWidth = 400;
  const surfaceHeight = 600;

  it("forces translate to (0,0) at zoom=1", () => {
    const out = clampTranslate(100, 100, 1, surfaceWidth, surfaceHeight);
    expect(out).toEqual({ translateX: 0, translateY: 0 });
  });

  it("allows the full range at zoom=2", () => {
    // At zoom=2, max abs pan = (2-1)*400/2 = 200, and ±300 for height.
    expect(clampTranslate(200, 300, 2, surfaceWidth, surfaceHeight)).toEqual({
      translateX: 200,
      translateY: 300,
    });
    expect(clampTranslate(-200, -300, 2, surfaceWidth, surfaceHeight)).toEqual({
      translateX: -200,
      translateY: -300,
    });
  });

  it("clamps pan past the edge at zoom=2", () => {
    expect(clampTranslate(500, 500, 2, surfaceWidth, surfaceHeight)).toEqual({
      translateX: 200,
      translateY: 300,
    });
    expect(clampTranslate(-500, -500, 2, surfaceWidth, surfaceHeight)).toEqual({
      translateX: -200,
      translateY: -300,
    });
  });

  it("allows partial pan inside the range", () => {
    expect(clampTranslate(50, 75, 2, surfaceWidth, surfaceHeight)).toEqual({
      translateX: 50,
      translateY: 75,
    });
  });
});

describe("clampZoom", () => {
  it("returns the value when within range", () => {
    expect(clampZoom(2, 1, 4)).toBe(2);
  });

  it("clamps to minZoom when below range", () => {
    expect(clampZoom(0.5, 1, 4)).toBe(1);
  });

  it("clamps to maxZoom when above range", () => {
    expect(clampZoom(10, 1, 4)).toBe(4);
  });
});

describe("touchDistance", () => {
  it("returns the euclidean distance between two points", () => {
    expect(touchDistance(0, 0, 3, 4)).toBe(5);
    expect(touchDistance(10, 10, 13, 14)).toBe(5);
  });

  it("returns 0 for the same point", () => {
    expect(touchDistance(5, 5, 5, 5)).toBe(0);
  });
});

describe("touchMidpoint", () => {
  it("returns the midpoint of two points", () => {
    expect(touchMidpoint(0, 0, 10, 20)).toEqual({ x: 5, y: 10 });
  });
});
