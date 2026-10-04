import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { LearningAnalysis } from '@shared/schemas/analysis.ts';
import type { Asset, AssetLibraryRole, AssetMetadata } from '@shared/schemas/assets.ts';
import type { Blueprint, BlueprintRevision } from '@shared/schemas/blueprint.ts';
import type { GameBrief } from '@shared/schemas/brief.ts';
import type { ExportKind, ExportRecord, Preflight } from '@shared/schemas/exports.ts';
import type { GameConfig } from '@shared/schemas/game.ts';
import type { Job, JobEvent, JobType } from '@shared/schemas/jobs.ts';
import type { CreateStep, ProjectDetail, ProjectSummary } from '@shared/schemas/project.ts';
import type { ChangeOp, ChangeScope } from '@shared/schemas/proposal.ts';
import type { AnalysisRecord, ChatMessage, ChatScope, Coverage, GameVersion, GameVersionSummary, Proposal } from '@shared/schemas/records.ts';
import type { ClaudeStatus, FigmaStatus, Health, RendererStatus } from '@shared/schemas/settings.ts';
import type { SlideChange, SourceDocument, SourceSlide, VisualRef, ReviewStatus } from '@shared/schemas/source.ts';
import type { InteractionIssue } from '@shared/attainability.ts';
import type { BlueprintIssue } from '@shared/schemas/blueprint.ts';
import { api, newIdempotencyKey } from './api.ts';

export interface BlueprintIssues {
  structural: BlueprintIssue[];
  scenes: Array<{ sceneId: string; buildable: boolean; issues: InteractionIssue[] }>;
}

export const qk = {
  health: ['health'] as const,
  projects: (search: string) => ['projects', search] as const,
  project: (id: string) => ['project', id] as const,
  slides: (id: string) => ['slides', id] as const,
  slideHistory: (id: string) => ['slide-history', id] as const,
  analysis: (id: string) => ['analysis', id] as const,
  blueprints: (id: string) => ['blueprints', id] as const,
  blueprint: (rev: string) => ['blueprint', rev] as const,
  coverage: (id: string, rev: string | null) => ['coverage', id, rev] as const,
  versions: (id: string) => ['versions', id] as const,
  version: (id: string) => ['version', id] as const,
  bundle: (id: string, version: string | null) => ['bundle', id, version] as const,
  chat: (id: string) => ['chat', id] as const,
  assets: (id: string) => ['assets', id] as const,
  exports: (id: string) => ['exports', id] as const,
  jobs: (id: string) => ['jobs', id] as const,
  aiPreview: (id: string) => ['ai-preview', id] as const,
  usage: ['usage'] as const,
  models: ['models'] as const,
};

/** Invalidate everything a finished job of `type` may have changed. */
export function invalidateForJob(qc: QueryClient, projectId: string, type: JobType): void {
  void qc.invalidateQueries({ queryKey: qk.project(projectId) });
  void qc.invalidateQueries({ queryKey: ['projects'] });
  void qc.invalidateQueries({ queryKey: qk.jobs(projectId) });
  if (type === 'extract_pptx' || type === 'extract_pdf' || type === 'render_slides') {
    void qc.invalidateQueries({ queryKey: qk.slides(projectId) });
    void qc.invalidateQueries({ queryKey: qk.assets(projectId) });
    void qc.invalidateQueries({ queryKey: qk.aiPreview(projectId) });
  }
  if (type === 'analyze') void qc.invalidateQueries({ queryKey: qk.analysis(projectId) });
  if (type === 'blueprint' || type === 'regenerate_scene') {
    void qc.invalidateQueries({ queryKey: qk.blueprints(projectId) });
    void qc.invalidateQueries({ queryKey: ['coverage', projectId] });
  }
  if (type === 'build') {
    void qc.invalidateQueries({ queryKey: qk.versions(projectId) });
    void qc.invalidateQueries({ queryKey: ['bundle', projectId] });
    void qc.invalidateQueries({ queryKey: qk.assets(projectId) });
    // Approve & build resolves the staged grade and motion plans.
    void qc.invalidateQueries({ queryKey: ['grade-plans', projectId] });
    void qc.invalidateQueries({ queryKey: ['motion-plans', projectId] });
    void qc.invalidateQueries({ queryKey: ['screen-map', projectId] });
  }
  if (type === 'refine' || type === 'ask') void qc.invalidateQueries({ queryKey: qk.chat(projectId) });
  if (type === 'figma_browse' || type === 'figma_import') {
    void qc.invalidateQueries({ queryKey: ['design', projectId] });
    void qc.invalidateQueries({ queryKey: ['design-frames', projectId] });
    void qc.invalidateQueries({ queryKey: qk.assets(projectId) });
    void qc.invalidateQueries({ queryKey: ['screen-map', projectId] });
  }
  if (type === 'grade_plan' || type === 'prepare') void qc.invalidateQueries({ queryKey: ['grade-plans', projectId] });
  if (type === 'motion_suggest' || type === 'prepare') {
    void qc.invalidateQueries({ queryKey: ['motion-plans', projectId] });
    void qc.invalidateQueries({ queryKey: qk.chat(projectId) });
  }
  if (type === 'prepare') {
    void qc.invalidateQueries({ queryKey: qk.analysis(projectId) });
    void qc.invalidateQueries({ queryKey: qk.blueprints(projectId) });
    void qc.invalidateQueries({ queryKey: ['screen-map', projectId] });
  }
  if (type === 'build' || type === 'prepare' || type === 'grade_plan' || type === 'motion_suggest') void qc.invalidateQueries({ queryKey: ['readiness', projectId] });
}

