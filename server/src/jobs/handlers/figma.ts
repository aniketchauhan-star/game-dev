import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import type { AvailableFrame, DesignDiff, DesignElement, DesignFrame } from '@shared/schemas/design.ts';
import { toAsset } from '../../db/assets.ts';
import { getDesignImport, insertDesignFrame, listImportFrames, updateDesignImport } from '../../db/design.ts';
import { assertDesignFile, FigmaError, type FigmaNode } from '../../figma/client.ts';
import { figmaClient } from '../../figma/index.ts';
import { listFrames, snapshotFrame } from '../../figma/snapshot.ts';
import { redactSecrets } from '../../secrets.ts';
import { storeMedia } from '../../services/assets.ts';
import { writeFileAtomic } from '../../storage.ts';
import { JobFailure, type JobContext } from '../context.ts';

/** Turn a Figma error into a job failure the creator can act on (and record it on the import). */
function failed(ctx: JobContext, importId: string, err: unknown, resetStatus: 'browsing' | 'failed'): never {
  if (err instanceof FigmaError) {
    const message = redactSecrets(`${err.message} ${err.hint}`.trim());
    updateDesignImport(ctx.app.db, importId, { status: resetStatus, error: message });
    throw new JobFailure(message, `figma_${err.code}`, err.retryable);
  }
  updateDesignImport(ctx.app.db, importId, { status: resetStatus, error: 'The import stopped unexpectedly. Retry, or upload exported screens instead.' });
  throw err;
}

const safeName = (nodeId: string) => nodeId.replace(/[^0-9a-zA-Z]/g, '-');

/**
 * List the frames of a linked Figma Design file with thumbnails. Fetches only
 * a shallow tree (or the linked node), never the whole file.
 */
