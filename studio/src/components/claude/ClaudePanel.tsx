import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Crosshair, FolderKanban, Send, Settings, Sparkles, Square } from 'lucide-react';
import type { ChatMessage, ChatScope } from '@shared/schemas/records.ts';
import { useRouter } from '../../lib/router.tsx';
import { useChat, useHealth, useJobAction, useProject, useSendChat, useSlides } from '../../lib/queries.ts';
import { useJobsContext, useProjectJobs, useTrackedJob } from '../../lib/jobs.tsx';
import { errorMessage } from '../../lib/api.ts';
import { formatTime } from '../../lib/format.ts';
import { Button, IconButton, TextArea } from '../ui/controls.tsx';
import { Banner, DemoBadge, OriginBadge } from '../ui/feedback.tsx';
import { JobActivity } from '../JobActivity.tsx';
import { ProposalCard } from './ProposalCard.tsx';
import { SourceChips } from '../SourceChips.tsx';

export interface ScopeOption {
  scope: ChatScope;
  label: string;
}

function StreamingText({ jobId, fallback }: { jobId: string | null; fallback: string }) {
  const tracked = useTrackedJob(jobId);
  const text = tracked?.text || fallback;
  return <p className="msg-text">{text || <span className="subtle">Thinking…</span>}</p>;
}

function Message({ m, projectId, currentVersionId, proposals }: { m: ChatMessage; projectId: string; currentVersionId: string | null; proposals: Map<string, import('@shared/schemas/records.ts').Proposal> }) {
  const slides = useSlides(projectId);
  if (m.role === 'system') {
    return (
      <li className="msg msg-system">
        <p>{m.text}</p>
      </li>
    );
  }
  const proposal = m.proposalId ? proposals.get(m.proposalId) : undefined;
  const scopeLabel = m.scope.kind === 'project' ? 'Whole project' : m.scope.kind === 'scene' ? 'Selected scene' : 'Selected slide';
  return (
    <li className={`msg msg-${m.role}`}>
      <div className="msg-meta">
        {m.role === 'creator' ? <span className="msg-author">You</span> : <OriginBadge origin={m.origin === 'demo' ? 'demo' : 'claude'} />}
        <span className="chip">{scopeLabel}</span>
        {m.scope.kind === 'slide' && m.scope.slideId && <SourceChips projectId={projectId} slideIds={[m.scope.slideId]} slides={slides.data?.slides ?? []} />}
        <span className="spacer" />
        <time className="subtle small" dateTime={m.createdAt}>
          {formatTime(m.createdAt)}
        </time>
      </div>
      {m.status === 'streaming' ? <StreamingText jobId={m.jobId} fallback={m.text} /> : <p className="msg-text">{m.text}</p>}
      {m.status === 'failed' && <p className="msg-failed small">This request did not complete. Nothing was changed.</p>}
      {proposal && <ProposalCard proposal={proposal} projectId={projectId} currentVersionId={currentVersionId} />}
    </li>
  );
}

const SWITCH_LABEL = { project: 'Use whole project', slide: 'Use selected slide', scene: 'Use selected scene' } as const;

