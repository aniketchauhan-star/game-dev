import { describe, expect, it } from 'vitest';
import {
  coordinateFeedback,
  describeCoordinateRule,
  describeMatchRule,
  describeSequenceRule,
  diagnoseCoordinate,
  evaluateCoordinate,
  evaluateMatch,
  evaluateSequence,
  findMatchAssignment,
  isSequenceSolved,
  solvedSequence,
} from '@shared/rules.ts';
import { mulberry32 } from '@shared/rng.ts';
import {
  coordinateRuleSchema,
  matchRuleSchema,
  sequenceRuleSchema,
  type CoordinateRule,
  type MatchInteraction,
  type Point,
  type SortInteraction,
} from '@shared/schemas/interaction.ts';
import { buildMatch, buildSort, matchInteraction, must, permutations, readRepoText, sortInteraction } from './helpers.ts';

const P = (x: number, y: number): Point => ({ x, y });

// ───────────────────────────── coordinate rules ─────────────────────────────

describe('evaluateCoordinate', () => {
  it('point-equals accepts only the exact target', () => {
    const rule: CoordinateRule = { kind: 'point-equals', target: P(3, -2) };
    expect(evaluateCoordinate(P(3, -2), rule)).toBe(true);
    expect(evaluateCoordinate(P(3 + 1e-12, -2 - 1e-12), rule)).toBe(true); // float noise tolerated
    expect(evaluateCoordinate(P(-2, 3), rule)).toBe(false); // swapped
    expect(evaluateCoordinate(P(3, 2), rule)).toBe(false); // sign of y
    expect(evaluateCoordinate(P(3.5, -2), rule)).toBe(false);
    expect(evaluateCoordinate(P(0, 0), rule)).toBe(false);
  });

  it('point-in-set accepts every listed target and nothing else', () => {
    const targets = [P(1, 1), P(-2, 3), P(0, -4)];
    const rule: CoordinateRule = { kind: 'point-in-set', targets };
    for (const t of targets) expect(evaluateCoordinate(t, rule)).toBe(true);
    for (const p of [P(1, -1), P(0, 0), P(3, -2), P(-4, 0)]) expect(evaluateCoordinate(p, rule)).toBe(false);
  });

  it.each([
    [P(2, 3), 1],
    [P(-2, 3), 2],
    [P(-2, -3), 3],
    [P(2, -3), 4],
    [P(0.5, 0.5), 1],
    [P(-5, -0.5), 3],
  ] as const)('in-quadrant: %o is only in quadrant %i', (point, quadrant) => {
    for (const q of [1, 2, 3, 4] as const) {
      expect(evaluateCoordinate(point, { kind: 'in-quadrant', quadrant: q })).toBe(q === quadrant);
    }
  });

  it.each([P(0, 0), P(0, 3), P(0, -3), P(4, 0), P(-4, 0), P(-0, 2), P(2, -0)])('in-quadrant: %o lies on an axis and is in no quadrant', (point) => {
    for (const q of [1, 2, 3, 4] as const) {
      expect(evaluateCoordinate(point, { kind: 'in-quadrant', quadrant: q })).toBe(false);
    }
  });

  it('on-axis: the x-axis is y = 0, the y-axis is x = 0, and the origin is on both', () => {
    const xAxis: CoordinateRule = { kind: 'on-axis', axis: 'x' };
    const yAxis: CoordinateRule = { kind: 'on-axis', axis: 'y' };
    expect(evaluateCoordinate(P(3, 0), xAxis)).toBe(true);
    expect(evaluateCoordinate(P(-5, 0), xAxis)).toBe(true);
    expect(evaluateCoordinate(P(0, 0), xAxis)).toBe(true);
    expect(evaluateCoordinate(P(0, 3), xAxis)).toBe(false);
    expect(evaluateCoordinate(P(2, 1), xAxis)).toBe(false);

    expect(evaluateCoordinate(P(0, 3), yAxis)).toBe(true);
    expect(evaluateCoordinate(P(0, -4), yAxis)).toBe(true);
    expect(evaluateCoordinate(P(0, 0), yAxis)).toBe(true);
    expect(evaluateCoordinate(P(3, 0), yAxis)).toBe(false);
    expect(evaluateCoordinate(P(-1, -1), yAxis)).toBe(false);
  });
});

