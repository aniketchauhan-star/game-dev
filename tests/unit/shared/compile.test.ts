import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { compileGame } from '../../../server/src/build/compile.ts';
import { checkInteraction, sortStartOrder } from '@shared/attainability.ts';
import { UNSUPPORTED_MESSAGE } from '@shared/registry.ts';
import { hashString } from '@shared/rng.ts';
import { isSequenceSolved } from '@shared/rules.ts';
import type { Blueprint, BlueprintScene } from '@shared/schemas/blueprint.ts';
import { gameConfigSchema, RUNTIME_VERSION, type GameConfig } from '@shared/schemas/game.ts';
import { THEME_PRESETS } from '@shared/themes.ts';
import {
  deepFreeze,
  loadSampleBlueprint,
  loadSampleBrief,
  makeAsset,
  makeRevision,
  must,
  SAMPLE_PROJECT_ID,
  sampleAssets,
  sampleSlides,
} from './helpers.ts';

type CompileInput = Parameters<typeof compileGame>[0];

const FROZEN_NOW = new Date('2026-05-04T03:02:01.000Z');

function sampleInput(overrides: Partial<CompileInput> = {}): CompileInput {
  return {
    projectId: SAMPLE_PROJECT_ID,
    revision: makeRevision(loadSampleBlueprint()),
    brief: loadSampleBrief(),
    assets: sampleAssets(),
    slides: sampleSlides(),
    ...overrides,
  };
}

/** Sample input with the blueprint edited by `edit` (on a fresh copy). */
function withBlueprint(edit: (b: Blueprint) => void, overrides: Partial<CompileInput> = {}): CompileInput {
  const blueprint = loadSampleBlueprint();
  edit(blueprint);
  return sampleInput({ revision: makeRevision(blueprint), ...overrides });
}

const sceneById = (b: Blueprint, id: string): BlueprintScene => must(b.scenes.find((s) => s.id === id), `scene ${id}`);
const compiled = (input: CompileInput = sampleInput()): GameConfig => must(compileGame(input).config, 'compiled config');

const SAMPLE_SCENE_IDS = ['scn_tower01', 'scn_taxi02', 'scn_quad03', 'scn_hangar04', 'scn_park05', 'scn_lineup06'];

