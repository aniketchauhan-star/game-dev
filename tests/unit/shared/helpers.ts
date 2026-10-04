/**
 * Fixture builders shared by the unit tests in this folder. Everything here is
 * plain data that satisfies the product schemas; tests mutate their own copies.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Asset } from '@shared/schemas/assets.ts';
import { blueprintSchema, NO_LOCKS, type Blueprint, type BlueprintRevision, type BlueprintScene } from '@shared/schemas/blueprint.ts';
import { gameBriefSchema, type GameBrief } from '@shared/schemas/brief.ts';
import { DEFAULT_PLACEMENT, RUNTIME_VERSION, type GameAsset, type GameConfig, type GameScene } from '@shared/schemas/game.ts';
import type { CoordinateInteraction, MatchInteraction, SortInteraction } from '@shared/schemas/interaction.ts';
import { DEFAULT_MOTION_CONFIG } from '@shared/schemas/motion.ts';
import type { SourceSlide } from '@shared/schemas/source.ts';
import { THEME_PRESETS } from '@shared/themes.ts';

// ───────────────────────────── generic utilities ─────────────────────────────

/** Absolute path of a file relative to the repository root. */
export function repoPath(rel: string): string {
  return fileURLToPath(new URL(`../../../${rel}`, import.meta.url));
}

export function readRepoText(rel: string): string {
  return fs.readFileSync(repoPath(rel), 'utf8');
}

export function readRepoJson(rel: string): unknown {
  return JSON.parse(readRepoText(rel)) as unknown;
}

/** Narrow away null/undefined (noUncheckedIndexedAccess) with a readable failure. */
export function must<T>(value: T | null | undefined, what = 'value'): T {
  if (value === null || value === undefined) throw new Error(`Expected ${what} to be present`);
  return value;
}

/** Recursively freeze a value so any attempted mutation throws (ES modules run in strict mode). */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}

export function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [items.slice()];
  const out: T[][] = [];
  items.forEach((item, i) => {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const p of permutations(rest)) out.push([item, ...p]);
  });
  return out;
}

export const sorted = <T>(items: readonly T[]): T[] => items.slice().sort();

// ───────────────────────────── interactions ─────────────────────────────

export function coordInteraction(overrides: Partial<CoordinateInteraction> = {}): CoordinateInteraction {
  return {
    type: 'coordinate-navigation',
    grid: { xMin: -5, xMax: 5, yMin: -4, yMax: 4, step: 1 },
    start: { x: 0, y: 0 },
    rule: { kind: 'point-equals', target: { x: 3, y: 2 } },
    showTargetMarker: true,
    showCoordinateReadout: true,
    moverLabel: 'NX7',
    landmarks: [
      { id: 'runway', label: 'Runway Alpha', point: { x: 3, y: 2 }, icon: 'runway' },
      { id: 'tower', label: 'Tower', point: { x: -2, y: 3 }, icon: 'tower' },
    ],
    display: { gridEmphasis: 'standard', pointSize: 'standard', labelSize: 'standard' },
    ...overrides,
  };
}

/** Quadrant sorting: four positions, one bay each, capacity 2 per bay. */
export function matchInteraction(overrides: Partial<MatchInteraction> = {}): MatchInteraction {
  return {
    type: 'drag-match',
    items: [
      { id: 'p1', label: '(2, 3)', imageAssetId: null },
      { id: 'p2', label: '(−4, 1)', imageAssetId: null },
      { id: 'p3', label: '(−3, −2)', imageAssetId: null },
      { id: 'p4', label: '(0, 4)', imageAssetId: null },
    ],
    targets: [
      { id: 'q1', label: 'Quadrant I', imageAssetId: null, capacity: 2 },
      { id: 'q2', label: 'Quadrant II', imageAssetId: null, capacity: 2 },
      { id: 'q3', label: 'Quadrant III', imageAssetId: null, capacity: 2 },
      { id: 'axis', label: 'On an axis', imageAssetId: null, capacity: 2 },
    ],
    rule: {
      kind: 'match-sets',
      accepts: [
        { itemId: 'p1', targetIds: ['q1'] },
        { itemId: 'p2', targetIds: ['q2'] },
        { itemId: 'p3', targetIds: ['q3'] },
        { itemId: 'p4', targetIds: ['axis'] },
      ],
    },
    trayPosition: 'bottom',
    ...overrides,
  };
}

