/**
 * What actually leaves the server: every request the official SDK sends to the
 * (mock) Anthropic API is recorded and checked — key placement, model id,
 * streaming, structured-output format, tools, effort and fallback parameters,
 * and which deck content is (not) sent.
 */
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SourceSlide } from '@shared/schemas/source.ts';
import { blockedRequests, FAKE_KEY, HIDDEN_SLIDE_MARKER, NOTES_MARKER, promptText, slideIdsInPrompt, smallDeck, startMock, Studio, TEST_MODEL, validAnalysis } from './harness.ts';
import { reply, type MockAnthropic, type RecordedRequest } from './mock-anthropic.ts';

let mock: MockAnthropic;
let s: Studio;
let deck: { projectId: string; slides: SourceSlide[]; includedIds: string[] };
let sampleId: string;
const seen: RecordedRequest[] = [];

const answerFromPrompt = (req: RecordedRequest) => reply.json(validAnalysis(slideIdsInPrompt(req)));
type Json = Record<string, any>;

beforeAll(async () => {
  mock = await startMock();
  s = await Studio.start(mock);
  expect((await s.testConnection()).state).toBe('configured');
  deck = await s.projectWithDeck();
  sampleId = (await s.post('/api/projects/sample')).body.project.id;
  seen.push(...mock.requests);
});

beforeEach(() => mock.reset());

afterEach(() => {
  seen.push(...mock.requests);
  expect(mock.unscripted.map((r) => `${r.method} ${r.url}`)).toEqual([]);
});

afterAll(async () => {
  await s?.close();
  await mock?.close();
  expect(blockedRequests).toEqual([]);
});

