/**
 * A local, scriptable stand-in for the Anthropic HTTP API — just the endpoints
 * NEXUS's gateway calls through the official SDK:
 *
 *   GET  /v1/models/{id}             model info + capabilities (Models API)
 *   GET  /v1/models                  model list (one page)
 *   POST /v1/messages?beta=true      Messages API, `stream: true` → real SSE event sequence
 *   POST /v1/messages/count_tokens   token counting (used by the AI preview)
 *
 * Every request is recorded (method, URL, headers, raw + parsed JSON body) so
 * tests can assert exactly what left the server. Responses for the Messages
 * endpoint come from a per-test FIFO queue of scripts; an unscripted request is
 * answered with a 400 and listed in `unscripted`, so it can never pass silently.
 *
 * Event payloads are typed with the SDK's own stream-event types, so the mock
 * cannot drift from the wire format the SDK parses. The mock also enforces a
 * few documented API rules (version header, key, model existence, and the
 * request features Claude Opus 5.5 rejects) so an incompatible request fails
 * here the way it would against the real API.
 *
 * This is a test double: passing tests prove NEXUS handles the API contract as
 * modelled here, not that the live Anthropic API behaves this way.
 */
import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import type Anthropic from '@anthropic-ai/sdk';

export type StreamEvent = Anthropic.Beta.BetaRawMessageStreamEvent;
export type StopReason = Anthropic.Beta.BetaStopReason;
type RefusalCategory = Anthropic.Beta.BetaRefusalStopDetails['category'];

export interface RecordedRequest {
  seq: number;
  method: string;
  /** Path and query string exactly as received. */
  url: string;
  pathname: string;
  query: Record<string, string>;
  /** Header names are lower-case (Node's representation). */
  headers: http.IncomingHttpHeaders;
  rawBody: string;
  /** Parsed JSON body, or null when the body is empty / not a JSON object. */
  body: Record<string, unknown> | null;
  receivedAt: number;
  requestId: string;
  /** HTTP status the mock answered with (undefined while it is holding the request open). */
  status?: number;
  /** SSE events written so far (streams only). */
  eventsSent: number;
  /** The mock is deliberately holding this request open (hang / stall). */
  holding: boolean;
  /** The client closed the connection before the mock finished the response. */
  clientAborted: boolean;
}

export type MockBlock =
  /** An adaptive-thinking block as Opus 5.5 streams it by default (display omitted: empty text + signature). */
  | { type: 'thinking' }
  | { type: 'text'; text: string }
  /** `input` is serialized to JSON; `rawJson` is streamed verbatim (use it for malformed tool input). */
  | { type: 'tool_use'; name: string; input?: unknown; rawJson?: string; id?: string }
  /** Server-side refusal fallback switch point (`fallbacks: "default"`). */
  | { type: 'fallback'; from: string; to: string; category?: RefusalCategory };

export interface MockUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export interface StreamReply {
  kind: 'stream';
  blocks: MockBlock[];
  /** Defaults to `tool_use` when a tool_use block is present, else `end_turn`. */
  stopReason?: StopReason;
  stopDetails?: { category: RefusalCategory; explanation: string | null } | null;
  /** Model reported in message_start (defaults to the requested model). */
  model?: string;
  usage?: Partial<MockUsage>;
  iterations?: Anthropic.Beta.BetaIterationsUsage | null;
  /** Characters per text_delta / input_json_delta event. */
  chunkSize?: number;
  /** Delay between SSE events in ms. */
  eventDelayMs?: number;
  /** Write this many SSE events, then keep the connection open (send nothing) until the client goes away. */
  stallAfter?: number;
  /** Write this many SSE events, then an SSE `error` event, then end the response (mid-stream API error). */
  errorAfter?: { events: number; type: string; message: string };
  /** Write this many SSE events, then destroy the socket (connection dropped mid-stream). */
  dropAfter?: number;
}

export interface ErrorReply {
  kind: 'error';
  status: number;
  type: string;
  message: string;
  headers?: Record<string, string>;
}

/** Accept the request and never send response headers (until the client gives up). */
export interface HangReply {
  kind: 'hang';
}

