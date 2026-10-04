import zlib from 'node:zlib';

/**
 * Minimal ZIP writer for fixtures and tests. Unlike production ZIP libraries it
 * deliberately allows hostile entries (traversal names, lying sizes, symlink
 * attributes, encryption flags) so the ingestion safeguards can be tested.
 */

export interface RawEntry {
  name: string;
  data: Buffer | string;
  method?: 'store' | 'deflate';
  /** Override the uncompressed size written to the headers (to simulate lying archives). */
  declaredSize?: number;
  /** Set the "encrypted" general-purpose flag. */
  encryptedFlag?: boolean;
  /** Mark the entry as a Unix symbolic link. */
  symlink?: boolean;
}

export function writeZip(entries: RawEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  const dosTime = 0x6000; // 12:00:00
  const dosDate = 0x5a21; // 2025-01-01

  for (const e of entries) {
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, 'utf8');
    const method = e.method ?? 'deflate';
    const body = method === 'deflate' ? zlib.deflateRawSync(raw) : raw;
    const crc = zlib.crc32(raw) >>> 0;
    const name = Buffer.from(e.name, 'utf8');
    const flags = 0x0800 | (e.encryptedFlag ? 0x0001 : 0);
    const size = e.declaredSize ?? raw.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method === 'deflate' ? 8 : 0, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x031e, 4); // made by: Unix, v3.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method === 'deflate' ? 8 : 0, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    const mode = e.symlink ? 0o120777 : 0o100644;
    central.writeUInt32LE(((mode << 16) >>> 0) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }

  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, cd, eocd]);
}
