import { formatNumber, formatPoint, quadrantOf, QUADRANT_NAMES } from './coords.ts';
import type {
  CoordinateRule,
  MatchInteraction,
  Point,
  SequenceRule,
  SortInteraction,
} from './schemas/interaction.ts';

/**
 * Trusted, deterministic evaluation of allowlisted answer rules. No rule is
 * ever executed as code: each `kind` maps to a function written here.
 */

const EPS = 1e-9;
const samePoint = (a: Point, b: Point) => Math.abs(a.x - b.x) < EPS && Math.abs(a.y - b.y) < EPS;

// ───────────────────────────── Coordinate navigation ─────────────────────────────

export function evaluateCoordinate(position: Point, rule: CoordinateRule): boolean {
  switch (rule.kind) {
    case 'point-equals':
      return samePoint(position, rule.target);
    case 'point-in-set':
      return rule.targets.some((t) => samePoint(position, t));
    case 'in-quadrant':
      return quadrantOf(position) === rule.quadrant;
    case 'on-axis':
      return rule.axis === 'x' ? Math.abs(position.y) < EPS : Math.abs(position.x) < EPS;
  }
}

export type CoordinateDiagnosisKind =
  | 'correct'
  | 'swapped'
  | 'x-sign'
  | 'y-sign'
  | 'both-signs'
  | 'x-off'
  | 'y-off'
  | 'both-off'
  | 'wrong-quadrant'
  | 'on-axis-not-quadrant'
  | 'not-on-axis';

export interface CoordinateDiagnosis {
  kind: CoordinateDiagnosisKind;
  /** Remaining movement to the nearest target, in units (positive = right/up). */
  dx: number | null;
  dy: number | null;
}

function nearestTarget(position: Point, targets: Point[]): Point {
  let best = targets[0]!;
  let bestD = Infinity;
  for (const t of targets) {
    const d = Math.abs(t.x - position.x) + Math.abs(t.y - position.y);
    if (d < bestD) {
      best = t;
      bestD = d;
    }
  }
  return best;
}

/** Explain a wrong answer in terms of common coordinate misconceptions. */
export function diagnoseCoordinate(position: Point, rule: CoordinateRule): CoordinateDiagnosis {
  if (evaluateCoordinate(position, rule)) return { kind: 'correct', dx: 0, dy: 0 };
  if (rule.kind === 'in-quadrant') {
    return { kind: quadrantOf(position) === null ? 'on-axis-not-quadrant' : 'wrong-quadrant', dx: null, dy: null };
  }
  if (rule.kind === 'on-axis') return { kind: 'not-on-axis', dx: null, dy: null };
  const target = rule.kind === 'point-equals' ? rule.target : nearestTarget(position, rule.targets);
  const dx = target.x - position.x;
  const dy = target.y - position.y;
  if (target.x !== target.y && samePoint(position, { x: target.y, y: target.x })) return { kind: 'swapped', dx, dy };
  const xRight = Math.abs(position.x - target.x) < EPS;
  const yRight = Math.abs(position.y - target.y) < EPS;
  const xNeg = target.x !== 0 && Math.abs(position.x + target.x) < EPS;
  const yNeg = target.y !== 0 && Math.abs(position.y + target.y) < EPS;
  if (xNeg && yNeg) return { kind: 'both-signs', dx, dy };
  if (xNeg && yRight) return { kind: 'x-sign', dx, dy };
  if (yNeg && xRight) return { kind: 'y-sign', dx, dy };
  if (xRight) return { kind: 'y-off', dx, dy };
  if (yRight) return { kind: 'x-off', dx, dy };
  return { kind: 'both-off', dx, dy };
}

function moveWords(dx: number, dy: number): string {
  const parts: string[] = [];
  if (dx !== 0) parts.push(`${formatNumber(Math.abs(dx))} ${Math.abs(dx) === 1 ? 'unit' : 'units'} ${dx > 0 ? 'right' : 'left'}`);
  if (dy !== 0) parts.push(`${formatNumber(Math.abs(dy))} ${Math.abs(dy) === 1 ? 'unit' : 'units'} ${dy > 0 ? 'up' : 'down'}`);
  return parts.join(' and ');
}

/**
 * Learner-facing feedback for a coordinate attempt. `revealDirections` is used
 * by later hints; early feedback names the misconception without solving it.
 */
