import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import type { ExtractionWarningCode } from '@shared/schemas/source.ts';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildPptx, type SlideSpec } from '../../../fixtures/scripts/pptx-builder.ts';
import type { RawEntry } from '../../../fixtures/scripts/zip-writer.ts';
import { ZipRejection } from '../../../server/src/ingest/zip.ts';
import type { ExtractedSlide, PptxResult } from '../../../server/src/ingest/pptx.ts';
import {
  DeckHarness,
  graphicFrame,
  groupShape,
  must,
  notesXml,
  NS,
  pictureShape,
  presentationXml,
  rejectionOf,
  relsXml,
  slideXml,
  solidPng,
  tableShape,
  textShape,
  type Box,
  type RelSpec,
} from './helpers.ts';

const harness = new DeckHarness();
afterEach(() => harness.closeAll());
afterAll(() => harness.dispose());

let png: Buffer;
beforeAll(async () => {
  png = await solidPng(64, 48);
});

const LAYOUT_REL: RelSpec = { id: 'rId1', type: 'slideLayout', target: '../slideLayouts/slideLayout2.xml' };
const BOX: Box = [838200, 1825625, 5000000, 1000000];

interface CustomSlide {
  xml: string;
  rels?: RelSpec[];
  /** Replace the default layout relationship (pass [] for a slide without one). */
  ownRels?: RelSpec[];
}

/** A deck whose slide parts (slide1.xml…) and their relationships are written by hand. */
function customDeck(slides: CustomSlide[], opts: { entries?: RawEntry[]; contentTypes?: string; replace?: Record<string, string> } = {}): Buffer {
  const specs: SlideSpec[] = slides.map((_, i) => ({ partNumber: i + 1, layout: 'content', title: `Slide ${i + 1}` }));
  const replace: Record<string, string> = { ...opts.replace };
  slides.forEach((s, i) => {
    replace[`ppt/slides/slide${i + 1}.xml`] = s.xml;
    replace[`ppt/slides/_rels/slide${i + 1}.xml.rels`] = relsXml(s.ownRels ?? [LAYOUT_REL, ...(s.rels ?? [])]);
  });
  return buildPptx({ slides: specs, replaceEntries: replace, extraEntries: opts.entries, extraContentTypes: opts.contentTypes });
}

function slideOf(deck: PptxResult, n: number): ExtractedSlide {
  return must(deck.slides.find((s) => s.slideNumber === n), `slide ${n}`);
}

function codes(s: ExtractedSlide): ExtractionWarningCode[] {
  return s.extract.warnings.map((w) => w.code);
}

function warning(s: ExtractedSlide, code: ExtractionWarningCode) {
  return must(s.extract.warnings.find((w) => w.code === code), `${code} warning on slide ${s.slideNumber}`);
}

function texts(s: ExtractedSlide): string[] {
  return s.extract.blocks.flatMap((b) => b.paragraphs.map((p) => p.text));
}

const mathXml = (inner: string) => `<a14:m xmlns:a14="${NS.a14}"><m:oMathPara xmlns:m="${NS.m}"><m:oMath>${inner}</m:oMath></m:oMathPara></a14:m>`;
const HALF = '<m:f><m:num><m:r><m:t>1</m:t></m:r></m:num><m:den><m:r><m:t>2</m:t></m:r></m:den></m:f>';