describe('diagnoseCoordinate', () => {
  const target: CoordinateRule = { kind: 'point-equals', target: P(3, 2) };

  it.each([
    ['correct', P(3, 2), { dx: 0, dy: 0 }],
    ['swapped', P(2, 3), { dx: 1, dy: -1 }],
    ['x-sign', P(-3, 2), { dx: 6, dy: 0 }],
    ['y-sign', P(3, -2), { dx: 0, dy: 4 }],
    ['both-signs', P(-3, -2), { dx: 6, dy: 4 }],
    ['x-off', P(1, 2), { dx: 2, dy: 0 }],
    ['y-off', P(3, -1), { dx: 0, dy: 3 }],
    ['both-off', P(0, 0), { dx: 3, dy: 2 }],
  ] as const)('names the %s misconception for target (3, 2)', (kind, position, delta) => {
    expect(diagnoseCoordinate(position, target)).toEqual({ kind, ...delta });
  });

  it('measures point-in-set mistakes against the nearest target', () => {
    const rule: CoordinateRule = { kind: 'point-in-set', targets: [P(4, 4), P(-1, 0)] };
    expect(diagnoseCoordinate(P(0, 0), rule)).toEqual({ kind: 'x-off', dx: -1, dy: 0 });
  });

  it('distinguishes a wrong quadrant from a point on an axis', () => {
    const rule: CoordinateRule = { kind: 'in-quadrant', quadrant: 2 };
    expect(diagnoseCoordinate(P(2, 3), rule).kind).toBe('wrong-quadrant');
    expect(diagnoseCoordinate(P(0, 3), rule).kind).toBe('on-axis-not-quadrant');
    expect(diagnoseCoordinate(P(-2, 3), rule).kind).toBe('correct');
  });

  it('reports not-on-axis for on-axis rules', () => {
    expect(diagnoseCoordinate(P(1, 1), { kind: 'on-axis', axis: 'y' })).toEqual({ kind: 'not-on-axis', dx: null, dy: null });
  });
});

describe('coordinateFeedback', () => {
  const rule: CoordinateRule = { kind: 'point-equals', target: P(3, 2) };

  it('confirms a correct answer using a true minus sign', () => {
    expect(coordinateFeedback(P(3, -2), { kind: 'point-equals', target: P(3, -2) }, false)).toBe('You are at (3, −2). That is correct.');
  });

  it('only reveals directions when asked', () => {
    expect(coordinateFeedback(P(1, 2), rule, false)).toBe('You are at (1, 2). Your y is right. Count along the x-axis again.');
    expect(coordinateFeedback(P(1, 2), rule, true)).toBe('You are at (1, 2). Your y is right. Move 2 units right.');
    expect(coordinateFeedback(P(3, 3), rule, true)).toBe('You are at (3, 3). Your x is right. Move 1 unit down.');
    expect(coordinateFeedback(P(0, 0), rule, true)).toBe('You are at (0, 0). Move 3 units right and 2 units up.');
    expect(coordinateFeedback(P(0, 0), rule, false)).toBe('You are at (0, 0). Start from the origin (0, 0): move along x first, then along y.');
  });

  it('explains swapped coordinates and sign errors', () => {
    expect(coordinateFeedback(P(2, 3), rule, false)).toContain('x and y were swapped');
    expect(coordinateFeedback(P(-3, 2), rule, false)).toContain('Check the sign of x');
    expect(coordinateFeedback(P(3, -2), rule, false)).toContain('Check the sign of y');
    expect(coordinateFeedback(P(-3, -2), rule, false)).toContain('Both signs are flipped');
  });

  it('names quadrants and axes', () => {
    expect(coordinateFeedback(P(2, 3), { kind: 'in-quadrant', quadrant: 2 }, false)).toBe('You are at (2, 3). That is in Quadrant I. You need Quadrant II.');
    expect(coordinateFeedback(P(0, 3), { kind: 'in-quadrant', quadrant: 2 }, false)).toContain('Points on an axis are not in any quadrant.');
    expect(coordinateFeedback(P(2, 3), { kind: 'on-axis', axis: 'x' }, false)).toBe('You are at (2, 3). Points on the x-axis have y = 0.');
    expect(coordinateFeedback(P(2, 3), { kind: 'on-axis', axis: 'y' }, false)).toBe('You are at (2, 3). Points on the y-axis have x = 0.');
  });
});

