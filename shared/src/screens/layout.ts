import type { DesignElement, DesignFrame, DesignLayer, SceneDesign } from '../schemas/design.ts';
import type { ScreenLayout } from '../schemas/proposal.ts';
import type { ScreenMapEntry, SourceScreenMapping } from '../schemas/screens.ts';

/**
 * Turn a reviewed Source-to-Screen map row into game layout data. Only the
 * declared editable subset becomes layers (text, solid rectangles, image
 * placements); the native instruction panel, controls and game logic are
 * always built by the runtime, positioned in the chosen regions.
 */

export interface LayoutAsset {
  id: string;
  kind: 'image' | 'audio';
  sprite: { clips: Array<{ name: string }> } | null;
}

export interface LayoutContext {
  frames: Map<string, DesignFrame>;
  assets: Map<string, LayoutAsset>;
  slideIds: Set<string>;
  /** Game screens of the blueprint: title, scene ids, completion. */
  screens: Array<{ id: string; kind: ScreenMapEntry['kind'] }>;
}

export interface LayoutResult {
  layout: ScreenLayout;
  /** Learner-facing wording that comes from Figma or a reviewed creator correction. */
  wording: { instruction?: string; title?: string };
  warnings: string[];
}

const LETTERBOX = '#0b1626';

export function layerIdFor(elementId: string): string {
  return `el-${elementId.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 40)}`;
}

function inside(a: DesignElement['box'], b: DesignElement['box']): boolean {
  return a.x >= b.x - 1 && a.y >= b.y - 1 && a.x + a.w <= b.x + b.w + 1 && a.y + a.h <= b.y + b.h + 1;
}

export function primaryFrame(entry: ScreenMapEntry, frames: Map<string, DesignFrame>): DesignFrame | null {
  const link = entry.frames.find((f) => f.primary) ?? entry.frames[0];
  return link ? (frames.get(link.frameId) ?? null) : null;
}

function backgroundAsset(entry: ScreenMapEntry, ctx: LayoutContext): string | null {
  const bg = entry.background;
  if (bg.kind === 'asset') return bg.assetId;
  if (bg.kind === 'frame-render') return bg.frameId ? (ctx.frames.get(bg.frameId)?.renderAssetId ?? null) : null;
  if (bg.kind === 'frame-element') {
    const f = bg.frameId ? ctx.frames.get(bg.frameId) : null;
    return f?.elements.find((e) => e.id === bg.elementId)?.assetId ?? null;
  }
  return null;
}

