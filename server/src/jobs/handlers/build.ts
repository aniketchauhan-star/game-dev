import { getGradePlan, resolveGradePlan } from '../../db/grade.ts';
import { getBlueprintRevision } from '../../db/learning.ts';
import { getMotionPlan, resolveMotionPlan } from '../../db/motion.ts';
import { currentVersion, insertVersion } from '../../db/versions.ts';
import { buildBranch } from '../../services/build.ts';
import { JobFailure, type JobContext } from '../context.ts';

/**
 * Build a playable version from an exact, approved blueprint revision, the
 * grade version's screen map and grade profile, and (for “Approve & build”)
 * the accepted rows of staged grade and motion plans. No AI call. A failure
 * leaves the previous playable version current.
 */
export async function handleBuild(ctx: JobContext<'build'>) {
  const { app } = ctx;
  const input = ctx.input();
  const rev = getBlueprintRevision(app.db, input.blueprintRevisionId);
  if (rev.projectId !== ctx.projectId) throw new JobFailure('Blueprint revision not found in this project.', 'not_found', false);
  if (rev.status !== 'approved') {
    throw new JobFailure(`Blueprint r${rev.number} is ${rev.status}. Only an approved revision can be built.`, 'not_approved', false);
  }
  const gradePlan = input.gradePlanId ? getGradePlan(app.db, input.gradePlanId) : null;
  const motionPlan = input.motionPlanId ? getMotionPlan(app.db, input.motionPlanId) : null;
  for (const p of [gradePlan, motionPlan]) {
    if (p && (p.projectId !== ctx.projectId || p.status !== 'proposed')) throw new JobFailure(`A staged plan is ${p?.status ?? 'missing'}; prepare the game again.`, 'plan_not_open', false);
  }
  ctx.stage('validate', `Validating approved blueprint r${rev.number}`);
  ctx.stage('compile', 'Compiling scenes with the trusted game templates');
  for (const [i, s] of rev.blueprint.scenes.entries()) ctx.event('info', `Scene ${i + 1}: ${s.title} (${s.interaction.type})`);
  ctx.throwIfCancelled();
  const result = buildBranch(app, ctx.projectId, rev, { carryMotion: input.carryMotion, gradePlan, motionPlan });
  ctx.stage('check', 'Checking that every scene can be completed');
  if (result.screenMapNumber) ctx.event('info', `Using screen map ${result.screenMapNumber} (layout, exact artwork, regions).`);
  if (result.gradeProfileRevision) ctx.event('info', `Using grade profile revision ${result.gradeProfileRevision}.`);
  for (const w of result.warnings) ctx.event('warning', w);
  for (const n of result.planResults.notes) ctx.event('info', n);
  for (const r of [...result.planResults.grade, ...result.planResults.motion]) {
    if (r.status === 'conflict' || r.status === 'invalid') ctx.event('warning', `Not applied — ${r.where ?? r.target}: ${r.message ?? r.status}`);
  }
  if (!result.config) {
    for (const e of result.errors) ctx.event('error', e);
    throw new JobFailure(`The build stopped: ${result.errors[0] ?? 'invalid configuration'}${result.errors.length > 1 ? ` (+${result.errors.length - 1} more)` : ''}. The previous playable version is unchanged.`, 'build_invalid', false);
  }
  ctx.throwIfCancelled();
  ctx.stage('save', 'Saving the new playable version');
  const parent = currentVersion(app.db, ctx.projectId, result.branchId);
  const applied = (rs: typeof result.planResults.grade) => rs.filter((r) => r.status === 'applied').length;
  const version = app.db.tx(() => {
    const v = insertVersion(app.db, {
      projectId: ctx.projectId,
      config: result.config!,
      origin: 'build',
      summary: `Built from blueprint r${rev.number}${gradePlan || motionPlan ? ` with ${applied(result.planResults.grade)} grade and ${applied(result.planResults.motion)} motion change(s)` : ''}`,
      blueprintRevisionId: rev.id,
      blueprintRevisionNumber: rev.number,
      parentVersionId: parent?.id ?? null,
      demo: rev.origin === 'demo',
      branchId: result.branchId,
    });
    if (gradePlan) resolveGradePlan(app.db, gradePlan.id, 'applied', { resultVersionId: v.id });
    if (motionPlan) resolveMotionPlan(app.db, motionPlan.id, 'applied', { resultVersionId: v.id });
    return v;
  });
  ctx.event('info', `Version ${version.number} is playable (${version.config.scenes.length} scenes).`);
  if (version.config.motion.bindings.length) ctx.event('info', `${version.config.motion.bindings.length} approved animation(s) included.`);
  return { versionId: version.id, number: version.number, warnings: result.warnings.length };
}
