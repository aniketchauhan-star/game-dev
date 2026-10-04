import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Blocks, CircleCheck, FilePlus2, FlaskConical, Gamepad2, LayoutGrid, List, Lock, Plus, Sparkles, TriangleAlert, Wand2 } from 'lucide-react';
import { checkInteraction } from '@shared/attainability.ts';
import { blueprintSchema, checkBlueprint, isNotWritten, NOT_WRITTEN, relinkLinear, type Blueprint, type BlueprintRevision, type BlueprintScene } from '@shared/schemas/blueprint.ts';
import { ID_PREFIX, newId } from '@shared/schemas/common.ts';
import { MECHANICS, SCENE_TYPES } from '@shared/registry.ts';
import { useRouter } from '../../../lib/router.tsx';
import { useAnalysis, useAssets, useBlueprint, useBlueprintAction, useBlueprints, useCoverage, useHealth, useManualBlueprint, useProject, useSaveBlueprint, useSlides, useStartJob } from '../../../lib/queries.ts';
import { useJobsContext, useProjectJobs } from '../../../lib/jobs.tsx';
import { useSaveStatus } from '../../../lib/saveStatus.tsx';
import { ApiError, errorMessage, newIdempotencyKey } from '../../../lib/api.ts';
import { formatDate } from '../../../lib/format.ts';
import { Workspace } from '../../../components/shell/Workspace.tsx';
import { ClaudePanel } from '../../../components/claude/ClaudePanel.tsx';
import { Button, Field, IconButton, Segmented, Select, TextArea, TextInput } from '../../../components/ui/controls.tsx';
import { Banner, EmptyState, OriginBadge, Pill, Spinner } from '../../../components/ui/feedback.tsx';
import { ConfirmDialog, Dialog, Menu, useToast } from '../../../components/ui/overlay.tsx';
import { SceneThumb } from '../../../components/scenes/SceneThumb.tsx';
import { templateInteraction } from '../../../components/scenes/InteractionEditor.tsx';
import { JobActivity } from '../../../components/JobActivity.tsx';
import { SourceChips } from '../../../components/SourceChips.tsx';
import { SceneEditor, ruleText } from './SceneEditor.tsx';

function sceneHasErrors(s: BlueprintScene): boolean {
  return checkInteraction(s.interaction, { seed: 1, sceneId: s.id }).some((i) => i.severity === 'error');
}

/** Draft editing with debounced autosave against the revision we loaded. */
function useDraft(rev: BlueprintRevision | undefined, projectId: string) {
  const save = useSaveBlueprint(projectId);
  const { track } = useSaveStatus();
  const toast = useToast();
  const [draft, setDraft] = useState<Blueprint | null>(rev?.blueprint ?? null);
  const revision = useRef(rev?.revision ?? 0);
  const timer = useRef<number | null>(null);
  const pending = useRef<Blueprint | null>(null);
  const [conflict, setConflict] = useState(false);
  /** Why the latest edit could not be saved (e.g. a required field is empty). */
  const [invalid, setInvalid] = useState<string | null>(null);
  useEffect(() => {
    setDraft(rev?.blueprint ?? null);
    revision.current = rev?.revision ?? 0;
    setConflict(false);
    setInvalid(null);
  }, [rev?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (rev && !pending.current) revision.current = rev.revision;
  }, [rev?.revision]); // eslint-disable-line react-hooks/exhaustive-deps

  const flush = async (acknowledgeSourceChanges = false) => {
    if (!rev || rev.status !== 'draft') return;
    const bp = pending.current ?? draft;
    if (!bp) return;
    if (timer.current) window.clearTimeout(timer.current);
    const parsed = blueprintSchema.safeParse(bp);
    if (!parsed.success) {
      // Keep the edit pending; it saves as soon as it is valid again.
      setInvalid(describeIssue(bp, parsed.error.issues[0]!));
      return;
    }
    setInvalid(null);
    pending.current = null;
    try {
      const r = await track(() => save.mutateAsync({ id: rev.id, blueprint: bp, revision: revision.current, acknowledgeSourceChanges }));
      revision.current = r.revision.revision;
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) setConflict(true);
      else toast({ tone: 'error', title: 'Blueprint not saved', detail: errorMessage(err).message });
    }
  };
  const update = (next: Blueprint) => {
    setDraft(next);
    pending.current = next;
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void flush(), 700);
  };
  return { draft, update, flush, conflict, invalid, revision };
}

