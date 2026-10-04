import fs from 'node:fs';
import { parseFigmaUrl, type DesignImport } from '@shared/schemas/design.ts';
import type { Job } from '@shared/schemas/jobs.ts';
import type { App } from '../app.ts';
import { toAsset } from '../db/assets.ts';
import { getDesignImport, insertDesignFrame, insertDesignImport, listDesignImports, listImportFrames, updateDesignImport } from '../db/design.ts';
import { createJob } from '../db/jobs.ts';
import { currentScreenMap, insertScreenMap } from '../db/screens.ts';
import { badRequest, conflict, HttpError } from '../errors.ts';
import { hasFigmaToken } from '../secrets.ts';
import { MediaRejection, storeMedia } from './assets.ts';

/**
 * Design sources: Figma links (read-only API) and exported screens (PNG/JPEG/SVG
 * uploads that work without any Figma connection). Exported screens are flat
 * pictures — visual references or flattened backgrounds, never editable layers.
 */

export function startFigmaImport(app: App, projectId: string, rawLink: string): { import: DesignImport; job: Job } {
  const link = parseFigmaUrl(rawLink);
  if (!link.ok) throw badRequest(link.reason, link.hint);
  if (!hasFigmaToken()) {
    throw new HttpError(409, 'figma_not_configured', 'Figma is not configured on this server.', 'Set FIGMA_ACCESS_TOKEN in the server environment (see Settings → Figma), or use “Upload exported screens”.');
  }
  // Canonical link rebuilt from validated identifiers (no tracking parameters, no pasted text).
  const canonical = `https://www.figma.com/design/${link.fileKey}${link.branchKey ? `/branch/${link.branchKey}` : ''}/${link.nodeId ? `?node-id=${link.nodeId.replace(':', '-')}` : ''}`;
  const imp = insertDesignImport(app.db, {
    projectId,
    kind: 'figma',
    status: 'browsing',
    fileKey: link.fileKey,
    branchKey: link.branchKey,
    requestedNodeId: link.nodeId,
    link: canonical,
    fileName: 'Figma file',
  });
  const { job } = createJob(app.db, { projectId, type: 'figma_browse', input: { importId: imp.id }, mode: 'local', idempotencyKey: null, model: null, maxAttempts: 2 });
  return { import: getDesignImport(app.db, imp.id), job };
}

export function startFrameImport(app: App, projectId: string, importId: string, nodeIds: string[]): { job: Job } {
  const imp = getDesignImport(app.db, importId);
  if (imp.projectId !== projectId) throw badRequest('That design import belongs to another project.');
  if (imp.kind !== 'figma') throw badRequest('Only Figma imports have frames to choose.');
  if (imp.status !== 'browsing') throw conflict(`This import is ${imp.status}.`, imp.status === 'active' ? 'To bring in other frames, paste the link again; to update these, use Refresh.' : undefined);
  const known = new Set(imp.available.map((a) => a.nodeId));
  const unknown = nodeIds.filter((n) => !known.has(n));
  if (unknown.length) throw badRequest('Some selected frames are not in this file listing.', 'Browse the file again.');
  const { job } = createJob(app.db, { projectId, type: 'figma_import', input: { importId, nodeIds }, mode: 'local', idempotencyKey: null, model: null, maxAttempts: 2 });
  return { job };
}

/** Refresh on request: a new import of the same frames, staged for review with a diff. */
export function startRefresh(app: App, projectId: string, importId: string): { import: DesignImport; job: Job } {
  const old = getDesignImport(app.db, importId);
  if (old.projectId !== projectId) throw badRequest('That design import belongs to another project.');
  if (old.kind !== 'figma' || !old.fileKey) throw badRequest('Only Figma imports can be refreshed. Upload new exported screens instead.');
  if (old.status !== 'active') throw conflict('Only the design in use can be refreshed.');
  if (!hasFigmaToken()) throw new HttpError(409, 'figma_not_configured', 'Figma is not configured on this server.', 'Set FIGMA_ACCESS_TOKEN to refresh from Figma.');
  const pending = listDesignImports(app.db, projectId).find((i) => i.previousImportId === importId && ['importing', 'pending-review', 'browsing'].includes(i.status));
  if (pending) throw conflict('A refresh of this design is already waiting for review.', 'Approve or reject it first.');
  const nodeIds = old.frames.map((f) => f.nodeId).filter((n): n is string => Boolean(n));
  if (nodeIds.length === 0) throw conflict('This import has no frames to refresh.');
  const next = insertDesignImport(app.db, {
    projectId,
    kind: 'figma',
    status: 'browsing',
    fileKey: old.fileKey,
    branchKey: old.branchKey,
    requestedNodeId: old.requestedNodeId,
    link: old.link,
    fileName: old.fileName,
    previousImportId: old.id,
  });
  updateDesignImport(app.db, next.id, { available: old.available });
  const { job } = createJob(app.db, { projectId, type: 'figma_import', input: { importId: next.id, nodeIds }, mode: 'local', idempotencyKey: null, model: null, maxAttempts: 2 });
  return { import: getDesignImport(app.db, next.id), job };
}

