import { newId, ID_PREFIX } from '@shared/schemas/common.ts';
import type { Job, JobError, JobEvent, JobEventType, JobStatus, JobType, Usage } from '@shared/schemas/jobs.ts';
import { redactSecrets } from '../secrets.ts';
import { nowIso, parseJson, type Db } from './db.ts';

export interface JobRow {
  id: string;
  project_id: string;
  type: JobType;
  status: JobStatus;
  stage: string | null;
  mode: 'live' | 'demo' | 'local';
  input_json: string;
  result_json: string | null;
  error_json: string | null;
  usage_json: string | null;
  model: string | null;
  idempotency_key: string | null;
  attempt: number;
  max_attempts: number;
  cancel_requested: number;
  dismissed: number;
  lease_owner: string | null;
  lease_expires_at: number | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
}

export function toJob(r: JobRow): Job {
  return {
    id: r.id,
    projectId: r.project_id,
    type: r.type,
    status: r.status,
    stage: r.stage,
    attempt: r.attempt,
    maxAttempts: r.max_attempts,
    mode: r.mode,
    model: r.model,
    usage: parseJson<Usage | null>(r.usage_json, null),
    error: parseJson<JobError | null>(r.error_json, null),
    result: parseJson<unknown>(r.result_json, null),
    cancelRequested: r.cancel_requested === 1,
    createdAt: r.created_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  };
}

export function getJobRow(db: Db, id: string): JobRow | undefined {
  return db.get<JobRow>('SELECT * FROM jobs WHERE id = ?', [id]);
}

export function addEvent(
  db: Db,
  jobId: string,
  type: JobEventType,
  message: string,
  opts: { stage?: string | null; data?: unknown } = {},
): number {
  const r = db.run('INSERT INTO job_events (job_id, type, stage, message, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
    jobId,
    type,
    opts.stage ?? null,
    redactSecrets(message).slice(0, 4000),
    opts.data === undefined ? null : redactSecrets(JSON.stringify(opts.data)).slice(0, 200_000),
    nowIso(),
  ]);
  return r.lastInsertRowid;
}

export function eventsSince(db: Db, jobId: string, afterSeq: number, limit = 500): JobEvent[] {
  return db
    .all<{ seq: number; job_id: string; type: JobEventType; stage: string | null; message: string; data_json: string | null; created_at: string }>(
      'SELECT * FROM job_events WHERE job_id = ? AND seq > ? ORDER BY seq LIMIT ?',
      [jobId, afterSeq, limit],
    )
    .map((e) => ({ seq: e.seq, jobId: e.job_id, type: e.type, stage: e.stage, message: e.message, data: parseJson(e.data_json, null), createdAt: e.created_at }));
}

export interface CreateJobInput {
  projectId: string;
  type: JobType;
  input: unknown;
  mode: Job['mode'];
  idempotencyKey?: string | null;
  maxAttempts?: number;
  model?: string | null;
}

/**
 * Create a job unless an equivalent one exists: the same idempotency key, or an
 * active job of the same type for the project (repeated clicks never queue
 * duplicate paid generations).
 */
export function createJob(db: Db, input: CreateJobInput): { job: Job; created: boolean } {
  return db.tx(() => {
    if (input.idempotencyKey) {
      const existing = db.get<JobRow>('SELECT * FROM jobs WHERE project_id = ? AND idempotency_key = ?', [input.projectId, input.idempotencyKey]);
      if (existing) return { job: toJob(existing), created: false };
    }
    const active = db.get<JobRow>("SELECT * FROM jobs WHERE project_id = ? AND type = ? AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1", [
      input.projectId,
      input.type,
    ]);
    // Most job types run one at a time per project; these are distinct per input (another import, screen or grade version).
    const perInput = ['figma_browse', 'figma_import', 'motion_suggest', 'grade_plan', 'prepare'].includes(input.type);
    if (active && input.type !== 'ask' && (!perInput || active.input_json === JSON.stringify(input.input ?? {}))) return { job: toJob(active), created: false };
    const id = newId(ID_PREFIX.job);
    const now = nowIso();
    db.run(
      `INSERT INTO jobs (id, project_id, type, status, stage, mode, input_json, idempotency_key, attempt, max_attempts, model, created_at, updated_at)
       VALUES (?, ?, ?, 'queued', NULL, ?, ?, ?, 0, ?, ?, ?, ?)`,
      [id, input.projectId, input.type, input.mode, JSON.stringify(input.input ?? {}), input.idempotencyKey ?? null, input.maxAttempts ?? 3, input.model ?? null, now, now],
    );
    addEvent(db, id, 'status', 'Queued');
    return { job: toJob(getJobRow(db, id)!), created: true };
  });
}

export function listJobs(db: Db, projectId: string, limit = 50): Job[] {
  return db.all<JobRow>('SELECT * FROM jobs WHERE project_id = ? ORDER BY created_at DESC LIMIT ?', [projectId, limit]).map(toJob);
}

