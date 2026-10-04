import type { ComponentType } from 'react';
import { Compass, Lightbulb, Sparkles } from 'lucide-react';
import type { GameBrief } from '@shared/schemas/brief.ts';
import type { MechanicId } from '@shared/schemas/common.ts';
import { MECHANICS } from '@shared/registry.ts';
import { Button, Field, Segmented, TextArea, TextInput } from '../../components/ui/controls.tsx';
import { Banner } from '../../components/ui/feedback.tsx';
import { MiniCoordinate, MiniMatch, MiniSort } from '../../components/mechanics/MiniPreviews.tsx';

const EXAMPLE =
  'Create a Grade 9 coordinate game where learners guide an aircraft to the correct location. Keep the original lesson order, use minimal text, and make movement the main interaction.';

const PREVIEWS: Record<Exclude<MechanicId, 'custom'>, ComponentType> = {
  'coordinate-navigation': MiniCoordinate,
  'drag-match': MiniMatch,
  'sequence-sort': MiniSort,
};

export function BriefStep({ brief, update, gaps }: { brief: GameBrief; update: (fn: (b: GameBrief) => GameBrief) => void; gaps: string[] }) {
  const set = <K extends keyof GameBrief>(key: K, value: GameBrief[K]) => update((b) => ({ ...b, [key]: value }));
  const setOpt = <K extends keyof GameBrief['optional']>(key: K, value: GameBrief['optional'][K]) => update((b) => ({ ...b, optional: { ...b.optional, [key]: value } }));
  return (
    <div className="create-step">
      <header className="create-step-head">
        <h1>Describe the game</h1>
        <p className="muted">Only the essentials. Claude uses this brief together with your slides; you approve its interpretation before anything is built.</p>
      </header>

      <section className="prompt-panel panel">
        <label htmlFor="brief-prompt" className="prompt-label">
          What should learners do in your game?
        </label>
        <TextArea id="brief-prompt" rows={4} maxLength={2000} placeholder={EXAMPLE} value={brief.prompt} onChange={(e) => set('prompt', e.target.value)} />
        <div className="row-wrap">
          <span className="subtle small">
            {brief.prompt.length}/2000 · Name the action learners take, the order, and any constraints.
          </span>
          <span className="spacer" />
          {!brief.prompt && (
            <Button size="sm" variant="ghost" icon={<Lightbulb size={14} aria-hidden="true" />} onClick={() => set('prompt', EXAMPLE)}>
              Use the example
            </Button>
          )}
        </div>
      </section>

      <div className="form-grid">
        <Field label="Working title" required htmlFor="brief-title">
          <TextInput id="brief-title" maxLength={80} value={brief.title} placeholder="Air Traffic Control — Coordinate Mission" onChange={(e) => set('title', e.target.value)} />
        </Field>
        <Field label="Target grade or age" required htmlFor="brief-grade">
          <TextInput id="brief-grade" maxLength={40} value={brief.gradeOrAge} placeholder="Grade 9 · ages 14–15" onChange={(e) => set('gradeOrAge', e.target.value)} />
        </Field>
        <Field label="Subject" required htmlFor="brief-subject">
          <TextInput id="brief-subject" maxLength={60} value={brief.subject} placeholder="Mathematics" onChange={(e) => set('subject', e.target.value)} />
        </Field>
        <Field label="Approximate learning time" htmlFor="brief-duration" help="Minutes of play for one learner.">
          <TextInput
            id="brief-duration"
            type="number"
            min={1}
            max={120}
            inputMode="numeric"
            value={brief.durationMinutes ?? ''}
            placeholder="15"
            onChange={(e) => set('durationMinutes', e.target.value === '' ? null : Math.max(1, Math.min(120, Math.round(Number(e.target.value)))))}
          />
        </Field>
        <Field label="Main learning objective" required htmlFor="brief-objective" className="span-2">
          <TextInput id="brief-objective" maxLength={300} value={brief.learningObjective} placeholder="Locate and plot points in all four quadrants using ordered pairs." onChange={(e) => set('learningObjective', e.target.value)} />
        </Field>
      </div>

      <section aria-labelledby="mechanic-title" className="stack">
        <div className="section-head">
          <h2 id="mechanic-title" className="h-sub">
            Game interaction
          </h2>
        </div>
        <div className="theme-vs-mechanic">
          <Compass size={18} aria-hidden="true" />
          <p>
            <strong>Theme</strong> is how the game looks (an airport, a space station). <strong>Mechanic</strong> is what learners do (move to coordinates, match, sort). “Airport” is a theme; “move to coordinates” is a mechanic — you choose them separately.
          </p>
        </div>
        <div className="mechanic-grid" role="radiogroup" aria-label="Game interaction">
          {(['coordinate-navigation', 'drag-match', 'sequence-sort'] as const).map((id) => {
            const m = MECHANICS[id];
            const Preview = PREVIEWS[id];
            const selected = brief.mechanic === id;
            return (
              <div key={id} className={`mechanic-card${selected ? ' is-selected' : ''}`}>
                <label className="mechanic-choose">
                  <input type="radio" name="mechanic" checked={selected} onChange={() => set('mechanic', id)} />
                  <span className="mechanic-name">{m.label}</span>
                  <span className="pill pill-success pill-nodot">Playable</span>
                </label>
                <p className="muted small">{m.summary}</p>
                <Preview />
                <p className="subtle small">e.g. {m.example}</p>
              </div>
            );
          })}
          <div className={`mechanic-card is-custom${brief.mechanic === 'custom' ? ' is-selected' : ''}`}>
            <label className="mechanic-choose">
              <input type="radio" name="mechanic" checked={brief.mechanic === 'custom'} onChange={() => set('mechanic', 'custom')} />
              <span className="mechanic-name">Describe another idea</span>
              <span className="pill pill-warning pill-nodot">Blueprint only</span>
            </label>
            <p className="muted small">Any other interaction. You get an editable blueprint and a developer handoff — not a playable game, because no in-app builder exists for it yet.</p>
            {brief.mechanic === 'custom' ? (
              <TextArea rows={4} maxLength={1000} aria-label="Describe your game idea" placeholder="For example: a memory card game where learners flip pairs of matching coordinates." value={brief.customIdea} onChange={(e) => set('customIdea', e.target.value)} />
            ) : (
              <div className="custom-hint">
                <Sparkles size={16} aria-hidden="true" /> Claude drafts the blueprint; a developer builds it.
              </div>
            )}
          </div>
        </div>
      </section>

      <details className="optional-details">
        <summary>Optional details</summary>
        <div className="form-grid">
          <Field label="Story or setting" htmlFor="opt-story" className="span-2">
            <TextArea id="opt-story" rows={2} maxLength={600} value={brief.optional.story} placeholder="Learners are air traffic controllers at a busy airfield." onChange={(e) => setOpt('story', e.target.value)} />
          </Field>
          <div className="field">
            <span className="field-label">Difficulty</span>
            <Segmented
              label="Difficulty"
              value={brief.optional.difficulty}
              onChange={(v) => setOpt('difficulty', v)}
              options={[
                { value: 'gentle', label: 'Gentle' },
                { value: 'standard', label: 'Standard' },
                { value: 'challenging', label: 'Challenging' },
              ]}
            />
          </div>
          <Field label="Language notes" htmlFor="opt-lang" help="Reading level, vocabulary to use or avoid.">
            <TextInput id="opt-lang" maxLength={300} value={brief.optional.languageNotes} onChange={(e) => setOpt('languageNotes', e.target.value)} />
          </Field>
          <Field label="Constraints" htmlFor="opt-constraints" className="span-2">
            <TextArea id="opt-constraints" rows={2} maxLength={600} value={brief.optional.constraints} placeholder="No timers. Keep each scene under a minute." onChange={(e) => setOpt('constraints', e.target.value)} />
          </Field>
          <Field label="Accessibility notes" htmlFor="opt-a11y" className="span-2">
            <TextInput id="opt-a11y" maxLength={400} value={brief.optional.accessibilityNotes} placeholder="Some learners use switch access." onChange={(e) => setOpt('accessibilityNotes', e.target.value)} />
          </Field>
        </div>
      </details>

      {gaps.length > 0 && (
        <Banner tone="info" title="Still needed before analysis">
          <ul className="plain-list">
            {gaps.map((g) => (
              <li key={g}>{g}</li>
            ))}
          </ul>
        </Banner>
      )}
    </div>
  );
}