describe('compileGame: the sample blueprint', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FROZEN_NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('builds without errors or warnings', () => {
    const r = compileGame(sampleInput());
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.config).not.toBeNull();
  });

  it('produces a config that passes the GameConfig schema, also after a JSON round trip', () => {
    const config = compiled();
    expect(gameConfigSchema.safeParse(config).success).toBe(true);
    expect(gameConfigSchema.safeParse(JSON.parse(JSON.stringify(config))).success).toBe(true);
    expect(config).toMatchObject({
      schemaVersion: 1,
      kind: 'nexus-game',
      title: 'Air Traffic Control — Coordinate Mission',
      language: 'en',
      stage: { width: 1920, height: 1080 },
      meta: {
        projectId: SAMPLE_PROJECT_ID,
        blueprintRevisionId: 'bpr_sample00001',
        blueprintRevisionNumber: 1,
        origin: 'build',
        demo: true,
        runtimeVersion: RUNTIME_VERSION,
        builtAt: FROZEN_NOW.toISOString(),
      },
    });
  });

  it('is deterministic: the same input always produces an identical config', () => {
    const a = compileGame(sampleInput());
    const b = compileGame(sampleInput()); // independently loaded, equal input
    expect(b).toStrictEqual(a);
    expect(JSON.stringify(b.config)).toBe(JSON.stringify(a.config));
    for (let i = 0; i < 5; i++) expect(JSON.stringify(compiled())).toBe(JSON.stringify(a.config));
  });

  it('only the build timestamp depends on the clock', () => {
    const first = compiled();
    vi.setSystemTime(new Date('2027-01-01T00:00:00.000Z'));
    const later = compiled();
    expect(later.meta.builtAt).toBe('2027-01-01T00:00:00.000Z');
    expect({ ...later, meta: { ...later.meta, builtAt: 'x' } }).toStrictEqual({ ...first, meta: { ...first.meta, builtAt: 'x' } });
  });

  it('does not mutate its input', () => {
    const input = deepFreeze(sampleInput());
    const snapshot = JSON.stringify(input);
    expect(() => compileGame(input)).not.toThrow();
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it('derives a valid seed from the project id and revision number', () => {
    const config = compiled();
    expect(config.settings.seed).toBe(hashString(`${SAMPLE_PROJECT_ID}:1`) & 0x7fffffff);
    expect(config.settings.seed).toBeGreaterThanOrEqual(0);
    expect(config.settings.seed).toBeLessThanOrEqual(2 ** 31 - 1);
    expect(compiled(sampleInput({ projectId: 'prj_other000001' })).settings.seed).not.toBe(config.settings.seed);
    expect(compiled(sampleInput({ revision: makeRevision(loadSampleBlueprint(), { number: 2 }) })).settings.seed).not.toBe(config.settings.seed);
  });

  it('keeps the scene flow, ids, patterns and source slides of the blueprint', () => {
    const blueprint = loadSampleBlueprint();
    const config = compiled();
    expect(config.scenes.map((s) => s.id)).toEqual(SAMPLE_SCENE_IDS);
    for (const scene of config.scenes) {
      const source = sceneById(blueprint, scene.id);
      expect(scene.sourceSlideIds, scene.id).toEqual(source.sourceSlideIds);
      expect(scene.sourceSlideIds.length, scene.id).toBeGreaterThan(0);
      expect(scene.addedPractice).toBe(source.addedPractice);
      expect(scene.pattern).toBe(source.pattern);
      expect(scene.title).toBe(source.title);
      expect(scene.instruction).toBe(source.instruction);
      expect(scene.feedback).toEqual({ success: source.successFeedback, error: source.errorFeedback, hints: source.hints });
      expect(scene.interaction).toEqual(source.interaction);
    }
    expect(config.scenes.map((s) => s.next)).toEqual([...SAMPLE_SCENE_IDS.slice(1), null]);
  });

  it('every compiled interaction passes checkInteraction with no errors, and sort scenes never start solved', () => {
    const config = compiled();
    for (const scene of config.scenes) {
      const issues = checkInteraction(scene.interaction, { seed: config.settings.seed, sceneId: scene.id });
      expect(issues.filter((i) => i.severity === 'error'), scene.id).toEqual([]);
      if (scene.interaction.type === 'sequence-sort') {
        expect(isSequenceSolved(sortStartOrder(scene.interaction, config.settings.seed, scene.id), scene.interaction)).toBe(false);
      }
    }
  });

  it('applies the theme, palette, settings and locks chosen in the brief', () => {
    const config = compiled();
    const brief = loadSampleBrief();
    expect(config.theme).toMatchObject({ presetId: 'airport', paletteId: 'daylight', decor: 'airport', fontStyle: 'rounded' });
    expect(config.theme.palette).toEqual(THEME_PRESETS.airport.palettes.find((p) => p.id === 'daylight')?.palette);
    expect(config.settings).toMatchObject({
      minimalText: brief.options.minimalText,
      reducedMotion: brief.options.reducedMotion,
      locks: { sequence: brief.options.preserveSequence, assetIdentity: brief.options.reuseArtwork },
    });
    expect(config.screens.title.heading).toBe(config.title);
    expect(config.screens.completion.heading).toBe('Mission complete');
    expect(config.screens.completion.message.startsWith('Skills practised: ')).toBe(true);
    for (const scene of config.scenes) expect(scene.locks, scene.id).toEqual(sceneById(loadSampleBlueprint(), scene.id).locks);
  });

  it('packages the assigned assets and wires them to the game, title screen and coordinate scenes', () => {
    const config = compiled();
    expect(Object.keys(config.assets).sort()).toEqual(['ast_aircraft01', 'ast_airfield01']);
    expect(config.assets.ast_airfield01).toMatchObject({ id: 'ast_airfield01', kind: 'image', file: 'assets/ast_airfield01.png', mime: 'image/png', alt: 'Top-down airfield map' });
    expect(config.assets.ast_aircraft01).toMatchObject({ file: 'assets/ast_aircraft01.png', alt: 'Aircraft' });
    expect(config.theme.backgroundAssetId).toBe('ast_airfield01');
    expect(config.screens.title.characterAssetId).toBe('ast_aircraft01');
    const characters = Object.fromEntries(config.scenes.map((s) => [s.id, s.assets.character]));
    expect(characters).toEqual({
      scn_tower01: null,
      scn_taxi02: 'ast_aircraft01',
      scn_quad03: null,
      scn_hangar04: 'ast_aircraft01',
      scn_park05: 'ast_aircraft01',
      scn_lineup06: null,
    });
  });
});

