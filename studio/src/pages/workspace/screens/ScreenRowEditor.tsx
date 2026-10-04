import { useMemo, useState } from 'react';
import { Check, Plus, Trash2 } from 'lucide-react';
import type { Asset } from '@shared/schemas/assets.ts';
import { FIDELITY_LABELS, frameToStage, mapBox, type DesignFrame } from '@shared/schemas/design.ts';
import { ROLE_LABELS, type ScreenMapEntry, type SourceConflict } from '@shared/schemas/screens.ts';
import type { SourceSlide } from '@shared/schemas/source.ts';
import { primaryFrame } from '@shared/screens/layout.ts';
import { Button, Checkbox, Field, Select, TextArea, TextInput } from '../../../components/ui/controls.tsx';
import { Banner, Pill } from '../../../components/ui/feedback.tsx';

const FIDELITY_TONE = { editable: 'success', flattened: 'info', reference: 'neutral', 'needs-review': 'warning' } as const;
const USE_LABELS: Record<string, string> = {
  layer: 'Rebuild as a game layer',
  background: 'Use as background',
  'instruction-region': 'Instruction panel goes here',
  'play-region': 'Play area goes here',
  reference: 'Reference only',
  ignore: 'Ignore',
};

function slugId(prefix: string, text: string, taken: string[]): string {
  const base = `${prefix}-${text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 18) || 'item'}`;
  let id = base;
  for (let i = 2; taken.includes(id); i++) id = `${base.slice(0, 20)}-${i}`;
  return id;
}

