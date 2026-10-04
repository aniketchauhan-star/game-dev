import { ID_PREFIX, newId } from '@shared/schemas/common.ts';
import { motionPlanSchema, type MotionPlan, type MotionPlanRecord, type PlanDecision } from '@shared/schemas/motion.ts';
import { badRequest, conflict, notFound } from '../errors.ts';
import { nowIso, parseJson, type Db } from './db.ts';

/** MotionPlan records: proposed motion reviewed row by row; approved motion lives in game versions. */

interface MotionPlanRow {
  id: string;
  project_id: string;
  branch_id: string;
  number: number;
  grade_profile_revision: number | null;
  origin: MotionPlanRecord['origin'];
  model: string | null;
  job_id: string | null;
  request: string;
  scope_json: string;
  base_version_id: string | null;
  basis_json: string;
  status: MotionPlanRecord['status'];
  plan_json: string;
  decisions_json: string;
  proposal_id: string | null;
  result_version_id: string | null;
  created_at: string;
  resolved_at: string | null;
}

/** Decision keys: binding id for additions, `remove:<id>` for removals, `settings` for settings. */
export function planRowKeys(plan: MotionPlan): string[] {
  return [...plan.add.map((b) => b.id), ...plan.remove.map((r) => `remove:${r.id}`), ...(plan.settings && Object.keys(plan.settings).length ? ['settings'] : [])];
}

function toMotionPlan(db: Db, r: MotionPlanRow): MotionPlanRecord {
  const num = (id: string | null) => (id ? (db.get<{ number: number }>('SELECT number FROM game_versions WHERE id = ?', [id])?.number ?? null) : null);
  return {
    id: r.id,
    projectId: r.project_id,
    branchId: r.branch_id,
    number: r.number,
    gradeProfileRevision: r.grade_profile_revision,
    origin: r.origin,
    model: r.model,
    request: r.request,
    scope: parseJson(r.scope_json, { kind: 'project', screenId: null }),
    baseVersionId: r.base_version_id,
    baseVersionNumber: num(r.base_version_id),
    basis: parseJson(r.basis_json, { blueprintRevisionId: null, screenMapNumber: null }),
    status: r.status,
    plan: JSON.parse(r.plan_json) as MotionPlan,
    decisions: parseJson(r.decisions_json, {}),
    proposalId: r.proposal_id,
    resultVersionId: r.result_version_id,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
  };
}

export function insertMotionPlan(
  db: Db,
  p: {
    projectId: string;
    branchId: string;
    gradeProfileRevision: number | null;
    origin: MotionPlanRecord['origin'];
    model: string | null;
    jobId: string | null;
    request: string;
    scope: MotionPlanRecord['scope'];
    baseVersionId: string | null;
    basis: MotionPlanRecord['basis'];
    plan: MotionPlan;
    /** Initial decisions (rows are pending unless given). */
    decisions?: Record<string, PlanDecision>;
  },
): MotionPlanRecord {
  const plan = motionPlanSchema.parse(p.plan);
  return db.tx(() => {
    const number = (db.get<{ n: number | null }>('SELECT MAX(number) AS n FROM motion_plans WHERE project_id = ?', [p.projectId])?.n ?? 0) + 1;
    const id = newId(ID_PREFIX.motionPlan);
    const decisions = Object.fromEntries(planRowKeys(plan).map((k) => [k, p.decisions?.[k] ?? 'pending']));
    db.run(
      `INSERT INTO motion_plans (id, project_id, branch_id, number, grade_profile_revision, origin, model, job_id, request, scope_json, base_version_id, basis_json, status, plan_json, decisions_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?, ?)`,
      [
        id,
        p.projectId,
        p.branchId,
        number,
        p.gradeProfileRevision,
        p.origin,
        p.model,
        p.jobId,
        p.request.slice(0, 2000),
        JSON.stringify(p.scope),
        p.baseVersionId,
        JSON.stringify(p.basis),
        JSON.stringify(plan),
        JSON.stringify(decisions),
        nowIso(),
      ],
    );
    return getMotionPlan(db, id);
  });
}

export function getMotionPlan(db: Db, id: string): MotionPlanRecord {
  const r = db.get<MotionPlanRow>('SELECT * FROM motion_plans WHERE id = ?', [id]);
  if (!r) throw notFound('Motion plan');
  return toMotionPlan(db, r);
}

export function listMotionPlans(db: Db, branchId: string, limit = 30): MotionPlanRecord[] {
  return db.all<MotionPlanRow>('SELECT * FROM motion_plans WHERE branch_id = ? ORDER BY number DESC LIMIT ?', [branchId, limit]).map((r) => toMotionPlan(db, r));
}

/** The plan staged for the next build ("Prepare my game"), if any. */
export function stagedMotionPlan(db: Db, branchId: string): MotionPlanRecord | null {
  const r = db.get<MotionPlanRow>("SELECT * FROM motion_plans WHERE branch_id = ? AND base_version_id IS NULL AND status = 'proposed' ORDER BY number DESC LIMIT 1", [branchId]);
  return r ? toMotionPlan(db, r) : null;
}

export function setMotionPlanDecisions(db: Db, id: string, decisions: Record<string, PlanDecision>): MotionPlanRecord {
  return db.tx(() => {
    const cur = getMotionPlan(db, id);
    if (cur.status !== 'proposed') throw conflict(`This motion plan is already ${cur.status}.`);
    const known = new Set(planRowKeys(cur.plan));
    const next = { ...cur.decisions };
    for (const [k, v] of Object.entries(decisions)) {
      if (!known.has(k)) throw badRequest(`Unknown row ${k}.`);
      next[k] = v;
    }
    db.run('UPDATE motion_plans SET decisions_json = ? WHERE id = ?', [JSON.stringify(next), id]);
    return getMotionPlan(db, id);
  });
}

export function resolveMotionPlan(db: Db, id: string, status: Exclude<MotionPlanRecord['status'], 'proposed'>, links: { proposalId?: string | null; resultVersionId?: string | null } = {}): void {
  db.run('UPDATE motion_plans SET status = ?, proposal_id = COALESCE(?, proposal_id), result_version_id = COALESCE(?, result_version_id), resolved_at = ? WHERE id = ?', [
    status,
    links.proposalId ?? null,
    links.resultVersionId ?? null,
    nowIso(),
    id,
  ]);
}

/** Staged (pre-build) plans of a branch are superseded when a new one is staged. */
export function supersedeStagedMotionPlans(db: Db, branchId: string): void {
  db.run("UPDATE motion_plans SET status = 'superseded', resolved_at = ? WHERE branch_id = ? AND base_version_id IS NULL AND status = 'proposed'", [nowIso(), branchId]);
}
