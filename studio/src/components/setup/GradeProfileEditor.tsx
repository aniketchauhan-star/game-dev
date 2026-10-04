import { useEffect, useMemo, useState } from 'react';
import { GraduationCap, Info, RotateCcw } from 'lucide-react';
import { GRADE_PRESETS, gradeLabel, presetForGrade, PRESET_DISCLAIMER, profileForGrade, type GradeProfile, type GradeValue } from '@shared/schemas/grade.ts';
import { errorMessage } from '../../lib/api.ts';
import { useSaveStatus } from '../../lib/saveStatus.tsx';
import { useGrade, useSaveGrade } from '../../lib/studioQueries.ts';
import { Button, Checkbox, Field, Segmented, Select, TextArea, TextInput } from '../ui/controls.tsx';
import { Banner, Pill, Spinner } from '../ui/feedback.tsx';
import { useToast } from '../ui/overlay.tsx';

const LANGUAGES: Array<[string, string]> = [
  ['en', 'English'],
  ['en-GB', 'English (UK)'],
  ['en-US', 'English (US)'],
  ['en-IN', 'English (India)'],
  ['hi', 'Hindi'],
  ['es', 'Spanish'],
  ['fr', 'French'],
  ['de', 'German'],
  ['ar', 'Arabic'],
  ['pt', 'Portuguese'],
];

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** “Which grade is this game for?” — grade plus four separate, editable settings. Saving never rewrites the game. */
export function GradeProfileEditor({ projectId, onSaved, gameBuiltFor }: { projectId: string; onSaved?: (p: GradeProfile) => void; gameBuiltFor?: string | null }) {
  const grade = useGrade(projectId);
  const save = useSaveGrade(projectId);
  const { track } = useSaveStatus();
  const toast = useToast();
  const saved = grade.data?.current?.profile ?? null;
  const [draft, setDraft] = useState<GradeProfile | null>(null);
  const [pendingGrade, setPendingGrade] = useState<GradeValue | null>(null);

  useEffect(() => {
    if (grade.data && !draft) setDraft(saved ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grade.data]);

  const preset = useMemo(() => (draft ? presetForGrade(draft.grade) : null), [draft]);
  if (grade.isLoading) return <Spinner label="Loading the grade profile…" />;

  const set = <K extends keyof GradeProfile>(k: K, v: GradeProfile[K]) => setDraft((d) => (d ? { ...d, [k]: v, presetId: k === 'difficulty' || k === 'readingSupport' || k === 'guidance' || k === 'motion' ? null : d.presetId } : d));
  const chooseGrade = (g: GradeValue) => {
    if (!draft) {
      setDraft(profileForGrade(g));
      return;
    }
    if (draft.grade === g) return;
    // Grade supplies starting suggestions only: ask before replacing the four settings.
    setDraft({ ...draft, grade: g });
    if (presetForGrade(g)?.id !== presetForGrade(draft.grade)?.id) setPendingGrade(g);
  };
  const applyPreset = (g: GradeValue) => {
    if (!draft) return;
    const seeded = profileForGrade(g, draft);
    setDraft({ ...draft, difficulty: seeded.difficulty, readingSupport: seeded.readingSupport, guidance: seeded.guidance, motion: seeded.motion, presetId: seeded.presetId });
    setPendingGrade(null);
  };
  const dirty = draft !== null && !same(draft, saved);
  const commit = () => {
    if (!draft) return;
    void track(() => save.mutateAsync({ profile: draft, expectedRevision: grade.data?.current?.revision ?? 0 }))
      .then((r) => {
        toast({ tone: 'success', title: `Saved ${gradeLabel(draft)} profile`, detail: r.current ? `Profile revision ${r.current.revision}. The game is not changed until you review a plan.` : undefined });
        setPendingGrade(null);
        onSaved?.(draft);
      })
      .catch((e) => toast({ tone: 'error', title: 'Grade profile not saved', detail: `${errorMessage(e).message} ${errorMessage(e).hint ?? ''}` }));
  };

  return (
    <div className="grade-editor stack">
      <section className="grade-hero" aria-labelledby="grade-q">
        <h3 id="grade-q" className="grade-question">
          <GraduationCap size={20} aria-hidden="true" /> Which grade is this game for?
        </h3>
        <div className="grade-picker" role="radiogroup" aria-label="Grade">
          {Array.from({ length: 12 }, (_, i) => i + 1).map((g) => (
            <button key={g} type="button" role="radio" aria-checked={draft?.grade === g} className={`grade-chip${draft?.grade === g ? ' is-selected' : ''}`} onClick={() => chooseGrade(g)}>
              {g}
            </button>
          ))}
          <button type="button" role="radio" aria-checked={draft?.grade === 'custom'} className={`grade-chip grade-chip-custom${draft?.grade === 'custom' ? ' is-selected' : ''}`} onClick={() => chooseGrade('custom')}>
            Custom
          </button>
        </div>
        <p className="subtle small">
          <Info size={13} aria-hidden="true" /> Grade gives starting suggestions only. NEXUS does not infer a learner’s age, ability, diagnosis or reading level from it.
        </p>
      </section>

      {!draft ? (
        <p className="muted">Choose a grade (or Custom) to see starting suggestions.</p>
      ) : (
        <>
          {draft.grade === 'custom' && (
            <Field label="Who is it for?" htmlFor="grade-custom" help="For example “Adult learners” or “Mixed Grades 4–5”.">
              <TextInput id="grade-custom" maxLength={40} value={draft.customLabel} onChange={(e) => set('customLabel', e.target.value)} />
            </Field>
          )}

          {pendingGrade !== null && presetForGrade(pendingGrade) && (
            <Banner
              tone="info"
              title={`Use the ${presetForGrade(pendingGrade)!.label} starting suggestions?`}
              actions={
                <>
                  <Button size="sm" variant="primary" onClick={() => applyPreset(pendingGrade)}>
                    Use suggestions
                  </Button>
                  <Button size="sm" onClick={() => setPendingGrade(null)}>
                    Keep my settings
                  </Button>
                </>
              }
            >
              They would set the four settings below. Nothing else changes, and you can still edit each one.
            </Banner>
          )}

          {preset && (
            <section className="preset-card" aria-label={`${preset.label} product preset`}>
              <div className="row">
                <strong>{preset.label} preset</strong>
                <Pill tone="neutral" dot={false}>
                  Product preset
                </Pill>
                {draft.presetId === preset.id && <Pill tone="info">In use</Pill>}
                <span className="spacer" />
                {draft.presetId !== preset.id && (
                  <Button size="sm" variant="ghost" icon={<RotateCcw size={14} aria-hidden="true" />} onClick={() => applyPreset(draft.grade)}>
                    Use these suggestions
                  </Button>
                )}
              </div>
              <ul className="preset-points">
                {preset.summary.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
              <p className="subtle small">{PRESET_DISCLAIMER}</p>
            </section>
          )}

          <div className="grade-settings">
            <div className="field">
              <span className="field-label">Instructional difficulty</span>
              <Segmented
                label="Instructional difficulty"
                value={draft.difficulty}
                onChange={(v) => set('difficulty', v)}
                options={[
                  { value: 'foundational', label: 'Foundational' },
                  { value: 'core', label: 'Core' },
                  { value: 'stretch', label: 'Stretch' },
                ]}
              />
              <p className="field-help">How demanding the questions are. Changing it later goes through a reviewed plan.</p>
            </div>
            <div className="field">
              <span className="field-label">Reading support</span>
              <Segmented
                label="Reading support"
                value={draft.readingSupport}
                onChange={(v) => set('readingSupport', v)}
                options={[
                  { value: 'standard', label: 'Standard' },
                  { value: 'supported', label: 'Supported' },
                  { value: 'extended', label: 'Extended' },
                ]}
              />
              <p className="field-help">How much the wording helps reading (shorter sentences, key terms, step lists) — not a reading level.</p>
            </div>
            <div className="field">
              <span className="field-label">Guidance level</span>
              <Segmented
                label="Guidance level"
                value={draft.guidance}
                onChange={(v) => set('guidance', v)}
                options={[
                  { value: 'minimal', label: 'Minimal' },
                  { value: 'standard', label: 'Standard' },
                  { value: 'extra', label: 'Extra' },
                ]}
              />
              <p className="field-help">Hints, worked examples and step-by-step prompts.</p>
            </div>
            <div className="field">
              <span className="field-label">Visual & motion style</span>
              <Segmented
                label="Motion profile"
                value={draft.motion.profile}
                onChange={(v) => set('motion', { ...draft.motion, profile: v })}
                options={[
                  { value: 'minimal', label: 'Minimal' },
                  { value: 'guided', label: 'Guided' },
                  { value: 'playful', label: 'Playful' },
                ]}
              />
              <div className="row-wrap grade-motion-row">
                <Segmented
                  label="Pacing"
                  value={draft.motion.pacing}
                  onChange={(v) => set('motion', { ...draft.motion, pacing: v })}
                  options={[
                    { value: 'calm', label: 'Calm pacing' },
                    { value: 'standard', label: 'Standard pacing' },
                  ]}
                />
                <Select aria-label="Decorative effects" value={draft.motion.decorativeIntensity} onChange={(e) => set('motion', { ...draft.motion, decorativeIntensity: e.target.value as GradeProfile['motion']['decorativeIntensity'] })}>
                  <option value="off">Decorative effects: off</option>
                  <option value="low">Decorative effects: low</option>
                  <option value="standard">Decorative effects: standard</option>
                </Select>
                <Checkbox label="Sound" checked={draft.motion.sound} onChange={(v) => set('motion', { ...draft.motion, sound: v })} />
              </div>
              <p className="field-help">Separate from difficulty: more advanced content never means faster animation or more effects.</p>
            </div>
          </div>

          <fieldset className="access-modes">
            <legend className="field-label">Available in every profile</legend>
            <div className="access-grid">
              <Checkbox label="Low motion" hint="Instructional movement shows as steps; decoration is off." checked={draft.access.lowMotion} onChange={(v) => set('access', { ...draft.access, lowMotion: v })} />
              <Checkbox label="Untimed" hint="No timers or time pressure." checked={draft.access.untimed} onChange={(v) => set('access', { ...draft.access, untimed: v })} />
              <Checkbox label="Keyboard" hint="Every action works with keys." checked={draft.access.keyboard} onChange={(v) => set('access', { ...draft.access, keyboard: v })} />
              <Checkbox label="Extra guidance" hint="Hints offered earlier, examples first." checked={draft.access.extraGuidance} onChange={(v) => set('access', { ...draft.access, extraGuidance: v })} />
            </div>
          </fieldset>

          <details className="optional-details">
            <summary>Optional details</summary>
            <div className="form-grid">
              <Field label="Curriculum or board" htmlFor="grade-curr" help="Recorded for reference. Alignment is never claimed as verified.">
                <TextInput id="grade-curr" maxLength={80} value={draft.curriculum} placeholder="e.g. CBSE, Common Core" onChange={(e) => set('curriculum', e.target.value)} />
              </Field>
              <Field label="Language" htmlFor="grade-lang">
                <Select id="grade-lang" value={draft.language} onChange={(e) => set('language', e.target.value)}>
                  {LANGUAGES.map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Lesson duration (minutes)" htmlFor="grade-mins">
                <TextInput
                  id="grade-mins"
                  type="number"
                  min={1}
                  max={180}
                  value={draft.lessonMinutes ?? ''}
                  onChange={(e) => set('lessonMinutes', e.target.value === '' ? null : Math.max(1, Math.min(180, Math.round(Number(e.target.value)))))}
                />
              </Field>
              <Field label="Input device" htmlFor="grade-device">
                <Select id="grade-device" value={draft.inputDevice} onChange={(e) => set('inputDevice', e.target.value as GradeProfile['inputDevice'])}>
                  <option value="mixed">Mixed</option>
                  <option value="mouse">Mouse</option>
                  <option value="touch">Touch screen</option>
                  <option value="keyboard">Keyboard only</option>
                  <option value="whiteboard">Interactive whiteboard</option>
                </Select>
              </Field>
              <Field label="Prerequisite knowledge" htmlFor="grade-prereq" className="span-2">
                <TextArea id="grade-prereq" rows={2} maxLength={400} value={draft.prerequisites} placeholder="e.g. Knows what parallel lines are." onChange={(e) => set('prerequisites', e.target.value)} />
              </Field>
            </div>
          </details>

          {gameBuiltFor && saved && gradeLabel(draft) !== gameBuiltFor && (
            <Banner tone="warning" title={`The game was built for ${gameBuiltFor}.`}>
              Saving {gradeLabel(draft)} does not rewrite it. Review a grade adaptation plan (before/after) in Prepare, or create another grade version to keep both.
            </Banner>
          )}

          <div className="row">
            <Button variant="primary" disabled={!dirty || (draft.grade === 'custom' && !draft.customLabel.trim())} loading={save.isPending} onClick={commit}>
              Save grade profile
            </Button>
            {dirty && saved && (
              <Button variant="ghost" onClick={() => setDraft(saved)}>
                Discard changes
              </Button>
            )}
            <span className="subtle small">{grade.data?.current ? `Saved revision ${grade.data.current.revision} · ${gradeLabel(grade.data.current.profile)}` : 'Not saved yet'}</span>
          </div>
        </>
      )}
    </div>
  );
}

/** One-line summary for cards: “Grade 8 · Core · Standard reading support · Guided motion”. */
export function gradeSummary(p: GradeProfile): string {
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  return `${gradeLabel(p)} · ${cap(p.difficulty)} difficulty · ${cap(p.readingSupport)} reading support · ${cap(p.guidance)} guidance · ${cap(p.motion.profile)} motion`;
}

export { GRADE_PRESETS };
