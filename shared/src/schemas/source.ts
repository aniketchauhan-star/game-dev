import { z } from 'zod';
import { idString, isoDate } from './common.ts';

/** Position of an object on the slide. EMU values from the package plus a 0–1 normalized box. */
export const boundsSchema = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
  /** Normalized against the slide size (0–1). */
  nx: z.number(),
  ny: z.number(),
  nw: z.number(),
  nh: z.number(),
  /** Where the bounds came from: the shape itself, an inherited layout/master placeholder, or a transformed group child. */
  source: z.enum(['shape', 'layout', 'master', 'group']),
});
export type Bounds = z.infer<typeof boundsSchema>;

export const paragraphSchema = z.object({
  text: z.string(),
  level: z.number().int().min(0).max(8),
  bullet: z.boolean(),
});
export type Paragraph = z.infer<typeof paragraphSchema>;

export const textBlockSchema = z.object({
  id: z.string(),
  shapeName: z.string(),
  role: z.enum(['title', 'subtitle', 'body', 'text', 'smartart']),
  paragraphs: z.array(paragraphSchema),
  bounds: boundsSchema.nullable(),
  /** Position in the slide's reading order (shape tree order, which screen readers follow). */
  order: z.number().int(),
  inGroup: z.boolean(),
});
export type TextBlock = z.infer<typeof textBlockSchema>;

export const tableSchema = z.object({
  id: z.string(),
  shapeName: z.string(),
  rows: z.array(z.array(z.string())),
  bounds: boundsSchema.nullable(),
  order: z.number().int(),
});
export type SlideTable = z.infer<typeof tableSchema>;

export const equationSchema = z.object({
  id: z.string(),
  /** Office Math (OMML) source exactly as stored in the deck (truncated if extremely long). */
  omml: z.string(),
  /** Linearized text reading of the equation, e.g. "d = √((x₂ − x₁)² + (y₂ − y₁)²)". */
  linear: z.string(),
  bounds: boundsSchema.nullable(),
  order: z.number().int(),
});
export type SlideEquation = z.infer<typeof equationSchema>;

export const slideImageSchema = z.object({
  id: z.string(),
  shapeName: z.string(),
  /** Package part name, e.g. `ppt/media/image3.png`. */
  partName: z.string(),
  contentType: z.string(),
  altText: z.string(),
  bounds: boundsSchema.nullable(),
  order: z.number().int(),
  /** Asset created from this image, when the format is supported. */
  assetId: z.string().nullable(),
  supported: z.boolean(),
});
export type SlideImage = z.infer<typeof slideImageSchema>;

export const extractionWarningCode = z.enum([
  'chart',
  'smartart',
  'group',
  'animation',
  'equation',
  'reading-order',
  'external-link',
  'unsupported-image',
  'image-too-large',
  'ole-object',
  'media',
  'empty-slide',
  'missing-part',
  'placeholder-bounds',
  'truncated',
]);
export type ExtractionWarningCode = z.infer<typeof extractionWarningCode>;

export const extractionWarningSchema = z.object({
  code: extractionWarningCode,
  severity: z.enum(['info', 'warning']),
  message: z.string(),
});
export type ExtractionWarning = z.infer<typeof extractionWarningSchema>;

/** Everything extracted from one slide. Immutable once stored — creator corrections live in `SlideEdits`. */
export const slideExtractSchema = z.object({
  title: z.string(),
  layoutName: z.string().nullable(),
  blocks: z.array(textBlockSchema),
  tables: z.array(tableSchema),
  equations: z.array(equationSchema),
  images: z.array(slideImageSchema),
  notes: z.array(z.string()),
  warnings: z.array(extractionWarningSchema),
});
export type SlideExtract = z.infer<typeof slideExtractSchema>;

/** Creator corrections layered over the original extraction. */
export const slideEditsSchema = z.object({
  title: z.string().max(300).nullable(),
  /** Block id → replacement paragraphs (plain text, one entry per paragraph). */
  blocks: z.record(z.string(), z.array(z.string().max(2000)).max(80)),
  notes: z.array(z.string().max(4000)).max(80).nullable(),
});
export type SlideEdits = z.infer<typeof slideEditsSchema>;

export const reviewStatus = z.enum(['needs_review', 'verified', 'missing_visual']);
export type ReviewStatus = z.infer<typeof reviewStatus>;

export const visualRefSchema = z.object({
  kind: z.enum(['pdf-page', 'image', 'render']),
  documentId: z.string().nullable(),
  pageNumber: z.number().int().min(1).nullable(),
  assetId: z.string().nullable(),
  /** suggested = proposed by text matching or file order; verified = confirmed by the creator; exact = rendered from this deck. */
  mapping: z.enum(['suggested', 'verified', 'exact']),
});
export type VisualRef = z.infer<typeof visualRefSchema>;

export const sourceSlideSchema = z.object({
  id: idString,
  projectId: idString,
  documentId: idString,
  slideNumber: z.number().int().min(1),
  /** `p:sldId/@id` — stable across reordering inside PowerPoint. */
  pptxSlideId: z.number().int(),
  partName: z.string(),
  hidden: z.boolean(),
  included: z.boolean(),
  extract: slideExtractSchema,
  edits: slideEditsSchema,
  lockedWording: z.boolean(),
  requiredExample: z.boolean(),
  reviewStatus,
  visualRef: visualRefSchema.nullable(),
  contentHash: z.string(),
  revision: z.number().int(),
  updatedAt: isoDate,
});
export type SourceSlide = z.infer<typeof sourceSlideSchema>;

export const sourceDocumentSchema = z.object({
  id: idString,
  projectId: idString,
  kind: z.enum(['pptx', 'pdf', 'slide-images']),
  role: z.enum(['primary', 'reference', 'bundled-sample', 'rendered']),
  originalName: z.string(),
  sizeBytes: z.number().int(),
  sha256: z.string(),
  status: z.enum(['stored', 'extracting', 'ready', 'failed']),
  pageCount: z.number().int().nullable(),
  slideSize: z.object({ cx: z.number(), cy: z.number() }).nullable(),
  warnings: z.array(z.string()),
  error: z.string().nullable(),
  createdAt: isoDate,
});
export type SourceDocument = z.infer<typeof sourceDocumentSchema>;

export const slideChangeSchema = z.object({
  id: z.string(),
  slideId: z.string(),
  field: z.string(),
  before: z.unknown(),
  after: z.unknown(),
  createdAt: isoDate,
});
export type SlideChange = z.infer<typeof slideChangeSchema>;

/** Merge original extraction and creator edits into the text Claude and the builder see. */
export function effectiveSlideText(slide: Pick<SourceSlide, 'extract' | 'edits'>): {
  title: string;
  blocks: Array<{ id: string; role: TextBlock['role']; paragraphs: string[]; edited: boolean }>;
  notes: string[];
  notesEdited: boolean;
  titleEdited: boolean;
} {
  const titleEdited = slide.edits.title !== null && slide.edits.title !== undefined;
  const title = titleEdited ? (slide.edits.title as string) : slide.extract.title;
  const blocks = slide.extract.blocks.map((b) => {
    const edited = Object.prototype.hasOwnProperty.call(slide.edits.blocks, b.id);
    return {
      id: b.id,
      role: b.role,
      paragraphs: edited ? (slide.edits.blocks[b.id] ?? []) : b.paragraphs.map((p) => p.text),
      edited,
    };
  });
  const notesEdited = slide.edits.notes !== null && slide.edits.notes !== undefined;
  return { title, blocks, notes: notesEdited ? (slide.edits.notes as string[]) : slide.extract.notes, notesEdited, titleEdited };
}
