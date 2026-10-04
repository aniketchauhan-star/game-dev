import { ID_PREFIX, newId } from '@shared/schemas/common.ts';
import { gradeAdaptationPlanSchema, gradeProfileSchema, type GradeAdaptationPlan, type GradePlanRecord, type GradeProfile, type GradeProfileRecord } from '@shared/schemas/grade.ts';
import { badRequest, conflict, notFound } from '../errors.ts';
import { nowIso, parseJson, type Db } from './db.ts';

// ───────────────────────────── GradeProfile (immutable revisions per grade version) ─────────────────────────────

interface ProfileRow {
  id: string;
  project_id: string;
  branch_id: string;
  revision: number;
  origin: GradeProfileRecord['origin'];
  profile_json: string;
  created_at: string;
}

function toProfile(r: ProfileRow): GradeProfileRecord {
  return {
    id: r.id,
    projectId: r.project_id,
    branchId: r.branch_id,
    revision: r.revision,
    origin: r.origin,
    profile: gradeProfileSchema.parse(JSON.parse(r.profile_json)),
    createdAt: r.created_at,
  };
}

export function currentGradeProfile(db: Db, branchId: string): GradeProfileRecord | null {
  const r = db.get<ProfileRow>('SELECT * FROM grade_profiles WHERE branch_id = ? ORDER BY revision DESC LIMIT 1', [branchId]);
  return r ? toProfile(r) : null;
}

export function getGradeProfile(db: Db, id: string): GradeProfileRecord {
  const r = db.get<ProfileRow>('SELECT * FROM grade_profiles WHERE id = ?', [id]);
  if (!r) throw notFound('Grade profile');
  return toProfile(r);
}

export function gradeProfileAt(db: Db, branchId: string, revision: number): GradeProfileRecord | null {
  const r = db.get<ProfileRow>('SELECT * FROM grade_profiles WHERE branch_id = ? AND revision = ?', [branchId, revision]);
  return r ? toProfile(r) : null;
}

export function listGradeProfiles(db: Db, branchId: string): GradeProfileRecord[] {
  return db.all<ProfileRow>('SELECT * FROM grade_profiles WHERE branch_id = ? ORDER BY revision DESC LIMIT 50', [branchId]).map(toProfile);
}

/**
 * Save a new revision (never edits an old one). `expectedRevision` is the
 * revision the creator edited (0 when there was none); a mismatch means another
 * window saved first. Saving an identical profile returns the current revision.
 */
export function saveGradeProfile(
  db: Db,
  p: { projectId: string; branchId: string; profile: GradeProfile; origin: GradeProfileRecord['origin']; expectedRevision: number | null },
): GradeProfileRecord {
  const parsed = gradeProfileSchema.safeParse(p.profile);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw badRequest('The grade profile is not valid.', issue ? `${issue.path.join('.')}: ${issue.message}` : undefined);
  }
  return db.tx(() => {
    const cur = currentGradeProfile(db, p.branchId);
    const curRevision = cur?.revision ?? 0;
    if (p.expectedRevision !== null && p.expectedRevision !== curRevision) {
      throw conflict('The grade profile was saved from another window.', 'Reload to continue from the latest profile.', { current: cur });
    }
    if (cur && JSON.stringify(cur.profile) === JSON.stringify(parsed.data)) return cur;
    const id = newId(ID_PREFIX.gradeProfile);
    db.run('INSERT INTO grade_profiles (id, project_id, branch_id, revision, origin, profile_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
      id,
      p.projectId,
      p.branchId,
      curRevision + 1,
      p.origin,
      JSON.stringify(parsed.data),
      nowIso(),
    ]);
    db.run('UPDATE projects SET updated_at = ? WHERE id = ?', [nowIso(), p.projectId]);
    return getGradeProfile(db, id);
  });
}

// ───────────────────────────── GradeAdaptationPlan ─────────────────────────────

interface PlanRow {
  id: string;
  project_id: string;
  branch_id: string;
  number: number;
  grade_profile_id: string;
  grade_profile_revision: number;
  from_grade: string | null;
  to_grade: string;
  mode: GradePlanRecord['mode'];
  origin: GradePlanRecord['origin'];
  model: string | null;
  job_id: string | null;
  base_version_id: string | null;
  basis_json: string;
  status: GradePlanRecord['status'];
  plan_json: string;
  decisions_json: string;
  proposal_id: string | null;
  blueprint_revision_id: string | null;
  result_version_id: string | null;
  created_at: string;
  resolved_at: string | null;
}

