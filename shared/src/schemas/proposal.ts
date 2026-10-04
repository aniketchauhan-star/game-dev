import { z } from 'zod';
import { gameAssetSchema, gameConfigSchema, type GameAsset, type GameConfig } from './game.ts';
import type { SceneLocks } from './blueprint.ts';
import { objectPlacementSchema, sceneDesignSchema } from './design.ts';
import { animationBindingSchema, MOTION_SETTING_LABELS, motionSettingField, screenIdSchema } from './motion.ts';
import { checkInteraction } from '../attainability.ts';
import { listScreens } from '../motion/entities.ts';

/**
 * Structured edits against a specific game version. Used for Claude
 * refinements, demo templates and the creator's own inspector edits. Every
 * field is allowlisted with the lock that guards it.
 */

export const SCENE_FIELDS = [
  'title',
  'instruction',
  'supportText',
  'layout.instructionPosition',
  'layout.density',
  'layout.showProgress',
  'feedback.success',
  'feedback.error',
  'feedback.hints',
  'assets.background',
  'assets.character',
  'assets.characterClip',
  'assets.panel',
  'assets.button',
  'interaction.display',
  'interaction.showCoordinateReadout',
  'interaction.showTargetMarker',
  'interaction.moverLabel',
  'interaction.landmarks',
  'interaction.grid',
  'interaction.start',
  'interaction.rule',
  'interaction.items',
  'interaction.targets',
  'interaction.trayPosition',
  'interaction.orientation',
  'interaction.showValues',
  'interaction.startLabel',
  'interaction.endLabel',
  'interaction.points',
  'interaction.illustration',
  'interaction.continueLabel',
] as const;
export const sceneFieldSchema = z.enum(SCENE_FIELDS);
export type SceneField = z.infer<typeof sceneFieldSchema>;

export const PROJECT_FIELDS = [
  'title',
  'theme.palette',
  'theme.decor',
  'theme.fontStyle',
  'theme.backgroundAssetId',
  'settings.reducedMotion',
  'settings.minimalText',
  'settings.audio.sfx',
  'screens.title.heading',
  'screens.title.subheading',
  'screens.title.characterAssetId',
  'screens.completion.heading',
  'screens.completion.message',
] as const;
export const projectFieldSchema = z.enum(PROJECT_FIELDS);
export type ProjectField = z.infer<typeof projectFieldSchema>;

export type LearningImpact = 'none' | 'wording' | 'answers' | 'difficulty' | 'sequence';

interface FieldMeta {
  label: string;
  lock: keyof SceneLocks | null;
  impact: LearningImpact;
}

export const SCENE_FIELD_META: Record<SceneField, FieldMeta> = {
  title: { label: 'Scene title', lock: 'wording', impact: 'wording' },
  instruction: { label: 'Instruction', lock: 'wording', impact: 'wording' },
  supportText: { label: 'Support text', lock: 'wording', impact: 'wording' },
  'layout.instructionPosition': { label: 'Instruction position', lock: 'layout', impact: 'none' },
  'layout.density': { label: 'Layout density', lock: 'layout', impact: 'none' },
  'layout.showProgress': { label: 'Progress indicator', lock: 'layout', impact: 'none' },
  'feedback.success': { label: 'Success feedback', lock: 'wording', impact: 'wording' },
  'feedback.error': { label: 'Error feedback', lock: 'wording', impact: 'wording' },
  'feedback.hints': { label: 'Hints', lock: 'wording', impact: 'wording' },
  'assets.background': { label: 'Scene background', lock: 'assets', impact: 'none' },
  'assets.character': { label: 'Scene character', lock: 'assets', impact: 'none' },
  'assets.characterClip': { label: 'Character idle clip', lock: 'assets', impact: 'none' },
  'assets.panel': { label: 'Instruction panel artwork', lock: 'assets', impact: 'none' },
  'assets.button': { label: 'Button artwork', lock: 'assets', impact: 'none' },
  'interaction.display': { label: 'Grid and point visibility', lock: null, impact: 'none' },
  'interaction.showCoordinateReadout': { label: 'Coordinate readout', lock: null, impact: 'difficulty' },
  'interaction.showTargetMarker': { label: 'Target marker', lock: 'answer', impact: 'difficulty' },
  'interaction.moverLabel': { label: 'Mover label', lock: 'wording', impact: 'wording' },
  'interaction.landmarks': { label: 'Landmarks', lock: 'answer', impact: 'answers' },
  'interaction.grid': { label: 'Grid range', lock: 'answer', impact: 'answers' },
  'interaction.start': { label: 'Start position', lock: 'answer', impact: 'answers' },
  'interaction.rule': { label: 'Correct answer rule', lock: 'answer', impact: 'answers' },
  'interaction.items': { label: 'Items', lock: 'answer', impact: 'answers' },
  'interaction.targets': { label: 'Targets', lock: 'answer', impact: 'answers' },
  'interaction.trayPosition': { label: 'Item tray position', lock: 'layout', impact: 'none' },
  'interaction.orientation': { label: 'Sort orientation', lock: 'layout', impact: 'none' },
  'interaction.showValues': { label: 'Show values', lock: null, impact: 'difficulty' },
  'interaction.startLabel': { label: 'Start label', lock: 'wording', impact: 'wording' },
  'interaction.endLabel': { label: 'End label', lock: 'wording', impact: 'wording' },
  'interaction.points': { label: 'Concept points', lock: 'wording', impact: 'wording' },
  'interaction.illustration': { label: 'Illustration', lock: null, impact: 'none' },
  'interaction.continueLabel': { label: 'Continue label', lock: 'wording', impact: 'wording' },
};

