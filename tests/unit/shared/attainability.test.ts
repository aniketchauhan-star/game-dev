import { describe, expect, it } from 'vitest';
import { checkInteraction, sortStartOrder, type InteractionIssue } from '@shared/attainability.ts';
import { UNSUPPORTED_MESSAGE } from '@shared/registry.ts';
import { sceneSeed, seededShuffle } from '@shared/rng.ts';
import { isSequenceSolved } from '@shared/rules.ts';
import type { CoordinateInteraction, Grid, SceneInteraction, SortInteraction } from '@shared/schemas/interaction.ts';
import { buildMatch, buildSort, coordInteraction, matchInteraction, sortInteraction, sorted } from './helpers.ts';

const OPTS = { seed: 424242, sceneId: 'scn_test' };
const check = (i: SceneInteraction, opts = OPTS): InteractionIssue[] => checkInteraction(i, opts);
const errors = (i: SceneInteraction): string[] => check(i).filter((x) => x.severity === 'error').map((x) => x.message);
const warnings = (i: SceneInteraction): string[] => check(i).filter((x) => x.severity === 'warning').map((x) => x.message);

const coord = (overrides: Partial<CoordinateInteraction>) => coordInteraction({ landmarks: [], showTargetMarker: false, ...overrides });

// ───────────────────────────── coordinate navigation ─────────────────────────────

