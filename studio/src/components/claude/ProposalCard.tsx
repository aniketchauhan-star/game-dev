import type { ReactElement } from 'react';
import { Ban, Check, Lock, RotateCcw, TriangleAlert, Undo2, X } from 'lucide-react';
import { summarizeValue } from '@shared/schemas/proposal.ts';
import type { Proposal } from '@shared/schemas/records.ts';
import { useProposalAction, useSlides } from '../../lib/queries.ts';
import { errorMessage } from '../../lib/api.ts';
import { Button } from '../ui/controls.tsx';
import { DemoBadge, OriginBadge, Pill } from '../ui/feedback.tsx';
import { useToast } from '../ui/overlay.tsx';
import { SourceChips } from '../SourceChips.tsx';

const STATUS: Record<Proposal['results'][number]['status'], { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' | 'info'; icon: ReactElement }> = {
  applied: { label: 'Ready', tone: 'success', icon: <Check size={13} aria-hidden="true" /> },
  conflict: { label: 'Locked', tone: 'warning', icon: <Lock size={13} aria-hidden="true" /> },
  'out-of-scope': { label: 'Outside scope', tone: 'warning', icon: <Ban size={13} aria-hidden="true" /> },
  invalid: { label: 'Invalid', tone: 'danger', icon: <X size={13} aria-hidden="true" /> },
  unchanged: { label: 'No change', tone: 'neutral', icon: <Check size={13} aria-hidden="true" /> },
};

const IMPACT: Record<string, string> = {
  wording: 'Changes learner-facing wording',
  answers: 'Changes answers or learning content',
  difficulty: 'Changes difficulty or support',
  sequence: 'Changes the learning sequence',
};

export function ProposalCard({ proposal, projectId, currentVersionId }: { proposal: Proposal; projectId: string; currentVersionId: string | null }) {
  const action = useProposalAction(projectId);
  const slides = useSlides(projectId);
  const toast = useToast();
  const applicable = proposal.results.filter((r) => r.status === 'applied').length;
  const stale = proposal.status === 'proposed' && currentVersionId !== proposal.baseVersionId;
  const impacts = [...new Set(proposal.results.filter((r) => r.status === 'applied' && r.impact !== 'none').map((r) => r.impact))];
  const sourceIds = [...new Set(proposal.results.flatMap((r) => r.sourceSlideIds))];
  const run = (a: 'apply' | 'reject' | 'undo') =>
    action.mutate(
      { id: proposal.id, action: a },
      {
        onSuccess: (r) => {
          if (a === 'apply' && r.version) toast({ tone: 'success', title: `Applied → version ${r.version.number}`, detail: 'The previous version stays in the history.' });
          if (a === 'undo' && r.version) toast({ tone: 'success', title: `Undone → version ${r.version.number}` });
        },
        onError: (e) => toast({ tone: 'error', title: a === 'apply' ? 'Not applied' : 'Action failed', detail: `${errorMessage(e).message} ${errorMessage(e).hint ?? ''}` }),
      },
    );
  return (
    <article className={`proposal${proposal.status !== 'proposed' ? ` is-${proposal.status}` : ''}`} aria-label={`Proposed change: ${proposal.summary}`}>
      <header className="proposal-head">
        <span className="proposal-kicker">{proposal.origin === 'creator' ? 'Your edit' : 'Proposed change'}</span>
        <span className="subtle small">· against v{proposal.baseVersionNumber}</span>
        <span className="spacer" />
        {proposal.origin === 'demo' ? <DemoBadge text="Demo template" /> : <OriginBadge origin={proposal.origin} model={proposal.model} />}
      </header>
      <h4 className="proposal-title">{proposal.summary}</h4>
      {proposal.explanation && <p className="proposal-expl">{proposal.explanation}</p>}
      <ul className="change-list">
        {proposal.results.map((r) => {
          const st = STATUS[r.status];
          return (
            <li key={r.index} className={`change is-${r.status}`}>
              <div className="change-head">
                <span className="change-label">
                  {r.label}
                  {r.where && <span className="change-where">{r.where}</span>}
                </span>
                <Pill tone={st.tone} dot={false}>
                  {st.icon}
                  {st.label}
                </Pill>
              </div>
              <dl className="change-diff">
                <dt>Before</dt>
                <dd className="before">{summarizeValue(r.before)}</dd>
                <dt>After</dt>
                <dd className="after">{summarizeValue(r.after)}</dd>
              </dl>
              {r.message && (
                <p className="change-msg">
                  {r.status === 'applied' ? <TriangleAlert size={13} aria-hidden="true" /> : null}
                  {r.message}
                </p>
              )}
            </li>
          );
        })}
      </ul>
      {(impacts.length > 0 || sourceIds.length > 0) && (
        <div className="proposal-meta">
          {impacts.map((i) => (
            <Pill key={i} tone="warning" dot={false}>
              {IMPACT[i] ?? i}
            </Pill>
          ))}
          {sourceIds.length > 0 && <SourceChips projectId={projectId} slideIds={sourceIds} slides={slides.data?.slides ?? []} />}
        </div>
      )}
      <footer className="proposal-actions">
        {proposal.status === 'proposed' && !stale && (
          <>
            <Button size="sm" variant="primary" disabled={applicable === 0} loading={action.isPending && action.variables?.action === 'apply'} onClick={() => run('apply')}>
              Apply {applicable > 0 ? `${applicable} change${applicable === 1 ? '' : 's'}` : ''}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => run('reject')}>
              Reject
            </Button>
          </>
        )}
        {stale && <p className="subtle small">The game changed after this proposal (base v{proposal.baseVersionNumber}). Ask again to propose against the latest version.</p>}
        {proposal.status === 'applied' && (
          <>
            <Pill tone="success">Applied → v{proposal.resultVersionNumber}</Pill>
            {proposal.resultVersionId === currentVersionId && (
              <Button size="sm" variant="ghost" icon={<Undo2 size={14} aria-hidden="true" />} loading={action.isPending} onClick={() => run('undo')}>
                Undo
              </Button>
            )}
          </>
        )}
        {proposal.status === 'rejected' && <Pill tone="neutral">Rejected</Pill>}
        {proposal.status === 'undone' && (
          <Pill tone="neutral">
            <RotateCcw size={12} aria-hidden="true" /> Undone
          </Pill>
        )}
        {proposal.status === 'stale' && <Pill tone="warning">Stale — the game changed</Pill>}
        {proposal.status === 'failed' && <Pill tone="danger">Nothing applicable</Pill>}
      </footer>
    </article>
  );
}