export const PROJECT_FIELD_META: Record<ProjectField, FieldMeta & { assetIdentity?: boolean }> = {
  title: { label: 'Game title', lock: null, impact: 'none' },
  'theme.palette': { label: 'Color palette', lock: null, impact: 'none' },
  'theme.decor': { label: 'Background scenery', lock: null, impact: 'none' },
  'theme.fontStyle': { label: 'Font style', lock: null, impact: 'none' },
  'theme.backgroundAssetId': { label: 'Background image', lock: null, impact: 'none', assetIdentity: true },
  'settings.reducedMotion': { label: 'Reduced motion', lock: null, impact: 'none' },
  'settings.minimalText': { label: 'Minimal text', lock: null, impact: 'none' },
  'settings.audio.sfx': { label: 'Sound effects', lock: null, impact: 'none' },
  'screens.title.heading': { label: 'Title screen heading', lock: null, impact: 'none' },
  'screens.title.subheading': { label: 'Title screen subheading', lock: null, impact: 'none' },
  'screens.title.characterAssetId': { label: 'Title screen character', lock: null, impact: 'none', assetIdentity: true },
  'screens.completion.heading': { label: 'Completion heading', lock: null, impact: 'none' },
  'screens.completion.message': { label: 'Completion message', lock: null, impact: 'none' },
};

/** Layout of one screen as computed from the Source-to-Screen map (design, placed objects, artwork skins). */
export const screenLayoutSchema = z.object({
  design: sceneDesignSchema.nullable(),
  objects: z.array(objectPlacementSchema).max(20),
  /** Only the assets the map sets explicitly; undefined keeps the version's value. */
  character: z.string().max(64).nullable().optional(),
  characterClip: z.string().regex(/^[a-z][a-z0-9-]{0,23}$/).nullable().optional(),
  background: z.string().max(64).nullable().optional(),
  panel: z.string().max(64).nullable().optional(),
  button: z.string().max(64).nullable().optional(),
  /** Library assets the layout brings into the game (filled in by the server from the asset records). */
  addAssets: z.array(gameAssetSchema).max(40).default([]),
});
export type ScreenLayout = z.infer<typeof screenLayoutSchema>;

export const changeOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('set-scene-field'), sceneId: z.string(), field: sceneFieldSchema, value: z.unknown() }),
  z.object({ op: z.literal('set-project-field'), field: projectFieldSchema, value: z.unknown() }),
  z.object({ op: z.literal('move-scene'), sceneId: z.string(), toIndex: z.number().int().min(0).max(23) }),
  // Motion: data interpreted by the trusted runtime (never code).
  z.object({ op: z.literal('add-animation'), binding: animationBindingSchema, addAssets: z.array(gameAssetSchema).max(4).default([]) }),
  z.object({ op: z.literal('update-animation'), binding: animationBindingSchema, addAssets: z.array(gameAssetSchema).max(4).default([]) }),
  z.object({ op: z.literal('remove-animation'), id: z.string().max(40) }),
  z.object({ op: z.literal('set-motion-setting'), field: motionSettingField, value: z.unknown() }),
  /** Creator-only: Claude proposals never contain lock changes. */
  z.object({ op: z.literal('set-motion-lock'), screenId: screenIdSchema, locked: z.boolean() }),
  z.object({ op: z.literal('set-screen-layout'), screenId: screenIdSchema, layout: screenLayoutSchema }),
]);
export type ChangeOp = z.infer<typeof changeOpSchema>;

