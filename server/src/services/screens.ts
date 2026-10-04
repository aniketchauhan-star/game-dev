import type { Blueprint } from '@shared/schemas/blueprint.ts';
import type { DesignFrame } from '@shared/schemas/design.ts';
import { applyChangeOps, type ChangeOp } from '@shared/schemas/proposal.ts';
import type { GameVersion, Proposal } from '@shared/schemas/records.ts';
import type { ScreenMapRecord, SourceScreenMapping } from '@shared/schemas/screens.ts';
import { effectiveSlideText } from '@shared/schemas/source.ts';
import { computeScreenLayout, validateMapping, type LayoutAsset, type LayoutContext } from '@shared/screens/layout.ts';
import { mergeWithBlueprint, suggestMapping, type SuggestAsset } from '@shared/screens/suggest.ts';
import type { App } from '../app.ts';
import { listAssetRows, toAsset } from '../db/assets.ts';
import { activeBranchId } from '../db/branches.ts';
import { framesById, listActiveFrames } from '../db/design.ts';
import { latestBlueprint } from '../db/learning.ts';
import { currentScreenMap, insertScreenMap, listScreenMaps } from '../db/screens.ts';
import { listSlides } from '../db/sources.ts';
import { currentVersion } from '../db/versions.ts';
import { badRequest } from '../errors.ts';
import { attachLibraryAssets } from './attachAssets.ts';
import { applyManualEdit } from './proposals.ts';

export interface ScreenSources {
  branchId: string;
  blueprint: Blueprint | null;
  blueprintRevisionId: string | null;
  slides: Array<{ id: string; title: string; text: string; inLesson: boolean }>;
  frames: DesignFrame[];
  assets: Array<SuggestAsset & LayoutAsset>;
  ctx: LayoutContext;
}

export function slidePlainText(slide: Parameters<typeof effectiveSlideText>[0]): { title: string; text: string } {
  const t = effectiveSlideText(slide);
  return { title: t.title, text: [t.title, ...t.blocks.flatMap((b) => b.paragraphs)].join('\n') };
}

/** Everything the map is checked against: the branch's latest blueprint, slides, design frames and assets. */
export function screenSources(app: App, projectId: string, branchId = activeBranchId(app.db, projectId), extraFrameIds: string[] = []): ScreenSources {
  const rev = latestBlueprint(app.db, projectId, branchId);
  const slides = listSlides(app.db, projectId).map((s) => ({ id: s.id, ...slidePlainText(s), inLesson: s.included && !s.hidden }));
  const active = listActiveFrames(app.db, projectId);
  const extra = framesById(app.db, extraFrameIds.filter((id) => !active.some((f) => f.id === id)));
  const frames = [...active, ...extra.values()].filter((f) => f.projectId === projectId);
  const assets = listAssetRows(app.db, projectId).map((r) => {
    const a = toAsset(r);
    return { id: a.id, role: a.role, name: a.name, kind: a.kind, sprite: a.metadata.sprite ? { clips: a.metadata.sprite.clips.map((c) => ({ name: c.name })) } : null };
  });
  const screens = rev
    ? [{ id: 'title', kind: 'title' as const }, ...rev.blueprint.scenes.map((s) => ({ id: s.id, kind: 'scene' as const })), { id: 'completion', kind: 'completion' as const }]
    : [];
  return {
    branchId,
    blueprint: rev?.blueprint ?? null,
    blueprintRevisionId: rev?.id ?? null,
    slides,
    frames,
    assets,
    ctx: { frames: new Map(frames.map((f) => [f.id, f])), assets: new Map(assets.map((a) => [a.id, a])), slideIds: new Set(slides.map((s) => s.id)), screens },
  };
}

function framesUsedBy(map: SourceScreenMapping | null | undefined): string[] {
  return (map?.screens ?? []).flatMap((s) => [...s.frames.map((f) => f.frameId), ...(s.background.frameId ? [s.background.frameId] : [])]);
}

export interface ScreenMapBundle {
  branchId: string;
  current: ScreenMapRecord | null;
  suggestion: SourceScreenMapping | null;
  suggestionNote: string | null;
  history: ReturnType<typeof listScreenMaps>;
  blueprintRevisionId: string | null;
  check: { errors: string[]; warnings: string[] } | null;
}

/**
 * The current map (if any) and, when useful, a suggestion: a full suggestion
 * when nothing was saved yet, or the saved rows merged with screens the
 * blueprint gained since. Suggestions are never saved automatically.
 */