describe('slide order and package metadata', () => {
  it('follows p:sldIdLst even when it disagrees with file names, relationship ids and ZIP order', async () => {
    const buf = buildPptx({
      slides: [1, 2, 3].map((n) => ({ partNumber: n, layout: 'content' as const, title: `Part ${n}` })),
      // Builder wires rId100→slide1, rId101→slide2, rId102→slide3; list them 3, 1, 2.
      replaceEntries: { 'ppt/presentation.xml': presentationXml([{ id: 300, rid: 'rId102' }, { id: 301, rid: 'rId100' }, { id: 302, rid: 'rId101' }]) },
    });
    const deck = await harness.extract(buf);
    expect(deck.slides.map((s) => s.extract.title)).toEqual(['Part 3', 'Part 1', 'Part 2']);
    expect(deck.slides.map((s) => s.partName)).toEqual(['ppt/slides/slide3.xml', 'ppt/slides/slide1.xml', 'ppt/slides/slide2.xml']);
    expect(deck.slides.map((s) => s.pptxSlideId)).toEqual([300, 301, 302]);
    expect(deck.slides.map((s) => s.slideNumber)).toEqual([1, 2, 3]);
  });

  it('follows the builder order option (high part numbers first)', async () => {
    const deck = await harness.extract(
      buildPptx({ slides: [7, 12, 2].map((n) => ({ partNumber: n, layout: 'content' as const, title: `Part ${n}` })), order: [12, 2, 7] }),
    );
    expect(deck.slides.map((s) => s.extract.title)).toEqual(['Part 12', 'Part 2', 'Part 7']);
  });

  it('uses the declared slide size for normalized bounds', async () => {
    const deck = await harness.extract(
      customDeck([{ xml: slideXml(textShape({ id: 2, name: 'Box', paragraphs: ['Hi'], box: [914400, 685800, 4572000, 3429000] })) }], {
        replace: { 'ppt/presentation.xml': presentationXml([{ id: 256, rid: 'rId100' }], { cx: 9144000, cy: 6858000 }) },
      }),
    );
    expect(deck.slideSize).toEqual({ cx: 9144000, cy: 6858000 });
    expect(deck.slides[0]?.extract.blocks[0]?.bounds).toMatchObject({ nx: 0.1, ny: 0.1, nw: 0.5, nh: 0.5 });
  });

  it('assumes 16:9 and says so when the slide size is missing', async () => {
    const deck = await harness.extract(
      customDeck([{ xml: slideXml(textShape({ id: 2, name: 'Box', paragraphs: ['Hi'], box: BOX })) }], {
        replace: { 'ppt/presentation.xml': presentationXml([{ id: 256, rid: 'rId100' }], null) },
      }),
    );
    expect(deck.slideSize).toEqual({ cx: 12192000, cy: 6858000 });
    expect(deck.packageWarnings).toContain('Slide size missing; assumed 16:9.');
  });

  it('treats show="0" and show="false" as hidden', async () => {
    const shape = textShape({ id: 2, name: 'T', paragraphs: ['x'], box: BOX });
    const deck = await harness.extract(customDeck([{ xml: slideXml(shape, { show: 'false' }) }, { xml: slideXml(shape, { show: '1' }) }, { xml: slideXml(shape, { show: '0' }) }]));
    expect(deck.slides.map((s) => s.hidden)).toEqual([true, false, true]);
  });
});

