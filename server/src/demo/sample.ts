import fs from 'node:fs';
import path from 'node:path';
import { learningAnalysisSchema, type LearningAnalysis } from '@shared/schemas/analysis.ts';
import { blueprintSchema, type Blueprint } from '@shared/schemas/blueprint.ts';
import { gameBriefSchema, type GameBrief } from '@shared/schemas/brief.ts';
import { ID_PREFIX, newId } from '@shared/schemas/common.ts';
import type { ChangeOp, ChangeScope } from '@shared/schemas/proposal.ts';
import type { GameConfig } from '@shared/schemas/game.ts';
import type { App } from '../app.ts';
import { compileGame } from '../build/compile.ts';
import { REPO_ROOT } from '../config.ts';
import { listAssetRows, toAsset, updateAssetRow } from '../db/assets.ts';
import { assetLibraryRole } from '@shared/schemas/assets.ts';
import { approveBlueprint, insertAnalysis, insertBlueprintRevision } from '../db/learning.ts';
import { createProject, updateProjectMeta } from '../db/projects.ts';
import { currentSnapshot, insertDocument, listSlides } from '../db/sources.ts';
import { insertVersion } from '../db/versions.ts';
import { extractDeckIntoProject } from '../jobs/handlers/ingest.ts';
import { sha256, writeFileAtomic } from '../storage.ts';

/**
 * Bundled sample “Air Traffic Control — Coordinate Mission”. Its deck goes
 * through the real ingestion pipeline; its analysis and blueprint are prepared
 * fixtures, always labelled “Demo mode — sample content”.
 */

export const SAMPLE_DIR = path.join(REPO_ROOT, 'fixtures', 'sample');
export const SAMPLE_DECK = path.join(SAMPLE_DIR, 'air-traffic-control.pptx');
export const SAMPLE_NAME = 'Air Traffic Control — Coordinate Mission';

function readFixture(name: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(SAMPLE_DIR, name), 'utf8'));
}

/** Resolve `@slide:<p:sldId>` and `@asset:<deck image file>` references to this project's ids. */
export function resolveSampleRefs<T>(app: App, projectId: string, raw: unknown): T {
  const slides = listSlides(app.db, projectId);
  const bySldId = new Map(slides.map((s) => [String(s.pptxSlideId), s.id]));
  const assets = listAssetRows(app.db, projectId);
  const byName = new Map(assets.map((a) => [a.original_name, a.id]));
  const missing: string[] = [];
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      if (v.startsWith('@slide:')) {
        const id = bySldId.get(v.slice(7));
        if (!id) missing.push(v);
        return id ?? v;
      }
      if (v.startsWith('@asset:')) return byName.get(v.slice(7)) ?? null;
      return v;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, walk(val)]));
    return v;
  };
  const out = walk(raw);
  if (missing.length > 0) throw new Error(`Sample content refers to slides that are not in this project: ${missing.join(', ')}`);
  return out as T;
}

export function loadSampleBrief(): GameBrief {
  return gameBriefSchema.parse(readFixture('sample-brief.json'));
}

function sampleId(app: App, projectId: string): string | null {
  return app.db.get<{ sample_id: string | null }>('SELECT sample_id FROM projects WHERE id = ?', [projectId])?.sample_id ?? null;
}

export async function loadSampleAnalysis(app: App, projectId: string): Promise<LearningAnalysis> {
  if (sampleId(app, projectId) === 'trapezium') return (await import('./trapezium.ts')).trapeziumAnalysis(app, projectId);
  return learningAnalysisSchema.parse(resolveSampleRefs(app, projectId, readFixture('sample-analysis.json')));
}

export async function loadSampleBlueprint(app: App, projectId: string): Promise<Blueprint> {
  if (sampleId(app, projectId) === 'trapezium') return (await import('./trapezium.ts')).trapeziumBlueprint(app, projectId);
  return blueprintSchema.parse(resolveSampleRefs(app, projectId, readFixture('sample-blueprint.json')));
}

/** Create the sample project: real deck ingestion + prepared (demo) analysis, approved blueprint and a built v1. */
export async function createSampleProject(app: App): Promise<string> {
  const brief = loadSampleBrief();
  const projectId = createProject(app.db, { name: SAMPLE_NAME, isSample: true, brief });
  app.db.run("UPDATE projects SET sample_id = 'air-traffic' WHERE id = ?", [projectId]);
  const data = fs.readFileSync(SAMPLE_DECK);
  const docId = newId(ID_PREFIX.document);
  const rel = `projects/${projectId}/sources/${docId}/original.pptx`;
  writeFileAtomic(app.storage.abs(rel), data);
  insertDocument(app.db, { id: docId, projectId, kind: 'pptx', role: 'bundled-sample', originalName: 'air-traffic-control.pptx', storedPath: rel, sizeBytes: data.length, sha256: sha256(data), status: 'stored' });
  await extractDeckIntoProject(app, projectId, docId, { onEvent: () => {}, source: 'bundled-sample' });

  const snap = currentSnapshot(app.db, projectId);
  const analysis = insertAnalysis(app.db, {
    projectId,
    origin: 'demo',
    model: null,
    jobId: null,
    sourceRevision: snap.revision,
    snapshot: snap.snapshot,
    briefRevision: 0,
    analysis: await loadSampleAnalysis(app, projectId),
  });
  const blueprint = await loadSampleBlueprint(app, projectId);
  // File the deck images the sample uses under the library category of the need they fill.
  for (const need of blueprint.assetNeeds) {
    const role = assetLibraryRole.safeParse(need.role);
    if (need.assignedAssetId && role.success) updateAssetRow(app.db, need.assignedAssetId, { role: role.data });
  }
  const draft = insertBlueprintRevision(app.db, {
    projectId,
    parentId: null,
    origin: 'demo',
    model: null,
    jobId: null,
    analysisId: analysis.id,
    sourceRevision: snap.revision,
    snapshot: snap.snapshot,
    blueprint,
  });
  const approved = approveBlueprint(app.db, draft.id, draft.revision);
  const compiled = compileGame({
    projectId,
    revision: approved,
    brief,
    assets: listAssetRows(app.db, projectId).map((r) => toAsset(r)),
    slides: listSlides(app.db, projectId),
  });
  if (!compiled.config) throw new Error(`Sample build failed: ${compiled.errors.join('; ')}`);
  insertVersion(app.db, {
    projectId,
    config: compiled.config,
    origin: 'sample',
    summary: 'Built from the sample blueprint r1 (demo content)',
    blueprintRevisionId: approved.id,
    blueprintRevisionNumber: approved.number,
    parentVersionId: null,
    demo: true,
  });
  updateProjectMeta(app.db, projectId, { createStep: 'review' }, null);
  return projectId;
}

