/**
 * Harness for the Claude integration tests: the REAL gateway + official SDK +
 * Fastify API + worker + SQLite, talking to the local mock in mock-anthropic.ts.
 *
 * Safety rails (evaluated when this module loads, before any server module is
 * imported — server modules are only ever loaded with dynamic `import()` from
 * `Studio.start`, after the environment below is in place):
 *  - NEXUS_ENV_FILE points at a file that does not exist, so a developer's real
 *    `.env` (and real key) is never loaded;
 *  - every Claude / server tuning variable inherited from the shell is cleared;
 *  - `globalThis.fetch` refuses any non-loopback destination, so even a
 *    mis-configured base URL can never reach api.anthropic.com;
 *  - the only key ever set is FAKE_KEY.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspect } from 'node:util';
import yauzl from 'yauzl';
import { vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Job, JobEvent } from '@shared/schemas/jobs.ts';
import type { ClaudeStatus, Health } from '@shared/schemas/settings.ts';
import type { SourceSlide } from '@shared/schemas/source.ts';
import type { App } from '../../../server/src/app.ts';
import type { ServerConfig } from '../../../server/src/config.ts';
import type { AiAnalysis } from '../../../server/src/claude/schemas.ts';
import { buildPptx } from '../../../fixtures/scripts/pptx-builder.ts';
import { MockAnthropic, modelInfo, type RecordedRequest } from './mock-anthropic.ts';

export const FAKE_KEY = 'sk-ant-test-FAKEKEY-0123456789abcdef';
export const TEST_MODEL = 'claude-opus-5-5';
export const STUDIO_HOST = '127.0.0.1:5174';

// ───────────────────────────── environment isolation ─────────────────────────────

export const MISSING_ENV_FILE = path.join(os.tmpdir(), `nexus-claude-it-${process.pid}`, 'this-file-does-not-exist.env');
process.env.NEXUS_ENV_FILE = MISSING_ENV_FILE;

const CLEARED_ENV = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_PROFILE',
  'ANTHROPIC_LOG',
  'CLAUDE_MODEL',
  'CLAUDE_REFUSAL_FALLBACK',
  'CLAUDE_TIMEOUT_MS',
  'CLAUDE_MAX_RETRIES',
  'CLAUDE_MAX_REPAIR_ATTEMPTS',
  'CLAUDE_PRICING_FILE',
  'NEXUS_DATA_DIR',
  'NEXUS_ALLOW_REMOTE',
  'HOST',
  'PORT',
  'STUDIO_DEV_PORT',
  'ALLOWED_HOSTS',
  'RENDERER',
  'SOFFICE_PATH',
  'RENDERER_DOCKER_IMAGE',
  'FIGMA_ACCESS_TOKEN',
  'FIGMA_API_BASE_URL',
  'FIGMA_ASSET_HOSTS',
];
for (const name of CLEARED_ENV) delete process.env[name];
process.env.RENDERER = 'off';

/** Non-loopback URLs anything in this process tried to fetch (always expected to stay empty). */
export const blockedRequests: string[] = [];

(function installNetworkGuard() {
  const g = globalThis as { __nexusClaudeFetchGuard?: boolean };
  if (g.__nexusClaudeFetchGuard) return;
  g.__nexusClaudeFetchGuard = true;
  const realFetch = globalThis.fetch;
  const local = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href);
    if (!local.has(url.hostname)) {
      blockedRequests.push(url.origin);
      throw new Error(`[claude-it] blocked a non-local request to ${url.origin}: these tests only talk to the local mock`);
    }
    return realFetch(input, init);
  }) as typeof fetch;
})();

export interface ClaudeEnv {
  /** ANTHROPIC_API_KEY; null leaves it unset. Default FAKE_KEY. */
  key?: string | null;
  /** CLAUDE_MODEL; null leaves it unset. Default TEST_MODEL. */
  model?: string | null;
  timeoutMs?: number;
  maxRetries?: number;
  maxRepairAttempts?: number;
  refusalFallback?: 'default' | 'off';
}

function setOrDelete(name: string, value: string | null): void {
  if (value === null) delete process.env[name];
  else process.env[name] = value;
}