export function computeScreenLayout(entry: ScreenMapEntry, ctx: LayoutContext): LayoutResult {
  const warnings: string[] = [];
  const wording: LayoutResult['wording'] = {};
  const frame = primaryFrame(entry, ctx.frames);
  const bgAsset = backgroundAsset(entry, ctx);
  const reviewedCorrections = entry.corrections.filter((c) => c.reviewed);
  if (entry.corrections.length > reviewedCorrections.length) warnings.push(`${entry.corrections.length - reviewedCorrections.length} correction(s) on “${entry.title}” wait for review and are not used yet.`);

  let design: SceneDesign | null = null;
  if (entry.roles.layout === 'figma' && frame) {
    const byId = new Map(frame.elements.map((e) => [e.id, e]));
    const layers: DesignLayer[] = [];
    let instructionRegion: DesignElement['box'] | null = null;
    let playRegion: DesignElement['box'] | null = null;
    for (const choice of entry.layers) {
      const e = byId.get(choice.elementId);
      if (!e) continue;
      if (choice.use === 'instruction-region') instructionRegion = e.box;
      if (choice.use === 'play-region') playRegion = e.box;
      if (choice.use !== 'layer') continue;
      if (e.fidelity === 'needs-review') warnings.push(`“${e.name}” was marked “Needs review” and is included because you chose it.`);
      const base = { id: layerIdFor(e.id), name: e.name.slice(0, 80), box: e.box, rotation: 0, opacity: e.opacity, z: e.z, fill: null, radius: null, stroke: null, assetId: null, text: null };
      if (e.kind === 'text' && e.text) {
        const correction = reviewedCorrections.find((c) => c.field === 'label' && c.elementId === e.id);
        const font = frame.fonts.find((f) => f.family === e.text!.fontFamily);
        layers.push({
          ...base,
          kind: 'text',
          text: {
            content: (correction?.after ?? e.text.characters).trim().slice(0, 600) || e.name.slice(0, 40),
            fontFamily: (font?.available ? e.text.fontFamily : (font?.substitute ?? 'Inter')).slice(0, 80),
            fontSize: Math.max(6, Math.min(400, e.text.fontSize)),
            fontWeight: Math.max(100, Math.min(900, Math.round(e.text.fontWeight / 100) * 100 || 400)),
            align: e.text.align,
            color: e.text.color ?? '#0f2740',
            substituted: font ? !font.available : false,
          },
        });
      } else if (e.kind === 'rect' && e.fill) {
        layers.push({ ...base, kind: 'rect', fill: e.fill, radius: e.cornerRadius !== null ? Math.max(0, Math.min(2000, e.cornerRadius)) : null, stroke: e.stroke ? { color: e.stroke.color, width: Math.max(0, Math.min(64, e.stroke.weight)) } : null });
      } else if (e.kind === 'image' && e.assetId) {
        layers.push({ ...base, kind: 'image', assetId: e.assetId });
      } else {
        warnings.push(`“${e.name}” (${e.kind}) is not in the editable subset, so it stays a reference. Use it through a flattened background or an uploaded image instead.`);
      }
      if (layers.length >= 60) {
        warnings.push('At most 60 design layers per screen are kept.');
        break;
      }
    }
    design = {
      frameId: frame.id,
      source: frame.source,
      mode: entry.designMode,
      fit: entry.fit,
      frameSize: { w: frame.width, h: frame.height },
      letterbox: frame.backgroundColor ?? LETTERBOX,
      backgroundAssetId: bgAsset,
      layers,
      regions: { instruction: instructionRegion, play: playRegion },
    };
    if (entry.roles.content === 'figma') {
      const texts = frame.elements.filter((e) => e.kind === 'text' && e.text && e.text.characters.trim());
      const inRegion = instructionRegion ? texts.filter((t) => inside(t.box, instructionRegion!)) : texts;
      const instruction = inRegion.filter((t) => !/title|heading/i.test(t.name)).sort((a, b) => b.text!.characters.length - a.text!.characters.length)[0];
      const title = texts.find((t) => /title|heading/i.test(t.name));
      if (instruction) wording.instruction = instruction.text!.characters.trim().slice(0, 300);
      if (title) wording.title = title.text!.characters.trim().slice(0, 60);
    }
  } else if (entry.roles.layout === 'figma' && !frame) {
    warnings.push(`“${entry.title}” uses the Figma layout but has no frame linked; the built-in layout is used.`);
  } else if (bgAsset && entry.kind !== 'scene') {
    // Title and completion screens take a chosen background through a minimal design.
    design = { frameId: null, source: 'creator', mode: 'match', fit: 'cover', frameSize: { w: 1920, h: 1080 }, letterbox: LETTERBOX, backgroundAssetId: bgAsset, layers: [], regions: { instruction: null, play: null } };
  }

  // Creator wording (content role “My wording”) and conflict resolutions with custom text.
  for (const c of reviewedCorrections) {
    if (c.field === 'instruction') wording.instruction = c.after.slice(0, 300);
    if (c.field === 'title') wording.title = c.after.slice(0, 60);
  }
  for (const c of entry.conflicts) {
    if (c.status === 'resolved' && c.resolution?.choice === 'custom' && c.resolution.text && c.kind === 'instruction') wording.instruction = c.resolution.text.slice(0, 300);
  }

  const layout: ScreenLayout = {
    design,
    objects: entry.objects,
    addAssets: [],
    ...(entry.assets.character ? { character: entry.assets.character, characterClip: entry.assets.characterClip } : {}),
    ...(entry.kind === 'scene' ? { panel: entry.assets.panel, button: entry.assets.button, ...(bgAsset ? { background: bgAsset } : {}) } : {}),
  };
  return { layout, wording, warnings };
}

export interface MappingCheck {
  errors: string[];
  warnings: string[];
}