describe('describe*Rule', () => {
  it('describes coordinate rules for learners', () => {
    expect(describeCoordinateRule({ kind: 'point-equals', target: P(3, -2) })).toBe('Reach (3, −2)');
    expect(describeCoordinateRule({ kind: 'point-in-set', targets: [P(1, 1), P(-2, 3)] })).toBe('Reach any of (1, 1), (−2, 3)');
    expect(describeCoordinateRule({ kind: 'in-quadrant', quadrant: 3 })).toBe('Finish anywhere in Quadrant III');
    expect(describeCoordinateRule({ kind: 'on-axis', axis: 'y' })).toBe('Finish on the y-axis');
  });

  it('describes sequence rules, mentioning ties and interchangeable groups', () => {
    expect(describeSequenceRule({ kind: 'order-by-value', direction: 'ascending' })).toMatch(/^Order from smallest to largest value/);
    expect(describeSequenceRule({ kind: 'order-by-value', direction: 'descending' })).toMatch(/^Order from largest to smallest value/);
    expect(describeSequenceRule({ kind: 'explicit-order', order: ['a', 'b'], interchangeable: [] })).toBe('Match the given sequence exactly');
    expect(describeSequenceRule({ kind: 'explicit-order', order: ['a', 'b', 'c'], interchangeable: [['a', 'b']] })).toBe('Match the given sequence; grouped items may swap with each other');
  });

  it('describes match rules with labels, alternatives and distractors', () => {
    const m = buildMatch({ a: ['t1', 't2'], b: ['t2'], d: [] }, { t1: 1, t2: 2 });
    expect(describeMatchRule(m)).toBe('Item a → Target t1 or Target t2; Item b → Target t2; Item d → stays unplaced');
  });
});

// ───────────────────────────── drag and match ─────────────────────────────

describe('evaluateMatch', () => {
  // a and b may go in either bay; c only in t2; d is a distractor.
  const m = buildMatch({ a: ['t1', 't2'], b: ['t1', 't2'], c: ['t2'], d: [] }, { t1: 2, t2: 2 });

  it('accepts every valid arrangement when the rule allows several', () => {
    const valid = [
      { a: 't1', b: 't1', c: 't2', d: null },
      { a: 't1', b: 't2', c: 't2', d: null },
      { a: 't2', b: 't1', c: 't2', d: null },
    ];
    for (const placements of valid) {
      const r = evaluateMatch(placements, m);
      expect(r.correct, JSON.stringify(placements)).toBe(true);
      expect(r).toMatchObject({ overCapacity: [], correctCount: 3, requiredCount: 3 });
      expect(r.items.d).toBe('distractor-ok');
    }
  });

  it('rejects an arrangement that overfills a target even if every item is in an accepted target', () => {
    const r = evaluateMatch({ a: 't2', b: 't2', c: 't2', d: null }, m);
    expect(r.items).toEqual({ a: 'correct', b: 'correct', c: 'correct', d: 'distractor-ok' });
    expect(r.overCapacity).toEqual(['t2']);
    expect(r.correct).toBe(false);
  });

  it('requires distractors to stay unplaced', () => {
    const r = evaluateMatch({ a: 't1', b: 't2', c: 't2', d: 't1' }, m);
    expect(r.items.d).toBe('distractor-placed');
    expect(r.overCapacity).toEqual([]);
    expect(r.correctCount).toBe(3);
    expect(r.correct).toBe(false);
  });

  it('reports unplaced and incorrect items', () => {
    const r = evaluateMatch({ a: 't1', b: null, c: 't1', d: null }, m);
    expect(r.items).toEqual({ a: 'correct', b: 'unplaced', c: 'incorrect', d: 'distractor-ok' });
    expect(r.correctCount).toBe(1);
    expect(r.correct).toBe(false);
  });

  it('treats items missing from the placements map as still in the tray', () => {
    const r = evaluateMatch({}, m);
    expect(r.items).toEqual({ a: 'unplaced', b: 'unplaced', c: 'unplaced', d: 'distractor-ok' });
    expect(r).toMatchObject({ correct: false, correctCount: 0, requiredCount: 3, overCapacity: [] });
  });

  it('agrees with an independent oracle on every possible arrangement', () => {
    const slots = [null, 't1', 't2'] as const;
    let checked = 0;
    for (const a of slots) for (const b of slots) for (const c of slots) for (const d of slots) {
      const placements = { a, b, c, d };
      const load = (t: string) => Object.values(placements).filter((x) => x === t).length;
      const oracle =
        (a === 't1' || a === 't2') && (b === 't1' || b === 't2') && c === 't2' && d === null && load('t1') <= 2 && load('t2') <= 2;
      expect(evaluateMatch(placements, m).correct, JSON.stringify(placements)).toBe(oracle);
      checked++;
    }
    expect(checked).toBe(81);
  });
});

