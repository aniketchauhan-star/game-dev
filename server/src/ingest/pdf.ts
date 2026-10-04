import { PDFDocument } from 'pdf-lib';
import { sniff } from './sniff.ts';

/**
 * Optional PDF reference adapter. Reads page text (for suggested slide
 * mapping) with pdf.js — no PDF JavaScript is executed (pdf.js 6 has no eval path) —
 * and extracts single pages with pdf-lib when the creator authorizes sending a
 * page to Claude for visual analysis.
 */

export class PdfRejection extends Error {
  constructor(
    readonly code: 'not-pdf' | 'encrypted' | 'too-many-pages' | 'too-large' | 'corrupt',
    message: string,
    readonly hint: string,
  ) {
    super(message);
  }
}

export interface PdfPageInfo {
  number: number;
  text: string;
  width: number;
  height: number;
}

export interface PdfInfo {
  pageCount: number;
  pages: PdfPageInfo[];
}

export async function readPdf(buf: Buffer, limits: { maxBytes: number; maxPages: number }): Promise<PdfInfo> {
  if (buf.length > limits.maxBytes) throw new PdfRejection('too-large', 'The PDF is larger than the upload limit.', 'Export a smaller PDF (for example without embedded video).');
  if (sniff(buf) !== 'pdf') throw new PdfRejection('not-pdf', 'This file is not a PDF.', 'Upload a PDF exported from your presentation.');
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({
    data: new Uint8Array(buf),
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
    stopAtErrors: false,
  });
  try {
    const pdf = await task.promise;
    if (pdf.numPages > limits.maxPages) {
      throw new PdfRejection('too-many-pages', `The PDF has ${pdf.numPages} pages; the limit is ${limits.maxPages}.`, 'Export only the slides you need.');
    }
    const pages: PdfPageInfo[] = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const text = content.items
        .map((item) => ('str' in item ? item.str : ''))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 8000);
      pages.push({ number: i, text, width: Math.round(viewport.width), height: Math.round(viewport.height) });
      page.cleanup();
    }
    return { pageCount: pdf.numPages, pages };
  } catch (err) {
    if (err instanceof PdfRejection) throw err;
    const name = (err as { name?: string }).name ?? '';
    if (name === 'PasswordException') {
      throw new PdfRejection('encrypted', 'This PDF is password-protected.', 'Export the PDF again without a password.');
    }
    throw new PdfRejection('corrupt', `The PDF could not be read: ${(err as Error).message}`, 'Export the PDF again from your presentation software.');
  } finally {
    await task.destroy();
  }
}

/** A one-page PDF containing only `pageNumber` (1-based), for an authorized visual-analysis request. */
export async function extractPdfPage(buf: Buffer, pageNumber: number): Promise<Buffer> {
  const src = await PDFDocument.load(buf, { updateMetadata: false });
  if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > src.getPageCount()) {
    throw new PdfRejection('corrupt', `Page ${pageNumber} does not exist.`, 'Check the slide-to-page mapping.');
  }
  const out = await PDFDocument.create();
  const [page] = await out.copyPages(src, [pageNumber - 1]);
  out.addPage(page!);
  return Buffer.from(await out.save());
}
