import { describe, expect, it } from 'vitest';
import { isBuildableSceneType, MECHANICS, SCENE_TYPES, UNSUPPORTED_MESSAGE } from '@shared/registry.ts';
import { mechanicId } from '@shared/schemas/common.ts';
import { buildableInteractionSchema, sceneInteractionSchema } from '@shared/schemas/interaction.ts';
import { overlap, suggestPageMapping, tokens } from '@shared/similarity.ts';

const ALL_SCENE_TYPES = ['info', 'coordinate-navigation', 'drag-match', 'sequence-sort', 'custom'];

describe('registry', () => {
  it('describes every mechanic id exactly once', () => {
    expect(Object.keys(MECHANICS).sort()).toEqual([...mechanicId.options].sort());
    for (const [id, info] of Object.entries(MECHANICS)) expect(info.id).toBe(id);
  });

  it('only the custom mechanic is blueprint-only', () => {
    const notBuildable = Object.values(MECHANICS).filter((m) => !m.buildable).map((m) => m.id);
    expect(notBuildable).toEqual(['custom']);
  });

  it('buildable mechanics only offer buildable scene types', () => {
    for (const m of Object.values(MECHANICS)) {
      if (m.buildable) for (const t of m.sceneTypes) expect(isBuildableSceneType(t), `${m.id} → ${t}`).toBe(true);
    }
    expect(MECHANICS.custom.sceneTypes).toContain('custom');
  });

  it('lists every scene type, with custom as the only unbuildable one', () => {
    expect(Object.keys(SCENE_TYPES).sort()).toEqual([...ALL_SCENE_TYPES].sort());
    expect(Object.values(SCENE_TYPES).filter((t) => !t.buildable).map((t) => t.type)).toEqual(['custom']);
  });

  it.each(['info', 'coordinate-navigation', 'drag-match', 'sequence-sort'])('%s is buildable', (t) => {
    expect(isBuildableSceneType(t)).toBe(true);
  });

  it.each(['custom', '', 'unknown', 'constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', 'INFO'])('%j is not buildable', (t) => {
    expect(isBuildableSceneType(t)).toBe(false);
  });

  it('the game schema only accepts buildable interactions, while blueprints may hold custom ones', () => {
    const custom = { type: 'custom', description: 'A timed card-flip memory game.' };
    expect(sceneInteractionSchema.safeParse(custom).success).toBe(true);
    expect(buildableInteractionSchema.safeParse(custom).success).toBe(false);
    expect(UNSUPPORTED_MESSAGE).toMatch(/blueprint/i);
  });
});

describe('similarity (slide ↔ reference page suggestions)', () => {
  it('tokens drops short words and stop words, lowercases and strips accents', () => {
    expect([...tokens('The Coordinate Plane, and (x, y)!')].sort()).toEqual(['coordinate', 'plane']);
    expect([...tokens('Café crème')].sort()).toEqual(['cafe', 'creme']);
    expect(tokens('a an of to')).toEqual(new Set());
  });

  it('overlap scores shared words against the smaller vocabulary', () => {
    expect(overlap(new Set(['a1x', 'b2x', 'c3x']), new Set(['a1x', 'b2x', 'zzz', 'yyy']))).toEqual({ shared: 2, score: 2 / 3 });
    expect(overlap(new Set(), new Set(['abc']))).toEqual({ shared: 0, score: 0 });
  });

  it('suggests pages in order and leaves unmatched slides empty', () => {
    const slides = [
      { id: 's1', text: 'Plotting points on the coordinate plane' },
      { id: 's2', text: 'Quadrants and signs of coordinates' },
      { id: 's3', text: 'Hidden slide about the distance formula' },
    ];
    const pages = [
      { number: 1, text: 'Plotting points: the coordinate plane explained' },
      { number: 2, text: 'Quadrants: signs of coordinates in each quadrant' },
    ];
    expect(suggestPageMapping(slides, pages)).toEqual([
      { slideId: 's1', pageNumber: 1, sharedWords: 4 },
      { slideId: 's2', pageNumber: 2, sharedWords: 3 },
      { slideId: 's3', pageNumber: null, sharedWords: 0 },
    ]);
  });

  it('never suggests crossing pairs: order is preserved', () => {
    const slides = [
      { id: 'a', text: 'runway tower hangar' },
      { id: 'b', text: 'quadrant signs axis' },
    ];
    const pages = [
      { number: 1, text: 'quadrant signs zebra' },
      { number: 2, text: 'runway tower hangar' },
    ];
    expect(suggestPageMapping(slides, pages)).toEqual([
      { slideId: 'a', pageNumber: 2, sharedWords: 3 },
      { slideId: 'b', pageNumber: null, sharedWords: 0 },
    ]);
  });

  it('requires at least two shared words before suggesting a page', () => {
    const r = suggestPageMapping([{ id: 'a', text: 'runway lights' }], [{ number: 1, text: 'runway markings' }]);
    expect(r).toEqual([{ slideId: 'a', pageNumber: null, sharedWords: 0 }]);
  });
});
