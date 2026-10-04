import { useEffect, useMemo, useState } from 'react';
import { EyeOff, History, ImageOff, Lock, LockOpen, MessageSquareText, Pencil, RotateCcw, Sigma, Star, TriangleAlert } from 'lucide-react';
import { effectiveSlideText, type ReviewStatus, type SourceDocument, type SourceSlide } from '@shared/schemas/source.ts';
import type { AnalysisRecord } from '@shared/schemas/records.ts';
import { useAssets, useRevertSlideChange, useSlideHistory, useUpdateSlide } from '../../../lib/queries.ts';
import { useSaveStatus } from '../../../lib/saveStatus.tsx';
import { errorMessage } from '../../../lib/api.ts';
import { formatDate } from '../../../lib/format.ts';
import { Button, Field, Segmented, Select, Switch, TextArea, TextInput } from '../../../components/ui/controls.tsx';
import { Banner, OriginBadge, Pill } from '../../../components/ui/feedback.tsx';
import { useToast } from '../../../components/ui/overlay.tsx';
import { ExtractedView } from '../../../components/source/ExtractedView.tsx';
import { PdfPage } from '../../../components/source/PdfPage.tsx';

const REVIEW_LABEL: Record<ReviewStatus, string> = { verified: 'Verified by creator', needs_review: 'Needs review', missing_visual: 'Missing visual reference' };

