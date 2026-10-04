import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import type { CoordinateInteraction, CoordinateRule, InfoInteraction, MatchInteraction, SceneInteraction, SortInteraction } from '@shared/schemas/interaction.ts';
import type { Asset } from '@shared/schemas/assets.ts';
import { Button, Checkbox, Field, IconButton, Segmented, Select, Switch, TextArea, TextInput } from '../ui/controls.tsx';

/**
 * Structured editors for each supported scene type. Answers are always data
 * (points, pairs, orders) — there is nowhere to type a formula or code.
 */

type Props<T> = { value: T; onChange: (v: T) => void; locked: { answer: boolean; wording: boolean }; images: Asset[] };

let counter = 0;
function newLocalId(prefix: string, taken: string[]): string {
  let id = '';
  do id = `${prefix}${++counter}`;
  while (taken.includes(id));
  return id;
}

function Num({ label, value, onChange, disabled, min, max }: { label: string; value: number; onChange: (v: number) => void; disabled?: boolean; min?: number; max?: number }) {
  return (
    <label className="num-field">
      <span className="field-label">{label}</span>
      <TextInput compact type="number" value={value} min={min} max={max} disabled={disabled} onChange={(e) => onChange(Math.round(Number(e.target.value) || 0))} />
    </label>
  );
}

function ImageSelect({ value, images, onChange, disabled, label }: { value: string | null; images: Asset[]; onChange: (v: string | null) => void; disabled?: boolean; label: string }) {
  if (images.length === 0) return null;
  return (
    <Select aria-label={label} value={value ?? ''} disabled={disabled} onChange={(e) => onChange(e.target.value || null)}>
      <option value="">No image</option>
      {images.map((a) => (
        <option key={a.id} value={a.id}>
          {a.name}
        </option>
      ))}
    </Select>
  );
}

function InfoEditor({ value, onChange, locked }: Props<InfoInteraction>) {
  return (
    <div className="stack">
      {value.points.map((p, i) => (
        <div key={i} className="row">
          <TextInput aria-label={`Point ${i + 1}`} value={p} maxLength={140} disabled={locked.wording} onChange={(e) => onChange({ ...value, points: value.points.map((x, j) => (j === i ? e.target.value : x)) })} />
          <IconButton label={`Remove point ${i + 1}`} size="sm" disabled={value.points.length <= 1 || locked.wording} onClick={() => onChange({ ...value, points: value.points.filter((_, j) => j !== i) })}>
            <Trash2 size={14} aria-hidden="true" />
          </IconButton>
        </div>
      ))}
      <div className="row-wrap">
        <Button size="sm" icon={<Plus size={14} aria-hidden="true" />} disabled={value.points.length >= 4 || locked.wording} onClick={() => onChange({ ...value, points: [...value.points, 'New point'] })}>
          Add point
        </Button>
        <Segmented
          label="Illustration"
          value={value.illustration}
          onChange={(v) => onChange({ ...value, illustration: v })}
          options={[
            { value: 'none', label: 'No illustration' },
            { value: 'grid', label: 'Grid' },
            { value: 'quadrants', label: 'Quadrants' },
          ]}
        />
      </div>
      <Field label="Continue button label" htmlFor="info-continue">
        <TextInput id="info-continue" value={value.continueLabel} maxLength={24} disabled={locked.wording} onChange={(e) => onChange({ ...value, continueLabel: e.target.value })} />
      </Field>
    </div>
  );
}