describe('request shape', () => {
  it('analysis: a streamed structured-output request for the configured model, with effort, prompt caching and the refusal-fallback beta', async () => {
    mock.enqueueMessages(answerFromPrompt);
    const { job } = await s.analyze(deck.projectId);
    expect(job.status).toBe('succeeded');

    const [req] = mock.messageRequests();
    expect(req).toBeDefined();
    expect(req!.method).toBe('POST');
    expect(req!.pathname).toBe('/v1/messages');
    expect(req!.query).toEqual({ beta: 'true' });
    expect(req!.headers['x-api-key']).toBe(FAKE_KEY);
    expect(req!.headers.authorization).toBeUndefined();
    expect(req!.headers['anthropic-version']).toBe('2023-06-01');
    expect(req!.headers['content-type']).toBe('application/json');
    expect(req!.headers['x-stainless-helper-method']).toBe('stream');
    expect(req!.headers['x-stainless-timeout']).toBe('600'); // CLAUDE_TIMEOUT_MS default (10 min), in seconds
    expect(req!.headers['x-stainless-retry-count']).toBe('0');
    expect(String(req!.headers['anthropic-beta']).split(',')).toContain('server-side-fallback-2026-07-01');

    const b = req!.body as Json;
    expect(b.model).toBe(TEST_MODEL);
    expect(b.stream).toBe(true);
    expect(b.max_tokens).toBe(16000);
    expect(b.fallbacks).toBe('default');
    expect(b.output_config.effort).toBe('medium');
    expect(b.output_config.format.type).toBe('json_schema');
    const schema = b.output_config.format.schema as Json;
    expect(schema.type).toBe('object');
    expect([...schema.required].sort()).toEqual(['concepts', 'examples', 'interactions', 'objectives', 'openQuestions', 'prerequisites', 'questions', 'summary', 'topic']);
    // Structured outputs need closed objects: every object schema (including $defs) forbids extra properties.
    const objects: Json[] = [];
    const walk = (node: unknown) => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (!node || typeof node !== 'object') return;
      if ((node as Json).type === 'object') objects.push(node as Json);
      Object.values(node as Json).forEach(walk);
    };
    walk(schema);
    expect(objects.length).toBeGreaterThan(5);
    for (const o of objects) expect(o.additionalProperties).toBe(false);
    expect(b.system).toEqual([{ type: 'text', text: expect.stringContaining('NEXUS Play Studio'), cache_control: { type: 'ephemeral' } }]);
    expect(b.messages).toHaveLength(1);
    expect(b.messages[0].role).toBe('user');
    expect(b.messages[0].content).toEqual([{ type: 'text', text: expect.stringContaining('Slide list (cite these ids exactly):') }]);
    // Parameters Claude Opus 5.5 rejects (or that the SDK must move to headers) are absent.
    for (const absent of ['betas', 'tools', 'tool_choice', 'thinking', 'temperature', 'top_p', 'top_k']) expect(b, absent).not.toHaveProperty(absent);
    expect(req!.rawBody).not.toContain(FAKE_KEY);
  });

  it('analysis prompt: only included slides are sent — never the hidden slide — and speaker notes follow the brief', async () => {
    const { projectId, slides, includedIds } = await s.projectWithDeck('Notes on and off');
    const hidden = slides.find((sl) => sl.hidden)!;
    mock.enqueueMessages(answerFromPrompt, answerFromPrompt);

    expect((await s.analyze(projectId)).job.status).toBe('succeeded');
    const withNotes = mock.messageRequests()[0]!;
    const text = promptText(withNotes);
    expect(text).toContain('<creator_brief>');
    for (const id of includedIds) expect(text).toContain(`<source_slide id="${id}"`);
    expect(slideIdsInPrompt(withNotes)).toEqual(includedIds);
    expect(withNotes.rawBody).not.toContain(hidden.id);
    expect(withNotes.rawBody).not.toContain(HIDDEN_SLIDE_MARKER);
    expect(text).toContain(NOTES_MARKER); // includeSpeakerNotes defaults to true

    const project = (await s.get(`/api/projects/${projectId}`)).body.project;
    const brief = { ...project.brief, aiInputs: { ...project.brief.aiInputs, includeSpeakerNotes: false } };
    expect((await s.put(`/api/projects/${projectId}/brief`, { brief, revision: project.briefRevision })).status).toBe(200);
    expect((await s.analyze(projectId)).job.status).toBe('succeeded');
    const withoutNotes = mock.messageRequests()[1]!;
    expect(withoutNotes.rawBody).not.toContain(NOTES_MARKER);
    expect(withoutNotes.rawBody).not.toContain(HIDDEN_SLIDE_MARKER);
    expect(promptText(withoutNotes)).toContain('Ordered pairs');
  });

  it('visual references: only an authorized slide with an attached, verified visual is sent — as a base64 PNG image block', async () => {
    const png = await sharp({ create: { width: 96, height: 64, channels: 3, background: '#1F5FAD' } }).png().toBuffer();
    const { projectId, slides } = await s.projectWithDeck('With a picture', smallDeck({ slide2Image: png }));
    const pairs = slides.find((sl) => sl.slideNumber === 2)!;
    const quadrants = slides.find((sl) => sl.slideNumber === 3)!;
    const assetId = pairs.extract.images[0]?.assetId;
    expect(assetId).toBeTruthy();

    // Before the creator authorizes anything, no image leaves the server.
    mock.enqueueMessages(answerFromPrompt, answerFromPrompt);
    expect((await s.analyze(projectId)).job.status).toBe('succeeded');
    expect(((mock.messageRequests()[0]!.body as Json).messages[0].content as Json[]).map((b) => b.type)).toEqual(['text']);

    const patched = await s.request('PATCH', `/api/slides/${pairs.id}`, { revision: null, patch: { visualRef: { kind: 'image', documentId: null, pageNumber: null, assetId, mapping: 'verified' } } });
    expect(patched.status).toBe(200);
    const project = (await s.get(`/api/projects/${projectId}`)).body.project;
    const brief = { ...project.brief, aiInputs: { ...project.brief.aiInputs, sendVisualReferences: true, authorizedVisualSlideIds: [pairs.id, quadrants.id] } };
    expect((await s.put(`/api/projects/${projectId}/brief`, { brief, revision: project.briefRevision })).status).toBe(200);

    const { job, events } = await s.analyze(projectId);
    expect(job.status).toBe('succeeded');
    const content = (mock.messageRequests()[1]!.body as Json).messages[0].content as Json[];
    expect(content.map((b) => b.type)).toEqual(['image', 'text', 'text']);
    expect(content[0]!.source.type).toBe('base64');
    expect(content[0]!.source.media_type).toBe('image/png');
    expect(Buffer.from(content[0]!.source.data, 'base64').subarray(1, 4).toString('latin1')).toBe('PNG');
    expect(content[1]).toEqual({ type: 'text', text: `The image above is the visual reference for slide 2 (${pairs.id}).` });
    // Slide 3 is authorized but has no visual attached: nothing is sent for it, and the job log says so.
    expect(events.some((e) => e.message === 'Slide 3: no visual reference is attached, so none was sent.')).toBe(true);
  });

  it('refine: the strict propose_changes tool with eager input streaming, tool_choice auto and no structured-output format', async () => {
    mock.enqueueMessages(reply.text('Which scene should get the bigger labels — or should all coordinate scenes change?'));
    const sent = await s.post(`/api/projects/${sampleId}/chat`, { text: 'Make the labels bigger', mode: 'refine', scope: { kind: 'project', sceneId: null, slideId: null }, area: 'build' });
    expect(sent.status).toBe(202);
    expect(sent.body.job).toMatchObject({ type: 'refine', mode: 'live' });
    await s.runNext();
    expect((await s.getJob(sent.body.job.id)).job.status).toBe('succeeded');

    const [req] = mock.messageRequests();
    const b = req!.body as Json;
    expect(b).toMatchObject({ model: TEST_MODEL, stream: true, max_tokens: 16000, fallbacks: 'default', tool_choice: { type: 'auto' }, output_config: { effort: 'medium' } });
    expect(b.output_config).not.toHaveProperty('format');
    expect(b.tools).toHaveLength(1);
    const tool = b.tools[0] as Json;
    expect(tool).toMatchObject({ name: 'propose_changes', strict: true, eager_input_streaming: true });
    expect(tool.input_schema).toMatchObject({ type: 'object', additionalProperties: false, required: ['summary', 'explanation', 'changes', 'conflictsNoticed'] });
    expect(tool.input_schema.properties.changes.items).toMatchObject({ additionalProperties: false, required: ['op', 'sceneId', 'field', 'valueJson', 'toIndex', 'reason'] });
    expect(b.system[0].text).toContain('propose_changes');
    const text = promptText(req!);
    expect(text).toContain('<creator_request>\nMake the labels bigger\n</creator_request>');
    expect(text).toContain('<game_config>');
    expect(text).toContain('Scope: whole project.');
    for (const absent of ['betas', 'thinking', 'temperature', 'top_p', 'top_k']) expect(b, absent).not.toHaveProperty(absent);
    expect(req!.headers['x-api-key']).toBe(FAKE_KEY);
    expect(req!.rawBody).not.toContain(FAKE_KEY);
  });

  it('ask: a plain streamed chat request — no tools, low effort, the selected slide as context', async () => {
    const slideId = deck.includedIds[1]!;
    mock.enqueueMessages(reply.text('Slide 2 explains how to read an ordered pair: x first, then y.'));
    const sent = await s.post(`/api/projects/${deck.projectId}/chat`, { text: 'What does this slide teach?', mode: 'ask', scope: { kind: 'slide', slideId, sceneId: null }, area: 'source' });
    expect(sent.status).toBe(202);
    await s.runNext();
    expect((await s.getJob(sent.body.job.id)).job.status).toBe('succeeded');

    const [req] = mock.messageRequests();
    const b = req!.body as Json;
    expect(b).toMatchObject({ model: TEST_MODEL, stream: true, max_tokens: 8000, output_config: { effort: 'low' } });
    for (const absent of ['tools', 'tool_choice', 'betas']) expect(b, absent).not.toHaveProperty(absent);
    expect(b.output_config).not.toHaveProperty('format');
    expect(b.system[0].text).toContain('answer the creator');
    expect(promptText(req!)).toContain(`<source_slide id="${slideId}"`);
    expect(promptText(req!)).toContain('<creator_request>\nWhat does this slide teach?\n</creator_request>');
  });

  it('AI preview token count: POST /v1/messages/count_tokens with the token-counting beta, and the real count is returned', async () => {
    mock.enqueueTokenCounts({ kind: 'json', body: { input_tokens: 4321 } });
    const preview = await s.get(`/api/projects/${deck.projectId}/ai-preview?countTokens=1`);
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({ tokenCount: 4321, tokenNote: null });
    const [req] = mock.requests;
    expect(req).toMatchObject({ method: 'POST', pathname: '/v1/messages/count_tokens', query: { beta: 'true' } });
    expect(String(req!.headers['anthropic-beta']).split(',')).toContain('token-counting-2024-11-01');
    expect(req!.body).toMatchObject({ model: TEST_MODEL });
    expect(req!.body).not.toHaveProperty('stream');
  });

  it('CLAUDE_REFUSAL_FALLBACK=off: no fallbacks parameter and no fallback beta header', async () => {
    const off = await Studio.start(mock, { refusalFallback: 'off' });
    try {
      expect((await off.testConnection()).state).toBe('configured');
      const { projectId } = await off.projectWithDeck();
      mock.enqueueMessages(answerFromPrompt);
      expect((await off.analyze(projectId)).job.status).toBe('succeeded');
      const req = mock.messageRequests().at(-1)!;
      expect(req.body).not.toHaveProperty('fallbacks');
      expect(req.headers['anthropic-beta']).toBeUndefined();
      expect((req.body as Json).output_config).toMatchObject({ effort: 'medium', format: { type: 'json_schema' } });
    } finally {
      await off.close();
    }
  });

  it('a model without effort support and outside the fallback list: no effort and no fallbacks are sent', async () => {
    const haiku = await Studio.start(mock, { model: 'claude-haiku-4-5' });
    try {
      expect((await haiku.testConnection()).modelInfo?.effort).toBe(false);
      const { projectId } = await haiku.projectWithDeck();
      mock.enqueueMessages(answerFromPrompt);
      expect((await haiku.analyze(projectId)).job.status).toBe('succeeded');
      const req = mock.messageRequests().at(-1)!;
      const b = req.body as Json;
      expect(b.model).toBe('claude-haiku-4-5');
      expect(Object.keys(b.output_config)).toEqual(['format']);
      expect(b).not.toHaveProperty('fallbacks');
      expect(req.headers['anthropic-beta']).toBeUndefined();
    } finally {
      await haiku.close();
    }
  });

  it('across every request above, the key travels only in the x-api-key header — never in another header, the URL or a body', () => {
    expect(seen.length).toBeGreaterThan(0);
    const endpoints = new Set(['GET /v1/models/claude-opus-5-5', 'GET /v1/models/claude-haiku-4-5', 'POST /v1/messages', 'POST /v1/messages/count_tokens']);
    for (const r of seen) {
      expect(endpoints.has(`${r.method} ${r.pathname}`), `${r.method} ${r.pathname}`).toBe(true);
      expect(r.headers['x-api-key']).toBe(FAKE_KEY);
      expect(r.headers.authorization).toBeUndefined();
      for (const [name, value] of Object.entries(r.headers)) {
        if (name !== 'x-api-key') expect(String(value), `header ${name}`).not.toContain(FAKE_KEY);
      }
      expect(r.url).not.toContain(FAKE_KEY);
      expect(r.rawBody).not.toContain(FAKE_KEY);
      expect(r.rawBody).not.toMatch(/sk-ant-/);
    }
  });
});
