import type { GameConfig, GameScene } from '../schemas/game.ts';
import type { EntityKind } from './presets.ts';

/**
 * Stable entity ids for everything a binding can target on a screen. The
 * runtime tags the same elements with `data-entity`, the studio lists them as
 * chips, and Claude is only ever shown this list — it cannot invent targets.
 */

export interface ScreenEntity {
  id: string;
  label: string;
  kind: EntityKind;
  /** Asset behind the entity (images, sprites). */
  assetId: string | null;
  /** Named sprite clips when the entity is a sprite with clips; empty for static images. */
  clips: string[];
  /** A static image: whole-object motion only. */
  staticImage: boolean;
  /** Interactive mechanic element (dragging takes priority over decorative motion). */
  interactive: boolean;
}

export interface ScreenInfo {
  id: string;
  label: string;
  kind: 'title' | 'scene' | 'completion';
  type: GameScene['interaction']['type'] | 'title' | 'completion';
  entities: ScreenEntity[];
  controls: string[];
}

function clipsOf(config: GameConfig, assetId: string | null | undefined): string[] {
  if (!assetId) return [];
  const a = config.assets[assetId];
  return a?.sprite?.clips?.map((c) => c.name) ?? [];
}

function assetEntity(config: GameConfig, id: string, label: string, assetId: string | null, interactive = false): ScreenEntity {
  const clips = clipsOf(config, assetId);
  const sprite = Boolean(assetId && config.assets[assetId]?.sprite);
  return { id, label, kind: sprite ? 'sprite' : 'image', assetId, clips, staticImage: !sprite, interactive };
}

/** A short name for an asset from its alt text (“Swiftee, the expedition's guide” → “Swiftee”). */
export function assetShortName(config: GameConfig, assetId: string | null | undefined, fallback: string): string {
  const alt = assetId ? config.assets[assetId]?.alt : undefined;
  const short = alt?.split(/[,—–(:]/)[0]?.trim().slice(0, 28);
  return short || fallback;
}

function plain(id: string, label: string, kind: EntityKind, interactive = false): ScreenEntity {
  return { id, label, kind, assetId: null, clips: [], staticImage: false, interactive };
}

function designEntities(config: GameConfig, design: GameScene['design'], objects: GameScene['objects']): ScreenEntity[] {
  const out: ScreenEntity[] = [];
  for (const layer of design?.layers ?? []) {
    if (layer.kind === 'image') out.push(assetEntity(config, layer.id, `${layer.name || 'Image'} (design)`, layer.assetId));
    else out.push(plain(layer.id, `${layer.kind === 'text' ? (layer.text?.content ?? layer.name).slice(0, 40) : layer.name || 'Shape'} (design)`, layer.kind === 'text' ? 'text' : 'shape'));
  }
  for (const o of objects ?? []) out.push(assetEntity(config, o.id, o.label, o.assetId));
  return out;
}

function sceneLabel(index: number, scene: GameScene): string {
  return `Screen ${index + 2} · ${scene.title}`;
}

export function listScreens(config: GameConfig): ScreenInfo[] {
  const screens: ScreenInfo[] = [];
  const t = config.screens.title;
  screens.push({
    id: 'title',
    label: 'Screen 1 · Title',
    kind: 'title',
    type: 'title',
    controls: ['start'],
    entities: [
      plain('screen', 'Whole screen', 'screen'),
      plain('title-card', 'Title card', 'panel'),
      plain('title-heading', 'Title heading', 'text'),
      ...(t.characterAssetId ? [assetEntity(config, 'character', assetShortName(config, t.characterAssetId, 'Title character'), t.characterAssetId)] : []),
      plain('button:start', 'Start button', 'control', true),
      ...designEntities(config, t.design, t.objects),
    ],
  });
  config.scenes.forEach((scene, i) => {
    const it = scene.interaction;
    const entities: ScreenEntity[] = [plain('screen', 'Whole screen', 'screen')];
    if (scene.design?.backgroundAssetId ?? scene.assets.background) entities.push(assetEntity(config, 'background', 'Background', scene.design?.backgroundAssetId ?? scene.assets.background));
    entities.push(plain('instruction', 'Instruction panel', 'panel'));
    // On coordinate screens the character is drawn as the mover (entity “mover”).
    if (scene.assets.character && scene.interaction.type !== 'coordinate-navigation') entities.push(assetEntity(config, 'character', assetShortName(config, scene.assets.character, 'Character'), scene.assets.character));
    const controls: string[] = [];
    if (it.type === 'info') {
      entities.push(plain('points', 'Key points', 'list'));
      it.points.forEach((p, k) => entities.push(plain(`point:${k + 1}`, `Point ${k + 1}: ${p.slice(0, 32)}`, 'text')));
      entities.push(plain('button:continue', `${it.continueLabel} button`, 'control', true));
      controls.push('continue');
    } else {
      if (it.type === 'coordinate-navigation') {
        entities.push(plain('grid', 'Coordinate grid', 'grid'));
        entities.push(plain('mover', it.moverLabel ? `Mover (${it.moverLabel})` : 'Mover', 'mover', true));
        for (const l of it.landmarks) entities.push(plain(`landmark:${l.id}`, `Landmark ${l.label}`, 'shape'));
      } else if (it.type === 'drag-match') {
        entities.push(plain('tray', 'Item tray', 'tray'));
        for (const item of it.items) entities.push({ ...assetEntity(config, `item:${item.id}`, `Card ${item.label}`, item.imageAssetId, true), kind: 'card' });
        for (const target of it.targets) entities.push({ ...assetEntity(config, `target:${target.id}`, `Target ${target.label}`, target.imageAssetId), kind: 'target' });
      } else if (it.type === 'sequence-sort') {
        for (const item of it.items) entities.push({ ...assetEntity(config, `card:${item.id}`, `Card ${item.label}`, item.imageAssetId, true), kind: 'card' });
      }
      entities.push(plain('button:check', 'Check button', 'control', true), plain('button:hint', 'Hint button', 'control', true), plain('button:reset', 'Reset button', 'control', true));
      controls.push('check', 'hint', 'reset', 'next');
    }
    entities.push(...designEntities(config, scene.design, scene.objects));
    screens.push({ id: scene.id, label: sceneLabel(i, scene), kind: 'scene', type: it.type, controls, entities });
  });
  const c = config.screens.completion;
  screens.push({
    id: 'completion',
    label: `Screen ${config.scenes.length + 2} · Completion`,
    kind: 'completion',
    type: 'completion',
    controls: ['replay'],
    entities: [
      plain('screen', 'Whole screen', 'screen'),
      plain('completion-card', 'Completion card', 'panel'),
      plain('badge', 'Success badge', 'shape'),
      ...(c.characterAssetId ? [assetEntity(config, 'character', assetShortName(config, c.characterAssetId, 'Completion character'), c.characterAssetId)] : []),
      plain('button:replay', 'Play again button', 'control', true),
      ...designEntities(config, c.design, c.objects),
    ],
  });
  return screens;
}

export function findScreen(config: GameConfig, screenId: string): ScreenInfo | null {
  return listScreens(config).find((s) => s.id === screenId) ?? null;
}