/** Compact builder: `accepts` maps item id → accepted target ids ([] = distractor). */
export function buildMatch(accepts: Record<string, string[]>, capacities: Record<string, number>): MatchInteraction {
  return {
    type: 'drag-match',
    items: Object.keys(accepts).map((id) => ({ id, label: `Item ${id}`, imageAssetId: null })),
    targets: Object.entries(capacities).map(([id, capacity]) => ({ id, label: `Target ${id}`, imageAssetId: null, capacity })),
    rule: { kind: 'match-sets', accepts: Object.entries(accepts).map(([itemId, targetIds]) => ({ itemId, targetIds })) },
    trayPosition: 'left',
  };
}

/** Line-up by x-coordinate; qf2 and ba9 tie on x = 1. */
export function sortInteraction(overrides: Partial<SortInteraction> = {}): SortInteraction {
  return {
    type: 'sequence-sort',
    items: [
      { id: 'nx7', label: 'NX7 at (−3, 2)', value: -3, imageAssetId: null },
      { id: 'qf2', label: 'QF2 at (1, −4)', value: 1, imageAssetId: null },
      { id: 'ba9', label: 'BA9 at (1, 3)', value: 1, imageAssetId: null },
      { id: 'ai4', label: 'AI4 at (4, 0)', value: 4, imageAssetId: null },
    ],
    rule: { kind: 'order-by-value', direction: 'ascending' },
    orientation: 'horizontal',
    showValues: false,
    startLabel: 'Left (smallest x)',
    endLabel: 'Right (largest x)',
    ...overrides,
  };
}

/** Sort builder from `id → value`. */
export function buildSort(values: Record<string, number | null>, rule: SortInteraction['rule']): SortInteraction {
  return sortInteraction({
    items: Object.entries(values).map(([id, value]) => ({ id, label: `Item ${id}`, value, imageAssetId: null })),
    rule,
  });
}

// ───────────────────────────── game config ─────────────────────────────

function imageAsset(id: string, alt: string): GameAsset {
  return {
    id,
    kind: 'image',
    file: `assets/${id}.png`,
    mime: 'image/png',
    width: 512,
    height: 512,
    alt,
    sprite: null,
    placement: { ...DEFAULT_PLACEMENT },
  };
}

function scene(partial: Pick<GameScene, 'id' | 'title' | 'interaction' | 'sourceSlideIds'> & Partial<GameScene>): GameScene {
  return {
    pattern: 'apply',
    addedPractice: false,
    instruction: `Instruction for ${partial.title}.`,
    supportText: null,
    layout: { instructionPosition: 'top', density: 'comfortable', showProgress: true },
    feedback: { success: 'Well done!', error: 'Not yet — try again.', hints: ['Look again.', 'Check each step.'] },
    assets: { background: null, character: null, characterClip: null, panel: null, button: null },
    design: null,
    objects: [],
    next: null,
    locks: { ...NO_LOCKS },
    ...partial,
  };
}

/**
 * A valid four-scene game (info → coordinate → match → sort) with three image
 * assets. Scene 4 is added practice without source slides. Returns a fresh copy.
 */
