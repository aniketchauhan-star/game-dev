import { useEffect, useMemo, useRef, useState } from 'react';
import { Copy, Film, Image as ImageIcon, Music, Play, Plus, RefreshCw, Trash2, TriangleAlert, X } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { ASSET_ROLE_LABELS, type Asset, type AssetLibraryRole, type AssetProvenance } from '@shared/schemas/assets.ts';
import type { ChangeOp } from '@shared/schemas/proposal.ts';
import { spriteClipSchema, type SpriteClip, type SpriteSheet } from '@shared/schemas/game.ts';
import { useAssets, useBlueprints, useDeleteAsset, useManualEdit, useProject, useUpdateAsset, usePreviewBundle, qk } from '../../../lib/queries.ts';
import { useComposeSprite } from '../../../lib/studioQueries.ts';
import { errorMessage, upload } from '../../../lib/api.ts';
import { formatBytes, formatDate } from '../../../lib/format.ts';
import { useSaveStatus } from '../../../lib/saveStatus.tsx';
import { Workspace } from '../../../components/shell/Workspace.tsx';
import { ClaudePanel } from '../../../components/claude/ClaudePanel.tsx';
import { Button, Checkbox, Field, IconButton, Select, Switch, TextArea, TextInput } from '../../../components/ui/controls.tsx';
import { Banner, EmptyState, Pill, Spinner } from '../../../components/ui/feedback.tsx';
import { ConfirmDialog, useToast } from '../../../components/ui/overlay.tsx';
import { AssetUploader } from '../../../components/assets/AssetUploader.tsx';

type Filter = AssetLibraryRole | 'all';
const FILTERS: Filter[] = ['all', 'background', 'character', 'object', 'ui', 'audio', 'reference', 'unassigned'];
const ROLE_CHOICES: AssetLibraryRole[] = ['background', 'character', 'object', 'ui', 'audio', 'reference', 'unassigned'];
const CLIP_NAMES = ['idle', 'wave', 'celebrate', 'walk', 'talk', 'point'];

/** Plays the sheet (or one clip of it) on a canvas. A clip that does not loop plays once and holds its last frame. */
function SpritePreview({ asset, sprite, clip, playKey = 0 }: { asset: Asset; sprite: SpriteSheet; clip?: SpriteClip | null; playKey?: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const img = new Image();
    img.src = `/api/assets/${asset.id}/file?variant=display`;
    const first = clip ? Math.min(clip.from, sprite.frameCount - 1) : 0;
    const last = clip ? Math.min(Math.max(clip.to, first), sprite.frameCount - 1) : sprite.frameCount - 1;
    const loop = clip ? clip.loop : true;
    const fps = clip?.fps ?? sprite.fps;
    let frame = first;
    let timer: number | null = null;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    img.onload = () => {
      const c = canvas.current;
      const ctx = c?.getContext('2d');
      if (!c || !ctx) return;
      c.width = sprite.frameWidth;
      c.height = sprite.frameHeight;
      const draw = () => {
        const col = frame % sprite.columns;
        const row = Math.floor(frame / sprite.columns);
        ctx.clearRect(0, 0, c.width, c.height);
        ctx.drawImage(img, col * (sprite.frameWidth + sprite.spacing), row * (sprite.frameHeight + sprite.spacing), sprite.frameWidth, sprite.frameHeight, 0, 0, sprite.frameWidth, sprite.frameHeight);
        if (frame < last) frame++;
        else if (loop) frame = first;
        else if (timer) {
          window.clearInterval(timer);
          timer = null;
        }
      };
      draw();
      if (!reduce) timer = window.setInterval(draw, 1000 / fps);
    };
    return () => {
      if (timer) window.clearInterval(timer);
    };
  }, [asset.id, sprite, clip, playKey]);
  return <canvas ref={canvas} className="sprite-canvas checker" role="img" aria-label={clip ? `Preview of the “${clip.name}” clip` : 'Sprite sheet animation preview'} />;
}

function clipProblems(clips: SpriteClip[], frameCount: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  clips.forEach((c, i) => {
    const label = c.name || `Clip ${i + 1}`;
    if (!spriteClipSchema.shape.name.safeParse(c.name).success) out.push(`${label}: use lowercase letters, digits and dashes (start with a letter, up to 24 characters).`);
    if (seen.has(c.name)) out.push(`${label}: the name is used twice.`);
    seen.add(c.name);
    if (c.from > c.to) out.push(`${label}: the first frame comes after the last frame.`);
    if (c.to >= frameCount) out.push(`${label}: the sheet has frames 0–${frameCount - 1}.`);
  });
  return out;
}

