import type { GameConfig } from './schemas/game.ts';
import type { GradeAdaptationPlan } from './schemas/grade.ts';
import type { MotionPlan, PlanDecision } from './schemas/motion.ts';
import { MOTION_SETTING_FIELDS, type MotionSettingField } from './schemas/motion.ts';
import type { ChangeOp } from './schemas/proposal.ts';

/**
 * Reviewed plans → structured change ops. Only rows the creator accepted are
 * converted; the ops then go through the normal scope, lock and validation
 * checks, so a plan can never bypass a lock or produce an invalid game.
 */

export function gradePlanOps(plan: GradeAdaptationPlan, decisions: Record<string, PlanDecision>, config: GameConfig): { ops: ChangeOp[]; notes: string[] } {
  const ops: ChangeOp[] = [];
  const notes: string[] = [];
  for (const item of plan.items) {
    if (decisions[item.id] !== 'accepted') continue;
    if (item.changesLearning) {
      notes.push(`“${item.summary}” changes learning content, so it goes through blueprint review instead of being applied directly.`);
      continue;
    }
    if (!item.change) continue;
    const { field, value } = item.change;
    const targets = item.sceneId ? [item.sceneId] : field.startsWith('layout.') ? config.scenes.map((s) => s.id) : [];
    if (targets.length === 0) {
      notes.push(`“${item.summary}” names no scene, so it was not applied.`);
      continue;
    }
    for (const sceneId of targets) ops.push({ op: 'set-scene-field', sceneId, field, value });
  }
  return { ops, notes };
}

export function motionPlanOps(plan: MotionPlan, decisions: Record<string, PlanDecision>): ChangeOp[] {
  const ops: ChangeOp[] = [];
  for (const r of plan.remove) if (decisions[`remove:${r.id}`] === 'accepted') ops.push({ op: 'remove-animation', id: r.id });
  if (plan.settings && decisions.settings === 'accepted') {
    for (const field of MOTION_SETTING_FIELDS) {
      const value = (plan.settings as Partial<Record<MotionSettingField, unknown>>)[field];
      if (value !== undefined) ops.push({ op: 'set-motion-setting', field, value });
    }
  }
  // Additions in dependency order (an animation is added after the one it waits for).
  const accepted = plan.add.filter((b) => decisions[b.id] === 'accepted');
  const added = new Set<string>();
  let guard = 0;
  while (added.size < accepted.length && guard++ < accepted.length + 2) {
    for (const b of accepted) {
      if (added.has(b.id)) continue;
      if (b.after && accepted.some((x) => x.id === b.after) && !added.has(b.after)) continue;
      ops.push({ op: 'add-animation', binding: b, addAssets: [] });
      added.add(b.id);
    }
  }
  for (const b of accepted) if (!added.has(b.id)) ops.push({ op: 'add-animation', binding: b, addAssets: [] });
  return ops;
}
