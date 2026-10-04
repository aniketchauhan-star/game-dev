import { describe, expect, it } from 'vitest';
import { gameConfigSchema, type GameConfig } from '@shared/schemas/game.ts';
import { applyChangeOps } from '@shared/schemas/proposal.ts';
import type { AnimationBinding, MotionPlan } from '@shared/schemas/motion.ts';
import { describeBinding } from '@shared/motion/describe.ts';
import { listScreens } from '@shared/motion/entities.ts';
import { makeBinding, suggestScreenMotion } from '@shared/motion/suggest.ts';
import { validateBindings } from '@shared/motion/validate.ts';
import { motionPlanOps } from '@shared/plans.ts';
import { makeGameConfig, must } from './helpers.ts';

/** The four-scene test game with a sprite character (idle / wave / celebrate) on the drag-match scene. */
function spriteGame(): GameConfig {
  const c = makeGameConfig();
  c.assets.ast_bird0001 = {
    id: 'ast_bird0001',
    kind: 'image',
    file: 'assets/ast_bird0001.png',
    mime: 'image/png',
    width: 1280,
    height: 256,
    alt: 'Swiftee, the expedition guide',
    placement: { scale: 1, rotation: 0, anchorX: 0.5, anchorY: 1, crop: null },
    sprite: {
      frameWidth: 128,
      frameHeight: 256,
      columns: 10,
      rows: 1,
      spacing: 0,
      frameCount: 10,
      fps: 8,
      anchorX: 0.5,
      anchorY: 1,
      clips: [
        { name: 'idle', from: 0, to: 1, fps: 2, loop: true },
        { name: 'wave', from: 2, to: 5, fps: null, loop: false },
        { name: 'celebrate', from: 6, to: 9, fps: null, loop: false },
      ],
    },
  };
  const quad = must(c.scenes.find((s) => s.id === 'scn_quad'));
  quad.assets = { background: null, character: 'ast_bird0001', characterClip: 'idle', panel: null, button: null };
  return gameConfigSchema.parse(c);
}

const screenOf = (c: GameConfig, id: string) => must(listScreens(c).find((s) => s.id === id), id);

function binding(c: GameConfig, screenId: string, d: Parameters<typeof makeBinding>[2], taken = new Set<string>()): AnimationBinding {
  return makeBinding(c, screenOf(c, screenId), d, taken, 'creator');
}

describe('motion entities', () => {
  it('lists every screen with its real objects, named by their assets', () => {
    const c = spriteGame();
    const screens = listScreens(c);
    expect(screens.map((s) => s.label)).toEqual(['Screen 1 · Title', 'Screen 2 · Meet the grid', 'Screen 3 · Taxi to Runway Alpha', 'Screen 4 · Which quadrant?', 'Screen 5 · Line up for take-off', 'Screen 6 · Completion']);
    const quad = screenOf(c, 'scn_quad');
    const swiftee = must(quad.entities.find((e) => e.id === 'character'));
    expect(swiftee).toMatchObject({ label: 'Swiftee', kind: 'sprite', clips: ['idle', 'wave', 'celebrate'], staticImage: false });
    expect(quad.entities.filter((e) => e.kind === 'target').map((e) => e.id)).toEqual(['target:q1', 'target:q2', 'target:q3', 'target:axis']);
    // On coordinate screens the character is the mover, not a separate object.
    expect(screenOf(c, 'scn_taxi').entities.some((e) => e.id === 'character')).toBe(false);
    expect(screenOf(c, 'title').entities.find((e) => e.id === 'character')).toMatchObject({ kind: 'image', staticImage: true });
  });
});

