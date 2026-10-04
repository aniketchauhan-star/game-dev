import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { App } from '../../app.ts';
import { activeBranchId } from '../../db/branches.ts';
import { currentGradeProfile } from '../../db/grade.ts';
import { activeJobs, createJob } from '../../db/jobs.ts';
import { approveBlueprint, latestBlueprint } from '../../db/learning.ts';
import { getProjectRow, touchProject } from '../../db/projects.ts';
import { badRequest, conflict } from '../../errors.ts';
import { readiness } from '../../services/readiness.ts';
import { idempotencyKey, parse } from '../util.ts';
import { blueprintIssues } from './learning.ts';

/** “Prepare my game”, the readiness summary, and “Approve & build”. */
export function prepareRoutes(f: FastifyInstance, app: App): void {
  f.get('/api/projects/:id/readiness', async (req) => {
    const { id } = req.params as { id: string };
    getProjectRow(app.db, id);
    return readiness(app, id);
  });

  /**
   * Stage reviewable proposals: gameplay, screen map + artwork, grade plan and
   * motion. With Claude configured this calls Claude (the creator pressed the
   * button); without it the preset rules are used and gameplay is left to the
   * creator — nothing is invented.
   */
  f.post('/api/projects/:id/prepare', async (req, reply) => {
    const { id } = req.params as { id: string };
    const project = getProjectRow(app.db, id);
    const branchId = activeBranchId(app.db, id);
    if (!currentGradeProfile(app.db, branchId)) throw conflict('Which grade is this game for?', 'Set the Grade & learning profile first.');
    if (activeJobs(app.db, id).some((j) => j.type === 'build')) throw conflict('A build is running.', 'Wait for it to finish.');
    const status = app.gateway.status();
    const mode = status.keyPresent && status.state === 'configured' ? 'live' : project.is_sample === 1 ? 'demo' : 'local';
    const { job, created } = createJob(app.db, { projectId: id, type: 'prepare', input: { branchId }, mode, idempotencyKey: idempotencyKey(req), model: mode === 'live' ? app.gateway.resolveModel().model : null, maxAttempts: 2 });
    touchProject(app.db, id);
    return reply.code(created ? 202 : 200).send({ job, mode });
  });

  /**
   * Approve & build: approve the latest draft blueprint (supported mechanics
   * only), then build it with the reviewed map, grade profile and the accepted
   * rows of the staged plans. A failed build leaves the last playable version.
   */
  f.post('/api/projects/:id/approve-build', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parse(z.object({ includeGradePlan: z.boolean().default(true), includeMotionPlan: z.boolean().default(true) }), req.body ?? {});
    getProjectRow(app.db, id);
    const r = readiness(app, id);
    if (!r.canBuild) throw conflict('The game cannot be built yet.', r.buildBlockers.join(' '));
    const branchId = activeBranchId(app.db, id);
    let rev = latestBlueprint(app.db, id, branchId)!;
    if (rev.status === 'draft') {
      const issues = blueprintIssues(app, id, rev.blueprint);
      const blocking = issues.structural.filter((i) => i.severity === 'error');
      if (blocking.length) throw badRequest(`Blueprint r${rev.number} has problems that block approval: ${blocking[0]!.message}`, 'Fix them in Blueprint, then try again.');
      rev = approveBlueprint(app.db, rev.id, rev.revision);
    } else if (rev.status !== 'approved') throw conflict(`Blueprint r${rev.number} is ${rev.status}.`);
    const { job } = createJob(app.db, {
      projectId: id,
      type: 'build',
      input: { blueprintRevisionId: rev.id, gradePlanId: body.includeGradePlan ? r.gradePlanId : null, motionPlanId: body.includeMotionPlan ? r.motionPlanId : null, carryMotion: true },
      mode: 'local',
      idempotencyKey: idempotencyKey(req),
      model: null,
      maxAttempts: 2,
    });
    touchProject(app.db, id);
    return reply.code(202).send({ job, blueprintRevisionId: rev.id });
  });
}
