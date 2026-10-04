import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { EyeOff, FileText, Frame, GraduationCap, Image as ImageIcon, MessageSquareText, Pencil, Presentation, Shapes, TriangleAlert, X } from 'lucide-react';
import type { ProjectDetail } from '@shared/schemas/project.ts';
import { useAssets, useHealth, useJobs, useSlides } from '../../lib/queries.ts';
import { useDesign, useGrade } from '../../lib/studioQueries.ts';
import { useProjectJobs } from '../../lib/jobs.tsx';
import { formatBytes } from '../../lib/format.ts';
import { DeckUpload } from '../source/DeckUpload.tsx';
import { JobActivity } from '../JobActivity.tsx';
import { AssetUploader } from '../assets/AssetUploader.tsx';
import { Button } from '../ui/controls.tsx';
import { Banner, Pill } from '../ui/feedback.tsx';
import { DesignSources } from './DesignSources.tsx';
import { GradeProfileEditor, gradeSummary } from './GradeProfileEditor.tsx';

export type SetupCardId = 'design' | 'lesson' | 'assets' | 'grade';

/** The PowerPoint card editor: the existing validated .pptx pipeline (legacy .ppt warning included) plus an optional PDF reference. */
export function LessonSourcePanel({ project }: { project: ProjectDetail }) {
  const slides = useSlides(project.id);
  const jobs = useJobs(project.id);
  const health = useHealth();
  const primary = project.documents.find((d) => d.kind === 'pptx') ?? null;
  const pdf = project.documents.find((d) => d.kind === 'pdf' && d.role === 'reference') ?? null;
  const extractJob = (jobs.data ?? []).find((j) => j.type === 'extract_pptx');
  const liveExtract = useProjectJobs(project.id).find((t) => t.job.type === 'extract_pptx')?.job ?? extractJob;
  const primaryFailed = primary?.status === 'failed' || liveExtract?.status === 'failed';
  const pdfJob = (jobs.data ?? []).find((j) => j.type === 'extract_pdf');
  const list = slides.data?.slides ?? [];
  const stats = useMemo(
    () => ({
      total: list.length,
      hidden: list.filter((s) => s.hidden).length,
      notes: list.filter((s) => s.extract.notes.length > 0).length,
      images: list.reduce((n, s) => n + s.extract.images.length, 0),
      warnings: list.reduce((n, s) => n + s.extract.warnings.filter((w) => w.severity === 'warning').length, 0),
    }),
    [list],
  );
  const renderer = health.data?.renderer;
  return (
    <div className="stack">
      <p className="muted small">NEXUS reads the PowerPoint package itself — text, titles, speaker notes, tables, images and positions — in the deck’s own slide order. Nothing is sent to Claude at this step. PowerPoint supplies lesson content by default.</p>
      {!(list.length > 0 && primary) && <DeckUpload projectId={project.id} kind="pptx" existing={primary} existingFailed={primaryFailed} />}
      {extractJob && (extractJob.status !== 'succeeded' || list.length === 0) && <JobActivity job={extractJob} />}
      {primary && primary.status === 'failed' && (
        <Banner tone="danger" title="The deck could not be imported">
          {primary.error}
        </Banner>
      )}
      {list.length > 0 && primary && (
        <section className="panel panel-pad import-summary" aria-label="Import summary">
          <div className="row">
            <Presentation size={18} aria-hidden="true" />
            <strong className="truncate">{primary.originalName}</strong>
            <span className="subtle small">{formatBytes(primary.sizeBytes)}</span>
            {primary.role === 'bundled-sample' && <span className="pill pill-warning pill-nodot">Bundled example source</span>}
          </div>
          <ul className="stat-row">
            <li>
              <FileText size={16} aria-hidden="true" />
              <strong>{stats.total}</strong> {stats.total === 1 ? 'slide' : 'slides'}
            </li>
            <li>
              <EyeOff size={16} aria-hidden="true" />
              <strong>{stats.hidden}</strong> hidden (excluded by default)
            </li>
            <li>
              <MessageSquareText size={16} aria-hidden="true" />
              <strong>{stats.notes}</strong> with speaker notes
            </li>
            <li>
              <ImageIcon size={16} aria-hidden="true" />
              <strong>{stats.images}</strong> {stats.images === 1 ? 'image' : 'images'}
            </li>
            <li className={stats.warnings ? 'is-warn' : ''}>
              <TriangleAlert size={16} aria-hidden="true" />
              <strong>{stats.warnings}</strong> {stats.warnings === 1 ? 'item' : 'items'} to review
            </li>
          </ul>
          {renderer && renderer.state !== 'available' && (
            <p className="muted small">Text extracted; slide rendering is unavailable, so slides appear as an Extracted content view (not a screenshot). Add a PDF export below for visual reference.</p>
          )}
          <DeckUpload projectId={project.id} kind="pptx" existing={primary} compact />
        </section>
      )}
      <section className="optional-source" aria-labelledby="pdf-ref-title">
        <h4 id="pdf-ref-title" className="h-sub-sm">
          Optional: PDF export for visual reference
        </h4>
        <p className="muted small">Slide images help you (and, only if you allow it later, Claude) see diagrams and charts. Page-to-slide matches are suggested by text and must be verified. Figma PDF exports also go here.</p>
        <DeckUpload projectId={project.id} kind="pdf" compact />
        {pdf && (
          <p className="small muted">
            Reference: <strong>{pdf.originalName}</strong> · {pdf.pageCount ?? '—'} pages · {pdf.status}
          </p>
        )}
        {pdfJob && pdfJob.status !== 'succeeded' && <JobActivity job={pdfJob} compact />}
      </section>
    </div>
  );
}