/** Named clips (idle, wave, celebrate…) that motion presets can play. Frames are numbered from 0. */
function SpriteClips({ asset, sprite, onSave, saving }: { asset: Asset; sprite: SpriteSheet; onSave: (clips: SpriteClip[]) => void; saving: boolean }) {
  const [clips, setClips] = useState<SpriteClip[]>(sprite.clips);
  const [previewing, setPreviewing] = useState<number | null>(null);
  const [playKey, setPlayKey] = useState(0);
  useEffect(() => {
    setClips(sprite.clips);
    setPreviewing(null);
  }, [asset.id, sprite.clips]);
  const problems = clipProblems(clips, sprite.frameCount);
  const changed = JSON.stringify(clips) !== JSON.stringify(sprite.clips);
  const set = (i: number, patch: Partial<SpriteClip>) => setClips((cs) => cs.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const num = (v: string, max: number) => Math.max(0, Math.min(max, Math.round(Number(v) || 0)));
  const shown = previewing !== null ? (clips[previewing] ?? null) : null;
  return (
    <div className="stack-tight">
      <span className="field-label">Clips ({clips.length})</span>
      {clips.length === 0 && <p className="subtle small">No clips yet. Name frame ranges (for example idle 0–1, wave 2–5) so Animate can play them.</p>}
      {clips.map((c, i) => (
        <div key={i} className="clip-row">
          <TextInput compact aria-label={`Clip ${i + 1} name`} value={c.name} maxLength={24} onChange={(e) => set(i, { name: e.target.value.toLowerCase() })} />
          <label className="num-field">
            <span className="field-label">From</span>
            <TextInput compact type="number" min={0} max={sprite.frameCount - 1} value={c.from} onChange={(e) => set(i, { from: num(e.target.value, 511) })} />
          </label>
          <label className="num-field">
            <span className="field-label">To</span>
            <TextInput compact type="number" min={0} max={sprite.frameCount - 1} value={c.to} onChange={(e) => set(i, { to: num(e.target.value, 511) })} />
          </label>
          <label className="num-field">
            <span className="field-label">FPS</span>
            <TextInput compact type="number" min={1} max={60} placeholder={String(sprite.fps)} value={c.fps ?? ''} onChange={(e) => set(i, { fps: e.target.value === '' ? null : Math.max(1, Math.min(60, Number(e.target.value) || 1)) })} />
          </label>
          <Checkbox label="Loop" checked={c.loop} onChange={(v) => set(i, { loop: v })} />
          <IconButton label={`Preview ${c.name || 'clip'}`} size="sm" pressed={previewing === i} onClick={() => (setPreviewing(i), setPlayKey((k) => k + 1))}>
            <Play size={14} aria-hidden="true" />
          </IconButton>
          <IconButton label={`Remove ${c.name || 'clip'}`} size="sm" onClick={() => (setClips((cs) => cs.filter((_, j) => j !== i)), setPreviewing(null))}>
            <X size={14} aria-hidden="true" />
          </IconButton>
        </div>
      ))}
      {problems.length > 0 && (
        <ul className="plain-list small is-error">
          {problems.slice(0, 4).map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      <div className="row-wrap">
        <Button
          size="sm"
          icon={<Plus size={14} aria-hidden="true" />}
          disabled={clips.length >= 16}
          onClick={() => {
            const name = CLIP_NAMES.find((n) => !clips.some((c) => c.name === n)) ?? `clip-${clips.length + 1}`;
            setClips((cs) => [...cs, { name, from: 0, to: sprite.frameCount - 1, fps: null, loop: name === 'idle' }]);
          }}
        >
          Add clip
        </Button>
        <Button size="sm" variant="primary" loading={saving} disabled={!changed || problems.length > 0} onClick={() => onSave(clips)}>
          Save clips
        </Button>
        {changed && (
          <Button size="sm" variant="ghost" onClick={() => setClips(sprite.clips)}>
            Discard
          </Button>
        )}
      </div>
      <SpritePreview asset={asset} sprite={sprite} clip={shown} playKey={playKey} />
      <p className="subtle small">{shown ? `Previewing “${shown.name}” (frames ${shown.from}–${shown.to}${shown.loop ? ', looping' : ', plays once'}).` : 'Previewing every frame. Choose ▶ on a clip to preview it.'}</p>
    </div>
  );
}

const PROVENANCE_LABELS: Record<AssetProvenance['kind'], string> = {
  upload: 'Uploaded file',
  'ai-tool': 'Made with an external AI image tool',
  figma: 'Rendered from Figma (read-only import)',
  'exported-screen': 'Exported design screen',
  pptx: 'Image from the lesson deck',
  bundled: 'Bundled sample',
};

/** Where the file came from. Creator-declared origins can be corrected; imports are recorded by the studio. */
function ProvenanceSection({ asset, onSave }: { asset: Asset; onSave: (p: AssetProvenance) => void }) {
  const p = asset.metadata.provenance;
  const editable = !p || p.kind === 'upload' || p.kind === 'ai-tool';
  const [kind, setKind] = useState<'upload' | 'ai-tool'>(p?.kind === 'ai-tool' ? 'ai-tool' : 'upload');
  const [tool, setTool] = useState(p?.tool ?? '');
  const [note, setNote] = useState(p?.note ?? '');
  useEffect(() => {
    setKind(p?.kind === 'ai-tool' ? 'ai-tool' : 'upload');
    setTool(p?.tool ?? '');
    setNote(p?.note ?? '');
  }, [asset.id, p]);
  return (
    <section className="stack-tight">
      <h3 className="h-sub-sm">Origin</h3>
      <p className="small">
        {p ? PROVENANCE_LABELS[p.kind] : asset.source === 'extracted' ? PROVENANCE_LABELS.pptx : 'Not recorded'}
        {p?.tool ? ` — ${p.tool}` : ''}
      </p>
      {p?.figma && (
        <p className="subtle small mono">
          File {p.figma.fileKey}
          {p.figma.nodeId ? ` · node ${p.figma.nodeId}` : ''}
          {p.figma.sourceVersion ? ` · version ${p.figma.sourceVersion}` : ''} · {p.figma.kind}
        </p>
      )}
      {p?.note && <p className="subtle small">{p.note}</p>}
      {editable && asset.kind === 'image' && (
        <details>
          <summary className="small">Correct the origin</summary>
          <div className="stack-tight">
            <Select aria-label="Origin" value={kind} onChange={(e) => setKind(e.target.value as 'upload' | 'ai-tool')}>
              <option value="upload">{PROVENANCE_LABELS.upload}</option>
              <option value="ai-tool">{PROVENANCE_LABELS['ai-tool']}</option>
            </Select>
            {kind === 'ai-tool' && <TextInput aria-label="Tool name" placeholder="Tool, e.g. ChatGPT" maxLength={60} value={tool} onChange={(e) => setTool(e.target.value)} />}
            <TextInput aria-label="Note" placeholder="Optional note (licence, who made it)" maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} />
            <Button size="sm" onClick={() => onSave({ kind, tool: kind === 'ai-tool' ? tool.trim() : '', note: note.trim(), figma: null, recordedAt: new Date().toISOString() })}>
              Save origin
            </Button>
          </div>
        </details>
      )}
    </section>
  );
}

function AssetDetail({ asset, projectId }: { asset: Asset; projectId: string }) {
  const qc = useQueryClient();
  const update = useUpdateAsset(projectId);
  const del = useDeleteAsset(projectId);
  const project = useProject(projectId);
  const bundle = usePreviewBundle(projectId, null, Boolean(project.data?.currentVersionId));
  const edit = useManualEdit(projectId);
  const { track } = useSaveStatus();
  const toast = useToast();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const replaceInput = useRef<HTMLInputElement>(null);
  const meta = asset.metadata;
  const save = (patch: Parameters<typeof update.mutate>[0]['patch'], label = 'Asset') =>
    void track(() => update.mutateAsync({ id: asset.id, patch })).catch((e) => toast({ tone: 'error', title: `${label} not saved`, detail: errorMessage(e).message }));
  const config = bundle.data?.config;
  const assign = (ops: ChangeOp[], summary: string, scope: { kind: 'scene' | 'project'; sceneId: string | null }) =>
    project.data?.currentVersionId &&
    void track(() => edit.mutateAsync({ baseVersionId: project.data!.currentVersionId!, ops, scope, summary }))
      .then(() => toast({ tone: 'success', title: summary, detail: 'Saved as a new game version.' }))
      .catch((e) => toast({ tone: 'error', title: 'Not assigned', detail: `${errorMessage(e).message} ${errorMessage(e).hint ?? ''}` }));
  const sprite: SpriteSheet = meta.sprite ?? { frameWidth: Math.max(1, Math.floor((asset.width ?? 64) / 4)), frameHeight: asset.height ?? 64, columns: 4, rows: 1, spacing: 0, frameCount: 4, fps: 8, anchorX: 0.5, anchorY: 1, clips: [] };

  return (
    <aside className="asset-detail panel" aria-label={`Details for ${asset.name}`}>
      <div className={`asset-preview${asset.kind === 'image' ? ' checker' : ''}`}>
        {asset.kind === 'image' ? <img src={`/api/assets/${asset.id}/file?variant=display`} alt={meta.alt || asset.name} /> : <audio controls preload="none" src={`/api/assets/${asset.id}/file?variant=display`} aria-label={`Play ${asset.name}`} />}
      </div>
      <div className="stack panel-pad">
        <Field label="Name" htmlFor="asset-name">
          <TextInput id="asset-name" defaultValue={asset.name} key={asset.id} maxLength={120} onBlur={(e) => e.target.value.trim() && e.target.value !== asset.name && save({ name: e.target.value.trim() }, 'Name')} />
        </Field>
        <Field label="Role" htmlFor="asset-role">
          <Select id="asset-role" value={asset.role} onChange={(e) => save({ role: e.target.value as AssetLibraryRole }, 'Role')}>
            {ROLE_CHOICES.map((r) => (
              <option key={r} value={r}>
                {ASSET_ROLE_LABELS[r]}
              </option>
            ))}
          </Select>
        </Field>
        <dl className="kv">
          <dt>Format</dt>
          <dd>
            {asset.format.toUpperCase()}
            {meta.rasterizedFromSvg ? ' (rasterized from SVG)' : ''}
          </dd>
          {asset.width && (
            <>
              <dt>Size</dt>
              <dd className="tabular">
                {asset.width} × {asset.height}px
              </dd>
            </>
          )}
          <dt>File</dt>
          <dd className="tabular">{formatBytes(asset.sizeBytes)}</dd>
          {asset.kind === 'image' && (
            <>
              <dt>Transparency</dt>
              <dd>{asset.hasAlpha ? 'Yes (alpha channel)' : 'No'}</dd>
            </>
          )}
          {asset.durationSeconds !== null && (
            <>
              <dt>Duration</dt>
              <dd>{asset.durationSeconds}s</dd>
            </>
          )}
          <dt>Source</dt>
          <dd>{asset.source === 'extracted' ? 'Extracted from the deck' : asset.source === 'bundled-sample' ? 'Bundled sample' : asset.source === 'figma' ? 'Imported from Figma' : 'Uploaded'}</dd>
          <dt>Added</dt>
          <dd>{formatDate(asset.createdAt)}</dd>
        </dl>
        <Field label="Alt text" htmlFor="asset-alt" help="Describes the image for screen-reader users.">
          <TextInput id="asset-alt" key={`${asset.id}-alt`} defaultValue={meta.alt} maxLength={160} onBlur={(e) => e.target.value !== meta.alt && save({ metadata: { alt: e.target.value } }, 'Alt text')} />
        </Field>
        <ProvenanceSection asset={asset} onSave={(provenance) => save({ metadata: { provenance } }, 'Origin')} />
        {asset.role === 'reference' && <p className="subtle small">Reference only: shown beside the game in Screens and never exported in the playable game.</p>}
        <section>
          <h3 className="h-sub-sm">Used in</h3>
          {asset.usage.length ? (
            <ul className="plain-list small">
              {asset.usage.map((u, i) => (
                <li key={i}>{u.label}</li>
              ))}
            </ul>
          ) : (
            <p className="subtle small">Not used yet.</p>
          )}
        </section>
        {asset.kind === 'image' && config && project.data?.currentVersionId && (
          <section className="stack">
            <h3 className="h-sub-sm">Assign in the current game</h3>
            <Select
              aria-label="Assign this image"
              value=""
              onChange={(e) => {
                const v = e.target.value;
                if (!v) return;
                if (v === 'theme-bg') assign([{ op: 'set-project-field', field: 'theme.backgroundAssetId', value: asset.id }], `Game background → ${asset.name}`, { kind: 'project', sceneId: null });
                else if (v === 'title-char') assign([{ op: 'set-project-field', field: 'screens.title.characterAssetId', value: asset.id }], `Title character → ${asset.name}`, { kind: 'project', sceneId: null });
                else {
                  const [role, sceneId] = v.split(':') as ['bg' | 'char', string];
                  assign([{ op: 'set-scene-field', sceneId, field: role === 'bg' ? 'assets.background' : 'assets.character', value: asset.id }], `${role === 'bg' ? 'Background' : 'Character'} for “${config.scenes.find((s) => s.id === sceneId)?.title}”`, { kind: 'scene', sceneId });
                }
              }}
            >
              <option value="">Choose where to use it…</option>
              <option value="theme-bg">Game background</option>
              <option value="title-char">Title screen character</option>
              {config.scenes.map((s, i) => (
                <optgroup key={s.id} label={`Scene ${i + 1}: ${s.title}`}>
                  <option value={`bg:${s.id}`}>Background</option>
                  <option value={`char:${s.id}`}>Character</option>
                </optgroup>
              ))}
            </Select>
            <p className="subtle small">Asset locks are respected; a conflicting assignment is refused with an explanation.</p>
          </section>
        )}
        {asset.kind === 'image' && (
          <details className="stack">
            <summary className="h-sub-sm">Placement</summary>
            <div className="num-row">
              {(
                [
                  ['scale', 'Scale', 0.1, 4, 0.1],
                  ['rotation', 'Rotation°', -180, 180, 1],
                  ['anchorX', 'Anchor x', 0, 1, 0.05],
                  ['anchorY', 'Anchor y', 0, 1, 0.05],
                ] as const
              ).map(([k, label, min, max, step]) => (
                <label key={k} className="num-field">
                  <span className="field-label">{label}</span>
                  <TextInput compact type="number" min={min} max={max} step={step} defaultValue={meta.placement[k]} key={`${asset.id}-${k}`} onBlur={(e) => save({ metadata: { placement: { ...meta.placement, [k]: Math.min(max, Math.max(min, Number(e.target.value))) } } }, 'Placement')} />
                </label>
              ))}
            </div>
            <Switch
              label="Crop"
              checked={Boolean(meta.placement.crop)}
              onChange={(v) => save({ metadata: { placement: { ...meta.placement, crop: v ? { x: 0, y: 0, w: 1, h: 1 } : null } } }, 'Crop')}
            />
            {meta.placement.crop && (
              <div className="num-row">
                {(['x', 'y', 'w', 'h'] as const).map((k) => (
                  <label key={k} className="num-field">
                    <span className="field-label">Crop {k}</span>
                    <TextInput compact type="number" min={0} max={1} step={0.05} defaultValue={meta.placement.crop![k]} key={`${asset.id}-c${k}`} onBlur={(e) => save({ metadata: { placement: { ...meta.placement, crop: { ...meta.placement.crop!, [k]: Math.min(1, Math.max(k === 'w' || k === 'h' ? 0.01 : 0, Number(e.target.value))) } } } }, 'Crop')} />
                  </label>
                ))}
              </div>
            )}
            <p className="subtle small">Placement is stored as metadata — the original file is never modified.</p>
          </details>
        )}
        {asset.kind === 'image' && (
          <details className="stack">
            <summary className="h-sub-sm">Sprite sheet</summary>
            <Switch label="This image is a sprite sheet" checked={Boolean(meta.sprite)} onChange={(v) => save({ metadata: { sprite: v ? sprite : null } }, 'Sprite')} />
            {!meta.sprite && <p className="subtle small">A single picture can only move, fade, scale or rotate as a whole. For waving or walking, use a sprite sheet, or combine separate frame images with “Combine frames” in the library.</p>}
            {meta.sprite && (
              <>
                <div className="num-row">
                  {(
                    [
                      ['frameWidth', 'Frame w'],
                      ['frameHeight', 'Frame h'],
                      ['columns', 'Columns'],
                      ['rows', 'Rows'],
                      ['spacing', 'Spacing'],
                      ['frameCount', 'Frames'],
                      ['fps', 'FPS'],
                    ] as const
                  ).map(([k, label]) => (
                    <label key={k} className="num-field">
                      <span className="field-label">{label}</span>
                      <TextInput compact type="number" min={k === 'spacing' ? 0 : 1} defaultValue={meta.sprite![k]} key={`${asset.id}-s${k}`} onBlur={(e) => save({ metadata: { sprite: { ...meta.sprite!, [k]: Math.max(k === 'spacing' ? 0 : 1, Math.round(Number(e.target.value))) } } }, 'Sprite')} />
                    </label>
                  ))}
                </div>
                <SpriteClips asset={asset} sprite={meta.sprite} saving={update.isPending} onSave={(clips) => save({ metadata: { sprite: { ...meta.sprite!, clips } } }, 'Clips')} />
              </>
            )}
          </details>
        )}
        <div className="row-wrap">
          <input
            ref={replaceInput}
            type="file"
            className="sr-only"
            tabIndex={-1}
            accept={asset.kind === 'image' ? '.png,.jpg,.jpeg,.webp,.svg' : '.mp3,.ogg,.wav,.m4a'}
            onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (!f) return;
              setReplacing(true);
              const form = new FormData();
              form.append('file', f, f.name);
              try {
                const r = await upload<{ asset: Asset; version: { number: number } | null }>(`/api/assets/${asset.id}/replace`, form, () => {});
                toast({ tone: 'success', title: `Replaced with “${r.asset.name}”`, detail: r.version ? `Placement kept. Saved as version ${r.version.number}.` : 'Placement kept.' });
                void qc.invalidateQueries({ queryKey: qk.assets(projectId) });
                void qc.invalidateQueries({ queryKey: qk.versions(projectId) });
                void qc.invalidateQueries({ queryKey: ['bundle', projectId] });
              } catch (err) {
                toast({ tone: 'error', title: 'Not replaced', detail: `${errorMessage(err).message} ${errorMessage(err).hint ?? ''}` });
              } finally {
                setReplacing(false);
              }
            }}
          />
          <Button size="sm" icon={<RefreshCw size={14} aria-hidden="true" />} loading={replacing} onClick={() => replaceInput.current?.click()}>
            Replace file
          </Button>
          <Button size="sm" variant="danger" icon={<Trash2 size={14} aria-hidden="true" />} onClick={() => setConfirmDelete(true)}>
            Delete
          </Button>
        </div>
      </div>
      <ConfirmDialog
        open={confirmDelete}
        title="Delete this asset?"
        confirmLabel="Delete asset"
        danger
        busy={del.isPending}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() =>
          del.mutate(asset.id, {
            onSuccess: () => setConfirmDelete(false),
            onError: (e) => {
              setConfirmDelete(false);
              toast({ tone: 'error', title: 'Not deleted', detail: `${errorMessage(e).message} ${errorMessage(e).hint ?? ''}` });
            },
          })
        }
      >
        <p>
          “{asset.name}” will be removed from this project. Assets used by any game version or blueprint cannot be deleted, so older versions always stay playable.
        </p>
      </ConfirmDialog>
    </aside>
  );
}