describe('text extraction', () => {
  it('separates titles, subtitles, body and free text; skips date, footer and slide-number placeholders', async () => {
    const xml = slideXml(
      textShape({ id: 2, name: 'Title 1', ph: '<p:ph type="title"/>', paragraphs: [], runXml: '<a:p><a:r><a:t>Line one</a:t></a:r><a:br/><a:r><a:t>Line two</a:t></a:r></a:p>' }) +
        textShape({ id: 3, name: 'Subtitle', ph: '<p:ph type="subTitle" idx="2"/>', paragraphs: ['A subtitle'], box: [838200, 1300000, 5000000, 400000] }) +
        textShape({
          id: 4,
          name: 'Body',
          ph: '<p:ph idx="1"/>',
          paragraphs: [],
          runXml:
            '<a:p><a:r><a:t>Bulleted by default</a:t></a:r></a:p>' +
            '<a:p><a:pPr lvl="2"><a:buNone/></a:pPr><a:r><a:t>No bullet, level 2</a:t></a:r></a:p>' +
            '<a:p><a:r><a:t>   </a:t></a:r></a:p>',
        }) +
        textShape({
          id: 5,
          name: 'Callout',
          paragraphs: [],
          box: [838200, 5000000, 5000000, 600000],
          runXml: '<a:p><a:r><a:t>Due:</a:t></a:r><a:r><a:t>  </a:t></a:r><a:fld id="{1}" type="datetime1"><a:t>10/3/2026</a:t></a:fld></a:p><a:p><a:pPr><a:buChar char="•"/></a:pPr><a:r><a:t>Explicit bullet</a:t></a:r></a:p>',
        }) +
        textShape({ id: 6, name: 'Footer', ph: '<p:ph type="ftr" sz="quarter" idx="11"/>', paragraphs: ['© Footer text'], box: BOX }) +
        textShape({ id: 7, name: 'Date', ph: '<p:ph type="dt" sz="half" idx="10"/>', paragraphs: ['3/10/2026 date'], box: BOX }) +
        textShape({ id: 8, name: 'Number', ph: '<p:ph type="sldNum" idx="12"/>', paragraphs: [], runXml: '<a:p><a:fld id="{2}" type="slidenum"><a:t>‹#› 42</a:t></a:fld></a:p>', box: BOX }),
    );
    const s = must((await harness.extract(customDeck([{ xml }]))).slides[0]);
    expect(s.extract.title).toBe('Line one Line two');
    expect(s.extract.blocks.map((b) => ({ role: b.role, name: b.shapeName, paragraphs: b.paragraphs }))).toEqual([
      { role: 'title', name: 'Title 1', paragraphs: [{ text: 'Line one\nLine two', level: 0, bullet: false }] },
      { role: 'subtitle', name: 'Subtitle', paragraphs: [{ text: 'A subtitle', level: 0, bullet: false }] },
      {
        role: 'body',
        name: 'Body',
        paragraphs: [
          { text: 'Bulleted by default', level: 0, bullet: true },
          { text: 'No bullet, level 2', level: 2, bullet: false },
        ],
      },
      {
        role: 'text',
        name: 'Callout',
        paragraphs: [
          { text: 'Due: 10/3/2026', level: 0, bullet: false },
          { text: 'Explicit bullet', level: 0, bullet: true },
        ],
      },
    ]);
    const allText = [...texts(s), s.extract.title, ...s.extract.notes].join('\n');
    expect(allText).not.toMatch(/Footer text|3\/10\/2026 date|‹#›/);
    expect(s.extract.blocks.map((b) => b.shapeName)).not.toEqual(expect.arrayContaining(['Footer', 'Date', 'Number']));
  });

  it('extracts table cells, blanking cells merged into a neighbour', async () => {
    const merged =
      `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="3" name="Merged table"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="0" y="0"/><a:ext cx="4000000" cy="800000"/></p:xfrm>` +
      `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblGrid><a:gridCol w="2000000"/><a:gridCol w="2000000"/></a:tblGrid>` +
      `<a:tr h="400000"><a:tc gridSpan="2"><a:txBody><a:bodyPr/><a:p><a:r><a:t>Spanning header</a:t></a:r></a:p></a:txBody></a:tc><a:tc hMerge="1"><a:txBody><a:bodyPr/><a:p><a:r><a:t>HIDDEN-H</a:t></a:r></a:p></a:txBody></a:tc></a:tr>` +
      `<a:tr h="400000"><a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>Left</a:t></a:r></a:p><a:p><a:r><a:t>second line</a:t></a:r></a:p></a:txBody></a:tc><a:tc vMerge="1"><a:txBody><a:bodyPr/><a:p><a:r><a:t>HIDDEN-V</a:t></a:r></a:p></a:txBody></a:tc></a:tr>` +
      `</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
    const s = must((await harness.extract(customDeck([{ xml: slideXml(merged) }]))).slides[0]);
    expect(s.extract.tables.map((t) => [t.shapeName, t.rows])).toEqual([
      [
        'Merged table',
        [
          ['Spanning header', ''],
          ['Left\nsecond line', ''],
        ],
      ],
    ]);
  });

  it('extracts equations from inline math, from mc:AlternateContent at shape level, and inside table cells', async () => {
    const inline = textShape({ id: 2, name: 'Inline', paragraphs: [], box: BOX, runXml: `<a:p><a:r><a:t>Half is</a:t></a:r>${mathXml(HALF)}</a:p>` });
    const alternate =
      `<mc:AlternateContent xmlns:mc="${NS.mc}"><mc:Choice xmlns:a14="${NS.a14}" Requires="a14">` +
      textShape({ id: 3, name: 'Math shape', paragraphs: [], box: [838200, 3000000, 5000000, 600000], runXml: `<a:p>${mathXml('<m:sSup><m:e><m:r><m:t>x</m:t></m:r></m:e><m:sup><m:r><m:t>2</m:t></m:r></m:sup></m:sSup>')}</a:p>` }) +
      `</mc:Choice><mc:Fallback>${textShape({ id: 3, name: 'Math picture fallback', paragraphs: ['FALLBACK-RENDERING'], box: BOX })}</mc:Fallback></mc:AlternateContent>`;
    const tableWithMath = tableShape({ id: 4, name: 'T', rows: [['placeholder']], box: [0, 5000000, 2000000, 400000] }).replace(
      '<a:t>placeholder</a:t></a:r></a:p>',
      `<a:t>Area:</a:t></a:r>${mathXml('<m:r><m:t>πr</m:t></m:r>')}</a:p>`,
    );
    const s = must((await harness.extract(customDeck([{ xml: slideXml(inline + alternate + tableWithMath) }]))).slides[0]);
    expect(s.extract.equations.map((e) => e.linear)).toEqual(['1/2', 'x^2', 'πr']);
    expect(texts(s)).toEqual(['Half is 1/2', 'x^2']);
    expect(s.extract.tables[0]?.rows).toEqual([['Area: πr']]);
    expect(JSON.stringify(s.extract)).not.toContain('FALLBACK-RENDERING');
    expect(codes(s)).toContain('equation');
  });

  it('uses the mc:Fallback branch for non-math alternate content', async () => {
    const alt =
      `<mc:AlternateContent xmlns:mc="${NS.mc}"><mc:Choice xmlns:p14="${NS.p14}" Requires="p14">${textShape({ id: 2, name: 'New', paragraphs: ['NEW-FEATURE'], box: BOX })}</mc:Choice>` +
      `<mc:Fallback>${textShape({ id: 2, name: 'Old', paragraphs: ['Fallback text'], box: BOX })}</mc:Fallback></mc:AlternateContent>`;
    const s = must((await harness.extract(customDeck([{ xml: slideXml(alt) }]))).slides[0]);
    expect(texts(s)).toEqual(['Fallback text']);
  });
});

describe('speaker notes', () => {
  it('reads notes through each slide\'s relationship, not by matching file numbers', async () => {
    const buf = buildPptx({
      slides: [
        { partNumber: 1, layout: 'content', title: 'One', notes: ['Notes written for slide one'] },
        { partNumber: 2, layout: 'content', title: 'Two', notes: ['Notes written for slide two'] },
        { partNumber: 3, layout: 'content', title: 'Three' },
      ],
      replaceEntries: {
        // Cross-wire the relationships: slide1 → notesSlide2, slide2 → notesSlide1.
        'ppt/slides/_rels/slide1.xml.rels': relsXml([LAYOUT_REL, { id: 'rId2', type: 'notesSlide', target: '../notesSlides/notesSlide2.xml' }]),
        'ppt/slides/_rels/slide2.xml.rels': relsXml([LAYOUT_REL, { id: 'rId2', type: 'notesSlide', target: '../notesSlides/notesSlide1.xml' }]),
      },
      // An orphan notes part named after slide 3 must not be attached to it.
      extraEntries: [{ name: 'ppt/notesSlides/notesSlide3.xml', data: notesXml(textShape({ id: 2, name: 'Notes', ph: '<p:ph type="body" idx="1"/>', paragraphs: ['ORPHAN NOTES'] })) }],
    });
    const deck = await harness.extract(buf);
    expect(deck.slides.map((s) => s.extract.notes)).toEqual([['Notes written for slide two'], ['Notes written for slide one'], []]);
  });

  it('keeps only the notes body placeholder (not the slide image, header or slide number)', async () => {
    const notes = notesXml(
      textShape({ id: 2, name: 'Slide Image', ph: '<p:ph type="sldImg"/>', paragraphs: [] }) +
        textShape({ id: 3, name: 'Header', ph: '<p:ph type="hdr" idx="1"/>', paragraphs: ['HEADER-TEXT'] }) +
        textShape({
          id: 4,
          name: 'Notes Placeholder',
          ph: '<p:ph type="body" idx="2"/>',
          paragraphs: [],
          runXml: '<a:p><a:r><a:t>Ask the class first.</a:t></a:r></a:p><a:p><a:r><a:t>Then</a:t></a:r><a:br/><a:r><a:t>reveal.</a:t></a:r></a:p><a:p/>',
        }) +
        textShape({ id: 5, name: 'Number', ph: '<p:ph type="sldNum" idx="3"/>', paragraphs: ['99'] }),
    );
    const buf = buildPptx({
      slides: [{ partNumber: 1, layout: 'content', title: 'One', notes: ['placeholder'] }],
      replaceEntries: { 'ppt/notesSlides/notesSlide1.xml': notes },
    });
    const s = must((await harness.extract(buf)).slides[0]);
    expect(s.extract.notes).toEqual(['Ask the class first.', 'Then\nreveal.']);
  });

  it('truncates enormous speaker notes and says so', async () => {
    const lines = Array.from({ length: 50 }, (_, i) => `Note ${i} ${'x'.repeat(1000)}`);
    const s = must((await harness.extract(buildPptx({ slides: [{ partNumber: 1, layout: 'content', title: 'Long', notes: lines }] }))).slides[0]);
    expect(s.extract.notes).toHaveLength(40);
    expect(s.extract.notes[0]).toBe(lines[0]);
    expect(warning(s, 'truncated').severity).toBe('warning');
  });
});

describe('extraction warnings', () => {
  let deck: PptxResult;
  const keep = new DeckHarness();
  beforeAll(async () => {
    deck = await keep.extract(
      buildPptx({
        slides: [
          { partNumber: 1, layout: 'content', title: 'Chart', chartTitle: 'Rainfall by month' },
          { partNumber: 2, layout: 'content', title: 'SmartArt', smartArt: ['Plan', 'Fly', 'Land'] },
          { partNumber: 3, layout: 'content', title: 'Animated', bullets: ['First', 'Second'], animate: true },
          { partNumber: 4, layout: 'content', title: 'Vector', emfImage: true },
          {
            partNumber: 5,
            layout: 'content',
            title: 'Shuffled',
            textBoxes: [
              { text: 'Read me second', x: 838200, y: 4500000, w: 4000000, h: 500000 },
              { text: 'Read me first', x: 838200, y: 1900000, w: 4000000, h: 500000 },
            ],
          },
          {
            partNumber: 6,
            layout: 'content',
            title: 'Ordered',
            textBoxes: [
              { text: 'Top left', x: 838200, y: 1900000, w: 3000000, h: 500000 },
              { text: 'Top right (slightly higher)', x: 6000000, y: 1850000, w: 3000000, h: 500000 },
              { text: 'Bottom', x: 838200, y: 4500000, w: 4000000, h: 500000 },
            ],
          },
          { partNumber: 7, layout: 'content' },
        ],
      }),
    );
  });
  afterAll(() => keep.dispose());

  it('warns that chart data is not extracted, naming the chart', () => {
    const s = slideOf(deck, 1);
    const w = warning(s, 'chart');
    expect(w.severity).toBe('warning');
    expect(w.message).toContain('Rainfall by month');
    expect(texts(s)).toEqual(['Chart']);
  });

  it('extracts SmartArt node text (not the document node) and warns that its layout is lost', () => {
    const s = slideOf(deck, 2);
    expect(warning(s, 'smartart').severity).toBe('warning');
    const smart = must(s.extract.blocks.find((b) => b.role === 'smartart'));
    expect(smart.paragraphs).toEqual([
      { text: 'Plan', level: 0, bullet: true },
      { text: 'Fly', level: 0, bullet: true },
      { text: 'Land', level: 0, bullet: true },
    ]);
    expect(smart.bounds).toMatchObject({ x: 0, y: 3000000, w: 6000000, h: 3000000 });
  });

  it('warns about animations with the effect count', () => {
    const w = warning(slideOf(deck, 3), 'animation');
    expect(w.severity).toBe('warning');
    expect(w.message).toContain('1 effect');
  });

  it('flags EMF pictures as unsupported but still records them', () => {
    const s = slideOf(deck, 4);
    const w = warning(s, 'unsupported-image');
    expect(w.severity).toBe('warning');
    expect(w.message).toContain('EMF');
    expect(s.extract.images).toEqual([expect.objectContaining({ partName: 'ppt/media/vector4.emf', contentType: 'image/x-emf', supported: false, altText: 'vector diagram' })]);
    expect(deck.media.get('ppt/media/vector4.emf')?.contentType).toBe('image/x-emf');
  });

  it('warns when shape order differs from top-to-bottom visual order', () => {
    const s = slideOf(deck, 5);
    expect(texts(s)).toEqual(['Shuffled', 'Read me second', 'Read me first']);
    expect(warning(s, 'reading-order').severity).toBe('info');
  });

  it('does not warn when shape order already matches visual order (same-row shapes read left to right)', () => {
    expect(codes(slideOf(deck, 6))).not.toContain('reading-order');
  });

  it('flags slides with nothing to extract', () => {
    const s = slideOf(deck, 7);
    expect(s.extract.title).toBe('');
    expect(warning(s, 'empty-slide').severity).toBe('info');
  });

  it('warns about video/audio, embedded OLE objects, ink and unknown graphic frames', async () => {
    const video = slideXml(pictureShape({ id: 2, name: 'Video', rid: 'rId2', box: BOX, nvPr: '<a:videoFile r:link="rId3"/>' }));
    const ole = slideXml(graphicFrame({ id: 2, name: 'Sheet', box: BOX, uri: 'http://schemas.openxmlformats.org/presentationml/2006/ole', inner: '<p:oleObj progId="Excel.Sheet.12" r:id="rId2"/>' }));
    const ink = slideXml('<p:contentPart r:id="rId2"/>');
    const unknown = slideXml(graphicFrame({ id: 2, name: 'Thing', box: BOX, uri: 'urn:example:unknown-frame', inner: '<x:thing xmlns:x="urn:example"/>' }));
    const d = await harness.extract(
      customDeck(
        [
          {
            xml: video,
            rels: [
              { id: 'rId2', type: 'image', target: '../media/poster.png' },
              { id: 'rId3', type: 'video', target: 'https://example.invalid/clip.mp4', external: true },
            ],
          },
          { xml: ole, rels: [{ id: 'rId2', type: 'oleObject', target: '../embeddings/sheet.xlsx' }] },
          { xml: ink, rels: [{ id: 'rId2', type: 'customXml', target: '../ink/ink1.xml' }] },
          { xml: unknown },
        ],
        { entries: [{ name: 'ppt/media/poster.png', data: png, method: 'store' }, { name: 'ppt/embeddings/sheet.xlsx', data: 'PK-not-really' }] },
      ),
    );
    const [v, o, i, u] = [1, 2, 3, 4].map((n) => slideOf(d, n));
    expect(warning(v!, 'media').severity).toBe('warning');
    expect(warning(v!, 'external-link').severity).toBe('warning');
    expect(v!.extract.images.map((img) => img.partName)).toEqual(['ppt/media/poster.png']);
    expect(warning(o!, 'ole-object')).toMatchObject({ severity: 'warning' });
    expect(warning(o!, 'ole-object').message).toMatch(/never executed/);
    expect(warning(i!, 'ole-object').severity).toBe('info');
    expect(warning(u!, 'ole-object')).toMatchObject({ severity: 'info' });
    expect(warning(u!, 'ole-object').message).toContain('urn:example:unknown-frame');
  });

  it('warns when a placeholder position cannot be resolved (slide without a layout)', async () => {
    const d = await harness.extract(
      customDeck([{ xml: slideXml(textShape({ id: 2, name: 'Title', ph: '<p:ph type="title"/>', paragraphs: ['Orphan title'] })), ownRels: [] }]),
    );
    const s = must(d.slides[0]);
    expect(s.extract.layoutName).toBeNull();
    expect(s.extract.blocks[0]?.bounds).toBeNull();
    expect(codes(s)).toContain('placeholder-bounds');
  });
});

describe('images and group transforms', () => {
  it('finds images by relationship id, whatever the id and file name', async () => {
    const xml = slideXml(pictureShape({ id: 5, name: 'Odd picture', rid: 'rId42', descr: 'A blue rectangle', box: [100, 200, 300, 400] }));
    const d = await harness.extract(customDeck([{ xml, rels: [{ id: 'rId42', type: 'image', target: '../media/zz-final%20v2.png' }] }], { entries: [{ name: 'ppt/media/zz-final v2.png', data: png }] }));
    const img = must(d.slides[0]?.extract.images[0]);
    expect(img).toMatchObject({ shapeName: 'Odd picture', partName: 'ppt/media/zz-final v2.png', contentType: 'image/png', altText: 'A blue rectangle', supported: true });
    expect(img.bounds).toMatchObject({ x: 100, y: 200, w: 300, h: 400, source: 'shape' });
    expect((await d.readPart(img.partName, 1e6)).equals(png)).toBe(true);
  });

  it('indexes an image shared by several slides once, with every use', async () => {
    const pic = (rid: string) => slideXml(pictureShape({ id: 2, name: 'Logo', rid, box: BOX }));
    const d = await harness.extract(
      customDeck(
        [
          { xml: pic('rId2'), rels: [{ id: 'rId2', type: 'image', target: '../media/shared.png' }] },
          { xml: pic('rId9'), rels: [{ id: 'rId9', type: 'image', target: '/ppt/media/shared.png' }] },
        ],
        { entries: [{ name: 'ppt/media/shared.png', data: png }] },
      ),
    );
    expect([...d.media.values()]).toEqual([
      {
        partName: 'ppt/media/shared.png',
        contentType: 'image/png',
        usedBy: [
          { slideNumber: 1, imageId: 'img-1' },
          { slideNumber: 2, imageId: 'img-1' },
        ],
      },
    ]);
  });

  // Outer group: child space scaled ×2. Inner group (inside outer child space): offset chOff, scaled ×0.25.
  const nestedGroups = groupShape({
    id: 10,
    off: [1000000, 2000000],
    ext: [4000000, 2000000],
    chOff: [0, 0],
    chExt: [2000000, 1000000],
    children:
      textShape({ id: 11, name: 'A', paragraphs: ['Outer text'], box: [100000, 100000, 500000, 250000] }) +
      groupShape({
        id: 12,
        off: [1000000, 0],
        ext: [1000000, 1000000],
        chOff: [500000, 500000],
        chExt: [4000000, 4000000],
        children: textShape({ id: 13, name: 'B', paragraphs: ['Inner text'], box: [2500000, 1500000, 400000, 400000] }) + pictureShape({ id: 14, name: 'P', rid: 'rId2', box: [500000, 500000, 800000, 800000] }),
      }) +
      tableShape({ id: 15, name: 'T', rows: [['cell']], box: [0, 500000, 1000000, 400000] }),
  });

  async function nestedDeck(): Promise<ExtractedSlide> {
    const d = await harness.extract(customDeck([{ xml: slideXml(nestedGroups), rels: [{ id: 'rId2', type: 'image', target: '../media/p.png' }] }], { entries: [{ name: 'ppt/media/p.png', data: png }] }));
    return must(d.slides[0]);
  }

  it('composes nested group transforms (offsets and scales) for text, pictures and tables', async () => {
    const s = await nestedDeck();
    const byText = (t: string) => must(s.extract.blocks.find((b) => b.paragraphs[0]?.text === t));
    expect(byText('Outer text').bounds).toMatchObject({ x: 1200000, y: 2200000, w: 1000000, h: 500000 });
    expect(byText('Inner text').bounds).toMatchObject({ x: 4000000, y: 2500000, w: 200000, h: 200000 });
    expect(s.extract.images[0]?.bounds).toMatchObject({ x: 3000000, y: 2000000, w: 400000, h: 400000 });
    expect(s.extract.tables[0]?.bounds).toMatchObject({ x: 1000000, y: 3000000, w: 2000000, h: 800000 });
    expect(s.extract.blocks.every((b) => b.inGroup && b.bounds?.source === 'group')).toBe(true);
    expect(codes(s)).toContain('group');
  });

  it('counts each grouped object once in the group warning, even in nested groups', async () => {
    const s = await nestedDeck();
    // Four objects are inside groups: A, B, P and T.
    expect(warning(s, 'group').message).toMatch(/^4 object\(s\)/);
  });

  it('labels every group child (pictures, tables, SmartArt) as coming from a group transform', async () => {
    const smartArtFrame = graphicFrame({
      id: 21,
      name: 'Diagram',
      box: [0, 0, 1000000, 1000000],
      uri: 'http://schemas.openxmlformats.org/drawingml/2006/diagram',
      inner: `<dgm:relIds xmlns:dgm="${NS.dgm}" r:dm="rId3" r:lo="rId4" r:qs="rId5" r:cs="rId6"/>`,
    });
    const dataModel = `<dgm:dataModel xmlns:dgm="${NS.dgm}" xmlns:a="${NS.a}"><dgm:ptLst><dgm:pt modelId="1"><dgm:t><a:bodyPr/><a:p><a:r><a:t>Grouped node</a:t></a:r></a:p></dgm:t></dgm:pt></dgm:ptLst></dgm:dataModel>`;
    const xml = slideXml(
      groupShape({
        id: 20,
        off: [1000000, 1000000],
        ext: [2000000, 2000000],
        chOff: [0, 0],
        chExt: [1000000, 1000000],
        children: smartArtFrame + pictureShape({ id: 22, name: 'P', rid: 'rId2', box: [0, 0, 100000, 100000] }) + tableShape({ id: 23, name: 'T', rows: [['c']], box: [0, 500000, 500000, 200000] }),
      }),
    );
    const d = await harness.extract(
      customDeck([{ xml, rels: [{ id: 'rId2', type: 'image', target: '../media/p.png' }, { id: 'rId3', type: 'diagramData', target: '../diagrams/data1.xml' }] }], {
        entries: [{ name: 'ppt/media/p.png', data: png }, { name: 'ppt/diagrams/data1.xml', data: dataModel }],
      }),
    );
    const s = must(d.slides[0]);
    expect({
      smartArtInGroup: s.extract.blocks.find((b) => b.role === 'smartart')?.inGroup,
      pictureSource: s.extract.images[0]?.bounds?.source,
      tableSource: s.extract.tables[0]?.bounds?.source,
    }).toEqual({ smartArtInGroup: true, pictureSource: 'group', tableSource: 'group' });
  });
});

describe('external relationships are never followed', () => {
  function watchIo() {
    const fsSpies = [
      vi.spyOn(fs, 'open'),
      vi.spyOn(fs, 'openSync'),
      vi.spyOn(fs, 'readFile'),
      vi.spyOn(fs, 'readFileSync'),
      vi.spyOn(fs, 'createReadStream'),
      vi.spyOn(fs, 'statSync'),
      vi.spyOn(fs, 'existsSync'),
      vi.spyOn(fs.promises, 'open'),
      vi.spyOn(fs.promises, 'readFile'),
    ];
    const netSpies = [vi.spyOn(globalThis, 'fetch'), vi.spyOn(http, 'request'), vi.spyOn(http, 'get'), vi.spyOn(https, 'request'), vi.spyOn(https, 'get')];
    const callsOf = (spies: Array<{ mock: { calls: unknown[][] } }>) => spies.flatMap((s) => [...s.mock.calls]);
    /** Snapshot the recorded calls, then restore the originals (mockRestore also clears the call log). */
    return (): { fsPaths: string[]; netCalls: number } => {
      const snapshot = { fsPaths: callsOf(fsSpies as never).map((c) => String(c[0])), netCalls: callsOf(netSpies as never).length };
      for (const s of [...fsSpies, ...netSpies]) s.mockRestore();
      return snapshot;
    };
  }

  it('does not load linked, external or escaping image targets — and reports them', async () => {
    const unique = `nexus-secret-${Math.random().toString(36).slice(2)}`;
    const secretFile = harness.tmp.write(`${unique}.png`, png);
    const escape = `${'../'.repeat(30)}${secretFile.replace(/^\//, '')}`;
    const xml = slideXml(
      pictureShape({ id: 2, name: 'External embed', rid: 'rId2', box: BOX }) +
        pictureShape({ id: 3, name: 'Linked', rid: 'rId3', box: BOX, attr: 'r:link' }) +
        pictureShape({ id: 4, name: 'Escaping', rid: 'rId4', box: BOX }) +
        textShape({ id: 5, name: 'Link text', paragraphs: [], box: BOX, runXml: '<a:p><a:r><a:rPr><a:hlinkClick r:id="rId5"/></a:rPr><a:t>Visit the site</a:t></a:r></a:p>' }),
    );
    const buf = customDeck([
      {
        xml,
        rels: [
          { id: 'rId2', type: 'image', target: `file://${secretFile}`, external: true },
          { id: 'rId3', type: 'image', target: 'https://example.invalid/remote.png', external: true },
          { id: 'rId4', type: 'image', target: escape },
          { id: 'rId5', type: 'hyperlink', target: 'https://example.invalid/page', external: true },
          { id: 'rId6', type: 'oleObject', target: 'file:///C:/finance/budget.xlsx', external: true },
        ],
      },
    ]);

    const stopWatching = watchIo();
    let d: PptxResult;
    let io: { fsPaths: string[]; netCalls: number };
    try {
      d = await harness.extract(buf);
    } finally {
      io = stopWatching();
    }
    // Positive control: the spies do see the importer opening the uploaded deck itself.
    expect(io.fsPaths.some((p) => p.endsWith('deck.pptx'))).toBe(true);
    expect(io.netCalls).toBe(0);
    expect(io.fsPaths.filter((p) => p.includes(unique) || p.includes('example.invalid') || p.includes('budget.xlsx'))).toEqual([]);

    const s = must(d.slides[0]);
    expect(s.extract.images).toEqual([]);
    expect(d.media.size).toBe(0);
    expect(texts(s)).toEqual(['Visit the site']);
    expect(warning(s, 'external-link').severity).toBe('warning');
    expect(warning(s, 'missing-part').severity).toBe('warning');
    expect(d.packageWarnings).toContain('Ignored a relationship with an unsafe target in ppt/slides/slide1.xml.');
    expect(JSON.stringify(s.extract)).not.toContain(unique);

    // The package reader cannot be pointed at the outside file either.
    await expect(d.readPart(secretFile, 1e6)).rejects.toBeInstanceOf(ZipRejection);
    await expect(d.readPart(`file://${secretFile}`, 1e6)).rejects.toBeInstanceOf(ZipRejection);
    await expect(d.readPart(escape, 1e6)).rejects.toBeInstanceOf(ZipRejection);
  });

  it('reports external (non-hyperlink) references even when no shape uses them', async () => {
    const d = await harness.extract(
      customDeck([{ xml: slideXml(textShape({ id: 2, name: 'T', paragraphs: ['Plain'], box: BOX })), rels: [{ id: 'rId7', type: 'oleObject', target: 'file:///C:/finance/budget.xlsx', external: true }] }]),
    );
    expect(warning(must(d.slides[0]), 'external-link').message).toMatch(/external files/);
  });

  it('builder-made linked image: not loaded, warned, and absent from media', async () => {
    const d = await harness.extract(buildPptx({ slides: [{ partNumber: 1, layout: 'content', title: 'Linked', externalImage: true }] }));
    const s = must(d.slides[0]);
    expect(s.extract.images).toEqual([]);
    expect(d.media.size).toBe(0);
    expect(warning(s, 'external-link').message).toMatch(/not loaded/);
    const err = await rejectionOf(d.readPart('file:///etc/passwd', 1e6), ZipRejection);
    expect(err.code).toBe('corrupt');
  });

  it('flags an image reference whose relationship is missing', async () => {
    const d = await harness.extract(customDeck([{ xml: slideXml(pictureShape({ id: 2, name: 'Ghost', rid: 'rId99', box: BOX })) }]));
    const s = must(d.slides[0]);
    expect(s.extract.images).toEqual([]);
    expect(warning(s, 'missing-part').message).toMatch(/missing/);
  });
});
