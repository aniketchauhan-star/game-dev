import { z } from 'zod';
import { shortText } from './common.ts';
import { fitMode, objectPlacementSchema } from './design.ts';

/**
 * Source-to-Screen Map: which sources feed each game screen. Several slides can
 * feed one scene and several Figma states can belong to one scene; equal counts
 * or matching numbers never imply a correspondence — every link is explicit and
 * reviewed. PowerPoint supplies lesson content, Figma supplies layout and style,
 * and assigned uploads supply exact artwork unless the creator changes a role.
 */

export const screenKind = z.enum(['title', 'scene', 'completion']);

export const sourceRolesSchema = z.object({
  /** Who supplies learner-facing lesson text (instructions, labels, definitions). */
  content: z.enum(['ppt', 'figma', 'creator']),
  /** Who supplies composition: the Figma frame, or the built-in template layout. */
  layout: z.enum(['figma', 'template']),
  /** Who supplies exact artwork: assigned uploads, Figma renders, or built-in art. */
  artwork: z.enum(['uploads', 'figma', 'built-in']),
});
export type SourceRoles = z.infer<typeof sourceRolesSchema>;

export const ROLE_LABELS = {
  content: { ppt: 'PowerPoint lesson', figma: 'Figma text', creator: 'My wording' },
  layout: { figma: 'Figma layout', template: 'Built-in layout' },
  artwork: { uploads: 'My uploads', figma: 'Figma artwork', 'built-in': 'Built-in art' },
} as const;

export const screenFrameLinkSchema = z.object({
  frameId: z.string().max(64),
  /** State name within the scene, e.g. "default", "correct", "hint". */
  state: z.string().trim().min(1).max(40),
  primary: z.boolean(),
});

/** What to do with one element of the primary frame. */
export const layerUse = z.enum(['layer', 'background', 'instruction-region', 'play-region', 'reference', 'ignore']);
export type LayerUse = z.infer<typeof layerUse>;

export const layerChoiceSchema = z.object({
  elementId: z.string().max(120),
  use: layerUse,
});

export const conflictKind = z.enum(['instruction', 'label', 'definition', 'answer-rule', 'number', 'other']);

export const conflictSchema = z.object({
  id: z.string().regex(/^cf-[a-z0-9-]{1,40}$/),
  kind: conflictKind,
  pptText: z.string().max(800),
  pptSlideIds: z.array(z.string().max(40)).max(6),
  figmaText: z.string().max(800),
  figmaFrameId: z.string().max(64).nullable(),
  figmaElementId: z.string().max(120).nullable(),
  message: z.string().trim().min(1).max(400),
  detectedBy: z.enum(['rule', 'claude']),
  status: z.enum(['open', 'resolved']),
  resolution: z
    .object({
      /** Which wording the game uses. Neither source is ever edited. */
      choice: z.enum(['ppt', 'figma', 'custom', 'not-a-conflict']),
      text: z.string().max(800).nullable(),
      note: z.string().max(300),
      at: z.string(),
    })
    .nullable(),
});
export type SourceConflict = z.infer<typeof conflictSchema>;

/** An explicit creator correction of learner-facing text: reviewed and versioned with the map. */
export const correctionSchema = z.object({
  id: z.string().regex(/^cr-[a-z0-9-]{1,40}$/),
  field: z.enum(['title', 'instruction', 'label']),
  elementId: z.string().max(120).nullable(),
  before: z.string().max(800),
  after: z.string().trim().min(1).max(800),
  reason: z.string().max(300),
  reviewed: z.boolean(),
  at: z.string(),
});
export type Correction = z.infer<typeof correctionSchema>;

export const screenBackgroundSchema = z.object({
  /** none: the theme / blueprint background; asset: an assigned upload; frame-render: the whole design picture; frame-element: one image layer. */
  kind: z.enum(['none', 'asset', 'frame-render', 'frame-element']),
  assetId: z.string().max(64).nullable(),
  frameId: z.string().max(64).nullable(),
  elementId: z.string().max(120).nullable(),
  /** The creator confirmed a whole-design picture has no baked text or buttons (otherwise they would show twice). */
  confirmedClean: z.boolean().default(false),
});

export const screenMapEntrySchema = z.object({
  screenId: z.string().regex(/^(title|completion|[A-Za-z0-9_-]{1,40})$/),
  kind: screenKind,
  title: z.string().trim().min(1).max(80),
  slideIds: z.array(z.string().max(40)).max(20),
  frames: z.array(screenFrameLinkSchema).max(8),
  roles: sourceRolesSchema,
  designMode: z.enum(['match', 'adapt']),
  fit: fitMode,
  background: screenBackgroundSchema,
  layers: z.array(layerChoiceSchema).max(300),
  assets: z.object({
    character: z.string().max(64).nullable(),
    characterClip: z.string().regex(/^[a-z][a-z0-9-]{0,23}$/).nullable(),
    panel: z.string().max(64).nullable(),
    button: z.string().max(64).nullable(),
  }),
  objects: z.array(objectPlacementSchema).max(20),
  conflicts: z.array(conflictSchema).max(40),
  corrections: z.array(correctionSchema).max(40),
  /** The creator confirmed this row (links, roles and assets). */
  reviewed: z.boolean(),
  notes: shortText(400),
});
export type ScreenMapEntry = z.infer<typeof screenMapEntrySchema>;

export const sourceScreenMappingSchema = z.object({
  screens: z.array(screenMapEntrySchema).max(26),
});
export type SourceScreenMapping = z.infer<typeof sourceScreenMappingSchema>;

export const screenMapRecordSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  branchId: z.string(),
  number: z.number().int(),
  blueprintRevisionId: z.string().nullable(),
  origin: z.enum(['creator', 'suggested', 'claude', 'demo', 'branch']),
  note: z.string(),
  mapping: sourceScreenMappingSchema,
  createdAt: z.string(),
});
export type ScreenMapRecord = z.infer<typeof screenMapRecordSchema>;

export const DEFAULT_ROLES: SourceRoles = { content: 'ppt', layout: 'template', artwork: 'uploads' };

export function emptyScreen(screenId: string, kind: z.infer<typeof screenKind>, title: string, slideIds: string[] = []): ScreenMapEntry {
  return {
    screenId,
    kind,
    title,
    slideIds,
    frames: [],
    roles: { ...DEFAULT_ROLES },
    designMode: 'match',
    fit: 'contain',
    background: { kind: 'none', assetId: null, frameId: null, elementId: null, confirmedClean: false },
    layers: [],
    assets: { character: null, characterClip: null, panel: null, button: null },
    objects: [],
    conflicts: [],
    corrections: [],
    reviewed: false,
    notes: '',
  };
}