describe('validateBindings', () => {
  it('accepts a valid wave on screen entry and reads it as a rule', () => {
    const c = spriteGame();
    const b = binding(c, 'scn_quad', { target: 'character', presetId: 'character-clip', event: 'scene-entered', params: { clip: 'wave' } });
    expect(validateBindings(c, [b])).toEqual([]);
    expect(describeBinding({ ...c, motion: { ...c.motion, bindings: [b] } }, b)).toBe('When Screen 4 · Which quadrant? opens → play Swiftee\'s “wave” clip once.');
  });

  it('refuses frame animation on a static picture and names the fix', () => {
    const c = spriteGame();
    const b = binding(c, 'title', { target: 'character', presetId: 'character-clip', event: 'scene-entered', params: { clip: 'wave' } });
    const issues = validateBindings(c, [b]);
    expect(issues[0]?.message).toMatch(/static image: it can move, scale, fade or rotate as a whole/);
    expect(issues[0]?.message).toMatch(/sprite sheet/);
  });

  it('refuses unknown clips, objects, buttons and triggers the screen never emits', () => {
    const c = spriteGame();
    const clip = binding(c, 'scn_quad', { target: 'character', presetId: 'character-clip', event: 'scene-entered', params: { clip: 'dance' } });
    expect(validateBindings(c, [clip])[0]?.message).toMatch(/no clip named “dance” \(available: idle, wave, celebrate\)/);
    const ghost = { ...binding(c, 'scn_quad', { target: 'tray', presetId: 'attention-cue', event: 'scene-entered' }), target: 'item:zz' };
    expect(validateBindings(c, [ghost])[0]?.message).toMatch(/there is no object “item:zz”/);
    const button = binding(c, 'scn_intro', { target: 'points', presetId: 'label-reveal', event: 'control-activated', control: 'check' });
    expect(validateBindings(c, [button]).map((i) => i.message).join(' ')).toMatch(/has no “check” button/);
    const drop = binding(c, 'scn_intro', { target: 'points', presetId: 'label-reveal', event: 'valid-drop' });
    expect(validateBindings(c, [drop]).map((i) => i.message).join(' ')).toMatch(/never emits “valid-drop”/);
  });

  it('ties guided return to the Reset button and grid units to coordinate screens', () => {
    const c = spriteGame();
    const ret = binding(c, 'scn_quad', { target: 'item:p1', presetId: 'guided-return', event: 'control-activated', control: 'check' });
    expect(validateBindings(c, [ret]).map((i) => i.message).join(' ')).toMatch(/Guided return follows the Reset button/);
    const grid = binding(c, 'scn_quad', { target: 'tray', presetId: 'move-by', event: 'scene-entered', params: { dx: 1, dy: 0, units: 'grid' } });
    expect(validateBindings(c, [grid]).map((i) => i.message).join(' ')).toMatch(/Grid units only work on coordinate screens/);
    const ok = binding(c, 'scn_taxi', { target: 'mover', presetId: 'move-by', event: 'scene-entered', params: { dx: 2, dy: 1, units: 'grid' } });
    expect(validateBindings(c, [ok])).toEqual([]);
  });

  it('rejects dependency loops, cross-trigger waits and over-budget screens', () => {
    const c = spriteGame();
    const taken = new Set<string>();
    const a = binding(c, 'scn_quad', { target: 'instruction', presetId: 'outline-highlight', event: 'scene-entered' }, taken);
    const b = binding(c, 'scn_quad', { target: 'tray', presetId: 'attention-cue', event: 'scene-entered', after: a.id }, taken);
    const loop = [{ ...a, after: b.id }, b];
    expect(validateBindings(c, loop).some((i) => /loops back/.test(i.message))).toBe(true);
    const cross = binding(c, 'scn_quad', { target: 'instruction', presetId: 'success-highlight', event: 'correct-answer', after: a.id }, taken);
    expect(validateBindings(c, [a, cross]).some((i) => /same trigger/.test(i.message))).toBe(true);
    const many = Array.from({ length: 9 }, () => binding(c, 'scn_quad', { target: 'instruction', presetId: 'outline-highlight', event: 'scene-entered' }, taken));
    expect(validateBindings(c, many).some((i) => /At most 8 animations can start/.test(i.message))).toBe(true);
    const fades = [binding(c, 'scn_quad', { target: 'screen', presetId: 'scene-fade', event: 'scene-entered' }, taken), binding(c, 'scn_quad', { target: 'screen', presetId: 'scene-cut', event: 'scene-entered' }, taken)];
    expect(validateBindings(c, fades).some((i) => /only one entrance transition/.test(i.message))).toBe(true);
  });

  it('warns when two movements or two entrances of one object would run at the same time', () => {
    const c = spriteGame();
    const taken = new Set<string>();
    const a = binding(c, 'scn_taxi', { target: 'mover', presetId: 'move-by', event: 'correct-answer', params: { dx: 1, dy: 0, units: 'grid' }, durationMs: 800 }, taken);
    const b = binding(c, 'scn_taxi', { target: 'mover', presetId: 'move-by', event: 'correct-answer', params: { dx: 0, dy: 1, units: 'grid' }, durationMs: 800 }, taken);
    const together = validateBindings(c, [a, b]);
    expect(together).toEqual([expect.objectContaining({ bindingId: b.id, severity: 'warning', message: expect.stringMatching(/would both move the same object at the same time/) })]);
    // In sequence, or with the second starting after the first has finished, there is no conflict.
    expect(validateBindings(c, [a, { ...b, after: a.id }])).toEqual([]);
    expect(validateBindings(c, [a, { ...b, timing: { ...b.timing, delayMs: 800 } }])).toEqual([]);
    // Different objects never conflict.
    const fade = binding(c, 'scn_quad', { target: 'instruction', presetId: 'fade-in', event: 'scene-entered' }, taken);
    const slide = binding(c, 'scn_quad', { target: 'instruction', presetId: 'slide-in', event: 'scene-entered' }, taken);
    const tray = binding(c, 'scn_quad', { target: 'tray', presetId: 'slide-in', event: 'scene-entered' }, taken);
    expect(validateBindings(c, [fade, tray])).toEqual([]);
    expect(validateBindings(c, [fade, slide]).map((i) => i.message)).toEqual([expect.stringMatching(/would both bring in the same object/)]);
  });

  it('makes an invalid binding an invalid game', () => {
    const c = spriteGame();
    c.motion.bindings = [binding(c, 'title', { target: 'character', presetId: 'character-clip', event: 'scene-entered', params: { clip: 'wave' } })];
    expect(gameConfigSchema.safeParse(c).success).toBe(false);
  });
});