function toPlan(db: Db, r: PlanRow): GradePlanRecord {
  const num = (id: string | null) => (id ? (db.get<{ number: number }>('SELECT number FROM game_versions WHERE id = ?', [id])?.number ?? null) : null);
  return {
    id: r.id,
    projectId: r.project_id,
    branchId: r.branch_id,
    number: r.number,
    gradeProfileId: r.grade_profile_id,
    gradeProfileRevision: r.grade_profile_revision,
    fromGrade: r.from_grade,
    toGrade: r.to_grade,
    mode: r.mode,
    origin: r.origin,
    model: r.model,
    baseVersionId: r.base_version_id,
    baseVersionNumber: num(r.base_version_id),
    basis: parseJson(r.basis_json, { blueprintRevisionId: null, blueprintRevisionNumber: null, screenMapNumber: null }),
    status: r.status,
    plan: JSON.parse(r.plan_json) as GradeAdaptationPlan,
    decisions: parseJson(r.decisions_json, {}),
    proposalId: r.proposal_id,
    blueprintRevisionId: r.blueprint_revision_id,
    resultVersionId: r.result_version_id,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
  };
}

export function insertGradePlan(
  db: Db,
  p: {
    projectId: string;
    branchId: string;
    profile: GradeProfileRecord;
    fromGrade: string | null;
    toGrade: string;
    mode: GradePlanRecord['mode'];
    origin: GradePlanRecord['origin'];
    model: string | null;
    jobId: string | null;
    baseVersionId: string | null;
    basis: GradePlanRecord['basis'];
    plan: GradeAdaptationPlan;
  },
): GradePlanRecord {
  const plan = gradeAdaptationPlanSchema.parse(p.plan);
  return db.tx(() => {
    // A newer plan for the same grade version replaces older open ones.
    db.run("UPDATE grade_plans SET status = 'superseded', resolved_at = ? WHERE branch_id = ? AND status = 'proposed'", [nowIso(), p.branchId]);
    const number = (db.get<{ n: number | null }>('SELECT MAX(number) AS n FROM grade_plans WHERE project_id = ?', [p.projectId])?.n ?? 0) + 1;
    const id = newId(ID_PREFIX.gradePlan);
    const decisions = Object.fromEntries(plan.items.map((i) => [i.id, 'pending']));
    db.run(
      `INSERT INTO grade_plans (id, project_id, branch_id, number, grade_profile_id, grade_profile_revision, from_grade, to_grade, mode, origin, model, job_id, base_version_id, basis_json, status, plan_json, decisions_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?, ?)`,
      [
        id,
        p.projectId,
        p.branchId,
        number,
        p.profile.id,
        p.profile.revision,
        p.fromGrade,
        p.toGrade,
        p.mode,
        p.origin,
        p.model,
        p.jobId,
        p.baseVersionId,
        JSON.stringify(p.basis),
        JSON.stringify(plan),
        JSON.stringify(decisions),
        nowIso(),
      ],
    );
    return getGradePlan(db, id);
  });
}

export function getGradePlan(db: Db, id: string): GradePlanRecord {
  const r = db.get<PlanRow>('SELECT * FROM grade_plans WHERE id = ?', [id]);
  if (!r) throw notFound('Grade adaptation plan');
  return toPlan(db, r);
}

export function listGradePlans(db: Db, branchId: string, limit = 20): GradePlanRecord[] {
  return db.all<PlanRow>('SELECT * FROM grade_plans WHERE branch_id = ? ORDER BY number DESC LIMIT ?', [branchId, limit]).map((r) => toPlan(db, r));
}

export function latestGradePlan(db: Db, branchId: string): GradePlanRecord | null {
  const r = db.get<PlanRow>('SELECT * FROM grade_plans WHERE branch_id = ? ORDER BY number DESC LIMIT 1', [branchId]);
  return r ? toPlan(db, r) : null;
}

/** Record per-item review decisions on an open plan. */
export function setGradePlanDecisions(db: Db, id: string, decisions: Record<string, 'pending' | 'accepted' | 'rejected'>): GradePlanRecord {
  return db.tx(() => {
    const cur = getGradePlan(db, id);
    if (cur.status !== 'proposed') throw conflict(`This plan is already ${cur.status}.`);
    const known = new Set(cur.plan.items.map((i) => i.id));
    const next = { ...cur.decisions };
    for (const [k, v] of Object.entries(decisions)) {
      if (!known.has(k)) throw badRequest(`Unknown plan item ${k}.`);
      next[k] = v;
    }
    db.run('UPDATE grade_plans SET decisions_json = ? WHERE id = ?', [JSON.stringify(next), id]);
    return getGradePlan(db, id);
  });
}

export function resolveGradePlan(
  db: Db,
  id: string,
  status: Exclude<GradePlanRecord['status'], 'proposed'>,
  links: { proposalId?: string | null; blueprintRevisionId?: string | null; resultVersionId?: string | null } = {},
): void {
  db.run(
    'UPDATE grade_plans SET status = ?, proposal_id = COALESCE(?, proposal_id), blueprint_revision_id = COALESCE(?, blueprint_revision_id), result_version_id = COALESCE(?, result_version_id), resolved_at = ? WHERE id = ?',
    [status, links.proposalId ?? null, links.blueprintRevisionId ?? null, links.resultVersionId ?? null, nowIso(), id],
  );
}