const FIELD_NAMES: Record<string, string> = {
  title: 'Title',
  premise: 'Premise',
  progression: 'Progression',
  assessment: 'Assessment',
  mechanicFit: 'Why this mechanic fits',
  learningOutcomes: 'Learning outcome',
  instruction: 'Instruction',
  objective: 'Learning objective',
  visibleContent: 'What learners see',
  learnerAction: 'What learners do',
  expectedResult: 'Expected result',
  successFeedback: 'Success feedback',
  errorFeedback: 'Error feedback',
  completion: 'Completion criteria',
  hints: 'Hint',
};

/** Human wording for the first schema problem, e.g. “Scene 3 · Instruction: cannot be empty”. */
function describeIssue(bp: Blueprint, issue: { path: PropertyKey[]; message: string; code?: string }): string {
  const path = issue.path;
  const parts: string[] = [];
  if (path[0] === 'scenes' && typeof path[1] === 'number') {
    parts.push(`Scene ${path[1] + 1}${bp.scenes[path[1]] ? ` (“${bp.scenes[path[1]]!.title || 'untitled'}”)` : ''}`);
    const field = path.slice(2).find((p): p is string => typeof p === 'string' && p !== 'interaction');
    if (field) parts.push(FIELD_NAMES[field] ?? field);
  } else {
    const field = path.find((p): p is string => typeof p === 'string');
    if (field) parts.push(FIELD_NAMES[field] ?? field);
    if (typeof path[1] === 'number') parts[parts.length - 1] += ` ${path[1] + 1}`;
  }
  const tooSmall = issue.code === 'too_small' || /at least 1|>=1/i.test(issue.message);
  return `${parts.join(' · ') || 'Blueprint'}: ${tooSmall ? 'cannot be empty' : issue.message}`;
}

type NoteKey = 'premise' | 'mechanicFit' | 'progression' | 'assessment';
const NOTE_PROMPTS: Record<NoteKey, string> = {
  premise: `${NOT_WRITTEN} — describe the story premise.`,
  mechanicFit: `${NOT_WRITTEN} — explain why the chosen interaction fits this lesson.`,
  progression: `${NOT_WRITTEN} — describe how support fades and difficulty grows.`,
  assessment: `${NOT_WRITTEN} — describe how understanding is checked.`,
};
const NOTE_LIMITS: Record<NoteKey, number> = { premise: 400, mechanicFit: 500, progression: 400, assessment: 400 };

