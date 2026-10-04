import type { GameAsset, GameConfig } from '@shared/schemas/game.ts';
import { motionSettingsSchema, type AnimationBinding, type MotionPlan, type MotionPlanRecord, type MotionPlanScope, type UnsupportedMotion } from '@shared/schemas/motion.ts';
import type { GameVersion, Proposal } from '@shared/schemas/records.ts';
import { applyChangeOps } from '@shared/schemas/proposal.ts';
import { describeBinding } from '@shared/motion/describe.ts';
import { listScreens } from '@shared/motion/entities.ts';
import { MOTION_PRESETS, UNAVAILABLE_EFFECTS } from '@shared/motion/presets.ts';
import { bindingId } from '@shared/motion/suggest.ts';
import { validateBindings } from '@shared/motion/validate.ts';
import { motionPlanOps } from '@shared/plans.ts';
import { gradeLabel, type GradeProfile } from '@shared/schemas/grade.ts';
import type { App } from '../app.ts';
import type { AiMotionPlan } from '../claude/schemas.ts';
import { getMotionPlan, resolveMotionPlan } from '../db/motion.ts';
import { getVersion, insertProposal } from '../db/versions.ts';
import { badRequest, conflict } from '../errors.ts';
import { listAssetRows, toAsset } from '../db/assets.ts';
import { attachLibraryAssets } from './attachAssets.ts';
import { applyProposal } from './proposals.ts';

const EASE = new Set(['linear', 'ease-out', 'ease-in-out', 'ease-in']);

function coerce(value: string): string | number | boolean {
  const v = value.trim();
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v.slice(0, 200);
}

