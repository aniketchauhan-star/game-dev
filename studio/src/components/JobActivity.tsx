import { Ban, CircleAlert, CircleCheck, CircleDot, Info, LoaderCircle, RotateCcw, Sparkles, TriangleAlert, X } from 'lucide-react';
import { JOB_LABELS, type Job, type JobEvent } from '@shared/schemas/jobs.ts';
import { useJobAction } from '../lib/queries.ts';
import { useTrackedJob } from '../lib/jobs.tsx';
import { formatTime, formatTokens } from '../lib/format.ts';
import { Button } from './ui/controls.tsx';
import { DemoBadge } from './ui/feedback.tsx';
import { errorMessage } from '../lib/api.ts';
import { useToast } from './ui/overlay.tsx';

/**
 * Real job progress: status, current stage and the actual event log written by
 * the worker. No percentages or invented timings.
 */

const EVENT_ICON: Record<JobEvent['type'], typeof Info> = {
  status: Info,
  stage: CircleDot,
  info: Info,
  warning: TriangleAlert,
  error: CircleAlert,
  text: Sparkles,
  usage: Info,
  result: CircleCheck,
};

function statusText(job: Job): string {
  switch (job.status) {
    case 'queued':
      return 'Waiting for the worker';
    case 'running':
      return 'Working';
    case 'succeeded':
      return 'Done';
    case 'failed':
      return 'Failed';
    case 'cancelled':
      return 'Cancelled';
    case 'interrupted':
      return 'Interrupted';
  }
}

export function JobActivity({ job: initial, compact, showLog = true }: { job: Job; compact?: boolean; showLog?: boolean }) {
  const tracked = useTrackedJob(initial.id);
  const job = tracked?.job ?? initial;
  const events = (tracked?.events ?? []).filter((e) => e.type !== 'text');
  const lastStageSeq = events.findLast((e) => e.type === 'stage')?.seq ?? null;
  const action = useJobAction(job.projectId);
  const toast = useToast();
  const running = job.status === 'queued' || job.status === 'running';
  const run = (a: 'cancel' | 'retry' | 'dismiss') =>
    action.mutate({ jobId: job.id, action: a }, { onError: (e) => toast({ tone: 'error', title: 'Action failed', detail: errorMessage(e).message }) });
  const tone = job.status === 'failed' || job.status === 'interrupted' ? 'danger' : job.status === 'succeeded' ? 'success' : job.status === 'cancelled' ? 'neutral' : 'active';
  const usage = job.usage;
  return (
    <section className={`job-card tone-${tone}${compact ? ' is-compact' : ''}`} aria-live="polite">
      <header className="job-card-head">
        {running ? <LoaderCircle size={16} className="spin" aria-hidden="true" /> : job.status === 'succeeded' ? <CircleCheck size={16} aria-hidden="true" /> : job.status === 'cancelled' ? <Ban size={16} aria-hidden="true" /> : <CircleAlert size={16} aria-hidden="true" />}
        <strong>{JOB_LABELS[job.type]}</strong>
        <span className="job-status">{statusText(job)}</span>
        {job.mode === 'demo' && <DemoBadge text="Demo" />}
        <span className="spacer" />
        {running && (
          <Button size="sm" variant="ghost" icon={<X size={14} aria-hidden="true" />} loading={action.isPending} onClick={() => run('cancel')}>
            Stop
          </Button>
        )}
      </header>
      {job.stage && running && <p className="job-stage">{events.filter((e) => e.type === 'stage').at(-1)?.message ?? job.stage}</p>}
      {job.error && (
        <p className="job-error">
          {job.error.message}
          {job.status === 'interrupted' ? '' : job.error.retryable ? ' You can retry; completed stages are reused.' : ''}
        </p>
      )}
      {(job.status === 'failed' || job.status === 'interrupted' || job.status === 'cancelled') && (
        <div className="row-wrap">
          {job.attempt < job.maxAttempts && (job.error?.retryable !== false || job.status !== 'failed') && (
            <Button size="sm" icon={<RotateCcw size={14} aria-hidden="true" />} loading={action.isPending} onClick={() => run('retry')}>
              {job.status === 'interrupted' ? 'Resume' : 'Retry'}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => run('dismiss')}>
            Dismiss
          </Button>
        </div>
      )}
      {showLog && events.length > 0 && (
        <ol className="job-log">
          {events.slice(compact ? -4 : -40).map((e) => {
            // Only the stage the worker is in right now spins; earlier stages are plain markers.
            const current = e.type === 'stage' && job.status === 'running' && e.seq === lastStageSeq;
            const Icon = current ? LoaderCircle : EVENT_ICON[e.type];
            return (
              <li key={e.seq} className={`ev-${e.type}`}>
                <Icon size={13} aria-hidden="true" className={current ? 'spin' : undefined} />
                <span className="job-log-msg">{e.message}</span>
                <time className="subtle" dateTime={e.createdAt}>
                  {formatTime(e.createdAt)}
                </time>
              </li>
            );
          })}
        </ol>
      )}
      {usage && usage.calls > 0 && (
        <p className="job-usage subtle small">
          {usage.calls} Claude call{usage.calls === 1 ? '' : 's'} · {formatTokens(usage.inputTokens)} input · {formatTokens(usage.outputTokens)} output tokens{job.model ? ` · ${job.model}` : ''}
        </p>
      )}
    </section>
  );
}
