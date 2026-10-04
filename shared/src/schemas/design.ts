import { z } from 'zod';
import { hexColor, shortText } from './common.ts';

/**
 * Design inputs (Figma frames or exported screens) and what the game keeps of
 * them. A background, a source reference, an editable label, an interactive
 * object and a game rule are different things: only the declared editable
 * subset becomes game layers; everything else stays flattened artwork or a
 * reference, and interaction always comes from the native mechanic.
 */

export const STAGE = { width: 1920, height: 1080 } as const;

export const boxSchema = z.object({
  x: z.number().finite().min(-20_000).max(20_000),
  y: z.number().finite().min(-20_000).max(20_000),
  w: z.number().finite().positive().max(40_000),
  h: z.number().finite().positive().max(40_000),
});
export type Box = z.infer<typeof boxSchema>;

// ───────────── in the game config ─────────────

/** An editable element kept from a design, positioned in the source frame's coordinates. */
export const designLayerSchema = z.object({
  id: z.string().regex(/^el-[A-Za-z0-9_-]{1,40}$/),
  name: shortText(80),
  kind: z.enum(['text', 'rect', 'image']),
  box: boxSchema,
  rotation: z.number().min(-360).max(360),
  opacity: z.number().min(0).max(1),
  z: z.number().int().min(-1000).max(1000),
  text: z
    .object({
      content: z.string().trim().min(1).max(600),
      fontFamily: shortText(80),
      fontSize: z.number().min(6).max(400),
      fontWeight: z.number().int().min(100).max(900),
      align: z.enum(['left', 'center', 'right', 'justified']),
      color: hexColor,
      /** The design font is not available to the runtime; the game's font is used instead. */
      substituted: z.boolean(),
    })
    .nullable(),
  fill: hexColor.nullable(),
  radius: z.number().min(0).max(2000).nullable(),
  stroke: z.object({ color: hexColor, width: z.number().min(0).max(64) }).nullable(),
  assetId: z.string().max(64).nullable(),
});
export type DesignLayer = z.infer<typeof designLayerSchema>;

export const fitMode = z.enum(['contain', 'cover']);
export type FitMode = z.infer<typeof fitMode>;

export const sceneDesignSchema = z.object({
  /** DesignFrameSnapshot this came from (provenance), or null for a creator layout. */
  frameId: z.string().max(64).nullable(),
  source: z.enum(['figma', 'exported', 'creator']),
  /** match: keep the approved composition; adapt: layout changes were proposed and approved. */
  mode: z.enum(['match', 'adapt']),
  /** contain = letterbox (nothing cropped); cover = fill the stage, cropping the overflow. */
  fit: fitMode,
  frameSize: z.object({ w: z.number().positive().max(40_000), h: z.number().positive().max(40_000) }),
  letterbox: hexColor,
  backgroundAssetId: z.string().max(64).nullable(),
  layers: z.array(designLayerSchema).max(60),
  /** Where the native instruction panel and the interaction area sit, in frame coordinates. */
  regions: z.object({ instruction: boxSchema.nullable(), play: boxSchema.nullable() }),
});
export type SceneDesign = z.infer<typeof sceneDesignSchema>;

/** Artwork placed on a screen by the creator, in stage coordinates. Decorative unless marked as a guide. */
export const objectPlacementSchema = z.object({
  id: z.string().regex(/^obj-[a-z0-9-]{1,24}$/),
  assetId: z.string().max(64),
  label: z.string().trim().min(1).max(40),
  x: z.number().min(-960).max(2880),
  y: z.number().min(-540).max(1620),
  width: z.number().min(8).max(3840),
  height: z.number().min(8).max(2160),
  z: z.number().int().min(-10).max(10),
  rotation: z.number().min(-180).max(180),
  role: z.enum(['decor', 'guide']),
  /** Sprite clip shown while idle (sprites only). */
  clip: z.string().regex(/^[a-z][a-z0-9-]{0,23}$/).nullable(),
});
export type ObjectPlacement = z.infer<typeof objectPlacementSchema>;

/** Uniform frame → stage transform: never stretched; letterboxed (contain) or cropped (cover). */
export function frameToStage(frame: { w: number; h: number }, fit: FitMode): { scale: number; dx: number; dy: number } {
  const sx = STAGE.width / frame.w;
  const sy = STAGE.height / frame.h;
  const scale = fit === 'contain' ? Math.min(sx, sy) : Math.max(sx, sy);
  return { scale, dx: (STAGE.width - frame.w * scale) / 2, dy: (STAGE.height - frame.h * scale) / 2 };
}

export function mapBox(b: Box, t: { scale: number; dx: number; dy: number }): Box {
  return { x: t.dx + b.x * t.scale, y: t.dy + b.y * t.scale, w: b.w * t.scale, h: b.h * t.scale };
}

