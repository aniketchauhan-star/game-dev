import { describe, expect, it } from 'vitest';
import type { DesignElement, DesignFrame } from '@shared/schemas/design.ts';
import { emptyScreen, type ScreenMapEntry } from '@shared/schemas/screens.ts';
import { definitionClaims, detectConflicts } from '@shared/screens/conflicts.ts';
import { computeScreenLayout, layerIdFor, validateMapping, type LayoutContext } from '@shared/screens/layout.ts';
import { mergeWithBlueprint, suggestMapping, type SuggestAsset } from '@shared/screens/suggest.ts';
import { makeBlueprint, makeBlueprintScene, must } from './helpers.ts';

// ───────────── fixtures ─────────────

function el(id: string, name: string, kind: DesignElement['kind'], patch: Partial<DesignElement> = {}): DesignElement {
  return {
    id,
    name,
    type: kind === 'text' ? 'TEXT' : kind === 'image' ? 'RECTANGLE' : 'RECTANGLE',
    kind,
    fidelity: kind === 'text' || kind === 'rect' || kind === 'image' ? 'editable' : 'flattened',
    box: { x: 100, y: 100, w: 400, h: 80 },
    rotation: 0,
    opacity: 1,
    z: 1,
    depth: 1,
    parentId: null,
    text: null,
    fill: kind === 'rect' ? '#ffffff' : null,
    cornerRadius: null,
    stroke: null,
    imageRef: null,
    assetId: null,
    bakedText: false,
    notes: [],
    ...patch,
  };
}

function text(id: string, name: string, characters: string, box = { x: 140, y: 120, w: 900, h: 60 }): DesignElement {
  return el(id, name, 'text', { box, text: { characters, fontFamily: 'Baloo 2', fontStyle: 'Bold', fontWeight: 700, fontSize: 40, lineHeightPx: null, align: 'left', color: '#0f2740', mixedStyles: false } });
}

function frame(id: string, name: string, elements: DesignElement[], patch: Partial<DesignFrame> = {}): DesignFrame {
  return {
    id,
    projectId: 'prj_test000001',
    importId: 'dim_test000001',
    nodeId: '10:1',
    name,
    pageName: 'Screens',
    width: 1920,
    height: 1080,
    source: 'figma',
    renderAssetId: `ast_render_${id}`,
    backgroundColor: '#dff3ff',
    elements,
    fonts: [{ family: 'Baloo 2', style: 'Bold', count: 1, available: false, substitute: 'Nunito' }],
    prototype: [],
    warnings: [],
    checksum: 'x',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...patch,
  };
}

const LESSON = 'A trapezium is a quadrilateral with at least one pair of parallel sides.';
const DESIGN_WRONG = 'A trapezium is a quadrilateral with exactly one pair of parallel sides.';

function trapeziumBlueprint() {
  return makeBlueprint([
    makeBlueprintScene('scn_identify', {
      title: 'Spot the parallel sides',
      instruction: 'Sort each shape by whether it has parallel sides.',
      sourceSlideIds: ['sld_a', 'sld_b'],
    }),
    makeBlueprintScene('scn_match', { title: 'Match the shapes', instruction: 'Match each shape to its most specific name.', sourceSlideIds: ['sld_c'] }),
    makeBlueprintScene('scn_extra', { title: 'Bonus practice', instruction: 'Try one more.', sourceSlideIds: [] }),
  ]);
}

const SLIDES = [
  { id: 'sld_a', title: 'What is a trapezium?', text: LESSON },
  { id: 'sld_b', title: 'Spot the parallel sides', text: 'Look for parallel sides in each shape.' },
  { id: 'sld_c', title: 'Match the shapes', text: 'Every parallelogram is also a trapezium.' },
];

const ASSETS: SuggestAsset[] = [
  { id: 'ast_bg', role: 'background', name: 'ice-background', kind: 'image', sprite: null },
  { id: 'ast_bird', role: 'character', name: 'Swiftee', kind: 'image', sprite: { clips: [{ name: 'idle' }, { name: 'wave' }] } },
  { id: 'ast_panel', role: 'ui', name: 'panel-blank', kind: 'image', sprite: null },
  { id: 'ast_button', role: 'ui', name: 'button-primary', kind: 'image', sprite: null },
];

// ───────────── conflicts ─────────────

