import { ID_PREFIX, newId } from '@shared/schemas/common.ts';
import type { ExportRecord, Preflight } from '@shared/schemas/exports.ts';
import type { ChatMessage, ChatScope } from '@shared/schemas/records.ts';
import { notFound } from '../errors.ts';
import { redactSecrets } from '../secrets.ts';
import { nowIso, parseJson, type Db } from './db.ts';

// ───────────────────────────── chat messages ─────────────────────────────

interface MessageRow {
  id: string;
  project_id: string;
  role: ChatMessage['role'];
  text: string;
  scope_json: string;
  area: ChatMessage['area'];
  origin: ChatMessage['origin'];
  status: ChatMessage['status'];
  job_id: string | null;
  proposal_id: string | null;
  created_at: string;
}

function toMessage(r: MessageRow): ChatMessage {
  return {
    id: r.id,
    projectId: r.project_id,
    role: r.role,
    text: r.text,
    scope: parseJson<ChatScope>(r.scope_json, { kind: 'project', sceneId: null, slideId: null }),
    area: r.area,
    origin: r.origin,
    status: r.status,
    jobId: r.job_id,
    proposalId: r.proposal_id,
    createdAt: r.created_at,
  };
}

export function insertMessage(
  db: Db,
  m: { projectId: string; role: ChatMessage['role']; text: string; scope: ChatScope; area: ChatMessage['area']; origin: ChatMessage['origin']; status?: ChatMessage['status']; jobId?: string | null; proposalId?: string | null },
): ChatMessage {
  const id = newId(ID_PREFIX.message);
  db.run(
    `INSERT INTO chat_messages (id, project_id, role, text, scope_json, area, origin, status, job_id, proposal_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, m.projectId, m.role, redactSecrets(m.text), JSON.stringify(m.scope), m.area, m.origin, m.status ?? 'complete', m.jobId ?? null, m.proposalId ?? null, nowIso()],
  );
  return getMessage(db, id);
}

export function updateMessage(db: Db, id: string, patch: { text?: string; status?: ChatMessage['status']; jobId?: string; proposalId?: string }): void {
  const sets: string[] = [];
  const params: Array<string | null> = [];
  if (patch.text !== undefined) (sets.push('text = ?'), params.push(redactSecrets(patch.text)));
  if (patch.status) (sets.push('status = ?'), params.push(patch.status));
  if (patch.jobId) (sets.push('job_id = ?'), params.push(patch.jobId));
  if (patch.proposalId) (sets.push('proposal_id = ?'), params.push(patch.proposalId));
  if (sets.length) db.run(`UPDATE chat_messages SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
}

export function getMessage(db: Db, id: string): ChatMessage {
  const r = db.get<MessageRow>('SELECT * FROM chat_messages WHERE id = ?', [id]);
  if (!r) throw notFound('Message');
  return toMessage(r);
}

export function listMessages(db: Db, projectId: string, limit = 200): ChatMessage[] {
  return db
    .all<MessageRow>(
      'SELECT * FROM (SELECT rowid AS seq, * FROM chat_messages WHERE project_id = ? ORDER BY created_at DESC, seq DESC LIMIT ?) ORDER BY created_at, seq',
      [projectId, limit],
    )
    .map(toMessage);
}

// ───────────────────────────── exports ─────────────────────────────

interface ExportRow {
  id: string;
  project_id: string;
  kind: ExportRecord['kind'];
  label: string;
  version_id: string | null;
  version_number: number | null;
  file_path: string;
  file_name: string;
  size_bytes: number;
  include_source_material: number;
  preflight_json: string;
  created_at: string;
  branch_id: string | null;
}

export function toExport(r: ExportRow): ExportRecord {
  return {
    id: r.id,
    projectId: r.project_id,
    kind: r.kind,
    label: r.label,
    versionId: r.version_id,
    versionNumber: r.version_number,
    fileName: r.file_name,
    sizeBytes: r.size_bytes,
    includeSourceMaterial: r.include_source_material === 1,
    createdAt: r.created_at,
    preflight: JSON.parse(r.preflight_json) as Preflight,
    branchId: r.branch_id,
  };
}

export function insertExport(
  db: Db,
  e: { id: string; projectId: string; kind: ExportRecord['kind']; label: string; versionId: string | null; versionNumber: number | null; filePath: string; fileName: string; sizeBytes: number; includeSourceMaterial: boolean; preflight: Preflight; branchId: string | null },
): ExportRecord {
  db.run(
    `INSERT INTO exports (id, project_id, kind, label, version_id, version_number, file_path, file_name, size_bytes, include_source_material, preflight_json, created_at, branch_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [e.id, e.projectId, e.kind, e.label, e.versionId, e.versionNumber, e.filePath, e.fileName, e.sizeBytes, e.includeSourceMaterial ? 1 : 0, JSON.stringify(e.preflight), nowIso(), e.branchId],
  );
  return getExport(db, e.id).record;
}

export function getExport(db: Db, id: string): { record: ExportRecord; filePath: string } {
  const r = db.get<ExportRow>('SELECT * FROM exports WHERE id = ?', [id]);
  if (!r) throw notFound('Export');
  return { record: toExport(r), filePath: r.file_path };
}

export function listExports(db: Db, projectId: string): ExportRecord[] {
  return db.all<ExportRow>('SELECT * FROM exports WHERE project_id = ? ORDER BY created_at DESC LIMIT 50', [projectId]).map(toExport);
}

export function newExportId(): string {
  return newId(ID_PREFIX.export);
}

// ───────────────────────────── settings ─────────────────────────────

export function getSetting<T>(db: Db, key: string, fallback: T): T {
  const r = db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', [key]);
  return r ? parseJson<T>(r.value, fallback) : fallback;
}

export function setSetting(db: Db, key: string, value: unknown): void {
  db.run(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [key, JSON.stringify(value), nowIso()],
  );
}