/** What Claude sees: the screens in scope as id-labelled chips, presets, triggers, assets and preferences — never secrets. */
export function motionContext(config: GameConfig, scope: MotionPlanScope, extra: { grade: GradeProfile | null; designEvidence: Array<{ screenId: string; text: string }>; request: string; library?: GameAsset[] }): string {
  const screens = listScreens(config).filter((s) => scope.kind === 'project' || s.id === scope.screenId);
  const screensJson = screens.map((s) => ({
    id: s.id,
    label: s.label,
    type: s.type,
    controls: s.controls,
    locked: config.motion.lockedScreens.includes(s.id),
    objects: s.entities.map((e) => ({ id: e.id, label: e.label, kind: e.kind, ...(e.clips.length ? { clips: e.clips } : {}), ...(e.staticImage ? { staticImage: true } : {}), ...(e.interactive ? { interactive: true } : {}) })),
    existing: config.motion.bindings.filter((b) => b.screenId === s.id).map((b) => ({ id: b.id, rule: describeBinding(config, b), purpose: b.purpose, origin: b.origin })),
  }));
  const presets = Object.values(MOTION_PRESETS).map((p) => ({
    id: p.id,
    label: p.label,
    category: p.category,
    purpose: p.purpose,
    targets: p.targets,
    triggers: p.triggers ?? 'any',
    params: p.defaults,
    durationMs: p.duration,
    maxRepeat: p.maxRepeat,
    needsClip: p.requiresClip,
    reducedMotionDefault: p.defaultReduced,
  }));
  const assets = Object.values({ ...Object.fromEntries((extra.library ?? []).map((a) => [a.id, a])), ...config.assets })
    .filter((a) => a.kind === 'audio' || a.sprite)
    .map((a) => ({ id: a.id, alt: a.alt, kind: a.kind, ...(a.sprite ? { clips: a.sprite.clips.map((c) => c.name) } : {}) }));
  const grade = extra.grade ? { grade: gradeLabel(extra.grade), motion: extra.grade.motion, lowMotion: extra.grade.access.lowMotion } : null;
  const settings = { profile: config.motion.profile, pacing: config.motion.pacing, decorativeIntensity: config.motion.decorativeIntensity, sound: config.motion.sound, lowEffects: config.motion.lowEffects };
  const guard = (t: string) => t.replace(/<\s*\/?\s*(creator_request|screens|presets)\b/gi, (m) => m.replace('<', '‹'));
  return [
    scope.kind === 'screen' ? `Scope: only ${screens[0]?.label ?? scope.screenId} (id ${scope.screenId}). Rows for other screens will be refused.` : 'Scope: the whole game. Name each screen a row touches.',
    `<screens>\n${JSON.stringify(screensJson)}\n</screens>`,
    `<presets>\n${JSON.stringify(presets)}\n</presets>`,
    `Triggers: scene-entered (screen opens), control-activated (a listed control is pressed), instruction-advanced (next hint shown), object-selected, valid-drop (an object is placed in a valid spot), correct-answer, retry-requested (an answer was checked and is not right yet), scene-completed (leaving the screen).`,
    `Path parameter format for follow-path: up to 8 relative waypoints "dx,dy dx,dy" in stage pixels (1920×1080). move-by units: "stage" pixels, or "grid" units on coordinate screens (y up).`,
    `<assets>\n${JSON.stringify(assets)}\n</assets>`,
    `<grade_profile>\n${JSON.stringify(grade)}\n</grade_profile>`,
    `<motion_settings>\n${JSON.stringify(settings)}\n</motion_settings>`,
    extra.designEvidence.length ? `<design_evidence>\n${extra.designEvidence.map((d) => `${d.screenId}: ${guard(d.text)}`).join('\n')}\n</design_evidence>` : '',
    `<unavailable_effects>\n${UNAVAILABLE_EFFECTS.map((u) => `${u.label}: ${u.reason} Alternative: ${u.alternative}`).join('\n')}\n</unavailable_effects>`,
    `<creator_request>\n${guard(extra.request || 'Suggest purposeful motion for this screen.')}\n</creator_request>`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Turn Claude's rows into validated bindings. Every row is checked against the
 * real screen, object list, preset schema, locks, budgets and capabilities;
 * a row that fails is reported as unsupported with the reason, not applied.
 */
export function normalizeAiMotion(base: GameConfig, ai: AiMotionPlan, scope: MotionPlanScope, gradeProfileRevision: number | null, library: GameAsset[] = []): MotionPlan {
  // Library sprites and sounds may be used; they are packaged when the plan is applied.
  const config: GameConfig = { ...base, assets: { ...Object.fromEntries(library.map((a) => [a.id, a])), ...base.assets } };
  const screens = new Map(listScreens(config).map((s) => [s.id, s]));
  const unsupported: UnsupportedMotion[] = ai.unsupported.slice(0, 10).map((u) => ({ request: u.request.slice(0, 300) || 'Request', reason: u.reason.slice(0, 400) || 'Not supported.', alternative: u.alternative?.slice(0, 300) ?? null, handoff: u.handoff }));
  const refuse = (request: string, reason: string, alternative: string | null = null) => {
    if (unsupported.length < 10) unsupported.push({ request: request.slice(0, 300), reason: reason.slice(0, 400), alternative, handoff: false });
  };
  const taken = new Set(config.motion.bindings.map((b) => b.id));
  const remove = ai.remove
    .filter((r) => {
      const b = config.motion.bindings.find((x) => x.id === r.id);
      if (!b) return false;
      if (scope.kind === 'screen' && b.screenId !== scope.screenId) return refuse(`Remove ${r.id}`, 'That animation is on another screen than the one selected.'), false;
      if (config.motion.lockedScreens.includes(b.screenId)) return refuse(`Remove ${r.id}`, 'Motion on that screen is locked.'), false;
      return true;
    })
    .map((r) => ({ id: r.id, reason: r.reason.slice(0, 300) }));
  const removedIds = new Set(remove.map((r) => r.id));
  const kept = config.motion.bindings.filter((b) => !removedIds.has(b.id));
  const added: AnimationBinding[] = [];
  const indexToId = new Map<number, string>();
  ai.add.forEach((row, index) => {
    const what = `${row.presetId} on ${row.target}`;
    const screen = screens.get(row.screenId);
    if (!screen) return refuse(what, `There is no screen “${row.screenId}”.`);
    if (scope.kind === 'screen' && row.screenId !== scope.screenId) return refuse(what, `That is on ${screen.label}, outside the selected screen.`, 'Switch the scope to the whole game, or select that screen.');
    if (config.motion.lockedScreens.includes(row.screenId)) return refuse(what, `Motion on ${screen.label} is locked.`);
    const preset = MOTION_PRESETS[row.presetId];
    const params: Record<string, string | number | boolean> = {};
    for (const p of row.params.slice(0, 8)) if (/^[a-zA-Z]{1,24}$/.test(p.name)) params[p.name] = coerce(p.value);
    const merged = { ...preset.defaults, ...params };
    if (row.presetId === 'move-to' && (merged.to !== undefined || params.x !== undefined)) {
      if (params.to !== undefined) {
        delete merged.x;
        delete merged.y;
      } else delete merged.to;
    }
    let after: string | null = null;
    if (row.afterIndex !== null && indexToId.has(row.afterIndex)) after = indexToId.get(row.afterIndex)!;
    else if (row.afterExistingId && kept.some((b) => b.id === row.afterExistingId)) after = row.afterExistingId;
    const b: AnimationBinding = {
      id: bindingId(row.screenId, row.presetId, taken),
      screenId: row.screenId,
      target: row.target,
      presetId: row.presetId,
      trigger: { event: row.triggerEvent, control: row.triggerEvent === 'control-activated' ? ((row.triggerControl as AnimationBinding['trigger']['control']) ?? null) : null, entity: row.triggerEntity ?? null },
      params: merged,
      timing: {
        delayMs: Math.max(0, Math.min(10_000, Math.round(row.delayMs))),
        durationMs: Math.max(preset.duration.min, Math.min(preset.duration.max, Math.round(row.durationMs || preset.duration.default))),
        easing: EASE.has(row.easing) ? row.easing : 'ease-out',
        repeat: Math.max(1, Math.min(preset.maxRepeat, Math.round(row.repeat || 1))),
      },
      after,
      reducedMotion: row.reducedMotion,
      purpose: row.purpose,
      origin: row.evidence === 'source' ? 'source' : row.evidence === 'design-evidence' ? 'design-evidence' : 'claude',
      assetId: row.assetId,
      sound: row.soundAssetId ? { assetId: row.soundAssetId, volume: Math.max(0, Math.min(1, row.soundVolume ?? 0.8)) } : null,
      label: '',
      gradeProfileRevision,
      enabled: true,
    };
    const issues = validateBindings(config, [...kept, ...added, b]).filter((i) => i.severity === 'error' && (i.bindingId === b.id || i.bindingId === null));
    if (issues.length) {
      taken.delete(b.id);
      const staticClip = issues.find((i) => /static image/.test(i.message));
      return refuse(`${preset.label} on ${screen.entities.find((e) => e.id === row.target)?.label ?? row.target}`, issues[0]!.message, staticClip ? 'Use a whole-object movement (fade, move, scale) instead, or upload frames and set up a clip.' : null);
    }
    added.push(b);
    indexToId.set(index, b.id);
  });
  const draftConfig = { ...config, motion: { ...config.motion, bindings: [...kept, ...added] } };
  const labelled = added.map((b) => ({ ...b, label: describeBinding(draftConfig, b).slice(0, 160) }));
  let settings: MotionPlan['settings'] = null;
  if (ai.settings) {
    const raw = Object.fromEntries(Object.entries(ai.settings).filter(([, v]) => v !== null));
    const parsed = motionSettingsSchema.partial().safeParse(raw);
    if (parsed.success && Object.keys(parsed.data).length) settings = parsed.data;
  }
  const resolved = ai.resolved
    .filter((r) => (r.screenId === null || screens.has(r.screenId)) && (r.entityId === null || (r.screenId !== null && screens.get(r.screenId)!.entities.some((e) => e.id === r.entityId))) && (r.assetId === null || Boolean(config.assets[r.assetId])))
    .slice(0, 20)
    .map((r) => ({ phrase: r.phrase.slice(0, 120), screenId: r.screenId, entityId: r.entityId, assetId: r.assetId, label: r.label.slice(0, 160) }));
  return {
    summary: (ai.summary || 'Proposed motion').slice(0, 800),
    settings,
    add: labelled,
    remove,
    unsupported,
    resolved,
    notes: ai.notes.slice(0, 8).map((n) => n.slice(0, 300)),
  };
}

/**
 * Apply the accepted rows of a plan to its base version, atomically, through
 * the proposal system (scope, locks, validation, stale detection, undo).
 */
export function applyMotionPlan(app: App, planId: string): { plan: MotionPlanRecord; version: GameVersion; proposal: Proposal } {
  const plan = getMotionPlan(app.db, planId);
  if (plan.status !== 'proposed') throw conflict(`This motion plan is already ${plan.status}.`);
  if (!plan.baseVersionId) throw conflict('This plan is staged for the next build.', 'Use “Approve & build” in Prepare to build it in.');
  const base = getVersion(app.db, plan.baseVersionId);
  const ops = attachLibraryAssets(motionPlanOps(plan.plan, plan.decisions), base.config, listAssetRows(app.db, plan.projectId).map((r) => toAsset(r)));
  if (ops.length === 0) throw badRequest('Accept at least one row before applying.');
  const scope = plan.scope.kind === 'screen' && plan.scope.screenId ? { kind: 'scene' as const, sceneId: plan.scope.screenId } : { kind: 'project' as const, sceneId: null };
  const preview = applyChangeOps(base.config, ops, { scope });
  // All accepted rows are applied together or not at all.
  const refused = preview.results.filter((r) => r.status === 'invalid' || r.status === 'conflict' || r.status === 'out-of-scope');
  if (refused.length) {
    throw conflict(`${refused.length} accepted row${refused.length === 1 ? '' : 's'} cannot be applied: ${refused[0]!.message ?? refused[0]!.status}`, 'Nothing was changed. Reject those rows (or unlock the screen) and apply again.');
  }
  const proposal = insertProposal(app.db, {
    projectId: plan.projectId,
    baseVersionId: base.id,
    scope,
    request: plan.request || 'Suggest motion',
    summary: `Motion plan ${plan.number}: ${ops.length} change${ops.length === 1 ? '' : 's'}`,
    explanation: plan.plan.summary,
    ops,
    results: preview.results,
    origin: plan.origin === 'claude' ? 'claude' : plan.origin === 'demo' ? 'demo' : 'creator',
    model: plan.model,
    jobId: null,
  });
  try {
    const r = applyProposal(app, proposal.id);
    resolveMotionPlan(app.db, plan.id, 'applied', { proposalId: proposal.id, resultVersionId: r.version.id });
    return { plan: getMotionPlan(app.db, plan.id), version: r.version, proposal: r.proposal };
  } catch (err) {
    if ((err as { status?: number }).status === 409 && /version/.test((err as Error).message)) resolveMotionPlan(app.db, plan.id, 'stale', { proposalId: proposal.id });
    throw err;
  }
}
