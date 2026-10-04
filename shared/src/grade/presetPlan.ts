import type { GameConfig } from '../schemas/game.ts';
import { gradeLabel, GRADE_PRESETS, PRESET_DISCLAIMER, type AdaptationItem, type GradeAdaptationPlan, type GradeProfile } from '../schemas/grade.ts';

/**
 * A grade plan from the product presets alone (no AI). It only changes things
 * a rule can decide honestly — layout density and progress display — and
 * turns everything that needs new wording into advice for the creator. It
 * never writes new learner-facing text.
 */
export function presetGradePlan(config: GameConfig, profile: GradeProfile, mode: 'presentation' | 'challenge'): GradeAdaptationPlan {
  const items: AdaptationItem[] = [];
  const label = gradeLabel(profile);
  const young = profile.grade !== 'custom' && profile.grade <= 5;
  const wantDensity: 'comfortable' | 'compact' = young || profile.readingSupport !== 'standard' ? 'comfortable' : 'compact';
  const interactive = config.scenes.filter((s) => s.interaction.type !== 'info');
  let n = 0;
  const id = (k: string) => `${k}-${++n}`;

  if (config.scenes.some((s) => s.layout.density !== wantDensity)) {
    items.push({
      id: id('density'),
      area: 'layout',
      sceneId: null,
      change: { field: 'layout.density', value: wantDensity },
      summary: wantDensity === 'compact' ? 'Use cleaner, more compact instruction panels.' : 'Keep instruction panels roomy and easy to read.',
      rationale: wantDensity === 'compact' ? `${label} with standard reading support: shorter panels leave more room for the task.` : `${profile.readingSupport === 'standard' ? label : `${profile.readingSupport} reading support`}: larger text and spacing help reading.`,
      sourceSlideIds: [],
      addedPractice: false,
      changesLearning: false,
    });
  }
  if (profile.presetId === 'g3-5' || young) {
    for (const s of config.scenes.filter((x) => !x.layout.showProgress)) {
      items.push({ id: id('progress'), area: 'layout', sceneId: s.id, change: { field: 'layout.showProgress', value: true }, summary: `Show progress on “${s.title}”.`, rationale: 'Visible progress helps learners follow short task sequences.', sourceSlideIds: s.sourceSlideIds, addedPractice: false, changesLearning: false });
    }
  }
  const wantHints = profile.guidance === 'extra' || profile.access.extraGuidance ? 3 : profile.guidance === 'minimal' ? 1 : 2;
  for (const s of interactive) {
    if (s.feedback.hints.length < wantHints) {
      items.push({
        id: id('hints'),
        area: 'hints',
        sceneId: s.id,
        change: null,
        summary: `“${s.title}” has ${s.feedback.hints.length} hint(s); ${profile.guidance} guidance suggests ${wantHints}.`,
        rationale: 'Write the extra hint yourself in the inspector, or ask Claude for a wording plan. Preset rules never write learner-facing text.',
        sourceSlideIds: s.sourceSlideIds,
        addedPractice: false,
        changesLearning: false,
      });
    }
    const words = s.instruction.split(/\s+/).filter(Boolean).length;
    const limit = profile.readingSupport === 'extended' ? 14 : profile.readingSupport === 'supported' ? 20 : 30;
    if (words > limit) {
      items.push({
        id: id('wording'),
        area: 'language',
        sceneId: s.id,
        change: null,
        summary: `The instruction on “${s.title}” has ${words} words; ${profile.readingSupport} reading support suggests at most about ${limit}.`,
        rationale: 'Shorter instructions with one action each are easier to follow. Shorten it yourself or ask Claude for a wording plan.',
        sourceSlideIds: s.sourceSlideIds,
        addedPractice: false,
        changesLearning: false,
      });
    }
  }
  if (mode === 'challenge') {
    items.push({
      id: id('challenge'),
      area: 'difficulty',
      sceneId: null,
      change: null,
      summary: `Review question difficulty for ${profile.difficulty} level in the blueprint.`,
      rationale: 'Changing questions, items or answer rules needs instructional review and blueprint approval; preset rules do not invent new questions.',
      sourceSlideIds: [],
      addedPractice: false,
      changesLearning: true,
    });
  }
  const preset = profile.presetId ? GRADE_PRESETS[profile.presetId] : null;
  return {
    summary: `Preset-rule plan for ${label} (${mode === 'presentation' ? 'presentation only' : 'presentation + learning challenge'}): ${items.filter((i) => i.change).length} concrete change(s) and ${items.filter((i) => !i.change).length} note(s). No wording was rewritten — that needs your edits or Claude.`,
    items: items.slice(0, 40),
    motionPurpose:
      profile.motion.profile === 'minimal'
        ? 'Motion only where it explains something (a highlight, a snap on a valid drop); no decoration.'
        : profile.motion.profile === 'playful'
          ? 'Purposeful motion first, plus small, skippable celebrations.'
          : `Guided motion: a calm entrance, highlights that point at the task, and clear feedback on drops and answers${profile.motion.pacing === 'calm' ? ', at a calm pace' : ''}.`,
    assumptions: [preset ? `${preset.label}: ${preset.summary.join('; ')}.` : `${label}: no product preset (custom group).`, PRESET_DISCLAIMER, 'Grade gives starting suggestions only; nothing about individual learners is inferred.'],
    curriculumNote: profile.curriculum ? `Curriculum “${profile.curriculum}” is recorded but alignment is not verified.` : 'Curriculum alignment is not verified.',
  };
}