/**
 * Approve a refresh: it becomes the design in use and the previous import is
 * kept as history. The current screen map of every grade version is re-pointed
 * to the new frame snapshots (same Figma node ids), keeping placements,
 * choices and locks; game versions do not change until the next build/apply.
 */
export function approveRefresh(app: App, projectId: string, importId: string): DesignImport {
  const { db } = app;
  return db.tx(() => {
    const next = getDesignImport(db, importId);
    if (next.projectId !== projectId) throw badRequest('That design import belongs to another project.');
    if (next.status !== 'pending-review' || !next.previousImportId) throw conflict('This refresh is not waiting for review.');
    const oldFrames = listImportFrames(db, next.previousImportId);
    const newFrames = listImportFrames(db, next.id);
    const byNode = new Map(newFrames.map((f) => [f.nodeId, f.id]));
    const remap = new Map<string, string>();
    for (const f of oldFrames) {
      const n = f.nodeId ? byNode.get(f.nodeId) : undefined;
      if (n) remap.set(f.id, n);
    }
    const branches = db.all<{ id: string }>('SELECT id FROM game_branches WHERE project_id = ?', [projectId]);
    for (const b of branches) {
      const map = currentScreenMap(db, b.id);
      if (!map) continue;
      let touched = false;
      const screens = map.mapping.screens.map((s) => {
        const frames = s.frames.map((l) => {
          const to = remap.get(l.frameId);
          if (to) touched = true;
          return to ? { ...l, frameId: to } : l;
        });
        const bgFrame = s.background.frameId ? remap.get(s.background.frameId) : undefined;
        if (bgFrame) touched = true;
        return { ...s, frames, background: bgFrame ? { ...s.background, frameId: bgFrame } : s.background };
      });
      if (touched) {
        insertScreenMap(db, { projectId, branchId: b.id, blueprintRevisionId: map.blueprintRevisionId, origin: 'creator', note: `Design refresh approved (${next.fileName})`, mapping: { screens }, expectedNumber: map.number });
      }
    }
    updateDesignImport(db, next.previousImportId, { status: 'superseded' });
    return updateDesignImport(db, next.id, { status: 'active', approvedAt: new Date().toISOString() });
  });
}

export function rejectRefresh(app: App, projectId: string, importId: string): DesignImport {
  const next = getDesignImport(app.db, importId);
  if (next.projectId !== projectId) throw badRequest('That design import belongs to another project.');
  if (next.status !== 'pending-review') throw conflict('This refresh is not waiting for review.');
  return updateDesignImport(app.db, importId, { status: 'rejected' });
}

/** Remove a design import that is not in use (frames referenced by a current screen map stay). */
export function removeDesignImport(app: App, projectId: string, importId: string): void {
  const { db } = app;
  db.tx(() => {
    const imp = getDesignImport(db, importId);
    if (imp.projectId !== projectId) throw badRequest('That design import belongs to another project.');
    const frameIds = new Set(imp.frames.map((f) => f.id));
    const branches = db.all<{ id: string }>('SELECT id FROM game_branches WHERE project_id = ?', [projectId]);
    for (const b of branches) {
      const map = currentScreenMap(db, b.id);
      if (map?.mapping.screens.some((s) => s.frames.some((l) => frameIds.has(l.frameId)) || (s.background.frameId && frameIds.has(s.background.frameId)))) {
        throw conflict('Screens are still mapped to this design.', 'Unlink its frames in the Screens map first.');
      }
    }
    const used = db.get<{ c: number }>('SELECT COUNT(*) AS c FROM game_versions WHERE project_id = ? AND (' + [...frameIds].map(() => 'config_json LIKE ?').join(' OR ') + ')', [projectId, ...[...frameIds].map((id) => `%"${id}"%`)]);
    if (frameIds.size && used?.c) throw conflict('A game version was built from this design, so it is kept as history.', 'It can be hidden by importing a newer design.');
    db.run('DELETE FROM design_imports WHERE id = ?', [importId]);
  });
}

