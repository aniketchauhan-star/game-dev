import { z } from 'zod';
import { hexColor, learningPattern, requiredText, shortText } from './common.ts';
import { buildableInteractionSchema } from './interaction.ts';
import { sceneLocksSchema } from './blueprint.ts';
import { objectPlacementSchema, sceneDesignSchema } from './design.ts';
import { DEFAULT_MOTION_CONFIG, motionConfigSchema } from './motion.ts';
import { validateBindings } from '../motion/validate.ts';

/**
 * GameConfig — the only thing the trusted runtime executes. It is plain data,
 * versioned with `schemaVersion`, validated on the server before it is stored,
 * again in the runtime before it is played, and in exported games.
 */

export const GAME_CONFIG_SCHEMA_VERSION = 1 as const;

export const paletteSchema = z.object({
  background: hexColor,
  backgroundAlt: hexColor,
  surface: hexColor,
  surfaceText: hexColor,
  text: hexColor,
  mutedText: hexColor,
  primary: hexColor,
  primaryText: hexColor,
  accent: hexColor,
  gridLine: hexColor,
  gridAxis: hexColor,
  success: hexColor,
  error: hexColor,
  focus: hexColor,
});
export type Palette = z.infer<typeof paletteSchema>;

export const decorSchema = z.enum(['ice', 'airport', 'space', 'city', 'none']);
export type Decor = z.infer<typeof decorSchema>;

/** A named range of frames in a sprite sheet, configured in the sprite-sheet editor. */
export const spriteClipSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]{0,23}$/),
  from: z.number().int().min(0).max(511),
  to: z.number().int().min(0).max(511),
  fps: z.number().min(1).max(60).nullable(),
  loop: z.boolean(),
});
export type SpriteClip = z.infer<typeof spriteClipSchema>;

export const spriteSchema = z.object({
  frameWidth: z.number().int().min(1).max(4096),
  frameHeight: z.number().int().min(1).max(4096),
  columns: z.number().int().min(1).max(64),
  rows: z.number().int().min(1).max(64),
  spacing: z.number().int().min(0).max(256),
  frameCount: z.number().int().min(1).max(512),
  fps: z.number().min(1).max(60),
  anchorX: z.number().min(0).max(1),
  anchorY: z.number().min(0).max(1),
  clips: z.array(spriteClipSchema).max(16).default([]),
});
export type SpriteSheet = z.infer<typeof spriteSchema>;

export const placementSchema = z.object({
  scale: z.number().min(0.1).max(4),
  rotation: z.number().min(-180).max(180),
  anchorX: z.number().min(0).max(1),
  anchorY: z.number().min(0).max(1),
  crop: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), w: z.number().min(0.01).max(1), h: z.number().min(0.01).max(1) }).nullable(),
});
export type Placement = z.infer<typeof placementSchema>;

export const DEFAULT_PLACEMENT: Placement = { scale: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5, crop: null };

/** Relative path inside an exported game. Never absolute, never `..`. */
export const safeRelativePath = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/, 'Unsafe path characters')
  .refine((p) => !p.split('/').some((seg) => seg === '..' || seg === '.' || seg === ''), 'Path must not contain empty, . or .. segments');

export const gameAssetSchema = z.object({
  id: z.string(),
  kind: z.enum(['image', 'audio']),
  file: safeRelativePath,
  mime: z.enum(['image/png', 'image/jpeg', 'image/webp', 'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/mp4']),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  alt: shortText(160),
  sprite: spriteSchema.nullable(),
  placement: placementSchema,
});
export type GameAsset = z.infer<typeof gameAssetSchema>;

export const gameSceneSchema = z.object({
  id: z.string().min(1).max(40),
  title: requiredText(60),
  pattern: learningPattern,
  sourceSlideIds: z.array(z.string()).max(40),
  addedPractice: z.boolean(),
  instruction: requiredText(220),
  supportText: shortText(200).nullable(),
  layout: z.object({
    instructionPosition: z.enum(['top', 'left', 'bottom']),
    density: z.enum(['comfortable', 'compact']),
    showProgress: z.boolean(),
  }),
  interaction: buildableInteractionSchema,
  feedback: z.object({
    success: requiredText(160),
    error: requiredText(200),
    hints: z.array(requiredText(160)).min(1).max(3),
  }),
  assets: z.object({
    background: z.string().nullable(),
    character: z.string().nullable(),
    /** Idle clip shown for a sprite character. */
    characterClip: z.string().regex(/^[a-z][a-z0-9-]{0,23}$/).nullable().default(null),
    /** Exact artwork for the instruction panel and primary buttons (text stays native and readable). */
    panel: z.string().nullable().default(null),
    button: z.string().nullable().default(null),
  }),
  /** Design layout from an imported frame or exported screen (null = built-in layout). */
  design: sceneDesignSchema.nullable().default(null),
  /** Creator-placed artwork. */
  objects: z.array(objectPlacementSchema).max(20).default([]),
  next: z.string().nullable(),
  locks: sceneLocksSchema,
});
export type GameScene = z.infer<typeof gameSceneSchema>;

