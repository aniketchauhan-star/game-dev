import fs from 'node:fs';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { assetLibraryRole, assetProvenanceSchema, type Asset, type AssetLibraryRole, type AssetProvenance } from '@shared/schemas/assets.ts';
import { placementSchema, spriteSchema } from '@shared/schemas/game.ts';
import type { App } from '../../app.ts';
import { findAssetBySha, getAssetRow, toAsset } from '../../db/assets.ts';
import { sha256 } from '../../storage.ts';
import { getProjectRow, remapIds, touchProject } from '../../db/projects.ts';
import { currentVersion, insertVersion } from '../../db/versions.ts';
import { HttpError, notFound } from '../../errors.ts';
import { assetFile, composeSpriteSheet, deleteAsset, listAssetsWithUsage, MediaRejection, storeMedia, updateAsset } from '../../services/assets.ts';
import { attachment, parse, saveFilePart, sendFile } from '../util.ts';
import { AUDIO_MIME, IMAGE_MIME, sniff } from '../../ingest/sniff.ts';

function mediaError(err: unknown): never {
  if (err instanceof MediaRejection) throw new HttpError(415, `media_${err.code}`, err.message, err.hint);
  throw err;
}

export function assetRoutes(f: FastifyInstance, app: App): void {
  f.get('/api/projects/:id/assets', async (req) => {
    const { id } = req.params as { id: string };
    return { assets: listAssetsWithUsage(app, id) };
  });

  /** Upload one or more images/audio files. Types are validated from file contents, not names. */
  f.post('/api/projects/:id/assets', async (req, reply) => {
    const { id } = req.params as { id: string };
    getProjectRow(app.db, id);
    let role: z.infer<typeof assetLibraryRole> | undefined;
    // Where the creator says the artwork came from (e.g. downloaded from ChatGPT). Fields come before files.
    let origin: 'upload' | 'ai-tool' = 'upload';
    let tool = '';
    const created: string[] = [];
    const rejected: Array<{ name: string; message: string; hint: string }> = [];
    // Files identical to one already in the library are stored once and reported.
    const duplicates: Array<{ name: string; existingId: string; existingName: string; adopted: boolean }> = [];
    for await (const part of req.parts()) {
      if (part.type === 'field') {
        if (part.fieldname === 'role') {
          const r = assetLibraryRole.safeParse(part.value);
          if (r.success) role = r.data;
        }
        if (part.fieldname === 'provenance' && (part.value === 'upload' || part.value === 'ai-tool')) origin = part.value;
        if (part.fieldname === 'tool' && typeof part.value === 'string') tool = part.value.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 60);
        continue;
      }
      const tmp = app.storage.tmpFile('asset');
      try {
        const saved = await saveFilePart(part, tmp, app.config.limits.maxAssetBytes);
        const data = fs.readFileSync(tmp);
        const provenance = {
          kind: origin,
          tool: origin === 'ai-tool' ? tool || 'An AI image tool' : '',
          note: origin === 'ai-tool' ? `Artwork made with ${tool || 'an AI image tool'} and uploaded by the creator` : 'Uploaded by the creator',
          figma: null,
          recordedAt: new Date().toISOString(),
        };
        const same = findAssetBySha(app.db, id, sha256(data));
        if (same) {
          duplicates.push(adoptDuplicate(app, toAsset(same), { fileName: saved.originalName, role, provenance }));
          continue;
        }
        const row = await storeMedia(app, id, data, { originalName: saved.originalName, source: 'uploaded', role, dedupe: true, provenance });
        created.push(row.id);
      } catch (err) {
        if (err instanceof MediaRejection) rejected.push({ name: part.filename, message: err.message, hint: err.hint });
        else if (err instanceof HttpError) rejected.push({ name: part.filename, message: err.message, hint: err.hint ?? '' });
        else throw err;
      } finally {
        fs.rmSync(tmp, { force: true });
      }
    }
    touchProject(app.db, id);
    const assets = listAssetsWithUsage(app, id);
    return reply.code(created.length ? 201 : 200).send({ created: assets.filter((a) => created.includes(a.id)), rejected, duplicates, assets });
  });

  /** Combine exact uploaded frames into a sprite sheet (the frames stay in the library). */
  f.post('/api/projects/:id/assets/compose-sprite', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parse(z.object({ assetIds: z.array(z.string()).min(2).max(64), name: z.string().trim().min(1).max(120), fps: z.number().int().min(1).max(30).default(8) }), req.body);
    getProjectRow(app.db, id);
    const asset = await composeSpriteSheet(app, id, body);
    touchProject(app.db, id);
    return reply.code(201).send({ asset, assets: listAssetsWithUsage(app, id) });
  });

  f.patch('/api/assets/:id', async (req) => {
    const { id } = req.params as { id: string };
    const body = parse(
      z.object({
        role: assetLibraryRole.optional(),
        name: z.string().trim().min(1).max(120).optional(),
        metadata: z
          .object({
            placement: placementSchema.optional(),
            sprite: spriteSchema.nullable().optional(),
            alt: z.string().max(160).optional(),
            generationPrompt: z.string().max(1200).nullable().optional(),
            provenance: assetProvenanceSchema.nullable().optional(),
          })
          .optional(),
      }),
      req.body,
    );
    const asset = updateAsset(app, id, body);
    touchProject(app.db, asset.projectId);
    return { asset };
  });

  f.delete('/api/assets/:id', async (req) => {
    const { id } = req.params as { id: string };
    const row = getAssetRow(app.db, id);
    deleteAsset(app, id);
    touchProject(app.db, row.project_id);
    return { deleted: id };
  });

  /**
   * Replace an asset: the new file keeps the old placement metadata, and the
   * current game version is updated as a new version (older versions keep the
   * original file and stay playable).
   */
  f.post('/api/assets/:id/replace', async (req) => {
    const { id } = req.params as { id: string };
    const old = toAsset(getAssetRow(app.db, id));
    const part = await req.file();
    if (!part) throw new HttpError(400, 'no_file', 'No file was received.');
    const tmp = app.storage.tmpFile('asset');
    let created;
    try {
      const saved = await saveFilePart(part, tmp, app.config.limits.maxAssetBytes);
      const bytes = fs.readFileSync(tmp);
      // Refuse a different kind of media before anything is stored (judged by content, not name).
      const sniffed = sniff(bytes);
      const incoming = IMAGE_MIME[sniffed] ? 'image' : AUDIO_MIME[sniffed] ? 'audio' : null;
      if (incoming && incoming !== old.kind) throw new HttpError(415, 'kind_mismatch', `Replace ${old.kind} with ${old.kind}, not ${incoming}.`);
      created = await storeMedia(app, old.projectId, bytes, { originalName: saved.originalName, source: 'uploaded', role: old.role, alt: old.metadata.alt, replacedFrom: old.id, dedupe: false }).catch(mediaError);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
    const fresh = toAsset(created);
    if (fresh.kind !== old.kind) {
      deleteAsset(app, fresh.id);
      throw new HttpError(415, 'kind_mismatch', `Replace ${old.kind} with ${old.kind}, not ${fresh.kind}.`);
    }
    const version = currentVersion(app.db, old.projectId);
    let newVersion = null;
    if (version && version.config.assets[old.id]) {
      const remapped = remapIds(version.config, new Map([[old.id, fresh.id]]));
      const entry = remapped.assets[fresh.id]!;
      const ext = fresh.kind === 'image' ? (created.display_mime === 'image/jpeg' ? 'jpg' : created.display_mime === 'image/webp' ? 'webp' : 'png') : created.display_file.split('.').pop()!;
      remapped.assets[fresh.id] = {
        ...entry,
        id: fresh.id,
        file: `assets/${fresh.id}.${ext}`,
        mime: created.display_mime as typeof entry.mime,
        width: fresh.width,
        height: fresh.height,
        alt: fresh.metadata.alt || fresh.name,
        placement: fresh.metadata.placement,
      };
      newVersion = insertVersion(app.db, {
        projectId: old.projectId,
        config: remapped,
        origin: 'manual-edit',
        summary: `Replaced asset “${old.name}” with “${fresh.name}” (placement kept)`,
        blueprintRevisionId: version.blueprintRevisionId,
        blueprintRevisionNumber: version.blueprintRevisionNumber,
        parentVersionId: version.id,
        demo: version.demo,
      });
    }
    touchProject(app.db, old.projectId);
    return { asset: fresh, version: newVersion };
  });

  /** Asset bytes. Only validated derivatives are shown inline; SVG originals are download-only. */
  f.get('/api/assets/:id/file', async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = parse(z.object({ variant: z.enum(['display', 'thumb', 'original']).default('display') }), req.query, 'query');
    let row;
    try {
      row = getAssetRow(app.db, id);
    } catch {
      throw notFound('Asset');
    }
    const { file, mime } = assetFile(app, row, q.variant);
    if (!fs.existsSync(file)) throw notFound('Asset file');
    reply.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    if (q.variant === 'original') return sendFile(reply, file, { type: 'application/octet-stream', disposition: attachment(row.original_name) });
    return sendFile(reply, file, { type: mime, cache: 'private, max-age=3600' });
  });
}