export function activeJobs(db: Db, projectId: string): Job[] {
  return db.all<JobRow>("SELECT * FROM jobs WHERE project_id = ? AND status IN ('queued','running') ORDER BY created_at", [projectId]).map(toJob);
}

/** Claim the oldest queued job with a lease. Returns null when the queue is empty. */
export function claimNextJob(db: Db, workerId: string, leaseMs: number): JobRow | null {
  return db.tx(() => {
    const now = Date.now();
    const row = db.get<JobRow>(
      `UPDATE jobs SET status = 'running', lease_owner = ?, lease_expires_at = ?, attempt = attempt + 1,
         started_at = COALESCE(started_at, ?), updated_at = ?
       WHERE id = (SELECT id FROM jobs WHERE status = 'queued' ORDER BY created_at, rowid LIMIT 1)
       RETURNING *`,
      [workerId, now + leaseMs, nowIso(), nowIso()],
    );
    if (!row) return null;
    addEvent(db, row.id, 'status', row.attempt > 1 ? `Started (attempt ${row.attempt} of ${row.max_attempts})` : 'Started');
    return row;
  });
}

/** Extend the lease. Returns false if this worker no longer owns the job. */
export function heartbeatJob(db: Db, jobId: string, workerId: string, leaseMs: number): boolean {
  const r = db.run("UPDATE jobs SET lease_expires_at = ?, updated_at = ? WHERE id = ? AND lease_owner = ? AND status = 'running'", [
    Date.now() + leaseMs,
    nowIso(),
    jobId,
    workerId,
  ]);
  return r.changes === 1;
}

export function setStage(db: Db, jobId: string, stage: string, message?: string): void {
  db.run('UPDATE jobs SET stage = ?, updated_at = ? WHERE id = ?', [stage, nowIso(), jobId]);
  if (message) addEvent(db, jobId, 'stage', message, { stage });
}

export function setJobModel(db: Db, jobId: string, model: string): void {
  db.run('UPDATE jobs SET model = ? WHERE id = ?', [model, jobId]);
}

export function finishJob(
  db: Db,
  jobId: string,
  workerId: string | null,
  status: Extract<JobStatus, 'succeeded' | 'failed' | 'cancelled'>,
  opts: { result?: unknown; error?: JobError; usage?: Usage | null } = {},
): void {
  db.tx(() => {
    const row = getJobRow(db, jobId);
    if (!row) return;
    if (workerId && row.lease_owner !== workerId) return; // lease lost — another worker or recovery owns it now
    const error = opts.error ? { ...opts.error, message: redactSecrets(opts.error.message) } : null;
    db.run(
      `UPDATE jobs SET status = ?, result_json = ?, error_json = ?, usage_json = COALESCE(?, usage_json), lease_owner = NULL,
         lease_expires_at = NULL, finished_at = ?, updated_at = ? WHERE id = ?`,
      [
        status,
        opts.result === undefined ? null : JSON.stringify(opts.result),
        error ? JSON.stringify(error) : null,
        opts.usage ? JSON.stringify(opts.usage) : null,
        nowIso(),
        nowIso(),
        jobId,
      ],
    );
    const message =
      status === 'succeeded' ? 'Completed' : status === 'cancelled' ? 'Cancelled' : `Failed: ${error?.message ?? 'unknown error'}`;
    addEvent(db, jobId, status === 'failed' ? 'error' : 'status', message, { stage: row.stage, data: { status } });
  });
}

export function requestCancel(db: Db, jobId: string): Job | null {
  return db.tx(() => {
    const row = getJobRow(db, jobId);
    if (!row) return null;
    if (row.status === 'queued') {
      db.run("UPDATE jobs SET status = 'cancelled', cancel_requested = 1, finished_at = ?, updated_at = ? WHERE id = ?", [nowIso(), nowIso(), jobId]);
      addEvent(db, jobId, 'status', 'Cancelled before it started. Nothing was changed.', { data: { status: 'cancelled' } });
    } else if (row.status === 'running') {
      db.run('UPDATE jobs SET cancel_requested = 1, updated_at = ? WHERE id = ?', [nowIso(), jobId]);
      addEvent(db, jobId, 'info', 'Cancellation requested — stopping after the current step.');
    }
    return toJob(getJobRow(db, jobId)!);
  });
}

export function isCancelRequested(db: Db, jobId: string): boolean {
  return db.get<{ c: number }>('SELECT cancel_requested AS c FROM jobs WHERE id = ?', [jobId])?.c === 1;
}

export class JobStateError extends Error {}

