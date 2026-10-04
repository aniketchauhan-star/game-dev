import fs from 'node:fs';
import zlib from 'node:zlib';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildPptx, type BuildOptions, type SlideSpec } from '../../../fixtures/scripts/pptx-builder.ts';
import { writeZip } from '../../../fixtures/scripts/zip-writer.ts';
import { processImage, MediaRejection } from '../../../server/src/ingest/media.ts';
import { PptxRejection, type PptxRejectionCode } from '../../../server/src/ingest/pptx.ts';
import { compoundFile, DeckHarness, forgePngDimensions, MB, MEDIA_LIMITS, must, NS, presentationRels, presentationXml, rejectionOf, relsXml, solidJpeg, solidPng, XML_DECL } from './helpers.ts';

const harness = new DeckHarness();
afterEach(() => harness.closeAll());
afterAll(() => harness.dispose());

const ONE_SLIDE: SlideSpec[] = [{ partNumber: 1, layout: 'content', title: 'Only slide', bullets: ['Point'] }];
const deck = (opts: Partial<BuildOptions> = {}) => buildPptx({ slides: ONE_SLIDE, ...opts });

async function expectCode(buf: Buffer, code: PptxRejectionCode, opts: Parameters<DeckHarness['rejection']>[1] = {}): Promise<PptxRejection> {
  const err = await harness.rejection(buf, opts);
  expect(err.code).toBe(code);
  return err;
}

describe('file type is decided by content (sniffing), not by name', () => {
  it.each(['lesson.ppt', 'LESSON.PPS', 'template.pot'])('rejects an OLE compound file named %s as a legacy deck', async (name) => {
    const err = await expectCode(compoundFile(), 'legacy-ppt', { name });
    expect(err.hint).toMatch(/\.pptx/);
  });

  it.each(['deck.pptx', 'deck.zip', 'deck'])('rejects an OLE compound file named %s as encrypted/OLE', async (name) => {
    const err = await expectCode(compoundFile(), 'ole', { name });
    expect(err.message).toMatch(/password|encrypted/i);
  });

  it('rejects non-ZIP content even when it is named .pptx', async () => {
    await expectCode(Buffer.from('Hello, this is just text.'), 'unsupported-format');
    await expectCode(Buffer.from('%PDF-1.7\n%âãÏÓ\n1 0 obj\n<<>>\nendobj\n'), 'unsupported-format');
    await expectCode(await solidPng(8, 8), 'unsupported-format');
    await expectCode(Buffer.alloc(0), 'unsupported-format');
    await expectCode(Buffer.from('<html><script>alert(1)</script></html>'), 'unsupported-format');
  });

  it('rejects a truncated ZIP as "not-zip"', async () => {
    const real = deck();
    await expectCode(real.subarray(0, real.length - 200), 'not-zip');
  });

  it.each(['deck.ppt', 'deck.zip', 'deck.key', 'deck'])('extracts a real .pptx package even when it is named %s', async (name) => {
    const d = await harness.extract(deck(), { name });
    expect(d.slides.map((s) => s.extract.title)).toEqual(['Only slide']);
  });
});

