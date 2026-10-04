import { describe, expect, it } from 'vitest';
import { checkInteraction } from '@shared/attainability.ts';
import type { SceneLocks } from '@shared/schemas/blueprint.ts';
import { gameConfigSchema, type GameConfig, type GameScene } from '@shared/schemas/game.ts';
import {
  applyChangeOps,
  changeOpSchema,
  PROJECT_FIELD_META,
  PROJECT_FIELDS,
  SCENE_FIELD_META,
  SCENE_FIELDS,
  summarizeValue,
  type ApplyOptions,
  type ChangeOp,
  type OpResult,
  type ProjectField,
  type SceneField,
} from '@shared/schemas/proposal.ts';
import { deepFreeze, makeGameConfig, must } from './helpers.ts';

const PROJECT: ApplyOptions = { scope: { kind: 'project', sceneId: null } };
const ALLOW_LOCKED: ApplyOptions = { ...PROJECT, allowLockedChanges: true };
const inScene = (sceneId: string): ApplyOptions => ({ scope: { kind: 'scene', sceneId } });

const setScene = (sceneId: string, field: SceneField, value: unknown): ChangeOp => ({ op: 'set-scene-field', sceneId, field, value });
const setProject = (field: ProjectField, value: unknown): ChangeOp => ({ op: 'set-project-field', field, value });
const move = (sceneId: string, toIndex: number): ChangeOp => ({ op: 'move-scene', sceneId, toIndex });

const sceneOf = (cfg: GameConfig, id: string): GameScene => must(cfg.scenes.find((s) => s.id === id), `scene ${id}`);
const getField = (obj: unknown, field: string): unknown => field.split('.').reduce<unknown>((cur, key) => (cur as Record<string, unknown>)[key], obj);
const statuses = (results: OpResult[]) => results.map((r) => r.status);

/** Apply a single op and expose its result directly. */
function one(base: GameConfig, op: ChangeOp, opts: ApplyOptions = PROJECT) {
  const r = applyChangeOps(base, [op], opts);
  expect(r.results).toHaveLength(1);
  return { ...r, result: must(r.results[0], 'result') };
}

describe('fixture', () => {
  it('is a valid, playable GameConfig', () => {
    const cfg = makeGameConfig();
    expect(gameConfigSchema.safeParse(cfg).success).toBe(true);
    for (const s of cfg.scenes) {
      expect(checkInteraction(s.interaction, { seed: cfg.settings.seed, sceneId: s.id }).filter((i) => i.severity === 'error')).toEqual([]);
    }
  });
});

// ───────────────────────────── applying ─────────────────────────────

