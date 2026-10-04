import { useMemo, useRef, useState } from 'react';
import { CheckSquare, CloudOff, Frame, ImageUp, Link2, RefreshCw, Square, Trash2 } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { FIDELITY_LABELS, parseFigmaUrl, type DesignFidelity, type DesignImport } from '@shared/schemas/design.ts';
import { errorMessage, upload } from '../../lib/api.ts';
import { formatDate } from '../../lib/format.ts';
import { useJobsContext, useTrackedJob } from '../../lib/jobs.tsx';
import { qk } from '../../lib/queries.ts';
import { qk2, useDesign, useDesignActions } from '../../lib/studioQueries.ts';
import { JobActivity } from '../JobActivity.tsx';
import { Button, Field, IconButton, TextInput } from '../ui/controls.tsx';
import { Banner, Pill, ProgressBar, Spinner } from '../ui/feedback.tsx';
import { ConfirmDialog, useToast } from '../ui/overlay.tsx';

const FIDELITY_TONE: Record<DesignFidelity, 'success' | 'info' | 'neutral' | 'warning'> = { editable: 'success', flattened: 'info', reference: 'neutral', 'needs-review': 'warning' };

export function FidelityBadges({ counts }: { counts: Record<DesignFidelity, number> }) {
  return (
    <span className="fidelity-badges">
      {(Object.keys(FIDELITY_LABELS) as DesignFidelity[])
        .filter((k) => counts[k] > 0)
        .map((k) => (
          <Pill key={k} tone={FIDELITY_TONE[k]} dot={false}>
            {counts[k]} {FIDELITY_LABELS[k]}
          </Pill>
        ))}
    </span>
  );
}