/** Everything a saved map must satisfy; warnings are shown to the creator but do not block saving. */
export function validateMapping(mapping: SourceScreenMapping, ctx: LayoutContext): MappingCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  const known = new Map(ctx.screens.map((s) => [s.id, s.kind]));
  const seen = new Set<string>();
  const image = (id: string | null | undefined, what: string) => {
    if (!id) return;
    const a = ctx.assets.get(id);
    if (!a) errors.push(`${what}: the asset is not in this project.`);
    else if (a.kind !== 'image') errors.push(`${what}: choose an image, not ${a.kind}.`);
  };
  for (const s of mapping.screens) {
    const where = `“${s.title}”`;
    if (seen.has(s.screenId)) errors.push(`${where} appears twice.`);
    seen.add(s.screenId);
    const kind = known.get(s.screenId);
    if (!kind) {
      errors.push(`${where} is not a screen of the current blueprint.`);
      continue;
    }
    if (kind !== s.kind) errors.push(`${where} is a ${kind} screen.`);
    for (const id of s.slideIds) if (!ctx.slideIds.has(id)) errors.push(`${where} links a slide that is not in this project.`);
    if (s.frames.filter((f) => f.primary).length > 1) errors.push(`${where} has more than one primary frame.`);
    const states = new Set<string>();
    for (const l of s.frames) {
      if (!ctx.frames.has(l.frameId)) errors.push(`${where} links a design frame that no longer exists.`);
      if (states.has(l.state)) errors.push(`${where} uses the state name “${l.state}” twice.`);
      states.add(l.state);
    }
    const frame = primaryFrame(s, ctx.frames);
    if (s.roles.layout === 'figma' && !frame) errors.push(`${where} uses the Figma layout but no frame is linked. Link a frame or choose the built-in layout.`);
    if (s.roles.content === 'figma' && !frame) errors.push(`${where} takes its wording from Figma but no frame is linked.`);
    for (const c of s.layers) {
      const e = frame?.elements.find((x) => x.id === c.elementId);
      if (!e) {
        errors.push(`${where}: a chosen layer is not in its primary frame.`);
        continue;
      }
      const conflict = s.conflicts.find((x) => x.figmaElementId === e.id);
      if (c.use === 'layer' && conflict?.status === 'resolved' && conflict.resolution?.choice === 'ppt') {
        errors.push(`${where}: “${e.name}” conflicts with the lesson and you chose the PowerPoint wording, so it cannot be shown as a layer.`);
      } else if (c.use === 'layer' && conflict?.status === 'open') {
        warnings.push(`${where}: “${e.name}” has an unresolved conflict with the lesson.`);
      }
    }
    const bg = s.background;
    if (bg.kind === 'asset') image(bg.assetId, `${where} background`);
    if (bg.kind === 'frame-render' || bg.kind === 'frame-element') {
      const f = bg.frameId ? ctx.frames.get(bg.frameId) : null;
      if (!f) errors.push(`${where}: the background frame no longer exists.`);
      else if (bg.kind === 'frame-render') {
        if (!f.renderAssetId) errors.push(`${where}: that frame has no rendered picture to use as a background.`);
        const texts = f.elements.filter((e) => e.kind === 'text' || e.bakedText);
        if (!bg.confirmedClean && texts.length) {
          warnings.push(
            f.source === 'exported'
              ? `${where}: the background is an exported screen — any text or buttons in it would appear twice next to the game's own. Confirm it is clean, or upload a clean background.`
              : `${where}: the background picture includes ${texts.length} text layer(s) (e.g. “${(texts[0]!.text?.characters ?? texts[0]!.name).slice(0, 40)}”) that would appear twice. Ask for a clean background layer, or confirm it is clean.`,
          );
        }
      } else {
        const e = f.elements.find((x) => x.id === bg.elementId);
        if (!e?.assetId) errors.push(`${where}: that design layer has no imported image to use as a background.`);
      }
    }
    image(s.assets.character, `${where} character`);
    if (s.assets.characterClip) {
      const a = s.assets.character ? ctx.assets.get(s.assets.character) : null;
      if (!a?.sprite) errors.push(`${where}: a clip needs a sprite character; a static picture has no frames.`);
      else if (!a.sprite.clips.some((c) => c.name === s.assets.characterClip)) errors.push(`${where}: the character has no clip named “${s.assets.characterClip}”.`);
    }
    image(s.assets.panel, `${where} panel`);
    image(s.assets.button, `${where} button`);
    const objectIds = new Set<string>();
    for (const o of s.objects) {
      image(o.assetId, `${where} object “${o.label}”`);
      if (objectIds.has(o.id)) errors.push(`${where}: two objects share the id ${o.id}.`);
      objectIds.add(o.id);
      if (o.clip) {
        const a = ctx.assets.get(o.assetId);
        if (!a?.sprite?.clips.some((c) => c.name === o.clip)) errors.push(`${where}: object “${o.label}” has no clip named “${o.clip}”.`);
      }
    }
    const open = s.conflicts.filter((c) => c.status === 'open').length;
    if (open) warnings.push(`${where}: ${open} source conflict(s) to resolve.`);
  }
  for (const s of ctx.screens) if (!seen.has(s.id)) warnings.push(`Screen ${s.id} is not in the map yet.`);
  return { errors, warnings };
}