/** Is `assignment` a complete, capacity-respecting solution of `m`? */
function isValidAssignment(m: MatchInteraction, assignment: Record<string, string>): boolean {
  const placements: Record<string, string | null> = Object.fromEntries(m.items.map((i) => [i.id, assignment[i.id] ?? null]));
  return evaluateMatch(placements, m).correct;
}

/** Brute force: does any assignment satisfy every required item within capacities? */
function bruteForceSolvable(m: MatchInteraction): boolean {
  const required = m.rule.accepts.filter((a) => a.targetIds.length > 0);
  const capacity = new Map(m.targets.map((t) => [t.id, t.capacity]));
  const load = new Map<string, number>();
  const go = (k: number): boolean => {
    if (k === required.length) return true;
    for (const t of must(required[k]).targetIds) {
      const cap = capacity.get(t);
      if (cap === undefined || (load.get(t) ?? 0) >= cap) continue;
      load.set(t, (load.get(t) ?? 0) + 1);
      if (go(k + 1)) return true;
      load.set(t, (load.get(t) ?? 0) - 1);
    }
    return false;
  };
  return go(0);
}

describe('findMatchAssignment', () => {
  it('finds an arrangement that needs items to be moved along an augmenting path', () => {
    // Greedy a→t1, b→t2 blocks c; the solver must shift b to t3 and a to t2.
    const m = buildMatch({ a: ['t1', 't2'], b: ['t2', 't3'], c: ['t1'] }, { t1: 1, t2: 1, t3: 1 });
    const assignment = must(findMatchAssignment(m), 'assignment');
    expect(assignment).toEqual({ a: 't2', b: 't3', c: 't1' });
    expect(isValidAssignment(m, assignment)).toBe(true);
  });

  it('uses spare capacity on a shared target', () => {
    const m = buildMatch({ a: ['t1'], b: ['t1', 't2'], c: ['t1'] }, { t1: 2, t2: 1 });
    const assignment = must(findMatchAssignment(m), 'assignment');
    expect(isValidAssignment(m, assignment)).toBe(true);
    expect(assignment.b).toBe('t2');
  });

  it('leaves distractors out of the assignment', () => {
    const m = buildMatch({ a: ['t1'], d: [], e: [] }, { t1: 1 });
    expect(findMatchAssignment(m)).toEqual({ a: 't1' });
  });

  it('returns null when a target is too small for the items that need it', () => {
    expect(findMatchAssignment(buildMatch({ a: ['t1'], b: ['t1'], c: ['t1'] }, { t1: 2 }))).toBeNull();
    expect(findMatchAssignment(buildMatch({ a: ['t1'], b: ['t1'], c: ['t1'] }, { t1: 3 }))).not.toBeNull();
  });

  it('returns null when total capacity suffices but the distribution does not', () => {
    expect(findMatchAssignment(buildMatch({ a: ['t1'], b: ['t1'], c: ['t2'] }, { t1: 1, t2: 5 }))).toBeNull();
  });

  it('never assigns an item to a target that does not exist', () => {
    expect(findMatchAssignment(buildMatch({ a: ['ghost'] }, { t1: 3 }))).toBeNull();
  });

  it('agrees with brute force on 400 random small instances', () => {
    const rand = mulberry32(20261003);
    const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
    let solvable = 0;
    for (let n = 0; n < 400; n++) {
      const targetIds = Array.from({ length: int(1, 4) }, (_, i) => `t${i}`);
      const capacities = Object.fromEntries(targetIds.map((t) => [t, int(1, 3)]));
      const accepts: Record<string, string[]> = {};
      const itemCount = int(2, 7);
      for (let i = 0; i < itemCount; i++) accepts[`i${i}`] = targetIds.filter(() => rand() < 0.45);
      const m = buildMatch(accepts, capacities);
      const expected = bruteForceSolvable(m);
      const found = findMatchAssignment(m);
      expect(found !== null, JSON.stringify({ accepts, capacities })).toBe(expected);
      if (found) {
        expect(isValidAssignment(m, found), JSON.stringify({ accepts, capacities, found })).toBe(true);
        solvable++;
      }
    }
    // Make sure the generator exercised both outcomes.
    expect(solvable).toBeGreaterThan(50);
    expect(solvable).toBeLessThan(400);
  });
});

