import { useEffect, useState } from 'react';
import { CircleCheck, FileText, FlaskConical, Presentation, Sparkles, Wand2 } from 'lucide-react';
import { useRouter } from '../../../lib/router.tsx';
import { useAnalysis, useCoverage, useHealth, useProject, useSlides, useStartJob, useUpdateProject } from '../../../lib/queries.ts';
import { useJobsContext, useProjectJobs } from '../../../lib/jobs.tsx';
import { errorMessage, newIdempotencyKey } from '../../../lib/api.ts';
import { Workspace } from '../../../components/shell/Workspace.tsx';
import { ClaudePanel } from '../../../components/claude/ClaudePanel.tsx';
import { Button, Tabs } from '../../../components/ui/controls.tsx';
import { Banner, EmptyState, Spinner } from '../../../components/ui/feedback.tsx';
import { useToast } from '../../../components/ui/overlay.tsx';
import { DeckUpload } from '../../../components/source/DeckUpload.tsx';
import { JobActivity } from '../../../components/JobActivity.tsx';
import { SlideList } from './SlideList.tsx';
import { SlideDetail } from './SlideDetail.tsx';
import { LearningMap } from './LearningMap.tsx';
import { CoverageView } from './CoverageView.tsx';

type View = 'slides' | 'map' | 'coverage';

