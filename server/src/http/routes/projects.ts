import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { briefGaps, gameBriefSchema } from '@shared/schemas/brief.ts';
import { createStepSchema } from '@shared/schemas/project.ts';
import { effectiveSlideText } from '@shared/schemas/source.ts';
import type { App } from '../../app.ts';
import { slideBlock } from '../../claude/prompts.ts';
import { createProject, DEFAULT_PROJECT_NAME, deleteProject, duplicateProject, getProjectRow, listProjects, projectBrief, projectDetail, saveBrief, updateProjectMeta } from '../../db/projects.ts';
import { listSlides, refreshSourceRevision } from '../../db/sources.ts';
import { createSampleProject } from '../../demo/sample.ts';
import { addTrapeziumFiles, createTrapeziumProject, isTrapeziumProject } from '../../demo/trapezium.ts';
import { badRequest } from '../../errors.ts';
import { parse } from '../util.ts';

export function projectRoutes(f: FastifyInstance, app: App): void {
  f.get('/api/projects', async (req) => {
    const q = parse(z.object({ search: z.string().max(200).optional() }), req.query, 'query');
    return { projects: listProjects(app.db, q.search ?? '') };
  });

  f.post('/api/projects', async (req, reply) => {
    const body = parse(z.object({ name: z.string().max(120).optional() }), req.body ?? {});
    const id = createProject(app.db, { name: body.name?.trim() || DEFAULT_PROJECT_NAME });
    return reply.code(201).send({ project: projectDetail(app.db, id) });
  });

  /** Bundled samples: the Air Traffic Control game (fully prepared) or the Grade 8 trapezium starter (sources added by you). */
  f.post('/api/projects/sample', async (req, reply) => {
    const body = parse(z.object({ which: z.enum(['air-traffic', 'trapezium']).default('air-traffic') }), req.body ?? {});
    const id = body.which === 'trapezium' ? createTrapeziumProject(app) : await createSampleProject(app);
    return reply.code(201).send({ project: projectDetail(app.db, id) });
  });

  /** Add a group of the bundled trapezium files through the normal import pipelines. */
  f.post('/api/projects/:id/sample-files', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parse(z.object({ kind: z.enum(['lesson', 'screens', 'artwork']) }), req.body);
    if (!isTrapeziumProject(app, id)) throw badRequest('Sample files belong to the Grade 8 trapezium sample project.');
    const r = await addTrapeziumFiles(app, id, body.kind);
    return reply.code(201).send(r);
  });

  f.get('/api/projects/:id', async (req) => {
    const { id } = req.params as { id: string };
    refreshSourceRevision(app.db, id);
    return { project: projectDetail(app.db, id) };
  });

  f.patch('/api/projects/:id', async (req) => {
    const { id } = req.params as { id: string };
    const body = parse(
      z.object({ name: z.string().max(120).optional(), createStep: createStepSchema.optional(), contentReviewed: z.boolean().optional(), revision: z.number().int().nullable().optional() }),
      req.body,
    );
    updateProjectMeta(app.db, id, { name: body.name, createStep: body.createStep, contentReviewed: body.contentReviewed }, body.revision ?? null);
    return { project: projectDetail(app.db, id) };
  });

  f.post('/api/projects/:id/duplicate', async (req, reply) => {
    const { id } = req.params as { id: string };
    const copy = duplicateProject(app.db, app.storage, id);
    refreshSourceRevision(app.db, copy);
    return reply.code(201).send({ project: projectDetail(app.db, copy) });
  });

  f.delete('/api/projects/:id', async (req) => {
    const { id } = req.params as { id: string };
    const body = parse(z.object({ confirmName: z.string() }), req.body);
    const row = getProjectRow(app.db, id);
    if (body.confirmName.trim() !== row.name.trim()) throw badRequest('The confirmation does not match the project name. Nothing was deleted.');
    deleteProject(app.db, app.storage, id);
    return { deleted: id };
  });

  f.put('/api/projects/:id/brief', async (req) => {
    const { id } = req.params as { id: string };
    const body = parse(z.object({ brief: gameBriefSchema, revision: z.number().int() }), req.body);
    const revision = saveBrief(app.db, id, body.brief, body.revision);
    return { briefRevision: revision, gaps: briefGaps(body.brief), savedAt: new Date().toISOString() };
  });

  /** Exactly what an analysis would send to Claude, so the creator can review it before any paid call. */
  f.get('/api/projects/:id/ai-preview', async (req) => {
    const { id } = req.params as { id: string };
    const q = parse(z.object({ countTokens: z.enum(['0', '1']).optional() }), req.query, 'query');
    const brief = projectBrief(getProjectRow(app.db, id));
    const slides = listSlides(app.db, id);
    const included = slides.filter((s) => s.included);
    const authorized = new Set(brief.aiInputs.authorizedVisualSlideIds);
    const blocks = included.map((s) => slideBlock(s, { includeNotes: brief.aiInputs.includeSpeakerNotes }));
    const visuals = brief.aiInputs.sendVisualReferences
      ? included.filter((s) => authorized.has(s.id)).map((s) => ({ slideId: s.id, slideNumber: s.slideNumber, kind: s.visualRef?.kind ?? null, mapping: s.visualRef?.mapping ?? null, willSend: Boolean(s.visualRef && s.visualRef.mapping !== 'suggested') }))
      : [];
    let tokenCount: number | null = null;
    let tokenNote: string | null = null;
    if (q.countTokens === '1') {
      try {
        tokenCount = await app.gateway.countTokens({ system: 'Token count preview', content: blocks.join('\n\n') });
      } catch (err) {
        tokenNote = (err as Error).message;
      }
    }
    return {
      claude: app.gateway.status(),
      includeSpeakerNotes: brief.aiInputs.includeSpeakerNotes,
      slides: slides.map((s) => {
        const t = effectiveSlideText(s);
        return {
          slideId: s.id,
          slideNumber: s.slideNumber,
          title: t.title,
          included: s.included,
          hidden: s.hidden,
          characters: s.included ? slideBlock(s, { includeNotes: brief.aiInputs.includeSpeakerNotes }).length : 0,
          notesIncluded: s.included && brief.aiInputs.includeSpeakerNotes && t.notes.length > 0,
        };
      }),
      totalCharacters: blocks.reduce((n, b) => n + b.length, 0),
      visuals,
      sample: blocks[0]?.slice(0, 1500) ?? null,
      tokenCount,
      tokenNote,
      gaps: briefGaps(brief),
    };
  });
}