describe('checkInteraction: coordinate navigation', () => {
  it('reports nothing for a reachable target', () => {
    expect(check(coordInteraction())).toEqual([]);
  });

  it('rejects a start position outside the grid', () => {
    expect(errors(coord({ start: { x: 6, y: 0 } }))).toEqual(['Start position is outside the grid.']);
    expect(errors(coord({ start: { x: 0, y: -5 } }))).toEqual(['Start position is outside the grid.']);
  });

  it('rejects a start position between grid intersections', () => {
    const grid: Grid = { xMin: -4, xMax: 4, yMin: -4, yMax: 4, step: 2 };
    expect(errors(coord({ grid, start: { x: 1, y: 0 }, rule: { kind: 'point-equals', target: { x: 2, y: 2 } } }))).toEqual([
      'Start position must sit on a grid intersection (multiples of 2).',
    ]);
    expect(errors(coord({ start: { x: 0.5, y: 1 } }))).toEqual(['Start position must sit on a grid intersection (multiples of 1).']);
  });

  it('rejects a target outside the grid as unreachable', () => {
    expect(errors(coord({ rule: { kind: 'point-equals', target: { x: 6, y: 0 } } }))).toEqual(['Target (6, 0) is outside the grid, so it cannot be reached.']);
    expect(errors(coord({ rule: { kind: 'point-equals', target: { x: -1, y: -7 } } }))).toEqual(['Target (-1, -7) is outside the grid, so it cannot be reached.']);
  });

  it('rejects a target that is not on a multiple of the step', () => {
    const grid: Grid = { xMin: -4, xMax: 4, yMin: -4, yMax: 4, step: 2 };
    expect(errors(coord({ grid, rule: { kind: 'point-equals', target: { x: 3, y: 2 } } }))).toEqual([
      'Target (3, 2) is not on a grid intersection, so it cannot be reached with step 2.',
    ]);
    const grid5: Grid = { xMin: -10, xMax: 10, yMin: -10, yMax: 10, step: 5 };
    expect(errors(coord({ grid: grid5, rule: { kind: 'point-equals', target: { x: 5, y: -5 } } }))).toEqual([]);
    expect(errors(coord({ grid: grid5, rule: { kind: 'point-equals', target: { x: 7, y: 5 } } }))).toEqual([
      'Target (7, 5) is not on a grid intersection, so it cannot be reached with step 5.',
    ]);
  });

  it('checks every target of a point-in-set rule and reports only the unreachable ones', () => {
    const i = coord({ rule: { kind: 'point-in-set', targets: [{ x: 2, y: 2 }, { x: 7, y: 1 }, { x: 1.5, y: 0 }, { x: -5, y: 4 }] } });
    expect(errors(i)).toEqual([
      'Target (7, 1) is outside the grid, so it cannot be reached.',
      'Target (1.5, 0) is not on a grid intersection, so it cannot be reached with step 1.',
    ]);
  });

  it('rejects a quadrant the grid does not include', () => {
    const rightHalf: Grid = { xMin: 0, xMax: 6, yMin: -4, yMax: 4, step: 1 };
    const quadrant = (q: 1 | 2 | 3 | 4) => errors(coord({ grid: rightHalf, start: { x: 0, y: 0 }, rule: { kind: 'in-quadrant', quadrant: q } }));
    expect(quadrant(1)).toEqual([]);
    expect(quadrant(4)).toEqual([]);
    expect(quadrant(2)).toEqual(['The grid does not include Quadrant 2.']);
    expect(quadrant(3)).toEqual(['The grid does not include Quadrant 3.']);

    const firstOnly: Grid = { xMin: 0, xMax: 10, yMin: 0, yMax: 10, step: 2 };
    for (const q of [2, 3, 4] as const) {
      expect(errors(coord({ grid: firstOnly, rule: { kind: 'in-quadrant', quadrant: q } }))).toEqual([`The grid does not include Quadrant ${q}.`]);
    }
    expect(errors(coord({ grid: firstOnly, rule: { kind: 'in-quadrant', quadrant: 1 } }))).toEqual([]);
  });

  it('always accepts on-axis rules, because every valid grid contains both axes', () => {
    const firstOnly: Grid = { xMin: 0, xMax: 6, yMin: 0, yMax: 6, step: 2 };
    for (const axis of ['x', 'y'] as const) {
      expect(errors(coord({ grid: firstOnly, start: { x: 2, y: 2 }, rule: { kind: 'on-axis', axis } }))).toEqual([]);
    }
  });

  it('warns (without blocking) when the mover starts on a correct answer', () => {
    const solvedAtStart: CoordinateInteraction[] = [
      coord({ start: { x: 3, y: 2 }, rule: { kind: 'point-equals', target: { x: 3, y: 2 } } }),
      coord({ start: { x: 1, y: 1 }, rule: { kind: 'point-in-set', targets: [{ x: 1, y: 1 }, { x: 2, y: 2 }] } }),
      coord({ start: { x: -1, y: 2 }, rule: { kind: 'in-quadrant', quadrant: 2 } }),
      coord({ start: { x: 0, y: 0 }, rule: { kind: 'on-axis', axis: 'y' } }),
    ];
    for (const i of solvedAtStart) {
      expect(errors(i)).toEqual([]);
      expect(warnings(i)).toEqual(['The mover starts on a correct answer, so the scene is solved before the learner acts.']);
    }
  });

  it('warns that target markers only appear for point targets', () => {
    const i = coord({ start: { x: 2, y: -1 }, showTargetMarker: true, rule: { kind: 'in-quadrant', quadrant: 2 } });
    expect(warnings(i)).toEqual(['Target markers only appear for point targets.']);
    expect(warnings(coord({ showTargetMarker: true }))).toEqual([]);
  });

  it('rejects landmarks outside the grid and duplicate landmark ids', () => {
    const outside = coord({ landmarks: [{ id: 'tower', label: 'Tower', point: { x: 9, y: 0 }, icon: 'tower' }] });
    expect(errors(outside)).toEqual(['Landmark “Tower” is outside the grid.']);
    const dupes = coord({
      landmarks: [
        { id: 'gate', label: 'Gate A', point: { x: 1, y: 1 }, icon: 'gate' },
        { id: 'gate', label: 'Gate B', point: { x: 2, y: 1 }, icon: 'gate' },
      ],
    });
    expect(errors(dupes)).toEqual(['Landmark ids must be unique.']);
  });

  it('accumulates independent problems', () => {
    const i = coord({ start: { x: 9, y: 9 }, rule: { kind: 'point-equals', target: { x: 9, y: 0 } }, landmarks: [{ id: 'far', label: 'Far', point: { x: 0, y: 99 }, icon: 'flag' }] });
    expect(errors(i)).toHaveLength(3);
  });

  it('does not depend on the seed or scene id', () => {
    const i = coord({ rule: { kind: 'point-equals', target: { x: 6, y: 0 } } });
    expect(check(i, { seed: 1, sceneId: 'a' })).toEqual(check(i, { seed: 99, sceneId: 'b' }));
  });
});

// ───────────────────────────── drag and match ─────────────────────────────

