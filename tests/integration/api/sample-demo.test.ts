import './env.ts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BlueprintRevision } from '@shared/schemas/blueprint.ts';
import { gameConfigSchema, type GameConfig } from '@shared/schemas/game.ts';
import type { Job } from '@shared/schemas/jobs.ts';
import type { ProjectDetail, ProjectSummary } from '@shared/schemas/project.ts';
import type { ChatMessage, GameVersion, GameVersionSummary, Proposal } from '@shared/schemas/records.ts';
import { databaseBytes, idempotencyKey, SAMPLE_PROJECT_NAME, SAMPLE_TITLES_IN_ORDER, Studio, type Res } from './helpers.ts';

type Scope = { kind: 'project' | 'scene'; sceneId: string | null; slideId: null };

describe('bundled sample in demo mode (no Claude)', () => {
  let s: Studio;
  let sample: ProjectDetail;
  let v1: GameVersion;

  beforeAll(async () => {
    s = await Studio.start();
    sample = await s.createSample();
    v1 = (await s.get(`/api/versions/${sample.currentVersionId}`)).json().version as GameVersion;
  });

  afterAll(async () => {
    await s.close();
  });

  const sceneOf = (type: string, nth = 0) => v1.config.scenes.filter((sc) => sc.interaction.type === type)[nth]!;
  const sceneScope = (sceneId: string): Scope => ({ kind: 'scene', sceneId, slideId: null });
  const projectScope: Scope = { kind: 'project', sceneId: null, slideId: null };
  const proposals = async () => (await s.get(`/api/projects/${sample.id}/proposals`)).json().proposals as Proposal[];
  const messages = async () => (await s.get(`/api/projects/${sample.id}/chat`)).json().messages as ChatMessage[];
  const current = async () => (await s.project(sample.id)).currentVersionId;
  const version = async (id: string) => (await s.get(`/api/versions/${id}`)).json().version as GameVersion;

  /** Post a chat request like the studio does and run the resulting job on the worker. */
  async function ask(text: string, mode: 'refine' | 'ask', scope: Scope, extra: Record<string, unknown> = {}): Promise<{ res: Res; job: Job; reply: ChatMessage | undefined }> {
    const res = await s.post(`/api/projects/${sample.id}/chat`, { text, mode, scope, area: mode === 'refine' ? 'build' : 'general', ...extra }, { 'idempotency-key': idempotencyKey() });
    expect(res.statusCode, res.body).toBe(202);
    expect(res.json().job).toMatchObject({ type: mode, mode: 'demo', model: null, status: 'queued' });
    await s.runJobs();
    const { job } = await s.job(res.json().job.id);
    const reply = (await messages()).find((m) => m.jobId === job.id && m.role === 'claude');
    return { res, job, reply };
  }

  /** A version's config without the fields that identify the version itself. */
  const content = (c: GameConfig) => ({ ...c, id: null, meta: { ...c.meta, versionNumber: null, origin: null } });

  it('is created through its route and labelled as sample/demo content in API responses', async () => {
    expect(sample).toMatchObject({ name: SAMPLE_PROJECT_NAME, isSample: true, state: 'playable', statusLabel: 'Playable', currentVersionNumber: 1, slideCount: 9, createStep: 'review' });
    expect(sample.documents).toHaveLength(1);
    expect(sample.documents[0]).toMatchObject({ role: 'bundled-sample', kind: 'pptx', status: 'ready', originalName: 'air-traffic-control.pptx' });
    const listed = ((await s.get('/api/projects')).json().projects as ProjectSummary[]).find((p) => p.id === sample.id);
    expect(listed?.isSample).toBe(true);

    // The deck went through the real ingestion pipeline.
    expect((await s.slides(sample.id)).map((x) => x.extract.title)).toEqual([...SAMPLE_TITLES_IN_ORDER]);

    // Prepared analysis and blueprint are marked as demo content, not as Claude output.
    const analysis = (await s.get(`/api/projects/${sample.id}/analysis`)).json().analysis;
    expect(analysis).toMatchObject({ origin: 'demo', model: null, stale: false });
    const revisions = (await s.get(`/api/projects/${sample.id}/blueprints`)).json().revisions as BlueprintRevision[];
    expect(revisions.map((r) => [r.number, r.status, r.origin, r.model])).toEqual([[1, 'approved', 'demo', null]]);

    const versions = (await s.get(`/api/projects/${sample.id}/versions`)).json();
    expect(versions.currentVersionId).toBe(v1.id);
    expect((versions.versions as GameVersionSummary[]).map((v) => [v.number, v.origin, v.demo])).toEqual([[1, 'sample', true]]);
    expect(v1.config.meta).toMatchObject({ demo: true, origin: 'sample', versionNumber: 1, projectId: sample.id });
    expect(gameConfigSchema.safeParse(v1.config).success).toBe(true);

    const bundle = (await s.get(`/api/projects/${sample.id}/preview-bundle`)).json();
    expect(bundle.version).toMatchObject({ id: v1.id, demo: true, origin: 'sample' });
    expect(bundle.assets.every((a: { available: boolean }) => a.available)).toBe(true);

    const assets = (await s.get(`/api/projects/${sample.id}/assets`)).json().assets as Array<{ source: string }>;
    expect(assets.length).toBe(3);
    expect(assets.every((a) => a.source === 'bundled-sample')).toBe(true);

    const health = (await s.get('/api/health')).json();
    expect(health.claude).toMatchObject({ keyPresent: false, state: 'not_configured' });
  });

  it('runs analysis and blueprint steps as labelled demo jobs for the sample only', async () => {
    const analyze = await s.post(`/api/projects/${sample.id}/jobs`, { type: 'analyze', input: {} }, { 'idempotency-key': idempotencyKey() });
    expect(analyze.statusCode, analyze.body).toBe(202);
    expect(analyze.json().job).toMatchObject({ mode: 'demo', model: null });
    await s.runJobs();
    const a = (await s.job(analyze.json().job.id)).job;
    expect(a.status).toBe('succeeded');
    expect(a.result).toMatchObject({ demo: true });
    expect(a.usage).toBeNull();
    expect((await s.get(`/api/projects/${sample.id}/analysis`)).json().analysis).toMatchObject({ number: 2, origin: 'demo' });

    const bp = await s.post(`/api/projects/${sample.id}/jobs`, { type: 'blueprint', input: { analysisId: null } }, { 'idempotency-key': idempotencyKey() });
    expect(bp.statusCode, bp.body).toBe(202);
    await s.runJobs();
    const b = (await s.job(bp.json().job.id)).job;
    expect(b.status).toBe('succeeded');
    expect(b.result).toMatchObject({ number: 2, demo: true });
    const r2 = ((await s.get(`/api/projects/${sample.id}/blueprints`)).json().revisions as BlueprintRevision[])[0]!;
    expect(r2).toMatchObject({ number: 2, status: 'draft', origin: 'demo', model: null });

    const regen = await s.post(`/api/projects/${sample.id}/jobs`, { type: 'regenerate_scene', input: { blueprintRevisionId: r2.id, sceneId: r2.blueprint.scenes[1]!.id, guidance: 'Harder please' } });
    expect(regen.statusCode).toBe(409);
    expect(regen.json().error.code).toBe('demo_unsupported');
  });

  it('a regular project without Claude cannot run AI steps — it is told why instead of getting fake output', async () => {
    const p = await s.createProject('Not the sample');
    await s.importDeck(p.id);
    const analyze = await s.post(`/api/projects/${p.id}/jobs`, { type: 'analyze', input: {} });
    expect(analyze.statusCode).toBe(409);
    expect(analyze.json().error).toMatchObject({ code: 'claude_not_configured', message: 'Claude is not configured, so this step cannot run.' });
    expect(analyze.json().error.hint).toMatch(/start a blueprint yourself/);
    const chat = await s.post(`/api/projects/${p.id}/chat`, { text: 'Make the grid and points easier to see', mode: 'refine', scope: projectScope, area: 'build' });
    expect(chat.statusCode).toBe(409);
    expect(chat.json().error.code).toBe('claude_not_configured');
    expect((await s.get(`/api/projects/${p.id}/jobs`)).json().jobs.filter((j: Job) => j.type !== 'extract_pptx')).toEqual([]);
    expect((await s.get(`/api/projects/${p.id}/chat`)).json().messages).toEqual([]);
  });

  describe('demo refinement', () => {
    let proposal: Proposal;
    let v2: GameVersion;

    it('a template request on a coordinate scene produces a demo proposal with before/after values', async () => {
      const scene = sceneOf('coordinate-navigation');
      const before = await current();
      const { res, job, reply } = await ask('Make the grid and points easier to see', 'refine', sceneScope(scene.id), { baseVersionId: v1.id });
      expect(res.json().message).toMatchObject({ role: 'creator', origin: 'creator', text: 'Make the grid and points easier to see' });
      expect(job.status).toBe('succeeded');
      expect(job.result).toMatchObject({ demo: true });
      const proposalId = (job.result as { proposalId: string }).proposalId;
      expect(proposalId).toBeTruthy();

      proposal = (await proposals()).find((p) => p.id === proposalId)!;
      expect(proposal).toMatchObject({
        origin: 'demo',
        model: null,
        status: 'proposed',
        baseVersionId: v1.id,
        baseVersionNumber: 1,
        scope: { kind: 'scene', sceneId: scene.id },
        summary: 'Stronger grid lines, larger points and labels',
      });
      expect(proposal.ops).toEqual([{ op: 'set-scene-field', sceneId: scene.id, field: 'interaction.display', value: { gridEmphasis: 'high', pointSize: 'large', labelSize: 'large' } }]);
      expect(proposal.results).toHaveLength(1);
      expect(proposal.results[0]).toMatchObject({
        status: 'applied',
        before: { gridEmphasis: 'standard', pointSize: 'standard', labelSize: 'standard' },
        after: { gridEmphasis: 'high', pointSize: 'large', labelSize: 'large' },
        where: `Scene 2 · ${scene.title}`,
        sourceSlideIds: scene.sourceSlideIds,
      });

      expect(reply).toMatchObject({ origin: 'demo', status: 'complete', proposalId });
      expect(reply!.text.startsWith('Prepared demo template, not Claude.')).toBe(true);
      // A proposal is only a proposal: the game has not changed yet.
      expect(await current()).toBe(before);
    });

    it('applying it creates a new immutable version with only that change', async () => {
      const res = await s.post(`/api/proposals/${proposal.id}/apply`);
      expect(res.statusCode, res.body).toBe(200);
      v2 = res.json().version as GameVersion;
      expect(v2).toMatchObject({ number: 2, origin: 'refinement', demo: true, parentVersionId: v1.id, summary: proposal.summary });
      expect(res.json().proposal).toMatchObject({ status: 'applied', resultVersionId: v2.id, resultVersionNumber: 2 });
      expect(gameConfigSchema.safeParse(v2.config).success).toBe(true);

      const sceneId = proposal.scope.sceneId!;
      const changed = v2.config.scenes.find((sc) => sc.id === sceneId)!;
      expect(changed.interaction.type === 'coordinate-navigation' && changed.interaction.display).toEqual({ gridEmphasis: 'high', pointSize: 'large', labelSize: 'large' });
      const others = (c: GameConfig) => c.scenes.filter((sc) => sc.id !== sceneId);
      expect(others(v2.config)).toEqual(others(v1.config));
      expect(await current()).toBe(v2.id);
      expect((await version(v1.id)).config).toEqual(v1.config);
      expect((await messages()).at(-1)).toMatchObject({ role: 'system', text: 'Applied 1 change → version 2.' });

      const again = await s.post(`/api/proposals/${proposal.id}/apply`);
      expect(again.statusCode).toBe(409);
      expect(again.json().error.message).toBe('This proposal is already applied.');
    });

    it('undo creates another new version that restores the earlier configuration', async () => {
      const res = await s.post(`/api/proposals/${proposal.id}/undo`);
      expect(res.statusCode, res.body).toBe(200);
      const v3 = res.json().version as GameVersion;
      expect(v3).toMatchObject({ number: 3, origin: 'undo', demo: true, parentVersionId: v2.id });
      expect(res.json().proposal.status).toBe('undone');
      expect(content(v3.config)).toEqual(content(v1.config));
      expect(await current()).toBe(v3.id);
      const list = (await s.get(`/api/projects/${sample.id}/versions`)).json().versions as GameVersionSummary[];
      expect(list.map((v) => [v.number, v.origin])).toEqual([[3, 'undo'], [2, 'refinement'], [1, 'sample']]);
      expect((await messages()).at(-1)!.text).toBe(`Undid “${proposal.summary}” → version 3 (same as version 1).`);

      const twice = await s.post(`/api/proposals/${proposal.id}/undo`);
      expect(twice.statusCode).toBe(409);
      expect(twice.json().error.message).toBe('Only an applied change can be undone.');
    });

    it('a request that matches no prepared template gets a plain message and no proposal (never fake success)', async () => {
      const proposalsBefore = (await proposals()).length;
      const before = await current();
      const { job, reply } = await ask('Please add a dancing zebra named Quixotic-Marmalade-4417 to the hangar scene', 'refine', projectScope);
      expect(job.status).toBe('succeeded');
      expect(job.result).toEqual({ proposalId: null, demo: true });
      expect(reply).toMatchObject({ origin: 'demo', status: 'complete', proposalId: null });
      expect(reply!.text).toMatch(/^Without a Claude connection I can only replay prepared changes for these requests: /);
      expect(reply!.text).toContain('“Make the grid and points easier to see”');
      expect((await proposals()).length).toBe(proposalsBefore);
      expect(await current()).toBe(before);
    });

    it('a template that does not fit the selected scope explains why, with no proposal', async () => {
      const proposalsBefore = (await proposals()).length;
      const info = sceneOf('info');
      const grid = await ask('Make the grid and points easier to see', 'refine', sceneScope(info.id));
      expect(grid.job.result).toEqual({ proposalId: null, demo: true });
      expect(grid.reply!.text).toMatch(/^Prepared demo template, not Claude: This prepared change applies to coordinate scenes such as “/);
      const declutter = await ask('Make this screen less cluttered', 'refine', projectScope);
      expect(declutter.reply!.text).toBe('Prepared demo template, not Claude: This prepared change edits one scene. Select a scene in the list, then ask again.');
      expect((await proposals()).length).toBe(proposalsBefore);
    });

    it('a proposal made for an older version is refused and marked stale instead of overwriting newer work', async () => {
      const base = await current();
      const a = await ask('Make this screen less cluttered', 'refine', sceneScope(sceneOf('drag-match').id));
      const b = await ask('Make the grid and points easier to see', 'refine', sceneScope(sceneOf('coordinate-navigation', 1).id));
      const aId = (a.job.result as { proposalId: string }).proposalId;
      const bId = (b.job.result as { proposalId: string }).proposalId;
      expect((await s.post(`/api/proposals/${aId}/apply`)).statusCode).toBe(200);
      const newer = await current();
      expect(newer).not.toBe(base);

      const stale = await s.post(`/api/proposals/${bId}/apply`);
      expect(stale.statusCode).toBe(409);
      expect(stale.json().error.message).toMatch(/^This proposal was made for version \d+, but the game is now at version \d+\.$/);
      expect(await current()).toBe(newer);
      // The creator must see that this proposal can no longer be applied.
      expect((await proposals()).find((p) => p.id === bId)!.status).toBe('stale');
    });

    it('a rejected proposal can no longer be applied', async () => {
      const before = await current();
      const { job } = await ask('Make this screen less cluttered', 'refine', sceneScope(sceneOf('sequence-sort').id));
      const id = (job.result as { proposalId: string }).proposalId;
      const rejected = await s.post(`/api/proposals/${id}/reject`);
      expect(rejected.statusCode).toBe(200);
      expect(rejected.json().proposal.status).toBe('rejected');
      const apply = await s.post(`/api/proposals/${id}/apply`);
      expect(apply.statusCode).toBe(409);
      expect(apply.json().error.message).toBe('This proposal is already rejected.');
      expect(await current()).toBe(before);
    });

    it('ask mode replies that answering needs Claude', async () => {
      const { job, reply } = await ask('What does an ordered pair mean?', 'ask', projectScope);
      expect(job.status).toBe('succeeded');
      expect(job.result).toEqual({ demo: true });
      expect(reply).toMatchObject({ origin: 'demo', status: 'complete' });
      expect(reply!.text).toMatch(/^Answering questions needs a configured Claude connection/);
    });

    it('repeating a chat request with the same Idempotency-Key does not queue it twice', async () => {
      const key = idempotencyKey();
      const body = { text: 'Make this screen less cluttered', mode: 'refine', scope: sceneScope(sceneOf('coordinate-navigation', 2).id), area: 'build' };
      const first = await s.post(`/api/projects/${sample.id}/chat`, body, { 'idempotency-key': key });
      expect(first.statusCode).toBe(202);
      const second = await s.post(`/api/projects/${sample.id}/chat`, body, { 'idempotency-key': key });
      expect(second.statusCode).toBe(200);
      expect(second.json()).toMatchObject({ message: null, deduplicated: true, job: { id: first.json().job.id } });
      await s.runJobs();
      const creatorCopies = (await messages()).filter((m) => m.role === 'creator' && m.jobId === first.json().job.id);
      expect(creatorCopies).toHaveLength(1);
    });

    it('inspector edits create a manual-edit version; restore brings back an earlier version as a new one', async () => {
      const fresh = await s.createSample();
      const base = (await s.get(`/api/versions/${fresh.currentVersionId}`)).json().version as GameVersion;
      const edit = await s.post(`/api/projects/${fresh.id}/edits`, {
        baseVersionId: base.id,
        ops: [{ op: 'set-project-field', field: 'screens.completion.heading', value: 'Cleared for landing' }],
        scope: { kind: 'project', sceneId: null },
        summary: 'New completion heading',
      });
      expect(edit.statusCode, edit.body).toBe(200);
      const edited = edit.json().version as GameVersion;
      expect(edit.json().proposal).toMatchObject({ origin: 'creator', status: 'applied', resultVersionId: edited.id });
      expect(edited).toMatchObject({ number: 2, origin: 'manual-edit', parentVersionId: base.id, demo: true });
      expect(edited.config.screens.completion.heading).toBe('Cleared for landing');

      const restored = await s.post(`/api/versions/${base.id}/restore`);
      expect(restored.statusCode, restored.body).toBe(200);
      const v3 = restored.json().version as GameVersion;
      expect(v3).toMatchObject({ number: 3, origin: 'restore', parentVersionId: edited.id, summary: 'Restored version 1' });
      expect(content(v3.config)).toEqual(content(base.config));
      const again = await s.post(`/api/versions/${v3.id}/restore`);
      expect(again.statusCode).toBe(409);
      expect(again.json().error.message).toBe('Version 3 is already current.');
    });

    it('a refused inspector edit creates no version and does not leave its change pending', async () => {
      const fresh = await s.createSample();
      const v = (await s.get(`/api/versions/${fresh.currentVersionId}`)).json().version as GameVersion;
      // The sample keeps the source lesson order: moving a scene is refused by the sequence lock.
      const locked = await s.post(`/api/projects/${fresh.id}/edits`, { baseVersionId: v.id, ops: [{ op: 'move-scene', sceneId: v.config.scenes[3]!.id, toIndex: 0 }], scope: { kind: 'project', sceneId: null }, summary: 'Reorder scenes' });
      expect(locked.statusCode).toBe(400);
      expect(locked.json().error.message).toBe('None of the proposed changes can be applied (they are locked, out of scope, invalid or already in place).');
      expect((await s.project(fresh.id)).currentVersionId).toBe(v.id);
      expect((await s.get(`/api/projects/${fresh.id}/versions`)).json().versions).toHaveLength(1);

      // An edit against an older version is refused as well.
      const ok = await s.post(`/api/projects/${fresh.id}/edits`, { baseVersionId: v.id, ops: [{ op: 'set-project-field', field: 'settings.reducedMotion', value: true }], scope: { kind: 'project', sceneId: null }, summary: 'Reduce motion' });
      expect(ok.statusCode).toBe(200);
      const late = await s.post(`/api/projects/${fresh.id}/edits`, { baseVersionId: v.id, ops: [{ op: 'set-project-field', field: 'settings.audio.sfx', value: false }], scope: { kind: 'project', sceneId: null }, summary: 'Mute effects' });
      expect(late.statusCode).toBe(409);

      // Neither refused change may stay listed as “proposed” (it can never be applied).
      const list = (await s.get(`/api/projects/${fresh.id}/proposals`)).json().proposals as Proposal[];
      const status = (summary: string) => list.find((p) => p.summary === summary)?.status;
      expect({ reorder: status('Reorder scenes'), mute: status('Mute effects') }).toEqual({ reorder: 'failed', mute: 'stale' });
    });

    it('a key pasted into the chat is redacted wherever the request is stored or returned', async () => {
      const pasted = 'sk-ant-api03-PASTEDINTOCHAT0123456789';
      const { res, job } = await ask(`Make the grid and points easier to see ${pasted}`, 'refine', projectScope);
      const returned = [
        ['POST /chat', res.body],
        ['GET /chat (messages + proposals)', (await s.get(`/api/projects/${sample.id}/chat`)).body],
        ['GET /proposals', (await s.get(`/api/projects/${sample.id}/proposals`)).body],
        ['GET /jobs/:id', (await s.get(`/api/jobs/${job.id}`)).body],
      ] as const;
      // The creator's own message is already redacted…
      const mine = (await messages()).find((m) => m.jobId === job.id && m.role === 'creator')!;
      expect(mine.text).toBe('Make the grid and points easier to see sk-ant-[redacted]');
      const leaks = returned.filter(([, body]) => body.includes('PASTEDINTOCHAT')).map(([label]) => label);
      const storedInDb = databaseBytes(s.dataDir).includes(Buffer.from('PASTEDINTOCHAT'));
      expect({ leaks, storedInDb }).toEqual({ leaks: [], storedInDb: false });
    });
  });
});
