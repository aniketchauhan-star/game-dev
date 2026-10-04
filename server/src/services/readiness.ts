import { isBuildableSceneType } from '@shared/registry.ts';
import { validateBindings } from '@shared/motion/validate.ts';
import { motionPlanOps } from '@shared/plans.ts';
import { applyChangeOps } from '@shared/schemas/proposal.ts';
import { validateMapping } from '@shared/screens/layout.ts';
import type { App } from '../app.ts';
import { activeBranchId } from '../db/branches.ts';
import { currentGradeProfile, latestGradePlan } from '../db/grade.ts';
import { approvedBlueprint, latestBlueprint } from '../db/learning.ts';
import { stagedMotionPlan } from '../db/motion.ts';
import { getProjectRow, projectBrief } from '../db/projects.ts';
import { currentScreenMap } from '../db/screens.ts';
import { listSlides } from '../db/sources.ts';
import { currentVersion } from '../db/versions.ts';
import { prepareExport } from '../export/exporter.ts';
import { buildBranch } from './build.ts';
import { screenSources } from './screens.ts';

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'todo';

export interface ReadinessCheck {
  id: 'source' | 'grade' | 'screens' | 'assets' | 'mechanics' | 'motion' | 'export';
  label: string;
  status: CheckStatus;
  detail: string;
  /** Studio area that fixes it. */
  area: 'source' | 'prepare' | 'screens' | 'assets' | 'blueprint' | 'animate' | 'export';
}

export interface Readiness {
  branchId: string;
  checks: ReadinessCheck[];
  /** “Approve & build” is offered only when every scene uses a supported mechanic and nothing fails. */
  canBuild: boolean;
  buildBlockers: string[];
  blueprint: { id: string; number: number; status: string } | null;
  gradePlanId: string | null;
  motionPlanId: string | null;
}

