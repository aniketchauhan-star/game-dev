import fs from 'node:fs';
import zlib from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildPptx } from '../../../fixtures/scripts/pptx-builder.ts';
import { writeZip, type RawEntry } from '../../../fixtures/scripts/zip-writer.ts';
import { SafeZip, validateEntryName, ZipRejection, type ZipLimits, type ZipRejectionCode } from '../../../server/src/ingest/zip.ts';
import { MB, rejectionOf, TempDir } from './helpers.ts';

const LIMITS: ZipLimits = { maxEntries: 50, maxExpandedBytes: 60 * MB, maxEntryBytes: 25 * MB };

let tmp: TempDir;
beforeAll(() => {
  tmp = new TempDir('nexus-zip-test-');
});
afterAll(() => tmp.cleanup());

async function open(buf: Buffer, limits: ZipLimits = LIMITS): Promise<SafeZip> {
  return SafeZip.open(tmp.write('archive.zip', buf), limits);
}

async function openRejection(buf: Buffer, code: ZipRejectionCode, limits: ZipLimits = LIMITS): Promise<ZipRejection> {
  const err = await rejectionOf(open(buf, limits), ZipRejection);
  expect(err.code).toBe(code);
  return err;
}

describe('validateEntryName', () => {
  it.each(['[Content_Types].xml', '_rels/.rels', 'ppt/slides/slide1.xml', 'ppt/media/image 1.png', 'ppt/', 'docProps/app.xml', 'ünïcödé/naïve.xml', 'a..b/c.xml'])(
    'accepts the ordinary package name %j',
    (name) => {
      expect(validateEntryName(name)).toBeNull();
    },
  );

  it.each([
    ['', /length/],
    ['x'.repeat(513), /length/],
    ['ppt/a.xml\0.png', /NUL/],
    ['ppt\\slides\\slide1.xml', /backslash/],
    ['..\\..\\evil.dll', /backslash/],
    ['/etc/passwd', /absolute/],
    ['C:/Windows/System32/evil.dll', /absolute/],
    ['c:evil.txt', /absolute/],
    ['../evil.txt', /escapes/],
    ['ppt/../../evil.txt', /escapes/],
    ['ppt/slides/..', /escapes/],
    ['..', /escapes/],
    ['ppt//slide1.xml', /empty or dot/],
    ['./ppt/slide1.xml', /empty or dot/],
    ['ppt/./slide1.xml', /empty or dot/],
  ])('rejects %j', (name, reason) => {
    expect(validateEntryName(name)).toMatch(reason);
  });

  it('allows names up to 512 characters', () => {
    expect(validateEntryName('a'.repeat(512))).toBeNull();
  });
});

describe('SafeZip on well-formed archives', () => {
  it('lists entries with their declared sizes and reads deflated and stored data', async () => {
    const zip = await open(
      writeZip([
        { name: 'ppt/', data: '', method: 'store' },
        { name: 'ppt/presentation.xml', data: '<p:presentation/>' },
        { name: 'ppt/media/raw.bin', data: Buffer.from([1, 2, 3, 4]), method: 'store' },
      ]),
    );
    try {
      expect([...zip.entries.keys()]).toEqual(['ppt/', 'ppt/presentation.xml', 'ppt/media/raw.bin']);
      expect(zip.entries.get('ppt/')?.isDirectory).toBe(true);
      expect(zip.entries.get('ppt/presentation.xml')).toMatchObject({ isDirectory: false, uncompressedSize: 17 });
      expect(zip.totalUncompressed).toBe(17 + 4);
      expect((await zip.read('ppt/presentation.xml', 1024)).toString('utf8')).toBe('<p:presentation/>');
      expect([...(await zip.read('ppt/media/raw.bin', 4))]).toEqual([1, 2, 3, 4]);
    } finally {
      zip.close();
    }
  });

  it('resolves OOXML part names case-insensitively, while has() stays exact', async () => {
    const zip = await open(writeZip([{ name: 'PPT/Slides/Slide1.XML', data: '<x/>' }]));
    try {
      expect(zip.has('PPT/Slides/Slide1.XML')).toBe(true);
      expect(zip.has('ppt/slides/slide1.xml')).toBe(false);
      expect(zip.resolveName('ppt/slides/slide1.xml')).toBe('PPT/Slides/Slide1.XML');
      expect(zip.resolveName('ppt/slides/slide2.xml')).toBeNull();
      expect((await zip.read('ppt/slides/slide1.xml', 100)).toString()).toBe('<x/>');
    } finally {
      zip.close();
    }
  });

  it('refuses to read a missing part', async () => {
    const zip = await open(writeZip([{ name: 'a.xml', data: '<a/>' }]));
    try {
      const err = await rejectionOf(zip.read('b.xml', 100), ZipRejection);
      expect(err.code).toBe('corrupt');
      expect(err.message).toContain('b.xml');
    } finally {
      zip.close();
    }
  });

  it('refuses to read a part whose declared size exceeds the caller limit, before decompressing it', async () => {
    const zip = await open(writeZip([{ name: 'big.xml', data: 'x'.repeat(5000) }]));
    try {
      expect((await zip.read('big.xml', 5000)).length).toBe(5000);
      const err = await rejectionOf(zip.read('big.xml', 4999), ZipRejection);
      expect(err.code).toBe('too-large');
    } finally {
      zip.close();
    }
  });

  it('accepts exactly maxEntries entries', async () => {
    const entries: RawEntry[] = Array.from({ length: 5 }, (_, i) => ({ name: `f${i}.txt`, data: 'x' }));
    const zip = await open(writeZip(entries), { ...LIMITS, maxEntries: 5 });
    expect(zip.entries.size).toBe(5);
    zip.close();
  });
});