describe('screen reordering', () => {
  it('keeps animations attached to their screen and renumbers the readable rules', () => {
    const c = spriteGame();
    const wave = binding(c, 'scn_quad', { target: 'character', presetId: 'character-clip', event: 'scene-entered', params: { clip: 'wave' } });
    c.motion.bindings = [wave];
    expect(describeBinding(c, wave)).toMatch(/^When Screen 4 · Which quadrant\? opens/);
    const quad = must(c.scenes.find((s) => s.id === 'scn_quad'));
    const reordered = { ...c, scenes: [quad, ...c.scenes.filter((s) => s.id !== 'scn_quad')] };
    expect(validateBindings(reordered)).toEqual([]);
    expect(describeBinding(reordered, wave)).toMatch(/^When Screen 2 · Which quadrant\? opens/);
  });
});

describe('suggestScreenMotion (preset rules, no AI)', () => {
  it('is deterministic, validates, and never points at the answer', () => {
    const c = spriteGame();
    const a = suggestScreenMotion(c, 'scn_quad');
    const b = suggestScreenMotion(c, 'scn_quad');
    expect(a).toEqual(b);
    expect(a.add.length).toBeGreaterThan(3);
    expect(validateBindings(c, a.add).filter((i) => i.severity === 'error')).toEqual([]);
    // Feedback is bound to the mechanic's events; nothing highlights a specific target before an answer.
    for (const x of a.add.filter((x) => x.trigger.event === 'scene-entered')) expect(x.target.startsWith('target:') || x.target.startsWith('item:')).toBe(false);
    expect(a.add.filter((x) => x.presetId === 'drop-snap').every((x) => x.trigger.event === 'valid-drop' && x.trigger.entity === x.target)).toBe(true);
    expect(a.add.some((x) => x.presetId === 'character-clip' && x.params.clip === 'wave')).toBe(true);
    expect(a.add.every((x) => x.label.length > 0 && !x.label.includes('anim-'))).toBe(true);
  });

  it('leaves decoration out for the minimal profile and explains static pictures', () => {
    const c = spriteGame();
    c.motion.profile = 'minimal';
    const plan = suggestScreenMotion(c, 'scn_quad');
    expect(plan.add.every((x) => x.purpose !== 'decorative')).toBe(true);
    const title = suggestScreenMotion(spriteGame(), 'title');
    expect(title.notes.join(' ')).toMatch(/static picture/);
  });

  it('does not repeat animations the screen already has', () => {
    const c = spriteGame();
    const first = suggestScreenMotion(c, 'scn_quad');
    c.motion.bindings = first.add;
    const again = suggestScreenMotion(gameConfigSchema.parse(c), 'scn_quad');
    expect(again.add.filter((x) => x.presetId !== 'celebration-clip')).toEqual([]);
  });
});