describe('checkInteraction: drag-match', () => {
  it('reports nothing for a solvable quadrant sort', () => {
    expect(check(matchInteraction())).toEqual([]);
  });

  it('accepts rules with several valid arrangements and distractors', () => {
    expect(check(buildMatch({ a: ['t1', 't2'], b: ['t1', 't2'], c: ['t2'], d: [] }, { t1: 1, t2: 2 }))).toEqual([]);
  });

  it('distractors need no room: capacities only have to fit the required items', () => {
    expect(check(buildMatch({ a: ['t1'], b: ['t1'], d: [], e: [] }, { t1: 2 }))).toEqual([]);
  });

  it('rejects duplicate item and target ids', () => {
    const base = matchInteraction();
    const dupItems = matchInteraction({ items: [...base.items, { id: 'p1', label: 'Copy', imageAssetId: null }] });
    expect(errors(dupItems)).toContain('Item ids must be unique.');
    const dupTargets = matchInteraction({ targets: [...base.targets, { id: 'q1', label: 'Copy', imageAssetId: null, capacity: 1 }] });
    expect(errors(dupTargets)).toContain('Target ids must be unique.');
  });

  it('rejects rules that mention unknown items or targets', () => {
    const base = matchInteraction();
    const unknownItem = matchInteraction({ rule: { kind: 'match-sets', accepts: [...base.rule.accepts, { itemId: 'zz', targetIds: ['q1'] }] } });
    expect(errors(unknownItem)).toEqual(['Rule mentions unknown item "zz".']);
    const unknownTarget = matchInteraction({
      rule: { kind: 'match-sets', accepts: base.rule.accepts.map((a) => (a.itemId === 'p1' ? { itemId: 'p1', targetIds: ['q9'] } : a)) },
    });
    expect(errors(unknownTarget)).toEqual(['Rule mentions unknown target "q9".']);
  });

  it('rejects an item with more than one rule, and an item with none', () => {
    const base = matchInteraction();
    const twice = matchInteraction({ rule: { kind: 'match-sets', accepts: [...base.rule.accepts, { itemId: 'p1', targetIds: ['q2'] }] } });
    expect(errors(twice)).toEqual(['Item "p1" has more than one rule.']);
    const none = matchInteraction({ rule: { kind: 'match-sets', accepts: base.rule.accepts.filter((a) => a.itemId !== 'p2') } });
    expect(errors(none)).toEqual(['Item “(−4, 1)” has no rule. Give it target(s), or an empty list to make it a distractor.']);
  });

  it('rejects a rule where every item is a distractor', () => {
    expect(errors(buildMatch({ a: [], b: [] }, { t1: 1 }))).toEqual(['At least one item must belong to a target.']);
  });

  it('rejects capacities too small for the items that must be placed', () => {
    expect(errors(buildMatch({ a: ['t1'], b: ['t1'], c: ['t1'] }, { t1: 2 }))).toEqual([
      'No arrangement satisfies every item within the target capacities. Increase a capacity or allow another target.',
      'Targets do not have room for every item that must be placed.',
    ]);
  });

  it('rejects capacities that fit in total but not in distribution', () => {
    expect(errors(buildMatch({ a: ['t1'], b: ['t1'], c: ['t2'] }, { t1: 1, t2: 5 }))).toEqual([
      'No arrangement satisfies every item within the target capacities. Increase a capacity or allow another target.',
    ]);
  });
});

// ───────────────────────────── sequence sorting ─────────────────────────────

describe('checkInteraction: sequence-sort', () => {
  const explicit = (order: string[], interchangeable: string[][], ids = ['a', 'b', 'c', 'd']): SortInteraction =>
    buildSort(Object.fromEntries(ids.map((id) => [id, null])), { kind: 'explicit-order', order, interchangeable });

  it('reports nothing for valid order-by-value and explicit-order rules', () => {
    expect(check(sortInteraction())).toEqual([]);
    expect(check(sortInteraction({ rule: { kind: 'order-by-value', direction: 'descending' } }))).toEqual([]);
    expect(check(explicit(['a', 'b', 'c', 'd'], [['b', 'c']]))).toEqual([]);
  });

  it('rejects order-by-value when an item has no value', () => {
    expect(errors(buildSort({ a: 1, b: null, c: 3 }, { kind: 'order-by-value', direction: 'ascending' }))).toEqual([
      'Sorting by value needs a number on every item.',
    ]);
  });

  it('rejects order-by-value when every value is the same', () => {
    expect(errors(buildSort({ a: 2, b: 2, c: 2 }, { kind: 'order-by-value', direction: 'ascending' }))).toEqual([
      'Sorting needs at least two different values.',
    ]);
    expect(errors(buildSort({ a: null, b: null, c: null }, { kind: 'order-by-value', direction: 'ascending' }))).toEqual([
      'Sorting by value needs a number on every item.',
      'Sorting needs at least two different values.',
    ]);
  });

  it('accepts ties as long as at least two values differ', () => {
    expect(check(buildSort({ a: 1, b: 1, c: 2 }, { kind: 'order-by-value', direction: 'ascending' }))).toEqual([]);
  });

  it('rejects duplicate item ids', () => {
    const base = sortInteraction();
    expect(errors(sortInteraction({ items: [...base.items, { ...base.items[0]!, label: 'Copy' }] }))).toEqual(['Item ids must be unique.']);
  });

  it('rejects explicit orders that do not list every item exactly once', () => {
    const message = 'The sequence must list every item exactly once.';
    expect(errors(explicit(['a', 'b', 'c'], []))).toEqual([message]); // missing d
    expect(errors(explicit(['a', 'b', 'c', 'c'], []))).toEqual([message]); // repeated c
    expect(errors(explicit(['a', 'b', 'c', 'zz'], []))).toEqual([message]); // unknown id
  });

  it('rejects interchangeable groups with unknown or repeated items', () => {
    expect(errors(explicit(['a', 'b', 'c', 'd'], [['b', 'zz']]))).toEqual(['Interchangeable group mentions unknown item "zz".']);
    expect(errors(explicit(['a', 'b', 'c', 'd'], [['a', 'b'], ['b', 'c']]))).toEqual(['Item "b" appears in more than one interchangeable group.']);
  });

  it('rejects a single group that makes every item interchangeable', () => {
    expect(errors(explicit(['a', 'b', 'c', 'd'], [['d', 'c', 'b', 'a']]))).toEqual(['Every item is interchangeable, so any order is correct.']);
  });

  it('defensive: flags a rule with no solvable order (non-finite value that bypassed the schema)', () => {
    const forged = buildSort({ a: Number.NaN, b: 1, c: 2 }, { kind: 'order-by-value', direction: 'ascending' });
    expect(errors(forged)).toEqual(['The configured rule has no solvable order.']);
  });

  it('defensive: flags a sort whose only possible order is already solved (single item that bypassed the schema)', () => {
    const forged = buildSort({ a: null }, { kind: 'explicit-order', order: ['a'], interchangeable: [] });
    expect(errors(forged)).toEqual(['Could not find a starting order that is not already solved.']);
  });
});