describe('applyChangeOps: applying valid changes', () => {
  it('applies a scene field change and reports before, after and where', () => {
    const base = makeGameConfig();
    const r = applyChangeOps(base, [setScene('scn_taxi', 'instruction', 'Guide NX7 to Runway Alpha.')], PROJECT);
    expect(r.ok).toBe(true);
    expect(r.changed).toBe(true);
    expect(r.validationErrors).toEqual([]);
    expect(r.results).toEqual([
      {
        index: 0,
        status: 'applied',
        target: 'scn_taxi · instruction',
        where: 'Scene 2 · Taxi to Runway Alpha',
        label: 'Instruction',
        before: 'Instruction for Taxi to Runway Alpha.',
        after: 'Guide NX7 to Runway Alpha.',
        impact: 'wording',
        message: null,
        sourceSlideIds: ['sld_slide0002', 'sld_slide0003'],
      },
    ]);
    expect(sceneOf(r.config, 'scn_taxi').instruction).toBe('Guide NX7 to Runway Alpha.');
    expect(gameConfigSchema.safeParse(r.config).success).toBe(true);
  });

  it('replaces nested interaction objects as a whole', () => {
    const base = makeGameConfig();
    const display = { gridEmphasis: 'high', pointSize: 'large', labelSize: 'large' };
    const { result, config } = one(base, setScene('scn_taxi', 'interaction.display', display));
    expect(result.status).toBe('applied');
    expect(result.before).toEqual({ gridEmphasis: 'standard', pointSize: 'standard', labelSize: 'standard' });
    expect(getField(sceneOf(config, 'scn_taxi'), 'interaction.display')).toEqual(display);
  });

  it('applies project field changes', () => {
    const base = makeGameConfig();
    const r = applyChangeOps(
      base,
      [
        setProject('theme.decor', 'city'),
        setProject('theme.fontStyle', 'clean'),
        setProject('settings.reducedMotion', true),
        setProject('settings.audio.sfx', false),
        setProject('screens.completion.message', 'Every flight landed safely.'),
        setProject('title', 'Runway Rescue'),
      ],
      PROJECT,
    );
    expect(statuses(r.results)).toEqual(['applied', 'applied', 'applied', 'applied', 'applied', 'applied']);
    for (const res of r.results) {
      expect(res.where).toBe('Whole game');
      expect(res.sourceSlideIds).toEqual([]);
      expect(res.target).toMatch(/^project · /);
    }
    expect(r.results[0]).toMatchObject({ label: 'Background scenery', before: 'airport', after: 'city', impact: 'none', message: null });
    expect(r.config.theme.decor).toBe('city');
    expect(r.config.theme.fontStyle).toBe('clean');
    expect(r.config.settings.reducedMotion).toBe(true);
    expect(r.config.settings.audio.sfx).toBe(false);
    expect(r.config.screens.completion.message).toBe('Every flight landed safely.');
    expect(r.config.title).toBe('Runway Rescue');
    expect(r.ok).toBe(true);
  });

  it('asks for a check against the deck when an answer derived from source slides changes', () => {
    const base = makeGameConfig();
    const sourced = one(base, setScene('scn_taxi', 'interaction.rule', { kind: 'point-equals', target: { x: -2, y: 1 } }));
    expect(sourced.result).toMatchObject({
      status: 'applied',
      impact: 'answers',
      message: 'Changes an answer or content derived from the source slides — check it against the deck.',
      sourceSlideIds: ['sld_slide0002', 'sld_slide0003'],
    });
    // Added practice has no source slides, so there is nothing to check against.
    const practice = one(base, setScene('scn_lineup', 'interaction.rule', { kind: 'order-by-value', direction: 'descending' }));
    expect(practice.result).toMatchObject({ status: 'applied', impact: 'answers', message: null, sourceSlideIds: [] });
  });

  it('applies ops in order, so later ops see earlier results', () => {
    const base = makeGameConfig();
    const r = applyChangeOps(base, [setScene('scn_quad', 'title', 'Quadrant check'), setScene('scn_quad', 'title', 'Quadrant quiz')], PROJECT);
    expect(statuses(r.results)).toEqual(['applied', 'applied']);
    expect(r.results[1]).toMatchObject({ index: 1, before: 'Quadrant check', after: 'Quadrant quiz', where: 'Scene 3 · Quadrant check' });
    expect(sceneOf(r.config, 'scn_quad').title).toBe('Quadrant quiz');
  });

  it('keeps applying later ops after one is refused', () => {
    const base = makeGameConfig();
    const r = applyChangeOps(base, [setScene('scn_taxi', 'instruction', ''), setScene('scn_taxi', 'layout.density', 'compact')], PROJECT);
    expect(statuses(r.results)).toEqual(['invalid', 'applied']);
    expect(r.results.map((x) => x.index)).toEqual([0, 1]);
    expect(sceneOf(r.config, 'scn_taxi').instruction).toBe(sceneOf(base, 'scn_taxi').instruction);
    expect(sceneOf(r.config, 'scn_taxi').layout.density).toBe('compact');
    expect(r.ok).toBe(true);
  });
});

// ───────────────────────────── scope ─────────────────────────────

describe('applyChangeOps: scope', () => {
  it('refuses a change to another scene while one scene is selected, still showing the current value', () => {
    const base = makeGameConfig();
    const r = one(base, setScene('scn_taxi', 'instruction', 'Fly!'), inScene('scn_quad'));
    expect(r.result).toMatchObject({
      status: 'out-of-scope',
      before: 'Instruction for Taxi to Runway Alpha.',
      after: 'Fly!',
      where: 'Scene 2 · Taxi to Runway Alpha',
    });
    expect(r.result.message).toContain('outside the selected scene');
    expect(r.ok).toBe(false);
    expect(r.changed).toBe(false);
    expect(r.config).toEqual(base);
  });

  it('refuses project-wide fields while a scene is selected, still showing the current value', () => {
    const base = makeGameConfig();
    const r = one(base, setProject('theme.decor', 'city'), inScene('scn_quad'));
    expect(r.result).toMatchObject({ status: 'out-of-scope', before: 'airport', after: 'city', where: 'Whole game' });
    expect(r.config.theme.decor).toBe('airport');
  });

  it('refuses reordering while a scene is selected', () => {
    const base = makeGameConfig();
    const r = one(base, move('scn_quad', 0), inScene('scn_quad'));
    expect(r.result).toMatchObject({ status: 'out-of-scope', before: 3, after: 1, where: 'Scene 3 · Which quadrant?' });
    expect(r.config.scenes.map((s) => s.id)).toEqual(base.scenes.map((s) => s.id));
  });

  it('applies changes to the selected scene and only those', () => {
    const base = makeGameConfig();
    const r = applyChangeOps(
      base,
      [setScene('scn_quad', 'layout.density', 'compact'), setScene('scn_lineup', 'layout.density', 'compact'), setProject('title', 'Other')],
      inScene('scn_quad'),
    );
    expect(statuses(r.results)).toEqual(['applied', 'out-of-scope', 'out-of-scope']);
    expect(sceneOf(r.config, 'scn_quad').layout.density).toBe('compact');
    expect(sceneOf(r.config, 'scn_lineup').layout.density).toBe('comfortable');
    expect(r.config.title).toBe(base.title);
    expect(r.ok).toBe(true);
  });
});

