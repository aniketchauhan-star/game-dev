import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { motionPlanScopeSchema, planDecision } from '@shared/schemas/motion.ts';
import type { App } from '../../app.ts';
import { activeBranchId } from '../../db/branches.ts';
import { createJob } from '../../db/jobs.ts';
import { getMotionPlan, listMotionPlans, resolveMotionPlan, setMotionPlanDecisions } from '../../db/motion.ts';
import { getProjectRow, touchProject } from '../../db/projects.ts';
import { currentVersion, getVersion } from '../../db/versions.ts';
import { badRequest, conflict, HttpError } from '../../errors.ts';
import { applyMotionPlan } from '../../services/motion.ts';
import { idempotencyKey, parse } from '../util.ts';

/** Motion plans: reviewable rows from preset rules or Claude, applied atomically to an exact version. */
export function motionRoutes(f: FastifyInstance, app: App): void {
  f.get('/api/projects/:id/motion-plans', async (req) => {
    const { id } = req.params as { id: string };
    getProjectRow(app.db, id);
    return { plans: listMotionPlans(app.db, activeBranchId(app.db, id)) };
  });

  /**
   * Start a suggestion. engine “rules” never calls an AI service; “claude”
   * needs a configured key; “auto” uses Claude when configured, demo content
   * for the bundled sample, and the preset rules otherwise. A free-text
   * request always needs Claude (or the sample's prepared demo answers).
   */
  f.post('/api/projects/:id/motion-plans', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parse(
      z.object({ scope: motionPlanScopeSchema, request: z.string().trim().max(2000).default(''), engine: z.enum(['auto', 'rules', 'claude']).default('auto'), baseVersionId: z.string().nullable().optional() }),
      req.body,
    );
    const project = getProjectRow(app.db, id);
    const branchId = activeBranchId(app.db, id);
    const base = body.baseVersionId ? getVersion(app.db, body.baseVersionId) : currentVersion(app.db, id);
    if (!base || base.projectId !== id) throw conflict('Build the game first: motion is proposed against a playable version.', 'Or use Prepare my game to stage motion for the first build.');
    if (body.scope.kind === 'screen' && !body.scope.screenId) throw badRequest('Choose a screen.');
    const status = app.gateway.status();
    const claudeReady = status.keyPresent && status.state === 'configured';
    let mode: 'live' | 'demo' | 'local';
    if (body.engine === 'rules') {
      if (body.request) throw badRequest('Preset rules cannot read a request. Clear the request, or ask Claude.');
      mode = 'local';
    } else if (body.engine === 'claude' || body.request) {
      if (claudeReady) mode = 'live';
      else if (project.is_sample === 1) mode = 'demo';
      else if (status.keyPresent) throw new HttpError(409, 'claude_unverified', `Claude is set up but model ${status.model ?? '(none)'} is not verified.`, 'Open Settings → Claude and run “Test connection”.');
      else throw new HttpError(409, 'claude_not_configured', 'Claude is not configured, so a written request cannot be read.', 'Add animations with the manual presets, or use “Suggest motion” with the preset rules.');
    } else mode = claudeReady ? 'live' : project.is_sample === 1 ? 'demo' : 'local';
    const { job, created } = createJob(app.db, {
      projectId: id,
      type: 'motion_suggest',
      input: { branchId, baseVersionId: base.id, scope: body.scope, request: body.request, messageId: null },
      mode,
      idempotencyKey: idempotencyKey(req),
      model: mode === 'live' ? app.gateway.resolveModel().model : null,
      maxAttempts: 2,
    });
    touchProject(app.db, id);
    return reply.code(created ? 202 : 200).send({ job, mode });
  });

  f.patch('/api/motion-plans/:planId/decisions', async (req) => {
    const { planId } = req.params as { planId: string };
    const body = parse(z.object({ decisions: z.record(z.string(), planDecision) }), req.body);
    return { plan: setMotionPlanDecisions(app.db, planId, body.decisions) };
  });

  f.post('/api/motion-plans/:planId/apply', async (req) => {
    const { planId } = req.params as { planId: string };
    const result = applyMotionPlan(app, planId);
    touchProject(app.db, result.plan.projectId);
    return result;
  });

  f.post('/api/motion-plans/:planId/reject', async (req) => {
    const { planId } = req.params as { planId: string };
    const plan = getMotionPlan(app.db, planId);
    if (plan.status !== 'proposed') throw conflict(`This motion plan is already ${plan.status}.`);
    resolveMotionPlan(app.db, planId, 'rejected');
    return { plan: getMotionPlan(app.db, planId) };
  });
}