describe('SafeZip rejects hostile archives', () => {
  it.each([
    ['parent traversal', '../evil.txt'],
    ['traversal in the middle', 'ppt/slides/../../../evil.txt'],
    ['a bare ..', '..'],
    ['an absolute path', '/etc/cron.d/evil'],
    ['a drive letter', 'C:/Windows/System32/evil.dll'],
    ['a drive-relative path', 'C:evil.dll'],
    ['backslash separators', 'ppt\\..\\..\\evil.dll'],
    ['a backslash in a name', 'ppt\\slides\\slide1.xml'],
    ['a NUL byte', 'ppt/slide1.xml\0.png'],
    ['an empty segment', 'ppt//slide1.xml'],
    ['a dot segment', './ppt/slide1.xml'],
    ['an over-long name', `${'d/'.repeat(300)}x.xml`],
  ])('rejects %s with code "traversal"', async (_label, name) => {
    await openRejection(writeZip([{ name: '[Content_Types].xml', data: '<Types/>' }, { name, data: 'pwned' }]), 'traversal');
  });

  it('rejects symbolic links (Unix mode in the external attributes)', async () => {
    const err = await openRejection(writeZip([{ name: 'ppt/presentation.xml', data: '/etc/passwd', symlink: true }]), 'symlink');
    expect(err.message).toMatch(/symbolic link/i);
  });

  it('rejects entries with the encryption flag (general-purpose bit 0)', async () => {
    await openRejection(writeZip([{ name: 'a.xml', data: '<a/>' }, { name: 'ppt/presentation.xml', data: '<x/>', encryptedFlag: true }]), 'encrypted-entry');
  });

  it('rejects duplicate entry names, including case-only duplicates', async () => {
    await openRejection(writeZip([{ name: 'ppt/presentation.xml', data: '<a/>' }, { name: 'ppt/presentation.xml', data: '<b/>' }]), 'duplicate-entry');
    await openRejection(writeZip([{ name: 'ppt/presentation.xml', data: '<a/>' }, { name: 'PPT/Presentation.XML', data: '<b/>' }]), 'duplicate-entry');
  });

  it('rejects archives with more entries than allowed, without reading them', async () => {
    const entries: RawEntry[] = Array.from({ length: 6 }, (_, i) => ({ name: `f${i}.txt`, data: 'x' }));
    const err = await openRejection(writeZip(entries), 'too-many-entries', { ...LIMITS, maxEntries: 5 });
    expect(err.message).toContain('6');
  });

  it('rejects an entry whose declared size exceeds the per-entry limit', async () => {
    await openRejection(writeZip([{ name: 'a.bin', data: 'x', declaredSize: 26 * MB }]), 'too-large');
  });

  it('rejects archives whose total expanded size exceeds the limit', async () => {
    const entries: RawEntry[] = [
      { name: 'a.bin', data: Buffer.alloc(600_000) },
      { name: 'b.bin', data: Buffer.alloc(600_000) },
    ];
    await openRejection(writeZip(entries), 'too-large', { maxEntries: 10, maxExpandedBytes: 1_000_000, maxEntryBytes: 1_000_000 });
  });

  it('rejects a real compression bomb (20 MB of zeros deflated ~1000:1) before inflating it', async () => {
    const zeros = Buffer.alloc(20 * MB);
    // Precondition: this really is a >1000:1 entry.
    expect(zeros.length / zlib.deflateRawSync(zeros).length).toBeGreaterThan(1000);
    await openRejection(writeZip([{ name: 'ppt/media/bomb.bin', data: zeros }]), 'compression-bomb');
  });

  it('rejects an entry that declares a huge expansion from a tiny compressed body', async () => {
    await openRejection(writeZip([{ name: 'ppt/slides/slide1.xml', data: 'x'.repeat(100), declaredSize: 20 * MB }]), 'compression-bomb');
  });

  it('never returns more bytes than an entry declares (understated size)', async () => {
    const zip = await open(writeZip([{ name: 'ppt/slides/slide1.xml', data: 'x'.repeat(200_000), declaredSize: 10 }]));
    try {
      expect(zip.entries.get('ppt/slides/slide1.xml')?.uncompressedSize).toBe(10);
      const err = await rejectionOf(zip.read('ppt/slides/slide1.xml', 8 * MB), ZipRejection);
      expect(err.code).toBe('corrupt');
    } finally {
      zip.close();
    }
  });

  it('rejects an entry that inflates to less than it declares (overstated size)', async () => {
    const zip = await open(writeZip([{ name: 'a.xml', data: 'x'.repeat(1000), declaredSize: 5000 }]));
    try {
      const err = await rejectionOf(zip.read('a.xml', 8 * MB), ZipRejection);
      expect(err.code).toBe('corrupt');
    } finally {
      zip.close();
    }
  });

  it('rejects a stored entry whose sizes disagree', async () => {
    await openRejection(writeZip([{ name: 'a.xml', data: 'x'.repeat(1000), declaredSize: 5000, method: 'store' }]), 'corrupt');
  });

  it('rejects non-ZIP data, truncated archives and empty files as "not-zip"', async () => {
    await openRejection(Buffer.from('This is plain text, not a PowerPoint package.'), 'not-zip');
    const real = buildPptx({ slides: [{ partNumber: 1, layout: 'title', title: 'Hello' }] });
    await openRejection(real.subarray(0, Math.floor(real.length / 2)), 'not-zip');
    await openRejection(Buffer.alloc(0), 'not-zip');
  });

  it('rejects a damaged central directory as "corrupt"', async () => {
    const buf = writeZip([{ name: 'a.xml', data: '<a/>' }, { name: 'b.xml', data: '<b/>' }]);
    const cd = buf.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    expect(cd).toBeGreaterThan(0);
    buf.writeUInt32LE(0xdeadbeef, cd);
    await openRejection(buf, 'corrupt');
  });

  it('reports a missing file as "corrupt" rather than crashing', async () => {
    const err = await rejectionOf(SafeZip.open(`${tmp.dir}/does-not-exist.zip`, LIMITS), ZipRejection);
    expect(err.code).toBe('corrupt');
  });

  it('releases its file descriptor after a rejection and after close()', async () => {
    const hostile = [
      writeZip([{ name: '../evil', data: 'x' }]),
      writeZip([{ name: 'a', data: 'x', symlink: true }]),
      writeZip([{ name: 'a', data: 'x' }, { name: 'A', data: 'y' }]),
      writeZip([{ name: 'a', data: 'x', declaredSize: 26 * MB }]),
    ].map((buf) => tmp.write('hostile.zip', buf));
    const good = tmp.write('good.zip', writeZip([{ name: 'a.xml', data: '<a/>' }]));
    const baseline = openFdCount();
    for (let i = 0; i < 10; i++) {
      for (const file of hostile) await rejectionOf(SafeZip.open(file, LIMITS), ZipRejection);
      const zip = await SafeZip.open(good, LIMITS);
      await zip.read('a.xml', 100);
      zip.close();
    }
    expect(await settledFdCount(baseline)).toBeLessThanOrEqual(baseline + 2);
  });
});

/** Open descriptors of this process (macOS and Linux both expose /dev/fd). */
function openFdCount(): number {
  return fs.readdirSync('/dev/fd').length;
}

/** yauzl closes descriptors asynchronously; wait briefly for the count to settle. */
async function settledFdCount(target: number): Promise<number> {
  const deadline = Date.now() + 3000;
  let n = openFdCount();
  while (n > target && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    n = openFdCount();
  }
  return n;
}
