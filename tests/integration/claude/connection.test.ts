/**
 * Claude connection states through the Settings routes and the real gateway:
 * not configured → connection failed → configured (verified with capabilities),
 * and the `model_unverified` gate on AI jobs (at enqueue time and at run time).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ClaudeStatus } from '@shared/schemas/settings.ts';
import { blockedRequests, FAKE_KEY, startMock, Studio, TEST_MODEL, type ClaudeEnv } from './harness.ts';
import { modelInfo, reply, type MockAnthropic } from './mock-anthropic.ts';

let mock: MockAnthropic;
const open: Studio[] = [];

async function studio(env: ClaudeEnv = {}): Promise<Studio> {
  const s = await Studio.start(mock, env);
  open.push(s);
  return s;
}

beforeAll(async () => {
  mock = await startMock();
});

afterEach(async () => {
  while (open.length) await open.pop()!.close();
  expect(mock.unscripted.map((r) => `${r.method} ${r.url}`)).toEqual([]);
  mock.reset();
});

afterAll(async () => {
  await mock?.close();
  expect(blockedRequests).toEqual([]);
});

describe('Claude connection states', () => {
  it('without a key: “not configured”, nothing is sent to Claude, live AI jobs are refused and only the bundled sample runs in demo mode', async () => {
    const s = await studio({ key: null });
    const before = await s.claudeStatus();
    expect(before).toMatchObject({ state: 'not_configured', keyPresent: false, model: TEST_MODEL, modelInfo: null, verifiedAt: null, lastError: null });

    // “Test connection” cannot do anything without a key — and must not call the API.
    const tested = await s.testConnection();
    expect(tested.state).toBe('not_configured');

    const models = await s.get('/api/settings/claude/models');
    expect(models.status).toBe(502);
    expect(models.body.error.message).toMatch(/not configured/i);

    const { projectId } = await s.projectWithDeck();
    const refused = await s.startJob(projectId, 'analyze');
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('claude_not_configured');

    // The bundled sample replays prepared content in demo mode (labelled, never Claude).
    const sample = await s.post('/api/projects/sample');
    expect(sample.status).toBe(201);
    const demo = await s.startJob(sample.body.project.id, 'analyze');
    expect(demo.status).toBe(202);
    expect(demo.body.job.mode).toBe('demo');
    await s.runNext();
    const { job } = await s.getJob(demo.body.job.id);
    expect(job.status).toBe('succeeded');
    const analysis = (await s.get(`/api/projects/${sample.body.project.id}/analysis`)).body.analysis;
    expect(analysis.origin).toBe('demo');
    expect(analysis.model).toBeNull();

    expect(mock.requests).toHaveLength(0);
  });

  it('with a key and an unknown model: the Models API 404 becomes “connection failed” with a clear message, and AI jobs stay blocked', async () => {
    const s = await studio({ model: 'claude-imaginary-9' });
    expect((await s.claudeStatus()).state).toBe('unverified');

    const { projectId } = await s.projectWithDeck();
    const early = await s.startJob(projectId, 'analyze');
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('claude_unverified');

    const st = await s.testConnection();
    expect(st).toMatchObject({ state: 'connection_failed', keyPresent: true, model: 'claude-imaginary-9', modelSource: 'env', verifiedAt: null, modelInfo: null });
    expect(st.lastError).toMatch(/not available to this API key \(404\)/);
    expect(st.lastError).toMatch(/Choose another model/);

    const lookups = mock.modelRequests();
    expect(lookups).toHaveLength(1);
    expect(lookups[0]!.pathname).toBe('/v1/models/claude-imaginary-9');
    expect(lookups[0]!.headers['x-api-key']).toBe(FAKE_KEY);
    expect(lookups[0]!.status).toBe(404);

    const still = await s.startJob(projectId, 'analyze');
    expect(still.status).toBe(409);
    expect(still.body.error.code).toBe('claude_unverified');
    expect((await s.get(`/api/projects/${projectId}/jobs`)).body.jobs.filter((j: { type: string }) => j.type === 'analyze')).toHaveLength(0);
    expect(mock.messageRequests()).toHaveLength(0);
  });

  it('with a key and an available model: “configured”, with the capabilities read from the Models API stored', async () => {
    const s = await studio();
    expect(await s.claudeStatus()).toMatchObject({ state: 'unverified', verifiedAt: null, modelInfo: null, modelSource: 'env', baseUrlOverridden: true });

    const st = await s.testConnection();
    expect(st.state).toBe('configured');
    expect(st.lastError).toBeNull();
    expect(Number.isNaN(Date.parse(st.verifiedAt ?? ''))).toBe(false);
    const expectedInfo: ClaudeStatus['modelInfo'] = {
      id: TEST_MODEL,
      displayName: 'Claude Opus 5.5',
      maxInputTokens: 1_000_000,
      maxOutputTokens: 128_000,
      structuredOutputs: true,
      imageInput: true,
      pdfInput: true,
      effort: true,
    };
    expect(st.modelInfo).toEqual(expectedInfo);

    // Persisted: a new status read (and the health route) reports the same verification.
    const row = s.app.db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'claude.verification'");
    expect(JSON.parse(row!.value)).toMatchObject({ model: TEST_MODEL, error: null, info: expectedInfo });
    expect((await s.health()).claude).toMatchObject({ state: 'configured', modelInfo: expectedInfo });

    // Only the Models API was used for verification.
    expect(mock.requests.map((r) => `${r.method} ${r.pathname}`)).toEqual([`GET /v1/models/${TEST_MODEL}`]);

    const { projectId } = await s.projectWithDeck();
    const ok = await s.startJob(projectId, 'analyze');
    expect(ok.status).toBe(202);
    expect(ok.body.job).toMatchObject({ mode: 'live', model: TEST_MODEL, status: 'queued' });
  });

  it('an invalid key (401 from the Models API) is reported as a failed connection', async () => {
    const s = await studio();
    mock.enqueueModelLookups(reply.error(401, 'authentication_error', 'invalid x-api-key'));
    const st = await s.testConnection();
    expect(st.state).toBe('connection_failed');
    expect(st.lastError).toMatch(/rejected the API key \(401\)/);
  });

  it('a model without structured outputs is not accepted', async () => {
    mock.models.set('claude-legacy-1', modelInfo('claude-legacy-1', { displayName: 'Claude Legacy', structuredOutputs: false }));
    const s = await studio({ model: 'claude-legacy-1' });
    const st = await s.testConnection();
    expect(st.state).toBe('connection_failed');
    expect(st.lastError).toMatch(/does not support structured outputs/);
    expect(st.modelInfo?.structuredOutputs).toBe(false);
  });

  it('models chosen in Settings come from the live Models API list and are verified on selection', async () => {
    const s = await studio({ model: null });
    expect(await s.claudeStatus()).toMatchObject({ state: 'unverified', model: null, modelSource: null });

    const list = await s.get('/api/settings/claude/models');
    expect(list.status).toBe(200);
    expect(list.body.models.map((m: { id: string }) => m.id)).toEqual([TEST_MODEL, 'claude-sonnet-5-5', 'claude-haiku-4-5']);
    expect(list.body.models[0]).toMatchObject({ id: TEST_MODEL, displayName: 'Claude Opus 5.5', createdAt: '2026-08-12T00:00:00Z' });

    const haiku = await s.post('/api/settings/claude/model', { model: 'claude-haiku-4-5' });
    expect(haiku.status).toBe(200);
    expect(haiku.body.claude).toMatchObject({ state: 'configured', model: 'claude-haiku-4-5', modelSource: 'settings' });
    expect(haiku.body.claude.modelInfo).toMatchObject({ maxInputTokens: 200_000, maxOutputTokens: 64_000, effort: false });

    const bad = await s.post('/api/settings/claude/model', { model: 'claude-imaginary-9' });
    expect(bad.body.claude.state).toBe('connection_failed');

    const back = await s.post('/api/settings/claude/model', { model: TEST_MODEL });
    expect(back.body.claude.state).toBe('configured');

    // CLAUDE_MODEL in the environment takes precedence over the Settings choice.
    const envStudio = await studio();
    const refused = await envStudio.post('/api/settings/claude/model', { model: 'claude-haiku-4-5' });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('model_from_env');
  });

  it('the optional connection test sends one small structured request and reports its failure honestly', async () => {
    const s = await studio();
    mock.enqueueMessages(reply.json({ ok: true }, { usage: { input_tokens: 31, output_tokens: 7, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }));
    const ok = await s.testConnection(true);
    expect(ok.state).toBe('configured');

    const [req] = mock.messageRequests();
    expect(req!.body).toMatchObject({ model: TEST_MODEL, max_tokens: 2048, stream: true, output_config: { effort: 'low', format: { type: 'json_schema' } } });
    const schema = (req!.body!.output_config as { format: { schema: { properties: Record<string, { type: string }> } } }).format.schema;
    expect(schema.properties.ok?.type).toBe('boolean');
    expect(s.app.db.all("SELECT stage, job_id, input_tokens, output_tokens, stop_reason FROM usage_log")).toEqual([
      { stage: 'connection-test', job_id: null, input_tokens: 31, output_tokens: 7, stop_reason: 'end_turn' },
    ]);

    mock.enqueueMessages(reply.error(400, 'invalid_request_error', 'output_config.format: schema is too complex'));
    const failed = await s.testConnection(true);
    expect(failed.state).toBe('connection_failed');
    expect(failed.verifiedAt).toBeNull();
    expect(failed.lastError).toMatch(/could not accept the request \(400\)/);
    expect(failed.lastError).toMatch(/schema is too complex/);
  });

  it('a job enqueued while verified fails with model_unverified at run time once verification is lost — and sends nothing', async () => {
    const s = await studio({ model: null });
    expect((await s.post('/api/settings/claude/model', { model: TEST_MODEL })).body.claude.state).toBe('configured');
    const { projectId } = await s.projectWithDeck();
    const queued = await s.startJob(projectId, 'analyze');
    expect(queued.status).toBe(202);

    // The creator switches to a model the key cannot use; verification fails.
    expect((await s.post('/api/settings/claude/model', { model: 'claude-imaginary-9' })).body.claude.state).toBe('connection_failed');

    expect(await s.runNext()).toBe(true);
    const { job, events } = await s.getJob(queued.body.job.id);
    expect(job.status).toBe('failed');
    expect(job.error).toMatchObject({ code: 'claude_model_unverified', retryable: false });
    expect(job.error?.message).toMatch(/claude-imaginary-9 has not been verified/);
    expect(events.some((e) => e.type === 'error' && /has not been verified/.test(e.message))).toBe(true);
    expect(mock.messageRequests()).toHaveLength(0);
    expect(s.analysisCount(projectId)).toBe(0);
  });

  it('chat refinements and questions are refused until the model is verified', async () => {
    const s = await studio({ model: 'claude-imaginary-9' });
    const sample = (await s.post('/api/projects/sample')).body.project;
    for (const mode of ['refine', 'ask'] as const) {
      const r = await s.post(`/api/projects/${sample.id}/chat`, { text: 'Make the grid easier to see', mode, scope: { kind: 'project', sceneId: null, slideId: null }, area: 'build' });
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe('claude_unverified');
    }
    expect((await s.get(`/api/projects/${sample.id}/chat`)).body.messages).toHaveLength(0);
    expect(mock.requests).toHaveLength(0);
  });
});
