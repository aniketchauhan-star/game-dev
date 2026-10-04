import type { ReactNode } from 'react';
import { Ban, Check, CircleSlash, Info, Sparkles, X } from 'lucide-react';
import type { GameConfig } from '@shared/schemas/game.ts';
import type { AdaptationItem, GradePlanRecord } from '@shared/schemas/grade.ts';
import { MOTION_SETTING_LABELS, type AnimationBinding, type MotionPlanRecord, type PlanDecision } from '@shared/schemas/motion.ts';
import { summarizeValue } from '@shared/schemas/proposal.ts';
import { describeBinding } from '@shared/motion/describe.ts';
import { listScreens } from '@shared/motion/entities.ts';
import { MOTION_PRESETS } from '@shared/motion/presets.ts';
import { Button } from '../ui/controls.tsx';
import { Pill } from '../ui/feedback.tsx';

const ORIGIN_LABEL: Record<string, { text: string; tone: 'ai' | 'info' | 'neutral' | 'success' }> = {
  claude: { text: 'AI suggestion', tone: 'ai' },
  demo: { text: 'Demo (prepared)', tone: 'neutral' },
  preset: { text: 'Preset rule', tone: 'info' },
  creator: { text: 'You', tone: 'success' },
  source: { text: 'From the lesson', tone: 'success' },
  'design-evidence': { text: 'Design evidence', tone: 'info' },
};

export function DecisionToggle({ value, onChange, disabled, label }: { value: PlanDecision; onChange: (d: PlanDecision) => void; disabled?: boolean; label: string }) {
  return (
    <div className="decision" role="group" aria-label={`Decision for ${label}`}>
      <button type="button" className={`decision-btn is-accept${value === 'accepted' ? ' is-on' : ''}`} aria-pressed={value === 'accepted'} disabled={disabled} onClick={() => onChange(value === 'accepted' ? 'pending' : 'accepted')}>
        <Check size={14} aria-hidden="true" /> Accept
      </button>
      <button type="button" className={`decision-btn is-reject${value === 'rejected' ? ' is-on' : ''}`} aria-pressed={value === 'rejected'} disabled={disabled} onClick={() => onChange(value === 'rejected' ? 'pending' : 'rejected')}>
        <X size={14} aria-hidden="true" /> Reject
      </button>
    </div>
  );
}

function fieldValue(config: GameConfig | null, item: AdaptationItem): unknown {
  if (!config || !item.change) return null;
  const scenes = item.sceneId ? config.scenes.filter((s) => s.id === item.sceneId) : config.scenes;
  const pick = (s: GameConfig['scenes'][number]): unknown => {
    switch (item.change!.field) {
      case 'title':
        return s.title;
      case 'instruction':
        return s.instruction;
      case 'supportText':
        return s.supportText;
      case 'feedback.success':
        return s.feedback.success;
      case 'feedback.error':
        return s.feedback.error;
      case 'feedback.hints':
        return s.feedback.hints;
      case 'layout.density':
        return s.layout.density;
      case 'layout.showProgress':
        return s.layout.showProgress;
    }
  };
  const values = [...new Set(scenes.map((s) => JSON.stringify(pick(s))))];
  return values.length === 1 ? JSON.parse(values[0]!) : 'Varies by scene';
}

