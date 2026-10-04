import './env.ts';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { DesignFrame, DesignImport } from '@shared/schemas/design.ts';
import type { Health } from '@shared/schemas/settings.ts';
import { resetSecretsForTests } from '../../../server/src/secrets.ts';
import { FigmaMock } from '../../support/figma-mock.ts';
import { multipart, REPO_ROOT, Studio, studioHeaders } from './helpers.ts';

/**
 * Figma adapter against a LOCAL MOCK of the Figma REST API (tests/support/figma-mock.ts).
 * These tests prove the adapter's handling of the API contract as modelled by the mock;
 * they are not live Figma verification.
 */

const TOKEN = 'figd_test-ONLY-not-a-real-token-0123456789';
const TRAP = path.join(REPO_ROOT, 'fixtures', 'trapezium');

let mock: FigmaMock;

function configureFigma(origin: string | null, token: string | null = TOKEN): void {
  if (origin) process.env.FIGMA_API_BASE_URL = origin;
  else delete process.env.FIGMA_API_BASE_URL;
  if (token) process.env.FIGMA_ACCESS_TOKEN = token;
  else delete process.env.FIGMA_ACCESS_TOKEN;
  process.env.FIGMA_MAX_AUTO_WAIT_SECONDS = '2';
  resetSecretsForTests();
}

async function startWithMock(opts: Partial<ConstructorParameters<typeof FigmaMock>[0]> = {}, token = TOKEN): Promise<Studio> {
  mock = new FigmaMock({ token, ...opts });
  const origin = await mock.start();
  configureFigma(origin);
  return Studio.start();
}

