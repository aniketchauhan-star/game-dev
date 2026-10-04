import type { JobInput, JobType } from '@shared/schemas/jobs.ts';
import { suggestMapping } from '@shared/screens/suggest.ts';
import { mergeWithBlueprint } from '@shared/screens/suggest.ts';
import { isBuildableSceneType } from '@shared/registry.ts';
import { toGameAsset } from '@shared/assetsToGame.ts';
import { listAssetRows, toAsset } from '../../db/assets.ts';
import { currentGradeProfile, insertGradePlan } from '../../db/grade.ts';
import { currentAnalysis, latestBlueprint } from '../../db/learning.ts';
import { insertMotionPlan, supersedeStagedMotionPlans } from '../../db/motion.ts';
import { currentScreenMap, insertScreenMap } from '../../db/screens.ts';
import { listSlides } from '../../db/sources.ts';
import { aiMotionPlanSchema } from '../../claude/schemas.ts';
import { MOTION_SYSTEM } from '../../claude/prompts.ts';
import { buildBranch } from '../../services/build.ts';
import { motionContext, normalizeAiMotion } from '../../services/motion.ts';
import { screenSources } from '../../services/screens.ts';
import { JobContext, JobFailure } from '../context.ts';
import { handleAnalyze } from './analyze.ts';
import { handleBlueprint } from './blueprint.ts';
import { generateGradePlan } from './grade.ts';
import { ruleSuggestions } from './motion.ts';

export interface PrepareStage {
  key: 'gameplay' | 'screens' | 'assets' | 'grade' | 'motion';
  status: 'done' | 'review' | 'needs-you' | 'skipped' | 'blocked';
  message: string;
}

/** Run another job type's handler inside this job (same events, stages and cancellation). */
async function runChild<T extends JobType>(ctx: JobContext, type: T, input: JobInput<T>, handler: (c: JobContext<T>) => Promise<unknown>): Promise<unknown> {
  const child = new JobContext<T>(ctx.app, { ...ctx.row, type, input_json: JSON.stringify(input) });
  const onAbort = () => child.controller.abort();
  ctx.signal.addEventListener('abort', onAbort, { once: true });
  try {
    return await handler(child);
  } finally {
    ctx.signal.removeEventListener('abort', onAbort);
    if (child.usage.calls) ctx.addUsage(child.usage, child.usage.calls);
    child.flushText();
  }
}

/**
 * “Prepare my game”: creates reviewable proposals in stages — gameplay
 * (blueprint), Source-to-Screen map with artwork assignments, a grade
 * adaptation plan and a motion plan — staged for the next build. Nothing is
 * built or applied here; “Approve & build” does that after review.
 */