export function coordinateFeedback(position: Point, rule: CoordinateRule, revealDirections: boolean): string {
  const d = diagnoseCoordinate(position, rule);
  const at = `You are at ${formatPoint(position)}.`;
  switch (d.kind) {
    case 'correct':
      return `${at} That is correct.`;
    case 'swapped':
      return `${at} It looks like x and y were swapped. The first number is x (left or right); the second is y (up or down).`;
    case 'x-sign':
      return `${at} Your y is right. Check the sign of x: negative x is left of the y-axis, positive x is right.`;
    case 'y-sign':
      return `${at} Your x is right. Check the sign of y: negative y is below the x-axis, positive y is above.`;
    case 'both-signs':
      return `${at} Both signs are flipped. Negative numbers go left (for x) and down (for y).`;
    case 'x-off':
      return revealDirections && d.dx !== null
        ? `${at} Your y is right. Move ${moveWords(d.dx, 0)}.`
        : `${at} Your y is right. Count along the x-axis again.`;
    case 'y-off':
      return revealDirections && d.dy !== null
        ? `${at} Your x is right. Move ${moveWords(0, d.dy)}.`
        : `${at} Your x is right. Count along the y-axis again.`;
    case 'both-off':
      return revealDirections && d.dx !== null && d.dy !== null
        ? `${at} Move ${moveWords(d.dx, d.dy)}.`
        : `${at} Start from the origin (0, 0): move along x first, then along y.`;
    case 'wrong-quadrant':
      return rule.kind === 'in-quadrant'
        ? `${at} That is in ${QUADRANT_NAMES[quadrantOf(position)!]}. You need ${QUADRANT_NAMES[rule.quadrant]}.`
        : at;
    case 'on-axis-not-quadrant':
      return `${at} Points on an axis are not in any quadrant. Move off the axis.`;
    case 'not-on-axis':
      return rule.kind === 'on-axis'
        ? `${at} Points on the ${rule.axis}-axis have ${rule.axis === 'x' ? 'y = 0' : 'x = 0'}.`
        : at;
  }
}

export function describeCoordinateRule(rule: CoordinateRule): string {
  switch (rule.kind) {
    case 'point-equals':
      return `Reach ${formatPoint(rule.target)}`;
    case 'point-in-set':
      return `Reach any of ${rule.targets.map(formatPoint).join(', ')}`;
    case 'in-quadrant':
      return `Finish anywhere in ${QUADRANT_NAMES[rule.quadrant]}`;
    case 'on-axis':
      return `Finish on the ${rule.axis}-axis`;
  }
}

// ───────────────────────────── Drag and match ─────────────────────────────

export type MatchItemResult = 'correct' | 'incorrect' | 'unplaced' | 'distractor-placed' | 'distractor-ok';

export interface MatchEvaluation {
  correct: boolean;
  items: Record<string, MatchItemResult>;
  overCapacity: string[];
  correctCount: number;
  requiredCount: number;
}

/** `placements`: item id → target id, or null when the item is still in the tray. */
export function evaluateMatch(placements: Record<string, string | null>, interaction: MatchInteraction): MatchEvaluation {
  const accepts = new Map(interaction.rule.accepts.map((a) => [a.itemId, new Set(a.targetIds)]));
  const items: Record<string, MatchItemResult> = {};
  let correctCount = 0;
  let requiredCount = 0;
  for (const item of interaction.items) {
    const allowed = accepts.get(item.id) ?? new Set<string>();
    // Own keys only: an item id such as "constructor" must not resolve to Object.prototype.
    const placed = Object.hasOwn(placements, item.id) ? (placements[item.id] ?? null) : null;
    if (allowed.size === 0) {
      items[item.id] = placed === null ? 'distractor-ok' : 'distractor-placed';
      continue;
    }
    requiredCount++;
    if (placed === null) items[item.id] = 'unplaced';
    else if (allowed.has(placed)) {
      items[item.id] = 'correct';
      correctCount++;
    } else items[item.id] = 'incorrect';
  }
  const counts = new Map<string, number>();
  for (const t of Object.values(placements)) if (t !== null) counts.set(t, (counts.get(t) ?? 0) + 1);
  const overCapacity = interaction.targets.filter((t) => (counts.get(t.id) ?? 0) > t.capacity).map((t) => t.id);
  const correct = overCapacity.length === 0 && Object.values(items).every((r) => r === 'correct' || r === 'distractor-ok');
  return { correct, items, overCapacity, correctCount, requiredCount };
}

/**
 * Is there at least one arrangement that satisfies every item while respecting
 * target capacities? Bipartite matching with capacities (augmenting paths).
 */