export async function handleFigmaBrowse(ctx: JobContext<'figma_browse'>) {
  const { app } = ctx;
  const { importId } = ctx.input();
  const imp = getDesignImport(app.db, importId);
  if (imp.projectId !== ctx.projectId || imp.kind !== 'figma' || !imp.fileKey) throw new JobFailure('Design import not found.', 'not_found', false);
  const key = imp.branchKey ?? imp.fileKey;
  const client = figmaClient(app, { projectId: ctx.projectId, signal: ctx.signal, onWait: (s) => ctx.event('warning', `Figma asked us to slow down — waiting ${s} s before retrying.`) });
  try {
    ctx.stage('file', 'Reading the file structure from Figma');
    let fileName = imp.fileName;
    let meta: { editorType?: string; version?: string; lastModified?: string; role?: string };
    let frames: Array<{ node: FigmaNode; pageName: string }>;
    if (imp.requestedNodeId) {
      const res = await client.getNodes(key, [imp.requestedNodeId], { depth: 2 });
      assertDesignFile(res.editorType);
      meta = res;
      fileName = res.name;
      const doc = res.nodes[imp.requestedNodeId]?.document;
      if (!doc) throw new FigmaError('not_found', 'The frame in this link no longer exists in the file.', 'Copy a fresh link to the frame, or paste the file link to choose from all frames.', false);
      if (doc.type === 'CANVAS' || doc.type === 'SECTION') frames = listFrames({ id: '0:0', name: 'Document', type: 'DOCUMENT', children: [doc.type === 'CANVAS' ? doc : { id: 'page', name: doc.name, type: 'CANVAS', children: [doc] }] }, null);
      else frames = [{ node: doc, pageName: '' }];
    } else {
      const file = await client.getFileShallow(key, { fresh: true });
      assertDesignFile(file.editorType);
      meta = file;
      fileName = file.name;
      frames = listFrames(file.document, null);
    }
    ctx.event('info', `Found ${frames.length} frame${frames.length === 1 ? '' : 's'} in “${fileName}”.`);
    if (frames.length === 0) throw new FigmaError('not_found', 'No frames were found in this file.', 'Link to a page or frame that contains top-level frames, or upload exported screens.', false);

    ctx.stage('thumbs', 'Rendering frame thumbnails');
    const shown = frames.slice(0, 60);
    const urls = await client.renderImages(key, shown.map((f) => f.node.id), { format: 'png', scale: 0.2 });
    const dir = path.join(app.storage.projectDir(ctx.projectId), 'design', importId, 'thumbs');
    fs.mkdirSync(dir, { recursive: true });
    const available: AvailableFrame[] = [];
    for (const f of frames) {
      ctx.throwIfCancelled();
      const b = f.node.absoluteBoundingBox as { width?: number; height?: number } | undefined;
      const entry: AvailableFrame = {
        nodeId: f.node.id,
        name: String(f.node.name).slice(0, 200),
        pageName: f.pageName.slice(0, 200),
        type: f.node.type.slice(0, 40),
        width: Math.round(Number(b?.width ?? 0)),
        height: Math.round(Number(b?.height ?? 0)),
        childCount: f.node.children?.length ?? 0,
        thumbFile: null,
        thumbError: null,
      };
      const url = urls[f.node.id];
      if (url === undefined) entry.thumbError = 'Not rendered (only the first 60 frames get thumbnails).';
      else if (url === null) entry.thumbError = 'Figma could not render this frame.';
      else {
        try {
          const { data } = await client.download(url, { maxBytes: 4 * 1024 * 1024 });
          const png = await sharp(data, { limitInputPixels: 40_000_000 }).resize({ width: 480, height: 480, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
          const file = path.join(dir, `${safeName(f.node.id)}.png`);
          writeFileAtomic(file, png);
          entry.thumbFile = path.relative(app.storage.projectDir(ctx.projectId), file).split(path.sep).join('/');
        } catch (err) {
          entry.thumbError = err instanceof FigmaError ? err.message : 'The thumbnail could not be read.';
        }
      }
      available.push(entry);
    }
    updateDesignImport(app.db, importId, {
      status: 'browsing',
      fileName,
      editorType: meta.editorType ?? 'figma',
      sourceVersion: meta.version ?? null,
      lastModified: meta.lastModified ?? null,
      accessRole: meta.role ?? null,
      available,
      error: null,
      warnings: frames.length > 60 ? [`The file has ${frames.length} frames; thumbnails are shown for the first 60.`] : [],
    });
    return { frames: available.length, requests: client.requests };
  } catch (err) {
    if (err instanceof JobFailure) throw err;
    if (ctx.signal.aborted) throw err;
    failed(ctx, importId, err, imp.available.length ? 'browsing' : 'failed');
  }
}

function describeChanges(oldF: DesignFrame, next: { name: string; width: number; height: number; elements: DesignElement[] }): string[] {
  const out: string[] = [];
  if (oldF.name !== next.name) out.push(`Renamed from “${oldF.name}” to “${next.name}”.`);
  if (Math.round(oldF.width) !== Math.round(next.width) || Math.round(oldF.height) !== Math.round(next.height)) out.push(`Size changed from ${Math.round(oldF.width)}×${Math.round(oldF.height)} to ${Math.round(next.width)}×${Math.round(next.height)}.`);
  const before = new Map(oldF.elements.map((e) => [e.id, e]));
  const after = new Map(next.elements.map((e) => [e.id, e]));
  const added = [...after.keys()].filter((k) => !before.has(k));
  const removed = [...before.keys()].filter((k) => !after.has(k));
  if (added.length) out.push(`${added.length} layer${added.length === 1 ? '' : 's'} added.`);
  if (removed.length) out.push(`${removed.length} layer${removed.length === 1 ? '' : 's'} removed.`);
  let moved = 0;
  for (const [id, a] of after) {
    const b = before.get(id);
    if (!b) continue;
    if (a.text && b.text && a.text.characters !== b.text.characters) out.push(`Text “${b.text.characters.slice(0, 40)}” changed to “${a.text.characters.slice(0, 40)}”.`);
    if (Math.abs(a.box.x - b.box.x) > 0.5 || Math.abs(a.box.y - b.box.y) > 0.5 || Math.abs(a.box.w - b.box.w) > 0.5 || Math.abs(a.box.h - b.box.h) > 0.5) moved++;
    if (a.imageRef !== b.imageRef) out.push(`Image in “${a.name.slice(0, 40)}” changed.`);
    if (a.fill !== b.fill) out.push(`Colour of “${a.name.slice(0, 40)}” changed.`);
  }
  if (moved) out.push(`${moved} layer${moved === 1 ? '' : 's'} moved or resized.`);
  return out.slice(0, 20);
}

/**
 * Import selected frames: node data for exactly those frames, a render of each
 * (stored as a private reference asset), approved image fills, and an
 * immutable snapshot. A refresh (previous import set) is staged as
 * “pending review” with a diff instead of replacing what the game uses.
 */
export async function handleFigmaImport(ctx: JobContext<'figma_import'>) {
  const { app } = ctx;
  const { importId, nodeIds } = ctx.input();
  const imp = getDesignImport(app.db, importId);
  if (imp.projectId !== ctx.projectId || imp.kind !== 'figma' || !imp.fileKey) throw new JobFailure('Design import not found.', 'not_found', false);
  if (imp.frames.length > 0) throw new JobFailure('These frames were already imported.', 'already_imported', false);
  const key = imp.branchKey ?? imp.fileKey;
  const client = figmaClient(app, { projectId: ctx.projectId, signal: ctx.signal, onWait: (s) => ctx.event('warning', `Figma asked us to slow down — waiting ${s} s before retrying.`) });
  updateDesignImport(app.db, importId, { status: 'importing', error: null });
  try {
    ctx.stage('nodes', `Reading ${nodeIds.length} selected frame${nodeIds.length === 1 ? '' : 's'}`);
    const res = await client.getNodes(key, nodeIds, { fresh: true });
    assertDesignFile(res.editorType);
    const present: FigmaNode[] = [];
    const warnings: string[] = [];
    for (const id of nodeIds) {
      const doc = res.nodes[id]?.document;
      if (!doc) warnings.push(`Frame ${id} no longer exists in the file and was skipped.`);
      else present.push(doc);
    }
    if (present.length === 0) throw new FigmaError('not_found', 'None of the selected frames exist in the file any more.', 'Browse the file again and select current frames.', false);

    ctx.stage('render', 'Rendering frames as reference images');
    const widest = Math.max(...present.map((n) => Number((n.absoluteBoundingBox as { width?: number } | undefined)?.width ?? 1920)));
    const scale = Math.min(2, Math.max(0.5, 1920 / Math.max(1, widest)));
    const renderUrls = await client.renderImages(key, present.map((n) => n.id), { format: 'png', scale });

    const snapshots = present.map((node) => ({ node, snap: snapshotFrame(node) }));
    const refs = [...new Set(snapshots.flatMap((s) => s.snap.imageRefs))];
    const refAssets = new Map<string, string>();
    if (refs.length) {
      ctx.stage('fills', `Importing ${refs.length} image placement${refs.length === 1 ? '' : 's'}`);
      const fillUrls = await client.imageFills(key);
      for (const ref of refs.slice(0, 40)) {
        ctx.throwIfCancelled();
        const url = fillUrls[ref];
        if (!url) {
          warnings.push(`An image placement could not be downloaded (Figma did not return it); it stays a reference.`);
          continue;
        }
        try {
          const { data } = await client.download(url);
          const row = await storeMedia(app, ctx.projectId, data, {
            originalName: `figma-image-${ref.slice(0, 12)}.png`,
            source: 'figma',
            role: 'unassigned',
            provenance: { kind: 'figma', tool: 'Figma', note: `Image fill from “${res.name}”`, figma: { fileKey: imp.fileKey, nodeId: null, imageRef: ref, sourceVersion: res.version ?? null, importId, kind: 'image-fill' }, recordedAt: new Date().toISOString() },
          });
          refAssets.set(ref, row.id);
        } catch (err) {
          warnings.push(`An image placement could not be imported: ${err instanceof FigmaError ? err.message : (err as Error).message}`);
        }
      }
    }

    ctx.stage('snapshot', 'Saving local snapshots');
    const prepared: Array<Parameters<typeof insertDesignFrame>[1]> = [];
    for (const { node, snap } of snapshots) {
      ctx.throwIfCancelled();
      const b = (node.absoluteBoundingBox ?? {}) as { width?: number; height?: number };
      let renderAssetId: string | null = null;
      const url = renderUrls[node.id];
      if (url) {
        try {
          const { data } = await client.download(url);
          const row = await storeMedia(app, ctx.projectId, data, {
            originalName: `Figma - ${String(node.name).slice(0, 80)}.png`,
            source: 'figma',
            role: 'reference',
            alt: `Design reference: ${String(node.name).slice(0, 120)}`,
            provenance: { kind: 'figma', tool: 'Figma', note: `Frame render from “${res.name}”`, figma: { fileKey: imp.fileKey, nodeId: node.id, imageRef: null, sourceVersion: res.version ?? null, importId, kind: 'frame-render' }, recordedAt: new Date().toISOString() },
          });
          renderAssetId = toAsset(row).id;
        } catch (err) {
          warnings.push(`“${node.name}”: the reference render could not be downloaded (${err instanceof FigmaError ? err.message : 'unknown error'}).`);
        }
      } else {
        warnings.push(`Figma could not render “${node.name}”. Its layers were imported; upload an exported PNG if you need the picture.`);
      }
      const elements = snap.elements.map((e) => (e.imageRef && refAssets.has(e.imageRef) ? { ...e, assetId: refAssets.get(e.imageRef)! } : e));
      prepared.push({
        projectId: ctx.projectId,
        importId,
        nodeId: node.id,
        name: String(node.name),
        pageName: imp.available.find((a) => a.nodeId === node.id)?.pageName ?? '',
        width: Number(b.width ?? 1),
        height: Number(b.height ?? 1),
        renderAssetId,
        snapshot: { source: 'figma', backgroundColor: snap.backgroundColor, elements, fonts: snap.fonts, prototype: snap.prototype, warnings: snap.warnings },
      });
    }

    // Diff against the import this one refreshes (if any).
    let diff: DesignDiff | null = null;
    if (imp.previousImportId) {
      const old = listImportFrames(app.db, imp.previousImportId);
      const oldByNode = new Map(old.map((f) => [f.nodeId ?? f.id, f]));
      const newByNode = new Map(prepared.map((p) => [p.nodeId ?? '', p]));
      diff = {
        framesAdded: prepared.filter((p) => !oldByNode.has(p.nodeId ?? '')).map((p) => ({ nodeId: p.nodeId ?? '', name: p.name })),
        framesRemoved: old.filter((f) => !newByNode.has(f.nodeId ?? '')).map((f) => ({ nodeId: f.nodeId ?? '', name: f.name })),
        framesChanged: [],
        unchanged: 0,
      };
      for (const p of prepared) {
        const o = oldByNode.get(p.nodeId ?? '');
        if (!o) continue;
        const changes = describeChanges(o, { name: p.name, width: p.width, height: p.height, elements: p.snapshot.elements });
        if (changes.length) diff.framesChanged.push({ nodeId: p.nodeId ?? '', name: p.name, changes });
        else diff.unchanged++;
      }
    }

    app.db.tx(() => {
      for (const p of prepared) insertDesignFrame(app.db, p);
      updateDesignImport(app.db, importId, {
        status: imp.previousImportId ? 'pending-review' : 'active',
        fileName: res.name,
        editorType: res.editorType ?? 'figma',
        sourceVersion: res.version ?? null,
        lastModified: res.lastModified ?? null,
        accessRole: res.role ?? null,
        warnings: [...imp.warnings, ...warnings].slice(0, 40),
        diff,
        error: null,
        importedAt: new Date().toISOString(),
      });
    });
    ctx.event('info', `Imported ${prepared.length} frame${prepared.length === 1 ? '' : 's'} (${refAssets.size} image placement${refAssets.size === 1 ? '' : 's'}).${imp.previousImportId ? ' The refresh is waiting for your review.' : ''}`);
    for (const w of warnings) ctx.event('warning', w);
    return { frames: prepared.length, images: refAssets.size, requests: client.requests, pendingReview: Boolean(imp.previousImportId) };
  } catch (err) {
    if (err instanceof JobFailure) throw err;
    if (ctx.signal.aborted) {
      updateDesignImport(app.db, importId, { status: 'browsing' });
      throw err;
    }
    failed(ctx, importId, err, 'browsing');
  }
}