function Overview({
  bp,
  rev,
  projectId,
  slides,
  onChange,
}: {
  bp: Blueprint;
  rev: BlueprintRevision;
  projectId: string;
  slides: import('@shared/schemas/source.ts').SourceSlide[];
  /** Null when the revision is read-only. */
  onChange: ((bp: Blueprint) => void) | null;
}) {
  const coverage = useCoverage(projectId, rev.id);
  const c = coverage.data?.summary;
  const mech = MECHANICS[bp.coreMechanic];
  // Unwritten notes show as an empty box with the prompt as placeholder; clearing a note restores the prompt.
  const note = (key: NoteKey, label: string, help?: string) => (
    <Field label={label} htmlFor={`bp-${key}`} help={help}>
      <TextArea
        id={`bp-${key}`}
        rows={key === 'premise' ? 3 : 4}
        maxLength={NOTE_LIMITS[key]}
        value={isNotWritten(bp[key]) ? '' : bp[key]}
        placeholder={NOTE_PROMPTS[key]}
        onChange={(e) => onChange?.({ ...bp, [key]: e.target.value.trim() === '' ? NOTE_PROMPTS[key] : e.target.value })}
      />
    </Field>
  );
  const shown = (text: string) => <span className={isNotWritten(text) ? 'subtle' : undefined}>{text}</span>;
  if (onChange) {
    return (
      <div className="bp-overview">
        <section className="panel panel-pad bp-card bp-wide">
          <Field label="Game title" htmlFor="bp-title">
            <TextInput id="bp-title" maxLength={80} value={bp.title} onChange={(e) => onChange({ ...bp, title: e.target.value })} />
          </Field>
          {note('premise', 'Premise', 'Learners see this on the title screen.')}
          <div className="row-wrap">
            <Pill tone={mech.buildable ? 'success' : 'warning'}>
              {mech.label}
              {mech.buildable ? '' : ' · Blueprint only'}
            </Pill>
            <span className="muted small">{bp.scenes.length} scenes</span>
          </div>
        </section>
        <section className="panel panel-pad bp-card">{note('mechanicFit', 'Why this mechanic fits')}</section>
        <section className="panel panel-pad bp-card">
          {note('progression', 'Progression')}
          {note('assessment', 'Assessment')}
        </section>
        <section className="panel panel-pad bp-card bp-wide">
          <h3 className="h-sub-sm">Learning outcomes</h3>
          <ul className="map-list">
            {bp.learningOutcomes.map((o, i) => (
              <li key={o.id} className="stack" style={{ gap: 6 }}>
                <TextArea
                  aria-label={`Learning outcome ${i + 1}`}
                  rows={2}
                  maxLength={240}
                  value={o.text}
                  onChange={(e) => onChange({ ...bp, learningOutcomes: bp.learningOutcomes.map((x) => (x.id === o.id ? { ...x, text: e.target.value } : x)) })}
                />
                <SourceChips projectId={projectId} slideIds={o.sourceSlideIds} slides={slides} addedPractice={o.addedPractice} />
              </li>
            ))}
          </ul>
        </section>
      </div>
    );
  }
  return (
    <div className="bp-overview">
      <section className="panel panel-pad bp-card bp-wide">
        <p className="eyebrow">Premise</p>
        <p className="bp-premise">{shown(bp.premise)}</p>
        <div className="row-wrap">
          <Pill tone={mech.buildable ? 'success' : 'warning'}>
            {mech.label}
            {mech.buildable ? '' : ' · Blueprint only'}
          </Pill>
          <span className="muted small">
            {bp.scenes.length} scenes · Title screen → {bp.scenes.map((s) => s.title).join(' → ')} → Completion
          </span>
        </div>
      </section>
      <section className="panel panel-pad bp-card">
        <h3 className="h-sub-sm">Why this mechanic fits</h3>
        <p className="muted">{shown(bp.mechanicFit)}</p>
      </section>
      <section className="panel panel-pad bp-card">
        <h3 className="h-sub-sm">Coverage</h3>
        {c ? (
          <p className="muted">
            {c.covered} of {c.included} included slides used · {c.notCovered} not used · {c.excluded} excluded{c.addedPracticeScenes ? ` · ${c.addedPracticeScenes} added-practice scene(s)` : ''}.
          </p>
        ) : (
          <Spinner />
        )}
        <a className="small" href={`/p/${projectId}/source?view=coverage`}>
          See slide-by-slide coverage
        </a>
      </section>
      <section className="panel panel-pad bp-card">
        <h3 className="h-sub-sm">Learning outcomes</h3>
        <ul className="map-list">
          {bp.learningOutcomes.map((o) => (
            <li key={o.id}>
              {o.text}
              <div>
                <SourceChips projectId={projectId} slideIds={o.sourceSlideIds} slides={slides} addedPractice={o.addedPractice} />
              </div>
            </li>
          ))}
        </ul>
      </section>
      <section className="panel panel-pad bp-card">
        <h3 className="h-sub-sm">Progression & assessment</h3>
        <p className="muted small">{shown(bp.progression)}</p>
        <p className="muted small">{shown(bp.assessment)}</p>
      </section>
      <section className="panel panel-pad bp-card">
        <h3 className="h-sub-sm">Assumptions (not in the slides)</h3>
        {bp.assumptions.length ? (
          <ul className="plain-list small">
            {bp.assumptions.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
        ) : (
          <p className="subtle small">None recorded.</p>
        )}
      </section>
      <section className="panel panel-pad bp-card">
        <h3 className="h-sub-sm">Unresolved decisions</h3>
        {bp.unresolvedDecisions.length ? (
          <ul className="plain-list small">
            {bp.unresolvedDecisions.map((d) => (
              <li key={d.id}>
                {d.question}
                {d.options.length > 0 && <span className="subtle"> ({d.options.join(' / ')})</span>}
              </li>
            ))}
          </ul>
        ) : (
          <p className="subtle small">None.</p>
        )}
      </section>
      <section className="panel panel-pad bp-card">
        <h3 className="h-sub-sm">Asset needs</h3>
        <ul className="plain-list small">
          {bp.assetNeeds.map((n) => (
            <li key={n.id}>
              {n.description} <span className="subtle">({n.role})</span> {n.assignedAssetId ? <Pill tone="success">Assigned</Pill> : <Pill tone={n.required ? 'warning' : 'neutral'}>{n.required ? 'Missing' : 'Built-in art'}</Pill>}
            </li>
          ))}
          {bp.assetNeeds.length === 0 && <li className="subtle">None — built-in artwork is used.</li>}
        </ul>
      </section>
      <section className="panel panel-pad bp-card">
        <h3 className="h-sub-sm">Accessibility</h3>
        <ul className="plain-list small">
          {bp.accessibility.map((a, i) => (
            <li key={i}>{a}</li>
          ))}
        </ul>
      </section>
    </div>
  );
}

export function BlueprintArea({ projectId }: { projectId: string }) {
  const { navigate, search } = useRouter();
  const project = useProject(projectId);
  const revisions = useBlueprints(projectId);
  const slides = useSlides(projectId);
  const analysis = useAnalysis(projectId);
  const assets = useAssets(projectId);
  const health = useHealth();
  const start = useStartJob(projectId);
  const action = useBlueprintAction(projectId);
  const manual = useManualBlueprint(projectId);
  const { track } = useJobsContext();
  const jobs = useProjectJobs(projectId);
  const toast = useToast();
  const list = revisions.data ?? [];
  const [revId, setRevId] = useState<string | null>(search.get('rev'));
  useEffect(() => {
    if (!revId && list[0]) setRevId(list[0].id);
    if (revId && list.length && !list.some((r) => r.id === revId)) setRevId(list[0]!.id);
  }, [list, revId]);
  const bpQuery = useBlueprint(revId);
  const rev = bpQuery.data?.revision;
  const { draft, update, flush, conflict, invalid, revision } = useDraft(rev, projectId);
  const [selectedScene, setSelectedScene] = useState<string | null>(search.get('scene'));
  const [view, setView] = useState<'storyboard' | 'list'>('storyboard');
  const [reorder, setReorder] = useState<{ from: number; to: number } | null>(null);
  const [regen, setRegen] = useState<{ sceneId: string; guidance: string } | null>(null);
  const readOnly = !rev || rev.status !== 'draft';
  const allSlides = slides.data?.slides ?? [];
  const images = (assets.data ?? []).filter((a) => a.kind === 'image');
  const claude = health.data?.claude;
  const live = claude?.state === 'configured';
  const demo = !claude?.keyPresent && Boolean(project.data?.isSample);
  const bpJob = jobs.find((t) => t.job.type === 'blueprint' || t.job.type === 'regenerate_scene');
  const busy = Boolean(bpJob && (bpJob.job.status === 'queued' || bpJob.job.status === 'running'));
  // Show the revision a finished generation produced.
  const producedRev = bpJob?.job.status === 'succeeded' ? ((bpJob.job.result as { blueprintRevisionId?: string } | null)?.blueprintRevisionId ?? null) : null;
  useEffect(() => {
    if (producedRev) setRevId(producedRev);
  }, [producedRev]);
  const bp = draft ?? rev?.blueprint ?? null;
  const sceneIndex = bp?.scenes.findIndex((s) => s.id === selectedScene) ?? -1;
  const scene = sceneIndex >= 0 ? bp!.scenes[sceneIndex]! : null;
  const errors = useMemo(() => (bp ? bp.scenes.filter(sceneHasErrors).length : 0), [bp]);
  // The same structural checks the server runs before approval (only once slides are loaded).
  const structural = useMemo(() => {
    if (!bp || !slides.data) return [];
    return checkBlueprint(bp, new Set(slides.data.slides.filter((s) => s.included).map((s) => s.id)));
  }, [bp, slides.data]);
  const blocking = structural.filter((i) => i.severity === 'error');

  const generate = () =>
    start.mutate(
      { type: 'blueprint', input: { analysisId: analysis.data?.id ?? null }, key: newIdempotencyKey() },
      { onSuccess: (r) => track(r.job), onError: (e) => toast({ tone: 'error', title: 'Blueprint generation did not start', detail: `${errorMessage(e).message} ${errorMessage(e).hint ?? ''}` }) },
    );
  const build = () =>
    start.mutate(
      { type: 'build', input: { blueprintRevisionId: rev!.id }, key: newIdempotencyKey() },
      {
        onSuccess: (r) => {
          track(r.job);
          navigate(`/p/${projectId}/build`);
        },
        onError: (e) => toast({ tone: 'error', title: 'Build did not start', detail: `${errorMessage(e).message} ${errorMessage(e).hint ?? ''}` }),
      },
    );
  const approve = async () => {
    if (!rev) return;
    await flush();
    action.mutate(
      { id: rev.id, action: 'approve', revision: revision.current },
      {
        onSuccess: (r) => toast({ tone: 'success', title: `Blueprint r${r.revision.number} approved`, detail: 'It is now immutable. Builds use exactly this revision.' }),
        onError: (e) => toast({ tone: 'error', title: 'Not approved', detail: `${errorMessage(e).message} ${errorMessage(e).hint ?? ''}` }),
      },
    );
  };
  const newDraft = () =>
    rev &&
    action.mutate(
      { id: rev.id, action: 'draft' },
      { onSuccess: (r) => setRevId(r.revision.id), onError: (e) => toast({ tone: 'error', title: 'Could not create a draft', detail: errorMessage(e).message }) },
    );
  const moveScene = (from: number, to: number) => {
    if (!bp || to < 0 || to >= bp.scenes.length) return;
    const sequenceLocked = bp.scenes.slice(Math.min(from, to), Math.max(from, to) + 1).some((s) => s.locks.sequence);
    if (sequenceLocked && !reorder) return setReorder({ from, to });
    const scenes = bp.scenes.slice();
    const [m] = scenes.splice(from, 1);
    scenes.splice(to, 0, m!);
    update({ ...bp, scenes: relinkLinear(scenes) });
    setReorder(null);
  };
  const addScene = (type: BlueprintScene['interaction']['type']) => {
    if (!bp) return;
    const s: BlueprintScene = {
      id: newId(ID_PREFIX.scene),
      title: `New ${SCENE_TYPES[type].label.toLowerCase()}`,
      pattern: 'manipulate',
      sourceSlideIds: [],
      addedPractice: true,
      objective: 'Describe what this scene teaches.',
      visibleContent: 'Describe what learners see.',
      learnerAction: 'Describe what learners do.',
      expectedResult: 'Describe the correct result.',
      instruction: 'Write the learner instruction.',
      interaction: templateInteraction(type),
      successFeedback: 'Well done!',
      errorFeedback: 'Not yet — check your answer and try again.',
      hints: ['Write a first hint.'],
      next: null,
      assetNeedIds: { background: null, character: null },
      completion: 'The scene rule is satisfied.',
      difficulty: 'standard',
      locks: { sequence: false, wording: false, answer: false, layout: false, assets: false },
      origin: 'creator',
    };
    update({ ...bp, scenes: relinkLinear([...bp.scenes, s]) });
    setSelectedScene(s.id);
  };

  if (revisions.isLoading) {
    return (
      <div className="center-fill">
        <Spinner large label="Loading blueprint…" />
      </div>
    );
  }

  const claudePanel = (
    <ClaudePanel
      projectId={projectId}
      area="blueprint"
      mode="ask"
      scopes={[...(scene ? [{ scope: { kind: 'scene' as const, sceneId: scene.id, slideId: null }, label: `Selected scene: ${scene.title}` }] : []), { scope: { kind: 'project' as const, sceneId: null, slideId: null }, label: 'Whole project' }]}
      examples={['Does this scene sequence follow the lesson?', 'What could make scene 2 more hands-on?', 'Which slides are not used yet?']}
      actions={
        <div className="stack">
          {(live || (demo && list.length === 0)) && (
            <Button variant={list.length ? 'ai' : 'primary'} block icon={demo ? <FlaskConical size={16} aria-hidden="true" /> : <Sparkles size={16} aria-hidden="true" />} loading={busy || start.isPending} disabled={live && !analysis.data} onClick={generate}>
              {demo ? 'Load demo blueprint' : list.length ? 'Generate a new blueprint' : 'Generate blueprint'}
            </Button>
          )}
          {live && !analysis.data && <p className="subtle small">Analyze the deck first (Source → Learning map).</p>}
          {scene && live && !readOnly && (
            <Button variant="ai" block icon={<Wand2 size={16} aria-hidden="true" />} onClick={() => setRegen({ sceneId: scene.id, guidance: '' })}>
              Regenerate selected scene
            </Button>
          )}
        </div>
      }
    />
  );

  if (list.length === 0 || !rev || !bp) {
    return (
      <Workspace
        leftLabel="Scenes"
        left={<div className="panel-body subtle small pad">No scenes yet.</div>}
        center={
          <div className="canvas-inner">
            {bpJob && <JobActivity job={bpJob.job} />}
            <EmptyState
              icon={<Blocks size={26} aria-hidden="true" />}
              title="No blueprint yet"
              actions={
                <>
                  {(live || demo) && (
                    <Button variant="primary" icon={demo ? <FlaskConical size={16} aria-hidden="true" /> : <Sparkles size={16} aria-hidden="true" />} loading={busy || start.isPending} disabled={live && !analysis.data} onClick={generate}>
                      {demo ? 'Load demo blueprint' : 'Generate with Claude'}
                    </Button>
                  )}
                  <Button icon={<FilePlus2 size={16} aria-hidden="true" />} loading={manual.isPending} onClick={() => manual.mutate(undefined, { onSuccess: (r) => setRevId(r.revision.id), onError: (e) => toast({ tone: 'error', title: 'Could not start a blueprint', detail: errorMessage(e).message }) })}>
                    Start one yourself
                  </Button>
                </>
              }
            >
              A blueprint lists every scene with its source slides, learner action, deterministic success rule, feedback and hints. Generate it with Claude, or start from one concept card per slide and design the interactions yourself.
            </EmptyState>
          </div>
        }
        right={claudePanel}
      />
    );
  }

  const left = (
    <div className="scene-list">
      <div className="panel-head">
        <h2>Scenes</h2>
        {!readOnly && (
          <Menu
            label="Add scene"
            trigger={(props) => (
              <button type="button" className="icon-btn icon-btn-sm" aria-label="Add scene" {...props}>
                <Plus size={16} aria-hidden="true" />
              </button>
            )}
            items={MECHANICS[bp.coreMechanic].sceneTypes.map((t) => ({ label: SCENE_TYPES[t].label, onSelect: () => addScene(t) }))}
          />
        )}
      </div>
      <ol className="scene-items" aria-label="Scenes in play order">
        {bp.scenes.map((s, i) => (
          <li key={s.id} className={`scene-item${s.id === selectedScene ? ' is-selected' : ''}`}>
            <button type="button" className="scene-item-main" aria-current={s.id === selectedScene ? 'true' : undefined} onClick={() => setSelectedScene(s.id)}>
              <span className="scene-num tabular">{i + 1}</span>
              <span className="scene-item-text">
                <span className="scene-item-title">{s.title}</span>
                <span className="scene-item-type subtle small">
                  {SCENE_TYPES[s.interaction.type].label}
                  {sceneHasErrors(s) && (
                    <span className="meta-warn">
                      {' '}
                      · <TriangleAlert size={11} aria-hidden="true" /> needs fixing
                    </span>
                  )}
                </span>
              </span>
              {s.locks.sequence && <Lock size={12} aria-label="Sequence locked" className="subtle" />}
            </button>
            {!readOnly && (
              <span className="scene-move">
                <IconButton label={`Move ${s.title} up`} size="sm" disabled={i === 0} onClick={() => moveScene(i, i - 1)}>
                  <ArrowUp size={13} aria-hidden="true" />
                </IconButton>
                <IconButton label={`Move ${s.title} down`} size="sm" disabled={i === bp.scenes.length - 1} onClick={() => moveScene(i, i + 1)}>
                  <ArrowDown size={13} aria-hidden="true" />
                </IconButton>
              </span>
            )}
          </li>
        ))}
      </ol>
    </div>
  );

  const center = (
    <div className="canvas-inner">
      <header className="bp-header">
        <div className="stack" style={{ gap: 6 }}>
          <div className="row-wrap">
            <Select aria-label="Blueprint revision" value={rev.id} onChange={(e) => setRevId(e.target.value)} style={{ width: 'auto' }}>
              {list.map((r) => (
                <option key={r.id} value={r.id}>
                  r{r.number} · {r.status}
                  {r.stale ? ' · stale' : ''} · {formatDate(r.createdAt)}
                </option>
              ))}
            </Select>
            <Pill tone={rev.status === 'approved' ? 'success' : rev.status === 'draft' ? 'info' : 'neutral'}>{rev.status === 'approved' ? 'Approved · immutable' : rev.status === 'draft' ? 'Draft' : 'Superseded'}</Pill>
            <OriginBadge origin={rev.origin} model={rev.model} />
            {errors > 0 && <Pill tone="danger">{errors} scene(s) need fixing</Pill>}
          </div>
          <h1>{bp.title}</h1>
        </div>
        <div className="row-wrap bp-actions">
          <Segmented label="Blueprint view" value={view} onChange={setView} options={[{ value: 'storyboard', label: 'Storyboard', icon: <LayoutGrid size={14} aria-hidden="true" /> }, { value: 'list', label: 'List', icon: <List size={14} aria-hidden="true" /> }]} />
          {rev.status === 'draft' ? (
            <Button variant="primary" icon={<CircleCheck size={16} aria-hidden="true" />} loading={action.isPending} disabled={errors > 0 || blocking.length > 0 || invalid !== null} onClick={() => void approve()}>
              Approve blueprint
            </Button>
          ) : (
            <>
              <Button icon={<FilePlus2 size={16} aria-hidden="true" />} loading={action.isPending} onClick={newDraft}>
                Create new draft
              </Button>
              {rev.status === 'approved' &&
                (MECHANICS[bp.coreMechanic].buildable ? (
                  <Button variant="primary" icon={<Gamepad2 size={16} aria-hidden="true" />} loading={start.isPending} onClick={build}>
                    Build game from r{rev.number}
                  </Button>
                ) : (
                  <Button variant="primary" onClick={() => navigate(`/p/${projectId}/export`)}>
                    Export developer handoff
                  </Button>
                ))}
            </>
          )}
        </div>
      </header>
      {bpJob && (busy || bpJob.job.status === 'failed' || bpJob.job.status === 'interrupted') && <JobActivity job={bpJob.job} />}
      {conflict && (
        <Banner tone="warning" title="This draft changed elsewhere." actions={<Button size="sm" onClick={() => window.location.reload()}>Reload</Button>}>
          Autosave paused so nothing is overwritten.
        </Banner>
      )}
      {invalid && !readOnly && (
        <Banner tone="danger" title="Latest edit not saved yet">
          {invalid}. The draft saves again as soon as this is fixed.
        </Banner>
      )}
      {!readOnly && structural.length > 0 && (
        <Banner tone={blocking.length ? 'warning' : 'info'} title={blocking.length ? 'Before you can approve' : 'Worth checking before approval'}>
          <ul className="plain-list">
            {structural.map((i, n) => {
              const target = i.sceneId ? bp.scenes.find((x) => x.id === i.sceneId) : undefined;
              return (
                <li key={n}>
                  {i.severity === 'error' ? '' : 'Optional: '}
                  {target ? (
                    <button type="button" className="link-btn" onClick={() => setSelectedScene(target.id)}>
                      {target.title}
                    </button>
                  ) : null}
                  {target ? ' — ' : ''}
                  {i.message}
                </li>
              );
            })}
          </ul>
        </Banner>
      )}
      {rev.stale && (
        <Banner
          tone="warning"
          title={`Blueprint r${rev.number} is stale`}
          actions={
            rev.status === 'draft' ? (
              <Button size="sm" onClick={() => void flush(true)}>
                I reviewed it — mark as up to date
              </Button>
            ) : (
              <Button size="sm" onClick={newDraft}>
                Create a new draft to update it
              </Button>
            )
          }
        >
          {rev.staleReason}
        </Banner>
      )}
      {!MECHANICS[bp.coreMechanic].buildable && (
        <Banner tone="info" title="Blueprint only">
          This mechanic supports a blueprint but not an in-app build yet. Approve it and export a Developer handoff for a developer to implement.
        </Banner>
      )}
      {scene ? (
        <SceneEditor
          blueprint={bp}
          scene={scene}
          index={sceneIndex}
          readOnly={readOnly}
          slides={allSlides}
          images={images}
          projectId={projectId}
          canRegenerate={live}
          onChange={(s) => update({ ...bp, scenes: bp.scenes.map((x) => (x.id === s.id ? s : x)) })}
          onBack={() => setSelectedScene(null)}
          onRegenerate={() => setRegen({ sceneId: scene.id, guidance: '' })}
        />
      ) : (
        <>
          <Overview bp={bp} rev={rev} projectId={projectId} slides={allSlides} onChange={readOnly ? null : update} />
          {view === 'storyboard' ? (
            <ol className="storyboard" aria-label="Storyboard">
              {bp.scenes.map((s, i) => (
                <li key={s.id}>
                  <button type="button" className="story-card" onClick={() => setSelectedScene(s.id)}>
                    <SceneThumb interaction={s.interaction} title={s.title} />
                    <span className="story-meta">
                      <span className="eyebrow">
                        {i + 1} · {s.pattern}
                      </span>
                      <span className="story-title">{s.title}</span>
                      <span className="story-instruction">{s.instruction}</span>
                      <span className="story-rule small">{ruleText(s.interaction)}</span>
                    </span>
                    {sceneHasErrors(s) && (
                      <span className="story-flag">
                        <TriangleAlert size={13} aria-hidden="true" /> Needs fixing
                      </span>
                    )}
                  </button>
                  <div className="story-sources">
                    <SourceChips projectId={projectId} slideIds={s.sourceSlideIds} slides={allSlides} addedPractice={s.addedPractice} />
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <div className="table-wrap panel">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">#</th>
                    <th scope="col">Scene</th>
                    <th scope="col">Learner does</th>
                    <th scope="col">Success rule</th>
                    <th scope="col">Sources</th>
                  </tr>
                </thead>
                <tbody>
                  {bp.scenes.map((s, i) => (
                    <tr key={s.id}>
                      <td className="tabular">{i + 1}</td>
                      <td>
                        <button type="button" className="link-btn" onClick={() => setSelectedScene(s.id)}>
                          {s.title}
                        </button>
                        <div className="subtle small">{SCENE_TYPES[s.interaction.type].label}</div>
                      </td>
                      <td className="small">{s.learnerAction}</td>
                      <td className="small">{ruleText(s.interaction)}</td>
                      <td>
                        <SourceChips projectId={projectId} slideIds={s.sourceSlideIds} slides={allSlides} addedPractice={s.addedPractice} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );

  return (
    <>
      <Workspace leftLabel="Scenes" left={left} center={center} right={claudePanel} />
      <ConfirmDialog
        open={Boolean(reorder)}
        title="Change the learning sequence?"
        confirmLabel="Move scene"
        onClose={() => setReorder(null)}
        onConfirm={() => reorder && moveScene(reorder.from, reorder.to)}
      >
        <p>This scene is locked to the source order. Moving it changes the instructional sequence taken from the deck. Continue only if the new order still makes sense for learners.</p>
      </ConfirmDialog>
      <Dialog
        open={Boolean(regen)}
        onClose={() => setRegen(null)}
        title="Regenerate this scene"
        footer={
          <>
            <Button onClick={() => setRegen(null)}>Cancel</Button>
            <Button
              variant="ai"
              icon={<Sparkles size={16} aria-hidden="true" />}
              loading={start.isPending}
              onClick={async () => {
                if (!regen || !rev) return;
                await flush();
                start.mutate(
                  { type: 'regenerate_scene', input: { blueprintRevisionId: rev.id, sceneId: regen.sceneId, guidance: regen.guidance }, key: newIdempotencyKey() },
                  {
                    onSuccess: (r) => {
                      track(r.job);
                      setRegen(null);
                      toast({ tone: 'info', title: 'Regenerating the scene', detail: 'A new draft revision is created; this one stays unchanged.' });
                    },
                    onError: (e) => toast({ tone: 'error', title: 'Did not start', detail: errorMessage(e).message }),
                  },
                );
              }}
            >
              Regenerate
            </Button>
          </>
        }
      >
        <p className="muted">Only this scene changes, in a new draft revision. Locked wording and answers are kept.</p>
        <Field label="What should change? (optional)" htmlFor="regen-guidance">
          <TextArea id="regen-guidance" rows={3} maxLength={1000} value={regen?.guidance ?? ''} onChange={(e) => setRegen((r) => (r ? { ...r, guidance: e.target.value } : r))} placeholder="Make it more hands-on and use a negative x target." />
        </Field>
      </Dialog>
    </>
  );
}
