import { useEffect, useRef, useState } from 'react';
import { Spinner } from '../ui/feedback.tsx';

/**
 * Renders one page of a stored reference PDF with pdf.js (loaded on demand).
 * This shows the creator's own exported page — not a fabricated screenshot.
 */

type PdfDoc = { numPages: number; getPage(n: number): Promise<{ getViewport(o: { scale: number }): { width: number; height: number }; render(o: { canvasContext: CanvasRenderingContext2D; viewport: unknown; canvas: HTMLCanvasElement }): { promise: Promise<void> } }> };

const docs = new Map<string, Promise<PdfDoc>>();

async function loadDoc(docId: string): Promise<PdfDoc> {
  let p = docs.get(docId);
  if (!p) {
    p = (async () => {
      const pdfjs = await import('pdfjs-dist');
      const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
      pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
      const task = pdfjs.getDocument({ url: `/api/sources/${docId}/file`, disableFontFace: false });
      return (await task.promise) as unknown as PdfDoc;
    })();
    docs.set(docId, p);
    p.catch(() => docs.delete(docId));
  }
  return p;
}

export function PdfPage({ docId, pageNumber, label }: { docId: string; pageNumber: number; label: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setState('loading');
    (async () => {
      try {
        const doc = await loadDoc(docId);
        if (pageNumber < 1 || pageNumber > doc.numPages) throw new Error(`The PDF has ${doc.numPages} pages.`);
        const page = await doc.getPage(pageNumber);
        const width = boxRef.current?.clientWidth ?? 640;
        const base = page.getViewport({ scale: 1 });
        const scale = (width / base.width) * Math.min(2, window.devicePixelRatio || 1);
        const viewport = page.getViewport({ scale });
        const canvas = canvasRef.current;
        if (!canvas || cancelled) return;
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Canvas unavailable');
        await page.render({ canvasContext: ctx, viewport, canvas }).promise;
        if (!cancelled) setState('ready');
      } catch (err) {
        if (!cancelled) {
          setError((err as Error).message);
          setState('error');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [docId, pageNumber]);

  return (
    <div className="pdf-page" ref={boxRef}>
      {state === 'loading' && <Spinner label="Rendering page…" />}
      {state === 'error' && <p className="subtle small">The page could not be shown: {error}</p>}
      <canvas ref={canvasRef} role="img" aria-label={label} hidden={state !== 'ready'} />
    </div>
  );
}
