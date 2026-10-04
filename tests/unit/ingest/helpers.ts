import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import sharp from 'sharp';
import { expect } from 'vitest';
import { esc } from '../../../fixtures/scripts/pptx-builder.ts';
import { extractPptx, PptxRejection, type PptxLimits, type PptxResult } from '../../../server/src/ingest/pptx.ts';

/** Shared helpers for the ingestion unit tests. Nothing here touches the network. */

export const MB = 1024 * 1024;

/** Mirrors the defaults in server/src/config.ts (MAX_SLIDES, MAX_ZIP_ENTRIES, …). */
export const DEFAULT_LIMITS: PptxLimits = {
  maxSlides: 80,
  maxEntries: 4000,
  maxExpandedBytes: 300 * MB,
  maxXmlBytes: 8 * MB,
  maxAssetBytes: 25 * MB,
};

/** Mirrors MAX_ASSET_MB / MAX_IMAGE_MEGAPIXELS defaults. */
export const MEDIA_LIMITS = { maxBytes: 25 * MB, maxPixels: 50_000_000 };

export const SAMPLE_DECK_PATH = fileURLToPath(new URL('../../../fixtures/sample/air-traffic-control.pptx', import.meta.url));

export function must<T>(value: T | null | undefined, what = 'value'): T {
  if (value === null || value === undefined) throw new Error(`Expected ${what} to be present`);
  return value;
}

/**
 * Await `work` and return the error it rejects with, asserting its class.
 * Fails the test if the work succeeds.
 */
export async function rejectionOf<E extends Error>(work: Promise<unknown> | (() => unknown), ctor: abstract new (...args: any[]) => E): Promise<E> {
  try {
    await (typeof work === 'function' ? work() : work);
  } catch (err) {
    expect(err).toBeInstanceOf(ctor);
    return err as E;
  }
  throw new Error(`Expected the operation to fail with ${ctor.name}, but it succeeded`);
}

/**
 * A private directory under os.tmpdir(), created lazily on first use (so suites
 * skipped by a name filter never leave an empty directory behind). Every
 * written file gets its own sub-directory so names can repeat.
 */
export class TempDir {
  private created: string | null = null;
  private counter = 0;

  constructor(private readonly prefix = 'nexus-ingest-test-') {}

  get dir(): string {
    this.created ??= fs.mkdtempSync(path.join(os.tmpdir(), this.prefix));
    return this.created;
  }

  write(name: string, data: Buffer | string): string {
    const sub = path.join(this.dir, String(++this.counter));
    fs.mkdirSync(sub);
    const file = path.join(sub, name);
    fs.writeFileSync(file, data);
    return file;
  }

  cleanup(): void {
    if (this.created) fs.rmSync(this.created, { recursive: true, force: true });
    this.created = null;
  }
}

export interface ExtractOptions {
  /** Original upload name (only the extension matters to the importer). */
  name?: string;
  limits?: Partial<PptxLimits>;
  onProgress?: (message: string) => void;
}

/** Writes decks to a temp dir, runs extractPptx and keeps track of open packages so they are always closed. */
export class DeckHarness {
  readonly tmp = new TempDir('nexus-pptx-test-');
  private readonly open: PptxResult[] = [];

  async extract(buf: Buffer, opts: ExtractOptions = {}): Promise<PptxResult> {
    const name = opts.name ?? 'deck.pptx';
    const file = this.tmp.write(name, buf);
    const result = await extractPptx(file, name, { ...DEFAULT_LIMITS, ...opts.limits }, opts.onProgress);
    this.open.push(result);
    return result;
  }

  async extractFile(file: string, opts: ExtractOptions = {}): Promise<PptxResult> {
    const result = await extractPptx(file, opts.name ?? path.basename(file), { ...DEFAULT_LIMITS, ...opts.limits }, opts.onProgress);
    this.open.push(result);
    return result;
  }

  /** Expect the deck to be rejected; returns the PptxRejection for further assertions. */
  async rejection(buf: Buffer, opts: ExtractOptions = {}): Promise<PptxRejection> {
    const err = await rejectionOf(this.extract(buf, opts), PptxRejection);
    expect(err.hint.length).toBeGreaterThan(0);
    return err;
  }

  closeAll(): void {
    for (const r of this.open.splice(0)) r.close();
  }

  dispose(): void {
    this.closeAll();
    this.tmp.cleanup();
  }
}

// ───────────── hand-written OOXML fragments ─────────────

