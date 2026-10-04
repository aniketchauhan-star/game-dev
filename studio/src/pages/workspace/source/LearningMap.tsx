import { useEffect, useState } from 'react';
import { CircleCheck, FlaskConical, Lock, LockOpen, Sparkles, TriangleAlert } from 'lucide-react';
import type { LearningAnalysis } from '@shared/schemas/analysis.ts';
import type { AnalysisRecord } from '@shared/schemas/records.ts';
import type { SourceSlide } from '@shared/schemas/source.ts';
import { useSaveAnalysis } from '../../../lib/queries.ts';
import { useSaveStatus } from '../../../lib/saveStatus.tsx';
import { errorMessage } from '../../../lib/api.ts';
import { formatDate } from '../../../lib/format.ts';
import { Button, IconButton, TextArea } from '../../../components/ui/controls.tsx';
import { Banner, OriginBadge, Pill } from '../../../components/ui/feedback.tsx';
import { useToast } from '../../../components/ui/overlay.tsx';
import { SourceChips } from '../../../components/SourceChips.tsx';

/**
 * Claude's interpretation, editable by the creator. Objectives are labelled as
 * proposals until verified; every item cites slides or is marked added practice.
 */
export function LearningMap({
  record,
  slides,
  projectId,
  onAnalyze,
  analyzing,
  analyzeMode,
}: {
  record: AnalysisRecord;
  slides: SourceSlide[];
  projectId: string;
  onAnalyze: () => void;
  analyzing: boolean;
  /** 'live' with a verified model, 'demo' for the sample without a key, 'none' otherwise. */
  analyzeMode: 'live' | 'demo' | 'none';
}) {
  const save = useSaveAnalysis(projectId);
  const { track } = useSaveStatus();
  const toast = useToast();
  const [draft, setDraft] = useState<LearningAnalysis>(record.analysis);
  const [editing, setEditing] = useState<string | null>(null);
  useEffect(() => setDraft(record.analysis), [record.id, record.revision]); // eslint-disable-line react-hooks/exhaustive-deps

  const commit = (next: LearningAnalysis) => {
    setDraft(next);
    void track(() => save.mutateAsync({ id: record.id, analysis: next, revision: record.revision })).catch((e) => {
      setDraft(record.analysis);
      toast({ tone: 'error', title: 'Learning map not saved', detail: errorMessage(e).message });
    });
  };
  const updateObjective = (id: string, patch: Partial<LearningAnalysis['objectives'][number]>) =>
    commit({ ...draft, objectives: draft.objectives.map((o) => (o.id === id ? { ...o, ...patch, origin: patch.text !== undefined ? 'creator' : o.origin } : o)) });
  const a = draft;
  const chips = (ids: string[], added?: boolean) => <SourceChips projectId={projectId} slideIds={ids} slides={slides} addedPractice={added && ids.length === 0} />;

  return (
    <div className="learning-map stack">
      <header className="map-head">
        <div>
          <p className="eyebrow">Learning map · analysis {record.number}</p>
          <h1>{a.topic}</h1>
          <div className="row-wrap">
            <OriginBadge origin={record.origin} model={record.model} />
            <span className="subtle small">{formatDate(record.createdAt)}</span>
          </div>
        </div>
        {analyzeMode === 'live' && (
          <Button variant="ai" icon={<Sparkles size={16} aria-hidden="true" />} loading={analyzing} onClick={onAnalyze}>
            Re-analyze
          </Button>
        )}
        {analyzeMode === 'demo' && (
          <Button icon={<FlaskConical size={16} aria-hidden="true" />} loading={analyzing} onClick={onAnalyze}>
            Replay demo analysis
          </Button>
        )}
      </header>
      {record.stale && (
        <Banner tone="warning" title="This learning map is stale" actions={analyzeMode === 'none' ? undefined : <Button size="sm" variant={analyzeMode === 'live' ? 'ai' : 'default'} loading={analyzing} onClick={onAnalyze}>{analyzeMode === 'live' ? 'Re-analyze changed content' : 'Replay demo analysis'}</Button>}>
          {record.staleReason}
        </Banner>
      )}
      <p className="map-summary">{a.summary}</p>

      <section className="map-section">
        <div className="section-head">
          <h2 className="h-sub">Learning objectives</h2>
          <span className="subtle small">Proposed objectives are interpretations — verify or reword them.</span>
        </div>
        <ul className="objective-list">
          {a.objectives.map((o) => (
            <li key={o.id} className={`objective${o.status === 'verified' ? ' is-verified' : ''}`}>
              {editing === o.id ? (
                <TextArea
                  aria-label="Objective text"
                  autoFocus
                  defaultValue={o.text}
                  maxLength={240}
                  rows={2}
                  onBlur={(e) => {
                    setEditing(null);
                    if (e.target.value.trim() && e.target.value.trim() !== o.text) updateObjective(o.id, { text: e.target.value.trim() });
                  }}
                />
              ) : (
                <button type="button" className="objective-text" disabled={o.locked} onClick={() => setEditing(o.id)} title={o.locked ? 'Wording locked' : 'Click to reword'}>
                  {o.text}
                </button>
              )}
              <div className="objective-meta">
                {o.status === 'verified' ? <Pill tone="success">Verified by creator</Pill> : <Pill tone="ai">Proposed</Pill>}
                {o.origin === 'creator' && <Pill tone="info">Reworded by creator</Pill>}
                {chips(o.sourceSlideIds, o.addedPractice)}
                <span className="spacer" />
                <Button size="sm" variant="ghost" icon={<CircleCheck size={14} aria-hidden="true" />} onClick={() => updateObjective(o.id, { status: o.status === 'verified' ? 'proposed' : 'verified' })}>
                  {o.status === 'verified' ? 'Unverify' : 'Verify'}
                </Button>
                <IconButton label={o.locked ? 'Unlock wording' : 'Lock wording'} size="sm" pressed={o.locked} onClick={() => updateObjective(o.id, { locked: !o.locked })}>
                  {o.locked ? <Lock size={14} aria-hidden="true" /> : <LockOpen size={14} aria-hidden="true" />}
                </IconButton>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <div className="map-columns">
        <section className="map-section">
          <h2 className="h-sub">Concepts</h2>
          <ul className="map-list">
            {a.concepts.map((c) => (
              <li key={c.id}>
                <strong>{c.name}</strong>
                <p className="muted small">{c.description}</p>
                {chips(c.sourceSlideIds)}
              </li>
            ))}
          </ul>
        </section>
        <section className="map-section">
          <h2 className="h-sub">Prerequisites</h2>
          <ul className="map-list">
            {a.prerequisites.map((p) => (
              <li key={p.id}>
                {p.text} {p.inferred && <Pill tone="neutral">Inferred</Pill>}
                <div>{chips(p.sourceSlideIds)}</div>
              </li>
            ))}
            {a.prerequisites.length === 0 && <li className="subtle small">None listed.</li>}
          </ul>
        </section>
      </div>

      <section className="map-section">
        <h2 className="h-sub">Examples</h2>
        <ul className="map-list">
          {a.examples.map((e) => (
            <li key={e.id} className="row-wrap">
              <span>{e.text}</span>
              <button
                type="button"
                className="chip"
                aria-pressed={e.required}
                onClick={() => commit({ ...a, examples: a.examples.map((x) => (x.id === e.id ? { ...x, required: !x.required } : x)) })}
              >
                {e.required ? 'Required example' : 'Mark required'}
              </button>
              {chips(e.sourceSlideIds)}
            </li>
          ))}
        </ul>
      </section>

      <div className="map-columns">
        <section className="map-section">
          <h2 className="h-sub">Check-for-understanding questions</h2>
          <ul className="map-list">
            {a.questions.map((q) => (
              <li key={q.id}>
                <strong>{q.prompt}</strong>
                <p className="muted small">Answer: {q.answer}</p>
                {chips(q.sourceSlideIds, q.addedPractice)}
              </li>
            ))}
          </ul>
        </section>
        <section className="map-section">
          <h2 className="h-sub">Possible interactions</h2>
          <ul className="map-list">
            {a.interactions.map((i) => (
              <li key={i.id}>
                <Pill tone="info" dot={false}>
                  {i.mechanic}
                </Pill>{' '}
                {i.description}
                <div>{chips(i.sourceSlideIds, i.addedPractice)}</div>
              </li>
            ))}
          </ul>
        </section>
      </div>

      {a.openQuestions.length > 0 && (
        <section className="map-section">
          <h2 className="h-sub">
            <TriangleAlert size={16} aria-hidden="true" /> Open questions
          </h2>
          <ul className="plain-list">
            {a.openQuestions.map((q, i) => (
              <li key={i}>{q}</li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
