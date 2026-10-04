import sharp from 'sharp';
import { AUDIO_MIME, sniff, type SniffedType } from './sniff.ts';
import { parseXml, XmlRejection, type XNode } from './xml.ts';

type SharpMetadata = Awaited<ReturnType<ReturnType<typeof sharp>['metadata']>>;

/**
 * Validation and safe derivatives for uploaded or extracted media. Originals
 * are preserved by the caller; only the derivatives produced here are ever
 * displayed or exported:
 *  - raster images are re-encoded (strips EXIF/GPS metadata, keeps alpha);
 *  - SVG is screened and rasterized with librsvg — never inserted as markup;
 *  - pixel counts are capped before decoding to stop decompression bombs.
 */

export class MediaRejection extends Error {
  constructor(
    readonly code: 'unsupported-type' | 'too-large' | 'too-many-pixels' | 'unsafe-svg' | 'corrupt' | 'empty',
    message: string,
    readonly hint: string,
  ) {
    super(message);
  }
}

export interface ProcessedImage {
  kind: 'image';
  format: 'png' | 'jpeg' | 'webp' | 'gif' | 'tiff' | 'svg';
  originalMime: string;
  width: number;
  height: number;
  hasAlpha: boolean;
  display: { data: Buffer; mime: 'image/png' | 'image/jpeg' | 'image/webp'; ext: 'png' | 'jpg' | 'webp' };
  thumb: { data: Buffer; mime: 'image/webp' };
  rasterizedFromSvg: boolean;
}

export interface ProcessedAudio {
  kind: 'audio';
  format: 'mp3' | 'ogg' | 'wav' | 'm4a';
  originalMime: 'audio/mpeg' | 'audio/ogg' | 'audio/wav' | 'audio/mp4';
  durationSeconds: number | null;
  display: { data: Buffer; mime: 'audio/mpeg' | 'audio/ogg' | 'audio/wav' | 'audio/mp4'; ext: 'mp3' | 'ogg' | 'wav' | 'm4a' };
}

export interface MediaLimits {
  maxBytes: number;
  maxPixels: number;
}

const DISPLAY_MAX_EDGE = 4096;