export function ScreenRowEditor({
  entry,
  update,
  frames,
  slides,
  assets,
  mechanic,
}: {
  entry: ScreenMapEntry;
  update: (fn: (e: ScreenMapEntry) => ScreenMapEntry) => void;
  frames: DesignFrame[];
  slides: SourceSlide[];
  assets: Asset[];
  mechanic: string | null;
}) {
  const frameMap = useMemo(() => new Map(frames.map((f) => [f.id, f])), [frames]);
  const primary = primaryFrame(entry, frameMap);
  const images = assets.filter((a) => a.kind === 'image');
  const [addFrame, setAddFrame] = useState('');
  const set = <K extends keyof ScreenMapEntry>(k: K, v: ScreenMapEntry[K]) => update((e) => ({ ...e, [k]: v }));
  const useOf = (elementId: string) => entry.layers.find((l) => l.elementId === elementId)?.use ?? 'ignore';
  const setUse = (elementId: string, use: string) =>
    update((e) => {
      const rest = e.layers.filter((l) => l.elementId !== elementId && !(use === 'instruction-region' && l.use === 'instruction-region') && !(use === 'play-region' && l.use === 'play-region'));
      return { ...e, layers: use === 'ignore' ? rest : [...rest, { elementId, use: use as ScreenMapEntry['layers'][number]['use'] }] };
    });
  const bgFrame = entry.background.frameId ? frameMap.get(entry.background.frameId) : null;
  const bakedTexts = entry.background.kind === 'frame-render' && bgFrame ? bgFrame.elements.filter((e) => e.kind === 'text' || e.bakedText) : [];
  const characterAsset = entry.assets.character ? assets.find((a) => a.id === entry.assets.character) : null;
  const resolve = (c: SourceConflict, choice: NonNullable<SourceConflict['resolution']>['choice'], text: string | null) =>
    update((e) => ({ ...e, conflicts: e.conflicts.map((x) => (x.id === c.id ? { ...x, status: 'resolved', resolution: { choice, text, note: '', at: new Date().toISOString() } } : x)) }));

  return (
    <div className="screen-editor stack">
      <div className="row-wrap">
        <h2 className="h-sub">{entry.title}</h2>
        <Pill tone="neutral" dot={false}>
          {entry.kind === 'scene' ? (mechanic ?? 'scene') : entry.kind}
        </Pill>
        <span className="spacer" />
        <Checkbox label="Reviewed" checked={entry.reviewed} onChange={(v) => set('reviewed', v)} />
      </div>

      <details open>
        <summary className="h-sub-sm">Linked sources</summary>
        {entry.kind === 'scene' ? (
          <Field label="PowerPoint slides (several can feed one screen)" htmlFor={`slides-${entry.screenId}`}>
            <div className="slide-picks" id={`slides-${entry.screenId}`}>
              {slides.map((s) => (
                <Checkbox
                  key={s.id}
                  label={`${s.slideNumber}. ${s.extract.title || 'Untitled'}${s.hidden ? ' (hidden)' : ''}`}
                  checked={entry.slideIds.includes(s.id)}
                  onChange={(on) => set('slideIds', on ? [...entry.slideIds, s.id] : entry.slideIds.filter((x) => x !== s.id))}
                />
              ))}
            </div>
          </Field>
        ) : (
          <p className="subtle small">The {entry.kind} screen has no lesson slides.</p>
        )}
        <div className="field">
          <span className="field-label">Figma frames and states (several states can belong to one screen)</span>
          {entry.frames.length === 0 && <p className="subtle small">No frame linked — the built-in layout is used.</p>}
          <ul className="frame-links">
            {entry.frames.map((l) => {
              const f = frameMap.get(l.frameId);
              return (
                <li key={l.frameId}>
                  <span className="frame-thumb small checker">{f?.renderAssetId ? <img src={`/api/assets/${f.renderAssetId}/file?variant=thumb`} alt="" /> : null}</span>
                  <span className="truncate">{f?.name ?? 'Missing frame'}</span>
                  <TextInput
                    compact
                    aria-label={`State name for ${f?.name ?? 'frame'}`}
                    value={l.state}
                    maxLength={40}
                    onChange={(e) => update((x) => ({ ...x, frames: x.frames.map((y) => (y.frameId === l.frameId ? { ...y, state: e.target.value || 'state' } : y)) }))}
                  />
                  <label className="check small">
                    <input type="radio" name={`primary-${entry.screenId}`} checked={l.primary} onChange={() => update((x) => ({ ...x, frames: x.frames.map((y) => ({ ...y, primary: y.frameId === l.frameId })) }))} /> Use for layout
                  </label>
                  <button type="button" className="link-btn" aria-label={`Unlink ${f?.name ?? 'frame'}`} onClick={() => update((x) => ({ ...x, frames: x.frames.filter((y) => y.frameId !== l.frameId), layers: l.primary ? [] : x.layers }))}>
                    <Trash2 size={14} aria-hidden="true" />
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="row">
            <Select aria-label="Frame to link" value={addFrame} onChange={(e) => setAddFrame(e.target.value)}>
              <option value="">Link a frame…</option>
              {frames
                .filter((f) => !entry.frames.some((l) => l.frameId === f.id))
                .map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name} ({Math.round(f.width)}×{Math.round(f.height)}, {f.source === 'figma' ? 'Figma' : 'exported'})
                  </option>
                ))}
            </Select>
            <Button
              size="sm"
              icon={<Plus size={14} aria-hidden="true" />}
              disabled={!addFrame}
              onClick={() => {
                update((x) => ({ ...x, frames: [...x.frames, { frameId: addFrame, state: x.frames.length ? `state-${x.frames.length + 1}` : 'default', primary: x.frames.length === 0 }], roles: x.frames.length === 0 ? { ...x.roles, layout: 'figma' } : x.roles }));
                setAddFrame('');
              }}
            >
              Link
            </Button>
          </div>
          <p className="subtle small">Links are explicit: matching counts or numbers in names never link a frame by themselves.</p>
        </div>
      </details>

      <details open>
        <summary className="h-sub-sm">Source roles</summary>
        <div className="form-grid">
          <Field label="Lesson wording comes from" htmlFor={`role-c-${entry.screenId}`}>
            <Select id={`role-c-${entry.screenId}`} value={entry.roles.content} onChange={(e) => set('roles', { ...entry.roles, content: e.target.value as ScreenMapEntry['roles']['content'] })}>
              {(Object.entries(ROLE_LABELS.content) as Array<[string, string]>).map(([v, l]) => (
                <option key={v} value={v} disabled={v === 'figma' && !primary}>
                  {l}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Layout and style come from" htmlFor={`role-l-${entry.screenId}`}>
            <Select id={`role-l-${entry.screenId}`} value={entry.roles.layout} onChange={(e) => set('roles', { ...entry.roles, layout: e.target.value as ScreenMapEntry['roles']['layout'] })}>
              {(Object.entries(ROLE_LABELS.layout) as Array<[string, string]>).map(([v, l]) => (
                <option key={v} value={v} disabled={v === 'figma' && !primary}>
                  {l}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Exact artwork comes from" htmlFor={`role-a-${entry.screenId}`}>
            <Select id={`role-a-${entry.screenId}`} value={entry.roles.artwork} onChange={(e) => set('roles', { ...entry.roles, artwork: e.target.value as ScreenMapEntry['roles']['artwork'] })}>
              {(Object.entries(ROLE_LABELS.artwork) as Array<[string, string]>).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </details>

      {entry.roles.layout === 'figma' && primary && (
        <details open>
          <summary className="h-sub-sm">Design</summary>
          <div className="form-grid">
            <div className="field">
              <span className="field-label">Mode</span>
              <div className="segmented" role="group" aria-label="Design mode">
                <button type="button" aria-pressed={entry.designMode === 'match'} onClick={() => set('designMode', 'match')}>
                  Match my design
                </button>
                <button type="button" aria-pressed={entry.designMode === 'adapt'} onClick={() => set('designMode', 'adapt')}>
                  Adapt my design
                </button>
              </div>
              <p className="field-help">{entry.designMode === 'match' ? 'Keeps the approved composition, colours, artwork and relative placement.' : 'Layout changes for learning or accessibility are made explicitly below (regions, layers) and reviewed.'}</p>
            </div>
            <div className="field">
              <span className="field-label">Fit to the 1920×1080 stage</span>
              <div className="segmented" role="group" aria-label="Fit">
                <button type="button" aria-pressed={entry.fit === 'contain'} onClick={() => set('fit', 'contain')}>
                  Letterbox (nothing cropped)
                </button>
                <button type="button" aria-pressed={entry.fit === 'cover'} onClick={() => set('fit', 'cover')}>
                  Fill (crops the edges)
                </button>
              </div>
              <p className="field-help">
                Frame {Math.round(primary.width)}×{Math.round(primary.height)} · scale {frameToStage({ w: primary.width, h: primary.height }, entry.fit).scale.toFixed(2)} — never stretched.
              </p>
            </div>
          </div>
          {primary.fonts.some((f) => !f.available) && (
            <Banner tone="warning" title="Font substitution">
              {primary.fonts
                .filter((f) => !f.available)
                .map((f) => `“${f.family}” → ${f.substitute}`)
                .join(', ')}
              . Design fonts are never redistributed with the game.
            </Banner>
          )}
          <div className="field">
            <span className="field-label">Layers ({primary.elements.length})</span>
            <div className="layer-table-wrap">
              <table className="layer-table">
                <thead>
                  <tr>
                    <th scope="col">Layer</th>
                    <th scope="col">Badge</th>
                    <th scope="col">Use in the game</th>
                  </tr>
                </thead>
                <tbody>
                  {primary.elements
                    .filter((e) => e.depth <= 3)
                    .map((e) => (
                      <tr key={e.id}>
                        <td>
                          <span className="truncate block">{e.name}</span>
                          <span className="subtle small">{e.text ? `“${e.text.characters.slice(0, 60)}”` : `${e.kind} · ${Math.round(e.box.w)}×${Math.round(e.box.h)}`}</span>
                          {e.notes.length > 0 && <span className="subtle small block">{e.notes[0]}</span>}
                        </td>
                        <td>
                          <Pill tone={FIDELITY_TONE[e.fidelity]} dot={false}>
                            {FIDELITY_LABELS[e.fidelity]}
                          </Pill>
                        </td>
                        <td>
                          <Select aria-label={`Use of ${e.name}`} value={useOf(e.id)} onChange={(ev) => setUse(e.id, ev.target.value)}>
                            {Object.entries(USE_LABELS).map(([v, l]) => (
                              <option key={v} value={v} disabled={(v === 'layer' && (e.fidelity === 'reference' || (e.kind !== 'text' && e.kind !== 'rect' && e.kind !== 'image'))) || (v === 'background' && !e.assetId)}>
                                {l}
                              </option>
                            ))}
                          </Select>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
            <p className="field-help">Only text, solid shapes and image placements can be rebuilt. Buttons and controls are always native game controls; interaction never comes from the picture.</p>
          </div>
          {primary.prototype.length > 0 && (
            <div className="field">
              <span className="field-label">Prototype interactions (design evidence only)</span>
              <ul className="plain-list small">
                {primary.prototype.slice(0, 6).map((p, i) => (
                  <li key={i}>
                    “{p.nodeName}” {p.trigger.toLowerCase().replace(/_/g, ' ')} → {p.action === 'URL' ? 'opens a link (ignored)' : p.action.toLowerCase()}
                    {p.transition ? ` · ${p.transition.type.toLowerCase().replace(/_/g, ' ')} ${p.transition.durationMs ?? '?'} ms` : ''}
                  </li>
                ))}
              </ul>
              <p className="field-help">Not executed. Translate a transition with a supported scene transition in Animate if you want it.</p>
            </div>
          )}
        </details>
      )}

      <details open>
        <summary className="h-sub-sm">Background</summary>
        <div className="form-grid">
          <Field label="Background" htmlFor={`bg-${entry.screenId}`}>
            <Select
              id={`bg-${entry.screenId}`}
              value={entry.background.kind === 'asset' ? `asset:${entry.background.assetId}` : entry.background.kind === 'frame-render' ? `render:${entry.background.frameId}` : entry.background.kind === 'frame-element' ? `element:${entry.background.frameId}:${entry.background.elementId}` : 'none'}
              onChange={(e) => {
                const v = e.target.value;
                if (v === 'none') set('background', { kind: 'none', assetId: null, frameId: null, elementId: null, confirmedClean: false });
                else if (v.startsWith('asset:')) set('background', { kind: 'asset', assetId: v.slice(6), frameId: null, elementId: null, confirmedClean: false });
                else if (v.startsWith('render:')) set('background', { kind: 'frame-render', assetId: null, frameId: v.slice(7), elementId: null, confirmedClean: false });
                else {
                  const [, fid, eid] = v.split(':');
                  set('background', { kind: 'frame-element', assetId: null, frameId: fid ?? null, elementId: v.slice(`element:${fid}:`.length) || eid || null, confirmedClean: false });
                }
              }}
            >
              <option value="none">Theme / blueprint background</option>
              <optgroup label="Your uploads">
                {images
                  .filter((a) => a.role === 'background' || a.role === 'unassigned' || a.role === 'reference')
                  .map((a) => (
                    <option key={a.id} value={`asset:${a.id}`}>
                      {a.name}
                    </option>
                  ))}
              </optgroup>
              {entry.frames.map((l) => {
                const f = frameMap.get(l.frameId);
                if (!f) return null;
                return (
                  <optgroup key={l.frameId} label={`Design: ${f.name}`}>
                    {f.renderAssetId && <option value={`render:${f.id}`}>Whole design picture (text baked in)</option>}
                    {f.elements
                      .filter((e) => e.kind === 'image' && e.assetId)
                      .map((e) => (
                        <option key={e.id} value={`element:${f.id}:${e.id}`}>
                          Layer: {e.name}
                        </option>
                      ))}
                  </optgroup>
                );
              })}
            </Select>
          </Field>
        </div>
        {entry.background.kind === 'frame-render' && (
          <Banner tone="warning" title="Text and buttons in this picture would appear twice">
            {bakedTexts.length ? `It includes ${bakedTexts.length} text layer(s), e.g. “${(bakedTexts[0]!.text?.characters ?? bakedTexts[0]!.name).slice(0, 50)}”.` : 'Exported screens are flat pictures.'} The game adds its own readable instructions and controls. Ask the designer for a clean background layer, or confirm this one is clean.
            <Checkbox label="This picture has no baked text or buttons" checked={entry.background.confirmedClean} onChange={(v) => set('background', { ...entry.background, confirmedClean: v })} />
          </Banner>
        )}
      </details>

      <details open>
        <summary className="h-sub-sm">Artwork</summary>
        <div className="form-grid">
          <Field label="Character" htmlFor={`char-${entry.screenId}`} help={entry.kind === 'scene' && mechanic === 'coordinate-navigation' ? 'On a coordinate screen the character is the mover.' : 'Shown beside the instructions.'}>
            <Select id={`char-${entry.screenId}`} value={entry.assets.character ?? ''} onChange={(e) => set('assets', { ...entry.assets, character: e.target.value || null, characterClip: null })}>
              <option value="">Keep the game's character</option>
              {images
                .filter((a) => a.role === 'character' || a.role === 'object' || a.role === 'unassigned')
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                    {a.metadata.sprite ? ` (sprite: ${a.metadata.sprite.clips.map((c) => c.name).join(', ') || 'no clips'})` : ' (static picture)'}
                  </option>
                ))}
            </Select>
          </Field>
          {characterAsset?.metadata.sprite && (
            <Field label="Idle clip" htmlFor={`clip-${entry.screenId}`}>
              <Select id={`clip-${entry.screenId}`} value={entry.assets.characterClip ?? ''} onChange={(e) => set('assets', { ...entry.assets, characterClip: e.target.value || null })}>
                <option value="">First frame (still)</option>
                {characterAsset.metadata.sprite.clips.map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {entry.kind === 'scene' && (
            <>
              <Field label="Instruction panel artwork" htmlFor={`panel-${entry.screenId}`} help="A blank panel: the game writes readable text on it.">
                <Select id={`panel-${entry.screenId}`} value={entry.assets.panel ?? ''} onChange={(e) => set('assets', { ...entry.assets, panel: e.target.value || null })}>
                  <option value="">Theme panel</option>
                  {images
                    .filter((a) => a.role === 'ui' || a.role === 'unassigned')
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                </Select>
              </Field>
              <Field label="Button artwork" htmlFor={`button-${entry.screenId}`} help="Text-free art; labels stay native and accessible.">
                <Select id={`button-${entry.screenId}`} value={entry.assets.button ?? ''} onChange={(e) => set('assets', { ...entry.assets, button: e.target.value || null })}>
                  <option value="">Theme buttons</option>
                  {images
                    .filter((a) => a.role === 'ui' || a.role === 'unassigned')
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                </Select>
              </Field>
            </>
          )}
        </div>
        <div className="field">
          <span className="field-label">Placed objects ({entry.objects.length})</span>
          {entry.objects.map((o, idx) => (
            <div key={o.id} className="object-row">
              <strong className="truncate">{o.label}</strong>
              {(['x', 'y', 'width', 'height'] as const).map((k) => (
                <label key={k} className="num-field">
                  <span>{k === 'width' ? 'w' : k === 'height' ? 'h' : k}</span>
                  <input
                    className="input input-sm"
                    type="number"
                    value={Math.round(o[k])}
                    onChange={(e) => {
                      const n = Number(e.target.value);
                      if (!Number.isFinite(n)) return;
                      update((x) => ({ ...x, objects: x.objects.map((y, j) => (j === idx ? { ...y, [k]: k === 'width' || k === 'height' ? Math.max(8, n) : n } : y)) }));
                    }}
                  />
                </label>
              ))}
              <label className="num-field">
                <span>z</span>
                <input className="input input-sm" type="number" min={-10} max={10} value={o.z} onChange={(e) => update((x) => ({ ...x, objects: x.objects.map((y, j) => (j === idx ? { ...y, z: Math.max(-10, Math.min(10, Math.round(Number(e.target.value) || 0))) } : y)) }))} />
              </label>
              <button type="button" className="link-btn" aria-label={`Remove ${o.label}`} onClick={() => update((x) => ({ ...x, objects: x.objects.filter((_, j) => j !== idx) }))}>
                <Trash2 size={14} aria-hidden="true" />
              </button>
            </div>
          ))}
          <div className="row-wrap">
            <Select
              aria-label="Place an asset on this screen"
              value=""
              onChange={(e) => {
                const a = images.find((x) => x.id === e.target.value);
                if (!a) return;
                const h = 220;
                const w = Math.round(((a.metadata.sprite?.frameWidth ?? a.width ?? 220) / (a.metadata.sprite?.frameHeight ?? a.height ?? 220)) * h);
                update((x) => ({ ...x, objects: [...x.objects, { id: slugId('obj', a.name, x.objects.map((o) => o.id)), assetId: a.id, label: a.name.slice(0, 40) || 'Object', x: 1500, y: 760, width: w, height: h, z: 1, rotation: 0, role: 'decor', clip: a.metadata.sprite?.clips[0]?.name ?? null }] }));
              }}
            >
              <option value="">Place an asset…</option>
              {images.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
            {primary && entry.objects.length > 0 && (
              <Select
                aria-label="Snap the last object to a design layer"
                value=""
                onChange={(e) => {
                  const el = primary.elements.find((x) => x.id === e.target.value);
                  if (!el) return;
                  const b = mapBox(el.box, frameToStage({ w: primary.width, h: primary.height }, entry.fit));
                  update((x) => ({ ...x, objects: x.objects.map((o, j) => (j === x.objects.length - 1 ? { ...o, x: Math.round(b.x), y: Math.round(b.y), width: Math.max(8, Math.round(b.w)), height: Math.max(8, Math.round(b.h)) } : o)) }));
                }}
              >
                <option value="">Put the last object where a design layer is…</option>
                {primary.elements
                  .filter((x) => x.kind === 'image' || x.kind === 'artwork' || x.kind === 'rect')
                  .map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name}
                    </option>
                  ))}
              </Select>
            )}
          </div>
          <p className="field-help">Objects are decorative pictures in stage pixels (1920×1080). They never take input; sprites play their idle clip.</p>
        </div>
      </details>

      <details open={entry.conflicts.some((c) => c.status === 'open')}>
        <summary className="h-sub-sm">
          Source conflicts ({entry.conflicts.filter((c) => c.status === 'open').length} open)
        </summary>
        {entry.conflicts.length === 0 && <p className="subtle small">None found by the rule checks (definitions, opposite statements, numbers, labels).</p>}
        {entry.conflicts.map((c) => (
          <div key={c.id} className={`conflict is-${c.status}`}>
            <p>
              <Pill tone={c.status === 'open' ? 'warning' : 'success'}>{c.kind}</Pill> {c.message}
            </p>
            <div className="conflict-texts">
              <blockquote>
                <span className="subtle small">PowerPoint</span>
                {c.pptText}
              </blockquote>
              <blockquote>
                <span className="subtle small">Figma</span>
                {c.figmaText}
              </blockquote>
            </div>
            {c.status === 'open' ? (
              <div className="row-wrap">
                <Button size="sm" onClick={() => resolve(c, 'ppt', null)}>
                  Use the PowerPoint wording
                </Button>
                <Button size="sm" onClick={() => resolve(c, 'figma', c.figmaText)}>
                  Use the Figma wording
                </Button>
                <Button size="sm" variant="ghost" onClick={() => resolve(c, 'not-a-conflict', null)}>
                  Not a conflict
                </Button>
              </div>
            ) : (
              <p className="subtle small">
                <Check size={13} aria-hidden="true" /> Resolved: {c.resolution?.choice === 'ppt' ? 'PowerPoint wording kept' : c.resolution?.choice === 'figma' ? 'Figma wording used' : c.resolution?.choice === 'custom' ? 'your wording' : 'not a conflict'}.{' '}
                <button type="button" className="link-btn" onClick={() => update((e) => ({ ...e, conflicts: e.conflicts.map((x) => (x.id === c.id ? { ...x, status: 'open', resolution: null } : x)) }))}>
                  Reopen
                </button>
              </p>
            )}
          </div>
        ))}
        <p className="field-help">Neither source is overwritten; the choice is saved with this map revision.</p>
      </details>

      <details>
        <summary className="h-sub-sm">Corrections ({entry.corrections.length})</summary>
        {entry.corrections.map((c) => (
          <div key={c.id} className="correction">
            <p className="small">
              <strong>{c.field}</strong>: “{c.before.slice(0, 80)}” → “{c.after.slice(0, 120)}” <span className="subtle">({c.reason || 'no reason given'})</span>
            </p>
            <Checkbox label="Reviewed — use this correction" checked={c.reviewed} onChange={(v) => update((e) => ({ ...e, corrections: e.corrections.map((x) => (x.id === c.id ? { ...x, reviewed: v } : x)) }))} />
          </div>
        ))}
        <CorrectionForm
          onAdd={(c) => update((e) => ({ ...e, corrections: [...e.corrections, { ...c, id: slugId('cr', c.field, e.corrections.map((x) => x.id)), reviewed: false, at: new Date().toISOString(), elementId: null, before: c.before }] }))}
        />
        <p className="field-help">A correction is versioned with the map and needs review before it is used. The original slide or design is never edited.</p>
      </details>

      <Field label="Notes" htmlFor={`notes-${entry.screenId}`}>
        <TextArea id={`notes-${entry.screenId}`} rows={2} maxLength={400} value={entry.notes} onChange={(e) => set('notes', e.target.value)} />
      </Field>
    </div>
  );
}

function CorrectionForm({ onAdd }: { onAdd: (c: { field: 'title' | 'instruction' | 'label'; before: string; after: string; reason: string }) => void }) {
  const [field, setField] = useState<'title' | 'instruction'>('instruction');
  const [after, setAfter] = useState('');
  const [reason, setReason] = useState('');
  return (
    <div className="correction-form stack-tight">
      <div className="row-wrap">
        <Select aria-label="Field to correct" value={field} onChange={(e) => setField(e.target.value as 'title' | 'instruction')}>
          <option value="instruction">Instruction</option>
          <option value="title">Screen title</option>
        </Select>
        <TextInput compact aria-label="Corrected text" placeholder="Corrected text" maxLength={300} value={after} onChange={(e) => setAfter(e.target.value)} />
        <TextInput compact aria-label="Reason" placeholder="Why" maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />
        <Button
          size="sm"
          disabled={!after.trim()}
          onClick={() => {
            onAdd({ field, before: '', after: after.trim(), reason: reason.trim() });
            setAfter('');
            setReason('');
          }}
        >
          Add correction
        </Button>
      </div>
    </div>
  );
}