export function screenMapBundle(app: App, projectId: string): ScreenMapBundle {
  const branchId = activeBranchId(app.db, projectId);
  const current = currentScreenMap(app.db, branchId);
  const src = screenSources(app, projectId, branchId, framesUsedBy(current?.mapping));
  let suggestion: SourceScreenMapping | null = null;
  let note: string | null = null;
  if (src.blueprint) {
    const fresh = suggestMapping({ blueprint: src.blueprint, slides: src.slides, frames: src.frames, assets: src.assets });
    if (!current) {
      suggestion = fresh;
      note = 'Suggested from the blueprint’s source links and shared words between frames and scenes. Review each row before saving.';
    } else {
      const merged = mergeWithBlueprint(current.mapping, fresh);
      if (merged.added.length || merged.removed.length) {
        suggestion = merged.mapping;
        note = `The blueprint changed: ${merged.added.length} new screen(s) suggested${merged.removed.length ? `, ${merged.removed.length} removed screen(s) dropped` : ''}. Your reviewed rows are kept.`;
      }
    }
  }
  return {
    branchId,
    current,
    suggestion,
    suggestionNote: note,
    history: listScreenMaps(app.db, branchId),
    blueprintRevisionId: src.blueprintRevisionId,
    check: current && src.blueprint ? validateMapping(current.mapping, src.ctx) : null,
  };
}

/** Layout + wording ops that bring a game version in line with the map. */
export function layoutOps(mapping: SourceScreenMapping, ctx: LayoutContext, config: GameVersion['config']): { ops: ChangeOp[]; warnings: string[] } {
  const ops: ChangeOp[] = [];
  const warnings: string[] = [];
  for (const entry of mapping.screens) {
    const exists = entry.screenId === 'title' || entry.screenId === 'completion' || config.scenes.some((s) => s.id === entry.screenId);
    if (!exists) {
      warnings.push(`“${entry.title}” is not in this game version yet; it is used at the next build.`);
      continue;
    }
    const r = computeScreenLayout(entry, ctx);
    warnings.push(...r.warnings);
    ops.push({ op: 'set-screen-layout', screenId: entry.screenId, layout: r.layout });
    if (entry.kind === 'scene') {
      if (r.wording.instruction) ops.push({ op: 'set-scene-field', sceneId: entry.screenId, field: 'instruction', value: r.wording.instruction });
      if (r.wording.title) ops.push({ op: 'set-scene-field', sceneId: entry.screenId, field: 'title', value: r.wording.title });
    }
  }
  return { ops, warnings };
}

export function saveScreenMap(
  app: App,
  projectId: string,
  input: { mapping: SourceScreenMapping; expectedNumber: number; note: string; applyToVersion: boolean },
): { map: ScreenMapRecord; version: GameVersion | null; proposal: Proposal | null; skipped: string[]; warnings: string[] } {
  const branchId = activeBranchId(app.db, projectId);
  const src = screenSources(app, projectId, branchId, framesUsedBy(input.mapping));
  if (!src.blueprint) throw badRequest('Create a blueprint first: the screens of the map are the screens of the game.');
  const check = validateMapping(input.mapping, src.ctx);
  if (check.errors.length) throw badRequest(`The screen map has ${check.errors.length} problem(s): ${check.errors[0]}`, check.errors.slice(1, 4).join(' '));
  const map = insertScreenMap(app.db, { projectId, branchId, blueprintRevisionId: src.blueprintRevisionId, origin: 'creator', note: input.note || 'Saved in Screens', mapping: input.mapping, expectedNumber: input.expectedNumber });
  let version: GameVersion | null = null;
  let proposal: Proposal | null = null;
  const skipped: string[] = [];
  const warnings = [...check.warnings];
  if (input.applyToVersion) {
    const current = currentVersion(app.db, projectId);
    if (current) {
      const { ops: raw, warnings: w } = layoutOps(input.mapping, src.ctx, current.config);
      const ops = attachLibraryAssets(raw, current.config, listAssetRows(app.db, projectId).map((r) => toAsset(r)));
      warnings.push(...w);
      // Preview first: a version is only created when something actually changes.
      const preview = applyChangeOps(current.config, ops, { scope: { kind: 'project', sceneId: null } });
      skipped.push(...preview.results.filter((x) => x.status === 'conflict' || x.status === 'invalid').map((x) => `${x.where ?? x.target}: ${x.message ?? x.status}`));
      if (preview.ok) {
        const r = applyManualEdit(app, projectId, { baseVersionId: current.id, ops, scope: { kind: 'project', sceneId: null }, summary: `Applied screen map ${map.number} (layout, artwork and wording)` });
        version = r.version;
        proposal = r.proposal;
      }
    }
  }
  return { map, version, proposal, skipped, warnings };
}