describe('ZIP-level attacks are rejected with the ZIP rejection code', () => {
  it.each<[string, Partial<BuildOptions>, PptxRejectionCode]>([
    ['a path-traversal entry', { extraEntries: [{ name: '../../../../tmp/evil.sh', data: '#!/bin/sh' }] }, 'traversal'],
    ['an absolute-path entry', { extraEntries: [{ name: '/etc/cron.d/evil', data: 'x' }] }, 'traversal'],
    ['a backslash entry', { extraEntries: [{ name: 'ppt\\..\\..\\evil.xml', data: '<x/>' }] }, 'traversal'],
    ['a drive-letter entry', { extraEntries: [{ name: 'C:/Windows/System32/evil.dll', data: 'MZ' }] }, 'traversal'],
    ['a symbolic link', { extraEntries: [{ name: 'ppt/media/link.png', data: '/etc/passwd', symlink: true }] }, 'symlink'],
    ['an encrypted entry', { extraEntries: [{ name: 'ppt/media/secret.png', data: 'x', encryptedFlag: true }] }, 'encrypted-entry'],
    ['a duplicate part', { extraEntries: [{ name: 'ppt/presentation.xml', data: '<evil/>' }] }, 'duplicate-entry'],
    ['a case-only duplicate part', { extraEntries: [{ name: 'PPT/Slides/Slide1.XML', data: '<evil/>' }] }, 'duplicate-entry'],
    ['an entry declaring a huge size', { extraEntries: [{ name: 'ppt/media/huge.bin', data: 'x', declaredSize: 400 * MB }] }, 'too-large'],
  ])('rejects %s', async (_label, opts, code) => {
    await expectCode(deck(opts), code);
  });

  it('rejects a package with more entries than allowed', async () => {
    const err = await expectCode(deck(), 'too-many-entries', { limits: { maxEntries: 10 } });
    expect(err.message).toContain('limit is 10');
  });

  it('rejects a package whose total expanded size exceeds the limit', async () => {
    const extraEntries = [{ name: 'ppt/media/a.bin', data: Buffer.alloc(300_000) }, { name: 'ppt/media/b.bin', data: Buffer.alloc(300_000) }];
    await expectCode(deck({ extraEntries }), 'too-large', { limits: { maxExpandedBytes: 500_000 } });
  });

  it('rejects a compression bomb hidden among the media', async () => {
    const zeros = Buffer.alloc(20 * MB);
    expect(zeros.length / zlib.deflateRawSync(zeros).length).toBeGreaterThan(1000);
    await expectCode(deck({ extraEntries: [{ name: 'ppt/media/image9.png', data: zeros }] }), 'compression-bomb');
  });

  it('rejects an XML part that lies about its uncompressed size', async () => {
    const lying = deck({
      dropEntries: ['ppt/presentation.xml'],
      extraEntries: [{ name: 'ppt/presentation.xml', data: presentationXml([{ id: 256, rid: 'rId100' }]), declaredSize: 64 }],
    });
    await expectCode(lying, 'corrupt');
  });

  it('rejects XML parts larger than the XML limit, even when the per-entry ZIP limit is higher', async () => {
    const bullets = Array.from({ length: 2000 }, (_, i) => `Bullet number ${i} with some padding text`);
    const big = buildPptx({ slides: [{ partNumber: 1, layout: 'content', title: 'Big', bullets }] });
    await expectCode(big, 'too-large', { limits: { maxXmlBytes: 64 * 1024, maxAssetBytes: 4 * MB } });
    await expectCode(big, 'too-large', { limits: { maxXmlBytes: 64 * 1024, maxAssetBytes: 64 * 1024 } });
    // …and accepted under the default limits.
    expect((await harness.extract(big)).slides[0]?.extract.blocks[1]?.paragraphs).toHaveLength(2000);
  });
});