/** Before/after review of a grade adaptation plan. Nothing changes until items are accepted and applied. */
export function GradePlanReview({
  plan,
  config,
  onDecide,
  busy,
  actions,
}: {
  plan: GradePlanRecord;
  /** The game the plan is compared with (current version, or null before the first build). */
  config: GameConfig | null;
  onDecide: (decisions: Record<string, PlanDecision>) => void;
  busy?: boolean;
  actions?: ReactNode;
}) {
  const open = plan.status === 'proposed';
  const sceneTitle = (id: string | null) => (id ? (config?.scenes.find((s) => s.id === id)?.title ?? id) : 'Whole game');
  const origin = ORIGIN_LABEL[plan.origin] ?? ORIGIN_LABEL.preset!;
  return (
    <section className="plan-review" aria-label={`Grade adaptation plan ${plan.number}`}>
      <header className="plan-head">
        <div className="stack-tight">
          <div className="row-wrap">
            <strong>Grade plan {plan.number}</strong>
            <Pill tone={origin.tone} dot={false}>
              {plan.origin === 'claude' ? <Sparkles size={12} aria-hidden="true" /> : null} {origin.text}
            </Pill>
            <Pill tone="neutral" dot={false}>
              {plan.mode === 'presentation' ? 'Presentation only' : 'Presentation + learning challenge'}
            </Pill>
            <Pill tone={plan.status === 'proposed' ? 'warning' : plan.status === 'applied' ? 'success' : 'neutral'}>{plan.status}</Pill>
          </div>
          <span className="subtle small">
            {plan.fromGrade ? `${plan.fromGrade} → ` : ''}
            {plan.toGrade} · grade profile revision {plan.gradeProfileRevision}
            {plan.baseVersionNumber ? ` · against version ${plan.baseVersionNumber}` : ' · staged for the next build'}
          </span>
        </div>
        {open && (
          <div className="row">
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => onDecide(Object.fromEntries(plan.plan.items.filter((i) => i.change && !i.changesLearning).map((i) => [i.id, 'accepted'])))}>
              Accept all changes
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => onDecide(Object.fromEntries(plan.plan.items.map((i) => [i.id, 'rejected'])))}>
              Reject all
            </Button>
          </div>
        )}
      </header>
      <p className="plan-summary">{plan.plan.summary}</p>
      <div className="plan-table-wrap">
        <table className="plan-table">
          <thead>
            <tr>
              <th scope="col">Change</th>
              <th scope="col">Where</th>
              <th scope="col">Before</th>
              <th scope="col">After</th>
              <th scope="col">Decision</th>
            </tr>
          </thead>
          <tbody>
            {plan.plan.items.map((item) => {
              const decision = plan.decisions[item.id] ?? 'pending';
              const appliesHere = item.change !== null && !(item.changesLearning && plan.mode === 'presentation');
              return (
                <tr key={item.id} className={`decision-${decision}`}>
                  <td>
                    <span className="plan-item-summary">{item.summary}</span>
                    <span className="subtle small block">{item.rationale}</span>
                    <span className="row-wrap tags">
                      <Pill tone="neutral" dot={false}>
                        {item.area}
                      </Pill>
                      {item.addedPractice && <Pill tone="warning">Added practice</Pill>}
                      {item.changesLearning && <Pill tone="ai">Changes learning — needs blueprint review</Pill>}
                      {item.sourceSlideIds.length > 0 && (
                        <Pill tone="info" dot={false}>
                          {item.sourceSlideIds.length} source slide{item.sourceSlideIds.length === 1 ? '' : 's'}
                        </Pill>
                      )}
                    </span>
                  </td>
                  <td>{item.change ? sceneTitle(item.sceneId) : <span className="subtle">—</span>}</td>
                  <td className="plan-before">{item.change ? summarizeValue(fieldValue(config, item)) : <span className="subtle">—</span>}</td>
                  <td className="plan-after">{item.change ? summarizeValue(item.change.value) : <span className="subtle">{item.changesLearning ? 'Described for review' : 'Advice only'}</span>}</td>
                  <td>
                    {appliesHere || plan.mode === 'challenge' ? (
                      <DecisionToggle value={decision} disabled={!open || busy} label={item.summary} onChange={(d) => onDecide({ [item.id]: d })} />
                    ) : (
                      <span className="subtle small">
                        <CircleSlash size={13} aria-hidden="true" /> Not applied in presentation mode
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <dl className="plan-notes">
        <dt>Motion purpose</dt>
        <dd>{plan.plan.motionPurpose}</dd>
        <dt>Assumptions</dt>
        <dd>
          <ul className="plain-list small">
            {plan.plan.assumptions.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
        </dd>
        <dt>Curriculum</dt>
        <dd>{plan.plan.curriculumNote}</dd>
      </dl>
      {actions && <div className="row-wrap plan-actions">{actions}</div>}
    </section>
  );
}

function timing(b: AnimationBinding, all: AnimationBinding[]): string {
  const parts = [`${(b.timing.durationMs / 1000).toFixed(b.timing.durationMs % 100 ? 2 : 1)} s`];
  if (b.timing.delayMs) parts.unshift(`after ${(b.timing.delayMs / 1000).toFixed(1)} s`);
  if (b.after) parts.unshift(`after “${MOTION_PRESETS[all.find((x) => x.id === b.after)?.presetId ?? 'fade-in'].label}”`);
  if (b.timing.repeat > 1) parts.push(`× ${b.timing.repeat}`);
  return parts.join(' · ');
}

/** Review rows of a motion plan: target, trigger, effect, timing, purpose and origin. */
export function MotionPlanReview({
  plan,
  config,
  onDecide,
  onPreview,
  onEdit,
  busy,
  actions,
}: {
  plan: MotionPlanRecord;
  config: GameConfig | null;
  onDecide: (decisions: Record<string, PlanDecision>) => void;
  onPreview?: (binding: AnimationBinding) => void;
  /** Take a proposed row over as your own editable draft (the row is then declined in the plan). */
  onEdit?: (binding: AnimationBinding) => void;
  busy?: boolean;
  actions?: ReactNode;
}) {
  const open = plan.status === 'proposed';
  const screens = config ? listScreens({ ...config, motion: { ...config.motion, bindings: [...config.motion.bindings, ...plan.plan.add] } }) : [];
  const screenLabel = (id: string) => screens.find((s) => s.id === id)?.label ?? id;
  const entityLabel = (screenId: string, id: string) => screens.find((s) => s.id === screenId)?.entities.find((e) => e.id === id)?.label ?? id;
  const origin = ORIGIN_LABEL[plan.origin] ?? ORIGIN_LABEL.preset!;
  const draft = config ? { ...config, motion: { ...config.motion, bindings: [...config.motion.bindings, ...plan.plan.add] } } : null;
  return (
    <section className="plan-review" aria-label={`Motion plan ${plan.number}`}>
      <header className="plan-head">
        <div className="stack-tight">
          <div className="row-wrap">
            <strong>Motion plan {plan.number}</strong>
            <Pill tone={origin.tone} dot={false}>
              {plan.origin === 'claude' ? <Sparkles size={12} aria-hidden="true" /> : null} {origin.text}
            </Pill>
            <Pill tone="neutral" dot={false}>
              {plan.scope.kind === 'screen' && plan.scope.screenId ? screenLabel(plan.scope.screenId) : 'Whole game'}
            </Pill>
            <Pill tone={plan.status === 'proposed' ? 'warning' : plan.status === 'applied' ? 'success' : 'neutral'}>{plan.status}</Pill>
          </div>
          {plan.request && plan.request !== 'Prepare my game' && <span className="plan-request">“{plan.request}”</span>}
          <span className="subtle small">
            {plan.baseVersionNumber ? `Against version ${plan.baseVersionNumber}` : 'Staged for the next build'}
            {plan.gradeProfileRevision !== null ? ` · grade profile revision ${plan.gradeProfileRevision}` : ''}
          </span>
        </div>
        {open && Object.keys(plan.decisions).length > 0 && (
          <div className="row">
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => onDecide(Object.fromEntries(Object.keys(plan.decisions).map((k) => [k, 'accepted'])))}>
              Accept all
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => onDecide(Object.fromEntries(Object.keys(plan.decisions).map((k) => [k, 'rejected'])))}>
              Reject all
            </Button>
          </div>
        )}
      </header>
      <p className="plan-summary">{plan.plan.summary}</p>
      {plan.plan.resolved.length > 0 && (
        <div className="row-wrap chips" aria-label="How your words were understood">
          {plan.plan.resolved.map((r, i) => (
            <span key={i} className="chip chip-scope" title={`“${r.phrase}”`}>
              “{r.phrase}” → {r.screenId ? `${screenLabel(r.screenId)}${r.entityId ? ` · ${entityLabel(r.screenId, r.entityId)}` : ''}` : r.label}
            </span>
          ))}
        </div>
      )}
      {(plan.plan.add.length > 0 || plan.plan.remove.length > 0 || plan.plan.settings) && (
        <div className="plan-table-wrap">
          <table className="plan-table">
            <thead>
              <tr>
                <th scope="col">Target</th>
                <th scope="col">Trigger → effect</th>
                <th scope="col">Timing</th>
                <th scope="col">Purpose</th>
                <th scope="col">Origin</th>
                <th scope="col">Decision</th>
              </tr>
            </thead>
            <tbody>
              {plan.plan.add.map((b) => {
                const d = plan.decisions[b.id] ?? 'pending';
                const o = ORIGIN_LABEL[b.origin] ?? ORIGIN_LABEL.preset!;
                return (
                  <tr key={b.id} className={`decision-${d}`}>
                    <td>
                      <span className="chip">{screenLabel(b.screenId).replace(/ · .*/, '')}</span> <span className="chip chip-source">{entityLabel(b.screenId, b.target)}</span>
                    </td>
                    <td>
                      {b.label || (draft ? describeBinding(draft, b) : b.presetId)}
                      <span className="subtle small block">
                        Reduced motion: {b.reducedMotion}
                        {b.sound ? ' · with sound' : ''}
                      </span>
                    </td>
                    <td className="nowrap">{timing(b, [...(config?.motion.bindings ?? []), ...plan.plan.add])}</td>
                    <td>
                      <Pill tone={b.purpose === 'instructional' ? 'info' : b.purpose === 'feedback' ? 'success' : 'neutral'} dot={false}>
                        {b.purpose}
                      </Pill>
                    </td>
                    <td>
                      <Pill tone={o.tone} dot={false}>
                        {o.text}
                      </Pill>
                    </td>
                    <td>
                      <div className="row">
                        <DecisionToggle value={d} disabled={!open || busy} label={b.label || b.presetId} onChange={(v) => onDecide({ [b.id]: v })} />
                        {onPreview && (
                          <Button size="sm" variant="ghost" onClick={() => onPreview(b)}>
                            Preview
                          </Button>
                        )}
                        {onEdit && open && (
                          <Button size="sm" variant="ghost" disabled={busy} title="Copy this row into your own draft to change it; the plan row is declined." onClick={() => onEdit(b)}>
                            Edit
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {plan.plan.remove.map((r) => {
                const existing = config?.motion.bindings.find((b) => b.id === r.id);
                const key = `remove:${r.id}`;
                const d = plan.decisions[key] ?? 'pending';
                return (
                  <tr key={key} className={`decision-${d}`}>
                    <td>{existing ? <span className="chip chip-source">{entityLabel(existing.screenId, existing.target)}</span> : r.id}</td>
                    <td>
                      <Ban size={13} aria-hidden="true" /> Remove: {existing && config ? describeBinding(config, existing) : r.id}
                      <span className="subtle small block">{r.reason}</span>
                    </td>
                    <td>—</td>
                    <td>{existing ? <Pill tone="neutral" dot={false}>{existing.purpose}</Pill> : '—'}</td>
                    <td>
                      <Pill tone={origin.tone} dot={false}>
                        {origin.text}
                      </Pill>
                    </td>
                    <td>
                      <DecisionToggle value={d} disabled={!open || busy} label={`Remove ${r.id}`} onChange={(v) => onDecide({ [key]: v })} />
                    </td>
                  </tr>
                );
              })}
              {plan.plan.settings && Object.keys(plan.plan.settings).length > 0 && (
                <tr className={`decision-${plan.decisions.settings ?? 'pending'}`}>
                  <td>Whole game</td>
                  <td>
                    Motion settings:{' '}
                    {Object.entries(plan.plan.settings)
                      .map(([k, v]) => `${MOTION_SETTING_LABELS[k as keyof typeof MOTION_SETTING_LABELS] ?? k} → ${String(v)}`)
                      .join(', ')}
                  </td>
                  <td>—</td>
                  <td>—</td>
                  <td>
                    <Pill tone={origin.tone} dot={false}>
                      {origin.text}
                    </Pill>
                  </td>
                  <td>
                    <DecisionToggle value={plan.decisions.settings ?? 'pending'} disabled={!open || busy} label="Motion settings" onChange={(v) => onDecide({ settings: v })} />
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      {plan.plan.unsupported.length > 0 && (
        <div className="unsupported-list" role="note">
          <strong>
            <Info size={14} aria-hidden="true" /> Not supported — reported, not faked
          </strong>
          <ul className="plain-list small">
            {plan.plan.unsupported.map((u, i) => (
              <li key={i}>
                <strong>{u.request}:</strong> {u.reason}
                {u.alternative ? <span className="subtle"> Instead: {u.alternative}</span> : null}
                {u.handoff ? <Pill tone="warning">Developer handoff</Pill> : null}
              </li>
            ))}
          </ul>
        </div>
      )}
      {plan.plan.notes.length > 0 && (
        <ul className="plain-list small subtle">
          {plan.plan.notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      )}
      {actions && <div className="row-wrap plan-actions">{actions}</div>}
    </section>
  );
}
