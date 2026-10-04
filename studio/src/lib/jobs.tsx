import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Job, JobEvent } from '@shared/schemas/jobs.ts';
import { invalidateForJob } from './queries.ts';

/**
 * Follows job progress over Server-Sent Events. The browser reconnects with
 * Last-Event-ID automatically; the server replays anything missed. Only real
 * stage events are shown — never synthetic progress percentages.
 */

interface Tracked {
  job: Job;
  events: JobEvent[];
  connected: boolean;
  /** Text streamed by Claude for chat replies (from `text` events). */
  text: string;
}

interface JobsState {
  tracked: Record<string, Tracked>;
  track: (job: Job) => void;
}

const JobsContext = createContext<JobsState | null>(null);

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);

export function JobsProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [tracked, setTracked] = useState<Record<string, Tracked>>({});
  const sources = useRef(new Map<string, EventSource>());

  const track = useCallback(
    (job: Job) => {
      setTracked((prev) => (prev[job.id] ? { ...prev, [job.id]: { ...prev[job.id]!, job } } : { ...prev, [job.id]: { job, events: [], connected: false, text: '' } }));
      if (sources.current.has(job.id)) return;
      const es = new EventSource(`/api/jobs/${job.id}/events`);
      sources.current.set(job.id, es);
      es.onopen = () => setTracked((prev) => (prev[job.id] ? { ...prev, [job.id]: { ...prev[job.id]!, connected: true } } : prev));
      es.onerror = () => setTracked((prev) => (prev[job.id] ? { ...prev, [job.id]: { ...prev[job.id]!, connected: false } } : prev));
      es.addEventListener('job', (e) => {
        const ev = JSON.parse((e as MessageEvent).data) as JobEvent;
        setTracked((prev) => {
          const cur = prev[job.id];
          if (!cur || cur.events.some((x) => x.seq === ev.seq)) return prev;
          const status = (ev.data as { status?: Job['status'] } | null)?.status;
          return {
            ...prev,
            [job.id]: {
              ...cur,
              events: [...cur.events, ev].slice(-400),
              text: ev.type === 'text' ? cur.text + ev.message : cur.text,
              job: { ...cur.job, stage: ev.stage ?? cur.job.stage, status: status ?? (ev.message === 'Started' || ev.message.startsWith('Started (') ? 'running' : cur.job.status) },
            },
          };
        });
      });
      es.addEventListener('end', (e) => {
        const final = JSON.parse((e as MessageEvent).data) as Job;
        es.close();
        sources.current.delete(job.id);
        setTracked((prev) => (prev[job.id] ? { ...prev, [job.id]: { ...prev[job.id]!, job: final, connected: false } } : prev));
        invalidateForJob(qc, final.projectId, final.type);
      });
    },
    [qc],
  );

  useEffect(() => () => {
    for (const es of sources.current.values()) es.close();
    sources.current.clear();
  }, []);

  const value = useMemo(() => ({ tracked, track }), [tracked, track]);
  return <JobsContext.Provider value={value}>{children}</JobsContext.Provider>;
}

export function useJobsContext(): JobsState {
  const ctx = useContext(JobsContext);
  if (!ctx) throw new Error('JobsProvider missing');
  return ctx;
}

/** Track every active job of a project (e.g. after a reload or from another tab). */
export function useTrackActiveJobs(activeJobs: Job[] | undefined): void {
  const { track } = useJobsContext();
  useEffect(() => {
    for (const j of activeJobs ?? []) track(j);
  }, [activeJobs, track]);
}

export function useTrackedJob(jobId: string | null | undefined): Tracked | null {
  const { tracked } = useJobsContext();
  return jobId ? (tracked[jobId] ?? null) : null;
}

export function isTerminal(job: Job | null | undefined): boolean {
  return Boolean(job && TERMINAL.has(job.status));
}

/** Tracked jobs for a project, newest first. */
export function useProjectJobs(projectId: string | null): Tracked[] {
  const { tracked } = useJobsContext();
  return useMemo(
    () =>
      Object.values(tracked)
        .filter((t) => t.job.projectId === projectId)
        .sort((a, b) => b.job.createdAt.localeCompare(a.job.createdAt)),
    [tracked, projectId],
  );
}
