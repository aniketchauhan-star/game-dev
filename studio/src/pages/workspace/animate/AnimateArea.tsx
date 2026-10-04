import { useEffect, useMemo, useRef, useState } from 'react';
import { Ban, Clapperboard, Crosshair, Eye, EyeOff, GaugeCircle, Lock, Pause, Play, Plus, RotateCcw, Sparkles, Square, Trash2, Undo2, Volume2, VolumeX, Zap } from 'lucide-react';
import { toGameAsset } from '@shared/assetsToGame.ts';
import { gradeLabel } from '@shared/schemas/grade.ts';
import { MOTION_SETTING_LABELS, PROFILE_DEFAULTS, TRIGGER_LABELS, type AnimationBinding, type MotionPlanRecord, type MotionPresetId, type MotionSettings, type MotionTrigger } from '@shared/schemas/motion.ts';
import { applyChangeOps, type ChangeOp } from '@shared/schemas/proposal.ts';
import { describeBinding } from '@shared/motion/describe.ts';
import { listScreens, type ScreenEntity } from '@shared/motion/entities.ts';
import { CATEGORY_LABELS, MOTION_PRESETS, PRESETS_BY_CATEGORY, UNAVAILABLE_EFFECTS } from '@shared/motion/presets.ts';
import { bindingId, makeBinding } from '@shared/motion/suggest.ts';
import { validateBindings } from '@shared/motion/validate.ts';
import { motionPlanOps } from '@shared/plans.ts';
import { errorMessage } from '../../../lib/api.ts';
import { useJobsContext, useTrackedJob } from '../../../lib/jobs.tsx';
import { useAssets, useHealth, useManualEdit, usePreviewBundle, useProject, useProposalAction, type PreviewBundle } from '../../../lib/queries.ts';
import { Link } from '../../../lib/router.tsx';
import { useGrade, useMotionPlanAction, useMotionPlans, useStartMotionSuggest } from '../../../lib/studioQueries.ts';
import { Workspace } from '../../../components/shell/Workspace.tsx';
import { GamePreview, type PreviewHandle, type PreviewMotionMessage } from '../../../components/preview/GamePreview.tsx';
import { MotionPlanReview } from '../../../components/plans/PlanReview.tsx';
import { JobActivity } from '../../../components/JobActivity.tsx';
import { Button, Checkbox, Field, IconButton, Segmented, Select, Tabs, TextArea } from '../../../components/ui/controls.tsx';
import { Banner, EmptyState, Pill, Spinner } from '../../../components/ui/feedback.tsx';
import { useToast } from '../../../components/ui/overlay.tsx';
import { BindingEditor, triggersFor } from './BindingEditor.tsx';
import { MotionTimeline } from './MotionTimeline.tsx';

interface Drafts {
  /** New or edited bindings, by id. */
  upsert: Record<string, AnimationBinding>;
  /** Ids of bindings that are new (added in this draft). */
  added: string[];
  remove: string[];
  settings: Partial<MotionSettings>;
}

const EMPTY: Drafts = { upsert: {}, added: [], remove: [], settings: {} };

function draftOps(d: Drafts): ChangeOp[] {
  const ops: ChangeOp[] = [];
  for (const id of d.remove) ops.push({ op: 'remove-animation', id });
  for (const [field, value] of Object.entries(d.settings)) ops.push({ op: 'set-motion-setting', field: field as keyof MotionSettings, value });
  // Added bindings in dependency order so “after” always refers to something already present.
  const added = d.added.map((id) => d.upsert[id]!).filter(Boolean);
  const placed = new Set<string>();
  for (let guard = 0; placed.size < added.length && guard < added.length + 1; guard++) {
    for (const b of added) {
      if (placed.has(b.id) || (b.after && added.some((x) => x.id === b.after) && !placed.has(b.after))) continue;
      ops.push({ op: 'add-animation', binding: b, addAssets: [] });
      placed.add(b.id);
    }
  }
  for (const b of added) if (!placed.has(b.id)) ops.push({ op: 'add-animation', binding: b, addAssets: [] });
  for (const [id, b] of Object.entries(d.upsert)) if (!d.added.includes(id)) ops.push({ op: 'update-animation', binding: b, addAssets: [] });
  return ops;
}

const KIND_ICON: Record<string, string> = { sprite: '◆', image: '▣', card: '▭', target: '◎', control: '⏺', text: 'T', panel: '▤', list: '≡', mover: '➤', grid: '#', screen: '▢', shape: '◇', tray: '⊔' };