export function SourceArea({ projectId }: { projectId: string }) {
  const { search, navigate } = useRouter();
  const project = useProject(projectId);
  const slides = useSlides(projectId);
  const analysis = useAnalysis(projectId);
  const coverage = useCoverage(projectId, null);
  const health = useHealth();
  const start = useStartJob(projectId);
  const updateProject = useUpdateProject(projectId);
  const { track } = useJobsContext();
  const jobs = useProjectJobs(projectId);
  const toast = useToast();
  const view = (search.get('view') as View) || 'slides';
  const list = slides.data?.slides ?? [];
  const [selected, setSelected] = useState<string | null>(search.get('slide'));
  useEffect(() => {
    const fromUrl = search.get('slide');
    if (fromUrl) setSelected(fromUrl);
  }, [search]);
  useEffect(() => {
    if (!selected && list.length) setSelected(list[0]!.id);
  }, [list, selected]);
  const slide = list.find((s) => s.id === selected) ?? null;
  const analyzeJob = jobs.find((t) => t.job.type === 'analyze');
  const analyzing = Boolean(analyzeJob && (analyzeJob.job.status === 'queued' || analyzeJob.job.status === 'running'));
  const claude = health.data?.claude;
  const canAnalyze = claude?.state === 'configured' || (!claude?.keyPresent && project.data?.isSample);

  const setView = (v: View) => navigate(`/p/${projectId}/source?view=${v}${selected ? `&slide=${selected}` : ''}`, { replace: true });
  const analyze = () =>
    start.mutate(
      { type: 'analyze', key: newIdempotencyKey() },
      {
        onSuccess: (r) => {
          track(r.job);
          setView('map');
        },
        onError: (e) => toast({ tone: 'error', title: 'Analysis did not start', detail: `${errorMessage(e).message} ${errorMessage(e).hint ?? ''}` }),
      },
    );
  const render = () =>
    start.mutate(
      { type: 'render_slides', input: { documentId: project.data?.documents.find((d) => d.kind === 'pptx')?.id ?? '' }, key: newIdempotencyKey() },
      { onSuccess: (r) => track(r.job), onError: (e) => toast({ tone: 'error', title: 'Rendering did not start', detail: errorMessage(e).message }) },
    );

  if (slides.isLoading) {
    return (
      <div className="center-fill">
        <Spinner large label="Loading slides…" />
      </div>
    );
  }

  if (list.length === 0) {
    return (
      <div className="canvas-inner">
        <EmptyState icon={<Presentation size={26} aria-hidden="true" />} title="No slides yet">
          Import a .pptx deck to review its content.
        </EmptyState>
        <div className="narrow">
          <DeckUpload projectId={projectId} kind="pptx" />
        </div>
      </div>
    );
  }

  const left = <SlideList slides={list} selectedId={selected} onSelect={(id) => navigate(`/p/${projectId}/source?view=slides&slide=${id}`, { replace: true })} />;

  const center = (
    <div className="canvas-inner source-canvas">
      <div className="canvas-header">
        <Tabs
          label="Source views"
          value={view}
          onChange={setView}
          tabs={[
            { value: 'slides', label: 'Slide review' },
            { value: 'map', label: 'Learning map' },
            { value: 'coverage', label: 'Coverage' },
          ]}
        />
      </div>
      {analyzeJob && analyzing && <JobActivity job={analyzeJob.job} />}
      {view === 'slides' && slide && <SlideDetail slide={slide} documents={slides.data?.documents ?? []} analysis={analysis.data} />}
      {view === 'map' &&
        (analysis.data ? (
          <LearningMap
            record={analysis.data}
            slides={list}
            projectId={projectId}
            onAnalyze={analyze}
            analyzing={analyzing}
            analyzeMode={claude?.state === 'configured' ? 'live' : !claude?.keyPresent && project.data?.isSample ? 'demo' : 'none'}
          />
        ) : analyzeJob && !analyzing && analyzeJob.job.status !== 'succeeded' ? (
          <JobActivity job={analyzeJob.job} />
        ) : !analyzing ? (
          <EmptyState
            icon={<Sparkles size={24} aria-hidden="true" />}
            title="No learning map yet"
            actions={
              canAnalyze ? (
                <Button variant="primary" icon={project.data?.isSample && !claude?.keyPresent ? <FlaskConical size={16} aria-hidden="true" /> : <Sparkles size={16} aria-hidden="true" />} loading={start.isPending} onClick={analyze}>
                  {project.data?.isSample && !claude?.keyPresent ? 'Run demo analysis' : 'Analyze with Claude'}
                </Button>
              ) : (
                <>
                  <Button onClick={() => navigate('/settings')}>Set up Claude</Button>
                  <Button variant="primary" icon={<Wand2 size={16} aria-hidden="true" />} onClick={() => navigate(`/p/${projectId}/blueprint`)}>
                    Author the blueprint yourself
                  </Button>
                </>
              )
            }
          >
            {canAnalyze ? 'Claude proposes topics, concepts, objectives and activities — each citing slides — for you to verify. You review exactly what is sent before it runs.' : 'Claude is not configured. You can review the slides and build a blueprint by hand.'}
          </EmptyState>
        ) : null)}
      {view === 'coverage' && <CoverageView coverage={coverage.data} projectId={projectId} loading={coverage.isLoading} />}
    </div>
  );

  const right = (
    <ClaudePanel
      projectId={projectId}
      area="source"
      mode="ask"
      scopes={[
        ...(slide ? [{ scope: { kind: 'slide' as const, slideId: slide.id, sceneId: null }, label: `Selected slide: ${slide.slideNumber}` }] : []),
        { scope: { kind: 'project' as const, slideId: null, sceneId: null }, label: 'Whole project' },
      ]}
      examples={['How could this slide become an interaction?', 'Which objective does this slide support?', 'Is anything on this slide ambiguous for learners?']}
      actions={
        <div className="stack">
          {!analysis.data && canAnalyze && (
            <Button variant="primary" block icon={<Sparkles size={16} aria-hidden="true" />} loading={start.isPending || analyzing} onClick={() => navigate(`/p/${projectId}/create/review`)}>
              Review & analyze
            </Button>
          )}
          {health.data?.renderer.state === 'available' && (
            <Button block icon={<FileText size={16} aria-hidden="true" />} onClick={render}>
              Render slide images
            </Button>
          )}
          {project.data && !project.data.contentReviewedAt ? (
            <Button
              block
              icon={<CircleCheck size={16} aria-hidden="true" />}
              loading={updateProject.isPending}
              onClick={() => updateProject.mutate({ contentReviewed: true }, { onSuccess: () => toast({ tone: 'success', title: 'Content marked as reviewed' }) })}
            >
              Mark content reviewed
            </Button>
          ) : (
            <p className="subtle small">
              <CircleCheck size={13} aria-hidden="true" /> Content marked as reviewed.
            </p>
          )}
          {health.data?.renderer.state !== 'available' && <p className="subtle small">Slide rendering is unavailable — {health.data?.renderer.detail}</p>}
        </div>
      }
    />
  );

  return (
    <>
      {project.data?.lastProblemJob && project.data.lastProblemJob.type === 'extract_pptx' && (
        <div className="area-banner">
          <Banner tone="danger" title="The last import failed">
            {project.data.lastProblemJob.error?.message}
          </Banner>
        </div>
      )}
      <Workspace leftLabel="Slides" left={left} center={center} right={right} />
    </>
  );
}
