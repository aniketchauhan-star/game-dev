import './env.ts';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SourceDocument, SourceSlide } from '@shared/schemas/source.ts';
import { Studio } from './helpers.ts';

/** A PDF whose pages carry the given text (ASCII; the standard font has no Unicode minus sign). */
async function pdfWithPages(texts: string[]): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const text of texts) {
    const page = doc.addPage([960, 540]);
    text.split('\n').forEach((line, i) => page.drawText(line, { x: 40, y: 480 - i * 28, size: 18, font }));
  }
  return Buffer.from(await doc.save());
}

describe('reference PDF → extract_pdf job → suggested slide matches', () => {
  let s: Studio;
  let projectId: string;
  let slides: SourceSlide[];
  let pdfDoc: SourceDocument;

  beforeAll(async () => {
    s = await Studio.start();
    projectId = (await s.createProject('PDF reference')).id;
    slides = (await s.importDeck(projectId)).slides;
  });

  afterAll(async () => {
    await s.close();
  });

  it('refuses a file that is not a PDF', async () => {
    const res = await s.upload(projectId, { filename: 'export.pdf', data: Buffer.from('not really a pdf') }, { kind: 'pdf' });
    expect(res.statusCode).toBe(415);
    expect(res.json().error).toMatchObject({ code: 'not_pdf', message: 'This file is not a PDF.' });
  });

  it('reads the pages in the worker and suggests (never asserts) page matches for the slides they show', async () => {
    const pdf = await pdfWithPages([
      'The airfield is a coordinate plane\nThe x-axis runs left to right.\nThe y-axis runs bottom to top.',
      'Reading an ordered pair (x, y)\nAlways move along x first, then y.\nExample: (3, 2) means 3 right, then 2 up.',
      'Negative coordinates\nThe sign gives the direction; the number gives the distance.',
    ]);
    // A reference PDF sits next to the deck: no "replace deck" confirmation is needed.
    const up = await s.upload(projectId, { filename: 'lesson-export.pdf', data: pdf, contentType: 'application/pdf' }, { kind: 'pdf' });
    expect(up.statusCode, up.body).toBe(202);
    pdfDoc = up.json().document as SourceDocument;
    expect(pdfDoc).toMatchObject({ kind: 'pdf', role: 'reference', status: 'stored' });
    expect(up.json().job).toMatchObject({ type: 'extract_pdf', mode: 'local', status: 'queued' });

    expect(await s.runJobs()).toBe(1);
    const { job, events } = await s.job(up.json().job.id);
    expect(job.status, JSON.stringify(job.error)).toBe('succeeded');
    expect(job.result).toEqual({ pages: 3, matched: 3 });
    expect(events.map((e) => e.message)).toContain('Read 3 pages. Suggested matches for 3 of 9 slides — verify each one in Source review.');

    const p = await s.project(projectId);
    expect(p.documents.map((d) => [d.kind, d.status, d.pageCount])).toEqual([
      ['pptx', 'ready', 9],
      ['pdf', 'ready', 3],
    ]);
    const after = await s.slides(projectId);
    expect(after.map((x) => x.visualRef && [x.slideNumber, x.visualRef.pageNumber, x.visualRef.mapping]).filter(Boolean)).toEqual([
      [2, 1, 'suggested'],
      [3, 2, 'suggested'],
      [5, 3, 'suggested'],
    ]);
    expect(after.filter((x) => x.visualRef).every((x) => x.visualRef!.documentId === pdfDoc.id && x.visualRef!.kind === 'pdf-page')).toBe(true);

    // The PDF is served inline (for the in-studio viewer) but sandboxed.
    const file = await s.get(`/api/sources/${pdfDoc.id}/file`);
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('application/pdf');
    expect(file.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
  });

  it('the creator verifies a match (recorded in history); deleting the PDF clears every reference to it', async () => {
    const slide2 = (await s.slides(projectId))[1]!;
    const verify = await s.patch(`/api/slides/${slide2.id}`, { revision: slide2.revision, patch: { visualRef: { ...slide2.visualRef!, mapping: 'verified' } } });
    expect(verify.statusCode, verify.body).toBe(200);
    expect(verify.json().slide.visualRef.mapping).toBe('verified');
    const history = (await s.get(`/api/slides/${slide2.id}/history`)).json().changes as Array<{ field: string }>;
    expect(history[0]!.field).toBe('visualRef');

    expect((await s.del(`/api/projects/prj_doesnotexist/sources/${pdfDoc.id}`)).statusCode).toBe(404);
    const del = await s.del(`/api/projects/${projectId}/sources/${pdfDoc.id}`);
    expect(del.statusCode, del.body).toBe(200);
    expect((del.json().documents as SourceDocument[]).map((d) => d.kind)).toEqual(['pptx']);
    expect((await s.slides(projectId)).filter((x) => x.visualRef)).toEqual([]);
    expect((await s.get(`/api/sources/${pdfDoc.id}/file`)).statusCode).toBe(404);
    expect((await s.slides(projectId)).map((x) => x.id)).toEqual(slides.map((x) => x.id));
  });

  it('a damaged PDF fails its job with a clear message; too many pages is refused', async () => {
    const damaged = await s.upload(projectId, { filename: 'damaged.pdf', data: Buffer.from('%PDF-1.7\nthis is not a real pdf body\n%%EOF') }, { kind: 'pdf' });
    expect(damaged.statusCode).toBe(202);
    await s.runJobs();
    const failed = (await s.job(damaged.json().job.id)).job;
    expect(failed.status).toBe('failed');
    expect(failed.error).toMatchObject({ code: 'pdf_corrupt', retryable: false });
    expect(failed.error!.message).toMatch(/^The PDF could not be read/);

    const strict = await Studio.start({ limits: { maxPdfPages: 2 } });
    try {
      const p = await strict.createProject('Page limit');
      const up = await strict.upload(p.id, { filename: 'long.pdf', data: await pdfWithPages(['one', 'two', 'three']) }, { kind: 'pdf' });
      expect(up.statusCode).toBe(202);
      await strict.runJobs();
      const job = (await strict.job(up.json().job.id)).job;
      expect(job.status).toBe('failed');
      expect(job.error).toMatchObject({ code: 'pdf_too-many-pages' });
      expect(job.error!.message).toMatch(/The PDF has 3 pages; the limit is 2\./);
    } finally {
      await strict.close();
    }
  });
});