describe('motion change ops', () => {
  const addOp = (b: AnimationBinding) => ({ op: 'add-animation' as const, binding: b, addAssets: [] });

  it('applies within the selected screen only, and respects motion locks', () => {
    const c = spriteGame();
    const wave = binding(c, 'scn_quad', { target: 'character', presetId: 'character-clip', event: 'scene-entered', params: { clip: 'wave' } });
    const other = binding(c, 'scn_intro', { target: 'points', presetId: 'label-reveal', event: 'scene-entered' });
    const r = applyChangeOps(c, [addOp(wave), addOp(other)], { scope: { kind: 'scene', sceneId: 'scn_quad' } });
    expect(r.results.map((x) => x.status)).toEqual(['applied', 'out-of-scope']);
    expect(r.config.motion.bindings.map((b) => b.id)).toEqual([wave.id]);
    c.motion.lockedScreens = ['scn_quad'];
    const locked = applyChangeOps(c, [addOp(wave)], { scope: { kind: 'project', sceneId: null } });
    expect(locked.results[0]?.status).toBe('conflict');
    expect(locked.ok).toBe(false);
  });

  it('never applies a binding that makes the game invalid, and never mutates the base', () => {
    const c = spriteGame();
    const frozen = structuredClone(c);
    const bad = binding(c, 'title', { target: 'character', presetId: 'character-clip', event: 'scene-entered', params: { clip: 'wave' } });
    const r = applyChangeOps(c, [addOp(bad)], { scope: { kind: 'project', sceneId: null } });
    expect(r.results[0]?.status).toBe('invalid');
    expect(r.ok).toBe(false);
    expect(c).toEqual(frozen);
  });

  it('refuses to remove an animation another one waits for', () => {
    const c = spriteGame();
    const taken = new Set<string>();
    const a = binding(c, 'scn_quad', { target: 'instruction', presetId: 'outline-highlight', event: 'scene-entered' }, taken);
    const b = binding(c, 'scn_quad', { target: 'tray', presetId: 'attention-cue', event: 'scene-entered', after: a.id }, taken);
    c.motion.bindings = [a, b];
    const r = applyChangeOps(gameConfigSchema.parse(c), [{ op: 'remove-animation', id: a.id }], { scope: { kind: 'project', sceneId: null } });
    expect(r.results[0]).toMatchObject({ status: 'invalid' });
    expect(r.results[0]?.message).toMatch(/waits for this one/);
  });

  it('turns only accepted plan rows into ops, in dependency order', () => {
    const c = spriteGame();
    const taken = new Set<string>();
    const first = binding(c, 'scn_quad', { target: 'character', presetId: 'character-clip', event: 'scene-entered', params: { clip: 'wave' } }, taken);
    const second = binding(c, 'scn_quad', { target: 'instruction', presetId: 'outline-highlight', event: 'scene-entered', after: first.id }, taken);
    const skipped = binding(c, 'scn_quad', { target: 'tray', presetId: 'attention-cue', event: 'scene-entered' }, taken);
    const plan: MotionPlan = { summary: 'x', settings: { pacing: c.motion.pacing === 'calm' ? 'standard' : 'calm' }, add: [second, first, skipped], remove: [], unsupported: [], resolved: [], notes: [] };
    const ops = motionPlanOps(plan, { [first.id]: 'accepted', [second.id]: 'accepted', [skipped.id]: 'rejected', settings: 'pending' });
    expect(ops.map((o) => (o.op === 'add-animation' ? o.binding.id : o.op))).toEqual([first.id, second.id]);
    const r = applyChangeOps(c, ops, { scope: { kind: 'scene', sceneId: 'scn_quad' } });
    expect(r.ok).toBe(true);
    // The settings row was not accepted, so pacing is unchanged.
    expect(r.config.motion.pacing).toBe(c.motion.pacing);
  });
});
