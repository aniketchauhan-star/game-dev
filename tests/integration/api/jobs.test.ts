import './env.ts';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Job, JobEvent } from '@shared/schemas/jobs.ts';
import type { ProjectDetail } from '@shared/schemas/project.ts';
import { claimNextJob, eventsSince, finishJob, heartbeatJob, recoverExpiredLeases } from '../../../server/src/db/jobs.ts';
import { LEASE_MS, runOnce, workerLoop } from '../../../server/src/jobs/runner.ts';
import { idempotencyKey, oleFile, sampleDeck, Studio } from './helpers.ts';

describe('jobs', () => {
  let s: Studio;
  let sample: ProjectDetail;

  beforeAll(async () => {
    s = await Studio.start();
    sample = await s.createSample();
  });

  afterAll(async () => {
    await s.close();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const versionCount = (projectId: string) => s.app.db.get<{ c: number }>('SELECT COUNT(*) AS c FROM game_versions WHERE project_id = ?', [projectId])!.c;
  const queueBuild = (headers: Record<string, string> = {}) => s.post(`/api/projects/${sample.id}/jobs`, { type: 'build', input: { blueprintRevisionId: sample.approvedBlueprintId } }, headers);

  /** Upload a deck to a fresh project and return the queued extraction job id. */
  async function queuedExtraction(name: string, data: Buffer = sampleDeck(), filename = 'deck.pptx'): Promise<{ projectId: string; jobId: string; documentId: string }> {
    const p = await s.createProject(name);
    const up = await s.upload(p.id, { filename, data });
    expect(up.statusCode, up.body).toBe(202);
    return { projectId: p.id, jobId: up.json().job.id as string, documentId: up.json().document.id as string };
  }

  describe('idempotency', () => {
    it('the same Idempotency-Key returns the same job — while queued and after it finished', async () => {
      const key = idempotencyKey();
      const first = await queueBuild({ 'idempotency-key': key });
      expect(first.statusCode, first.body).toBe(202);
      expect(first.json()).toMatchObject({ deduplicated: false, job: { type: 'build', status: 'queued', mode: 'local' } });
      const id = first.json().job.id as string;

      const again = await queueBuild({ 'idempotency-key': key });
      expect(again.statusCode).toBe(200);
      expect(again.json()).toMatchObject({ deduplicated: true, job: { id } });

      const versionsBefore = versionCount(sample.id);
      expect(await s.runJobs()).toBe(1);
      expect(versionCount(sample.id)).toBe(versionsBefore + 1);

      const afterFinish = await queueBuild({ 'idempotency-key': key });
      expect(afterFinish.statusCode).toBe(200);
      expect(afterFinish.json()).toMatchObject({ deduplicated: true, job: { id, status: 'succeeded' } });
      expect(await s.runJobs()).toBe(0);
      expect(versionCount(sample.id)).toBe(versionsBefore + 1);

      // A different key is a new request.
      const other = await queueBuild({ 'idempotency-key': idempotencyKey() });
      expect(other.statusCode).toBe(202);
      expect(other.json().job.id).not.toBe(id);
      // …but a repeated click while that job is still queued never queues a duplicate.
      const repeat = await queueBuild({ 'idempotency-key': idempotencyKey() });
      expect(repeat.statusCode).toBe(200);
      expect(repeat.json()).toMatchObject({ deduplicated: true, job: { id: other.json().job.id } });
      expect(await s.runJobs()).toBe(1);
    });

    it('rejects a malformed Idempotency-Key', async () => {
      for (const key of ['short', 'has spaces in it', 'x'.repeat(81), 'semi;colon-key']) {
        const res = await queueBuild({ 'idempotency-key': key });
        expect(res.statusCode, key).toBe(400);
        expect(res.json().error.message).toBe('Invalid Idempotency-Key header.');
      }
      expect((await s.project(sample.id)).activeJobs).toEqual([]);
    });
  });

  describe('creation rules', () => {
    it('refuses job types that must go through the chat or upload endpoints, unknown types and unknown projects', async () => {
      const doc = (await s.project(sample.id)).documents[0]!;
      for (const [type, input] of [
        ['extract_pptx', { documentId: doc.id }],
        ['extract_pdf', { documentId: doc.id }],
        ['refine', {}],
        ['ask', {}],
      ] as const) {
        const res = await s.post(`/api/projects/${sample.id}/jobs`, { type, input });
        expect(res.statusCode, type).toBe(409);
        expect(res.json().error.message).toBe('Start this through the chat or the upload endpoint.');
      }
      expect((await s.post(`/api/projects/${sample.id}/jobs`, { type: 'mine_bitcoin', input: {} })).statusCode).toBe(400);
      expect((await s.post('/api/projects/prj_doesnotexist/jobs', { type: 'build', input: { blueprintRevisionId: sample.approvedBlueprintId } })).statusCode).toBe(404);
      expect((await s.project(sample.id)).activeJobs).toEqual([]);
    });
  });

  describe('cancel', () => {
    it('cancels a queued job before it starts; the worker never runs it', async () => {
      const versionsBefore = versionCount(sample.id);
      const queued = await queueBuild({ 'idempotency-key': idempotencyKey() });
      expect(queued.statusCode).toBe(202);
      const id = queued.json().job.id as string;

      const res = await s.post(`/api/jobs/${id}/cancel`);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().job).toMatchObject({ id, status: 'cancelled', cancelRequested: true, attempt: 0 });
      expect(res.json().job.finishedAt).toBeTruthy();

      expect(await runOnce(s.worker, 'cancel-worker')).toBe(false);
      const { job, events } = await s.job(id);
      expect(job.status).toBe('cancelled');
      expect(job.startedAt).toBeNull();
      expect(events.map((e) => e.message)).toEqual(['Queued', 'Cancelled before it started. Nothing was changed.']);
      expect(versionCount(sample.id)).toBe(versionsBefore);

      // Cancelling again is harmless; unknown jobs are 404.
      expect((await s.post(`/api/jobs/${id}/cancel`)).json().job.status).toBe('cancelled');
      expect((await s.post('/api/jobs/job_doesnotexist/cancel')).statusCode).toBe(404);
    });
  });

  describe('retry', () => {
    it('re-queues a failed job; it completes once the cause is fixed; a succeeded job cannot be retried', async () => {
      const { projectId, jobId, documentId } = await queuedExtraction('Retry after fix');
      const stored = path.join(s.dataDir, 'projects', projectId, 'sources', documentId, 'original.pptx');
      const good = fs.readFileSync(stored);
      fs.writeFileSync(stored, Buffer.from('damaged on disk before the worker ran'));

      await s.runJobs();
      let { job } = await s.job(jobId);
      expect(job.status).toBe('failed');
      expect(job.error).toMatchObject({ code: 'pptx_unsupported-format', retryable: false });
      expect((await s.project(projectId)).lastProblemJob?.id).toBe(jobId);

      fs.writeFileSync(stored, good);
      const retried = await s.post(`/api/jobs/${jobId}/retry`);
      expect(retried.statusCode, retried.body).toBe(200);
      expect(retried.json().job).toMatchObject({ id: jobId, status: 'queued', error: null, finishedAt: null, attempt: 1 });

      expect(await s.runJobs()).toBe(1);
      let events: JobEvent[];
      ({ job, events } = await s.job(jobId));
      expect(job.status).toBe('succeeded');
      expect(job.attempt).toBe(2);
      const messages = events.map((e) => e.message);
      expect(messages).toContain('Retry requested.');
      expect(messages).toContain('Started (attempt 2 of 2)');
      expect(messages.at(-1)).toBe('Completed');
      expect((await s.slides(projectId))).toHaveLength(9);
      const p = await s.project(projectId);
      expect(p.lastProblemJob).toBeNull();
      expect(p.statusLabel).toBe('Draft');

      const again = await s.post(`/api/jobs/${jobId}/retry`);
      expect(again.statusCode).toBe(409);
      expect(again.json().error.message).toBe('A succeeded job cannot be retried.');
    });

    it('refuses a retry once every attempt is used', async () => {
      const { jobId } = await queuedExtraction('Retry exhausted', oleFile(), 'locked.pptx');
      await s.runJobs();
      expect((await s.job(jobId)).job).toMatchObject({ status: 'failed', attempt: 1, maxAttempts: 2 });
      expect((await s.post(`/api/jobs/${jobId}/retry`)).statusCode).toBe(200);
      await s.runJobs();
      expect((await s.job(jobId)).job).toMatchObject({ status: 'failed', attempt: 2 });
      const res = await s.post(`/api/jobs/${jobId}/retry`);
      expect(res.statusCode).toBe(409);
      expect(res.json().error.message).toMatch(/already used 2 of 2 attempts/);
      expect((await s.job(jobId)).job.status).toBe('failed');
    });

    it('dismissing a failed job clears the project’s “Needs attention” job', async () => {
      const { projectId, jobId } = await queuedExtraction('Dismiss me', oleFile(), 'locked.pptx');
      await s.runJobs();
      expect((await s.project(projectId)).lastProblemJob?.id).toBe(jobId);
      const res = await s.post(`/api/jobs/${jobId}/dismiss`);
      expect(res.statusCode).toBe(200);
      expect((await s.project(projectId)).lastProblemJob).toBeNull();
    });
  });

  describe('lease expiry recovery', () => {
    it('marks a running job whose worker died as interrupted, never re-runs it silently, and resumes on request', async () => {
      const { projectId, jobId } = await queuedExtraction('Crashed worker');
      // A worker process claims the job and then dies without finishing it.
      const crashed = s.openApp();
      const claimed = claimNextJob(crashed.db, 'crashed-worker', LEASE_MS)!;
      expect(claimed).toMatchObject({ id: jobId, status: 'running', lease_owner: 'crashed-worker', attempt: 1 });

      // While the lease is valid nothing is recovered.
      expect(recoverExpiredLeases(s.app.db)).toEqual([]);
      expect((await s.job(jobId)).job.status).toBe('running');

      // The lease runs out (as if 30 s passed without a heartbeat), then a new worker starts.
      s.app.db.run('UPDATE jobs SET lease_expires_at = ? WHERE id = ?', [Date.now() - 1, jobId]);
      await workerLoop(s.worker, { workerId: 'restarted-worker', signal: AbortSignal.abort() });

      const { job, events } = await s.job(jobId);
      expect(job).toMatchObject({ status: 'interrupted', attempt: 1 });
      expect(job.finishedAt).toBeTruthy();
      expect(events.at(-1)).toMatchObject({ type: 'error' });
      expect(events.at(-1)!.message).toMatch(/^Interrupted: the worker stopped while this job was running.*nothing was retried automatically/);

      // Never silently re-run: the queue is empty and the handler never ran.
      expect(await runOnce(s.worker, 'restarted-worker')).toBe(false);
      expect((await s.job(jobId)).job).toMatchObject({ status: 'interrupted', attempt: 1 });
      expect(await s.slides(projectId)).toEqual([]);

      // The dead worker cannot resurrect or overwrite the job if it comes back.
      expect(heartbeatJob(crashed.db, jobId, 'crashed-worker', LEASE_MS)).toBe(false);
      finishJob(crashed.db, jobId, 'crashed-worker', 'succeeded', { result: { bogus: true } });
      expect((await s.job(jobId)).job).toMatchObject({ status: 'interrupted', result: null });

      const p = await s.project(projectId);
      expect(p.lastProblemJob?.id).toBe(jobId);
      expect(p.statusLabel).toBe('Needs attention');
      expect(p.statusDetail).toMatch(/was interrupted/);
      // The restarted worker announced itself.
      expect((await s.get('/api/health')).json().worker).toMatchObject({ online: true, workerId: 'restarted-worker' });

      // Resume = explicit retry by the creator.
      expect((await s.post(`/api/jobs/${jobId}/retry`)).json().job.status).toBe('queued');
      expect(await s.runJobs()).toBe(1);
      expect((await s.job(jobId)).job).toMatchObject({ status: 'succeeded', attempt: 2 });
      expect(await s.slides(projectId)).toHaveLength(9);
    });

    it('a heartbeat keeps the lease alive; moving the clock past the lease without one triggers recovery', async () => {
      const { jobId } = await queuedExtraction('Sleepy worker');
      const sleepy = s.openApp();
      claimNextJob(sleepy.db, 'sleepy-worker', LEASE_MS);

      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() + LEASE_MS - 1_000);
      expect(heartbeatJob(sleepy.db, jobId, 'sleepy-worker', LEASE_MS)).toBe(true);
      vi.setSystemTime(Date.now() + LEASE_MS - 1_000);
      expect(recoverExpiredLeases(s.app.db)).toEqual([]);

      vi.setSystemTime(Date.now() + 2_000);
      const recovered = recoverExpiredLeases(s.app.db);
      vi.useRealTimers();
      expect(recovered.map((r) => r.id)).toEqual([jobId]);
      expect((await s.job(jobId)).job.status).toBe('interrupted');
      expect(heartbeatJob(sleepy.db, jobId, 'sleepy-worker', LEASE_MS)).toBe(false);
    });
  });

  describe('events', () => {
    let finished: Job;
    let events: JobEvent[];

    beforeAll(async () => {
      const { jobId } = await queuedExtraction('Event log');
      await s.runJobs();
      ({ job: finished, events } = await s.job(jobId));
      expect(finished.status).toBe('succeeded');
    });

    it('persists ordered events that are listable per job and visible from other connections', async () => {
      const seqs = events.map((e) => e.seq);
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
      expect(new Set(seqs).size).toBe(seqs.length);
      expect(events.every((e) => e.jobId === finished.id && typeof e.createdAt === 'string')).toBe(true);
      expect(events[0]).toMatchObject({ type: 'status', message: 'Queued' });
      expect(events.some((e) => e.type === 'stage' && e.stage === 'extract')).toBe(true);
      expect(events.at(-1)).toMatchObject({ type: 'status', message: 'Completed', data: { status: 'succeeded' } });

      // Another process (fresh connection) reads the same persisted log.
      const other = s.openApp();
      expect(eventsSince(other.db, finished.id, 0, 1000)).toEqual(events);
      expect(eventsSince(other.db, finished.id, events[2]!.seq, 1000)).toEqual(events.slice(3));

      const listed = (await s.get(`/api/projects/${finished.projectId}/jobs`)).json().jobs as Job[];
      expect(listed.map((j) => [j.id, j.status])).toContainEqual([finished.id, 'succeeded']);
      expect((await s.get('/api/jobs/job_doesnotexist')).statusCode).toBe(404);
    });

    it('streams the same events over Server-Sent Events and resumes after Last-Event-ID', async () => {
      const res = await s.get(`/api/jobs/${finished.id}/events`, { accept: 'text/event-stream' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/^text\/event-stream/);
      expect(res.headers['cache-control']).toBe('no-store');
      const body = res.body;
      expect(body.startsWith('retry: 2000\n\n')).toBe(true);
      const streamed = [...body.matchAll(/id: (\d+)\nevent: job\ndata: (.*)\n\n/g)].map((m) => JSON.parse(m[2]!) as JobEvent);
      expect(streamed).toEqual(events);
      const end = body.match(/event: end\ndata: (.*)\n\n$/);
      expect(end, body.slice(-300)).not.toBeNull();
      expect(JSON.parse(end![1]!)).toMatchObject({ id: finished.id, status: 'succeeded' });

      const resumed = await s.get(`/api/jobs/${finished.id}/events`, { 'last-event-id': String(events.at(-1)!.seq) });
      expect(resumed.body).not.toContain('event: job');
      expect(resumed.body).toContain('event: end');

      expect((await s.get('/api/jobs/job_doesnotexist/events')).statusCode).toBe(404);
    });
  });
});
