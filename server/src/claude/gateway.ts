import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { z } from 'zod';
import type { ClaudeStatus } from '@shared/schemas/settings.ts';
import type { Usage } from '@shared/schemas/jobs.ts';
import type { ServerConfig } from '../config.ts';
import type { Db } from '../db/db.ts';
import { logUsage } from '../db/jobs.ts';
import { getSetting, setSetting } from '../db/misc.ts';
import { getApiKey, redactSecrets } from '../secrets.ts';

/**
 * Server-side Claude access through the official Anthropic SDK.
 *  - The key is read only from the server environment (secrets.ts).
 *  - The model comes from CLAUDE_MODEL (or a model the creator picked in
 *    Settings from the live Models API list) and is verified before use.
 *  - Structured outputs are validated again with Zod; nothing partial is applied.
 */

export type ClaudeErrorCode =
  | 'not_configured'
  | 'model_unverified'
  | 'auth'
  | 'permission'
  | 'billing'
  | 'model_not_found'
  | 'rate_limited'
  | 'overloaded'
  | 'server_error'
  | 'timeout'
  | 'connection'
  | 'refusal'
  | 'truncated'
  | 'invalid_output'
  | 'bad_request'
  | 'too_large'
  | 'cancelled';

export class ClaudeError extends Error {
  constructor(
    readonly code: ClaudeErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly detail: string | null = null,
  ) {
    super(redactSecrets(message));
  }
}

/** Models documented as accepting the server-side refusal fallback (`fallbacks: "default"`). */
const FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export interface CallContext {
  stage: string;
  jobId: string | null;
  projectId: string | null;
  signal?: AbortSignal;
  /** Real activity notes for the job log (e.g. “Receiving response…”). */
  onActivity?: (message: string) => void;
  /** User-facing streamed text deltas (chat answers only). */
  onText?: (delta: string) => void;
}

export interface CallResult {
  model: string;
  requestedModel: string;
  usage: Omit<Usage, 'calls'>;
  /** Billed API requests behind this result (more than 1 when a repair was needed). */
  calls: number;
  stopReason: string | null;
  fellBack: boolean;
}

export interface StructuredResult<T> extends CallResult {
  data: T;
  rawText: string;
}

export interface ChatResult extends CallResult {
  text: string;
  toolCalls: Array<{ id: string; name: string; input: unknown }>;
}

type ContentBlocks = Anthropic.Beta.BetaContentBlockParam[];

interface Verification {
  model: string;
  verifiedAt: string | null;
  info: ClaudeStatus['modelInfo'];
  error: string | null;
}

/** Messages and codes of errors raised when a connection breaks (undici, Node sockets). */
const NETWORK_FAILURE = /terminated|socket|ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|other side closed|premature close|network|fetch failed|UND_ERR/i;