describe('source conflicts (rules only flag, never pick a winner)', () => {
  it('reads definition quantities', () => {
    expect(definitionClaims(LESSON)).toEqual([{ subject: 'trapezium', object: 'pair', quantity: '>=1', sentence: LESSON }]);
    expect(definitionClaims(DESIGN_WRONG)[0]?.quantity).toBe('=1');
  });

  it('flags a definition that disagrees with the lesson', () => {
    const found = detectConflicts([{ text: LESSON, slideIds: ['sld_a'] }], [{ text: DESIGN_WRONG, frameId: 'dfr_1', elementId: '10:7' }]);
    const def = must(found.find((c) => c.kind === 'definition'));
    expect(def).toMatchObject({ pptSlideIds: ['sld_a'], figmaFrameId: 'dfr_1', figmaElementId: '10:7', detectedBy: 'rule' });
    expect(def.message).toBe('The design defines “trapezium” differently from the lesson (exactly 1 vs at least 1 pair).');
  });

  it('flags opposite statements, different numbers and near-miss labels', () => {
    const polarity = detectConflicts([{ text: 'Every parallelogram is also a trapezium in this lesson.' }], [{ text: 'Every parallelogram is not a trapezium in this lesson.' }]);
    expect(polarity.map((c) => c.kind)).toContain('answer-rule');
    const numbers = detectConflicts([{ text: 'Move the jet 3 squares to the right of the tower.' }], [{ text: 'Move the jet 4 squares to the right of the tower.' }]);
    expect(numbers.map((c) => c.kind)).toEqual(['number']);
    const label = detectConflicts([], [{ text: 'Kites', elementId: '10:9' }], ['Kite', 'Trapezium']);
    expect(label).toHaveLength(1);
    expect(label[0]).toMatchObject({ kind: 'label', pptText: 'Kite', figmaText: 'Kites' });
  });

  it('stays quiet when the sources agree', () => {
    expect(detectConflicts([{ text: LESSON }], [{ text: LESSON }, { text: 'Kite' }], ['Kite'])).toEqual([]);
  });
});

// ───────────── suggestions ─────────────

describe('suggestMapping (evidence only)', () => {
  it('links frames by shared words, never by order, counts or numbers', () => {
    const numbered = [frame('dfr_1', 'Screen 1', [text('1:1', 'Body', 'Lorem ipsum dolor')]), frame('dfr_2', 'Screen 2', [text('2:1', 'Body', 'Sit amet')]), frame('dfr_3', 'Screen 3', [text('3:1', 'Body', 'Consectetur')])];
    const map = suggestMapping({ blueprint: trapeziumBlueprint(), slides: SLIDES, frames: numbered, assets: ASSETS });
    expect(map.screens.map((s) => s.screenId)).toEqual(['title', 'scn_identify', 'scn_match', 'scn_extra', 'completion']);
    expect(map.screens.every((s) => s.frames.length === 0)).toBe(true);
    expect(map.screens.every((s) => !s.reviewed)).toBe(true);
  });

  it('groups several states of one screen and several slides per scene', () => {
    const frames = [
      frame('dfr_spot', 'Spot the parallel sides', [text('5:1', 'Instruction', 'Spot the parallel sides: sort each shape'), el('5:2', 'Instruction panel', 'rect', { depth: 1, box: { x: 100, y: 80, w: 1200, h: 160 } })]),
      frame('dfr_spot_hint', 'Spot the parallel sides – hint', [text('6:1', 'Instruction', 'Spot the parallel sides: look for sides that never meet')]),
      frame('dfr_match', 'Match the shapes', [text('7:1', 'Instruction', 'Match each shape to its most specific name')]),
    ];
    const map = suggestMapping({ blueprint: trapeziumBlueprint(), slides: SLIDES, frames, assets: ASSETS });
    const identify = must(map.screens.find((s) => s.screenId === 'scn_identify'));
    expect(identify.slideIds).toEqual(['sld_a', 'sld_b']);
    expect(identify.frames).toEqual([
      { frameId: 'dfr_spot', state: 'default', primary: true },
      { frameId: 'dfr_spot_hint', state: 'hint', primary: false },
    ]);
    expect(identify.roles.layout).toBe('figma');
    expect(identify.layers).toEqual([{ elementId: '5:2', use: 'instruction-region' }]);
    // Uploaded artwork is preferred over a picture of the whole design.
    expect(identify.background).toMatchObject({ kind: 'asset', assetId: 'ast_bg' });
    expect(identify.assets).toEqual({ character: 'ast_bird', characterClip: 'idle', panel: 'ast_panel', button: 'ast_button' });
    // A scene with no slides takes the creator's wording rather than inventing a source.
    expect(must(map.screens.find((s) => s.screenId === 'scn_extra')).roles.content).toBe('creator');
  });

  it('attaches conflicts between linked slides and linked frames to the row', () => {
    const frames = [frame('dfr_spot', 'Spot the parallel sides', [text('5:1', 'Definition', DESIGN_WRONG), text('5:3', 'Instruction', 'Spot the parallel sides in each shape')])];
    const map = suggestMapping({ blueprint: trapeziumBlueprint(), slides: SLIDES, frames, assets: ASSETS });
    const identify = must(map.screens.find((s) => s.screenId === 'scn_identify'));
    expect(identify.conflicts.map((c) => [c.kind, c.status, c.figmaElementId])).toEqual([['definition', 'open', '5:1']]);
  });

  it('follows a new scene order and keeps every reviewed row', () => {
    const before = suggestMapping({ blueprint: trapeziumBlueprint(), slides: SLIDES, frames: [], assets: ASSETS });
    const reviewed = { screens: before.screens.map((s) => ({ ...s, reviewed: true, notes: `note ${s.screenId}` })) };
    const bp = trapeziumBlueprint();
    bp.scenes = [bp.scenes[2]!, bp.scenes[0]!, bp.scenes[1]!];
    const merged = mergeWithBlueprint(reviewed, suggestMapping({ blueprint: bp, slides: SLIDES, frames: [], assets: ASSETS }));
    expect(merged.mapping.screens.map((s) => s.screenId)).toEqual(['title', 'scn_extra', 'scn_identify', 'scn_match', 'completion']);
    expect(merged.mapping.screens.every((s) => s.reviewed && s.notes === `note ${s.screenId}`)).toBe(true);
    expect(merged.added).toEqual([]);
    expect(merged.removed).toEqual([]);
  });

  it('keeps reviewed rows when the blueprint changes', () => {
    const before = suggestMapping({ blueprint: trapeziumBlueprint(), slides: SLIDES, frames: [], assets: ASSETS });
    const reviewed = { screens: before.screens.map((s) => (s.screenId === 'scn_identify' ? { ...s, reviewed: true, notes: 'checked' } : s)) };
    const bp = trapeziumBlueprint();
    bp.scenes = bp.scenes.filter((s) => s.id !== 'scn_extra');
    const next = suggestMapping({ blueprint: bp, slides: SLIDES, frames: [], assets: ASSETS });
    const merged = mergeWithBlueprint(reviewed, next);
    expect(merged.removed).toEqual(['scn_extra']);
    expect(must(merged.mapping.screens.find((s) => s.screenId === 'scn_identify'))).toMatchObject({ reviewed: true, notes: 'checked' });
  });
});

