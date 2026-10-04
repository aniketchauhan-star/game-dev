import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { Asset } from '@shared/schemas/assets.ts';
import type { DesignFrame, DesignImport } from '@shared/schemas/design.ts';
import type { GradePlanRecord, GradeProfile, GradeProfileRecord } from '@shared/schemas/grade.ts';
import type { Job } from '@shared/schemas/jobs.ts';
import type { MotionPlanRecord, PlanDecision } from '@shared/schemas/motion.ts';
import type { BranchSummary, GameVersion, Proposal } from '@shared/schemas/records.ts';
import type { ScreenMapRecord, SourceScreenMapping } from '@shared/schemas/screens.ts';
import type { FigmaStatus } from '@shared/schemas/settings.ts';
import { api } from './api.ts';
import { qk } from './queries.ts';

/** Query keys for the design, grade, screen-map and motion records. */
export const qk2 = {
  design: (id: string) => ['design', id] as const,
  frame: (id: string) => ['design-frame', id] as const,
  grade: (id: string, branch: string | null) => ['grade', id, branch] as const,
  gradePlans: (id: string, branch: string | null) => ['grade-plans', id, branch] as const,
  screenMap: (id: string, branch: string | null) => ['screen-map', id, branch] as const,
  motionPlans: (id: string, branch: string | null) => ['motion-plans', id, branch] as const,
  readiness: (id: string) => ['readiness', id] as const,
};

/** Everything that depends on the active grade version. */
export function invalidateBranchScoped(qc: QueryClient, projectId: string): void {
  for (const key of [qk.project(projectId), qk.versions(projectId), qk.blueprints(projectId), qk.chat(projectId), qk.assets(projectId)]) void qc.invalidateQueries({ queryKey: key });
  for (const prefix of ['bundle', 'grade', 'grade-plans', 'screen-map', 'motion-plans', 'readiness', 'coverage']) void qc.invalidateQueries({ queryKey: [prefix, projectId] });
  void qc.invalidateQueries({ queryKey: ['projects'] });
}

// ───────────── grade versions (branches) ─────────────

export function useCreateBranch(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; profile: GradeProfile | null }) => api<{ branch: BranchSummary; branches: BranchSummary[] }>(`/api/projects/${projectId}/branches`, { method: 'POST', body }),
    onSuccess: () => invalidateBranchScoped(qc, projectId),
  });
}

export function useActivateBranch(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (branchId: string) => api<{ branch: BranchSummary }>(`/api/projects/${projectId}/branches/${branchId}/activate`, { method: 'POST', body: {} }),
    onSuccess: () => invalidateBranchScoped(qc, projectId),
  });
}

export function useRenameBranch(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ branchId, name, expectedRevision }: { branchId: string; name: string; expectedRevision: number }) =>
      api<{ branch: BranchSummary }>(`/api/branches/${branchId}`, { method: 'PATCH', body: { name, expectedRevision } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.project(projectId) }),
  });
}

export function useDeleteBranch(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (branchId: string) => api(`/api/projects/${projectId}/branches/${branchId}`, { method: 'DELETE' }),
    onSuccess: () => invalidateBranchScoped(qc, projectId),
  });
}

// ───────────── grade & learning profile ─────────────

export interface GradeBundle {
  branchId: string;
  current: GradeProfileRecord | null;
  history: GradeProfileRecord[];
}

export const useGrade = (projectId: string | null, branchId: string | null = null) =>
  useQuery({
    queryKey: qk2.grade(projectId ?? '', branchId),
    queryFn: () => api<GradeBundle>(`/api/projects/${projectId}/grade${branchId ? `?branchId=${branchId}` : ''}`),
    enabled: Boolean(projectId),
  });

export function useSaveGrade(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { branchId?: string | null; profile: GradeProfile; expectedRevision: number | null }) => api<GradeBundle>(`/api/projects/${projectId}/grade`, { method: 'PUT', body }),
    onSuccess: (r) => {
      qc.setQueryData(qk2.grade(projectId, null), r);
      void qc.invalidateQueries({ queryKey: ['grade', projectId] });
      void qc.invalidateQueries({ queryKey: qk.project(projectId) });
      void qc.invalidateQueries({ queryKey: qk2.readiness(projectId) });
      void qc.invalidateQueries({ queryKey: ['projects'] });
    },
  });
}

export const useGradePlans = (projectId: string | null, branchId: string | null = null) =>
  useQuery({
    queryKey: qk2.gradePlans(projectId ?? '', branchId),
    queryFn: () => api<{ plans: GradePlanRecord[] }>(`/api/projects/${projectId}/grade-plans${branchId ? `?branchId=${branchId}` : ''}`).then((r) => r.plans),
    enabled: Boolean(projectId),
  });

