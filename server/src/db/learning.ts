import { learningAnalysisSchema, type LearningAnalysis } from '@shared/schemas/analysis.ts';
import { blueprintSchema, type Blueprint, type BlueprintRevision } from '@shared/schemas/blueprint.ts';
import { ID_PREFIX, newId, type Provenance } from '@shared/schemas/common.ts';
import type { AnalysisRecord } from '@shared/schemas/records.ts';
import { badRequest, conflict, notFound } from '../errors.ts';
import { activeBranchId } from './branches.ts';
import { nowIso, parseJson, type Db } from './db.ts';
import type { SourceSnapshot } from './sources.ts';

// ───────────────────────────── analyses ─────────────────────────────

interface AnalysisRow {
  id: string;
  project_id: string;
  number: number;
  origin: Provenance;
  model: string | null;
  job_id: string | null;
  source_revision: string;
  source_snapshot_json: string;
  brief_revision: number;
  stale: number;
  stale_reason: string | null;
  analysis_json: string;
  revision: number;
  created_at: string;
}

function toAnalysis(r: AnalysisRow): AnalysisRecord {
  return {
    id: r.id,
    projectId: r.project_id,
    number: r.number,
    origin: r.origin,
    model: r.model,
    sourceRevision: r.source_revision,
    briefRevision: r.brief_revision,
    stale: r.stale === 1,
    staleReason: r.stale_reason,
    analysis: JSON.parse(r.analysis_json) as LearningAnalysis,
    revision: r.revision,
    createdAt: r.created_at,
  };
}

export function insertAnalysis(
  db: Db,
  a: { projectId: string; origin: Provenance; model: string | null; jobId: string | null; sourceRevision: string; snapshot: SourceSnapshot; briefRevision: number; analysis: LearningAnalysis },
): AnalysisRecord {
  const parsed = learningAnalysisSchema.parse(a.analysis);
  return db.tx(() => {
    const number = (db.get<{ n: number | null }>('SELECT MAX(number) AS n FROM analyses WHERE project_id = ?', [a.projectId])?.n ?? 0) + 1;
    const id = newId(ID_PREFIX.analysis);
    db.run(
      `INSERT INTO analyses (id, project_id, number, origin, model, job_id, source_revision, source_snapshot_json, brief_revision, analysis_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, a.projectId, number, a.origin, a.model, a.jobId, a.sourceRevision, JSON.stringify(a.snapshot), a.briefRevision, JSON.stringify(parsed), nowIso()],
    );
    return getAnalysis(db, id);
  });
}

export function getAnalysis(db: Db, id: string): AnalysisRecord {
  const r = db.get<AnalysisRow>('SELECT * FROM analyses WHERE id = ?', [id]);
  if (!r) throw notFound('Learning analysis');
  return toAnalysis(r);
}

export function currentAnalysis(db: Db, projectId: string): AnalysisRecord | null {
  const r = db.get<AnalysisRow>('SELECT * FROM analyses WHERE project_id = ? ORDER BY number DESC LIMIT 1', [projectId]);
  return r ? toAnalysis(r) : null;
}

/** Creator edits to the learning map (verify, reword, lock objectives…). */
export function updateAnalysisContent(db: Db, id: string, analysis: LearningAnalysis, expectedRevision: number): AnalysisRecord {
  const parsed = learningAnalysisSchema.safeParse(analysis);
  if (!parsed.success) throw badRequest('The learning map is not valid.', parsed.error.issues[0]?.message);
  return db.tx(() => {
    const cur = getAnalysis(db, id);
    if (cur.revision !== expectedRevision) throw conflict('The learning map changed since you loaded it.', 'Reload to see the latest version.', { current: cur });
    db.run('UPDATE analyses SET analysis_json = ?, revision = revision + 1 WHERE id = ?', [JSON.stringify(parsed.data), id]);
    return getAnalysis(db, id);
  });
}

// ───────────────────────────── blueprint revisions ─────────────────────────────

interface BlueprintRow {
  id: string;
  project_id: string;
  branch_id: string | null;
  number: number;
  parent_id: string | null;
  status: BlueprintRevision['status'];
  origin: Provenance;
  model: string | null;
  job_id: string | null;
  analysis_id: string | null;
  source_revision: string;
  source_snapshot_json: string;
  stale: number;
  stale_reason: string | null;
  blueprint_json: string;
  revision: number;
  created_at: string;
  approved_at: string | null;
}

function toRevision(r: BlueprintRow): BlueprintRevision {
  return {
    id: r.id,
    projectId: r.project_id,
    branchId: r.branch_id,
    number: r.number,
    parentId: r.parent_id,
    status: r.status,
    origin: r.origin,
    model: r.model,
    analysisId: r.analysis_id,
    sourceRevision: r.source_revision,
    stale: r.stale === 1,
    staleReason: r.stale_reason,
    blueprint: JSON.parse(r.blueprint_json) as Blueprint,
    revision: r.revision,
    createdAt: r.created_at,
    approvedAt: r.approved_at,
  };
}

export function insertBlueprintRevision(
  db: Db,
  b: {
    projectId: string;
    parentId: string | null;
    origin: Provenance;
    model: string | null;
    jobId: string | null;
    analysisId: string | null;
    sourceRevision: string;
    snapshot: SourceSnapshot;
    blueprint: Blueprint;
    /** Grade version; defaults to the parent revision's, then the active one. */
    branchId?: string | null;
  },
): BlueprintRevision {
  const parsed = blueprintSchema.parse(b.blueprint);
  return db.tx(() => {
    const parentBranch = b.parentId ? (db.get<{ branch_id: string | null }>('SELECT branch_id FROM blueprint_revisions WHERE id = ?', [b.parentId])?.branch_id ?? null) : null;
    const branchId = b.branchId ?? parentBranch ?? activeBranchId(db, b.projectId);
    const number = (db.get<{ n: number | null }>('SELECT MAX(number) AS n FROM blueprint_revisions WHERE project_id = ?', [b.projectId])?.n ?? 0) + 1;
    const id = newId(ID_PREFIX.blueprint);
    db.run(
      `INSERT INTO blueprint_revisions (id, project_id, branch_id, number, parent_id, status, origin, model, job_id, analysis_id, source_revision, source_snapshot_json, blueprint_json, created_at)
       VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, b.projectId, branchId, number, b.parentId, b.origin, b.model, b.jobId, b.analysisId, b.sourceRevision, JSON.stringify(b.snapshot), JSON.stringify(parsed), nowIso()],
    );
    return getBlueprintRevision(db, id);
  });
}

