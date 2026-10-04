import fs from 'node:fs';
import path from 'node:path';
import type { Asset, AssetLibraryRole, AssetMetadata, AssetProvenance } from '@shared/schemas/assets.ts';
import { ID_PREFIX, newId } from '@shared/schemas/common.ts';
import { DEFAULT_PLACEMENT } from '@shared/schemas/game.ts';
import type { App } from '../app.ts';
import { assetReferenced, computeUsage, findAssetBySha, getAssetRow, insertAssetRow, listAssetRows, toAsset, updateAssetRow, type AssetRow } from '../db/assets.ts';
import { activeBranchId } from '../db/branches.ts';
import { listActiveFrames } from '../db/design.ts';
import { latestBlueprint } from '../db/learning.ts';
import { currentScreenMap } from '../db/screens.ts';
import { listSlides } from '../db/sources.ts';
import { currentVersion } from '../db/versions.ts';
import { conflict } from '../errors.ts';
import { MediaRejection, processAudio, processImage } from '../ingest/media.ts';
import { sniff } from '../ingest/sniff.ts';
import { sha256, writeFileAtomic } from '../storage.ts';

/**
 * Stores an uploaded or extracted media file. The original is kept untouched;
 * a validated display derivative (and a thumbnail for images) is what the
 * studio, the preview and exports use.
 */
export async function storeMedia(
  app: App,
  projectId: string,
  data: Buffer,
  opts: { originalName: string; source: Asset['source']; role?: AssetLibraryRole; alt?: string; replacedFrom?: string | null; dedupe?: boolean; provenance?: AssetProvenance | null },
): Promise<AssetRow> {
  const digest = sha256(data);
  if (opts.dedupe !== false) {
    const existing = findAssetBySha(app.db, projectId, digest);
    if (existing) return existing;
  }
  const kind = sniff(data);
  const limits = { maxBytes: app.config.limits.maxAssetBytes, maxPixels: app.config.limits.maxImagePixels };
  const isAudio = ['mp3', 'ogg', 'wav', 'm4a'].includes(kind);
  const processed = isAudio ? processAudio(data, limits, kind) : await processImage(data, limits, kind);

  const id = newId(ID_PREFIX.asset);
  const dirAbs = path.join(app.storage.projectDir(projectId), 'assets', id);
  fs.mkdirSync(dirAbs, { recursive: true });
  const originalExt = processed.kind === 'image' ? (processed.format === 'jpeg' ? 'jpg' : processed.format) : processed.format;
  const originalFile = `original.${originalExt}`;
  const displayFile = `display.${processed.display.ext}`;
  writeFileAtomic(path.join(dirAbs, originalFile), data);
  writeFileAtomic(path.join(dirAbs, displayFile), processed.display.data);
  let thumbFile: string | null = null;
  if (processed.kind === 'image') {
    thumbFile = 'thumb.webp';
    writeFileAtomic(path.join(dirAbs, thumbFile), processed.thumb.data);
  }

  let placement = DEFAULT_PLACEMENT;
  if (opts.replacedFrom) {
    try {
      placement = toAsset(getAssetRow(app.db, opts.replacedFrom)).metadata.placement;
    } catch {
      // replaced asset no longer exists — keep defaults
    }
  }
  const role: AssetLibraryRole = opts.role ?? (isAudio ? 'audio' : 'unassigned');
  const metadata: AssetMetadata = {
    placement,
    sprite: null,
    replacedFrom: opts.replacedFrom ?? null,
    rasterizedFromSvg: processed.kind === 'image' && processed.rasterizedFromSvg,
    alt: (opts.alt ?? '').slice(0, 160),
    generationPrompt: null,
    provenance: opts.provenance ?? null,
  };
  const baseName = path.basename(opts.originalName).replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'asset';
  const row: Omit<AssetRow, 'created_at'> = {
    id,
    project_id: projectId,
    role,
    kind: processed.kind,
    name: baseName.replace(/\.[^.]+$/, ''),
    original_name: baseName,
    mime: processed.originalMime,
    format: processed.kind === 'image' ? processed.format : processed.format,
    size_bytes: data.length,
    width: processed.kind === 'image' ? processed.width : null,
    height: processed.kind === 'image' ? processed.height : null,
    has_alpha: processed.kind === 'image' ? (processed.hasAlpha ? 1 : 0) : null,
    duration_seconds: processed.kind === 'audio' ? processed.durationSeconds : null,
    source: opts.source,
    sha256: digest,
    stored_dir: app.storage.rel(dirAbs),
    original_file: originalFile,
    display_file: displayFile,
    display_mime: processed.display.mime,
    thumb_file: thumbFile,
    metadata_json: JSON.stringify(metadata),
  };
  insertAssetRow(app.db, row);
  return getAssetRow(app.db, id);
}

export function listAssetsWithUsage(app: App, projectId: string): Asset[] {
  const version = currentVersion(app.db, projectId);
  const blueprint = latestBlueprint(app.db, projectId);
  const map = currentScreenMap(app.db, activeBranchId(app.db, projectId));
  const frameRenders = listActiveFrames(app.db, projectId).map((f) => ({ assetId: f.renderAssetId, name: f.name }));
  const usage = computeUsage(version?.config ?? null, blueprint?.blueprint ?? null, listSlides(app.db, projectId), { mapping: map?.mapping ?? null, frameRenders });
  return listAssetRows(app.db, projectId).map((r) => toAsset(r, usage.get(r.id) ?? []));
}