function FramePicker({ projectId, imp }: { projectId: string; imp: DesignImport }) {
  const actions = useDesignActions(projectId);
  const { track } = useJobsContext();
  const toast = useToast();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const toggle = (id: string) => setSelected((s) => (s.has(id) ? new Set([...s].filter((x) => x !== id)) : new Set([...s, id])));
  return (
    <div className="frame-picker stack">
      <div className="row">
        <strong>Choose the frames to import</strong>
        <span className="subtle small">
          {imp.available.length} frame{imp.available.length === 1 ? '' : 's'} in “{imp.fileName}”
        </span>
        <span className="spacer" />
        <Button size="sm" variant="ghost" onClick={() => setSelected(selected.size === imp.available.length ? new Set() : new Set(imp.available.slice(0, 24).map((a) => a.nodeId)))}>
          {selected.size === imp.available.length ? 'Clear' : 'Select all'}
        </Button>
      </div>
      <ul className="frame-grid" aria-label="Frames in the Figma file">
        {imp.available.map((a) => {
          const on = selected.has(a.nodeId);
          return (
            <li key={a.nodeId}>
              <button type="button" className={`frame-tile${on ? ' is-selected' : ''}`} aria-pressed={on} onClick={() => toggle(a.nodeId)}>
                <span className="frame-thumb checker">
                  {a.thumbFile ? <img src={`/api/design-imports/${imp.id}/thumbs/${encodeURIComponent(a.nodeId)}`} alt="" loading="lazy" /> : <span className="subtle small">{a.thumbError ?? 'No preview'}</span>}
                </span>
                <span className="frame-meta">
                  {on ? <CheckSquare size={15} aria-hidden="true" /> : <Square size={15} aria-hidden="true" />}
                  <span className="truncate">{a.name}</span>
                </span>
                <span className="subtle small">
                  {a.width}×{a.height}
                  {a.pageName ? ` · ${a.pageName}` : ''}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <div className="row">
        <Button
          variant="primary"
          disabled={selected.size === 0 || selected.size > 24}
          loading={actions.importFrames.isPending}
          onClick={() =>
            actions.importFrames.mutate(
              { importId: imp.id, nodeIds: [...selected] },
              { onSuccess: (r) => track(r.job), onError: (e) => toast({ tone: 'error', title: 'Import not started', detail: `${errorMessage(e).message} ${errorMessage(e).hint ?? ''}` }) },
            )
          }
        >
          Import {selected.size || ''} frame{selected.size === 1 ? '' : 's'}
        </Button>
        <span className="subtle small">Only the selected frames are fetched. Nothing is written back to Figma.</span>
      </div>
    </div>
  );
}

function ImportCard({ projectId, imp, all }: { projectId: string; imp: DesignImport; all: DesignImport[] }) {
  const actions = useDesignActions(projectId);
  const { track } = useJobsContext();
  const toast = useToast();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const refreshing = all.find((i) => i.previousImportId === imp.id && ['browsing', 'importing', 'pending-review'].includes(i.status));
  const fail = (title: string) => (e: unknown) => toast({ tone: 'error', title, detail: `${errorMessage(e).message} ${errorMessage(e).hint ?? ''}` });
  const totals = imp.frames.reduce<Record<DesignFidelity, number>>(
    (acc, f) => {
      for (const k of Object.keys(acc) as DesignFidelity[]) acc[k] += f.fidelity[k] ?? 0;
      return acc;
    },
    { editable: 0, flattened: 0, reference: 0, 'needs-review': 0 },
  );
  return (
    <article className={`design-import panel panel-pad status-${imp.status}`} aria-label={`${imp.kind === 'figma' ? 'Figma file' : 'Exported screens'}: ${imp.fileName}`}>
      <header className="row-wrap">
        {imp.kind === 'figma' ? <Frame size={17} aria-hidden="true" /> : <ImageUp size={17} aria-hidden="true" />}
        <strong className="truncate">{imp.fileName}</strong>
        <Pill tone={imp.status === 'active' ? 'success' : imp.status === 'pending-review' ? 'warning' : imp.status === 'failed' ? 'danger' : 'neutral'}>
          {imp.status === 'pending-review' ? 'Refresh waiting for review' : imp.status === 'browsing' ? 'Choose frames' : imp.status}
        </Pill>
        {imp.kind === 'exported' && (
          <Pill tone="info" dot={false}>
            Flat pictures
          </Pill>
        )}
        <span className="spacer" />
        {imp.kind === 'figma' && imp.status === 'active' && !refreshing && (
          <Button size="sm" icon={<RefreshCw size={14} aria-hidden="true" />} loading={actions.refresh.isPending} onClick={() => actions.refresh.mutate(imp.id, { onSuccess: (r) => track(r.job), onError: fail('Refresh not started') })}>
            Refresh from Figma
          </Button>
        )}
        {imp.status !== 'pending-review' && (
          <IconButton label="Remove this design import" size="sm" onClick={() => setConfirmRemove(true)}>
            <Trash2 size={15} aria-hidden="true" />
          </IconButton>
        )}
      </header>
      <p className="subtle small">
        {imp.kind === 'figma' ? `File ${imp.fileKey}${imp.sourceVersion ? ` · version ${imp.sourceVersion}` : ''}${imp.lastModified ? ` · edited ${formatDate(imp.lastModified)}` : ''}` : 'Uploaded exports'}
        {imp.importedAt ? ` · imported ${formatDate(imp.importedAt)}` : ''}
      </p>
      {imp.error && <Banner tone="danger" title={imp.error} />}
      {imp.status === 'browsing' && imp.available.length > 0 && <FramePicker projectId={projectId} imp={imp} />}
      {imp.frames.length > 0 && (
        <>
          <ul className="imported-frames">
            {imp.frames.map((f) => (
              <li key={f.id} className="imported-frame">
                <span className="frame-thumb checker">{f.renderAssetId ? <img src={`/api/assets/${f.renderAssetId}/file?variant=thumb`} alt="" loading="lazy" /> : <span className="subtle small">No render</span>}</span>
                <span className="truncate">{f.name}</span>
                <span className="subtle small">
                  {Math.round(f.width)}×{Math.round(f.height)}
                </span>
                <FidelityBadges counts={f.fidelity} />
              </li>
            ))}
          </ul>
          {imp.kind === 'figma' && <FidelityBadges counts={totals} />}
        </>
      )}
      {imp.status === 'pending-review' && imp.diff && (
        <section className="design-diff" aria-label="Changes since the design in use">
          <strong>What changed in Figma</strong>
          <ul className="plain-list small">
            {imp.diff.framesChanged.map((c) => (
              <li key={c.nodeId}>
                <strong>{c.name}</strong>: {c.changes.join(' ')}
              </li>
            ))}
            {imp.diff.framesAdded.map((c) => (
              <li key={c.nodeId}>Added: {c.name}</li>
            ))}
            {imp.diff.framesRemoved.map((c) => (
              <li key={c.nodeId}>No longer in the file: {c.name}</li>
            ))}
            <li className="subtle">{imp.diff.unchanged} frame(s) unchanged.</li>
          </ul>
          <p className="subtle small">Approving re-points your screen map to these snapshots and keeps placements and locks. Game versions change only when you build or apply.</p>
          <div className="row">
            <Button size="sm" variant="primary" loading={actions.decide.isPending} onClick={() => actions.decide.mutate({ importId: imp.id, action: 'approve' }, { onError: fail('Not approved') })}>
              Approve refresh
            </Button>
            <Button size="sm" onClick={() => actions.decide.mutate({ importId: imp.id, action: 'reject' }, { onError: fail('Not rejected') })}>
              Keep the current design
            </Button>
          </div>
        </section>
      )}
      {imp.warnings.length > 0 && (
        <details className="small">
          <summary>
            {imp.warnings.length} note{imp.warnings.length === 1 ? '' : 's'} from the import
          </summary>
          <ul className="plain-list">
            {imp.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </details>
      )}
      <ConfirmDialog
        open={confirmRemove}
        onClose={() => setConfirmRemove(false)}
        title="Remove this design import?"
        confirmLabel="Remove"
        danger
        busy={actions.remove.isPending}
        onConfirm={() => actions.remove.mutate(imp.id, { onSuccess: () => setConfirmRemove(false), onError: fail('Not removed') })}
      >
        Its reference pictures stay in the asset library. A design that a screen map or game version still uses cannot be removed.
      </ConfirmDialog>
    </article>
  );
}

/** Figma design card editor: paste a Design file/frame link, or upload exported screens (no Figma needed). */
export function DesignSources({ projectId }: { projectId: string }) {
  const design = useDesign(projectId);
  const actions = useDesignActions(projectId);
  const { track } = useJobsContext();
  const qc = useQueryClient();
  const toast = useToast();
  const [link, setLink] = useState('');
  const [lastJob, setLastJob] = useState<string | null>(null);
  const lastTracked = useTrackedJob(lastJob);
  const [progress, setProgress] = useState<number | null>(null);
  const [rejected, setRejected] = useState<Array<{ name: string; message: string; hint: string }>>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const parsed = useMemo(() => (link.trim() ? parseFigmaUrl(link) : null), [link]);
  const figma = design.data?.figma;
  const imports = design.data?.imports ?? [];

  const sendScreens = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const form = new FormData();
    for (const f of Array.from(files).slice(0, 24)) form.append('files', f, f.name);
    setProgress(0);
    setRejected([]);
    try {
      const r = await upload<{ rejected: Array<{ name: string; message: string; hint: string }> }>(`/api/projects/${projectId}/design/exported`, form, (p) => setProgress(p.loaded / Math.max(1, p.total)));
      setRejected(r.rejected);
    } catch (e) {
      toast({ tone: 'error', title: 'Screens not uploaded', detail: errorMessage(e).message });
    } finally {
      setProgress(null);
      void qc.invalidateQueries({ queryKey: qk2.design(projectId) });
      void qc.invalidateQueries({ queryKey: qk.assets(projectId) });
    }
  };

  if (design.isLoading) return <Spinner label="Loading design sources…" />;
  return (
    <div className="design-sources stack">
      <section className="stack" aria-labelledby="figma-link-title">
        <h3 id="figma-link-title" className="h-sub-sm">
          <Link2 size={16} aria-hidden="true" /> Connect / paste design link
        </h3>
        {figma?.state === 'not-configured' ? (
          <Banner tone="info" title="Figma is not configured on this server">
            <CloudOff size={14} aria-hidden="true" /> Link import needs a Figma personal access token set as FIGMA_ACCESS_TOKEN on the server (see Settings → Figma). Uploading exported screens below works without it.
          </Banner>
        ) : (
          <>
            <Field label="Figma Design file or frame link" htmlFor="figma-link" help="In Figma: select a frame → Copy link to selection. Only figma.com Design links are accepted." error={parsed && !parsed.ok ? `${parsed.reason} ${parsed.hint}` : null}>
              <div className="row">
                <TextInput id="figma-link" value={link} placeholder="https://www.figma.com/design/…?node-id=…" onChange={(e) => setLink(e.target.value)} />
                <Button
                  variant="primary"
                  disabled={!parsed?.ok}
                  loading={actions.paste.isPending}
                  onClick={() =>
                    actions.paste.mutate(link, {
                      onSuccess: (r) => {
                        track(r.job);
                        setLastJob(r.job.id);
                        setLink('');
                      },
                      onError: (e) => toast({ tone: 'error', title: 'Could not open the link', detail: `${errorMessage(e).message} ${errorMessage(e).hint ?? ''}` }),
                    })
                  }
                >
                  Find frames
                </Button>
              </div>
            </Field>
            {figma?.state === 'error' && <Banner tone="warning" title="The last Figma connection check failed">{figma.detail}</Banner>}
          </>
        )}
        {lastTracked && lastTracked.job.status !== 'succeeded' && <JobActivity job={lastTracked.job} compact />}
      </section>

      <section className="stack" aria-labelledby="exported-title">
        <h3 id="exported-title" className="h-sub-sm">
          <ImageUp size={16} aria-hidden="true" /> Upload exported screens
        </h3>
        <p className="muted small">PNG, JPEG or SVG exports of your frames. They are kept as visual references or flattened backgrounds — text and buttons inside them are part of the picture, so the game adds its own readable text and controls on top.</p>
        <input ref={fileInput} type="file" multiple className="sr-only" tabIndex={-1} accept=".png,.jpg,.jpeg,.svg,image/png,image/jpeg,image/svg+xml" onChange={(e) => {
          void sendScreens(e.target.files);
          e.target.value = '';
        }} />
        <div className="row">
          <Button icon={<ImageUp size={15} aria-hidden="true" />} loading={progress !== null} onClick={() => fileInput.current?.click()}>
            Upload exported screens
          </Button>
          <span className="subtle small">.fig files can’t be read — paste a link or export PNGs instead.</span>
        </div>
        {progress !== null && <ProgressBar value={progress} label="Uploading screens" />}
        {rejected.length > 0 && (
          <Banner tone="warning" title={`${rejected.length} file(s) were not added`}>
            <ul className="plain-list">
              {rejected.map((r, i) => (
                <li key={i}>
                  <strong>{r.name}</strong>: {r.message} {r.hint}
                </li>
              ))}
            </ul>
          </Banner>
        )}
      </section>

      {imports.filter((i) => i.status !== 'superseded' && i.status !== 'rejected').length > 0 && (
        <section className="stack" aria-label="Design imports">
          {imports
            .filter((i) => i.status !== 'superseded' && i.status !== 'rejected')
            .map((imp) => (
              <ImportCard key={imp.id} projectId={projectId} imp={imp} all={imports} />
            ))}
        </section>
      )}
    </div>
  );
}