export function useGradePlanAction(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action, decisions }: { id: string; action: 'decisions' | 'apply' | 'reject'; decisions?: Record<string, PlanDecision> }): Promise<{ plan: GradePlanRecord; version?: GameVersion | null; blueprintRevisionId?: string | null }> =>
      action === 'decisions'
        ? api<{ plan: GradePlanRecord }>(`/api/grade-plans/${id}/decisions`, { method: 'PATCH', body: { decisions } })
        : api<{ plan: GradePlanRecord; version?: GameVersion | null; blueprintRevisionId?: string | null }>(`/api/grade-plans/${id}/${action}`, { method: 'POST', body: {} }),
    onSuccess: () => invalidateBranchScoped(qc, projectId),
  });
}

// ───────────── design sources (Figma + exported screens) ─────────────

export const useDesign = (projectId: string | null) =>
  useQuery({
    queryKey: qk2.design(projectId ?? ''),
    queryFn: () => api<{ imports: DesignImport[]; figma: FigmaStatus }>(`/api/projects/${projectId}/design`),
    enabled: Boolean(projectId),
  });

export const useDesignFrames = (projectId: string | null) =>
  useQuery({ queryKey: ['design-frames', projectId ?? ''], queryFn: () => api<{ frames: DesignFrame[] }>(`/api/projects/${projectId}/design-frames`).then((r) => r.frames), enabled: Boolean(projectId) });

export const useDesignFrame = (frameId: string | null) =>
  useQuery({ queryKey: qk2.frame(frameId ?? ''), queryFn: () => api<{ frame: DesignFrame }>(`/api/design-frames/${frameId}`).then((r) => r.frame), enabled: Boolean(frameId), staleTime: Infinity });

export function useDesignActions(projectId: string) {
  const qc = useQueryClient();
  const done = () => {
    void qc.invalidateQueries({ queryKey: qk2.design(projectId) });
    void qc.invalidateQueries({ queryKey: ['design-frames', projectId] });
    void qc.invalidateQueries({ queryKey: qk.project(projectId) });
    void qc.invalidateQueries({ queryKey: qk.jobs(projectId) });
    void qc.invalidateQueries({ queryKey: qk.assets(projectId) });
    void qc.invalidateQueries({ queryKey: ['screen-map', projectId] });
  };
  const paste = useMutation({ mutationFn: (link: string) => api<{ import: DesignImport; job: Job }>(`/api/projects/${projectId}/design/figma`, { method: 'POST', body: { link } }), onSuccess: done });
  const importFrames = useMutation({ mutationFn: ({ importId, nodeIds }: { importId: string; nodeIds: string[] }) => api<{ job: Job }>(`/api/design-imports/${importId}/import`, { method: 'POST', body: { nodeIds } }), onSuccess: done });
  const refresh = useMutation({ mutationFn: (importId: string) => api<{ import: DesignImport; job: Job }>(`/api/design-imports/${importId}/refresh`, { method: 'POST', body: {} }), onSuccess: done });
  const decide = useMutation({ mutationFn: ({ importId, action }: { importId: string; action: 'approve' | 'reject' }) => api<{ import: DesignImport }>(`/api/design-imports/${importId}/${action}`, { method: 'POST', body: {} }), onSuccess: done });
  const remove = useMutation({ mutationFn: (importId: string) => api(`/api/design-imports/${importId}`, { method: 'DELETE' }), onSuccess: done });
  return { paste, importFrames, refresh, decide, remove };
}

export function useComposeSprite(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { assetIds: string[]; name: string; fps: number }) => api<{ asset: Asset }>(`/api/projects/${projectId}/assets/compose-sprite`, { method: 'POST', body }).then((r) => r.asset),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.assets(projectId) }),
  });
}

// ───────────── Source-to-Screen map ─────────────

export interface ScreenMapBundle {
  branchId: string;
  current: ScreenMapRecord | null;
  /** Rows suggested from the blueprint and sources (unreviewed) when no map was saved yet. */
  suggestion: SourceScreenMapping | null;
  suggestionNote: string | null;
  history: Array<Omit<ScreenMapRecord, 'mapping'> & { screens: number; reviewed: number }>;
  blueprintRevisionId: string | null;
  check: { errors: string[]; warnings: string[] } | null;
}

export const useScreenMap = (projectId: string | null) =>
  useQuery({ queryKey: qk2.screenMap(projectId ?? '', null), queryFn: () => api<ScreenMapBundle>(`/api/projects/${projectId}/screen-map`), enabled: Boolean(projectId) });

