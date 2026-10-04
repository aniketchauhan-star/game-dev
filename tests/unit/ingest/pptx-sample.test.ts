import type { ExtractedSlide, PptxResult } from '../../../server/src/ingest/pptx.ts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSampleDeck, SAMPLE_ORDER, sampleSlideId } from '../../../fixtures/scripts/sample-deck.ts';
import { processImage } from '../../../server/src/ingest/media.ts';
import { sniff } from '../../../server/src/ingest/sniff.ts';
import { DeckHarness, MEDIA_LIMITS, must, SAMPLE_DECK_PATH } from './helpers.ts';

/**
 * The bundled sample (fixtures/sample/air-traffic-control.pptx). Its part
 * numbers deliberately differ from presentation order: slide10.xml is shown 4th.
 */

const SLIDE_W = 12192000;
const SLIDE_H = 6858000;

const harness = new DeckHarness();
let deck: PptxResult;
const progress: string[] = [];

beforeAll(async () => {
  deck = await harness.extractFile(SAMPLE_DECK_PATH, { name: 'air-traffic-control.pptx', onProgress: (m) => progress.push(m) });
});
afterAll(() => harness.dispose());

function slide(n: number): ExtractedSlide {
  return must(deck.slides.find((s) => s.slideNumber === n), `slide ${n}`);
}

