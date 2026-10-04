import zlib from 'node:zlib';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { MediaRejection, processAudio, processImage, screenSvg, type MediaLimits } from '../../../server/src/ingest/media.ts';
import { sniff } from '../../../server/src/ingest/sniff.ts';
import { forgePngDimensions, MB, MEDIA_LIMITS, rejectionOf, solidJpeg, solidPng, wavFile } from './helpers.ts';

async function imageRejection(buf: Buffer, code: MediaRejection['code'], limits: MediaLimits = MEDIA_LIMITS): Promise<MediaRejection> {
  const err = await rejectionOf(processImage(buf, limits), MediaRejection);
  expect(err.code).toBe(code);
  expect(err.hint.length).toBeGreaterThan(0);
  return err;
}

function audioRejection(buf: Buffer, code: MediaRejection['code'], limits: MediaLimits = MEDIA_LIMITS): Promise<MediaRejection> {
  return rejectionOf(() => processAudio(buf, limits), MediaRejection).then((err) => {
    expect(err.code).toBe(code);
    return err;
  });
}

/** Insert an ancillary chunk right after IHDR. */
function withPngChunk(png: Buffer, type: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, 'latin1');
  data.copy(chunk, 8);
  chunk.writeUInt32BE(zlib.crc32(chunk.subarray(4, 8 + data.length)) >>> 0, 8 + data.length);
  return Buffer.concat([png.subarray(0, 33), chunk, png.subarray(33)]);
}

