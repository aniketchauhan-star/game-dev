import { useEffect, useMemo, useState } from 'react';
import { CircleCheck, CircleDashed, CircleX, GitBranch, GraduationCap, Hammer, Rocket, TriangleAlert } from 'lucide-react';
import { gradeLabel, profileForGrade, type GradeValue } from '@shared/schemas/grade.ts';
import type { Job } from '@shared/schemas/jobs.ts';
import { errorMessage } from '../../../lib/api.ts';
import { useJobsContext, useTrackedJob } from '../../../lib/jobs.tsx';
import { useHealth, useJobs, usePreviewBundle, useProject } from '../../../lib/queries.ts';
import { Link, useRouter } from '../../../lib/router.tsx';
import {
  useAddSampleFiles,
  useApproveBuild,
  useCreateBranch,
  useGrade,
  useGradePlanAction,
  useGradePlans,
  useMotionPlanAction,
  useMotionPlans,
  useReadiness,
  useStartGradePlan,
  useStartPrepare,
  type ReadinessCheck,
} from '../../../lib/studioQueries.ts';
import { SetupCards } from '../../../components/setup/SetupCards.tsx';
import { GradePlanReview, MotionPlanReview } from '../../../components/plans/PlanReview.tsx';
import { JobActivity } from '../../../components/JobActivity.tsx';
import { Button, Field, TextInput } from '../../../components/ui/controls.tsx';
import { Banner, DemoBadge, Pill, Spinner } from '../../../components/ui/feedback.tsx';
import { useToast } from '../../../components/ui/overlay.tsx';

const STATUS_ICON: Record<ReadinessCheck['status'], typeof CircleCheck> = { pass: CircleCheck, warn: TriangleAlert, fail: CircleX, todo: CircleDashed };
const STAGE_LABEL: Record<string, string> = { gameplay: 'Gameplay', screens: 'Screen map', assets: 'Artwork', grade: 'Grade plan', motion: 'Motion' };

