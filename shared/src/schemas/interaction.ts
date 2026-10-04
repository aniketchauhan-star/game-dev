import { z } from 'zod';
import { localId, requiredText, shortText } from './common.ts';

/**
 * Interaction and answer-rule schemas shared by blueprints, game configs, the
 * runtime and the server. Rules are data from an allowlist — never formulas or
 * code — and are evaluated by trusted functions in `shared/src/rules.ts`.
 */

export const pointSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
});
export type Point = z.infer<typeof pointSchema>;

export const gridSchema = z
  .object({
    xMin: z.number().int().min(-20).max(0),
    xMax: z.number().int().min(0).max(20),
    yMin: z.number().int().min(-20).max(0),
    yMax: z.number().int().min(0).max(20),
    step: z.union([z.literal(1), z.literal(2), z.literal(5)]),
  })
  .superRefine((g, ctx) => {
    if (g.xMax - g.xMin < 2) ctx.addIssue({ code: 'custom', message: 'Grid needs at least 2 units across', path: ['xMax'] });
    if (g.yMax - g.yMin < 2) ctx.addIssue({ code: 'custom', message: 'Grid needs at least 2 units tall', path: ['yMax'] });
    if ((g.xMax - g.xMin) / g.step > 24 || (g.yMax - g.yMin) / g.step > 24)
      ctx.addIssue({ code: 'custom', message: 'Grid has too many lines to stay readable (max 24 per axis)', path: ['step'] });
    for (const k of ['xMin', 'xMax', 'yMin', 'yMax'] as const) {
      if (g[k] % g.step !== 0) ctx.addIssue({ code: 'custom', message: `${k} must be a multiple of the step`, path: [k] });
    }
  });
export type Grid = z.infer<typeof gridSchema>;

export const coordinateRuleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('point-equals'), target: pointSchema }),
  z.object({ kind: z.literal('point-in-set'), targets: z.array(pointSchema).min(1).max(12) }),
  z.object({ kind: z.literal('in-quadrant'), quadrant: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]) }),
  z.object({ kind: z.literal('on-axis'), axis: z.enum(['x', 'y']) }),
]);
export type CoordinateRule = z.infer<typeof coordinateRuleSchema>;

export const landmarkIcon = z.enum(['runway', 'tower', 'gate', 'beacon', 'star', 'flag', 'home', 'none']);

export const landmarkSchema = z.object({
  id: localId,
  label: requiredText(24),
  point: pointSchema,
  icon: landmarkIcon,
});

export const coordinateDisplaySchema = z.object({
  gridEmphasis: z.enum(['standard', 'high']),
  pointSize: z.enum(['standard', 'large']),
  labelSize: z.enum(['standard', 'large']),
});

export const coordinateInteractionSchema = z.object({
  type: z.literal('coordinate-navigation'),
  grid: gridSchema,
  start: pointSchema,
  rule: coordinateRuleSchema,
  showTargetMarker: z.boolean(),
  showCoordinateReadout: z.boolean(),
  moverLabel: shortText(24),
  landmarks: z.array(landmarkSchema).max(8),
  display: coordinateDisplaySchema,
});
export type CoordinateInteraction = z.infer<typeof coordinateInteractionSchema>;

export const cardSchema = z.object({
  id: localId,
  label: requiredText(60),
  imageAssetId: z.string().nullable(),
});

export const matchTargetSchema = cardSchema.extend({
  capacity: z.number().int().min(1).max(12),
});

export const matchRuleSchema = z.object({
  kind: z.literal('match-sets'),
  /** For each item, the targets that accept it. An empty list marks a distractor that must stay unplaced. */
  accepts: z.array(z.object({ itemId: localId, targetIds: z.array(localId).max(8) })).min(1).max(16),
});
export type MatchRule = z.infer<typeof matchRuleSchema>;

export const matchInteractionSchema = z.object({
  type: z.literal('drag-match'),
  items: z.array(cardSchema).min(2).max(12),
  targets: z.array(matchTargetSchema).min(1).max(8),
  rule: matchRuleSchema,
  trayPosition: z.enum(['left', 'bottom']),
});
export type MatchInteraction = z.infer<typeof matchInteractionSchema>;

export const sortItemSchema = cardSchema.extend({
  value: z.number().finite().nullable(),
});

export const sequenceRuleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('order-by-value'), direction: z.enum(['ascending', 'descending']) }),
  z.object({
    kind: z.literal('explicit-order'),
    order: z.array(localId).min(2).max(10),
    /** Groups of items that may appear in any order relative to each other. */
    interchangeable: z.array(z.array(localId).min(2)).max(5),
  }),
]);
export type SequenceRule = z.infer<typeof sequenceRuleSchema>;

export const sortInteractionSchema = z.object({
  type: z.literal('sequence-sort'),
  items: z.array(sortItemSchema).min(3).max(10),
  rule: sequenceRuleSchema,
  orientation: z.enum(['horizontal', 'vertical']),
  showValues: z.boolean(),
  startLabel: shortText(24),
  endLabel: shortText(24),
});
export type SortInteraction = z.infer<typeof sortInteractionSchema>;

export const infoInteractionSchema = z.object({
  type: z.literal('info'),
  points: z.array(requiredText(140)).min(1).max(4),
  illustration: z.enum(['grid', 'quadrants', 'none']),
  continueLabel: requiredText(24),
});
export type InfoInteraction = z.infer<typeof infoInteractionSchema>;

/** Unsupported mechanic described in prose. Blueprint only — never built into a playable scene. */
export const customInteractionSchema = z.object({
  type: z.literal('custom'),
  description: requiredText(800),
});

export const buildableInteractionSchema = z.discriminatedUnion('type', [
  infoInteractionSchema,
  coordinateInteractionSchema,
  matchInteractionSchema,
  sortInteractionSchema,
]);
export type BuildableInteraction = z.infer<typeof buildableInteractionSchema>;

export const sceneInteractionSchema = z.discriminatedUnion('type', [
  infoInteractionSchema,
  coordinateInteractionSchema,
  matchInteractionSchema,
  sortInteractionSchema,
  customInteractionSchema,
]);
export type SceneInteraction = z.infer<typeof sceneInteractionSchema>;
export type SceneType = SceneInteraction['type'];