/** Re-queue a failed, interrupted or cancelled job. Completed stages are reused by the handler. */
export function retryJob(db: Db, jobId: string): Job {
  return db.tx(() => {
    const row = getJobRow(db, jobId);
    if (!row) throw new JobStateError('Job not found');
    if (!['failed', 'interrupted', 'cancelled'].includes(row.status)) throw new JobStateError(`A ${row.status} job cannot be retried.`);
    if (row.attempt >= row.max_attempts) throw new JobStateError(`This job already used ${row.attempt} of ${row.max_attempts} attempts. Start a new run instead.`);
    const done = db.all<{ stage_key: string }>("SELECT stage_key FROM job_stages WHERE job_id = ? AND status = 'succeeded'", [jobId]).map((s) => s.stage_key);
    db.run(
      "UPDATE jobs SET status = 'queued', error_json = NULL, cancel_requested = 0, dismissed = 0, finished_at = NULL, lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?",
      [nowIso(), jobId],
    );
    addEvent(db, jobId, 'status', done.length > 0 ? `Retry requested — ${done.length} completed stage(s) will be reused; only the failed stage runs again.` : 'Retry requested.');
    return toJob(getJobRow(db, jobId)!);
  });
}

/** Mark running jobs whose lease expired (worker crashed or restarted) as interrupted. No automatic re-run. */
export function recoverExpiredLeases(db: Db): JobRow[] {
  return db.tx(() => {
    const expired = db.all<JobRow>("SELECT * FROM jobs WHERE status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at < ?)", [Date.now()]);
    for (const row of expired) {
      db.run("UPDATE jobs SET status = 'interrupted', lease_owner = NULL, lease_expires_at = NULL, finished_at = ?, updated_at = ? WHERE id = ?", [nowIso(), nowIso(), row.id]);
      addEvent(
        db,
        row.id,
        'error',
        `Interrupted: the worker stopped while this job was running${row.stage ? ` (stage: ${row.stage})` : ''}. Your saved work is unchanged and nothing was retried automatically. Use Resume to continue from the last completed stage.`,
        { stage: row.stage, data: { status: 'interrupted' } },
      );
    }
    return expired;
  });
}

export function getStageOutput<T>(db: Db, jobId: string, key: string): { output: T; usage: Usage | null } | null {
  const row = db.get<{ output_json: string | null; usage_json: string | null }>(
    "SELECT output_json, usage_json FROM job_stages WHERE job_id = ? AND stage_key = ? AND status = 'succeeded'",
    [jobId, key],
  );
  if (!row) return null;
  return { output: parseJson<T>(row.output_json, null as T), usage: parseJson<Usage | null>(row.usage_json, null) };
}

export function saveStageOutput(db: Db, jobId: string, key: string, output: unknown, usage: Usage | null): void {
  db.run(
    `INSERT INTO job_stages (job_id, stage_key, status, output_json, usage_json, updated_at) VALUES (?, ?, 'succeeded', ?, ?, ?)
     ON CONFLICT(job_id, stage_key) DO UPDATE SET status = 'succeeded', output_json = excluded.output_json, usage_json = excluded.usage_json, updated_at = excluded.updated_at`,
    [jobId, key, JSON.stringify(output), usage ? JSON.stringify(usage) : null, nowIso()],
  );
}

export function dismissJob(db: Db, jobId: string): void {
  db.run('UPDATE jobs SET dismissed = 1, updated_at = ? WHERE id = ?', [nowIso(), jobId]);
}

export function workerHeartbeat(db: Db, workerId: string, pid: number, startedAt: string): void {
  db.run(
    `INSERT INTO workers (id, pid, started_at, heartbeat_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET heartbeat_at = excluded.heartbeat_at`,
    [workerId, pid, startedAt, Date.now()],
  );
}

export function workerStatus(db: Db): { online: boolean; lastHeartbeat: string | null; workerId: string | null } {
  const row = db.get<{ id: string; heartbeat_at: number }>('SELECT id, heartbeat_at FROM workers ORDER BY heartbeat_at DESC LIMIT 1');
  if (!row) return { online: false, lastHeartbeat: null, workerId: null };
  return { online: Date.now() - row.heartbeat_at < 20_000, lastHeartbeat: new Date(row.heartbeat_at).toISOString(), workerId: row.id };
}

export function logUsage(
  db: Db,
  entry: { jobId: string | null; projectId: string | null; stage: string; requestedModel: string; model: string; usage: Omit<Usage, 'calls'>; stopReason: string | null },
): void {
  db.run(
    `INSERT INTO usage_log (job_id, project_id, stage, requested_model, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, stop_reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      entry.jobId,
      entry.projectId,
      entry.stage,
      entry.requestedModel,
      entry.model,
      entry.usage.inputTokens,
      entry.usage.outputTokens,
      entry.usage.cacheReadTokens,
      entry.usage.cacheWriteTokens,
      entry.stopReason,
      nowIso(),
    ],
  );
}

export function usageSummary(db: Db, limit = 100) {
  return db.all<{
    job_id: string | null;
    project_id: string | null;
    stage: string;
    model: string;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
    stop_reason: string | null;
    created_at: string;
  }>('SELECT job_id, project_id, stage, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, stop_reason, created_at FROM usage_log ORDER BY id DESC LIMIT ?', [limit]);
}