export function mapError(err: unknown): ClaudeError {
  if (err instanceof ClaudeError) return err;
  if (err instanceof Anthropic.APIUserAbortError) return new ClaudeError('cancelled', 'The request was cancelled.', false);
  if (err instanceof Anthropic.AuthenticationError) {
    return new ClaudeError('auth', 'Claude rejected the API key (401). Check ANTHROPIC_API_KEY in the server environment and restart the server.', false);
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return new ClaudeError('permission', `This API key is not allowed to use the requested model or feature (403): ${err.message}`, false);
  }
  if (err instanceof Anthropic.NotFoundError) {
    return new ClaudeError('model_not_found', 'The configured model is not available to this API key (404). Choose another model in Settings.', false);
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new ClaudeError('rate_limited', 'Claude is rate-limiting requests right now (429). Your work is saved — retry in a minute.', true);
  }
  if (err instanceof Anthropic.BadRequestError) {
    const msg = err.message ?? '';
    if (/prompt is too long|too many tokens|request too large/i.test(msg)) {
      return new ClaudeError('too_large', 'The request was too large for the model. Exclude some slides or images and retry.', false, msg);
    }
    return new ClaudeError('bad_request', `Claude could not accept the request (400): ${msg}`, false, msg);
  }
  if (err instanceof Anthropic.InternalServerError) {
    if (err.status === 529) return new ClaudeError('overloaded', 'Claude is temporarily overloaded (529). Your work is saved — retry shortly.', true);
    return new ClaudeError('server_error', `Claude returned a server error (${err.status}). Your work is saved — retry shortly.`, true);
  }
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return new ClaudeError('timeout', 'The request to Claude timed out. Your work is saved — retry the stage.', true);
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new ClaudeError('connection', 'Could not reach the Claude API (network error). Check your connection and retry.', true);
  }
  if (err instanceof Anthropic.APIError) {
    if (err.status === 402) return new ClaudeError('billing', 'The Anthropic account has a billing problem (402).', false);
    if (err.status === 413) return new ClaudeError('too_large', 'The request was too large for the model. Exclude some slides or images and retry.', false, err.message);
    // An `error` event inside an open stream has no HTTP status — only the error type.
    switch (err.type) {
      case 'overloaded_error':
        return new ClaudeError('overloaded', 'Claude is temporarily overloaded. Your work is saved — retry shortly.', true);
      case 'rate_limit_error':
        return new ClaudeError('rate_limited', 'Claude is rate-limiting requests right now. Your work is saved — retry in a minute.', true);
      case 'timeout_error':
        return new ClaudeError('timeout', 'The request to Claude timed out. Your work is saved — retry the stage.', true);
      case 'authentication_error':
        return new ClaudeError('auth', 'Claude rejected the API key. Check ANTHROPIC_API_KEY in the server environment and restart the server.', false);
      case 'permission_error':
        return new ClaudeError('permission', `This API key is not allowed to use the requested model or feature: ${err.message}`, false);
      case 'not_found_error':
        return new ClaudeError('model_not_found', 'The configured model is not available to this API key. Choose another model in Settings.', false);
      case 'billing_error':
        return new ClaudeError('billing', 'The Anthropic account has a billing problem.', false);
      case 'invalid_request_error':
        return new ClaudeError('bad_request', `Claude could not accept the request: ${err.message}`, false, err.message);
      default:
        return new ClaudeError('server_error', `Claude API error${err.status ? ` ${err.status}` : ''}: ${err.message}`, true);
    }
  }
  if (err instanceof Anthropic.AnthropicError) {
    // Raised by the SDK itself (not the API). A broken connection arrives here wrapped, with the
    // network error as `cause`; anything else is a response the SDK could not parse.
    const cause = (err as { cause?: unknown }).cause;
    const detail = `${err.message} ${cause instanceof Error ? `${cause.name} ${cause.message} ${(cause as { code?: string }).code ?? ''}` : ''}`;
    if (/stream ended without|request ended without sending any chunks/i.test(err.message) || NETWORK_FAILURE.test(detail)) {
      return new ClaudeError('connection', 'The connection to Claude was interrupted before the response finished. Nothing was applied — retry the stage.', true);
    }
    return new ClaudeError('invalid_output', `Claude's response could not be parsed: ${err.message}`, true);
  }
  const message = err instanceof Error ? err.message : String(err);
  if (/abort/i.test(message)) return new ClaudeError('cancelled', 'The request was cancelled.', false);
  return new ClaudeError('connection', `The response stream was interrupted: ${message}`, true);
}

