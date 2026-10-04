import type { GameConfig } from '../schemas/game.ts';
import type { AnimationBinding, MotionControl, MotionPlan, MotionPresetId, MotionTrigger } from '../schemas/motion.ts';
import { describeBinding } from './describe.ts';
import { listScreens, type ScreenInfo } from './entities.ts';
import { MOTION_PRESETS } from './presets.ts';
import { validateBindings } from './validate.ts';

/**
 * Deterministic “Suggest motion for this screen” (no AI): a few purposeful
 * presets chosen from the screen's real objects and the motion profile —
 * instructional emphasis first, feedback tied to the mechanic's events, and
 * decoration only when the profile allows it. Answers are never revealed (no
 * arrow to the target position, no highlight of the right card).
 */

export function bindingId(screenId: string, presetId: string, taken: Set<string>): string {
  const base = `anim-${screenId.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 12)}-${presetId.slice(0, 10)}`.replace(/-+/g, '-');
  let id = base.slice(0, 35);
  for (let i = 2; taken.has(id); i++) id = `${base.slice(0, 31)}-${i}`;
  taken.add(id);
  return id;
}

interface Draft {
  target: string;
  presetId: MotionPresetId;
  event: MotionTrigger;
  control?: MotionControl | null;
  entity?: string | null;
  params?: Record<string, string | number | boolean>;
  delayMs?: number;
  durationMs?: number;
  after?: string | null;
  repeat?: number;
}

export function makeBinding(config: GameConfig, screen: ScreenInfo, d: Draft, taken: Set<string>, origin: AnimationBinding['origin'] = 'preset'): AnimationBinding {
  const preset = MOTION_PRESETS[d.presetId];
  return {
    id: bindingId(screen.id, d.presetId, taken),
    screenId: screen.id,
    target: d.target,
    presetId: d.presetId,
    trigger: { event: d.event, control: d.control ?? null, entity: d.entity ?? null },
    params: { ...preset.defaults, ...(d.params ?? {}) },
    timing: { delayMs: d.delayMs ?? 0, durationMs: d.durationMs ?? preset.duration.default, easing: 'ease-out', repeat: d.repeat ?? 1 },
    after: d.after ?? null,
    reducedMotion: preset.defaultReduced,
    purpose: preset.purpose,
    origin,
    assetId: null,
    sound: null,
    label: '',
    gradeProfileRevision: config.meta.gradeProfileRevision ?? null,
    enabled: true,
  };
}

