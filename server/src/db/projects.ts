import fs from 'node:fs';
import path from 'node:path';
import { defaultBrief, gameBriefSchema, type GameBrief } from '@shared/schemas/brief.ts';
import { ID_PREFIX, newId } from '@shared/schemas/common.ts';
import { JOB_LABELS, type Job } from '@shared/schemas/jobs.ts';
import type { CreateStep, ProjectDetail, ProjectState, ProjectSummary, StatusLabel } from '@shared/schemas/project.ts';
import { badRequest, conflict, notFound } from '../errors.ts';
import { copyDir, type Storage } from '../storage.ts';
import { activeBranchId, ensureMainBranch, listBranches } from './branches.ts';
import { nowIso, parseJson, type Db } from './db.ts';
import { activeJobs, toJob, type JobRow } from './jobs.ts';
import { currentSnapshot, listDocuments, sourceRevisionOf } from './sources.ts';

export const DEFAULT_PROJECT_NAME = 'Untitled game';

interface ProjectRow {
  id: string;
  name: string;
  is_sample: number;
  state: ProjectState;
  create_step: CreateStep;
  brief_json: string;
  brief_revision: number;
  content_reviewed_at: string | null;
  current_version_id: string | null;
  active_branch_id: string | null;
  source_revision: string;
  revision: number;
  created_at: string;
  updated_at: string;
}

export function getProjectRow(db: Db, id: string): ProjectRow {
  const r = db.get<ProjectRow>('SELECT * FROM projects WHERE id = ?', [id]);
  if (!r) throw notFound('Project');
  return r;
}

export function projectBrief(r: ProjectRow): GameBrief {
  const parsed = gameBriefSchema.safeParse(parseJson(r.brief_json, null));
  return parsed.success ? parsed.data : defaultBrief();
}

export function createProject(db: Db, opts: { name: string; isSample?: boolean; brief?: GameBrief }): string {
  const id = newId(ID_PREFIX.project);
  const now = nowIso();
  db.tx(() => {
    db.run(
      `INSERT INTO projects (id, name, is_sample, state, create_step, brief_json, brief_revision, source_revision, revision, created_at, updated_at)
       VALUES (?, ?, ?, 'draft', 'source', ?, 0, '', 0, ?, ?)`,
      [id, opts.name.slice(0, 120) || DEFAULT_PROJECT_NAME, opts.isSample ? 1 : 0, JSON.stringify(opts.brief ?? defaultBrief()), now, now],
    );
    // Every project starts with one grade version ("Main").
    ensureMainBranch(db, id);
  });
  return id;
}

/** Grade label of the active grade version's profile ("Grade 8"), or '' when none is set. */
function activeGradeLabel(db: Db, r: ProjectRow): string {
  const branch = r.active_branch_id ?? activeBranchId(db, r.id);
  const row = db.get<{ profile_json: string }>('SELECT profile_json FROM grade_profiles WHERE branch_id = ? ORDER BY revision DESC LIMIT 1', [branch]);
  const p = parseJson<{ grade?: number | 'custom'; customLabel?: string } | null>(row?.profile_json, null);
  if (!p || p.grade === undefined) return '';
  return p.grade === 'custom' ? p.customLabel?.trim() || 'Custom group' : `Grade ${p.grade}`;
}

export function touchProject(db: Db, id: string): void {
  db.run('UPDATE projects SET updated_at = ? WHERE id = ?', [nowIso(), id]);
}

interface Derived {
  state: ProjectState;
  statusLabel: StatusLabel;
  statusDetail: string | null;
  lastProblemJob: Job | null;
}

/**
 * Project state comes from artifacts and active jobs. A failed job never
 * erases the last successful game — it only adds “Needs attention”.
 */