const svg = (body: string, attrs = 'width="200" height="100"') => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ${attrs}>${body}</svg>`);
const TINY_PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

describe('processImage — raster images are validated and re-encoded', () => {
  it('accepts a PNG, keeps alpha, and produces a PNG display copy and a WebP thumbnail', async () => {
    const src = await solidPng(640, 320, 0.5);
    const out = await processImage(src, MEDIA_LIMITS);
    expect(out).toMatchObject({ kind: 'image', format: 'png', originalMime: 'image/png', width: 640, height: 320, hasAlpha: true, rasterizedFromSvg: false });
    expect(out.display).toMatchObject({ mime: 'image/png', ext: 'png' });
    expect(sniff(out.display.data)).toBe('png');
    expect(out.thumb.mime).toBe('image/webp');
    expect(sniff(out.thumb.data)).toBe('webp');
    const thumb = await sharp(out.thumb.data).metadata();
    expect([thumb.width, thumb.height]).toEqual([480, 240]);
  });

  it('re-encodes instead of passing bytes through: metadata chunks and trailing payloads are dropped', async () => {
    const base = await solidPng(32, 32);
    const tagged = withPngChunk(base, 'tEXt', Buffer.from('Comment\0<script>alert("png-comment")</script>', 'latin1'));
    const polyglot = Buffer.concat([tagged, Buffer.from('PK\x03\x04<html><script>alert("trailer")</script>')]);
    const out = await processImage(polyglot, MEDIA_LIMITS);
    expect(out.display.data.includes('alert(')).toBe(false);
    expect(out.display.data.includes('PK\x03\x04')).toBe(false);
    expect([out.width, out.height]).toEqual([32, 32]);
  });

  it('accepts a JPEG, applies EXIF orientation and strips EXIF metadata', async () => {
    const src = await sharp({ create: { width: 200, height: 100, channels: 3, background: '#c83c0a' } })
      .jpeg()
      .withExif({ IFD0: { Copyright: 'OWNER-SECRET', ImageDescription: 'Taken at home' } })
      .withMetadata({ orientation: 6 })
      .toBuffer();
    expect(src.includes('OWNER-SECRET')).toBe(true);
    const out = await processImage(src, MEDIA_LIMITS);
    expect(out).toMatchObject({ format: 'jpeg', originalMime: 'image/jpeg', width: 100, height: 200, hasAlpha: false });
    expect(out.display).toMatchObject({ mime: 'image/jpeg', ext: 'jpg' });
    expect(out.display.data.includes('OWNER-SECRET')).toBe(false);
    const meta = await sharp(out.display.data).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.orientation).toBeUndefined();
  });

  it('keeps WebP as WebP and converts GIF and TIFF to PNG', async () => {
    const base = { create: { width: 30, height: 20, channels: 4 as const, background: { r: 0, g: 0, b: 255, alpha: 0.5 } } };
    const webp = await processImage(await sharp(base).webp().toBuffer(), MEDIA_LIMITS);
    expect([webp.format, webp.display.mime]).toEqual(['webp', 'image/webp']);
    const gif = await processImage(await sharp(base).gif().toBuffer(), MEDIA_LIMITS);
    expect([gif.format, gif.display.mime, gif.originalMime]).toEqual(['gif', 'image/png', 'image/gif']);
    const tiff = await processImage(await sharp(base).tiff().toBuffer(), MEDIA_LIMITS);
    expect([tiff.format, tiff.display.mime]).toEqual(['tiff', 'image/png']);
  });

  it('caps the display copy at 4096 px on the long edge', async () => {
    const out = await processImage(await solidPng(5000, 100), MEDIA_LIMITS);
    expect(out.width).toBe(4096);
    expect(out.height).toBeLessThanOrEqual(100);
  });

  it('decides the format from the bytes: a JPEG is a JPEG whatever it was called', async () => {
    const jpegBytes = await solidJpeg(40, 30);
    expect((await processImage(jpegBytes, MEDIA_LIMITS)).format).toBe('jpeg');
  });
});

describe('processImage — limits and rejections', () => {
  it('rejects images above the pixel limit and accepts images exactly at it', async () => {
    const limits = { maxBytes: 25 * MB, maxPixels: 4_000_000 };
    const err = await imageRejection(await solidPng(2500, 2000), 'too-many-pixels', limits);
    expect(err.message).toMatch(/megapixel/);
    const ok = await processImage(await solidPng(2000, 2000), limits);
    expect([ok.width, ok.height]).toEqual([2000, 2000]);
  });

  it('rejects a decompression-bomb header without decoding the pixels', async () => {
    const bomb = forgePngDimensions(await solidPng(4, 4), 50000, 50000);
    const started = performance.now();
    await imageRejection(bomb, 'too-many-pixels');
    expect(performance.now() - started).toBeLessThan(5000);
  });

  it('rejects files over the byte limit, and empty files', async () => {
    const png = await solidPng(64, 64);
    await imageRejection(png, 'too-large', { maxBytes: png.length - 1, maxPixels: 1e9 });
    await imageRejection(Buffer.alloc(0), 'empty');
  });

  it.each<[string, Buffer]>([
    ['BMP', Buffer.concat([Buffer.from('BM'), Buffer.alloc(64)])],
    ['EMF', (() => { const b = Buffer.alloc(88); b.writeUInt32LE(1, 0); b.write(' EMF', 40, 'latin1'); return b; })()],
    ['WMF', Buffer.concat([Buffer.from([0xd7, 0xcd, 0xc6, 0x9a]), Buffer.alloc(40)])],
    ['plain text', Buffer.from('just some text')],
    ['HTML', Buffer.from('<html><body><img src=x onerror=alert(1)></body></html>')],
    ['PDF', Buffer.from('%PDF-1.7\n')],
    ['a ZIP archive', Buffer.from('PK\x03\x04rest-of-zip')],
  ])('rejects %s as an unsupported type', async (_label, buf) => {
    await imageRejection(buf, 'unsupported-type');
  });

  it('rejects a damaged PNG as corrupt', async () => {
    await imageRejection(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 7)]), 'corrupt');
  });
});

describe('SVG is untrusted: screened, then rasterized — never passed on as markup', () => {
  it('rasterizes a safe SVG to a PNG display copy at stage size', async () => {
    const out = await processImage(svg('<rect width="200" height="100" fill="#1f5fad"/><circle cx="50" cy="50" r="20" fill="#d9480f"/>'), MEDIA_LIMITS);
    expect(out).toMatchObject({ format: 'svg', originalMime: 'image/svg+xml', rasterizedFromSvg: true, width: 2048, height: 1024 });
    expect(out.display).toMatchObject({ mime: 'image/png', ext: 'png' });
    expect(sniff(out.display.data)).toBe('png');
    expect(out.display.data.includes('<svg')).toBe(false);
    expect(sniff(out.thumb.data)).toBe('webp');
  });

  it.each<[string, Buffer, RegExp]>([
    ['a <script> element', svg('<script>alert(document.domain)</script>'), /script/i],
    ['an upper-case <SCRIPT> with attributes', svg('<SCRIPT type="text/ecmascript">alert(1)</SCRIPT>'), /script/i],
    ['an onload handler', svg('<rect width="1" height="1"/>', 'width="10" height="10" onload="alert(1)"'), /event handler/i],
    ['an onclick handler with spacing', svg('<rect width="1" height="1" onclick = "alert(1)"/>'), /event handler/i],
    ['foreignObject HTML', svg('<foreignObject width="10" height="10"><iframe xmlns="http://www.w3.org/1999/xhtml" src="https://example.invalid"/></foreignObject>'), /foreignObject/i],
    ['a javascript: link', svg('<a href="javascript:alert(1)"><rect width="1" height="1"/></a>'), /javascript/i],
    ['an external https image', svg('<image href="https://example.invalid/track.png" width="1" height="1"/>'), /external/i],
    ['an xlink:href to a local file', svg('<image xlink:href="file:///etc/passwd" width="1" height="1"/>'), /external/i],
    ['a <use> of another document', svg('<use href="sprites.svg#icon"/>'), /external/i],
    ['a nested SVG data URL', svg(`<image href="data:image/svg+xml;base64,${Buffer.from('<svg onload="alert(1)"/>').toString('base64')}" width="1" height="1"/>`), /external/i],
    ['an external CSS url()', svg('<rect width="1" height="1" style="fill:url(https://example.invalid/p.svg#x)"/>'), /external resource/i],
    ['a CSS @import', svg('<style>@import "https://example.invalid/x.css";</style>'), /import/i],
    ['a DOCTYPE with entities', Buffer.from('<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x "y">]><svg xmlns="http://www.w3.org/2000/svg">&x;</svg>'), /DOCTYPE/],
    ['an external stylesheet processing instruction', Buffer.from('<?xml version="1.0"?><?xml-stylesheet href="https://example.invalid/x.css"?><svg xmlns="http://www.w3.org/2000/svg"/>'), /external/i],
  ])('rejects %s (screenSvg and processImage agree)', async (_label, buf, reason) => {
    expect(screenSvg(buf.toString('utf8'))).toMatch(reason);
    const err = await imageRejection(buf, 'unsafe-svg');
    expect(err.message).toMatch(reason);
  });

  it('allows internal references and embedded raster data URLs', async () => {
    const safe = svg(
      `<defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient><rect id="r" width="5" height="5"/></defs>` +
        `<rect width="10" height="10" fill="url(#g)"/><use href="#r"/><use xlink:href="#r"/><image href="${TINY_PNG_DATA_URL}" width="1" height="1"/>`,
    );
    expect(screenSvg(safe.toString('utf8'))).toBeNull();
    expect((await processImage(safe, MEDIA_LIMITS)).rasterizedFromSvg).toBe(true);
  });

  it('allows quoted internal url() references such as fill="url(\'#g\')"', () => {
    const quoted = `<svg xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g"/></defs><rect width="10" height="10" fill="url('#g')"/><style>.a{fill:url("#g")}</style></svg>`;
    expect(screenSvg(quoted)).toBeNull();
  });

  it('flags namespace-prefixed script and foreignObject elements too', () => {
    const prefixedScript = '<s:svg xmlns:s="http://www.w3.org/2000/svg" width="10" height="10"><s:script>alert(1)</s:script></s:svg>';
    const prefixedForeign = '<s:svg xmlns:s="http://www.w3.org/2000/svg"><s:foreignObject><body xmlns="http://www.w3.org/1999/xhtml"/></s:foreignObject></s:svg>';
    expect({ script: screenSvg(prefixedScript), foreignObject: screenSvg(prefixedForeign) }).toEqual({ script: expect.any(String), foreignObject: expect.any(String) });
  });

  it('even when screening misses something, the display copy is a raster image with no markup or script', async () => {
    const sneaky = Buffer.from('<svg:svg xmlns:svg="http://www.w3.org/2000/svg" width="40" height="40"><svg:rect width="40" height="40" fill="red"/><svg:script>alert("ns-script")</svg:script></svg:svg>');
    expect(sniff(sneaky)).toBe('svg');
    let out;
    try {
      out = await processImage(sneaky, MEDIA_LIMITS);
    } catch (err) {
      // Rejecting it is also safe.
      expect(err).toBeInstanceOf(MediaRejection);
      return;
    }
    expect(out.display.mime).toBe('image/png');
    expect(sniff(out.display.data)).toBe('png');
    expect(out.display.data.includes('script')).toBe(false);
    expect(out.display.data.includes('<svg')).toBe(false);
  });

  it('rasterizes a large-canvas but simple SVG down to stage size instead of failing', async () => {
    const big = svg('<rect width="12000" height="12000" fill="#3366cc"/>', 'width="12000" height="12000" viewBox="0 0 12000 12000"');
    const out = await processImage(big, MEDIA_LIMITS);
    expect(out.rasterizedFromSvg).toBe(true);
    expect(Math.max(out.width, out.height)).toBeLessThanOrEqual(2048);
  });

  it('applies the byte limit to SVG as well', async () => {
    const big = svg(`<desc>${'x'.repeat(5000)}</desc>`);
    await imageRejection(big, 'too-large', { maxBytes: 1000, maxPixels: MEDIA_LIMITS.maxPixels });
  });
});