export function getBlueprintRevision(db: Db, id: string): BlueprintRevision {
  const r = db.get<BlueprintRow>('SELECT * FROM blueprint_revisions WHERE id = ?', [id]);
  if (!r) throw notFound('Blueprint revision');
  return toRevision(r);
}

export function getBlueprintSnapshot(db: Db, id: string): SourceSnapshot {
  return parseJson(db.get<{ s: string }>('SELECT source_snapshot_json AS s FROM blueprint_revisions WHERE id = ?', [id])?.s, {});
}

/** Revisions of one grade version (the active one by default), newest first. */
export function listBlueprintRevisions(db: Db, projectId: string, branchId?: string | null): BlueprintRevision[] {
  const branch = branchId ?? activeBranchId(db, projectId);
  return db.all<BlueprintRow>('SELECT * FROM blueprint_revisions WHERE project_id = ? AND branch_id = ? ORDER BY number DESC', [projectId, branch]).map(toRevision);
}

export function latestBlueprint(db: Db, projectId: string, branchId?: string | null): BlueprintRevision | null {
  const branch = branchId ?? activeBranchId(db, projectId);
  const r = db.get<BlueprintRow>('SELECT * FROM blueprint_revisions WHERE project_id = ? AND branch_id = ? ORDER BY number DESC LIMIT 1', [projectId, branch]);
  return r ? toRevision(r) : null;
}

export function approvedBlueprint(db: Db, projectId: string, branchId?: string | null): BlueprintRevision | null {
  const branch = branchId ?? activeBranchId(db, projectId);
  const r = db.get<BlueprintRow>("SELECT * FROM blueprint_revisions WHERE project_id = ? AND branch_id = ? AND status = 'approved' ORDER BY number DESC LIMIT 1", [projectId, branch]);
  return r ? toRevision(r) : null;
}

/** Edit a draft. Approved revisions are immutable (also enforced by a database trigger). */
export function updateDraftBlueprint(db: Db, id: string, blueprint: Blueprint, expectedRevision: number, refreshSource?: { revision: string; snapshot: SourceSnapshot }): BlueprintRevision {
  const parsed = blueprintSchema.safeParse(blueprint);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw badRequest('The blueprint is not valid.', issue ? `${issue.path.join('.')}: ${issue.message}` : undefined);
  }
  return db.tx(() => {
    const cur = getBlueprintRevision(db, id);
    if (cur.status !== 'draft') {
      throw conflict(`Blueprint r${cur.number} is ${cur.status} and cannot be edited.`, 'Create a new draft from it — the approved revision stays unchanged.');
    }
    if (cur.revision !== expectedRevision) throw conflict('This draft changed since you loaded it.', 'Reload to see the latest version.', { current: cur });
    if (refreshSource) {
      db.run('UPDATE blueprint_revisions SET blueprint_json = ?, source_revision = ?, source_snapshot_json = ?, stale = 0, stale_reason = NULL, revision = revision + 1 WHERE id = ?', [
        JSON.stringify(parsed.data),
        refreshSource.revision,
        JSON.stringify(refreshSource.snapshot),
        id,
      ]);
    } else {
      db.run('UPDATE blueprint_revisions SET blueprint_json = ?, revision = revision + 1 WHERE id = ?', [JSON.stringify(parsed.data), id]);
    }
    return getBlueprintRevision(db, id);
  });
}

/** Approve a draft: it becomes immutable; previously approved revisions are marked superseded. */
export function approveBlueprint(db: Db, id: string, expectedRevision: number): BlueprintRevision {
  return db.tx(() => {
    const cur = getBlueprintRevision(db, id);
    if (cur.status !== 'draft') throw conflict(`Blueprint r${cur.number} is already ${cur.status}.`);
    if (cur.revision !== expectedRevision) throw conflict('This draft changed since you reviewed it.', 'Review the latest draft before approving.');
    // Approval supersedes the previous approved revision of the same grade version only.
    db.run("UPDATE blueprint_revisions SET status = 'superseded' WHERE project_id = ? AND branch_id IS ? AND status = 'approved'", [cur.projectId, cur.branchId]);
    db.run("UPDATE blueprint_revisions SET status = 'approved', approved_at = ? WHERE id = ?", [nowIso(), id]);
    return getBlueprintRevision(db, id);
  });
}

/** New draft copied from any revision (used when editing an approved blueprint). */
export function createDraftFrom(db: Db, id: string, snapshot: { revision: string; snapshot: SourceSnapshot }): BlueprintRevision {
  const src = getBlueprintRevision(db, id);
  return insertBlueprintRevision(db, {
    projectId: src.projectId,
    parentId: src.id,
    origin: 'creator',
    model: null,
    jobId: null,
    analysisId: src.analysisId,
    sourceRevision: snapshot.revision,
    snapshot: snapshot.snapshot,
    blueprint: src.blueprint,
  });
}