export const gameConfigSchema = z
  .object({
    schemaVersion: z.literal(GAME_CONFIG_SCHEMA_VERSION),
    kind: z.literal('nexus-game'),
    id: z.string(),
    title: requiredText(80),
    language: z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/),
    meta: z.object({
      projectId: z.string(),
      versionNumber: z.number().int().min(0),
      blueprintRevisionId: z.string().nullable(),
      blueprintRevisionNumber: z.number().int().nullable(),
      builtAt: z.string(),
      origin: z.enum(['build', 'refinement', 'manual-edit', 'restore', 'undo', 'sample', 'branch']),
      demo: z.boolean(),
      runtimeVersion: z.string(),
      /** Grade version (branch) and the inputs this build used. */
      branchId: z.string().nullable().default(null),
      gradeLabel: z.string().max(60).default(''),
      gradeProfileRevision: z.number().int().nullable().default(null),
      screenMapNumber: z.number().int().nullable().default(null),
    }),
    stage: z.object({ width: z.literal(1920), height: z.literal(1080) }),
    theme: z.object({
      presetId: z.string().max(40),
      paletteId: z.string().max(40),
      palette: paletteSchema,
      decor: decorSchema,
      backgroundAssetId: z.string().nullable(),
      fontStyle: z.enum(['rounded', 'clean']),
    }),
    settings: z.object({
      minimalText: z.boolean(),
      reducedMotion: z.boolean(),
      seed: z.number().int().min(0).max(2 ** 31 - 1),
      audio: z.object({ sfx: z.boolean(), musicAssetId: z.string().nullable() }),
      /** Project-wide locks: keep the source-derived scene order; keep assigned asset identities. */
      locks: z.object({ sequence: z.boolean(), assetIdentity: z.boolean() }),
      /**
       * Guidance level from the grade profile: when the runtime offers the next hint
       * (minimal: only on request; standard: after two unsuccessful checks; extra: after one).
       */
      guidance: z.enum(['minimal', 'standard', 'extra']).default('standard'),
    }),
    screens: z.object({
      title: z.object({
        heading: requiredText(80),
        subheading: shortText(160),
        startLabel: requiredText(24),
        characterAssetId: z.string().nullable(),
        characterClip: z.string().regex(/^[a-z][a-z0-9-]{0,23}$/).nullable().default(null),
        design: sceneDesignSchema.nullable().default(null),
        objects: z.array(objectPlacementSchema).max(20).default([]),
      }),
      completion: z.object({
        heading: requiredText(80),
        message: shortText(240),
        replayLabel: requiredText(24),
        characterAssetId: z.string().nullable().default(null),
        characterClip: z.string().regex(/^[a-z][a-z0-9-]{0,23}$/).nullable().default(null),
        design: sceneDesignSchema.nullable().default(null),
        objects: z.array(objectPlacementSchema).max(20).default([]),
      }),
    }),
    assets: z.record(z.string(), gameAssetSchema),
    scenes: z.array(gameSceneSchema).min(1).max(24),
    /** Approved motion: settings plus animation bindings, interpreted by the trusted runtime. */
    motion: motionConfigSchema.default(DEFAULT_MOTION_CONFIG),
  })
  .superRefine((cfg, ctx) => {
    const ids = new Set<string>();
    cfg.scenes.forEach((s, i) => {
      if (ids.has(s.id)) ctx.addIssue({ code: 'custom', path: ['scenes', i, 'id'], message: `Duplicate scene id ${s.id}` });
      ids.add(s.id);
    });
    const known = (id: string) => Object.hasOwn(cfg.assets, id);
    cfg.scenes.forEach((s, i) => {
      if (s.next !== null && !ids.has(s.next)) ctx.addIssue({ code: 'custom', path: ['scenes', i, 'next'], message: `Unknown next scene ${s.next}` });
      for (const key of ['background', 'character'] as const) {
        const a = s.assets[key];
        if (a !== null && !known(a)) ctx.addIssue({ code: 'custom', path: ['scenes', i, 'assets', key], message: `Unknown asset ${a}` });
      }
      // Card images must point at packaged assets too.
      const it = s.interaction;
      const cards = it.type === 'drag-match' ? [...it.items, ...it.targets] : it.type === 'sequence-sort' ? it.items : [];
      for (const card of cards) {
        if (card.imageAssetId !== null && !known(card.imageAssetId)) ctx.addIssue({ code: 'custom', path: ['scenes', i, 'interaction'], message: `Card “${card.label}” uses unknown asset ${card.imageAssetId}` });
      }
    });
    for (const [key, asset] of Object.entries(cfg.assets)) {
      if (asset.id !== key) ctx.addIssue({ code: 'custom', path: ['assets', key], message: 'Asset key must equal asset id' });
    }
    const refs: Array<[string | null, string]> = [
      [cfg.theme.backgroundAssetId, 'theme.backgroundAssetId'],
      [cfg.screens.title.characterAssetId, 'screens.title.characterAssetId'],
      [cfg.screens.completion.characterAssetId, 'screens.completion.characterAssetId'],
      [cfg.settings.audio.musicAssetId, 'settings.audio.musicAssetId'],
    ];
    cfg.scenes.forEach((s, i) => {
      refs.push([s.assets.panel, `scenes.${i}.assets.panel`], [s.assets.button, `scenes.${i}.assets.button`]);
    });
    const screens: Array<[string, { design: z.infer<typeof sceneDesignSchema> | null; objects: Array<z.infer<typeof objectPlacementSchema>> }]> = [
      ['screens.title', cfg.screens.title],
      ['screens.completion', cfg.screens.completion],
      ...cfg.scenes.map((s, i) => [`scenes.${i}`, s] as [string, { design: z.infer<typeof sceneDesignSchema> | null; objects: Array<z.infer<typeof objectPlacementSchema>> }]),
    ];
    for (const [path, sc] of screens) {
      if (sc.design) {
        refs.push([sc.design.backgroundAssetId, `${path}.design.backgroundAssetId`]);
        sc.design.layers.forEach((l, k) => refs.push([l.assetId, `${path}.design.layers.${k}.assetId`]));
        const layerIds = new Set<string>();
        for (const l of sc.design.layers) {
          if (layerIds.has(l.id)) ctx.addIssue({ code: 'custom', path: path.split('.'), message: `Duplicate design layer id ${l.id}` });
          layerIds.add(l.id);
          if (l.kind === 'image' && !l.assetId) ctx.addIssue({ code: 'custom', path: path.split('.'), message: `Image layer ${l.id} has no image` });
          if (l.kind === 'text' && !l.text) ctx.addIssue({ code: 'custom', path: path.split('.'), message: `Text layer ${l.id} has no text` });
        }
      }
      const objectIds = new Set<string>();
      sc.objects.forEach((o, k) => {
        if (objectIds.has(o.id)) ctx.addIssue({ code: 'custom', path: path.split('.'), message: `Duplicate object id ${o.id}` });
        objectIds.add(o.id);
        refs.push([o.assetId, `${path}.objects.${k}.assetId`]);
      });
    }
    for (const [ref, path] of refs) {
      if (ref !== null && !known(ref)) ctx.addIssue({ code: 'custom', path: path.split('.'), message: `Unknown asset ${ref}` });
    }
    for (const [key, asset] of Object.entries(cfg.assets)) {
      for (const clip of asset.sprite?.clips ?? []) {
        if (clip.to < clip.from || clip.to >= asset.sprite!.frameCount) ctx.addIssue({ code: 'custom', path: ['assets', key, 'sprite'], message: `Clip “${clip.name}” uses frames outside the sheet` });
      }
    }
    // Motion: targets, presets, capabilities, parameters, cycles and budgets.
    for (const issue of validateBindings(cfg as GameConfig)) {
      if (issue.severity === 'error') ctx.addIssue({ code: 'custom', path: ['motion', 'bindings'], message: issue.message });
    }
  });
export type GameConfig = z.infer<typeof gameConfigSchema>;

export const RUNTIME_VERSION = '1.0.0';