export function AssetsArea({ projectId }: { projectId: string }) {
  const assets = useAssets(projectId);
  const blueprints = useBlueprints(projectId);
  const toast = useToast();
  const [filter, setFilter] = useState<Filter>('all');
  const [selected, setSelected] = useState<string | null>(null);
  const compose = useComposeSprite(projectId);
  const [combining, setCombining] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [sheetName, setSheetName] = useState('');
  const [sheetFps, setSheetFps] = useState(8);
  const list = assets.data ?? [];
  const visible = filter === 'all' ? list : list.filter((a) => a.role === filter);
  const asset = list.find((a) => a.id === selected) ?? null;
  const counts = useMemo(() => Object.fromEntries(FILTERS.map((f) => [f, f === 'all' ? list.length : list.filter((a) => a.role === f).length])), [list]);
  const latest = blueprints.data?.[0]?.blueprint;
  const missing = (latest?.assetNeeds ?? []).filter((n) => n.required && !n.assignedAssetId);
  const prompts = (latest?.assetNeeds ?? [])
    .filter((n) => !n.assignedAssetId && n.role !== 'audio')
    .map((n) => `${n.description}. Flat, friendly educational illustration with clean shapes and high contrast, no text${n.role === 'character' ? ', transparent background, top-down view' : ', 16:9, 1920×1080'}.`);

  const left = (
    <nav className="asset-filters" aria-label="Asset types">
      <div className="panel-head">
        <h2>Assets</h2>
        <span className="subtle small">{list.length}</span>
      </div>
      <ul>
        {FILTERS.map((f) => (
          <li key={f}>
            <button type="button" className={`filter-item${filter === f ? ' is-selected' : ''}`} aria-pressed={filter === f} onClick={() => setFilter(f)}>
              {f === 'audio' ? <Music size={15} aria-hidden="true" /> : <ImageIcon size={15} aria-hidden="true" />}
              <span>{f === 'all' ? 'All assets' : ASSET_ROLE_LABELS[f]}</span>
              <span className="subtle small tabular">{counts[f]}</span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );

  const center = (
    <div className="canvas-inner">
      <header className="canvas-header">
        <div>
          <h1>Asset library</h1>
          <p className="subtitle">Originals are preserved. Displays and games use validated copies; SVGs are rasterized.</p>
        </div>
        <span className="spacer" />
        <Button icon={<Film size={16} aria-hidden="true" />} aria-pressed={combining} onClick={() => (setCombining((c) => !c), setPicked([]))}>
          Combine frames
        </Button>
      </header>
      <div className="asset-upload-row">
        <AssetUploader projectId={projectId} role={filter === 'all' || filter === 'reference' ? 'unassigned' : filter} label={filter === 'audio' ? 'Upload audio' : 'Upload images'} audio={filter === 'audio'} askOrigin={filter !== 'audio'} />
      </div>
      {combining && (
        <div className="combine-bar panel panel-pad stack-tight" role="region" aria-label="Combine frames into a sprite sheet">
          <p className="small">
            Click frame images in playing order — the same picture can be used more than once. All frames must be the same size; the originals are kept. The sheet is a new character asset — then name its clips (idle, wave, celebrate…).
          </p>
          {picked.length > 0 && (
            <ol className="frame-sequence" aria-label="Frames in order">
              {picked.map((id, i) => (
                <li key={`${id}-${i}`}>
                  <span className="checker">
                    <img src={`/api/assets/${id}/file?variant=thumb`} alt="" />
                  </span>
                  <span className="small truncate">
                    {i + 1}. {list.find((a) => a.id === id)?.name ?? id}
                  </span>
                  <IconButton label={`Remove frame ${i + 1}`} size="sm" onClick={() => setPicked((ps) => ps.filter((_, j) => j !== i))}>
                    <X size={12} aria-hidden="true" />
                  </IconButton>
                </li>
              ))}
            </ol>
          )}
          {(() => {
            const sizes = new Set(picked.map((id) => list.find((a) => a.id === id)).map((a) => `${a?.width}×${a?.height}`));
            return sizes.size > 1 ? <p className="small is-error">The picked frames have different sizes ({[...sizes].join(', ')}). Export every frame at the same size.</p> : null;
          })()}
          <div className="row-wrap">
            <TextInput compact className="sheet-name" aria-label="Sprite sheet name" placeholder="Sheet name, e.g. Swiftee frames" maxLength={120} value={sheetName} onChange={(e) => setSheetName(e.target.value)} />
            <label className="num-field">
              <span className="field-label">FPS</span>
              <TextInput compact type="number" min={1} max={30} value={sheetFps} onChange={(e) => setSheetFps(Math.max(1, Math.min(30, Math.round(Number(e.target.value) || 8))))} />
            </label>
            <Button
              variant="primary"
              size="sm"
              loading={compose.isPending}
              disabled={picked.length < 2 || picked.length > 64 || !sheetName.trim()}
              onClick={() =>
                compose.mutate(
                  { assetIds: picked, name: sheetName.trim(), fps: sheetFps },
                  {
                    onSuccess: (a) => {
                      toast({ tone: 'success', title: `Created “${a.name}”`, detail: `${picked.length} frames combined. Name its clips in the details panel.` });
                      setCombining(false);
                      setPicked([]);
                      setSheetName('');
                      setFilter('all');
                      setSelected(a.id);
                    },
                    onError: (e) => toast({ tone: 'error', title: 'Not combined', detail: `${errorMessage(e).message} ${errorMessage(e).hint ?? ''}` }),
                  },
                )
              }
            >
              Combine {picked.length || ''} frames
            </Button>
            {picked.length > 0 && (
              <Button size="sm" variant="ghost" onClick={() => setPicked([])}>
                Clear
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => (setCombining(false), setPicked([]))}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {missing.length > 0 && (
        <Banner tone="warning" title="Missing required artwork">
          {missing.map((m) => m.description).join(' · ')} — the game uses built-in artwork until you assign something. A random replacement is never chosen for you.
        </Banner>
      )}
      {assets.isLoading ? (
        <Spinner large label="Loading assets…" />
      ) : visible.length === 0 ? (
        <EmptyState icon={<ImageIcon size={24} aria-hidden="true" />} title={filter === 'all' ? 'No assets yet' : `No ${ASSET_ROLE_LABELS[filter as AssetLibraryRole].toLowerCase()}`}>
          Images from your deck appear here automatically. Upload PNG, JPEG, WebP or SVG images, or MP3, OGG, WAV or M4A audio.
        </EmptyState>
      ) : (
        <div className={`asset-layout${asset ? ' has-detail' : ''}`}>
          <ul className="asset-grid">
            {visible.map((a) => (
              <li key={a.id}>
                <button
                  type="button"
                  className={`asset-card${(combining ? picked.includes(a.id) : a.id === selected) ? ' is-selected' : ''}`}
                  aria-pressed={combining ? picked.includes(a.id) : a.id === selected}
                  disabled={combining && a.kind !== 'image'}
                  aria-label={combining ? `Add ${a.name} as frame ${picked.length + 1}` : undefined}
                  onClick={() => (combining ? setPicked((ps) => (ps.length < 64 ? [...ps, a.id] : ps)) : setSelected(a.id === selected ? null : a.id))}
                >
                  {combining && picked.includes(a.id) && (
                    <span className="pick-order" aria-hidden="true">
                      {picked.flatMap((x, i) => (x === a.id ? [i + 1] : [])).join(', ')}
                    </span>
                  )}
                  <span className={`asset-thumb${a.kind === 'image' ? ' checker' : ''}`}>
                    {a.kind === 'image' ? <img src={`/api/assets/${a.id}/file?variant=thumb`} alt="" loading="lazy" /> : <Music size={28} aria-hidden="true" />}
                  </span>
                  <span className="asset-name truncate">{a.name}</span>
                  <span className="asset-meta subtle small tabular">
                    {a.width ? `${a.width}×${a.height}` : a.format.toUpperCase()} · {formatBytes(a.sizeBytes)}
                  </span>
                  <span className="row-wrap">
                    <Pill tone={a.usage.length ? 'success' : 'neutral'}>{a.usage.length ? `Used ${a.usage.length}×` : 'Unused'}</Pill>
                    {a.hasAlpha && <Pill tone="info" dot={false}>Alpha</Pill>}
                    {a.metadata.sprite && <Pill tone="info" dot={false}>Sprite · {a.metadata.sprite.clips.length} clip{a.metadata.sprite.clips.length === 1 ? '' : 's'}</Pill>}
                    {a.role === 'reference' && <Pill tone="neutral" dot={false}>Reference only</Pill>}
                    {a.metadata.provenance?.kind === 'ai-tool' && <Pill tone="ai" dot={false}>{a.metadata.provenance.tool || 'AI tool'}</Pill>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {asset && !combining && <AssetDetail asset={asset} projectId={projectId} />}
        </div>
      )}
      {prompts.length > 0 && (
        <section className="panel panel-pad stack">
          <h2 className="h-sub">Prompts for artwork you still need</h2>
          <p className="subtle small">NEXUS does not generate images — copy these into an image tool you choose, then upload the result here.</p>
          {prompts.map((p, i) => (
            <div key={i} className="prompt-row">
              <TextArea readOnly rows={2} value={p} aria-label={`Generation prompt ${i + 1}`} />
              <Button size="sm" icon={<Copy size={14} aria-hidden="true" />} onClick={() => void navigator.clipboard.writeText(p).then(() => toast({ tone: 'success', title: 'Prompt copied' }))}>
                Copy
              </Button>
            </div>
          ))}
        </section>
      )}
      {list.some((a) => a.usage.length === 0 && a.source === 'extracted') && (
        <p className="subtle small">
          <TriangleAlert size={13} aria-hidden="true" /> Some deck images are not used in the game yet — assign them from the details panel if they should appear.
        </p>
      )}
    </div>
  );

  return (
    <Workspace
      leftLabel="Asset types"
      left={left}
      center={center}
      right={<ClaudePanel projectId={projectId} area="assets" mode="ask" scopes={[{ scope: { kind: 'project', sceneId: null, slideId: null }, label: 'Whole project' }]} examples={['Which scenes still use built-in artwork?', 'What kind of background would suit this lesson?']} />}
    />
  );
}