export function deriveStatus(db: Db, r: ProjectRow): Derived {
  const active = activeJobs(db, r.id);
  const has = (type: Job['type']) => active.some((j) => j.type === type);
  const slideCount = db.get<{ c: number }>('SELECT COUNT(*) AS c FROM source_slides WHERE project_id = ?', [r.id])?.c ?? 0;
  const branch = r.active_branch_id ?? activeBranchId(db, r.id);
  const approved = db.get<{ id: string; stale: number; number: number }>("SELECT id, stale, number FROM blueprint_revisions WHERE project_id = ? AND branch_id = ? AND status = 'approved' ORDER BY number DESC LIMIT 1", [r.id, branch]);
  const anyBlueprint = db.get<{ id: string }>('SELECT id FROM blueprint_revisions WHERE project_id = ? AND branch_id = ? LIMIT 1', [r.id, branch]);
  const primary = db.get<{ status: string; error: string | null }>("SELECT status, error FROM source_documents WHERE project_id = ? AND kind = 'pptx' ORDER BY created_at DESC LIMIT 1", [r.id]);
  const version = r.current_version_id ? db.get<{ number: number }>('SELECT number FROM game_versions WHERE id = ?', [r.current_version_id]) : undefined;

  let state: ProjectState;
  if (has('extract_pptx')) state = 'extracting';
  else if (has('analyze') || has('blueprint')) state = 'analyzing';
  else if (has('build')) state = 'building';
  else if (version) state = 'playable';
  else if (approved) state = 'approved';
  else if (anyBlueprint) state = 'blueprint_ready';
  else if (slideCount > 0) state = 'needs_review';
  else if (primary?.status === 'failed') state = 'failed';
  else state = 'draft';

  // Latest job of each type; failures that were not followed by a success need attention.
  const latestPerType = db.all<JobRow>(
    `SELECT j.* FROM jobs j JOIN (SELECT type, MAX(created_at) AS m FROM jobs WHERE project_id = ? GROUP BY type) t
       ON j.type = t.type AND j.created_at = t.m WHERE j.project_id = ?`,
    [r.id, r.id],
  );
  const problem = latestPerType
    .filter((j) => (j.status === 'failed' || j.status === 'interrupted') && j.dismissed === 0 && j.type !== 'ask')
    .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  const lastProblemJob = problem ? toJob(problem) : null;
  if (!version && !approved && !anyBlueprint && slideCount === 0) {
    const lastCancelled = latestPerType.find((j) => j.status === 'cancelled');
    if (lastCancelled && state === 'draft') state = 'cancelled';
  }

  let statusLabel: StatusLabel;
  let statusDetail: string | null = null;
  if (primary?.status === 'failed' && slideCount === 0) {
    statusLabel = 'Needs attention';
    statusDetail = primary.error ? `Import failed: ${primary.error}` : 'The deck could not be imported.';
  } else if (lastProblemJob) {
    statusLabel = 'Needs attention';
    const what = JOB_LABELS[lastProblemJob.type];
    statusDetail = `${what} ${lastProblemJob.status === 'interrupted' ? 'was interrupted' : 'failed'}${version ? ` — v${version.number} is still playable` : ''}.`;
  } else if (approved?.stale === 1) {
    statusLabel = 'Needs attention';
    statusDetail = `Source changed after blueprint r${approved.number} was approved.`;
  } else if (version) {
    statusLabel = 'Playable';
    statusDetail = `Version ${version.number}`;
  } else if (approved) {
    statusLabel = 'Blueprint approved';
    statusDetail = `Blueprint r${approved.number}`;
  } else if (r.content_reviewed_at) {
    statusLabel = 'Content reviewed';
  } else {
    statusLabel = 'Draft';
    statusDetail = slideCount > 0 ? `${slideCount} slides imported` : null;
  }
  return { state, statusLabel, statusDetail, lastProblemJob };
}

export function toSummary(db: Db, r: ProjectRow): ProjectSummary {
  const brief = projectBrief(r);
  const derived = deriveStatus(db, r);
  if (derived.state !== r.state) db.run('UPDATE projects SET state = ? WHERE id = ?', [derived.state, r.id]);
  const slideCount = db.get<{ c: number }>('SELECT COUNT(*) AS c FROM source_slides WHERE project_id = ?', [r.id])?.c ?? 0;
  const version = r.current_version_id ? db.get<{ number: number }>('SELECT number FROM game_versions WHERE id = ?', [r.current_version_id]) : undefined;
  return {
    id: r.id,
    name: r.name,
    subject: brief.subject,
    gradeOrAge: activeGradeLabel(db, r) || brief.gradeOrAge,
    isSample: r.is_sample === 1,
    state: derived.state,
    statusLabel: derived.statusLabel,
    statusDetail: derived.statusDetail,
    themeId: brief.visual.themeId,
    paletteId: brief.visual.paletteId,
    slideCount,
    currentVersionNumber: version?.number ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    revision: r.revision,
  };
}

