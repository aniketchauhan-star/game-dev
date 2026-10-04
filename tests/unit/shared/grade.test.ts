import { describe, expect, it } from 'vitest';
import { presetGradePlan } from '@shared/grade/presetPlan.ts';
import { gradeAdaptationPlanSchema, gradeLabel, profileForGrade, PRESET_DISCLAIMER, type GradeAdaptationPlan } from '@shared/schemas/grade.ts';
import { applyChangeOps } from '@shared/schemas/proposal.ts';
import { gradePlanOps } from '@shared/plans.ts';
import { makeGameConfig } from './helpers.ts';

describe('grade profiles', () => {
  it('seeds separate settings from labelled product presets', () => {
    const g2 = profileForGrade(2);
    expect(g2).toMatchObject({ grade: 2, presetId: 'g1-2', difficulty: 'foundational', readingSupport: 'extended', guidance: 'extra' });
    const g11 = profileForGrade(11, { curriculum: 'IB MYP', language: 'en-GB' });
    expect(g11).toMatchObject({ presetId: 'g9-12', difficulty: 'stretch', guidance: 'minimal', curriculum: 'IB MYP', language: 'en-GB' });
    expect(g11.motion).toMatchObject({ profile: 'minimal', decorativeIntensity: 'off' });
    const custom = profileForGrade('custom', { customLabel: 'Adult learners' });
    expect(custom.presetId).toBeNull();
    expect(gradeLabel(custom)).toBe('Adult learners');
    // Accessibility options are available to every grade.
    for (const g of [1, 6, 12] as const) expect(profileForGrade(g).access).toMatchObject({ untimed: true, keyboard: true });
  });
});

describe('presetGradePlan (no AI)', () => {
  it('only changes what a rule can decide and never writes learner-facing text', () => {
    const config = makeGameConfig();
    config.scenes[1]!.layout.density = 'compact';
    // Grades 1–2 preset: extra guidance suggests 3 hints; the fixture scenes have 2.
    const plan = presetGradePlan(config, profileForGrade(2), 'presentation');
    expect(gradeAdaptationPlanSchema.safeParse(plan).success).toBe(true);
    for (const item of plan.items) {
      if (item.change) expect(['layout.density', 'layout.showProgress']).toContain(item.change.field);
      expect(item.changesLearning).toBe(false);
    }
    const hints = plan.items.filter((i) => i.area === 'hints');
    expect(hints.length).toBe(3);
    expect(hints.every((i) => i.change === null && /never write learner-facing text/.test(i.rationale))).toBe(true);
    expect(plan.items.filter((i) => i.change?.field === 'layout.density').map((i) => i.change!.value)).toEqual(['comfortable']);
    expect(plan.assumptions).toContain(PRESET_DISCLAIMER);
    expect(plan.curriculumNote).toBe('Curriculum alignment is not verified.');
  });

  it('routes learning changes to blueprint review in challenge mode', () => {
    const config = makeGameConfig();
    const plan = presetGradePlan(config, profileForGrade(9, { curriculum: 'GCSE' }), 'challenge');
    const learning = plan.items.filter((i) => i.changesLearning);
    expect(learning).toHaveLength(1);
    expect(learning[0]!.change).toBeNull();
    expect(plan.curriculumNote).toMatch(/“GCSE” is recorded but alignment is not verified/);
  });
});

describe('gradePlanOps', () => {
  it('applies only accepted presentation changes and never learning changes', () => {
    const config = makeGameConfig();
    const plan: GradeAdaptationPlan = {
      summary: 'Test plan',
      motionPurpose: 'Purposeful motion.',
      assumptions: [],
      curriculumNote: '',
      items: [
        { id: 'wording-1', area: 'language', sceneId: 'scn_taxi', change: { field: 'instruction', value: 'Move the plane to the runway.' }, summary: 'Shorter instruction', rationale: 'r', sourceSlideIds: ['sld_slide0002'], addedPractice: false, changesLearning: false },
        { id: 'density-1', area: 'layout', sceneId: null, change: { field: 'layout.density', value: 'compact' }, summary: 'Compact panels', rationale: 'r', sourceSlideIds: [], addedPractice: false, changesLearning: false },
        { id: 'hard-1', area: 'difficulty', sceneId: 'scn_quad', change: { field: 'instruction', value: 'Harder!' }, summary: 'Harder question', rationale: 'r', sourceSlideIds: [], addedPractice: true, changesLearning: true },
        { id: 'rejected-1', area: 'feedback', sceneId: 'scn_quad', change: { field: 'feedback.success', value: 'Brilliant!' }, summary: 'Praise', rationale: 'r', sourceSlideIds: [], addedPractice: false, changesLearning: false },
      ],
    };
    const { ops, notes } = gradePlanOps(plan, { 'wording-1': 'accepted', 'density-1': 'accepted', 'hard-1': 'accepted', 'rejected-1': 'rejected' }, config);
    expect(ops).toEqual([
      { op: 'set-scene-field', sceneId: 'scn_taxi', field: 'instruction', value: 'Move the plane to the runway.' },
      ...config.scenes.map((s) => ({ op: 'set-scene-field', sceneId: s.id, field: 'layout.density', value: 'compact' })),
    ]);
    expect(notes.join(' ')).toMatch(/goes through blueprint review/);
    const r = applyChangeOps(config, ops, { scope: { kind: 'project', sceneId: null } });
    expect(r.ok).toBe(true);
    // Answer rules are untouched by presentation changes.
    expect(r.config.scenes.map((s) => s.interaction)).toEqual(config.scenes.map((s) => s.interaction));
  });
});
