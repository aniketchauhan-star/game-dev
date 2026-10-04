import { useMemo } from 'react';
import type { Asset } from '@shared/schemas/assets.ts';
import type { GameConfig } from '@shared/schemas/game.ts';
import { MOTION_TRIGGERS, TRIGGER_LABELS, type AnimationBinding, type MotionControl, type MotionPresetId, type MotionTrigger } from '@shared/schemas/motion.ts';
import { describeBinding } from '@shared/motion/describe.ts';
import type { ScreenInfo } from '@shared/motion/entities.ts';
import { MOTION_PRESETS, PRESETS_BY_CATEGORY, CATEGORY_LABELS } from '@shared/motion/presets.ts';
import { validateBindings } from '@shared/motion/validate.ts';
import { Field, Select, TextInput } from '../../../components/ui/controls.tsx';
import { Banner, Pill } from '../../../components/ui/feedback.tsx';

const SCREEN_TRIGGERS: Record<string, MotionTrigger[]> = {
  title: ['scene-entered', 'control-activated'],
  completion: ['scene-entered', 'control-activated'],
  info: ['scene-entered', 'control-activated', 'scene-completed'],
  'coordinate-navigation': ['scene-entered', 'control-activated', 'instruction-advanced', 'correct-answer', 'retry-requested', 'scene-completed'],
  'drag-match': [...MOTION_TRIGGERS],
  'sequence-sort': [...MOTION_TRIGGERS],
};

/** Allowed triggers for a preset on a screen (empty = it cannot run there). */
export function triggersFor(screen: ScreenInfo, presetId: MotionPresetId): MotionTrigger[] {
  const base = SCREEN_TRIGGERS[screen.type] ?? ['scene-entered'];
  const preset = MOTION_PRESETS[presetId];
  return preset.triggers ? base.filter((t) => preset.triggers!.includes(t)) : base;
}

function NumberField({ label, value, min, max, step = 1, onChange, help }: { label: string; value: number; min: number; max: number; step?: number; onChange: (n: number) => void; help?: string }) {
  const id = `n-${label.replace(/\W+/g, '-').toLowerCase()}`;
  return (
    <Field label={label} htmlFor={id} help={help}>
      <TextInput
        id={id}
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onChange(Math.max(min, Math.min(max, n)));
        }}
      />
    </Field>
  );
}

