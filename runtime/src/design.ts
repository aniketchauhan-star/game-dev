import type { GameAsset } from '@shared/schemas/game.ts';
import { frameToStage, mapBox, type ObjectPlacement, type SceneDesign } from '@shared/schemas/design.ts';
import { h } from './dom.ts';
import type { Clock } from './motion/clock.ts';
import { SpriteView } from './motion/sprite.ts';

/**
 * Imported design, rendered as data. The frame keeps its aspect ratio (never
 * stretched): letterboxed (“contain”) or cropped (“cover”). Only declared
 * editable layers are rebuilt — text, solid rectangles and image placements —
 * and none of them is interactive: the native instruction panel, controls and
 * mechanics are always drawn on top by the runtime.
 */

export interface DesignCtx {
  assetUrl(id: string | null | undefined): string | null;
  assets: Record<string, GameAsset>;
  clock: Clock;
  /** Reduced motion: sprites show a still frame. */
  still: boolean;
  sprites: Map<string, SpriteView>;
}

const FONT_STACK: Record<string, string> = {
  Nunito: "'Nunito Variable', 'Nunito', ui-rounded, system-ui, sans-serif",
  Inter: "system-ui, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif",
  'Space Grotesk': "'Space Grotesk Variable', 'Space Grotesk', system-ui, sans-serif",
};

function place(el: HTMLElement, box: { x: number; y: number; w: number; h: number }): void {
  el.style.setProperty('left', `${box.x}px`);
  el.style.setProperty('top', `${box.y}px`);
  el.style.setProperty('width', `${box.w}px`);
  el.style.setProperty('height', `${box.h}px`);
}

export function designLayer(design: SceneDesign, ctx: DesignCtx): HTMLElement {
  const t = frameToStage(design.frameSize, design.fit);
  const root = h('div', { class: `nx-design nx-fit-${design.fit}`, attrs: { 'data-frame': design.frameId ?? 'creator' } });
  root.style.setProperty('background-color', design.letterbox);
  const frameBox = { x: t.dx, y: t.dy, w: design.frameSize.w * t.scale, h: design.frameSize.h * t.scale };
  const bg = ctx.assetUrl(design.backgroundAssetId);
  if (bg) {
    const img = h('img', { class: 'nx-design-bg', attrs: { src: bg, alt: '', 'data-entity': 'background', draggable: 'false' } });
    place(img, frameBox);
    root.appendChild(img);
  }
  for (const layer of [...design.layers].sort((a, b) => a.z - b.z)) {
    const box = mapBox(layer.box, t);
    let el: HTMLElement;
    if (layer.kind === 'text' && layer.text) {
      el = h('div', { class: `nx-dl-text nx-align-${layer.text.align === 'justified' ? 'left' : layer.text.align}`, text: layer.text.content });
      el.style.setProperty('font-size', `${Math.max(8, layer.text.fontSize * t.scale)}px`);
      el.style.setProperty('font-weight', String(layer.text.fontWeight));
      el.style.setProperty('color', layer.text.color);
      el.style.setProperty('text-align', layer.text.align === 'justified' ? 'justify' : layer.text.align);
      el.style.setProperty('font-family', FONT_STACK[layer.text.fontFamily] ?? FONT_STACK.Inter!);
    } else if (layer.kind === 'rect') {
      el = h('div', { class: 'nx-dl-rect', attrs: { 'aria-hidden': 'true' } });
      if (layer.fill) el.style.setProperty('background-color', layer.fill);
      if (layer.radius !== null) el.style.setProperty('border-radius', `${layer.radius * t.scale}px`);
      if (layer.stroke) el.style.setProperty('border', `${Math.max(1, layer.stroke.width * t.scale)}px solid ${layer.stroke.color}`);
    } else {
      const url = ctx.assetUrl(layer.assetId);
      if (!url) continue;
      el = h('img', { class: 'nx-dl-img', attrs: { src: url, alt: '', draggable: 'false' } });
    }
    el.setAttribute('data-entity', layer.id);
    place(el, box);
    if (layer.opacity < 1) el.style.setProperty('opacity', String(layer.opacity));
    root.appendChild(el);
  }
  return root;
}

