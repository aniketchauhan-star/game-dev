import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { Bot, Download, FileCode2, Gamepad2, ShieldCheck, TriangleAlert } from 'lucide-react';
import type { ExportKind, Preflight } from '@shared/schemas/exports.ts';
import { MECHANICS } from '@shared/registry.ts';
import { useBlueprints, useCreateExport, useExports, usePreflight, useProject, useVersions } from '../../../lib/queries.ts';
import { errorMessage } from '../../../lib/api.ts';
import { formatBytes, formatDate } from '../../../lib/format.ts';
import { Button, Checkbox, Field, Select, TextArea } from '../../../components/ui/controls.tsx';
import { Banner, Pill, Spinner } from '../../../components/ui/feedback.tsx';
import { useToast } from '../../../components/ui/overlay.tsx';

const CARDS: Array<{ kind: ExportKind; title: string; icon: ReactElement; text: string; includes: string }> = [
  {
    kind: 'playable',
    title: 'Playable game (.zip)',
    icon: <Gamepad2 size={20} aria-hidden="true" />,
    text: 'A static website: index.html, the game runtime, configuration (animations included) and only the assets the game uses. Works offline from any static host or sub-folder. No server, login or API key.',
    includes: 'Never includes the deck, speaker notes, design references, Figma data, conversations or keys.',
  },
  {
    kind: 'source',
    title: 'Source package (.zip)',
    icon: <FileCode2 size={20} aria-hidden="true" />,
    text: 'Editable game.config.json, asset mapping, original asset files, runtime source and a dependency-free build script.',
    includes: 'Source material (deck + notes) only if you tick the option below.',
  },
  {
    kind: 'handoff',
    title: 'Claude Code handoff (.zip)',
    icon: <Bot size={20} aria-hidden="true" />,
    text: 'Everything in the source package plus README, CLAUDE.md, GAME_DESIGN.md, TASKS.md, ASSET_GUIDE.md, GRADE_PROFILE.md, ANIMATION_GUIDE.md, animation-manifest.json, design-map.json and source-map.json for a developer working in VS Code.',
    includes: 'Write the next changes you want below; they go into TASKS.md.',
  },
];

