import type { DesignElement, DesignFidelity, PrototypeEvidence } from '@shared/schemas/design.ts';
import type { FigmaNode } from './client.ts';

/**
 * Turn a Figma frame (REST node JSON) into a DesignFrameSnapshot: a flat list
 * of elements in frame coordinates, each classified against the declared
 * editable subset:
 *
 *   Editable          unrotated rectangles/frames with one solid fill, single-style
 *                     text with a solid colour, and image placements (fill/fit)
 *   Flattened artwork vectors, gradients, boolean shapes — usable only as images
 *   Reference only    containers and things the game never rebuilds
 *   Needs review      rotation, masks, crops/tiling, effects, mixed text styles,
 *                     clipping — shown to the creator, never silently converted
 *
 * Prototype links and transitions are collected as design evidence only.
 * Text, names and URLs inside the file are treated as data (URLs are dropped).
 */

/** Fonts the game runtime ships (open-licence fonts bundled with the studio). */
export const RUNTIME_FONTS = ['Nunito', 'Inter', 'Space Grotesk'] as const;

const MAX_ELEMENTS = 400;
const MAX_DEPTH = 14;

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Paint {
  type?: string;
  visible?: boolean;
  opacity?: number;
  color?: { r: number; g: number; b: number; a?: number };
  imageRef?: string;
  scaleMode?: string;
  imageTransform?: number[][];
}

export interface SnapshotResult {
  backgroundColor: string | null;
  elements: DesignElement[];
  fonts: Array<{ family: string; style: string; count: number; available: boolean; substitute: string | null }>;
  prototype: PrototypeEvidence[];
  warnings: string[];
  /** imageRefs of editable image placements (to import as assets when approved). */
  imageRefs: string[];
}

const hex2 = (n: number) => Math.round(Math.max(0, Math.min(1, n)) * 255).toString(16).padStart(2, '0');
export function colorHex(c: { r: number; g: number; b: number } | undefined): string | null {
  if (!c || [c.r, c.g, c.b].some((v) => typeof v !== 'number' || !Number.isFinite(v))) return null;
  return `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`;
}

