import crypto from 'node:crypto';
import { ID_PREFIX, newId } from '@shared/schemas/common.ts';
import {
  designFrameSchema,
  type AvailableFrame,
  type DesignDiff,
  type DesignFidelity,
  type DesignFrame,
  type DesignFrameSummary,
  type DesignImport,
  type DesignImportStatus,
} from '@shared/schemas/design.ts';
import { notFound } from '../errors.ts';
import { nowIso, parseJson, type Db } from './db.ts';

/**
 * DesignImport and DesignFrameSnapshot records. Frames are immutable local
 * snapshots (trigger-enforced) with a checksum, so a later refresh can be
 * compared and approved without touching what the game already uses. No
 * access token or temporary provider URL is ever stored here.
 */

interface ImportRow {
  id: string;
  project_id: string;
  kind: DesignImport['kind'];
  status: DesignImportStatus;
  file_key: string | null;
  branch_key: string | null;
  requested_node_id: string | null;
  link: string | null;
  file_name: string;
  editor_type: string | null;
  source_version: string | null;
  last_modified: string | null;
  access_role: string | null;
  previous_import_id: string | null;
  available_json: string;
  diff_json: string | null;
  warnings_json: string;
  error: string | null;
  revision: number;
  created_at: string;
  imported_at: string | null;
  approved_at: string | null;
}

interface FrameRow {
  id: string;
  project_id: string;
  import_id: string;
  node_id: string | null;
  name: string;
  page_name: string;
  width: number;
  height: number;
  render_asset_id: string | null;
  snapshot_json: string;
  checksum: string;
  created_at: string;
}

type Snapshot = Pick<DesignFrame, 'source' | 'backgroundColor' | 'elements' | 'fonts' | 'prototype' | 'warnings'>;

function toFrame(r: FrameRow): DesignFrame {
  const snap = JSON.parse(r.snapshot_json) as Snapshot;
  return designFrameSchema.parse({
    id: r.id,
    projectId: r.project_id,
    importId: r.import_id,
    nodeId: r.node_id,
    name: r.name,
    pageName: r.page_name,
    width: r.width,
    height: r.height,
    renderAssetId: r.render_asset_id,
    checksum: r.checksum,
    createdAt: r.created_at,
    ...snap,
  });
}

function toFrameSummary(r: FrameRow): DesignFrameSummary {
  const f = toFrame(r);
  const fidelity: Record<DesignFidelity, number> = { editable: 0, flattened: 0, reference: 0, 'needs-review': 0 };
  for (const e of f.elements) fidelity[e.fidelity]++;
  return {
    id: f.id,
    importId: f.importId,
    nodeId: f.nodeId,
    name: f.name,
    pageName: f.pageName,
    width: f.width,
    height: f.height,
    source: f.source,
    renderAssetId: f.renderAssetId,
    checksum: f.checksum,
    createdAt: f.createdAt,
    elementCount: f.elements.length,
    fidelity,
    warningCount: f.warnings.length,
  };
}

function toImport(db: Db, r: ImportRow): DesignImport {
  const frames = db.all<FrameRow>('SELECT * FROM design_frames WHERE import_id = ? ORDER BY created_at, rowid', [r.id]).map(toFrameSummary);
  return {
    id: r.id,
    projectId: r.project_id,
    kind: r.kind,
    status: r.status,
    fileKey: r.file_key,
    branchKey: r.branch_key,
    requestedNodeId: r.requested_node_id,
    link: r.link,
    fileName: r.file_name,
    editorType: r.editor_type,
    sourceVersion: r.source_version,
    lastModified: r.last_modified,
    accessRole: r.access_role,
    previousImportId: r.previous_import_id,
    available: parseJson<AvailableFrame[]>(r.available_json, []),
    diff: parseJson<DesignDiff | null>(r.diff_json, null),
    warnings: parseJson<string[]>(r.warnings_json, []),
    error: r.error,
    frames,
    revision: r.revision,
    createdAt: r.created_at,
    importedAt: r.imported_at,
    approvedAt: r.approved_at,
  };
}