// ───────────────────────────── locks ─────────────────────────────

const LOCK_CASES: Array<[SceneField, keyof SceneLocks, unknown]> = [
  ['title', 'wording', 'Taxi time'],
  ['instruction', 'wording', 'Fly to (3, 2).'],
  ['supportText', 'wording', null],
  ['feedback.success', 'wording', 'Landed!'],
  ['feedback.hints', 'wording', ['Count right first.']],
  ['interaction.moverLabel', 'wording', 'QF2'],
  ['interaction.rule', 'answer', { kind: 'point-equals', target: { x: -2, y: 1 } }],
  ['interaction.start', 'answer', { x: 1, y: 1 }],
  ['interaction.grid', 'answer', { xMin: -6, xMax: 6, yMin: -4, yMax: 4, step: 1 }],
  ['interaction.landmarks', 'answer', []],
  ['interaction.showTargetMarker', 'answer', false],
  ['layout.density', 'layout', 'compact'],
  ['layout.instructionPosition', 'layout', 'left'],
  ['layout.showProgress', 'layout', false],
  ['assets.character', 'assets', 'ast_plane002'],
  ['assets.background', 'assets', null],
];

describe('applyChangeOps: locks', () => {
  it.each(LOCK_CASES)('%s is blocked by the scene %s lock unless locked changes are allowed', (field, lock, value) => {
    const base = makeGameConfig();
    sceneOf(base, 'scn_taxi').locks[lock] = true;
    const current = getField(sceneOf(base, 'scn_taxi'), field);

    const refused = one(base, setScene('scn_taxi', field, value));
    expect(refused.result.status).toBe('conflict');
    expect(refused.result.message).toContain(`${lock} lock`);
    expect(refused.result.before).toEqual(current);
    expect(refused.ok).toBe(false);
    expect(refused.config).toEqual(base);

    const allowed = one(base, setScene('scn_taxi', field, value), ALLOW_LOCKED);
    expect(allowed.result.status).toBe('applied');
    expect(getField(sceneOf(allowed.config, 'scn_taxi'), field)).toEqual(value);
  });

  it('a lock only guards its own fields', () => {
    const base = makeGameConfig();
    sceneOf(base, 'scn_taxi').locks.wording = true;
    const r = applyChangeOps(base, [setScene('scn_taxi', 'layout.density', 'compact'), setScene('scn_taxi', 'interaction.start', { x: 1, y: 1 })], PROJECT);
    expect(statuses(r.results)).toEqual(['applied', 'applied']);

    const answerLocked = makeGameConfig();
    sceneOf(answerLocked, 'scn_taxi').locks.answer = true;
    expect(one(answerLocked, setScene('scn_taxi', 'instruction', 'New words.')).result.status).toBe('applied');
    // Locks belong to one scene.
    expect(one(answerLocked, setScene('scn_quad', 'interaction.rule', { kind: 'match-sets', accepts: [{ itemId: 'p1', targetIds: ['q1'] }, { itemId: 'p2', targetIds: ['q2'] }, { itemId: 'p3', targetIds: ['q3'] }, { itemId: 'p4', targetIds: [] }] })).result.status).toBe('applied');
  });

  it('fields without a lock are never blocked by scene locks', () => {
    const base = makeGameConfig();
    for (const s of base.scenes) s.locks = { sequence: true, wording: true, answer: true, layout: true, assets: true };
    const r = applyChangeOps(
      base,
      [
        setScene('scn_taxi', 'interaction.display', { gridEmphasis: 'high', pointSize: 'large', labelSize: 'large' }),
        setScene('scn_taxi', 'interaction.showCoordinateReadout', false),
        setScene('scn_lineup', 'interaction.showValues', true),
        setScene('scn_intro', 'interaction.illustration', 'quadrants'),
      ],
      PROJECT,
    );
    expect(statuses(r.results)).toEqual(['applied', 'applied', 'applied', 'applied']);
  });

  it('the project asset-identity lock blocks scene asset changes', () => {
    const base = makeGameConfig();
    base.settings.locks.assetIdentity = true;
    const refused = one(base, setScene('scn_taxi', 'assets.character', 'ast_plane002'));
    expect(refused.result.status).toBe('conflict');
    expect(refused.result.message).toContain('asset identity');
    expect(refused.result.before).toBe('ast_plane001');
    expect(one(base, setScene('scn_taxi', 'assets.character', 'ast_plane002'), ALLOW_LOCKED).result.status).toBe('applied');
    // Other scene fields are unaffected by the asset-identity lock.
    expect(one(base, setScene('scn_taxi', 'title', 'Taxi time')).result.status).toBe('applied');
  });

  it('the project asset-identity lock blocks project asset fields', () => {
    const base = makeGameConfig();
    base.settings.locks.assetIdentity = true;
    const r = applyChangeOps(
      base,
      [setProject('theme.backgroundAssetId', null), setProject('screens.title.characterAssetId', 'ast_plane002'), setProject('theme.decor', 'space')],
      PROJECT,
    );
    expect(statuses(r.results)).toEqual(['conflict', 'conflict', 'applied']);
    expect(r.results[0]?.message).toBe('Locked: asset identity is locked for this project.');
    expect(r.config.theme.backgroundAssetId).toBe('ast_bg000001');
    expect(r.config.screens.title.characterAssetId).toBe('ast_plane001');

    const allowed = applyChangeOps(base, [setProject('theme.backgroundAssetId', null), setProject('screens.title.characterAssetId', 'ast_plane002')], ALLOW_LOCKED);
    expect(statuses(allowed.results)).toEqual(['applied', 'applied']);
    expect(allowed.config.theme.backgroundAssetId).toBeNull();
  });

  it('a scene sequence lock blocks moves that shift the locked scene', () => {
    const base = makeGameConfig();
    sceneOf(base, 'scn_quad').locks.sequence = true;
    const refused = one(base, move('scn_lineup', 1));
    expect(refused.result.status).toBe('conflict');
    expect(refused.result.message).toBe('Locked: the learning sequence is locked to the source order.');
    expect(refused.config.scenes.map((s) => s.id)).toEqual(['scn_intro', 'scn_taxi', 'scn_quad', 'scn_lineup']);
    // Moves that do not pass the locked scene are fine.
    expect(one(base, move('scn_taxi', 0)).result.status).toBe('applied');
    expect(one(base, move('scn_lineup', 1), ALLOW_LOCKED).result.status).toBe('applied');
  });

  it('the project sequence lock blocks every move', () => {
    const base = makeGameConfig();
    base.settings.locks.sequence = true;
    expect(one(base, move('scn_taxi', 0)).result.status).toBe('conflict');
    expect(one(base, move('scn_taxi', 0), ALLOW_LOCKED).result.status).toBe('applied');
  });
});