export function assetFile(app: App, row: AssetRow, variant: 'display' | 'thumb' | 'original'): { file: string; mime: string } {
  const dir = app.storage.abs(row.stored_dir);
  if (variant === 'thumb' && row.thumb_file) return { file: path.join(dir, row.thumb_file), mime: 'image/webp' };
  if (variant === 'original') return { file: path.join(dir, row.original_file), mime: row.mime };
  return { file: path.join(dir, row.display_file), mime: row.display_mime };
}

export function deleteAsset(app: App, id: string): void {
  const row = getAssetRow(app.db, id);
  if (assetReferenced(app.db, row.project_id, id)) {
    throw conflict(
      'This asset is used by a game version, blueprint, design snapshot or screen map, so it cannot be deleted.',
      'Unassign it from scenes and screens first. Earlier versions keep their assets so they stay playable.',
    );
  }
  app.db.run('DELETE FROM assets WHERE id = ?', [id]);
  // Slides that showed it keep their record but lose the asset link.
  for (const s of listSlides(app.db, row.project_id)) {
    if (s.extract.images.some((i) => i.assetId === id)) {
      const extract = { ...s.extract, images: s.extract.images.map((i) => (i.assetId === id ? { ...i, assetId: null } : i)) };
      app.db.run('UPDATE source_slides SET extract_json = ? WHERE id = ?', [JSON.stringify(extract), s.id]);
    }
  }
  fs.rmSync(app.storage.abs(row.stored_dir), { recursive: true, force: true });
}

export function updateAsset(app: App, id: string, patch: { role?: AssetLibraryRole; name?: string; metadata?: Partial<AssetMetadata> }): Asset {
  const row = getAssetRow(app.db, id);
  const current = toAsset(row).metadata;
  updateAssetRow(app.db, id, {
    role: patch.role,
    name: patch.name?.slice(0, 120),
    metadata: patch.metadata ? { ...current, ...patch.metadata } : undefined,
  });
  return toAsset(getAssetRow(app.db, id));
}

/**
 * Combine exact uploaded frames (same size, in the order given) into one
 * sprite sheet asset, so named clips can be set up in the sprite editor.
 * The frames themselves are kept unchanged.
 */
export async function composeSpriteSheet(app: App, projectId: string, input: { assetIds: string[]; name: string; fps: number }): Promise<Asset> {
  if (input.assetIds.length < 2 || input.assetIds.length > 64) throw conflict('Choose between 2 and 64 frames.');
  const rows = input.assetIds.map((id) => getAssetRow(app.db, id));
  if (rows.some((r) => r.project_id !== projectId)) throw conflict('Every frame must belong to this project.');
  if (rows.some((r) => r.kind !== 'image')) throw conflict('Sprite frames must be images.');
  const w = rows[0]!.width ?? 0;
  const h = rows[0]!.height ?? 0;
  if (!w || !h || rows.some((r) => r.width !== w || r.height !== h)) {
    throw conflict('All frames must be the same size to form a sprite sheet.', `The first frame is ${w}×${h}. Export every frame at the same size.`);
  }
  const columns = Math.min(rows.length, Math.max(1, Math.floor(4096 / w)), 8);
  const sheetRows = Math.ceil(rows.length / columns);
  if (columns * w > 4096 || sheetRows * h > 4096) throw conflict('The frames are too large to combine into one sheet (4096 px limit).', 'Use smaller frames or fewer of them.');
  const { default: sharp } = await import('sharp');
  const inputs = rows.map((r, i) => ({ input: fs.readFileSync(path.join(app.storage.abs(r.stored_dir), r.display_file)), left: (i % columns) * w, top: Math.floor(i / columns) * h }));
  const sheet = await sharp({ create: { width: columns * w, height: sheetRows * h, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(inputs)
    .png()
    .toBuffer();
  const created = await storeMedia(app, projectId, sheet, {
    originalName: `${input.name.replace(/[^\w.\- ]+/g, '_').slice(0, 80) || 'sprite'}.png`,
    source: 'uploaded',
    role: 'character',
    dedupe: false,
    provenance: { kind: 'upload', tool: '', note: `Sprite sheet composed in the studio from ${rows.length} uploaded frames: ${rows.map((r) => r.original_name).join(', ').slice(0, 220)}`, figma: null, recordedAt: new Date().toISOString() },
  });
  const asset = toAsset(created);
  return updateAsset(app, asset.id, {
    name: input.name.slice(0, 120) || asset.name,
    metadata: {
      sprite: { frameWidth: w, frameHeight: h, columns, rows: sheetRows, spacing: 0, frameCount: rows.length, fps: input.fps, anchorX: 0.5, anchorY: 1, clips: [] },
      alt: toAsset(rows[0]!).metadata.alt || input.name,
    },
  });
}

export { MediaRejection };
