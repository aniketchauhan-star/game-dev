import './env.ts';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import yauzl from 'yauzl';
import { expect } from 'vitest';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import type { BlueprintRevision } from '@shared/schemas/blueprint.ts';
import type { GameBrief } from '@shared/schemas/brief.ts';
import type { ExportKind, ExportRecord } from '@shared/schemas/exports.ts';
import type { Job, JobEvent } from '@shared/schemas/jobs.ts';
import type { ProjectDetail } from '@shared/schemas/project.ts';
import type { GameVersion } from '@shared/schemas/records.ts';
import type { Limits } from '@shared/schemas/settings.ts';
import type { SourceSlide } from '@shared/schemas/source.ts';
import { createApp, type App } from '../../../server/src/app.ts';
import { loadConfig, REPO_ROOT, type ServerConfig } from '../../../server/src/config.ts';
import { buildServer } from '../../../server/src/http/server.ts';
import { runOnce } from '../../../server/src/jobs/runner.ts';
import { resetSecretsForTests } from '../../../server/src/secrets.ts';

/**
 * Shared harness for the API + worker + database integration tests.
 *
 * Every Studio gets its own temporary data directory and its own temporary
 * `dist` directory holding a stub runtime and studio page, so tests never depend
 * on (or race with) a real `npm run build`. A second App instance on the same
 * data directory plays the worker process, exactly like production where the
 * API server and the worker share the SQLite file through separate connections.
 */

export { REPO_ROOT };

export const STUDIO_HOST = '127.0.0.1:5174';
export const STUDIO_ORIGIN = `http://${STUDIO_HOST}`;

/** A fake key used only to prove the real key handling never leaks a key. Never valid anywhere. */
export const FAKE_KEY = 'sk-ant-test-FAKEKEY-123456789';

/**
 * A loopback TCP server that accepts and immediately drops every connection.
 * Tests that set a fake key point the Claude base URL here, so any SDK call
 * fails locally with a connection error and can never reach Anthropic.
 */
export async function startClaudeSink(): Promise<{ url: string; connections: () => number; close: () => Promise<void> }> {
  let count = 0;
  const server = net.createServer((socket) => {
    count++;
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    connections: () => count,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export const SAMPLE_DECK_PATH = path.join(REPO_ROOT, 'fixtures', 'sample', 'air-traffic-control.pptx');
export const SAMPLE_PROJECT_NAME = 'Air Traffic Control — Coordinate Mission';

/** Slide titles of the bundled deck in PRESENTATION order (slide10.xml is 4th; slide5.xml is hidden). */
export const SAMPLE_TITLES_IN_ORDER = [
  'Air Traffic Control: Coordinate Mission',
  'The airfield is a coordinate plane',
  'Reading an ordered pair (x, y)',
  'The four quadrants',
  'Negative coordinates',
  'Teacher answer key',
  'Tower to runway: plotting steps',
  'Extension: distance between two aircraft',
  'Mission practice',
] as const;
export const SAMPLE_PART_ORDER = [1, 2, 3, 10, 4, 5, 6, 7, 8] as const;
export const SAMPLE_HIDDEN_SLIDE_NUMBER = 6;

/** Speaker-notes sentences from the bundled deck. They must never reach a playable export. */
export const SAMPLE_NOTES_SENTENCES = [
  'Hook: ask how air traffic controllers say exactly where an aircraft is.',
  'Draw both axes on the board. Stress equal spacing on both axes.',
  'Common mistake: swapping x and y.',
  'Hidden slide — not shown to learners.',
  'Model each step with flight NX7 before learners try.',
] as const;

let sampleDeckCache: Buffer | null = null;
export function sampleDeck(): Buffer {
  sampleDeckCache ??= fs.readFileSync(SAMPLE_DECK_PATH);
  return sampleDeckCache;
}

/** OLE compound-file header: legacy .ppt files and password-protected (encrypted) Office files. */
export function oleFile(size = 4096): Buffer {
  return Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), crypto.randomBytes(size)]);
}

