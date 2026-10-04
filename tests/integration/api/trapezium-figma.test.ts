import './env.ts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Asset } from '@shared/schemas/assets.ts';
import type { DesignFrame, DesignImport } from '@shared/schemas/design.ts';
import { profileForGrade, type GradePlanRecord } from '@shared/schemas/grade.ts';
import type { MotionPlanRecord } from '@shared/schemas/motion.ts';
import type { ProjectDetail } from '@shared/schemas/project.ts';
import type { GameVersion } from '@shared/schemas/records.ts';
import type { ScreenMapRecord } from '@shared/schemas/screens.ts';
import { resetSecretsForTests } from '../../../server/src/secrets.ts';
import { FigmaMock } from '../../support/figma-mock.ts';
import fs from 'node:fs';
import path from 'node:path';
import { multipart, REPO_ROOT, Studio, studioHeaders } from './helpers.ts';

function must<T>(v: T | undefined, what: string): T {
  if (v === undefined) throw new Error(`Missing ${what}`);
  return v;
}

/**
 * The Grade 8 trapezium sample with its design read from a LOCAL MOCK of the
 * Figma REST API (tests/support/figma-mock.ts) — not live Figma. Proves the
 * evidence-only screen map, the lesson-vs-design conflict check, and that the
 * reviewed map (not the design) decides what learners read.
 */

const TOKEN = 'figd_test-ONLY-not-a-real-token-0123456789';
let mock: FigmaMock;
let studio: Studio;
let project: ProjectDetail;
let frames: DesignFrame[] = [];

async function json<T>(p: Promise<{ statusCode: number; body: string; json(): unknown }>, status = 200): Promise<T> {
  const res = await p;
  expect(res.statusCode, res.body).toBe(status);
  return res.json() as T;
}
const frameName = (id: string) => frames.find((f) => f.id === id)?.name ?? id;

beforeAll(async () => {
  mock = new FigmaMock({ token: TOKEN });
  process.env.FIGMA_API_BASE_URL = await mock.start();
  process.env.FIGMA_ACCESS_TOKEN = TOKEN;
  resetSecretsForTests();
  studio = await Studio.start();
  project = (await json<{ project: ProjectDetail }>(studio.post('/api/projects/sample', { which: 'trapezium' }), 201)).project;
});
afterAll(async () => {
  await studio.close();
  await mock.stop();
  delete process.env.FIGMA_API_BASE_URL;
  delete process.env.FIGMA_ACCESS_TOKEN;
  resetSecretsForTests();
});