// ───────────────────────────── validation ─────────────────────────────

const INVALID_SCENE_VALUES: Array<[string, string, SceneField, unknown]> = [
  ['an empty instruction', 'scn_taxi', 'instruction', ''],
  ['a whitespace-only title', 'scn_taxi', 'title', '   '],
  ['an instruction over 220 characters', 'scn_taxi', 'instruction', 'x'.repeat(221)],
  ['an unknown layout density', 'scn_taxi', 'layout.density', 'cramped'],
  ['an empty hint list', 'scn_taxi', 'feedback.hints', []],
  ['four hints', 'scn_taxi', 'feedback.hints', ['a', 'b', 'c', 'd']],
  ['an unknown background asset', 'scn_taxi', 'assets.background', 'ast_missing'],
  ['a grid that excludes the origin', 'scn_taxi', 'interaction.grid', { xMin: 1, xMax: 5, yMin: -4, yMax: 4, step: 1 }],
  ['a grid step of 3', 'scn_taxi', 'interaction.grid', { xMin: -6, xMax: 6, yMin: -6, yMax: 6, step: 3 }],
  ['an unknown grid emphasis', 'scn_taxi', 'interaction.display', { gridEmphasis: 'extreme', pointSize: 'large', labelSize: 'large' }],
  ['a rule kind outside the allowlist', 'scn_taxi', 'interaction.rule', { kind: 'expression', expr: 'x > 0' }],
  ['a sort with one item', 'scn_lineup', 'interaction.items', [{ id: 'a', label: 'A', value: 1, imageAssetId: null }]],
  ['a string where a boolean belongs', 'scn_lineup', 'interaction.showValues', 'yes'],
];

