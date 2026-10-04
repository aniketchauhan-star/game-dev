import { describe, expect, it } from 'vitest';
import {
  clampPoint,
  computeGridLayout,
  formatNumber,
  formatPoint,
  isOnGrid,
  quadrantOf,
  QUADRANT_NAMES,
  snapToGrid,
  speakPoint,
  stepPoint,
  tickValues,
  toMath,
  toScreen,
  type Rect,
} from '@shared/coords.ts';
import { gridSchema, type Grid, type Point } from '@shared/schemas/interaction.ts';

const GRIDS: Array<[string, Grid]> = [
  ['airfield −5..5 × −4..4 step 1', { xMin: -5, xMax: 5, yMin: -4, yMax: 4, step: 1 }],
  ['square −10..10 step 5', { xMin: -10, xMax: 10, yMin: -10, yMax: 10, step: 5 }],
  ['first quadrant 0..8 × 0..6 step 2', { xMin: 0, xMax: 8, yMin: 0, yMax: 6, step: 2 }],
  ['lopsided −20..0 × −4..16 step 2', { xMin: -20, xMax: 0, yMin: -4, yMax: 16, step: 2 }],
  ['tall −2..2 × −20..20 step 2', { xMin: -2, xMax: 2, yMin: -20, yMax: 20, step: 2 }],
];

const AREAS: Array<[string, Rect, number]> = [
  ['full stage', { x: 0, y: 0, width: 1920, height: 1080 }, 0],
  ['padded stage', { x: 0, y: 0, width: 1920, height: 1080 }, 60],
  ['wide strip with offset', { x: 100, y: 50, width: 1600, height: 300 }, 10],
  ['tall column with offset', { x: 1200, y: 40, width: 420, height: 1000 }, 24],
  ['square thumbnail', { x: 7, y: 9, width: 256, height: 256 }, 0],
];

const intersections = (g: Grid): Point[] => {
  const out: Point[] = [];
  for (let x = g.xMin; x <= g.xMax; x += g.step) for (let y = g.yMin; y <= g.yMax; y += g.step) out.push({ x, y });
  return out;
};

describe('test grids are valid', () => {
  it.each(GRIDS)('%s', (_name, grid) => {
    expect(gridSchema.safeParse(grid).success).toBe(true);
  });
});

describe('computeGridLayout', () => {
  it('centres the airfield grid on the 1920×1080 stage with the origin in the middle', () => {
    const L = computeGridLayout({ xMin: -5, xMax: 5, yMin: -4, yMax: 4, step: 1 }, { x: 0, y: 0, width: 1920, height: 1080 });
    expect(L).toMatchObject({ unit: 135, width: 1350, height: 1080, left: 285, top: 0, originX: 960, originY: 540 });
  });

  describe.each(GRIDS)('%s', (_gridName, grid) => {
    it.each(AREAS)('in %s: square cells, fits inside the padded area, centred, fills one dimension', (_areaName, area, padding) => {
      const L = computeGridLayout(grid, area, padding);
      expect(L.unit).toBeGreaterThan(0);
      // One unit is the same number of pixels on both axes.
      const o = toScreen(L, { x: 0, y: 0 });
      const right = toScreen(L, { x: 1, y: 0 });
      const up = toScreen(L, { x: 0, y: 1 });
      expect(right.sx - o.sx).toBeCloseTo(L.unit, 9);
      expect(o.sy - up.sy).toBeCloseTo(L.unit, 9);
      expect(L.width).toBeCloseTo(L.unit * (grid.xMax - grid.xMin), 9);
      expect(L.height).toBeCloseTo(L.unit * (grid.yMax - grid.yMin), 9);
      // Inside the area minus padding.
      const eps = 1e-6;
      expect(L.left).toBeGreaterThanOrEqual(area.x + padding - eps);
      expect(L.top).toBeGreaterThanOrEqual(area.y + padding - eps);
      expect(L.left + L.width).toBeLessThanOrEqual(area.x + area.width - padding + eps);
      expect(L.top + L.height).toBeLessThanOrEqual(area.y + area.height - padding + eps);
      // Centred.
      expect(L.left - area.x).toBeCloseTo(area.x + area.width - (L.left + L.width), 6);
      expect(L.top - area.y).toBeCloseTo(area.y + area.height - (L.top + L.height), 6);
      // As large as possible: fills the padded width or the padded height.
      const fillsWidth = Math.abs(L.width - (area.width - 2 * padding)) < eps;
      const fillsHeight = Math.abs(L.height - (area.height - 2 * padding)) < eps;
      expect(fillsWidth || fillsHeight).toBe(true);
    });

    it.each(AREAS)('in %s: the grid corners land on the layout rectangle and y points up', (_areaName, area, padding) => {
      const L = computeGridLayout(grid, area, padding);
      const topLeft = toScreen(L, { x: grid.xMin, y: grid.yMax });
      const bottomRight = toScreen(L, { x: grid.xMax, y: grid.yMin });
      expect(topLeft.sx).toBeCloseTo(L.left, 6);
      expect(topLeft.sy).toBeCloseTo(L.top, 6);
      expect(bottomRight.sx).toBeCloseTo(L.left + L.width, 6);
      expect(bottomRight.sy).toBeCloseTo(L.top + L.height, 6);
      // Larger mathematical y is higher on screen (smaller screen y).
      expect(toScreen(L, { x: 0, y: grid.step }).sy).toBeLessThan(toScreen(L, { x: 0, y: 0 }).sy);
      expect(toScreen(L, { x: grid.step, y: 0 }).sx).toBeGreaterThan(toScreen(L, { x: 0, y: 0 }).sx);
      const origin = toScreen(L, { x: 0, y: 0 });
      expect(origin).toEqual({ sx: L.originX, sy: L.originY });
    });

    it.each(AREAS)('in %s: math → screen → math round-trips every intersection', (_areaName, area, padding) => {
      const L = computeGridLayout(grid, area, padding);
      for (const p of intersections(grid)) {
        const { sx, sy } = toScreen(L, p);
        const back = toMath(L, sx, sy);
        expect(back.x).toBeCloseTo(p.x, 9);
        expect(back.y).toBeCloseTo(p.y, 9);
        expect(snapToGrid(back, grid)).toEqual(p);
      }
    });

    it.each(AREAS)('in %s: a tap near an intersection snaps to it', (_areaName, area, padding) => {
      const L = computeGridLayout(grid, area, padding);
      const nudge = 0.3 * grid.step * L.unit;
      for (const p of intersections(grid)) {
        const { sx, sy } = toScreen(L, p);
        for (const [dx, dy] of [[nudge, nudge], [-nudge, nudge], [nudge, -nudge], [-nudge, -nudge]] as const) {
          expect(snapToGrid(toMath(L, sx + dx, sy + dy), grid)).toEqual(p);
        }
      }
    });
  });

  it('a tap outside the grid clamps to the nearest edge intersection', () => {
    const grid: Grid = { xMin: -5, xMax: 5, yMin: -4, yMax: 4, step: 1 };
    const L = computeGridLayout(grid, { x: 0, y: 0, width: 1920, height: 1080 });
    expect(snapToGrid(toMath(L, 0, 540), grid)).toEqual({ x: -5, y: 0 }); // far left of the stage
    expect(snapToGrid(toMath(L, 1919, -500), grid)).toEqual({ x: 5, y: 4 }); // above and to the right
  });

  it('never produces a zero or negative unit, even when padding exceeds the area', () => {
    const L = computeGridLayout({ xMin: -2, xMax: 2, yMin: -2, yMax: 2, step: 1 }, { x: 0, y: 0, width: 40, height: 40 }, 100);
    expect(L.unit).toBeGreaterThan(0);
  });
});