/** Point the server at the mock. Read by loadConfig()/getApiKey() when the next App is created. */
export function applyClaudeEnv(baseUrl: string, env: ClaudeEnv): void {
  setOrDelete('ANTHROPIC_API_KEY', env.key === undefined ? FAKE_KEY : env.key);
  process.env.ANTHROPIC_BASE_URL = baseUrl;
  setOrDelete('CLAUDE_MODEL', env.model === undefined ? TEST_MODEL : env.model);
  setOrDelete('CLAUDE_TIMEOUT_MS', env.timeoutMs === undefined ? null : String(env.timeoutMs));
  process.env.CLAUDE_MAX_RETRIES = String(env.maxRetries ?? 2);
  process.env.CLAUDE_MAX_REPAIR_ATTEMPTS = String(env.maxRepairAttempts ?? 1);
  process.env.CLAUDE_REFUSAL_FALLBACK = env.refusalFallback ?? 'default';
}

async function loadServerModules() {
  const [appMod, httpMod, runnerMod, secretsMod] = await Promise.all([
    import('../../../server/src/app.ts'),
    import('../../../server/src/http/server.ts'),
    import('../../../server/src/jobs/runner.ts'),
    import('../../../server/src/secrets.ts'),
  ]);
  return {
    createApp: appMod.createApp,
    buildServer: httpMod.buildServer,
    runOnce: runnerMod.runOnce,
    resetSecretsForTests: secretsMod.resetSecretsForTests,
    redactSecrets: secretsMod.redactSecrets,
    getApiKey: secretsMod.getApiKey,
  };
}
export type ServerModules = Awaited<ReturnType<typeof loadServerModules>>;

// ───────────────────────────── mock ─────────────────────────────

export async function startMock(): Promise<MockAnthropic> {
  const mock = await MockAnthropic.start({
    models: [
      modelInfo(TEST_MODEL, { displayName: 'Claude Opus 5.5' }),
      modelInfo('claude-sonnet-5-5', { displayName: 'Claude Sonnet 5.5' }),
      modelInfo('claude-haiku-4-5', { displayName: 'Claude Haiku 4.5', effort: false, maxInputTokens: 200_000, maxTokens: 64_000 }),
    ],
  });
  mock.expectedKey = FAKE_KEY;
  return mock;
}

// ───────────────────────────── studio (app + API + worker) ─────────────────────────────

export interface ApiResult<T> {
  status: number;
  body: T;
  raw: string;
  rawPayload: Buffer;
  headers: Record<string, unknown>;
}

export interface RecordedResponse {
  method: string;
  url: string;
  status: number;
  body: string;
}

export interface JobDetail {
  job: Job;
  events: JobEvent[];
}

/** Error envelope every API route uses. */
export interface ApiErrorBody {
  code: string;
  message: string;
  hint: string | null;
  details: unknown;
}

/** POST /api/projects/:id/jobs — `job` on 2xx, `error` otherwise. */
export interface JobCreateResponse {
  job: Job;
  deduplicated: boolean;
  error: ApiErrorBody;
}

const STUB_RUNTIME_JS = '/* stub runtime for integration tests */\nwindow.NEXUS_RUNTIME_STUB = true;\n';
const STUB_RUNTIME_CSS = '/* stub runtime styles */\n.nx-root{display:block}\n';

export class Studio {
  /** Every API response body fetched through this studio (for secret scans). */
  readonly responses: RecordedResponse[] = [];
  readonly workerId = `claude-it-worker-${process.pid}`;

  private constructor(
    readonly mock: MockAnthropic,
    readonly mods: ServerModules,
    readonly app: App,
    readonly server: FastifyInstance,
    readonly rootDir: string,
  ) {}

