import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { AI_JOB_TYPES, jobInputSchemas, jobType, type Job, type JobType } from '@shared/schemas/jobs.ts';
import type { App } from '../../app.ts';
import { createJob, dismissJob, eventsSince, getJobRow, JobStateError, listJobs, requestCancel, retryJob, toJob } from '../../db/jobs.ts';
import { approvedBlueprint, currentAnalysis, getBlueprintRevision } from '../../db/learning.ts';
import { getProjectRow, touchProject } from '../../db/projects.ts';
import { listSlides, primaryDocument } from '../../db/sources.ts';
import { conflict, HttpError, notFound } from '../../errors.ts';
import { idempotencyKey, parse } from '../util.ts';

/** Decide live / demo / local for a job, or explain why it cannot run. */
export function jobMode(app: App, projectId: string, type: JobType): Job['mode'] {
  if (!AI_JOB_TYPES.includes(type)) return 'local';
  const status = app.gateway.status();
  const project = getProjectRow(app.db, projectId);
  if (status.keyPresent) {
    if (status.state !== 'configured') {
      throw new HttpError(409, 'claude_unverified', `Claude is set up but model ${status.model ?? '(none)'} is not verified.`, 'Open Settings → Claude and run “Test connection”.');
    }
    return 'live';
  }
  if (project.is_sample === 1) return 'demo';
  throw new HttpError(409, 'claude_not_configured', 'Claude is not configured, so this step cannot run.', 'Add ANTHROPIC_API_KEY to the server environment (see Settings), or continue manually: start a blueprint yourself in the Blueprint area.');
}

function preconditions(app: App, projectId: string, type: JobType, input: Record<string, unknown>): void {
  if (type === 'analyze' || type === 'blueprint') {
    if (listSlides(app.db, projectId).filter((s) => s.included).length === 0) throw conflict('No slides are included yet.', 'Import a deck and include at least one slide.');
  }
  if (type === 'blueprint' && !currentAnalysis(app.db, projectId) && getProjectRow(app.db, projectId).is_sample !== 1) {
    throw conflict('Analyze the deck before generating a blueprint.', 'Source → Analyze with Claude.');
  }
  if (type === 'build') {
    const rev = getBlueprintRevision(app.db, String(input.blueprintRevisionId));
    if (rev.projectId !== projectId) throw notFound('Blueprint revision');
    if (rev.status !== 'approved') throw conflict(`Blueprint r${rev.number} is not approved.`, 'Approve the blueprint first — builds always use an approved revision.');
  }
  if (type === 'regenerate_scene') {
    const rev = getBlueprintRevision(app.db, String(input.blueprintRevisionId));
    if (rev.projectId !== projectId) throw notFound('Blueprint revision');
  }
  if (type === 'render_slides') {
    if (!primaryDocument(app.db, projectId)) throw conflict('Import a deck first.');
    const r = app.renderer();
    if (r.state !== 'available') throw new HttpError(409, 'renderer_unavailable', 'Slide rendering is unavailable.', r.detail);
  }
}

export function jobRoutes(f: FastifyInstance, app: App): void {
  f.post('/api/projects/:id/jobs', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parse(z.object({ type: jobType, input: z.record(z.string(), z.unknown()).default({}) }), req.body);
    if (body.type === 'refine' || body.type === 'ask' || body.type === 'extract_pptx' || body.type === 'extract_pdf') {
      throw conflict('Start this through the chat or the upload endpoint.');
    }
    getProjectRow(app.db, id);
    const input = parse(jobInputSchemas[body.type] as z.ZodType<Record<string, unknown>>, body.input, 'job input');
    if (body.type === 'build' && !input.blueprintRevisionId) {
      const approved = approvedBlueprint(app.db, id);
      if (!approved) throw conflict('There is no approved blueprint to build.');
      input.blueprintRevisionId = approved.id;
    }
    preconditions(app, id, body.type, input);
    const mode = jobMode(app, id, body.type);
    if (mode === 'demo' && body.type === 'regenerate_scene') {
      throw new HttpError(409, 'demo_unsupported', 'Regenerating a scene needs a configured Claude connection.', 'Demo mode only replays prepared sample content. You can still edit the scene by hand.');
    }
    const { job, created } = createJob(app.db, {
      projectId: id,
      type: body.type,
      input,
      mode,
      idempotencyKey: idempotencyKey(req),
      model: mode === 'live' ? app.gateway.resolveModel().model : null,
      maxAttempts: 3,
    });
    touchProject(app.db, id);
    return reply.code(created ? 202 : 200).send({ job, deduplicated: !created });
  });

  f.get('/api/projects/:id/jobs', async (req) => {
    const { id } = req.params as { id: string };
    return { jobs: listJobs(app.db, id) };
  });

  f.get('/api/jobs/:id', async (req) => {
    const { id } = req.params as { id: string };
    const row = getJobRow(app.db, id);
    if (!row) throw notFound('Job');
    return { job: toJob(row), events: eventsSince(app.db, id, 0, 1000) };
  });

  f.post('/api/jobs/:id/cancel', async (req) => {
    const { id } = req.params as { id: string };
    const job = requestCancel(app.db, id);
    if (!job) throw notFound('Job');
    return { job };
  });

  f.post('/api/jobs/:id/retry', async (req) => {
    const { id } = req.params as { id: string };
    try {
      const job = retryJob(app.db, id);
      return { job };
    } catch (err) {
      if (err instanceof JobStateError) throw conflict(err.message);
      throw err;
    }
  });

  f.post('/api/jobs/:id/dismiss', async (req) => {
    const { id } = req.params as { id: string };
    const row = getJobRow(app.db, id);
    if (!row) throw notFound('Job');
    dismissJob(app.db, id);
    touchProject(app.db, row.project_id);
    return { job: toJob(getJobRow(app.db, id)!) };
  });

  /**
   * Server-Sent Events for one job. Reconnecting clients resume after
   * Last-Event-ID; the stream ends once the job is finished and drained.
   */
  f.get('/api/jobs/:id/events', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!getJobRow(app.db, id)) throw notFound('Job');
    const header = req.headers['last-event-id'];
    const q = req.query as { after?: string };
    let last = Number((Array.isArray(header) ? header[0] : header) ?? q.after ?? 0) || 0;
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Content-Type-Options': 'nosniff',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    let closed = false;
    req.raw.on('close', () => {
      closed = true;
    });
    let idle = 0;
    while (!closed) {
      const events = eventsSince(app.db, id, last, 200);
      for (const e of events) {
        res.write(`id: ${e.seq}\nevent: job\ndata: ${JSON.stringify(e)}\n\n`);
        last = e.seq;
      }
      const row = getJobRow(app.db, id);
      if (!row) break;
      if (events.length === 0 && ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(row.status)) {
        res.write(`event: end\ndata: ${JSON.stringify(toJob(row))}\n\n`);
        break;
      }
      if (events.length === 0) {
        idle += 1;
        if (idle % 50 === 0) res.write(': keep-alive\n\n');
      } else idle = 0;
      await new Promise((r) => setTimeout(r, 300));
    }
    res.end();
  });
}