function CoordinateEditor({ value, onChange, locked }: Props<CoordinateInteraction>) {
  const a = locked.answer;
  const g = value.grid;
  const setRule = (rule: CoordinateRule) => onChange({ ...value, rule });
  return (
    <div className="stack">
      <fieldset className="fieldset">
        <legend>Grid</legend>
        <div className="num-row">
          <Num label="x from" value={g.xMin} max={0} min={-20} disabled={a} onChange={(v) => onChange({ ...value, grid: { ...g, xMin: v } })} />
          <Num label="x to" value={g.xMax} min={0} max={20} disabled={a} onChange={(v) => onChange({ ...value, grid: { ...g, xMax: v } })} />
          <Num label="y from" value={g.yMin} max={0} min={-20} disabled={a} onChange={(v) => onChange({ ...value, grid: { ...g, yMin: v } })} />
          <Num label="y to" value={g.yMax} min={0} max={20} disabled={a} onChange={(v) => onChange({ ...value, grid: { ...g, yMax: v } })} />
          <label className="num-field">
            <span className="field-label">Step</span>
            <Select value={g.step} disabled={a} onChange={(e) => onChange({ ...value, grid: { ...g, step: Number(e.target.value) as 1 | 2 | 5 } })}>
              <option value={1}>1</option>
              <option value={2}>2</option>
              <option value={5}>5</option>
            </Select>
          </label>
        </div>
      </fieldset>
      <fieldset className="fieldset">
        <legend>Start and goal</legend>
        <div className="num-row">
          <Num label="Start x" value={value.start.x} disabled={a} onChange={(v) => onChange({ ...value, start: { ...value.start, x: v } })} />
          <Num label="Start y" value={value.start.y} disabled={a} onChange={(v) => onChange({ ...value, start: { ...value.start, y: v } })} />
        </div>
        <label className="field">
          <span className="field-label">Correct when the mover…</span>
          <Select
            value={value.rule.kind}
            disabled={a}
            onChange={(e) => {
              const k = e.target.value as CoordinateRule['kind'];
              if (k === 'point-equals') setRule({ kind: k, target: { x: 1, y: 1 } });
              if (k === 'point-in-set') setRule({ kind: k, targets: [{ x: 1, y: 1 }] });
              if (k === 'in-quadrant') setRule({ kind: k, quadrant: 1 });
              if (k === 'on-axis') setRule({ kind: k, axis: 'x' });
            }}
          >
            <option value="point-equals">reaches one exact point</option>
            <option value="point-in-set">reaches any of several points</option>
            <option value="in-quadrant">ends anywhere in a quadrant</option>
            <option value="on-axis">ends on an axis</option>
          </Select>
        </label>
        {value.rule.kind === 'point-equals' && (
          <div className="num-row">
            <Num label="Target x" value={value.rule.target.x} disabled={a} onChange={(v) => setRule({ kind: 'point-equals', target: { x: v, y: (value.rule as Extract<CoordinateRule, { kind: 'point-equals' }>).target.y } })} />
            <Num label="Target y" value={value.rule.target.y} disabled={a} onChange={(v) => setRule({ kind: 'point-equals', target: { x: (value.rule as Extract<CoordinateRule, { kind: 'point-equals' }>).target.x, y: v } })} />
          </div>
        )}
        {value.rule.kind === 'point-in-set' && (
          <div className="stack">
            {value.rule.targets.map((t, i) => {
              const targets = (value.rule as Extract<CoordinateRule, { kind: 'point-in-set' }>).targets;
              return (
                <div key={i} className="num-row">
                  <Num label={`Point ${i + 1} x`} value={t.x} disabled={a} onChange={(v) => setRule({ kind: 'point-in-set', targets: targets.map((p, j) => (j === i ? { ...p, x: v } : p)) })} />
                  <Num label="y" value={t.y} disabled={a} onChange={(v) => setRule({ kind: 'point-in-set', targets: targets.map((p, j) => (j === i ? { ...p, y: v } : p)) })} />
                  <IconButton label={`Remove point ${i + 1}`} size="sm" disabled={a || targets.length <= 1} onClick={() => setRule({ kind: 'point-in-set', targets: targets.filter((_, j) => j !== i) })}>
                    <Trash2 size={14} aria-hidden="true" />
                  </IconButton>
                </div>
              );
            })}
            <Button size="sm" icon={<Plus size={14} aria-hidden="true" />} disabled={a || value.rule.targets.length >= 12} onClick={() => setRule({ kind: 'point-in-set', targets: [...(value.rule as Extract<CoordinateRule, { kind: 'point-in-set' }>).targets, { x: 0, y: 1 }] })}>
              Add accepted point
            </Button>
          </div>
        )}
        {value.rule.kind === 'in-quadrant' && (
          <Segmented
            label="Quadrant"
            value={String(value.rule.quadrant) as '1' | '2' | '3' | '4'}
            onChange={(v) => !a && setRule({ kind: 'in-quadrant', quadrant: Number(v) as 1 | 2 | 3 | 4 })}
            options={[
              { value: '1', label: 'I' },
              { value: '2', label: 'II' },
              { value: '3', label: 'III' },
              { value: '4', label: 'IV' },
            ]}
          />
        )}
        {value.rule.kind === 'on-axis' && (
          <Segmented
            label="Axis"
            value={value.rule.axis}
            onChange={(v) => !a && setRule({ kind: 'on-axis', axis: v })}
            options={[
              { value: 'x', label: 'x-axis' },
              { value: 'y', label: 'y-axis' },
            ]}
          />
        )}
      </fieldset>
      <fieldset className="fieldset">
        <legend>Support and display</legend>
        <Switch label="Show the target on the grid" hint="Scaffolding for early scenes." checked={value.showTargetMarker} disabled={a} onChange={(v) => onChange({ ...value, showTargetMarker: v })} />
        <Switch label="Show the live coordinate readout" checked={value.showCoordinateReadout} onChange={(v) => onChange({ ...value, showCoordinateReadout: v })} />
        <Field label="Mover label" htmlFor="mover-label" help="Short name shown under the mover, e.g. a flight number.">
          <TextInput id="mover-label" maxLength={24} value={value.moverLabel} disabled={locked.wording} onChange={(e) => onChange({ ...value, moverLabel: e.target.value })} />
        </Field>
        <div className="row-wrap">
          <Segmented label="Grid emphasis" value={value.display.gridEmphasis} onChange={(v) => onChange({ ...value, display: { ...value.display, gridEmphasis: v } })} options={[{ value: 'standard', label: 'Standard grid' }, { value: 'high', label: 'Bold grid' }]} />
          <Segmented label="Point size" value={value.display.pointSize} onChange={(v) => onChange({ ...value, display: { ...value.display, pointSize: v } })} options={[{ value: 'standard', label: 'Standard points' }, { value: 'large', label: 'Large points' }]} />
          <Segmented label="Label size" value={value.display.labelSize} onChange={(v) => onChange({ ...value, display: { ...value.display, labelSize: v } })} options={[{ value: 'standard', label: 'Standard labels' }, { value: 'large', label: 'Large labels' }]} />
        </div>
      </fieldset>
      <fieldset className="fieldset">
        <legend>Landmarks</legend>
        {value.landmarks.map((l, i) => (
          <div key={l.id} className="landmark-row">
            <TextInput compact aria-label={`Landmark ${i + 1} label`} value={l.label} maxLength={24} disabled={a} onChange={(e) => onChange({ ...value, landmarks: value.landmarks.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} />
            <Num label="x" value={l.point.x} disabled={a} onChange={(v) => onChange({ ...value, landmarks: value.landmarks.map((x, j) => (j === i ? { ...x, point: { ...x.point, x: v } } : x)) })} />
            <Num label="y" value={l.point.y} disabled={a} onChange={(v) => onChange({ ...value, landmarks: value.landmarks.map((x, j) => (j === i ? { ...x, point: { ...x.point, y: v } } : x)) })} />
            <Select aria-label={`Landmark ${i + 1} icon`} value={l.icon} disabled={a} onChange={(e) => onChange({ ...value, landmarks: value.landmarks.map((x, j) => (j === i ? { ...x, icon: e.target.value as typeof l.icon } : x)) })}>
              {['runway', 'tower', 'gate', 'beacon', 'star', 'flag', 'home', 'none'].map((ic) => (
                <option key={ic} value={ic}>
                  {ic}
                </option>
              ))}
            </Select>
            <IconButton label={`Remove landmark ${l.label}`} size="sm" disabled={a} onClick={() => onChange({ ...value, landmarks: value.landmarks.filter((_, j) => j !== i) })}>
              <Trash2 size={14} aria-hidden="true" />
            </IconButton>
          </div>
        ))}
        <Button
          size="sm"
          icon={<Plus size={14} aria-hidden="true" />}
          disabled={a || value.landmarks.length >= 8}
          onClick={() => onChange({ ...value, landmarks: [...value.landmarks, { id: newLocalId('lm', value.landmarks.map((l) => l.id)), label: 'Landmark', point: { x: 0, y: 0 }, icon: 'flag' }] })}
        >
          Add landmark
        </Button>
      </fieldset>
    </div>
  );
}

function MatchEditor({ value, onChange, locked, images }: Props<MatchInteraction>) {
  const a = locked.answer;
  const accepts = new Map(value.rule.accepts.map((x) => [x.itemId, new Set(x.targetIds)]));
  const setAccept = (itemId: string, targetId: string, on: boolean) => {
    const rule = value.items.map((it) => {
      const set = new Set(accepts.get(it.id) ?? []);
      if (it.id === itemId) {
        if (on) set.add(targetId);
        else set.delete(targetId);
      }
      return { itemId: it.id, targetIds: [...set] };
    });
    onChange({ ...value, rule: { kind: 'match-sets', accepts: rule } });
  };
  return (
    <div className="stack">
      <fieldset className="fieldset">
        <legend>Targets</legend>
        {value.targets.map((t, i) => (
          <div key={t.id} className="num-row">
            <TextInput compact aria-label={`Target ${i + 1} label`} value={t.label} maxLength={60} disabled={a} onChange={(e) => onChange({ ...value, targets: value.targets.map((x) => (x.id === t.id ? { ...x, label: e.target.value } : x)) })} />
            <Num label="Holds" value={t.capacity} min={1} max={12} disabled={a} onChange={(v) => onChange({ ...value, targets: value.targets.map((x) => (x.id === t.id ? { ...x, capacity: Math.max(1, Math.min(12, v)) } : x)) })} />
            <ImageSelect label={`Image for target ${t.label}`} value={t.imageAssetId} images={images} disabled={a} onChange={(v) => onChange({ ...value, targets: value.targets.map((x) => (x.id === t.id ? { ...x, imageAssetId: v } : x)) })} />
            <IconButton
              label={`Remove target ${t.label}`}
              size="sm"
              disabled={a || value.targets.length <= 1}
              onClick={() => onChange({ ...value, targets: value.targets.filter((x) => x.id !== t.id), rule: { kind: 'match-sets', accepts: value.rule.accepts.map((x) => ({ ...x, targetIds: x.targetIds.filter((id) => id !== t.id) })) } })}
            >
              <Trash2 size={14} aria-hidden="true" />
            </IconButton>
          </div>
        ))}
        <Button size="sm" icon={<Plus size={14} aria-hidden="true" />} disabled={a || value.targets.length >= 8} onClick={() => onChange({ ...value, targets: [...value.targets, { id: newLocalId('t', value.targets.map((t) => t.id)), label: 'New target', imageAssetId: null, capacity: 1 }] })}>
          Add target
        </Button>
      </fieldset>
      <fieldset className="fieldset">
        <legend>Items and correct targets</legend>
        <p className="subtle small">Tick every target that accepts an item. Several ticks allow several correct arrangements; no tick makes the item a distractor that must stay in the tray.</p>
        <div className="match-matrix" role="table" aria-label="Item to target answers">
          <div role="row" className="mm-row mm-head">
            <span role="columnheader">Item</span>
            {value.targets.map((t) => (
              <span key={t.id} role="columnheader" className="truncate">
                {t.label}
              </span>
            ))}
            <span role="columnheader" className="sr-only">
              Actions
            </span>
          </div>
          {value.items.map((it, i) => (
            <div key={it.id} role="row" className="mm-row">
              <span role="cell">
                <TextInput compact aria-label={`Item ${i + 1} label`} value={it.label} maxLength={60} disabled={a} onChange={(e) => onChange({ ...value, items: value.items.map((x) => (x.id === it.id ? { ...x, label: e.target.value } : x)) })} />
              </span>
              {value.targets.map((t) => (
                <span key={t.id} role="cell">
                  <Checkbox label={<span className="sr-only">{`${it.label} belongs in ${t.label}`}</span>} checked={accepts.get(it.id)?.has(t.id) ?? false} disabled={a} onChange={(v) => setAccept(it.id, t.id, v)} />
                </span>
              ))}
              <span role="cell">
                <IconButton
                  label={`Remove item ${it.label}`}
                  size="sm"
                  disabled={a || value.items.length <= 2}
                  onClick={() => onChange({ ...value, items: value.items.filter((x) => x.id !== it.id), rule: { kind: 'match-sets', accepts: value.rule.accepts.filter((x) => x.itemId !== it.id) } })}
                >
                  <Trash2 size={14} aria-hidden="true" />
                </IconButton>
              </span>
            </div>
          ))}
        </div>
        <Button
          size="sm"
          icon={<Plus size={14} aria-hidden="true" />}
          disabled={a || value.items.length >= 12}
          onClick={() => {
            const id = newLocalId('i', value.items.map((x) => x.id));
            onChange({ ...value, items: [...value.items, { id, label: 'New item', imageAssetId: null }], rule: { kind: 'match-sets', accepts: [...value.rule.accepts, { itemId: id, targetIds: value.targets[0] ? [value.targets[0].id] : [] }] } });
          }}
        >
          Add item
        </Button>
      </fieldset>
      <Segmented label="Item tray position" value={value.trayPosition} onChange={(v) => onChange({ ...value, trayPosition: v })} options={[{ value: 'bottom', label: 'Tray below' }, { value: 'left', label: 'Tray on the left' }]} />
    </div>
  );
}

function SortEditor({ value, onChange, locked, images }: Props<SortInteraction>) {
  const a = locked.answer;
  const byValue = value.rule.kind === 'order-by-value';
  const groupOf = (id: string) => (value.rule.kind === 'explicit-order' ? value.rule.interchangeable.findIndex((g) => g.includes(id)) : -1);
  const setOrderFromItems = (items: SortInteraction['items'], interchangeable = value.rule.kind === 'explicit-order' ? value.rule.interchangeable : []) =>
    onChange({ ...value, items, rule: byValue ? value.rule : { kind: 'explicit-order', order: items.map((x) => x.id), interchangeable: interchangeable.filter((g) => g.length >= 2) } });
  const move = (i: number, d: number) => {
    const items = value.items.slice();
    const j = i + d;
    if (j < 0 || j >= items.length) return;
    [items[i], items[j]] = [items[j]!, items[i]!];
    setOrderFromItems(items);
  };
  const setGroup = (id: string, group: number) => {
    if (value.rule.kind !== 'explicit-order') return;
    const groups = value.rule.interchangeable.map((g) => g.filter((x) => x !== id));
    if (group >= 0) {
      while (groups.length <= group) groups.push([]);
      groups[group]!.push(id);
    }
    setOrderFromItems(value.items, groups);
  };
  return (
    <div className="stack">
      <Segmented
        label="Sorting rule"
        value={byValue ? (value.rule as { direction: string }).direction : 'explicit'}
        onChange={(v) => {
          if (a) return;
          if (v === 'explicit') onChange({ ...value, rule: { kind: 'explicit-order', order: value.items.map((x) => x.id), interchangeable: [] } });
          else onChange({ ...value, rule: { kind: 'order-by-value', direction: v as 'ascending' | 'descending' }, items: value.items.map((x, k) => ({ ...x, value: x.value ?? k + 1 })) });
        }}
        options={[
          { value: 'ascending', label: 'Smallest value first' },
          { value: 'descending', label: 'Largest value first' },
          { value: 'explicit', label: 'Exact sequence' },
        ]}
      />
      <p className="subtle small">
        {byValue ? 'Every item needs a number. Equal values may appear in either order.' : 'The list order below is the correct sequence. Items in the same swap group may trade places.'}
      </p>
      <ol className="sort-edit">
        {value.items.map((it, i) => (
          <li key={it.id} className="num-row">
            <span className="tabular subtle">{i + 1}</span>
            <TextInput compact aria-label={`Item ${i + 1} label`} value={it.label} maxLength={60} disabled={a} onChange={(e) => onChange({ ...value, items: value.items.map((x) => (x.id === it.id ? { ...x, label: e.target.value } : x)) })} />
            {byValue ? (
              <label className="num-field">
                <span className="field-label">Value</span>
                <TextInput compact type="number" step="any" value={it.value ?? ''} disabled={a} onChange={(e) => onChange({ ...value, items: value.items.map((x) => (x.id === it.id ? { ...x, value: e.target.value === '' ? null : Number(e.target.value) } : x)) })} />
              </label>
            ) : (
              <label className="num-field">
                <span className="field-label">Swap group</span>
                <Select value={groupOf(it.id)} disabled={a} onChange={(e) => setGroup(it.id, Number(e.target.value))}>
                  <option value={-1}>None</option>
                  {[0, 1, 2, 3, 4].map((g) => (
                    <option key={g} value={g}>
                      {String.fromCharCode(65 + g)}
                    </option>
                  ))}
                </Select>
              </label>
            )}
            <ImageSelect label={`Image for ${it.label}`} value={it.imageAssetId} images={images} disabled={a} onChange={(v) => onChange({ ...value, items: value.items.map((x) => (x.id === it.id ? { ...x, imageAssetId: v } : x)) })} />
            {!byValue && (
              <>
                <IconButton label={`Move ${it.label} up`} size="sm" disabled={a || i === 0} onClick={() => move(i, -1)}>
                  <ArrowUp size={14} aria-hidden="true" />
                </IconButton>
                <IconButton label={`Move ${it.label} down`} size="sm" disabled={a || i === value.items.length - 1} onClick={() => move(i, 1)}>
                  <ArrowDown size={14} aria-hidden="true" />
                </IconButton>
              </>
            )}
            <IconButton label={`Remove ${it.label}`} size="sm" disabled={a || value.items.length <= 3} onClick={() => setOrderFromItems(value.items.filter((x) => x.id !== it.id))}>
              <Trash2 size={14} aria-hidden="true" />
            </IconButton>
          </li>
        ))}
      </ol>
      <Button
        size="sm"
        icon={<Plus size={14} aria-hidden="true" />}
        disabled={a || value.items.length >= 10}
        onClick={() => setOrderFromItems([...value.items, { id: newLocalId('s', value.items.map((x) => x.id)), label: 'New item', value: byValue ? value.items.length + 1 : null, imageAssetId: null }])}
      >
        Add item
      </Button>
      <div className="row-wrap">
        <Segmented label="Orientation" value={value.orientation} onChange={(v) => onChange({ ...value, orientation: v })} options={[{ value: 'horizontal', label: 'Row' }, { value: 'vertical', label: 'Column' }]} />
        <Switch label="Show values on cards" checked={value.showValues} onChange={(v) => onChange({ ...value, showValues: v })} />
      </div>
      <div className="form-grid">
        <Field label="Start label" htmlFor="sort-start">
          <TextInput id="sort-start" maxLength={24} value={value.startLabel} disabled={locked.wording} onChange={(e) => onChange({ ...value, startLabel: e.target.value })} />
        </Field>
        <Field label="End label" htmlFor="sort-end">
          <TextInput id="sort-end" maxLength={24} value={value.endLabel} disabled={locked.wording} onChange={(e) => onChange({ ...value, endLabel: e.target.value })} />
        </Field>
      </div>
    </div>
  );
}

export function InteractionEditor({ value, onChange, locked, images }: Props<SceneInteraction>) {
  switch (value.type) {
    case 'info':
      return <InfoEditor value={value} onChange={onChange} locked={locked} images={images} />;
    case 'coordinate-navigation':
      return <CoordinateEditor value={value} onChange={onChange} locked={locked} images={images} />;
    case 'drag-match':
      return <MatchEditor value={value} onChange={onChange} locked={locked} images={images} />;
    case 'sequence-sort':
      return <SortEditor value={value} onChange={onChange} locked={locked} images={images} />;
    case 'custom':
      return (
        <Field label="Describe the interaction" htmlFor="custom-desc" help="Blueprint only — this mechanic has no in-app builder. It is exported as a developer handoff.">
          <TextArea id="custom-desc" rows={5} maxLength={800} value={value.description} disabled={locked.wording} onChange={(e) => onChange({ ...value, description: e.target.value })} />
        </Field>
      );
  }
}

/** Starting values for a newly added scene. Clearly creator-authored placeholders to replace. */
export function templateInteraction(type: SceneInteraction['type']): SceneInteraction {
  switch (type) {
    case 'info':
      return { type: 'info', points: ['Replace with a key point from your slide.'], illustration: 'none', continueLabel: 'Continue' };
    case 'coordinate-navigation':
      return {
        type: 'coordinate-navigation',
        grid: { xMin: -5, xMax: 5, yMin: -4, yMax: 4, step: 1 },
        start: { x: 0, y: 0 },
        rule: { kind: 'point-equals', target: { x: 2, y: 1 } },
        showTargetMarker: true,
        showCoordinateReadout: true,
        moverLabel: '',
        landmarks: [],
        display: { gridEmphasis: 'standard', pointSize: 'standard', labelSize: 'standard' },
      };
    case 'drag-match':
      return {
        type: 'drag-match',
        items: [
          { id: 'i1', label: 'Item A', imageAssetId: null },
          { id: 'i2', label: 'Item B', imageAssetId: null },
        ],
        targets: [
          { id: 't1', label: 'Target 1', imageAssetId: null, capacity: 1 },
          { id: 't2', label: 'Target 2', imageAssetId: null, capacity: 1 },
        ],
        rule: { kind: 'match-sets', accepts: [{ itemId: 'i1', targetIds: ['t1'] }, { itemId: 'i2', targetIds: ['t2'] }] },
        trayPosition: 'bottom',
      };
    case 'sequence-sort':
      return {
        type: 'sequence-sort',
        items: [
          { id: 's1', label: 'First step', value: null, imageAssetId: null },
          { id: 's2', label: 'Second step', value: null, imageAssetId: null },
          { id: 's3', label: 'Third step', value: null, imageAssetId: null },
        ],
        rule: { kind: 'explicit-order', order: ['s1', 's2', 's3'], interchangeable: [] },
        orientation: 'horizontal',
        showValues: false,
        startLabel: 'First',
        endLabel: 'Last',
      };
    case 'custom':
      return { type: 'custom', description: 'Describe what learners do in this scene.' };
  }
}
