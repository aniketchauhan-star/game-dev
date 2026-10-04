import { isOnGrid, quadrantOf, snapToGrid } from './coords.ts';
import { evaluateCoordinate, findMatchAssignment, isSequenceSolved, solvedSequence } from './rules.ts';
import { sceneSeed, shuffleUntil } from './rng.ts';
import type {
  CoordinateInteraction,
  MatchInteraction,
  Point,
  SceneInteraction,
  SortInteraction,
} from './schemas/interaction.ts';
import { UNSUPPORTED_MESSAGE } from './registry.ts';

/**
 * Checks that a configured interaction can actually be completed. Run by the
 * builder before a version is stored and again when the creator edits a scene.
 */

export interface InteractionIssue {
  severity: 'error' | 'warning';
  message: string;
}

const inGrid = (p: Point, i: CoordinateInteraction) =>
  p.x >= i.grid.xMin && p.x <= i.grid.xMax && p.y >= i.grid.yMin && p.y <= i.grid.yMax;

function checkCoordinate(i: CoordinateInteraction): InteractionIssue[] {
  const issues: InteractionIssue[] = [];
  if (!inGrid(i.start, i)) issues.push({ severity: 'error', message: 'Start position is outside the grid.' });
  else if (!isOnGrid(i.start, i.grid)) issues.push({ severity: 'error', message: `Start position must sit on a grid intersection (multiples of ${i.grid.step}).` });

  const targets: Point[] = i.rule.kind === 'point-equals' ? [i.rule.target] : i.rule.kind === 'point-in-set' ? i.rule.targets : [];
  for (const t of targets) {
    if (!inGrid(t, i)) issues.push({ severity: 'error', message: `Target (${t.x}, ${t.y}) is outside the grid, so it cannot be reached.` });
    else if (!isOnGrid(t, i.grid)) issues.push({ severity: 'error', message: `Target (${t.x}, ${t.y}) is not on a grid intersection, so it cannot be reached with step ${i.grid.step}.` });
  }
  if (i.rule.kind === 'in-quadrant') {
    // Some intersection of the grid must lie in the quadrant.
    const q = i.rule.quadrant;
    const xs = q === 1 || q === 4 ? i.grid.xMax : i.grid.xMin;
    const ys = q === 1 || q === 2 ? i.grid.yMax : i.grid.yMin;
    const corner = snapToGrid({ x: xs, y: ys }, i.grid);
    if (quadrantOf(corner) !== q) issues.push({ severity: 'error', message: `The grid does not include Quadrant ${q}.` });
  }
  if (evaluateCoordinate(i.start, i.rule)) issues.push({ severity: 'warning', message: 'The mover starts on a correct answer, so the scene is solved before the learner acts.' });
  if (i.showTargetMarker && i.rule.kind !== 'point-equals' && i.rule.kind !== 'point-in-set') {
    issues.push({ severity: 'warning', message: 'Target markers only appear for point targets.' });
  }
  for (const l of i.landmarks) {
    if (!inGrid(l.point, i)) issues.push({ severity: 'error', message: `Landmark “${l.label}” is outside the grid.` });
  }
  const ids = i.landmarks.map((l) => l.id);
  if (new Set(ids).size !== ids.length) issues.push({ severity: 'error', message: 'Landmark ids must be unique.' });
  return issues;
}