export function makeGameConfig(): GameConfig {
  const palette = must(THEME_PRESETS.airport.palettes[0], 'airport palette').palette;
  return {
    schemaVersion: 1,
    kind: 'nexus-game',
    id: 'ver_test000001',
    title: 'Coordinate Practice',
    language: 'en',
    meta: {
      projectId: 'prj_test000001',
      versionNumber: 3,
      blueprintRevisionId: 'bpr_test000001',
      blueprintRevisionNumber: 1,
      builtAt: '2026-01-01T00:00:00.000Z',
      origin: 'build',
      demo: false,
      runtimeVersion: RUNTIME_VERSION,
      branchId: null,
      gradeLabel: '',
      gradeProfileRevision: null,
      screenMapNumber: null,
    },
    stage: { width: 1920, height: 1080 },
    theme: { presetId: 'airport', paletteId: 'daylight', palette: { ...palette }, decor: 'airport', backgroundAssetId: 'ast_bg000001', fontStyle: 'rounded' },
    settings: {
      minimalText: true,
      reducedMotion: false,
      seed: 424242,
      audio: { sfx: true, musicAssetId: null },
      locks: { sequence: false, assetIdentity: false },
      guidance: 'standard',
    },
    screens: {
      title: { heading: 'Coordinate Practice', subheading: 'Guide each flight to its runway.', startLabel: 'Start', characterAssetId: 'ast_plane001', characterClip: null, design: null, objects: [] },
      completion: { heading: 'Mission complete', message: 'You guided every flight.', replayLabel: 'Play again', characterAssetId: null, characterClip: null, design: null, objects: [] },
    },
    assets: {
      ast_bg000001: imageAsset('ast_bg000001', 'Airfield'),
      ast_plane001: imageAsset('ast_plane001', 'Aircraft'),
      ast_plane002: imageAsset('ast_plane002', 'Helicopter'),
    },
    scenes: [
      scene({
        id: 'scn_intro',
        title: 'Meet the grid',
        pattern: 'discover',
        sourceSlideIds: ['sld_slide0001'],
        interaction: { type: 'info', points: ['The x-axis runs left to right.', 'The y-axis runs bottom to top.'], illustration: 'grid', continueLabel: 'Continue' },
        next: 'scn_taxi',
      }),
      scene({
        id: 'scn_taxi',
        title: 'Taxi to Runway Alpha',
        pattern: 'manipulate',
        sourceSlideIds: ['sld_slide0002', 'sld_slide0003'],
        supportText: 'Move along x first, then along y.',
        interaction: coordInteraction(),
        assets: { background: 'ast_bg000001', character: 'ast_plane001', characterClip: null, panel: null, button: null },
        next: 'scn_quad',
      }),
      scene({
        id: 'scn_quad',
        title: 'Which quadrant?',
        pattern: 'predict',
        sourceSlideIds: ['sld_slide0004'],
        interaction: matchInteraction(),
        next: 'scn_lineup',
      }),
      scene({
        id: 'scn_lineup',
        title: 'Line up for take-off',
        sourceSlideIds: [],
        addedPractice: true,
        interaction: sortInteraction(),
        next: null,
      }),
    ],
    motion: structuredClone(DEFAULT_MOTION_CONFIG),
  };
}

// ───────────────────────────── blueprints ─────────────────────────────

export function makeBlueprintScene(id: string, overrides: Partial<BlueprintScene> = {}): BlueprintScene {
  return {
    id,
    title: `Scene ${id}`,
    pattern: 'discover',
    sourceSlideIds: ['sld_slide0001'],
    addedPractice: false,
    objective: 'Recognize the axes.',
    visibleContent: 'A concept card.',
    learnerAction: 'Read and continue.',
    expectedResult: 'The learner continues.',
    instruction: 'Read the points.',
    interaction: { type: 'info', points: ['The x-axis runs left to right.'], illustration: 'none', continueLabel: 'Continue' },
    successFeedback: 'Great.',
    errorFeedback: 'Read the points first.',
    hints: ['x comes first.'],
    next: null,
    assetNeedIds: { background: null, character: null },
    completion: 'The learner continues.',
    difficulty: 'standard',
    locks: { ...NO_LOCKS },
    origin: 'creator',
    ...overrides,
  };
}

export function makeBlueprint(scenes: BlueprintScene[], overrides: Partial<Blueprint> = {}): Blueprint {
  return {
    schemaVersion: 1,
    title: 'Test blueprint',
    learningOutcomes: [{ id: 'out-1', text: 'Plot points from ordered pairs.', sourceSlideIds: ['sld_slide0001'], addedPractice: false }],
    coreMechanic: 'coordinate-navigation',
    customMechanicDescription: null,
    premise: 'You guide aircraft across an airfield grid.',
    progression: 'From marked targets to unmarked ones.',
    assessment: 'Deterministic rules check every answer.',
    assetNeeds: [{ id: 'bg-main', role: 'background', description: 'Airfield backdrop', assignedAssetId: null, required: false }],
    accessibility: [],
    unresolvedDecisions: [],
    assumptions: [],
    mechanicFit: 'Moving to coordinates practises the skill directly.',
    scenes,
    ...overrides,
  };
}

// ───────────────────────────── sample fixtures ─────────────────────────────

export const SAMPLE_PROJECT_ID = 'prj_sample00001';
export const SAMPLE_DOCUMENT_ID = 'doc_sample00001';
/** Test-chosen ids for the `@slide:<p:sldId>` placeholders. */
export const sampleSlideId = (pptxId: string | number): string => `sld_pptx${pptxId}`;
/** Test-chosen ids for the `@asset:<deck image file>` placeholders. */
export const SAMPLE_ASSET_IDS: Readonly<Record<string, string>> = {
  'airfield-map.png': 'ast_airfield01',
  'aircraft.png': 'ast_aircraft01',
};

