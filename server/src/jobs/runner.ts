import os from 'node:os';
import type { JobType } from '@shared/schemas/jobs.ts';
import type { App } from '../app.ts';
import { ClaudeError } from '../claude/gateway.ts';
import { addEvent, claimNextJob, finishJob, heartbeatJob, isCancelRequested, recoverExpiredLeases, workerHeartbeat, type JobRow } from '../db/jobs.ts';
import { touchProject } from '../db/projects.ts';
import { HttpError } from '../errors.ts';
import { MediaRejection } from '../ingest/media.ts';
import { PdfRejection } from '../ingest/pdf.ts';
import { PptxRejection } from '../ingest/pptx.ts';
import { redactSecrets } from '../secrets.ts';
import { JobCancelled, JobContext, JobFailure } from './context.ts';
import { handleAnalyze } from './handlers/analyze.ts';
import { handleBlueprint } from './handlers/blueprint.ts';
import { handleBuild } from './handlers/build.ts';
import { handleFigmaBrowse, handleFigmaImport } from './handlers/figma.ts';
import { handleGradePlan } from './handlers/grade.ts';
import { handleMotionSuggest } from './handlers/motion.ts';
import { handlePrepare } from './handlers/prepare.ts';
import { handleExtractPdf, handleExtractPptx, handleRenderSlides } from './handlers/ingest.ts';
import { handleAsk, handleRefine } from './handlers/refine.ts';
import { handleRegenerateScene } from './handlers/regenerate.ts';

export const LEASE_MS = 30_000;

type Handler = (ctx: JobContext) => Promise<unknown>;


const HANDLERS: Record<JobType, Handler> = {
  extract_pptx: handleExtractPptx as Handler,
  extract_pdf: handleExtractPdf as Handler,
  render_slides: handleRenderSlides as Handler,
  analyze: handleAnalyze as Handler,
  blueprint: handleBlueprint as Handler,
  regenerate_scene: handleRegenerateScene as Handler,
  build: handleBuild as Handler,
  refine: handleRefine as Handler,
  ask: handleAsk as Handler,
  figma_browse: handleFigmaBrowse as Handler,
  figma_import: handleFigmaImport as Handler,
  grade_plan: handleGradePlan as Handler,
  motion_suggest: handleMotionSuggest as Handler,
  prepare: handlePrepare as Handler,
};

function describeFailure(err: unknown): { message: string; code: string; retryable: boolean } {
  if (err instanceof ClaudeError) return { message: err.message, code: `claude_${err.code}`, retryable: err.retryable };
  if (err instanceof PptxRejection) return { message: `${err.message} ${err.hint}`, code: `pptx_${err.code}`, retryable: false };
  if (err instanceof PdfRejection) return { message: `${err.message} ${err.hint}`, code: `pdf_${err.code}`, retryable: false };
  if (err instanceof MediaRejection) return { message: `${err.message} ${err.hint}`, code: `media_${err.code}`, retryable: false };
  if (err instanceof JobFailure) return { message: err.message, code: err.code, retryable: err.retryable };
  if (err instanceof HttpError) return { message: err.hint ? `${err.message} ${err.hint}` : err.message, code: err.code, retryable: false };
  const message = err instanceof Error ? err.message : String(err);
  return { message: `Unexpected error: ${message}`, code: 'internal', retryable: true };
}

/** Run one claimed job to completion with lease heartbeats and cancellation polling. */
export async function processJob(app: App, row: JobRow, workerId: string): Promise<void> {
  const ctx = new JobContext(app, row);
  let leaseLost = false;
  const timer = setInterval(() => {
    try {
      if (!heartbeatJob(app.db, row.id, workerId, LEASE_MS)) {
        leaseLost = true;
        ctx.controller.abort();
      } else if (isCancelRequested(app.db, row.id)) {
        ctx.controller.abort();
      }
    } catch {
      // database busy — try again next tick
    }
  }, 1000);
  try {
    const handler = HANDLERS[row.type];
    if (!handler) throw new JobFailure(`Unknown job type ${row.type}`, 'unknown_type', false);
    const result = await handler(ctx);
    ctx.flushText();
    if (ctx.signal.aborted && !leaseLost) {
      finishJob(app.db, row.id, workerId, 'cancelled', { usage: ctx.usage.calls ? ctx.usage : null });
    } else if (!leaseLost) {
      finishJob(app.db, row.id, workerId, 'succeeded', { result, usage: ctx.usage.calls ? ctx.usage : null });
    }
  } catch (err) {
    ctx.flushText();
    if (leaseLost) {
      // Another process (or recovery) owns the job now; do not overwrite its state.
    } else if (err instanceof JobCancelled || (ctx.signal.aborted && isCancelRequested(app.db, row.id))) {
      addEvent(app.db, row.id, 'info', 'Stopped at the creator’s request. Saved work and the last playable version are unchanged.');
      finishJob(app.db, row.id, workerId, 'cancelled', { usage: ctx.usage.calls ? ctx.usage : null });
    } else {
      const f = describeFailure(err);
      finishJob(app.db, row.id, workerId, 'failed', {
        error: { message: redactSecrets(f.message), code: f.code, retryable: f.retryable, stage: ctx.row.stage },
        usage: ctx.usage.calls ? ctx.usage : null,
      });
    }
  } finally {
    clearInterval(timer);
    touchProject(app.db, row.project_id);
  }
}

/** Process at most one queued job. Returns true when a job ran. Used by the worker loop and tests. */
export async function runOnce(app: App, workerId: string): Promise<boolean> {
  const row = claimNextJob(app.db, workerId, LEASE_MS);
  if (!row) return false;
  await processJob(app, row, workerId);
  return true;
}

export async function workerLoop(app: App, opts: { workerId?: string; signal?: AbortSignal; pollMs?: number } = {}): Promise<void> {
  const workerId = opts.workerId ?? `worker-${os.hostname()}-${process.pid}`;
  const startedAt = new Date().toISOString();
  const recovered = recoverExpiredLeases(app.db);
  if (recovered.length > 0) console.log(`[worker] marked ${recovered.length} interrupted job(s) from a previous run`);
  // Heartbeat and lease recovery run on their own timer so long jobs keep the worker visibly online.
  const beat = () => {
    try {
      workerHeartbeat(app.db, workerId, process.pid, startedAt);
      recoverExpiredLeases(app.db);
    } catch {
      // database briefly busy — next tick
    }
  };
  beat();
  const timer = setInterval(beat, 5000);
  try {
    while (!opts.signal?.aborted) {
      let ran = false;
      try {
        ran = await runOnce(app, workerId);
      } catch (err) {
        console.error('[worker] job loop error:', redactSecrets(err instanceof Error ? err.message : String(err)));
      }
      if (!ran) await new Promise((r) => setTimeout(r, opts.pollMs ?? 400));
    }
  } finally {
    clearInterval(timer);
  }
}
