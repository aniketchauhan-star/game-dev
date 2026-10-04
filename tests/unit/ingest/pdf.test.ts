import { PDFDocument, PDFHexString, PDFName, PDFString, StandardFonts } from 'pdf-lib';
import { beforeAll, describe, expect, it } from 'vitest';
import { extractPdfPage, PdfRejection, readPdf } from '../../../server/src/ingest/pdf.ts';
import { rejectionOf, solidPng } from './helpers.ts';

interface PageSpec {
  lines?: string[];
  size?: [number, number];
}

async function makePdf(pages: PageSpec[], tweak?: (doc: PDFDocument) => void): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const spec of pages) {
    const [w, h] = spec.size ?? [600, 400];
    const page = doc.addPage([w, h]);
    (spec.lines ?? []).forEach((line, i) => page.drawText(line, { x: 20, y: h - 30 - i * 10, size: 8, font }));
  }
  tweak?.(doc);
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

const LIMITS = { maxBytes: 40 * 1024 * 1024, maxPages: 200 };

async function pdfRejection(work: Promise<unknown>, code: PdfRejection['code']): Promise<PdfRejection> {
  const err = await rejectionOf(work, PdfRejection);
  expect(err.code).toBe(code);
  expect(err.hint.length).toBeGreaterThan(0);
  return err;
}

let threePages: Buffer;
beforeAll(async () => {
  threePages = await makePdf([
    { lines: ['Alpha page one'], size: [600, 400] },
    { lines: ['Bravo   page', 'two'], size: [610, 400] },
    { lines: ['Charlie page three'], size: [620, 450] },
  ]);
});

describe('readPdf', () => {
  it('returns the page count and each page\'s text and size', async () => {
    const info = await readPdf(threePages, LIMITS);
    expect(info).toEqual({
      pageCount: 3,
      pages: [
        { number: 1, text: 'Alpha page one', width: 600, height: 400 },
        { number: 2, text: 'Bravo page two', width: 610, height: 400 },
        { number: 3, text: 'Charlie page three', width: 620, height: 450 },
      ],
    });
  });

  it('returns empty text for image-only pages', async () => {
    const info = await readPdf(await makePdf([{}]), LIMITS);
    expect(info.pages).toEqual([{ number: 1, text: '', width: 600, height: 400 }]);
  });

  it('caps the text kept per page', async () => {
    const lines = Array.from({ length: 100 }, (_, i) => `${String(i).padStart(3, '0')} ${'w'.repeat(96)}`);
    const info = await readPdf(await makePdf([{ lines, size: [600, 1100] }]), LIMITS);
    expect(info.pages[0]?.text.length).toBe(8000);
    expect(info.pages[0]?.text.startsWith('000 www')).toBe(true);
  });

  it('enforces the page limit (and accepts a PDF exactly at it)', async () => {
    const err = await pdfRejection(readPdf(threePages, { ...LIMITS, maxPages: 2 }), 'too-many-pages');
    expect(err.message).toContain('3 pages');
    expect((await readPdf(threePages, { ...LIMITS, maxPages: 3 })).pageCount).toBe(3);
  });

  it('enforces the size limit before parsing (and accepts a PDF exactly at it)', async () => {
    await pdfRejection(readPdf(threePages, { ...LIMITS, maxBytes: threePages.length - 1 }), 'too-large');
    expect((await readPdf(threePages, { ...LIMITS, maxBytes: threePages.length })).pageCount).toBe(3);
  });

  it('rejects content that is not a PDF, whatever it claims to be', async () => {
    await pdfRejection(readPdf(await solidPng(8, 8), LIMITS), 'not-pdf');
    await pdfRejection(readPdf(Buffer.from('PK\x03\x04 a zip'), LIMITS), 'not-pdf');
    await pdfRejection(readPdf(Buffer.from('<html>%PDF-1.7</html>'), LIMITS), 'not-pdf');
    await pdfRejection(readPdf(Buffer.alloc(0), LIMITS), 'not-pdf');
  });

  it('rejects a damaged PDF as corrupt', async () => {
    await pdfRejection(readPdf(Buffer.from('%PDF-1.7\nthis is not a real PDF body\n%%EOF'), LIMITS), 'corrupt');
  });

  it('rejects a password-protected PDF', async () => {
    const encrypted = await makePdf([{ lines: ['Secret'] }], (doc) => {
      const dict = doc.context.obj({ Filter: 'Standard', V: 1, R: 2, Length: 40, P: -4, O: PDFHexString.of('11'.repeat(32)), U: PDFHexString.of('22'.repeat(32)) });
      doc.context.trailerInfo.Encrypt = doc.context.register(dict);
      doc.context.trailerInfo.ID = doc.context.obj([PDFHexString.of('ab'.repeat(16)), PDFHexString.of('ab'.repeat(16))]);
    });
    await pdfRejection(readPdf(encrypted, LIMITS), 'encrypted');
  });

  it('never runs document JavaScript', async () => {
    const marker = '__nexusPdfJsRan';
    const withJs = await makePdf([{ lines: ['Has an OpenAction'] }], (doc) => {
      const action = doc.context.obj({ S: 'JavaScript', JS: PDFString.of(`globalThis.${marker} = true; app.alert('x');`) });
      doc.catalog.set(PDFName.of('OpenAction'), action);
    });
    const info = await readPdf(withJs, LIMITS);
    expect(info.pages[0]?.text).toBe('Has an OpenAction');
    expect((globalThis as Record<string, unknown>)[marker]).toBeUndefined();
  });
});

describe('extractPdfPage', () => {
  it.each([
    [1, 'Alpha page one', 600, 400],
    [2, 'Bravo page two', 610, 400],
    [3, 'Charlie page three', 620, 450],
  ])('returns a one-page PDF containing only page %i', async (pageNumber, text, width, height) => {
    const before = Buffer.from(threePages);
    const single = await extractPdfPage(threePages, pageNumber);
    expect(single.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect((await PDFDocument.load(single)).getPageCount()).toBe(1);
    expect(await readPdf(single, LIMITS)).toEqual({ pageCount: 1, pages: [{ number: 1, text, width, height }] });
    expect(threePages.equals(before)).toBe(true);
  });

  it.each([0, 4, -1])('rejects page %i, which does not exist', async (pageNumber) => {
    const err = await pdfRejection(extractPdfPage(threePages, pageNumber), 'corrupt');
    expect(err.message).toContain(String(pageNumber));
  });
});
