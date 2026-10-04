import fs from 'node:fs';
import path from 'node:path';
import { effectiveSlideText, type ExtractionWarning } from '@shared/schemas/source.ts';
import { suggestPageMapping } from '@shared/similarity.ts';
import type { App } from '../../app.ts';
import { getDocumentRow, insertDocument, insertSlides, listSlides, refreshSourceRevision, updateDocument, updateSlide } from '../../db/sources.ts';
import { ID_PREFIX, newId } from '@shared/schemas/common.ts';
import { extractPptx, PptxRejection, SUPPORTED_IMAGE_TYPES } from '../../ingest/pptx.ts';
import { readPdf } from '../../ingest/pdf.ts';
import { renderDeckToPdf } from '../../ingest/render.ts';
import { storeMedia } from '../../services/assets.ts';
import { sha256, writeFileAtomic } from '../../storage.ts';
import { MediaRejection } from '../../ingest/media.ts';
import { JobFailure, type JobContext } from '../context.ts';

/** Extract a stored .pptx into slides and assets. Shared by the job handler and the bundled sample importer. */
export async function extractDeckIntoProject(
  app: App,
  projectId: string,
  documentId: string,
  opts: { onEvent: (message: string) => void; source: 'uploaded' | 'bundled-sample'; signal?: AbortSignal },
): Promise<{ slides: number; hidden: number; withNotes: number; warnings: number; images: number }> {
  const doc = getDocumentRow(app.db, documentId);
  if (!doc || doc.project_id !== projectId) throw new JobFailure('The uploaded deck was not found.', 'missing_document', false);
  updateDocument(app.db, documentId, { status: 'extracting', error: null });
  const file = app.storage.abs(doc.stored_path);
  let result;
  try {
    result = await extractPptx(file, doc.original_name, app.config.limits, opts.onEvent);
  } catch (err) {
    if (err instanceof PptxRejection) updateDocument(app.db, documentId, { status: 'failed', error: `${err.message} ${err.hint}` });
    else updateDocument(app.db, documentId, { status: 'failed', error: (err as Error).message });
    throw err;
  }
  try {
    if (opts.signal?.aborted) throw new Error('Cancelled');
    // Import supported images as project assets (originals preserved; display copies validated).
    const imageAssets = new Map<string, string>();
    const imageWarnings = new Map<number, ExtractionWarning[]>();
    const supported = [...result.media.values()].filter((m) => SUPPORTED_IMAGE_TYPES.has(m.contentType));
    if (supported.length > 0) opts.onEvent(`Importing ${supported.length} image${supported.length === 1 ? '' : 's'} from the deck`);
    for (const m of supported) {
      if (opts.signal?.aborted) throw new Error('Cancelled');
      const altFor = (() => {
        for (const use of m.usedBy) {
          const slide = result.slides.find((s) => s.slideNumber === use.slideNumber);
          const img = slide?.extract.images.find((i) => i.id === use.imageId);
          if (img?.altText) return img.altText;
        }
        return '';
      })();
      try {
        const data = await result.readPart(m.partName, app.config.limits.maxAssetBytes);
        const row = await storeMedia(app, projectId, data, { originalName: path.posix.basename(m.partName), source: opts.source === 'bundled-sample' ? 'bundled-sample' : 'extracted', alt: altFor });
        imageAssets.set(m.partName, row.id);
      } catch (err) {
        const message =
          err instanceof MediaRejection
            ? `Image ${path.posix.basename(m.partName)} was not imported: ${err.message}`
            : `Image ${path.posix.basename(m.partName)} could not be read.`;
        for (const use of m.usedBy) {
          const list = imageWarnings.get(use.slideNumber) ?? [];
          list.push({ code: err instanceof MediaRejection && err.code === 'too-many-pixels' ? 'image-too-large' : 'unsupported-image', severity: 'warning', message });
          imageWarnings.set(use.slideNumber, list);
        }
      }
    }
    const slides = result.slides.map((s) => ({
      ...s,
      extract: { ...s.extract, warnings: [...s.extract.warnings, ...(imageWarnings.get(s.slideNumber) ?? [])] },
    }));
    opts.onEvent(`Saving ${slides.length} slides`);
    app.db.tx(() => {
      // One primary deck per project: slides from an earlier deck are replaced.
      app.db.run('DELETE FROM source_slides WHERE project_id = ? AND document_id <> ?', [projectId, documentId]);
      app.db.run('DELETE FROM source_slides WHERE document_id = ?', [documentId]);
      insertSlides(app.db, projectId, documentId, slides, imageAssets);
      updateDocument(app.db, documentId, {
        status: 'ready',
        pageCount: slides.length,
        slideSize: result.slideSize,
        warnings: result.packageWarnings,
        error: null,
      });
    });
    refreshSourceRevision(app.db, projectId);
    return {
      slides: slides.length,
      hidden: slides.filter((s) => s.hidden).length,
      withNotes: slides.filter((s) => s.extract.notes.length > 0).length,
      warnings: slides.reduce((n, s) => n + s.extract.warnings.length, 0),
      images: imageAssets.size,
    };
  } finally {
    result.close();
  }
}

export async function handleExtractPptx(ctx: JobContext<'extract_pptx'>) {
  const { documentId } = ctx.input();
  ctx.stage('extract', 'Reading the PowerPoint package');
  const summary = await extractDeckIntoProject(ctx.app, ctx.projectId, documentId, {
    onEvent: (m) => ctx.event('info', m),
    source: 'uploaded',
    signal: ctx.signal,
  });
  const renderer = ctx.app.renderer();
  ctx.event(
    'info',
    `Extracted ${summary.slides} slides (${summary.hidden} hidden, ${summary.withNotes} with speaker notes, ${summary.images} images, ${summary.warnings} warnings to review).` +
      (renderer.state === 'available' ? '' : ' Text extracted; slide rendering is unavailable — slides are shown as an Extracted content view.'),
  );
  return summary;
}