describe('applyChangeOps: rejecting invalid values', () => {
  it.each(INVALID_SCENE_VALUES)('rejects %s', (_name, sceneId, field, value) => {
    const base = makeGameConfig();
    const r = one(base, setScene(sceneId, field, value));
    expect(r.result.status).toBe('invalid');
    expect(r.result.message).toMatch(/^Invalid value: /);
    expect(r.result.before).toEqual(getField(sceneOf(base, sceneId), field));
    expect(r.ok).toBe(false);
    expect(r.changed).toBe(false);
    expect(r.config).toEqual(base);
  });

  const palette = makeGameConfig().theme.palette;
  const { focus: _dropped, ...paletteWithoutFocus } = palette;
  const INVALID_PROJECT_VALUES: Array<[string, ProjectField, unknown]> = [
    ['an empty title', 'title', ''],
    ['a title over 80 characters', 'title', 't'.repeat(81)],
    ['a palette color that is not hex', 'theme.palette', { ...palette, text: 'black' }],
    ['a palette missing a color', 'theme.palette', paletteWithoutFocus],
    ['an unknown decor', 'theme.decor', 'jungle'],
    ['an unknown font style', 'theme.fontStyle', 'comic'],
    ['a non-boolean reduced-motion flag', 'settings.reducedMotion', 'yes'],
    ['an unknown title character asset', 'screens.title.characterAssetId', 'ast_missing'],
    ['an unknown background asset', 'theme.backgroundAssetId', 'ast_missing'],
    ['an empty completion heading', 'screens.completion.heading', ''],
  ];

  it.each(INVALID_PROJECT_VALUES)('rejects %s', (_name, field, value) => {
    const base = makeGameConfig();
    const r = one(base, setProject(field, value));
    expect(r.result.status).toBe('invalid');
    expect(r.result.message).toMatch(/^Invalid value: /);
    expect(r.result.before).toEqual(getField(base, field));
    expect(r.ok).toBe(false);
    expect(r.config).toEqual(base);
  });

  const UNPLAYABLE: Array<[string, string, SceneField, unknown, string]> = [
    ['a target outside the grid', 'scn_taxi', 'interaction.rule', { kind: 'point-equals', target: { x: 9, y: 9 } }, 'Target (9, 9) is outside the grid, so it cannot be reached.'],
    ['a start between intersections', 'scn_taxi', 'interaction.start', { x: 0.5, y: 0 }, 'Start position must sit on a grid intersection (multiples of 1).'],
    ['a grid that no longer contains the target', 'scn_taxi', 'interaction.grid', { xMin: -2, xMax: 2, yMin: -4, yMax: 4, step: 1 }, 'Target (3, 2) is outside the grid, so it cannot be reached.'],
    [
      'answers that overfill a bay',
      'scn_quad',
      'interaction.rule',
      { kind: 'match-sets', accepts: [{ itemId: 'p1', targetIds: ['q1'] }, { itemId: 'p2', targetIds: ['q1'] }, { itemId: 'p3', targetIds: ['q1'] }, { itemId: 'p4', targetIds: ['axis'] }] },
      'No arrangement satisfies every item within the target capacities. Increase a capacity or allow another target.',
    ],
    [
      'removing a bay the answers need',
      'scn_quad',
      'interaction.targets',
      [
        { id: 'q2', label: 'Quadrant II', imageAssetId: null, capacity: 2 },
        { id: 'q3', label: 'Quadrant III', imageAssetId: null, capacity: 2 },
        { id: 'axis', label: 'On an axis', imageAssetId: null, capacity: 2 },
      ],
      'Rule mentions unknown target "q1".',
    ],
    [
      'sort values that are all equal',
      'scn_lineup',
      'interaction.items',
      [
        { id: 'a', label: 'A', value: 2, imageAssetId: null },
        { id: 'b', label: 'B', value: 2, imageAssetId: null },
        { id: 'c', label: 'C', value: 2, imageAssetId: null },
      ],
      'Sorting needs at least two different values.',
    ],
  ];

  it.each(UNPLAYABLE)('rejects %s as unplayable', (_name, sceneId, field, value, reason) => {
    const base = makeGameConfig();
    const r = one(base, setScene(sceneId, field, value));
    expect(r.result.status).toBe('invalid');
    expect(r.result.message).toBe(`Would make the scene unplayable: ${reason}`);
    expect(r.config).toEqual(base);
  });

  it('allows a change that only triggers an attainability warning', () => {
    const base = makeGameConfig();
    // Starting on the target is a warning (solved before the learner acts), not an error.
    expect(one(base, setScene('scn_taxi', 'interaction.start', { x: 3, y: 2 })).result.status).toBe('applied');
  });

  it('reports fields that do not apply to the scene type, without a before value', () => {
    const base = makeGameConfig();
    const info = one(base, setScene('scn_intro', 'interaction.grid', { xMin: -5, xMax: 5, yMin: -5, yMax: 5, step: 1 }));
    expect(info.result).toMatchObject({ status: 'invalid', before: null, message: 'Grid range does not apply to a info scene.', where: 'Scene 1 · Meet the grid' });
    const coordinate = one(base, setScene('scn_taxi', 'interaction.items', []));
    expect(coordinate.result).toMatchObject({ status: 'invalid', before: null });
  });

  it('reports unknown scenes', () => {
    const base = makeGameConfig();
    const r = applyChangeOps(base, [setScene('scn_nope', 'title', 'Ghost'), move('scn_nope', 0)], PROJECT);
    expect(r.results[0]).toMatchObject({ status: 'invalid', where: 'Unknown scene', message: 'Scene scn_nope does not exist in this version.', sourceSlideIds: [] });
    expect(r.results[1]).toMatchObject({ status: 'invalid', where: 'Unknown scene', message: 'Scene scn_nope does not exist.' });
    expect(r.ok).toBe(false);
  });

  it('rejects a move outside the scene list', () => {
    const r = one(makeGameConfig(), move('scn_intro', 4));
    expect(r.result).toMatchObject({ status: 'invalid', message: 'Target position is outside the scene list.' });
  });

  it('reports the validation errors of an invalid base and returns it unchanged', () => {
    const base = makeGameConfig();
    must(base.scenes[0]).next = 'scn_ghost';
    const r = one(base, setScene('scn_quad', 'title', 'Quadrant quiz'));
    expect(r.result.status).toBe('invalid');
    expect(r.validationErrors).toContain('scenes.0.next: Unknown next scene scn_ghost');
    expect(r.ok).toBe(false);
    expect(r.config).toEqual(base);
  });
});