export const MOTION_OPS = ['add-animation', 'update-animation', 'remove-animation', 'set-motion-setting', 'set-motion-lock'] as const;
export const isMotionOp = (op: ChangeOp) => (MOTION_OPS as readonly string[]).includes(op.op);

export const changeScopeSchema = z.object({
  kind: z.enum(['project', 'scene']),
  sceneId: z.string().nullable(),
});
export type ChangeScope = z.infer<typeof changeScopeSchema>;

export type OpStatus = 'applied' | 'conflict' | 'out-of-scope' | 'invalid' | 'unchanged';

export interface OpResult {
  index: number;
  status: OpStatus;
  target: string;
  /** Human description of where the change lands, e.g. “Scene 2 · Taxi to Runway Alpha” or “Whole game”. */
  where?: string;
  label: string;
  before: unknown;
  after: unknown;
  impact: LearningImpact;
  message: string | null;
  /** Source slides behind the changed scene, so the creator can check the change against the deck. */
  sourceSlideIds: string[];
}

export interface ApplyResult {
  ok: boolean;
  config: GameConfig;
  results: OpResult[];
  /** Errors in the resulting config (nothing is stored when present). */
  validationErrors: string[];
  changed: boolean;
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function getAt(obj: unknown, path: string[]): unknown {
  let cur: unknown = obj;
  for (const key of path) {
    if (cur === null || typeof cur !== 'object' || !Object.prototype.hasOwnProperty.call(cur, key)) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function setAt(obj: unknown, path: string[], value: unknown): boolean {
  let cur: unknown = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i]!;
    if (cur === null || typeof cur !== 'object' || !Object.prototype.hasOwnProperty.call(cur, key)) return false;
    cur = (cur as Record<string, unknown>)[key];
  }
  const last = path[path.length - 1]!;
  if (cur === null || typeof cur !== 'object' || !Object.prototype.hasOwnProperty.call(cur, last)) return false;
  (cur as Record<string, unknown>)[last] = value;
  return true;
}

/** Deep equality that ignores object key order (arrays stay ordered). */
function stable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.keys(v as Record<string, unknown>)
        .sort()
        .map((k) => [k, stable((v as Record<string, unknown>)[k])]),
    );
  }
  return v;
}
const same = (a: unknown, b: unknown) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));

export interface ApplyOptions {
  scope: ChangeScope;
  /** When false, ops that violate a lock are reported as conflicts and skipped. */
  allowLockedChanges?: boolean;
}

/**
 * Apply ops to a copy of `base`. Never mutates `base`. Ops that are out of
 * scope, violate locks, or produce an invalid game are reported and skipped;
 * the returned config is validated as a whole before `ok` is true.
 */
