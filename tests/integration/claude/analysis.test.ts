/**
 * Analysis jobs end to end: API → queue → worker → gateway → official SDK →
 * local mock (SSE) → validation → SQLite. Covers the happy path and every
 * failure mode the gateway promises to report honestly without storing output.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { checkAnalysisReferences } from '@shared/schemas/analysis.ts';
import type { AnalysisRecord } from '@shared/schemas/records.ts';
import { blockedRequests, promptText, sleep, slideIdsInPrompt, startMock, Studio, TEST_MODEL, validAnalysis, type JobDetail } from './harness.ts';
import { reply, type MockAnthropic, type RecordedRequest, type StreamReply } from './mock-anthropic.ts';

const MAX_RETRIES = 2;
const MAX_REPAIRS = 2;

let mock: MockAnthropic;
let s: Studio;

beforeAll(async () => {
  mock = await startMock();
  s = await Studio.start(mock, { maxRetries: MAX_RETRIES, maxRepairAttempts: MAX_REPAIRS });
  expect((await s.testConnection()).state).toBe('configured');
});

beforeEach(() => mock.reset());

afterEach(() => {
  expect(mock.unscripted.map((r) => `${r.method} ${r.url}`), 'requests the test did not script').toEqual([]);
});

afterAll(async () => {
  await s?.close();
  await mock?.close();
  expect(blockedRequests).toEqual([]);
});

/** A structured answer built from the slide ids the prompt actually listed. */
const answerFromPrompt = (extra: Partial<StreamReply> = {}) => (req: RecordedRequest) => ({ ...reply.json(validAnalysis(slideIdsInPrompt(req))), ...extra });

async function expectNothingStored(studio: Studio, projectId: string, jobId: string): Promise<void> {
  expect(studio.analysisCount(projectId)).toBe(0);
  expect((await studio.get(`/api/projects/${projectId}/analysis`)).body.analysis).toBeNull();
  expect(studio.stageRows(jobId).map((r) => r.stage_key)).not.toContain('learning-map');
  expect((await studio.get(`/api/projects/${projectId}`)).body.project.currentAnalysisId).toBeNull();
}

/** Run the next job, but give up (and cancel it, so the worker returns) after `ms`. */
async function runWithDeadline(studio: Studio, jobId: string, ms: number): Promise<JobDetail & { timedOut: boolean; elapsedMs: number }> {
  const started = Date.now();
  const run = studio.runNext();
  const winner = await Promise.race([run.then(() => 'done' as const), sleep(ms).then(() => 'deadline' as const)]);
  if (winner === 'deadline') {
    await studio.post(`/api/jobs/${jobId}/cancel`);
    await run;
  }
  return { ...(await studio.getJob(jobId)), timedOut: winner === 'deadline', elapsedMs: Date.now() - started };
}

