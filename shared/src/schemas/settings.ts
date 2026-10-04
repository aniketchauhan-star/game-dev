import { z } from 'zod';

export const claudeStatusSchema = z.object({
  /**
   * configured — key present and the model verified against the Models API;
   * unverified — key present, model not yet verified; not_configured — no key;
   * connection_failed — the last verification failed.
   */
  state: z.enum(['configured', 'unverified', 'not_configured', 'connection_failed']),
  keyPresent: z.boolean(),
  model: z.string().nullable(),
  modelSource: z.enum(['env', 'settings']).nullable(),
  verifiedAt: z.string().nullable(),
  modelInfo: z
    .object({
      id: z.string(),
      displayName: z.string(),
      maxInputTokens: z.number().nullable(),
      maxOutputTokens: z.number().nullable(),
      structuredOutputs: z.boolean().nullable(),
      imageInput: z.boolean().nullable(),
      pdfInput: z.boolean().nullable(),
      effort: z.boolean().nullable(),
    })
    .nullable(),
  lastError: z.string().nullable(),
  refusalFallback: z.enum(['default', 'off']),
  baseUrlOverridden: z.boolean(),
});
export type ClaudeStatus = z.infer<typeof claudeStatusSchema>;

export const rendererStatusSchema = z.object({
  state: z.enum(['available', 'unavailable', 'error', 'disabled']),
  mode: z.enum(['libreoffice', 'docker', 'off']),
  detail: z.string(),
  version: z.string().nullable(),
  checkedAt: z.string(),
});
export type RendererStatus = z.infer<typeof rendererStatusSchema>;

export const figmaStatusSchema = z.object({
  /**
   * not-configured — no token on the server; configured — token present, not yet checked;
   * verified — the last check succeeded; error — the last check failed.
   */
  state: z.enum(['not-configured', 'configured', 'verified', 'error']),
  tokenPresent: z.boolean(),
  account: z.string().nullable(),
  detail: z.string(),
  checkedAt: z.string().nullable(),
  /** Hosted multi-user OAuth needs its own integration; this local build does not provide it. */
  oauth: z.literal('not-configured'),
  apiBaseUrl: z.string(),
});
export type FigmaStatus = z.infer<typeof figmaStatusSchema>;

export const limitsSchema = z.object({
  maxUploadBytes: z.number().int(),
  maxSlides: z.number().int(),
  maxExpandedBytes: z.number().int(),
  maxEntries: z.number().int(),
  maxXmlBytes: z.number().int(),
  maxImagePixels: z.number().int(),
  maxAssetBytes: z.number().int(),
  maxPdfPages: z.number().int(),
});
export type Limits = z.infer<typeof limitsSchema>;

export const pricingSchema = z.object({
  asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  source: z.string().max(300),
  currency: z.literal('USD'),
  models: z.record(
    z.string(),
    z.object({
      inputPerMTok: z.number().nonnegative(),
      outputPerMTok: z.number().nonnegative(),
      cacheReadPerMTok: z.number().nonnegative().optional(),
      cacheWritePerMTok: z.number().nonnegative().optional(),
    }),
  ),
});
export type Pricing = z.infer<typeof pricingSchema>;

export const healthSchema = z.object({
  ok: z.boolean(),
  version: z.string(),
  dataDir: z.string(),
  worker: z.object({ online: z.boolean(), lastHeartbeat: z.string().nullable(), workerId: z.string().nullable() }),
  claude: claudeStatusSchema,
  renderer: rendererStatusSchema,
  figma: figmaStatusSchema,
  limits: limitsSchema,
  pricing: z.object({ configured: z.boolean(), asOf: z.string().nullable(), source: z.string().nullable(), error: z.string().nullable() }),
  /** Extension point for a future isolated custom-code builder; disabled in this version. */
  customCodeBuilder: z.object({ enabled: z.boolean(), reason: z.string().nullable() }),
});
export type Health = z.infer<typeof healthSchema>;
