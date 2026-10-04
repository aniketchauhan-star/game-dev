import { useState } from 'react';
import { ArrowRight, Calculator, FlaskConical, Pencil, Sparkles } from 'lucide-react';
import type { GameBrief } from '@shared/schemas/brief.ts';
import type { CreateStep, ProjectDetail } from '@shared/schemas/project.ts';
import { MECHANICS } from '@shared/registry.ts';
import { THEME_PRESETS, findPalette } from '@shared/themes.ts';
import { useRouter } from '../../lib/router.tsx';
import { useAiPreview, useSlides, useStartJob } from '../../lib/queries.ts';
import { errorMessage, newIdempotencyKey } from '../../lib/api.ts';
import { useJobsContext } from '../../lib/jobs.tsx';
import { formatTokens } from '../../lib/format.ts';
import { Button, Checkbox, Switch } from '../../components/ui/controls.tsx';
import { Banner, DemoBadge, Pill } from '../../components/ui/feedback.tsx';
import { ThemeArt } from '../../components/themes/ThemeArt.tsx';

export function ReviewStep({
  project,
  brief,
  update,
  flush,
  gaps,
  goTo,
}: {
  project: ProjectDetail;
  brief: GameBrief;
  update: (fn: (b: GameBrief) => GameBrief) => void;
  flush: () => Promise<void>;
  gaps: string[];
  goTo: (s: CreateStep) => void;
}) {
  const { navigate } = useRouter();
  const { track } = useJobsContext();
  const slides = useSlides(project.id);
  const [countTokens, setCountTokens] = useState(false);
  const preview = useAiPreview(project.id, countTokens);
  const start = useStartJob(project.id);
  const [key] = useState(newIdempotencyKey);
  const [error, setError] = useState<{ message: string; hint: string | null } | null>(null);
  const list = slides.data?.slides ?? [];
  const included = list.filter((s) => s.included);
  const needsReview = list.filter((s) => s.included && s.reviewStatus !== 'verified').length;
  const missingVisual = list.filter((s) => s.included && s.reviewStatus === 'missing_visual').length;
  const claude = preview.data?.claude;
  const mode = claude?.keyPresent ? (claude.state === 'configured' ? 'live' : 'unverified') : project.isSample ? 'demo' : 'none';
  const visualCandidates = list.filter((s) => s.included && s.visualRef && s.visualRef.mapping !== 'suggested');
  const setAi = <K extends keyof GameBrief['aiInputs']>(k: K, v: GameBrief['aiInputs'][K]) => update((b) => ({ ...b, aiInputs: { ...b.aiInputs, [k]: v } }));
  const mech = brief.mechanic ? MECHANICS[brief.mechanic] : null;
  const theme = THEME_PRESETS[brief.visual.themeId];

  const analyze = async () => {
    setError(null);
    await flush();
    start.mutate(
      { type: 'analyze', key },
      {
        onSuccess: (r) => {
          track(r.job);
          navigate(`/p/${project.id}/source?view=map`);
        },
        onError: (e) => setError(errorMessage(e)),
      },
    );
  };

  return (
    <div className="create-step">
      <header className="create-step-head">
        <h1>Review before analysis</h1>
        <p className="muted">Nothing has been sent to Claude yet. Check the summary and exactly what will be shared, then start the analysis yourself.</p>
      </header>

      <div className="review-grid">
        <section className="panel panel-pad review-card" aria-labelledby="rv-source">
          <div className="section-head">
            <h2 id="rv-source" className="h-sub">
              Source
            </h2>
            <Button size="sm" variant="ghost" icon={<Pencil size={14} aria-hidden="true" />} onClick={() => goTo('source')}>
              Edit
            </Button>
          </div>
          <dl className="kv">
            <dt>Deck</dt>
            <dd className="truncate">{project.documents.find((d) => d.kind === 'pptx')?.originalName ?? '—'}</dd>
            <dt>Slides</dt>
            <dd>
              {included.length} included · {list.length - included.length} excluded
            </dd>
            <dt>To review</dt>
            <dd>
              {needsReview} not yet verified{missingVisual ? ` · ${missingVisual} missing a visual reference` : ''}
            </dd>
          </dl>
        </section>
        <section className="panel panel-pad review-card" aria-labelledby="rv-game">
          <div className="section-head">
            <h2 id="rv-game" className="h-sub">
              Game
            </h2>
            <Button size="sm" variant="ghost" icon={<Pencil size={14} aria-hidden="true" />} onClick={() => goTo('brief')}>
              Edit
            </Button>
          </div>
          <dl className="kv">
            <dt>Title</dt>
            <dd>{brief.title || '—'}</dd>
            <dt>Audience</dt>
            <dd>{[brief.gradeOrAge, brief.subject].filter(Boolean).join(' · ') || '—'}</dd>
            <dt>Mechanic</dt>
            <dd>
              {mech ? mech.label : '—'} {mech && !mech.buildable && <Pill tone="warning">Blueprint only</Pill>}
            </dd>
            <dt>Duration</dt>
            <dd>{brief.durationMinutes ? `${brief.durationMinutes} min` : '—'}</dd>
          </dl>
        </section>
        <section className="panel panel-pad review-card" aria-labelledby="rv-visual">
          <div className="section-head">
            <h2 id="rv-visual" className="h-sub">
              Visual direction
            </h2>
            <Button size="sm" variant="ghost" icon={<Pencil size={14} aria-hidden="true" />} onClick={() => goTo('visual')}>
              Edit
            </Button>
          </div>
          <div className="review-theme">
            <ThemeArt themeId={brief.visual.themeId} paletteId={brief.visual.paletteId} />
            <div>
              <strong>{theme.label}</strong>
              <p className="muted small">{findPalette(brief.visual.themeId, brief.visual.paletteId).label} palette · 1920×1080</p>
            </div>
          </div>
        </section>
        <section className="panel panel-pad review-card" aria-labelledby="rv-constraints">
          <h2 id="rv-constraints" className="h-sub">
            Constraints
          </h2>
          <ul className="tag-list">
            <li>{brief.options.minimalText ? 'Minimal text' : 'Normal text'}</li>
            <li>{brief.options.preserveSequence ? 'Preserve source order' : 'Order may change'}</li>
            <li>{brief.options.reuseArtwork ? 'Reuse supplied artwork' : 'Artwork may change'}</li>
            <li>{brief.options.allowAddedPractice ? 'Added practice allowed' : 'No added practice'}</li>
            {brief.options.reducedMotion && <li>Reduced motion</li>}
            {brief.optional.constraints && <li>{brief.optional.constraints}</li>}
          </ul>
        </section>
      </div>

      {(gaps.length > 0 || needsReview > 0) && (
        <Banner tone="info" title="Unresolved questions">
          <ul className="plain-list">
            {gaps.map((g) => (
              <li key={g}>{g}</li>
            ))}
            {needsReview > 0 && <li>{needsReview} included slide(s) are not yet verified in Source review. You can analyze now and verify while Claude works.</li>}
          </ul>
        </Banner>
      )}

      <section className="panel panel-pad disclosure" aria-labelledby="send-title">
        <div className="section-head">
          <h2 id="send-title" className="h-sub">
            What will be sent to Claude
          </h2>
          {mode === 'live' && (
            <Button size="sm" icon={<Calculator size={14} aria-hidden="true" />} loading={countTokens && preview.isFetching} onClick={() => setCountTokens(true)}>
              Count tokens
            </Button>
          )}
        </div>
        <p className="muted small">
          Text of the {included.length} included slides (titles, body text, tables, equation text and image descriptions){brief.aiInputs.includeSpeakerNotes ? ', including speaker notes' : ''}, plus your brief. Hidden and excluded slides are not sent. No files, API keys or other projects are sent.
        </p>
        <div className="disclosure-controls">
          <Switch label="Include speaker notes" hint="Notes often explain the teaching intent. Turn off if they contain private remarks." checked={brief.aiInputs.includeSpeakerNotes} onChange={(v) => setAi('includeSpeakerNotes', v)} />
          <Switch
            label="Send visual references"
            hint={visualCandidates.length ? `${visualCandidates.length} slide(s) have a verified page or image.` : 'No verified slide images yet (add a PDF export and verify matches in Source review).'}
            checked={brief.aiInputs.sendVisualReferences}
            disabled={visualCandidates.length === 0}
            onChange={(v) => setAi('sendVisualReferences', v)}
          />
        </div>
        {brief.aiInputs.sendVisualReferences && visualCandidates.length > 0 && (
          <fieldset className="visual-auth">
            <legend className="field-label">Authorize images per slide</legend>
            {visualCandidates.map((s) => (
              <Checkbox
                key={s.id}
                label={`Slide ${s.slideNumber}: ${s.extract.title || 'untitled'}`}
                hint={s.visualRef?.kind === 'image' ? 'Image you assigned' : `PDF page ${s.visualRef?.pageNumber} (${s.visualRef?.mapping})`}
                checked={brief.aiInputs.authorizedVisualSlideIds.includes(s.id)}
                onChange={(v) =>
                  setAi(
                    'authorizedVisualSlideIds',
                    v ? [...brief.aiInputs.authorizedVisualSlideIds, s.id] : brief.aiInputs.authorizedVisualSlideIds.filter((x) => x !== s.id),
                  )
                }
              />
            ))}
          </fieldset>
        )}
        <div className="send-table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Slide</th>
                <th scope="col">Title</th>
                <th scope="col">Sent</th>
                <th scope="col" className="tabular">
                  Characters
                </th>
              </tr>
            </thead>
            <tbody>
              {(preview.data?.slides ?? []).map((s) => (
                <tr key={s.slideId}>
                  <td className="tabular">{s.slideNumber}</td>
                  <td className="truncate">{s.title || <span className="subtle">(no title)</span>}</td>
                  <td>{s.included ? (s.notesIncluded ? 'Text + notes' : 'Text') : <span className="subtle">{s.hidden ? 'Hidden — not sent' : 'Excluded — not sent'}</span>}</td>
                  <td className="tabular">{s.included ? s.characters.toLocaleString() : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="small muted tabular">
          Total {preview.data?.totalCharacters.toLocaleString() ?? '—'} characters
          {preview.data?.tokenCount !== null && preview.data?.tokenCount !== undefined && ` · ${formatTokens(preview.data.tokenCount)} input tokens counted by the API (slides only; the brief and instructions add a little more)`}
          {preview.data?.tokenNote && ` · Token count unavailable: ${preview.data.tokenNote}`}
        </p>
        {preview.data?.sample && (
          <details>
            <summary className="small">Show exactly how slide text is sent (first slide)</summary>
            <pre className="send-sample">{preview.data.sample}</pre>
          </details>
        )}
      </section>

      <section className="analyze-bar panel" aria-label="Start analysis">
        {mode === 'live' && (
          <>
            <div>
              <p className="banner-title">Ready to analyze</p>
              <p className="muted small">
                Uses <strong>{claude?.model}</strong>. Claude proposes a learning map you review before any blueprint. Token usage is recorded in Settings → Usage.
              </p>
            </div>
            <Button variant="primary" size="lg" icon={<Sparkles size={18} aria-hidden="true" />} loading={start.isPending} disabled={included.length === 0} onClick={() => void analyze()}>
              Analyze with Claude
            </Button>
          </>
        )}
        {mode === 'demo' && (
          <>
            <div>
              <div className="row">
                <p className="banner-title">Claude is not configured</p>
                <DemoBadge />
              </div>
              <p className="muted small">This bundled sample can replay its prepared learning map. It is clearly labelled demo content — no Claude call is made.</p>
            </div>
            <Button variant="primary" size="lg" icon={<FlaskConical size={18} aria-hidden="true" />} loading={start.isPending} onClick={() => void analyze()}>
              Run demo analysis
            </Button>
          </>
        )}
        {(mode === 'none' || mode === 'unverified') && (
          <>
            <div>
              <p className="banner-title">{mode === 'none' ? 'Claude is not configured' : `Model ${claude?.model ?? ''} is not verified yet`}</p>
              <p className="muted small">
                {mode === 'none'
                  ? 'Add ANTHROPIC_API_KEY to the server environment to analyze decks. You can still review slides and author a blueprint yourself.'
                  : 'Open Settings → Claude and run “Test connection” to verify the model before analysis.'}
              </p>
            </div>
            <div className="row">
              <Button onClick={() => navigate('/settings')}>Open Settings</Button>
              <Button variant="primary" onClick={() => navigate(`/p/${project.id}/source`)}>
                Continue without Claude <ArrowRight size={16} aria-hidden="true" />
              </Button>
            </div>
          </>
        )}
      </section>
      {error && (
        <Banner tone="danger" title={error.message}>
          {error.hint}
        </Banner>
      )}
    </div>
  );
}