/** Regions (frame coordinates) → stage boxes for the native instruction panel and play area. */
export function regionBoxes(design: SceneDesign): { instruction: { x: number; y: number; w: number; h: number } | null; play: { x: number; y: number; w: number; h: number } | null } {
  const t = frameToStage(design.frameSize, design.fit);
  const clampBox = (b: { x: number; y: number; w: number; h: number }) => {
    const x = Math.max(0, Math.min(1900, b.x));
    const y = Math.max(0, Math.min(1060, b.y));
    return { x, y, w: Math.max(240, Math.min(1920 - x, b.w)), h: Math.max(120, Math.min(1080 - y, b.h)) };
  };
  return {
    instruction: design.regions.instruction ? clampBox(mapBox(design.regions.instruction, t)) : null,
    play: design.regions.play ? clampBox(mapBox(design.regions.play, t)) : null,
  };
}

function spriteOrImage(assetId: string, ctx: DesignCtx, box: { width: number; height: number }, entity: string, clip: string | null, className: string): HTMLElement | null {
  const asset = ctx.assets[assetId];
  const url = ctx.assetUrl(assetId);
  if (!asset || !url) return null;
  if (asset.sprite) {
    const view = new SpriteView(asset, url, box, ctx.clock, ctx.still, className);
    view.setIdle(clip ?? (view.clip('idle') ? 'idle' : null));
    view.el.setAttribute('data-entity', entity);
    ctx.sprites.set(entity, view);
    return view.el;
  }
  const img = h('img', { class: className, attrs: { src: url, alt: '', draggable: 'false', 'data-entity': entity } });
  img.style.setProperty('width', `${box.width}px`);
  img.style.setProperty('height', `${box.height}px`);
  return img;
}

/** Creator-placed artwork (decorative, never interactive). */
export function objectsLayer(objects: ObjectPlacement[], ctx: DesignCtx, front: boolean): HTMLElement | null {
  const list = objects.filter((o) => (front ? o.z >= 0 : o.z < 0));
  if (list.length === 0) return null;
  const root = h('div', { class: `nx-objects${front ? ' nx-objects-front' : ''}`, attrs: { 'aria-hidden': 'true' } });
  for (const o of [...list].sort((a, b) => a.z - b.z)) {
    const el = spriteOrImage(o.assetId, ctx, { width: o.width, height: o.height }, o.id, o.clip, 'nx-object');
    if (!el) continue;
    el.style.setProperty('left', `${o.x}px`);
    el.style.setProperty('top', `${o.y}px`);
    if (o.rotation) el.style.setProperty('rotate', `${o.rotation}deg`);
    root.appendChild(el);
  }
  return root;
}

/** The scene's character (e.g. Swiftee) beside the instructions. On coordinate screens the character is the mover instead. */
export function characterGuide(assetId: string | null, clip: string | null, ctx: DesignCtx, size = 200): HTMLElement | null {
  if (!assetId) return null;
  return spriteOrImage(assetId, ctx, { width: size, height: size }, 'character', clip, 'nx-guide');
}

/** Title / completion art: the character, as a sprite when it has frames. */
export function characterArt(assetId: string | null, clip: string | null, ctx: DesignCtx): HTMLElement | null {
  if (!assetId) return null;
  return spriteOrImage(assetId, ctx, { width: 220, height: 220 }, 'character', clip, 'nx-title-art');
}

/**
 * Exact panel / button artwork behind native, readable text. The text colour
 * follows the artwork's brightness when it can be measured (same-origin images).
 */
export function applySkin(el: HTMLElement, url: string, kind: 'panel' | 'buttons'): void {
  if (kind === 'panel') {
    el.classList.add('nx-skin-panel');
    el.style.setProperty('background-image', `url("${url.replace(/"/g, '%22')}")`);
  } else {
    el.classList.add('nx-skinned-buttons');
    el.style.setProperty('--nx-button-skin', `url("${url.replace(/"/g, '%22')}")`);
  }
  const img = new Image();
  img.onload = () => {
    try {
      const c = document.createElement('canvas');
      c.width = 24;
      c.height = 12;
      const g = c.getContext('2d');
      if (!g) return;
      g.drawImage(img, 0, 0, 24, 12);
      const d = g.getImageData(0, 0, 24, 12).data;
      let sum = 0;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3]! < 40) continue;
        sum += 0.2126 * d[i]! + 0.7152 * d[i + 1]! + 0.0722 * d[i + 2]!;
        n++;
      }
      if (n === 0) return;
      const prefix = kind === 'panel' ? 'nx-skin' : 'nx-buttons';
      el.classList.toggle(`${prefix}-dark`, sum / n < 140);
      el.classList.toggle(`${prefix}-light`, sum / n >= 140);
    } catch {
      // Unmeasurable (e.g. a file:// page): the theme colours and a text shadow keep it readable.
    }
  };
  img.src = url;
}
