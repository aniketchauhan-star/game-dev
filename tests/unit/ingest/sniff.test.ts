import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeZip } from '../../../fixtures/scripts/zip-writer.ts';
import { sniffUpload } from '../../../server/src/ingest/pptx.ts';
import { AUDIO_MIME, IMAGE_MIME, sniff, type SniffedType } from '../../../server/src/ingest/sniff.ts';
import { compoundFile, solidJpeg, solidPng, TempDir, wavFile } from './helpers.ts';

const bytes = (...b: number[]) => Buffer.from(b);
const ascii = (s: string, pad = 64) => Buffer.concat([Buffer.from(s, 'latin1'), Buffer.alloc(Math.max(0, pad - s.length))]);

function emf(): Buffer {
  const b = Buffer.alloc(88);
  b.writeUInt32LE(1, 0);
  b.write(' EMF', 40, 'latin1');
  return b;
}

describe('sniff — magic bytes', () => {
  it.each<[string, Buffer, SniffedType]>([
    ['ZIP local header', bytes(0x50, 0x4b, 0x03, 0x04, 0x14, 0, 0, 0), 'zip'],
    ['empty ZIP (EOCD only)', bytes(0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0), 'zip'],
    ['OLE compound file', compoundFile(), 'ole'],
    ['PDF', ascii('%PDF-1.7\n'), 'pdf'],
    ['PNG', bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), 'png'],
    ['JPEG', bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0x10), 'jpeg'],
    ['GIF87a', ascii('GIF87a'), 'gif'],
    ['GIF89a', ascii('GIF89a'), 'gif'],
    ['WebP', ascii('RIFF\x24\x00\x00\x00WEBPVP8 '), 'webp'],
    ['WAV', ascii('RIFF\x24\x00\x00\x00WAVEfmt '), 'wav'],
    ['TIFF little-endian', bytes(0x49, 0x49, 0x2a, 0x00), 'tiff'],
    ['TIFF big-endian', bytes(0x4d, 0x4d, 0x00, 0x2a), 'tiff'],
    ['BMP', ascii('BM'), 'bmp'],
    ['EMF', emf(), 'emf'],
    ['placeable WMF', bytes(0xd7, 0xcd, 0xc6, 0x9a, 0, 0), 'wmf'],
    ['standard WMF', bytes(0x01, 0x00, 0x09, 0x00, 0, 3), 'wmf'],
    ['Ogg', ascii('OggS\x00\x02'), 'ogg'],
    ['MP3 with ID3 tag', ascii('ID3\x04\x00'), 'mp3'],
    ['MP3 frame sync', bytes(0xff, 0xfb, 0x90, 0x64), 'mp3'],
    ['M4A', ascii('\x00\x00\x00\x20ftypM4A \x00\x00\x00\x00'), 'm4a'],
    ['SVG', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'svg'],
    ['SVG with XML declaration', Buffer.from('<?xml version="1.0"?>\n<!-- generator -->\n<svg xmlns="http://www.w3.org/2000/svg"/>'), 'svg'],
    ['SVG with BOM and leading whitespace', Buffer.from('﻿  \n<SVG xmlns="http://www.w3.org/2000/svg"/>'), 'svg'],
  ])('detects %s', (_label, buf, expected) => {
    expect(sniff(buf)).toBe(expected);
  });

  it.each<[string, Buffer]>([
    ['empty input', Buffer.alloc(0)],
    ['plain text', Buffer.from('hello world')],
    ['HTML', Buffer.from('<!doctype html><html><script>alert(1)</script></html>')],
    ['XML that is not SVG', Buffer.from('<?xml version="1.0"?><root/>')],
    ['AAC ADTS (not MP3)', bytes(0xff, 0xf1, 0x50, 0x80)],
    ['MP4 with an unknown brand', ascii('\x00\x00\x00\x20ftypqt  ')],
    ['RIFF that is neither WebP nor WAV', ascii('RIFF\x24\x00\x00\x00AVI LIST')],
  ])('returns "unknown" for %s', (_label, buf) => {
    expect(sniff(buf)).toBe('unknown');
  });

  it('identifies real encoder output by content', async () => {
    const opts = { create: { width: 8, height: 8, channels: 4 as const, background: '#336699' } };
    expect(sniff(await solidPng(8, 8))).toBe('png');
    expect(sniff(await solidJpeg(8, 8))).toBe('jpeg');
    expect(sniff(await sharp(opts).webp().toBuffer())).toBe('webp');
    expect(sniff(await sharp(opts).gif().toBuffer())).toBe('gif');
    expect(sniff(await sharp(opts).tiff().toBuffer())).toBe('tiff');
    expect(sniff(wavFile({ sampleRate: 8000, channels: 1, bitsPerSample: 16, seconds: 0.1 }))).toBe('wav');
    expect(sniff(writeZip([{ name: 'a.txt', data: 'a' }]))).toBe('zip');
  });

  it('maps sniffed types to MIME types', () => {
    expect(IMAGE_MIME.png).toBe('image/png');
    expect(IMAGE_MIME.jpeg).toBe('image/jpeg');
    expect(IMAGE_MIME.svg).toBe('image/svg+xml');
    expect(IMAGE_MIME.emf).toBeUndefined();
    expect(AUDIO_MIME.mp3).toBe('audio/mpeg');
    expect(AUDIO_MIME.m4a).toBe('audio/mp4');
    expect(AUDIO_MIME.png).toBeUndefined();
  });
});

describe('sniffUpload — classifies uploads by content, never by extension', () => {
  let tmp: TempDir;
  beforeAll(() => {
    tmp = new TempDir('nexus-sniff-test-');
  });
  afterAll(() => tmp.cleanup());

  it('recognises a ZIP regardless of its name', async () => {
    const zip = writeZip([{ name: 'a.txt', data: 'a' }]);
    expect(await sniffUpload(tmp.write('deck.pptx', zip))).toBe('zip');
    expect(await sniffUpload(tmp.write('photo.png', zip))).toBe('zip');
    expect(await sniffUpload(tmp.write('noext', zip))).toBe('zip');
  });

  it('recognises OLE compound files (legacy .ppt or encrypted .pptx)', async () => {
    expect(await sniffUpload(tmp.write('deck.pptx', compoundFile()))).toBe('ole');
    expect(await sniffUpload(tmp.write('deck.ppt', compoundFile()))).toBe('ole');
  });

  it('classifies everything else — including other known formats and tiny files — as "other"', async () => {
    expect(await sniffUpload(tmp.write('deck.pptx', await solidPng(4, 4)))).toBe('other');
    expect(await sniffUpload(tmp.write('deck.pptx', ascii('%PDF-1.7\n')))).toBe('other');
    expect(await sniffUpload(tmp.write('deck.pptx', Buffer.from('PK')))).toBe('other');
    expect(await sniffUpload(tmp.write('deck.pptx', Buffer.alloc(0)))).toBe('other');
  });
});