export function listProjects(db: Db, search: string): ProjectSummary[] {
  const rows = db.all<ProjectRow>('SELECT * FROM projects ORDER BY updated_at DESC');
  const q = search.trim().toLowerCase();
  return rows
    .map((r) => toSummary(db, r))
    .filter((p) => !q || [p.name, p.subject, p.gradeOrAge].some((v) => v.toLowerCase().includes(q)));
}

export function projectDetail(db: Db, id: string): ProjectDetail {
  const r = getProjectRow(db, id);
  const summary = toSummary(db, r);
  const derived = deriveStatus(db, r);
  const branch = r.active_branch_id ?? activeBranchId(db, id);
  const latest = db.get<{ id: string }>('SELECT id FROM blueprint_revisions WHERE project_id = ? AND branch_id = ? ORDER BY number DESC LIMIT 1', [id, branch]);
  const approved = db.get<{ id: string }>("SELECT id FROM blueprint_revisions WHERE project_id = ? AND branch_id = ? AND status = 'approved' ORDER BY number DESC LIMIT 1", [id, branch]);
  const analysis = db.get<{ id: string }>('SELECT id FROM analyses WHERE project_id = ? ORDER BY number DESC LIMIT 1', [id]);
  return {
    ...summary,
    brief: projectBrief(r),
    briefRevision: r.brief_revision,
    createStep: r.create_step,
    documents: listDocuments(db, id),
    contentReviewedAt: r.content_reviewed_at,
    currentVersionId: r.current_version_id,
    latestBlueprintId: latest?.id ?? null,
    approvedBlueprintId: approved?.id ?? null,
    currentAnalysisId: analysis?.id ?? null,
    activeJobs: activeJobs(db, id),
    lastProblemJob: derived.lastProblemJob,
    sourceRevision: r.source_revision,
    activeBranchId: branch,
    branches: listBranches(db, id),
  };
}

export function updateProjectMeta(db: Db, id: string, patch: { name?: string; createStep?: CreateStep; contentReviewed?: boolean }, expectedRevision: number | null): void {
  db.tx(() => {
    const r = getProjectRow(db, id);
    if (expectedRevision !== null && r.revision !== expectedRevision) throw conflict('The project changed since you loaded it.', 'Reload and try again.');
    const sets: string[] = ['revision = revision + 1', 'updated_at = ?'];
    const params: Array<string | null> = [nowIso()];
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (!name) throw badRequest('The project name cannot be empty.');
      sets.push('name = ?');
      params.push(name.slice(0, 120));
    }
    if (patch.createStep) (sets.push('create_step = ?'), params.push(patch.createStep));
    if (patch.contentReviewed !== undefined) (sets.push('content_reviewed_at = ?'), params.push(patch.contentReviewed ? nowIso() : null));
    db.run(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
  });
}

/** Autosave the brief with optimistic concurrency. Returns the new brief revision. */
export function saveBrief(db: Db, id: string, brief: GameBrief, expectedRevision: number): number {
  const parsed = gameBriefSchema.safeParse(brief);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw badRequest('The brief is not valid.', issue ? `${issue.path.join('.')}: ${issue.message}` : undefined);
  }
  return db.tx(() => {
    const r = getProjectRow(db, id);
    if (r.brief_revision !== expectedRevision) {
      throw conflict('The brief was saved from another window.', 'Reload to continue from the latest saved brief.', { brief: projectBrief(r), briefRevision: r.brief_revision });
    }
    db.run('UPDATE projects SET brief_json = ?, brief_revision = brief_revision + 1, updated_at = ? WHERE id = ?', [JSON.stringify(parsed.data), nowIso(), id]);
    // The project name follows the working title until the creator renames the project themselves.
    const prevTitle = projectBrief(r).title.trim();
    const nextTitle = parsed.data.title.trim();
    if ((r.name === DEFAULT_PROJECT_NAME || (prevTitle !== '' && r.name === prevTitle)) && nextTitle !== r.name) {
      db.run('UPDATE projects SET name = ?, revision = revision + 1 WHERE id = ?', [nextTitle.slice(0, 120) || DEFAULT_PROJECT_NAME, id]);
    }
    return r.brief_revision + 1;
  });
}