export function sha256(data: Buffer | string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/** Same shape as the studio's `newIdempotencyKey()` (24 hex characters). */
export function idempotencyKey(): string {
  return crypto.randomBytes(12).toString('hex');
}

export function tempDir(prefix = 'nexus-it-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Set (or clear) the server's Anthropic key for the current process and forget the cached value. */
export function setApiKey(key: string | null): void {
  if (key === null) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = key;
  resetSecretsForTests();
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS' | 'HEAD';
export type Res = LightMyRequestResponse;

/** Headers the studio sends: Host always; CSRF header, Origin and Fetch Metadata on state-changing requests. */
export function studioHeaders(method: Method): Record<string, string> {
  const h: Record<string, string> = { host: STUDIO_HOST, accept: 'application/json' };
  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
    h['x-nexus-csrf'] = '1';
    h.origin = STUDIO_ORIGIN;
    h['sec-fetch-site'] = 'same-origin';
  }
  return h;
}

export type MultipartPart = { name: string; value: string } | { name: string; filename: string; data: Buffer; contentType?: string };

export function multipart(parts: MultipartPart[]): { payload: Buffer; contentType: string } {
  const boundary = `----nexus-it-${crypto.randomBytes(12).toString('hex')}`;
  const chunks: Buffer[] = [];
  for (const p of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    if ('filename' in p) {
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${p.name}"; filename="${p.filename}"\r\nContent-Type: ${p.contentType ?? 'application/octet-stream'}\r\n\r\n`));
      chunks.push(p.data, Buffer.from('\r\n'));
    } else {
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${p.name}"\r\n\r\n${p.value}\r\n`));
    }
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

export interface StudioOptions {
  limits?: Partial<Limits>;
  claude?: Partial<ServerConfig['claude']>;
  /** `stub` (default): private dist dir with a stub runtime + studio page. `empty`: nothing built. */
  dist?: 'stub' | 'empty';
}

export const STUB_RUNTIME_FILES = ['runtime/runtime.js', 'runtime/runtime.css', 'runtime/fonts/stub-font.woff2'] as const;
export const DIST_SENTINEL = 'DIST-ROOT-SENTINEL-must-never-be-served';

function writeStubDist(distDir: string): void {
  const files: Record<string, string | Buffer> = {
    'runtime/runtime.js': '/* NEXUS runtime — integration-test stub */\n(function () { "use strict"; })();\n',
    'runtime/runtime.css': '/* NEXUS runtime styles — integration-test stub */\n.nx-root { display: block; }\n',
    'runtime/runtime.js.map': '{"version":3,"sources":[],"names":[],"mappings":""}\n',
    'runtime/fonts/stub-font.woff2': Buffer.concat([Buffer.from('wOF2'), Buffer.alloc(60)]),
    'studio/index.html': '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>NEXUS Play Studio</title><script type="module" src="/assets/index-stub.js"></script></head><body><div id="root"></div></body></html>\n',
    'studio/assets/index-stub.js': 'export {};\n',
    'OUTSIDE-SENTINEL.txt': DIST_SENTINEL,
  };
  for (const [rel, data] of Object.entries(files)) {
    const file = path.join(distDir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, data);
  }
}

export class Studio {
  private readonly apps: App[] = [];
  private closed = false;

  private constructor(
    readonly app: App,
    readonly worker: App,
    readonly f: FastifyInstance,
    readonly dataDir: string,
    readonly distDir: string,
    private readonly overrides: Partial<ServerConfig>,
  ) {
    this.apps.push(app, worker);
  }

  static async start(opts: StudioOptions = {}): Promise<Studio> {
    const dataDir = tempDir('nexus-it-');
    const distDir = tempDir('nexus-it-dist-');
    if ((opts.dist ?? 'stub') === 'stub') writeStubDist(distDir);
    const base = loadConfig({ dataDir, distDir });
    const overrides: Partial<ServerConfig> = {
      dataDir,
      distDir,
      limits: { ...base.limits, ...opts.limits },
      claude: { ...base.claude, ...opts.claude },
    };
    const app = createApp(overrides);
    const f = await buildServer(app, { logger: false });
    // The worker is a separate App (separate SQLite connection) on the same data directory.
    const worker = createApp(overrides);
    return new Studio(app, worker, f, dataDir, distDir, overrides);
  }

  /** Another process-like App on the same data directory (for example a second worker). */
  openApp(): App {
    const a = createApp(this.overrides);
    this.apps.push(a);
    return a;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.f.close();
    for (const a of this.apps) {
      try {
        a.db.close();
      } catch {
        // already closed by the test
      }
    }
    if (!process.env.NEXUS_IT_KEEP) {
      fs.rmSync(this.dataDir, { recursive: true, force: true });
      fs.rmSync(this.distDir, { recursive: true, force: true });
    }
  }

  // ── HTTP ──

  inject(opts: InjectOptions): Promise<Res> {
    return this.f.inject(opts);
  }

  request(method: Method, url: string, body?: unknown, headers: Record<string, string | undefined> = {}): Promise<Res> {
    const h: Record<string, string> = { ...studioHeaders(method) };
    if (body !== undefined) h['content-type'] = 'application/json';
    for (const [k, v] of Object.entries(headers)) {
      if (v === undefined) delete h[k];
      else h[k] = v;
    }
    return this.f.inject({ method, url, headers: h, payload: body === undefined ? undefined : JSON.stringify(body) });
  }

  get(url: string, headers: Record<string, string | undefined> = {}): Promise<Res> {
    return this.request('GET', url, undefined, headers);
  }
  post(url: string, body?: unknown, headers: Record<string, string | undefined> = {}): Promise<Res> {
    return this.request('POST', url, body, headers);
  }
  put(url: string, body?: unknown, headers: Record<string, string | undefined> = {}): Promise<Res> {
    return this.request('PUT', url, body, headers);
  }
  patch(url: string, body?: unknown, headers: Record<string, string | undefined> = {}): Promise<Res> {
    return this.request('PATCH', url, body, headers);
  }
  del(url: string, body?: unknown, headers: Record<string, string | undefined> = {}): Promise<Res> {
    return this.request('DELETE', url, body, headers);
  }

  upload(projectId: string, file: { filename: string; data: Buffer; contentType?: string }, fields: Record<string, string> = {}, headers: Record<string, string | undefined> = {}): Promise<Res> {
    const { payload, contentType } = multipart([...Object.entries(fields).map(([name, value]) => ({ name, value })), { name: 'file', ...file }]);
    const h: Record<string, string> = { ...studioHeaders('POST'), 'content-type': contentType };
    for (const [k, v] of Object.entries(headers)) {
      if (v === undefined) delete h[k];
      else h[k] = v;
    }
    return this.f.inject({ method: 'POST', url: `/api/projects/${projectId}/sources`, headers: h, payload });
  }

  // ── worker ──

  /** Run queued jobs on the worker App until the queue is empty. Returns how many ran. */
  async runJobs(workerId = 'it-worker', max = 25): Promise<number> {
    let n = 0;
    while (n < max && (await runOnce(this.worker, workerId))) n++;
    return n;
  }

  // ── typed conveniences ──

  async createProject(name?: string): Promise<ProjectDetail> {
    const res = await this.post('/api/projects', name === undefined ? {} : { name });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().project as ProjectDetail;
  }

  async project(id: string): Promise<ProjectDetail> {
    const res = await this.get(`/api/projects/${id}`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json().project as ProjectDetail;
  }

  async slides(projectId: string): Promise<SourceSlide[]> {
    const res = await this.get(`/api/projects/${projectId}/slides`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json().slides as SourceSlide[];
  }

  async job(id: string): Promise<{ job: Job; events: JobEvent[] }> {
    const res = await this.get(`/api/jobs/${id}`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as { job: Job; events: JobEvent[] };
  }

  async saveBrief(projectId: string, patch: Partial<GameBrief>): Promise<{ briefRevision: number }> {
    const p = await this.project(projectId);
    const res = await this.put(`/api/projects/${projectId}/brief`, { brief: { ...p.brief, ...patch }, revision: p.briefRevision });
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as { briefRevision: number };
  }

  /** Upload a deck, run the extraction job on the worker and return the job and slides. */
  async importDeck(projectId: string, data: Buffer = sampleDeck(), filename = 'air-traffic-control.pptx'): Promise<{ job: Job; slides: SourceSlide[] }> {
    const up = await this.upload(projectId, { filename, data, contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' });
    expect(up.statusCode, up.body).toBe(202);
    const jobId = up.json().job.id as string;
    await this.runJobs();
    const { job } = await this.job(jobId);
    expect(job.status, JSON.stringify(job.error)).toBe('succeeded');
    return { job, slides: await this.slides(projectId) };
  }

  async createSample(): Promise<ProjectDetail> {
    const res = await this.post('/api/projects/sample');
    expect(res.statusCode, res.body).toBe(201);
    return res.json().project as ProjectDetail;
  }

  /** Hand-start a blueprint, write the required premise and approve it. */
  async approvedManualBlueprint(projectId: string, edit: (b: BlueprintRevision['blueprint']) => void = () => {}): Promise<BlueprintRevision> {
    const created = await this.post(`/api/projects/${projectId}/blueprints/manual`);
    expect(created.statusCode, created.body).toBe(201);
    const draft = created.json().revision as BlueprintRevision;
    const blueprint = structuredClone(draft.blueprint);
    blueprint.premise = 'Learners are explorers who unlock each idea from the lesson in order.';
    edit(blueprint);
    const saved = await this.put(`/api/blueprints/${draft.id}`, { blueprint, revision: draft.revision });
    expect(saved.statusCode, saved.body).toBe(200);
    const rev = saved.json().revision as BlueprintRevision;
    const approved = await this.post(`/api/blueprints/${rev.id}/approve`, { revision: rev.revision });
    expect(approved.statusCode, approved.body).toBe(200);
    return approved.json().revision as BlueprintRevision;
  }

  /** Queue a build of the approved blueprint (as the studio does), run it and return the new version. */
  async build(projectId: string, blueprintRevisionId?: string): Promise<GameVersion> {
    const revisionId = blueprintRevisionId ?? (await this.project(projectId)).approvedBlueprintId;
    expect(revisionId, 'an approved blueprint to build').toBeTruthy();
    const res = await this.post(`/api/projects/${projectId}/jobs`, { type: 'build', input: { blueprintRevisionId: revisionId } }, { 'idempotency-key': idempotencyKey() });
    expect(res.statusCode, res.body).toBe(202);
    const jobId = res.json().job.id as string;
    await this.runJobs();
    const { job } = await this.job(jobId);
    expect(job.status, JSON.stringify(job.error)).toBe('succeeded');
    const versionId = (job.result as { versionId: string }).versionId;
    const v = await this.get(`/api/versions/${versionId}`);
    expect(v.statusCode, v.body).toBe(200);
    return v.json().version as GameVersion;
  }

  /** Create an export through the API, download it and read every entry. */
  async exportZip(
    projectId: string,
    body: { kind: ExportKind; includeSourceMaterial?: boolean; nextChanges?: string; versionId?: string | null },
  ): Promise<{ record: ExportRecord; zip: Buffer; entries: Map<string, Buffer> }> {
    const res = await this.post(`/api/projects/${projectId}/exports`, body);
    expect(res.statusCode, res.body).toBe(201);
    const record = res.json().export as ExportRecord;
    const dl = await this.get(`/api/exports/${record.id}/download`);
    expect(dl.statusCode, dl.body.slice(0, 300)).toBe(200);
    expect(dl.headers['content-type']).toBe('application/zip');
    const zip = dl.rawPayload;
    return { record, zip, entries: await readZip(zip) };
  }
}

/** Read every file entry of a ZIP with yauzl (strict names: absolute or `..` names make it fail). */
export function readZip(buf: Buffer): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buf, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true, decodeStrings: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error('Could not open ZIP'));
      const out = new Map<string, Buffer>();
      zip.on('error', reject);
      zip.on('end', () => resolve(out));
      zip.on('entry', (entry: yauzl.Entry) => {
        if (entry.fileName.endsWith('/')) {
          out.set(entry.fileName, Buffer.alloc(0));
          zip.readEntry();
          return;
        }
        zip.openReadStream(entry, (e, stream) => {
          if (e || !stream) return reject(e ?? new Error('Could not read entry'));
          const chunks: Buffer[] = [];
          stream.on('data', (c: Buffer) => chunks.push(c));
          stream.on('error', reject);
          stream.on('end', () => {
            out.set(entry.fileName, Buffer.concat(chunks));
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
}

/** A ZIP entry name that is relative, has no `.`/`..`/empty segments, no backslashes and no drive letter. */
export function isSafeRelativeEntry(name: string): boolean {
  if (name.length === 0 || name.startsWith('/') || name.includes('\\') || name.includes('\0') || /^[a-zA-Z]:/.test(name)) return false;
  const segments = name.replace(/\/$/, '').split('/');
  return segments.every((s) => s !== '' && s !== '.' && s !== '..');
}

/** Every SQLite file of a data directory (main file plus WAL/SHM) as one buffer, for byte-level secret scans. */
export function databaseBytes(dataDir: string): Buffer {
  const parts = ['nexus.sqlite', 'nexus.sqlite-wal', 'nexus.sqlite-shm']
    .map((n) => path.join(dataDir, n))
    .filter((p) => fs.existsSync(p))
    .map((p) => fs.readFileSync(p));
  return Buffer.concat(parts);
}

/** All regular files below a directory (absolute paths). */
export function listFilesRecursive(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFilesRecursive(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}
