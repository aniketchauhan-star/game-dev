import { useMemo } from 'react';
import { ArrowLeft, Lock, Sparkles, TriangleAlert } from 'lucide-react';
import { checkInteraction } from '@shared/attainability.ts';
import type { Blueprint, BlueprintScene } from '@shared/schemas/blueprint.ts';
import type { SceneInteraction } from '@shared/schemas/interaction.ts';
import type { SourceSlide } from '@shared/schemas/source.ts';
import type { Asset } from '@shared/schemas/assets.ts';
import { MECHANICS, SCENE_TYPES } from '@shared/registry.ts';
import { describeCoordinateRule, describeMatchRule, describeSequenceRule } from '@shared/rules.ts';
import { Button, Checkbox, Field, Segmented, Select, TextArea, TextInput } from '../../../components/ui/controls.tsx';
import { Banner, OriginBadge, Pill } from '../../../components/ui/feedback.tsx';
import { SceneThumb } from '../../../components/scenes/SceneThumb.tsx';
import { InteractionEditor, templateInteraction } from '../../../components/scenes/InteractionEditor.tsx';
import { SourceChips } from '../../../components/SourceChips.tsx';

export function ruleText(i: SceneInteraction): string {
  if (i.type === 'coordinate-navigation') return describeCoordinateRule(i.rule);
  if (i.type === 'drag-match') return describeMatchRule(i);
  if (i.type === 'sequence-sort') return describeSequenceRule(i.rule);
  if (i.type === 'info') return 'Continue after reading';
  return 'Custom mechanic — not playable in the studio';
}