export function insertDesignImport(
  db: Db,
  d: {
    projectId: string;
    kind: DesignImport['kind'];
    status: DesignImportStatus;
    fileKey: string | null;
    branchKey: string | null;
    requestedNodeId: string | null;
    link: string | null;
    fileName: string;
    previousImportId?: string | null;
  },
): DesignImport {
  const id = newId(ID_PREFIX.designImport);
  db.run(
    `INSERT INTO design_imports (id, project_id, kind, status, file_key, branch_key, requested_node_id, link, file_name, previous_import_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, d.projectId, d.kind, d.status, d.fileKey, d.branchKey, d.requestedNodeId, d.link, d.fileName.slice(0, 200), d.previousImportId ?? null, nowIso()],
  );
  return getDesignImport(db, id);
}

export function getDesignImport(db: Db, id: string): DesignImport {
  const r = db.get<ImportRow>('SELECT * FROM design_imports WHERE id = ?', [id]);
  if (!r) throw notFound('Design import');
  return toImport(db, r);
}

export function listDesignImports(db: Db, projectId: string): DesignImport[] {
  return db.all<ImportRow>('SELECT * FROM design_imports WHERE project_id = ? ORDER BY created_at DESC, rowid DESC', [projectId]).map((r) => toImport(db, r));
}

export interface ImportPatch {
  status?: DesignImportStatus;
  fileName?: string;
  editorType?: string | null;
  sourceVersion?: string | null;
  lastModified?: string | null;
  accessRole?: string | null;
  available?: AvailableFrame[];
  diff?: DesignDiff | null;
  warnings?: string[];
  error?: string | null;
  importedAt?: string | null;
  approvedAt?: string | null;
}

export function updateDesignImport(db: Db, id: string, patch: ImportPatch): DesignImport {
  const cols: Record<keyof ImportPatch, string> = {
    status: 'status',
    fileName: 'file_name',
    editorType: 'editor_type',
    sourceVersion: 'source_version',
    lastModified: 'last_modified',
    accessRole: 'access_role',
    available: 'available_json',
    diff: 'diff_json',
    warnings: 'warnings_json',
    error: 'error',
    importedAt: 'imported_at',
    approvedAt: 'approved_at',
  };
  const sets: string[] = ['revision = revision + 1'];
  const params: Array<string | null> = [];
  for (const [k, col] of Object.entries(cols) as Array<[keyof ImportPatch, string]>) {
    if (patch[k] === undefined) continue;
    const v = patch[k];
    sets.push(`${col} = ?`);
    params.push(k === 'available' || k === 'diff' || k === 'warnings' ? (v === null ? null : JSON.stringify(v)) : (v as string | null));
  }
  db.run(`UPDATE design_imports SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
  return getDesignImport(db, id);
}

/** Stable checksum of a frame snapshot (geometry, text, styles, image refs). */
export function snapshotChecksum(s: Snapshot & { width: number; height: number; name: string }): string {
  const material = {
    name: s.name,
    width: s.width,
    height: s.height,
    backgroundColor: s.backgroundColor,
    elements: s.elements.map((e) => ({ ...e, assetId: null })),
    prototype: s.prototype,
  };
  return crypto.createHash('sha256').update(JSON.stringify(material)).digest('hex');
}

export function insertDesignFrame(
  db: Db,
  f: { projectId: string; importId: string; nodeId: string | null; name: string; pageName: string; width: number; height: number; renderAssetId: string | null; snapshot: Snapshot },
): DesignFrame {
  const id = newId(ID_PREFIX.designFrame);
  const checksum = snapshotChecksum({ ...f.snapshot, width: f.width, height: f.height, name: f.name });
  // Validate the full record before it becomes immutable.
  designFrameSchema.parse({ id, projectId: f.projectId, importId: f.importId, nodeId: f.nodeId, name: f.name, pageName: f.pageName, width: f.width, height: f.height, renderAssetId: f.renderAssetId, checksum, createdAt: nowIso(), ...f.snapshot });
  db.run(
    `INSERT INTO design_frames (id, project_id, import_id, node_id, name, page_name, width, height, render_asset_id, snapshot_json, checksum, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, f.projectId, f.importId, f.nodeId, f.name.slice(0, 200), f.pageName.slice(0, 200), f.width, f.height, f.renderAssetId, JSON.stringify(f.snapshot), checksum, nowIso()],
  );
  return getDesignFrame(db, id);
}

export function getDesignFrame(db: Db, id: string): DesignFrame {
  const r = db.get<FrameRow>('SELECT * FROM design_frames WHERE id = ?', [id]);
  if (!r) throw notFound('Design frame');
  return toFrame(r);
}

export function listImportFrames(db: Db, importId: string): DesignFrame[] {
  return db.all<FrameRow>('SELECT * FROM design_frames WHERE import_id = ? ORDER BY created_at, rowid', [importId]).map(toFrame);
}

/** Frames the project can map: from active imports (Figma or exported screens). */
export function listActiveFrames(db: Db, projectId: string): DesignFrame[] {
  return db
    .all<FrameRow>(
      `SELECT f.* FROM design_frames f JOIN design_imports i ON i.id = f.import_id
       WHERE f.project_id = ? AND i.status = 'active' ORDER BY i.created_at, f.created_at, f.rowid`,
      [projectId],
    )
    .map(toFrame);
}

export function framesById(db: Db, ids: string[]): Map<string, DesignFrame> {
  const out = new Map<string, DesignFrame>();
  for (const id of new Set(ids)) {
    const r = db.get<FrameRow>('SELECT * FROM design_frames WHERE id = ?', [id]);
    if (r) out.set(id, toFrame(r));
  }
  return out;
}

// ───────────────────────────── Figma response cache ─────────────────────────────

export function cacheGet<T>(db: Db, key: string): T | null {
  const r = db.get<{ body_json: string; expires_at: number }>('SELECT body_json, expires_at FROM figma_cache WHERE cache_key = ?', [key]);
  if (!r || r.expires_at < Date.now()) return null;
  return parseJson<T | null>(r.body_json, null);
}

export function cachePut(db: Db, projectId: string, key: string, value: unknown, ttlMs: number): void {
  const now = Date.now();
  db.run('INSERT INTO figma_cache (cache_key, project_id, body_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(cache_key) DO UPDATE SET body_json = excluded.body_json, created_at = excluded.created_at, expires_at = excluded.expires_at', [
    key,
    projectId,
    JSON.stringify(value),
    now,
    now + ttlMs,
  ]);
  db.run('DELETE FROM figma_cache WHERE expires_at < ?', [now]);
}