export function BindingEditor({
  binding,
  config,
  screen,
  assets,
  onChange,
}: {
  binding: AnimationBinding;
  config: GameConfig;
  screen: ScreenInfo;
  assets: Asset[];
  onChange: (b: AnimationBinding) => void;
}) {
  const preset = MOTION_PRESETS[binding.presetId];
  const target = screen.entities.find((e) => e.id === binding.target) ?? null;
  const set = (patch: Partial<AnimationBinding>) => onChange({ ...binding, ...patch });
  const setParams = (patch: Record<string, string | number | boolean | undefined>) => {
    const params = { ...binding.params };
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || v === '') delete params[k];
      else params[k] = v;
    }
    onChange({ ...binding, params });
  };
  const setParam = (k: string, v: string | number | boolean | undefined) => setParams({ [k]: v });
  const triggers = triggersFor(screen, binding.presetId);
  const sameTrigger = config.motion.bindings.filter((b) => b.screenId === screen.id && b.id !== binding.id && b.trigger.event === binding.trigger.event);
  const issues = useMemo(() => {
    const others = config.motion.bindings.filter((b) => b.id !== binding.id);
    return validateBindings({ ...config, motion: { ...config.motion, bindings: [...others, binding] } }, [...others, binding]).filter((i) => i.bindingId === binding.id);
  }, [config, binding]);
  const clipSource = binding.assetId ? assets.find((a) => a.id === binding.assetId) : target?.assetId ? assets.find((a) => a.id === target.assetId) : null;
  const clips = clipSource?.metadata.sprite?.clips.map((c) => c.name) ?? target?.clips ?? [];
  const sprites = assets.filter((a) => a.kind === 'image' && a.metadata.sprite && a.metadata.sprite.clips.length > 0);
  const audio = assets.filter((a) => a.kind === 'audio');
  const rule = describeBinding({ ...config, motion: { ...config.motion, bindings: [...config.motion.bindings.filter((b) => b.id !== binding.id), binding] } }, binding);

  return (
    <div className="binding-editor stack">
      <p className="rule-line" aria-live="polite">
        {rule}
      </p>
      <div className="form-grid">
        <Field label="Object" htmlFor="be-target">
          <Select id="be-target" value={binding.target} onChange={(e) => set({ target: e.target.value })}>
            {screen.entities.map((e) => (
              <option key={e.id} value={e.id} disabled={!preset.targets.includes(e.kind)}>
                {e.label} ({e.kind}){!preset.targets.includes(e.kind) ? ' — not for this effect' : ''}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Effect" htmlFor="be-preset">
          <Select
            id="be-preset"
            value={binding.presetId}
            onChange={(e) => {
              const next = MOTION_PRESETS[e.target.value as MotionPresetId];
              const allowed = triggersFor(screen, next.id);
              onChange({
                ...binding,
                presetId: next.id,
                params: { ...next.defaults },
                purpose: next.purpose,
                reducedMotion: next.defaultReduced,
                timing: { ...binding.timing, durationMs: next.duration.default, repeat: 1 },
                trigger: allowed.includes(binding.trigger.event) ? binding.trigger : { event: allowed[0] ?? 'scene-entered', control: allowed[0] === 'control-activated' ? ((screen.controls[0] as MotionControl) ?? null) : null, entity: null },
              });
            }}
          >
            {PRESETS_BY_CATEGORY.map((g) => (
              <optgroup key={g.category} label={CATEGORY_LABELS[g.category]}>
                {g.presets.map((p) => (
                  <option key={p.id} value={p.id} disabled={target ? !p.targets.includes(target.kind) : false}>
                    {p.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </Select>
        </Field>
        <Field label="When" htmlFor="be-trigger">
          <Select
            id="be-trigger"
            value={binding.trigger.event}
            onChange={(e) => {
              const ev = e.target.value as MotionTrigger;
              set({ trigger: { event: ev, control: ev === 'control-activated' ? ((screen.controls[0] as MotionControl) ?? null) : null, entity: null } });
            }}
          >
            {triggers.map((t) => (
              <option key={t} value={t}>
                {TRIGGER_LABELS[t]}
              </option>
            ))}
          </Select>
        </Field>
        {binding.trigger.event === 'control-activated' && (
          <Field label="Button" htmlFor="be-control">
            <Select id="be-control" value={binding.trigger.control ?? ''} onChange={(e) => set({ trigger: { ...binding.trigger, control: e.target.value as MotionControl } })}>
              {screen.controls.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {(binding.trigger.event === 'valid-drop' || binding.trigger.event === 'object-selected') && (
          <Field label="Only for" htmlFor="be-filter">
            <Select id="be-filter" value={binding.trigger.entity ?? ''} onChange={(e) => set({ trigger: { ...binding.trigger, entity: e.target.value || null } })}>
              <option value="">Any object</option>
              {screen.entities
                .filter((e) => e.kind === 'card' || e.kind === 'target' || e.kind === 'mover')
                .map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.label}
                  </option>
                ))}
            </Select>
          </Field>
        )}
        <NumberField label="Delay (ms)" value={binding.timing.delayMs} min={0} max={10000} step={50} onChange={(n) => set({ timing: { ...binding.timing, delayMs: Math.round(n) } })} />
        <NumberField label="Duration (ms)" value={binding.timing.durationMs} min={preset.duration.min} max={preset.duration.max} step={20} onChange={(n) => set({ timing: { ...binding.timing, durationMs: Math.round(n) } })} help={`${preset.duration.min}–${preset.duration.max} ms`} />
      </div>

      <ParamFields binding={binding} screen={screen} clips={clips} sprites={sprites} setParam={setParam} setParams={setParams} setAsset={(id) => set({ assetId: id })} />

      <details>
        <summary className="h-sub-sm">Advanced</summary>
        <div className="form-grid">
          <Field label="Easing" htmlFor="be-ease">
            <Select id="be-ease" value={binding.timing.easing} onChange={(e) => set({ timing: { ...binding.timing, easing: e.target.value as AnimationBinding['timing']['easing'] } })}>
              <option value="ease-out">Ease out</option>
              <option value="ease-in-out">Ease in and out</option>
              <option value="ease-in">Ease in</option>
              <option value="linear">Linear</option>
            </Select>
          </Field>
          <Field label="Repeat" htmlFor="be-repeat" help={`At most ${preset.maxRepeat}`}>
            <Select id="be-repeat" value={String(binding.timing.repeat)} onChange={(e) => set({ timing: { ...binding.timing, repeat: Number(e.target.value) } })}>
              {Array.from({ length: preset.maxRepeat }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>
                  {n === 1 ? 'Once' : `${n} times`}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Start" htmlFor="be-after" help="Sequential: wait for another animation of the same trigger. Parallel: start with the trigger.">
            <Select id="be-after" value={binding.after ?? ''} onChange={(e) => set({ after: e.target.value || null })}>
              <option value="">With the trigger (parallel)</option>
              {sameTrigger.map((b) => (
                <option key={b.id} value={b.id}>
                  After: {MOTION_PRESETS[b.presetId].label} on {screen.entities.find((x) => x.id === b.target)?.label ?? b.target}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="With reduced motion" htmlFor="be-reduced" help={preset.staticAlternative}>
            <Select id="be-reduced" value={binding.reducedMotion} onChange={(e) => set({ reducedMotion: e.target.value as AnimationBinding['reducedMotion'] })}>
              <option value="static">Show the end state (static)</option>
              <option value="stepwise">Show steps, no movement</option>
              <option value="skip">Skip it</option>
              <option value="unchanged">Keep (no movement involved)</option>
            </Select>
          </Field>
          <Field label="Purpose" htmlFor="be-purpose">
            <Select id="be-purpose" value={binding.purpose} onChange={(e) => set({ purpose: e.target.value as AnimationBinding['purpose'] })}>
              <option value="instructional">Instructional</option>
              <option value="feedback">Feedback</option>
              <option value="decorative">Decorative</option>
            </Select>
          </Field>
          <Field label="Sound" htmlFor="be-sound" help="Uploaded or bundled audio only. Captions stay in the panel; missing audio never blocks learning.">
            <Select id="be-sound" value={binding.sound?.assetId ?? ''} onChange={(e) => set({ sound: e.target.value ? { assetId: e.target.value, volume: binding.sound?.volume ?? 0.8 } : null })}>
              <option value="">No sound</option>
              {audio.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          </Field>
          {binding.sound && <NumberField label="Volume (0–1)" value={binding.sound.volume} min={0} max={1} step={0.05} onChange={(n) => set({ sound: { ...binding.sound!, volume: n } })} />}
        </div>
      </details>

      <p className="subtle small">
        <Pill tone="neutral" dot={false}>
          {preset.category}
        </Pill>{' '}
        {preset.summary} Reduced motion: {preset.staticAlternative}
      </p>
      {issues.length > 0 && (
        <Banner tone={issues.some((i) => i.severity === 'error') ? 'warning' : 'info'} title={issues.some((i) => i.severity === 'error') ? 'This animation cannot be applied yet' : 'Worth checking'}>
          <ul className="plain-list">
            {issues.map((i, k) => (
              <li key={k}>{i.message}</li>
            ))}
          </ul>
        </Banner>
      )}
    </div>
  );
}

function ParamFields({
  binding,
  screen,
  clips,
  sprites,
  setParam,
  setParams,
  setAsset,
}: {
  binding: AnimationBinding;
  screen: ScreenInfo;
  clips: string[];
  sprites: Asset[];
  setParam: (k: string, v: string | number | boolean | undefined) => void;
  setParams: (patch: Record<string, string | number | boolean | undefined>) => void;
  setAsset: (id: string | null) => void;
}) {
  const p = binding.params;
  const entityOptions = screen.entities.filter((e) => e.id !== binding.target);
  switch (binding.presetId) {
    case 'slide-in':
    case 'scene-slide':
      return (
        <div className="form-grid">
          <Field label="From" htmlFor="pf-from">
            <Select id="pf-from" value={String(p.from ?? 'left')} onChange={(e) => setParam('from', e.target.value)}>
              {['left', 'right', 'top', 'bottom'].map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </Select>
          </Field>
          {binding.presetId === 'slide-in' && <NumberField label="Distance (px)" value={Number(p.distance ?? 160)} min={20} max={600} onChange={(n) => setParam('distance', Math.round(n))} />}
        </div>
      );
    case 'pop-in':
      return <NumberField label="Start size (0.6–0.95)" value={Number(p.from ?? 0.85)} min={0.6} max={0.95} step={0.05} onChange={(n) => setParam('from', Number(n.toFixed(2)))} />;
    case 'outline-highlight':
      return (
        <div className="form-grid">
          <ColorField value={String(p.color ?? 'accent')} onChange={(v) => setParam('color', v)} />
          <NumberField label="Width (px)" value={Number(p.width ?? 6)} min={3} max={12} onChange={(n) => setParam('width', Math.round(n))} />
          <NumberField label="Pulses" value={Number(p.pulses ?? 2)} min={1} max={3} onChange={(n) => setParam('pulses', Math.round(n))} />
        </div>
      );
    case 'selected-outline':
    case 'retry-cue':
      return <ColorField value={String(p.color ?? 'focus')} onChange={(v) => setParam('color', v)} options={binding.presetId === 'retry-cue' ? ['focus', 'accent', 'primary'] : undefined} />;
    case 'path-reveal':
      return (
        <div className="form-grid">
          <Field label="Arrow to" htmlFor="pf-to">
            <Select id="pf-to" value={String(p.to ?? '')} onChange={(e) => setParam('to', e.target.value)}>
              {entityOptions.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Style" htmlFor="pf-style">
            <Select id="pf-style" value={String(p.style ?? 'arrow')} onChange={(e) => setParam('style', e.target.value)}>
              <option value="arrow">Arrow (drawn)</option>
              <option value="dotted">Dotted</option>
            </Select>
          </Field>
          <NumberField label="Hold (ms)" value={Number(p.hold ?? 1500)} min={0} max={8000} step={100} onChange={(n) => setParam('hold', Math.round(n))} />
        </div>
      );
    case 'move-to':
      return (
        <div className="form-grid">
          <Field label="Move to" htmlFor="pf-moveto">
            <Select
              id="pf-moveto"
              value={typeof p.to === 'string' ? p.to : '@point'}
              onChange={(e) => (e.target.value === '@point' ? setParams({ to: undefined, x: 960, y: 540 }) : setParams({ x: undefined, y: undefined, to: e.target.value }))}
            >
              <option value="@point">A point on the stage</option>
              {entityOptions.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.label}
                </option>
              ))}
            </Select>
          </Field>
          {typeof p.to !== 'string' && (
            <>
              <NumberField label="x (0–1920)" value={Number(p.x ?? 960)} min={-200} max={2120} onChange={(n) => setParam('x', Math.round(n))} />
              <NumberField label="y (0–1080)" value={Number(p.y ?? 540)} min={-200} max={1280} onChange={(n) => setParam('y', Math.round(n))} />
            </>
          )}
        </div>
      );
    case 'move-by':
      return (
        <div className="form-grid">
          <Field label="Units" htmlFor="pf-units">
            <Select id="pf-units" value={String(p.units ?? 'stage')} onChange={(e) => setParam('units', e.target.value)}>
              <option value="stage">Stage pixels</option>
              <option value="grid" disabled={screen.type !== 'coordinate-navigation'}>
                Grid units (coordinate screens)
              </option>
            </Select>
          </Field>
          <NumberField label={p.units === 'grid' ? 'Right (+) / left (−)' : 'dx (px)'} value={Number(p.dx ?? 0)} min={-1920} max={1920} onChange={(n) => setParam('dx', n)} />
          <NumberField label={p.units === 'grid' ? 'Up (+) / down (−)' : 'dy (px, down +)'} value={Number(p.dy ?? 0)} min={-1080} max={1080} onChange={(n) => setParam('dy', n)} />
        </div>
      );
    case 'follow-path':
      return (
        <Field label="Path (relative waypoints “dx,dy dx,dy”)" htmlFor="pf-path" help="Up to 8 points, in stage pixels from where the object starts. The game's positions and answers do not change.">
          <TextInput id="pf-path" value={String(p.path ?? '')} onChange={(e) => setParam('path', e.target.value)} />
        </Field>
      );
    case 'celebration-clip':
    case 'character-clip':
      return (
        <div className="form-grid">
          {binding.presetId === 'celebration-clip' && (
            <Field label="Play from" htmlFor="pf-asset" help="The object's own clips, or an uploaded sprite shown on top.">
              <Select id="pf-asset" value={binding.assetId ?? ''} onChange={(e) => setAsset(e.target.value || null)}>
                <option value="">This object's clips</option>
                {sprites.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field label="Clip" htmlFor="pf-clip">
            <Select id="pf-clip" value={String(p.clip ?? '')} onChange={(e) => setParam('clip', e.target.value)}>
              {clips.length === 0 && <option value={String(p.clip ?? '')}>No clips available</option>}
              {clips.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      );
    case 'particle-burst':
      return (
        <div className="form-grid">
          <NumberField label="Particles (6–40)" value={Number(p.count ?? 16)} min={6} max={40} onChange={(n) => setParam('count', Math.round(n))} />
          <NumberField label="Spread (px)" value={Number(p.spread ?? 160)} min={40} max={360} onChange={(n) => setParam('spread', Math.round(n))} />
          <Field label="Colours" htmlFor="pf-colors">
            <Select id="pf-colors" value={String(p.colors ?? 'palette')} onChange={(e) => setParam('colors', e.target.value)}>
              <option value="palette">Theme colours</option>
              <option value="success">Success colour</option>
              <option value="accent">Accent colour</option>
            </Select>
          </Field>
        </div>
      );
    default:
      return null;
  }
}

function ColorField({ value, onChange, options = ['accent', 'primary', 'success', 'focus'] }: { value: string; onChange: (v: string) => void; options?: string[] }) {
  return (
    <Field label="Colour" htmlFor="pf-color">
      <Select id="pf-color" value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((c) => (
          <option key={c} value={c}>
            Theme {c}
          </option>
        ))}
      </Select>
    </Field>
  );
}