export function ClaudePanel({
  projectId,
  area,
  mode,
  scopes,
  examples,
  actions,
  baseVersionId,
  emptyHint,
}: {
  projectId: string;
  area: ChatMessage['area'];
  mode: 'ask' | 'refine';
  scopes: ScopeOption[];
  examples: string[];
  actions?: ReactNode;
  baseVersionId?: string | null;
  emptyHint?: string;
}) {
  const { navigate } = useRouter();
  const health = useHealth();
  const project = useProject(projectId);
  const chat = useChat(projectId);
  const send = useSendChat(projectId);
  const jobAction = useJobAction(projectId);
  const { track } = useJobsContext();
  const projectJobs = useProjectJobs(projectId);
  const [scopeIndex, setScopeIndex] = useState(0);
  const [text, setText] = useState('');
  const [error, setError] = useState<{ message: string; hint: string | null } | null>(null);
  const listRef = useRef<HTMLOListElement>(null);
  useEffect(() => setScopeIndex(0), [scopes.length, scopes[0]?.label]);
  const scope = scopes[Math.min(scopeIndex, scopes.length - 1)] ?? { scope: { kind: 'project', sceneId: null, slideId: null }, label: 'Whole project' };

  const claude = health.data?.claude;
  const isSample = project.data?.isSample ?? false;
  const live = claude?.state === 'configured';
  const demo = !claude?.keyPresent && isSample;
  const canSend = live || demo;
  const messages = chat.data?.messages ?? [];
  const proposals = useMemo(() => new Map((chat.data?.proposals ?? []).map((p) => [p.id, p])), [chat.data?.proposals]);
  const chatJob = projectJobs.find((t) => (t.job.type === 'refine' || t.job.type === 'ask') && (t.job.status === 'queued' || t.job.status === 'running'));
  const otherJobs = projectJobs.filter((t) => t.job.type !== 'refine' && t.job.type !== 'ask').slice(0, 2);

  useEffect(() => {
    listRef.current?.lastElementChild?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }, [messages.length, chatJob?.text.length]);

  const submit = () => {
    const t = text.trim();
    if (!t || !canSend) return;
    setError(null);
    send.mutate(
      { text: t, mode, scope: scope.scope, area, baseVersionId: mode === 'refine' ? (baseVersionId ?? null) : null },
      {
        onSuccess: (r) => {
          track(r.job);
          if (r.deduplicated) setError({ message: 'Claude is still working on your previous request.', hint: 'Wait for it to finish, or stop it first.' });
          else setText('');
        },
        onError: (e) => setError(errorMessage(e)),
      },
    );
  };

  const status = live ? (
    <span className="claude-status is-live" title={`Model ${claude?.model}`}>
      <span className="dot" aria-hidden="true" /> Live · {claude?.model}
    </span>
  ) : demo ? (
    <DemoBadge />
  ) : (
    <button type="button" className="claude-status is-off" onClick={() => navigate('/settings')}>
      <Settings size={13} aria-hidden="true" /> {!claude?.keyPresent ? 'Not configured' : claude.state === 'connection_failed' ? 'Connection failed' : 'Model not verified'}
    </button>
  );

  return (
    <div className="claude-panel">
      <header className="panel-head claude-head">
        <Sparkles size={18} className="claude-glyph" aria-hidden="true" />
        <h2>Claude</h2>
        {status}
      </header>
      <div className="claude-scope">
        <span className="chip chip-scope" aria-live="polite" title={scope.label}>
          {scope.scope.kind === 'project' ? <FolderKanban size={13} aria-hidden="true" /> : <Crosshair size={13} aria-hidden="true" />}
          <span className="truncate">{scope.label}</span>
        </span>
        {scopes.length > 1 && (
          <Button size="sm" variant="ghost" onClick={() => setScopeIndex((i) => (i + 1) % scopes.length)}>
            {SWITCH_LABEL[scopes[(scopeIndex + 1) % scopes.length]!.scope.kind]}
          </Button>
        )}
      </div>
      {actions && <div className="claude-actions">{actions}</div>}
      <div className="claude-body">
        {otherJobs.map((t) => (
          <JobActivity key={t.job.id} job={t.job} compact />
        ))}
        {messages.length === 0 ? (
          <div className="claude-empty">
            <p className="muted small">{emptyHint ?? (mode === 'refine' ? 'Ask for a change to the selected scene or the whole game. Every change is shown before it is applied.' : 'Ask about the slides or the learning design.')}</p>
          </div>
        ) : (
          <ol className="msg-list" ref={listRef} aria-label="Conversation">
            {messages.map((m) => (
              <Message key={m.id} m={m} projectId={projectId} currentVersionId={project.data?.currentVersionId ?? null} proposals={proposals} />
            ))}
          </ol>
        )}
      </div>
      <footer className="composer">
        {error && (
          <Banner tone="warning" title={error.message}>
            {error.hint}
          </Banner>
        )}
        {!canSend && (
          <p className="composer-note small">
            {!claude?.keyPresent
              ? 'Claude is not configured. You can still edit everything by hand.'
              : claude.state === 'connection_failed'
                ? 'Claude could not be reached. Check the connection in Settings; you can still edit everything by hand.'
                : 'Verify the model in Settings to use Claude.'}{' '}
            <button type="button" className="link-btn" onClick={() => navigate('/settings')}>
              Settings
            </button>
          </p>
        )}
        {canSend && messages.length === 0 && (
          <div className="example-chips" aria-label="Example requests">
            {examples.map((ex) => (
              <button key={ex} type="button" className="chip" onClick={() => setText(ex)}>
                {ex}
              </button>
            ))}
          </div>
        )}
        <div className="composer-box">
          <TextArea
            aria-label={mode === 'refine' ? 'Describe a change for Claude' : 'Ask Claude'}
            placeholder={mode === 'refine' ? 'e.g. Make the grid and points easier to see' : 'Ask about this slide or lesson'}
            rows={2}
            maxLength={2000}
            value={text}
            disabled={!canSend}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
          />
          {chatJob ? (
            <IconButton label="Stop Claude" bordered onClick={() => jobAction.mutate({ jobId: chatJob.job.id, action: 'cancel' })}>
              <Square size={16} aria-hidden="true" />
            </IconButton>
          ) : (
            <IconButton label="Send" bordered disabled={!canSend || !text.trim() || send.isPending} onClick={submit}>
              <Send size={16} aria-hidden="true" />
            </IconButton>
          )}
        </div>
        <p className="subtle small composer-hint">
          Enter to send · Shift+Enter for a new line{mode === 'refine' ? ' · changes need your approval' : ''}
        </p>
      </footer>
    </div>
  );
}
