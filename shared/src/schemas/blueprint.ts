import { z } from 'zod';
import { difficulty, learningPattern, mechanicId, provenance, requiredText } from './common.ts';
import { sceneInteractionSchema } from './interaction.ts';

export const sceneLocksSchema = z.object({
  /** Scene must keep its position in the source-derived sequence. */
  sequence: z.boolean(),
  /** Learner-facing wording must not be rewritten. */
  wording: z.boolean(),
  /** Correct answers / rules must not change. */
  answer: z.boolean(),
  /** Layout regions (instruction position, density) must not change. */
  layout: z.boolean(),
  /** Assigned asset identities (character, background) must not change. */
  assets: z.boolean(),
});
export type SceneLocks = z.infer<typeof sceneLocksSchema>;

export const NO_LOCKS: SceneLocks = { sequence: false, wording: false, answer: false, layout: false, assets: false };

export const assetRole = z.enum(['background', 'character', 'object', 'ui', 'audio']);
export type AssetRole = z.infer<typeof assetRole>;

export const assetNeedSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/),
  role: assetRole,
  description: requiredText(160),
  assignedAssetId: z.string().nullable(),
  required: z.boolean(),
});
export type AssetNeed = z.infer<typeof assetNeedSchema>;

export const blueprintSceneSchema = z.object({
  id: z.string().min(1).max(40),
  title: requiredText(60),
  pattern: learningPattern,
  sourceSlideIds: z.array(z.string()).max(40),
  addedPractice: z.boolean(),
  objective: requiredText(240),
  visibleContent: requiredText(400),
  learnerAction: requiredText(240),
  expectedResult: requiredText(240),
  /** Learner-facing instruction shown in the game. */
  instruction: requiredText(220),
  interaction: sceneInteractionSchema,
  successFeedback: requiredText(160),
  errorFeedback: requiredText(200),
  hints: z.array(requiredText(160)).min(1).max(3),
  next: z.string().nullable(),
  assetNeedIds: z.object({ background: z.string().nullable(), character: z.string().nullable() }),
  completion: requiredText(240),
  difficulty,
  locks: sceneLocksSchema,
  origin: provenance,
});
export type BlueprintScene = z.infer<typeof blueprintSceneSchema>;

export const blueprintSchema = z.object({
  schemaVersion: z.literal(1),
  title: requiredText(80),
  learningOutcomes: z
    .array(z.object({ id: z.string(), text: requiredText(240), sourceSlideIds: z.array(z.string()).max(40), addedPractice: z.boolean() }))
    .min(1)
    .max(8),
  coreMechanic: mechanicId,
  customMechanicDescription: z.string().max(1000).nullable(),
  premise: requiredText(400),
  progression: requiredText(400),
  assessment: requiredText(400),
  assetNeeds: z.array(assetNeedSchema).max(16),
  accessibility: z.array(requiredText(200)).max(10),
  unresolvedDecisions: z.array(z.object({ id: z.string(), question: requiredText(240), options: z.array(z.string().max(120)).max(5) })).max(10),
  assumptions: z.array(requiredText(240)).max(10),
  mechanicFit: requiredText(500),
  scenes: z.array(blueprintSceneSchema).min(1).max(24),
});
export type Blueprint = z.infer<typeof blueprintSchema>;

export const blueprintRevisionStatus = z.enum(['draft', 'approved', 'superseded']);

export const blueprintRevisionSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  /** Grade version this revision belongs to. */
  branchId: z.string().nullable().default(null),
  number: z.number().int().min(1),
  parentId: z.string().nullable(),
  status: blueprintRevisionStatus,
  origin: provenance,
  model: z.string().nullable(),
  analysisId: z.string().nullable(),
  sourceRevision: z.string(),
  stale: z.boolean(),
  staleReason: z.string().nullable(),
  blueprint: blueprintSchema,
  revision: z.number().int(),
  createdAt: z.string(),
  approvedAt: z.string().nullable(),
});
export type BlueprintRevision = z.infer<typeof blueprintRevisionSchema>;

export interface BlueprintIssue {
  sceneId: string | null;
  severity: 'error' | 'warning';
  message: string;
}

/** Structural checks that Zod cannot express: unique ids, valid `next` pointers, sourced scenes, known slides. */
/** Marks text the creator still has to write (used by hand-started blueprints). */
export const NOT_WRITTEN = 'Not written yet';
export const isNotWritten = (text: string): boolean => text.trim().startsWith(NOT_WRITTEN);