// ───────────────────────────── sequence sorting ─────────────────────────────

const solvedOrders = (i: SortInteraction): string[][] => permutations(i.items.map((x) => x.id)).filter((p) => isSequenceSolved(p, i));

describe('evaluateSequence: order-by-value', () => {
  it('accepts tied values in either order (ascending)', () => {
    const s = buildSort({ a: 3, b: 1, c: 1, d: 2 }, { kind: 'order-by-value', direction: 'ascending' });
    expect(solvedOrders(s)).toEqual([
      ['b', 'c', 'd', 'a'],
      ['c', 'b', 'd', 'a'],
    ]);
    const wrong = evaluateSequence(['b', 'd', 'c', 'a'], s);
    expect(wrong).toEqual({ correct: false, positions: [true, false, false, true], correctCount: 2 });
  });

  it('accepts duplicate values in either order (descending, with negatives and zero)', () => {
    const s = buildSort({ a: 5, b: 5, c: -1, d: 0 }, { kind: 'order-by-value', direction: 'descending' });
    expect(solvedOrders(s)).toEqual([
      ['a', 'b', 'd', 'c'],
      ['b', 'a', 'd', 'c'],
    ]);
    expect(evaluateSequence(['a', 'd', 'b', 'c'], s).correct).toBe(false);
  });

  it('handles fractional values', () => {
    const s = buildSort({ a: 0.5, b: -0.25, c: 2.75 }, { kind: 'order-by-value', direction: 'ascending' });
    expect(solvedOrders(s)).toEqual([['b', 'a', 'c']]);
  });

  it('is never correct for incomplete orders, repeated ids or unknown ids', () => {
    const s = buildSort({ a: 1, b: 1, c: 2 }, { kind: 'order-by-value', direction: 'ascending' });
    const partial = evaluateSequence(['a', 'b'], s);
    expect(partial.positions).toEqual([true, true]);
    expect(partial.correct).toBe(false);
    const repeated = evaluateSequence(['a', 'a', 'c'], s);
    expect(repeated.positions).toEqual([true, true, true]);
    expect(repeated.correct).toBe(false);
    const unknown = evaluateSequence(['a', 'b', 'zz'], s);
    expect(unknown.positions).toEqual([true, true, false]);
    expect(unknown.correct).toBe(false);
  });

  it('never places an item without a value correctly, so such a puzzle cannot be solved', () => {
    const s = buildSort({ a: null, b: 1, c: 2 }, { kind: 'order-by-value', direction: 'ascending' });
    expect(solvedOrders(s)).toEqual([]);
    for (const order of permutations(['a', 'b', 'c'])) {
      expect(evaluateSequence(order, s).positions[order.indexOf('a')]).toBe(false);
    }
  });

  it('solvedSequence returns a solved order for either direction', () => {
    for (const direction of ['ascending', 'descending'] as const) {
      const s = buildSort({ a: 3, b: 1, c: 1, d: 2, e: -7 }, { kind: 'order-by-value', direction });
      expect(isSequenceSolved(solvedSequence(s), s)).toBe(true);
    }
    expect(solvedSequence(sortInteraction())).toEqual(['nx7', 'qf2', 'ba9', 'ai4']);
  });
});

describe('evaluateSequence: explicit-order', () => {
  const ids = ['a', 'b', 'c', 'd', 'e'];
  const explicit = (interchangeable: string[][]): SortInteraction =>
    buildSort(Object.fromEntries(ids.map((id) => [id, null])), { kind: 'explicit-order', order: ids, interchangeable });

  it('without groups, only the exact order is correct', () => {
    expect(solvedOrders(explicit([]))).toEqual([ids]);
  });

  it('interchangeable groups may swap among themselves but nowhere else', () => {
    const s = explicit([
      ['b', 'c'],
      ['d', 'e'],
    ]);
    const solved = solvedOrders(s).map((o) => o.join(''));
    expect(solved.sort()).toEqual(['abcde', 'abced', 'acbde', 'acbed']);
    const r = evaluateSequence(['b', 'a', 'c', 'd', 'e'], s);
    expect(r.positions).toEqual([false, false, true, true, true]);
    expect(r.correctCount).toBe(3);
  });

  it('interchangeable items need not be adjacent', () => {
    const s = explicit([['a', 'e']]);
    expect(solvedOrders(s).map((o) => o.join('')).sort()).toEqual(['abcde', 'ebcda']);
  });

  it('solvedSequence returns the configured order', () => {
    expect(solvedSequence(explicit([['b', 'c']]))).toEqual(ids);
  });
});