interface UsageCounts {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

/**
 * Billed tokens for one response. When the response carries `usage.iterations`
 * (e.g. a server-side refusal fallback), those entries are the per-attempt billing
 * record and top-level `usage` covers only the attempt that answered — so sum them.
 */
function usageOf(u: Anthropic.Beta.BetaUsage | undefined): Omit<Usage, 'calls'> {
  const iterations = (u as { iterations?: UsageCounts[] | null } | undefined)?.iterations;
  const entries: UsageCounts[] = iterations && iterations.length > 0 ? iterations : u ? [u as UsageCounts] : [];
  return entries.reduce<Omit<Usage, 'calls'>>(
    (acc, e) => ({
      inputTokens: acc.inputTokens + (e.input_tokens ?? 0),
      outputTokens: acc.outputTokens + (e.output_tokens ?? 0),
      cacheReadTokens: acc.cacheReadTokens + (e.cache_read_input_tokens ?? 0),
      cacheWriteTokens: acc.cacheWriteTokens + (e.cache_creation_input_tokens ?? 0),
    }),
    { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  );
}

/** JSON schema for structured outputs, built with the SDK's documented Zod helper. */
export function outputSchemaFor(schema: z.ZodType): { type: 'json_schema'; schema: Record<string, unknown> } {
  const fmt = zodOutputFormat(schema as never) as unknown as { schema: Record<string, unknown> };
  // Passed without a `parse` function: the SDK returns raw text and we validate it ourselves.
  return { type: 'json_schema', schema: fmt.schema };
}

export class ClaudeGateway {
  private client: Anthropic | null = null;

  constructor(
    private readonly db: Db,
    private readonly config: ServerConfig,
  ) {}

  /** Model from CLAUDE_MODEL, else the creator's choice in Settings. */
  resolveModel(): { model: string | null; source: 'env' | 'settings' | null } {
    if (this.config.claude.model) return { model: this.config.claude.model, source: 'env' };
    const chosen = getSetting<string | null>(this.db, 'claude.model', null);
    return chosen ? { model: chosen, source: 'settings' } : { model: null, source: null };
  }

  private verification(): Verification | null {
    return getSetting<Verification | null>(this.db, 'claude.verification', null);
  }

  status(): ClaudeStatus {
    const keyPresent = getApiKey() !== null;
    const { model, source } = this.resolveModel();
    const v = this.verification();
    const matches = v && v.model === model;
    let state: ClaudeStatus['state'];
    if (!keyPresent) state = 'not_configured';
    else if (matches && v!.error) state = 'connection_failed';
    else if (matches && v!.verifiedAt) state = 'configured';
    else state = 'unverified';
    return {
      state,
      keyPresent,
      model,
      modelSource: source,
      verifiedAt: matches ? (v!.verifiedAt ?? null) : null,
      modelInfo: matches ? (v!.info ?? null) : null,
      lastError: matches ? (v!.error ?? null) : null,
      refusalFallback: this.config.claude.refusalFallback,
      baseUrlOverridden: Boolean(this.config.claude.baseUrl),
    };
  }

  private sdk(): Anthropic {
    const apiKey = getApiKey();
    if (!apiKey) {
      throw new ClaudeError('not_configured', 'Claude is not configured. Add ANTHROPIC_API_KEY to the server environment (.env) and restart the server.', false);
    }
    if (!this.client) {
      this.client = new Anthropic({
        apiKey,
        authToken: null,
        baseURL: this.config.claude.baseUrl ?? undefined,
        maxRetries: this.config.claude.maxRetries,
        timeout: this.config.claude.timeoutMs,
        logLevel: 'off',
      });
    }
    return this.client;
  }

  /** Verify the configured model with the Models API; optionally send one tiny structured request. */
  async verify(opts: { testRequest: boolean }): Promise<ClaudeStatus> {
    const { model } = this.resolveModel();
    if (!getApiKey()) return this.status();
    if (!model) {
      setSetting(this.db, 'claude.verification', { model: null, verifiedAt: null, info: null, error: 'No model selected. Set CLAUDE_MODEL or choose a model in Settings.' });
      return this.status();
    }
    try {
      const info = await this.sdk().models.retrieve(model);
      const caps = info.capabilities;
      const modelInfo: NonNullable<ClaudeStatus['modelInfo']> = {
        id: info.id,
        displayName: info.display_name,
        maxInputTokens: info.max_input_tokens ?? null,
        maxOutputTokens: (info as { max_tokens?: number | null }).max_tokens ?? null,
        structuredOutputs: caps ? caps.structured_outputs.supported : null,
        imageInput: caps ? caps.image_input.supported : null,
        pdfInput: caps ? caps.pdf_input.supported : null,
        effort: caps ? caps.effort.supported : null,
      };
      if (modelInfo.structuredOutputs === false) {
        setSetting(this.db, 'claude.verification', { model, verifiedAt: null, info: modelInfo, error: `${info.display_name} does not support structured outputs, which NEXUS needs. Choose another model.` });
        return this.status();
      }
      setSetting(this.db, 'claude.verification', { model, verifiedAt: new Date().toISOString(), info: modelInfo, error: null });
      if (opts.testRequest) {
        const { z } = await import('zod');
        await this.structured(
          { system: 'You are a connection test. Return exactly the JSON object requested.', content: 'Return {"ok": true}.', schema: z.object({ ok: z.boolean() }), maxTokens: 2048, effort: 'low' },
          { stage: 'connection-test', jobId: null, projectId: null },
        );
      }
      return this.status();
    } catch (err) {
      const e = mapError(err);
      setSetting(this.db, 'claude.verification', { model, verifiedAt: null, info: this.verification()?.info ?? null, error: e.message });
      return this.status();
    }
  }

  async listModels(): Promise<Array<{ id: string; displayName: string; createdAt: string }>> {
    const out: Array<{ id: string; displayName: string; createdAt: string }> = [];
    try {
      for await (const m of this.sdk().models.list()) {
        out.push({ id: m.id, displayName: m.display_name, createdAt: m.created_at });
        if (out.length >= 100) break;
      }
    } catch (err) {
      throw mapError(err);
    }
    return out;
  }

  private ensureReady(): { model: string; info: ClaudeStatus['modelInfo'] } {
    const st = this.status();
    if (!st.keyPresent) {
      throw new ClaudeError('not_configured', 'Claude is not configured. Add ANTHROPIC_API_KEY to the server environment and restart the server.', false);
    }
    if (!st.model) throw new ClaudeError('model_unverified', 'No Claude model is selected. Set CLAUDE_MODEL or choose one in Settings.', false);
    if (st.state !== 'configured') {
      throw new ClaudeError('model_unverified', `Model ${st.model} has not been verified yet. Open Settings and run “Test connection”.`, false);
    }
    return { model: st.model, info: st.modelInfo };
  }

  private baseParams(model: string, info: ClaudeStatus['modelInfo'], effort: 'low' | 'medium' | 'high' | undefined) {
    const params: Record<string, unknown> = {};
    if (effort && info?.effort) params.output_config = { effort };
    if (this.config.claude.refusalFallback === 'default' && FALLBACK_MODELS.has(model)) {
      params.fallbacks = 'default';
      params.betas = [FALLBACK_BETA];
    }
    return params;
  }

  private async run(
    params: Record<string, unknown>,
    ctx: CallContext,
    model: string,
  ): Promise<{ message: Anthropic.Beta.BetaMessage; text: string }> {
    const client = this.sdk();
    ctx.onActivity?.(`Sending request to Claude (${model})`);
    // The SDK's timeout (and its bounded retries) cover the wait for response headers. Once the
    // stream is open, this watchdog bounds silence between events, so a stalled connection cannot
    // hold a job forever. Pings are consumed by the SDK, so the limit is generous: CLAUDE_TIMEOUT_MS.
    const idleMs = this.config.claude.timeoutMs;
    const local = new AbortController();
    const forwardAbort = () => local.abort();
    if (ctx.signal?.aborted) local.abort();
    else ctx.signal?.addEventListener('abort', forwardAbort, { once: true });
    let stalled = false;
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    const arm = () => {
      if (watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        stalled = true;
        local.abort();
      }, idleMs);
    };
    let announced = false;
    try {
      const stream = client.beta.messages.stream(params as unknown as Anthropic.Beta.Messages.MessageCreateParamsStreaming, { signal: local.signal });
      stream.on('connect', arm);
      stream.on('streamEvent', arm);
      stream.on('text', (delta) => {
        if (!announced) {
          announced = true;
          ctx.onActivity?.('Receiving response');
        }
        ctx.onText?.(delta);
      });
      const message = (await stream.finalMessage()) as Anthropic.Beta.BetaMessage;
      const text = message.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
      return { message, text };
    } catch (err) {
      if (stalled && !ctx.signal?.aborted) {
        throw new ClaudeError('timeout', `Claude stopped sending data for more than ${formatMs(idleMs)}, so the request was abandoned. Nothing was applied — retry the stage.`, true);
      }
      throw mapError(err);
    } finally {
      if (watchdog) clearTimeout(watchdog);
      ctx.signal?.removeEventListener('abort', forwardAbort);
    }
  }

  private record(ctx: CallContext, requestedModel: string, message: Anthropic.Beta.BetaMessage): CallResult {
    const usage = usageOf(message.usage);
    const iterations = (message.usage as { iterations?: Array<{ type?: string }> | null }).iterations ?? [];
    const fellBack = iterations.some((i) => i.type === 'fallback_message');
    logUsage(this.db, {
      jobId: ctx.jobId,
      projectId: ctx.projectId,
      stage: ctx.stage,
      requestedModel,
      model: message.model,
      usage,
      stopReason: message.stop_reason ?? null,
    });
    return { model: message.model, requestedModel, usage, calls: 1, stopReason: message.stop_reason ?? null, fellBack };
  }

  private checkStop(message: Anthropic.Beta.BetaMessage, maxTokens: number): void {
    if (message.stop_reason === 'refusal') {
      const details = message.stop_details as { category?: string | null; explanation?: string | null } | null;
      throw new ClaudeError(
        'refusal',
        `Claude declined this request${details?.category ? ` (category: ${details.category})` : ''}. Nothing was changed; your project is saved. Rephrase the request or adjust the source content.`,
        false,
        details?.explanation ?? null,
      );
    }
    if (message.stop_reason === 'max_tokens') {
      throw new ClaudeError('truncated', `Claude's response was cut off at the ${maxTokens}-token output limit. Nothing was applied. Retry the stage, or reduce its scope.`, true);
    }
    if (message.stop_reason === 'pause_turn') {
      throw new ClaudeError('invalid_output', 'Claude paused before finishing. Nothing was applied — retry the stage.', true);
    }
  }

  /**
   * Structured-output call: stream to completion, check the stop reason, parse, then validate
   * with Zod. Output that is not valid JSON or does not match the schema gets a bounded number of
   * repair attempts (CLAUDE_MAX_REPAIR_ATTEMPTS) that show Claude its answer and the exact
   * problems; if it still fails, the call fails — nothing partial is returned.
   */
  async structured<T>(
    opts: { system: string; content: string | ContentBlocks; schema: z.ZodType<T>; maxTokens: number; effort?: 'low' | 'medium' | 'high'; cacheSystem?: boolean },
    ctx: CallContext,
  ): Promise<StructuredResult<T>> {
    const { model, info } = this.ensureReady();
    const extra = this.baseParams(model, info, opts.effort);
    const outputConfig = { ...((extra.output_config as Record<string, unknown>) ?? {}), format: outputSchemaFor(opts.schema) };
    const repairs = this.config.claude.maxRepairAttempts;
    const total: Omit<Usage, 'calls'> = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    let content = opts.content;
    for (let attempt = 0; ; attempt++) {
      const params = {
        ...extra,
        model,
        max_tokens: opts.maxTokens,
        system: [{ type: 'text', text: opts.system, ...(opts.cacheSystem ? { cache_control: { type: 'ephemeral' } } : {}) }],
        messages: [{ role: 'user', content }],
        output_config: outputConfig,
      };
      const { message, text } = await this.run(params, { ...ctx, onText: undefined }, model);
      const meta = this.record(ctx, model, message);
      total.inputTokens += meta.usage.inputTokens;
      total.outputTokens += meta.usage.outputTokens;
      total.cacheReadTokens += meta.usage.cacheReadTokens;
      total.cacheWriteTokens += meta.usage.cacheWriteTokens;
      this.checkStop(message, opts.maxTokens);
      const outcome = parseStructured(text, opts.schema);
      if (outcome.ok) return { ...meta, usage: { ...total }, calls: attempt + 1, data: outcome.data, rawText: text };
      if (attempt >= repairs) throw outcome.error;
      ctx.onActivity?.(`Claude's output did not validate (${outcome.summary.slice(0, 160)}); asking for a corrected version (repair ${attempt + 1} of ${repairs})`);
      content = withRepairNote(opts.content, text, outcome.summary);
    }
  }

  /** Streamed conversational call with optional strict tools (refinement proposals). */
  async chat(
    opts: { system: string; content: string | ContentBlocks; tools?: Anthropic.Beta.BetaTool[]; maxTokens: number; effort?: 'low' | 'medium' | 'high' },
    ctx: CallContext,
  ): Promise<ChatResult> {
    const { model, info } = this.ensureReady();
    const params = {
      ...this.baseParams(model, info, opts.effort),
      model,
      max_tokens: opts.maxTokens,
      system: [{ type: 'text', text: opts.system }],
      messages: [{ role: 'user', content: opts.content }],
      ...(opts.tools && opts.tools.length > 0 ? { tools: opts.tools, tool_choice: { type: 'auto' } } : {}),
    };
    const { message, text } = await this.run(params, ctx, model);
    const meta = this.record(ctx, model, message);
    this.checkStop(message, opts.maxTokens);
    const toolCalls = message.content
      .filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use')
      .map((b) => ({ id: b.id, name: b.name, input: b.input }));
    return { ...meta, text, toolCalls };
  }

  /** Real input-token count for a prepared request (free endpoint; rate limited). */
  async countTokens(opts: { system: string; content: string | ContentBlocks }): Promise<number> {
    const { model } = this.ensureReady();
    try {
      const r = await this.sdk().beta.messages.countTokens({
        model,
        system: [{ type: 'text', text: opts.system }],
        messages: [{ role: 'user', content: opts.content }],
      } as unknown as Anthropic.Beta.Messages.MessageCountTokensParams);
      return r.input_tokens;
    } catch (err) {
      throw mapError(err);
    }
  }
}

function formatMs(ms: number): string {
  return ms >= 1000 ? `${Math.round(ms / 1000)} s` : `${ms} ms`;
}

function parseStructured<T>(text: string, schema: z.ZodType<T>): { ok: true; data: T } | { ok: false; error: ClaudeError; summary: string } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    const why = (err as Error).message;
    return { ok: false, summary: `not valid JSON (${why})`, error: new ClaudeError('invalid_output', 'Claude returned output that is not valid JSON. Nothing was applied.', true, text.slice(0, 500)) };
  }
  const parsed = schema.safeParse(json);
  if (parsed.success) return { ok: true, data: parsed.data };
  const issues = parsed.error.issues.slice(0, 6).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
  return { ok: false, summary: issues, error: new ClaudeError('invalid_output', `Claude's output did not match the expected structure: ${issues}. Nothing was applied.`, true, issues) };
}

/** The original request plus Claude's previous answer and what was wrong with it. */
function withRepairNote(original: string | ContentBlocks, previous: string, problems: string): string | ContentBlocks {
  const note = `Your previous answer could not be used because it was ${problems.startsWith('not valid JSON') ? problems : `invalid: ${problems}`}.\n\nPrevious answer (truncated):\n${previous.slice(0, 6000)}\n\nReturn the complete answer again as a single JSON object that matches the required schema exactly.`;
  return typeof original === 'string' ? `${original}\n\n${note}` : [...original, { type: 'text', text: note }];
}
