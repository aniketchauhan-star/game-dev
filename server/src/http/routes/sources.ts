import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { ID_PREFIX, newId } from '@shared/schemas/common.ts';
import { reviewStatus, visualRefSchema } from '@shared/schemas/source.ts';
import type { App } from '../../app.ts';
import { createJob } from '../../db/jobs.ts';
import { getProjectRow, touchProject } from '../../db/projects.ts';
import {
  deleteDocument,
  getDocument,
  getDocumentRow,
  getSlide,
  insertDocument,
  listDocuments,
  listSlides,
  primaryDocument,
  refreshSourceRevision,
  revertSlideChange,
  slideHistory,
  updateSlide,
} from '../../db/sources.ts';
import { conflict, HttpError } from '../../errors.ts';
import { sniff } from '../../ingest/sniff.ts';
import { attachment, parse, saveFilePart, sendFile } from '../util.ts';

export function sourceRoutes(f: FastifyInstance, app: App): void {
  /** Upload the primary deck (.pptx) or a reference PDF. Extraction runs as a job in the worker. */
  f.post('/api/projects/:id/sources', async (req, reply) => {
    const { id: projectId } = req.params as { id: string };
    getProjectRow(app.db, projectId);
    let kind: 'pptx' | 'pdf' | null = null;
    let replace = false;
    let saved: Awaited<ReturnType<typeof saveFilePart>> | null = null;
    try {
      for await (const part of req.parts()) {
        if (part.type === 'field') {
          if (part.fieldname === 'kind' && (part.value === 'pptx' || part.value === 'pdf')) kind = part.value;
          if (part.fieldname === 'replace') replace = part.value === '1';
          continue;
        }
        if (saved) throw new HttpError(400, 'one_file', 'Upload one file at a time.');
        saved = await saveFilePart(part, app.storage.tmpFile('upload'), app.config.limits.maxUploadBytes);
      }
      if (!saved) throw new HttpError(400, 'no_file', 'No file was received.');
      if (saved.size === 0) throw new HttpError(400, 'empty', 'The file is empty.');
      const head = Buffer.alloc(64);
      const fd = fs.openSync(saved.tmpPath, 'r');
      fs.readSync(fd, head, 0, 64, 0);
      fs.closeSync(fd);
      const type = sniff(head);
      const lower = saved.originalName.toLowerCase();
      if (!kind) kind = lower.endsWith('.pdf') ? 'pdf' : 'pptx';
      if (kind === 'pdf' && type !== 'pdf') throw new HttpError(415, 'not_pdf', 'This file is not a PDF.', 'Choose a PDF exported from your presentation.');
      if (kind === 'pptx') {
        if (lower.endsWith('.ppt') || lower.endsWith('.pps')) {
          throw new HttpError(415, 'legacy_ppt', 'Legacy .ppt files are not supported.', 'Open it in PowerPoint and choose File → Save As → PowerPoint Presentation (.pptx).');
        }
        if (lower.endsWith('.pptm') || lower.endsWith('.ppsm') || lower.endsWith('.potm')) {
          throw new HttpError(415, 'macro', 'Macro-enabled presentations are not accepted.', 'Save a copy as a regular .pptx without macros.');
        }
        if (lower.endsWith('.key')) throw new HttpError(415, 'keynote', 'Keynote files are not supported directly.', 'In Keynote, choose File → Export To → PowerPoint.');
        if (type !== 'zip' && type !== 'ole') throw new HttpError(415, 'not_pptx', 'This file is not a PowerPoint (.pptx) presentation.', 'Choose a .pptx file.');
        // A deck whose import failed has nothing to protect, so it is replaced without asking.
        const current = primaryDocument(app.db, projectId);
        if (current && current.status !== 'failed' && !replace) {
          throw conflict('This project already has a deck.', 'Confirm “Replace deck” to import the new file. Slide edits on the old deck are not carried over, and existing blueprints will be marked stale.');
        }
      }
      const upload = saved;
      const docId = newId(ID_PREFIX.document);
      const rel = `projects/${projectId}/sources/${docId}/original.${kind === 'pdf' ? 'pdf' : 'pptx'}`;
      const dest = app.storage.abs(rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.renameSync(upload.tmpPath, dest);
      saved = null;
      const fileKind = kind;
      const job = app.db.tx(() => {
        if (fileKind === 'pptx') {
          const existing = primaryDocument(app.db, projectId);
          if (existing) deleteDocument(app.db, app.storage, existing.id);
        }
        insertDocument(app.db, {
          id: docId,
          projectId,
          kind: fileKind,
          role: fileKind === 'pptx' ? 'primary' : 'reference',
          originalName: upload.originalName,
          storedPath: rel,
          sizeBytes: upload.size,
          sha256: upload.sha256,
          status: 'stored',
        });
        return createJob(app.db, { projectId, type: fileKind === 'pdf' ? 'extract_pdf' : 'extract_pptx', input: { documentId: docId }, mode: 'local', maxAttempts: 2 }).job;
      });
      touchProject(app.db, projectId);
      return reply.code(202).send({ document: getDocument(app.db, docId), job });
    } finally {
      if (saved) fs.rmSync(saved.tmpPath, { force: true });
    }
  });

  f.delete('/api/projects/:id/sources/:docId', async (req) => {
    const { id, docId } = req.params as { id: string; docId: string };
    const doc = getDocument(app.db, docId);
    if (doc.projectId !== id) throw new HttpError(404, 'not_found', 'Source document was not found.');
    deleteDocument(app.db, app.storage, docId);
    refreshSourceRevision(app.db, id);
    touchProject(app.db, id);
    return { deleted: docId, documents: listDocuments(app.db, id) };
  });

  /** Original file download. PDFs are served for the in-studio pdf.js viewer; decks only as attachments. */
  f.get('/api/sources/:docId/file', async (req, reply) => {
    const { docId } = req.params as { docId: string };
    const row = getDocumentRow(app.db, docId);
    if (!row) throw new HttpError(404, 'not_found', 'Source document was not found.');
    const file = app.storage.abs(row.stored_path);
    if (!fs.existsSync(file)) throw new HttpError(404, 'missing_file', 'The stored file is missing.');
    reply.header('Content-Security-Policy', "default-src 'none'; sandbox");
    if (row.kind === 'pdf') return sendFile(reply, file, { type: 'application/pdf', cache: 'private, max-age=300' });
    return sendFile(reply, file, { type: 'application/octet-stream', disposition: attachment(row.original_name) });
  });

  f.get('/api/projects/:id/slides', async (req) => {
    const { id } = req.params as { id: string };
    return { slides: listSlides(app.db, id), documents: listDocuments(app.db, id) };
  });

  f.patch('/api/slides/:id', async (req) => {
    const { id } = req.params as { id: string };
    const body = parse(
      z.object({
        revision: z.number().int().nullable(),
        patch: z.object({
          included: z.boolean().optional(),
          title: z.string().max(300).nullable().optional(),
          blocks: z.record(z.string(), z.array(z.string().max(2000)).max(80).nullable()).optional(),
          notes: z.array(z.string().max(4000)).max(80).nullable().optional(),
          lockedWording: z.boolean().optional(),
          requiredExample: z.boolean().optional(),
          reviewStatus: reviewStatus.optional(),
          visualRef: visualRefSchema.nullable().optional(),
        }),
      }),
      req.body,
    );
    const slide = updateSlide(app.db, id, body.patch, body.revision);
    const source = refreshSourceRevision(app.db, slide.projectId);
    touchProject(app.db, slide.projectId);
    return { slide, sourceRevision: source.revision, sourceChanged: source.changed };
  });

  f.post('/api/projects/:id/slides/bulk', async (req) => {
    const { id } = req.params as { id: string };
    const body = parse(z.object({ slideIds: z.array(z.string()).max(200), included: z.boolean().optional(), reviewStatus: reviewStatus.optional() }), req.body);
    app.db.tx(() => {
      for (const sid of body.slideIds) {
        const s = getSlide(app.db, sid);
        if (s.projectId !== id) continue;
        updateSlide(app.db, sid, { included: body.included, reviewStatus: body.reviewStatus }, null);
      }
    });
    const source = refreshSourceRevision(app.db, id);
    touchProject(app.db, id);
    return { slides: listSlides(app.db, id), sourceRevision: source.revision };
  });

  f.get('/api/slides/:id/history', async (req) => {
    const { id } = req.params as { id: string };
    return { changes: slideHistory(app.db, id) };
  });

  f.post('/api/slide-changes/:id/revert', async (req) => {
    const { id } = req.params as { id: string };
    const slide = revertSlideChange(app.db, id);
    refreshSourceRevision(app.db, slide.projectId);
    return { slide };
  });

  /** Re-run extraction for a stored document (for example after a renderer or limit change). */
  f.post('/api/projects/:id/sources/:docId/extract', async (req, reply) => {
    const { id, docId } = req.params as { id: string; docId: string };
    const doc = getDocument(app.db, docId);
    if (doc.projectId !== id) throw new HttpError(404, 'not_found', 'Source document was not found.');
    const type = doc.kind === 'pdf' ? 'extract_pdf' : 'extract_pptx';
    const { job, created } = createJob(app.db, { projectId: id, type, input: { documentId: docId }, mode: 'local', maxAttempts: 2 });
    return reply.code(created ? 202 : 200).send({ job, document: doc });
  });
}
