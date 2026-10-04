import { ID_PREFIX, newId } from '@shared/schemas/common.ts';
import { GAME_CONFIG_SCHEMA_VERSION, gameConfigSchema, type GameConfig } from '@shared/schemas/game.ts';
import type { ChangeOp, ChangeScope, OpResult, ProposalStatus } from '@shared/schemas/proposal.ts';
import type { GameVersion, GameVersionSummary, Proposal } from '@shared/schemas/records.ts';
import { notFound } from '../errors.ts';
import { activeBranchId, getBranchRow, setBranchCurrentVersion } from './branches.ts';
import { nowIso, parseJson, type Db } from './db.ts';

// ───────────────────────────── game versions ─────────────────────────────

interface VersionRow {
  id: string;
  project_id: string;
  branch_id: string | null;
  number: number;
  blueprint_revision_id: string | null;
  blueprint_revision_number: number | null;
  parent_version_id: string | null;
  origin: GameVersionSummary['origin'];
  summary: string;
  demo: number;
  schema_version: number;
  config_json: string;
  created_at: string;
}

function toSummary(r: VersionRow): GameVersionSummary {
  return {
    id: r.id,
    projectId: r.project_id,
    branchId: r.branch_id,
    number: r.number,
    blueprintRevisionId: r.blueprint_revision_id,
    blueprintRevisionNumber: r.blueprint_revision_number,
    parentVersionId: r.parent_version_id,
    origin: r.origin,
    summary: r.summary,
    demo: r.demo === 1,
    createdAt: r.created_at,
  };
}

function toVersion(r: VersionRow): GameVersion {
  return { ...toSummary(r), config: JSON.parse(r.config_json) as GameConfig };
}

export interface NewVersion {
  projectId: string;
  config: GameConfig;
  origin: GameVersionSummary['origin'];
  summary: string;
  blueprintRevisionId: string | null;
  blueprintRevisionNumber: number | null;
  parentVersionId: string | null;
  demo: boolean;
  /** Grade version the new version belongs to; defaults to the parent's branch, then the active one. */
  branchId?: string | null;
}

/**
 * Store a new immutable version and make it current on its grade version — in
 * one transaction, so a failure leaves the previous playable version untouched.
 */