function EditForm({ slide, onDone }: { slide: SourceSlide; onDone: () => void }) {
  const update = useUpdateSlide(slide.projectId);
  const { track } = useSaveStatus();
  const toast = useToast();
  const text = effectiveSlideText(slide);
  const [title, setTitle] = useState(text.title);
  const [blocks, setBlocks] = useState<Record<string, string>>(() => Object.fromEntries(text.blocks.map((b) => [b.id, b.paragraphs.join('\n')])));
  const [notes, setNotes] = useState(text.notes.join('\n'));
  const save = () =>
    track(() =>
      update.mutateAsync({
        slideId: slide.id,
        revision: slide.revision,
        patch: {
          title,
          blocks: Object.fromEntries(Object.entries(blocks).map(([id, v]) => [id, v.split('\n').map((l) => l.trim()).filter(Boolean)])),
          notes: notes.split('\n').map((l) => l.trim()).filter(Boolean),
        },
      }),
    )
      .then((r) => {
        onDone();
        if (r.sourceChanged) toast({ tone: 'info', title: 'Slide text updated', detail: 'Analyses and blueprints that used the old text are now marked stale.' });
      })
      .catch((e) => toast({ tone: 'error', title: 'Not saved', detail: errorMessage(e).message }));
  return (
    <div className="edit-form stack">
      <Banner tone="info">Corrections are layered over the original extraction, which is kept. Every change is recorded in the slide history.</Banner>
      <Field label="Title" htmlFor="ed-title">
        <TextInput id="ed-title" value={title} maxLength={300} onChange={(e) => setTitle(e.target.value)} />
      </Field>
      {slide.extract.blocks
        .filter((b) => b.role !== 'title')
        .map((b, i) => (
          <Field key={b.id} label={`${b.role === 'smartart' ? 'SmartArt text' : 'Text box'} ${i + 1}`} htmlFor={`ed-${b.id}`} help="One paragraph per line.">
            <TextArea id={`ed-${b.id}`} rows={Math.min(8, Math.max(2, (blocks[b.id] ?? '').split('\n').length + 1))} value={blocks[b.id] ?? ''} onChange={(e) => setBlocks((prev) => ({ ...prev, [b.id]: e.target.value }))} />
          </Field>
        ))}
      <Field label="Speaker notes" htmlFor="ed-notes" help="One paragraph per line.">
        <TextArea id="ed-notes" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
      <div className="row">
        <Button variant="primary" loading={update.isPending} onClick={() => void save()}>
          Save corrections
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function SlideHistory({ slide }: { slide: SourceSlide }) {
  const history = useSlideHistory(slide.id);
  const revert = useRevertSlideChange(slide.projectId);
  const toast = useToast();
  const list = history.data ?? [];
  if (list.length === 0) return <p className="subtle small">No changes yet — this slide shows the original extraction.</p>;
  const show = (v: unknown) => (Array.isArray(v) ? v.join(' / ') : typeof v === 'object' && v ? JSON.stringify(v) : String(v ?? '—'));
  return (
    <ol className="history-list">
      {list.map((c) => (
        <li key={c.id}>
          <div className="row">
            <strong className="small">{c.field.startsWith('block:') ? 'Text box' : c.field}</strong>
            <span className="subtle small">{formatDate(c.createdAt)}</span>
            <span className="spacer" />
            <Button
              size="sm"
              variant="ghost"
              icon={<RotateCcw size={13} aria-hidden="true" />}
              onClick={() => revert.mutate(c.id, { onError: (e) => toast({ tone: 'error', title: 'Could not revert', detail: errorMessage(e).message }) })}
            >
              Revert
            </Button>
          </div>
          <p className="small subtle truncate">
            {show(c.before)} → {show(c.after)}
          </p>
        </li>
      ))}
    </ol>
  );
}

function VisualReference({ slide, documents, aspect }: { slide: SourceSlide; documents: SourceDocument[]; aspect: number }) {
  const update = useUpdateSlide(slide.projectId);
  const assets = useAssets(slide.projectId);
  const toast = useToast();
  const pdfs = documents.filter((d) => d.kind === 'pdf' && d.status === 'ready');
  const ref = slide.visualRef;
  const set = (visualRef: SourceSlide['visualRef'], extra: { reviewStatus?: ReviewStatus } = {}) =>
    update.mutate({ slideId: slide.id, revision: null, patch: { visualRef, ...extra } }, { onError: (e) => toast({ tone: 'error', title: 'Not saved', detail: errorMessage(e).message }) });
  const images = (assets.data ?? []).filter((a) => a.kind === 'image');
  return (
    <div className="visual-ref stack">
      {ref && (ref.kind === 'pdf-page' || ref.kind === 'render') && ref.documentId && ref.pageNumber ? (
        <>
          <div className="row">
            <Pill tone={ref.mapping === 'suggested' ? 'warning' : 'success'}>
              {ref.mapping === 'suggested' ? 'Suggested by text match — not verified' : ref.mapping === 'exact' ? 'Rendered from this deck' : 'Verified by creator'}
            </Pill>
            <span className="subtle small">Page {ref.pageNumber}</span>
          </div>
          <div style={{ aspectRatio: `${aspect}` }} className="visual-frame">
            <PdfPage docId={ref.documentId} pageNumber={ref.pageNumber} label={`Reference page ${ref.pageNumber} for slide ${slide.slideNumber}`} />
          </div>
          <div className="row-wrap">
            {ref.mapping === 'suggested' && (
              <Button size="sm" variant="primary" onClick={() => set({ ...ref, mapping: 'verified' }, slide.reviewStatus === 'missing_visual' ? { reviewStatus: 'needs_review' } : {})}>
                Confirm this page matches
              </Button>
            )}
            <label className="row small">
              Page
              <TextInput
                compact
                type="number"
                min={1}
                aria-label="Reference page number"
                style={{ width: 80 }}
                defaultValue={ref.pageNumber}
                onBlur={(e) => {
                  const n = Number(e.target.value);
                  if (n >= 1 && n !== ref.pageNumber) set({ ...ref, pageNumber: n, mapping: 'verified' });
                }}
              />
            </label>
            <Button size="sm" variant="ghost" onClick={() => set(null)}>
              Clear
            </Button>
          </div>
        </>
      ) : ref?.kind === 'image' && ref.assetId ? (
        <>
          <Pill tone="success">Image chosen by creator</Pill>
          <img className="visual-image checker" src={`/api/assets/${ref.assetId}/file?variant=display`} alt={`Visual reference for slide ${slide.slideNumber}`} />
          <Button size="sm" variant="ghost" onClick={() => set(null)}>
            Clear
          </Button>
        </>
      ) : (
        <p className="subtle small">
          <ImageOff size={14} aria-hidden="true" /> No visual reference. Without one, nobody — including Claude — can see diagrams on this slide.
        </p>
      )}
      <div className="row-wrap">
        {pdfs.length > 0 && !ref && (
          <Button size="sm" onClick={() => set({ kind: 'pdf-page', documentId: pdfs[0]!.id, pageNumber: slide.slideNumber, assetId: null, mapping: 'suggested' })}>
            Use PDF page {slide.slideNumber} (verify)
          </Button>
        )}
        {images.length > 0 && (
          <Select aria-label="Use an image from the library as visual reference" value="" onChange={(e) => e.target.value && set({ kind: 'image', documentId: null, pageNumber: null, assetId: e.target.value, mapping: 'verified' })}>
            <option value="">Use an image from the library…</option>
            {images.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        )}
      </div>
    </div>
  );
}

function Interpretation({ slide, analysis }: { slide: SourceSlide; analysis: AnalysisRecord | null | undefined }) {
  if (!analysis) {
    return <p className="subtle small">No learning map yet. After analysis, Claude’s proposed objectives, concepts and activities for this slide appear here — labelled as proposals, not quotations.</p>;
  }
  const a = analysis.analysis;
  const has = (ids: string[]) => ids.includes(slide.id);
  const objectives = a.objectives.filter((o) => has(o.sourceSlideIds));
  const concepts = a.concepts.filter((c) => has(c.sourceSlideIds));
  const examples = a.examples.filter((e) => has(e.sourceSlideIds));
  const interactions = a.interactions.filter((i) => has(i.sourceSlideIds));
  const empty = objectives.length + concepts.length + examples.length + interactions.length === 0;
  return (
    <div className="interp stack">
      <div className="row">
        <OriginBadge origin={analysis.origin} model={analysis.model} />
        {analysis.stale && <Pill tone="warning">Stale</Pill>}
      </div>
      {empty && <p className="subtle small">The learning map does not reference this slide.</p>}
      {objectives.length > 0 && (
        <section>
          <h4 className="interp-h">Proposed objectives</h4>
          <ul className="interp-list">
            {objectives.map((o) => (
              <li key={o.id}>
                {o.text} {o.status === 'verified' ? <Pill tone="success">Verified by creator</Pill> : <Pill tone="ai">Proposed</Pill>}
              </li>
            ))}
          </ul>
        </section>
      )}
      {concepts.length > 0 && (
        <section>
          <h4 className="interp-h">Concepts</h4>
          <ul className="interp-list">
            {concepts.map((c) => (
              <li key={c.id}>
                <strong>{c.name}</strong> — {c.description}
              </li>
            ))}
          </ul>
        </section>
      )}
      {examples.length > 0 && (
        <section>
          <h4 className="interp-h">Examples</h4>
          <ul className="interp-list">
            {examples.map((e) => (
              <li key={e.id}>
                {e.text} {e.required && <Pill tone="info">Required</Pill>}
              </li>
            ))}
          </ul>
        </section>
      )}
      {interactions.length > 0 && (
        <section>
          <h4 className="interp-h">Possible interactions</h4>
          <ul className="interp-list">
            {interactions.map((i) => (
              <li key={i.id}>{i.description}</li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

export function SlideDetail({ slide, documents, analysis }: { slide: SourceSlide; documents: SourceDocument[]; analysis: AnalysisRecord | null | undefined }) {
  const update = useUpdateSlide(slide.projectId);
  const { track } = useSaveStatus();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [view, setView] = useState<'extracted' | 'visual'>('extracted');
  const [showHistory, setShowHistory] = useState(false);
  useEffect(() => {
    setEditing(false);
    setView(slide.visualRef && slide.visualRef.mapping !== 'suggested' ? 'visual' : 'extracted');
  }, [slide.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const primary = documents.find((d) => d.id === slide.documentId);
  const aspect = primary?.slideSize ? primary.slideSize.cx / primary.slideSize.cy : 16 / 9;
  const text = effectiveSlideText(slide);
  const patch = (p: Parameters<typeof update.mutate>[0]['patch'], label: string) =>
    void track(() => update.mutateAsync({ slideId: slide.id, revision: slide.revision, patch: p })).catch((e) => toast({ tone: 'error', title: `${label} not saved`, detail: errorMessage(e).message }));
  const edited = text.titleEdited || text.notesEdited || text.blocks.some((b) => b.edited);
  const warnings = slide.extract.warnings;
  const statusOptions = useMemo(
    () => (['needs_review', 'verified', 'missing_visual'] as ReviewStatus[]).map((s) => ({ value: s, label: REVIEW_LABEL[s] })),
    [],
  );

  return (
    <article className="slide-detail" aria-labelledby="slide-heading">
      <header className="slide-head">
        <div className="slide-head-main">
          <p className="eyebrow">
            Slide {slide.slideNumber}
            {slide.extract.layoutName ? ` · ${slide.extract.layoutName}` : ''}
          </p>
          <h1 id="slide-heading">{text.title || <span className="subtle">No title placeholder</span>}</h1>
          <div className="row-wrap">
            {slide.hidden && (
              <Pill tone="neutral">
                <EyeOff size={12} aria-hidden="true" /> Hidden in the deck
              </Pill>
            )}
            {!slide.included && <Pill tone="neutral">Excluded from generation</Pill>}
            {edited && <Pill tone="info">Corrected by creator</Pill>}
            {slide.lockedWording && <Pill tone="info">Wording locked</Pill>}
            {slide.requiredExample && <Pill tone="info">Required example</Pill>}
          </div>
        </div>
        <div className="slide-head-actions">
          <Switch label="Include in game" checked={slide.included} onChange={(v) => patch({ included: v }, 'Inclusion')} />
        </div>
      </header>

      <div className="review-status-row">
        <span className="field-label">Review status</span>
        <Segmented label="Review status" value={slide.reviewStatus} options={statusOptions} onChange={(v) => patch({ reviewStatus: v }, 'Review status')} />
      </div>

      {warnings.length > 0 && (
        <ul className="warning-list" aria-label="Extraction warnings">
          {warnings.map((w) => (
            <li key={w.code} className={`warn-${w.severity}`}>
              <TriangleAlert size={14} aria-hidden="true" />
              <span>{w.message}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="slide-columns">
        <section className="slide-col" aria-labelledby="src-h">
          <div className="section-head">
            <h2 id="src-h" className="h-sub">
              Source content
            </h2>
            <Segmented
              label="Slide view"
              value={view}
              onChange={setView}
              options={[
                { value: 'extracted', label: 'Extracted view' },
                { value: 'visual', label: 'Visual reference' },
              ]}
            />
          </div>
          {view === 'extracted' ? <ExtractedView slide={slide} aspect={aspect} /> : <VisualReference slide={slide} documents={documents} aspect={aspect} />}

          {editing ? (
            <EditForm slide={slide} onDone={() => setEditing(false)} />
          ) : (
            <div className="source-text stack">
              <div className="row">
                <h3 className="h-sub-sm">Text in reading order</h3>
                <span className="spacer" />
                <Button size="sm" icon={<Pencil size={14} aria-hidden="true" />} onClick={() => setEditing(true)}>
                  Correct text
                </Button>
              </div>
              {text.blocks.filter((b) => b.role !== 'title').length === 0 && <p className="subtle small">No body text was found.</p>}
              {text.blocks
                .filter((b) => b.role !== 'title')
                .map((b) => (
                  <div key={b.id} className={`text-block${b.edited ? ' is-edited' : ''}`}>
                    {b.edited && <span className="edited-tag">Corrected</span>}
                    {b.role === 'smartart' && <span className="edited-tag">SmartArt text</span>}
                    <ul>
                      {b.paragraphs.map((p, i) => (
                        <li key={i}>{p}</li>
                      ))}
                    </ul>
                  </div>
                ))}
              {slide.extract.tables.map((t) => (
                <div key={t.id} className="table-wrap">
                  <table className="table">
                    <tbody>
                      {t.rows.map((r, i) => (
                        <tr key={i}>
                          {r.map((c, j) => (i === 0 ? <th key={j}>{c}</th> : <td key={j}>{c}</td>))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
              {slide.extract.equations.map((eq) => (
                <details key={eq.id} className="equation">
                  <summary>
                    <Sigma size={14} aria-hidden="true" /> <span className="mono">{eq.linear}</span>
                  </summary>
                  <p className="subtle small">Linear text is an approximation. The original Office Math source is preserved:</p>
                  <pre className="omml">{eq.omml}</pre>
                </details>
              ))}
              {slide.extract.images.length > 0 && (
                <div className="thumb-row">
                  {slide.extract.images.map((img) =>
                    img.assetId ? (
                      <img key={img.id} className="thumb checker" src={`/api/assets/${img.assetId}/file?variant=thumb`} alt={img.altText || 'Slide image (no description in the deck)'} />
                    ) : (
                      <span key={img.id} className="thumb thumb-missing" title={img.contentType}>
                        Not imported
                      </span>
                    ),
                  )}
                </div>
              )}
              <div className="notes">
                <h3 className="h-sub-sm">
                  <MessageSquareText size={14} aria-hidden="true" /> Speaker notes {text.notesEdited && <span className="edited-tag">Corrected</span>}
                </h3>
                {text.notes.length ? (
                  text.notes.map((n, i) => <p key={i}>{n}</p>)
                ) : (
                  <p className="subtle small">No speaker notes.</p>
                )}
              </div>
            </div>
          )}

          <div className="row-wrap">
            <Button size="sm" icon={slide.lockedWording ? <Lock size={14} aria-hidden="true" /> : <LockOpen size={14} aria-hidden="true" />} onClick={() => patch({ lockedWording: !slide.lockedWording }, 'Lock')}>
              {slide.lockedWording ? 'Unlock wording' : 'Lock wording'}
            </Button>
            <Button size="sm" icon={<Star size={14} aria-hidden="true" />} onClick={() => patch({ requiredExample: !slide.requiredExample }, 'Required example')}>
              {slide.requiredExample ? 'Not a required example' : 'Mark as required example'}
            </Button>
            <Button size="sm" variant="ghost" icon={<History size={14} aria-hidden="true" />} aria-expanded={showHistory} onClick={() => setShowHistory((s) => !s)}>
              History
            </Button>
          </div>
          {showHistory && <SlideHistory slide={slide} />}
        </section>

        <section className="slide-col interp-col" aria-labelledby="interp-h">
          <h2 id="interp-h" className="h-sub">
            Learning interpretation
          </h2>
          <Interpretation slide={slide} analysis={analysis} />
        </section>
      </div>
    </article>
  );
}
