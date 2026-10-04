import type { Asset, AssetLibraryRole, AssetMetadata, AssetUsage } from '@shared/schemas/assets.ts';
import type { Blueprint } from '@shared/schemas/blueprint.ts';
import type { GameConfig } from '@shared/schemas/game.ts';
import type { SourceScreenMapping } from '@shared/schemas/screens.ts';
import type { SourceSlide } from '@shared/schemas/source.ts';
import { notFound } from '../errors.ts';
import { nowIso, parseJson, type Db } from './db.ts';

export interface AssetRow {
  id: string;
  project_id: string;
  role: AssetLibraryRole;
  kind: 'image' | 'audio';
  name: string;
  original_name: string;
  mime: string;
  format: string;
  size_bytes: number;
  width: number | null;
  height: number | null;
  has_alpha: number | null;
  duration_seconds: number | null;
  source: Asset['source'];
  sha256: string;
  stored_dir: string;
  original_file: string;
  display_file: string;
  display_mime: string;
  thumb_file: string | null;
  metadata_json: string;
  created_at: string;
}

export function toAsset(r: AssetRow, usage: AssetUsage[] = []): Asset {
  return {
    id: r.id,
    projectId: r.project_id,
    role: r.role,
    kind: r.kind,
    name: r.name,
    originalName: r.original_name,
    mime: r.mime,
    format: r.format,
    sizeBytes: r.size_bytes,
    width: r.width,
    height: r.height,
    hasAlpha: r.has_alpha === null ? null : r.has_alpha === 1,
    durationSeconds: r.duration_seconds,
    source: r.source,
    sha256: r.sha256,
    metadata: parseJson<AssetMetadata>(r.metadata_json, {
      placement: { scale: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5, crop: null },
      sprite: null,
      replacedFrom: null,
      rasterizedFromSvg: false,
      alt: '',
      generationPrompt: null,
      provenance: null,
    }),
    usage,
    createdAt: r.created_at,
  };
}