// ───────────────────────────── unchanged ─────────────────────────────

describe('applyChangeOps: unchanged values', () => {
  it('reports a primitive that is already set', () => {
    const r = one(makeGameConfig(), setScene('scn_taxi', 'layout.density', 'comfortable'));
    expect(r.result).toMatchObject({ status: 'unchanged', message: 'Already set to this value.', before: 'comfortable' });
    expect(r.ok).toBe(false);
    expect(r.changed).toBe(false);
  });

  it('reports objects and arrays with identical content', () => {
    const base = makeGameConfig();
    const taxi = sceneOf(base, 'scn_taxi');
    const r = applyChangeOps(
      base,
      [
        setScene('scn_taxi', 'interaction.display', structuredClone(getField(taxi, 'interaction.display'))),
        setScene('scn_taxi', 'feedback.hints', [...taxi.feedback.hints]),
        setProject('theme.palette', { ...base.theme.palette }),
      ],
      PROJECT,
    );
    expect(statuses(r.results)).toEqual(['unchanged', 'unchanged', 'unchanged']);
    expect(r.changed).toBe(false);
  });

  it('reports a project field that is already set', () => {
    expect(one(makeGameConfig(), setProject('theme.decor', 'airport')).result.status).toBe('unchanged');
  });

  it('reports a move to the current position', () => {
    expect(one(makeGameConfig(), move('scn_quad', 2)).result).toMatchObject({ status: 'unchanged', message: 'Scene is already there.' });
  });

  it('setting a locked field to its current value is unchanged, not a conflict', () => {
    const base = makeGameConfig();
    sceneOf(base, 'scn_taxi').locks.wording = true;
    expect(one(base, setScene('scn_taxi', 'title', 'Taxi to Runway Alpha')).result.status).toBe('unchanged');
  });

  it('treats an object with the same content in a different key order as unchanged', () => {
    const base = makeGameConfig();
    const reordered = { labelSize: 'standard', pointSize: 'standard', gridEmphasis: 'standard' };
    const r = one(base, setScene('scn_taxi', 'interaction.display', reordered));
    // The resulting game is identical to the base (toEqual ignores key order)…
    expect(r.config).toEqual(base);
    // …so the op must not be reported as a change (ok: true makes the server store a new version).
    expect(r.result.status).toBe('unchanged');
    expect(r.changed).toBe(false);
    expect(r.ok).toBe(false);
  });
});

// ───────────────────────────── move-scene ─────────────────────────────

describe('applyChangeOps: move-scene', () => {
  const flow = (cfg: GameConfig) => cfg.scenes.map((s) => `${s.id}→${s.next ?? 'end'}`);

  it('moves a scene forward and relinks next pointers in the new order', () => {
    const base = makeGameConfig();
    const r = one(base, move('scn_intro', 2));
    expect(r.result).toMatchObject({
      status: 'applied',
      label: 'Scene order',
      before: 1,
      after: 3,
      impact: 'sequence',
      where: 'Scene 1 · Meet the grid',
      target: 'scn_intro · position',
      sourceSlideIds: ['sld_slide0001'],
    });
    expect(flow(r.config)).toEqual(['scn_taxi→scn_quad', 'scn_quad→scn_intro', 'scn_intro→scn_lineup', 'scn_lineup→end']);
    expect(gameConfigSchema.safeParse(r.config).success).toBe(true);
  });

  it('moves a scene backward', () => {
    const r = one(makeGameConfig(), move('scn_lineup', 0));
    expect(flow(r.config)).toEqual(['scn_lineup→scn_intro', 'scn_intro→scn_taxi', 'scn_taxi→scn_quad', 'scn_quad→end']);
    expect(r.result).toMatchObject({ before: 4, after: 1 });
  });

  it('later ops in the same batch see the new position', () => {
    const r = applyChangeOps(makeGameConfig(), [move('scn_lineup', 0), setScene('scn_lineup', 'title', 'Warm-up line-up')], PROJECT);
    expect(statuses(r.results)).toEqual(['applied', 'applied']);
    expect(r.results[1]?.where).toBe('Scene 1 · Line up for take-off');
    expect(must(r.config.scenes[0]).title).toBe('Warm-up line-up');
  });

  it('keeps every scene exactly once', () => {
    const base = makeGameConfig();
    // intro,taxi,quad,lineup → intro,quad,lineup,taxi → quad,intro,lineup,taxi → lineup,quad,intro,taxi
    const r = applyChangeOps(base, [move('scn_taxi', 3), move('scn_intro', 1), move('scn_lineup', 0)], PROJECT);
    expect(statuses(r.results)).toEqual(['applied', 'applied', 'applied']);
    expect(r.config.scenes.map((s) => s.id)).toEqual(['scn_lineup', 'scn_quad', 'scn_intro', 'scn_taxi']);
    expect(r.config.scenes.map((s) => s.id).sort()).toEqual(base.scenes.map((s) => s.id).sort());
    expect(r.config.scenes.filter((s) => s.next === null)).toHaveLength(1);
  });
});