// ───────────── imported design records ─────────────

export const designFidelity = z.enum(['editable', 'flattened', 'reference', 'needs-review']);
export type DesignFidelity = z.infer<typeof designFidelity>;

export const FIDELITY_LABELS: Record<DesignFidelity, string> = {
  editable: 'Editable',
  flattened: 'Flattened artwork',
  reference: 'Reference only',
  'needs-review': 'Needs review',
};

export const designElementSchema = z.object({
  /** Figma node id, or a synthetic id for exported screens. */
  id: z.string().max(120),
  name: z.string().max(160),
  type: z.string().max(40),
  kind: z.enum(['text', 'rect', 'image', 'artwork', 'group', 'other']),
  fidelity: designFidelity,
  box: boxSchema,
  rotation: z.number(),
  opacity: z.number().min(0).max(1),
  z: z.number().int(),
  depth: z.number().int().min(0).max(64),
  parentId: z.string().max(120).nullable(),
  text: z
    .object({
      characters: z.string().max(4000),
      fontFamily: z.string().max(120),
      fontStyle: z.string().max(80),
      fontWeight: z.number().int(),
      fontSize: z.number(),
      lineHeightPx: z.number().nullable(),
      align: z.enum(['left', 'center', 'right', 'justified']),
      color: hexColor.nullable(),
      mixedStyles: z.boolean(),
    })
    .nullable(),
  fill: hexColor.nullable(),
  cornerRadius: z.number().nullable(),
  stroke: z.object({ color: hexColor, weight: z.number() }).nullable(),
  imageRef: z.string().max(200).nullable(),
  /** Imported image (image fill or flattened render), stored in the project library. */
  assetId: z.string().max(64).nullable(),
  /** Text baked into flattened artwork, so the game does not show it twice. */
  bakedText: z.boolean(),
  notes: z.array(z.string().max(240)).max(8),
});
export type DesignElement = z.infer<typeof designElementSchema>;

export const prototypeEvidenceSchema = z.object({
  nodeId: z.string().max(120),
  nodeName: z.string().max(160),
  trigger: z.string().max(40),
  action: z.string().max(40),
  destinationId: z.string().max(120).nullable(),
  navigation: z.string().max(40).nullable(),
  transition: z.object({ type: z.string().max(40), durationMs: z.number().nullable(), direction: z.string().max(20).nullable() }).nullable(),
});
export type PrototypeEvidence = z.infer<typeof prototypeEvidenceSchema>;

export const fontUseSchema = z.object({
  family: z.string().max(120),
  style: z.string().max(80),
  count: z.number().int(),
  available: z.boolean(),
  substitute: z.string().max(80).nullable(),
});

export const designFrameSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  importId: z.string(),
  nodeId: z.string().nullable(),
  name: z.string(),
  pageName: z.string().nullable(),
  width: z.number(),
  height: z.number(),
  source: z.enum(['figma', 'exported']),
  /** Flattened render of the whole frame (reference / flattened artwork). */
  renderAssetId: z.string().nullable(),
  backgroundColor: hexColor.nullable(),
  elements: z.array(designElementSchema),
  fonts: z.array(fontUseSchema),
  prototype: z.array(prototypeEvidenceSchema),
  warnings: z.array(z.string()),
  checksum: z.string(),
  createdAt: z.string(),
});
export type DesignFrame = z.infer<typeof designFrameSchema>;

export const designDiffSchema = z.object({
  framesAdded: z.array(z.object({ nodeId: z.string(), name: z.string() })),
  framesRemoved: z.array(z.object({ nodeId: z.string(), name: z.string() })),
  framesChanged: z.array(z.object({ nodeId: z.string(), name: z.string(), changes: z.array(z.string()) })),
  unchanged: z.number().int(),
});
export type DesignDiff = z.infer<typeof designDiffSchema>;

/** A frame offered for selection after browsing a Figma file (not imported yet). */
export const availableFrameSchema = z.object({
  nodeId: z.string().max(120),
  name: z.string().max(200),
  pageName: z.string().max(200),
  type: z.string().max(40),
  width: z.number(),
  height: z.number(),
  childCount: z.number().int(),
  /** Thumbnail file relative to the project directory, when the render succeeded. */
  thumbFile: z.string().max(300).nullable(),
  thumbError: z.string().max(200).nullable(),
});
export type AvailableFrame = z.infer<typeof availableFrameSchema>;

export const designFrameSummarySchema = designFrameSchema
  .pick({ id: true, importId: true, nodeId: true, name: true, pageName: true, width: true, height: true, source: true, renderAssetId: true, checksum: true, createdAt: true })
  .extend({
    elementCount: z.number().int(),
    fidelity: z.record(designFidelity, z.number().int()),
    warningCount: z.number().int(),
  });