export function applyChangeOps(base: GameConfig, ops: ChangeOp[], opts: ApplyOptions): ApplyResult {
  let config = clone(base);
  const results: OpResult[] = [];

  ops.forEach((op, index) => {
    if (op.op === 'set-scene-field') {
      const meta = SCENE_FIELD_META[op.field];
      const sceneIndex = config.scenes.findIndex((s) => s.id === op.sceneId);
      const scene = config.scenes[sceneIndex];
      const res: Omit<OpResult, 'status' | 'message'> = {
        index,
        target: `${op.sceneId} · ${op.field}`,
        where: scene ? `Scene ${sceneIndex + 1} · ${scene.title}` : 'Unknown scene',
        label: meta.label,
        before: null,
        after: op.value,
        impact: meta.impact,
        sourceSlideIds: scene?.sourceSlideIds ?? [],
      };
      if (!scene) return results.push({ ...res, status: 'invalid', message: `Scene ${op.sceneId} does not exist in this version.` });
      const path = op.field.split('.');
      const before = getAt(scene, path);
      if (before === undefined) {
        return results.push({ ...res, status: 'invalid', message: `${meta.label} does not apply to a ${scene.interaction.type} scene.` });
      }
      // The current value is shown even when the change is refused, so the creator sees what it would touch.
      res.before = clone(before);
      if (opts.scope.kind === 'scene' && opts.scope.sceneId !== op.sceneId) {
        return results.push({ ...res, status: 'out-of-scope', message: 'This change is outside the selected scene. Switch the scope to Whole project to allow it.' });
      }
      if (same(before, op.value)) return results.push({ ...res, status: 'unchanged', message: 'Already set to this value.' });
      const assetLocked = (op.field === 'assets.background' || op.field === 'assets.character') && config.settings.locks.assetIdentity;
      if (!opts.allowLockedChanges && ((meta.lock && scene.locks[meta.lock]) || assetLocked)) {
        return results.push({ ...res, status: 'conflict', message: `Locked: this scene's ${assetLocked ? 'asset identity' : meta.lock} lock prevents changing ${meta.label.toLowerCase()}.` });
      }
      const trial = clone(config);
      const trialScene = trial.scenes.find((s) => s.id === op.sceneId)!;
      setAt(trialScene, path, clone(op.value));
      const parsed = gameConfigSchema.safeParse(trial);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return results.push({ ...res, status: 'invalid', message: `Invalid value: ${issue ? `${issue.path.join('.')}: ${issue.message}` : 'schema check failed'}` });
      }
      const sceneAfter = parsed.data.scenes.find((s) => s.id === op.sceneId)!;
      const interactionIssues = checkInteraction(sceneAfter.interaction, { seed: parsed.data.settings.seed, sceneId: sceneAfter.id }).filter((i) => i.severity === 'error');
      if (interactionIssues.length > 0) {
        return results.push({ ...res, status: 'invalid', message: `Would make the scene unplayable: ${interactionIssues[0]!.message}` });
      }
      config = parsed.data;
      const answerFromSource = meta.impact === 'answers' && scene.sourceSlideIds.length > 0;
      return results.push({
        ...res,
        status: 'applied',
        message: answerFromSource ? 'Changes an answer or content derived from the source slides — check it against the deck.' : null,
      });
    }

    if (op.op === 'set-project-field') {
      const meta = PROJECT_FIELD_META[op.field];
      const result: Omit<OpResult, 'status' | 'message'> = {
        index,
        target: `project · ${op.field}`,
        where: 'Whole game',
        label: meta.label,
        before: null,
        after: op.value,
        impact: meta.impact,
        sourceSlideIds: [],
      };
      const path = op.field.split('.');
      const before = getAt(config, path);
      if (before === undefined) return results.push({ ...result, status: 'invalid', message: `${meta.label} is not available.` });
      result.before = clone(before);
      if (opts.scope.kind !== 'project') {
        return results.push({ ...result, status: 'out-of-scope', message: 'Project-wide change requested while a single scene is selected. Switch the scope to Whole project to allow it.' });
      }
      if (same(before, op.value)) return results.push({ ...result, status: 'unchanged', message: 'Already set to this value.' });
      if (!opts.allowLockedChanges && meta.assetIdentity && config.settings.locks.assetIdentity) {
        return results.push({ ...result, status: 'conflict', message: 'Locked: asset identity is locked for this project.' });
      }
      const trial = clone(config);
      setAt(trial, path, clone(op.value));
      const parsed = gameConfigSchema.safeParse(trial);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return results.push({ ...result, status: 'invalid', message: `Invalid value: ${issue ? `${issue.path.join('.')}: ${issue.message}` : 'schema check failed'}` });
      }
      config = parsed.data;
      return results.push({ ...result, status: 'applied', message: null });
    }

    if (op.op !== 'move-scene') {
      const r = applyMotionOrLayoutOp(config, op, index, opts);
      if (r.config) config = r.config;
      return results.push(r.result);
    }

    // move-scene
    const fromIndex = config.scenes.findIndex((s) => s.id === op.sceneId);
    const scene = config.scenes[fromIndex];
    const result: Omit<OpResult, 'status' | 'message'> = {
      index,
      target: `${op.sceneId} · position`,
      where: scene ? `Scene ${fromIndex + 1} · ${scene.title}` : 'Unknown scene',
      label: 'Scene order',
      before: fromIndex + 1,
      after: op.toIndex + 1,
      impact: 'sequence',
      sourceSlideIds: scene?.sourceSlideIds ?? [],
    };
    if (!scene) return results.push({ ...result, status: 'invalid', message: `Scene ${op.sceneId} does not exist.` });
    if (opts.scope.kind !== 'project') return results.push({ ...result, status: 'out-of-scope', message: 'Reordering scenes changes the whole project. Switch the scope to Whole project.' });
    if (op.toIndex >= config.scenes.length) return results.push({ ...result, status: 'invalid', message: 'Target position is outside the scene list.' });
    if (fromIndex === op.toIndex) return results.push({ ...result, status: 'unchanged', message: 'Scene is already there.' });
    const movedPast = config.scenes.slice(Math.min(fromIndex, op.toIndex), Math.max(fromIndex, op.toIndex) + 1);
    if (!opts.allowLockedChanges && (config.settings.locks.sequence || movedPast.some((s) => s.locks.sequence))) {
      return results.push({ ...result, status: 'conflict', message: 'Locked: the learning sequence is locked to the source order.' });
    }
    const scenes = config.scenes.slice();
    scenes.splice(fromIndex, 1);
    scenes.splice(op.toIndex, 0, scene);
    config = { ...config, scenes: scenes.map((s, i) => ({ ...s, next: scenes[i + 1]?.id ?? null })) };
    return results.push({ ...result, status: 'applied', message: null });
  });

  const final = gameConfigSchema.safeParse(config);
  const validationErrors = final.success ? [] : final.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
  const changed = results.some((r) => r.status === 'applied');
  return { ok: final.success && changed, config: final.success ? final.data : base, results, validationErrors, changed };
}