function ReadinessList({ projectId, checks }: { projectId: string; checks: ReadinessCheck[] }) {
  return (
    <ul className="readiness" aria-label="Readiness">
      {checks.map((c) => {
        const Icon = STATUS_ICON[c.status];
        return (
          <li key={c.id} className={`readiness-item is-${c.status}`}>
            <Icon size={18} aria-hidden="true" />
            <div>
              <strong>{c.label}</strong>
              <span className="sr-only"> — {c.status === 'pass' ? 'passed' : c.status === 'fail' ? 'failed' : c.status === 'warn' ? 'warning' : 'to do'}</span>
              <p className="subtle small">{c.detail}</p>
            </div>
            {c.status !== 'pass' && c.area !== 'prepare' && (
              <Link className="link-btn small" to={`/p/${projectId}/${c.area}`}>
                Open {c.area}
              </Link>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function NewGradeVersion({ projectId, builtFor, onDone }: { projectId: string; builtFor: string | null; onDone: () => void }) {
  const create = useCreateBranch(projectId);
  const toast = useToast();
  const [grade, setGrade] = useState<GradeValue>(6);
  const [custom, setCustom] = useState('');
  const [name, setName] = useState('');
  const profile = { ...profileForGrade(grade), customLabel: grade === 'custom' ? custom : '' };
  return (
    <section className="panel panel-pad stack" aria-labelledby="new-branch-title">
      <h2 id="new-branch-title" className="h-sub">
        <GitBranch size={18} aria-hidden="true" /> Create another grade version
      </h2>
      <p className="muted small">
        Branches the current approved game{builtFor ? ` (built for ${builtFor})` : ''}. Sources and asset versions are shared; the new version keeps its own blueprint, screens, grade settings, motion and history. The earlier version is never overwritten.
      </p>
      <div className="grade-picker" role="radiogroup" aria-label="Grade for the new version">
        {Array.from({ length: 12 }, (_, i) => i + 1).map((g) => (
          <button key={g} type="button" role="radio" aria-checked={grade === g} className={`grade-chip${grade === g ? ' is-selected' : ''}`} onClick={() => setGrade(g)}>
            {g}
          </button>
        ))}
        <button type="button" role="radio" aria-checked={grade === 'custom'} className={`grade-chip grade-chip-custom${grade === 'custom' ? ' is-selected' : ''}`} onClick={() => setGrade('custom')}>
          Custom
        </button>
      </div>
      <div className="form-grid">
        {grade === 'custom' && (
          <Field label="Who is it for?" htmlFor="nb-custom">
            <TextInput id="nb-custom" maxLength={40} value={custom} onChange={(e) => setCustom(e.target.value)} />
          </Field>
        )}
        <Field label="Name" htmlFor="nb-name" help={`Defaults to “${gradeLabel(profile)} version”.`}>
          <TextInput id="nb-name" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
      </div>
      <div className="row">
        <Button
          variant="primary"
          loading={create.isPending}
          disabled={grade === 'custom' && !custom.trim()}
          onClick={() =>
            create.mutate(
              { name, profile },
              {
                onSuccess: (r) => {
                  toast({ tone: 'success', title: `Created “${r.branch.name}”`, detail: 'It starts as a copy. Review a grade adaptation plan below before anything changes.' });
                  onDone();
                },
                onError: (e) => toast({ tone: 'error', title: 'Not created', detail: `${errorMessage(e).message} ${errorMessage(e).hint ?? ''}` }),
              },
            )
          }
        >
          Create {gradeLabel(profile)} version
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </section>
  );
}

export function PreparePage({ projectId }: { projectId: string }) {
  const project = useProject(projectId);
  const health = useHealth();
  const readiness = useReadiness(projectId);
  const grade = useGrade(projectId);
  const gradePlans = useGradePlans(projectId);
  const motionPlans = useMotionPlans(projectId);
  const jobs = useJobs(projectId);
  const bundle = usePreviewBundle(projectId, null, Boolean(project.data?.currentVersionId));
  const prepare = useStartPrepare(projectId);
  const approve = useApproveBuild(projectId);
  const startGrade = useStartGradePlan(projectId);
  const gradeAction = useGradePlanAction(projectId);
  const motionAction = useMotionPlanAction(projectId);
  const sampleFiles = useAddSampleFiles(projectId);
  const { track } = useJobsContext();
  const { search, navigate } = useRouter();
  const toast = useToast();
  const [showNewBranch, setShowNewBranch] = useState(search.get('branch') === 'new');
  useEffect(() => setShowNewBranch(search.get('branch') === 'new'), [search]);

  const prepareJob = (jobs.data ?? []).find((j) => j.type === 'prepare') ?? null;
  const tracked = useTrackedJob(prepareJob?.id ?? null);
  const liveJob: Job | null = tracked?.job ?? prepareJob;
  const buildJob = (jobs.data ?? []).find((j) => j.type === 'build') ?? null;
  const trackedBuild = useTrackedJob(buildJob?.id ?? null);
  const stages = (liveJob?.status === 'succeeded' ? (liveJob.result as { stages?: Array<{ key: string; status: string; message: string }> } | null)?.stages : null) ?? null;
  const config = bundle.data?.config ?? null;
  const builtFor = config?.meta.gradeLabel || null;
  const profile = grade.data?.current?.profile ?? null;
  const currentGrade = profile ? gradeLabel(profile) : null;
  const latestGradePlan = gradePlans.data?.[0] ?? null;
  const stagedGradePlan = latestGradePlan && latestGradePlan.status === 'proposed' ? latestGradePlan : null;
  const stagedMotion = (motionPlans.data ?? []).find((p) => p.status === 'proposed' && p.baseVersionId === null) ?? null;
  const claude = health.data?.claude;
  const engine = claude?.state === 'configured' ? 'Claude' : project.data?.isSample ? 'demo answers (bundled sample)' : 'preset rules (no AI)';
  const fail = (title: string) => (e: unknown) => toast({ tone: 'error', title, detail: `${errorMessage(e).message} ${errorMessage(e).hint ?? ''}` });
  const decideGrade = (id: string) => (decisions: Record<string, 'pending' | 'accepted' | 'rejected'>) => gradeAction.mutate({ id, action: 'decisions', decisions }, { onError: fail('Decision not saved') });
  const decideMotion = (id: string) => (decisions: Record<string, 'pending' | 'accepted' | 'rejected'>) => motionAction.mutate({ id, action: 'decisions', decisions }, { onError: fail('Decision not saved') });
  const gradeMismatch = Boolean(builtFor && currentGrade && builtFor !== currentGrade);
  const isTrapeziumSample = project.data?.isSample && project.data.name.startsWith('Trapezium Quest');

  const pendingGrade = useMemo(() => (stagedGradePlan ? stagedGradePlan.plan.items.filter((i) => (stagedGradePlan.decisions[i.id] ?? 'pending') === 'pending').length : 0), [stagedGradePlan]);

  if (project.isLoading || !project.data) {
    return (
      <div className="center-fill">
        <Spinner large label="Loading…" />
      </div>
    );
  }
  const p = project.data;
  const active = p.branches.find((b) => b.active);

  return (
    <div className="canvas-inner prepare-page">
      <header className="page-head">
        <div>
          <h1 className="h-page">
            <Rocket size={24} aria-hidden="true" /> Prepare my game
          </h1>
          <p className="muted">
            Add sources and the grade, then let NEXUS stage reviewable proposals — gameplay, screen map, artwork, grade plan and motion. Nothing is built until you choose Approve & build.
          </p>
        </div>
        {active && (
          <span className="row-wrap">
            <Pill tone="info" dot={false}>
              <GitBranch size={13} aria-hidden="true" /> {active.name}
              {active.gradeLabel ? ` · ${active.gradeLabel}` : ''}
            </Pill>
            {p.isSample && <DemoBadge text="Bundled sample" />}
          </span>
        )}
      </header>

      {isTrapeziumSample && (
        <Banner
          tone="info"
          title="Grade 8 trapezium sample"
          actions={
            <>
              {(['lesson', 'screens', 'artwork'] as const).map((k) => (
                <Button key={k} size="sm" loading={sampleFiles.isPending && sampleFiles.variables === k} onClick={() => sampleFiles.mutate(k, { onError: fail('Sample files not added') })}>
                  Add sample {k === 'lesson' ? 'lesson (PPTX)' : k === 'screens' ? 'exported screens' : 'artwork'}
                </Button>
              ))}
            </>
          }
        >
          Labelled sample files go through the same import pipelines as your uploads. Without Claude, AI steps replay prepared demo answers for this sample only.
        </Banner>
      )}

      <SetupCards project={p} gameBuiltFor={builtFor} />

      {gradeMismatch && (
        <Banner
          tone="warning"
          title={`The game was built for ${builtFor}; the profile now says ${currentGrade}.`}
          actions={
            <>
              <Button size="sm" variant="primary" loading={startGrade.isPending} onClick={() => startGrade.mutate({ mode: 'presentation', engine: 'auto' }, { onSuccess: (r) => track(r.job), onError: fail('Plan not started') })}>
                Plan: presentation only
              </Button>
              <Button size="sm" loading={startGrade.isPending} onClick={() => startGrade.mutate({ mode: 'challenge', engine: 'auto' }, { onSuccess: (r) => track(r.job), onError: fail('Plan not started') })}>
                Plan: presentation + learning challenge
              </Button>
            </>
          }
        >
          A grade switch never rewrites the game. Review a before/after plan: “presentation only” revises wording and guidance without changing outcomes or answers; “learning challenge” sends learning changes to blueprint review.
        </Banner>
      )}

      <section className="panel panel-pad stack prepare-run" aria-labelledby="prepare-title">
        <div className="row-wrap">
          <h2 id="prepare-title" className="h-sub">
            Stage proposals
          </h2>
          <span className="spacer" />
          <span className="subtle small">Uses {engine}.</span>
          <Button
            variant="primary"
            icon={<Rocket size={16} aria-hidden="true" />}
            disabled={!profile}
            loading={prepare.isPending || liveJob?.status === 'running' || liveJob?.status === 'queued'}
            onClick={() => prepare.mutate(undefined, { onSuccess: (r) => track(r.job), onError: fail('Could not prepare') })}
          >
            Prepare my game
          </Button>
        </div>
        {!profile && <p className="muted small">Set the grade first (Grade & learning profile card).</p>}
        {liveJob && liveJob.status !== 'succeeded' && <JobActivity job={liveJob} compact />}
        {stages && (
          <ol className="stage-results">
            {stages.map((s) => (
              <li key={s.key} className={`stage-result is-${s.status}`}>
                <strong>{STAGE_LABEL[s.key] ?? s.key}</strong>
                <Pill tone={s.status === 'done' ? 'success' : s.status === 'review' ? 'warning' : s.status === 'blocked' ? 'danger' : 'neutral'}>{s.status === 'needs-you' ? 'needs you' : s.status}</Pill>
                <span className="small">{s.message}</span>
              </li>
            ))}
          </ol>
        )}
      </section>

      {readiness.data?.blueprint && (
        <section className="panel panel-pad row-wrap" aria-label="Gameplay">
          <strong>Gameplay:</strong> blueprint r{readiness.data.blueprint.number} ({readiness.data.blueprint.status})
          <Link className="link-btn" to={`/p/${projectId}/blueprint`}>
            Review in Blueprint
          </Link>
          <Link className="link-btn" to={`/p/${projectId}/screens`}>
            Review screens
          </Link>
        </section>
      )}

      {latestGradePlan && (latestGradePlan.status === 'proposed' || latestGradePlan.status === 'applied') && (
        <GradePlanReview
          plan={latestGradePlan}
          config={config}
          busy={gradeAction.isPending}
          onDecide={decideGrade(latestGradePlan.id)}
          actions={
            latestGradePlan.status === 'proposed' && (
              <>
                {latestGradePlan.baseVersionId ? (
                  <Button
                    variant="primary"
                    loading={gradeAction.isPending}
                    disabled={!Object.values(latestGradePlan.decisions).includes('accepted')}
                    onClick={() =>
                      gradeAction.mutate(
                        { id: latestGradePlan.id, action: 'apply' },
                        {
                          onSuccess: (r) => {
                            if ('blueprintRevisionId' in r && r.blueprintRevisionId) {
                              toast({ tone: 'success', title: 'Learning changes sent to blueprint review', detail: 'A new draft blueprint holds them. Approve it, then build.' });
                              navigate(`/p/${projectId}/blueprint`);
                            } else toast({ tone: 'success', title: 'Grade plan applied', detail: 'Saved as a new game version — undo from the version menu.' });
                          },
                          onError: fail('Not applied'),
                        },
                      )
                    }
                  >
                    {latestGradePlan.mode === 'challenge' ? 'Send to blueprint review' : 'Apply accepted changes'}
                  </Button>
                ) : (
                  <span className="subtle small">Accepted items are applied by Approve & build. {pendingGrade ? `${pendingGrade} item(s) still pending.` : ''}</span>
                )}
                <Button variant="ghost" onClick={() => gradeAction.mutate({ id: latestGradePlan.id, action: 'reject' }, { onError: fail('Not rejected') })}>
                  Reject plan
                </Button>
              </>
            )
          }
        />
      )}

      {stagedMotion && (
        <MotionPlanReview
          plan={stagedMotion}
          config={config}
          busy={motionAction.isPending}
          onDecide={decideMotion(stagedMotion.id)}
          actions={
            <>
              <span className="subtle small">Accepted animations are built in by Approve & build; you can fine-tune them in Animate afterwards.</span>
              <Button variant="ghost" onClick={() => motionAction.mutate({ id: stagedMotion.id, action: 'reject' }, { onError: fail('Not rejected') })}>
                Reject plan
              </Button>
            </>
          }
        />
      )}

      <section className="panel panel-pad stack" aria-labelledby="ready-title">
        <h2 id="ready-title" className="h-sub">
          Readiness
        </h2>
        {readiness.isLoading ? <Spinner label="Running checks…" /> : readiness.data ? <ReadinessList projectId={projectId} checks={readiness.data.checks} /> : null}
        <div className="row-wrap">
          <Button
            variant="primary"
            icon={<Hammer size={16} aria-hidden="true" />}
            disabled={!readiness.data?.canBuild}
            loading={approve.isPending || trackedBuild?.job.status === 'running' || trackedBuild?.job.status === 'queued'}
            onClick={() =>
              approve.mutate(
                { includeGradePlan: true, includeMotionPlan: true },
                {
                  onSuccess: (r) => {
                    track(r.job);
                    toast({ tone: 'info', title: 'Building…', detail: 'The previous playable version stays current until the build succeeds.' });
                  },
                  onError: fail('Not built'),
                },
              )
            }
          >
            Approve & build
          </Button>
          {readiness.data && !readiness.data.canBuild && (
            <span className="subtle small">
              <TriangleAlert size={14} aria-hidden="true" /> {readiness.data.buildBlockers.join(' ')}
            </span>
          )}
          {readiness.data?.canBuild && <span className="subtle small">Builds only the supported mechanics. A failed build changes nothing.</span>}
        </div>
        {trackedBuild && trackedBuild.job.status !== 'succeeded' && <JobActivity job={trackedBuild.job} compact />}
        {trackedBuild?.job.status === 'succeeded' && (
          <Banner tone="success" title="Built" actions={<Button size="sm" onClick={() => navigate(`/p/${projectId}/build?play=1`)}>Play it</Button>}>
            The new version includes your accepted grade changes and animations. Fine-tune motion in Animate.
          </Banner>
        )}
      </section>

      <section className="panel panel-pad stack" aria-labelledby="versions-title">
        <div className="row-wrap">
          <h2 id="versions-title" className="h-sub">
            <GraduationCap size={18} aria-hidden="true" /> Grade versions
          </h2>
          <span className="spacer" />
          {!showNewBranch && (
            <Button size="sm" icon={<GitBranch size={14} aria-hidden="true" />} disabled={!p.currentVersionId} onClick={() => setShowNewBranch(true)}>
              Create another grade version
            </Button>
          )}
        </div>
        <ul className="branch-list">
          {p.branches.map((b) => (
            <li key={b.id} className={b.active ? 'is-active' : ''}>
              <strong>{b.name}</strong> <span className="subtle small">{b.gradeLabel || 'no grade set'}</span>
              <span className="subtle small">{b.currentVersionNumber ? `v${b.currentVersionNumber} · ${b.versionCount} version(s)` : 'not built'}</span>
              {b.parentName && <span className="subtle small">from “{b.parentName}”{b.forkedFromVersionNumber ? ` v${b.forkedFromVersionNumber}` : ''}</span>}
              {b.active && <Pill tone="info">editing</Pill>}
            </li>
          ))}
        </ul>
        {showNewBranch && <NewGradeVersion projectId={projectId} builtFor={builtFor} onDone={() => (setShowNewBranch(false), navigate(`/p/${projectId}/prepare`, { replace: true }))} />}
      </section>
    </div>
  );
}
