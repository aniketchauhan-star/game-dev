import type { BlueprintRevision } from '@shared/schemas/blueprint.ts';
import type { GameConfig } from '@shared/schemas/game.ts';
import type { GradePlanRecord } from '@shared/schemas/grade.ts';
import type { MotionPlanRecord } from '@shared/schemas/motion.ts';
import { applyChangeOps, type OpResult } from '@shared/schemas/proposal.ts';
import { gradePlanOps, motionPlanOps } from '@shared/plans.ts';
import type { App } from '../app.ts';
import { compileGame, type CompileResult } from '../build/compile.ts';
import { listAssetRows, toAsset } from '../db/assets.ts';
import { activeBranchId } from '../db/branches.ts';
import { currentGradeProfile } from '../db/grade.ts';
import { getProjectRow, projectBrief } from '../db/projects.ts';
import { currentScreenMap } from '../db/screens.ts';
import { listSlides } from '../db/sources.ts';
import { currentVersion } from '../db/versions.ts';
import { attachLibraryAssets } from './attachAssets.ts';
import { screenSources } from './screens.ts';

export interface BranchBuild extends CompileResult {
  branchId: string;
  screenMapNumber: number | null;
  gradeProfileRevision: number | null;
  /** Plan rows that were applied, and those refused (locked / invalid) with the reason. */
  planResults: { grade: OpResult[]; motion: OpResult[]; notes: string[] };
}

/**
 * Deterministic build of one grade version: approved blueprint revision +
 * current screen map + grade profile (+ approved motion carried over), then
 * the creator-accepted rows of staged grade / motion plans, each through the
 * normal lock and validation checks. No AI call happens here.
 */
export function buildBranch(
  app: App,
  projectId: string,
  revision: BlueprintRevision,
  opts: { carryMotion: boolean; gradePlan?: GradePlanRecord | null; motionPlan?: MotionPlanRecord | null; allowDraft?: boolean },
): BranchBuild {
  const branchId = revision.branchId ?? activeBranchId(app.db, projectId);
  const map = currentScreenMap(app.db, branchId);
  const frameIds = (map?.mapping.screens ?? []).flatMap((s) => [...s.frames.map((f) => f.frameId), ...(s.background.frameId ? [s.background.frameId] : [])]);
  const src = map ? screenSources(app, projectId, branchId, frameIds) : null;
  const grade = currentGradeProfile(app.db, branchId);
  const carry = opts.carryMotion ? (currentVersion(app.db, projectId, branchId)?.config.motion ?? null) : null;
  const rev = opts.allowDraft && revision.status === 'draft' ? { ...revision, status: 'approved' as const } : revision;
  const result = compileGame({
    projectId,
    revision: rev,
    brief: projectBrief(getProjectRow(app.db, projectId)),
    assets: listAssetRows(app.db, projectId).map((r) => toAsset(r)),
    slides: listSlides(app.db, projectId),
    branchId,
    screenMap: map && src ? { number: map.number, mapping: map.mapping, ctx: src.ctx } : null,
    grade: grade ? { revision: grade.revision, profile: grade.profile } : null,
    carryMotion: carry,
  });
  const planResults: BranchBuild['planResults'] = { grade: [], motion: [], notes: [] };
  let config: GameConfig | null = result.config;
  if (config && opts.gradePlan) {
    const { ops, notes } = gradePlanOps(opts.gradePlan.plan, opts.gradePlan.decisions, config);
    planResults.notes.push(...notes);
    if (ops.length) {
      const r = applyChangeOps(config, ops, { scope: { kind: 'project', sceneId: null } });
      planResults.grade = r.results;
      if (r.ok) config = r.config;
    }
  }
  if (config && opts.motionPlan) {
    const ops = attachLibraryAssets(motionPlanOps(opts.motionPlan.plan, opts.motionPlan.decisions), config, listAssetRows(app.db, projectId).map((r) => toAsset(r)));
    if (ops.length) {
      const r = applyChangeOps(config, ops, { scope: { kind: 'project', sceneId: null } });
      planResults.motion = r.results;
      if (r.ok) config = r.config;
    }
  }
  return { ...result, config, branchId, screenMapNumber: map?.number ?? null, gradeProfileRevision: grade?.revision ?? null, planResults };
}
