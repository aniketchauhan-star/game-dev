import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, CircleCheck, Gamepad2, History, Maximize2, Pause, Play, RotateCcw, Volume2, VolumeX, X } from 'lucide-react';
import { checkInteraction } from '@shared/attainability.ts';
import { gameConfigSchema, type GameConfig, type GameScene } from '@shared/schemas/game.ts';
import type { ChangeOp } from '@shared/schemas/proposal.ts';
import type { PreviewToParent } from '@shared/schemas/preview.ts';
import { SCENE_TYPES } from '@shared/registry.ts';
import { useRouter } from '../../../lib/router.tsx';
import { useBlueprints, useManualEdit, usePreviewBundle, useProject, useRestoreVersion, useStartJob, useVersions } from '../../../lib/queries.ts';
import { useJobsContext, useProjectJobs } from '../../../lib/jobs.tsx';
import { useSaveStatus } from '../../../lib/saveStatus.tsx';
import { errorMessage, newIdempotencyKey } from '../../../lib/api.ts';
import { formatTime } from '../../../lib/format.ts';
import { Workspace } from '../../../components/shell/Workspace.tsx';
import { ClaudePanel } from '../../../components/claude/ClaudePanel.tsx';
import { Button, IconButton, Segmented, Select, Switch } from '../../../components/ui/controls.tsx';
import { Banner, DemoBadge, EmptyState, Pill, Spinner } from '../../../components/ui/feedback.tsx';
import { useToast } from '../../../components/ui/overlay.tsx';
import { GamePreview, type FitMode, type PreviewHandle, type PreviewState } from '../../../components/preview/GamePreview.tsx';
import { SceneThumb } from '../../../components/scenes/SceneThumb.tsx';
import { JobActivity } from '../../../components/JobActivity.tsx';

type LogEntry = { at: string; text: string; tone: 'info' | 'ok' | 'bad' };

function QuickEdits({ config, scene, versionId, projectId, disabled }: { config: GameConfig; scene: GameScene; versionId: string; projectId: string; disabled: boolean }) {
  const edit = useManualEdit(projectId);
  const { track } = useSaveStatus();
  const toast = useToast();
  const apply = (ops: ChangeOp[], summary: string) =>
    void track(() => edit.mutateAsync({ baseVersionId: versionId, ops, scope: { kind: 'scene', sceneId: scene.id }, summary })).catch((e) =>
      toast({ tone: 'error', title: 'Change not applied', detail: `${errorMessage(e).message} ${errorMessage(e).hint ?? ''}` }),
    );
  const set = (field: Extract<ChangeOp, { op: 'set-scene-field' }>['field'], value: unknown, summary: string) => apply([{ op: 'set-scene-field', sceneId: scene.id, field, value }], summary);
  const i = scene.interaction;
  const layoutLocked = scene.locks.layout || disabled;
  return (
    <div className="quick-edits stack">
      <h3 className="h-sub-sm">Quick edits · scene</h3>
      <p className="subtle small">Each change creates a new version; locks are respected.</p>
      <div className="field">
        <span className="field-label">Instruction panel</span>
        <Segmented label="Instruction position" value={scene.layout.instructionPosition} onChange={(v) => !layoutLocked && set('layout.instructionPosition', v, `Instruction panel to the ${v}`)} options={[{ value: 'top', label: 'Top' }, { value: 'left', label: 'Left' }, { value: 'bottom', label: 'Bottom' }]} />
      </div>
      <div className="field">
        <span className="field-label">Density</span>
        <Segmented label="Density" value={scene.layout.density} onChange={(v) => !layoutLocked && set('layout.density', v, `Layout density: ${v}`)} options={[{ value: 'comfortable', label: 'Comfortable' }, { value: 'compact', label: 'Compact' }]} />
      </div>
      <Switch label="Show progress" checked={scene.layout.showProgress} disabled={layoutLocked} onChange={(v) => set('layout.showProgress', v, v ? 'Show progress' : 'Hide progress')} />
      {i.type === 'coordinate-navigation' && (
        <>
          <Switch label="Bold grid" checked={i.display.gridEmphasis === 'high'} disabled={disabled} onChange={(v) => set('interaction.display', { ...i.display, gridEmphasis: v ? 'high' : 'standard' }, v ? 'Bold grid lines' : 'Standard grid lines')} />
          <Switch label="Large points & labels" checked={i.display.pointSize === 'large'} disabled={disabled} onChange={(v) => set('interaction.display', { ...i.display, pointSize: v ? 'large' : 'standard', labelSize: v ? 'large' : 'standard' }, v ? 'Larger points and labels' : 'Standard points and labels')} />
          <Switch label="Coordinate readout" checked={i.showCoordinateReadout} disabled={disabled} onChange={(v) => set('interaction.showCoordinateReadout', v, v ? 'Show coordinate readout' : 'Hide coordinate readout')} />
        </>
      )}
      {i.type === 'drag-match' && (
        <div className="field">
          <span className="field-label">Item tray</span>
          <Segmented label="Tray position" value={i.trayPosition} onChange={(v) => !layoutLocked && set('interaction.trayPosition', v, `Tray ${v}`)} options={[{ value: 'bottom', label: 'Below' }, { value: 'left', label: 'Left' }]} />
        </div>
      )}
      {i.type === 'sequence-sort' && (
        <>
          <div className="field">
            <span className="field-label">Orientation</span>
            <Segmented label="Orientation" value={i.orientation} onChange={(v) => !layoutLocked && set('interaction.orientation', v, `Cards in a ${v === 'horizontal' ? 'row' : 'column'}`)} options={[{ value: 'horizontal', label: 'Row' }, { value: 'vertical', label: 'Column' }]} />
          </div>
          <Switch label="Show values" checked={i.showValues} disabled={disabled} onChange={(v) => set('interaction.showValues', v, v ? 'Show values on cards' : 'Hide values on cards')} />
        </>
      )}
      <Switch
        label="Reduced motion (whole game)"
        checked={config.settings.reducedMotion}
        disabled={disabled}
        onChange={(v) => apply([{ op: 'set-project-field', field: 'settings.reducedMotion', value: v }], v ? 'Reduced motion on' : 'Reduced motion off')}
      />
    </div>
  );
}

