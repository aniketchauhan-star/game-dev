import { describe, expect, it } from 'vitest';
import { computeCoverage } from '@shared/coverage.ts';
import type { LearningAnalysis } from '@shared/schemas/analysis.ts';
import { coverageSchema } from '@shared/schemas/records.ts';
import { makeBlueprint, makeBlueprintScene, must } from './helpers.ts';

const slide = (n: number, included: boolean, hidden = false) => ({ id: `sld_slide000${n}`, slideNumber: n, hidden, included, title: `Slide ${n}` });

// 1 covered, 2 covered twice, 3 included but unused, 4 excluded, 5 hidden (excluded by default), 6 hidden but included and used.
const SLIDES = [slide(1, true), slide(2, true), slide(3, true), slide(4, false), slide(5, false, true), slide(6, true, true)];

const BLUEPRINT = makeBlueprint([
  makeBlueprintScene('scn_a', { sourceSlideIds: ['sld_slide0001', 'sld_slide0002'], next: 'scn_b' }),
  makeBlueprintScene('scn_b', { sourceSlideIds: ['sld_slide0002', 'sld_slide0006'], next: 'scn_c' }),
  makeBlueprintScene('scn_c', { sourceSlideIds: [], addedPractice: true, next: null }),
]);

const ANALYSIS: LearningAnalysis = {
  schemaVersion: 1,
  topic: 'Coordinates',
  summary: 'Plotting points.',
  concepts: [
    { id: 'c-plot', name: 'Plotting', description: 'Ordered pairs', sourceSlideIds: ['sld_slide0001'] },
    { id: 'c-quad', name: 'Quadrants', description: 'Signs', sourceSlideIds: ['sld_slide0002', 'sld_slide0003'] },
    { id: 'c-dist', name: 'Distance', description: 'Not used', sourceSlideIds: ['sld_slide0003'] },
  ],
  prerequisites: [],
  objectives: [{ id: 'o1', text: 'Plot points.', sourceSlideIds: ['sld_slide0001'], addedPractice: false, status: 'proposed', origin: 'demo', locked: false }],
  examples: [],
  questions: [],
  interactions: [],
  openQuestions: [],
};

describe('computeCoverage', () => {
  const coverage = computeCoverage(SLIDES, BLUEPRINT, ANALYSIS, 'bpr_test000001');
  const row = (n: number) => must(coverage.slides.find((s) => s.slideNumber === n), `slide ${n}`);

  it('produces a schema-valid coverage record', () => {
    expect(coverageSchema.safeParse(coverage).success).toBe(true);
    expect(coverage.blueprintRevisionId).toBe('bpr_test000001');
  });

  it('counts covered, not covered, excluded and added-practice scenes', () => {
    expect(coverage.summary).toEqual({ included: 4, covered: 3, notCovered: 1, excluded: 2, addedPracticeScenes: 1 });
  });

  it('gives each slide a status and an explanation', () => {
    expect(row(1)).toMatchObject({ status: 'covered', sceneIds: ['scn_a'], note: null });
    expect(row(2)).toMatchObject({ status: 'covered', sceneIds: ['scn_a', 'scn_b'], note: 'Used by 2 scenes.' });
    expect(row(3)).toMatchObject({ status: 'not-covered', sceneIds: [], note: 'Included but not used by any scene.' });
    expect(row(4)).toMatchObject({ status: 'excluded', note: 'Excluded by the creator.' });
    expect(row(5).status).toBe('hidden');
    expect(row(5).note).toContain('Hidden in the deck');
    expect(row(6)).toMatchObject({ status: 'covered', sceneIds: ['scn_b'] });
  });

  it('keeps slides in deck order', () => {
    expect(coverage.slides.map((s) => s.slideNumber)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('lists slides used by more than one scene as duplicates', () => {
    expect(coverage.duplicates).toEqual([{ slideId: 'sld_slide0002', slideNumber: 2, sceneIds: ['scn_a', 'scn_b'] }]);
  });

  it('maps scenes to slide numbers and marks added practice', () => {
    expect(coverage.scenes).toEqual([
      { sceneId: 'scn_a', title: 'Scene scn_a', slideNumbers: [1, 2], addedPractice: false },
      { sceneId: 'scn_b', title: 'Scene scn_b', slideNumbers: [2, 6], addedPractice: false },
      { sceneId: 'scn_c', title: 'Scene scn_c', slideNumbers: [], addedPractice: true },
    ]);
  });

  it('maps concepts to the scenes that use their slides', () => {
    expect(coverage.concepts).toEqual([
      { conceptId: 'c-plot', name: 'Plotting', slideIds: ['sld_slide0001'], sceneIds: ['scn_a'] },
      { conceptId: 'c-quad', name: 'Quadrants', slideIds: ['sld_slide0002', 'sld_slide0003'], sceneIds: ['scn_a', 'scn_b'] },
      { conceptId: 'c-dist', name: 'Distance', slideIds: ['sld_slide0003'], sceneIds: [] },
    ]);
    expect(row(2).conceptIds).toEqual(['c-quad']);
    expect(row(3).conceptIds).toEqual(['c-quad', 'c-dist']);
  });

  it('ignores scene references to slides that are not in the deck', () => {
    const blueprint = makeBlueprint([makeBlueprintScene('scn_a', { sourceSlideIds: ['sld_slide0001', 'sld_missing1'] })]);
    const c = computeCoverage(SLIDES, blueprint, null, null);
    expect(c.scenes[0]?.slideNumbers).toEqual([1]);
    expect(c.slides.map((s) => s.slideId)).not.toContain('sld_missing1');
  });

  it('reports every included slide as not covered when there is no blueprint yet', () => {
    const c = computeCoverage(SLIDES, null, null, null);
    expect(c.summary).toEqual({ included: 4, covered: 0, notCovered: 4, excluded: 2, addedPracticeScenes: 0 });
    expect(c.slides.filter((s) => s.status === 'not-covered').every((s) => s.note === 'No blueprint yet.')).toBe(true);
    expect(c.scenes).toEqual([]);
    expect(c.concepts).toEqual([]);
  });

  it('counts a scene once even if it cites the same slide twice', () => {
    const blueprint = makeBlueprint([makeBlueprintScene('scn_a', { sourceSlideIds: ['sld_slide0001', 'sld_slide0001'] })]);
    const c = computeCoverage(SLIDES, blueprint, null, null);
    const first = must(c.slides[0]);
    expect(first.sceneIds).toEqual(['scn_a']);
    expect(first.note).toBeNull();
    expect(c.duplicates).toEqual([]);
  });
});
