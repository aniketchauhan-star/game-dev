import { ID_PREFIX, newId } from '@shared/schemas/common.ts';
import type { BranchSummary } from '@shared/schemas/records.ts';
import { conflict, notFound } from '../errors.ts';
import { nowIso, parseJson, type Db } from './db.ts';

/**
 * Grade versions. Every project has at least one branch ("Main"). A branch
 * owns its blueprint revisions, game versions, screen map, grade profile and
 * motion; sources and immutable assets are shared by the whole project.
 * `projects.current_version_id` always mirrors the active branch's current
 * version, so code that only knows about projects keeps working.
 */

interface BranchRow {
  id: string;
  project_id: string;
  name: string;
  parent_branch_id: string | null;
  forked_from_version_id: string | null;
  current_version_id: string | null;
  revision: number;
  created_at: string;
}

export function activeBranchId(db: Db, projectId: string): string {
  const r = db.get<{ active_branch_id: string | null }>('SELECT active_branch_id FROM projects WHERE id = ?', [projectId]);
  if (!r) throw notFound('Project');
  if (r.active_branch_id) return r.active_branch_id;
  // Projects created before branches existed get their main branch on first use.
  return db.tx(() => ensureMainBranch(db, projectId));
}

/** Create the "Main" branch for a project that has none (new projects, or legacy rows). */
export function ensureMainBranch(db: Db, projectId: string): string {
  const existing = db.get<{ active_branch_id: string | null; current_version_id: string | null; created_at: string }>('SELECT active_branch_id, current_version_id, created_at FROM projects WHERE id = ?', [projectId]);
  if (!existing) throw notFound('Project');
  if (existing.active_branch_id) return existing.active_branch_id;
  const id = `${ID_PREFIX.branch}_${projectId.slice(projectId.indexOf('_') + 1)}`;
  if (!db.get('SELECT 1 FROM game_branches WHERE id = ?', [id])) {
    db.run('INSERT INTO game_branches (id, project_id, name, parent_branch_id, forked_from_version_id, current_version_id, revision, created_at) VALUES (?, ?, ?, NULL, NULL, ?, 0, ?)', [
      id,
      projectId,
      'Main',
      existing.current_version_id,
      existing.created_at,
    ]);
  }
  db.run('UPDATE projects SET active_branch_id = ? WHERE id = ?', [id, projectId]);
  db.run('UPDATE game_versions SET branch_id = ? WHERE project_id = ? AND branch_id IS NULL', [id, projectId]);
  db.run('UPDATE blueprint_revisions SET branch_id = ? WHERE project_id = ? AND branch_id IS NULL', [id, projectId]);
  return id;
}

function gradeLabelOf(db: Db, branchId: string): string {
  const r = db.get<{ profile_json: string }>('SELECT profile_json FROM grade_profiles WHERE branch_id = ? ORDER BY revision DESC LIMIT 1', [branchId]);
  const p = parseJson<{ grade?: number | 'custom'; customLabel?: string } | null>(r?.profile_json, null);
  if (!p || p.grade === undefined) return '';
  return p.grade === 'custom' ? p.customLabel?.trim() || 'Custom group' : `Grade ${p.grade}`;
}

function toBranch(db: Db, r: BranchRow, activeId: string): BranchSummary {
  const v = r.current_version_id ? db.get<{ number: number }>('SELECT number FROM game_versions WHERE id = ?', [r.current_version_id]) : undefined;
  const forked = r.forked_from_version_id ? db.get<{ number: number }>('SELECT number FROM game_versions WHERE id = ?', [r.forked_from_version_id]) : undefined;
  const parent = r.parent_branch_id ? db.get<{ name: string }>('SELECT name FROM game_branches WHERE id = ?', [r.parent_branch_id]) : undefined;
  const versions = db.get<{ c: number }>('SELECT COUNT(*) AS c FROM game_versions WHERE branch_id = ?', [r.id])?.c ?? 0;
  return {
    id: r.id,
    projectId: r.project_id,
    name: r.name,
    parentBranchId: r.parent_branch_id,
    parentName: parent?.name ?? null,
    forkedFromVersionId: r.forked_from_version_id,
    forkedFromVersionNumber: forked?.number ?? null,
    currentVersionId: r.current_version_id,
    currentVersionNumber: v?.number ?? null,
    versionCount: versions,
    gradeLabel: gradeLabelOf(db, r.id),
    active: r.id === activeId,
    revision: r.revision,
    createdAt: r.created_at,
  };
}

export function getBranchRow(db: Db, id: string): BranchRow {
  const r = db.get<BranchRow>('SELECT * FROM game_branches WHERE id = ?', [id]);
  if (!r) throw notFound('Grade version');
  return r;
}

