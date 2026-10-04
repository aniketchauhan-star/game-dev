import type { GameConfig } from '../schemas/game.ts';
import { MOTION_BUDGET, type AnimationBinding } from '../schemas/motion.ts';
import { listScreens, type ScreenInfo } from './entities.ts';
import { MOTION_PRESETS } from './presets.ts';

export interface MotionIssue {
  bindingId: string | null;
  screenId: string | null;
  severity: 'error' | 'warning';
  message: string;
}

const TRIGGERS_BY_SCREEN: Record<ScreenInfo['type'], string[]> = {
  title: ['scene-entered', 'control-activated'],
  completion: ['scene-entered', 'control-activated'],
  info: ['scene-entered', 'control-activated', 'scene-completed'],
  'coordinate-navigation': ['scene-entered', 'control-activated', 'instruction-advanced', 'correct-answer', 'retry-requested', 'scene-completed'],
  'drag-match': ['scene-entered', 'control-activated', 'instruction-advanced', 'object-selected', 'valid-drop', 'correct-answer', 'retry-requested', 'scene-completed'],
  'sequence-sort': ['scene-entered', 'control-activated', 'instruction-advanced', 'object-selected', 'valid-drop', 'correct-answer', 'retry-requested', 'scene-completed'],
};

/**
 * Validate bindings against a game: screens, targets, presets, capabilities,
 * parameters, durations, dependencies (no cycles, bounded depth) and budgets.
 * Errors make the config invalid; warnings are shown to the creator.
 */