export function findMatchAssignment(interaction: MatchInteraction): Record<string, string> | null {
  const accepts = new Map(interaction.rule.accepts.map((a) => [a.itemId, a.targetIds]));
  const capacity = new Map(interaction.targets.map((t) => [t.id, t.capacity]));
  const required = interaction.items.filter((i) => (accepts.get(i.id)?.length ?? 0) > 0).map((i) => i.id);
  const assigned = new Map<string, string>(); // item -> target
  const load = new Map<string, string[]>(); // target -> items

  const tryAssign = (item: string, visited: Set<string>): boolean => {
    for (const target of accepts.get(item) ?? []) {
      if (!capacity.has(target) || visited.has(target)) continue;
      visited.add(target);
      const current = load.get(target) ?? [];
      if (current.length < (capacity.get(target) ?? 0)) {
        current.push(item);
        load.set(target, current);
        assigned.set(item, target);
        return true;
      }
      for (const other of current) {
        if (tryAssign(other, visited)) {
          const after = (load.get(target) ?? []).filter((x) => x !== other);
          after.push(item);
          load.set(target, after);
          assigned.set(item, target);
          return true;
        }
      }
    }
    return false;
  };

  for (const item of required) {
    if (!tryAssign(item, new Set())) return null;
  }
  return Object.fromEntries(assigned);
}

// ───────────────────────────── Sequence sorting ─────────────────────────────

export interface SequenceEvaluation {
  correct: boolean;
  /** For each position: does the item there belong in that position? */
  positions: boolean[];
  correctCount: number;
}

function equivalenceClass(rule: Extract<SequenceRule, { kind: 'explicit-order' }>): Map<string, string> {
  const cls = new Map<string, string>();
  for (const id of rule.order) cls.set(id, id);
  rule.interchangeable.forEach((group, gi) => {
    for (const id of group) cls.set(id, `group:${gi}`);
  });
  return cls;
}

/** Evaluate an arrangement (array of item ids). Duplicate values may appear in either order. */
export function evaluateSequence(order: string[], interaction: SortInteraction): SequenceEvaluation {
  const rule = interaction.rule;
  let positions: boolean[];
  if (rule.kind === 'order-by-value') {
    const value = new Map(interaction.items.map((i) => [i.id, i.value ?? NaN]));
    const sorted = interaction.items
      .map((i) => i.value ?? NaN)
      .sort((a, b) => (rule.direction === 'ascending' ? a - b : b - a));
    positions = order.map((id, idx) => {
      const v = value.get(id);
      return v !== undefined && !Number.isNaN(v) && v === sorted[idx];
    });
  } else {
    const cls = equivalenceClass(rule);
    positions = order.map((id, idx) => {
      const expected = rule.order[idx];
      return expected !== undefined && cls.get(id) !== undefined && cls.get(id) === cls.get(expected);
    });
  }
  const complete = order.length === interaction.items.length && new Set(order).size === order.length;
  const correctCount = positions.filter(Boolean).length;
  return { correct: complete && correctCount === order.length, positions, correctCount };
}

export function isSequenceSolved(order: string[], interaction: SortInteraction): boolean {
  return evaluateSequence(order, interaction).correct;
}

/** A canonical solved order (used for previews and attainability checks). */
export function solvedSequence(interaction: SortInteraction): string[] {
  const rule = interaction.rule;
  if (rule.kind === 'explicit-order') return rule.order.slice();
  return interaction.items
    .slice()
    .sort((a, b) => ((rule.direction === 'ascending' ? 1 : -1) * ((a.value ?? 0) - (b.value ?? 0))))
    .map((i) => i.id);
}

export function describeSequenceRule(rule: SequenceRule): string {
  if (rule.kind === 'order-by-value') {
    return rule.direction === 'ascending' ? 'Order from smallest to largest value (equal values may go in either order)' : 'Order from largest to smallest value (equal values may go in either order)';
  }
  return rule.interchangeable.length > 0
    ? 'Match the given sequence; grouped items may swap with each other'
    : 'Match the given sequence exactly';
}

export function describeMatchRule(interaction: MatchInteraction): string {
  const label = new Map(interaction.targets.map((t) => [t.id, t.label]));
  const itemLabel = new Map(interaction.items.map((i) => [i.id, i.label]));
  return interaction.rule.accepts
    .map((a) =>
      a.targetIds.length === 0
        ? `${itemLabel.get(a.itemId) ?? a.itemId} → stays unplaced`
        : `${itemLabel.get(a.itemId) ?? a.itemId} → ${a.targetIds.map((t) => label.get(t) ?? t).join(' or ')}`,
    )
    .join('; ');
}