describe('XML parts with DTDs or broken markup are rejected', () => {
  const lol = (() => {
    let ents = '<!ENTITY lol0 "lol">';
    for (let i = 1; i <= 9; i++) ents += `<!ENTITY lol${i} "${`&lol${i - 1};`.repeat(10)}">`;
    return ents;
  })();

  it('rejects a billion-laughs entity bomb in a slide quickly, without expanding it', async () => {
    const bomb = `${XML_DECL}<!DOCTYPE p:sld [${lol}]><p:sld xmlns:a="${NS.a}" xmlns:p="${NS.p}"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>&lol9;</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
    const started = performance.now();
    const err = await expectCode(deck({ replaceEntries: { 'ppt/slides/slide1.xml': bomb } }), 'xml');
    expect(performance.now() - started).toBeLessThan(5000);
    expect(err.message).toMatch(/DTD|document type/i);
    expect(err.message).toContain('ppt/slides/slide1.xml');
  });

  it('rejects an external entity (XXE) without reading the referenced file', async () => {
    const secret = `XXE-SECRET-${Math.random().toString(36).slice(2)}`;
    const secretFile = harness.tmp.write('secret.txt', secret);
    const xxe = `${XML_DECL}<!DOCTYPE p:presentation [<!ENTITY xxe SYSTEM "file://${secretFile}">]><p:presentation xmlns:p="${NS.p}" xmlns:r="${NS.r}"><p:sldIdLst><p:sldId id="256" r:id="rId100"/></p:sldIdLst><p:sldSz cx="&xxe;" cy="1"/></p:presentation>`;
    const err = await expectCode(deck({ replaceEntries: { 'ppt/presentation.xml': xxe } }), 'xml');
    expect(`${err.message} ${err.hint}`).not.toContain(secret);
  });

  it.each([
    ['[Content_Types].xml', `${XML_DECL}<!DOCTYPE Types [<!ENTITY t "application/xml">]><Types xmlns="${NS.ct}"><Default Extension="xml" ContentType="&t;"/></Types>`],
    ['_rels/.rels', `${XML_DECL}<!DOCTYPE Relationships SYSTEM "http://example.invalid/rels.dtd"><Relationships xmlns="${NS.rel}"/>`],
    ['ppt/_rels/presentation.xml.rels', `${XML_DECL}<!DOCTYPE r [<!ENTITY % ext SYSTEM "http://example.invalid/x.dtd"> %ext;]><Relationships xmlns="${NS.rel}"/>`],
  ])('rejects a DOCTYPE in %s', async (part, xml) => {
    const err = await expectCode(deck({ replaceEntries: { [part]: xml } }), 'xml');
    expect(err.message).toContain(part);
  });

  it('rejects malformed slide XML', async () => {
    await expectCode(deck({ replaceEntries: { 'ppt/slides/slide1.xml': '<p:sld xmlns:p="x"><p:cSld>' } }), 'xml');
  });
});

describe('macro-enabled content is refused', () => {
  it.each<[string, Partial<BuildOptions>]>([
    ['a VBA project part', { extraEntries: [{ name: 'ppt/vbaProject.bin', data: Buffer.from([0xd0, 0xcf, 0x11, 0xe0]) }] }],
    ['an upper-case VBA project part', { extraEntries: [{ name: 'PPT/VBAPROJECT.BIN', data: 'x' }] }],
    ['VBA data', { extraEntries: [{ name: 'ppt/vbaData.xml', data: '<wne:vbaSuppData xmlns:wne="urn:x"/>' }] }],
    ['a macro-enabled main content type (.pptm)', { mainContentType: 'application/vnd.ms-powerpoint.presentation.macroEnabled.main+xml' }],
    ['a macro-enabled slideshow content type (.ppsm)', { mainContentType: 'application/vnd.ms-powerpoint.slideshow.macroEnabled.main+xml' }],
    ['a VBA project content type', { extraContentTypes: '<Default Extension="bin" ContentType="application/vnd.ms-office.vbaProject"/>' }],
  ])('rejects %s', async (_label, opts) => {
    const err = await expectCode(deck(opts), 'macro');
    expect(err.hint).toMatch(/without macros/);
  });
});

describe('packages that are not (usable) presentations', () => {
  it.each<[string, string]>([
    ['a PowerPoint Show (.ppsx)', 'application/vnd.openxmlformats-officedocument.presentationml.slideshow.main+xml'],
    ['a PowerPoint template (.potx)', 'application/vnd.openxmlformats-officedocument.presentationml.template.main+xml'],
    ['a Word document', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'],
  ])('rejects %s as not-presentation', async (_label, mainContentType) => {
    await expectCode(deck({ mainContentType }), 'not-presentation');
  });

  it('rejects a package without a main-document relationship', async () => {
    await expectCode(deck({ dropEntries: ['_rels/.rels'] }), 'not-presentation');
  });

  it('rejects a main-document relationship that is external or escapes the package', async () => {
    const officeDoc = (target: string, external = false) =>
      relsXml([{ id: 'rId1', type: 'officeDocument', target, external }]);
    await expectCode(deck({ replaceEntries: { '_rels/.rels': officeDoc('https://example.invalid/presentation.xml', true) } }), 'not-presentation');
    await expectCode(deck({ replaceEntries: { '_rels/.rels': officeDoc('../../ppt/presentation.xml') } }), 'not-presentation');
  });

  it('rejects a package whose presentation.xml is missing', async () => {
    const err = await expectCode(deck({ dropEntries: ['ppt/presentation.xml'] }), 'corrupt');
    expect(err.message).toContain('ppt/presentation.xml');
  });

  it('rejects a package without [Content_Types].xml, and an empty ZIP', async () => {
    await expectCode(deck({ dropEntries: ['[Content_Types].xml'] }), 'corrupt');
    await expectCode(writeZip([]), 'corrupt');
  });

  it('rejects a presentation with no slides', async () => {
    await expectCode(buildPptx({ slides: [] }), 'no-slides');
  });

  it('rejects decks over the slide limit and accepts decks exactly at it', async () => {
    const slides: SlideSpec[] = [1, 2, 3].map((n) => ({ partNumber: n, layout: 'content', title: `S${n}` }));
    const err = await expectCode(buildPptx({ slides }), 'too-many-slides', { limits: { maxSlides: 2 } });
    expect(err.message).toContain('3 slides');
    expect((await harness.extract(buildPptx({ slides }), { limits: { maxSlides: 3 } })).slides).toHaveLength(3);
  });

  it.each<[string, Parameters<typeof presentationRels>[0]]>([
    ['external', [{ rid: 'rId100', target: 'https://example.invalid/slide1.xml', external: true }]],
    ['missing', [{ rid: 'rId999', target: 'slides/slide1.xml' }]],
    ['not a slide relationship', [{ rid: 'rId100', target: 'slideLayouts/slideLayout1.xml', type: 'slideLayout' }]],
    ['escaping the package', [{ rid: 'rId100', target: '../../../etc/slide1.xml' }]],
  ])('rejects a slide reference that is %s', async (_label, rels) => {
    await expectCode(deck({ replaceEntries: { 'ppt/_rels/presentation.xml.rels': presentationRels(rels) } }), 'external-slide');
  });

  it('rejects the same slide listed twice', async () => {
    const twice = deck({
      replaceEntries: {
        'ppt/presentation.xml': presentationXml([{ id: 256, rid: 'rId100' }, { id: 257, rid: 'rId101' }]),
        'ppt/_rels/presentation.xml.rels': presentationRels([{ rid: 'rId100', target: 'slides/slide1.xml' }, { rid: 'rId101', target: 'slides/../slides/slide1.xml' }]),
      },
    });
    await expectCode(twice, 'corrupt');
  });

  it('rejects a slide that is listed but missing from the package', async () => {
    const slides: SlideSpec[] = [1, 2].map((n) => ({ partNumber: n, layout: 'content', title: `S${n}` }));
    const err = await expectCode(buildPptx({ slides, dropEntries: ['ppt/slides/slide2.xml'] }), 'corrupt');
    expect(err.message).toMatch(/Slide 2/);
  });
});

describe('resource hygiene', () => {
  const openFdCount = () => fs.readdirSync('/dev/fd').length;

  it('does not leak file descriptors when rejecting packages or after close()', async () => {
    const cases: Array<[Buffer, Parameters<DeckHarness['rejection']>[1]]> = [
      [deck({ extraEntries: [{ name: '../evil.sh', data: 'x' }] }), {}], // rejected while opening the ZIP
      [deck({ mainContentType: 'application/vnd.ms-powerpoint.presentation.macroEnabled.main+xml' }), {}], // after opening
      [deck({ replaceEntries: { 'ppt/slides/slide1.xml': '<p:sld' } }), {}], // while parsing a slide
      [deck(), { limits: { maxSlides: 0 } }],
      [compoundFile(), { name: 'old.ppt' }], // rejected by sniffing
    ];
    const good = deck();
    // Warm up module loading so only descriptors held by the importer are measured.
    await harness.rejection(cases[0]![0]);
    (await harness.extract(good)).close();
    const baseline = openFdCount();
    for (let i = 0; i < 8; i++) {
      for (const [buf, opts] of cases) await harness.rejection(buf, opts);
      (await harness.extract(good)).close();
    }
    const deadline = Date.now() + 3000;
    let now = openFdCount();
    while (now > baseline + 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      now = openFdCount();
    }
    expect(now).toBeLessThanOrEqual(baseline + 2);
  });
});

describe('media inside a deck is validated by content before use', () => {
  let big: Buffer;
  let small: Buffer;
  beforeAll(async () => {
    big = await solidPng(2500, 2000);
    small = await solidPng(320, 200);
  });

  async function extractImage(file: string, data: Buffer): Promise<Buffer> {
    const d = await harness.extract(
      buildPptx({ slides: [{ partNumber: 1, layout: 'content', title: 'Pic', image: { file, png: data, alt: 'alt', x: 0, y: 0, w: 914400, h: 914400 } }] }),
    );
    const ref = must([...d.media.values()][0]);
    return d.readPart(ref.partName, MEDIA_LIMITS.maxBytes);
  }

  it('enforces the pixel limit on extracted images (larger rejected, smaller accepted)', async () => {
    const limits = { maxBytes: 25 * MB, maxPixels: 4_000_000 };
    const err = await rejectionOf(processImage(await extractImage('big.png', big), limits), MediaRejection);
    expect(err.code).toBe('too-many-pixels');
    const ok = await processImage(await extractImage('small.png', small), limits);
    expect([ok.width, ok.height]).toEqual([320, 200]);
  });

  it('rejects a decompression-bomb PNG header (huge declared dimensions) under the default limits', async () => {
    const bomb = forgePngDimensions(await solidPng(4, 4), 60000, 60000);
    const err = await rejectionOf(processImage(await extractImage('bomb.png', bomb), MEDIA_LIMITS), MediaRejection);
    expect(err.code).toBe('too-many-pixels');
  });

  it('sniffs mislabeled media parts by their bytes, not their .png name', async () => {
    const jpeg = await processImage(await extractImage('photo.png', await solidJpeg(40, 30)), MEDIA_LIMITS);
    expect(jpeg.format).toBe('jpeg');
    expect(jpeg.display.mime).toBe('image/jpeg');

    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" onload="alert(document.cookie)"><rect width="10" height="10"/></svg>');
    expect((await rejectionOf(processImage(await extractImage('innocent.png', svg), MEDIA_LIMITS), MediaRejection)).code).toBe('unsafe-svg');

    const html = Buffer.from('<!doctype html><html><body><script>alert(1)</script></body></html>');
    expect((await rejectionOf(processImage(await extractImage('page.png', html), MEDIA_LIMITS), MediaRejection)).code).toBe('unsupported-type');
  });
});
