import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { sourceScreenMappingSchema } from '@shared/schemas/screens.ts';
import type { App } from '../../app.ts';
import { activeBranchId } from '../../db/branches.ts';
import { getProjectRow, touchProject } from '../../db/projects.ts';
import { currentScreenMap, insertScreenMap, screenMapAt } from '../../db/screens.ts';
import { notFound } from '../../errors.ts';
import { saveScreenMap, screenMapBundle } from '../../services/screens.ts';
import { parse } from '../util.ts';

/** Source-to-Screen map: which slides, design frames and artwork feed each game screen. */
export function screenRoutes(f: FastifyInstance, app: App): void {
  f.get('/api/projects/:id/screen-map', async (req) => {
    const { id } = req.params as { id: string };
    getProjectRow(app.db, id);
    return screenMapBundle(app, id);
  });

  /** Save a reviewed map as a new revision; optionally apply its layout to the current game version (as a new version). */
  f.put('/api/projects/:id/screen-map', async (req) => {
    const { id } = req.params as { id: string };
    const body = parse(z.object({ mapping: sourceScreenMappingSchema, expectedNumber: z.number().int().min(0), note: z.string().max(300).default(''), applyToVersion: z.boolean().default(false) }), req.body);
    getProjectRow(app.db, id);
    const result = saveScreenMap(app, id, body);
    touchProject(app.db, id);
    return result;
  });

  /** Restore an earlier map revision as the newest one (history is kept). */
  f.post('/api/projects/:id/screen-map/restore', async (req) => {
    const { id } = req.params as { id: string };
    const body = parse(z.object({ number: z.number().int().min(1) }), req.body);
    const branchId = activeBranchId(app.db, id);
    const old = screenMapAt(app.db, branchId, body.number);
    if (!old) throw notFound('Screen map revision');
    const cur = currentScreenMap(app.db, branchId);
    const map = insertScreenMap(app.db, { projectId: id, branchId, blueprintRevisionId: old.blueprintRevisionId, origin: 'creator', note: `Restored map ${old.number}`, mapping: old.mapping, expectedNumber: cur?.number ?? 0 });
    touchProject(app.db, id);
    return { map };
  });
}
