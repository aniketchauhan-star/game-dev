import { useEffect, useMemo, useRef, useState } from 'react';
import { CircleAlert, CircleCheck, Columns2, History, Layers, LayoutTemplate, Save, TriangleAlert } from 'lucide-react';
import { toGameAsset } from '@shared/assetsToGame.ts';
import { frameToStage } from '@shared/schemas/design.ts';
import { applyChangeOps, type ChangeOp } from '@shared/schemas/proposal.ts';
import type { ScreenMapEntry, SourceScreenMapping } from '@shared/schemas/screens.ts';
import { computeScreenLayout, primaryFrame, validateMapping, type LayoutContext } from '@shared/screens/layout.ts';
import { errorMessage } from '../../../lib/api.ts';
import { useAssets, useBlueprints, usePreviewBundle, useProject, useSlides, type PreviewBundle } from '../../../lib/queries.ts';
import { useDesignFrames, useSaveScreenMap, useScreenMap } from '../../../lib/studioQueries.ts';
import { Link } from '../../../lib/router.tsx';
import { Workspace } from '../../../components/shell/Workspace.tsx';
import { GamePreview } from '../../../components/preview/GamePreview.tsx';
import { Button, Checkbox, Select } from '../../../components/ui/controls.tsx';
import { Banner, EmptyState, Pill, Spinner } from '../../../components/ui/feedback.tsx';
import { useToast } from '../../../components/ui/overlay.tsx';
import { ScreenRowEditor } from './ScreenRowEditor.tsx';

