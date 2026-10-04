import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Project-scoped file store under the data directory (never under a public
 * web directory). All paths go through `resolveInside` so a stored relative
 * path can never escape its root.
 */
export class Storage {
  constructor(readonly dataDir: string) {
    fs.mkdirSync(this.projectsRoot, { recursive: true });
    fs.mkdirSync(this.tmpRoot, { recursive: true });
    fs.mkdirSync(this.exportsRoot, { recursive: true });
  }

  get projectsRoot() {
    return path.join(this.dataDir, 'projects');
  }
  get tmpRoot() {
    return path.join(this.dataDir, 'tmp');
  }
  get exportsRoot() {
    return path.join(this.dataDir, 'exports');
  }

  /** Absolute path for a data-dir-relative path, refusing anything that escapes the data dir. */
  abs(relative: string): string {
    return resolveInside(this.dataDir, relative);
  }

  rel(absolute: string): string {
    const r = path.relative(this.dataDir, absolute);
    if (r.startsWith('..') || path.isAbsolute(r)) throw new Error('Path is outside the data directory');
    return r.split(path.sep).join('/');
  }

  projectDir(projectId: string): string {
    assertSafeId(projectId);
    return path.join(this.projectsRoot, projectId);
  }

  ensureDir(dir: string): string {
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  tmpFile(prefix: string): string {
    return path.join(this.tmpRoot, `${prefix}-${crypto.randomBytes(8).toString('hex')}`);
  }

  removeProject(projectId: string): void {
    fs.rmSync(this.projectDir(projectId), { recursive: true, force: true });
  }

  /** Remove temporary files older than `maxAgeMs` (interrupted uploads, render scratch space). */
  cleanupTmp(maxAgeMs = 6 * 60 * 60 * 1000): number {
    let removed = 0;
    const cutoff = Date.now() - maxAgeMs;
    for (const name of fs.readdirSync(this.tmpRoot)) {
      const p = path.join(this.tmpRoot, name);
      try {
        const st = fs.statSync(p);
        if (st.mtimeMs < cutoff) {
          fs.rmSync(p, { recursive: true, force: true });
          removed++;
        }
      } catch {
        // already gone
      }
    }
    return removed;
  }
}

export function assertSafeId(id: string): void {
  if (!/^[a-z]{2,5}_[A-Za-z0-9]{6,32}$/.test(id)) throw new Error('Invalid identifier');
}

/** Resolve `relative` under `root`; throws on absolute paths, `..` escapes and NUL bytes. */
export function resolveInside(root: string, relative: string): string {
  if (relative.includes('\0')) throw new Error('Invalid path');
  if (path.isAbsolute(relative)) throw new Error('Absolute paths are not allowed');
  const rootAbs = path.resolve(root);
  const target = path.resolve(rootAbs, relative);
  const rel = path.relative(rootAbs, target);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Path escapes its root');
  return target;
}

export function sha256File(file: string): string {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    let n: number;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) hash.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

export function sha256(data: Buffer | string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/** Write via a temp file + rename so readers never see a partial file. */
export function writeFileAtomic(file: string, data: Buffer | string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

/** Recursively copy a directory (used when duplicating projects so they never share files). */
export function copyDir(from: string, to: string): void {
  if (!fs.existsSync(from)) return;
  fs.cpSync(from, to, { recursive: true, errorOnExist: false, force: true, dereference: false, verbatimSymlinks: false });
}