export interface JsonReply {
  kind: 'json';
  status?: number;
  body: unknown;
  headers?: Record<string, string>;
}

export type MockReply = StreamReply | ErrorReply | HangReply | JsonReply;
export type MockScript = MockReply | ((req: RecordedRequest) => MockReply);

export const DEFAULT_USAGE: MockUsage = { input_tokens: 1834, output_tokens: 412, cache_creation_input_tokens: 1250, cache_read_input_tokens: 0 };

/** Reply builders for common API behaviours. */
export const reply = {
  /** A structured-output answer: the JSON text streamed in a text block (after a thinking block). */
  json(value: unknown, opts: Omit<StreamReply, 'kind' | 'blocks'> = {}): StreamReply {
    return { kind: 'stream', blocks: [{ type: 'thinking' }, { type: 'text', text: JSON.stringify(value) }], ...opts };
  },
  /** Raw text (for malformed JSON, chat answers, …). */
  text(text: string, opts: Omit<StreamReply, 'kind' | 'blocks'> = {}): StreamReply {
    return { kind: 'stream', blocks: [{ type: 'text', text }], ...opts };
  },
  toolUse(name: string, input: unknown, opts: Omit<StreamReply, 'kind' | 'blocks'> & { preamble?: string } = {}): StreamReply {
    const { preamble, ...rest } = opts;
    return { kind: 'stream', blocks: [...(preamble ? [{ type: 'text' as const, text: preamble }] : []), { type: 'tool_use', name, input }], ...rest };
  },
  refusal(opts: { partialText?: string; category?: RefusalCategory; explanation?: string | null } = {}): StreamReply {
    return {
      kind: 'stream',
      blocks: opts.partialText ? [{ type: 'text', text: opts.partialText }] : [],
      stopReason: 'refusal',
      stopDetails: { category: opts.category ?? null, explanation: opts.explanation ?? null },
    };
  },
  error(status: number, type: string, message: string, headers?: Record<string, string>): ErrorReply {
    return { kind: 'error', status, type, message, headers };
  },
  rateLimited(retryAfterSeconds = 1): ErrorReply {
    return {
      kind: 'error',
      status: 429,
      type: 'rate_limit_error',
      message: 'This request would exceed the rate limit for your organization of 50 requests per minute.',
      headers: { 'retry-after': String(retryAfterSeconds) },
    };
  },
  overloaded(): ErrorReply {
    return { kind: 'error', status: 529, type: 'overloaded_error', message: 'Overloaded' };
  },
  serverError(): ErrorReply {
    return { kind: 'error', status: 500, type: 'api_error', message: 'Internal server error' };
  },
  hang(): HangReply {
    return { kind: 'hang' };
  },
};

export function modelInfo(
  id: string,
  opts: { displayName?: string; structuredOutputs?: boolean; effort?: boolean; imageInput?: boolean; pdfInput?: boolean; maxInputTokens?: number; maxTokens?: number } = {},
): Anthropic.ModelInfo {
  const yes = { supported: true };
  const effort = opts.effort ?? true;
  return {
    type: 'model',
    id,
    display_name: opts.displayName ?? id,
    created_at: '2026-08-12T00:00:00Z',
    max_input_tokens: opts.maxInputTokens ?? 1_000_000,
    max_tokens: opts.maxTokens ?? 128_000,
    capabilities: {
      batch: yes,
      citations: yes,
      code_execution: yes,
      context_management: { supported: true, clear_thinking_20251015: yes, clear_tool_uses_20250919: yes, compact_20260112: yes },
      effort: { supported: effort, low: { supported: effort }, medium: { supported: effort }, high: { supported: effort }, xhigh: { supported: effort }, max: { supported: effort } },
      image_input: { supported: opts.imageInput ?? true },
      pdf_input: { supported: opts.pdfInput ?? true },
      structured_outputs: { supported: opts.structuredOutputs ?? true },
      thinking: { supported: true, types: { adaptive: yes, enabled: { supported: false } } },
    },
  };
}