function AssetsPanel({ projectId }: { projectId: string }) {
  return (
    <div className="stack">
      <p className="muted small">Everything goes into the shared project library. Assigned uploads supply exact artwork — including artwork you downloaded from ChatGPT or another AI tool (say so below, and it is recorded with the file).</p>
      <div className="setup-uploaders">
        <AssetUploader projectId={projectId} role="background" label="Add backgrounds" askOrigin />
        <AssetUploader projectId={projectId} role="character" label="Add characters or sprite frames" askOrigin />
        <AssetUploader projectId={projectId} role="ui" label="Add panels and buttons" askOrigin />
        <AssetUploader projectId={projectId} role="object" label="Add objects" askOrigin />
        <AssetUploader projectId={projectId} role="audio" label="Add sounds" audio />
      </div>
      <p className="subtle small">Separate character frames can be combined into a sprite sheet with named clips in Assets. A static picture can only move, fade, scale or rotate as a whole.</p>
    </div>
  );
}

interface CardSpec {
  id: SetupCardId;
  title: string;
  icon: ReactNode;
  status: string;
  detail: string;
  tone: 'success' | 'warning' | 'neutral' | 'danger' | 'info';
  done: boolean;
}

/**
 * The four setup cards of the unified project. Each shows real status and an
 * Edit action. Any useful combination is accepted; none is mandatory on its own.
 */