describe('snapping and stepping', () => {
  const grid2: Grid = { xMin: -4, xMax: 4, yMin: -4, yMax: 4, step: 2 };

  it('snapToGrid rounds to multiples of the step and clamps to the bounds', () => {
    expect(snapToGrid({ x: 1.2, y: -2.9 }, grid2)).toEqual({ x: 2, y: -2 });
    expect(snapToGrid({ x: 0.9, y: 0.4 }, grid2)).toEqual({ x: 0, y: 0 });
    expect(snapToGrid({ x: 99, y: -99 }, grid2)).toEqual({ x: 4, y: -4 });
  });

  it('snapToGrid never returns negative zero', () => {
    const s = snapToGrid({ x: -0.4, y: -0.2 }, grid2);
    expect(Object.is(s.x, -0)).toBe(false);
    expect(Object.is(s.y, -0)).toBe(false);
  });

  it('isOnGrid accepts intersections only', () => {
    expect(isOnGrid({ x: 2, y: -4 }, grid2)).toBe(true);
    expect(isOnGrid({ x: 1, y: 0 }, grid2)).toBe(false);
    expect(isOnGrid({ x: 6, y: 0 }, grid2)).toBe(false); // outside
  });

  it('stepPoint moves whole steps and stays inside the grid', () => {
    expect(stepPoint({ x: 0, y: 0 }, grid2, 1, 0)).toEqual({ x: 2, y: 0 });
    expect(stepPoint({ x: 0, y: 0 }, grid2, 0, -1)).toEqual({ x: 0, y: -2 });
    expect(stepPoint({ x: 4, y: 4 }, grid2, 1, 1)).toEqual({ x: 4, y: 4 });
    expect(stepPoint({ x: -4, y: 0 }, grid2, -3, 0)).toEqual({ x: -4, y: 0 });
  });

  it('clampPoint limits each axis independently', () => {
    expect(clampPoint({ x: -9, y: 2.5 }, grid2)).toEqual({ x: -4, y: 2.5 });
  });

  it('tickValues lists every step without negative zero', () => {
    expect(tickValues(-4, 4, 2)).toEqual([-4, -2, 0, 2, 4]);
    expect(tickValues(-10, 10, 5)).toEqual([-10, -5, 0, 5, 10]);
    expect(tickValues(-4, 4, 2).some((v) => Object.is(v, -0))).toBe(false);
  });
});

describe('quadrants and formatting', () => {
  it('quadrantOf follows the signs and returns null on either axis', () => {
    expect(quadrantOf({ x: 1, y: 1 })).toBe(1);
    expect(quadrantOf({ x: -1, y: 1 })).toBe(2);
    expect(quadrantOf({ x: -1, y: -1 })).toBe(3);
    expect(quadrantOf({ x: 1, y: -1 })).toBe(4);
    for (const p of [{ x: 0, y: 0 }, { x: 0, y: 5 }, { x: -3, y: 0 }, { x: -0, y: -2 }]) expect(quadrantOf(p)).toBeNull();
    expect(QUADRANT_NAMES[3]).toBe('Quadrant III');
  });

  it('formats numbers with a true minus sign and no trailing zeros', () => {
    expect(formatNumber(-3)).toBe('−3');
    expect(formatNumber(2.5)).toBe('2.5');
    expect(formatNumber(4)).toBe('4');
    expect(formatNumber(-0)).toBe('0');
    expect(formatNumber(1 / 3)).toBe('0.333');
    expect(formatPoint({ x: -4, y: -3 })).toBe('(−4, −3)');
  });

  it('speaks points for screen readers', () => {
    expect(speakPoint({ x: 3, y: -2 })).toBe('x 3, y negative 2');
    expect(speakPoint({ x: -1, y: 0 })).toBe('x negative 1, y 0');
  });
});
