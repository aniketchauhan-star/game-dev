import type { Grid, Point } from './schemas/interaction.ts';

/**
 * Coordinate-plane geometry. Mathematical y grows upward; screen y grows
 * downward. Every conversion goes through these functions so the runtime, the
 * studio thumbnails and the tests agree.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface GridLayout {
  grid: Grid;
  /** Size of one unit (not one step) in screen pixels — identical on both axes. */
  unit: number;
  /** Screen position of the mathematical origin (0, 0). */
  originX: number;
  originY: number;
  /** Screen rectangle covered by the grid. */
  left: number;
  top: number;
  width: number;
  height: number;
}

export function computeGridLayout(grid: Grid, area: Rect, padding = 0): GridLayout {
  const spanX = grid.xMax - grid.xMin;
  const spanY = grid.yMax - grid.yMin;
  const availW = Math.max(1, area.width - padding * 2);
  const availH = Math.max(1, area.height - padding * 2);
  const unit = Math.min(availW / spanX, availH / spanY);
  const width = unit * spanX;
  const height = unit * spanY;
  const left = area.x + (area.width - width) / 2;
  const top = area.y + (area.height - height) / 2;
  return {
    grid,
    unit,
    left,
    top,
    width,
    height,
    originX: left + (0 - grid.xMin) * unit,
    originY: top + grid.yMax * unit,
  };
}

/** Mathematical point → screen pixel. */
export function toScreen(layout: GridLayout, p: Point): { sx: number; sy: number } {
  return { sx: layout.originX + p.x * layout.unit, sy: layout.originY - p.y * layout.unit };
}

/** Screen pixel → mathematical point (unsnapped). */
export function toMath(layout: GridLayout, sx: number, sy: number): Point {
  return { x: (sx - layout.originX) / layout.unit, y: (layout.originY - sy) / layout.unit };
}

function roundToStep(v: number, step: number): number {
  const r = Math.round(v / step) * step;
  return Object.is(r, -0) ? 0 : r;
}

export function clampPoint(p: Point, grid: Grid): Point {
  return {
    x: Math.min(grid.xMax, Math.max(grid.xMin, p.x)),
    y: Math.min(grid.yMax, Math.max(grid.yMin, p.y)),
  };
}

/** Snap to the nearest grid intersection (multiples of `step`) inside the grid bounds. */
export function snapToGrid(p: Point, grid: Grid): Point {
  const c = clampPoint(p, grid);
  return { x: roundToStep(c.x, grid.step), y: roundToStep(c.y, grid.step) };
}

export function isOnGrid(p: Point, grid: Grid): boolean {
  const s = snapToGrid(p, grid);
  return Math.abs(s.x - p.x) < 1e-9 && Math.abs(s.y - p.y) < 1e-9;
}

/** Move by whole steps, staying inside the grid. */
export function stepPoint(p: Point, grid: Grid, dx: number, dy: number): Point {
  return snapToGrid({ x: p.x + dx * grid.step, y: p.y + dy * grid.step }, grid);
}

export function tickValues(min: number, max: number, step: number): number[] {
  const out: number[] = [];
  for (let v = min; v <= max + 1e-9; v += step) out.push(Object.is(v, -0) ? 0 : Math.round(v * 1e6) / 1e6);
  return out;
}

const MINUS = '−';

/** Format a number for learners: true minus sign, no trailing zeros. */
export function formatNumber(n: number): string {
  const rounded = Math.round(n * 1000) / 1000;
  const abs = Math.abs(rounded);
  const s = Number.isInteger(abs) ? String(abs) : String(abs);
  return rounded < 0 ? `${MINUS}${s}` : s;
}

export function formatPoint(p: Point): string {
  return `(${formatNumber(p.x)}, ${formatNumber(p.y)})`;
}

/** Spoken form for screen readers, e.g. "x 3, y negative 2". */
export function speakPoint(p: Point): string {
  const say = (n: number) => (n < 0 ? `negative ${Math.abs(n)}` : String(n));
  return `x ${say(p.x)}, y ${say(p.y)}`;
}

export function quadrantOf(p: Point): 1 | 2 | 3 | 4 | null {
  if (p.x === 0 || p.y === 0) return null;
  if (p.x > 0 && p.y > 0) return 1;
  if (p.x < 0 && p.y > 0) return 2;
  if (p.x < 0 && p.y < 0) return 3;
  return 4;
}

export const QUADRANT_NAMES: Record<1 | 2 | 3 | 4, string> = { 1: 'Quadrant I', 2: 'Quadrant II', 3: 'Quadrant III', 4: 'Quadrant IV' };
