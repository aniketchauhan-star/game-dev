import { ID_PREFIX, newId } from '@shared/schemas/common.ts';
import { sourceScreenMappingSchema, type ScreenMapRecord, type SourceScreenMapping } from '@shared/schemas/screens.ts';
import { badRequest, conflict, notFound } from '../errors.ts';
import { nowIso, type Db } from './db.ts';

/**
 * SourceScreenMapping revisions. Every save is a new numbered, immutable row
 * (also enforced by a trigger), so creator corrections are reviewed and
 * versioned, and an earlier mapping can always be restored.
 */

interface MapRow {
  id: string;
  project_id: string;
  branch_id: string;
  number: number;
  blueprint_revision_id: string | null;
  origin: ScreenMapRecord['origin'];
  note: string;
  mapping_json: string;
  created_at: string;
}

function toMap(r: MapRow): ScreenMapRecord {
  return {
    id: r.id,
    projectId: r.project_id,
    branchId: r.branch_id,
    number: r.number,
    blueprintRevisionId: r.blueprint_revision_id,
    origin: r.origin,
    note: r.note,
    mapping: sourceScreenMappingSchema.parse(JSON.parse(r.mapping_json)),
    createdAt: r.created_at,
  };
}

export function currentScreenMap(db: Db, branchId: string): ScreenMapRecord | null {
  const r = db.get<MapRow>('SELECT * FROM screen_maps WHERE branch_id = ? ORDER BY number DESC LIMIT 1', [branchId]);
  return r ? toMap(r) : null;
}

export function getScreenMap(db: Db, id: string): ScreenMapRecord {
  const r = db.get<MapRow>('SELECT * FROM screen_maps WHERE id = ?', [id]);
  if (!r) throw notFound('Screen map');
  return toMap(r);
}

export function screenMapAt(db: Db, branchId: string, number: number): ScreenMapRecord | null {
  const r = db.get<MapRow>('SELECT * FROM screen_maps WHERE branch_id = ? AND number = ?', [branchId, number]);
  return r ? toMap(r) : null;
}

export function listScreenMaps(db: Db, branchId: string, limit = 30): Array<Omit<ScreenMapRecord, 'mapping'> & { screens: number; reviewed: number }> {
  return db.all<MapRow>('SELECT * FROM screen_maps WHERE branch_id = ? ORDER BY number DESC LIMIT ?', [branchId, limit]).map((r) => {
    const m = toMap(r);
    const { mapping, ...rest } = m;
    return { ...rest, screens: mapping.screens.length, reviewed: mapping.screens.filter((s) => s.reviewed).length };
  });
}

/**
 * Save a new map revision. `expectedNumber` is the revision the creator edited
 * (0 when none existed); another window saving first is reported, not merged.
 */
export function insertScreenMap(
  db: Db,
  m: { projectId: string; branchId: string; blueprintRevisionId: string | null; origin: ScreenMapRecord['origin']; note: string; mapping: SourceScreenMapping; expectedNumber: number | null },
): ScreenMapRecord {
  const parsed = sourceScreenMappingSchema.safeParse(m.mapping);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw badRequest('The screen map is not valid.', issue ? `${issue.path.join('.')}: ${issue.message}` : undefined);
  }
  const ids = parsed.data.screens.map((s) => s.screenId);
  if (new Set(ids).size !== ids.length) throw badRequest('Each game screen can appear only once in the map.');
  return db.tx(() => {
    const cur = currentScreenMap(db, m.branchId);
    const curNumber = cur?.number ?? 0;
    if (m.expectedNumber !== null && m.expectedNumber !== curNumber) {
      throw conflict('The screen map was saved from another window.', 'Reload to see the latest map, then make your change again.', { currentNumber: curNumber });
    }
    const id = newId(ID_PREFIX.screenMap);
    db.run('INSERT INTO screen_maps (id, project_id, branch_id, number, blueprint_revision_id, origin, note, mapping_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [
      id,
      m.projectId,
      m.branchId,
      curNumber + 1,
      m.blueprintRevisionId,
      m.origin,
      m.note.slice(0, 300),
      JSON.stringify(parsed.data),
      nowIso(),
    ]);
    db.run('UPDATE projects SET updated_at = ? WHERE id = ?', [nowIso(), m.projectId]);
    return getScreenMap(db, id);
  });
}