export function SetupCards({ project, initial = null, gameBuiltFor = null }: { project: ProjectDetail; initial?: SetupCardId | null; gameBuiltFor?: string | null }) {
  const [open, setOpen] = useState<SetupCardId | null>(initial);
  // `initial` is known only once the sources have loaded; open it then, unless the creator already chose a card.
  const chosen = useRef(false);
  useEffect(() => {
    if (!chosen.current && initial) setOpen(initial);
  }, [initial]);
  const slides = useSlides(project.id);
  const design = useDesign(project.id);
  const assets = useAssets(project.id);
  const grade = useGrade(project.id);
  const primary = project.documents.find((d) => d.kind === 'pptx') ?? null;
  const list = slides.data?.slides ?? [];
  const imports = design.data?.imports ?? [];
  const activeFrames = imports.filter((i) => i.status === 'active').flatMap((i) => i.frames);
  const figmaFrames = imports.filter((i) => i.status === 'active' && i.kind === 'figma').flatMap((i) => i.frames).length;
  const exported = imports.filter((i) => i.status === 'active' && i.kind === 'exported').flatMap((i) => i.frames).length;
  const browsing = imports.find((i) => i.status === 'browsing' && i.available.length > 0);
  const pendingRefresh = imports.find((i) => i.status === 'pending-review');
  const library = (assets.data ?? []).filter((a) => a.role !== 'reference');
  const aiMade = library.filter((a) => a.metadata.provenance?.kind === 'ai-tool').length;
  const profile = grade.data?.current?.profile ?? null;

  const cards: CardSpec[] = [
    {
      id: 'design',
      title: 'Figma design',
      icon: <Frame size={20} aria-hidden="true" />,
      status: activeFrames.length ? `${activeFrames.length} screen${activeFrames.length === 1 ? '' : 's'} ready to map` : browsing ? 'Choose frames to import' : 'Not added',
      detail: pendingRefresh
        ? 'A refresh from Figma is waiting for your review.'
        : activeFrames.length
          ? [figmaFrames ? `${figmaFrames} from Figma` : '', exported ? `${exported} exported` : ''].filter(Boolean).join(' · ')
          : design.data?.figma.state === 'not-configured'
            ? 'Upload exported screens (Figma link import is not configured on this server).'
            : 'Paste a design link or upload exported screens.',
      tone: pendingRefresh ? 'warning' : activeFrames.length ? 'success' : 'neutral',
      done: activeFrames.length > 0,
    },
    {
      id: 'lesson',
      title: 'PPT lesson / storyboard',
      icon: <Presentation size={20} aria-hidden="true" />,
      status: list.length ? `${list.length} slide${list.length === 1 ? '' : 's'} imported` : primary?.status === 'failed' ? 'Import failed' : primary ? 'Importing…' : 'Not added',
      detail: list.length ? `${list.filter((s) => s.hidden).length} hidden · ${project.contentReviewedAt ? 'content reviewed' : 'not reviewed yet'}` : primary?.status === 'failed' ? (primary.error ?? 'See details.') : '.pptx lesson deck or storyboard (legacy .ppt must be re-saved as .pptx).',
      tone: primary?.status === 'failed' && !list.length ? 'danger' : list.length ? (project.contentReviewedAt ? 'success' : 'info') : 'neutral',
      done: list.length > 0,
    },
    {
      id: 'assets',
      title: 'Game assets',
      icon: <Shapes size={20} aria-hidden="true" />,
      status: library.length ? `${library.length} asset${library.length === 1 ? '' : 's'} in the library` : 'No artwork yet',
      detail: library.length
        ? `${['background', 'character', 'object', 'ui', 'audio', 'unassigned']
            .map((r) => [r, library.filter((a) => a.role === r).length] as const)
            .filter(([, n]) => n > 0)
            .map(([r, n]) => `${n} ${r === 'ui' ? 'UI' : r === 'unassigned' ? 'not yet sorted' : r}`)
            .join(' · ')}${aiMade ? ` · ${aiMade} made with an AI tool` : ''}`
        : 'Built-in art is used until you add your own.',
      tone: library.length ? 'success' : 'neutral',
      done: library.length > 0,
    },
    {
      id: 'grade',
      title: 'Grade & learning profile',
      icon: <GraduationCap size={20} aria-hidden="true" />,
      status: profile ? gradeSummary(profile).split(' · ')[0]! : 'Not set',
      detail: profile ? gradeSummary(profile).split(' · ').slice(1).join(' · ') : 'Which grade is this game for? Set it before generating the blueprint.',
      tone: profile ? 'success' : 'warning',
      done: Boolean(profile),
    },
  ];

  return (
    <div className="setup">
      <ul className="setup-cards" aria-label="Project sources and grade">
        {cards.map((c) => (
          <li key={c.id} className={`setup-card tone-${c.tone}${open === c.id ? ' is-open' : ''}`}>
            <div className="setup-card-head">
              <span className="setup-card-icon">{c.icon}</span>
              <h3>{c.title}</h3>
              {c.done ? (
                <Pill tone="success" dot={false}>
                  Added
                </Pill>
              ) : (
                c.id === 'grade' && <Pill tone="warning">Needed</Pill>
              )}
            </div>
            <p className="setup-card-status">{c.status}</p>
            <p className="setup-card-detail subtle small">{c.detail}</p>
            <Button size="sm" icon={open === c.id ? <X size={14} aria-hidden="true" /> : <Pencil size={14} aria-hidden="true" />} aria-expanded={open === c.id} aria-controls={`setup-${c.id}`} onClick={() => {
                chosen.current = true;
                setOpen(open === c.id ? null : c.id);
              }}>
              {open === c.id ? 'Close' : 'Edit'}
            </Button>
          </li>
        ))}
      </ul>
      {open && (
        <section id={`setup-${open}`} className="setup-editor panel panel-pad" aria-label={cards.find((c) => c.id === open)!.title}>
          <h3 className="h-sub">{cards.find((c) => c.id === open)!.title}</h3>
          {open === 'design' && <DesignSources projectId={project.id} />}
          {open === 'lesson' && <LessonSourcePanel project={project} />}
          {open === 'assets' && <AssetsPanel projectId={project.id} />}
          {open === 'grade' && <GradeProfileEditor projectId={project.id} gameBuiltFor={gameBuiltFor} />}
        </section>
      )}
    </div>
  );
}

/** What the sources add up to — content is never invented to fill gaps. */
export function useSourceSummary(project: ProjectDetail | undefined) {
  const slides = useSlides(project?.id ?? null);
  const design = useDesign(project?.id ?? null);
  const assets = useAssets(project?.id ?? null);
  const grade = useGrade(project?.id ?? null);
  const slideCount = slides.data?.slides.length ?? 0;
  const frameCount = (design.data?.imports ?? []).filter((i) => i.status === 'active').reduce((n, i) => n + i.frames.length, 0);
  const assetCount = (assets.data ?? []).filter((a) => a.role !== 'reference').length;
  return { slideCount, frameCount, assetCount, grade: grade.data?.current?.profile ?? null, loading: slides.isLoading || design.isLoading || assets.isLoading || grade.isLoading };
}
