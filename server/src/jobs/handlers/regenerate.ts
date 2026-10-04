import { checkInteraction } from '@shared/attainability.ts';
import { blueprintSchema, checkBlueprint, type BlueprintScene } from '@shared/schemas/blueprint.ts';
import { MECHANICS } from '@shared/registry.ts';
import { aiFullSceneSchema, type AiFullScene } from '../../claude/schemas.ts';
import type { StructuredResult } from '../../claude/gateway.ts';
import { allowedMechanicsNote, briefBlock, SCENES_SYSTEM, slideBlock, slideIndex } from '../../claude/prompts.ts';
import { getBlueprintRevision, insertBlueprintRevision } from '../../db/learning.ts';
import { getProjectRow, projectBrief } from '../../db/projects.ts';
import { currentSnapshot, listSlides } from '../../db/sources.ts';
import { JobFailure, type JobContext } from '../context.ts';
import { assetCatalog } from './blueprint.ts';

const clip = (s: string, n: number) => {
  const t = s.trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};

/**
 * Regenerate one scene into a NEW draft revision. Other scenes are copied
 * unchanged; locked parts of the scene are restored from the original.
 */
export async function handleRegenerateScene(ctx: JobContext<'regenerate_scene'>) {
  const { app } = ctx;
  const { blueprintRevisionId, sceneId, guidance } = ctx.input();
  if (ctx.mode === 'demo') {
    throw new JobFailure('Regenerating a scene needs a configured Claude connection. Demo mode only replays the sample’s prepared content — you can still edit this scene by hand.', 'demo_unsupported', false);
  }
  const rev = getBlueprintRevision(app.db, blueprintRevisionId);
  if (rev.projectId !== ctx.projectId) throw new JobFailure('Blueprint revision not found in this project.', 'not_found', false);
  const index = rev.blueprint.scenes.findIndex((s) => s.id === sceneId);
  const old = rev.blueprint.scenes[index];
  if (!old) throw new JobFailure('That scene is no longer in the blueprint.', 'not_found', false);
  const project = getProjectRow(app.db, ctx.projectId);
  const brief = projectBrief(project);
  const slides = listSlides(app.db, ctx.projectId).filter((s) => s.included);
  const included = new Set(slides.map((s) => s.id));
  const sceneSlides = slides.filter((s) => old.sourceSlideIds.includes(s.id));
  const allowed = new Set(MECHANICS[rev.blueprint.coreMechanic].sceneTypes);

  const locked = Object.entries(old.locks).filter(([, v]) => v).map(([k]) => k);
  if (locked.length > 0) ctx.event('info', `Scene locks kept as-is: ${locked.join(', ')}.`);

  const request = [
    briefBlock(brief),
    allowedMechanicsNote(brief),
    `Slide list (cite these ids exactly):\n${slideIndex(slides)}`,
    assetCatalog(app, ctx.projectId),
    sceneSlides.length ? sceneSlides.map((s) => slideBlock(s, { includeNotes: brief.aiInputs.includeSpeakerNotes })).join('\n\n') : 'This scene is added practice (no source slides).',
    `Neighbouring scenes: ${rev.blueprint.scenes.map((s, i) => `${i + 1}. ${s.title} (${s.interaction.type})${s.id === sceneId ? ' ← regenerate this one' : ''}`).join('; ')}`,
    `Current version of the scene:\n${JSON.stringify(old)}`,
    old.locks.wording ? 'The wording of this scene is LOCKED: keep instruction, feedback and hints exactly.' : '',
    old.locks.answer ? 'The correct answers of this scene are LOCKED: keep the interaction exactly.' : '',
    `Creator guidance for the new version: ${guidance.trim() || '(none — improve clarity and learning value while keeping the same source content)'}`,
    'Write a complete replacement for this one scene.',
  ]
    .filter(Boolean)
    .join('\n\n');

  const scene = await ctx.once<AiFullScene>('scene', `Regenerating scene ${index + 1} “${old.title}”`, async () => {
    let previous: string | null = null;
    let problems: string[] = [];
    for (let attempt = 0; ; attempt++) {
      const text: string = previous ? `${request}\n\nYour previous answer:\n${previous}\n\nProblems to fix:\n- ${problems.join('\n- ')}` : request;
      const r: StructuredResult<AiFullScene> = await app.gateway.structured({ system: SCENES_SYSTEM, content: text, schema: aiFullSceneSchema, maxTokens: 12000, effort: 'medium', cacheSystem: true }, ctx.claude('regenerate-scene'));
      const usage = ctx.recordCall(r);
      const d = r.data;
      problems = [];
      if (!allowed.has(d.interaction.type)) problems.push(`Scene type "${d.interaction.type}" is not allowed for this game's interaction.`);
      for (const id of d.sourceSlideIds) if (!included.has(id)) problems.push(`Unknown or excluded slide "${id}".`);
      if (d.sourceSlideIds.length === 0 && !d.addedPractice) problems.push('Cite sourceSlideIds or set addedPractice=true.');
      if (d.addedPractice && !brief.options.allowAddedPractice) problems.push('Added practice is not allowed by the creator.');
      for (const issue of checkInteraction(d.interaction, { seed: 1, sceneId })) if (issue.severity === 'error') problems.push(issue.message);
      if (problems.length === 0) return { output: d, usage };
      if (attempt >= app.config.claude.maxRepairAttempts) throw new JobFailure(`The regenerated scene did not pass validation (${problems.slice(0, 3).join('; ')}). The blueprint is unchanged.`, 'invalid_scene', true);
      ctx.event('warning', `Validation found ${problems.length} problem(s); asking Claude to correct them.`);
      previous = r.rawText.slice(0, 12_000);
    }
  });

  ctx.stage('validate', 'Validating scene configuration');
  const next: BlueprintScene = {
    ...old,
    title: clip(scene.title, 60) || old.title,
    pattern: scene.pattern,
    sourceSlideIds: [...new Set(scene.sourceSlideIds)],
    addedPractice: scene.addedPractice,
    objective: clip(scene.objective, 240) || old.objective,
    visibleContent: clip(scene.visibleContent, 400) || old.visibleContent,
    learnerAction: clip(scene.learnerAction, 240) || old.learnerAction,
    expectedResult: clip(scene.expectedResult, 240) || old.expectedResult,
    instruction: clip(scene.instruction, 220) || old.instruction,
    interaction: scene.interaction,
    successFeedback: clip(scene.successFeedback, 160) || old.successFeedback,
    errorFeedback: clip(scene.errorFeedback, 200) || old.errorFeedback,
    hints: scene.hints.slice(0, 3).map((h) => clip(h, 160)).filter(Boolean),
    completion: clip(scene.completion, 240) || old.completion,
    difficulty: scene.difficulty,
    origin: 'claude',
  };
  if (next.hints.length === 0) next.hints = old.hints;
  // Locks win over the regenerated content.
  if (old.locks.wording) {
    Object.assign(next, { instruction: old.instruction, successFeedback: old.successFeedback, errorFeedback: old.errorFeedback, hints: old.hints, title: old.title });
  }
  if (old.locks.answer) next.interaction = old.interaction;
  if (old.locks.sequence) next.sourceSlideIds = old.sourceSlideIds;

  const blueprint = { ...rev.blueprint, scenes: rev.blueprint.scenes.map((s) => (s.id === sceneId ? next : s)) };
  const parsed = blueprintSchema.safeParse(blueprint);
  if (!parsed.success) throw new JobFailure(`The updated blueprint is invalid (${parsed.error.issues[0]?.message ?? 'schema'}). It was not saved.`, 'invalid_blueprint', true);
  const errors = checkBlueprint(parsed.data, included).filter((i) => i.severity === 'error');
  if (errors.length > 0) throw new JobFailure(`The updated blueprint has a problem: ${errors[0]!.message}. It was not saved.`, 'invalid_blueprint', true);

  ctx.stage('save', 'Saving a new draft revision');
  const { snapshot, revision } = currentSnapshot(app.db, ctx.projectId);
  const saved = insertBlueprintRevision(app.db, {
    projectId: ctx.projectId,
    parentId: rev.id,
    origin: 'claude',
    model: ctx.modelUsed,
    jobId: ctx.jobId,
    analysisId: rev.analysisId,
    sourceRevision: revision,
    snapshot,
    blueprint: parsed.data,
  });
  ctx.event('info', `Draft r${saved.number} created with scene ${index + 1} regenerated. r${rev.number} is unchanged.`);
  return { blueprintRevisionId: saved.id, number: saved.number, sceneId };
}