export function AnimateArea({ projectId }: { projectId: string }) {
  const project = useProject(projectId);
  const bundle = usePreviewBundle(projectId, null, Boolean(project.data?.currentVersionId));
  const assets = useAssets(projectId);
  const grade = useGrade(projectId);
  const plans = useMotionPlans(projectId);
  const health = useHealth();
  const edit = useManualEdit(projectId);
  const proposalAction = useProposalAction(projectId);
  const planAction = useMotionPlanAction(projectId);
  const suggest = useStartMotionSuggest(projectId);
  const { track } = useJobsContext();
  const toast = useToast();
  const preview = useRef<PreviewHandle>(null);
  const [screenId, setScreenId] = useState<string | null>(null);
  const [entityId, setEntityId] = useState<string | null>(null);
  const [tab, setTab] = useState<'animation' | 'effects' | 'claude'>('animation');
  const [drafts, setDrafts] = useState<Drafts>(EMPTY);
  const [editing, setEditing] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [rects, setRects] = useState<Array<{ id: string; x: number; y: number; w: number; h: number }>>([]);
  const [log, setLog] = useState<Array<{ kind: string; bindingId: string; reason: string | null; at: number }>>([]);
  const [paused, setPaused] = useState(false);
  const [rate, setRate] = useState<'0.5' | '1' | '2'>('1');
  const [sound, setSound] = useState(false);
  const [timeline, setTimeline] = useState(false);
  const [simTrigger, setSimTrigger] = useState<MotionTrigger>('scene-entered');
  const [planPreview, setPlanPreview] = useState<MotionPlanRecord | null>(null);
  const [pendingPlay, setPendingPlay] = useState<string | null>(null);
  const [request, setRequest] = useState('');
  const [askScope, setAskScope] = useState<'screen' | 'project'>('screen');
  const [lastJob, setLastJob] = useState<string | null>(null);
  const trackedJob = useTrackedJob(lastJob);
  const [lastProposal, setLastProposal] = useState<string | null>(null);

  const config = bundle.data?.config ?? null;
  const library = assets.data ?? [];

  // Draft (and plan preview) applied on top of the current version, client-side.
  const ops = useMemo(() => draftOps(drafts), [drafts]);
  const planOps = useMemo(() => (planPreview ? motionPlanOps(planPreview.plan, Object.fromEntries(Object.keys(planPreview.decisions).map((k) => [k, planPreview.decisions[k] === 'rejected' ? 'rejected' : 'accepted']))) : []), [planPreview]);
  const draft = useMemo(() => {
    if (!config) return null;
    const all = [...ops, ...planOps];
    if (all.length === 0) return { config, results: [] as ReturnType<typeof applyChangeOps>['results'], added: [] as string[] };
    const lib = new Map(library.map((a) => [a.id, a]));
    const withAssets = all.map((op) =>
      op.op === 'add-animation' || op.op === 'update-animation'
        ? { ...op, addAssets: [op.binding.assetId, op.binding.sound?.assetId].filter((id): id is string => Boolean(id) && !config.assets[id!] && lib.has(id!)).map((id) => toGameAsset(lib.get(id)!)) }
        : op,
    );
    const r = applyChangeOps(config, withAssets, { scope: { kind: 'project', sceneId: null } });
    const added = withAssets.flatMap((op) => ('addAssets' in op ? op.addAssets.map((a) => a.id) : []));
    return { config: r.changed && r.config ? r.config : config, results: r.results, added };
  }, [config, ops, planOps, library]);
  const view = draft?.config ?? null;
  const screens = useMemo(() => (view ? listScreens(view) : []), [view]);
  const screen = screens.find((s) => s.id === screenId) ?? screens[1] ?? screens[0] ?? null;
  const entity = screen?.entities.find((e) => e.id === entityId) ?? null;
  const previewBundle: PreviewBundle | undefined = useMemo(() => {
    if (!bundle.data || !view) return bundle.data;
    const known = new Set(bundle.data.assets.map((a) => a.id));
    const extra = (draft?.added ?? []).filter((id) => !known.has(id)).map((id) => ({ id, mime: view.assets[id]!.mime, url: `/api/assets/${id}/file?variant=display`, available: true }));
    return { ...bundle.data, config: view, assets: [...bundle.data.assets, ...extra] };
  }, [bundle.data, view, draft?.added]);
  useEffect(() => {
    if (!screenId && screen) setScreenId(screen.id);
  }, [screen, screenId]);

  const issues = useMemo(() => (view ? validateBindings(view) : []), [view]);
  // Only the creator's own draft rows (a previewed plan is applied from its own review).
  const refused = (draft?.results ?? []).filter((r) => r.index < ops.length && (r.status === 'invalid' || r.status === 'conflict'));
  const dirty = ops.length > 0;
  const profile = grade.data?.current?.profile ?? null;

  const onMotion = (m: PreviewMotionMessage) => {
    if (m.type === 'screen') {
      setScreenId(m.screenId);
      setRects([]);
    } else if (m.type === 'entities') {
      setRects(m.rects);
      if (pendingPlay) {
        preview.current?.motion('play', { bindingId: pendingPlay });
        setPendingPlay(null);
      }
    } else setLog((l) => [{ kind: m.kind, bindingId: m.bindingId, reason: m.reason, at: Date.now() }, ...l].slice(0, 30));
  };

  useEffect(() => {
    preview.current?.motion('rate', { value: Number(rate) });
  }, [rate]);
  useEffect(() => {
    preview.current?.motion('sound', { value: sound ? 1 : 0 });
  }, [sound]);

  const selectScreen = (id: string) => {
    setScreenId(id);
    setEntityId(null);
    setEditing(null);
    // The preview follows `startSceneId`; no explicit goto (it would navigate twice).
  };

  // Every binding carries its readable rule (stored with the version, shown in plans, logs and exports).
  const labelled = (b: AnimationBinding): AnimationBinding => {
    if (!view) return b;
    const others = view.motion.bindings.filter((x) => x.id !== b.id);
    return { ...b, label: describeBinding({ ...view, motion: { ...view.motion, bindings: [...others, b] } }, b).slice(0, 160) };
  };
  const upsert = (b: AnimationBinding) => setDrafts((d) => ({ ...d, upsert: { ...d.upsert, [b.id]: labelled(b) } }));
  const addPreset = (presetId: MotionPresetId) => {
    if (!view || !screen) return;
    const preset = MOTION_PRESETS[presetId];
    const target = preset.category === 'transition' ? 'screen' : entity && preset.targets.includes(entity.kind) ? entity.id : screen.entities.find((e) => preset.targets.includes(e.kind))?.id;
    if (!target) return toast({ tone: 'error', title: `${preset.label} has no suitable object on this screen` });
    const allowed = triggersFor(screen, presetId);
    const event = allowed.includes('scene-entered') ? 'scene-entered' : (allowed[0] ?? 'scene-entered');
    const taken = new Set([...view.motion.bindings.map((b) => b.id), ...Object.keys(drafts.upsert)]);
    // Feedback on a particular target or card runs only for that object (not for every drop on the screen).
    const targetKind = screen.entities.find((e) => e.id === target)?.kind;
    const entityFilter = (event === 'valid-drop' || event === 'object-selected') && (targetKind === 'target' || targetKind === 'card') ? target : null;
    const b = makeBinding(view, screen, { target, presetId, event, entity: entityFilter, control: event === 'control-activated' ? ((screen.controls[0] as never) ?? null) : null }, taken, 'creator');
    setDrafts((d) => ({ ...d, upsert: { ...d.upsert, [b.id]: labelled(b) }, added: [...d.added, b.id] }));
    setEditing(b.id);
    setPendingPlay(b.id);
  };
  const removeBinding = (id: string) =>
    setDrafts((d) => (d.added.includes(id) ? { ...d, added: d.added.filter((x) => x !== id), upsert: Object.fromEntries(Object.entries(d.upsert).filter(([k]) => k !== id)) } : { ...d, remove: [...new Set([...d.remove, id])], upsert: Object.fromEntries(Object.entries(d.upsert).filter(([k]) => k !== id)) }));

  const touched = new Set<string>([...Object.values(drafts.upsert).map((b) => b.screenId), ...drafts.remove.map((id) => config?.motion.bindings.find((b) => b.id === id)?.screenId ?? '')]);
  const scope = Object.keys(drafts.settings).length === 0 && touched.size === 1 ? { kind: 'scene' as const, sceneId: [...touched][0]! } : { kind: 'project' as const, sceneId: null };
  const apply = () => {
    if (!project.data?.currentVersionId || ops.length === 0) return;
    const where = scope.kind === 'scene' ? (screens.find((s) => s.id === scope.sceneId)?.label ?? scope.sceneId) : `${touched.size} screen(s)${Object.keys(drafts.settings).length ? ' and motion settings' : ''}`;
    edit.mutate(
      { baseVersionId: project.data.currentVersionId, ops, scope, summary: `Animation: ${ops.length} change(s) on ${where}` },
      {
        onSuccess: (r) => {
          setDrafts(EMPTY);
          setEditing(null);
          setLastProposal(r.proposal.id);
          toast({ tone: 'success', title: `Applied to ${where}`, detail: `Saved as version ${r.version.number}. Undo is available below.` });
        },
        onError: (e) => toast({ tone: 'error', title: 'Not applied', detail: `${errorMessage(e).message} ${errorMessage(e).hint ?? ''}` }),
      },
    );
  };
  const lock = (id: string, locked: boolean) => {
    if (!project.data?.currentVersionId) return;
    edit.mutate(
      { baseVersionId: project.data.currentVersionId, ops: [{ op: 'set-motion-lock', screenId: id, locked }], scope: { kind: 'scene', sceneId: id }, summary: `${locked ? 'Locked' : 'Unlocked'} motion on ${screens.find((s) => s.id === id)?.label ?? id}` },
      { onError: (e) => toast({ tone: 'error', title: 'Lock not changed', detail: errorMessage(e).message }) },
    );
  };

  if (bundle.isLoading || project.isLoading) {
    return (
      <div className="center-fill">
        <Spinner large label="Loading the game…" />
      </div>
    );
  }
  if (!config || !view || !screen) {
    return (
      <div className="center-fill">
        <EmptyState icon={<Clapperboard size={24} aria-hidden="true" />} title="Build the game to animate it" actions={<Link className="btn btn-primary" to={`/p/${projectId}/prepare`}>Go to Prepare</Link>}>
          Motion is attached to the objects of a playable version. Prepare my game can also stage motion for the first build.
        </EmptyState>
      </div>
    );
  }

  const screenBindings = view.motion.bindings.filter((b) => b.screenId === screen.id && (!entity || b.target === entity.id || b.trigger.entity === entity.id));
  const editingBinding = editing ? (drafts.upsert[editing] ?? view.motion.bindings.find((b) => b.id === editing) ?? null) : null;
  const locked = view.motion.lockedScreens.includes(screen.id);
  const claudeReady = health.data?.claude.state === 'configured';
  const sample = Boolean(project.data?.isSample);
  const visiblePlans = (plans.data ?? []).filter((p) => p.baseVersionId !== null).slice(0, 6);
  const simulate = () => {
    const ent = entity && (simTrigger === 'valid-drop' || simTrigger === 'object-selected') ? [entity.id] : [];
    const control = simTrigger === 'control-activated' ? (screen.controls[0] ?? null) : null;
    preview.current?.motion('fire', { trigger: { event: simTrigger, control, entities: ent } });
  };

  const left = (
    <div className="panel-body animate-left">
      <div className="panel-head">
        <h2>Screens</h2>
      </div>
      <ul className="screen-rows" aria-label="Screens">
        {screens.map((s) => {
          const n = view.motion.bindings.filter((b) => b.screenId === s.id).length;
          const isLocked = view.motion.lockedScreens.includes(s.id);
          return (
            <li key={s.id} className="row">
              <button type="button" className={`screen-row${s.id === screen.id ? ' is-selected' : ''}`} aria-current={s.id === screen.id ? 'true' : undefined} onClick={() => selectScreen(s.id)}>
                <span className="screen-row-title">{s.label}</span>
                <span className="subtle small">
                  {n} animation{n === 1 ? '' : 's'}
                  {isLocked ? ' · locked' : ''}
                </span>
              </button>
              <IconButton label={isLocked ? `Unlock motion on ${s.label}` : `Lock motion on ${s.label}`} size="sm" pressed={isLocked} onClick={() => lock(s.id, !isLocked)}>
                <Lock size={14} aria-hidden="true" />
              </IconButton>
            </li>
          );
        })}
      </ul>
      <div className="panel-head">
        <h2>Objects</h2>
        {entity && (
          <button type="button" className="link-btn small" onClick={() => setEntityId(null)}>
            Show all
          </button>
        )}
      </div>
      <ul className="entity-list" aria-label={`Objects on ${screen.label}`}>
        {screen.entities.map((e: ScreenEntity) => (
          <li key={e.id}>
            <button type="button" className={`entity-chip${e.id === entity?.id ? ' is-selected' : ''}`} aria-pressed={e.id === entity?.id} onClick={() => setEntityId(e.id === entity?.id ? null : e.id)}>
              <span className="entity-kind" aria-hidden="true">
                {KIND_ICON[e.kind] ?? '•'}
              </span>
              <span className="truncate">{e.label}</span>
              {e.kind === 'sprite' && <Pill tone="info" dot={false}>{e.clips.length} clip{e.clips.length === 1 ? '' : 's'}</Pill>}
              {e.staticImage && e.assetId && <Pill tone="neutral" dot={false}>static</Pill>}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );

  const center = (
    <div className="animate-center">
      <div className="context-chips row-wrap" aria-label="Selection">
        <span className="chip chip-scope">{screen.label}</span>
        <span className="chip">{entity ? `Object: ${entity.label}` : 'No object selected'}</span>
        <span className="chip">{profile ? gradeLabel(profile) : 'Grade not set'}</span>
        <span className="chip">Motion: {view.motion.profile} · {view.motion.pacing}</span>
        {locked && <Pill tone="warning">Motion locked</Pill>}
      </div>
      <div className="animate-stage">
        <GamePreview
          ref={preview}
          bundle={previewBundle}
          startSceneId={screen.id}
          fit="fit"
          editor
          title="Animate preview"
          onMotion={onMotion}
          onState={(s) => setPaused(s.paused)}
          overlay={(scale) =>
            rects
              .filter((r) => picking || r.id === entity?.id)
              .map((r) => (
                <button
                  key={r.id}
                  type="button"
                  tabIndex={picking ? 0 : -1}
                  className={`entity-box${r.id === entity?.id ? ' is-selected' : ''}${picking ? ' is-picking' : ''}`}
                  style={{ left: r.x * scale, top: r.y * scale, width: Math.max(8, r.w * scale), height: Math.max(8, r.h * scale) }}
                  aria-label={`Select ${screen.entities.find((e) => e.id === r.id)?.label ?? r.id}`}
                  onClick={() => {
                    setEntityId(r.id);
                    setPicking(false);
                  }}
                />
              ))
          }
        />
      </div>
      <div className="transport row-wrap" role="toolbar" aria-label="Preview controls">
        <Button size="sm" icon={<RotateCcw size={14} aria-hidden="true" />} onClick={() => preview.current?.motion('restart')}>
          Restart screen
        </Button>
        <Button size="sm" icon={paused ? <Play size={14} aria-hidden="true" /> : <Pause size={14} aria-hidden="true" />} onClick={() => (paused ? preview.current?.resume() : preview.current?.pause())}>
          {paused ? 'Resume' : 'Pause'}
        </Button>
        <Button size="sm" icon={<Square size={14} aria-hidden="true" />} onClick={() => preview.current?.motion('stop')}>
          Stop motion
        </Button>
        <Segmented
          label="Preview speed"
          value={rate}
          onChange={setRate}
          options={[
            { value: '0.5', label: '0.5×' },
            { value: '1', label: '1×' },
            { value: '2', label: '2×' },
          ]}
        />
        <IconButton label={sound ? 'Mute animation sounds in preview' : 'Play animation sounds in preview'} size="sm" pressed={sound} onClick={() => setSound((v) => !v)}>
          {sound ? <Volume2 size={15} aria-hidden="true" /> : <VolumeX size={15} aria-hidden="true" />}
        </IconButton>
        <IconButton label={picking ? 'Stop picking objects' : 'Pick an object on the stage'} size="sm" pressed={picking} onClick={() => (setPicking((p) => !p), preview.current?.motion('entities'))}>
          <Crosshair size={15} aria-hidden="true" />
        </IconButton>
        <span className="spacer" />
        <label className="row small">
          Simulate
          <Select aria-label="Event to simulate" value={simTrigger} onChange={(e) => setSimTrigger(e.target.value as MotionTrigger)}>
            {(['scene-entered', 'control-activated', 'instruction-advanced', 'object-selected', 'valid-drop', 'correct-answer', 'retry-requested', 'scene-completed'] as MotionTrigger[]).map((t) => (
              <option key={t} value={t}>
                {TRIGGER_LABELS[t]}
              </option>
            ))}
          </Select>
        </label>
        <Button size="sm" icon={<Zap size={14} aria-hidden="true" />} onClick={simulate}>
          Fire
        </Button>
        <IconButton label={timeline ? 'Hide timeline' : 'Show timeline'} size="sm" pressed={timeline} onClick={() => setTimeline((t) => !t)}>
          <GaugeCircle size={15} aria-hidden="true" />
        </IconButton>
      </div>
      <p className="subtle small sim-note">Simulation runs only the animations — it never submits answers, awards points, changes progress or plays sounds unless you turn them on.</p>
      {timeline && <MotionTimeline config={view} screen={screen} selectedId={editing} onSelect={(id) => setEditing(id)} />}
      {(dirty || lastProposal) && (
        <div className="draft-bar row-wrap" role="status">
          {dirty ? (
            <>
              <strong>{ops.length} unsaved change{ops.length === 1 ? '' : 's'}</strong>
              <span className="subtle small">{scope.kind === 'scene' ? `Scope: ${screens.find((s) => s.id === scope.sceneId)?.label}` : `Scope: whole game — ${touched.size} screen(s)${Object.keys(drafts.settings).length ? ' + settings' : ''}`}</span>
              {refused.length > 0 && <span className="small is-error">{refused.length} cannot be applied: {refused[0]!.message} Fix or remove {refused.length === 1 ? 'it' : 'them'} — changes are applied together or not at all.</span>}
              <span className="spacer" />
              <Button size="sm" variant="ghost" onClick={() => (setDrafts(EMPTY), setEditing(null))}>
                Discard
              </Button>
              <Button size="sm" variant="primary" loading={edit.isPending} disabled={refused.length > 0} onClick={apply}>
                Apply
              </Button>
            </>
          ) : (
            <>
              <span className="small">Last change applied.</span>
              <span className="spacer" />
              <Button
                size="sm"
                icon={<Undo2 size={14} aria-hidden="true" />}
                loading={proposalAction.isPending}
                onClick={() =>
                  proposalAction.mutate(
                    { id: lastProposal!, action: 'undo' },
                    { onSuccess: () => (setLastProposal(null), toast({ tone: 'success', title: 'Undone', detail: 'The previous motion is back as a new version.' })), onError: (e) => toast({ tone: 'error', title: 'Not undone', detail: `${errorMessage(e).message} ${errorMessage(e).hint ?? ''}` }) },
                  )
                }
              >
                Undo
              </Button>
            </>
          )}
        </div>
      )}
      {log.length > 0 && (
        <details className="motion-log">
          <summary className="small">Preview activity ({log.length})</summary>
          <ul className="plain-list small">
            {log.slice(0, 12).map((l, i) => (
              <li key={i}>
                {l.kind} · {(() => {
                  const b = view.motion.bindings.find((x) => x.id === l.bindingId);
                  return b ? describeBinding(view, b) : l.bindingId;
                })()}
                {l.reason ? <span className="subtle"> — {l.reason}</span> : null}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );

  const right = (
    <div className="panel-body animate-right">
      <Tabs
        label="Inspector"
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'animation', label: 'Animation', count: screenBindings.length },
          { value: 'effects', label: 'Effects' },
          { value: 'claude', label: 'Ask Claude' },
        ]}
      />
      {tab === 'animation' && (
        <div className="stack">
          {locked && <Banner tone="warning" title="Motion on this screen is locked">Unlock it in the screen list to change it. Claude proposals cannot change it either.</Banner>}
          {!editingBinding && (
            <>
              <ul className="binding-list">
                {screenBindings.map((b) => {
                  const draftNew = drafts.added.includes(b.id);
                  const changed = Boolean(drafts.upsert[b.id]) && !draftNew;
                  return (
                    <li key={b.id} className={`binding-item purpose-${b.purpose}${draftNew || changed ? ' is-draft' : ''}`}>
                      <p className="small">{describeBinding(view, b)}</p>
                      <div className="row-wrap">
                        <Pill tone={b.origin === 'claude' ? 'ai' : b.origin === 'creator' ? 'success' : 'info'} dot={false}>
                          {b.origin === 'claude' ? 'AI suggestion' : b.origin === 'creator' ? 'You' : b.origin === 'design-evidence' ? 'Design evidence' : b.origin === 'source' ? 'From the lesson' : 'Preset rule'}
                        </Pill>
                        <Pill tone="neutral" dot={false}>
                          {b.purpose}
                        </Pill>
                        {(draftNew || changed) && <Pill tone="warning">unsaved</Pill>}
                        {!b.enabled && <Pill tone="neutral">off</Pill>}
                        <span className="spacer" />
                        <IconButton label="Preview this animation" size="sm" onClick={() => preview.current?.motion('play', { bindingId: b.id })}>
                          <Eye size={14} aria-hidden="true" />
                        </IconButton>
                        <IconButton label={b.enabled ? 'Turn off' : 'Turn on'} size="sm" disabled={locked} onClick={() => upsert({ ...b, enabled: !b.enabled })}>
                          {b.enabled ? <EyeOff size={14} aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}
                        </IconButton>
                        <Button size="sm" variant="ghost" disabled={locked} onClick={() => setEditing(b.id)}>
                          Edit
                        </Button>
                        <IconButton label="Remove" size="sm" disabled={locked} onClick={() => removeBinding(b.id)}>
                          <Trash2 size={14} aria-hidden="true" />
                        </IconButton>
                      </div>
                    </li>
                  );
                })}
                {screenBindings.length === 0 && <li className="subtle small">No animations {entity ? `on ${entity.label}` : 'on this screen'} yet.</li>}
              </ul>
              <section aria-labelledby="add-anim" className="stack-tight">
                <h3 id="add-anim" className="h-sub-sm">
                  <Plus size={15} aria-hidden="true" /> Add {entity ? `to ${entity.label}` : 'an animation'}
                </h3>
                {PRESETS_BY_CATEGORY.map((g) => (
                  <div key={g.category} className="preset-group">
                    <span className="subtle small">{CATEGORY_LABELS[g.category]}</span>
                    <div className="row-wrap">
                      {g.presets.map((p) => {
                        const fits = entity ? p.targets.includes(entity.kind) || p.category === 'transition' : screen.entities.some((e) => p.targets.includes(e.kind));
                        const needsClip = p.requiresClip && entity && entity.staticImage && p.id === 'character-clip';
                        return (
                          <Button key={p.id} size="sm" disabled={locked || !fits || Boolean(needsClip)} title={!fits ? `Not for ${entity?.kind ?? 'these objects'}` : needsClip ? 'A static picture has no frames: it can only move, fade, scale or rotate as a whole.' : p.summary} onClick={() => addPreset(p.id)}>
                            {p.label}
                          </Button>
                        );
                      })}
                    </div>
                  </div>
                ))}
                {entity?.staticImage && entity.assetId && <p className="subtle small">{entity.label} is a static picture: it can move, fade, scale or rotate as a whole. Upload frames or a sprite sheet and set up clips in Assets for waving or walking.</p>}
              </section>
            </>
          )}
          {editingBinding && (
            <div className="stack">
              <div className="row">
                <h3 className="h-sub-sm">{MOTION_PRESETS[editingBinding.presetId].label}</h3>
                <span className="spacer" />
                <Button size="sm" variant="ghost" icon={<Eye size={14} aria-hidden="true" />} onClick={() => preview.current?.motion('play', { bindingId: editingBinding.id })}>
                  Preview
                </Button>
                <Button size="sm" onClick={() => setEditing(null)}>
                  Done
                </Button>
              </div>
              <BindingEditor binding={editingBinding} config={view} screen={screen} assets={library} onChange={upsert} />
            </div>
          )}
          {issues.some((i) => i.screenId === screen.id) && (
            <Banner tone={issues.some((i) => i.screenId === screen.id && i.severity === 'error') ? 'danger' : 'warning'} title="Checks">
              {issues
                .filter((i) => i.screenId === screen.id)
                .sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1))
                .slice(0, 4)
                .map((i, k) => (
                  <p key={k} className="small">
                    {i.severity === 'error' ? 'Error: ' : 'Warning: '}
                    {i.message}
                  </p>
                ))}
            </Banner>
          )}
        </div>
      )}
      {tab === 'effects' && <EffectsPanel config={view} onChange={(patch) => setDrafts((d) => ({ ...d, settings: { ...d.settings, ...patch } }))} />}
      {tab === 'claude' && (
        <div className="stack">
          <p className="muted small">Tell Claude which asset, on which screen, should do what, and when. References are resolved into the screen and object chips below before anything changes; you review every row.</p>
          <div className="row-wrap">
            <span className="chip chip-scope">{askScope === 'screen' ? screen.label : 'Whole game'}</span>
            {entity && <span className="chip">{entity.label}</span>}
          </div>
          <Segmented
            label="Scope"
            value={askScope}
            onChange={setAskScope}
            options={[
              { value: 'screen', label: 'This screen' },
              { value: 'project', label: 'Whole game' },
            ]}
          />
          {askScope === 'project' && <p className="subtle small">Whole-game proposals list every screen they touch; nothing outside them changes.</p>}
          <Field label="Request" htmlFor="motion-request">
            <TextArea id="motion-request" rows={4} maxLength={1500} value={request} placeholder="On this screen, play Swiftee's wave when the screen opens, then reveal the instruction panel. Keep the shapes stationary." onChange={(e) => setRequest(e.target.value)} />
          </Field>
          <div className="row-wrap">
            <Button
              variant="ai"
              icon={<Sparkles size={15} aria-hidden="true" />}
              disabled={!request.trim() || (!claudeReady && !sample)}
              loading={suggest.isPending}
              onClick={() =>
                suggest.mutate(
                  { scope: { kind: askScope, screenId: askScope === 'screen' ? screen.id : null }, request: `${request.trim()}${entity ? `\n\nSelected object: ${entity.label} [${entity.id}] on ${screen.label}.` : ''}`, engine: 'claude', baseVersionId: project.data?.currentVersionId ?? null },
                  { onSuccess: (r) => (track(r.job), setLastJob(r.job.id)), onError: (e) => toast({ tone: 'error', title: 'Not sent', detail: `${errorMessage(e).message} ${errorMessage(e).hint ?? ''}` }) },
                )
              }
            >
              Ask
            </Button>
            <Button
              icon={<Sparkles size={15} aria-hidden="true" />}
              loading={suggest.isPending}
              onClick={() =>
                suggest.mutate(
                  { scope: { kind: 'screen', screenId: screen.id }, request: '', engine: claudeReady ? 'auto' : 'rules', baseVersionId: project.data?.currentVersionId ?? null },
                  { onSuccess: (r) => (track(r.job), setLastJob(r.job.id)), onError: (e) => toast({ tone: 'error', title: 'Not started', detail: errorMessage(e).message }) },
                )
              }
            >
              Suggest motion for this screen
            </Button>
          </div>
          <p className="subtle small">{claudeReady ? 'Uses Claude (costs tokens).' : sample ? 'Claude is not configured: the bundled sample replays prepared demo answers; “Suggest” uses the preset rules.' : 'Claude is not configured: “Suggest” uses the preset rules (no AI); written requests need Claude.'}</p>
          {trackedJob && trackedJob.job.status !== 'succeeded' && <JobActivity job={trackedJob.job} compact />}
          {visiblePlans.map((p) => (
            <MotionPlanReview
              key={p.id}
              plan={p}
              config={config}
              busy={planAction.isPending}
              onDecide={(decisions) => planAction.mutate({ id: p.id, action: 'decisions', decisions }, { onError: (e) => toast({ tone: 'error', title: 'Not saved', detail: errorMessage(e).message }) })}
              onEdit={(b) => {
                // Take the row over as your own draft; the plan row is declined so it is never applied twice.
                const taken = new Set([...view.motion.bindings.map((x) => x.id), ...Object.keys(drafts.upsert)]);
                const id = taken.has(b.id) ? bindingId(b.screenId, b.presetId, taken) : b.id;
                const after = b.after && view.motion.bindings.some((x) => x.id === b.after) ? b.after : null;
                const own: AnimationBinding = labelled({ ...b, id, after });
                setDrafts((d) => ({ ...d, upsert: { ...d.upsert, [id]: own }, added: [...d.added, id] }));
                setPlanPreview(null);
                setScreenId(b.screenId);
                setEntityId(null);
                setTab('animation');
                setEditing(id);
                planAction.mutate({ id: p.id, action: 'decisions', decisions: { [b.id]: 'rejected' } }, { onError: (e) => toast({ tone: 'error', title: 'Plan not updated', detail: errorMessage(e).message }) });
              }}
              onPreview={(b) => {
                if (planPreview?.id === p.id && b.screenId === screen.id) return void preview.current?.motion('play', { bindingId: b.id });
                setPlanPreview(p);
                setScreenId(b.screenId);
                setPendingPlay(b.id);
              }}
              actions={
                p.status === 'proposed' ? (
                  <>
                    <Button size="sm" variant={planPreview?.id === p.id ? 'primary' : 'default'} icon={<Eye size={14} aria-hidden="true" />} onClick={() => setPlanPreview(planPreview?.id === p.id ? null : p)}>
                      {planPreview?.id === p.id ? 'Previewing — stop' : 'Preview plan'}
                    </Button>
                    <Button
                      size="sm"
                      variant="primary"
                      loading={planAction.isPending}
                      disabled={!Object.values(p.decisions).includes('accepted') || dirty}
                      title={dirty ? 'Apply or discard your own unsaved changes first.' : undefined}
                      onClick={() =>
                        planAction.mutate(
                          { id: p.id, action: 'apply' },
                          {
                            onSuccess: (r) => {
                              setPlanPreview(null);
                              if (r.proposal) setLastProposal(r.proposal.id);
                              toast({ tone: 'success', title: 'Motion plan applied', detail: 'Saved as a new version. Undo is available.' });
                            },
                            onError: (e) => toast({ tone: 'error', title: 'Not applied', detail: `${errorMessage(e).message} ${errorMessage(e).hint ?? ''}` }),
                          },
                        )
                      }
                    >
                      Apply accepted rows
                    </Button>
                    <Button size="sm" variant="ghost" icon={<Ban size={14} aria-hidden="true" />} onClick={() => planAction.mutate({ id: p.id, action: 'reject' })}>
                      Reject
                    </Button>
                  </>
                ) : p.status === 'applied' && p.proposalId ? (
                  <Button size="sm" icon={<Undo2 size={14} aria-hidden="true" />} onClick={() => proposalAction.mutate({ id: p.proposalId!, action: 'undo' }, { onError: (e) => toast({ tone: 'error', title: 'Not undone', detail: `${errorMessage(e).message} ${errorMessage(e).hint ?? ''}` }) })}>
                    Undo
                  </Button>
                ) : null
              }
            />
          ))}
        </div>
      )}
    </div>
  );

  return <Workspace leftLabel="Screens & objects" left={left} center={center} right={right} rightLabel="Inspector" />;
}

function EffectsPanel({ config, onChange }: { config: NonNullable<PreviewBundle['config']>; onChange: (patch: Partial<MotionSettings>) => void }) {
  const m = config.motion;
  return (
    <div className="stack">
      <Field label={MOTION_SETTING_LABELS.profile} htmlFor="fx-profile" help="Overridable starting points. Instructional movement and decoration are separate.">
        <Segmented
          label="Motion profile"
          value={m.profile}
          onChange={(v) => onChange({ profile: v, ...PROFILE_DEFAULTS[v] })}
          options={[
            { value: 'minimal', label: 'Minimal' },
            { value: 'guided', label: 'Guided' },
            { value: 'playful', label: 'Playful' },
          ]}
        />
      </Field>
      <Field label="Pacing" htmlFor="fx-pacing">
        <Segmented
          label="Pacing"
          value={m.pacing}
          onChange={(v) => onChange({ pacing: v })}
          options={[
            { value: 'calm', label: 'Calm' },
            { value: 'standard', label: 'Standard' },
          ]}
        />
      </Field>
      <Field label="Decorative effects" htmlFor="fx-deco" help="Off keeps instructional and feedback motion only.">
        <Segmented
          label="Decorative effects"
          value={m.decorativeIntensity}
          onChange={(v) => onChange({ decorativeIntensity: v })}
          options={[
            { value: 'off', label: 'Off' },
            { value: 'low', label: 'Low' },
            { value: 'standard', label: 'Standard' },
          ]}
        />
      </Field>
      <Checkbox label="Animation sounds" hint="Uploaded or bundled audio only; captions stay in the panel." checked={m.sound} onChange={(v) => onChange({ sound: v })} />
      <Field label="Reduced motion" htmlFor="fx-reduced">
        <Select id="fx-reduced" value={m.reducedMotion} onChange={(e) => onChange({ reducedMotion: e.target.value as MotionSettings['reducedMotion'] })}>
          <option value="follow-device">Follow the learner's device setting</option>
          <option value="always">Always use reduced motion</option>
        </Select>
      </Field>
      <Checkbox label="Low-effects mode" hint="No particles; fewer animations at once." checked={m.lowEffects} onChange={(v) => onChange({ lowEffects: v })} />
      <section className="unavailable" aria-labelledby="unavail-title">
        <h3 id="unavail-title" className="h-sub-sm">
          Not available (and why)
        </h3>
        <ul className="plain-list small">
          {UNAVAILABLE_EFFECTS.map((u) => (
            <li key={u.id}>
              <strong>{u.label}</strong> — {u.reason} <span className="subtle">Instead: {u.alternative}</span>
            </li>
          ))}
        </ul>
      </section>
      <p className="subtle small">No frame-rate or accessibility-compliance claims are made; measure on the learners' devices.</p>
    </div>
  );
}
