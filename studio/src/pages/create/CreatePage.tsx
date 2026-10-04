import { useEffect, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, Check } from 'lucide-react';
import { briefGaps } from '@shared/schemas/brief.ts';
import { gradeLabel } from '@shared/schemas/grade.ts';
import type { CreateStep } from '@shared/schemas/project.ts';
import { useRouter } from '../../lib/router.tsx';
import { useProject, useSlides, useUpdateProject } from '../../lib/queries.ts';
import { Button } from '../../components/ui/controls.tsx';
import { Banner, Spinner } from '../../components/ui/feedback.tsx';
import { useBriefDraft } from './useBriefDraft.ts';
import { useSourceSummary } from '../../components/setup/SetupCards.tsx';
import { SourceStep } from './SourceStep.tsx';
import { BriefStep } from './BriefStep.tsx';
import { VisualStep } from './VisualStep.tsx';
import { ReviewStep } from './ReviewStep.tsx';

const STEPS: Array<{ id: CreateStep; label: string; hint: string }> = [
  { id: 'source', label: 'Sources & grade', hint: 'Lesson, design, art, grade' },
  { id: 'brief', label: 'Game brief', hint: 'What learners do' },
  { id: 'visual', label: 'Visual direction', hint: 'Theme & assets' },
  { id: 'review', label: 'Review', hint: 'Check & analyze' },
];

export function CreatePage({ projectId, step }: { projectId: string; step: CreateStep }) {
  const { navigate } = useRouter();
  const project = useProject(projectId);
  const slides = useSlides(projectId);
  const updateProject = useUpdateProject(projectId);
  const draft = useBriefDraft(project.data);
  const index = STEPS.findIndex((s) => s.id === step);
  const summary = useSourceSummary(project.data);
  // Any useful combination of sources counts; with none, the brief step asks for objectives instead.
  const hasSlides = (slides.data?.slides.length ?? 0) > 0 || summary.frameCount > 0 || summary.assetCount > 0 || summary.grade !== null;
  const gaps = draft.brief ? briefGaps(draft.brief) : [];

  // Remember progress so the creator returns to the right step.
  useEffect(() => {
    if (project.data && project.data.createStep !== step && STEPS.findIndex((s) => s.id === project.data!.createStep) < index) {
      updateProject.mutate({ createStep: step });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, project.data?.id]);

  // The brief's grade follows the grade profile until the creator writes their own.
  useEffect(() => {
    if (summary.grade && draft.brief && !draft.brief.gradeOrAge.trim()) {
      const label = gradeLabel(summary.grade);
      draft.update((b) => ({ ...b, gradeOrAge: label }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summary.grade, draft.brief === null]);

  const go = async (to: CreateStep) => {
    await draft.flush();
    navigate(`/p/${projectId}/create/${to}`);
  };

  if (project.isLoading || !draft.brief) {
    return (
      <div className="center-fill">
        <Spinner large label="Loading project…" />
      </div>
    );
  }
  if (project.isError || !project.data) {
    return (
      <div className="canvas-inner">
        <Banner tone="danger" title="This project could not be loaded.">
          It may have been deleted. Return to Projects to continue.
        </Banner>
      </div>
    );
  }

  const canContinue: Record<CreateStep, boolean> = { source: hasSlides, brief: true, visual: true, review: true };
  let body: ReactNode = null;
  if (step === 'source') body = <SourceStep project={project.data} />;
  if (step === 'brief') body = <BriefStep brief={draft.brief} update={draft.update} gaps={gaps} />;
  if (step === 'visual') body = <VisualStep project={project.data} brief={draft.brief} update={draft.update} />;
  if (step === 'review') body = <ReviewStep project={project.data} brief={draft.brief} update={draft.update} flush={draft.flush} gaps={gaps} goTo={go} />;

  return (
    <div className="create-page">
      <nav className="stepper" aria-label="Create game steps">
        <ol>
          {STEPS.map((s, i) => {
            const state = i < index ? 'done' : i === index ? 'current' : 'todo';
            const reachable = i <= index || (i === index + 1 && canContinue[step]) || (hasSlides && i <= 3);
            return (
              <li key={s.id} className={`step is-${state}`}>
                <button type="button" disabled={!reachable} aria-current={state === 'current' ? 'step' : undefined} onClick={() => void go(s.id)}>
                  <span className="step-num" aria-hidden="true">
                    {state === 'done' ? <Check size={14} /> : i + 1}
                  </span>
                  <span className="step-text">
                    <span className="step-label">{s.label}</span>
                    <span className="step-hint">{s.hint}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      </nav>
      {draft.conflict && (
        <div className="create-banner">
          <Banner tone="warning" title="This brief was changed in another window." actions={<Button size="sm" onClick={() => window.location.reload()}>Reload</Button>}>
            Autosave is paused so neither copy is overwritten. Reload to continue from the latest saved brief.
          </Banner>
        </div>
      )}
      <div className="create-body">{body}</div>
      <footer className="create-foot">
        <Button icon={<ArrowLeft size={16} aria-hidden="true" />} onClick={() => (index === 0 ? navigate('/') : void go(STEPS[index - 1]!.id))}>
          {index === 0 ? 'Projects' : 'Back'}
        </Button>
        <span className="subtle small">
          Step {index + 1} of {STEPS.length} · progress is saved automatically
        </span>
        {index < STEPS.length - 1 && (
          <Button variant="primary" disabled={!canContinue[step]} onClick={() => void go(STEPS[index + 1]!.id)}>
            Continue <ArrowRight size={16} aria-hidden="true" />
          </Button>
        )}
      </footer>
    </div>
  );
}
