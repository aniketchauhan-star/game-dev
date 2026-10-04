import { describe, expect, it } from 'vitest';
import { safeZipPath, slugify } from '../../../server/src/export/paths.ts';
import { safeRelativePath } from '@shared/schemas/game.ts';

describe('safeZipPath', () => {
  it.each([
    'index.html',
    'game/config.json',
    'assets/ast_aircraft01.png',
    'docs/Design Document (v2).md',
    'source-material/doc_1-air-traffic-control.pptx',
    'a+b/c-d_e.f',
  ])('accepts %s and returns it unchanged', (p) => {
    expect(safeZipPath(p)).toBe(p);
  });

  it.each([
    ['../escape.txt', 'segments'],
    ['assets/../../etc/passwd', 'segments'],
    ['assets/..', 'segments'],
    ['./index.html', 'segments'],
    ['assets/./x.png', 'segments'],
    ['assets//x.png', 'segments'],
    ['assets/', 'segments'],
    ['/etc/passwd', 'absolute'],
    ['C:/Windows/system32', 'absolute'],
    ['c:evil.txt', 'absolute'],
    ['assets\\x.png', 'characters'],
    ['..\\..\\evil.exe', 'characters'],
    ['ok\0.png', 'characters'],
    ['.hidden', 'name'],
    ['assets/.env', 'name'],
    ['assets/-rf', 'name'],
    ['assets/naïve.png', 'name'],
    ['assets/a:b.png', 'name'],
    ['assets/x?.png', 'name'],
    ['', 'length'],
    [`a/${'x'.repeat(240)}`, 'length'],
  ])('rejects %j (%s)', (p, reason) => {
    expect(() => safeZipPath(p)).toThrow(`Unsafe export path (${reason})`);
  });

  it('accepts a path of exactly 240 characters', () => {
    const p = `a/${'x'.repeat(238)}`;
    expect(p).toHaveLength(240);
    expect(safeZipPath(p)).toBe(p);
  });
});

describe('slugify', () => {
  it('lowercases, strips accents and joins words with single dashes', () => {
    expect(slugify('Air Traffic Control — Coordinate Mission')).toBe('air-traffic-control-coordinate-mission');
    expect(slugify('Café Olé: Ünïcode Ånd Àccents')).toBe('cafe-ole-unicode-and-accents');
    expect(slugify('  --Hello,   World!--  ')).toBe('hello-world');
    expect(slugify('Grade 9 · Maths (v2)')).toBe('grade-9-maths-v2');
  });

  it('falls back to "game" when nothing usable remains', () => {
    for (const s of ['', '   ', '!!!', '—', '🚀🚀', 'गणित', '数学']) expect(slugify(s), s).toBe('game');
  });

  it('neutralises path syntax', () => {
    expect(slugify('../../etc/passwd')).toBe('etc-passwd');
    expect(slugify('C:\\Windows\\System32')).toBe('c-windows-system32');
    expect(slugify('a/b\\c\0d')).toBe('a-b-c-d');
  });

  it('limits the length to 60 characters', () => {
    expect(slugify('x'.repeat(100))).toHaveLength(60);
  });

  const NASTY = [
    'Air Traffic Control — Coordinate Mission',
    '../../etc/passwd',
    'CON',
    '.hidden',
    '-leading-dash',
    'name with spaces and (parens) + plus',
    'tab\tand\nnewline',
    `${'word '.repeat(11)}tail`,
    `${'a'.repeat(59)} b`,
    `${'ab '.repeat(30)}`,
    'Ⅻ ﬁve ①',
  ];

  it.each(NASTY)('output for %j is a filesystem-safe name usable in export paths', (input) => {
    const slug = slugify(input);
    expect(slug).toMatch(/^[a-z0-9-]+$/);
    expect(slug.length).toBeGreaterThan(0);
    expect(slug.length).toBeLessThanOrEqual(60);
    expect(() => safeZipPath(`${slug}/index.html`)).not.toThrow();
    expect(() => safeZipPath(`${slug}.zip`)).not.toThrow();
    expect(safeRelativePath.safeParse(`${slug}/game.json`).success).toBe(true);
  });

  it.each(NASTY)('output for %j has no leading, trailing or doubled dashes', (input) => {
    const slug = slugify(input);
    expect(slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });
});
