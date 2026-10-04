import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { GameBrief } from '@shared/schemas/brief.ts';
import type { ProjectDetail } from '@shared/schemas/project.ts';
import { ApiError } from '../../lib/api.ts';
import { qk, saveBrief } from '../../lib/queries.ts';
import { useSaveStatus } from '../../lib/saveStatus.tsx';

/**
 * Local brief draft with debounced autosave. Saves carry the last confirmed
 * revision; a conflict (edited in another window) stops autosave and asks the
 * creator to reload instead of overwriting.
 */
export function useBriefDraft(project: ProjectDetail | undefined) {
  const qc = useQueryClient();
  const { track } = useSaveStatus();
  const [brief, setBrief] = useState<GameBrief | null>(project?.brief ?? null);
  const [conflict, setConflict] = useState(false);
  const revision = useRef(project?.briefRevision ?? 0);
  const timer = useRef<number | null>(null);
  const latest = useRef<GameBrief | null>(brief);
  const dirty = useRef(false);
  const loadedFor = useRef<string | null>(null);

  useEffect(() => {
    if (!project || loadedFor.current === project.id) return;
    loadedFor.current = project.id;
    setBrief(project.brief);
    latest.current = project.brief;
    revision.current = project.briefRevision;
  }, [project]);

  const flush = useCallback(async () => {
    if (!project || !dirty.current || !latest.current || conflict) return;
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = null;
    dirty.current = false;
    const snapshot = latest.current;
    try {
      const r = await track(() => saveBrief(project.id, snapshot, revision.current), () => {
        dirty.current = true;
        void flush();
      });
      revision.current = r.briefRevision;
      qc.setQueryData<ProjectDetail>(qk.project(project.id), (old) => (old ? { ...old, brief: snapshot, briefRevision: r.briefRevision } : old));
      // The server may also have updated the project name from the working title.
      void qc.invalidateQueries({ queryKey: qk.project(project.id) });
      void qc.invalidateQueries({ queryKey: ['projects'] });
      void qc.invalidateQueries({ queryKey: qk.aiPreview(project.id) });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) setConflict(true);
      else dirty.current = true;
    }
  }, [project, conflict, track, qc]);

  const update = useCallback(
    (fn: (b: GameBrief) => GameBrief) => {
      setBrief((prev) => {
        if (!prev) return prev;
        const next = fn(prev);
        latest.current = next;
        dirty.current = true;
        return next;
      });
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => void flush(), 650);
    },
    [flush],
  );

  useEffect(() => () => {
    if (timer.current) window.clearTimeout(timer.current);
  }, []);

  return { brief, update, flush, conflict };
}
