import fs from 'node:fs';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { App } from '../../app.ts';
import { activeBranchId } from '../../db/branches.ts';
import { framesById, getDesignFrame, getDesignImport, listActiveFrames, listDesignImports } from '../../db/design.ts';
import { currentScreenMap } from '../../db/screens.ts';
import { getProjectRow, touchProject } from '../../db/projects.ts';
import { HttpError, notFound } from '../../errors.ts';
import { figmaStatus } from '../../figma/index.ts';
import { approveRefresh, rejectRefresh, removeDesignImport, startFigmaImport, startFrameImport, startRefresh, uploadExportedScreens } from '../../services/design.ts';
import { resolveInside } from '../../storage.ts';
import { parse, saveFilePart, sendFile } from '../util.ts';

/** Figma design (read-only adapter) and exported screens. */
export function designRoutes(f: FastifyInstance, app: App): void {
  f.get('/api/projects/:id/design', async (req) => {
    const { id } = req.params as { id: string };
    getProjectRow(app.db, id);
    return { imports: listDesignImports(app.db, id), figma: figmaStatus(app) };
  });

  /** Paste a Figma Design file/frame link. The link is validated; the API request is built from its identifiers. */
  f.post('/api/projects/:id/design/figma', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parse(z.object({ link: z.string().trim().min(1).max(2048) }), req.body);
    getProjectRow(app.db, id);
    const result = startFigmaImport(app, id, body.link);
    touchProject(app.db, id);
    return reply.code(202).send(result);
  });

  f.post('/api/design-imports/:importId/import', async (req, reply) => {
    const { importId } = req.params as { importId: string };
    const body = parse(z.object({ nodeIds: z.array(z.string().regex(/^\d{1,12}:\d{1,12}$/)).min(1).max(24) }), req.body);
    const imp = getDesignImport(app.db, importId);
    const result = startFrameImport(app, imp.projectId, importId, [...new Set(body.nodeIds)]);
    touchProject(app.db, imp.projectId);
    return reply.code(202).send(result);
  });

  f.post('/api/design-imports/:importId/refresh', async (req, reply) => {
    const { importId } = req.params as { importId: string };
    const imp = getDesignImport(app.db, importId);
    const result = startRefresh(app, imp.projectId, importId);
    touchProject(app.db, imp.projectId);
    return reply.code(202).send(result);
  });

  f.post('/api/design-imports/:importId/approve', async (req) => {
    const { importId } = req.params as { importId: string };
    const imp = getDesignImport(app.db, importId);
    const result = approveRefresh(app, imp.projectId, importId);
    touchProject(app.db, imp.projectId);
    return { import: result };
  });

  f.post('/api/design-imports/:importId/reject', async (req) => {
    const { importId } = req.params as { importId: string };
    const imp = getDesignImport(app.db, importId);
    return { import: rejectRefresh(app, imp.projectId, importId) };
  });

  f.delete('/api/design-imports/:importId', async (req) => {
    const { importId } = req.params as { importId: string };
    const imp = getDesignImport(app.db, importId);
    removeDesignImport(app, imp.projectId, importId);
    touchProject(app.db, imp.projectId);
    return { deleted: importId };
  });

  /** Frame thumbnails captured while browsing (stored privately in the project folder). */
  f.get('/api/design-imports/:importId/thumbs/:nodeId', async (req, reply) => {
    const { importId, nodeId } = req.params as { importId: string; nodeId: string };
    const imp = getDesignImport(app.db, importId);
    const entry = imp.available.find((a) => a.nodeId === nodeId);
    if (!entry?.thumbFile) throw notFound('Thumbnail');
    const file = resolveInside(app.storage.projectDir(imp.projectId), entry.thumbFile);
    if (!fs.existsSync(file)) throw notFound('Thumbnail');
    return sendFile(reply, file, { type: 'image/png', cache: 'private, max-age=300' });
  });

  /** Every frame snapshot the screen map can use (active imports, plus frames the current map still references). */
  f.get('/api/projects/:id/design-frames', async (req) => {
    const { id } = req.params as { id: string };
    getProjectRow(app.db, id);
    const active = listActiveFrames(app.db, id);
    const map = currentScreenMap(app.db, activeBranchId(app.db, id));
    const referenced = (map?.mapping.screens ?? []).flatMap((s) => [...s.frames.map((f) => f.frameId), ...(s.background.frameId ? [s.background.frameId] : [])]).filter((fid) => !active.some((f) => f.id === fid));
    const extra = [...framesById(app.db, referenced).values()].filter((f) => f.projectId === id);
    return { frames: [...active, ...extra] };
  });

  f.get('/api/design-frames/:frameId', async (req) => {
    const { frameId } = req.params as { frameId: string };
    return { frame: getDesignFrame(app.db, frameId) };
  });

  /** Upload exported screens (PNG/JPEG/SVG). Works without any Figma connection. */
  f.post('/api/projects/:id/design/exported', async (req, reply) => {
    const { id } = req.params as { id: string };
    getProjectRow(app.db, id);
    const files: Array<{ path: string; name: string }> = [];
    const early: Array<{ name: string; message: string; hint: string }> = [];
    try {
      for await (const part of req.parts()) {
        if (part.type !== 'file') continue;
        if (files.length >= 24) {
          early.push({ name: part.filename, message: 'At most 24 screens per upload.', hint: 'Upload the rest in another batch.' });
          part.file.resume();
          continue;
        }
        const tmp = app.storage.tmpFile('screen');
        try {
          const saved = await saveFilePart(part, tmp, app.config.limits.maxAssetBytes);
          files.push({ path: tmp, name: saved.originalName });
        } catch (err) {
          if (err instanceof HttpError) early.push({ name: part.filename, message: err.message, hint: err.hint ?? '' });
          else throw err;
        }
      }
      const result = await uploadExportedScreens(app, id, files);
      touchProject(app.db, id);
      return reply.code(result.import ? 201 : 200).send({ import: result.import, rejected: [...early, ...result.rejected], imports: listDesignImports(app.db, id) });
    } finally {
      for (const f2 of files) fs.rmSync(f2.path, { force: true });
    }
  });
}
