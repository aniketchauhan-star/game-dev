import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { chatScopeSchema } from '@shared/schemas/records.ts';
import { changeOpSchema, changeScopeSchema } from '@shared/schemas/proposal.ts';
import type { App } from '../../app.ts';
import { getAssetRow } from '../../db/assets.ts';
import { createJob } from '../../db/jobs.ts';
import { insertMessage, listMessages } from '../../db/misc.ts';
import { getProjectRow, touchProject } from '../../db/projects.ts';
import { currentVersion, getVersion, listProposals, listVersions } from '../../db/versions.ts';
import { badRequest, conflict, notFound } from '../../errors.ts';
import { applyManualEdit, applyProposal, rejectProposal, restoreVersion, undoProposal } from '../../services/proposals.ts';
import { idempotencyKey, parse } from '../util.ts';
import { redactSecrets } from '../../secrets.ts';
import { jobMode } from './jobs.ts';

export function versionRoutes(f: FastifyInstance, app: App): void {
  f.get('/api/projects/:id/versions', async (req) => {
    const { id } = req.params as { id: string };
    return { versions: listVersions(app.db, id), currentVersionId: getProjectRow(app.db, id).current_version_id };
  });

  f.get('/api/versions/:id', async (req) => {
    const { id } = req.params as { id: string };
    return { version: getVersion(app.db, id) };
  });

  f.post('/api/versions/:id/restore', async (req) => {
    const { id } = req.params as { id: string };
    const v = getVersion(app.db, id);
    const version = restoreVersion(app, v.projectId, id);
    touchProject(app.db, v.projectId);
    return { version };
  });

  /** Creator's inspector edits — validated, lock-checked and applied atomically against a base version. */
  f.post('/api/projects/:id/edits', async (req) => {
    const { id } = req.params as { id: string };
    const body = parse(z.object({ baseVersionId: z.string(), ops: z.array(changeOpSchema).min(1).max(40), scope: changeScopeSchema, summary: z.string().min(1).max(200) }), req.body);
    const result = applyManualEdit(app, id, body);
    touchProject(app.db, id);
    return result;
  });

  /** Config + asset list for the sandboxed preview. The studio fetches asset bytes and posts them to the iframe. */
  f.get('/api/projects/:id/preview-bundle', async (req) => {
    const { id } = req.params as { id: string };
    const q = parse(z.object({ versionId: z.string().optional() }), req.query, 'query');
    const version = q.versionId ? getVersion(app.db, q.versionId) : currentVersion(app.db, id);
    if (!version || version.projectId !== id) throw notFound('Playable version');
    const assets = Object.values(version.config.assets).map((a) => {
      let available = true;
      try {
        getAssetRow(app.db, a.id);
      } catch {
        available = false;
      }
      return { id: a.id, mime: a.mime, url: `/api/assets/${a.id}/file?variant=display`, available };
    });
    return { version: { id: version.id, number: version.number, demo: version.demo, origin: version.origin, summary: version.summary }, config: version.config, assets };
  });

  f.get('/api/projects/:id/proposals', async (req) => {
    const { id } = req.params as { id: string };
    return { proposals: listProposals(app.db, id) };
  });

  f.post('/api/proposals/:id/apply', async (req) => {
    const { id } = req.params as { id: string };
    const result = applyProposal(app, id);
    touchProject(app.db, result.proposal.projectId);
    return result;
  });

  f.post('/api/proposals/:id/reject', async (req) => {
    const { id } = req.params as { id: string };
    return { proposal: rejectProposal(app, id) };
  });

  f.post('/api/proposals/:id/undo', async (req) => {
    const { id } = req.params as { id: string };
    const result = undoProposal(app, id);
    touchProject(app.db, result.proposal.projectId);
    return result;
  });

  f.get('/api/projects/:id/chat', async (req) => {
    const { id } = req.params as { id: string };
    return { messages: listMessages(app.db, id), proposals: listProposals(app.db, id, 100) };
  });

  /**
   * Creator message → stored message + a job. `refine` proposes structured
   * changes against a specific base version; `ask` answers a question.
   */
  f.post('/api/projects/:id/chat', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parse(
      z.object({
        text: z.string().trim().min(1).max(2000),
        mode: z.enum(['refine', 'ask']),
        scope: chatScopeSchema,
        area: z.enum(['source', 'blueprint', 'build', 'assets', 'general']),
        baseVersionId: z.string().nullable().optional(),
      }),
      req.body,
    );
    getProjectRow(app.db, id);
    const mode = jobMode(app, id, body.mode);
    let baseVersionId: string | null = null;
    if (body.mode === 'refine') {
      const current = currentVersion(app.db, id);
      if (!current) throw conflict('Build the game before asking for refinements.', 'Approve a blueprint and build it first.');
      baseVersionId = body.baseVersionId ?? current.id;
      const base = getVersion(app.db, baseVersionId);
      if (base.projectId !== id) throw badRequest('That version belongs to another project.');
      if (body.scope.kind === 'scene' && !base.config.scenes.some((s) => s.id === body.scope.sceneId)) throw badRequest('The selected scene is not in that version.');
      if (body.scope.kind === 'slide') throw badRequest('Refinements apply to the whole project or a scene.');
    }
    const key = idempotencyKey(req);
    // Anything that looks like an API key is redacted once, here, before the text is stored,
    // queued for the worker, copied into a proposal or sent to Claude.
    const text = redactSecrets(body.text);
    const message = insertMessage(app.db, { projectId: id, role: 'creator', text, scope: body.scope, area: body.area, origin: 'creator' });
    const input =
      body.mode === 'refine'
        ? { messageId: message.id, baseVersionId: baseVersionId!, scope: { kind: body.scope.kind === 'scene' ? 'scene' : 'project', sceneId: body.scope.kind === 'scene' ? body.scope.sceneId : null }, request: text }
        : { messageId: message.id, slideId: body.scope.slideId, sceneId: body.scope.sceneId, question: text };
    const { job, created } = createJob(app.db, { projectId: id, type: body.mode, input, mode, idempotencyKey: key, model: mode === 'live' ? app.gateway.resolveModel().model : null, maxAttempts: 2 });
    if (!created) {
      app.db.run('DELETE FROM chat_messages WHERE id = ?', [message.id]);
      return reply.code(200).send({ message: null, job, deduplicated: true });
    }
    app.db.run('UPDATE chat_messages SET job_id = ? WHERE id = ?', [job.id, message.id]);
    touchProject(app.db, id);
    return reply.code(202).send({ message: { ...message, jobId: job.id }, job, deduplicated: false });
  });
}