export function checkBlueprint(blueprint: Blueprint, includedSlideIds: ReadonlySet<string>): BlueprintIssue[] {
  const issues: BlueprintIssue[] = [];
  if (isNotWritten(blueprint.premise)) issues.push({ sceneId: null, severity: 'error', message: 'Write the story premise — learners see it on the title screen.' });
  const notes: Array<[string, string]> = [
    ['“Why this mechanic fits”', blueprint.mechanicFit],
    ['Progression', blueprint.progression],
    ['Assessment', blueprint.assessment],
  ];
  for (const [label, text] of notes) {
    if (isNotWritten(text)) issues.push({ sceneId: null, severity: 'warning', message: `${label} is not written yet — it goes into the design document and exports.` });
  }
  const ids = new Set<string>();
  for (const scene of blueprint.scenes) {
    if (ids.has(scene.id)) issues.push({ sceneId: scene.id, severity: 'error', message: `Duplicate scene id "${scene.id}"` });
    ids.add(scene.id);
  }
  const needIds = new Set(blueprint.assetNeeds.map((n) => n.id));
  for (const scene of blueprint.scenes) {
    if (scene.next !== null && !ids.has(scene.next)) {
      issues.push({ sceneId: scene.id, severity: 'error', message: `“Next scene” points to unknown scene "${scene.next}"` });
    }
    if (scene.next === scene.id) issues.push({ sceneId: scene.id, severity: 'error', message: 'A scene cannot lead to itself' });
    if (scene.sourceSlideIds.length === 0 && !scene.addedPractice) {
      issues.push({ sceneId: scene.id, severity: 'error', message: 'Scene needs source slides or must be marked as added practice' });
    }
    for (const sid of scene.sourceSlideIds) {
      if (!includedSlideIds.has(sid)) issues.push({ sceneId: scene.id, severity: 'error', message: `References unknown or excluded slide "${sid}"` });
    }
    for (const key of ['background', 'character'] as const) {
      const need = scene.assetNeedIds[key];
      if (need !== null && !needIds.has(need)) issues.push({ sceneId: scene.id, severity: 'error', message: `Unknown asset need "${need}"` });
    }
  }
  blueprint.learningOutcomes.forEach((o) => {
    for (const sid of o.sourceSlideIds) {
      if (!includedSlideIds.has(sid)) issues.push({ sceneId: null, severity: 'error', message: `Outcome references unknown or excluded slide "${sid}"` });
    }
    if (o.sourceSlideIds.length === 0 && !o.addedPractice) {
      issues.push({ sceneId: null, severity: 'error', message: `Outcome “${o.text.slice(0, 40)}” needs source slides or must be marked as added practice` });
    }
  });
  // Every scene must be reachable from the first scene by following `next`.
  if (blueprint.scenes.length > 0) {
    const byId = new Map(blueprint.scenes.map((s) => [s.id, s]));
    const seen = new Set<string>();
    let cursor: string | null = blueprint.scenes[0]!.id;
    while (cursor !== null && !seen.has(cursor)) {
      seen.add(cursor);
      cursor = byId.get(cursor)?.next ?? null;
    }
    if (cursor !== null) issues.push({ sceneId: cursor, severity: 'error', message: 'Scene flow contains a loop' });
    for (const s of blueprint.scenes) {
      if (!seen.has(s.id)) issues.push({ sceneId: s.id, severity: 'warning', message: 'Scene is not reachable from the first scene' });
    }
  }
  return issues;
}

/** Rewrite `next` pointers so scenes play in array order. Used after reordering a linear flow. */
export function relinkLinear<T extends { id: string; next: string | null }>(scenes: T[]): T[] {
  return scenes.map((s, i) => ({ ...s, next: scenes[i + 1]?.id ?? null }));
}

/** Ordered scenes following the `next` chain from the first scene. */
export function sceneFlow<T extends { id: string; next: string | null }>(scenes: T[]): T[] {
  const byId = new Map(scenes.map((s) => [s.id, s]));
  const out: T[] = [];
  const seen = new Set<string>();
  let cursor: string | null = scenes[0]?.id ?? null;
  while (cursor && !seen.has(cursor)) {
    const s = byId.get(cursor);
    if (!s) break;
    out.push(s);
    seen.add(cursor);
    cursor = s.next;
  }
  return out;
}