export function getBranch(db: Db, id: string): BranchSummary {
  const r = getBranchRow(db, id);
  return toBranch(db, r, activeBranchId(db, r.project_id));
}

export function listBranches(db: Db, projectId: string): BranchSummary[] {
  const active = activeBranchId(db, projectId);
  return db.all<BranchRow>('SELECT * FROM game_branches WHERE project_id = ? ORDER BY created_at, rowid', [projectId]).map((r) => toBranch(db, r, active));
}

/** Resolve an optional branch id (validated against the project) to a concrete one. */
export function resolveBranch(db: Db, projectId: string, branchId: string | null | undefined): string {
  if (!branchId) return activeBranchId(db, projectId);
  const r = getBranchRow(db, branchId);
  if (r.project_id !== projectId) throw notFound('Grade version');
  return r.id;
}

export function branchCurrentVersionId(db: Db, branchId: string): string | null {
  return getBranchRow(db, branchId).current_version_id;
}

/** Point a branch at a version; keeps the project's mirror in sync when the branch is active. */
export function setBranchCurrentVersion(db: Db, branchId: string, versionId: string): void {
  const b = getBranchRow(db, branchId);
  db.run('UPDATE game_branches SET current_version_id = ?, revision = revision + 1 WHERE id = ?', [versionId, branchId]);
  db.run('UPDATE projects SET current_version_id = ?, updated_at = ? WHERE id = ? AND active_branch_id = ?', [versionId, nowIso(), b.project_id, branchId]);
}

export function setActiveBranch(db: Db, projectId: string, branchId: string): BranchSummary {
  return db.tx(() => {
    const b = getBranchRow(db, branchId);
    if (b.project_id !== projectId) throw notFound('Grade version');
    db.run('UPDATE projects SET active_branch_id = ?, current_version_id = ?, revision = revision + 1, updated_at = ? WHERE id = ?', [branchId, b.current_version_id, nowIso(), projectId]);
    return getBranch(db, branchId);
  });
}

export function renameBranch(db: Db, branchId: string, name: string, expectedRevision: number): BranchSummary {
  return db.tx(() => {
    const b = getBranchRow(db, branchId);
    if (b.revision !== expectedRevision) throw conflict('This grade version changed since you loaded it.', 'Reload and try again.');
    db.run('UPDATE game_branches SET name = ?, revision = revision + 1 WHERE id = ?', [name.trim().slice(0, 60), branchId]);
    return getBranch(db, branchId);
  });
}

export function insertBranch(db: Db, b: { projectId: string; name: string; parentBranchId: string | null; forkedFromVersionId: string | null }): string {
  const id = newId(ID_PREFIX.branch);
  db.run('INSERT INTO game_branches (id, project_id, name, parent_branch_id, forked_from_version_id, current_version_id, revision, created_at) VALUES (?, ?, ?, ?, ?, NULL, 0, ?)', [
    id,
    b.projectId,
    b.name.trim().slice(0, 60) || 'Grade version',
    b.parentBranchId,
    b.forkedFromVersionId,
    nowIso(),
  ]);
  return id;
}

/** A branch can be deleted when it is not the last one and not active; its versions go with it. */
export function deleteBranch(db: Db, projectId: string, branchId: string): void {
  db.tx(() => {
    const b = getBranchRow(db, branchId);
    if (b.project_id !== projectId) throw notFound('Grade version');
    if (activeBranchId(db, projectId) === branchId) throw conflict('Switch to another grade version before deleting this one.');
    const count = db.get<{ c: number }>('SELECT COUNT(*) AS c FROM game_branches WHERE project_id = ?', [projectId])?.c ?? 0;
    if (count <= 1) throw conflict('A project needs at least one grade version.');
    const versionIds = db.all<{ id: string }>('SELECT id FROM game_versions WHERE branch_id = ?', [branchId]).map((r) => r.id);
    for (const table of ['grade_profiles', 'grade_plans', 'motion_plans', 'screen_maps']) db.run(`DELETE FROM ${table} WHERE branch_id = ?`, [branchId]);
    if (versionIds.length) {
      const marks = versionIds.map(() => '?').join(',');
      db.run(`DELETE FROM proposals WHERE base_version_id IN (${marks})`, versionIds);
      db.run(`DELETE FROM game_versions WHERE id IN (${marks})`, versionIds);
    }
    db.run('DELETE FROM blueprint_revisions WHERE branch_id = ?', [branchId]);
    db.run('UPDATE game_branches SET parent_branch_id = ? WHERE parent_branch_id = ?', [b.parent_branch_id, branchId]);
    // Export records keep their version number and file, so downloaded packages stay listed.
    db.run('DELETE FROM game_branches WHERE id = ?', [branchId]);
  });
}