function PreflightView({ p, files }: { p: Preflight; files: string[] }) {
  const tone = { pass: 'success', warn: 'warning', fail: 'danger', info: 'info' } as const;
  return (
    <section className="panel panel-pad stack preflight" aria-labelledby="pf-title">
      <div className="section-head">
        <h2 id="pf-title" className="h-sub">
          <ShieldCheck size={18} aria-hidden="true" /> Preflight — {p.label}
        </h2>
        <span className="subtle small">{p.versionNumber !== null ? `Version ${p.versionNumber}${p.blueprintRevisionNumber ? ` · blueprint r${p.blueprintRevisionNumber}` : ''}` : 'No playable version'}</span>
      </div>
      <ul className="check-list">
        {p.checks.map((c) => (
          <li key={c.id}>
            <Pill tone={tone[c.status]}>{c.status}</Pill>
            <span>
              <strong>{c.label}</strong> — <span className="muted">{c.detail}</span>
            </span>
          </li>
        ))}
      </ul>
      {p.unresolvedSourceWarnings.length > 0 && (
        <details>
          <summary className="small">{p.unresolvedSourceWarnings.length} source item(s) to review</summary>
          <ul className="plain-list small">
            {p.unresolvedSourceWarnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </details>
      )}
      <p className="small muted">
        Checks that ran: {p.testsRun.join(', ')}. Browser playtesting is not part of the export — play the game before sharing it.
      </p>
      <details>
        <summary className="small">Files in this export ({files.length})</summary>
        <ul className="file-list mono small">
          {files.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      </details>
    </section>
  );
}

export function ExportPage({ projectId }: { projectId: string }) {
  const project = useProject(projectId);
  const versions = useVersions(projectId);
  const blueprints = useBlueprints(projectId);
  const exportsList = useExports(projectId);
  const preflight = usePreflight(projectId);
  const create = useCreateExport(projectId);
  const toast = useToast();
  const [kind, setKind] = useState<ExportKind>('playable');
  const [versionId, setVersionId] = useState<string | null>(null);
  const [includeSource, setIncludeSource] = useState(false);
  const [nextChanges, setNextChanges] = useState('');
  const list = versions.data?.versions ?? [];
  useEffect(() => {
    if (!versionId && versions.data?.currentVersionId) setVersionId(versions.data.currentVersionId);
  }, [versions.data, versionId]);
  const latestBp = blueprints.data?.[0];
  const blueprintOnly = list.length === 0 && latestBp && !MECHANICS[latestBp.blueprint.coreMechanic].buildable;
  useEffect(() => {
    if (blueprintOnly) setKind('handoff');
  }, [blueprintOnly]);
  const body = useMemo(() => ({ kind, versionId, includeSourceMaterial: kind !== 'playable' && includeSource, nextChanges }), [kind, versionId, includeSource, nextChanges]);
  useEffect(() => {
    if (list.length === 0 && !latestBp) return;
    const t = window.setTimeout(() => preflight.mutate(body), 300);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [body.kind, body.versionId, body.includeSourceMaterial, list.length, latestBp?.id]);

  if (versions.isLoading || blueprints.isLoading) {
    return (
      <div className="center-fill">
        <Spinner large label="Loading…" />
      </div>
    );
  }
  const selected = list.find((v) => v.id === versionId);
  const pf = preflight.data?.preflight;

  return (
    <div className="export-page canvas-inner">
      <header className="canvas-header">
        <div>
          <p className="eyebrow">Export</p>
          <h1>Share {project.data?.name}</h1>
          <p className="subtitle">Exports are files you download. Nothing is published or pushed anywhere.</p>
        </div>
      </header>
      {list.length === 0 && !latestBp && (
        <Banner tone="info" title="Nothing to export yet">
          Approve a blueprint and build the game first.
        </Banner>
      )}
      {blueprintOnly && (
        <Banner tone="info" title="Developer handoff">
          This game uses a mechanic without an in-app builder, so there is no playable version. The handoff contains the approved design for a developer to build.
        </Banner>
      )}
      {list.length > 0 && (
        <div className="export-version">
          <Field label="Version to export" htmlFor="export-version">
            <Select id="export-version" value={versionId ?? ''} onChange={(e) => setVersionId(e.target.value)}>
              {list.map((v) => (
                <option key={v.id} value={v.id}>
                  v{v.number}
                  {v.id === versions.data?.currentVersionId ? ' (current)' : ''} — {v.summary}
                </option>
              ))}
            </Select>
          </Field>
          {selected && (
            <p className="muted small">
              Exporting exactly version {selected.number}
              {selected.blueprintRevisionNumber ? `, built from blueprint r${selected.blueprintRevisionNumber}` : ''}, created {formatDate(selected.createdAt)}.{selected.demo ? ' Contains demo sample content.' : ''}
            </p>
          )}
        </div>
      )}
      <div className="export-cards" role="radiogroup" aria-label="Export type">
        {CARDS.map((c) => {
          const disabled = c.kind !== 'handoff' && list.length === 0;
          const title = c.kind === 'handoff' && blueprintOnly ? 'Developer handoff (.zip)' : c.title;
          return (
            <label key={c.kind} className={`export-card${kind === c.kind ? ' is-selected' : ''}${disabled ? ' is-disabled' : ''}`}>
              <input type="radio" name="export-kind" className="sr-only" checked={kind === c.kind} disabled={disabled} onChange={() => setKind(c.kind)} />
              <span className="export-icon">{c.icon}</span>
              <span className="export-title">{title}</span>
              <span className="muted small">{c.text}</span>
              <span className="subtle small">{c.includes}</span>
            </label>
          );
        })}
      </div>
      {kind !== 'playable' && (
        <div className="panel panel-pad stack">
          <Checkbox label="Include source material" hint="Adds the original deck, extracted slide text and speaker notes in source-material/. Leave off unless the recipient should have them." checked={includeSource} onChange={setIncludeSource} />
          {kind === 'handoff' && (
            <Field label="Requested next changes for the developer" htmlFor="next-changes" help="Written into TASKS.md.">
              <TextArea id="next-changes" rows={3} maxLength={4000} value={nextChanges} onChange={(e) => setNextChanges(e.target.value)} placeholder="Add a fourth coordinate scene using negative y targets; add Spanish translations." />
            </Field>
          )}
        </div>
      )}
      {preflight.isPending && <Spinner label="Running preflight checks…" />}
      {preflight.isError && (
        <Banner tone="danger" title={errorMessage(preflight.error).message}>
          {errorMessage(preflight.error).hint}
        </Banner>
      )}
      {pf && preflight.data && <PreflightView p={pf} files={preflight.data.files} />}
      <div className="row">
        <Button
          variant="primary"
          size="lg"
          icon={<Download size={18} aria-hidden="true" />}
          loading={create.isPending}
          disabled={!pf || pf.blocking || preflight.isPending}
          onClick={() =>
            create.mutate(body, {
              onSuccess: (rec) => {
                toast({ tone: 'success', title: `${rec.label} ready`, detail: `${rec.fileName} · ${formatBytes(rec.sizeBytes)}` });
                // A download link, not a navigation: the studio page stays as it is.
                const a = document.createElement('a');
                a.href = `/api/exports/${rec.id}/download`;
                a.download = rec.fileName;
                document.body.appendChild(a);
                a.click();
                a.remove();
              },
              onError: (e) => toast({ tone: 'error', title: 'Export failed', detail: `${errorMessage(e).message} ${errorMessage(e).hint ?? ''}` }),
            })
          }
        >
          Export {pf?.label ?? ''}
        </Button>
        {pf?.blocking && (
          <span className="meta-warn small">
            <TriangleAlert size={14} aria-hidden="true" /> A failing check blocks this export.
          </span>
        )}
      </div>
      <section className="stack">
        <h2 className="h-sub">Previous exports</h2>
        {(exportsList.data ?? []).length === 0 ? (
          <p className="subtle small">No exports yet.</p>
        ) : (
          <div className="table-wrap panel">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Export</th>
                  <th scope="col">Version</th>
                  <th scope="col">Created</th>
                  <th scope="col">Size</th>
                  <th scope="col">
                    <span className="sr-only">Download</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {(exportsList.data ?? []).map((e) => (
                  <tr key={e.id}>
                    <td>
                      {e.label}
                      {e.includeSourceMaterial && <span className="subtle small"> · with source material</span>}
                    </td>
                    <td>{e.versionNumber !== null ? `v${e.versionNumber}` : '—'}</td>
                    <td>{formatDate(e.createdAt)}</td>
                    <td className="tabular">{formatBytes(e.sizeBytes)}</td>
                    <td>
                      <a className="btn btn-sm" href={`/api/exports/${e.id}/download`}>
                        <Download size={14} aria-hidden="true" /> Download
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