// ───────────────────────────── immutability and reporting ─────────────────────────────

describe('applyChangeOps: never mutates its input', () => {
  it('leaves a deep-frozen base untouched across every kind of op', () => {
    const base = makeGameConfig();
    sceneOf(base, 'scn_quad').locks.wording = true;
    deepFreeze(base);
    const snapshot = JSON.stringify(base);
    const ops: ChangeOp[] = [
      setScene('scn_taxi', 'instruction', 'New instruction.'),
      setScene('scn_taxi', 'interaction.display', { gridEmphasis: 'high', pointSize: 'large', labelSize: 'large' }),
      setScene('scn_quad', 'title', 'Locked title'),
      setScene('scn_taxi', 'instruction', ''),
      setProject('theme.decor', 'space'),
      move('scn_lineup', 0),
    ];
    // Any write to the frozen base throws a TypeError (strict mode) and fails the test here.
    const r = applyChangeOps(base, ops, PROJECT);
    expect(statuses(r.results)).toEqual(['applied', 'applied', 'conflict', 'invalid', 'applied', 'applied']);
    expect(JSON.stringify(base)).toBe(snapshot);
    expect(r.config).not.toBe(base);
    expect(() => applyChangeOps(base, ops, inScene('scn_taxi'))).not.toThrow();
    expect(JSON.stringify(base)).toBe(snapshot);
  });

  it('does not alias op values into the returned config', () => {
    const value = { gridEmphasis: 'high', pointSize: 'large', labelSize: 'large' };
    const r = one(makeGameConfig(), setScene('scn_taxi', 'interaction.display', value));
    value.gridEmphasis = 'standard';
    expect(getField(sceneOf(r.config, 'scn_taxi'), 'interaction.display')).toEqual({ gridEmphasis: 'high', pointSize: 'large', labelSize: 'large' });
  });
});

describe('applyChangeOps: every result says where it lands', () => {
  it('includes where text for every status and op kind', () => {
    const base = makeGameConfig();
    sceneOf(base, 'scn_quad').locks.layout = true;
    const ops: ChangeOp[] = [
      setScene('scn_taxi', 'title', 'Taxi time'), // applied
      setScene('scn_quad', 'layout.density', 'compact'), // conflict
      setScene('scn_taxi', 'title', ''), // invalid
      setScene('scn_intro', 'title', 'Meet the grid'), // unchanged
      setScene('scn_ghost', 'title', 'Ghost'), // invalid (unknown scene)
      setScene('scn_intro', 'interaction.rule', { kind: 'on-axis', axis: 'x' }), // invalid (not applicable)
      setProject('theme.decor', 'ice'), // applied
      setProject('title', ''), // invalid
      move('scn_lineup', 3), // unchanged
      move('scn_ghost', 0), // invalid
      move('scn_intro', 1), // applied
    ];
    const projectScope = applyChangeOps(base, ops, PROJECT);
    const sceneScope = applyChangeOps(base, ops, inScene('scn_quad'));
    for (const r of [...projectScope.results, ...sceneScope.results]) {
      expect(typeof r.where, JSON.stringify(r)).toBe('string');
      expect(r.where, JSON.stringify(r)).toMatch(/^(Scene \d+ · .+|Whole game|Unknown scene)$/);
    }
    expect(new Set([...projectScope.results, ...sceneScope.results].map((r) => r.status))).toEqual(
      new Set(['applied', 'conflict', 'invalid', 'unchanged', 'out-of-scope']),
    );
  });
});

// ───────────────────────────── allowlist and metadata ─────────────────────────────