// ───────────────────────────── data-driven only ─────────────────────────────

describe('rule evaluation is data-driven only', () => {
  it('rule schemas only accept allowlisted kinds', () => {
    expect(coordinateRuleSchema.safeParse({ kind: 'expression', expr: 'x > 0 && y > 0' }).success).toBe(false);
    expect(coordinateRuleSchema.safeParse({ kind: 'point-equals', target: { x: 'process.exit(1)', y: 0 } }).success).toBe(false);
    expect(sequenceRuleSchema.safeParse({ kind: 'formula', compare: '(a, b) => a - b' }).success).toBe(false);
    expect(matchRuleSchema.safeParse({ kind: 'script', source: 'return true' }).success).toBe(false);
    expect(coordinateRuleSchema.safeParse({ kind: 'in-quadrant', quadrant: 5 }).success).toBe(false);
  });

  it('extra code-like fields are stripped from parsed rules', () => {
    const parsed = coordinateRuleSchema.parse({ kind: 'point-equals', target: { x: 1, y: 1 }, evaluate: 'globalThis.__nexusPwned = true' });
    expect(parsed).toEqual({ kind: 'point-equals', target: { x: 1, y: 1 } });
  });

  it('code-like labels and ids are inert data', () => {
    const g = globalThis as Record<string, unknown>;
    const payload = '${globalThis.__nexusPwned = true}';
    const m = matchInteraction({
      items: [
        { id: 'p1', label: `\`${payload}\``, imageAssetId: null },
        { id: 'p2', label: "'); globalThis.__nexusPwned = true; ('", imageAssetId: null },
      ],
      targets: [{ id: 'q1', label: payload, imageAssetId: null, capacity: 2 }],
      rule: { kind: 'match-sets', accepts: [{ itemId: 'p1', targetIds: ['q1'] }, { itemId: 'p2', targetIds: [] }] },
    });
    expect(evaluateMatch({ p1: 'q1', p2: null }, m).correct).toBe(true);
    expect(describeMatchRule(m)).toContain(payload);
    const s = sortInteraction({ items: sortInteraction().items.map((i) => ({ ...i, label: payload })) });
    expect(isSequenceSolved(solvedSequence(s), s)).toBe(true);
    expect(g.__nexusPwned).toBeUndefined();
  });

  it('unknown rule kinds that bypass the schema are never treated as correct', () => {
    const forged = { kind: 'expression', expr: 'true' } as unknown as CoordinateRule;
    expect(evaluateCoordinate(P(0, 0), forged)).toBeFalsy();
  });

  // `constructor` is a valid local id (lowercase letters only), and a key missing from
  // `placements` means "still in the tray" — it must not be looked up on Object.prototype.
  it('an item id that collides with Object.prototype (constructor) is unplaced when absent from placements', () => {
    const m = buildMatch({ constructor: ['t1'], a: ['t1'] }, { t1: 2 });
    const r = evaluateMatch({ a: 't1' }, m);
    expect(r.items['constructor']).toBe('unplaced');
    expect(r.correct).toBe(false);
  });

  it('a distractor with id constructor that is absent from placements counts as left in the tray', () => {
    const m = buildMatch({ a: ['t1'], constructor: [] }, { t1: 1 });
    const r = evaluateMatch({ a: 't1' }, m);
    expect(r.items['constructor']).toBe('distractor-ok');
    expect(r.correct).toBe(true);
  });

  it.each(['shared/src/rules.ts', 'shared/src/attainability.ts', 'shared/src/coords.ts'])('%s contains no dynamic code execution', (file) => {
    const source = readRepoText(file);
    for (const pattern of [/\beval\s*\(/, /\bnew\s+Function\b/, /\bFunction\s*\(/, /\bimport\s*\(/, /\brequire\s*\(/, /\bsetTimeout\s*\(\s*['"`]/]) {
      expect(source, `${file} matches ${pattern}`).not.toMatch(pattern);
    }
  });
});