// ───────────────────────────── demo refinement templates ─────────────────────────────

export interface DemoTemplate {
  id: string;
  prompt: string;
  keywords: string[];
  summary: string;
  explanation: string;
  /** The prepared change ops for this scope, or a plain-language reason it cannot apply here. */
  plan: (config: GameConfig, scope: ChangeScope) => ChangeOp[] | { unavailable: string };
}

const ONE_SCENE = 'This prepared change edits one scene. Select a scene in the list, then ask again.';
const WHOLE_GAME = 'This prepared change affects the whole game. Choose “Use whole project” above the conversation, then ask again.';

/** Keyword-matched templates that replay prepared changes in demo mode. They are not Claude. */
export const DEMO_TEMPLATES: DemoTemplate[] = [
  {
    id: 'declutter',
    prompt: 'Make this screen less cluttered',
    keywords: ['clutter', 'cleaner', 'simpler', 'busy'],
    summary: 'Reduce on-screen elements in the selected scene',
    explanation: 'Hides the progress indicator, removes support text and switches to the compact layout. Learning content and answers are unchanged.',
    plan: (config, scope) => {
      const scene = scope.kind === 'scene' ? config.scenes.find((s) => s.id === scope.sceneId) : undefined;
      if (!scene) return { unavailable: ONE_SCENE };
      const ops: ChangeOp[] = [
        { op: 'set-scene-field', sceneId: scene.id, field: 'layout.showProgress', value: false },
        { op: 'set-scene-field', sceneId: scene.id, field: 'layout.density', value: 'compact' },
      ];
      if (scene.supportText) ops.push({ op: 'set-scene-field', sceneId: scene.id, field: 'supportText', value: null });
      return ops;
    },
  },
  {
    id: 'instruction-top',
    prompt: 'Move the instruction panel to the top',
    keywords: ['instruction', 'top'],
    summary: 'Place the instruction panel above the interaction',
    explanation: 'Moves the instruction region to the top of the selected scene. Wording is unchanged.',
    plan: (config, scope) => {
      const scene = scope.kind === 'scene' ? config.scenes.find((s) => s.id === scope.sceneId) : undefined;
      if (!scene) return { unavailable: ONE_SCENE };
      if (scene.interaction.type === 'info') return { unavailable: 'A concept card has no separate instruction panel. Select an interactive scene, then ask again.' };
      if (scene.layout.instructionPosition === 'top') return { unavailable: 'The instruction panel in this scene is already at the top.' };
      return [{ op: 'set-scene-field', sceneId: scene.id, field: 'layout.instructionPosition', value: 'top' }];
    },
  },
  {
    id: 'background',
    prompt: 'Keep the characters but change the background',
    keywords: ['background'],
    summary: 'Switch the background scenery, keeping every character',
    explanation: 'Changes the game background to the built-in city scenery and removes the background image. Characters and answers are unchanged.',
    plan: (config, scope) => {
      if (scope.kind !== 'project') return { unavailable: WHOLE_GAME };
      return [
        { op: 'set-project-field', field: 'theme.decor', value: config.theme.decor === 'city' ? 'airport' : 'city' },
        { op: 'set-project-field', field: 'theme.backgroundAssetId', value: null },
      ];
    },
  },
  {
    id: 'visibility',
    prompt: 'Make the grid and points easier to see',
    keywords: ['grid', 'points', 'easier to see', 'visible', 'see'],
    summary: 'Stronger grid lines, larger points and labels',
    explanation: 'Raises grid emphasis and enlarges points and axis labels in coordinate scenes.',
    plan: (config, scope) => {
      const scenes = config.scenes.filter((s) => s.interaction.type === 'coordinate-navigation' && (scope.kind === 'project' || s.id === scope.sceneId));
      if (scenes.length === 0) {
        const names = config.scenes.filter((s) => s.interaction.type === 'coordinate-navigation').map((s) => `“${s.title}”`);
        return { unavailable: `This prepared change applies to coordinate scenes${names.length ? ` such as ${names.slice(0, 2).join(' or ')}` : ''}. Select one, or use the whole project, then ask again.` };
      }
      return scenes.map((scene) => ({ op: 'set-scene-field', sceneId: scene.id, field: 'interaction.display', value: { gridEmphasis: 'high', pointSize: 'large', labelSize: 'large' } }) as ChangeOp);
    },
  },
];

export function matchDemoTemplate(request: string): DemoTemplate | null {
  const text = request.toLowerCase();
  let best: { t: DemoTemplate; score: number } | null = null;
  for (const t of DEMO_TEMPLATES) {
    const score = t.keywords.filter((k) => text.includes(k)).length;
    if (score > 0 && (!best || score > best.score)) best = { t, score };
  }
  return best?.t ?? null;
}