function checkMatch(i: MatchInteraction): InteractionIssue[] {
  const issues: InteractionIssue[] = [];
  const itemIds = new Set(i.items.map((x) => x.id));
  const targetIds = new Set(i.targets.map((x) => x.id));
  if (itemIds.size !== i.items.length) issues.push({ severity: 'error', message: 'Item ids must be unique.' });
  if (targetIds.size !== i.targets.length) issues.push({ severity: 'error', message: 'Target ids must be unique.' });
  const covered = new Set<string>();
  for (const a of i.rule.accepts) {
    if (!itemIds.has(a.itemId)) issues.push({ severity: 'error', message: `Rule mentions unknown item "${a.itemId}".` });
    if (covered.has(a.itemId)) issues.push({ severity: 'error', message: `Item "${a.itemId}" has more than one rule.` });
    covered.add(a.itemId);
    for (const t of a.targetIds) if (!targetIds.has(t)) issues.push({ severity: 'error', message: `Rule mentions unknown target "${t}".` });
  }
  for (const item of i.items) {
    if (!covered.has(item.id)) issues.push({ severity: 'error', message: `Item “${item.label}” has no rule. Give it target(s), or an empty list to make it a distractor.` });
  }
  const required = i.rule.accepts.filter((a) => a.targetIds.length > 0).length;
  if (required === 0) issues.push({ severity: 'error', message: 'At least one item must belong to a target.' });
  if (issues.every((x) => x.severity !== 'error') && findMatchAssignment(i) === null) {
    issues.push({ severity: 'error', message: 'No arrangement satisfies every item within the target capacities. Increase a capacity or allow another target.' });
  }
  const totalCapacity = i.targets.reduce((s, t) => s + t.capacity, 0);
  if (totalCapacity < required) issues.push({ severity: 'error', message: 'Targets do not have room for every item that must be placed.' });
  return issues;
}

function checkSort(i: SortInteraction, seed: number, sceneId: string): InteractionIssue[] {
  const issues: InteractionIssue[] = [];
  const ids = i.items.map((x) => x.id);
  if (new Set(ids).size !== ids.length) issues.push({ severity: 'error', message: 'Item ids must be unique.' });
  if (i.rule.kind === 'order-by-value') {
    if (i.items.some((x) => x.value === null)) issues.push({ severity: 'error', message: 'Sorting by value needs a number on every item.' });
    const distinct = new Set(i.items.map((x) => x.value));
    if (distinct.size < 2) issues.push({ severity: 'error', message: 'Sorting needs at least two different values.' });
  } else {
    const order = i.rule.order;
    if (order.length !== ids.length || new Set(order).size !== order.length || !order.every((id) => ids.includes(id))) {
      issues.push({ severity: 'error', message: 'The sequence must list every item exactly once.' });
    }
    const seen = new Set<string>();
    for (const group of i.rule.interchangeable) {
      for (const id of group) {
        if (!ids.includes(id)) issues.push({ severity: 'error', message: `Interchangeable group mentions unknown item "${id}".` });
        if (seen.has(id)) issues.push({ severity: 'error', message: `Item "${id}" appears in more than one interchangeable group.` });
        seen.add(id);
      }
    }
    if (i.rule.interchangeable.length === 1 && i.rule.interchangeable[0]!.length === ids.length) {
      issues.push({ severity: 'error', message: 'Every item is interchangeable, so any order is correct.' });
    }
  }
  if (!issues.some((x) => x.severity === 'error')) {
    if (!isSequenceSolved(solvedSequence(i), i)) issues.push({ severity: 'error', message: 'The configured rule has no solvable order.' });
    const start = shuffleUntil(ids, sceneSeed(seed, sceneId), (arr) => !isSequenceSolved(arr, i));
    if (isSequenceSolved(start, i)) issues.push({ severity: 'error', message: 'Could not find a starting order that is not already solved.' });
  }
  return issues;
}

export function checkInteraction(interaction: SceneInteraction, opts: { seed: number; sceneId: string }): InteractionIssue[] {
  switch (interaction.type) {
    case 'info':
      return [];
    case 'coordinate-navigation':
      return checkCoordinate(interaction);
    case 'drag-match':
      return checkMatch(interaction);
    case 'sequence-sort':
      return checkSort(interaction, opts.seed, opts.sceneId);
    case 'custom':
      return [{ severity: 'error', message: UNSUPPORTED_MESSAGE }];
  }
}

/** Starting order for a sort scene — deterministic for the seed and never already solved. */
export function sortStartOrder(i: SortInteraction, seed: number, sceneId: string): string[] {
  return shuffleUntil(
    i.items.map((x) => x.id),
    sceneSeed(seed, sceneId),
    (arr) => !isSequenceSolved(arr, i),
  );
}