/**
 * Same walk as `resolveSampleRefs` (server/src/demo/sample.ts), but with ids
 * chosen by the test instead of database lookups.
 */
export function resolveRefs(raw: unknown, slideId: (ref: string) => string, assetId: (name: string) => string | null): unknown {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      if (v.startsWith('@slide:')) return slideId(v.slice(7));
      if (v.startsWith('@asset:')) return assetId(v.slice(7));
      return v;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, walk(val)]));
    return v;
  };
  return walk(raw);
}

const SAMPLE_BLUEPRINT_FILE = 'fixtures/sample/sample-blueprint.json';

export function loadSampleBlueprint(): Blueprint {
  const raw = readRepoJson(SAMPLE_BLUEPRINT_FILE);
  return blueprintSchema.parse(resolveRefs(raw, sampleSlideId, (name) => SAMPLE_ASSET_IDS[name] ?? null));
}

export function loadSampleBrief(): GameBrief {
  return gameBriefSchema.parse(readRepoJson('fixtures/sample/sample-brief.json'));
}

/** The `p:sldId` values the sample blueprint cites, ascending. */
export function sampleCitedPptxIds(): number[] {
  const text = readRepoText(SAMPLE_BLUEPRINT_FILE);
  const ids = new Set<number>();
  for (const m of text.matchAll(/@slide:(\d+)/g)) ids.add(Number(m[1]));
  return [...ids].sort((a, b) => a - b);
}

export function makeSlide(id: string, slideNumber: number, overrides: Partial<SourceSlide> = {}): SourceSlide {
  return {
    id,
    projectId: SAMPLE_PROJECT_ID,
    documentId: SAMPLE_DOCUMENT_ID,
    slideNumber,
    pptxSlideId: 255 + slideNumber,
    partName: `ppt/slides/slide${slideNumber}.xml`,
    hidden: false,
    included: true,
    extract: { title: `Slide ${slideNumber}`, layoutName: null, blocks: [], tables: [], equations: [], images: [], notes: [], warnings: [] },
    edits: { title: null, blocks: {}, notes: null },
    lockedWording: false,
    requiredExample: false,
    reviewStatus: 'verified',
    visualRef: null,
    contentHash: `hash-${slideNumber}`,
    revision: 1,
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** One source slide per cited `p:sldId`, numbered so pptx id 256 + n is slide n. */
export function sampleSlides(): SourceSlide[] {
  return sampleCitedPptxIds().map((pptxId) => makeSlide(sampleSlideId(pptxId), pptxId - 255, { pptxSlideId: pptxId }));
}

export function makeAsset(id: string, overrides: Partial<Asset> = {}): Asset {
  return {
    id,
    projectId: SAMPLE_PROJECT_ID,
    role: 'unassigned',
    kind: 'image',
    name: `${id} image`,
    originalName: `${id}.png`,
    mime: 'image/png',
    format: 'png',
    sizeBytes: 2048,
    width: 640,
    height: 480,
    hasAlpha: true,
    durationSeconds: null,
    source: 'extracted',
    sha256: '0'.repeat(64),
    metadata: { placement: { ...DEFAULT_PLACEMENT }, sprite: null, replacedFrom: null, rasterizedFromSvg: false, alt: '', generationPrompt: null, provenance: null },
    usage: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

export function sampleAssets(): Asset[] {
  return [
    makeAsset('ast_airfield01', { role: 'background', name: 'Airfield map', originalName: 'airfield-map.png', metadata: { placement: { ...DEFAULT_PLACEMENT }, sprite: null, replacedFrom: null, rasterizedFromSvg: false, alt: 'Top-down airfield map', generationPrompt: null, provenance: null } }),
    makeAsset('ast_aircraft01', { role: 'character', name: 'Aircraft', originalName: 'aircraft.png' }),
  ];
}

export function makeRevision(blueprint: Blueprint, overrides: Partial<BlueprintRevision> = {}): BlueprintRevision {
  return {
    id: 'bpr_sample00001',
    projectId: SAMPLE_PROJECT_ID,
    branchId: null,
    number: 1,
    parentId: null,
    status: 'approved',
    origin: 'demo',
    model: null,
    analysisId: null,
    sourceRevision: 'src-rev-1',
    stale: false,
    staleReason: null,
    blueprint,
    revision: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    approvedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}
