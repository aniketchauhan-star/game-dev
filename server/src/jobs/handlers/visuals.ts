import fs from 'node:fs';
import sharp from 'sharp';
import type Anthropic from '@anthropic-ai/sdk';
import type { GameBrief } from '@shared/schemas/brief.ts';
import type { SourceSlide } from '@shared/schemas/source.ts';
import type { App } from '../../app.ts';
import { getAssetRow } from '../../db/assets.ts';
import { getDocumentRow } from '../../db/sources.ts';
import { extractPdfPage } from '../../ingest/pdf.ts';
import { assetFile } from '../../services/assets.ts';

/**
 * Visual references sent to Claude ONLY when the creator authorized them for a
 * slide and the slide↔page mapping is verified (or exact). Nothing is sent for
 * slides without real image data.
 */
export async function visualBlocks(
  app: App,
  slides: SourceSlide[],
  brief: GameBrief,
  note: (message: string) => void,
): Promise<Anthropic.Beta.BetaContentBlockParam[]> {
  if (!brief.aiInputs.sendVisualReferences) return [];
  const info = app.gateway.status().modelInfo;
  const authorized = new Set(brief.aiInputs.authorizedVisualSlideIds);
  const out: Anthropic.Beta.BetaContentBlockParam[] = [];
  let bytes = 0;
  for (const slide of slides) {
    if (!authorized.has(slide.id)) continue;
    const ref = slide.visualRef;
    if (!ref) {
      note(`Slide ${slide.slideNumber}: no visual reference is attached, so none was sent.`);
      continue;
    }
    if (ref.mapping === 'suggested') {
      note(`Slide ${slide.slideNumber}: the page match is not verified yet, so its image was not sent.`);
      continue;
    }
    if (out.length >= 40) {
      note('Visual reference limit reached (20 slides); remaining visuals were not sent.');
      break;
    }
    try {
      if ((ref.kind === 'pdf-page' || ref.kind === 'render') && ref.documentId && ref.pageNumber) {
        if (info?.pdfInput === false) {
          note(`Slide ${slide.slideNumber}: the selected model does not accept PDF pages; visual not sent.`);
          continue;
        }
        const doc = getDocumentRow(app.db, ref.documentId);
        if (!doc) continue;
        const page = await extractPdfPage(fs.readFileSync(app.storage.abs(doc.stored_path)), ref.pageNumber);
        bytes += page.length;
        out.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: page.toString('base64') }, title: `Slide ${slide.slideNumber} (${slide.id})` });
        out.push({ type: 'text', text: `The document above is the visual reference for slide ${slide.slideNumber} (${slide.id}).` });
      } else if (ref.kind === 'image' && ref.assetId) {
        if (info?.imageInput === false) {
          note(`Slide ${slide.slideNumber}: the selected model does not accept images; visual not sent.`);
          continue;
        }
        const row = getAssetRow(app.db, ref.assetId);
        const { file } = assetFile(app, row, 'display');
        const png = await sharp(fs.readFileSync(file)).resize({ width: 1568, height: 1568, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
        bytes += png.length;
        out.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') } });
        out.push({ type: 'text', text: `The image above is the visual reference for slide ${slide.slideNumber} (${slide.id}).` });
      }
      if (bytes > 18 * 1024 * 1024) {
        note('Visual references reached the request size budget; remaining visuals were not sent.');
        break;
      }
    } catch (err) {
      note(`Slide ${slide.slideNumber}: the visual reference could not be prepared (${(err as Error).message}).`);
    }
  }
  if (out.length > 0) note(`Sending ${out.length / 2} authorized visual reference(s).`);
  return out;
}
