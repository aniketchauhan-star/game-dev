import { z } from 'zod';
import { placementSchema, spriteSchema } from './game.ts';

export const assetLibraryRole = z.enum(['background', 'character', 'object', 'ui', 'audio', 'reference', 'unassigned']);
export type AssetLibraryRole = z.infer<typeof assetLibraryRole>;

/**
 * Where an asset came from. Recorded so exports and reviews can tell creator
 * uploads, artwork made with an external AI tool (e.g. downloaded from
 * ChatGPT), Figma imports and slide images apart. Never holds tokens or
 * temporary provider URLs.
 */
export const assetProvenanceSchema = z.object({
  kind: z.enum(['upload', 'ai-tool', 'figma', 'exported-screen', 'pptx', 'bundled']),
  /** Tool or origin named by the creator, e.g. "ChatGPT". */
  tool: z.string().max(60),
  note: z.string().max(300),
  figma: z
    .object({
      fileKey: z.string().max(64),
      nodeId: z.string().max(120).nullable(),
      imageRef: z.string().max(200).nullable(),
      sourceVersion: z.string().max(80).nullable(),
      importId: z.string().max(64),
      kind: z.enum(['frame-render', 'node-render', 'image-fill', 'thumbnail']),
    })
    .nullable(),
  recordedAt: z.string(),
});
export type AssetProvenance = z.infer<typeof assetProvenanceSchema>;

export const assetMetadataSchema = z.object({
  placement: placementSchema,
  sprite: spriteSchema.nullable(),
  /** Asset this one replaced; placement is carried over unless the creator asks otherwise. */
  replacedFrom: z.string().nullable(),
  /** The original upload was SVG; only the rasterized PNG is ever displayed. */
  rasterizedFromSvg: z.boolean(),
  alt: z.string().max(160),
  /** Copyable prompt for an external image generator (no image service is called). */
  generationPrompt: z.string().max(1200).nullable(),
  provenance: assetProvenanceSchema.nullable().default(null),
});
export type AssetMetadata = z.infer<typeof assetMetadataSchema>;

export const assetUsageSchema = z.object({
  kind: z.enum([
    'scene-background',
    'scene-character',
    'theme-background',
    'title-character',
    'completion-character',
    'music',
    'card-image',
    'blueprint-need',
    'slide-image',
    'scene-panel',
    'scene-button',
    'design-background',
    'design-layer',
    'screen-object',
    'animation',
    'design-reference',
    'screen-map',
  ]),
  sceneId: z.string().nullable(),
  label: z.string(),
});
export type AssetUsage = z.infer<typeof assetUsageSchema>;

export const assetSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  role: assetLibraryRole,
  kind: z.enum(['image', 'audio']),
  name: z.string(),
  originalName: z.string(),
  mime: z.string(),
  format: z.string(),
  sizeBytes: z.number().int(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  hasAlpha: z.boolean().nullable(),
  durationSeconds: z.number().nullable(),
  source: z.enum(['uploaded', 'extracted', 'bundled-sample', 'figma']),
  sha256: z.string(),
  metadata: assetMetadataSchema,
  usage: z.array(assetUsageSchema),
  createdAt: z.string(),
});
export type Asset = z.infer<typeof assetSchema>;

export const ASSET_ROLE_LABELS: Record<AssetLibraryRole, string> = {
  background: 'Backgrounds',
  character: 'Characters',
  object: 'Objects',
  ui: 'UI',
  audio: 'Audio',
  reference: 'Design references',
  unassigned: 'Unassigned',
};