const SAFE_REF = (v: string) => v.startsWith('#') || /^data:image\/(png|jpeg|jpg|gif|webp);base64,/i.test(v);
/** url(...) that does not point inside this document (#id), quoted or not. */
const EXTERNAL_URL = /url\(\s*(?!["']?\s*#)/i;
const BLOCKED_ELEMENTS = new Set(['script', 'foreignobject', 'iframe', 'object', 'embed', 'handler', 'listener', 'animation', 'audio', 'video']);

/**
 * Reject SVG features that could execute code or load external resources.
 * Two layers: a fast text screen, then a namespace-aware walk of the parsed
 * tree (so prefixed elements such as <s:script> cannot slip through).
 */
export function screenSvg(text: string): string | null {
  const lower = text.toLowerCase();
  if (/<!doctype|<!entity/.test(lower)) return 'SVG contains a DOCTYPE or entity declarations.';
  if (/<(?:[\w.-]+:)?script[\s/>]/.test(lower)) return 'SVG contains scripts.';
  if (/<(?:[\w.-]+:)?foreignobject[\s/>]/.test(lower)) return 'SVG contains embedded HTML (foreignObject).';
  if (/\s(?:[\w.-]+:)?on[a-z]+\s*=/.test(lower)) return 'SVG contains event handler attributes.';
  if (/javascript:/.test(lower)) return 'SVG contains a javascript: URL.';
  const hrefs = [...text.matchAll(/(?:[\w.-]+:)?href\s*=\s*["']([^"']*)["']/gi)].map((m) => m[1]!.trim());
  if (hrefs.some((h) => !SAFE_REF(h))) return 'SVG references an external file or URL.';
  if (EXTERNAL_URL.test(text)) return 'SVG styles reference an external resource.';
  if (/@import/i.test(text)) return 'SVG styles import external resources.';
  return screenSvgTree(text);
}

function screenSvgTree(text: string): string | null {
  let root: XNode;
  try {
    root = parseXml(Buffer.from(text, 'utf8'), { maxBytes: 16 * 1024 * 1024, maxNodes: 200_000 });
  } catch (err) {
    if (err instanceof XmlRejection && err.code === 'xml-dtd') return 'SVG contains a DOCTYPE or entity declarations.';
    return `SVG could not be read safely (${(err as Error).message}).`;
  }
  const local = (name: string) => name.slice(name.lastIndexOf(':') + 1).toLowerCase();
  if (local(root.name) !== 'svg') return 'The file is not an SVG document.';
  const walk = (node: XNode): string | null => {
    const el = local(node.name);
    if (BLOCKED_ELEMENTS.has(el)) return `SVG contains a <${el}> element.`;
    for (const [name, value] of Object.entries(node.attrs)) {
      const attr = local(name);
      if (attr.startsWith('on')) return 'SVG contains event handler attributes.';
      if ((attr === 'href' || attr === 'src') && !SAFE_REF(value.trim())) return 'SVG references an external file or URL.';
      if (/javascript:/i.test(value)) return 'SVG contains a javascript: URL.';
      if (EXTERNAL_URL.test(value) || /@import/i.test(value)) return 'SVG styles reference an external resource.';
    }
    for (const child of node.children) {
      if (typeof child === 'string') {
        if (el === 'style' && (EXTERNAL_URL.test(child) || /@import/i.test(child))) return 'SVG styles reference an external resource.';
        continue;
      }
      const problem = walk(child);
      if (problem) return problem;
    }
    return null;
  };
  return walk(root);
}

async function thumbnail(input: Buffer, maxPixels: number): Promise<Buffer> {
  return sharp(input, { limitInputPixels: maxPixels })
    .resize({ width: 480, height: 480, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 82, alphaQuality: 100 })
    .toBuffer();
}

export async function processImage(buf: Buffer, limits: MediaLimits, sniffed: SniffedType = sniff(buf)): Promise<ProcessedImage> {
  if (buf.length === 0) throw new MediaRejection('empty', 'The file is empty.', 'Choose the image file again.');
  if (buf.length > limits.maxBytes) {
    throw new MediaRejection('too-large', `The image is ${(buf.length / 1048576).toFixed(1)} MB; the limit is ${Math.round(limits.maxBytes / 1048576)} MB.`, 'Export a smaller PNG, JPEG or WebP.');
  }

  if (sniffed === 'svg') {
    const text = buf.toString('utf8');
    const problem = screenSvg(text);
    if (problem) throw new MediaRejection('unsafe-svg', problem, 'Export the artwork as PNG instead, or remove scripts and external references from the SVG.');
    let png: Buffer;
    let meta: SharpMetadata;
    try {
      // Rasterize at a size suitable for a 1920×1080 stage. The probe only reads the
      // declared size (no pixels), so a large canvas is scaled DOWN rather than refused;
      // the render itself stays under the pixel limit.
      const probe = await sharp(buf, { limitInputPixels: false }).metadata();
      const longEdge = Math.max(probe.width ?? 512, probe.height ?? 512, 1);
      const density = Math.max(1, Math.min(72 * (2048 / longEdge), 600));
      png = await sharp(buf, { density, limitInputPixels: limits.maxPixels })
        .resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: false })
        .png()
        .toBuffer();
      meta = await sharp(png).metadata();
    } catch (err) {
      const msg = (err as Error).message;
      if (/pixel limit/i.test(msg)) {
        throw new MediaRejection('too-many-pixels', `The SVG is too large to render within ${Math.round(limits.maxPixels / 1e6)} megapixels.`, 'Export the artwork as PNG instead.');
      }
      throw new MediaRejection('corrupt', `The SVG could not be rendered: ${msg}`, 'Export the artwork as PNG instead.');
    }
    return {
      kind: 'image',
      format: 'svg',
      originalMime: 'image/svg+xml',
      width: meta.width ?? 0,
      height: meta.height ?? 0,
      hasAlpha: meta.hasAlpha ?? true,
      display: { data: png, mime: 'image/png', ext: 'png' },
      thumb: { data: await thumbnail(png, limits.maxPixels), mime: 'image/webp' },
      rasterizedFromSvg: true,
    };
  }

  const supported: Record<string, ProcessedImage['format']> = { png: 'png', jpeg: 'jpeg', webp: 'webp', gif: 'gif', tiff: 'tiff' };
  const format = supported[sniffed];
  if (!format) {
    const named = sniffed === 'unknown' ? 'This file type' : sniffed.toUpperCase();
    throw new MediaRejection('unsupported-type', `${named} is not a supported image format.`, 'Use PNG, JPEG, WebP or SVG.');
  }

  let meta: SharpMetadata;
  try {
    meta = await sharp(buf, { limitInputPixels: limits.maxPixels }).metadata();
  } catch (err) {
    const msg = (err as Error).message;
    if (/pixel limit/i.test(msg)) {
      throw new MediaRejection('too-many-pixels', `The image exceeds ${Math.round(limits.maxPixels / 1e6)} megapixels.`, 'Resize the image before uploading.');
    }
    throw new MediaRejection('corrupt', 'The image could not be decoded (it may be damaged).', 'Re-export the image and try again.');
  }
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (!width || !height) throw new MediaRejection('corrupt', 'The image has no dimensions.', 'Re-export the image and try again.');
  if (width * height > limits.maxPixels) {
    throw new MediaRejection('too-many-pixels', `The image is ${width}×${height}, above the ${Math.round(limits.maxPixels / 1e6)} megapixel limit.`, 'Resize the image before uploading.');
  }
  const hasAlpha = Boolean(meta.hasAlpha);

  let pipeline = sharp(buf, { limitInputPixels: limits.maxPixels, animated: false }).rotate();
  if (Math.max(width, height) > DISPLAY_MAX_EDGE) pipeline = pipeline.resize({ width: DISPLAY_MAX_EDGE, height: DISPLAY_MAX_EDGE, fit: 'inside' });
  let display: ProcessedImage['display'];
  try {
    if (format === 'jpeg' && !hasAlpha) display = { data: await pipeline.jpeg({ quality: 92, mozjpeg: true }).toBuffer(), mime: 'image/jpeg', ext: 'jpg' };
    else if (format === 'webp') display = { data: await pipeline.webp({ quality: 92, alphaQuality: 100 }).toBuffer(), mime: 'image/webp', ext: 'webp' };
    else display = { data: await pipeline.png({ compressionLevel: 9 }).toBuffer(), mime: 'image/png', ext: 'png' };
  } catch {
    throw new MediaRejection('corrupt', 'The image could not be re-encoded safely.', 'Re-export the image as PNG and try again.');
  }
  const outMeta = await sharp(display.data).metadata();
  return {
    kind: 'image',
    format,
    originalMime: format === 'jpeg' ? 'image/jpeg' : `image/${format}`,
    width: outMeta.width ?? width,
    height: outMeta.height ?? height,
    hasAlpha,
    display,
    thumb: { data: await thumbnail(display.data, limits.maxPixels), mime: 'image/webp' },
    rasterizedFromSvg: false,
  };
}

function wavDuration(buf: Buffer): number | null {
  // Walk RIFF chunks for "fmt " (byte rate) and "data" (size).
  let byteRate = 0;
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('latin1', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === 'fmt ' && offset + 16 <= buf.length) byteRate = buf.readUInt32LE(offset + 16);
    if (id === 'data') return byteRate > 0 ? Math.round((size / byteRate) * 100) / 100 : null;
    offset += 8 + size + (size % 2);
  }
  return null;
}

export function processAudio(buf: Buffer, limits: MediaLimits, sniffed: SniffedType = sniff(buf)): ProcessedAudio {
  if (buf.length === 0) throw new MediaRejection('empty', 'The file is empty.', 'Choose the audio file again.');
  if (buf.length > limits.maxBytes) {
    throw new MediaRejection('too-large', `The audio file is ${(buf.length / 1048576).toFixed(1)} MB; the limit is ${Math.round(limits.maxBytes / 1048576)} MB.`, 'Use a shorter clip or a compressed format such as MP3.');
  }
  const mime = AUDIO_MIME[sniffed];
  if (!mime) throw new MediaRejection('unsupported-type', 'This is not a supported audio format.', 'Use MP3, OGG, WAV or M4A.');
  const format = sniffed as ProcessedAudio['format'];
  const ext = format;
  return {
    kind: 'audio',
    format,
    originalMime: mime,
    durationSeconds: format === 'wav' ? wavDuration(buf) : null,
    display: { data: buf, mime, ext },
  };
}