export function insertVersion(db: Db, v: NewVersion): GameVersion {
  return db.tx(() => {
    const parentBranch = v.parentVersionId ? (db.get<{ branch_id: string | null }>('SELECT branch_id FROM game_versions WHERE id = ?', [v.parentVersionId])?.branch_id ?? null) : null;
    const branchId = v.branchId ?? parentBranch ?? activeBranchId(db, v.projectId);
    if (getBranchRow(db, branchId).project_id !== v.projectId) throw notFound('Grade version');
    const number = (db.get<{ n: number | null }>('SELECT MAX(number) AS n FROM game_versions WHERE project_id = ?', [v.projectId])?.n ?? 0) + 1;
    const id = newId(ID_PREFIX.version);
    const config: GameConfig = gameConfigSchema.parse({
      ...v.config,
      id,
      meta: { ...v.config.meta, projectId: v.projectId, versionNumber: number, origin: v.origin, demo: v.demo, branchId },
    });
    db.run(
      `INSERT INTO game_versions (id, project_id, branch_id, number, blueprint_revision_id, blueprint_revision_number, parent_version_id, origin, summary, demo, schema_version, config_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, v.projectId, branchId, number, v.blueprintRevisionId, v.blueprintRevisionNumber, v.parentVersionId, v.origin, v.summary.slice(0, 300), v.demo ? 1 : 0, GAME_CONFIG_SCHEMA_VERSION, JSON.stringify(config), nowIso()],
    );
    setBranchCurrentVersion(db, branchId, id);
    return getVersion(db, id);
  });
}

export function getVersion(db: Db, id: string): GameVersion {
  const r = db.get<VersionRow>('SELECT * FROM game_versions WHERE id = ?', [id]);
  if (!r) throw notFound('Game version');
  return toVersion(r);
}

/** Versions of one grade version (the active one by default), newest first. */
export function listVersions(db: Db, projectId: string, branchId?: string | null): GameVersionSummary[] {
  const branch = branchId ?? activeBranchId(db, projectId);
  return db.all<VersionRow>('SELECT * FROM game_versions WHERE project_id = ? AND branch_id = ? ORDER BY number DESC', [projectId, branch]).map(toSummary);
}

/** Current version of a grade version (the active one by default). */
export function currentVersion(db: Db, projectId: string, branchId?: string | null): GameVersion | null {
  if (branchId) {
    const id = getBranchRow(db, branchId).current_version_id;
    return id ? getVersion(db, id) : null;
  }
  const r = db.get<VersionRow>('SELECT v.* FROM game_versions v JOIN projects p ON p.current_version_id = v.id WHERE p.id = ?', [projectId]);
  return r ? toVersion(r) : null;
}

// ───────────────────────────── proposals ─────────────────────────────

interface ProposalRow {
  id: string;
  project_id: string;
  base_version_id: string;
  scope_json: string;
  request: string;
  summary: string;
  explanation: string;
  ops_json: string;
  results_json: string;
  status: ProposalStatus;
  origin: Proposal['origin'];
  model: string | null;
  job_id: string | null;
  result_version_id: string | null;
  created_at: string;
  resolved_at: string | null;
}

function toProposal(db: Db, r: ProposalRow): Proposal {
  const num = (id: string | null) => (id ? (db.get<{ number: number }>('SELECT number FROM game_versions WHERE id = ?', [id])?.number ?? null) : null);
  return {
    id: r.id,
    projectId: r.project_id,
    baseVersionId: r.base_version_id,
    baseVersionNumber: num(r.base_version_id) ?? 0,
    scope: parseJson<ChangeScope>(r.scope_json, { kind: 'project', sceneId: null }),
    request: r.request,
    summary: r.summary,
    explanation: r.explanation,
    ops: parseJson<ChangeOp[]>(r.ops_json, []),
    results: parseJson<OpResult[]>(r.results_json, []),
    status: r.status,
    origin: r.origin,
    model: r.model,
    resultVersionId: r.result_version_id,
    resultVersionNumber: num(r.result_version_id),
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
  };
}

export function insertProposal(
  db: Db,
  p: { projectId: string; baseVersionId: string; scope: ChangeScope; request: string; summary: string; explanation: string; ops: ChangeOp[]; results: OpResult[]; origin: Proposal['origin']; model: string | null; jobId: string | null; status?: ProposalStatus },
): Proposal {
  const id = newId(ID_PREFIX.proposal);
  db.run(
    `INSERT INTO proposals (id, project_id, base_version_id, scope_json, request, summary, explanation, ops_json, results_json, status, origin, model, job_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, p.projectId, p.baseVersionId, JSON.stringify(p.scope), p.request, p.summary, p.explanation, JSON.stringify(p.ops), JSON.stringify(p.results), p.status ?? 'proposed', p.origin, p.model, p.jobId, nowIso()],
  );
  return getProposal(db, id);
}

export function getProposal(db: Db, id: string): Proposal {
  const r = db.get<ProposalRow>('SELECT * FROM proposals WHERE id = ?', [id]);
  if (!r) throw notFound('Proposed change');
  return toProposal(db, r);
}

export function listProposals(db: Db, projectId: string, limit = 50): Proposal[] {
  return db.all<ProposalRow>('SELECT * FROM proposals WHERE project_id = ? ORDER BY created_at DESC LIMIT ?', [projectId, limit]).map((r) => toProposal(db, r));
}

export function setProposalStatus(db: Db, id: string, status: ProposalStatus, resultVersionId: string | null = null, results?: OpResult[]): void {
  db.run('UPDATE proposals SET status = ?, result_version_id = COALESCE(?, result_version_id), results_json = COALESCE(?, results_json), resolved_at = ? WHERE id = ?', [
    status,
    resultVersionId,
    results ? JSON.stringify(results) : null,
    nowIso(),
    id,
  ]);
}