  static async start(mock: MockAnthropic, env: ClaudeEnv = {}, overrides: Partial<ServerConfig> = {}): Promise<Studio> {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-claude-it-'));
    const dataDir = path.join(rootDir, 'data');
    const distDir = path.join(rootDir, 'dist');
    fs.mkdirSync(path.join(distDir, 'runtime'), { recursive: true });
    fs.writeFileSync(path.join(distDir, 'runtime', 'runtime.js'), STUB_RUNTIME_JS);
    fs.writeFileSync(path.join(distDir, 'runtime', 'runtime.css'), STUB_RUNTIME_CSS);
    applyClaudeEnv(mock.url, env);
    const mods = await loadServerModules();
    mods.resetSecretsForTests();
    const app = mods.createApp({ dataDir, distDir, ...overrides });
    // Hard guard: never let a test run against anything but the local mock.
    if (app.config.claude.baseUrl !== mock.url) {
      app.db.close();
      throw new Error(`Claude base URL is ${app.config.claude.baseUrl}, expected the mock at ${mock.url}`);
    }
    const expectedKey = env.key === undefined ? FAKE_KEY : env.key;
    if (mods.getApiKey() !== (expectedKey && expectedKey.trim() ? expectedKey.trim() : null)) {
      app.db.close();
      throw new Error('The server did not pick up the test key configuration');
    }
    const server = await mods.buildServer(app);
    await server.ready();
    return new Studio(mock, mods, app, server, rootDir);
  }

  get dataDir(): string {
    return this.app.config.dataDir;
  }

  async close(): Promise<void> {
    await this.server.close();
    try {
      this.app.db.close();
    } catch {
      // already closed
    }
    fs.rmSync(this.rootDir, { recursive: true, force: true });
  }

  // ── HTTP ──