describe('compileGame: refusals and warnings', () => {
  it('refuses a blueprint with a custom (unsupported) scene', () => {
    const input = withBlueprint((b) => {
      sceneById(b, 'scn_quad03').interaction = { type: 'custom', description: 'Learners spin a radar dial to find each aircraft.' };
    });
    const r = compileGame(input);
    expect(r.config).toBeNull();
    expect(r.errors).toEqual([`Scene 3 “Which quadrant?”: ${UNSUPPORTED_MESSAGE}`]);
  });

  it('refuses a blueprint whose only scenes are unsupported', () => {
    const blueprint = loadSampleBlueprint();
    const custom: BlueprintScene = { ...must(blueprint.scenes[1]), interaction: { type: 'custom', description: 'A timed card-flip memory game.' }, next: null };
    blueprint.scenes = [custom];
    blueprint.coreMechanic = 'custom';
    const r = compileGame(sampleInput({ revision: makeRevision(blueprint) }));
    expect(r.config).toBeNull();
    expect(r.errors).toEqual([`Scene 1 “Taxi to Runway Alpha”: ${UNSUPPORTED_MESSAGE}`, 'The blueprint has no buildable scenes.']);
  });

  it('refuses draft revisions', () => {
    const r = compileGame(sampleInput({ revision: makeRevision(loadSampleBlueprint(), { status: 'draft', approvedAt: null }) }));
    expect(r.config).toBeNull();
    expect(r.errors).toEqual(['Blueprint r1 is a draft. Approve it before building.']);
  });

  it('warns about a stale revision but still builds', () => {
    const r = compileGame(sampleInput({ revision: makeRevision(loadSampleBlueprint(), { stale: true, staleReason: 'slide 3 was edited' }) }));
    expect(r.config).not.toBeNull();
    expect(r.warnings).toEqual(['Blueprint r1 is marked stale: slide 3 was edited.']);
  });

  it('refuses unreachable targets, naming the scene', () => {
    const input = withBlueprint((b) => {
      const taxi = sceneById(b, 'scn_taxi02');
      if (taxi.interaction.type !== 'coordinate-navigation') throw new Error('expected a coordinate scene');
      taxi.interaction.rule = { kind: 'point-equals', target: { x: 9, y: 2 } };
    });
    const r = compileGame(input);
    expect(r.config).toBeNull();
    expect(r.errors).toEqual(['Scene 2 “Taxi to Runway Alpha”: Target (9, 2) is outside the grid, so it cannot be reached.']);
  });

  it('refuses a match scene whose bays cannot hold the required cards', () => {
    const input = withBlueprint((b) => {
      const quad = sceneById(b, 'scn_quad03');
      if (quad.interaction.type !== 'drag-match') throw new Error('expected a match scene');
      quad.interaction.targets = quad.interaction.targets.map((t) => (t.id === 'q1' ? { ...t, capacity: 1 } : t));
    });
    const r = compileGame(input);
    expect(r.config).toBeNull();
    expect(r.errors).toContain('Scene 3 “Which quadrant?”: No arrangement satisfies every item within the target capacities. Increase a capacity or allow another target.');
  });

  it('passes attainability warnings through without blocking the build', () => {
    const input = withBlueprint((b) => {
      const park = sceneById(b, 'scn_park05');
      if (park.interaction.type !== 'coordinate-navigation') throw new Error('expected a coordinate scene');
      park.interaction.showTargetMarker = true;
    });
    const r = compileGame(input);
    expect(r.config).not.toBeNull();
    expect(r.warnings).toEqual(['Scene 5 “Holding pattern”: Target markers only appear for point targets.']);
  });

  it('leaves out scenes that cannot be reached, with a warning', () => {
    const input = withBlueprint((b) => {
      sceneById(b, 'scn_hangar04').next = null; // park05 and lineup06 become unreachable
    });
    const r = compileGame(input);
    expect(r.warnings).toEqual(['Some scenes are not reachable from the first scene and were left out.']);
    expect(must(r.config).scenes.map((s) => s.id)).toEqual(SAMPLE_SCENE_IDS.slice(0, 4));
    expect(must(r.config).scenes.at(-1)?.next).toBeNull();
  });

  it('follows the next chain rather than array order', () => {
    const input = withBlueprint((b) => {
      // Play the line-up straight after the welcome card, then the rest.
      sceneById(b, 'scn_tower01').next = 'scn_lineup06';
      sceneById(b, 'scn_lineup06').next = 'scn_taxi02';
      sceneById(b, 'scn_park05').next = null;
    });
    const config = compiled(input);
    expect(config.scenes.map((s) => s.id)).toEqual(['scn_tower01', 'scn_lineup06', 'scn_taxi02', 'scn_quad03', 'scn_hangar04', 'scn_park05']);
    expect(config.scenes.map((s) => s.next)).toEqual(['scn_lineup06', 'scn_taxi02', 'scn_quad03', 'scn_hangar04', 'scn_park05', null]);
  });

  it('marks scenes built from wording-locked slides as wording-locked', () => {
    const slides = sampleSlides().map((s) => (s.id === 'sld_pptx260' ? { ...s, lockedWording: true } : s));
    const config = compiled(sampleInput({ slides }));
    const locked = config.scenes.filter((s) => s.locks.wording).map((s) => s.id);
    // Slide 260 feeds the quadrant and hangar scenes.
    expect(locked).toEqual(['scn_quad03', 'scn_hangar04']);
  });

  it('falls back to built-in artwork when assigned assets are missing from the library', () => {
    const r = compileGame(sampleInput({ assets: [] }));
    const config = must(r.config);
    expect(gameConfigSchema.safeParse(config).success).toBe(true);
    expect(config.assets).toEqual({});
    expect(config.theme.backgroundAssetId).toBeNull();
    expect(config.screens.title.characterAssetId).toBeNull();
    expect(config.scenes.every((s) => s.assets.character === null && s.assets.background === null)).toBe(true);
    expect(r.warnings.length).toBeGreaterThan(0);
    expect(r.warnings.every((w) => w.includes('missing from the library'))).toBe(true);
  });

  it('does not use an asset of the wrong kind', () => {
    const assets = [sampleAssets()[0]!, makeAsset('ast_aircraft01', { kind: 'audio', mime: 'audio/mpeg', format: 'mp3', width: null, height: null, durationSeconds: 3 })];
    const r = compileGame(sampleInput({ assets }));
    const config = must(r.config);
    expect(Object.keys(config.assets)).toEqual(['ast_airfield01']);
    expect(config.screens.title.characterAssetId).toBeNull();
    expect(r.warnings.some((w) => w.includes('is audio, not image'))).toBe(true);
  });

  it('warns when a required asset need has nothing assigned', () => {
    const input = withBlueprint((b) => {
      must(b.assetNeeds.find((n) => n.id === 'char-plane')).assignedAssetId = null;
    });
    const r = compileGame(input);
    expect(r.config).not.toBeNull();
    expect(r.warnings.some((w) => w.includes('has no asset assigned; built-in artwork is used.'))).toBe(true);
  });

  it('packages card images and never references an asset it did not package', () => {
    const input = withBlueprint((b) => {
      const quad = sceneById(b, 'scn_quad03');
      if (quad.interaction.type !== 'drag-match') throw new Error('expected a match scene');
      quad.interaction.items = quad.interaction.items.map((item, i) =>
        i === 0 ? { ...item, imageAssetId: 'ast_airfield01' } : i === 1 ? { ...item, imageAssetId: 'ast_missing01' } : item,
      );
    });
    const r = compileGame(input);
    const config = must(r.config);
    expect(r.warnings.some((w) => w.includes('ast_missing01 is missing from the library'))).toBe(true);
    const quad = must(config.scenes.find((s) => s.id === 'scn_quad03'));
    if (quad.interaction.type !== 'drag-match') throw new Error('expected a match scene');
    expect(quad.interaction.items[0]?.imageAssetId).toBe('ast_airfield01');
    // Every card image the game points at must be packaged with it.
    for (const card of [...quad.interaction.items, ...quad.interaction.targets]) {
      if (card.imageAssetId !== null) expect(config.assets[card.imageAssetId], `card ${card.id} → ${card.imageAssetId}`).toBeDefined();
    }
  });

  it('uses the first palette of the theme when the brief names an unknown palette', () => {
    const brief = loadSampleBrief();
    brief.visual.paletteId = 'no-such-palette';
    const config = compiled(sampleInput({ brief }));
    expect(config.theme.paletteId).toBe(THEME_PRESETS.airport.palettes[0]!.id);
  });
});