type ScreenOp = Exclude<ChangeOp, { op: 'set-scene-field' } | { op: 'set-project-field' } | { op: 'move-scene' }>;

function screenLabel(config: GameConfig, screenId: string): string {
  return listScreens(config).find((s) => s.id === screenId)?.label ?? `Unknown screen ${screenId}`;
}

/** Add library assets an op needs; assets already packaged are kept as they are. */
function mergeAssets(config: GameConfig, add: GameAsset[]): void {
  for (const a of add) if (!Object.prototype.hasOwnProperty.call(config.assets, a.id)) config.assets[a.id] = clone(a);
}

function motionLocked(config: GameConfig, screenId: string): boolean {
  return config.motion.lockedScreens.includes(screenId);
}

function validated(trial: GameConfig): { ok: true; config: GameConfig } | { ok: false; message: string } {
  const parsed = gameConfigSchema.safeParse(trial);
  if (parsed.success) return { ok: true, config: parsed.data };
  const issue = parsed.error.issues[0];
  return { ok: false, message: issue ? `${issue.path.join('.')}: ${issue.message}` : 'schema check failed' };
}

/**
 * Motion and layout ops. Same rules as field edits: scope first, then locks,
 * then a whole-config validation (which includes motion validation), so a
 * refused op never leaves a partial change behind.
 */
