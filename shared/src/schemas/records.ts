import { z } from 'zod';
import { learningAnalysisSchema } from './analysis.ts';
import { provenance } from './common.ts';
import { gameConfigSchema } from './game.ts';
import { changeOpSchema, proposalStatusSchema } from './proposal.ts';

export const analysisRecordSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  number: z.number().int(),
  origin: provenance,
  model: z.string().nullable(),
  sourceRevision: z.string(),
  briefRevision: z.number().int(),
  stale: z.boolean(),
  staleReason: z.string().nullable(),
  analysis: learningAnalysisSchema,
  revision: z.number().int(),
  createdAt: z.string(),
});
export type AnalysisRecord = z.infer<typeof analysisRecordSchema>;

export const versionOrigin = z.enum(['build', 'refinement', 'manual-edit', 'restore', 'undo', 'sample', 'branch']);

/** A grade version of the game (branch): its own versions, blueprint, screen map, grade profile and motion. */
export const branchSummarySchema = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  parentBranchId: z.string().nullable(),
  parentName: z.string().nullable(),
  forkedFromVersionId: z.string().nullable(),
  forkedFromVersionNumber: z.number().int().nullable(),
  currentVersionId: z.string().nullable(),
  currentVersionNumber: z.number().int().nullable(),
  versionCount: z.number().int(),
  gradeLabel: z.string(),
  active: z.boolean(),
  revision: z.number().int(),
  createdAt: z.string(),
});
export type BranchSummary = z.infer<typeof branchSummarySchema>;

export const gameVersionSummarySchema = z.object({
  id: z.string(),
  projectId: z.string(),
  branchId: z.string().nullable(),
  number: z.number().int(),
  blueprintRevisionId: z.string().nullable(),
  blueprintRevisionNumber: z.number().int().nullable(),
  parentVersionId: z.string().nullable(),
  origin: versionOrigin,
  summary: z.string(),
  demo: z.boolean(),
  createdAt: z.string(),
});
export type GameVersionSummary = z.infer<typeof gameVersionSummarySchema>;

export const gameVersionSchema = gameVersionSummarySchema.extend({ config: gameConfigSchema });
export type GameVersion = z.infer<typeof gameVersionSchema>;

export const opResultSchema = z.object({
  index: z.number().int(),
  status: z.enum(['applied', 'conflict', 'out-of-scope', 'invalid', 'unchanged']),
  target: z.string(),
  where: z.string().optional(),
  label: z.string(),
  before: z.unknown(),
  after: z.unknown(),
  impact: z.enum(['none', 'wording', 'answers', 'difficulty', 'sequence']),
  message: z.string().nullable(),
  sourceSlideIds: z.array(z.string()),
});

export const proposalSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  baseVersionId: z.string(),
  baseVersionNumber: z.number().int(),
  scope: z.object({ kind: z.enum(['project', 'scene']), sceneId: z.string().nullable() }),
  request: z.string(),
  summary: z.string(),
  explanation: z.string(),
  ops: z.array(changeOpSchema),
  results: z.array(opResultSchema),
  status: proposalStatusSchema,
  origin: z.enum(['claude', 'demo', 'creator']),
  model: z.string().nullable(),
  resultVersionId: z.string().nullable(),
  resultVersionNumber: z.number().int().nullable(),
  createdAt: z.string(),
  resolvedAt: z.string().nullable(),
});
export type Proposal = z.infer<typeof proposalSchema>;

export const chatScopeSchema = z.object({
  kind: z.enum(['project', 'scene', 'slide']),
  sceneId: z.string().nullable(),
  slideId: z.string().nullable(),
});
export type ChatScope = z.infer<typeof chatScopeSchema>;

export const chatMessageSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  role: z.enum(['creator', 'claude', 'system']),
  text: z.string(),
  scope: chatScopeSchema,
  area: z.enum(['source', 'blueprint', 'build', 'assets', 'general']),
  origin: z.enum(['creator', 'claude', 'demo', 'system']),
  status: z.enum(['complete', 'streaming', 'failed', 'cancelled']),
  jobId: z.string().nullable(),
  proposalId: z.string().nullable(),
  createdAt: z.string(),
});
export type ChatMessage = z.infer<typeof chatMessageSchema>;

export const coverageSchema = z.object({
  blueprintRevisionId: z.string().nullable(),
  slides: z.array(
    z.object({
      slideId: z.string(),
      slideNumber: z.number().int(),
      title: z.string(),
      status: z.enum(['covered', 'not-covered', 'excluded', 'hidden']),
      sceneIds: z.array(z.string()),
      conceptIds: z.array(z.string()),
      note: z.string().nullable(),
    }),
  ),
  scenes: z.array(z.object({ sceneId: z.string(), title: z.string(), slideNumbers: z.array(z.number().int()), addedPractice: z.boolean() })),
  duplicates: z.array(z.object({ slideId: z.string(), slideNumber: z.number().int(), sceneIds: z.array(z.string()) })),
  concepts: z.array(z.object({ conceptId: z.string(), name: z.string(), slideIds: z.array(z.string()), sceneIds: z.array(z.string()) })),
  summary: z.object({ included: z.number().int(), covered: z.number().int(), notCovered: z.number().int(), excluded: z.number().int(), addedPracticeScenes: z.number().int() }),
});
export type Coverage = z.infer<typeof coverageSchema>;
