import { useRef, useState } from 'react';
import { Upload } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import type { Asset, AssetLibraryRole } from '@shared/schemas/assets.ts';
import { errorMessage, upload } from '../../lib/api.ts';
import { qk, useHealth } from '../../lib/queries.ts';
import { formatBytes } from '../../lib/format.ts';
import { Button } from '../ui/controls.tsx';
import { Banner, ProgressBar } from '../ui/feedback.tsx';

const ACCEPT_IMAGES = '.png,.jpg,.jpeg,.webp,.svg,image/png,image/jpeg,image/webp,image/svg+xml';
const ACCEPT_AUDIO = '.mp3,.ogg,.wav,.m4a,audio/mpeg,audio/ogg,audio/wav,audio/mp4';

type Origin = 'upload' | 'chatgpt' | 'other-ai';

/**
 * Upload images or audio with a role. File types are validated by the server
 * from file contents. With `askOrigin`, the creator says where the artwork came
 * from (for example downloaded from ChatGPT) and it is recorded as provenance.
 */
export function AssetUploader({ projectId, role, label, audio, compact, askOrigin }: { projectId: string; role: AssetLibraryRole; label: string; audio?: boolean; compact?: boolean; askOrigin?: boolean }) {
  const [origin, setOrigin] = useState<Origin>('upload');
  const [tool, setTool] = useState('');
  const qc = useQueryClient();
  const health = useHealth();
  const input = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [rejected, setRejected] = useState<Array<{ name: string; message: string; hint: string }>>([]);
  const [duplicates, setDuplicates] = useState<Array<{ name: string; existingName: string; adopted: boolean }>>([]);
  const [error, setError] = useState<string | null>(null);
  const max = health.data?.limits.maxAssetBytes ?? 25 * 1048576;

  const send = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const tooBig = Array.from(files).filter((f) => f.size > max);
    const ok = Array.from(files).filter((f) => f.size <= max).slice(0, 20);
    setRejected(tooBig.map((f) => ({ name: f.name, message: `Larger than ${formatBytes(max)}.`, hint: 'Resize or compress it first.' })));
    setError(null);
    if (ok.length === 0) return;
    const form = new FormData();
    form.append('role', role);
    // Fields must precede the files: the server reads the multipart stream in order.
    form.append('provenance', origin === 'upload' ? 'upload' : 'ai-tool');
    if (origin !== 'upload') form.append('tool', origin === 'chatgpt' ? 'ChatGPT' : tool.trim() || 'Another AI image tool');
    for (const f of ok) form.append('files', f, f.name);
    setProgress(0);
    try {
      const r = await upload<{ created: Asset[]; rejected: Array<{ name: string; message: string; hint: string }>; duplicates?: Array<{ name: string; existingName: string; adopted: boolean }> }>(`/api/projects/${projectId}/assets`, form, (p) => setProgress(p.loaded / Math.max(1, p.total)));
      setRejected((prev) => [...prev, ...r.rejected]);
      setDuplicates(r.duplicates ?? []);
    } catch (err) {
      setError(errorMessage(err).message);
    } finally {
      setProgress(null);
      void qc.invalidateQueries({ queryKey: qk.assets(projectId) });
    }
  };

  return (
    <div className={`asset-uploader${compact ? ' is-compact' : ''}`}>
      <input ref={input} type="file" multiple className="sr-only" tabIndex={-1} accept={audio ? ACCEPT_AUDIO : ACCEPT_IMAGES} onChange={(e) => {
        void send(e.target.files);
        e.target.value = '';
      }} />
      {askOrigin && !audio && (
        <div className="row-wrap asset-origin">
          <label className="field-label" htmlFor={`origin-${role}`}>
            Where is this artwork from?
          </label>
          <select id={`origin-${role}`} className="select select-sm" value={origin} onChange={(e) => setOrigin(e.target.value as Origin)}>
            <option value="upload">My own or licensed artwork</option>
            <option value="chatgpt">Made with ChatGPT (downloaded)</option>
            <option value="other-ai">Another AI image tool</option>
          </select>
          {origin === 'other-ai' && <input className="input input-sm" aria-label="Tool name" maxLength={60} placeholder="Tool name" value={tool} onChange={(e) => setTool(e.target.value)} />}
        </div>
      )}
      <Button size="sm" icon={<Upload size={14} aria-hidden="true" />} loading={progress !== null} onClick={() => input.current?.click()}>
        {label}
      </Button>
      {progress !== null && <ProgressBar value={progress} label={`Uploading ${label}`} />}
      {error && <Banner tone="danger" title={error} />}
      {duplicates.length > 0 && (
        <Banner tone="info" title={`${duplicates.length} file(s) were already in the library`}>
          <ul className="plain-list">
            {duplicates.map((d, i) => (
              <li key={i}>
                <strong>{d.name}</strong> is the same picture as “{d.existingName}”{d.adopted ? ' (imported earlier); it now has your name, role and origin note.' : '; it is stored once — use that asset (it can appear several times in a sprite).'}
              </li>
            ))}
          </ul>
        </Banner>
      )}
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
    </div>
  );
}
