/**
 * Build-chat refinement and questions in LIVE mode. The bundled sample is demo
 * content, but job mode is decided per request: with a key present and the
 * model verified, refine/ask on the sample run live against Claude (here: the
 * local mock) — demo templates are only used when no key is configured.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ChatMessage, GameVersion, Proposal } from '@shared/schemas/records.ts';
import { blockedRequests, promptText, startMock, Studio, TEST_MODEL } from './harness.ts';
import { reply, type MockAnthropic, type RecordedRequest } from './mock-anthropic.ts';

let mock: MockAnthropic;
let s: Studio;
let projectId: string;

beforeAll(async () => {
  mock = await startMock();
  s = await Studio.start(mock);
  expect((await s.testConnection()).state).toBe('configured');
  const sample = await s.post('/api/projects/sample');
  expect(sample.status).toBe(201);
  projectId = sample.body.project.id;
});

beforeEach(() => mock.reset());

afterEach(() => {
  expect(mock.unscripted.map((r) => `${r.method} ${r.url}`)).toEqual([]);
});

afterAll(async () => {
  await s?.close();
  await mock?.close();
  expect(blockedRequests).toEqual([]);
});

async function currentVersion(): Promise<GameVersion> {
  const id = (await s.get(`/api/projects/${projectId}`)).body.project.currentVersionId as string;
  return (await s.get<{ version: GameVersion }>(`/api/versions/${id}`)).body.version;
}

async function versions(): Promise<Array<{ id: string; number: number }>> {
  return (await s.get(`/api/projects/${projectId}/versions`)).body.versions;
}

async function proposalsForJob(jobId: string): Promise<Proposal[]> {
  const all = (await s.get<{ proposals: Proposal[] }>(`/api/projects/${projectId}/proposals`)).body.proposals;
  const ids = new Set(s.app.db.all<{ id: string }>('SELECT id FROM proposals WHERE job_id = ?', [jobId]).map((r) => r.id));
  return all.filter((p) => ids.has(p.id));
}

async function chat(text: string, scope: { kind: 'project' | 'scene'; sceneId: string | null }, mode: 'refine' | 'ask' = 'refine') {
  const sent = await s.post(`/api/projects/${projectId}/chat`, { text, mode, scope: { ...scope, slideId: null }, area: 'build' });
  expect(sent.status).toBe(202);
  expect(sent.body.job).toMatchObject({ type: mode, mode: 'live', model: TEST_MODEL });
  expect(await s.runNext()).toBe(true);
  const detail = await s.getJob(sent.body.job.id);
  const messages = (await s.get<{ messages: ChatMessage[] }>(`/api/projects/${projectId}/chat`)).body.messages;
  const replyMessage = messages.find((m) => m.role === 'claude' && m.jobId === sent.body.job.id);
  return { ...detail, creatorMessage: sent.body.message as ChatMessage, reply: replyMessage };
}

const change = (c: { op: string; sceneId?: string | null; field?: string | null; value?: unknown; toIndex?: number | null; reason?: string }) => ({
  op: c.op,
  sceneId: c.sceneId ?? null,
  field: c.field ?? null,
  valueJson: c.value === undefined ? null : JSON.stringify(c.value),
  toIndex: c.toIndex ?? null,
  reason: c.reason ?? 'Requested by the creator',
});

describe('refine (live mode)', () => {
  it('stores a proposal with before/after values; nothing changes until “apply”; locked and non-allowlisted changes come back flagged and are never applied', async () => {
    const v1 = await currentVersion();
    const cfg = v1.config;
    expect(cfg.meta.demo).toBe(true); // demo content…
    expect(cfg.settings.locks).toEqual({ sequence: true, assetIdentity: true });
    const target = cfg.scenes.find((sc) => sc.interaction.type !== 'info')!;
    const targetIndex = cfg.scenes.indexOf(target);
    const last = cfg.scenes.at(-1)!;
    const newPos = target.layout.instructionPosition === 'top' ? 'bottom' : 'top';
    const newDecor = cfg.theme.decor === 'city' ? 'space' : 'city';
    const newBackground = cfg.theme.backgroundAssetId === null ? 'ast_notARealAsset1' : null;
    const versionsBefore = await versions();

    let request: RecordedRequest | null = null;
    mock.enqueueMessages((req) => {
      request = req;
      return reply.toolUse(
        'propose_changes',
        {
          summary: 'Instruction on top and city scenery',
          explanation: 'Moves the instruction panel and switches the scenery.',
          changes: [
            change({ op: 'set-scene-field', sceneId: target.id, field: 'layout.instructionPosition', value: newPos }),
            change({ op: 'set-project-field', field: 'theme.decor', value: newDecor }),
            change({ op: 'move-scene', sceneId: last.id, toIndex: 0 }),
            change({ op: 'set-project-field', field: 'theme.backgroundAssetId', value: newBackground }),
            change({ op: 'set-scene-field', sceneId: target.id, field: 'interaction.secretAnswer', value: '42' }),
          ],
          conflictsNoticed: ['The learning sequence is locked to the source order.'],
        },
        { preamble: 'I will move the instruction panel and switch to the city scenery.' },
      );
    });

    const { job, events, reply: answer } = await chat('Put the instructions on top, use the city scenery and start with the last scene', { kind: 'project', sceneId: null });
    expect(job.status).toBe('succeeded');
    expect(request).not.toBeNull();

    const [proposal] = await proposalsForJob(job.id);
    expect(proposal).toBeDefined();
    expect(job.result).toEqual({ proposalId: proposal!.id });
    expect(proposal).toMatchObject({ status: 'proposed', origin: 'claude', model: TEST_MODEL, baseVersionId: v1.id, scope: { kind: 'project', sceneId: null }, resultVersionId: null });
    expect(proposal!.ops).toHaveLength(4); // the non-allowlisted field never becomes an op
    expect(proposal!.results.map((r) => r.status)).toEqual(['applied', 'applied', 'conflict', 'conflict']);
    expect(proposal!.results[0]).toMatchObject({ before: target.layout.instructionPosition, after: newPos, label: 'Instruction position', where: `Scene ${targetIndex + 1} · ${target.title}` });
    expect(proposal!.results[1]).toMatchObject({ before: cfg.theme.decor, after: newDecor, where: 'Whole game' });
    expect(proposal!.results[2]).toMatchObject({ before: cfg.scenes.length, after: 1, impact: 'sequence', message: expect.stringMatching(/sequence is locked/) });
    expect(proposal!.results[3]).toMatchObject({ before: cfg.theme.backgroundAssetId, after: newBackground, message: expect.stringMatching(/asset identity is locked/) });
    expect(proposal!.explanation).toContain('“interaction.secretAnswer” is not an editable scene field.');
    expect(proposal!.explanation).toContain('Conflict: The learning sequence is locked to the source order.');
    expect(events.filter((e) => e.type === 'warning').map((e) => e.message)).toEqual(
      expect.arrayContaining(['“interaction.secretAnswer” is not an editable scene field.', 'Conflict noted by Claude: The learning sequence is locked to the source order.']),
    );
    expect(answer).toMatchObject({ origin: 'claude', status: 'complete', proposalId: proposal!.id, text: 'I will move the instruction panel and switch to the city scenery.' });
    expect(job.usage?.calls).toBe(1);

    // Nothing is applied yet: same versions, same current version, byte-identical configuration.
    expect(await versions()).toEqual(versionsBefore);
    expect((await currentVersion()).config).toEqual(cfg);

    // Apply: only the two applicable changes land, in a new version.
    const applied = await s.post(`/api/proposals/${proposal!.id}/apply`);
    expect(applied.status).toBe(200);
    const v2 = applied.body.version as GameVersion;
    expect(v2).toMatchObject({ number: v1.number + 1, origin: 'refinement', parentVersionId: v1.id });
    expect(applied.body.proposal).toMatchObject({ status: 'applied', resultVersionId: v2.id });
    expect(v2.config.scenes.find((sc) => sc.id === target.id)!.layout.instructionPosition).toBe(newPos);
    expect(v2.config.theme.decor).toBe(newDecor);
    expect(v2.config.scenes.map((sc) => sc.id)).toEqual(cfg.scenes.map((sc) => sc.id)); // locked order kept
    expect(v2.config.theme.backgroundAssetId).toBe(cfg.theme.backgroundAssetId); // locked asset identity kept
    expect((await currentVersion()).id).toBe(v2.id);
    expect((await s.post(`/api/proposals/${proposal!.id}/apply`)).status).toBe(409); // never applied twice
  });

  it('scene scope: changes outside the selected scene come back “out-of-scope”; rejecting the proposal changes nothing', async () => {
    const base = await currentVersion();
    const cfg = base.config;
    const target = cfg.scenes.find((sc) => sc.interaction.type !== 'info')!;
    const other = cfg.scenes.find((sc) => sc.id !== target.id)!;
    const versionsBefore = await versions();

    let request: RecordedRequest | null = null;
    mock.enqueueMessages((req) => {
      request = req;
      return reply.toolUse('propose_changes', {
        summary: 'Friendlier success message',
        explanation: 'Rewords the success feedback.',
        changes: [
          change({ op: 'set-scene-field', sceneId: target.id, field: 'feedback.success', value: 'Cleared for take-off — well flown!' }),
          change({ op: 'set-scene-field', sceneId: other.id, field: 'layout.density', value: other.layout.density === 'compact' ? 'comfortable' : 'compact' }),
          change({ op: 'set-project-field', field: 'title', value: 'A different game title' }),
          change({ op: 'move-scene', sceneId: target.id, toIndex: 0 }),
        ],
        conflictsNoticed: [],
      });
    });
    const { job } = await chat('Make the success message friendlier', { kind: 'scene', sceneId: target.id });
    expect(job.status).toBe('succeeded');

    const text = promptText(request!);
    expect(text).toContain(`Scope: selected scene ${target.id}`);
    const sceneConfig = JSON.parse(/<scene_config>\n([\s\S]*?)\n<\/scene_config>/.exec(text)![1]!) as Array<{ id: string }>;
    expect(sceneConfig.map((sc) => sc.id)).toEqual([target.id]); // only the selected scene's details are sent

    const [proposal] = await proposalsForJob(job.id);
    expect(proposal!.scope).toEqual({ kind: 'scene', sceneId: target.id });
    expect(proposal!.results.map((r) => r.status)).toEqual(['applied', 'out-of-scope', 'out-of-scope', 'out-of-scope']);
    expect(proposal!.results[0]).toMatchObject({ before: target.feedback.success, after: 'Cleared for take-off — well flown!' });
    expect(proposal!.results[1]!.message).toMatch(/outside the selected scene/);

    const rejected = await s.post(`/api/proposals/${proposal!.id}/reject`);
    expect(rejected.body.proposal.status).toBe('rejected');
    expect(await versions()).toEqual(versionsBefore);
    expect((await currentVersion()).config).toEqual(cfg);
  });

  it('a reply without a tool call stores no proposal and keeps Claude’s answer', async () => {
    mock.enqueueMessages(reply.text('Do you want bigger labels in every coordinate scene, or only in the selected one?'));
    const { job, reply: answer } = await chat('Make it nicer', { kind: 'project', sceneId: null });
    expect(job.status).toBe('succeeded');
    expect(job.result).toEqual({ proposalId: null });
    expect(await proposalsForJob(job.id)).toEqual([]);
    expect(answer).toMatchObject({ status: 'complete', origin: 'claude', proposalId: null, text: 'Do you want bigger labels in every coordinate scene, or only in the selected one?' });
  });

  describe('failures leave no proposal and mark the reply failed', () => {
    const validInput = () => ({ summary: 'x', explanation: 'y', changes: [], conflictsNoticed: [] });

    it('refusal', async () => {
      mock.enqueueMessages(reply.refusal({ category: 'general_harms', explanation: null }));
      const { job, reply: answer } = await chat('Change the scenery', { kind: 'project', sceneId: null });
      expect(job.status).toBe('failed');
      expect(job.error).toMatchObject({ code: 'claude_refusal', retryable: false });
      expect(await proposalsForJob(job.id)).toEqual([]);
      expect(answer).toMatchObject({ status: 'failed', proposalId: null });
    });

    it('truncated tool input (stop_reason "max_tokens")', async () => {
      const raw = JSON.stringify(validInput()).slice(0, 25);
      mock.enqueueMessages({ kind: 'stream', blocks: [{ type: 'tool_use', name: 'propose_changes', rawJson: raw }], stopReason: 'max_tokens' });
      const { job, reply: answer } = await chat('Change the scenery', { kind: 'project', sceneId: null });
      expect(job.status).toBe('failed');
      expect(job.error).toMatchObject({ code: 'claude_truncated' });
      expect(await proposalsForJob(job.id)).toEqual([]);
      expect(answer?.status).toBe('failed');
    });

    it('tool input that does not match the tool schema', async () => {
      mock.enqueueMessages(reply.toolUse('propose_changes', { summary: 'x', explanation: 'y', changes: [{ op: 'delete-everything' }] }));
      const { job, reply: answer } = await chat('Change the scenery', { kind: 'project', sceneId: null });
      expect(job.status).toBe('failed');
      expect(job.error).toMatchObject({ code: 'invalid_proposal', retryable: true });
      expect(job.error!.message).toMatch(/Nothing was changed/);
      expect(await proposalsForJob(job.id)).toEqual([]);
      expect(answer?.status).toBe('failed');
    });

    it('tool input that is not parseable JSON', async () => {
      mock.enqueueMessages({ kind: 'stream', blocks: [{ type: 'tool_use', name: 'propose_changes', rawJson: '{"summary": "x",, "changes": [}' }] });
      const { job, reply: answer } = await chat('Change the scenery', { kind: 'project', sceneId: null });
      expect(job.status).toBe('failed');
      expect(job.error).toMatchObject({ code: 'claude_invalid_output' });
      expect(await proposalsForJob(job.id)).toEqual([]);
      expect(answer?.status).toBe('failed');
    });
  });
});

describe('ask (live mode)', () => {
  it('streams the answer into the job log and stores it as a Claude chat message', async () => {
    const answerText = 'The grid scenes ask learners to move along x first, then y — slide 3 explains the order.';
    mock.enqueueMessages(reply.text(answerText, { chunkSize: 12, eventDelayMs: 5, usage: { input_tokens: 900, output_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }));
    const { job, events, reply: answer } = await chat('How do the grid scenes work?', { kind: 'project', sceneId: null }, 'ask');
    expect(job.status).toBe('succeeded');
    expect(answer).toMatchObject({ role: 'claude', origin: 'claude', status: 'complete', text: answerText });
    expect(job.result).toEqual({ messageId: answer!.id });
    expect(events.filter((e) => e.type === 'text').map((e) => e.message).join('')).toBe(answerText);
    expect(job.usage).toEqual({ inputTokens: 900, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 1 });
    expect(mock.messageRequests()[0]!.body).not.toHaveProperty('tools');
  });
});