/**
 * The creator uploaded a file that is already in the library. An imported copy nobody has sorted
 * yet (a Figma image fill, a slide picture, a design reference) takes the creator's name and role;
 * its import provenance is kept and the creator's statement is added. Anything else is left as it is.
 */
function adoptDuplicate(app: App, existing: Asset, upload: { fileName: string; role: AssetLibraryRole | undefined; provenance: AssetProvenance }): { name: string; existingId: string; existingName: string; adopted: boolean } {
  const imported = existing.source === 'figma' || existing.source === 'extracted';
  const adopt = imported && (existing.role === 'unassigned' || existing.role === 'reference') && Boolean(upload.role) && upload.role !== 'unassigned';
  if (adopt) {
    const p = existing.metadata.provenance;
    const where = p?.figma ? 'It is also an image in the Figma file (imported earlier).' : existing.source === 'extracted' ? 'It is also an image in the lesson deck.' : 'It was imported earlier.';
    // The creator's declaration decides the origin; the import link (e.g. the Figma node) is kept.
    const provenance: AssetProvenance =
      upload.provenance.kind === 'ai-tool'
        ? { ...upload.provenance, figma: p?.figma ?? null, note: `${upload.provenance.note}. ${where}`.slice(0, 300) }
        : p
          ? { ...p, note: `${p.note} The creator uploaded the same file as their own artwork.`.trim().slice(0, 300) }
          : upload.provenance;
    updateAsset(app, existing.id, { role: upload.role, name: upload.fileName.replace(/\.[^.]+$/, '').slice(0, 120) || existing.name, metadata: { provenance } });
  }
  return { name: upload.fileName, existingId: existing.id, existingName: existing.name, adopted: adopt };
}