// ───────────── layout ─────────────

function ctxFor(frames: DesignFrame[]): LayoutContext {
  return {
    frames: new Map(frames.map((f) => [f.id, f])),
    assets: new Map([
      ['ast_bg', { id: 'ast_bg', kind: 'image' as const, sprite: null }],
      ['ast_bird', { id: 'ast_bird', kind: 'image' as const, sprite: { clips: [{ name: 'idle' }] } }],
      ['ast_flat', { id: 'ast_flat', kind: 'image' as const, sprite: null }],
      ['ast_chime', { id: 'ast_chime', kind: 'audio' as const, sprite: null }],
    ]),
    slideIds: new Set(['sld_a', 'sld_b']),
    screens: [
      { id: 'title', kind: 'title' },
      { id: 'scn_identify', kind: 'scene' },
      { id: 'completion', kind: 'completion' },
    ],
  };
}

function row(patch: Partial<ScreenMapEntry> = {}): ScreenMapEntry {
  return { ...emptyScreen('scn_identify', 'scene', 'Spot the parallel sides', ['sld_a']), ...patch };
}

describe('computeScreenLayout and validateMapping', () => {
  const f = frame('dfr_spot', 'Spot the parallel sides', [
    text('5:1', 'Heading', 'Spot the parallel sides'),
    text('5:2', 'Instruction', 'Sort each shape: does it have parallel sides?', { x: 120, y: 200, w: 900, h: 60 }),
    el('5:3', 'Instruction panel', 'rect', { box: { x: 100, y: 180, w: 1200, h: 120 } }),
    el('5:4', 'Mascot artwork', 'artwork', { fidelity: 'flattened' }),
    el('5:5', 'Ice photo', 'image', { assetId: 'ast_flat' }),
  ]);

  it('keeps only the chosen editable subset, substitutes fonts, and never builds controls from the design', () => {
    const entry = row({
      frames: [{ frameId: f.id, state: 'default', primary: true }],
      roles: { content: 'ppt', layout: 'figma', artwork: 'uploads' },
      layers: [
        { elementId: '5:1', use: 'layer' },
        { elementId: '5:3', use: 'instruction-region' },
        { elementId: '5:4', use: 'layer' },
        { elementId: '5:5', use: 'layer' },
      ],
      background: { kind: 'asset', assetId: 'ast_bg', frameId: null, elementId: null, confirmedClean: false },
    });
    const r = computeScreenLayout(entry, ctxFor([f]));
    const design = must(r.layout.design);
    expect(design.layers.map((l) => [l.id, l.kind])).toEqual([
      [layerIdFor('5:1'), 'text'],
      [layerIdFor('5:5'), 'image'],
    ]);
    expect(design.layers[0]?.text).toMatchObject({ content: 'Spot the parallel sides', fontFamily: 'Nunito', substituted: true });
    expect(design.regions.instruction).toEqual({ x: 100, y: 180, w: 1200, h: 120 });
    expect(design.backgroundAssetId).toBe('ast_bg');
    expect(r.warnings.join(' ')).toMatch(/“Mascot artwork” \(artwork\) is not in the editable subset/);
    // PowerPoint keeps the wording role: no instruction is taken from the design.
    expect(r.wording).toEqual({});
    expect(r.layout).toMatchObject({ background: 'ast_bg' });
  });

  it('takes wording from the design only when the creator gives Figma that role', () => {
    const entry = row({ frames: [{ frameId: f.id, state: 'default', primary: true }], roles: { content: 'figma', layout: 'figma', artwork: 'uploads' }, layers: [{ elementId: '5:3', use: 'instruction-region' }] });
    expect(computeScreenLayout(entry, ctxFor([f])).wording).toEqual({ instruction: 'Sort each shape: does it have parallel sides?', title: 'Spot the parallel sides' });
  });

  it('refuses rows that cannot be built and warns about doubled text', () => {
    const ctx = ctxFor([f]);
    const bad = validateMapping(
      {
        screens: [
          row({ roles: { content: 'ppt', layout: 'figma', artwork: 'uploads' } }),
          { ...emptyScreen('scn_gone', 'scene', 'Removed scene'), slideIds: [] },
          { ...emptyScreen('title', 'title', 'Title'), assets: { character: 'ast_chime', characterClip: null, panel: null, button: null } },
          { ...emptyScreen('completion', 'completion', 'Completion'), assets: { character: 'ast_bg', characterClip: 'wave', panel: null, button: null } },
        ],
      },
      ctx,
    );
    expect(bad.errors).toEqual([
      '“Spot the parallel sides” uses the Figma layout but no frame is linked. Link a frame or choose the built-in layout.',
      '“Removed scene” is not a screen of the current blueprint.',
      '“Title” character: choose an image, not audio.',
      '“Completion”: a clip needs a sprite character; a static picture has no frames.',
    ]);
    const doubled = validateMapping({ screens: [row({ frames: [{ frameId: f.id, state: 'default', primary: true }], background: { kind: 'frame-render', assetId: null, frameId: f.id, elementId: null, confirmedClean: false } })] }, ctx);
    expect(doubled.errors).toEqual([]);
    expect(doubled.warnings.join(' ')).toMatch(/would appear twice/);
    const clean = validateMapping({ screens: [row({ frames: [{ frameId: f.id, state: 'default', primary: true }], background: { kind: 'frame-render', assetId: null, frameId: f.id, elementId: null, confirmedClean: true } })] }, ctx);
    expect(clean.warnings.filter((w) => /appear twice/.test(w))).toEqual([]);
    // Screens of the blueprint that are missing from the map are reported, not invented.
    expect(clean.warnings).toEqual(['Screen title is not in the map yet.', 'Screen completion is not in the map yet.']);
  });

  it('blocks showing design text the creator resolved in favour of the lesson', () => {
    const entry = row({
      frames: [{ frameId: f.id, state: 'default', primary: true }],
      roles: { content: 'ppt', layout: 'figma', artwork: 'uploads' },
      layers: [{ elementId: '5:2', use: 'layer' }],
      conflicts: [
        {
          id: 'cf-identify-1',
          kind: 'instruction',
          pptText: 'Sort each shape by whether it has parallel sides.',
          pptSlideIds: ['sld_a'],
          figmaText: 'Sort each shape: does it have parallel sides?',
          figmaFrameId: f.id,
          figmaElementId: '5:2',
          message: 'Different wording.',
          detectedBy: 'rule',
          status: 'resolved',
          resolution: { choice: 'ppt', text: null, note: '', at: '2026-01-01T00:00:00.000Z' },
        },
      ],
    });
    expect(validateMapping({ screens: [entry] }, ctxFor([f])).errors.join(' ')).toMatch(/you chose the PowerPoint wording, so it cannot be shown as a layer/);
  });
});