describe('processAudio — audio is identified by its bytes', () => {
  const id3 = Buffer.concat([Buffer.from('ID3\x04\x00\x00\x00\x00\x00\x00', 'latin1'), Buffer.from([0xff, 0xfb, 0x90, 0x64]), Buffer.alloc(400)]);
  const frameSync = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x64]), Buffer.alloc(400)]);
  const ogg = Buffer.concat([Buffer.from('OggS\x00\x02', 'latin1'), Buffer.alloc(100)]);
  const m4a = Buffer.concat([Buffer.from('\x00\x00\x00\x1cftypM4A \x00\x00\x00\x00M4A mp42isom', 'latin1'), Buffer.alloc(100)]);

  it.each<[string, Buffer, string, string]>([
    ['MP3 with an ID3 tag', id3, 'mp3', 'audio/mpeg'],
    ['MP3 starting with a frame', frameSync, 'mp3', 'audio/mpeg'],
    ['Ogg', ogg, 'ogg', 'audio/ogg'],
    ['M4A', m4a, 'm4a', 'audio/mp4'],
  ])('accepts %s and passes the bytes through', (_label, buf, format, mime) => {
    const out = processAudio(buf, MEDIA_LIMITS);
    expect(out).toMatchObject({ kind: 'audio', format, originalMime: mime, durationSeconds: null });
    expect(out.display).toMatchObject({ mime, ext: format });
    expect(out.display.data.equals(buf)).toBe(true);
  });

  it('accepts WAV and computes its duration from the RIFF chunks', () => {
    const out = processAudio(wavFile({ sampleRate: 8000, channels: 1, bitsPerSample: 16, seconds: 2 }), MEDIA_LIMITS);
    expect(out).toMatchObject({ format: 'wav', originalMime: 'audio/wav', durationSeconds: 2 });
    const stereo = processAudio(wavFile({ sampleRate: 44100, channels: 2, bitsPerSample: 16, seconds: 0.5 }), MEDIA_LIMITS);
    expect(stereo.durationSeconds).toBe(0.5);
  });

  it('returns no duration for a WAV without a data chunk or with a zero byte rate', () => {
    const noData = wavFile({ sampleRate: 8000, channels: 1, bitsPerSample: 16, seconds: 0 }).subarray(0, 36);
    expect(processAudio(noData, MEDIA_LIMITS).durationSeconds).toBeNull();
    const zeroRate = wavFile({ sampleRate: 8000, channels: 1, bitsPerSample: 16, seconds: 0.1 });
    zeroRate.writeUInt32LE(0, 28);
    expect(processAudio(zeroRate, MEDIA_LIMITS).durationSeconds).toBeNull();
  });

  it('identifies mislabeled audio by content (WAV bytes are WAV)', () => {
    const wav = wavFile({ sampleRate: 8000, channels: 1, bitsPerSample: 8, seconds: 0.25 });
    expect(processAudio(wav, MEDIA_LIMITS).format).toBe('wav');
  });

  it('rejects non-audio, empty and oversized files', async () => {
    await audioRejection(await solidPng(4, 4), 'unsupported-type');
    await audioRejection(Buffer.from('ID-not-really'), 'unsupported-type');
    await audioRejection(Buffer.from([0xff, 0xf1, 0x50, 0x80, 0, 0]), 'unsupported-type');
    await audioRejection(Buffer.alloc(0), 'empty');
    await audioRejection(id3, 'too-large', { maxBytes: id3.length - 1, maxPixels: 1 });
  });
});