// ───────────── reads ─────────────

export const useHealth = () => useQuery({ queryKey: qk.health, queryFn: () => api<Health>('/api/health'), refetchInterval: 15_000 });

export const useProjects = (search: string) =>
  useQuery({ queryKey: qk.projects(search), queryFn: () => api<{ projects: ProjectSummary[] }>(`/api/projects?search=${encodeURIComponent(search)}`).then((r) => r.projects) });

export const useProject = (id: string | null) =>
  useQuery({ queryKey: qk.project(id ?? ''), queryFn: () => api<{ project: ProjectDetail }>(`/api/projects/${id}`).then((r) => r.project), enabled: Boolean(id) });

export const useSlides = (id: string | null) =>
  useQuery({
    queryKey: qk.slides(id ?? ''),
    queryFn: () => api<{ slides: SourceSlide[]; documents: SourceDocument[] }>(`/api/projects/${id}/slides`),
    enabled: Boolean(id),
  });

export const useSlideHistory = (slideId: string | null) =>
  useQuery({ queryKey: qk.slideHistory(slideId ?? ''), queryFn: () => api<{ changes: SlideChange[] }>(`/api/slides/${slideId}/history`).then((r) => r.changes), enabled: Boolean(slideId) });

export const useAnalysis = (id: string | null) =>
  useQuery({ queryKey: qk.analysis(id ?? ''), queryFn: () => api<{ analysis: AnalysisRecord | null }>(`/api/projects/${id}/analysis`).then((r) => r.analysis), enabled: Boolean(id) });

export const useBlueprints = (id: string | null) =>
  useQuery({ queryKey: qk.blueprints(id ?? ''), queryFn: () => api<{ revisions: BlueprintRevision[] }>(`/api/projects/${id}/blueprints`).then((r) => r.revisions), enabled: Boolean(id) });

export const useBlueprint = (rev: string | null) =>
  useQuery({ queryKey: qk.blueprint(rev ?? ''), queryFn: () => api<{ revision: BlueprintRevision; issues: BlueprintIssues }>(`/api/blueprints/${rev}`), enabled: Boolean(rev) });

export const useCoverage = (id: string | null, rev: string | null) =>
  useQuery({
    queryKey: qk.coverage(id ?? '', rev),
    queryFn: () => api<{ coverage: Coverage }>(`/api/projects/${id}/coverage${rev ? `?blueprintId=${rev}` : ''}`).then((r) => r.coverage),
    enabled: Boolean(id),
  });

export const useVersions = (id: string | null) =>
  useQuery({ queryKey: qk.versions(id ?? ''), queryFn: () => api<{ versions: GameVersionSummary[]; currentVersionId: string | null }>(`/api/projects/${id}/versions`), enabled: Boolean(id) });

export const useVersion = (versionId: string | null) =>
  useQuery({ queryKey: qk.version(versionId ?? ''), queryFn: () => api<{ version: GameVersion }>(`/api/versions/${versionId}`).then((r) => r.version), enabled: Boolean(versionId) });

export interface PreviewBundle {
  version: { id: string; number: number; demo: boolean; origin: string; summary: string };
  config: GameConfig;
  assets: Array<{ id: string; mime: string; url: string; available: boolean }>;
}

export const usePreviewBundle = (id: string | null, versionId: string | null, enabled = true) =>
  useQuery({
    queryKey: qk.bundle(id ?? '', versionId),
    queryFn: () => api<PreviewBundle>(`/api/projects/${id}/preview-bundle${versionId ? `?versionId=${versionId}` : ''}`),
    enabled: Boolean(id) && enabled,
    retry: false,
  });