describe('change-op allowlist', () => {
  it.each([
    { op: 'set-scene-field', sceneId: 'scn_taxi', field: 'locks.answer', value: false },
    { op: 'set-scene-field', sceneId: 'scn_taxi', field: 'id', value: 'scn_new' },
    { op: 'set-scene-field', sceneId: 'scn_taxi', field: 'next', value: null },
    { op: 'set-scene-field', sceneId: 'scn_taxi', field: 'sourceSlideIds', value: [] },
    { op: 'set-scene-field', sceneId: 'scn_taxi', field: 'interaction', value: {} },
    { op: 'set-project-field', field: 'settings.seed', value: 1 },
    { op: 'set-project-field', field: 'settings.locks.sequence', value: false },
    { op: 'set-project-field', field: 'meta.projectId', value: 'prj_other' },
    { op: 'set-project-field', field: 'assets', value: {} },
    { op: 'move-scene', sceneId: 'scn_taxi', toIndex: -1 },
    { op: 'move-scene', sceneId: 'scn_taxi', toIndex: 24 },
    { op: 'move-scene', sceneId: 'scn_taxi', toIndex: 1.5 },
    { op: 'delete-scene', sceneId: 'scn_taxi' },
  ])('rejects %o', (op) => {
    expect(changeOpSchema.safeParse(op).success).toBe(false);
  });

  it('every scene field has a label, and answer/wording impacts are guarded by the matching lock', () => {
    for (const field of SCENE_FIELDS) {
      const meta = SCENE_FIELD_META[field];
      expect(meta.label.length, field).toBeGreaterThan(0);
      if (meta.impact === 'answers') expect(meta.lock, field).toBe('answer');
      if (meta.impact === 'wording') expect(meta.lock, field).toBe('wording');
    }
  });

  it('project asset fields are guarded by the asset-identity lock', () => {
    const assetFields = PROJECT_FIELDS.filter((f) => PROJECT_FIELD_META[f].assetIdentity);
    expect(assetFields.sort()).toEqual(['screens.title.characterAssetId', 'theme.backgroundAssetId']);
  });
});

// ───────────────────────────── summarizeValue ─────────────────────────────

describe('summarizeValue', () => {
  it('formats primitives', () => {
    expect(summarizeValue(null)).toBe('—');
    expect(summarizeValue(undefined)).toBe('—');
    expect(summarizeValue('Guide NX7 to (3, 2).')).toBe('Guide NX7 to (3, 2).');
    expect(summarizeValue(42)).toBe('42');
    expect(summarizeValue(-2.5)).toBe('-2.5');
    expect(summarizeValue(true)).toBe('true');
    expect(summarizeValue(false)).toBe('false');
  });

  it('formats flat objects as human key: value pairs', () => {
    expect(summarizeValue({ gridEmphasis: 'high', pointSize: 'large', labelSize: 'large' })).toBe('grid emphasis: high · point size: large · label size: large');
    expect(summarizeValue({ x: 3, y: -2 })).toBe('x: 3 · y: -2');
    expect(summarizeValue({ xMin: -5, xMax: 5, yMin: -4, yMax: 4, step: 1 })).toBe('x min: -5 · x max: 5 · y min: -4 · y max: 4 · step: 1');
    expect(summarizeValue({ background: null, character: 'ast_plane001' })).toBe('background: — · character: ast_plane001');
  });

  it('formats arrays of primitives as a list', () => {
    expect(summarizeValue(['Count right first.', 'Then count up.'])).toBe('Count right first., Then count up.');
    expect(summarizeValue([1, null, true])).toBe('1, —, true');
  });

  it('falls back to JSON for nested values and objects with many keys', () => {
    expect(summarizeValue({ kind: 'point-equals', target: { x: 3, y: 2 } })).toBe('{"kind":"point-equals","target":{"x":3,"y":2}}');
    expect(summarizeValue([{ x: 1, y: 2 }])).toBe('[{"x":1,"y":2}]');
    const nineKeys = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`k${i}`, i]));
    expect(summarizeValue(nineKeys)).toBe(JSON.stringify(nineKeys));
  });

  it('truncates long strings to 140 characters', () => {
    expect(summarizeValue('a'.repeat(140))).toBe('a'.repeat(140));
    const long = summarizeValue('a'.repeat(141));
    expect(long).toBe(`${'a'.repeat(137)}…`);
    expect(long).toHaveLength(138);
  });

  it('truncates long lists, objects and JSON to 160 characters', () => {
    const list = summarizeValue(Array.from({ length: 60 }, (_, i) => `item${i}`));
    expect(list).toHaveLength(158);
    expect(list.endsWith('…')).toBe(true);
    expect(list.startsWith('item0, item1, item2')).toBe(true);
    const json = summarizeValue({ landmarks: Array.from({ length: 20 }, (_, i) => ({ id: `l${i}`, x: i, y: -i })) });
    expect(json).toHaveLength(158);
    expect(json.startsWith('{"landmarks":[{"id":"l0"')).toBe(true);
  });
});