export function SceneEditor({
  blueprint,
  scene,
  index,
  readOnly,
  slides,
  images,
  projectId,
  onChange,
  onBack,
  onRegenerate,
  canRegenerate,
}: {
  blueprint: Blueprint;
  scene: BlueprintScene;
  index: number;
  readOnly: boolean;
  slides: SourceSlide[];
  images: Asset[];
  projectId: string;
  onChange: (s: BlueprintScene) => void;
  onBack: () => void;
  onRegenerate: () => void;
  canRegenerate: boolean;
}) {
  const issues = useMemo(() => checkInteraction(scene.interaction, { seed: 1, sceneId: scene.id }), [scene.interaction, scene.id]);
  const set = <K extends keyof BlueprintScene>(k: K, v: BlueprintScene[K]) => onChange({ ...scene, [k]: v, origin: 'creator' });
  const allowed = MECHANICS[blueprint.coreMechanic].sceneTypes;
  const included = slides.filter((s) => s.included);
  const wordingLocked = readOnly || scene.locks.wording;
  return (
    <div className="scene-editor stack">
      <div className="row">
        <Button size="sm" variant="ghost" icon={<ArrowLeft size={14} aria-hidden="true" />} onClick={onBack}>
          All scenes
        </Button>
        <span className="spacer" />
        {canRegenerate && !readOnly && (
          <Button size="sm" variant="ai" icon={<Sparkles size={14} aria-hidden="true" />} onClick={onRegenerate}>
            Regenerate this scene
          </Button>
        )}
      </div>
      <header className="scene-editor-head">
        <SceneThumb interaction={scene.interaction} title={scene.title} />
        <div className="stack">
          <p className="eyebrow">
            Scene {index + 1} · {SCENE_TYPES[scene.interaction.type].label} · {scene.pattern}
          </p>
          <TextInput aria-label="Scene title" className="scene-title-input" value={scene.title} maxLength={60} disabled={wordingLocked} onChange={(e) => set('title', e.target.value)} />
          <div className="row-wrap">
            <OriginBadge origin={scene.origin} />
            {!SCENE_TYPES[scene.interaction.type].buildable && <Pill tone="warning">Blueprint only</Pill>}
            <SourceChips projectId={projectId} slideIds={scene.sourceSlideIds} slides={slides} addedPractice={scene.addedPractice} />
          </div>
        </div>
      </header>

      {readOnly && <Banner tone="info" title="This revision is approved and read-only.">Create a new draft to change it — the approved revision stays exactly as it was built.</Banner>}
      {issues.filter((i) => i.severity === 'error').map((i) => (
        <Banner key={i.message} tone="danger" title="This scene cannot be completed yet">
          {i.message}
        </Banner>
      ))}
      {issues.filter((i) => i.severity === 'warning').map((i) => (
        <Banner key={i.message} tone="warning">
          {i.message}
        </Banner>
      ))}

      <section className="panel panel-pad stack" aria-labelledby="se-learning">
        <h2 id="se-learning" className="h-sub">
          Learning design
        </h2>
        <div className="form-grid">
          <Field label="Learning pattern" htmlFor="se-pattern">
            <Select id="se-pattern" value={scene.pattern} disabled={readOnly} onChange={(e) => set('pattern', e.target.value as BlueprintScene['pattern'])}>
              {['discover', 'manipulate', 'predict', 'test', 'apply'].map((p) => (
                <option key={p} value={p}>
                  {p[0]!.toUpperCase() + p.slice(1)}
                </option>
              ))}
            </Select>
          </Field>
          <div className="field">
            <span className="field-label">Difficulty</span>
            <Segmented label="Difficulty" value={scene.difficulty} onChange={(v) => !readOnly && set('difficulty', v)} options={[{ value: 'gentle', label: 'Gentle' }, { value: 'standard', label: 'Standard' }, { value: 'challenging', label: 'Challenging' }]} />
          </div>
          <Field label="Learning objective" htmlFor="se-objective" className="span-2">
            <TextArea id="se-objective" rows={2} maxLength={240} value={scene.objective} disabled={readOnly} onChange={(e) => set('objective', e.target.value)} />
          </Field>
          <fieldset className="fieldset span-2">
            <legend>Source slides</legend>
            <div className="source-picker">
              {included.map((s) => (
                <Checkbox
                  key={s.id}
                  label={`${s.slideNumber}. ${s.extract.title || 'Untitled'}`}
                  checked={scene.sourceSlideIds.includes(s.id)}
                  disabled={readOnly || scene.addedPractice}
                  onChange={(v) => set('sourceSlideIds', v ? [...scene.sourceSlideIds, s.id] : scene.sourceSlideIds.filter((x) => x !== s.id))}
                />
              ))}
            </div>
            <Checkbox label="Added practice (goes beyond the slides)" checked={scene.addedPractice} disabled={readOnly} onChange={(v) => onChange({ ...scene, addedPractice: v, sourceSlideIds: v ? [] : scene.sourceSlideIds, origin: 'creator' })} />
          </fieldset>
          <Field label="What learners see" htmlFor="se-visible" className="span-2">
            <TextArea id="se-visible" rows={2} maxLength={400} value={scene.visibleContent} disabled={readOnly} onChange={(e) => set('visibleContent', e.target.value)} />
          </Field>
          <Field label="What learners do" htmlFor="se-action">
            <TextArea id="se-action" rows={2} maxLength={240} value={scene.learnerAction} disabled={readOnly} onChange={(e) => set('learnerAction', e.target.value)} />
          </Field>
          <Field label="Expected result" htmlFor="se-expected">
            <TextArea id="se-expected" rows={2} maxLength={240} value={scene.expectedResult} disabled={readOnly} onChange={(e) => set('expectedResult', e.target.value)} />
          </Field>
        </div>
      </section>

      <section className="panel panel-pad stack" aria-labelledby="se-interaction">
        <div className="section-head">
          <h2 id="se-interaction" className="h-sub">
            Interaction & success rule
          </h2>
          <Select
            aria-label="Scene type"
            value={scene.interaction.type}
            disabled={readOnly || scene.locks.answer}
            onChange={(e) => {
              const t = e.target.value as SceneInteraction['type'];
              if (t !== scene.interaction.type && window.confirm('Switching the scene type replaces its interaction with a template you then fill in. Continue?')) set('interaction', templateInteraction(t));
            }}
          >
            {allowed.map((t) => (
              <option key={t} value={t}>
                {SCENE_TYPES[t].label}
              </option>
            ))}
          </Select>
        </div>
        <p className="rule-summary">
          <strong>Success rule:</strong> {ruleText(scene.interaction)}
        </p>
        {scene.locks.answer && (
          <p className="subtle small">
            <Lock size={13} aria-hidden="true" /> Answers are locked for this scene.
          </p>
        )}
        <InteractionEditor value={scene.interaction} onChange={(v) => set('interaction', v)} locked={{ answer: readOnly || scene.locks.answer, wording: wordingLocked }} images={images} />
      </section>

      <section className="panel panel-pad stack" aria-labelledby="se-words">
        <h2 id="se-words" className="h-sub">
          Learner-facing text {scene.locks.wording && <Pill tone="info">Wording locked</Pill>}
        </h2>
        <Field label="Instruction" htmlFor="se-instruction" help={`${scene.instruction.length}/220`}>
          <TextArea id="se-instruction" rows={2} maxLength={220} value={scene.instruction} disabled={wordingLocked} onChange={(e) => set('instruction', e.target.value)} />
        </Field>
        <div className="form-grid">
          <Field label="Success feedback" htmlFor="se-success">
            <TextArea id="se-success" rows={2} maxLength={160} value={scene.successFeedback} disabled={wordingLocked} onChange={(e) => set('successFeedback', e.target.value)} />
          </Field>
          <Field label="Helpful error feedback" htmlFor="se-error">
            <TextArea id="se-error" rows={2} maxLength={200} value={scene.errorFeedback} disabled={wordingLocked} onChange={(e) => set('errorFeedback', e.target.value)} />
          </Field>
        </div>
        <fieldset className="fieldset">
          <legend>Progressive hints (gentle → explicit)</legend>
          {[0, 1, 2].map((i) => (
            <TextInput
              key={i}
              aria-label={`Hint ${i + 1}`}
              placeholder={i === 0 ? 'Required' : 'Optional'}
              maxLength={160}
              value={scene.hints[i] ?? ''}
              disabled={wordingLocked}
              onChange={(e) => {
                const hints = [...scene.hints];
                hints[i] = e.target.value;
                set('hints', hints.filter((h, k) => h.trim() || k === 0).slice(0, 3));
              }}
            />
          ))}
        </fieldset>
        <Field label="Completion criteria" htmlFor="se-completion">
          <TextInput id="se-completion" maxLength={240} value={scene.completion} disabled={readOnly} onChange={(e) => set('completion', e.target.value)} />
        </Field>
      </section>

      <section className="panel panel-pad stack" aria-labelledby="se-locks">
        <h2 id="se-locks" className="h-sub">
          Locks & assets
        </h2>
        <div className="lock-grid">
          {(
            [
              ['sequence', 'Keep position in the sequence'],
              ['wording', 'Keep wording'],
              ['answer', 'Keep correct answers'],
              ['layout', 'Keep layout regions'],
              ['assets', 'Keep assigned artwork'],
            ] as const
          ).map(([k, label]) => (
            <Checkbox key={k} label={label} checked={scene.locks[k]} disabled={readOnly} onChange={(v) => set('locks', { ...scene.locks, [k]: v })} />
          ))}
        </div>
        <div className="form-grid">
          {(['background', 'character'] as const).map((role) => (
            <Field key={role} label={role === 'background' ? 'Background need' : 'Character need'} htmlFor={`se-need-${role}`}>
              <Select id={`se-need-${role}`} value={scene.assetNeedIds[role] ?? ''} disabled={readOnly || scene.locks.assets} onChange={(e) => set('assetNeedIds', { ...scene.assetNeedIds, [role]: e.target.value || null })}>
                <option value="">None (built-in artwork)</option>
                {blueprint.assetNeeds
                  .filter((n) => n.role === role)
                  .map((n) => (
                    <option key={n.id} value={n.id}>
                      {n.description}
                    </option>
                  ))}
              </Select>
            </Field>
          ))}
        </div>
        {issues.length === 0 && (
          <p className="subtle small">
            <TriangleAlert size={13} aria-hidden="true" style={{ display: 'none' }} />
            Deterministic checks pass: this scene can be completed.
          </p>
        )}
      </section>
    </div>
  );
}