export function validateBindings(config: GameConfig, bindings: AnimationBinding[] = config.motion.bindings): MotionIssue[] {
  const issues: MotionIssue[] = [];
  const screens = new Map(listScreens(config).map((s) => [s.id, s]));
  const byId = new Map<string, AnimationBinding>();
  const err = (b: AnimationBinding | null, message: string, severity: 'error' | 'warning' = 'error') => issues.push({ bindingId: b?.id ?? null, screenId: b?.screenId ?? null, severity, message });

  for (const b of bindings) {
    if (byId.has(b.id)) err(b, `Duplicate animation id ${b.id}.`);
    byId.set(b.id, b);
  }

  const perScreen = new Map<string, AnimationBinding[]>();
  for (const b of bindings) {
    const list = perScreen.get(b.screenId) ?? [];
    list.push(b);
    perScreen.set(b.screenId, list);

    const screen = screens.get(b.screenId);
    if (!screen) {
      err(b, `Screen “${b.screenId}” does not exist in this game.`);
      continue;
    }
    const preset = MOTION_PRESETS[b.presetId];
    const entity = screen.entities.find((e) => e.id === b.target);
    if (!entity) {
      err(b, `${screen.label}: there is no object “${b.target}”.`);
      continue;
    }
    // A clip on a static picture is explained below (what it can do instead), not as a generic mismatch.
    if (!preset.targets.includes(entity.kind) && !(preset.requiresClip && entity.staticImage && !b.assetId)) {
      err(b, `${preset.label} cannot be used on ${entity.label} (${entity.kind}).`);
    }
    if (!TRIGGERS_BY_SCREEN[screen.type].includes(b.trigger.event)) {
      err(b, `${screen.label} never emits “${b.trigger.event}”.`);
    }
    if (preset.triggers && !preset.triggers.includes(b.trigger.event)) {
      err(b, `${preset.label} only runs on: ${preset.triggers.join(', ')}.`);
    }
    if (b.trigger.event === 'control-activated') {
      if (!b.trigger.control) err(b, 'Choose which button triggers this animation.');
      else if (!screen.controls.includes(b.trigger.control)) err(b, `${screen.label} has no “${b.trigger.control}” button.`);
    } else if (b.trigger.control !== null) {
      err(b, 'A button is only used with the “button pressed” trigger.');
    }
    if (b.trigger.entity !== null) {
      if (b.trigger.event !== 'valid-drop' && b.trigger.event !== 'object-selected') err(b, 'An object filter is only used with drop or selection triggers.');
      else if (!screen.entities.some((e) => e.id === b.trigger.entity)) err(b, `${screen.label}: there is no object “${b.trigger.entity}” to filter on.`);
    }
    const params = preset.params.safeParse(b.params);
    if (!params.success) err(b, `${preset.label}: ${params.error.issues[0]?.path.join('.') || 'parameters'} — ${params.error.issues[0]?.message ?? 'invalid'}.`);
    if (b.timing.durationMs < preset.duration.min || b.timing.durationMs > preset.duration.max) {
      err(b, `${preset.label} lasts between ${preset.duration.min} and ${preset.duration.max} ms.`);
    }
    if (b.timing.repeat > preset.maxRepeat) err(b, `${preset.label} can repeat at most ${preset.maxRepeat} time${preset.maxRepeat === 1 ? '' : 's'}.`);
    if (preset.requiresClip) {
      const clip = typeof b.params.clip === 'string' ? b.params.clip : null;
      const source = b.assetId ? config.assets[b.assetId] : entity.assetId ? config.assets[entity.assetId] : undefined;
      const clips = source?.sprite?.clips?.map((c) => c.name) ?? [];
      if (b.assetId && !config.assets[b.assetId]) err(b, `The clip asset ${b.assetId} is not packaged with this game.`);
      else if (!source?.sprite) {
        err(b, `${entity.label} is a static image: it can move, scale, fade or rotate as a whole, but it has no animation frames for “${clip ?? 'a clip'}”. Upload frames or a sprite sheet and set up clips in Assets.`);
      } else if (clip && !clips.includes(clip)) {
        err(b, `${entity.label} has no clip named “${clip}” (available: ${clips.join(', ') || 'none'}).`);
      }
    }
    if (b.presetId === 'guided-return' && b.trigger.control !== 'reset') {
      err(b, 'Guided return follows the Reset button: the game puts pieces back, and the motion shows it.');
    }
    if (b.presetId === 'move-by' && b.params.units === 'grid' && screen.type !== 'coordinate-navigation') {
      err(b, 'Grid units only work on coordinate screens.');
    }
    if ((b.presetId === 'move-to' || b.presetId === 'path-reveal') && typeof b.params.to === 'string' && !screen.entities.some((e) => e.id === b.params.to)) {
      err(b, `${screen.label}: there is no object “${String(b.params.to)}” to move or point to.`);
    }
    if (b.sound) {
      const a = config.assets[b.sound.assetId];
      if (!a) err(b, `Sound ${b.sound.assetId} is not packaged with this game.`);
      else if (a.kind !== 'audio') err(b, 'The sound must be an audio file.');
    }
    if (b.after !== null) {
      const dep = bindings.find((d) => d.id === b.after);
      if (!dep) err(b, `It waits for ${b.after}, which does not exist.`);
      else if (dep.screenId !== b.screenId) err(b, 'It can only wait for an animation on the same screen.');
      else if (dep.trigger.event !== b.trigger.event) err(b, 'It can only wait for an animation with the same trigger.');
    }
    if (preset.purpose === 'decorative' && entity.interactive && b.trigger.event === 'object-selected') {
      err(b, 'Decorative motion on an object while it is being handled would fight with dragging.', 'warning');
    }
  }

  // Dependencies: finite chains, no cycles.
  for (const b of bindings) {
    const seen = new Set<string>([b.id]);
    let cur = b.after;
    let depth = 0;
    while (cur) {
      if (seen.has(cur)) {
        err(b, 'Its “after” chain loops back on itself.');
        break;
      }
      seen.add(cur);
      depth++;
      if (depth > MOTION_BUDGET.maxChainDepth) {
        err(b, `Sequences can be at most ${MOTION_BUDGET.maxChainDepth} steps long.`);
        break;
      }
      cur = byId.get(cur)?.after ?? null;
    }
  }

  // Conflicts: two movements (or two entrances) of the same object that would run at the same time.
  const MOVEMENT = new Set(['move-to', 'move-by', 'follow-path']);
  const times = new Map<string, { start: number; end: number }>();
  const timeOf = (b: AnimationBinding, depth = 0): { start: number; end: number } => {
    const hit = times.get(b.id);
    if (hit) return hit;
    const dep = b.after ? byId.get(b.after) : undefined;
    const start = (dep && depth < MOTION_BUDGET.maxChainDepth ? timeOf(dep, depth + 1).end : 0) + b.timing.delayMs;
    const t = { start, end: start + b.timing.durationMs * b.timing.repeat };
    times.set(b.id, t);
    return t;
  };
  const groups = new Map<string, AnimationBinding[]>();
  for (const b of bindings) {
    if (!b.enabled) continue;
    const kind = MOVEMENT.has(b.presetId) ? 'movement' : MOTION_PRESETS[b.presetId].category === 'entrance' ? 'entrance' : null;
    if (!kind) continue;
    const key = [b.screenId, b.target, b.trigger.event, b.trigger.control ?? '', b.trigger.entity ?? '', kind].join('|');
    groups.set(key, [...(groups.get(key) ?? []), b]);
  }
  for (const list of groups.values()) {
    for (let i = 1; i < list.length; i++) {
      const b = list[i]!;
      const tb = timeOf(b);
      const clash = list.slice(0, i).find((a) => {
        const ta = timeOf(a);
        return ta.start < tb.end && tb.start < ta.end;
      });
      if (clash) {
        const what = MOVEMENT.has(b.presetId) ? 'move' : 'bring in';
        err(b, `${MOTION_PRESETS[clash.presetId].label} and ${MOTION_PRESETS[b.presetId].label} would both ${what} the same object at the same time. Sequence one after the other (After), or remove one.`, 'warning');
      }
    }
  }

  // Budgets per screen.
  for (const [screenId, list] of perScreen) {
    const enabled = list.filter((b) => b.enabled);
    if (enabled.length > MOTION_BUDGET.bindingsPerScreen) {
      issues.push({ bindingId: null, screenId, severity: 'error', message: `At most ${MOTION_BUDGET.bindingsPerScreen} animations per screen.` });
    }
    const byTrigger = new Map<string, number>();
    for (const b of enabled) byTrigger.set(b.trigger.event, (byTrigger.get(b.trigger.event) ?? 0) + 1);
    for (const [trigger, n] of byTrigger) {
      if (n > MOTION_BUDGET.bindingsPerTrigger) issues.push({ bindingId: null, screenId, severity: 'error', message: `At most ${MOTION_BUDGET.bindingsPerTrigger} animations can start on “${trigger}”.` });
    }
    const particles = enabled.filter((b) => b.presetId === 'particle-burst').length;
    if (particles > MOTION_BUDGET.particlePresetsPerScreen) {
      issues.push({ bindingId: null, screenId, severity: 'error', message: `At most ${MOTION_BUDGET.particlePresetsPerScreen} particle bursts per screen.` });
    }
    const transitions = enabled.filter((b) => MOTION_PRESETS[b.presetId].category === 'transition');
    if (transitions.length > 1) issues.push({ bindingId: null, screenId, severity: 'error', message: 'A screen can have only one entrance transition.' });
  }
  return issues;
}