/** Source-to-Screen map: which slides, design frames and artwork feed each game screen. */
export function ScreensArea({ projectId }: { projectId: string }) {
  const project = useProject(projectId);
  const bundle = useScreenMap(projectId);
  const frames = useDesignFrames(projectId);
  const slides = useSlides(projectId);
  const assets = useAssets(projectId);
  const blueprints = useBlueprints(projectId);
  const preview = usePreviewBundle(projectId, null, Boolean(project.data?.currentVersionId));
  const save = useSaveScreenMap(projectId);
  const toast = useToast();
  const [draft, setDraft] = useState<SourceScreenMapping | null>(null);
  const [baseNumber, setBaseNumber] = useState<number | null>(null);
  const [dirty, setDirty] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [compare, setCompare] = useState<'side' | 'overlay'>('side');
  const [opacity, setOpacity] = useState(0.5);
  const [applyToVersion, setApplyToVersion] = useState(true);
  const [state, setStateIndex] = useState(0);
  const loadedFor = useRef<string>('');

  // Load the saved map (or the suggestion) when it changes, unless there are unsaved edits.
  useEffect(() => {
    if (!bundle.data || dirty) return;
    const key = `${bundle.data.branchId}:${bundle.data.current?.number ?? 0}:${Boolean(bundle.data.suggestion)}`;
    if (loadedFor.current === key) return;
    loadedFor.current = key;
    setDraft(bundle.data.suggestion ?? bundle.data.current?.mapping ?? null);
    setBaseNumber(bundle.data.current?.number ?? 0);
  }, [bundle.data, dirty]);

  const latest = blueprints.data?.[0] ?? null;
  const ctx: LayoutContext | null = useMemo(() => {
    if (!frames.data || !assets.data || !slides.data || !latest) return null;
    return {
      frames: new Map(frames.data.map((f) => [f.id, f])),
      assets: new Map(assets.data.map((a) => [a.id, { id: a.id, kind: a.kind, sprite: a.metadata.sprite ? { clips: a.metadata.sprite.clips.map((c) => ({ name: c.name })) } : null }])),
      slideIds: new Set(slides.data.slides.map((s) => s.id)),
      screens: [{ id: 'title', kind: 'title' as const }, ...latest.blueprint.scenes.map((s) => ({ id: s.id, kind: 'scene' as const })), { id: 'completion', kind: 'completion' as const }],
    };
  }, [frames.data, assets.data, slides.data, latest]);
  const check = useMemo(() => (draft && ctx ? validateMapping(draft, ctx) : null), [draft, ctx]);
  const entry = draft?.screens.find((s) => s.screenId === selected) ?? draft?.screens[0] ?? null;
  useEffect(() => {
    if (!selected && draft?.screens[0]) setSelected(draft.screens[0].screenId);
  }, [draft, selected]);
  useEffect(() => setStateIndex(0), [selected]);

  // Live preview of this row's layout on the current game (client-side; the server recomputes on save).
  const draftBundle: PreviewBundle | undefined = useMemo(() => {
    if (!preview.data || !entry || !ctx || !assets.data) return preview.data;
    const config = preview.data.config;
    const exists = entry.screenId === 'title' || entry.screenId === 'completion' || config.scenes.some((s) => s.id === entry.screenId);
    if (!exists) return preview.data;
    const r = computeScreenLayout(entry, ctx);
    const lib = new Map(assets.data.map((a) => [a.id, a]));
    const ids = [r.layout.design?.backgroundAssetId, ...(r.layout.design?.layers ?? []).map((l) => l.assetId), ...r.layout.objects.map((o) => o.assetId), r.layout.character, r.layout.background, r.layout.panel, r.layout.button].filter((x): x is string => Boolean(x));
    const addAssets = [...new Set(ids)].filter((id) => !config.assets[id] && lib.has(id)).map((id) => toGameAsset(lib.get(id)!));
    const ops: ChangeOp[] = [{ op: 'set-screen-layout', screenId: entry.screenId, layout: { ...r.layout, addAssets } }];
    if (entry.kind === 'scene' && r.wording.instruction) ops.push({ op: 'set-scene-field', sceneId: entry.screenId, field: 'instruction', value: r.wording.instruction });
    const applied = applyChangeOps(config, ops, { scope: { kind: 'project', sceneId: null }, allowLockedChanges: true });
    if (!applied.ok) return preview.data;
    const known = new Set(preview.data.assets.map((a) => a.id));
    return {
      ...preview.data,
      config: applied.config,
      assets: [...preview.data.assets, ...addAssets.filter((a) => !known.has(a.id)).map((a) => ({ id: a.id, mime: a.mime, url: `/api/assets/${a.id}/file?variant=display`, available: true }))],
    };
  }, [preview.data, entry, ctx, assets.data]);

  const update = (screenId: string) => (fn: (e: ScreenMapEntry) => ScreenMapEntry) => {
    setDraft((d) => (d ? { screens: d.screens.map((s) => (s.screenId === screenId ? fn(s) : s)) } : d));
    setDirty(true);
  };

  const doSave = () => {
    if (!draft || baseNumber === null) return;
    save.mutate(
      { mapping: draft, expectedNumber: baseNumber, note: 'Saved in Screens', applyToVersion: applyToVersion && Boolean(project.data?.currentVersionId) },
      {
        onSuccess: (r) => {
          setDirty(false);
          setBaseNumber(r.map.number);
          loadedFor.current = '';
          toast({
            tone: r.skipped.length ? 'info' : 'success',
            title: `Saved map revision ${r.map.number}`,
            detail: r.version ? `Applied to the game as version ${r.version.number}.${r.skipped.length ? ` Not applied: ${r.skipped[0]}` : ''}` : r.skipped.length ? `Not applied: ${r.skipped[0]}` : 'Used at the next build.',
          });
        },
        onError: (e) => toast({ tone: 'error', title: 'Map not saved', detail: `${errorMessage(e).message} ${errorMessage(e).hint ?? ''}` }),
      },
    );
  };

  if (bundle.isLoading || blueprints.isLoading) {
    return (
      <div className="center-fill">
        <Spinner large label="Loading screens…" />
      </div>
    );
  }
  if (!latest) {
    return (
      <div className="center-fill">
        <EmptyState icon={<LayoutTemplate size={24} aria-hidden="true" />} title="Screens follow the blueprint" actions={<Link className="btn btn-primary" to={`/p/${projectId}/prepare`}>Go to Prepare</Link>}>
          The map links lesson slides, design frames and artwork to the game's screens — the title, each scene and the completion screen. Create the blueprint first (Prepare my game, or Blueprint).
        </EmptyState>
      </div>
    );
  }

  const config = preview.data?.config ?? null;
  const motionCount = (screenId: string) => config?.motion.bindings.filter((b) => b.screenId === screenId).length ?? 0;
  const mechanicOf = (screenId: string) => latest.blueprint.scenes.find((s) => s.id === screenId)?.interaction.type ?? null;
  const frameMap = ctx?.frames ?? new Map();
  const primary = entry ? primaryFrame(entry, frameMap) : null;
  const stateFrames = entry ? entry.frames.map((l) => frameMap.get(l.frameId)).filter((f): f is NonNullable<typeof f> => Boolean(f)) : [];
  const shown = stateFrames[state] ?? primary;
  const refUrl = shown?.renderAssetId ? `/api/assets/${shown.renderAssetId}/file?variant=display` : null;
  const startScreen = entry?.screenId ?? null;

  const left = (
    <div className="panel-body">
      <div className="panel-head">
        <h2>Screens</h2>
        <span className="subtle small">{draft ? `${draft.screens.filter((s) => s.reviewed).length}/${draft.screens.length} reviewed` : ''}</span>
      </div>
      <ul className="screen-rows" aria-label="Game screens">
        {(draft?.screens ?? []).map((s, i) => {
          const open = s.conflicts.filter((c) => c.status === 'open').length;
          const f = s.frames.find((l) => l.primary) ?? s.frames[0];
          return (
            <li key={s.screenId}>
              <button type="button" className={`screen-row${entry?.screenId === s.screenId ? ' is-selected' : ''}`} aria-current={entry?.screenId === s.screenId ? 'true' : undefined} onClick={() => setSelected(s.screenId)}>
                <span className="screen-row-title">
                  <span className="subtle small">Screen {i + 1}</span> {s.title}
                </span>
                <span className="row-wrap tags">
                  <Pill tone="neutral" dot={false}>
                    {s.kind === 'scene' ? (mechanicOf(s.screenId) ?? 'scene') : s.kind}
                  </Pill>
                  {s.slideIds.length > 0 && <Pill tone="info" dot={false}>{s.slideIds.length} slide{s.slideIds.length === 1 ? '' : 's'}</Pill>}
                  {f && <Pill tone="info" dot={false}>{s.frames.length} frame{s.frames.length === 1 ? '' : 's'}</Pill>}
                  {(s.assets.character || s.assets.panel || s.assets.button || s.background.kind !== 'none') && <Pill tone="success" dot={false}>artwork</Pill>}
                  <Pill tone="neutral" dot={false}>
                    {motionCount(s.screenId)} motion
                  </Pill>
                  {open > 0 && <Pill tone="warning">{open} conflict{open === 1 ? '' : 's'}</Pill>}
                  {s.reviewed ? <CircleCheck size={15} className="ok-icon" aria-label="Reviewed" /> : <span className="subtle small">to review</span>}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );

  const center = (
    <div className="screens-center">
      {bundle.data?.suggestionNote && !dirty && (
        <Banner tone="info" title={bundle.data.current ? 'The blueprint changed' : 'Suggested map'}>
          {bundle.data.suggestionNote}
        </Banner>
      )}
      <div className="compare-bar row-wrap">
        <div className="segmented" role="group" aria-label="Compare">
          <button type="button" aria-pressed={compare === 'side'} onClick={() => setCompare('side')}>
            <Columns2 size={14} aria-hidden="true" /> Side by side
          </button>
          <button type="button" aria-pressed={compare === 'overlay'} onClick={() => setCompare('overlay')} disabled={!refUrl}>
            <Layers size={14} aria-hidden="true" /> Overlay
          </button>
        </div>
        {compare === 'overlay' && (
          <label className="row small">
            Design opacity
            <input type="range" min={0} max={1} step={0.05} value={opacity} onChange={(e) => setOpacity(Number(e.target.value))} aria-label="Design overlay opacity" />
          </label>
        )}
        {stateFrames.length > 1 && (
          <Select aria-label="Design state" value={String(state)} onChange={(e) => setStateIndex(Number(e.target.value))}>
            {entry!.frames.map((l, i) => (
              <option key={l.frameId} value={i}>
                State: {l.state}
              </option>
            ))}
          </Select>
        )}
      </div>
      <div className={`compare compare-${compare}`}>
        {compare === 'side' && (
          <figure className="compare-pane">
            <figcaption className="subtle small">Design reference{shown ? ` — ${shown.name}` : ''}</figcaption>
            <div className="ref-stage">
              {refUrl && shown ? (
                <img
                  src={refUrl}
                  alt={`Design reference: ${shown.name}`}
                  className="ref-img"
                  style={(() => {
                    const t = frameToStage({ w: shown.width, h: shown.height }, entry?.fit ?? 'contain');
                    return { left: `${(t.dx / 1920) * 100}%`, top: `${(t.dy / 1080) * 100}%`, width: `${((shown.width * t.scale) / 1920) * 100}%`, height: `${((shown.height * t.scale) / 1080) * 100}%` };
                  })()}
                />
              ) : (
                <p className="subtle small ref-empty">No design frame linked.</p>
              )}
            </div>
          </figure>
        )}
        <figure className="compare-pane">
          <figcaption className="subtle small">Game preview{dirty ? ' (unsaved changes)' : ''}</figcaption>
          {draftBundle ? (
            <GamePreview
              bundle={draftBundle}
              startSceneId={startScreen}
              fit="fit"
              title="Screen preview"
              overlay={
                compare === 'overlay' && refUrl && shown
                  ? () => {
                      const t = frameToStage({ w: shown.width, h: shown.height }, entry?.fit ?? 'contain');
                      return <img src={refUrl} alt="" className="ref-overlay" style={{ left: `${(t.dx / 1920) * 100}%`, top: `${(t.dy / 1080) * 100}%`, width: `${((shown.width * t.scale) / 1920) * 100}%`, height: `${((shown.height * t.scale) / 1080) * 100}%`, opacity }} />;
                    }
                  : undefined
              }
            />
          ) : (
            <p className="subtle small">Build the game to see a preview here; the map is used at the next build.</p>
          )}
        </figure>
      </div>
      {check && (check.errors.length > 0 || check.warnings.length > 0) && (
        <div className="map-check" role="status">
          {check.errors.map((e, i) => (
            <p key={`e${i}`} className="small is-error">
              <CircleAlert size={14} aria-hidden="true" /> {e}
            </p>
          ))}
          {check.warnings.slice(0, 6).map((w, i) => (
            <p key={`w${i}`} className="small subtle">
              <TriangleAlert size={14} aria-hidden="true" /> {w}
            </p>
          ))}
        </div>
      )}
      <div className="save-bar row-wrap">
        <Button variant="primary" icon={<Save size={15} aria-hidden="true" />} loading={save.isPending} disabled={!draft || (!dirty && Boolean(bundle.data?.current) && !bundle.data?.suggestion) || Boolean(check?.errors.length)} onClick={doSave}>
          Save map revision
        </Button>
        {project.data?.currentVersionId && <Checkbox label="Also apply layout and artwork to the current game (as a new version)" checked={applyToVersion} onChange={setApplyToVersion} />}
        <span className="spacer" />
        {bundle.data && bundle.data.history.length > 0 && (
          <span className="subtle small">
            <History size={13} aria-hidden="true" /> Revision {bundle.data.current?.number ?? 0} of {bundle.data.history.length}
          </span>
        )}
      </div>
    </div>
  );

  const right = entry ? (
    <div className="panel-body">
      <ScreenRowEditor entry={entry} update={update(entry.screenId)} frames={frames.data ?? []} slides={slides.data?.slides ?? []} assets={assets.data ?? []} mechanic={mechanicOf(entry.screenId)} />
    </div>
  ) : (
    <div className="panel-body">
      <p className="subtle">Select a screen.</p>
    </div>
  );

  return <Workspace leftLabel="Screens" left={left} center={center} right={right} rightLabel="Screen details" />;
}
