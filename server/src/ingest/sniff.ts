/** File type detection from magic bytes — never from the file extension or the client's MIME type. */

export type SniffedType =
  | 'zip'
  | 'ole'
  | 'pdf'
  | 'png'
  | 'jpeg'
  | 'gif'
  | 'webp'
  | 'svg'
  | 'tiff'
  | 'bmp'
  | 'emf'
  | 'wmf'
  | 'mp3'
  | 'ogg'
  | 'wav'
  | 'm4a'
  | 'unknown';

export function sniff(buf: Buffer): SniffedType {
  const b = (i: number) => buf[i] ?? -1;
  const ascii = (start: number, len: number) => buf.subarray(start, start + len).toString('latin1');
  if (b(0) === 0x50 && b(1) === 0x4b && (b(2) === 0x03 || b(2) === 0x05 || b(2) === 0x07)) return 'zip';
  if (b(0) === 0xd0 && b(1) === 0xcf && b(2) === 0x11 && b(3) === 0xe0 && b(4) === 0xa1 && b(5) === 0xb1 && b(6) === 0x1a && b(7) === 0xe1) return 'ole';
  if (ascii(0, 5) === '%PDF-') return 'pdf';
  if (b(0) === 0x89 && ascii(1, 3) === 'PNG') return 'png';
  if (b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return 'jpeg';
  if (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a') return 'gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return 'webp';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE') return 'wav';
  if ((b(0) === 0x49 && b(1) === 0x49 && b(2) === 0x2a && b(3) === 0x00) || (b(0) === 0x4d && b(1) === 0x4d && b(2) === 0x00 && b(3) === 0x2a)) return 'tiff';
  if (ascii(0, 2) === 'BM') return 'bmp';
  if (b(0) === 0x01 && b(1) === 0x00 && b(2) === 0x00 && b(3) === 0x00 && ascii(40, 4) === ' EMF') return 'emf';
  if ((b(0) === 0xd7 && b(1) === 0xcd && b(2) === 0xc6 && b(3) === 0x9a) || (b(0) === 0x01 && b(1) === 0x00 && b(2) === 0x09 && b(3) === 0x00)) return 'wmf';
  if (ascii(0, 4) === 'OggS') return 'ogg';
  if (ascii(0, 3) === 'ID3' || (b(0) === 0xff && (b(1) & 0xe0) === 0xe0 && (b(1) & 0x06) !== 0)) return 'mp3';
  if (ascii(4, 4) === 'ftyp') {
    const brand = ascii(8, 4);
    if (['M4A ', 'M4B ', 'mp42', 'isom', 'iso2', 'dash'].includes(brand)) return 'm4a';
  }
  const head = buf.subarray(0, 512).toString('utf8').replace(/^﻿/, '').trimStart().toLowerCase();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'svg';
  return 'unknown';
}

export const IMAGE_MIME: Partial<Record<SniffedType, string>> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  tiff: 'image/tiff',
};

export const AUDIO_MIME: Partial<Record<SniffedType, 'audio/mpeg' | 'audio/ogg' | 'audio/wav' | 'audio/mp4'>> = {
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
};