describe('checkInteraction: info and custom', () => {
  it('concept cards are always playable', () => {
    expect(check({ type: 'info', points: ['The origin is (0, 0).'], illustration: 'quadrants', continueLabel: 'Next' })).toEqual([]);
  });

  it('custom mechanics are reported as not buildable', () => {
    expect(check({ type: 'custom', description: 'A timed card-flip memory game.' })).toEqual([{ severity: 'error', message: UNSUPPORTED_MESSAGE }]);
  });
});

// ───────────────────────────── sort start order ─────────────────────────────

describe('sortStartOrder', () => {
  const interactions: Array<[string, SortInteraction]> = [
    ['ties (ascending)', sortInteraction()],
    ['three items, one tie', buildSort({ a: 1, b: 1, c: 2 }, { kind: 'order-by-value', direction: 'ascending' })],
    ['descending', buildSort({ a: 10, b: -2, c: 7, d: 0, e: 3 }, { kind: 'order-by-value', direction: 'descending' })],
    ['explicit with group', buildSort({ a: null, b: null, c: null }, { kind: 'explicit-order', order: ['a', 'b', 'c'], interchangeable: [['a', 'b']] })],
    ['explicit exact', buildSort({ a: null, b: null, c: null, d: null }, { kind: 'explicit-order', order: ['d', 'c', 'b', 'a'], interchangeable: [] })],
  ];

  it.each(interactions)('%s: deterministic, a permutation, and never already solved (300 seeds)', (_name, i) => {
    const ids = i.items.map((x) => x.id);
    for (let seed = 0; seed < 300; seed++) {
      const start = sortStartOrder(i, seed, 'scn_sort');
      expect(sortStartOrder(i, seed, 'scn_sort')).toEqual(start);
      expect(sorted(start)).toEqual(sorted(ids));
      expect(isSequenceSolved(start, i), `seed ${seed}: ${start.join(',')}`).toBe(false);
    }
  });

  it('re-shuffles deterministically when the first shuffle would already be solved', () => {
    const i = buildSort({ a: 1, b: 1, c: 2 }, { kind: 'order-by-value', direction: 'ascending' });
    const ids = i.items.map((x) => x.id);
    let seed = 0;
    while (!isSequenceSolved(seededShuffle(ids, sceneSeed(seed, 'scn_sort')), i)) seed++;
    const firstShuffle = seededShuffle(ids, sceneSeed(seed, 'scn_sort'));
    expect(isSequenceSolved(firstShuffle, i)).toBe(true);

    const start = sortStartOrder(i, seed, 'scn_sort');
    expect(start).not.toEqual(firstShuffle);
    expect(isSequenceSolved(start, i)).toBe(false);
    expect(sortStartOrder(i, seed, 'scn_sort')).toEqual(start);
  });

  it('depends on the scene id, so scenes in one game start differently', () => {
    const i = buildSort({ a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7 }, { kind: 'order-by-value', direction: 'ascending' });
    const starts = new Set(Array.from({ length: 20 }, (_, k) => sortStartOrder(i, 7, `scn_${k}`).join(',')));
    expect(starts.size).toBeGreaterThan(10);
  });

  it('matches what checkInteraction verifies for the same seed and scene', () => {
    for (const [, i] of interactions) {
      for (let seed = 0; seed < 50; seed++) {
        expect(checkInteraction(i, { seed, sceneId: 'scn_sort' }).filter((x) => x.severity === 'error')).toEqual([]);
      }
    }
  });
});