export type DesignFrameSummary = z.infer<typeof designFrameSummarySchema>;

export const designImportStatus = z.enum(['browsing', 'importing', 'active', 'pending-review', 'superseded', 'rejected', 'failed']);
export type DesignImportStatus = z.infer<typeof designImportStatus>;

export const designImportSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  kind: z.enum(['figma', 'exported']),
  /**
   * browsing: frames listed for selection; importing: snapshot job running; active: in use;
   * pending-review: a refresh waiting for approval; superseded / rejected: history; failed: see error.
   */
  status: designImportStatus,
  fileKey: z.string().nullable(),
  branchKey: z.string().nullable(),
  requestedNodeId: z.string().nullable(),
  /** Canonical link rebuilt from validated identifiers (never the pasted text). */
  link: z.string().nullable(),
  fileName: z.string(),
  editorType: z.string().nullable(),
  sourceVersion: z.string().nullable(),
  lastModified: z.string().nullable(),
  accessRole: z.string().nullable(),
  previousImportId: z.string().nullable(),
  available: z.array(availableFrameSchema),
  diff: designDiffSchema.nullable(),
  warnings: z.array(z.string()),
  error: z.string().nullable(),
  frames: z.array(designFrameSummarySchema),
  revision: z.number().int(),
  createdAt: z.string(),
  importedAt: z.string().nullable(),
  approvedAt: z.string().nullable(),
});
export type DesignImport = z.infer<typeof designImportSchema>;

// ───────────── Figma links ─────────────

export const FIGMA_HOSTS = ['www.figma.com', 'figma.com'] as const;

export type FigmaLink =
  | { ok: true; fileKey: string; nodeId: string | null; branchKey: string | null; kind: 'design' | 'file' | 'proto'; apiKey: string }
  | { ok: false; reason: string; hint: string };

const UNSUPPORTED_KINDS: Record<string, string> = {
  board: 'FigJam boards',
  slides: 'Figma Slides decks',
  deck: 'Figma Slides decks',
  make: 'Figma Make files',
  site: 'Figma Sites',
  sites: 'Figma Sites',
  buzz: 'Figma Buzz files',
};

/**
 * Validate a pasted Figma link and extract identifiers. Only figma.com Design
 * file/frame links are accepted; the API request is later built from these
 * identifiers, never from the pasted URL.
 */
export function parseFigmaUrl(raw: string): FigmaLink {
  const fail = (reason: string, hint = 'In Figma, right-click a frame → Copy/Paste as → Copy link to selection, then paste it here.'): FigmaLink => ({ ok: false, reason, hint });
  const text = raw.trim();
  if (text.length > 2048) return fail('That link is too long to be a Figma link.');
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return fail('That is not a web link.');
  }
  if (url.protocol !== 'https:') return fail('Figma links start with https://.');
  if (url.username || url.password || url.port) return fail('That is not a figma.com link.');
  if (!(FIGMA_HOSTS as readonly string[]).includes(url.hostname)) return fail('Only figma.com links are supported.');
  const parts = url.pathname.split('/').filter(Boolean);
  const kind = parts[0] ?? '';
  if (UNSUPPORTED_KINDS[kind]) {
    return fail(`${UNSUPPORTED_KINDS[kind]} are not supported.`, 'Use a Figma Design file, or export the screens as PNG/JPEG/SVG and upload them instead.');
  }
  if (kind !== 'design' && kind !== 'file' && kind !== 'proto') return fail('That is not a link to a Figma Design file.');
  const fileKey = parts[1] ?? '';
  if (!/^[A-Za-z0-9]{10,64}$/.test(fileKey)) return fail('The link does not contain a valid file key.');
  let branchKey: string | null = null;
  if (parts[2] === 'branch') {
    branchKey = parts[3] ?? '';
    if (!/^[A-Za-z0-9]{10,64}$/.test(branchKey)) return fail('The branch part of the link is not valid.');
  }
  const rawNode = url.searchParams.get('node-id');
  let nodeId: string | null = null;
  if (rawNode !== null && rawNode !== '') {
    // URLs write node ids as 1-2; the API expects 1:2.
    const m = /^(\d{1,12})[-:](\d{1,12})$/.exec(rawNode);
    if (!m) return fail('The node-id in the link is not a frame id I can use.', 'Copy the link from a top-level frame rather than a layer inside a component instance.');
    nodeId = `${m[1]}:${m[2]}`;
  }
  return { ok: true, fileKey, nodeId, branchKey, kind, apiKey: branchKey ?? fileKey };
}
