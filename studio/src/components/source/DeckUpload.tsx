import { useRef, useState } from 'react';
import { FileUp, FileText, Upload, X } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import type { Job } from '@shared/schemas/jobs.ts';
import type { SourceDocument } from '@shared/schemas/source.ts';
import { ApiError, errorMessage, upload } from '../../lib/api.ts';
import { formatBytes } from '../../lib/format.ts';
import { qk, useHealth } from '../../lib/queries.ts';
import { useJobsContext } from '../../lib/jobs.tsx';
import { Button } from '../ui/controls.tsx';
import { Banner, ProgressBar } from '../ui/feedback.tsx';
import { ConfirmDialog } from '../ui/overlay.tsx';

type Kind = 'pptx' | 'pdf';

function precheck(file: File, kind: Kind, maxBytes: number): { message: string; hint: string } | null {
  const name = file.name.toLowerCase();
  if (kind === 'pptx') {
    if (name.endsWith('.ppt') || name.endsWith('.pps')) return { message: 'Legacy .ppt files are not supported.', hint: 'Open the file in PowerPoint and choose File → Save As → PowerPoint Presentation (.pptx).' };
    if (name.endsWith('.pptm') || name.endsWith('.ppsm') || name.endsWith('.potm')) return { message: 'Macro-enabled presentations are not accepted.', hint: 'Save a copy as a regular .pptx without macros.' };
    if (name.endsWith('.key')) return { message: 'Keynote files are not supported directly.', hint: 'In Keynote, choose File → Export To → PowerPoint.' };
    if (!name.endsWith('.pptx')) return { message: 'Choose a PowerPoint (.pptx) file.', hint: 'Google Slides: File → Download → Microsoft PowerPoint (.pptx).' };
  }
  if (kind === 'pdf' && !name.endsWith('.pdf')) return { message: 'Choose a PDF file.', hint: 'Export your presentation as PDF to add a visual reference.' };
  if (file.size > maxBytes) return { message: `The file is ${formatBytes(file.size)}; the limit is ${formatBytes(maxBytes)}.`, hint: 'Compress images in the deck (PowerPoint: File → Compress Pictures) or split it into smaller lessons.' };
  if (file.size === 0) return { message: 'The file is empty.', hint: 'Choose the file again.' };
  return null;
}

