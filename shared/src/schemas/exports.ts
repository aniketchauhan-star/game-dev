import { z } from 'zod';

export const exportKind = z.enum(['playable', 'source', 'handoff']);
export type ExportKind = z.infer<typeof exportKind>;

export const preflightCheckSchema = z.object({
  id: z.string(),
  label: z.string(),
  status: z.enum(['pass', 'warn', 'fail', 'info']),
  detail: z.string(),
});
export type PreflightCheck = z.infer<typeof preflightCheckSchema>;

export const preflightSchema = z.object({
  kind: exportKind,
  label: z.string(),
  playable: z.boolean(),
  versionId: z.string().nullable(),
  versionNumber: z.number().int().nullable(),
  blueprintRevisionNumber: z.number().int().nullable(),
  checks: z.array(preflightCheckSchema),
  missingAssets: z.array(z.string()),
  unresolvedSourceWarnings: z.array(z.string()),
  unsupportedScenes: z.array(z.string()),
  /** Checks that actually ran during this export (never claims browser testing that did not happen). */
  testsRun: z.array(z.string()),
  blocking: z.boolean(),
});
export type Preflight = z.infer<typeof preflightSchema>;

export const exportRecordSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  kind: exportKind,
  label: z.string(),
  versionId: z.string().nullable(),
  versionNumber: z.number().int().nullable(),
  fileName: z.string(),
  sizeBytes: z.number().int(),
  includeSourceMaterial: z.boolean(),
  createdAt: z.string(),
  preflight: preflightSchema,
  /** Grade version the export was made from. */
  branchId: z.string().nullable().default(null),
});
export type ExportRecord = z.infer<typeof exportRecordSchema>;

export const EXPORT_LABELS: Record<ExportKind, string> = {
  playable: 'Playable game',
  source: 'Source package',
  handoff: 'Claude Code handoff',
};