/** Models for which the mock enforces the documented Claude Opus 5.5 / Fable 5.1 request rules. */
const STRICT_MODELS = new Set(['claude-opus-5-5', 'claude-fable-5-1', 'claude-sonnet-5-5']);
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function chunks(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

export class MockAnthropic {
  readonly requests: RecordedRequest[] = [];
  /** Requests no script or route accounted for (answered with an error). */
  readonly unscripted: RecordedRequest[] = [];
  readonly models = new Map<string, Anthropic.ModelInfo>();
  /** When set, requests whose x-api-key differs get a 401 like the real API. */
  expectedKey: string | null = null;
  private readonly messageScripts: MockScript[] = [];
  private readonly modelScripts: MockScript[] = [];
  private readonly countScripts: MockScript[] = [];
  private readonly sockets = new Set<Socket>();
  private seq = 0;
  private defaultModels: Anthropic.ModelInfo[] = [];

  private constructor(
    private readonly server: http.Server,
    readonly url: string,
  ) {}

  static async start(opts: { models?: Anthropic.ModelInfo[] } = {}): Promise<MockAnthropic> {
    let mock: MockAnthropic | null = null;
    const server = http.createServer((req, res) => {
      void mock!.onRequest(req, res);
    });
    server.on('connection', (socket) => {
      mock?.sockets.add(socket);
      socket.on('close', () => mock?.sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    mock = new MockAnthropic(server, `http://127.0.0.1:${port}`);
    mock.defaultModels = opts.models ?? [];
    mock.reset();
    return mock;
  }

  /** Queue replies for POST /v1/messages, consumed in order. */
  enqueueMessages(...scripts: MockScript[]): void {
    this.messageScripts.push(...scripts);
  }

  /** Queue replies for GET /v1/models/{id} that take precedence over the `models` map (errors, hangs…). */
  enqueueModelLookups(...scripts: MockScript[]): void {
    this.modelScripts.push(...scripts);
  }

  enqueueTokenCounts(...scripts: MockScript[]): void {
    this.countScripts.push(...scripts);
  }

  pendingMessageScripts(): number {
    return this.messageScripts.length;
  }

  messageRequests(): RecordedRequest[] {
    return this.requests.filter((r) => r.method === 'POST' && r.pathname === '/v1/messages');
  }

  modelRequests(): RecordedRequest[] {
    return this.requests.filter((r) => r.method === 'GET' && r.pathname.startsWith('/v1/models'));
  }

  /** Forget recorded requests and queued scripts; restore the default model list. */
  reset(): void {
    this.requests.length = 0;
    this.unscripted.length = 0;
    this.messageScripts.length = 0;
    this.modelScripts.length = 0;
    this.countScripts.length = 0;
    this.models.clear();
    for (const m of this.defaultModels) this.models.set(m.id, m);
  }

  async waitFor(cond: () => boolean, timeoutMs = 5000, what = 'condition'): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!cond()) {
      if (Date.now() > deadline) throw new Error(`mock-anthropic: timed out after ${timeoutMs} ms waiting for ${what}`);
      await sleep(10);
    }
  }

  async close(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  // ───────────────────────────── request handling ─────────────────────────────

  private async onRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const chunksIn: Buffer[] = [];
    for await (const c of req) chunksIn.push(c as Buffer);
    const rawBody = Buffer.concat(chunksIn).toString('utf8');
    const u = new URL(req.url ?? '/', 'http://mock.invalid');
    let body: Record<string, unknown> | null = null;
    if (rawBody) {
      try {
        const parsed: unknown = JSON.parse(rawBody);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
      } catch {
        body = null;
      }
    }
    const seq = ++this.seq;
    const rec: RecordedRequest = {
      seq,
      method: req.method ?? 'GET',
      url: req.url ?? '/',
      pathname: u.pathname,
      query: Object.fromEntries(u.searchParams.entries()),
      headers: req.headers,
      rawBody,
      body,
      receivedAt: Date.now(),
      requestId: `req_mock_${String(seq).padStart(6, '0')}`,
      eventsSent: 0,
      holding: false,
      clientAborted: false,
    };
    this.requests.push(rec);
    res.on('close', () => {
      if (!res.writableFinished) rec.clientAborted = true;
    });

    try {
      if (!req.headers['anthropic-version']) {
        return this.sendError(rec, res, reply.error(400, 'invalid_request_error', 'anthropic-version: header is required'));
      }
      if (this.expectedKey !== null && req.headers['x-api-key'] !== this.expectedKey) {
        return this.sendError(rec, res, reply.error(401, 'authentication_error', 'invalid x-api-key'));
      }
      const modelMatch = /^\/v1\/models\/([^/]+)$/.exec(u.pathname);
      if (rec.method === 'GET' && u.pathname === '/v1/models') return this.listModels(rec, res);
      if (rec.method === 'GET' && modelMatch) return await this.retrieveModel(rec, res, decodeURIComponent(modelMatch[1]!));
      if (rec.method === 'POST' && u.pathname === '/v1/messages') return await this.messages(rec, res);
      if (rec.method === 'POST' && u.pathname === '/v1/messages/count_tokens') return await this.countTokens(rec, res);
      this.unscripted.push(rec);
      return this.sendError(rec, res, reply.error(404, 'not_found_error', `mock-anthropic: no route for ${rec.method} ${u.pathname}`));
    } catch (err) {
      this.unscripted.push(rec);
      if (!res.headersSent) this.sendError(rec, res, reply.error(500, 'api_error', `mock-anthropic crashed: ${(err as Error).message}`));
      else res.destroy();
    }
  }

  private listModels(rec: RecordedRequest, res: http.ServerResponse): void {
    const data = [...this.models.values()];
    this.sendJson(rec, res, 200, { data, has_more: false, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null });
  }

  private async retrieveModel(rec: RecordedRequest, res: http.ServerResponse, id: string): Promise<void> {
    const script = this.modelScripts.shift();
    if (script) return this.play(rec, res, typeof script === 'function' ? script(rec) : script);
    const info = this.models.get(id);
    if (!info) return this.sendError(rec, res, reply.error(404, 'not_found_error', `model: ${id}`));
    this.sendJson(rec, res, 200, info);
  }

  private async countTokens(rec: RecordedRequest, res: http.ServerResponse): Promise<void> {
    const script = this.countScripts.shift();
    if (script) return this.play(rec, res, typeof script === 'function' ? script(rec) : script);
    this.sendJson(rec, res, 200, { input_tokens: Math.max(1, Math.round(rec.rawBody.length / 4)) });
  }

  private async messages(rec: RecordedRequest, res: http.ServerResponse): Promise<void> {
    const invalid = this.validateMessagesRequest(rec);
    if (invalid) return this.sendError(rec, res, invalid);
    const script = this.messageScripts.shift();
    if (!script) {
      this.unscripted.push(rec);
      return this.sendError(rec, res, reply.error(400, 'invalid_request_error', 'mock-anthropic: no scripted response for this request'));
    }
    const r = typeof script === 'function' ? script(rec) : script;
    if (r.kind === 'stream' && rec.body?.stream !== true) {
      this.unscripted.push(rec);
      return this.sendError(rec, res, reply.error(400, 'invalid_request_error', 'mock-anthropic: scripted a stream but the request did not set stream: true'));
    }
    return this.play(rec, res, r);
  }

  /** The subset of API validation that matters for NEXUS's requests (documented model rules). */
  private validateMessagesRequest(rec: RecordedRequest): ErrorReply | null {
    const b = rec.body;
    if (!b) return reply.error(400, 'invalid_request_error', 'Request body must be a JSON object');
    const model = b.model;
    if (typeof model !== 'string' || !model) return reply.error(400, 'invalid_request_error', 'model: Field required');
    if (!this.models.has(model)) return reply.error(404, 'not_found_error', `model: ${model}`);
    if (typeof b.max_tokens !== 'number' || !Number.isInteger(b.max_tokens) || b.max_tokens < 1) {
      return reply.error(400, 'invalid_request_error', 'max_tokens: Field required');
    }
    const messages = b.messages;
    if (!Array.isArray(messages) || messages.length === 0) return reply.error(400, 'invalid_request_error', 'messages: at least one message is required');
    const first = messages[0] as { role?: unknown } | undefined;
    if (first?.role !== 'user') return reply.error(400, 'invalid_request_error', 'messages: first message must use the "user" role');
    const last = messages.at(-1) as { role?: unknown } | undefined;
    if ('betas' in b) return reply.error(400, 'invalid_request_error', 'betas: Extra inputs are not permitted (send the anthropic-beta header)');
    if (STRICT_MODELS.has(model)) {
      for (const p of ['temperature', 'top_p', 'top_k']) {
        if (p in b) return reply.error(400, 'invalid_request_error', `${p}: sampling parameters are not supported for this model`);
      }
      const thinking = b.thinking as { type?: unknown } | undefined;
      if (thinking && thinking.type !== 'adaptive') return reply.error(400, 'invalid_request_error', 'thinking: only {"type": "adaptive"} is supported for this model');
      const choice = b.tool_choice as { type?: unknown } | undefined;
      if (choice && (choice.type === 'any' || choice.type === 'tool')) {
        return reply.error(400, 'invalid_request_error', 'tool_choice: type "tool" and "any" are not supported for this model.');
      }
      if (last?.role === 'assistant') return reply.error(400, 'invalid_request_error', 'This model does not support assistant message prefill.');
    }
    if (b.fallbacks !== undefined) {
      const betas = String(rec.headers['anthropic-beta'] ?? '').split(',').map((s) => s.trim());
      if (!betas.includes(FALLBACK_BETA)) return reply.error(400, 'invalid_request_error', `fallbacks: requires the anthropic-beta header ${FALLBACK_BETA}`);
    }
    const tools = b.tools;
    if (tools !== undefined) {
      if (!Array.isArray(tools)) return reply.error(400, 'invalid_request_error', 'tools: must be an array');
      for (const t of tools as Array<Record<string, unknown>>) {
        const schema = t.input_schema as Record<string, unknown> | undefined;
        if (typeof t.name !== 'string' || !schema || schema.type !== 'object') return reply.error(400, 'invalid_request_error', 'tools: each tool needs a name and an object input_schema');
        if (t.strict === true && schema.additionalProperties !== false) {
          return reply.error(400, 'invalid_request_error', 'tools: strict tools require "additionalProperties": false');
        }
      }
    }
    const format = (b.output_config as { format?: { type?: unknown; schema?: unknown } } | undefined)?.format;
    if (format !== undefined && (format.type !== 'json_schema' || !format.schema || typeof format.schema !== 'object')) {
      return reply.error(400, 'invalid_request_error', 'output_config.format: expected {"type": "json_schema", "schema": {...}}');
    }
    return null;
  }

  private async play(rec: RecordedRequest, res: http.ServerResponse, r: MockReply): Promise<void> {
    switch (r.kind) {
      case 'error':
        return this.sendError(rec, res, r);
      case 'json':
        return this.sendJson(rec, res, r.status ?? 200, r.body, r.headers);
      case 'hang':
        rec.holding = true;
        return;
      case 'stream':
        return this.stream(rec, res, r);
    }
  }

  private baseHeaders(rec: RecordedRequest): Record<string, string> {
    return { 'request-id': rec.requestId, 'anthropic-organization-id': 'org_mock_0001', 'x-mock-anthropic': '1' };
  }

  private sendJson(rec: RecordedRequest, res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    rec.status = status;
    const text = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...this.baseHeaders(rec), ...headers });
    res.end(text);
  }

  private sendError(rec: RecordedRequest, res: http.ServerResponse, e: ErrorReply): void {
    this.sendJson(rec, res, e.status, { type: 'error', error: { type: e.type, message: e.message }, request_id: rec.requestId }, e.headers ?? {});
  }

  private async stream(rec: RecordedRequest, res: http.ServerResponse, spec: StreamReply): Promise<void> {
    rec.status = 200;
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive', ...this.baseHeaders(rec) });
    res.flushHeaders();
    const events = buildStreamEvents(spec, rec);
    const gone = () => res.destroyed || res.writableEnded || rec.clientAborted;
    for (let i = 0; i <= events.length; i++) {
      if (spec.stallAfter !== undefined && i === spec.stallAfter) {
        rec.holding = true;
        return; // keep the connection open, send nothing more
      }
      if (spec.dropAfter !== undefined && i === spec.dropAfter) {
        rec.holding = false;
        res.socket?.destroy();
        return;
      }
      if (spec.errorAfter && i === spec.errorAfter.events) {
        res.end(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: spec.errorAfter.type, message: spec.errorAfter.message }, request_id: rec.requestId })}\n\n`);
        return;
      }
      const ev = events[i];
      if (!ev) break;
      const frame = `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`;
      // Split each frame across two writes so the SDK's SSE decoder has to reassemble lines.
      const cut = Math.max(1, Math.floor(frame.length / 2));
      res.write(frame.slice(0, cut));
      await tick();
      if (gone()) return;
      res.write(frame.slice(cut));
      rec.eventsSent++;
      if (i === 0) res.write('event: ping\ndata: {"type": "ping"}\n\n');
      if (spec.eventDelayMs) await sleep(spec.eventDelayMs);
      else await tick();
      if (gone()) return;
    }
    res.end();
  }
}

/** The SSE event sequence the Messages API streams for this scripted reply. */
export function buildStreamEvents(spec: StreamReply, rec: RecordedRequest): StreamEvent[] {
  const model = spec.model ?? (typeof rec.body?.model === 'string' ? rec.body.model : 'claude-unknown');
  const usage: MockUsage = { ...DEFAULT_USAGE, ...spec.usage };
  const size = spec.chunkSize ?? 48;
  const hasTool = spec.blocks.some((b) => b.type === 'tool_use');
  const stopReason: StopReason = spec.stopReason ?? (hasTool ? 'tool_use' : 'end_turn');
  const events: StreamEvent[] = [
    {
      type: 'message_start',
      message: {
        id: `msg_mock_${String(rec.seq).padStart(6, '0')}`,
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        stop_details: null,
        container: null,
        context_management: null,
        diagnostics: null,
        usage: {
          input_tokens: usage.input_tokens,
          output_tokens: 1,
          cache_creation_input_tokens: usage.cache_creation_input_tokens,
          cache_read_input_tokens: usage.cache_read_input_tokens,
          cache_creation: null,
          fallback_credit: null,
          inference_geo: null,
          iterations: null,
          output_tokens_details: null,
          server_tool_use: null,
          service_tier: 'standard',
          speed: null,
        },
      },
    },
  ];
  spec.blocks.forEach((block, index) => {
    switch (block.type) {
      case 'thinking':
        events.push({ type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } });
        events.push({ type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: `sig_mock_${rec.seq}_${index}` } });
        break;
      case 'text':
        events.push({ type: 'content_block_start', index, content_block: { type: 'text', text: '', citations: null } });
        for (const c of chunks(block.text, size)) events.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: c } });
        break;
      case 'tool_use': {
        const json = block.rawJson ?? JSON.stringify(block.input ?? {});
        events.push({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: block.id ?? `toolu_mock_${rec.seq}_${index}`, name: block.name, input: {} } });
        events.push({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: '' } });
        for (const c of chunks(json, size)) events.push({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: c } });
        break;
      }
      case 'fallback':
        events.push({
          type: 'content_block_start',
          index,
          content_block: { type: 'fallback', from: { model: block.from }, to: { model: block.to }, trigger: { type: 'refusal', category: block.category ?? null } },
        });
        break;
    }
    events.push({ type: 'content_block_stop', index });
  });
  events.push({
    type: 'message_delta',
    delta: {
      stop_reason: stopReason,
      stop_sequence: null,
      stop_details: spec.stopDetails
        ? { type: 'refusal', category: spec.stopDetails.category, explanation: spec.stopDetails.explanation, fallback_credit_token: null, fallback_has_prefill_claim: null, recommended_model: null }
        : null,
      container: null,
    },
    usage: {
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cache_creation_input_tokens: usage.cache_creation_input_tokens,
      cache_read_input_tokens: usage.cache_read_input_tokens,
      fallback_credit: null,
      iterations: spec.iterations ?? null,
      output_tokens_details: null,
      server_tool_use: null,
    },
    context_management: null,
  });
  events.push({ type: 'message_stop' });
  return events;
}