export function useSaveScreenMap(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { mapping: SourceScreenMapping; expectedNumber: number; note: string; applyToVersion: boolean }) =>
      api<{ map: ScreenMapRecord; version: GameVersion | null; proposal: Proposal | null; skipped: string[] }>(`/api/projects/${projectId}/screen-map`, { method: 'PUT', body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['screen-map', projectId] });
      void qc.invalidateQueries({ queryKey: qk2.readiness(projectId) });
      void qc.invalidateQueries({ queryKey: qk.versions(projectId) });
      void qc.invalidateQueries({ queryKey: ['bundle', projectId] });
      void qc.invalidateQueries({ queryKey: qk.project(projectId) });
      void qc.invalidateQueries({ queryKey: qk.assets(projectId) });
    },
  });
}

// ───────────── motion plans ─────────────

export const useMotionPlans = (projectId: string | null) =>
  useQuery({ queryKey: qk2.motionPlans(projectId ?? '', null), queryFn: () => api<{ plans: MotionPlanRecord[] }>(`/api/projects/${projectId}/motion-plans`).then((r) => r.plans), enabled: Boolean(projectId) });

export function useMotionPlanAction(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action, decisions }: { id: string; action: 'decisions' | 'apply' | 'reject'; decisions?: Record<string, PlanDecision> }): Promise<{ plan: MotionPlanRecord; version?: GameVersion; proposal?: Proposal }> =>
      action === 'decisions'
        ? api<{ plan: MotionPlanRecord }>(`/api/motion-plans/${id}/decisions`, { method: 'PATCH', body: { decisions } })
        : api<{ plan: MotionPlanRecord; version?: GameVersion; proposal?: Proposal }>(`/api/motion-plans/${id}/${action}`, { method: 'POST', body: {} }),
    onSuccess: () => invalidateBranchScoped(qc, projectId),
  });
}

// ───────────── prepare, readiness, plans ─────────────

export interface ReadinessCheck {
  id: 'source' | 'grade' | 'screens' | 'assets' | 'mechanics' | 'motion' | 'export';
  label: string;
  status: 'pass' | 'warn' | 'fail' | 'todo';
  detail: string;
  area: 'source' | 'prepare' | 'screens' | 'assets' | 'blueprint' | 'animate' | 'export';
}

export interface Readiness {
  branchId: string;
  checks: ReadinessCheck[];
  canBuild: boolean;
  buildBlockers: string[];
  blueprint: { id: string; number: number; status: string } | null;
  gradePlanId: string | null;
  motionPlanId: string | null;
}

export const useReadiness = (projectId: string | null) =>
  useQuery({ queryKey: qk2.readiness(projectId ?? ''), queryFn: () => api<Readiness>(`/api/projects/${projectId}/readiness`), enabled: Boolean(projectId) });

export function useStartPrepare(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ job: Job; mode: 'live' | 'demo' | 'local' }>(`/api/projects/${projectId}/prepare`, { method: 'POST', body: {} }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.project(projectId) });
      void qc.invalidateQueries({ queryKey: qk.jobs(projectId) });
    },
  });
}

export function useApproveBuild(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { includeGradePlan: boolean; includeMotionPlan: boolean }) => api<{ job: Job; blueprintRevisionId: string }>(`/api/projects/${projectId}/approve-build`, { method: 'POST', body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.project(projectId) });
      void qc.invalidateQueries({ queryKey: qk.jobs(projectId) });
      void qc.invalidateQueries({ queryKey: qk.blueprints(projectId) });
    },
  });
}

export function useStartGradePlan(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { mode: 'presentation' | 'challenge'; engine: 'auto' | 'rules' | 'claude' }) => api<{ job: Job; mode: string }>(`/api/projects/${projectId}/grade-plans`, { method: 'POST', body }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.project(projectId) }),
  });
}

export function useStartMotionSuggest(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { scope: { kind: 'project' | 'screen'; screenId: string | null }; request: string; engine: 'auto' | 'rules' | 'claude'; baseVersionId?: string | null }) =>
      api<{ job: Job; mode: string }>(`/api/projects/${projectId}/motion-plans`, { method: 'POST', body }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.project(projectId) }),
  });
}

export function useAddSampleFiles(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (kind: 'lesson' | 'screens' | 'artwork') => api<{ jobId: string | null; added: number }>(`/api/projects/${projectId}/sample-files`, { method: 'POST', body: { kind } }),
    onSuccess: () => {
      for (const key of [qk.project(projectId), qk.assets(projectId), qk.slides(projectId), qk2.design(projectId), qk.jobs(projectId)]) void qc.invalidateQueries({ queryKey: key });
    },
  });
}