export function DeckUpload({
  projectId,
  kind,
  existing,
  existingFailed,
  compact,
  onUploaded,
}: {
  projectId: string;
  kind: Kind;
  existing?: SourceDocument | null;
  /** The existing deck's import failed (possibly known from the live job before the document refetches). */
  existingFailed?: boolean;
  compact?: boolean;
  onUploaded?: (doc: SourceDocument, job: Job) => void;
}) {
  const qc = useQueryClient();
  const health = useHealth();
  const { track } = useJobsContext();
  const inputRef = useRef<HTMLInputElement>(null);
  const abort = useRef<AbortController | null>(null);
  const [over, setOver] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<{ message: string; hint: string | null } | null>(null);
  const [pendingReplace, setPendingReplace] = useState<File | null>(null);
  const maxBytes = health.data?.limits.maxUploadBytes ?? 40 * 1024 * 1024;

  const send = async (f: File, replace: boolean) => {
    const pre = precheck(f, kind, maxBytes);
    setError(pre);
    if (pre) return;
    setFile(f);
    setProgress(0);
    const form = new FormData();
    form.append('kind', kind);
    if (replace) form.append('replace', '1');
    form.append('file', f, f.name);
    abort.current = new AbortController();
    try {
      const r = await upload<{ document: SourceDocument; job: Job }>(`/api/projects/${projectId}/sources`, form, (p) => setProgress(p.loaded / Math.max(1, p.total)), abort.current.signal);
      setProgress(1);
      track(r.job);
      void qc.invalidateQueries({ queryKey: qk.project(projectId) });
      void qc.invalidateQueries({ queryKey: qk.slides(projectId) });
      void qc.invalidateQueries({ queryKey: qk.jobs(projectId) });
      onUploaded?.(r.document, r.job);
      setFile(null);
      setProgress(null);
    } catch (err) {
      setProgress(null);
      if (err instanceof ApiError && err.status === 409 && kind === 'pptx' && !replace) {
        setPendingReplace(f);
        setFile(null);
        return;
      }
      setFile(null);
      setError(errorMessage(err));
    }
  };

  const choose = (files: FileList | null) => {
    const f = files?.[0];
    if (!f) return;
    // Refuse unsupported files before asking anything else.
    const pre = precheck(f, kind, maxBytes);
    setError(pre);
    if (pre) return;
    // Only a deck that imported (or is importing) needs confirmation; a failed import has nothing to lose.
    if (existing && kind === 'pptx' && existing.status !== 'failed' && !existingFailed) setPendingReplace(f);
    else void send(f, Boolean(existing && kind === 'pptx'));
  };

  const label = kind === 'pptx' ? 'PowerPoint deck (.pptx)' : 'PDF export of the deck (optional)';
  return (
    <div className="deck-upload">
      <div
        className={`dropzone${over ? ' is-over' : ''}${error ? ' is-error' : ''}${compact ? ' is-compact' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          choose(e.dataTransfer.files);
        }}
      >
        <div className="dropzone-icon" aria-hidden="true">
          {kind === 'pptx' ? <FileUp size={28} /> : <FileText size={26} />}
        </div>
        <div>
          <p className="dropzone-title">{existing && kind === 'pptx' ? 'Replace the deck' : `Drop your ${label} here`}</p>
          <p className="muted small">
            {kind === 'pptx'
              ? `Up to ${formatBytes(maxBytes)} and ${health.data?.limits.maxSlides ?? 80} slides. Legacy .ppt must be saved as .pptx first.`
              : 'Used only as a visual reference for slides and page matching. Page order is verified, never assumed.'}
          </p>
        </div>
        <input ref={inputRef} type="file" className="sr-only" tabIndex={-1} accept={kind === 'pptx' ? '.pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation' : '.pdf,application/pdf'} onChange={(e) => {
          choose(e.target.files);
          e.target.value = '';
        }} />
        <Button variant={kind === 'pptx' && !existing ? 'primary' : 'default'} icon={<Upload size={16} aria-hidden="true" />} onClick={() => inputRef.current?.click()} disabled={progress !== null}>
          {kind === 'pptx' ? (existing ? 'Choose a new .pptx' : 'Choose .pptx file') : 'Choose PDF'}
        </Button>
      </div>

      {file && progress !== null && (
        <div className="upload-row" role="status">
          <FileText size={18} aria-hidden="true" />
          <div className="upload-info">
            <div className="row">
              <span className="truncate">{file.name}</span>
              <span className="subtle small tabular">{formatBytes(file.size)}</span>
            </div>
            <ProgressBar value={progress} label={`Uploading ${file.name}`} />
            <span className="subtle small tabular">{progress >= 1 ? 'Uploaded — starting extraction' : `Uploading… ${Math.round(progress * 100)}%`}</span>
          </div>
          <button type="button" className="icon-btn icon-btn-sm" aria-label="Cancel upload" onClick={() => abort.current?.abort()}>
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      )}

      {error && (
        <Banner tone="danger" title={error.message}>
          {error.hint}
        </Banner>
      )}

      <ConfirmDialog
        open={Boolean(pendingReplace)}
        title="Replace the deck?"
        confirmLabel="Replace deck"
        onClose={() => setPendingReplace(null)}
        onConfirm={() => {
          const f = pendingReplace;
          setPendingReplace(null);
          if (f) void send(f, true);
        }}
      >
        <p>
          The current deck’s slides and your slide edits will be replaced by <strong>{pendingReplace?.name}</strong>. Existing learning maps and blueprints are kept but will be marked stale, and game versions stay playable.
        </p>
      </ConfirmDialog>
    </div>
  );
}