describe('analysis — happy path', () => {
  it('streams a valid learning map that is validated and stored with origin “claude”, the model id, checked slide references and token usage', async () => {
    const { projectId, slides, includedIds } = await s.projectWithDeck();
    expect(slides).toHaveLength(4);
    expect(includedIds).toHaveLength(3); // the hidden answer-key slide is excluded

    let listed: string[] = [];
    mock.enqueueMessages((req) => {
      listed = slideIdsInPrompt(req);
      return reply.json(validAnalysis(listed), { usage: { input_tokens: 2210, output_tokens: 655, cache_creation_input_tokens: 1300, cache_read_input_tokens: 0 } });
    });

    const enqueued = await s.startJob(projectId, 'analyze');
    expect(enqueued.status).toBe(202);
    expect(enqueued.body.job).toMatchObject({ type: 'analyze', mode: 'live', model: TEST_MODEL, status: 'queued' });
    expect(await s.runNext()).toBe(true);
    const { job, events } = await s.getJob(enqueued.body.job.id);

    expect(job.status).toBe('succeeded');
    expect(job.error).toBeNull();
    expect(listed).toEqual(includedIds); // the prompt cites exactly the included slides, in deck order

    const stored = (await s.get<{ analysis: AnalysisRecord }>(`/api/projects/${projectId}/analysis`)).body.analysis;
    expect(stored).toMatchObject({ origin: 'claude', model: TEST_MODEL, number: 1, stale: false });
    expect(job.result).toEqual({ analysisId: stored.id, model: TEST_MODEL, fellBack: false });
    expect(job.model).toBe(TEST_MODEL);

    const a = stored.analysis;
    expect(a.topic).toBe('Coordinates on the plane');
    expect(a.objectives.map((o) => ({ text: o.text, src: o.sourceSlideIds, origin: o.origin, status: o.status, locked: o.locked }))).toEqual([
      { text: 'Plot a point from an ordered pair', src: [listed[1]], origin: 'claude', status: 'proposed', locked: false },
      { text: 'Identify the quadrant that contains a point', src: [listed[2]], origin: 'claude', status: 'proposed', locked: false },
    ]);
    expect(a.interactions[0]).toMatchObject({ id: 'int-1', mechanic: 'coordinate-navigation', sourceSlideIds: [listed[1], listed[2]], addedPractice: false });
    const cited = [...a.concepts, ...a.prerequisites, ...a.objectives, ...a.examples, ...a.questions, ...a.interactions].flatMap((x) => x.sourceSlideIds);
    expect(cited.length).toBeGreaterThan(0);
    for (const id of cited) expect(includedIds).toContain(id);
    expect(checkAnalysisReferences(a, new Set(includedIds))).toEqual([]);

    // Usage: job total, per-call usage log and the activity event all carry the streamed counts.
    expect(job.usage).toEqual({ inputTokens: 2210, outputTokens: 655, cacheReadTokens: 0, cacheWriteTokens: 1300, calls: 1 });
    expect(s.usageRows(job.id)).toMatchObject([
      { stage: 'learning-map', requested_model: TEST_MODEL, model: TEST_MODEL, input_tokens: 2210, output_tokens: 655, cache_read_tokens: 0, cache_write_tokens: 1300, stop_reason: 'end_turn' },
    ]);
    expect(events.find((e) => e.type === 'usage')?.data).toMatchObject({ inputTokens: 2210, outputTokens: 655, model: TEST_MODEL });
    expect(events.map((e) => e.message)).toEqual(expect.arrayContaining([`Sending request to Claude (${TEST_MODEL})`, 'Receiving response']));
    expect((await s.get(`/api/usage`)).body.rows.some((r: { job_id: string; input_tokens: number }) => r.job_id === job.id && r.input_tokens === 2210)).toBe(true);

    expect(mock.messageRequests()).toHaveLength(1);
    expect(mock.messageRequests()[0]!.clientAborted).toBe(false);
  });

  it('a reference to a slide that is not in the prompt (the hidden slide) is rejected and repaired before anything is stored', async () => {
    const { projectId, slides, includedIds } = await s.projectWithDeck();
    const hiddenId = slides.find((sl) => sl.hidden)!.id;
    mock.enqueueMessages(
      (req) => {
        const a = validAnalysis(slideIdsInPrompt(req));
        a.examples[0]!.sourceSlideIds = [hiddenId];
        return reply.json(a);
      },
      answerFromPrompt(),
    );
    const { job, events } = await s.analyze(projectId);
    expect(job.status).toBe('succeeded');
    const reqs = mock.messageRequests();
    expect(reqs).toHaveLength(2);
    expect(promptText(reqs[1]!)).toContain('Your previous answer was');
    expect(promptText(reqs[1]!)).toContain(`Unknown or excluded slide reference "${hiddenId}"`);
    expect(events.some((e) => e.type === 'warning' && /Asking Claude to correct them \(attempt 1 of 2\)/.test(e.message))).toBe(true);
    const stored = (await s.get<{ analysis: AnalysisRecord }>(`/api/projects/${projectId}/analysis`)).body.analysis;
    expect(JSON.stringify(stored.analysis)).not.toContain(hiddenId);
    expect(checkAnalysisReferences(stored.analysis, new Set(includedIds))).toEqual([]);
    expect(job.usage?.calls).toBe(2);
  });

  it('a learning map that is valid JSON but fails the learning-map rules (no objectives) is repaired', async () => {
    const { projectId } = await s.projectWithDeck();
    mock.enqueueMessages((req) => reply.json({ ...validAnalysis(slideIdsInPrompt(req)), objectives: [] }), answerFromPrompt());
    const { job } = await s.analyze(projectId);
    expect(job.status).toBe('succeeded');
    expect(mock.messageRequests()).toHaveLength(2);
    expect(promptText(mock.messageRequests()[1]!)).toMatch(/objectives: Too small/);
    expect(s.analysisCount(projectId)).toBe(1);
  });

  describe('server-side refusal fallback (mid-stream decline, continued by the fallback model)', () => {
    const FALLBACK = 'claude-opus-4-8';
    /** The partial is kept, a fallback block marks the boundary, and the fallback model continues the text. */
    const fallbackReply = (req: RecordedRequest): StreamReply => {
      const json = JSON.stringify(validAnalysis(slideIdsInPrompt(req)));
      return {
        kind: 'stream',
        blocks: [
          { type: 'text', text: json.slice(0, 120) },
          { type: 'fallback', from: TEST_MODEL, to: FALLBACK, category: 'cyber' },
          { type: 'text', text: json.slice(120) },
        ],
        usage: { input_tokens: 2000, output_tokens: 600, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        iterations: [
          { type: 'message', model: TEST_MODEL, input_tokens: 1900, output_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cache_creation: null },
          { type: 'fallback_message', model: FALLBACK, input_tokens: 2000, output_tokens: 600, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cache_creation: null },
        ],
      };
    };

    it('is labelled honestly: the model that answered is stored and a warning is logged', async () => {
      const { projectId } = await s.projectWithDeck();
      mock.enqueueMessages(fallbackReply);
      const { job, events } = await s.analyze(projectId);
      expect(job.status).toBe('succeeded');
      const stored = (await s.get<{ analysis: AnalysisRecord }>(`/api/projects/${projectId}/analysis`)).body.analysis;
      expect(stored.origin).toBe('claude');
      expect(stored.model).toBe(FALLBACK);
      expect(stored.analysis.topic).toBe('Coordinates on the plane'); // partial + continuation joined into one valid JSON document
      expect(job.model).toBe(FALLBACK);
      expect(job.result).toMatchObject({ model: FALLBACK, fellBack: true });
      expect(events.some((e) => e.type === 'warning' && e.message.includes(`fallback model ${FALLBACK} answered`))).toBe(true);
      expect(s.usageRows(job.id)).toMatchObject([{ requested_model: TEST_MODEL, model: FALLBACK }]);
    });

    it('counts the tokens of every billed attempt (usage.iterations), not only the final one', async () => {
      const { projectId } = await s.projectWithDeck();
      mock.enqueueMessages(fallbackReply);
      const { job } = await s.analyze(projectId);
      expect(job.status).toBe('succeeded');
      // usage.iterations is the per-attempt billing record; top-level usage covers only the attempt that answered.
      expect(job.usage).toMatchObject({ inputTokens: 1900 + 2000, outputTokens: 40 + 600 });
    });
  });
});

describe('analysis — failures end in a failed job with an honest error and nothing stored', () => {
  it('refusal (stop_reason "refusal")', async () => {
    const { projectId } = await s.projectWithDeck();
    mock.enqueueMessages(reply.refusal({ partialText: '{"topic": "Coordin', category: 'cyber', explanation: 'This request may relate to restricted content.' }));
    const { job, events } = await s.analyze(projectId);
    expect(job.status).toBe('failed');
    expect(job.error).toMatchObject({ code: 'claude_refusal', retryable: false, stage: 'learning-map' });
    expect(job.error!.message).toMatch(/Claude declined this request \(category: cyber\)/);
    expect(job.error!.message).toMatch(/Nothing was changed/);
    expect(events.at(-1)).toMatchObject({ type: 'error' });
    expect(mock.messageRequests()).toHaveLength(1); // a refusal is final: no retry, no repair
    await expectNothingStored(s, projectId, job.id);
    expect(s.usageRows(job.id)).toMatchObject([{ stop_reason: 'refusal' }]); // billed tokens are still logged
  });

  it('truncation (stop_reason "max_tokens")', async () => {
    const { projectId } = await s.projectWithDeck();
    mock.enqueueMessages((req) => reply.text(JSON.stringify(validAnalysis(slideIdsInPrompt(req))).slice(0, 300), { stopReason: 'max_tokens', usage: { output_tokens: 16000 } }));
    const { job } = await s.analyze(projectId);
    expect(job.status).toBe('failed');
    expect(job.error).toMatchObject({ code: 'claude_truncated', retryable: true });
    expect(job.error!.message).toMatch(/cut off at the 16000-token output limit/);
    expect(job.error!.message).toMatch(/Nothing was applied/);
    expect(mock.messageRequests()).toHaveLength(1);
    await expectNothingStored(s, projectId, job.id);
    expect(s.usageRows(job.id)).toMatchObject([{ stop_reason: 'max_tokens', output_tokens: 16000 }]);
  });

  it('malformed JSON: a bounded repair (exactly CLAUDE_MAX_REPAIR_ATTEMPTS extra calls), then failure', async () => {
    const { projectId } = await s.projectWithDeck();
    const malformed = '{"topic": "Coordinates", "summary": "Points on a plane", "concepts": [{"name": "Ordered pair",, }]';
    mock.enqueueMessages(...Array.from({ length: 1 + MAX_REPAIRS }, () => reply.text(malformed)));
    const { job } = await s.analyze(projectId);
    expect(job.status).toBe('failed');
    expect(['claude_invalid_output', 'invalid_analysis']).toContain(job.error?.code);
    expect(job.error?.message).toMatch(/not valid JSON|did not pass validation|did not match/);
    expect(job.error?.message).toMatch(/Nothing was (applied|saved)/);
    await expectNothingStored(s, projectId, job.id);
    // CLAUDE_MAX_REPAIR_ATTEMPTS is documented as “extra attempts when a response fails schema validation”.
    const reqs = mock.messageRequests();
    expect(reqs, 'calls made for a malformed structured output (1 + CLAUDE_MAX_REPAIR_ATTEMPTS expected)').toHaveLength(1 + MAX_REPAIRS);
    for (const r of reqs.slice(1)) expect(promptText(r)).not.toBe(promptText(reqs[0]!)); // a repair says what was wrong
  });

  it('schema-invalid JSON (missing required field, unknown enum value): a bounded repair, then failure', async () => {
    const { projectId } = await s.projectWithDeck();
    const invalid = (req: RecordedRequest) => {
      const a: Record<string, unknown> = { ...validAnalysis(slideIdsInPrompt(req)) };
      delete a.objectives;
      a.interactions = [{ mechanic: 'quiz-show', description: 'A quiz', sourceSlideIds: [], addedPractice: true }];
      return reply.json(a);
    };
    mock.enqueueMessages(...Array.from({ length: 1 + MAX_REPAIRS }, () => invalid));
    const { job } = await s.analyze(projectId);
    expect(job.status).toBe('failed');
    expect(['claude_invalid_output', 'invalid_analysis']).toContain(job.error?.code);
    expect(job.error?.message).toMatch(/did not match the expected structure|did not pass validation/);
    expect(job.error?.message).toMatch(/objectives/);
    await expectNothingStored(s, projectId, job.id);
    expect(mock.messageRequests(), 'calls made for a schema-invalid structured output (1 + CLAUDE_MAX_REPAIR_ATTEMPTS expected)').toHaveLength(1 + MAX_REPAIRS);
  });

  it('references to slide ids that do not exist are rejected: bounded repair, then failure', async () => {
    const { projectId } = await s.projectWithDeck();
    const BOGUS = 'sld_doesNotExist01';
    const bad = (req: RecordedRequest) => {
      const ids = slideIdsInPrompt(req);
      const a = validAnalysis(ids);
      a.concepts[0]!.sourceSlideIds = [BOGUS];
      a.objectives[1]!.sourceSlideIds = [ids[0]!, BOGUS];
      return reply.json(a);
    };
    mock.enqueueMessages(bad, bad, bad);
    const { job, events } = await s.analyze(projectId);
    expect(job.status).toBe('failed');
    expect(job.error).toMatchObject({ code: 'invalid_analysis', retryable: true });
    expect(job.error!.message).toContain(`Unknown or excluded slide reference "${BOGUS}"`);
    expect(job.error!.message).toMatch(/Nothing was saved/);
    const reqs = mock.messageRequests();
    expect(reqs).toHaveLength(1 + MAX_REPAIRS);
    for (const r of reqs.slice(1)) {
      expect(promptText(r)).toContain('Your previous answer was');
      expect(promptText(r)).toContain(`Unknown or excluded slide reference "${BOGUS}"`);
    }
    expect(events.filter((e) => e.type === 'warning').map((e) => /attempt (\d) of 2/.exec(e.message)?.[1])).toEqual(['1', '2']);
    await expectNothingStored(s, projectId, job.id);
    expect(job.usage?.calls).toBe(3);
  });

  it('429 rate limit: retry-after is honoured, retries are bounded by CLAUDE_MAX_RETRIES, then a rate-limited error', async () => {
    const { projectId } = await s.projectWithDeck();
    mock.enqueueMessages(reply.rateLimited(1), reply.rateLimited(1), reply.rateLimited(1));
    const { job } = await s.analyze(projectId);
    expect(job.status).toBe('failed');
    expect(job.error).toMatchObject({ code: 'claude_rate_limited', retryable: true });
    expect(job.error!.message).toMatch(/rate-limiting requests right now \(429\)/);
    expect(job.error!.message).toMatch(/Your work is saved/);
    const reqs = mock.messageRequests();
    expect(reqs).toHaveLength(1 + MAX_RETRIES);
    expect(reqs.map((r) => r.headers['x-stainless-retry-count'])).toEqual(['0', '1', '2']);
    for (let i = 1; i < reqs.length; i++) expect(reqs[i]!.receivedAt - reqs[i - 1]!.receivedAt).toBeGreaterThanOrEqual(950);
    await expectNothingStored(s, projectId, job.id);
    expect(s.usageRows(job.id)).toEqual([]);
  });

  it('a single 429 is retried transparently and the analysis still succeeds', async () => {
    const { projectId } = await s.projectWithDeck();
    mock.enqueueMessages(reply.rateLimited(1), answerFromPrompt());
    const { job } = await s.analyze(projectId);
    expect(job.status).toBe('succeeded');
    expect(mock.messageRequests().map((r) => r.status)).toEqual([429, 200]);
    expect(s.analysisCount(projectId)).toBe(1);
  });

  it('500 server error: bounded retries, then a server error', async () => {
    const { projectId } = await s.projectWithDeck();
    mock.enqueueMessages(reply.serverError(), reply.serverError(), reply.serverError());
    const { job } = await s.analyze(projectId);
    expect(job.status).toBe('failed');
    expect(job.error).toMatchObject({ code: 'claude_server_error', retryable: true });
    expect(job.error!.message).toMatch(/server error \(500\)/);
    expect(mock.messageRequests()).toHaveLength(1 + MAX_RETRIES);
    await expectNothingStored(s, projectId, job.id);
  });

  it('529 overloaded: bounded retries, then an overloaded error', async () => {
    const { projectId } = await s.projectWithDeck();
    mock.enqueueMessages(reply.overloaded(), reply.overloaded(), reply.overloaded());
    const { job } = await s.analyze(projectId);
    expect(job.status).toBe('failed');
    expect(job.error).toMatchObject({ code: 'claude_overloaded', retryable: true });
    expect(job.error!.message).toMatch(/temporarily overloaded \(529\)/);
    expect(mock.messageRequests()).toHaveLength(1 + MAX_RETRIES);
    await expectNothingStored(s, projectId, job.id);
  });

  it('400 invalid_request_error is not retried and is reported with the API message', async () => {
    const { projectId } = await s.projectWithDeck();
    mock.enqueueMessages(reply.error(400, 'invalid_request_error', 'messages.0.content.0: unexpected field "foo"'));
    const { job } = await s.analyze(projectId);
    expect(job.status).toBe('failed');
    expect(job.error).toMatchObject({ code: 'claude_bad_request', retryable: false });
    expect(job.error!.message).toMatch(/could not accept the request \(400\)/);
    expect(job.error!.message).toContain('unexpected field');
    expect(mock.messageRequests()).toHaveLength(1);
    await expectNothingStored(s, projectId, job.id);
  });

  it('a prompt that is too long (400) is reported as too large, not retried', async () => {
    const { projectId } = await s.projectWithDeck();
    mock.enqueueMessages(reply.error(400, 'invalid_request_error', 'prompt is too long: 1048577 tokens > 1000000 maximum'));
    const { job } = await s.analyze(projectId);
    expect(job.error).toMatchObject({ code: 'claude_too_large', retryable: false });
    expect(job.error!.message).toMatch(/too large for the model/);
    expect(mock.messageRequests()).toHaveLength(1);
    await expectNothingStored(s, projectId, job.id);
  });

  it('an error event in the middle of the stream (overloaded_error) fails the job as overloaded', async () => {
    const { projectId } = await s.projectWithDeck();
    mock.enqueueMessages(answerFromPrompt({ errorAfter: { events: 6, type: 'overloaded_error', message: 'Overloaded' } }));
    const { job } = await s.analyze(projectId);
    expect(job.status).toBe('failed');
    await expectNothingStored(s, projectId, job.id);
    expect(job.error?.retryable).toBe(true);
    // Same classification as an HTTP 529, and no raw JSON error envelope in the creator-facing message.
    expect({ code: job.error?.code, message: job.error?.message }).toEqual({ code: 'claude_overloaded', message: expect.not.stringMatching(/\{"type":"error"/) });
  });

  it('a connection dropped in the middle of the stream is reported as an interrupted connection', async () => {
    const { projectId } = await s.projectWithDeck();
    mock.enqueueMessages(answerFromPrompt({ dropAfter: 6 }));
    const { job } = await s.analyze(projectId);
    expect(job.status).toBe('failed');
    await expectNothingStored(s, projectId, job.id);
    expect(job.error?.retryable).toBe(true);
    // A network failure must not be presented as unparseable model output.
    expect({ code: job.error?.code, message: job.error?.message }).toEqual({ code: 'claude_connection', message: expect.not.stringMatching(/could not be parsed/) });
  });

  it('cancelling a running job while Claude is mid-stream ends it “cancelled”, aborts the HTTP stream and stores nothing', async () => {
    const { projectId } = await s.projectWithDeck();
    mock.enqueueMessages(answerFromPrompt({ stallAfter: 6 }));
    const enqueued = await s.startJob(projectId, 'analyze');
    const running = s.runNext();
    await mock.waitFor(() => mock.messageRequests()[0]?.holding === true, 10_000, 'the analysis stream to start');
    expect(mock.messageRequests()[0]!.eventsSent).toBe(6);
    expect((await s.getJob(enqueued.body.job.id)).job.status).toBe('running');

    const cancel = await s.post(`/api/jobs/${enqueued.body.job.id}/cancel`);
    expect(cancel.status).toBe(200);
    expect(cancel.body.job.cancelRequested).toBe(true);
    await running;

    const { job, events } = await s.getJob(enqueued.body.job.id);
    expect(job.status).toBe('cancelled');
    expect(job.error).toBeNull();
    expect(events.some((e) => /Stopped at the creator’s request/.test(e.message))).toBe(true);
    await mock.waitFor(() => mock.messageRequests()[0]!.clientAborted, 5000, 'the client to abort the stream');
    expect(mock.messageRequests()).toHaveLength(1);
    await expectNothingStored(s, projectId, job.id);
    expect(s.usageRows(job.id)).toEqual([]);
  });
});

describe('analysis — timeouts (CLAUDE_TIMEOUT_MS=500)', () => {
  let fast: Studio;
  beforeAll(async () => {
    fast = await Studio.start(mock, { timeoutMs: 500, maxRetries: MAX_RETRIES, maxRepairAttempts: MAX_REPAIRS });
    expect((await fast.testConnection()).state).toBe('configured');
  });
  afterAll(async () => {
    await fast?.close();
  });

  it('a request that never answers times out on every bounded attempt, then fails with a timeout error', async () => {
    const { projectId } = await fast.projectWithDeck();
    mock.enqueueMessages(reply.hang(), reply.hang(), reply.hang());
    const started = Date.now();
    const { job } = await fast.analyze(projectId);
    expect(job.status).toBe('failed');
    expect(job.error).toMatchObject({ code: 'claude_timeout', retryable: true });
    expect(job.error!.message).toMatch(/timed out/);
    const reqs = mock.messageRequests();
    expect(reqs).toHaveLength(1 + MAX_RETRIES);
    // Every attempt was abandoned by the client (the socket close can trail the job result by a few ms).
    await mock.waitFor(() => reqs.every((r) => r.clientAborted), 3000, 'every timed-out attempt to be aborted by the client');
    expect(reqs.every((r) => r.status === undefined)).toBe(true); // the mock never answered
    expect(reqs[0]!.headers['x-stainless-timeout']).toBe('0'); // 500 ms, in whole seconds
    expect(Date.now() - started).toBeLessThan(15_000);
    await expectNothingStored(fast, projectId, job.id);
  });

  it('a stream that stalls after the response headers is abandoned within the configured timeout', async () => {
    const { projectId } = await fast.projectWithDeck();
    mock.enqueueMessages(answerFromPrompt({ stallAfter: 4 }), answerFromPrompt({ stallAfter: 4 }), answerFromPrompt({ stallAfter: 4 }));
    const enqueued = await fast.startJob(projectId, 'analyze');
    const out = await runWithDeadline(fast, enqueued.body.job.id, 6000);
    expect(out.timedOut, `job still running ${out.elapsedMs} ms after a stall although CLAUDE_TIMEOUT_MS=500 (it had to be cancelled)`).toBe(false);
    expect(out.job.status).toBe('failed');
    expect(['claude_timeout', 'claude_connection']).toContain(out.job.error?.code);
    await expectNothingStored(fast, projectId, out.job.id);
  });
});