describe('Grade 8 trapezium sample with a (mock) Figma design', () => {
  it('imports only the selected frames, read-only, with provenance', async () => {
    for (const kind of ['lesson', 'artwork'] as const) await json(studio.post(`/api/projects/${project.id}/sample-files`, { kind }), 201);
    await studio.runJobs();
    const browse = await json<{ import: DesignImport }>(studio.post(`/api/projects/${project.id}/design/figma`, { link: 'https://www.figma.com/design/TrapQuestDemo8x2026/Trapezium-Quest' }), 202);
    await studio.runJobs();
    const listed = (await json<{ imports: DesignImport[] }>(studio.get(`/api/projects/${project.id}/design`))).imports.find((i) => i.id === browse.import.id)!;
    expect(listed.available.map((a) => a.name)).toEqual(['01 Intro', '02 Spot the parallel sides', '02b Spot the parallel sides — hint state', '03 Match the shapes', '04 Well done', 'Button / Primary']);
    const started = await json<{ job: { id: string } }>(studio.post(`/api/design-imports/${listed.id}/import`, { nodeIds: ['10:1', '10:2', '10:3', '10:4', '10:5'] }), 202);
    await studio.runJobs();
    expect((await studio.job(started.job.id)).job.status).toBe('succeeded');
    frames = (await json<{ frames: DesignFrame[] }>(studio.get(`/api/projects/${project.id}/design-frames`))).frames;
    expect(frames.map((f) => f.name).sort()).toEqual(['01 Intro', '02 Spot the parallel sides', '02b Spot the parallel sides — hint state', '03 Match the shapes', '04 Well done']);
    // The picker shows small thumbnails; full renders and node data are fetched only for the selected frames.
    const fullRenders = mock.requests.filter((r) => r.pathname.startsWith('/v1/images/') && r.query.scale !== '0.2');
    expect(fullRenders.length).toBeGreaterThan(0);
    expect(fullRenders.some((r) => r.query.ids?.includes('20:1'))).toBe(false);
    expect(mock.requests.filter((r) => r.pathname.endsWith('/nodes')).some((r) => r.query.ids?.includes('20:1'))).toBe(false);
    // Nothing is written back: the adapter only ever sends GET requests.
    expect(new Set(mock.requests.map((r) => r.method))).toEqual(new Set(['GET']));
    const assets = (await json<{ assets: Asset[] }>(studio.get(`/api/projects/${project.id}/assets`))).assets;
    const renders = assets.filter((a) => a.metadata.provenance?.kind === 'figma' && a.metadata.provenance.figma?.kind === 'frame-render');
    expect(renders).toHaveLength(5);
    expect(renders.every((a) => a.role === 'reference' && a.metadata.provenance!.figma!.fileKey === 'TrapQuestDemo8x2026')).toBe(true);
  });

  it('reports an upload that is already in the library, giving an unsorted imported copy the creator’s name, role and origin note', async () => {
    const art = path.join(REPO_ROOT, 'fixtures', 'trapezium', 'art');
    const send = (role: string, files: string[]) => {
      const { payload, contentType } = multipart([
        { name: 'role', value: role },
        { name: 'provenance', value: 'ai-tool' },
        { name: 'tool', value: 'ChatGPT' },
        ...files.map((f) => ({ name: 'files', filename: f, data: fs.readFileSync(path.join(art, f)), contentType: 'image/png' })),
      ]);
      return studio.inject({ method: 'POST', url: `/api/projects/${project.id}/assets`, headers: { ...studioHeaders('POST'), 'content-type': contentType }, payload });
    };
    const before = (await json<{ assets: Asset[] }>(studio.get(`/api/projects/${project.id}/assets`))).assets;
    // Swiftee's first frame is also an image fill in the Figma file (imported, not yet sorted).
    const fill = must(before.find((a) => a.metadata.provenance?.figma?.kind === 'image-fill' && a.metadata.provenance.figma.imageRef === 'ref-swiftee'), 'Figma image fill');
    expect(fill.role).toBe('unassigned');
    const res = await send('character', ['swiftee-01.png']);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().created).toEqual([]);
    expect(res.json().duplicates).toEqual([{ name: 'swiftee-01.png', existingId: fill.id, existingName: fill.name, adopted: true }]);
    const after = (await json<{ assets: Asset[] }>(studio.get(`/api/projects/${project.id}/assets`))).assets;
    expect(after).toHaveLength(before.length);
    const adopted = after.find((a) => a.id === fill.id)!;
    expect(adopted).toMatchObject({ name: 'swiftee-01', role: 'character' });
    expect(adopted.metadata.provenance).toMatchObject({ kind: 'ai-tool', tool: 'ChatGPT', figma: { imageRef: 'ref-swiftee', fileKey: 'TrapQuestDemo8x2026' } });
    expect(adopted.metadata.provenance!.note).toMatch(/made with ChatGPT.*also an image in the Figma file/);
    // Two identical new frames: stored once, the second reported (not adopted).
    const frames = await send('character', ['swiftee-04.png', 'swiftee-06.png']);
    expect(frames.statusCode, frames.body).toBe(201);
    expect(frames.json().created).toHaveLength(1);
    expect(frames.json().duplicates).toEqual([{ name: 'swiftee-06.png', existingId: frames.json().created[0].id, existingName: 'swiftee-04', adopted: false }]);
  });

  it('suggests the map from evidence and flags the design definition that contradicts the lesson', async () => {
    await json(studio.put(`/api/projects/${project.id}/grade`, { profile: profileForGrade(8), expectedRevision: 0 }));
    const { job } = await json<{ job: { id: string } }>(studio.post(`/api/projects/${project.id}/prepare`), 202);
    await studio.runJobs();
    expect((await studio.job(job.id)).job.status).toBe('succeeded');
    const map = (await json<{ current: ScreenMapRecord }>(studio.get(`/api/projects/${project.id}/screen-map`))).current;
    const linked = Object.fromEntries(map.mapping.screens.map((s) => [s.screenId, s.frames.map((f) => `${frameName(f.frameId)} (${f.state}${f.primary ? ', layout' : ''})`)]));
    expect(linked).toEqual({
      title: ['01 Intro (default, layout)'],
      scn_trap_intro: [],
      scn_trap_identify: ['02 Spot the parallel sides (default, layout)', '02b Spot the parallel sides — hint state (hint)'],
      scn_trap_match: ['03 Match the shapes (default, layout)'],
      completion: ['04 Well done (default, layout)'],
    });
    const identify = map.mapping.screens.find((s) => s.screenId === 'scn_trap_identify')!;
    expect(identify.roles).toEqual({ content: 'ppt', layout: 'figma', artwork: 'uploads' });
    expect(identify.conflicts).toHaveLength(1);
    expect(identify.conflicts[0]).toMatchObject({ kind: 'definition', status: 'open', figmaText: expect.stringContaining('exactly one pair'), pptText: expect.stringContaining('at least one pair') });
    expect(identify.reviewed).toBe(false);
  });

  it('refuses to show design text the creator resolved in favour of the lesson', async () => {
    const map = (await json<{ current: ScreenMapRecord }>(studio.get(`/api/projects/${project.id}/screen-map`))).current;
    const screens = map.mapping.screens.map((s) =>
      s.screenId === 'scn_trap_identify'
        ? { ...s, layers: [...s.layers, { elementId: s.conflicts[0]!.figmaElementId!, use: 'layer' as const }], conflicts: s.conflicts.map((c) => ({ ...c, status: 'resolved' as const, resolution: { choice: 'ppt' as const, text: null, note: '', at: new Date().toISOString() } })) }
        : s,
    );
    const res = await studio.put(`/api/projects/${project.id}/screen-map`, { mapping: { screens }, expectedNumber: map.number });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/you chose the PowerPoint wording, so it cannot be shown as a layer/);
  });

  it('builds the reviewed map: the lesson definition wins and the design supplies layout only', async () => {
    const map = (await json<{ current: ScreenMapRecord }>(studio.get(`/api/projects/${project.id}/screen-map`))).current;
    const screens = map.mapping.screens.map((s) => ({
      ...s,
      reviewed: true,
      conflicts: s.conflicts.map((c) => ({ ...c, status: 'resolved' as const, resolution: { choice: 'ppt' as const, text: null, note: 'The lesson defines a trapezium inclusively.', at: new Date().toISOString() } })),
    }));
    const saved = await json<{ map: ScreenMapRecord }>(studio.put(`/api/projects/${project.id}/screen-map`, { mapping: { screens }, expectedNumber: map.number, note: 'Reviewed' }));
    expect(saved.map.number).toBe(map.number + 1);
    // A stale save (against the old revision) is refused instead of overwriting.
    const stale = await studio.put(`/api/projects/${project.id}/screen-map`, { mapping: { screens }, expectedNumber: map.number });
    expect(stale.statusCode).toBe(409);

    const grade = (await json<{ plans: GradePlanRecord[] }>(studio.get(`/api/projects/${project.id}/grade-plans`))).plans[0]!;
    await json(studio.patch(`/api/grade-plans/${grade.id}/decisions`, { decisions: Object.fromEntries(grade.plan.items.map((i) => [i.id, 'accepted'])) }));
    const motion = (await json<{ plans: MotionPlanRecord[] }>(studio.get(`/api/projects/${project.id}/motion-plans`))).plans[0]!;
    await json(studio.post(`/api/motion-plans/${motion.id}/reject`));
    const { job } = await json<{ job: { id: string } }>(studio.post(`/api/projects/${project.id}/approve-build`, {}), 202);
    await studio.runJobs();
    const built = (await studio.job(job.id)).job;
    expect(built.status, JSON.stringify(built.error)).toBe('succeeded');
    const cfg = (await json<{ config: GameVersion['config'] }>(studio.get(`/api/projects/${project.id}/preview-bundle`))).config;
    expect(cfg.meta.screenMapNumber).toBe(saved.map.number);
    expect(cfg.motion.bindings).toEqual([]);
    const intro = cfg.scenes.find((s) => s.id === 'scn_trap_intro')!;
    expect(intro.interaction.type === 'info' && intro.interaction.points[0]).toBe('A trapezium is a quadrilateral with at least one pair of parallel sides.');
    const identify = cfg.scenes.find((s) => s.id === 'scn_trap_identify')!;
    expect(JSON.stringify(identify)).not.toMatch(/exactly one pair/);
    const panel = frames.find((f) => f.name === '02 Spot the parallel sides')!.elements.find((e) => e.id === '12:2')!;
    expect(identify.design).toMatchObject({ source: 'figma', mode: 'match', regions: { instruction: panel.box } });
    expect(identify.design!.layers).toEqual([]);
    // Exact uploaded artwork on every scene; the Figma render is reference only.
    const library = (await json<{ assets: Asset[] }>(studio.get(`/api/projects/${project.id}/assets`))).assets;
    const byName = (n: string) => must(library.find((a) => a.name === n && a.role !== 'reference'), n).id;
    expect(identify.assets).toMatchObject({ background: byName('ice-background'), panel: byName('Blank ice panel'), button: byName('Ice button'), character: byName('Swiftee'), characterClip: 'idle' });
    expect(Object.values(cfg.assets).some((a) => library.find((x) => x.id === a.id)?.role === 'reference')).toBe(false);
  });

  it('exports a handoff whose design map names Figma nodes but carries no token or design dump', async () => {
    const handoff = await studio.exportZip(project.id, { kind: 'handoff' });
    const folder = [...handoff.entries.keys()][0]!.split('/')[0]!;
    const map = JSON.parse(handoff.entries.get(`${folder}/design-map.json`)!.toString('utf8')) as { screens: Array<{ screenId: string; frames: Array<{ name: string; figma: { fileKey: string; nodeId: string } | null }>; conflicts: Array<{ kind: string; status: string; resolution: { choice: string } | null }> }> };
    const identify = map.screens.find((s) => s.screenId === 'scn_trap_identify')!;
    expect(identify.frames.map((f) => [f.name, f.figma?.fileKey, f.figma?.nodeId])).toEqual([
      ['02 Spot the parallel sides', 'TrapQuestDemo8x2026', '10:2'],
      ['02b Spot the parallel sides — hint state', 'TrapQuestDemo8x2026', '10:3'],
    ]);
    expect(identify.conflicts).toEqual([{ kind: 'definition', status: 'resolved', message: expect.any(String), resolution: { choice: 'ppt', text: null } }]);
    for (const [name, data] of handoff.entries) {
      const text = data.toString('utf8');
      expect(text.includes(TOKEN), name).toBe(false);
      expect(text.includes('"document"'), `${name} looks like a Figma file dump`).toBe(false);
    }
  });
});
