import fs from 'node:fs';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { exportKind } from '@shared/schemas/exports.ts';
import type { App } from '../../app.ts';
import { getExport, listExports } from '../../db/misc.ts';
import { touchProject } from '../../db/projects.ts';
import { notFound } from '../../errors.ts';
import { createExport, prepareExport } from '../../export/exporter.ts';
import { attachment, parse, sendFile } from '../util.ts';

const exportBody = z.object({
  kind: exportKind,
  versionId: z.string().nullable().optional(),
  includeSourceMaterial: z.boolean().default(false),
  nextChanges: z.string().max(4000).default(''),
});

export function exportRoutes(f: FastifyInstance, app: App): void {
  f.post('/api/projects/:id/exports/preflight', async (req) => {
    const { id } = req.params as { id: string };
    const body = parse(exportBody, req.body);
    const prepared = prepareExport(app, id, { kind: body.kind, versionId: body.versionId ?? null, includeSourceMaterial: body.includeSourceMaterial, nextChanges: body.nextChanges });
    return { preflight: prepared.preflight, files: prepared.entries.map((e) => e.path).sort() };
  });

  f.post('/api/projects/:id/exports', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parse(exportBody, req.body);
    const record = await createExport(app, id, { kind: body.kind, versionId: body.versionId ?? null, includeSourceMaterial: body.includeSourceMaterial, nextChanges: body.nextChanges });
    touchProject(app.db, id);
    return reply.code(201).send({ export: record });
  });

  f.get('/api/projects/:id/exports', async (req) => {
    const { id } = req.params as { id: string };
    return { exports: listExports(app.db, id) };
  });

  f.get('/api/exports/:id/download', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { record, filePath } = getExport(app.db, id);
    if (!fs.existsSync(filePath)) throw notFound('Export file');
    return sendFile(reply, filePath, { type: 'application/zip', disposition: attachment(record.fileName) });
  });
}