export const useChat = (id: string | null) =>
  useQuery({ queryKey: qk.chat(id ?? ''), queryFn: () => api<{ messages: ChatMessage[]; proposals: Proposal[] }>(`/api/projects/${id}/chat`), enabled: Boolean(id) });

export const useAssets = (id: string | null) =>
  useQuery({ queryKey: qk.assets(id ?? ''), queryFn: () => api<{ assets: Asset[] }>(`/api/projects/${id}/assets`).then((r) => r.assets), enabled: Boolean(id) });

export const useExports = (id: string | null) =>
  useQuery({ queryKey: qk.exports(id ?? ''), queryFn: () => api<{ exports: ExportRecord[] }>(`/api/projects/${id}/exports`).then((r) => r.exports), enabled: Boolean(id) });

export const useJobs = (id: string | null) =>
  useQuery({ queryKey: qk.jobs(id ?? ''), queryFn: () => api<{ jobs: Job[] }>(`/api/projects/${id}/jobs`).then((r) => r.jobs), enabled: Boolean(id) });

export interface AiPreview {
  claude: ClaudeStatus;
  includeSpeakerNotes: boolean;
  slides: Array<{ slideId: string; slideNumber: number; title: string; included: boolean; hidden: boolean; characters: number; notesIncluded: boolean }>;
  totalCharacters: number;
  visuals: Array<{ slideId: string; slideNumber: number; kind: string | null; mapping: string | null; willSend: boolean }>;
  sample: string | null;
  tokenCount: number | null;
  tokenNote: string | null;
  gaps: string[];
}

export const useAiPreview = (id: string | null, countTokens: boolean) =>
  useQuery({
    queryKey: [...qk.aiPreview(id ?? ''), countTokens],
    queryFn: () => api<AiPreview>(`/api/projects/${id}/ai-preview${countTokens ? '?countTokens=1' : ''}`),
    enabled: Boolean(id),
  });

export interface UsageRow {
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
  estimatedUsd: number | null;
}

export const useUsage = () => useQuery({ queryKey: qk.usage, queryFn: () => api<{ rows: UsageRow[]; pricing: { asOf: string; source: string } | null }>('/api/usage') });

export const useModels = (enabled: boolean) =>
  useQuery({ queryKey: qk.models, queryFn: () => api<{ models: Array<{ id: string; displayName: string; createdAt: string }> }>('/api/settings/claude/models').then((r) => r.models), enabled, retry: false });

// ───────────── writes ─────────────

export function useCreateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api<{ project: ProjectDetail }>('/api/projects', { method: 'POST', body: { name } }).then((r) => r.project),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['projects'] }),
  });
}

export function useCreateSample() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (which: 'air-traffic' | 'trapezium' = 'air-traffic') => api<{ project: ProjectDetail }>('/api/projects/sample', { method: 'POST', body: { which } }).then((r) => r.project),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['projects'] }),
  });
}

export function useUpdateProject(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: { name?: string; createStep?: CreateStep; contentReviewed?: boolean }) =>
      api<{ project: ProjectDetail }>(`/api/projects/${id}`, { method: 'PATCH', body: patch }).then((r) => r.project),
    onSuccess: (p) => {
      qc.setQueryData(qk.project(id), p);
      void qc.invalidateQueries({ queryKey: ['projects'] });
    },
  });
}

export function useRenameProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => api<{ project: ProjectDetail }>(`/api/projects/${id}`, { method: 'PATCH', body: { name } }).then((r) => r.project),
    onSuccess: (p) => {
      qc.setQueryData(qk.project(p.id), p);
      void qc.invalidateQueries({ queryKey: ['projects'] });
    },
  });
}

export function useDuplicateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<{ project: ProjectDetail }>(`/api/projects/${id}/duplicate`, { method: 'POST', body: {} }).then((r) => r.project),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['projects'] }),
  });
}

export function useDeleteProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, confirmName }: { id: string; confirmName: string }) => api(`/api/projects/${id}`, { method: 'DELETE', body: { confirmName } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['projects'] }),
  });
}

export function saveBrief(id: string, brief: GameBrief, revision: number) {
  return api<{ briefRevision: number; gaps: string[]; savedAt: string }>(`/api/projects/${id}/brief`, { method: 'PUT', body: { brief, revision } });
}

export interface SlidePatch {
  included?: boolean;
  title?: string | null;
  blocks?: Record<string, string[] | null>;
  notes?: string[] | null;
  lockedWording?: boolean;
  requiredExample?: boolean;
  reviewStatus?: ReviewStatus;
  visualRef?: VisualRef | null;
}