export function deleteProject(db: Db, storage: Storage, id: string): void {
  getProjectRow(db, id);
  db.run('DELETE FROM projects WHERE id = ?', [id]);
  storage.removeProject(id);
  for (const f of fs.readdirSync(storage.exportsRoot)) {
    if (f.startsWith(`${id}-`)) fs.rmSync(path.join(storage.exportsRoot, f), { force: true });
  }
}

/** Deep-replace identifiers inside JSON (values and record keys). */
export function remapIds<T>(value: T, map: Map<string, string>): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return map.get(v) ?? v;
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v)) out[map.get(k) ?? k] = walk(val);
      return out;
    }
    return v;
  };
  return walk(value) as T;
}

/**
 * Duplicate a project: new identifiers everywhere and private copies of all
 * files, so the copies never share mutable versions or assets. Conversation
 * history and job logs are not copied.
 */
export function duplicateProject(db: Db, storage: Storage, sourceId: string): string {
  const src = getProjectRow(db, sourceId);
  const newProjectId = newId(ID_PREFIX.project);
  const map = new Map<string, string>([[sourceId, newProjectId]]);
  const remapRows = <T extends { id: string }>(table: string, prefix: string): T[] => {
    const rows = db.all<T>(`SELECT * FROM ${table} WHERE project_id = ?`, [sourceId]);
    for (const row of rows) map.set(row.id, newId(prefix));
    return rows;
  };
  const docs = remapRows<{ id: string; stored_path: string }>('source_documents', ID_PREFIX.document);
  const slides = remapRows<{ id: string }>('source_slides', ID_PREFIX.slide);
  const assets = remapRows<{ id: string; stored_dir: string }>('assets', ID_PREFIX.asset);
  const analyses = remapRows<{ id: string }>('analyses', ID_PREFIX.analysis);
  const blueprints = remapRows<{ id: string }>('blueprint_revisions', ID_PREFIX.blueprint);
  const versions = remapRows<{ id: string }>('game_versions', ID_PREFIX.version);
  // Grade versions and the design / grade / motion records that hang off them.
  ensureMainBranch(db, sourceId);
  const branches = remapRows<{ id: string }>('game_branches', ID_PREFIX.branch);
  const profiles = remapRows<{ id: string }>('grade_profiles', ID_PREFIX.gradeProfile);
  const gradePlans = remapRows<{ id: string }>('grade_plans', ID_PREFIX.gradePlan);
  const motionPlans = remapRows<{ id: string }>('motion_plans', ID_PREFIX.motionPlan);
  const designImports = remapRows<{ id: string }>('design_imports', ID_PREFIX.designImport);
  const designFrames = remapRows<{ id: string }>('design_frames', ID_PREFIX.designFrame);
  const screenMaps = remapRows<{ id: string }>('screen_maps', ID_PREFIX.screenMap);
  const srcRow = getProjectRow(db, sourceId);

  const srcDir = storage.projectDir(sourceId);
  const dstDir = storage.projectDir(newProjectId);
  const relSwap = (rel: string) => rel.replace(`projects/${sourceId}/`, `projects/${newProjectId}/`);

  // Private copies of every stored file first; if the database step fails the copy is removed.
  copyDir(srcDir, dstDir);
  try {
  db.tx(() => {
    const now = nowIso();
    db.run(
      `INSERT INTO projects (id, name, is_sample, state, create_step, brief_json, brief_revision, content_reviewed_at, current_version_id, active_branch_id, source_revision, revision, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 0, ?, ?)`,
      [
        newProjectId,
        `${src.name} (copy)`.slice(0, 120),
        src.is_sample,
        src.state,
        src.create_step,
        JSON.stringify(remapIds(parseJson(src.brief_json, {}), map)),
        src.content_reviewed_at,
        src.current_version_id ? (map.get(src.current_version_id) ?? null) : null,
        srcRow.active_branch_id ? (map.get(srcRow.active_branch_id) ?? null) : null,
        src.source_revision,
        now,
        now,
      ],
    );
    const copyRows = (table: string, rows: Array<Record<string, unknown>>, transform: (row: Record<string, unknown>) => Record<string, unknown>) => {
      for (const row of rows) {
        const next = transform({ ...row });
        const cols = Object.keys(next);
        db.run(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map((c) => next[c] as string | number | null));
      }
    };
    const jsonCols = new Set([
      'extract_json',
      'edits_json',
      'visual_ref_json',
      'metadata_json',
      'analysis_json',
      'source_snapshot_json',
      'blueprint_json',
      'config_json',
      'pages_json',
      'before_json',
      'after_json',
      'profile_json',
      'plan_json',
      'decisions_json',
      'basis_json',
      'scope_json',
      'available_json',
      'diff_json',
      'snapshot_json',
      'mapping_json',
    ]);
    const generic = (row: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(row)) {
        if (k === 'id' || k.endsWith('_id')) row[k] = typeof v === 'string' ? (map.get(v) ?? v) : v;
        else if (jsonCols.has(k) && typeof v === 'string') row[k] = JSON.stringify(remapIds(JSON.parse(v), map));
        else if ((k === 'stored_path' || k === 'stored_dir') && typeof v === 'string') row[k] = relSwap(v);
      }
      return row;
    };
    // Source revisions hash slide ids, which change in the copy: recompute them from the remapped
    // snapshots so unchanged content stays fresh (and stale content stays stale).
    const withRevision = (row: Record<string, unknown>) => {
      const out = generic(row);
      if (typeof out.source_snapshot_json === 'string') out.source_revision = sourceRevisionOf(parseJson(out.source_snapshot_json, {}));
      return { ...out, job_id: null };
    };
    copyRows('source_documents', docs as unknown as Array<Record<string, unknown>>, generic);
    copyRows('source_slides', slides as unknown as Array<Record<string, unknown>>, generic);
    db.run('UPDATE projects SET source_revision = ? WHERE id = ?', [currentSnapshot(db, newProjectId).revision, newProjectId]);
    copyRows('assets', assets as unknown as Array<Record<string, unknown>>, generic);
    copyRows('analyses', analyses as unknown as Array<Record<string, unknown>>, withRevision);
    copyRows('blueprint_revisions', blueprints as unknown as Array<Record<string, unknown>>, withRevision);
    copyRows('game_versions', versions as unknown as Array<Record<string, unknown>>, (row) => {
      const out = generic(row);
      const cfg = JSON.parse(out.config_json as string);
      cfg.meta.projectId = newProjectId;
      out.config_json = JSON.stringify(cfg);
      return out;
    });
    const changes = db.all<Record<string, unknown>>('SELECT c.* FROM slide_changes c JOIN source_slides s ON s.id = c.slide_id WHERE s.project_id = ?', [sourceId]);
    copyRows('slide_changes', changes, (row) => ({ ...generic(row), id: newId(ID_PREFIX.slideEdit) }));
    const rows = (list: Array<{ id: string }>) => list as unknown as Array<Record<string, unknown>>;
    // Proposals and job logs are not copied, so links to them are cleared.
    const unlinked = (row: Record<string, unknown>) => ({ ...generic(row), job_id: null, ...('proposal_id' in row ? { proposal_id: null } : {}) });
    copyRows('game_branches', rows(branches), generic);
    copyRows('grade_profiles', rows(profiles), generic);
    copyRows('grade_plans', rows(gradePlans), unlinked);
    copyRows('motion_plans', rows(motionPlans), unlinked);
    copyRows('design_imports', rows(designImports), generic);
    copyRows('design_frames', rows(designFrames), generic);
    copyRows('screen_maps', rows(screenMaps), generic);
  });
  } catch (err) {
    fs.rmSync(dstDir, { recursive: true, force: true });
    throw err;
  }
  return newProjectId;
}