function Diagnostics({ config, log, previewState, versionLabel }: { config: GameConfig; log: LogEntry[]; previewState: PreviewState | null; versionLabel: string }) {
  const checks = useMemo(() => {
    const schema = gameConfigSchema.safeParse(config);
    const scenes = config.scenes.map((s, i) => ({ s, i, issues: checkInteraction(s.interaction, { seed: config.settings.seed, sceneId: s.id }) }));
    return { schemaOk: schema.success, schemaError: schema.success ? null : (schema.error.issues[0]?.message ?? 'invalid'), scenes };
  }, [config]);
  return (
    <div className="diagnostics">
      <div className="diag-col">
        <h3 className="h-sub-sm">Checks</h3>
        <ul className="diag-list">
          <li className={checks.schemaOk ? 'ok' : 'bad'}>{checks.schemaOk ? 'Configuration matches the GameConfig schema' : `Schema problem: ${checks.schemaError}`}</li>
          {checks.scenes.map(({ s, i, issues }) => (
            <li key={s.id} className={issues.some((x) => x.severity === 'error') ? 'bad' : issues.length ? 'warn' : 'ok'}>
              Scene {i + 1} ({SCENE_TYPES[s.interaction.type].label}): {issues.length ? issues.map((x) => x.message).join(' ') : 'completable'}
            </li>
          ))}
        </ul>
        <p className="subtle small">
          {versionLabel} · runtime {config.meta.runtimeVersion} · seed {config.settings.seed}
          {previewState?.error ? ` · runtime error: ${previewState.error}` : ''}
        </p>
      </div>
      <div className="diag-col">
        <h3 className="h-sub-sm">Playtest events</h3>
        {log.length === 0 ? (
          <p className="subtle small">Play the game to see scene starts, attempts and hints here. Events stay in the studio — the game never stores them.</p>
        ) : (
          <ol className="diag-log">
            {log.slice(-60).map((e, k) => (
              <li key={k} className={e.tone}>
                <time>{formatTime(e.at)}</time> {e.text}
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

export function BuildArea({ projectId }: { projectId: string }) {
  const { search, navigate } = useRouter();
  const project = useProject(projectId);
  const versions = useVersions(projectId);
  const blueprints = useBlueprints(projectId);
  const restore = useRestoreVersion(projectId);
  const start = useStartJob(projectId);
  const { track } = useJobsContext();
  const jobs = useProjectJobs(projectId);
  const toast = useToast();
  const viewVersion = search.get('version');
  const play = search.get('play') === '1';
  const bundle = usePreviewBundle(projectId, viewVersion, Boolean(project.data?.currentVersionId));
  const previewRef = useRef<PreviewHandle>(null);
  const [fit, setFit] = useState<FitMode>('fit');
  const [selected, setSelected] = useState<string | null>(null);
  const [diagOpen, setDiagOpen] = useState(false);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [completed, setCompleted] = useState<Set<string>>(new Set());
  const [pstate, setPstate] = useState<PreviewState | null>(null);
  const config = bundle.data?.config;
  const isCurrent = !viewVersion || viewVersion === project.data?.currentVersionId;
  const current = (versions.data?.versions ?? []).find((v) => v.id === (viewVersion ?? versions.data?.currentVersionId));
  const buildJob = jobs.find((t) => t.job.type === 'build');
  const approved = (blueprints.data ?? []).find((r) => r.status === 'approved');
  const scene = config?.scenes.find((s) => s.id === selected) ?? null;

  useEffect(() => {
    if (config && (!selected || !config.scenes.some((s) => s.id === selected))) setSelected(config.scenes[0]?.id ?? null);
  }, [config, selected]);
  useEffect(() => {
    setLog([]);
    setCompleted(new Set());
  }, [bundle.data?.version.id]);

  const onEvent = (m: Extract<PreviewToParent, { type: 'progress' | 'error' }>) => {
    const at = new Date().toISOString();
    if (m.type === 'error') return setLog((l) => [...l, { at, text: `Runtime error: ${m.message}`, tone: 'bad' }]);
    const sceneName = config?.scenes.find((s) => s.id === m.sceneId)?.title ?? '';
    const text =
      m.event === 'attempt'
        ? `${sceneName}: attempt ${m.attempt} — ${m.correct ? 'correct' : 'not yet'}`
        : m.event === 'hint'
          ? `${sceneName}: hint ${m.hintLevel} used`
          : m.event === 'scene-started'
            ? `Started “${sceneName}”`
            : m.event === 'scene-completed'
              ? `Completed “${sceneName}”`
              : m.event === 'game-completed'
                ? 'Reached the completion screen'
                : m.event === 'title-shown'
                  ? 'Title screen'
                  : 'Restarted';
    if (m.event === 'scene-completed' && m.sceneId) setCompleted((c) => new Set(c).add(m.sceneId!));
    if (m.event === 'scene-started' && m.sceneId) setSelected(m.sceneId);
    setLog((l) => [...l, { at, text, tone: m.event === 'attempt' ? (m.correct ? 'ok' : 'bad') : 'info' }]);
  };

  if (!project.data) {
    return (
      <div className="center-fill">
        <Spinner large label="Loading…" />
      </div>
    );
  }

  const refine = (
    <ClaudePanel
      projectId={projectId}
      area="build"
      mode="refine"
      baseVersionId={isCurrent ? (project.data.currentVersionId ?? null) : null}
      scopes={[...(scene ? [{ scope: { kind: 'scene' as const, sceneId: scene.id, slideId: null }, label: `Selected scene: ${scene.title}` }] : []), { scope: { kind: 'project' as const, sceneId: null, slideId: null }, label: 'Whole project' }]}
      examples={['Make this screen less cluttered', 'Move the instruction panel to the top', 'Keep the characters but change the background', 'Make the grid and points easier to see']}
    />
  );

  if (!project.data.currentVersionId) {
    return (
      <Workspace
        leftLabel="Scenes"
        left={<div className="panel-body subtle small pad">No playable version yet.</div>}
        center={
          <div className="canvas-inner">
            {buildJob && <JobActivity job={buildJob.job} />}
            <EmptyState
              icon={<Gamepad2 size={26} aria-hidden="true" />}
              title="Nothing to play yet"
              actions={
                approved ? (
                  <Button
                    variant="primary"
                    icon={<Gamepad2 size={16} aria-hidden="true" />}
                    loading={start.isPending}
                    onClick={() =>
                      start.mutate(
                        { type: 'build', input: { blueprintRevisionId: approved.id }, key: newIdempotencyKey() },
                        { onSuccess: (r) => track(r.job), onError: (e) => toast({ tone: 'error', title: 'Build did not start', detail: errorMessage(e).message }) },
                      )
                    }
                  >
                    Build from approved r{approved.number}
                  </Button>
                ) : (
                  <Button variant="primary" onClick={() => navigate(`/p/${projectId}/blueprint`)}>
                    Go to the blueprint
                  </Button>
                )
              }
            >
              {approved ? 'The approved blueprint is ready. Building uses exactly that revision with the trusted game templates — no AI call.' : 'Approve a blueprint first. Builds always use an approved, immutable revision.'}
            </EmptyState>
          </div>
        }
        right={refine}
      />
    );
  }

  const controls = (
    <div className="preview-controls" role="toolbar" aria-label="Preview controls">
      <Button size="sm" icon={pstate?.paused ? <Play size={14} aria-hidden="true" /> : <Pause size={14} aria-hidden="true" />} onClick={() => (pstate?.paused ? previewRef.current?.resume() : previewRef.current?.pause())}>
        {pstate?.paused ? 'Resume' : 'Pause'}
      </Button>
      <Button size="sm" icon={<RotateCcw size={14} aria-hidden="true" />} onClick={() => previewRef.current?.restart()}>
        Restart
      </Button>
      <Select aria-label="Jump to scene" value={pstate?.sceneId ?? ''} onChange={(e) => previewRef.current?.goto(e.target.value || null)} style={{ width: 'auto', minHeight: 36 }}>
        <option value="">Title screen</option>
        {config?.scenes.map((s, i) => (
          <option key={s.id} value={s.id}>
            {i + 1}. {s.title}
          </option>
        ))}
      </Select>
      <IconButton label={pstate?.muted ? 'Unmute' : 'Mute'} size="sm" bordered onClick={() => previewRef.current?.setMuted(!pstate?.muted)}>
        {pstate?.muted ? <VolumeX size={15} aria-hidden="true" /> : <Volume2 size={15} aria-hidden="true" />}
      </IconButton>
      <span className="spacer" />
      <Segmented label="Fit" value={fit} onChange={setFit} options={[{ value: 'fit', label: 'Fit' }, { value: '50', label: '50%' }, { value: '75', label: '75%' }, { value: '100', label: '100%' }]} />
      <IconButton label="Play full screen" size="sm" bordered onClick={() => navigate(`/p/${projectId}/build?play=1${viewVersion ? `&version=${viewVersion}` : ''}`)}>
        <Maximize2 size={15} aria-hidden="true" />
      </IconButton>
    </div>
  );

  const left = (
    <div className="scene-list">
      <div className="panel-head">
        <h2>Scenes</h2>
        {current && <span className="subtle small">v{current.number}</span>}
      </div>
      <ol className="scene-items">
        {config?.scenes.map((s, i) => (
          <li key={s.id} className={`scene-item${s.id === selected ? ' is-selected' : ''}`}>
            <button type="button" className="scene-item-main" aria-current={s.id === selected ? 'true' : undefined} onClick={() => setSelected(s.id)}>
              <span className="scene-num tabular">{i + 1}</span>
              <span className="scene-item-text">
                <span className="scene-item-title">{s.title}</span>
                <span className="scene-item-type subtle small">{SCENE_TYPES[s.interaction.type].label}</span>
              </span>
              {completed.has(s.id) && (
                <span className="meta-ok" title="Completed in this playtest">
                  <CircleCheck size={14} aria-hidden="true" />
                  <span className="sr-only">Completed in this playtest</span>
                </span>
              )}
            </button>
          </li>
        ))}
      </ol>
      {config && scene && current && <QuickEdits config={config} scene={scene} versionId={current.id} projectId={projectId} disabled={!isCurrent} />}
    </div>
  );

  const center = (
    <div className="build-canvas">
      {(!isCurrent || bundle.data?.version.demo || (buildJob && buildJob.job.status !== 'succeeded')) && (
        <div className="build-banners">
          {!isCurrent && current && (
            <Banner
              tone="info"
              title={`Viewing version ${current.number} (not current)`}
              actions={
                <>
                  <Button size="sm" variant="primary" icon={<History size={14} aria-hidden="true" />} loading={restore.isPending} onClick={() => restore.mutate(current.id, { onSuccess: () => navigate(`/p/${projectId}/build`) })}>
                    Restore as new version
                  </Button>
                  <Button size="sm" onClick={() => navigate(`/p/${projectId}/build`)}>
                    Back to current
                  </Button>
                </>
              }
            >
              {current.summary}
            </Banner>
          )}
          {buildJob && buildJob.job.status !== 'succeeded' && <JobActivity job={buildJob.job} compact />}
        </div>
      )}
      <div className="build-toolbar">
        <div className="row-wrap">
          <strong>{config?.title}</strong>
          {current && <Pill tone="info">v{current.number}</Pill>}
          {bundle.data?.version.demo && <DemoBadge />}
          {current && <span className="subtle small">{current.summary}</span>}
        </div>
        {controls}
      </div>
      <div className="stage-area">
        {bundle.isError ? (
          <Banner tone="danger" title="The preview data could not be loaded">
            {errorMessage(bundle.error).message}
          </Banner>
        ) : play ? (
          <p className="subtle small">Playing in full screen.</p>
        ) : (
          <GamePreview ref={previewRef} bundle={bundle.data} fit={fit} onEvent={onEvent} onState={setPstate} title={config?.title} />
        )}
      </div>
      <div className="scene-strip" role="list" aria-label="Scene strip">
        {config?.scenes.map((s, i) => (
          <button
            key={s.id}
            type="button"
            role="listitem"
            className={`strip-item${pstate?.sceneId === s.id ? ' is-playing' : ''}${selected === s.id ? ' is-selected' : ''}`}
            onClick={() => {
              setSelected(s.id);
              previewRef.current?.goto(s.id);
            }}
            aria-label={`Play scene ${i + 1}: ${s.title}`}
          >
            <SceneThumb interaction={s.interaction} />
            <span className="strip-label">
              {i + 1}. {s.title}
              {completed.has(s.id) && <CircleCheck size={12} aria-label="played" />}
            </span>
          </button>
        ))}
      </div>
      <section className={`diag-panel${diagOpen ? ' is-open' : ''}`}>
        <button type="button" className="diag-toggle" aria-expanded={diagOpen} onClick={() => setDiagOpen((o) => !o)}>
          Diagnostics {log.length > 0 && <span className="subtle small">· {log.length} {log.length === 1 ? 'event' : 'events'}</span>}
          {pstate?.error && <Pill tone="danger">Runtime error</Pill>}
          <span className="spacer" />
          {diagOpen ? <ChevronDown size={16} aria-hidden="true" /> : <ChevronUp size={16} aria-hidden="true" />}
        </button>
        {diagOpen && config && <Diagnostics config={config} log={log} previewState={pstate} versionLabel={current ? `Version ${current.number}${current.blueprintRevisionNumber ? ` from blueprint r${current.blueprintRevisionNumber}` : ''}` : ''} />}
      </section>
      {play && (
        <div className="playtest" role="dialog" aria-modal="true" aria-label="Playtest">
          <div className="playtest-bar">
            <strong>{config?.title}</strong>
            {current && <span className="subtle small">v{current.number}</span>}
            <span className="spacer" />
            <Button size="sm" icon={<RotateCcw size={14} aria-hidden="true" />} onClick={() => previewRef.current?.restart()}>
              Restart
            </Button>
            <IconButton label="Close playtest" bordered onClick={() => navigate(`/p/${projectId}/build${viewVersion ? `?version=${viewVersion}` : ''}`)}>
              <X size={16} aria-hidden="true" />
            </IconButton>
          </div>
          <div className="playtest-stage">
            <GamePreview ref={previewRef} bundle={bundle.data} fit="fit" onEvent={onEvent} onState={setPstate} title={config?.title} />
          </div>
        </div>
      )}
    </div>
  );

  return <Workspace leftLabel="Scenes" left={left} center={center} right={refine} />;
}