export function useUpdateSlide(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ slideId, patch, revision }: { slideId: string; patch: SlidePatch; revision: number | null }) =>
      api<{ slide: SourceSlide; sourceChanged: boolean }>(`/api/slides/${slideId}`, { method: 'PATCH', body: { patch, revision } }),
    onSuccess: (r) => {
      qc.setQueryData<{ slides: SourceSlide[]; documents: SourceDocument[] }>(qk.slides(projectId), (old) =>
        old ? { ...old, slides: old.slides.map((s) => (s.id === r.slide.id ? r.slide : s)) } : old,
      );
      void qc.invalidateQueries({ queryKey: qk.slideHistory(r.slide.id) });
      if (r.sourceChanged) {
        void qc.invalidateQueries({ queryKey: qk.analysis(projectId) });
        void qc.invalidateQueries({ queryKey: qk.blueprints(projectId) });
        void qc.invalidateQueries({ queryKey: ['blueprint'] });
        void qc.invalidateQueries({ queryKey: qk.project(projectId) });
        void qc.invalidateQueries({ queryKey: qk.aiPreview(projectId) });
        void qc.invalidateQueries({ queryKey: ['coverage', projectId] });
      }
    },
  });
}

export function useBulkSlides(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { slideIds: string[]; included?: boolean; reviewStatus?: ReviewStatus }) =>
      api<{ slides: SourceSlide[] }>(`/api/projects/${projectId}/slides/bulk`, { method: 'POST', body }),
    onSuccess: () => {
      for (const key of [qk.slides(projectId), qk.analysis(projectId), qk.blueprints(projectId), qk.project(projectId), qk.aiPreview(projectId)]) void qc.invalidateQueries({ queryKey: key });
      void qc.invalidateQueries({ queryKey: ['coverage', projectId] });
    },
  });
}

export function useRevertSlideChange(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (changeId: string) => api<{ slide: SourceSlide }>(`/api/slide-changes/${changeId}/revert`, { method: 'POST', body: {} }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: qk.slides(projectId) });
      void qc.invalidateQueries({ queryKey: qk.slideHistory(r.slide.id) });
      void qc.invalidateQueries({ queryKey: qk.project(projectId) });
    },
  });
}

export function useSaveAnalysis(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, analysis, revision }: { id: string; analysis: LearningAnalysis; revision: number }) =>
      api<{ analysis: AnalysisRecord }>(`/api/analyses/${id}`, { method: 'PUT', body: { analysis, revision } }).then((r) => r.analysis),
    onSuccess: (a) => qc.setQueryData(qk.analysis(projectId), a),
  });
}

export function useStartJob(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ type, input, key }: { type: JobType; input?: Record<string, unknown>; key?: string }) =>
      api<{ job: Job; deduplicated: boolean }>(`/api/projects/${projectId}/jobs`, { method: 'POST', body: { type, input: input ?? {} }, idempotencyKey: key ?? newIdempotencyKey() }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.project(projectId) });
      void qc.invalidateQueries({ queryKey: qk.jobs(projectId) });
    },
  });
}

export function useJobAction(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ jobId, action }: { jobId: string; action: 'cancel' | 'retry' | 'dismiss' }) => api<{ job: Job }>(`/api/jobs/${jobId}/${action}`, { method: 'POST', body: {} }).then((r) => r.job),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.project(projectId) });
      void qc.invalidateQueries({ queryKey: qk.jobs(projectId) });
      void qc.invalidateQueries({ queryKey: ['projects'] });
    },
  });
}

export function useSaveBlueprint(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, blueprint, revision, acknowledgeSourceChanges }: { id: string; blueprint: Blueprint; revision: number; acknowledgeSourceChanges?: boolean }) =>
      api<{ revision: BlueprintRevision; issues: BlueprintIssues }>(`/api/blueprints/${id}`, { method: 'PUT', body: { blueprint, revision, acknowledgeSourceChanges } }),
    onSuccess: (r) => {
      qc.setQueryData(qk.blueprint(r.revision.id), r);
      void qc.invalidateQueries({ queryKey: qk.blueprints(projectId) });
      void qc.invalidateQueries({ queryKey: ['coverage', projectId] });
    },
  });
}

export function useBlueprintAction(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action, revision }: { id: string; action: 'approve' | 'draft'; revision?: number }) =>
      api<{ revision: BlueprintRevision; issues: BlueprintIssues }>(`/api/blueprints/${id}/${action}`, { method: 'POST', body: action === 'approve' ? { revision } : {} }),
    onSuccess: (r) => {
      qc.setQueryData(qk.blueprint(r.revision.id), r);
      void qc.invalidateQueries({ queryKey: qk.blueprints(projectId) });
      void qc.invalidateQueries({ queryKey: qk.project(projectId) });
      void qc.invalidateQueries({ queryKey: ['projects'] });
    },
  });
}