describe('sample deck — package level', () => {
  it('reads the slide size and raises no package warnings', () => {
    expect(deck.slideSize).toEqual({ cx: SLIDE_W, cy: SLIDE_H });
    expect(deck.packageWarnings).toEqual([]);
  });

  it('orders slides by presentation.xml p:sldIdLst, not by part file names', () => {
    expect(deck.slides).toHaveLength(SAMPLE_ORDER.length);
    expect(deck.slides.map((s) => s.slideNumber)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(deck.slides.map((s) => s.partName)).toEqual(SAMPLE_ORDER.map((n) => `ppt/slides/slide${n}.xml`));
    expect(deck.slides.map((s) => s.pptxSlideId)).toEqual(SAMPLE_ORDER.map(sampleSlideId));
    // slide10.xml is the 4th slide, between slide3.xml and slide4.xml.
    expect(slide(4).partName).toBe('ppt/slides/slide10.xml');
    expect(slide(4).extract.title).toBe('The four quadrants');
    expect(slide(5).partName).toBe('ppt/slides/slide4.xml');
    expect(slide(5).extract.title).toBe('Negative coordinates');
  });

  it('reports progress while ordering and extracting', () => {
    expect(progress).toContain('Ordering 9 slides from presentation.xml');
    expect(progress).toContain('Extracting slide 9 of 9');
  });

  it('matches what the fixture builder produces (shipped sample is up to date)', async () => {
    const rebuilt = await harness.extract(await buildSampleDeck());
    expect(rebuilt.slides.map((s) => s.contentHash)).toEqual(deck.slides.map((s) => s.contentHash));
  });

  it('is deterministic: extracting again yields identical content hashes', async () => {
    const again = await harness.extractFile(SAMPLE_DECK_PATH);
    expect(again.slides.map((s) => s.contentHash)).toEqual(deck.slides.map((s) => s.contentHash));
    expect(new Set(deck.slides.map((s) => s.contentHash)).size).toBe(deck.slides.length);
  });
});

describe('sample deck — slide content', () => {
  it('flags only the hidden slide', () => {
    expect(deck.slides.filter((s) => s.hidden).map((s) => s.slideNumber)).toEqual([6]);
    expect(slide(6).partName).toBe('ppt/slides/slide5.xml');
    expect(slide(6).extract.title).toBe('Teacher answer key');
  });

  it('extracts titles separately from body text', () => {
    expect(deck.slides.map((s) => s.extract.title)).toEqual([
      'Air Traffic Control: Coordinate Mission',
      'The airfield is a coordinate plane',
      'Reading an ordered pair (x, y)',
      'The four quadrants',
      'Negative coordinates',
      'Teacher answer key',
      'Tower to runway: plotting steps',
      'Extension: distance between two aircraft',
      'Mission practice',
    ]);
    for (const s of deck.slides) {
      const titles = s.extract.blocks.filter((b) => b.role === 'title');
      expect(titles).toHaveLength(1);
      const bodyText = s.extract.blocks.filter((b) => b.role !== 'title').flatMap((b) => b.paragraphs.map((p) => p.text));
      expect(bodyText).not.toContain(s.extract.title);
    }
  });

  it('distinguishes title, subtitle, body and free-text roles', () => {
    expect(slide(1).extract.blocks.map((b) => [b.role, b.paragraphs.map((p) => p.text)])).toEqual([
      ['title', ['Air Traffic Control: Coordinate Mission']],
      ['subtitle', ['Grade 9 Mathematics · The coordinate plane']],
    ]);
    expect(slide(1).extract.layoutName).toBe('Title Slide');
    const body = must(slide(2).extract.blocks.find((b) => b.role === 'body'));
    expect(body.paragraphs).toEqual([
      { text: 'The x-axis runs left to right.', level: 0, bullet: true },
      { text: 'The y-axis runs bottom to top.', level: 0, bullet: true },
      { text: 'The axes cross at the origin, (0, 0).', level: 0, bullet: true },
      { text: 'Grid lines are equally spaced on both axes.', level: 0, bullet: true },
    ]);
    expect(slide(2).extract.layoutName).toBe('Title and Content');
  });

  it('keeps paragraph indentation levels', () => {
    const body = must(slide(3).extract.blocks.find((b) => b.role === 'body'));
    expect(body.paragraphs.map((p) => p.level)).toEqual([0, 0, 0, 1]);
    expect(body.paragraphs[3]?.text).toBe('Example: (3, 2) means 3 right, then 2 up.');
  });

  it('resolves placeholder positions from the slide, the layout or the master', () => {
    const [title1, subtitle1] = slide(1).extract.blocks;
    expect(title1?.bounds).toMatchObject({ x: 1524000, y: 1122363, w: 9144000, h: 2387600, source: 'layout' });
    expect(subtitle1?.bounds).toMatchObject({ x: 1524000, y: 3602038, w: 9144000, h: 1655762, source: 'layout' });
    const title2 = must(slide(2).extract.blocks.find((b) => b.role === 'title'));
    expect(title2.bounds).toMatchObject({ x: 838200, y: 365125, w: 10515600, h: 1325563, source: 'master' });
    const body2 = must(slide(2).extract.blocks.find((b) => b.role === 'body'));
    expect(body2.bounds).toMatchObject({ x: 838200, y: 1825625, w: 5181600, h: 4351338, source: 'shape' });
    expect(body2.bounds?.nx).toBeCloseTo(838200 / SLIDE_W, 10);
    expect(body2.bounds?.nh).toBeCloseTo(4351338 / SLIDE_H, 10);
  });

  it('reads speaker notes through the notesSlide relationship', () => {
    expect(slide(1).extract.notes).toEqual(['Hook: ask how air traffic controllers say exactly where an aircraft is.', 'Today learners guide aircraft using ordered pairs.']);
    expect(slide(4).extract.notes).toEqual(['Quadrants are numbered counter-clockwise, starting at the top right.']);
    expect(slide(6).extract.notes).toEqual(['Hidden slide — not shown to learners.']);
    expect(deck.slides.every((s) => s.extract.notes.length > 0)).toBe(true);
  });

  it('extracts tables cell by cell', () => {
    const s = slide(4);
    expect(s.extract.tables).toHaveLength(1);
    const table = must(s.extract.tables[0]);
    expect(table.rows).toEqual([
      ['Quadrant', 'x', 'y'],
      ['I', '+', '+'],
      ['II', '−', '+'],
      ['III', '−', '−'],
      ['IV', '+', '−'],
    ]);
    expect(table.bounds).toMatchObject({ x: 6400800, y: 1825625, source: 'shape' });
    expect(deck.slides.filter((s2) => s2.slideNumber !== 4).every((s2) => s2.extract.tables.length === 0)).toBe(true);
  });

  it('finds images through relationships, with alt text, content type and bounds', () => {
    const img = must(slide(2).extract.images[0]);
    expect(img).toMatchObject({
      partName: 'ppt/media/coordinate-grid.png',
      contentType: 'image/png',
      altText: 'Coordinate grid with x- and y-axes crossing at the origin and the point (3, 2) marked',
      supported: true,
      assetId: null,
    });
    expect(img.bounds).toMatchObject({ x: 6400800, y: 1825625, w: 4953000, h: 3852333, source: 'shape' });
    expect(img.bounds?.nw).toBeCloseTo(4953000 / SLIDE_W, 10);
    expect(slide(7).extract.images.map((i) => i.partName)).toEqual(['ppt/media/aircraft.png']);
    expect(slide(9).extract.images.map((i) => i.partName)).toEqual(['ppt/media/airfield-map.png']);
  });

  it('indexes every media part with the slides that use it', () => {
    expect([...deck.media.values()].map((m) => ({ part: m.partName, type: m.contentType, usedBy: m.usedBy.map((u) => u.slideNumber) }))).toEqual([
      { part: 'ppt/media/coordinate-grid.png', type: 'image/png', usedBy: [2] },
      { part: 'ppt/media/aircraft.png', type: 'image/png', usedBy: [7] },
      { part: 'ppt/media/airfield-map.png', type: 'image/png', usedBy: [9] },
    ]);
  });

  it('applies group transforms to grouped shapes (children stored at half scale)', () => {
    const grouped = slide(7).extract.blocks.filter((b) => b.inGroup);
    expect(grouped.map((b) => b.paragraphs[0]?.text)).toEqual(['TOWER', 'RUNWAY']);
    expect(grouped[0]?.bounds).toMatchObject({ x: 7010400, y: 1828800, w: 1828800, h: 609600, source: 'group' });
    expect(grouped[1]?.bounds).toMatchObject({ x: 9144000, y: 1828800, w: 1828800, h: 609600, source: 'group' });
    expect(slide(7).extract.warnings.map((w) => w.code)).toContain('group');
  });

  it('exports the Office Math equation as linear text and keeps the OMML source', () => {
    const s = slide(8);
    expect(s.extract.equations).toHaveLength(1);
    const eq = must(s.extract.equations[0]);
    expect(eq.linear).toBe('d=√((x_2−x_1)^2+(y_2−y_1)^2)');
    expect(eq.omml.startsWith('<m:oMathPara>')).toBe(true);
    expect(eq.omml).toContain('<m:rad>');
    const block = must(s.extract.blocks.find((b) => b.shapeName.startsWith('Equation')));
    expect(block.paragraphs.map((p) => p.text)).toEqual([eq.linear]);
    // The picture-text fallback is not duplicated next to the math.
    expect(JSON.stringify(s.extract)).not.toContain('d = √((x₂ − x₁)² + (y₂ − y₁)²)');
    expect(s.extract.warnings).toContainEqual(expect.objectContaining({ code: 'equation', severity: 'info' }));
  });

  it('warns about animations only on the animated slide', () => {
    const animated = deck.slides.filter((s) => s.extract.warnings.some((w) => w.code === 'animation'));
    expect(animated.map((s) => s.slideNumber)).toEqual([3]);
    expect(must(slide(3).extract.warnings.find((w) => w.code === 'animation')).message).toContain('1 effect');
  });

  it('raises no warnings for plain slides', () => {
    for (const n of [1, 2, 4, 5, 6, 9]) expect(slide(n).extract.warnings).toEqual([]);
  });
});

describe('sample deck — media parts', () => {
  it('serves media parts through readPart; they are real PNGs that pass image validation', async () => {
    for (const ref of deck.media.values()) {
      const data = await deck.readPart(ref.partName, MEDIA_LIMITS.maxBytes);
      expect(sniff(data)).toBe('png');
      const processed = await processImage(data, MEDIA_LIMITS);
      expect(processed.format).toBe('png');
      expect(processed.display.mime).toBe('image/png');
      expect(processed.width).toBeGreaterThan(0);
    }
  });

  it('readPart enforces the caller byte limit', async () => {
    await expect(deck.readPart('ppt/media/airfield-map.png', 10)).rejects.toMatchObject({ code: 'too-large' });
  });
});