export const NS = {
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  p: 'http://schemas.openxmlformats.org/presentationml/2006/main',
  mc: 'http://schemas.openxmlformats.org/markup-compatibility/2006',
  a14: 'http://schemas.microsoft.com/office/drawing/2010/main',
  p14: 'http://schemas.microsoft.com/office/powerpoint/2010/main',
  m: 'http://schemas.openxmlformats.org/officeDocument/2006/math',
  rel: 'http://schemas.openxmlformats.org/package/2006/relationships',
  ct: 'http://schemas.openxmlformats.org/package/2006/content-types',
  dgm: 'http://schemas.openxmlformats.org/drawingml/2006/diagram',
  c: 'http://schemas.openxmlformats.org/drawingml/2006/chart',
};
export const REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
export const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NSDECL = `xmlns:a="${NS.a}" xmlns:r="${NS.r}" xmlns:p="${NS.p}"`;

export type Box = [x: number, y: number, w: number, h: number];

export interface RelSpec {
  id: string;
  /** Suffix of the relationship type URI, e.g. "image", "slideLayout", "hyperlink". */
  type: string;
  target: string;
  external?: boolean;
}

export function relsXml(list: RelSpec[]): string {
  const body = list
    .map((r) => `<Relationship Id="${r.id}" Type="${REL_TYPE}/${r.type}" Target="${esc(r.target)}"${r.external ? ' TargetMode="External"' : ''}/>`)
    .join('');
  return `${XML_DECL}<Relationships xmlns="${NS.rel}">${body}</Relationships>`;
}

function xfrm(box: Box, tag = 'a:xfrm'): string {
  const [x, y, w, h] = box;
  return `<${tag}><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></${tag}>`;
}

function paragraph(text: string): string {
  return `<a:p><a:r><a:rPr lang="en-US" dirty="0"/><a:t>${esc(text)}</a:t></a:r></a:p>`;
}

/** A p:sp text shape. `ph` is the inner XML of p:nvPr (e.g. '<p:ph type="title"/>'). */
export function textShape(o: { id: number; name: string; paragraphs: string[]; box?: Box; ph?: string; runXml?: string }): string {
  const body = o.runXml ?? o.paragraphs.map(paragraph).join('');
  return `<p:sp><p:nvSpPr><p:cNvPr id="${o.id}" name="${esc(o.name)}"/><p:cNvSpPr/><p:nvPr>${o.ph ?? ''}</p:nvPr></p:nvSpPr><p:spPr>${o.box ? xfrm(o.box) : ''}</p:spPr><p:txBody><a:bodyPr/><a:lstStyle/>${body}</p:txBody></p:sp>`;
}

/** A p:pic referencing an image relationship (r:embed by default, or r:link). */
export function pictureShape(o: { id: number; name: string; rid: string; descr?: string; box?: Box; attr?: 'r:embed' | 'r:link'; nvPr?: string }): string {
  return `<p:pic><p:nvPicPr><p:cNvPr id="${o.id}" name="${esc(o.name)}" descr="${esc(o.descr ?? '')}"/><p:cNvPicPr/><p:nvPr>${o.nvPr ?? ''}</p:nvPr></p:nvPicPr><p:blipFill><a:blip ${o.attr ?? 'r:embed'}="${o.rid}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>${o.box ? xfrm(o.box) : ''}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`;
}

export function tableShape(o: { id: number; name: string; rows: string[][]; box: Box }): string {
  const cols = o.rows[0]?.length ?? 1;
  const grid = Array.from({ length: cols }, () => `<a:gridCol w="${Math.floor(o.box[2] / cols)}"/>`).join('');
  const trs = o.rows
    .map((r) => `<a:tr h="${Math.floor(o.box[3] / o.rows.length)}">${r.map((c) => `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/>${paragraph(c)}</a:txBody><a:tcPr/></a:tc>`).join('')}</a:tr>`)
    .join('');
  return `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${o.id}" name="${esc(o.name)}"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>${xfrm(o.box, 'p:xfrm')}<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr/><a:tblGrid>${grid}</a:tblGrid>${trs}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
}

/** A graphic frame with arbitrary graphicData content. */
export function graphicFrame(o: { id: number; name: string; box: Box; uri: string; inner: string }): string {
  return `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${o.id}" name="${esc(o.name)}"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>${xfrm(o.box, 'p:xfrm')}<a:graphic><a:graphicData uri="${o.uri}">${o.inner}</a:graphicData></a:graphic></p:graphicFrame>`;
}