export function useManualBlueprint(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ revision: BlueprintRevision; issues: BlueprintIssues }>(`/api/projects/${projectId}/blueprints/manual`, { method: 'POST', body: {} }),
    onSuccess: (r) => {
      qc.setQueryData(qk.blueprint(r.revision.id), r);
      void qc.invalidateQueries({ queryKey: qk.blueprints(projectId) });
      void qc.invalidateQueries({ queryKey: qk.project(projectId) });
    },
  });
}

function versionInvalidation(qc: QueryClient, projectId: string) {
  void qc.invalidateQueries({ queryKey: qk.versions(projectId) });
  void qc.invalidateQueries({ queryKey: ['bundle', projectId] });
  void qc.invalidateQueries({ queryKey: qk.project(projectId) });
  void qc.invalidateQueries({ queryKey: qk.chat(projectId) });
  void qc.invalidateQueries({ queryKey: qk.assets(projectId) });
  void qc.invalidateQueries({ queryKey: ['projects'] });
}

export function useManualEdit(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { baseVersionId: string; ops: ChangeOp[]; scope: ChangeScope; summary: string }) =>
      api<{ proposal: Proposal; version: GameVersion }>(`/api/projects/${projectId}/edits`, { method: 'POST', body }),
    onSuccess: () => versionInvalidation(qc, projectId),
  });
}

export function useProposalAction(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'apply' | 'reject' | 'undo' }) => api<{ proposal: Proposal; version?: GameVersion }>(`/api/proposals/${id}/${action}`, { method: 'POST', body: {} }),
    onSettled: () => versionInvalidation(qc, projectId),
  });
}

export function useRestoreVersion(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (versionId: string) => api<{ version: GameVersion }>(`/api/versions/${versionId}/restore`, { method: 'POST', body: {} }).then((r) => r.version),
    onSuccess: () => versionInvalidation(qc, projectId),
  });
}

export function useSendChat(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { text: string; mode: 'refine' | 'ask'; scope: ChatScope; area: ChatMessage['area']; baseVersionId?: string | null }) =>
      api<{ message: ChatMessage | null; job: Job; deduplicated: boolean }>(`/api/projects/${projectId}/chat`, { method: 'POST', body, idempotencyKey: newIdempotencyKey() }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.chat(projectId) });
      void qc.invalidateQueries({ queryKey: qk.project(projectId) });
    },
  });
}

export function useUpdateAsset(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: { role?: AssetLibraryRole; name?: string; metadata?: Partial<AssetMetadata> } }) =>
      api<{ asset: Asset }>(`/api/assets/${id}`, { method: 'PATCH', body: patch }).then((r) => r.asset),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.assets(projectId) }),
  });
}

export function useDeleteAsset(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api(`/api/assets/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.assets(projectId) }),
  });
}

export function usePreflight(projectId: string) {
  return useMutation({
    mutationFn: (body: { kind: ExportKind; versionId: string | null; includeSourceMaterial: boolean; nextChanges: string }) =>
      api<{ preflight: Preflight; files: string[] }>(`/api/projects/${projectId}/exports/preflight`, { method: 'POST', body }),
  });
}

export function useCreateExport(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { kind: ExportKind; versionId: string | null; includeSourceMaterial: boolean; nextChanges: string }) =>
      api<{ export: ExportRecord }>(`/api/projects/${projectId}/exports`, { method: 'POST', body }).then((r) => r.export),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.exports(projectId) }),
  });
}

export function useClaudeSettings() {
  const qc = useQueryClient();
  const test = useMutation({
    mutationFn: (testRequest: boolean) => api<{ claude: ClaudeStatus }>('/api/settings/claude/test', { method: 'POST', body: { testRequest } }).then((r) => r.claude),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.health }),
  });
  const chooseModel = useMutation({
    mutationFn: (model: string) => api<{ claude: ClaudeStatus }>('/api/settings/claude/model', { method: 'POST', body: { model } }).then((r) => r.claude),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.health }),
  });
  const checkRenderer = useMutation({
    mutationFn: () => api<{ renderer: RendererStatus }>('/api/settings/renderer/check', { method: 'POST', body: {} }).then((r) => r.renderer),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.health }),
  });
  const testFigma = useMutation({
    mutationFn: () => api<{ figma: FigmaStatus }>('/api/settings/figma/test', { method: 'POST', body: {} }).then((r) => r.figma),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.health }),
  });
  return { test, chooseModel, checkRenderer, testFigma };
}

export type { JobEvent };