export function suggestScreenMotion(config: GameConfig, screenId: string): MotionPlan {
  const screen = listScreens(config).find((s) => s.id === screenId);
  if (!screen) return { summary: 'That screen is not in this game.', settings: null, add: [], remove: [], unsupported: [], resolved: [], notes: [] };
  const profile = config.motion.profile;
  const decorative = config.motion.decorativeIntensity !== 'off' && profile !== 'minimal';
  const playful = profile === 'playful';
  const taken = new Set(config.motion.bindings.map((b) => b.id));
  const has = (id: string) => screen.entities.find((e) => e.id === id) ?? null;
  const out: AnimationBinding[] = [];
  const add = (d: Draft) => {
    const b = makeBinding(config, screen, d, taken);
    out.push(b);
    return b;
  };
  const notes: string[] = [];
  const existing = config.motion.bindings.filter((b) => b.screenId === screenId);
  const already = (presetId: string, target: string, event: string) => existing.some((b) => b.presetId === presetId && b.target === target && b.trigger.event === event);

  // Entrance.
  let lead: AnimationBinding | null = null;
  if (decorative && !existing.some((b) => MOTION_PRESETS[b.presetId].category === 'transition')) lead = add({ target: 'screen', presetId: 'scene-fade', event: 'scene-entered', durationMs: 320 });
  const character = has('character');
  if (decorative && character?.clips.includes('wave') && !already('character-clip', 'character', 'scene-entered')) {
    lead = add({ target: 'character', presetId: 'character-clip', event: 'scene-entered', params: { clip: 'wave' }, after: lead?.id ?? null, durationMs: 1000 });
  } else if (character && character.staticImage && decorative) {
    notes.push(`${character.label} is a static picture, so it can only move, fade, scale or rotate as a whole. Upload frames or a sprite sheet with a “wave” clip for a wave.`);
  }

  if (screen.kind === 'scene') {
    // Instructional emphasis on the task itself, never on the answer.
    if (screen.type === 'info') {
      if (has('points') && !already('label-reveal', 'points', 'scene-entered')) add({ target: 'points', presetId: 'label-reveal', event: 'scene-entered', after: lead?.id ?? null, durationMs: 1800 });
    } else {
      if (!already('outline-highlight', 'instruction', 'scene-entered')) add({ target: 'instruction', presetId: 'outline-highlight', event: 'scene-entered', after: lead?.id ?? null, params: { color: 'accent', width: 6, pulses: 1 }, durationMs: 1200 });
      const work = has('tray') ?? has('grid');
      if (work && !already('attention-cue', work.id, 'scene-entered')) add({ target: work.id, presetId: 'attention-cue', event: 'scene-entered', delayMs: 400, durationMs: 700 });
    }
    // Feedback driven by the mechanic.
    if (screen.type === 'drag-match') {
      for (const t of screen.entities.filter((e) => e.kind === 'target').slice(0, 6)) {
        if (!already('drop-snap', t.id, 'valid-drop')) add({ target: t.id, presetId: 'drop-snap', event: 'valid-drop', entity: t.id });
      }
    }
    if (screen.type === 'sequence-sort') {
      for (const c of screen.entities.filter((e) => e.kind === 'card').slice(0, 6)) {
        if (!already('drop-snap', c.id, 'valid-drop')) add({ target: c.id, presetId: 'drop-snap', event: 'valid-drop', entity: c.id });
      }
    }
    if (screen.type !== 'info') {
      if (!already('retry-cue', 'instruction', 'retry-requested')) add({ target: 'instruction', presetId: 'retry-cue', event: 'retry-requested', params: { color: 'focus' } });
      if (!already('success-highlight', 'instruction', 'correct-answer')) add({ target: 'instruction', presetId: 'success-highlight', event: 'correct-answer' });
      if (decorative && character?.clips.includes('celebrate')) add({ target: 'character', presetId: 'celebration-clip', event: 'correct-answer', params: { clip: 'celebrate' }, durationMs: 1000 });
      else if (playful) add({ target: 'instruction', presetId: 'particle-burst', event: 'correct-answer', params: { count: 14, spread: 140, colors: 'palette' } });
      if (playful) add({ target: 'button:check', presetId: 'press', event: 'control-activated', control: 'check' });
    }
  } else if (screen.kind === 'title') {
    if (decorative && !already('pop-in', 'title-card', 'scene-entered')) add({ target: 'title-card', presetId: 'pop-in', event: 'scene-entered', after: lead?.id ?? null });
  } else {
    if (decorative && character?.clips.includes('celebrate')) add({ target: 'character', presetId: 'celebration-clip', event: 'scene-entered', params: { clip: 'celebrate' }, after: lead?.id ?? null });
    else if (has('badge')) add({ target: 'badge', presetId: 'pop-in', event: 'scene-entered', after: lead?.id ?? null });
    if (playful) add({ target: 'completion-card', presetId: 'particle-burst', event: 'scene-entered', delayMs: 300, params: { count: 18, spread: 200, colors: 'palette' } });
  }

  // Keep only what validates together with the approved motion (budgets, targets, clips).
  const kept: AnimationBinding[] = [];
  for (const b of out) {
    const fixed = { ...b, after: b.after && kept.some((k) => k.id === b.after) ? b.after : null };
    const issues = validateBindings(config, [...config.motion.bindings, ...kept, fixed]).filter((i) => i.severity === 'error' && (i.bindingId === fixed.id || i.bindingId === null));
    if (issues.length === 0) kept.push(fixed);
    else notes.push(`Left out ${MOTION_PRESETS[fixed.presetId].label.toLowerCase()} on ${fixed.target}: ${issues[0]!.message}`);
  }
  const profileText = profile === 'minimal' ? 'Minimal profile: instructional emphasis and feedback only' : profile === 'playful' ? 'Playful profile: also small celebrations' : 'Guided profile: a calm entrance, a highlight of the task, and feedback on drops and answers';
  const withLabels = kept.map((b) => ({ ...b, label: describeBinding({ ...config, motion: { ...config.motion, bindings: [...config.motion.bindings, ...kept] } }, b).slice(0, 160) }));
  return {
    summary: `${kept.length} suggested animation${kept.length === 1 ? '' : 's'} for ${screen.label}. ${profileText}. Nothing points at the right answer.`,
    settings: null,
    add: withLabels,
    remove: [],
    unsupported: [],
    resolved: [],
    notes: notes.slice(0, 8),
  };
}