/** A p:grpSp whose children live in the chOff/chExt coordinate space. */
export function groupShape(o: { id: number; off: [number, number]; ext: [number, number]; chOff: [number, number]; chExt: [number, number]; children: string }): string {
  return `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="${o.id}" name="Group ${o.id}"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="${o.off[0]}" y="${o.off[1]}"/><a:ext cx="${o.ext[0]}" cy="${o.ext[1]}"/><a:chOff x="${o.chOff[0]}" y="${o.chOff[1]}"/><a:chExt cx="${o.chExt[0]}" cy="${o.chExt[1]}"/></a:xfrm></p:grpSpPr>${o.children}</p:grpSp>`;
}

/** A complete p:sld part. `tail` is appended after p:clrMapOvr (e.g. p:timing). */
export function slideXml(shapes: string, opts: { show?: string; tail?: string } = {}): string {
  const root = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>';
  return `${XML_DECL}<p:sld ${NSDECL}${opts.show !== undefined ? ` show="${opts.show}"` : ''}><p:cSld><p:spTree>${root}${shapes}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>${opts.tail ?? ''}</p:sld>`;
}

/** A notes slide whose spTree is given verbatim. */
export function notesXml(shapes: string): string {
  const root = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>';
  return `${XML_DECL}<p:notes ${NSDECL}><p:cSld><p:spTree>${root}${shapes}</p:spTree></p:cSld></p:notes>`;
}

/** presentation.xml with an explicit p:sldIdLst (and optional slide size; null omits p:sldSz). */
export function presentationXml(sldIds: Array<{ id: number; rid: string }>, sldSz: { cx: number; cy: number } | null = { cx: 12192000, cy: 6858000 }): string {
  const ids = sldIds.map((s) => `<p:sldId id="${s.id}" r:id="${s.rid}"/>`).join('');
  return `${XML_DECL}<p:presentation ${NSDECL}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${ids}</p:sldIdLst>${sldSz ? `<p:sldSz cx="${sldSz.cx}" cy="${sldSz.cy}"/>` : ''}<p:notesSz cx="6858000" cy="9144000"/></p:presentation>`;
}

/** The presentation-level relationships the builder writes for `partNumbers` (rId100+i → slide part), without notes. */
export function presentationRels(slides: Array<{ rid: string; target: string; type?: string; external?: boolean }>): string {
  return relsXml([
    { id: 'rId1', type: 'slideMaster', target: 'slideMasters/slideMaster1.xml' },
    ...slides.map((s) => ({ id: s.rid, type: s.type ?? 'slide', target: s.target, external: s.external ?? false })),
    { id: 'rId3', type: 'theme', target: 'theme/theme1.xml' },
  ]);
}

// ───────────── media fixtures ─────────────

export async function solidPng(width: number, height: number, alpha = 1): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 4, background: { r: 30, g: 95, b: 173, alpha } } })
    .png()
    .toBuffer();
}

export async function solidJpeg(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 217, g: 72, b: 15 } } })
    .jpeg()
    .toBuffer();
}

/** Rewrite a PNG's IHDR width/height (and its CRC) without touching the pixel data — a decompression-bomb header. */
export function forgePngDimensions(png: Buffer, width: number, height: number): Buffer {
  const out = Buffer.from(png);
  if (out.toString('latin1', 12, 16) !== 'IHDR') throw new Error('Not a PNG with a leading IHDR chunk');
  out.writeUInt32BE(width, 16);
  out.writeUInt32BE(height, 20);
  out.writeUInt32BE(zlib.crc32(out.subarray(12, 29)) >>> 0, 29);
  return out;
}

/** The 8-byte Compound File Binary (OLE2) signature followed by padding — what legacy .ppt and encrypted .pptx files look like. */
export function compoundFile(size = 1536): Buffer {
  const buf = Buffer.alloc(size);
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(buf, 0);
  buf.writeUInt16LE(0x003e, 24); // minor version
  buf.writeUInt16LE(0x0003, 26); // major version
  buf.writeUInt16LE(0xfffe, 28); // byte order mark
  return buf;
}

/** A minimal PCM WAV file. */
export function wavFile(o: { sampleRate: number; channels: number; bitsPerSample: number; seconds: number }): Buffer {
  const blockAlign = (o.channels * o.bitsPerSample) / 8;
  const byteRate = o.sampleRate * blockAlign;
  const dataSize = Math.round(byteRate * o.seconds);
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0, 'latin1');
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8, 'latin1');
  buf.write('fmt ', 12, 'latin1');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(o.channels, 22);
  buf.writeUInt32LE(o.sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(o.bitsPerSample, 34);
  buf.write('data', 36, 'latin1');
  buf.writeUInt32LE(dataSize, 40);
  return buf;
}
