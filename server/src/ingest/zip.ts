import yauzl from 'yauzl';

/**
 * Defensive ZIP reader for uploaded Office packages. The central directory is
 * read and validated before any entry is decompressed; reads are capped by
 * both the declared size (yauzl `validateEntrySizes`) and an explicit limit.
 */

export interface ZipLimits {
  maxEntries: number;
  maxExpandedBytes: number;
  /** Upper bound for any single entry. */
  maxEntryBytes: number;
}

export type ZipRejectionCode =
  | 'not-zip'
  | 'corrupt'
  | 'too-many-entries'
  | 'traversal'
  | 'encrypted-entry'
  | 'symlink'
  | 'duplicate-entry'
  | 'too-large'
  | 'compression-bomb';

export class ZipRejection extends Error {
  constructor(
    readonly code: ZipRejectionCode,
    message: string,
  ) {
    super(message);
  }
}

export interface ZipEntryInfo {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  isDirectory: boolean;
}

/** Strict validation of an entry name (in addition to yauzl's own checks). */
export function validateEntryName(name: string): string | null {
  if (name.length === 0 || name.length > 512) return 'entry name has an invalid length';
  if (name.includes('\0')) return 'entry name contains a NUL byte';
  if (name.includes('\\')) return 'entry name contains a backslash';
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) return 'entry name is an absolute path';
  const segments = name.replace(/\/$/, '').split('/');
  if (segments.some((s) => s === '..')) return 'entry name escapes the archive (..)';
  if (segments.some((s) => s === '' || s === '.')) return 'entry name has empty or dot segments';
  return null;
}

function openZip(file: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: false, validateEntrySizes: true, strictFileNames: true, decodeStrings: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error('Could not open archive'));
      resolve(zip);
    });
  });
}

export class SafeZip {
  private constructor(
    private readonly zip: yauzl.ZipFile,
    private readonly raw: Map<string, yauzl.Entry>,
    readonly entries: Map<string, ZipEntryInfo>,
    readonly totalUncompressed: number,
  ) {}

  static async open(file: string, limits: ZipLimits): Promise<SafeZip> {
    let zip: yauzl.ZipFile;
    try {
      zip = await openZip(file);
    } catch (err) {
      const msg = (err as Error).message ?? '';
      if (/end of central directory/i.test(msg)) throw new ZipRejection('not-zip', 'The file is not a valid ZIP package (it may be truncated or not a PowerPoint file).');
      throw new ZipRejection('corrupt', `The package could not be opened: ${msg}`);
    }
    if (zip.entryCount > limits.maxEntries) {
      zip.close();
      throw new ZipRejection('too-many-entries', `The package has ${zip.entryCount} entries; the limit is ${limits.maxEntries}.`);
    }
    const raw = new Map<string, yauzl.Entry>();
    const entries = new Map<string, ZipEntryInfo>();
    const lowerNames = new Set<string>();
    let total = 0;
    try {
      await new Promise<void>((resolve, reject) => {
        zip.on('error', (err: Error) => reject(err));
        zip.on('end', () => resolve());
        zip.on('entry', (entry: yauzl.Entry) => {
          try {
            const name = entry.fileName;
            const problem = validateEntryName(name);
            if (problem) throw new ZipRejection('traversal', `Rejected unsafe archive entry: ${problem}.`);
            if (entry.isEncrypted()) throw new ZipRejection('encrypted-entry', 'The package contains encrypted entries.');
            const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
            if (mode === 0o120000) throw new ZipRejection('symlink', 'The package contains a symbolic link.');
            const lower = name.toLowerCase();
            if (lowerNames.has(lower)) throw new ZipRejection('duplicate-entry', `The package contains a duplicate entry (${name}).`);
            lowerNames.add(lower);
            if (entry.uncompressedSize > limits.maxEntryBytes) {
              throw new ZipRejection('too-large', `An entry expands to ${Math.round(entry.uncompressedSize / 1048576)} MB, above the per-entry limit.`);
            }
            total += entry.uncompressedSize;
            if (total > limits.maxExpandedBytes) {
              throw new ZipRejection('too-large', `The package expands beyond the ${Math.round(limits.maxExpandedBytes / 1048576)} MB limit.`);
            }
            if (entry.compressedSize > 0 && entry.uncompressedSize > 10 * 1048576 && entry.uncompressedSize / entry.compressedSize > 1000) {
              throw new ZipRejection('compression-bomb', 'The package contains an entry with a suspicious compression ratio.');
            }
            const isDirectory = name.endsWith('/');
            raw.set(name, entry);
            entries.set(name, { name, compressedSize: entry.compressedSize, uncompressedSize: entry.uncompressedSize, isDirectory });
            zip.readEntry();
          } catch (err) {
            reject(err);
          }
        });
        zip.readEntry();
      });
    } catch (err) {
      zip.close();
      if (err instanceof ZipRejection) throw err;
      const msg = (err as Error).message ?? '';
      if (/invalid relative path|absolute path|invalid characters/i.test(msg)) {
        throw new ZipRejection('traversal', `Rejected unsafe archive entry name (${msg.split(':')[0]}).`);
      }
      throw new ZipRejection('corrupt', `The package is damaged: ${msg}`);
    }
    return new SafeZip(zip, raw, entries, total);
  }

  has(name: string): boolean {
    return this.raw.has(name);
  }

  /** Find an entry case-insensitively (OOXML part names are case-insensitive). */
  resolveName(name: string): string | null {
    if (this.raw.has(name)) return name;
    const lower = name.toLowerCase();
    for (const key of this.raw.keys()) if (key.toLowerCase() === lower) return key;
    return null;
  }

  async read(name: string, maxBytes: number): Promise<Buffer> {
    const actual = this.resolveName(name);
    if (!actual) throw new ZipRejection('corrupt', `Missing package part: ${name}`);
    const entry = this.raw.get(actual)!;
    if (entry.uncompressedSize > maxBytes) {
      throw new ZipRejection('too-large', `Package part ${name} is larger than allowed (${Math.round(maxBytes / 1048576)} MB).`);
    }
    return new Promise<Buffer>((resolve, reject) => {
      this.zip.openReadStream(entry, (err, stream) => {
        if (err || !stream) return reject(new ZipRejection('corrupt', `Could not read ${name}: ${err?.message ?? 'unknown error'}`));
        const chunks: Buffer[] = [];
        let size = 0;
        stream.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            stream.destroy();
            reject(new ZipRejection('too-large', `Package part ${name} expanded beyond its declared size.`));
            return;
          }
          chunks.push(chunk);
        });
        stream.on('error', (e: Error) => reject(new ZipRejection('corrupt', `Could not decompress ${name}: ${e.message}`)));
        stream.on('end', () => resolve(Buffer.concat(chunks)));
      });
    });
  }

  close(): void {
    try {
      this.zip.close();
    } catch {
      // already closed
    }
  }
}