  async request<T = any>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body?: unknown, headers: Record<string, string> = {}): Promise<ApiResult<T>> {
    const h: Record<string, string> = { host: STUDIO_HOST, 'x-nexus-csrf': '1', ...headers };
    let payload: string | Buffer | undefined;
    if (body !== undefined) {
      if (Buffer.isBuffer(body)) payload = body;
      else {
        payload = JSON.stringify(body);
        h['content-type'] ??= 'application/json';
      }
    }
    const res = await this.server.inject({ method, url, headers: h, ...(payload !== undefined ? { payload } : {}) });
    this.responses.push({ method, url, status: res.statusCode, body: res.body });
    let parsed: T;
    try {
      parsed = res.json() as T;
    } catch {
      parsed = undefined as T;
    }
    return { status: res.statusCode, body: parsed, raw: res.body, rawPayload: res.rawPayload, headers: res.headers as Record<string, unknown> };
  }

  get<T = any>(url: string): Promise<ApiResult<T>> {
    return this.request<T>('GET', url);
  }

  post<T = any>(url: string, body?: unknown): Promise<ApiResult<T>> {
    return this.request<T>('POST', url, body);
  }

  put<T = any>(url: string, body?: unknown): Promise<ApiResult<T>> {
    return this.request<T>('PUT', url, body);
  }

  async health(): Promise<Health> {
    return (await this.get<Health>('/api/health')).body;
  }

  async claudeStatus(): Promise<ClaudeStatus> {
    return (await this.health()).claude;
  }

  /** Settings → “Test connection” (Models API lookup of the configured model). */
  async testConnection(testRequest = false): Promise<ClaudeStatus> {
    const r = await this.post<{ claude: ClaudeStatus }>('/api/settings/claude/test', { testRequest });
    if (r.status !== 200) throw new Error(`test connection failed with HTTP ${r.status}: ${r.raw}`);
    return r.body.claude;
  }

  async getJob(jobId: string): Promise<JobDetail> {
    const r = await this.get<JobDetail>(`/api/jobs/${jobId}`);
    if (r.status !== 200) throw new Error(`GET job ${jobId} → ${r.status}: ${r.raw}`);
    return r.body;
  }

  async uploadDeck(projectId: string, data: Buffer, filename = 'coordinates-101.pptx'): Promise<ApiResult<any>> {
    const boundary = `----nexus-claude-it-${crypto.randomBytes(8).toString('hex')}`;
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="kind"\r\n\r\npptx\r\n`),
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/vnd.openxmlformats-officedocument.presentationml.presentation\r\n\r\n`,
      ),
      data,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    return this.request('POST', `/api/projects/${projectId}/sources`, body, { 'content-type': `multipart/form-data; boundary=${boundary}` });
  }

  /** A fresh project with a deck (default: the small test deck) uploaded and extracted by the worker. */
  async projectWithDeck(name = 'Coordinates 101', deck: Buffer = smallDeck()): Promise<{ projectId: string; slides: SourceSlide[]; includedIds: string[] }> {
    const created = await this.post('/api/projects', { name });
    if (created.status !== 201) throw new Error(`create project → ${created.status}: ${created.raw}`);
    const projectId: string = created.body.project.id;
    const up = await this.uploadDeck(projectId, deck);
    if (up.status !== 202) throw new Error(`upload → ${up.status}: ${up.raw}`);
    const ran = await this.runNext();
    if (!ran) throw new Error('the extraction job was not claimed');
    const { job } = await this.getJob(up.body.job.id);
    if (job.status !== 'succeeded') throw new Error(`extraction ${job.status}: ${JSON.stringify(job.error)}`);
    const slides = (await this.get<{ slides: SourceSlide[] }>(`/api/projects/${projectId}/slides`)).body.slides;
    return { projectId, slides, includedIds: slides.filter((s) => s.included).map((s) => s.id) };
  }

  async startJob(projectId: string, type: 'analyze' | 'blueprint', input: Record<string, unknown> = {}): Promise<ApiResult<JobCreateResponse>> {
    return this.post<JobCreateResponse>(`/api/projects/${projectId}/jobs`, { type, input });
  }

  /** Enqueue an analysis through the API and run it in the worker. */
  async analyze(projectId: string): Promise<JobDetail> {
    const r = await this.startJob(projectId, 'analyze');
    if (r.status !== 202) throw new Error(`enqueue analysis → ${r.status}: ${r.raw}`);
    await this.runNext();
    return this.getJob(r.body.job.id);
  }

  /** One worker iteration (claims and runs at most one queued job). */
  runNext(): Promise<boolean> {
    return this.mods.runOnce(this.app, this.workerId);
  }

  // ── database ──

  analysisCount(projectId: string): number {
    return this.app.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM analyses WHERE project_id = ?', [projectId])!.n;
  }

  usageRows(jobId: string): Array<Record<string, unknown>> {
    return this.app.db.all('SELECT * FROM usage_log WHERE job_id = ? ORDER BY id', [jobId]);
  }

  stageRows(jobId: string): Array<Record<string, unknown>> {
    return this.app.db.all('SELECT * FROM job_stages WHERE job_id = ?', [jobId]);
  }

  tableNames(): string[] {
    return this.app.db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((r) => r.name);
  }

  /** Every row of every table, serialized. */
  dumpDb(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const t of this.tableNames()) out[t] = JSON.stringify(this.app.db.all(`SELECT * FROM "${t.replace(/"/g, '""')}"`));
    return out;
  }

  /** Files under the data directory (database, WAL, uploads, assets, exports) whose raw bytes contain `needle`. */
  filesContaining(needle: string): string[] {
    const hits: string[] = [];
    const bytes = Buffer.from(needle, 'utf8');
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.isFile() && fs.readFileSync(p).includes(bytes)) hits.push(path.relative(this.dataDir, p));
      }
    };
    walk(this.dataDir);
    return hits;
  }
}

// ───────────────────────────── fixtures ─────────────────────────────

export const HIDDEN_SLIDE_MARKER = 'HIDDEN-ANSWER-KEY-7731';
export const NOTES_MARKER = 'Common mistake: swapping x and y.';

/** Four-slide deck: title, two content slides and a hidden answer-key slide; optionally an image on slide 2. */
export function smallDeck(opts: { slide2Image?: Buffer } = {}): Buffer {
  return buildPptx({
    title: 'Coordinates 101',
    slides: [
      { partNumber: 1, layout: 'title', title: 'Coordinates 101', subtitle: 'Finding points on a grid', notes: ['Warm-up: ask where the treasure is buried.'] },
      {
        partNumber: 2,
        layout: 'content',
        title: 'Ordered pairs',
        bullets: ['A point is written (x, y).', 'Move along x first, then y.', { text: 'Example: (3, 2) means 3 right, then 2 up.', level: 1 }],
        notes: [NOTES_MARKER],
        ...(opts.slide2Image
          ? { image: { file: 'grid.png', png: opts.slide2Image, alt: 'Coordinate grid with the point (3, 2) marked', x: 6400800, y: 1825625, w: 4953000, h: 3852333 } }
          : {}),
      },
      { partNumber: 3, layout: 'content', title: 'The four quadrants', bullets: ['The axes split the plane into four quadrants.', '(-4, -3) is in Quadrant III.'] },
      { partNumber: 4, layout: 'content', hidden: true, title: 'Teacher answer key', bullets: [`Answers: ${HIDDEN_SLIDE_MARKER}`] },
    ],
  });
}

