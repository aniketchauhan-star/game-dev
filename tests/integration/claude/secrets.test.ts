/**
 * Secret hygiene. After success AND failure scenarios — including API errors
 * that echo the key back — the fake key must appear only in the x-api-key
 * header sent to the (mock) API: never in the database (any table, or the raw
 * SQLite/WAL bytes), job events, API responses, exported zips, files under the
 * data directory, or console output.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { JobDetail } from './harness.ts';
import { blockedRequests, captureConsole, FAKE_KEY, readZipEntries, slideIdsInPrompt, startMock, Studio, TEST_MODEL, validAnalysis } from './harness.ts';
import { reply, type MockAnthropic, type RecordedRequest } from './mock-anthropic.ts';

/** Distinctive fragment of the key: catches partial echoes as well as the full key. */
const FRAGMENT = 'FAKEKEY';
const PREFIX_ECHO = FAKE_KEY.slice(0, 24); // what an API might echo: "sk-ant-test-FAKEKEY-0123"

let consoleCapture: ReturnType<typeof captureConsole>;
let mock: MockAnthropic;
let s: Studio;
const allMockRequests: RecordedRequest[] = [];
const exportedEntries: Array<{ zip: string; name: string; data: Buffer }> = [];
const jobIds: string[] = [];
let deckProjectId = '';
let sampleId = '';

const answerFromPrompt = (req: RecordedRequest) => reply.json(validAnalysis(slideIdsInPrompt(req)));

beforeAll(async () => {
  consoleCapture = captureConsole(); // before the server modules load
  mock = await startMock();
  s = await Studio.start(mock);
});

afterAll(async () => {
  consoleCapture?.restore();
  await s?.close();
  await mock?.close();
  expect(blockedRequests).toEqual([]);
});

function drainMock(): void {
  allMockRequests.push(...mock.requests);
  expect(mock.unscripted.map((r) => `${r.method} ${r.url}`)).toEqual([]);
  mock.reset();
}

async function analyze(projectId: string): Promise<JobDetail> {
  const d = await s.analyze(projectId);
  jobIds.push(d.job.id);
  return d;
}

async function chat(projectId: string, text: string, mode: 'refine' | 'ask'): Promise<JobDetail> {
  const sent = await s.post(`/api/projects/${projectId}/chat`, { text, mode, scope: { kind: 'project', sceneId: null, slideId: null }, area: 'build' });
  expect(sent.status).toBe(202);
  await s.runNext();
  jobIds.push(sent.body.job.id);
  return s.getJob(sent.body.job.id);
}

