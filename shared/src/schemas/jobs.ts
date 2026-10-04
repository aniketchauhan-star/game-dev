import { z } from 'zod';
import { motionPlanScopeSchema } from './motion.ts';
import { changeScopeSchema } from './proposal.ts';

export const jobType = z.enum([
  'extract_pptx',
  'extract_pdf',
  'render_slides',
  'analyze',
  'blueprint',
  'regenerate_scene',
  'build',
  'refine',
  'ask',
  'figma_browse',
  'figma_import',
  'grade_plan',
  'motion_suggest',
  'prepare',
]);
export type JobType = z.infer<typeof jobType>;

export const jobStatus = z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted']);
export type JobStatus = z.infer<typeof jobStatus>;

export const ACTIVE_JOB_STATUSES: JobStatus[] = ['queued', 'running'];

export const jobEventType = z.enum(['status', 'stage', 'info', 'warning', 'error', 'text', 'usage', 'result']);
export type JobEventType = z.infer<typeof jobEventType>;

export const usageSchema = z.object({
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  cacheReadTokens: z.number().int(),
  cacheWriteTokens: z.number().int(),
  calls: z.number().int(),
});
export type Usage = z.infer<typeof usageSchema>;

export const EMPTY_USAGE: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 0 };

export const jobErrorSchema = z.object({
  message: z.string(),
  code: z.string(),
  retryable: z.boolean(),
  stage: z.string().nullable(),
});
export type JobError = z.infer<typeof jobErrorSchema>;

export const jobSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  type: jobType,
  status: jobStatus,
  stage: z.string().nullable(),
  attempt: z.number().int(),
  maxAttempts: z.number().int(),
  mode: z.enum(['live', 'demo', 'local']),
  model: z.string().nullable(),
  usage: usageSchema.nullable(),
  error: jobErrorSchema.nullable(),
  result: z.unknown().nullable(),
  cancelRequested: z.boolean(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
});
export type Job = z.infer<typeof jobSchema>;

export const jobEventSchema = z.object({
  seq: z.number().int(),
  jobId: z.string(),
  type: jobEventType,
  stage: z.string().nullable(),
  message: z.string(),
  data: z.unknown().nullable(),
  createdAt: z.string(),
});
export type JobEvent = z.infer<typeof jobEventSchema>;

/** Inputs per job type — validated when a job is created and again when the worker claims it. */
export const jobInputSchemas = {
  extract_pptx: z.object({ documentId: z.string() }),
  extract_pdf: z.object({ documentId: z.string() }),
  render_slides: z.object({ documentId: z.string() }),
  analyze: z.object({}),
  blueprint: z.object({ analysisId: z.string().nullable() }),
  regenerate_scene: z.object({ blueprintRevisionId: z.string(), sceneId: z.string(), guidance: z.string().max(1000) }),
  build: z.object({
    blueprintRevisionId: z.string(),
    /** Optional staged inputs ("Approve & build"): accepted grade plan items and motion plan rows. */
    gradePlanId: z.string().nullable().default(null),
    motionPlanId: z.string().nullable().default(null),
    /** Keep approved motion from the current version where its targets still exist. */
    carryMotion: z.boolean().default(true),
  }),
  refine: z.object({ messageId: z.string(), baseVersionId: z.string(), scope: changeScopeSchema, request: z.string().min(1).max(2000) }),
  ask: z.object({ messageId: z.string(), slideId: z.string().nullable(), sceneId: z.string().nullable(), question: z.string().min(1).max(2000) }),
  figma_browse: z.object({ importId: z.string() }),
  figma_import: z.object({ importId: z.string(), nodeIds: z.array(z.string().regex(/^\d{1,12}:\d{1,12}$/)).min(1).max(24) }),
  grade_plan: z.object({ branchId: z.string(), mode: z.enum(['presentation', 'challenge']) }),
  motion_suggest: z.object({
    branchId: z.string(),
    /** Version the plan is made against; null stages it for the next build. */
    baseVersionId: z.string().nullable(),
    scope: motionPlanScopeSchema,
    /** Creator request in their own words; empty = “Suggest motion for this screen”. */
    request: z.string().max(2000),
    messageId: z.string().nullable().default(null),
  }),
  prepare: z.object({ branchId: z.string() }),
} satisfies Record<JobType, z.ZodType>;

export type JobInput<T extends JobType> = z.infer<(typeof jobInputSchemas)[T]>;

export const JOB_LABELS: Record<JobType, string> = {
  extract_pptx: 'Extract PowerPoint',
  extract_pdf: 'Read PDF reference',
  render_slides: 'Render slide images',
  analyze: 'Analyze learning content',
  blueprint: 'Generate blueprint',
  regenerate_scene: 'Regenerate scene',
  build: 'Build game',
  refine: 'Refine game',
  ask: 'Answer question',
  figma_browse: 'List Figma frames',
  figma_import: 'Import Figma frames',
  grade_plan: 'Grade adaptation plan',
  motion_suggest: 'Suggest motion',
  prepare: 'Prepare my game',
};

/** Job types that call Claude (and therefore cost money in live mode). */
export const AI_JOB_TYPES: JobType[] = ['analyze', 'blueprint', 'regenerate_scene', 'refine', 'ask', 'grade_plan', 'motion_suggest', 'prepare'];

/** AI job types that still run without Claude, using deterministic preset rules (clearly labelled). */
export const LOCAL_FALLBACK_JOB_TYPES: JobType[] = ['grade_plan', 'motion_suggest', 'prepare'];
