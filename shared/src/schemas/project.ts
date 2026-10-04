import { z } from 'zod';
import { gameBriefSchema, themeId } from './brief.ts';
import { jobSchema } from './jobs.ts';
import { branchSummarySchema } from './records.ts';
import { sourceDocumentSchema } from './source.ts';

export const projectState = z.enum([
  'draft',
  'uploading',
  'extracting',
  'needs_review',
  'analyzing',
  'blueprint_ready',
  'approved',
  'building',
  'playable',
  'failed',
  'cancelled',
]);
export type ProjectState = z.infer<typeof projectState>;

export const statusLabel = z.enum(['Draft', 'Content reviewed', 'Blueprint approved', 'Playable', 'Needs attention']);
export type StatusLabel = z.infer<typeof statusLabel>;

export const projectSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  subject: z.string(),
  gradeOrAge: z.string(),
  isSample: z.boolean(),
  state: projectState,
  statusLabel,
  statusDetail: z.string().nullable(),
  themeId,
  paletteId: z.string(),
  slideCount: z.number().int(),
  currentVersionNumber: z.number().int().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  revision: z.number().int(),
});
export type ProjectSummary = z.infer<typeof projectSummarySchema>;

export const createStepSchema = z.enum(['source', 'brief', 'visual', 'review']);
export type CreateStep = z.infer<typeof createStepSchema>;

export const projectDetailSchema = projectSummarySchema.extend({
  brief: gameBriefSchema,
  briefRevision: z.number().int(),
  createStep: createStepSchema,
  documents: z.array(sourceDocumentSchema),
  contentReviewedAt: z.string().nullable(),
  currentVersionId: z.string().nullable(),
  latestBlueprintId: z.string().nullable(),
  approvedBlueprintId: z.string().nullable(),
  currentAnalysisId: z.string().nullable(),
  activeJobs: z.array(jobSchema),
  lastProblemJob: jobSchema.nullable(),
  sourceRevision: z.string(),
  /** The grade version being edited; versions, blueprint, map, grade and motion follow it. */
  activeBranchId: z.string(),
  branches: z.array(branchSummarySchema),
});
export type ProjectDetail = z.infer<typeof projectDetailSchema>;

/** Workflow stage shown in the top bar. */
export const STAGES = ['Import', 'Review', 'Describe', 'Blueprint', 'Build', 'Playtest', 'Export'] as const;
export type Stage = (typeof STAGES)[number];

export function stageForState(state: ProjectState): Stage {
  switch (state) {
    case 'draft':
    case 'uploading':
    case 'extracting':
      return 'Import';
    case 'needs_review':
      return 'Review';
    case 'analyzing':
      return 'Describe';
    case 'blueprint_ready':
    case 'approved':
      return 'Blueprint';
    case 'building':
      return 'Build';
    case 'playable':
      return 'Playtest';
    case 'failed':
    case 'cancelled':
      return 'Import';
  }
}