describe('secret hygiene', () => {
  it('runs the success scenarios: verify, analysis, refine + apply, ask, token count', async () => {
    expect((await s.testConnection()).state).toBe('configured');
    deckProjectId = (await s.projectWithDeck()).projectId;
    mock.enqueueMessages(answerFromPrompt);
    expect((await analyze(deckProjectId)).job.status).toBe('succeeded');

    sampleId = (await s.post('/api/projects/sample')).body.project.id;
    const cfg = (await s.get(`/api/projects/${sampleId}/preview-bundle`)).body.config;
    mock.enqueueMessages(
      reply.toolUse(
        'propose_changes',
        {
          summary: 'City scenery',
          explanation: 'Switches the background scenery.',
          changes: [{ op: 'set-project-field', sceneId: null, field: 'theme.decor', valueJson: JSON.stringify(cfg.theme.decor === 'city' ? 'space' : 'city'), toIndex: null, reason: 'Requested' }],
          conflictsNoticed: [],
        },
        { preamble: 'Switching the scenery.' },
      ),
    );
    const refine = await chat(sampleId, 'Use the city scenery', 'refine');
    expect(refine.job.status).toBe('succeeded');
    const proposalId = (refine.job.result as { proposalId: string }).proposalId;
    expect((await s.post(`/api/proposals/${proposalId}/apply`)).status).toBe(200);

    mock.enqueueMessages(reply.text('Scenes 2 and 4 use the coordinate grid.'));
    expect((await chat(sampleId, 'Which scenes use the grid?', 'ask')).job.status).toBe('succeeded');

    mock.enqueueTokenCounts({ kind: 'json', body: { input_tokens: 777 } });
    expect((await s.get(`/api/projects/${deckProjectId}/ai-preview?countTokens=1`)).body.tokenCount).toBe(777);
    drainMock();
  });

  it('runs failure scenarios; error messages that echo the key are redacted before they are stored or returned', async () => {
    // Models API 403 whose message echoes the full key.
    mock.enqueueModelLookups(reply.error(403, 'permission_error', `API key ${FAKE_KEY} does not have access to model ${TEST_MODEL}`));
    const denied = await s.testConnection();
    expect(denied.state).toBe('connection_failed');
    expect(denied.lastError).toContain('[redacted]');
    expect(denied.lastError).not.toContain(FRAGMENT);
    expect((await s.testConnection()).state).toBe('configured'); // recover for the job scenarios

    // 400 whose message echoes the full key.
    mock.enqueueMessages(reply.error(400, 'invalid_request_error', `x-api-key header value ${FAKE_KEY} is not valid for this workspace`));
    const echoed = await analyze(deckProjectId);
    expect(echoed.job.status).toBe('failed');
    expect(echoed.job.error?.code).toBe('claude_bad_request');
    expect(echoed.job.error?.message).toContain('[redacted]');
    expect(echoed.job.error?.message).not.toContain(FRAGMENT);

    // Mid-stream error event that echoes a key prefix.
    mock.enqueueMessages((req) => ({ ...answerFromPrompt(req), errorAfter: { events: 4, type: 'api_error', message: `upstream rejected credential ${PREFIX_ECHO}…` } }));
    const partial = await analyze(deckProjectId);
    expect(partial.job.status).toBe('failed');
    expect(partial.job.error?.message).toContain('sk-ant-[redacted]');
    expect(partial.job.error?.message).not.toContain(FRAGMENT);

    // 401 / 403 on the Messages API (refine), echoing the key.
    mock.enqueueMessages(reply.error(403, 'permission_error', `The key ${FAKE_KEY} may not use ${TEST_MODEL}`));
    const forbidden = await chat(sampleId, 'Make the grid easier to see', 'refine');
    expect(forbidden.job.error?.code).toBe('claude_permission');
    expect(forbidden.job.error?.message).toContain('[redacted]');
    expect(forbidden.job.error?.message).not.toContain(FRAGMENT);
    mock.enqueueMessages(reply.error(401, 'authentication_error', `invalid x-api-key: ${FAKE_KEY}`));
    const unauthorized = await chat(sampleId, 'What is this game about?', 'ask');
    expect(unauthorized.job.error?.code).toBe('claude_auth');
    expect(unauthorized.job.error?.message).not.toContain(FRAGMENT);

    // Token counting failure echoing the key → the preview's note is redacted.
    mock.enqueueTokenCounts(reply.error(400, 'invalid_request_error', `bad credential ${FAKE_KEY}`));
    const preview = await s.get(`/api/projects/${deckProjectId}/ai-preview?countTokens=1`);
    expect(preview.body.tokenCount).toBeNull();
    expect(preview.body.tokenNote).toContain('[redacted]');
    expect(preview.body.tokenNote).not.toContain(FRAGMENT);

    // Plain failures: refusal, truncation, rate limit (no echo, but they exercise the error paths).
    mock.enqueueMessages(reply.refusal({ category: 'cyber', explanation: 'declined' }));
    expect((await analyze(deckProjectId)).job.error?.code).toBe('claude_refusal');
    mock.enqueueMessages(reply.text('{"topic": "Coord', { stopReason: 'max_tokens' }));
    expect((await analyze(deckProjectId)).job.error?.code).toBe('claude_truncated');
    mock.enqueueMessages(reply.rateLimited(0), reply.rateLimited(0), reply.rateLimited(0));
    expect((await analyze(deckProjectId)).job.error?.code).toBe('claude_rate_limited');
    drainMock();

    // The redaction helper itself also masks other key-shaped strings.
    expect(s.mods.redactSecrets(`a ${FAKE_KEY} b sk-ant-api03-AbCdEfGh12345678 c`)).toBe('a [redacted] b sk-ant-[redacted] c');
  });

  it('exports (playable, handoff with source material) contain no key', async () => {
    for (const body of [{ kind: 'playable' }, { kind: 'handoff', includeSourceMaterial: true, nextChanges: 'Add a harder final scene.' }, { kind: 'source', includeSourceMaterial: true }]) {
      const created = await s.post(`/api/projects/${sampleId}/exports`, body);
      expect(created.status, created.raw).toBe(201);
      const rec = created.body.export;
      expect(rec.preflight.checks.find((c: { id: string }) => c.id === 'secrets')).toMatchObject({ status: 'pass' });
      const download = await s.get(`/api/exports/${rec.id}/download`);
      expect(download.status).toBe(200);
      expect(download.rawPayload.includes(Buffer.from(FAKE_KEY))).toBe(false);
      const entries = await readZipEntries(download.rawPayload);
      expect(entries.length).toBeGreaterThan(3);
      for (const e of entries) exportedEntries.push({ zip: rec.fileName, ...e });
    }
    expect(exportedEntries.some((e) => e.name.endsWith('game.config.js'))).toBe(true);
    expect(exportedEntries.some((e) => e.name.endsWith('CLAUDE.md'))).toBe(true);
  });

  it('the key appears only in the x-api-key header — nowhere in the database, events, API responses, exports, files or console output', async () => {
    // Fetch every read endpoint the studio uses so their payloads are scanned too.
    await s.health();
    await s.get('/api/settings/claude/models');
    await s.get('/api/usage');
    const projects = (await s.get('/api/projects')).body.projects as Array<{ id: string }>;
    expect(projects.length).toBeGreaterThanOrEqual(2);
    for (const { id } of projects) {
      for (const p of ['', '/jobs', '/chat', '/analysis', '/proposals', '/versions', '/exports', '/slides', '/blueprints', '/ai-preview', '/preview-bundle']) {
        await s.get(`/api/projects/${id}${p}`);
      }
    }
    for (const id of jobIds) await s.getJob(id);
    const sse = await s.get(`/api/jobs/${jobIds[0]}/events`);
    expect(sse.raw).toContain('event: end');
    drainMock();

    // 1. The key really was in use: every request to the API carried it in x-api-key, and nowhere else.
    expect(allMockRequests.length).toBeGreaterThanOrEqual(15);
    for (const r of allMockRequests) {
      expect(r.headers['x-api-key']).toBe(FAKE_KEY);
      for (const [name, value] of Object.entries(r.headers)) if (name !== 'x-api-key') expect(String(value)).not.toContain(FRAGMENT);
      expect(r.url).not.toContain(FRAGMENT);
      expect(r.rawBody).not.toContain(FRAGMENT);
    }

    // 2. Database: every row of every table, and the raw SQLite / WAL / SHM bytes.
    const dump = s.dumpDb();
    expect(Object.keys(dump)).toEqual(expect.arrayContaining(['settings', 'jobs', 'job_events', 'usage_log', 'chat_messages', 'proposals', 'analyses', 'exports']));
    for (const [table, rows] of Object.entries(dump)) expect(rows, `table ${table}`).not.toContain(FRAGMENT);
    expect(dump.jobs).toContain('[redacted]'); // the echoed keys were stored only in redacted form
    expect(s.filesContaining(FAKE_KEY)).toEqual([]);
    expect(s.filesContaining(FRAGMENT)).toEqual([]);

    // 3. Job events (also covered by the dump, checked here through the API as the studio reads them).
    for (const id of jobIds) expect(JSON.stringify((await s.getJob(id)).events)).not.toContain(FRAGMENT);

    // 4. Every API response fetched during this file.
    expect(s.responses.length).toBeGreaterThan(50);
    for (const r of s.responses) expect(r.body, `${r.method} ${r.url}`).not.toContain(FRAGMENT);

    // 5. Exported archives, entry by entry.
    expect(exportedEntries.length).toBeGreaterThan(10);
    for (const e of exportedEntries) expect(e.data.includes(Buffer.from(FRAGMENT)), `${e.zip}: ${e.name}`).toBe(false);

    // 6. Console output of the API, the worker and the SDK (logLevel "off") in this process.
    expect(consoleCapture.text()).not.toContain(FRAGMENT);
  });
});