/** Suggest page↔slide matches for a reference PDF. Suggestions always need creator verification. */
function suggestMappings(app: App, projectId: string, documentId: string, pages: Array<{ number: number; text: string }>, kind: 'pdf-page' | 'render') {
  const slides = listSlides(app.db, projectId);
  const candidates = slides.filter((s) => !s.visualRef || s.visualRef.mapping === 'suggested');
  const suggestions = suggestPageMapping(
    candidates.map((s) => {
      const t = effectiveSlideText(s);
      return { id: s.id, text: [t.title, ...t.blocks.flatMap((b) => b.paragraphs)].join(' ') };
    }),
    pages,
  );
  let matched = 0;
  for (const sug of suggestions) {
    if (sug.pageNumber === null) continue;
    matched++;
    updateSlide(app.db, sug.slideId, { visualRef: { kind, documentId, pageNumber: sug.pageNumber, assetId: null, mapping: 'suggested' } }, null);
  }
  return { matched, considered: candidates.length };
}

export async function handleExtractPdf(ctx: JobContext<'extract_pdf'>) {
  const { documentId } = ctx.input();
  const doc = getDocumentRow(ctx.app.db, documentId);
  if (!doc) throw new JobFailure('The PDF was not found.', 'missing_document', false);
  ctx.stage('read', 'Reading the PDF reference');
  updateDocument(ctx.app.db, documentId, { status: 'extracting' });
  let info;
  try {
    info = await readPdf(fs.readFileSync(ctx.app.storage.abs(doc.stored_path)), { maxBytes: ctx.app.config.limits.maxUploadBytes, maxPages: ctx.app.config.limits.maxPdfPages });
  } catch (err) {
    updateDocument(ctx.app.db, documentId, { status: 'failed', error: (err as Error).message });
    throw err;
  }
  updateDocument(ctx.app.db, documentId, { status: 'ready', pageCount: info.pageCount, pages: info.pages });
  ctx.stage('map', 'Suggesting page-to-slide matches by text overlap');
  const slideCount = listSlides(ctx.app.db, ctx.projectId).length;
  const { matched, considered } = suggestMappings(ctx.app, ctx.projectId, documentId, info.pages, 'pdf-page');
  const textless = info.pages.filter((p) => p.text.length < 3).length;
  ctx.event('info', `Read ${info.pageCount} pages. Suggested matches for ${matched} of ${considered} slides — verify each one in Source review.`);
  if (info.pageCount === slideCount) ctx.event('info', 'The page count equals the slide count, but that does not prove the order matches. Check the suggested matches.');
  if (textless > 0) ctx.event('warning', `${textless} page(s) have no selectable text (scanned or image-only) and could not be matched automatically.`);
  return { pages: info.pageCount, matched };
}

export async function handleRenderSlides(ctx: JobContext<'render_slides'>) {
  const { documentId } = ctx.input();
  const status = await ctx.app.refreshRenderer();
  if (status.state !== 'available') {
    throw new JobFailure(`Slide rendering is unavailable: ${status.detail}`, 'renderer_unavailable', false);
  }
  const doc = getDocumentRow(ctx.app.db, documentId);
  if (!doc) throw new JobFailure('The deck was not found.', 'missing_document', false);
  ctx.stage('render', `Rendering slides with ${status.mode === 'docker' ? 'the Docker renderer' : 'LibreOffice'}`);
  const pdf = await renderDeckToPdf(ctx.app.config, ctx.app.storage.abs(doc.stored_path), ctx.signal);
  const id = newId(ID_PREFIX.document);
  const rel = `projects/${ctx.projectId}/sources/${id}/rendered.pdf`;
  writeFileAtomic(ctx.app.storage.abs(rel), pdf);
  insertDocument(ctx.app.db, { id, projectId: ctx.projectId, kind: 'pdf', role: 'rendered', originalName: `${doc.original_name.replace(/\.pptx$/i, '')} (rendered).pdf`, storedPath: rel, sizeBytes: pdf.length, sha256: sha256(pdf), status: 'extracting' });
  const info = await readPdf(pdf, { maxBytes: Number.MAX_SAFE_INTEGER, maxPages: ctx.app.config.limits.maxPdfPages });
  updateDocument(ctx.app.db, id, { status: 'ready', pageCount: info.pageCount, pages: info.pages });
  const slides = listSlides(ctx.app.db, ctx.projectId);
  if (info.pageCount === slides.length) {
    // Rendered from this exact deck with hidden slides exported, so page N is slide N.
    for (const s of slides) {
      if (s.visualRef?.mapping === 'verified') continue;
      updateSlide(ctx.app.db, s.id, { visualRef: { kind: 'render', documentId: id, pageNumber: s.slideNumber, assetId: null, mapping: 'exact' } }, null);
    }
    ctx.event('info', `Rendered ${info.pageCount} slides; each page is linked to its slide.`);
  } else {
    const { matched } = suggestMappings(ctx.app, ctx.projectId, id, info.pages, 'render');
    ctx.event('warning', `The renderer produced ${info.pageCount} pages for ${slides.length} slides; ${matched} matches were suggested by text overlap — verify them.`);
  }
  return { pages: info.pageCount };
}
