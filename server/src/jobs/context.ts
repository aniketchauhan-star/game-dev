import { EMPTY_USAGE, jobInputSchemas, type JobEventType, type JobType, type Usage } from '@shared/schemas/jobs.ts';
import type { App } from '../app.ts';
import type { CallContext, CallResult } from '../claude/gateway.ts';
import { addEvent, getStageOutput, saveStageOutput, setJobModel, setStage, type JobRow } from '../db/jobs.ts';

export class JobCancelled extends Error {
  constructor() {
    super('Cancelled by the creator');
  }
}

/** A failure the creator can act on; `retryable` controls whether Retry is offered. */
export class JobFailure extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

/**
 * Per-job helper handed to handlers: real stage events, resumable stages
 * (completed stage output is persisted and reused on retry), cancellation and
 * token usage accounting.
 */
export class JobContext<T extends JobType = JobType> {
  readonly controller = new AbortController();
  private usageTotal: Usage = { ...EMPTY_USAGE };
  private textBuffer = '';
  private textTimer: NodeJS.Timeout | null = null;
  modelUsed: string | null = null;
  fellBack = false;

  constructor(
    readonly app: App,
    readonly row: JobRow,
  ) {}

  get jobId(): string {
    return this.row.id;
  }
  get projectId(): string {
    return this.row.project_id;
  }
  get mode(): JobRow['mode'] {
    return this.row.mode;
  }
  get signal(): AbortSignal {
    return this.controller.signal;
  }
  get usage(): Usage {
    return this.usageTotal;
  }

  input(): import('zod').infer<(typeof jobInputSchemas)[T]> {
    const schema = jobInputSchemas[this.row.type as T];
    return schema.parse(JSON.parse(this.row.input_json)) as import('zod').infer<(typeof jobInputSchemas)[T]>;
  }

  event(type: JobEventType, message: string, data?: unknown): void {
    addEvent(this.app.db, this.jobId, type, message, { stage: this.row.stage, data });
  }

  stage(key: string, message: string): void {
    this.row.stage = key;
    setStage(this.app.db, this.jobId, key, message);
  }

  throwIfCancelled(): void {
    if (this.signal.aborted) throw new JobCancelled();
  }

  /** Run a stage once; on retry the stored output is reused and the stage is not repeated (or re-billed). */
  async once<O>(key: string, label: string, fn: () => Promise<{ output: O; usage?: Usage | null }>): Promise<O> {
    this.throwIfCancelled();
    const saved = getStageOutput<O>(this.app.db, this.jobId, key);
    if (saved) {
      this.event('info', `Reusing completed stage: ${label}`);
      return saved.output;
    }
    this.stage(key, label);
    const { output, usage } = await fn();
    saveStageOutput(this.app.db, this.jobId, key, output, usage ?? null);
    return output;
  }

  addUsage(u: Omit<Usage, 'calls'>, calls = 1): Usage {
    this.usageTotal = {
      inputTokens: this.usageTotal.inputTokens + u.inputTokens,
      outputTokens: this.usageTotal.outputTokens + u.outputTokens,
      cacheReadTokens: this.usageTotal.cacheReadTokens + u.cacheReadTokens,
      cacheWriteTokens: this.usageTotal.cacheWriteTokens + u.cacheWriteTokens,
      calls: this.usageTotal.calls + calls,
    };
    return { ...u, calls };
  }

  /** Record a Claude call: usage, the model that actually answered, and fallback use. */
  recordCall(r: CallResult): Usage {
    this.modelUsed = r.model;
    setJobModel(this.app.db, this.jobId, r.model);
    if (r.fellBack) {
      this.fellBack = true;
      this.event('warning', `Claude ${r.requestedModel} declined part of this request; the server-side fallback model ${r.model} answered instead.`);
    }
    this.event('usage', `Tokens: ${r.usage.inputTokens.toLocaleString('en-US')} in, ${r.usage.outputTokens.toLocaleString('en-US')} out${r.usage.cacheReadTokens ? `, ${r.usage.cacheReadTokens.toLocaleString('en-US')} from cache` : ''}`, {
      ...r.usage,
      model: r.model,
    });
    return this.addUsage(r.usage, r.calls);
  }

  claude(stage: string, onText?: (delta: string) => void): CallContext {
    return {
      stage,
      jobId: this.jobId,
      projectId: this.projectId,
      signal: this.signal,
      onActivity: (m) => this.event('info', m),
      onText,
    };
  }

  /** Buffer streamed text into job events (flushed every ~250 ms, never one row per token). */
  streamText(delta: string): void {
    this.textBuffer += delta;
    if (!this.textTimer) {
      this.textTimer = setTimeout(() => this.flushText(), 250);
    }
  }

  flushText(): void {
    if (this.textTimer) clearTimeout(this.textTimer);
    this.textTimer = null;
    if (this.textBuffer) {
      addEvent(this.app.db, this.jobId, 'text', this.textBuffer);
      this.textBuffer = '';
    }
  }
}