function applyMotionOrLayoutOp(config: GameConfig, op: ScreenOp, index: number, opts: ApplyOptions): { config: GameConfig | null; result: OpResult } {
  const result = (status: OpStatus, message: string | null, extra: Partial<OpResult>): { config: null; result: OpResult } => ({
    config: null,
    result: { index, status, message, target: '', label: '', before: null, after: null, impact: 'none', sourceSlideIds: [], ...extra },
  });
  const slidesOf = (screenId: string) => config.scenes.find((s) => s.id === screenId)?.sourceSlideIds ?? [];
  const inScope = (screenId: string | null) => opts.scope.kind === 'project' || (screenId !== null && opts.scope.sceneId === screenId);

  if (op.op === 'set-motion-setting') {
    const label = MOTION_SETTING_LABELS[op.field];
    const base = { target: `motion · ${op.field}`, where: 'Whole game', label, before: config.motion[op.field], after: op.value };
    if (opts.scope.kind !== 'project') return result('out-of-scope', 'Motion settings apply to the whole game. Switch the scope to Whole project.', base);
    if (same(config.motion[op.field], op.value)) return result('unchanged', 'Already set to this value.', base);
    const trial = clone(config);
    (trial.motion as Record<string, unknown>)[op.field] = clone(op.value);
    const v = validated(trial);
    if (!v.ok) return result('invalid', `Invalid value: ${v.message}`, base);
    return { config: v.config, result: { index, status: 'applied', message: null, impact: 'none', sourceSlideIds: [], ...base } };
  }

  const screenId = op.op === 'add-animation' || op.op === 'update-animation' ? op.binding.screenId : op.op === 'remove-animation' ? (config.motion.bindings.find((b) => b.id === op.id)?.screenId ?? null) : op.screenId;
  const where = screenId ? screenLabel(config, screenId) : 'Unknown screen';

  if (op.op === 'set-motion-lock') {
    const base = { target: `${op.screenId} · motion lock`, where, label: 'Motion lock', before: motionLocked(config, op.screenId), after: op.locked, sourceSlideIds: slidesOf(op.screenId) };
    if (!listScreens(config).some((s) => s.id === op.screenId)) return result('invalid', `Screen ${op.screenId} does not exist in this version.`, base);
    if (!inScope(op.screenId)) return result('out-of-scope', 'This lock is on another screen. Switch the scope to Whole project to allow it.', base);
    if (motionLocked(config, op.screenId) === op.locked) return result('unchanged', 'Already set.', base);
    const trial = clone(config);
    trial.motion.lockedScreens = op.locked ? [...trial.motion.lockedScreens, op.screenId] : trial.motion.lockedScreens.filter((id) => id !== op.screenId);
    const v = validated(trial);
    if (!v.ok) return result('invalid', `Invalid value: ${v.message}`, base);
    return { config: v.config, result: { index, status: 'applied', message: null, impact: 'none', ...base } };
  }

  if (op.op === 'add-animation' || op.op === 'update-animation' || op.op === 'remove-animation') {
    const id = op.op === 'remove-animation' ? op.id : op.binding.id;
    const existing = config.motion.bindings.find((b) => b.id === id) ?? null;
    const base = {
      target: `${screenId ?? '?'} · animation ${id}`,
      where,
      label: op.op === 'add-animation' ? 'New animation' : op.op === 'update-animation' ? 'Animation' : 'Remove animation',
      before: existing ? clone(existing) : null,
      after: op.op === 'remove-animation' ? null : op.binding,
      sourceSlideIds: screenId ? slidesOf(screenId) : [],
    };
    if (op.op === 'add-animation' && existing) return result('invalid', `An animation with id ${id} already exists.`, base);
    if (op.op !== 'add-animation' && !existing) return result('invalid', `Animation ${id} does not exist in this version.`, base);
    if (op.op === 'update-animation' && existing && existing.screenId !== op.binding.screenId) return result('invalid', 'An animation cannot move to another screen; remove it and add a new one.', base);
    if (!screenId || !listScreens(config).some((s) => s.id === screenId)) return result('invalid', `Screen ${screenId ?? '?'} does not exist in this version.`, base);
    if (!inScope(screenId)) return result('out-of-scope', 'This animation is on another screen. Switch the scope to Whole project to allow it.', base);
    if (op.op === 'update-animation' && existing && same(existing, op.binding)) return result('unchanged', 'Already set to this value.', base);
    if (!opts.allowLockedChanges && motionLocked(config, screenId)) return result('conflict', `Locked: motion on ${where} is locked.`, base);
    if (op.op === 'remove-animation' && config.motion.bindings.some((b) => b.after === id)) {
      return result('invalid', `Another animation waits for this one; remove or re-sequence it first.`, base);
    }
    const trial = clone(config);
    if (op.op !== 'remove-animation') mergeAssets(trial, op.addAssets ?? []);
    if (op.op === 'add-animation') trial.motion.bindings.push(clone(op.binding));
    else if (op.op === 'update-animation') trial.motion.bindings = trial.motion.bindings.map((b) => (b.id === id ? clone(op.binding) : b));
    else trial.motion.bindings = trial.motion.bindings.filter((b) => b.id !== id);
    const v = validated(trial);
    if (!v.ok) return result('invalid', `Not valid: ${v.message.replace(/^motion\.bindings: /, '')}`, base);
    return { config: v.config, result: { index, status: 'applied', message: null, impact: 'none', ...base } };
  }

  // set-screen-layout
  const target = op.screenId === 'title' ? config.screens.title : op.screenId === 'completion' ? config.screens.completion : config.scenes.find((s) => s.id === op.screenId);
  const before = target
    ? {
        design: target.design,
        objects: target.objects,
        ...('assets' in target ? { character: target.assets.character, characterClip: target.assets.characterClip, background: target.assets.background, panel: target.assets.panel, button: target.assets.button } : { character: target.characterAssetId, characterClip: target.characterClip }),
      }
    : null;
  const base = { target: `${op.screenId} · layout`, where, label: 'Screen layout', before: before ? clone(before) : null, after: op.layout, sourceSlideIds: slidesOf(op.screenId) };
  if (!target) return result('invalid', `Screen ${op.screenId} does not exist in this version.`, base);
  if (!inScope(op.screenId)) return result('out-of-scope', 'This layout is for another screen. Switch the scope to Whole project to allow it.', base);
  const l = op.layout;
  const layoutChanges = !same(target.design, l.design) || !same(target.objects, l.objects);
  const sceneTarget = 'assets' in target ? target : null;
  const assetChanges = sceneTarget
    ? (['character', 'characterClip', 'background', 'panel', 'button'] as const).some((k) => l[k] !== undefined && !same(sceneTarget.assets[k], l[k]))
    : (l.character !== undefined && l.character !== (target as GameConfig['screens']['title']).characterAssetId) || (l.characterClip !== undefined && l.characterClip !== (target as GameConfig['screens']['title']).characterClip);
  if (!layoutChanges && !assetChanges) return result('unchanged', 'The game already uses this layout.', base);
  if (!opts.allowLockedChanges) {
    if (sceneTarget && layoutChanges && sceneTarget.locks.layout) return result('conflict', `Locked: ${where} has its layout locked.`, base);
    const characterChange = l.character !== undefined && (sceneTarget ? sceneTarget.assets.character !== l.character : (target as GameConfig['screens']['title']).characterAssetId !== l.character);
    if (assetChanges && ((sceneTarget && sceneTarget.locks.assets) || (characterChange && config.settings.locks.assetIdentity))) {
      return result('conflict', `Locked: ${where} has its artwork locked.`, base);
    }
  }
  const trial = clone(config);
  mergeAssets(trial, l.addAssets ?? []);
  const t = op.screenId === 'title' ? trial.screens.title : op.screenId === 'completion' ? trial.screens.completion : trial.scenes.find((s) => s.id === op.screenId)!;
  t.design = clone(l.design);
  t.objects = clone(l.objects);
  if ('assets' in t) {
    for (const k of ['character', 'characterClip', 'background', 'panel', 'button'] as const) if (l[k] !== undefined) t.assets[k] = l[k] ?? null;
  } else {
    if (l.character !== undefined) t.characterAssetId = l.character ?? null;
    if (l.characterClip !== undefined) t.characterClip = l.characterClip ?? null;
  }
  const v = validated(trial);
  if (!v.ok) return result('invalid', `Invalid layout: ${v.message}`, base);
  return { config: v.config, result: { index, status: 'applied', message: null, impact: 'none', ...base } };
}

/** Human summary of what a value is, for before/after tables. */
const humanKey = (k: string) => k.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
const isPrimitive = (v: unknown) => v === null || ['string', 'number', 'boolean'].includes(typeof v);

/** Short human-readable value for before/after displays (never executed, only shown). */
export function summarizeValue(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'string') return v.length > 140 ? `${v.slice(0, 137)}…` : v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  let text: string;
  if (Array.isArray(v) && v.every(isPrimitive)) text = v.map((x) => summarizeValue(x)).join(', ');
  else if (typeof v === 'object' && !Array.isArray(v) && Object.values(v).every(isPrimitive) && Object.keys(v).length <= 8) {
    text = Object.entries(v as Record<string, unknown>)
      .map(([k, x]) => `${humanKey(k)}: ${summarizeValue(x)}`)
      .join(' · ');
  } else text = JSON.stringify(v);
  return text.length > 160 ? `${text.slice(0, 157)}…` : text;
}

export const proposalStatusSchema = z.enum(['proposed', 'applied', 'rejected', 'stale', 'failed', 'undone']);
export type ProposalStatus = z.infer<typeof proposalStatusSchema>;