export function insertAssetRow(db: Db, r: Omit<AssetRow, 'created_at'>): void {
  db.run(
    `INSERT INTO assets (id, project_id, role, kind, name, original_name, mime, format, size_bytes, width, height, has_alpha, duration_seconds,
       source, sha256, stored_dir, original_file, display_file, display_mime, thumb_file, metadata_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      r.id, r.project_id, r.role, r.kind, r.name, r.original_name, r.mime, r.format, r.size_bytes, r.width, r.height, r.has_alpha,
      r.duration_seconds, r.source, r.sha256, r.stored_dir, r.original_file, r.display_file, r.display_mime, r.thumb_file, r.metadata_json, nowIso(),
    ],
  );
}

export function getAssetRow(db: Db, id: string): AssetRow {
  const r = db.get<AssetRow>('SELECT * FROM assets WHERE id = ?', [id]);
  if (!r) throw notFound('Asset');
  return r;
}

export function findAssetBySha(db: Db, projectId: string, sha: string): AssetRow | undefined {
  return db.get<AssetRow>('SELECT * FROM assets WHERE project_id = ? AND sha256 = ? LIMIT 1', [projectId, sha]);
}

export function listAssetRows(db: Db, projectId: string): AssetRow[] {
  return db.all<AssetRow>('SELECT * FROM assets WHERE project_id = ? ORDER BY created_at', [projectId]);
}

export function updateAssetRow(db: Db, id: string, patch: { role?: AssetLibraryRole; name?: string; metadata?: AssetMetadata }): void {
  const sets: string[] = [];
  const params: Array<string | number | null> = [];
  if (patch.role) (sets.push('role = ?'), params.push(patch.role));
  if (patch.name !== undefined) (sets.push('name = ?'), params.push(patch.name));
  if (patch.metadata) (sets.push('metadata_json = ?'), params.push(JSON.stringify(patch.metadata)));
  if (sets.length === 0) return;
  db.run(`UPDATE assets SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
}

/** Where each asset is used in the current game version, the latest blueprint, the screen map, design references and the source slides. */
export function computeUsage(
  config: GameConfig | null,
  blueprint: Blueprint | null,
  slides: SourceSlide[],
  extra: { mapping?: SourceScreenMapping | null; frameRenders?: Array<{ assetId: string | null; name: string }> } = {},
): Map<string, AssetUsage[]> {
  const usage = new Map<string, AssetUsage[]>();
  const add = (id: string | null | undefined, u: AssetUsage) => {
    if (!id) return;
    const list = usage.get(id) ?? [];
    list.push(u);
    usage.set(id, list);
  };
  if (config) {
    add(config.theme.backgroundAssetId, { kind: 'theme-background', sceneId: null, label: 'Game background' });
    add(config.screens.title.characterAssetId, { kind: 'title-character', sceneId: null, label: 'Title screen character' });
    add(config.screens.completion.characterAssetId, { kind: 'completion-character', sceneId: null, label: 'Completion screen character' });
    add(config.settings.audio.musicAssetId, { kind: 'music', sceneId: null, label: 'Background music' });
    const designUse = (where: string, sceneId: string | null, design: GameConfig['scenes'][number]['design'], objects: GameConfig['scenes'][number]['objects']) => {
      add(design?.backgroundAssetId, { kind: 'design-background', sceneId, label: `${where} design background` });
      for (const l of design?.layers ?? []) add(l.assetId, { kind: 'design-layer', sceneId, label: `${where} layer “${l.name.slice(0, 40)}”` });
      for (const o of objects) add(o.assetId, { kind: 'screen-object', sceneId, label: `${where} object “${o.label}”` });
    };
    designUse('Title screen', null, config.screens.title.design, config.screens.title.objects);
    designUse('Completion screen', null, config.screens.completion.design, config.screens.completion.objects);
    config.scenes.forEach((s, i) => {
      add(s.assets.background, { kind: 'scene-background', sceneId: s.id, label: `Scene ${i + 1} background` });
      add(s.assets.character, { kind: 'scene-character', sceneId: s.id, label: `Scene ${i + 1} character` });
      add(s.assets.panel, { kind: 'scene-panel', sceneId: s.id, label: `Scene ${i + 1} instruction panel` });
      add(s.assets.button, { kind: 'scene-button', sceneId: s.id, label: `Scene ${i + 1} buttons` });
      designUse(`Scene ${i + 1}`, s.id, s.design, s.objects);
      const i2 = s.interaction;
      if (i2.type === 'drag-match') {
        for (const c of [...i2.items, ...i2.targets]) add(c.imageAssetId, { kind: 'card-image', sceneId: s.id, label: `Scene ${i + 1} card “${c.label}”` });
      } else if (i2.type === 'sequence-sort') {
        for (const c of i2.items) add(c.imageAssetId, { kind: 'card-image', sceneId: s.id, label: `Scene ${i + 1} card “${c.label}”` });
      }
    });
    for (const b of config.motion.bindings) {
      add(b.assetId, { kind: 'animation', sceneId: b.screenId, label: `Animation: ${b.label.slice(0, 60) || b.presetId}` });
      add(b.sound?.assetId, { kind: 'animation', sceneId: b.screenId, label: `Animation sound: ${b.label.slice(0, 50) || b.presetId}` });
    }
  }
  for (const need of blueprint?.assetNeeds ?? []) {
    add(need.assignedAssetId, { kind: 'blueprint-need', sceneId: null, label: `Blueprint need: ${need.description.slice(0, 60)}` });
  }
  for (const screen of extra.mapping?.screens ?? []) {
    const ids = [screen.assets.character, screen.assets.panel, screen.assets.button, screen.background.kind === 'asset' ? screen.background.assetId : null, ...screen.objects.map((o) => o.assetId)];
    for (const id of new Set(ids.filter(Boolean))) add(id, { kind: 'screen-map', sceneId: screen.screenId, label: `Screen map: ${screen.title.slice(0, 50)}` });
  }
  for (const f of extra.frameRenders ?? []) add(f.assetId, { kind: 'design-reference', sceneId: null, label: `Design reference “${f.name.slice(0, 50)}”` });
  for (const s of slides) {
    for (const img of s.extract.images) add(img.assetId, { kind: 'slide-image', sceneId: null, label: `Slide ${s.slideNumber} image` });
  }
  return usage;
}

/**
 * True when any stored game version, blueprint revision, design snapshot or a
 * grade version's current screen map references the asset.
 */
export function assetReferenced(db: Db, projectId: string, assetId: string): boolean {
  const like = `%"${assetId}"%`;
  const count = (sql: string) => db.get<{ c: number }>(sql, [projectId, like])?.c ?? 0;
  if (count('SELECT COUNT(*) AS c FROM game_versions WHERE project_id = ? AND config_json LIKE ?')) return true;
  if (count('SELECT COUNT(*) AS c FROM blueprint_revisions WHERE project_id = ? AND blueprint_json LIKE ?')) return true;
  if (db.get<{ c: number }>('SELECT COUNT(*) AS c FROM design_frames WHERE project_id = ? AND (render_asset_id = ? OR snapshot_json LIKE ?)', [projectId, assetId, like])?.c) return true;
  const currentMaps = db.all<{ mapping_json: string }>(
    `SELECT m.mapping_json FROM screen_maps m JOIN (SELECT branch_id, MAX(number) AS n FROM screen_maps WHERE project_id = ? GROUP BY branch_id) t
       ON t.branch_id = m.branch_id AND t.n = m.number`,
    [projectId],
  );
  return currentMaps.some((m) => m.mapping_json.includes(`"${assetId}"`));
}