/**
 * Upload exported screens. Each image becomes a private reference asset and a
 * frame snapshot holding one flattened element. Works without Figma.
 */
export async function uploadExportedScreens(app: App, projectId: string, files: Array<{ path: string; name: string }>): Promise<{ import: DesignImport | null; rejected: Array<{ name: string; message: string; hint: string }> }> {
  const accepted: Array<{ assetId: string; name: string; width: number; height: number }> = [];
  const rejected: Array<{ name: string; message: string; hint: string }> = [];
  for (const f of files) {
    const lower = f.name.toLowerCase();
    if (lower.endsWith('.fig') || lower.endsWith('.jam') || lower.endsWith('.deck')) {
      rejected.push({ name: f.name, message: 'Figma .fig/.jam/.deck files cannot be read.', hint: 'Paste a link to the Figma Design file, or export the frames as PNG, JPEG or SVG and upload those.' });
      continue;
    }
    if (lower.endsWith('.pdf')) {
      rejected.push({ name: f.name, message: 'PDF exports go through the lesson upload.', hint: 'Upload the PDF as a reference in “PPT lesson / storyboard”, or export the frames as PNG/JPEG/SVG.' });
      continue;
    }
    try {
      const data = fs.readFileSync(f.path);
      const row = await storeMedia(app, projectId, data, {
        originalName: f.name,
        source: 'uploaded',
        role: 'reference',
        alt: `Exported screen: ${f.name}`,
        provenance: { kind: 'exported-screen', tool: 'Figma export', note: 'Uploaded exported screen (flat image)', figma: null, recordedAt: new Date().toISOString() },
      });
      const a = toAsset(row);
      if (a.kind !== 'image' || !a.width || !a.height) {
        rejected.push({ name: f.name, message: 'That file is not an image.', hint: 'Exported screens must be PNG, JPEG or SVG.' });
        continue;
      }
      accepted.push({ assetId: a.id, name: f.name.replace(/\.[^.]+$/, ''), width: a.width, height: a.height });
    } catch (err) {
      if (err instanceof MediaRejection) rejected.push({ name: f.name, message: err.message, hint: err.hint });
      else if (err instanceof HttpError) rejected.push({ name: f.name, message: err.message, hint: err.hint ?? '' });
      else throw err;
    }
  }
  if (accepted.length === 0) return { import: null, rejected };
  const imp = app.db.tx(() => {
    const created = insertDesignImport(app.db, {
      projectId,
      kind: 'exported',
      status: 'active',
      fileKey: null,
      branchKey: null,
      requestedNodeId: null,
      link: null,
      fileName: accepted.length === 1 ? accepted[0]!.name : `${accepted.length} exported screens`,
    });
    for (const a of accepted) {
      insertDesignFrame(app.db, {
        projectId,
        importId: created.id,
        nodeId: null,
        name: a.name,
        pageName: '',
        width: a.width,
        height: a.height,
        renderAssetId: a.assetId,
        snapshot: {
          source: 'exported',
          backgroundColor: null,
          elements: [
            {
              id: 'exported-image',
              name: a.name.slice(0, 160),
              type: 'IMAGE',
              kind: 'artwork',
              fidelity: 'flattened',
              box: { x: 0, y: 0, w: a.width, h: a.height },
              rotation: 0,
              opacity: 1,
              z: 0,
              depth: 1,
              parentId: null,
              text: null,
              fill: null,
              cornerRadius: null,
              stroke: null,
              imageRef: null,
              assetId: a.assetId,
              bakedText: true,
              notes: ['A flat picture: any text, labels or buttons in it are part of the image.'],
            },
          ],
          fonts: [],
          prototype: [],
          warnings: [
            'Exported screens are flat pictures. Use one as a reference, or as a background only if it has no text or buttons — the game adds its own readable text and controls. Ask the designer for a clean background layer when needed.',
          ],
        },
      });
    }
    return updateDesignImport(app.db, created.id, { importedAt: new Date().toISOString(), approvedAt: new Date().toISOString() });
  });
  return { import: imp, rejected };
}