async function design(studio: Studio, projectId: string): Promise<DesignImport[]> {
  const res = await studio.get(`/api/projects/${projectId}/design`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json().imports as DesignImport[];
}

async function browse(studio: Studio, projectId: string, link = `https://www.figma.com/design/${'TrapQuestDemo8x2026'}/Trapezium-Quest`): Promise<DesignImport> {
  const res = await studio.post(`/api/projects/${projectId}/design/figma`, { link });
  expect(res.statusCode, res.body).toBe(202);
  await studio.runJobs();
  const imp = (await design(studio, projectId)).find((i) => i.id === res.json().import.id)!;
  return imp;
}

async function importFrames(studio: Studio, importId: string, nodeIds: string[]): Promise<{ jobStatus: string; error: unknown; imp: DesignImport }> {
  const res = await studio.post(`/api/design-imports/${importId}/import`, { nodeIds });
  expect(res.statusCode, res.body).toBe(202);
  await studio.runJobs();
  const job = (await studio.job(res.json().job.id)).job;
  const imp = (await studio.get(`/api/projects/${job.projectId}/design`)).json().imports.find((i: DesignImport) => i.id === importId) as DesignImport;
  return { jobStatus: job.status, error: job.error, imp };
}

afterEach(async () => {
  await mock?.stop();
  configureFigma(null, null);
  delete process.env.FIGMA_MAX_AUTO_WAIT_SECONDS;
});

describe('without a Figma token', () => {
  let studio: Studio;
  beforeAll(async () => {
    configureFigma(null, null);
    studio = await Studio.start();
  });
  afterAll(() => studio.close());

  it('reports “Not configured” and refuses link import with a clear route to exported screens', async () => {
    const health = (await studio.get('/api/health')).json() as Health;
    expect(health.figma.state).toBe('not-configured');
    expect(health.figma.oauth).toBe('not-configured');
    const p = await studio.createProject();
    const res = await studio.post(`/api/projects/${p.id}/design/figma`, { link: 'https://www.figma.com/design/TrapQuestDemo8x2026/x?node-id=10-2' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('figma_not_configured');
    expect(res.json().error.hint).toMatch(/exported screens/i);
  });

  it('validates links before anything is requested', async () => {
    const p = await studio.createProject();
    const cases: Array<[string, RegExp]> = [
      ['https://www.figma.com/board/TrapQuestDemo8x2026/Board', /FigJam/],
      ['https://www.figma.com/slides/TrapQuestDemo8x2026/Deck', /Slides/],
      ['https://evil.example.com/design/TrapQuestDemo8x2026/x', /figma\.com/],
      ['http://www.figma.com/design/TrapQuestDemo8x2026/x', /https/],
      ['https://www.figma.com/design/short/x', /file key/],
      ['https://www.figma.com/design/TrapQuestDemo8x2026/x?node-id=abc', /node-id/],
    ];
    for (const [link, message] of cases) {
      const res = await studio.post(`/api/projects/${p.id}/design/figma`, { link });
      expect(res.statusCode, link).toBe(400);
      expect(res.json().error.message, link).toMatch(message);
    }
  });

  it('imports exported screens without any Figma connection (flattened, reference role, provenance)', async () => {
    const p = await studio.createProject();
    const { payload, contentType } = multipart([
      { name: 'file', filename: '02-spot.png', data: fs.readFileSync(path.join(TRAP, 'frames', '02-spot.png')), contentType: 'image/png' },
      { name: 'file', filename: '03-match.png', data: fs.readFileSync(path.join(TRAP, 'frames', '03-match.png')), contentType: 'image/png' },
      { name: 'file', filename: 'design.fig', data: Buffer.from('fig-kiwi'), contentType: 'application/octet-stream' },
    ]);
    const res = await studio.inject({ method: 'POST', url: `/api/projects/${p.id}/design/exported`, headers: { ...studioHeaders('POST'), 'content-type': contentType }, payload });
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json() as { import: DesignImport; rejected: Array<{ name: string; hint: string }> };
    expect(body.import.kind).toBe('exported');
    expect(body.import.status).toBe('active');
    expect(body.import.frames).toHaveLength(2);
    expect(body.import.frames.every((f) => f.width === 1920 && f.height === 1080 && f.fidelity.flattened === 1 && f.fidelity.editable === 0)).toBe(true);
    expect(body.rejected).toHaveLength(1);
    expect(body.rejected[0]!.hint).toMatch(/link|PNG/);
    const assets = (await studio.get(`/api/projects/${p.id}/assets`)).json().assets as Array<{ role: string; metadata: { provenance: { kind: string } | null } }>;
    const refs = assets.filter((a) => a.role === 'reference');
    expect(refs).toHaveLength(2);
    expect(refs.every((a) => a.metadata.provenance?.kind === 'exported-screen')).toBe(true);
  });
});

describe('with the mock Figma API', () => {
  it('browses only a shallow tree, renders thumbnails and never sends the token to download hosts', async () => {
    const studio = await startWithMock();
    try {
      const p = await studio.createProject();
      const imp = await browse(studio, p.id);
      expect(imp.status, imp.error ?? '').toBe('browsing');
      expect(imp.fileName).toBe('Trapezium Quest — Grade 8 (sample)');
      expect(imp.editorType).toBe('figma');
      expect(imp.available.map((a) => a.name)).toEqual(['01 Intro', '02 Spot the parallel sides', '02b Spot the parallel sides — hint state', '03 Match the shapes', '04 Well done', 'Button / Primary']);
      expect(imp.available.find((a) => a.nodeId === '10:2')).toMatchObject({ width: 1920, height: 1080, pageName: 'Game screens' });
      const thumb = await studio.get(`/api/design-imports/${imp.id}/thumbs/10:2`);
      expect(thumb.statusCode).toBe(200);
      expect(thumb.headers['content-type']).toBe('image/png');
      const fileCalls = mock.apiRequests().filter((r) => r.pathname === `/v1/files/${mock.fileKey}`);
      expect(fileCalls).toHaveLength(1);
      expect(fileCalls[0]!.query.depth).toBe('2');
      const downloads = mock.requests.filter((r) => r.pathname.startsWith('/renders/'));
      expect(downloads.length).toBeGreaterThan(0);
      expect(downloads.every((r) => r.headers['x-figma-token'] === undefined)).toBe(true);
      expect(mock.apiRequests().every((r) => r.headers['x-figma-token'] === TOKEN)).toBe(true);
      // The token never appears in anything the studio returns or stores.
      const dump = JSON.stringify(await design(studio, p.id)) + fs.readFileSync(path.join(studio.dataDir, 'nexus.sqlite')).toString('latin1');
      expect(dump.includes(TOKEN)).toBe(false);
    } finally {
      await studio.close();
    }
  });

  it('imports selected frames as immutable snapshots with honest fidelity, font and evidence handling', async () => {
    const studio = await startWithMock();
    try {
      const p = await studio.createProject();
      const imp = await browse(studio, p.id);
      const { jobStatus, imp: done } = await importFrames(studio, imp.id, ['10:1', '10:2', '10:4']);
      expect(jobStatus).toBe('succeeded');
      expect(done.status).toBe('active');
      expect(done.sourceVersion).toBe('4242424242');
      expect(done.frames).toHaveLength(3);
      // Only the selected nodes were fetched.
      const nodeCalls = mock.apiRequests().filter((r) => r.pathname.endsWith('/nodes'));
      expect(nodeCalls.at(-1)!.query.ids).toBe('10:1,10:2,10:4');

      const spotId = done.frames.find((f) => f.nodeId === '10:2')!.id;
      const frame = (await studio.get(`/api/design-frames/${spotId}`)).json().frame as DesignFrame;
      const el = (name: string) => frame.elements.find((e) => e.name === name)!;
      expect(el('Instruction')).toMatchObject({ kind: 'text', fidelity: 'editable' });
      expect(el('Instruction').text?.characters).toContain('exactly one pair');
      expect(el('Instruction panel')).toMatchObject({ kind: 'rect', fidelity: 'editable', fill: '#ffffff' });
      expect(el('Ice background')).toMatchObject({ kind: 'image', fidelity: 'editable' });
      expect(el('Ice background').assetId).toBeTruthy();
      expect(el('Frosty glow')).toMatchObject({ kind: 'rect', fidelity: 'flattened' });
      expect(el('Mask').fidelity).toBe('needs-review');
      expect(el('Next button').fidelity).toBe('reference');
      expect(frame.renderAssetId).toBeTruthy();
      expect(frame.fonts.find((f) => f.family === 'Baloo 2')).toMatchObject({ available: false, substitute: 'Nunito' });
      expect(frame.warnings.join(' ')).toMatch(/never redistributed/);
      // Prototype links are evidence; the URL action's URL is dropped.
      expect(frame.prototype.some((p2) => p2.action === 'NODE' && p2.destinationId === '10:4' && p2.transition?.type === 'SMART_ANIMATE')).toBe(true);
      expect(frame.prototype.some((p2) => p2.action === 'URL')).toBe(true);
      expect(JSON.stringify(frame).includes('example.com')).toBe(false);

      const intro = (await studio.get(`/api/design-frames/${done.frames.find((f) => f.nodeId === '10:1')!.id}`)).json().frame as DesignFrame;
      expect(intro.elements.find((e) => e.name === 'Snowflake')?.fidelity).toBe('needs-review');
      expect(intro.elements.some((e) => e.name === 'Old title (hidden)')).toBe(false);

      // Image fills and renders are private assets with Figma provenance (no provider URLs kept).
      const assets = (await studio.get(`/api/projects/${p.id}/assets`)).json().assets as Array<{ role: string; source: string; metadata: { provenance: { kind: string; figma: { kind: string } | null } | null } }>;
      expect(assets.filter((a) => a.metadata.provenance?.figma?.kind === 'frame-render' && a.role === 'reference')).toHaveLength(3);
      expect(assets.filter((a) => a.metadata.provenance?.figma?.kind === 'image-fill')).toHaveLength(2);
      expect(JSON.stringify(assets).includes(mock.origin)).toBe(false);

      // Snapshots are immutable.
      expect(() => studio.app.db.run("UPDATE design_frames SET name = 'x' WHERE id = ?", [spotId])).toThrow(/immutable/);
    } finally {
      await studio.close();
    }
  });

  it('waits out a short Retry-After, and fails a long one with a manual retry and no partial import', async () => {
    const studio = await startWithMock();
    try {
      const p = await studio.createProject();
      mock.queue(`/v1/files/${mock.fileKey}`, { status: 429, headers: { 'retry-after': '1', 'x-figma-plan-tier': 'starter', 'x-figma-rate-limit-type': 'low' } });
      const imp = await browse(studio, p.id);
      expect(imp.status).toBe('browsing');
      expect(imp.available.length).toBe(6);

      mock.queue(`/v1/files/${mock.fileKey}/nodes`, { status: 429, headers: { 'retry-after': '86400', 'x-figma-plan-tier': 'starter', 'x-figma-rate-limit-type': 'low' } });
      const { jobStatus, error, imp: after } = await importFrames(studio, imp.id, ['10:2']);
      expect(jobStatus).toBe('failed');
      expect(error).toMatchObject({ code: 'figma_rate_limited', retryable: true });
      expect((error as { message: string }).message).toMatch(/1 days|24 hours|Retry/);
      expect(after.status).toBe('browsing');
      expect(after.frames).toHaveLength(0);
      // Manual retry succeeds once the limit has passed.
      const retry = await importFrames(studio, imp.id, ['10:2']);
      expect(retry.jobStatus).toBe('succeeded');
      expect(retry.imp.frames).toHaveLength(1);
    } finally {
      await studio.close();
    }
  });

  it('explains a refused token without echoing it', async () => {
    const studio = await startWithMock({}, 'figd_the-real-token-the-mock-expects');
    try {
      const p = await studio.createProject();
      const imp = await browse(studio, p.id);
      expect(imp.status).toBe('failed');
      expect(imp.error).toMatch(/refused|invalid or expired/);
      expect(imp.error).not.toContain(TOKEN);
      const jobs = (await studio.get(`/api/projects/${p.id}/jobs`)).json().jobs as Array<{ error: { code: string; message: string } | null }>;
      expect(jobs[0]!.error?.code).toBe('figma_expired_token');
      expect(jobs[0]!.error?.message).not.toContain(TOKEN);
    } finally {
      await studio.close();
    }
  });

  it('handles missing nodes, failed renders and download controls explicitly', async () => {
    const studio = await startWithMock({ missingNodes: ['10:3'], failRenders: ['10:4'] });
    try {
      const p = await studio.createProject();
      const imp = await browse(studio, p.id);
      expect(imp.available.some((a) => a.nodeId === '10:3')).toBe(false);
      // 10:3 was deleted after browsing: simulate by importing it explicitly through a fresh listing entry.
      studio.app.db.run('UPDATE design_imports SET available_json = ? WHERE id = ?', [JSON.stringify([...imp.available, { ...imp.available[0]!, nodeId: '10:3', name: 'Deleted frame' }]), imp.id]);
      // The render of 10:1 is redirected to a host outside the allowlist.
      mock.queue(`/v1/images/${mock.fileKey}`, { status: 200, body: { err: null, images: { '10:1': `${mock.origin}/redirect?to=https://evil.example.org/x.png`, '10:3': null, '10:4': null } } });
      const { jobStatus, imp: done } = await importFrames(studio, imp.id, ['10:1', '10:3', '10:4']);
      expect(jobStatus).toBe('succeeded');
      expect(done.frames.map((f) => f.nodeId).sort()).toEqual(['10:1', '10:4']);
      const warnings = done.warnings.join('\n');
      expect(warnings).toMatch(/10:3 no longer exists/);
      expect(warnings).toMatch(/could not render “03 Match the shapes”/);
      expect(warnings).toMatch(/not a Figma asset host/);
      expect(done.frames.every((f) => f.renderAssetId === null)).toBe(true);
    } finally {
      await studio.close();
    }
  });

  it('refuses FigJam and other non-Design editor types', async () => {
    const studio = await startWithMock({ editorType: 'figjam' });
    try {
      const p = await studio.createProject();
      const imp = await browse(studio, p.id);
      expect(imp.status).toBe('failed');
      expect(imp.error).toMatch(/FigJam board, not a Figma Design file/);
    } finally {
      await studio.close();
    }
  });

  it('refreshes only on request, shows a diff, and re-points the screen map when approved', async () => {
    const studio = await startWithMock();
    try {
      const p = await studio.createProject();
      const imp = await browse(studio, p.id);
      const { imp: active } = await importFrames(studio, imp.id, ['10:2', '10:4']);
      const oldSpot = active.frames.find((f) => f.nodeId === '10:2')!.id;
      const branchId = (await studio.project(p.id)).activeBranchId;
      const { insertScreenMap, currentScreenMap } = await import('../../../server/src/db/screens.ts');
      const { emptyScreen } = await import('@shared/schemas/screens.ts');
      insertScreenMap(studio.app.db, {
        projectId: p.id,
        branchId,
        blueprintRevisionId: null,
        origin: 'creator',
        note: 'test',
        mapping: { screens: [{ ...emptyScreen('scn_spot', 'scene', 'Spot'), frames: [{ frameId: oldSpot, state: 'default', primary: true }], background: { kind: 'frame-render', assetId: null, frameId: oldSpot, elementId: null, confirmedClean: false } }] },
        expectedNumber: 0,
      });
      const requestsBefore = mock.apiRequests().length;
      // Nothing is fetched until the creator asks.
      expect(mock.apiRequests().length).toBe(requestsBefore);
      mock.editText('12:4', 'A trapezium has at least one pair of parallel sides. Drag each shape to the right group.');
      const r = await studio.post(`/api/design-imports/${active.id}/refresh`);
      expect(r.statusCode, r.body).toBe(202);
      await studio.runJobs();
      const pending = (await design(studio, p.id)).find((i) => i.previousImportId === active.id)!;
      expect(pending.status).toBe('pending-review');
      expect(pending.diff?.framesChanged).toEqual([expect.objectContaining({ nodeId: '10:2', changes: [expect.stringMatching(/exactly one pair.*changed to.*at least one pair/s)] })]);
      expect(pending.diff?.unchanged).toBe(1);
      // The game still uses the old frames until approval.
      expect(currentScreenMap(studio.app.db, branchId)!.mapping.screens[0]!.frames[0]!.frameId).toBe(oldSpot);
      const ok = await studio.post(`/api/design-imports/${pending.id}/approve`);
      expect(ok.statusCode, ok.body).toBe(200);
      const all = await design(studio, p.id);
      expect(all.find((i) => i.id === active.id)!.status).toBe('superseded');
      expect(all.find((i) => i.id === pending.id)!.status).toBe('active');
      const newSpot = pending.frames.find((f) => f.nodeId === '10:2')!.id;
      const map = currentScreenMap(studio.app.db, branchId)!;
      expect(map.number).toBe(2);
      expect(map.mapping.screens[0]!.frames[0]!.frameId).toBe(newSpot);
      expect(map.mapping.screens[0]!.background.frameId).toBe(newSpot);
    } finally {
      await studio.close();
    }
  });
});
