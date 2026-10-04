import type { GameConfig } from '@shared/schemas/game.ts';
import { gradeLabel, type GradeAdaptationPlan, type GradeProfile } from '@shared/schemas/grade.ts';
import { presetGradePlan } from '@shared/grade/presetPlan.ts';
import { aiGradePlanSchema } from '../../claude/schemas.ts';
import { GRADE_SYSTEM } from '../../claude/prompts.ts';
import { currentGradeProfile, insertGradePlan } from '../../db/grade.ts';
import { approvedBlueprint, latestBlueprint } from '../../db/learning.ts';
import { currentVersion } from '../../db/versions.ts';
import { demoGradePlan } from '../../demo/trapezium.ts';
import { buildBranch } from '../../services/build.ts';
import { gradeContext, normalizeAiGrade } from '../../services/grade.ts';
import { JobFailure, type JobContext } from '../context.ts';

/** Claude (live), the sample's prepared plan (demo), or the product preset rules (local). */
export async function generateGradePlan(
  ctx: JobContext,
  config: GameConfig,
  profile: GradeProfile,
  fromGrade: string | null,
  mode: 'presentation' | 'challenge',
): Promise<{ plan: GradeAdaptationPlan; origin: 'claude' | 'preset' | 'demo'; model: string | null }> {
  const toGrade = gradeLabel(profile);
  if (ctx.mode === 'live') {
    ctx.stage('grade-plan', `Asking Claude for a ${mode === 'presentation' ? 'presentation-only' : 'presentation + learning challenge'} plan for ${toGrade}`);
    const r = await ctx.app.gateway.structured(
      { system: GRADE_SYSTEM, content: gradeContext(ctx.app, ctx.projectId, config, profile, fromGrade, mode), schema: aiGradePlanSchema, maxTokens: 12000, effort: 'medium' },
      ctx.claude('grade-plan'),
    );
    ctx.recordCall(r);
    ctx.stage('grade-validate', 'Checking plan items against scenes, fields and locks');
    return { plan: normalizeAiGrade(config, r.data, mode), origin: 'claude', model: r.model };
  }
  const demo = ctx.mode === 'demo' ? demoGradePlan(config, profile, mode) : null;
  if (demo) {
    ctx.stage('grade-demo', 'Demo mode — prepared sample plan, not Claude');
    return { plan: normalizeAiGrade(config, demo, mode), origin: 'demo', model: null };
  }
  ctx.stage('grade-rules', 'Applying the product preset rules (no AI)');
  return { plan: presetGradePlan(config, profile, mode), origin: 'preset', model: null };
}

/**
 * Grade Adaptation Plan: a before/after proposal for the grade profile, made
 * against the current game (or, before the first build, the game the approved
 * blueprint would build). Nothing changes until the creator accepts items.
 */
export async function handleGradePlan(ctx: JobContext<'grade_plan'>) {
  const { app } = ctx;
  const { branchId, mode } = ctx.input();
  const profile = currentGradeProfile(app.db, branchId);
  if (!profile) throw new JobFailure('Set the grade & learning profile first.', 'no_profile', false);
  const base = currentVersion(app.db, ctx.projectId, branchId);
  let config: GameConfig;
  let basis: { blueprintRevisionId: string | null; blueprintRevisionNumber: number | null; screenMapNumber: number | null };
  if (base) {
    config = base.config;
    basis = { blueprintRevisionId: base.blueprintRevisionId, blueprintRevisionNumber: base.blueprintRevisionNumber, screenMapNumber: base.config.meta.screenMapNumber ?? null };
  } else {
    const rev = approvedBlueprint(app.db, ctx.projectId, branchId) ?? latestBlueprint(app.db, ctx.projectId, branchId);
    if (!rev) throw new JobFailure('Create the blueprint first: the plan adapts the game it describes.', 'no_blueprint', false);
    ctx.stage('candidate', `Compiling blueprint r${rev.number} to see the game it would build`);
    const built = buildBranch(app, ctx.projectId, rev, { carryMotion: false, allowDraft: true });
    if (!built.config) throw new JobFailure(`Blueprint r${rev.number} cannot be built yet: ${built.errors[0] ?? 'invalid'}`, 'not_buildable', false);
    config = built.config;
    basis = { blueprintRevisionId: rev.id, blueprintRevisionNumber: rev.number, screenMapNumber: built.screenMapNumber };
  }
  const fromGrade = base ? config.meta.gradeLabel || null : null;
  const toGrade = gradeLabel(profile.profile);
  const { plan, origin, model } = await generateGradePlan(ctx, config, profile.profile, fromGrade, mode);
  const record = insertGradePlan(app.db, {
    projectId: ctx.projectId,
    branchId,
    profile,
    fromGrade,
    toGrade,
    mode,
    origin,
    model,
    jobId: ctx.jobId,
    baseVersionId: base?.id ?? null,
    basis,
    plan,
  });
  ctx.event('info', `Grade plan ${record.number}: ${plan.items.filter((i) => i.change).length} change(s), ${plan.items.filter((i) => !i.change).length} note(s) to review.`);
  return { planId: record.id };
}