export async function handlePrepare(ctx: JobContext<'prepare'>) {
  const { app } = ctx;
  const { branchId } = ctx.input();
  const stages: PrepareStage[] = [];
  const profile = currentGradeProfile(app.db, branchId);
  if (!profile) throw new JobFailure('Choose the grade first (Grade & learning profile).', 'no_grade', false);
  const slides = listSlides(app.db, ctx.projectId).filter((s) => s.included);

  // 1. Gameplay.
  let rev = latestBlueprint(app.db, ctx.projectId, branchId);
  if (!rev || rev.stale) {
    if (ctx.mode === 'local') {
      stages.push({ key: 'gameplay', status: 'needs-you', message: rev ? `Blueprint r${rev.number} is out of date with the source and Claude is not configured: update it yourself in Blueprint.` : 'Claude is not configured, so no gameplay is invented: write it yourself in Blueprint (“Start one yourself”), then prepare again.' });
    } else if (slides.length === 0) {
      stages.push({ key: 'gameplay', status: 'needs-you', message: 'There are no lesson slides to build gameplay from. Add a deck, or write the gameplay yourself in Blueprint. Nothing is invented to fill the gap.' });
    } else {
      ctx.stage('gameplay', 'Drafting gameplay from the lesson');
      const analysis = currentAnalysis(app.db, ctx.projectId);
      if (!analysis || analysis.stale) await runChild(ctx, 'analyze', {}, handleAnalyze);
      ctx.throwIfCancelled();
      await runChild(ctx, 'blueprint', { analysisId: currentAnalysis(app.db, ctx.projectId)?.id ?? null }, handleBlueprint);
      rev = latestBlueprint(app.db, ctx.projectId, branchId);
      stages.push({ key: 'gameplay', status: 'review', message: `Blueprint r${rev?.number ?? '?'} drafted — review it; Approve & build approves it.` });
    }
  } else {
    stages.push({ key: 'gameplay', status: rev.status === 'approved' ? 'done' : 'review', message: rev.status === 'approved' ? `Blueprint r${rev.number} is approved.` : `Blueprint r${rev.number} is a draft — review it; Approve & build approves it.` });
  }
  if (!rev || rev.stale) {
    for (const key of ['screens', 'assets', 'grade', 'motion'] as const) stages.push({ key, status: 'skipped', message: 'Needs gameplay first.' });
    return { stages, gradePlanId: null, motionPlanId: null };
  }
  const unsupported = rev.blueprint.scenes.filter((s) => !isBuildableSceneType(s.interaction.type));
  if (unsupported.length) {
    stages.push({ key: 'screens', status: 'blocked', message: `${unsupported.length} scene(s) use a custom mechanic that stays blueprint-only (developer handoff). Approve & build is available only for the supported mechanics.` });
    return { stages, gradePlanId: null, motionPlanId: null };
  }

  // 2. Screens and artwork assignments (suggested rows start unreviewed).
  ctx.stage('screens', 'Suggesting the Source-to-Screen map from evidence');
  const current = currentScreenMap(app.db, branchId);
  const src = screenSources(app, ctx.projectId, branchId);
  const suggestion = suggestMapping({ blueprint: rev.blueprint, slides: src.slides, frames: src.frames, assets: src.assets });
  let mapNumber = current?.number ?? null;
  if (!current) {
    const saved = insertScreenMap(app.db, { projectId: ctx.projectId, branchId, blueprintRevisionId: rev.id, origin: 'suggested', note: 'Suggested by Prepare my game — review each row', mapping: suggestion, expectedNumber: 0 });
    mapNumber = saved.number;
    const linked = suggestion.screens.filter((s) => s.frames.length).length;
    const conflicts = suggestion.screens.reduce((n, s) => n + s.conflicts.length, 0);
    stages.push({ key: 'screens', status: 'review', message: `${suggestion.screens.length} screen rows suggested (${linked} linked to design frames by shared words${conflicts ? `, ${conflicts} source conflict(s) flagged` : ''}). Review them in Screens.` });
  } else {
    const merged = mergeWithBlueprint(current.mapping, suggestion);
    if (merged.added.length || merged.removed.length) {
      const saved = insertScreenMap(app.db, { projectId: ctx.projectId, branchId, blueprintRevisionId: rev.id, origin: 'suggested', note: `Blueprint changed: ${merged.added.length} new row(s)`, mapping: merged.mapping, expectedNumber: current.number });
      mapNumber = saved.number;
      stages.push({ key: 'screens', status: 'review', message: `Your reviewed rows are kept; ${merged.added.length} new screen row(s) suggested${merged.removed.length ? `, ${merged.removed.length} removed` : ''}.` });
    } else {
      const unreviewed = current.mapping.screens.filter((s) => !s.reviewed).length;
      stages.push({ key: 'screens', status: unreviewed ? 'review' : 'done', message: unreviewed ? `${unreviewed} screen row(s) still to review.` : 'Every screen row is reviewed.' });
    }
  }
  const assigned = suggestion.screens.filter((s) => s.assets.character || s.assets.panel || s.assets.button || s.background.kind !== 'none').length;
  stages.push({ key: 'assets', status: assigned ? 'review' : 'skipped', message: assigned ? `Artwork suggested for ${assigned} screen(s) from your library (character, background, panel, buttons) — check them in Screens.` : 'No uploaded artwork to assign yet; built-in art is used.' });
  ctx.throwIfCancelled();

  // 3. The game this would build (deterministic), for the plans to refer to.
  ctx.stage('candidate', `Compiling blueprint r${rev.number} with the map and grade profile`);
  const candidate = buildBranch(app, ctx.projectId, rev, { carryMotion: true, allowDraft: true });
  if (!candidate.config) {
    stages.push({ key: 'grade', status: 'blocked', message: `The blueprint cannot be built yet: ${candidate.errors[0] ?? 'invalid'}. Fix it in Blueprint.` });
    stages.push({ key: 'motion', status: 'skipped', message: 'Needs a buildable blueprint.' });
    return { stages, gradePlanId: null, motionPlanId: null };
  }
  const config = candidate.config;

  // 4. Grade adaptation plan, staged for the build.
  const g = await generateGradePlan(ctx, config, profile.profile, null, 'presentation');
  const gradePlan = insertGradePlan(app.db, {
    projectId: ctx.projectId,
    branchId,
    profile,
    fromGrade: null,
    toGrade: config.meta.gradeLabel || 'this grade',
    mode: 'presentation',
    origin: g.origin,
    model: g.model,
    jobId: ctx.jobId,
    baseVersionId: null,
    basis: { blueprintRevisionId: rev.id, blueprintRevisionNumber: rev.number, screenMapNumber: mapNumber },
    plan: g.plan,
  });
  stages.push({ key: 'grade', status: 'review', message: `Grade plan ${gradePlan.number}: ${g.plan.items.filter((i) => i.change).length} change(s) and ${g.plan.items.filter((i) => !i.change).length} note(s) for ${gradePlan.toGrade}${g.origin === 'preset' ? ' (preset rules, no AI)' : g.origin === 'demo' ? ' (demo)' : ''}.` });
  ctx.throwIfCancelled();

  // 5. Motion plan for every screen, staged for the build.
  const library = listAssetRows(app.db, ctx.projectId).map((r) => toGameAsset(toAsset(r)));
  let motion = ruleSuggestions(config, null);
  let origin: 'preset' | 'claude' = 'preset';
  let model: string | null = null;
  if (ctx.mode === 'live') {
    ctx.stage('motion', 'Asking Claude for purposeful motion on every screen');
    const r = await app.gateway.structured(
      { system: MOTION_SYSTEM, content: motionContext(config, { kind: 'project', screenId: null }, { grade: profile.profile, designEvidence: [], request: 'Suggest purposeful, restrained motion for every screen of this game for the grade profile. Explain relationships; give feedback on drops and answers; keep celebrations small.', library }), schema: aiMotionPlanSchema, maxTokens: 14000, effort: 'medium' },
      ctx.claude('prepare-motion'),
    );
    ctx.recordCall(r);
    motion = normalizeAiMotion(config, r.data, { kind: 'project', screenId: null }, profile.revision, library);
    origin = 'claude';
    model = r.model;
  } else ctx.stage('motion', 'Choosing motion presets from each screen’s objects (preset rules, no AI)');
  supersedeStagedMotionPlans(app.db, branchId);
  const motionPlan = insertMotionPlan(app.db, {
    projectId: ctx.projectId,
    branchId,
    gradeProfileRevision: profile.revision,
    origin,
    model,
    jobId: ctx.jobId,
    request: 'Prepare my game',
    scope: { kind: 'project', screenId: null },
    baseVersionId: null,
    basis: { blueprintRevisionId: rev.id, screenMapNumber: mapNumber },
    plan: motion,
  });
  stages.push({ key: 'motion', status: 'review', message: `Motion plan ${motionPlan.number}: ${motion.add.length} animation(s) to review${origin === 'preset' ? ' (preset rules, no AI)' : ''}.` });
  for (const s of stages) ctx.event(s.status === 'blocked' || s.status === 'needs-you' ? 'warning' : 'info', `${s.key}: ${s.message}`);
  return { stages, gradePlanId: gradePlan.id, motionPlanId: motionPlan.id };
}
