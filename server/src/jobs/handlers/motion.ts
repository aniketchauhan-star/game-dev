import type { MotionPlan } from '@shared/schemas/motion.ts';
import { listScreens } from '@shared/motion/entities.ts';
import { suggestScreenMotion } from '@shared/motion/suggest.ts';
import { aiMotionPlanSchema } from '../../claude/schemas.ts';
import { MOTION_SYSTEM } from '../../claude/prompts.ts';
import { toGameAsset } from '@shared/assetsToGame.ts';
import { listAssetRows, toAsset } from '../../db/assets.ts';
import { framesById } from '../../db/design.ts';
import { currentGradeProfile } from '../../db/grade.ts';
import { insertMotionPlan } from '../../db/motion.ts';
import { currentScreenMap } from '../../db/screens.ts';
import { getVersion } from '../../db/versions.ts';
import { matchDemoMotion } from '../../demo/trapezium.ts';
import { motionContext, normalizeAiMotion } from '../../services/motion.ts';
import { JobFailure, type JobContext } from '../context.ts';

/** Deterministic preset suggestions for one screen or every screen (no AI). */
export function ruleSuggestions(config: Parameters<typeof suggestScreenMotion>[0], screenId: string | null): MotionPlan {
  const ids = screenId ? [screenId] : listScreens(config).map((s) => s.id);
  let working = config;
  const merged: MotionPlan = { summary: '', settings: null, add: [], remove: [], unsupported: [], resolved: [], notes: [] };
  for (const id of ids) {
    const p = suggestScreenMotion(working, id);
    merged.add.push(...p.add);
    merged.notes.push(...p.notes);
    working = { ...working, motion: { ...working.motion, bindings: [...working.motion.bindings, ...p.add] } };
    if (ids.length === 1) merged.summary = p.summary;
  }
  if (ids.length > 1) merged.summary = `${merged.add.length} suggested animations across ${ids.length} screens, from the preset rules for the ${config.motion.profile} profile. Nothing points at the right answer.`;
  merged.add = merged.add.slice(0, 40);
  merged.notes = merged.notes.slice(0, 8);
  return merged;
}

/**
 * “Suggest motion” / “Ask Claude”: a MotionPlan of reviewable rows against an
 * exact game version. Live mode asks Claude; without a key the preset rules
 * are used (labelled), and the bundled sample replays prepared demo rows.
 */
export async function handleMotionSuggest(ctx: JobContext<'motion_suggest'>) {
  const { app } = ctx;
  const input = ctx.input();
  if (!input.baseVersionId) throw new JobFailure('Build the game first: motion is proposed against a playable version (or use Prepare my game).', 'no_version', false);
  const base = getVersion(app.db, input.baseVersionId);
  if (base.projectId !== ctx.projectId) throw new JobFailure('Version not found in this project.', 'not_found', false);
  const config = base.config;
  const screenId = input.scope.kind === 'screen' ? input.scope.screenId : null;
  if (screenId && !listScreens(config).some((s) => s.id === screenId)) throw new JobFailure('The selected screen is not in this version.', 'not_found', false);
  const grade = currentGradeProfile(app.db, input.branchId);
  const gradeRev = config.meta.gradeProfileRevision ?? grade?.revision ?? null;
  const library = listAssetRows(app.db, ctx.projectId).map((r) => toGameAsset(toAsset(r)));
  let plan: MotionPlan;
  let origin: 'preset' | 'claude' | 'demo' = 'preset';
  let model: string | null = null;

  if (ctx.mode === 'live') {
    ctx.stage('context', screenId ? 'Reading the selected screen and its objects' : 'Reading every screen and its objects');
    const map = currentScreenMap(app.db, input.branchId);
    const frameIds = (map?.mapping.screens ?? []).filter((s) => !screenId || s.screenId === screenId).flatMap((s) => s.frames.map((f) => ({ screenId: s.screenId, frameId: f.frameId })));
    const frames = framesById(app.db, frameIds.map((f) => f.frameId));
    const designEvidence = frameIds.flatMap(({ screenId: sid, frameId }) =>
      (frames.get(frameId)?.prototype ?? [])
        .filter((p) => p.transition)
        .slice(0, 6)
        .map((p) => ({ screenId: sid, text: `“${p.nodeName}” ${p.trigger.toLowerCase().replace('_', ' ')} → ${p.transition!.type.toLowerCase()} ${p.transition!.durationMs ?? '?'} ms` })),
    );
    const content = motionContext(config, input.scope, { grade: grade?.profile ?? null, designEvidence, request: input.request, library });
    ctx.stage('propose', 'Asking Claude for motion rows');
    const r = await app.gateway.structured({ system: MOTION_SYSTEM, content, schema: aiMotionPlanSchema, maxTokens: 12000, effort: 'medium' }, ctx.claude('motion'));
    ctx.recordCall(r);
    ctx.stage('validate', 'Checking every row against the screen, presets, locks and budgets');
    plan = normalizeAiMotion(config, r.data, input.scope, gradeRev, library);
    origin = 'claude';
    model = r.model;
  } else if (ctx.mode === 'demo') {
    ctx.stage('demo', 'Demo mode — prepared sample rows, not Claude');
    const demo = matchDemoMotion(config, input.request, input.scope, library);
    if (demo) {
      plan = normalizeAiMotion(config, demo, input.scope, gradeRev, library);
      origin = 'demo';
    } else if (!input.request.trim()) {
      plan = ruleSuggestions(config, screenId);
    } else {
      plan = {
        summary: 'Demo mode can only replay prepared requests for the bundled sample. Use manual presets, or configure Claude.',
        settings: null,
        add: [],
        remove: [],
        unsupported: [{ request: input.request.slice(0, 300), reason: 'No prepared demo answer matches this request, and Claude is not configured.', alternative: 'Add the animation with a manual preset in the Animation tab.', handoff: false }],
        resolved: [],
        notes: [],
      };
      origin = 'demo';
    }
  } else {
    ctx.stage('rules', 'Choosing presets from the screen’s objects (preset rules, no AI)');
    plan = ruleSuggestions(config, screenId);
  }
  for (const u of plan.unsupported) ctx.event('warning', `Not supported: ${u.request} — ${u.reason}`);
  const record = insertMotionPlan(app.db, {
    projectId: ctx.projectId,
    branchId: input.branchId,
    gradeProfileRevision: gradeRev,
    origin,
    model,
    jobId: ctx.jobId,
    request: input.request,
    scope: input.scope,
    baseVersionId: base.id,
    basis: { blueprintRevisionId: base.blueprintRevisionId, screenMapNumber: config.meta.screenMapNumber ?? null },
    plan,
  });
  ctx.event('info', `Motion plan ${record.number}: ${plan.add.length} row(s) to review${plan.remove.length ? `, ${plan.remove.length} removal(s)` : ''}${plan.unsupported.length ? `, ${plan.unsupported.length} not supported` : ''}.`);
  return { planId: record.id, rows: plan.add.length };
}