/** All user-visible text the request sent to Claude (system prompt excluded). */
export function promptText(req: RecordedRequest): string {
  const messages = (req.body?.messages ?? []) as Array<{ content: unknown }>;
  return messages
    .map((m) =>
      typeof m.content === 'string'
        ? m.content
        : (m.content as Array<{ type: string; text?: string }>).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n'),
    )
    .join('\n');
}

/** Slide ids listed in an analysis prompt (“sld_… = slide N: Title”), in order. */
export function slideIdsInPrompt(req: RecordedRequest): string[] {
  return [...promptText(req).matchAll(/^(sld_[A-Za-z0-9]+) = slide \d+:/gm)].map((m) => m[1]!);
}

/** A learning map that satisfies the structured-output schema and cites the given slides. */
export function validAnalysis(ids: string[]): AiAnalysis {
  const [first] = ids;
  if (!first) throw new Error('validAnalysis needs at least one slide id');
  const a = ids[1] ?? first;
  const b = ids[2] ?? a;
  return {
    topic: 'Coordinates on the plane',
    summary: 'Learners locate points from ordered pairs and name the quadrant a point lies in.',
    concepts: [
      { name: 'Ordered pair', description: 'A point is written (x, y): move along x first, then y.', sourceSlideIds: [a] },
      { name: 'Quadrants', description: 'The axes split the plane into four quadrants.', sourceSlideIds: [b] },
    ],
    prerequisites: [{ text: 'Reading positive and negative numbers on a number line', sourceSlideIds: [a] }],
    objectives: [
      { text: 'Plot a point from an ordered pair', sourceSlideIds: [a], addedPractice: false },
      { text: 'Identify the quadrant that contains a point', sourceSlideIds: [b], addedPractice: false },
    ],
    examples: [{ text: '(3, 2) means 3 right, then 2 up.', sourceSlideIds: [a] }],
    questions: [{ prompt: 'Which quadrant contains (-4, -3)?', answer: 'Quadrant III', sourceSlideIds: [b], addedPractice: false }],
    interactions: [{ mechanic: 'coordinate-navigation', description: 'Guide a plane to a named point on the grid.', sourceSlideIds: [a, b], addedPractice: false }],
    openQuestions: [],
  };
}

/** Decompress every entry of a zip archive. */
export function readZipEntries(zip: Buffer): Promise<Array<{ name: string; data: Buffer }>> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(zip, { lazyEntries: true }, (err, file) => {
      if (err || !file) return reject(err ?? new Error('not a zip'));
      const out: Array<{ name: string; data: Buffer }> = [];
      file.on('error', reject);
      file.on('end', () => resolve(out));
      file.on('entry', (entry: yauzl.Entry) => {
        if (entry.fileName.endsWith('/')) return file.readEntry();
        file.openReadStream(entry, (e, stream) => {
          if (e || !stream) return reject(e ?? new Error('unreadable entry'));
          const parts: Buffer[] = [];
          stream.on('data', (c: Buffer) => parts.push(c));
          stream.on('error', reject);
          stream.on('end', () => {
            out.push({ name: entry.fileName, data: Buffer.concat(parts) });
            file.readEntry();
          });
        });
      });
      file.readEntry();
    });
  });
}

/** Record everything written through console.* (still forwarded to the real console). */
export function captureConsole(): { text: () => string; calls: () => number; restore: () => void } {
  const lines: string[] = [];
  const methods = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const;
  const spies = methods.map((m) => {
    const original = console[m].bind(console);
    return vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
      lines.push(args.map((a) => (typeof a === 'string' ? a : inspect(a, { depth: 8 }))).join(' '));
      original(...args);
    });
  });
  return {
    text: () => lines.join('\n'),
    calls: () => lines.length,
    restore: () => spies.forEach((s) => s.mockRestore()),
  };
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
