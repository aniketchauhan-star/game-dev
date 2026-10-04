import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { gradeProfileSchema } from '@shared/schemas/grade.ts';
import type { App } from '../../app.ts';
import { deleteBranch, getBranchRow, listBranches, renameBranch, resolveBranch, setActiveBranch } from '../../db/branches.ts';
import { gradePlanDecision } from '@shared/schemas/grade.ts';
import { createJob } from '../../db/jobs.ts';
import { currentGradeProfile, getGradePlan, listGradePlans, listGradeProfiles, resolveGradePlan, saveGradeProfile, setGradePlanDecisions } from '../../db/grade.ts';
import { HttpError } from '../../errors.ts';
import { applyGradePlan } from '../../services/grade.ts';
import { idempotencyKey } from '../util.ts';
import { getProjectRow, touchProject } from '../../db/projects.ts';
import { activeJobs } from '../../db/jobs.ts';
import { badRequest, conflict } from '../../errors.ts';
import { createGradeVersion } from '../../services/branches.ts';
import { parse } from '../util.ts';

/** Grade versions (branches) and the grade & learning profile of each. */
export function gradeRoutes(f: FastifyInstance, app: App): void {
  f.get('/api/projects/:id/branches', async (req) => {
    const { id } = req.params as { id: string };
    getProjectRow(app.db, id);
    return { branches: listBranches(app.db, id) };
  });

  /** “Create another grade version” — branches the current approved game. */
  f.post('/api/projects/:id/branches', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parse(z.object({ name: z.string().trim().max(60).default(''), profile: gradeProfileSchema.nullable().default(null), fromBranchId: z.string().nullable().optional() }), req.body);
    if (activeJobs(app.db, id).some((j) => j.type === 'build' || j.type === 'prepare')) throw conflict('A build is running.', 'Wait for it to finish, then create the grade version.');
    const branch = createGradeVersion(app, id, body);
    touchProject(app.db, id);
    return reply.code(201).send({ branch, branches: listBranches(app.db, id) });
  });

  f.post('/api/projects/:id/branches/:branchId/activate', async (req) => {
    const { id, branchId } = req.params as { id: string; branchId: string };
    if (activeJobs(app.db, id).some((j) => ['build', 'prepare', 'refine', 'grade_plan', 'motion_suggest'].includes(j.type))) {
      throw conflict('A job is still working on the current grade version.', 'Wait for it to finish (or cancel it), then switch.');
    }
    const branch = setActiveBranch(app.db, id, branchId);
    touchProject(app.db, id);
    return { branch, branches: listBranches(app.db, id) };
  });

  f.patch('/api/branches/:branchId', async (req) => {
    const { branchId } = req.params as { branchId: string };
    const body = parse(z.object({ name: z.string().trim().min(1).max(60), expectedRevision: z.number().int() }), req.body);
    const branch = renameBranch(app.db, branchId, body.name, body.expectedRevision);
    touchProject(app.db, getBranchRow(app.db, branchId).project_id);
    return { branch };
  });

  f.delete('/api/projects/:id/branches/:branchId', async (req) => {
    const { id, branchId } = req.params as { id: string; branchId: string };
    deleteBranch(app.db, id, branchId);
    touchProject(app.db, id);
    return { deleted: branchId, branches: listBranches(app.db, id) };
  });

  f.get('/api/projects/:id/grade', async (req) => {
    const { id } = req.params as { id: string };
    const q = parse(z.object({ branchId: z.string().optional() }), req.query, 'query');
    const branchId = resolveBranch(app.db, id, q.branchId);
    return { branchId, current: currentGradeProfile(app.db, branchId), history: listGradeProfiles(app.db, branchId) };
  });

  /**
   * Save the grade & learning profile as a new revision. Saving never rewrites
   * the game or calls Claude: a changed grade is reviewed through a grade
   * adaptation plan the creator asks for explicitly.
   */
  f.put('/api/projects/:id/grade', async (req) => {
    const { id } = req.params as { id: string };
    const body = parse(z.object({ branchId: z.string().nullable().optional(), profile: gradeProfileSchema, expectedRevision: z.number().int().min(0).nullable() }), req.body);
    getProjectRow(app.db, id);
    const branchId = resolveBranch(app.db, id, body.branchId);
    const record = saveGradeProfile(app.db, { projectId: id, branchId, profile: body.profile, origin: body.profile.presetId ? 'preset' : 'creator', expectedRevision: body.expectedRevision });
    touchProject(app.db, id);
    return { branchId, current: record, history: listGradeProfiles(app.db, branchId) };
  });

  f.get('/api/projects/:id/grade-plans', async (req) => {
    const { id } = req.params as { id: string };
    const q = parse(z.object({ branchId: z.string().optional() }), req.query, 'query');
    return { plans: listGradePlans(app.db, resolveBranch(app.db, id, q.branchId)) };
  });

  /** Ask for a grade adaptation plan (never automatic: saving a grade does not start one). */
  f.post('/api/projects/:id/grade-plans', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parse(z.object({ mode: z.enum(['presentation', 'challenge']).default('presentation'), engine: z.enum(['auto', 'rules', 'claude']).default('auto') }), req.body ?? {});
    const project = getProjectRow(app.db, id);
    const branchId = resolveBranch(app.db, id, null);
    if (!currentGradeProfile(app.db, branchId)) throw conflict('Set the grade & learning profile first.');
    const status = app.gateway.status();
    const ready = status.keyPresent && status.state === 'configured';
    let mode: 'live' | 'demo' | 'local';
    if (body.engine === 'rules') mode = 'local';
    else if (body.engine === 'claude') {
      if (ready) mode = 'live';
      else if (project.is_sample === 1) mode = 'demo';
      else throw new HttpError(409, 'claude_not_configured', 'Claude is not configured.', 'Use the preset rules, or add ANTHROPIC_API_KEY to the server environment.');
    } else mode = ready ? 'live' : project.is_sample === 1 ? 'demo' : 'local';
    const { job, created } = createJob(app.db, { projectId: id, type: 'grade_plan', input: { branchId, mode: body.mode }, mode, idempotencyKey: idempotencyKey(req), model: mode === 'live' ? app.gateway.resolveModel().model : null, maxAttempts: 2 });
    touchProject(app.db, id);
    return reply.code(created ? 202 : 200).send({ job, mode });
  });

  f.patch('/api/grade-plans/:planId/decisions', async (req) => {
    const { planId } = req.params as { planId: string };
    const body = parse(z.object({ decisions: z.record(z.string(), gradePlanDecision) }), req.body);
    return { plan: setGradePlanDecisions(app.db, planId, body.decisions) };
  });

  f.post('/api/grade-plans/:planId/apply', async (req) => {
    const { planId } = req.params as { planId: string };
    const result = applyGradePlan(app, planId);
    touchProject(app.db, result.plan.projectId);
    return result;
  });

  f.post('/api/grade-plans/:planId/reject', async (req) => {
    const { planId } = req.params as { planId: string };
    const plan = getGradePlan(app.db, planId);
    if (plan.status !== 'proposed') throw badRequest(`This plan is already ${plan.status}.`);
    resolveGradePlan(app.db, planId, 'rejected');
    return { plan: getGradePlan(app.db, planId) };
  });
}