function box(n: FigmaNode): Box | null {
  const b = n.absoluteBoundingBox as Box | null | undefined;
  if (!b || ![b.x, b.y, b.width, b.height].every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
  return b;
}

const visiblePaints = (paints: unknown): Paint[] => (Array.isArray(paints) ? (paints as Paint[]).filter((p) => p && p.visible !== false && (p.opacity ?? 1) > 0) : []);
const visibleEffects = (n: FigmaNode) => (Array.isArray(n.effects) ? (n.effects as Array<{ visible?: boolean; type?: string }>).filter((e) => e && e.visible !== false) : []);

export function substituteFont(family: string): string | null {
  if ((RUNTIME_FONTS as readonly string[]).includes(family)) return null;
  const f = family.toLowerCase();
  if (/(round|nunito|quicksand|comic|baloo|fredoka|varela)/.test(f)) return 'Nunito';
  if (/(grotesk|mono|display|tech|orbitron|exo)/.test(f)) return 'Space Grotesk';
  return 'Inter';
}

function textAlign(v: unknown): 'left' | 'center' | 'right' | 'justified' {
  return v === 'CENTER' ? 'center' : v === 'RIGHT' ? 'right' : v === 'JUSTIFIED' ? 'justified' : 'left';
}

const ARTWORK = new Set(['VECTOR', 'STAR', 'LINE', 'ELLIPSE', 'REGULAR_POLYGON', 'POLYGON', 'BOOLEAN_OPERATION']);
const CONTAINERS = new Set(['FRAME', 'GROUP', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE', 'SECTION']);

export function snapshotFrame(frame: FigmaNode): SnapshotResult {
  const frameBox = box(frame) ?? { x: 0, y: 0, width: Number((frame.size as { x?: number })?.x ?? 1), height: Number((frame.size as { y?: number })?.y ?? 1) };
  const elements: DesignElement[] = [];
  const prototype: PrototypeEvidence[] = [];
  const warnings: string[] = [];
  const fonts = new Map<string, { family: string; style: string; count: number }>();
  const imageRefs = new Set<string>();
  let truncated = false;
  let hidden = 0;
  let z = 0;

  const frameFills = visiblePaints(frame.fills);
  const bg = typeof frame.backgroundColor === 'object' ? colorHex(frame.backgroundColor as Paint['color']) : null;
  const backgroundColor = frameFills.find((p) => p.type === 'SOLID') ? colorHex(frameFills.find((p) => p.type === 'SOLID')!.color) : bg;

  const evidence = (n: FigmaNode) => {
    for (const it of Array.isArray(n.interactions) ? (n.interactions as Array<{ trigger?: { type?: string }; actions?: Array<Record<string, unknown>> }>) : []) {
      for (const a of it.actions ?? []) {
        const t = a.transition as { type?: string; duration?: number; direction?: string } | null | undefined;
        prototype.push({
          nodeId: n.id,
          nodeName: String(n.name).slice(0, 160),
          trigger: String(it.trigger?.type ?? 'UNKNOWN').slice(0, 40),
          action: String(a.type ?? 'UNKNOWN').slice(0, 40),
          // URL actions are recorded as evidence only; the URL itself is never kept or followed.
          destinationId: typeof a.destinationId === 'string' ? a.destinationId.slice(0, 120) : null,
          navigation: typeof a.navigation === 'string' ? a.navigation.slice(0, 40) : null,
          transition: t ? { type: String(t.type ?? 'UNKNOWN').slice(0, 40), durationMs: typeof t.duration === 'number' ? Math.round(t.duration * 1000) : null, direction: typeof t.direction === 'string' ? t.direction.slice(0, 20) : null } : null,
        });
        if (prototype.length >= 60) return;
      }
    }
  };

  const walk = (n: FigmaNode, depth: number, parentId: string | null, clip: Box | null, parentOpacity: number) => {
    if (elements.length >= MAX_ELEMENTS) {
      truncated = true;
      return;
    }
    if (n.visible === false) {
      hidden++;
      return;
    }
    evidence(n);
    const b = box(n);
    const opacity = Math.max(0, Math.min(1, (typeof n.opacity === 'number' ? n.opacity : 1) * parentOpacity));
    const rotation = typeof n.rotation === 'number' ? n.rotation : 0;
    const rotated = Math.abs(rotation) > 0.001;
    const effects = visibleEffects(n);
    const blend = typeof n.blendMode === 'string' ? n.blendMode : 'PASS_THROUGH';
    const fills = visiblePaints(n.fills);
    const strokes = visiblePaints(n.strokes);
    const notes: string[] = [];
    let kind: DesignElement['kind'];
    let fidelity: DesignFidelity;

    if (n.type === 'TEXT') kind = 'text';
    else if (fills.length >= 1 && fills.every((p) => p.type === 'IMAGE') && n.type !== 'TEXT') kind = 'image';
    else if (ARTWORK.has(n.type)) kind = 'artwork';
    else if (n.type === 'RECTANGLE' || (CONTAINERS.has(n.type) && fills.length > 0)) kind = 'rect';
    else if (CONTAINERS.has(n.type)) kind = 'group';
    else kind = 'other';

    const common: string[] = [];
    if (rotated) common.push('Rotated — rotation must be reviewed before it can be rebuilt.');
    if (n.isMask === true) common.push('Used as a mask — flatten the masked group in Figma or use it as artwork.');
    if (effects.length) common.push(`Has ${effects.map((e) => (e.type ?? 'effect').toLowerCase().replace(/_/g, ' ')).join(', ')} — effects are not rebuilt; keep it as flattened artwork.`);
    if (!['PASS_THROUGH', 'NORMAL'].includes(blend)) common.push(`Blend mode ${blend.toLowerCase()} is not rebuilt.`);

    let text: DesignElement['text'] = null;
    let fill: string | null = null;
    let imageRef: string | null = null;
    if (kind === 'text') {
      const style = (n.style ?? {}) as Record<string, unknown>;
      const overrides = Array.isArray(n.characterStyleOverrides) ? (n.characterStyleOverrides as number[]).some((v) => v !== 0) : false;
      const table = n.styleOverrideTable && typeof n.styleOverrideTable === 'object' ? Object.keys(n.styleOverrideTable as object).length : 0;
      const mixed = overrides && table > 0;
      const solid = fills.length === 1 && fills[0]!.type === 'SOLID';
      const family = String(style.fontFamily ?? '').slice(0, 120);
      const fstyle = String(style.fontStyle ?? (style.italic ? 'Italic' : 'Regular')).slice(0, 80);
      text = {
        characters: String(n.characters ?? '').slice(0, 4000),
        fontFamily: family,
        fontStyle: fstyle,
        fontWeight: Math.round(Number(style.fontWeight ?? 400)) || 400,
        fontSize: Number(style.fontSize ?? 16) || 16,
        lineHeightPx: typeof style.lineHeightPx === 'number' ? style.lineHeightPx : null,
        align: textAlign(style.textAlignHorizontal),
        color: solid ? colorHex(fills[0]!.color) : null,
        mixedStyles: mixed,
      };
      if (family) {
        const key = `${family}|${fstyle}`;
        const f = fonts.get(key) ?? { family, style: fstyle, count: 0 };
        f.count++;
        fonts.set(key, f);
      }
      if (mixed) notes.push('Mixed text styles — the game shows one style; review it.');
      if (!solid) notes.push('Text colour is not a single solid fill.');
      fidelity = common.length || mixed || !solid ? 'needs-review' : 'editable';
    } else if (kind === 'image') {
      const p = fills[0]!;
      imageRef = typeof p.imageRef === 'string' ? p.imageRef.slice(0, 200) : null;
      const mode = p.scaleMode ?? 'FILL';
      const transformed = Array.isArray(p.imageTransform) && JSON.stringify(p.imageTransform) !== JSON.stringify([[1, 0, 0], [0, 1, 0]]);
      if (fills.length > 1) notes.push('Several image fills are stacked — only a flattened render keeps them.');
      if (mode === 'TILE' || mode === 'CROP' || transformed) notes.push(`Image ${mode === 'TILE' ? 'tiling' : 'crop'} must be reviewed — the game shows the whole image fitted to its box.`);
      fidelity = common.length || fills.length > 1 || mode === 'TILE' || mode === 'CROP' || transformed ? 'needs-review' : imageRef ? 'editable' : 'needs-review';
      if (!imageRef) notes.push('The image reference is missing from the file data.');
      if (fidelity === 'editable' && imageRef) imageRefs.add(imageRef);
    } else if (kind === 'rect') {
      const solid = fills.length === 1 && fills[0]!.type === 'SOLID';
      fill = solid ? colorHex(fills[0]!.color) : null;
      if (!solid) notes.push(fills.some((p) => p.type?.startsWith('GRADIENT')) ? 'Gradient fill — kept as flattened artwork.' : 'Several or non-solid fills — kept as flattened artwork.');
      if (strokes.length > 1 || (strokes[0] && strokes[0].type !== 'SOLID')) notes.push('Complex stroke — kept as flattened artwork.');
      fidelity = common.length ? 'needs-review' : !solid || strokes.length > 1 || (strokes[0] && strokes[0].type !== 'SOLID') ? 'flattened' : 'editable';
    } else if (kind === 'artwork') {
      notes.push('Vector artwork — usable as a flattened image only.');
      fidelity = common.length ? 'needs-review' : 'flattened';
    } else if (kind === 'group') {
      fidelity = 'reference';
    } else {
      notes.push(`${n.type} layers are not rebuilt in the game.`);
      fidelity = 'reference';
    }
    notes.unshift(...common);

    // Clipping: partly outside a clipping ancestor → review.
    if (b && clip) {
      const outside = b.x < clip.x - 0.5 || b.y < clip.y - 0.5 || b.x + b.width > clip.x + clip.width + 0.5 || b.y + b.height > clip.y + clip.height + 0.5;
      if (outside && fidelity !== 'reference') {
        notes.push('Partly clipped by its frame — the visible part must be reviewed.');
        if (fidelity === 'editable') fidelity = 'needs-review';
      }
    }

    if (b && b.width > 0 && b.height > 0 && depth > 0) {
      const radius = typeof n.cornerRadius === 'number' ? n.cornerRadius : null;
      const stroke = strokes[0]?.type === 'SOLID' ? { color: colorHex(strokes[0].color) ?? '#000000', weight: typeof n.strokeWeight === 'number' ? n.strokeWeight : 1 } : null;
      elements.push({
        id: n.id.slice(0, 120),
        name: String(n.name).slice(0, 160),
        type: n.type.slice(0, 40),
        kind,
        fidelity,
        box: { x: b.x - frameBox.x, y: b.y - frameBox.y, w: b.width, h: b.height },
        rotation,
        opacity,
        z: z++,
        depth: Math.min(depth, 64),
        parentId,
        text,
        fill,
        cornerRadius: radius,
        stroke,
        imageRef,
        assetId: null,
        bakedText: false,
        notes: notes.slice(0, 8).map((s) => s.slice(0, 240)),
      });
    }
    if (depth >= MAX_DEPTH) {
      if (n.children?.length) warnings.push(`Layers nested deeper than ${MAX_DEPTH} levels inside “${String(n.name).slice(0, 60)}” were not read.`);
      return;
    }
    const clipsChildren = n.clipsContent === true && b ? b : clip;
    for (const child of n.children ?? []) walk(child, depth + 1, depth === 0 ? null : n.id, clipsChildren, opacity);
  };

  walk(frame, 0, null, null, 1);
  if (truncated) warnings.push(`Only the first ${MAX_ELEMENTS} layers were read; simplify the frame or use it as flattened artwork.`);
  if (hidden) warnings.push(`${hidden} hidden layer${hidden === 1 ? ' was' : 's were'} skipped.`);

  const fontList = [...fonts.values()].map((f) => {
    const substitute = substituteFont(f.family);
    return { ...f, available: substitute === null, substitute };
  });
  for (const f of fontList.filter((x) => !x.available)) {
    warnings.push(`Font “${f.family}” is not packaged with the game, and design fonts are never redistributed — “${f.substitute}” is used instead.`);
  }
  if (prototype.length) warnings.push(`${prototype.length} prototype interaction${prototype.length === 1 ? '' : 's'} recorded as design evidence only — they do not become gameplay.`);
  return { backgroundColor, elements, fonts: fontList, prototype, warnings: warnings.slice(0, 40), imageRefs: [...imageRefs].slice(0, 24) };
}

/** Top-level frames offered for selection: pages → frames/components/sections (sections are expanded). */
export function listFrames(document: FigmaNode, only: string | null): Array<{ node: FigmaNode; pageName: string }> {
  const out: Array<{ node: FigmaNode; pageName: string }> = [];
  const take = (n: FigmaNode, pageName: string) => {
    if (n.type === 'SECTION') {
      for (const c of n.children ?? []) take(c, pageName);
      return;
    }
    if (['FRAME', 'COMPONENT', 'INSTANCE', 'COMPONENT_SET'].includes(n.type) && n.visible !== false) out.push({ node: n, pageName });
  };
  for (const page of document.children ?? []) {
    if (page.type !== 'CANVAS') continue;
    for (const c of page.children ?? []) take(c, String(page.name));
  }
  if (only) {
    const hit = out.filter((f) => f.node.id === only);
    if (hit.length) return hit;
  }
  return out.slice(0, 200);
}