/** Readiness from real checks only — no invented percentages. */
export function readiness(app: App, projectId: string): Readiness {
  const branchId = activeBranchId(app.db, projectId);
  const project = getProjectRow(app.db, projectId);
  const brief = projectBrief(project);
  const checks: ReadinessCheck[] = [];
  const slides = listSlides(app.db, projectId);
  const included = slides.filter((s) => s.included);

  // Source reviewed.
  if (included.length === 0) {
    checks.push(brief.learningObjective.trim() ? { id: 'source', label: 'Source reviewed', status: 'warn', detail: 'No lesson slides: the game relies on your brief and objectives only.', area: 'source' } : { id: 'source', label: 'Source reviewed', status: 'fail', detail: 'Add a lesson deck, or write a brief with learning objectives.', area: 'source' });
  } else {
    const unverified = included.filter((s) => s.reviewStatus !== 'verified').length;
    checks.push({
      id: 'source',
      label: 'Source reviewed',
      status: project.content_reviewed_at && unverified === 0 ? 'pass' : project.content_reviewed_at ? 'warn' : 'todo',
      detail: project.content_reviewed_at ? (unverified ? `Reviewed; ${unverified} slide(s) not marked verified.` : `${included.length} slide(s) reviewed and verified.`) : `${included.length} slide(s) imported; mark the content reviewed in Source.`,
      area: 'source',
    });
  }

  // Grade plan reviewed.
  const profile = currentGradeProfile(app.db, branchId);
  const plan = latestGradePlan(app.db, branchId);
  if (!profile) checks.push({ id: 'grade', label: 'Grade plan reviewed', status: 'fail', detail: 'Choose the grade (Grade & learning profile).', area: 'prepare' });
  else if (!plan || plan.status === 'superseded' || plan.status === 'rejected') checks.push({ id: 'grade', label: 'Grade plan reviewed', status: 'todo', detail: 'No grade adaptation plan yet — Prepare my game makes one (optional).', area: 'prepare' });
  else if (plan.status === 'proposed') {
    const pending = plan.plan.items.filter((i) => (plan.decisions[i.id] ?? 'pending') === 'pending').length;
    checks.push({ id: 'grade', label: 'Grade plan reviewed', status: pending ? 'todo' : 'pass', detail: pending ? `${pending} of ${plan.plan.items.length} plan item(s) still to accept or reject.` : 'Every item has a decision.', area: 'prepare' });
  } else checks.push({ id: 'grade', label: 'Grade plan reviewed', status: plan.status === 'stale' ? 'warn' : 'pass', detail: plan.status === 'stale' ? 'The last plan went stale; prepare again for an up-to-date one.' : `Grade plan ${plan.number} was applied.`, area: 'prepare' });

  // Mechanics supported.
  const rev = latestBlueprint(app.db, projectId, branchId);
  const unsupported = (rev?.blueprint.scenes ?? []).filter((s) => !isBuildableSceneType(s.interaction.type));
  if (!rev) checks.push({ id: 'mechanics', label: 'Mechanics supported', status: 'fail', detail: 'There is no blueprint yet.', area: 'blueprint' });
  else checks.push({ id: 'mechanics', label: 'Mechanics supported', status: unsupported.length ? 'fail' : 'pass', detail: unsupported.length ? `${unsupported.length} scene(s) use a custom mechanic (blueprint-only; export a developer handoff).` : `All ${rev.blueprint.scenes.length} scenes use playable mechanics.`, area: 'blueprint' });

  // Screens mapped.
  const map = currentScreenMap(app.db, branchId);
  if (!rev) checks.push({ id: 'screens', label: 'Screens mapped', status: 'todo', detail: 'Screens follow the blueprint.', area: 'screens' });
  else if (!map) checks.push({ id: 'screens', label: 'Screens mapped', status: 'todo', detail: 'No screen map yet — the built-in layout is used until you map screens (Prepare suggests one).', area: 'screens' });
  else {
    const frameIds = map.mapping.screens.flatMap((s) => [...s.frames.map((f) => f.frameId), ...(s.background.frameId ? [s.background.frameId] : [])]);
    const src = screenSources(app, projectId, branchId, frameIds);
    const check = validateMapping(map.mapping, src.ctx);
    const unreviewed = map.mapping.screens.filter((s) => !s.reviewed).length;
    const open = map.mapping.screens.reduce((n, s) => n + s.conflicts.filter((c) => c.status === 'open').length, 0);
    checks.push({
      id: 'screens',
      label: 'Screens mapped',
      status: check.errors.length ? 'fail' : unreviewed || open ? 'todo' : check.warnings.length ? 'warn' : 'pass',
      detail: check.errors.length ? check.errors[0]! : unreviewed || open ? `${unreviewed} row(s) to review, ${open} source conflict(s) open.` : check.warnings[0] ?? `Map ${map.number}: every row reviewed.`,
      area: 'screens',
    });
  }

  // Assets assigned.
  const needs = rev?.blueprint.assetNeeds ?? [];
  const missingNeeds = needs.filter((n) => n.required && !n.assignedAssetId);
  const mapAssets = map ? map.mapping.screens.filter((s) => s.assets.character || s.assets.panel || s.assets.button || s.background.kind === 'asset').length : 0;
  checks.push({
    id: 'assets',
    label: 'Assets assigned',
    status: missingNeeds.length ? 'warn' : 'pass',
    detail: missingNeeds.length ? `${missingNeeds.length} required asset(s) unassigned (built-in art is used): ${missingNeeds.map((n) => n.description).join(', ').slice(0, 160)}` : mapAssets ? `Exact artwork assigned on ${mapAssets} screen(s).` : 'Built-in art is used where nothing is assigned.',
    area: 'assets',
  });

  // Motion validated + export checks, against the version the build would produce.
  const staged = stagedMotionPlan(app.db, branchId);
  const version = currentVersion(app.db, projectId);
  let candidateOk = false;
  if (rev && !unsupported.length) {
    const built = buildBranch(app, projectId, rev, { carryMotion: true, allowDraft: true });
    if (!built.config) {
      checks.push({ id: 'motion', label: 'Motion validated', status: 'todo', detail: `The blueprint cannot be built yet: ${built.errors[0] ?? 'invalid'}.`, area: 'blueprint' });
    } else {
      candidateOk = true;
      let cfg = built.config;
      let skipped = 0;
      if (staged) {
        const r = applyChangeOps(cfg, motionPlanOps(staged.plan, staged.decisions), { scope: { kind: 'project', sceneId: null } });
        if (r.ok) cfg = r.config;
        skipped = r.results.filter((x) => x.status === 'invalid' || x.status === 'conflict').length;
      }
      const issues = validateBindings(cfg);
      const errors = issues.filter((i) => i.severity === 'error');
      const warnings = issues.filter((i) => i.severity === 'warning');
      checks.push({
        id: 'motion',
        label: 'Motion validated',
        status: errors.length ? 'fail' : skipped || warnings.length ? 'warn' : 'pass',
        detail: errors.length ? errors[0]!.message : skipped ? `${skipped} staged motion row(s) would be refused (locks or validation).` : warnings.length ? warnings[0]!.message : `${cfg.motion.bindings.length} animation(s) pass targets, triggers, budgets and dependency checks.`,
        area: 'animate',
      });
    }
  } else checks.push({ id: 'motion', label: 'Motion validated', status: 'todo', detail: 'Needs a buildable blueprint.', area: 'animate' });

  if (version) {
    try {
      const pre = prepareExport(app, projectId, { kind: 'playable', versionId: version.id, includeSourceMaterial: false, nextChanges: '' }).preflight;
      const fail = pre.checks.find((c) => c.status === 'fail');
      const warn = pre.checks.find((c) => c.status === 'warn');
      checks.push({ id: 'export', label: 'Export checks passed', status: fail ? 'fail' : warn ? 'warn' : 'pass', detail: fail ? `${fail.label}: ${fail.detail}` : warn ? `${warn.label}: ${warn.detail}` : `Version ${version.number}: ${pre.checks.length} export checks passed.`, area: 'export' });
    } catch (err) {
      checks.push({ id: 'export', label: 'Export checks passed', status: 'fail', detail: (err as Error).message, area: 'export' });
    }
  } else checks.push({ id: 'export', label: 'Export checks passed', status: 'todo', detail: 'Runs on the built version after Approve & build.', area: 'export' });

  const buildBlockers: string[] = [];
  if (!rev) buildBlockers.push('Create a blueprint first.');
  if (unsupported.length) buildBlockers.push('Custom mechanics stay blueprint-only.');
  if (rev && !candidateOk && !unsupported.length) buildBlockers.push('The blueprint cannot be built yet.');
  for (const c of checks.filter((x) => x.status === 'fail' && (x.id === 'screens' || x.id === 'motion'))) buildBlockers.push(c.detail);
  const approved = approvedBlueprint(app.db, projectId, branchId);
  return {
    branchId,
    checks,
    canBuild: buildBlockers.length === 0,
    buildBlockers,
    blueprint: rev ? { id: rev.id, number: rev.number, status: rev.status === 'draft' && approved ? 'draft (an earlier revision is approved)' : rev.status } : null,
    gradePlanId: plan && plan.status === 'proposed' && !plan.baseVersionId ? plan.id : null,
    motionPlanId: staged?.id ?? null,
  };
}
