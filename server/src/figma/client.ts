import { z } from 'zod';

/**
 * Read-only client for the official Figma REST API (https://api.figma.com).
 *
 * - Requests are built from validated identifiers (file key, node ids), never
 *   from a pasted URL; the personal access token is sent only to the API
 *   origin as `X-Figma-Token`, never to download hosts.
 * - 429 responses honour `Retry-After`: short waits are retried automatically
 *   (bounded), long waits fail with a clear manual-retry message.
 * - Downloads (renders, image fills) are restricted to allowlisted hosts,
 *   follow at most three redirects (each re-validated), and enforce a size
 *   limit and an image content type.
 * - Nothing here writes back to Figma.
 */

export type FigmaErrorCode =
  | 'not_configured'
  | 'bad_request'
  | 'expired_token'
  | 'forbidden'
  | 'not_found'
  | 'rate_limited'
  | 'render_failed'
  | 'server_error'
  | 'network'
  | 'timeout'
  | 'bad_response'
  | 'host_not_allowed'
  | 'too_large'
  | 'bad_content_type'
  | 'too_many_redirects'
  | 'unsupported_editor';

export class FigmaError extends Error {
  constructor(
    readonly code: FigmaErrorCode,
    message: string,
    readonly hint: string,
    readonly retryable: boolean,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
  }
}

export interface FigmaCache {
  get<T>(key: string): T | null;
  put(key: string, value: unknown, ttlMs: number): void;
}

export interface FigmaClientOptions {
  baseUrl: string;
  token: string | null;
  assetHosts: string[];
  timeoutMs: number;
  maxAutoWaitSeconds: number;
  maxDownloadBytes: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  cache?: FigmaCache | null;
  signal?: AbortSignal;
  /** Called when the client waits for a rate limit, so a job can show it. */
  onWait?: (seconds: number, reason: string) => void;
}

const KEY_RE = /^[A-Za-z0-9]{10,64}$/;
const NODE_RE = /^\d{1,12}:\d{1,12}$/;

const looseNode: z.ZodType<FigmaNode> = z.lazy(() =>
  z
    .object({
      id: z.string(),
      name: z.string().default(''),
      type: z.string(),
      children: z.array(looseNode).optional(),
    })
    .passthrough(),
) as unknown as z.ZodType<FigmaNode>;

export interface FigmaNode {
  id: string;
  name: string;
  type: string;
  children?: FigmaNode[];
  [key: string]: unknown;
}

const fileResponse = z
  .object({
    name: z.string(),
    lastModified: z.string().optional(),
    version: z.string().optional(),
    role: z.string().optional(),
    editorType: z.string().optional(),
    document: looseNode,
  })
  .passthrough();
export type FigmaFile = z.infer<typeof fileResponse>;

const nodesResponse = z
  .object({
    name: z.string(),
    lastModified: z.string().optional(),
    version: z.string().optional(),
    role: z.string().optional(),
    editorType: z.string().optional(),
    nodes: z.record(z.string(), z.object({ document: looseNode }).passthrough().nullable()),
  })
  .passthrough();
export type FigmaNodes = z.infer<typeof nodesResponse>;

const imagesResponse = z.object({ err: z.string().nullable().optional(), images: z.record(z.string(), z.string().nullable()) }).passthrough();
const fillsResponse = z.object({ meta: z.object({ images: z.record(z.string(), z.string()) }).passthrough() }).passthrough();
const meResponse = z.object({ id: z.string(), handle: z.string().optional(), email: z.string().optional() }).passthrough();

const IMAGE_TYPES: Record<string, 'png' | 'jpeg' | 'svg'> = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/jpg': 'jpeg', 'image/svg+xml': 'svg' };

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new FigmaError('network', 'Cancelled.', '', false));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new FigmaError('network', 'Cancelled.', '', false));
      },
      { once: true },
    );
  });

/** Parse Retry-After: delta seconds or an HTTP date. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  const v = value.trim();
  if (/^\d{1,7}$/.test(v)) return Number(v);
  const t = Date.parse(v);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.ceil((t - now) / 1000));
}

function humanWait(seconds: number): string {
  if (seconds < 90) return `${seconds} seconds`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} minutes`;
  if (seconds < 172_800) return `${Math.round(seconds / 3600)} hours`;
  return `${Math.round(seconds / 86_400)} days`;
}

export class FigmaClient {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Number of API requests actually sent (cache hits excluded) — used by tests and job logs. */
  requests = 0;

  constructor(private readonly opts: FigmaClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  private requireToken(): string {
    if (!this.opts.token) {
      throw new FigmaError(
        'not_configured',
        'Figma is not configured on this server.',
        'Set FIGMA_ACCESS_TOKEN (a personal access token with the file_content:read scope) in the server environment and restart, or upload exported screens instead.',
        false,
      );
    }
    return this.opts.token;
  }

  private abortSignal(): AbortSignal {
    const timeout = AbortSignal.timeout(this.opts.timeoutMs);
    return this.opts.signal ? AbortSignal.any([this.opts.signal, timeout]) : timeout;
  }

  /** GET an API path built from validated parts. */
  private async api<T>(pathname: string, query: Record<string, string>, schema: z.ZodType<T>, opts: { cacheTtlMs?: number; fresh?: boolean } = {}): Promise<T> {
    const token = this.requireToken();
    const url = new URL(pathname, this.opts.baseUrl);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    const cacheKey = `${url.pathname}?${url.searchParams.toString()}`;
    if (this.opts.cache && opts.cacheTtlMs && !opts.fresh) {
      const hit = this.opts.cache.get<T>(cacheKey);
      if (hit) return hit;
    }
    let attempt = 0;
    for (;;) {
      attempt++;
      let res: Response;
      try {
        this.requests++;
        res = await this.fetchImpl(url, { method: 'GET', headers: { 'X-Figma-Token': token, Accept: 'application/json' }, redirect: 'error', signal: this.abortSignal() });
      } catch (err) {
        if (this.opts.signal?.aborted) throw new FigmaError('network', 'Cancelled.', '', false);
        const timedOut = (err as Error).name === 'TimeoutError';
        if (attempt < 2) {
          await this.sleep(1000, this.opts.signal);
          continue;
        }
        throw new FigmaError(
          timedOut ? 'timeout' : 'network',
          timedOut ? 'Figma did not answer in time.' : 'Could not reach Figma.',
          'Check the network connection and retry. Exported screens can be uploaded without a Figma connection.',
          true,
        );
      }
      if (res.status === 429) {
        const wait = parseRetryAfter(res.headers.get('retry-after'));
        const tier = res.headers.get('x-figma-plan-tier');
        const limitType = res.headers.get('x-figma-rate-limit-type');
        await res.body?.cancel().catch(() => undefined);
        if (wait !== null && wait <= this.opts.maxAutoWaitSeconds && attempt < 3) {
          this.opts.onWait?.(wait, 'Figma rate limit');
          await this.sleep(Math.max(wait, 1) * 1000, this.opts.signal);
          continue;
        }
        const detail = [tier ? `plan tier: ${tier}` : null, limitType ? `limit type: ${limitType}` : null].filter(Boolean).join(', ');
        throw new FigmaError(
          'rate_limited',
          `Figma's rate limit was reached${detail ? ` (${detail})` : ''}.${wait !== null ? ` Figma asks to wait about ${humanWait(wait)}.` : ''}`,
          'Nothing was imported. Use Retry after the wait. View or Collab seats have very low limits for file access; a Dev or Full seat raises them. Exported screens can be uploaded meanwhile.',
          true,
          wait,
        );
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        let message = '';
        try {
          const j = JSON.parse(text) as { err?: string; message?: string };
          message = j.err ?? j.message ?? '';
        } catch {
          message = '';
        }
        if (res.status === 400) throw new FigmaError('bad_request', `Figma rejected the request${message ? `: ${message}` : ''}.`, 'Check that the link points to a frame in a Figma Design file.', false);
        if (res.status === 401 || (res.status === 403 && /token/i.test(message))) {
          throw new FigmaError('expired_token', 'The server’s Figma access token was refused (invalid or expired).', 'Create a new personal access token with the file_content:read scope and update FIGMA_ACCESS_TOKEN, then restart the server.', false);
        }
        if (res.status === 403) {
          throw new FigmaError('forbidden', 'This Figma file is not shared with the account behind the server’s token.', 'Ask the file owner to share it (view access is enough), or upload exported screens instead.', false);
        }
        if (res.status === 404) throw new FigmaError('not_found', 'Figma could not find that file.', 'Check the link — the file may have been moved, deleted or be in another account.', false);
        if (res.status >= 500 && attempt < 2) {
          await this.sleep(1500, this.opts.signal);
          continue;
        }
        if (res.status >= 500) throw new FigmaError('server_error', `Figma returned an error (${res.status}).`, 'Retry in a moment.', true);
        throw new FigmaError('bad_response', `Unexpected Figma response (${res.status}).`, 'Retry, or upload exported screens instead.', true);
      }
      let json: unknown;
      try {
        json = await res.json();
      } catch {
        throw new FigmaError('bad_response', 'Figma returned an unreadable response.', 'Retry in a moment.', true);
      }
      const parsed = schema.safeParse(json);
      if (!parsed.success) throw new FigmaError('bad_response', 'Figma returned data in an unexpected shape.', 'Retry; if it persists, upload exported screens instead.', true);
      if (this.opts.cache && opts.cacheTtlMs) this.opts.cache.put(cacheKey, parsed.data, opts.cacheTtlMs);
      return parsed.data;
    }
  }

  private static key(fileKey: string): string {
    if (!KEY_RE.test(fileKey)) throw new FigmaError('bad_request', 'Invalid file key.', 'Paste the link again.', false);
    return fileKey;
  }

  private static ids(ids: string[]): string {
    if (ids.length === 0 || ids.length > 50 || ids.some((i) => !NODE_RE.test(i))) throw new FigmaError('bad_request', 'Invalid node ids.', 'Select frames again.', false);
    return ids.join(',');
  }

  /** File metadata and a shallow tree (pages and their top-level frames). */
  async getFileShallow(fileKey: string, opts: { fresh?: boolean } = {}): Promise<FigmaFile> {
    return this.api(`/v1/files/${FigmaClient.key(fileKey)}`, { depth: '2' }, fileResponse, { cacheTtlMs: 5 * 60_000, fresh: opts.fresh });
  }

  /** Specific nodes with their full subtrees (only what was selected). */
  async getNodes(fileKey: string, ids: string[], opts: { depth?: number; fresh?: boolean } = {}): Promise<FigmaNodes> {
    const query: Record<string, string> = { ids: FigmaClient.ids(ids) };
    if (opts.depth) query.depth = String(opts.depth);
    return this.api(`/v1/files/${FigmaClient.key(fileKey)}/nodes`, query, nodesResponse, { cacheTtlMs: 5 * 60_000, fresh: opts.fresh });
  }

  /** Render nodes. Values are null when Figma could not render a node. */
  async renderImages(fileKey: string, ids: string[], opts: { format: 'png' | 'jpg' | 'svg'; scale: number }): Promise<Record<string, string | null>> {
    const scale = Math.min(4, Math.max(0.01, opts.scale));
    const out: Record<string, string | null> = {};
    // Batch ids to keep each render request small.
    for (let i = 0; i < ids.length; i += 20) {
      const batch = ids.slice(i, i + 20);
      const r = await this.api(`/v1/images/${FigmaClient.key(fileKey)}`, { ids: FigmaClient.ids(batch), format: opts.format, scale: scale.toFixed(3).replace(/0+$/, '').replace(/\.$/, '') }, imagesResponse, {
        cacheTtlMs: 10 * 60_000,
      });
      if (r.err) throw new FigmaError('render_failed', `Figma could not render the frames: ${r.err}`, 'Retry, or upload exported screens instead.', true);
      for (const id of batch) out[id] = r.images[id] ?? null;
    }
    return out;
  }

  /** Download URLs for image fills (imageRef → URL). */
  async imageFills(fileKey: string): Promise<Record<string, string>> {
    const r = await this.api(`/v1/files/${FigmaClient.key(fileKey)}/images`, {}, fillsResponse, { cacheTtlMs: 10 * 60_000 });
    return r.meta.images;
  }

  async me(): Promise<{ id: string; handle: string | null }> {
    const r = await this.api('/v1/me', {}, meResponse);
    return { id: r.id, handle: r.handle ?? null };
  }

  private assertDownloadAllowed(url: URL): void {
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    const allowedHost = this.opts.assetHosts.includes(url.host) || this.opts.assetHosts.includes(url.hostname);
    if (!allowedHost) throw new FigmaError('host_not_allowed', `Refused to download from ${url.hostname}: not a Figma asset host.`, 'Only Figma render and image hosts are accepted.', false);
    if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) throw new FigmaError('host_not_allowed', 'Refused a non-HTTPS download.', '', false);
    if (url.username || url.password) throw new FigmaError('host_not_allowed', 'Refused a download URL with credentials.', '', false);
  }

  /** Download a render or image fill with host, redirect, size and type controls. Never sends the token. */
  async download(rawUrl: string, opts: { maxBytes?: number } = {}): Promise<{ data: Buffer; type: 'png' | 'jpeg' | 'svg' }> {
    const maxBytes = Math.min(opts.maxBytes ?? this.opts.maxDownloadBytes, this.opts.maxDownloadBytes);
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new FigmaError('bad_response', 'Figma returned an invalid download link.', 'Retry the import.', true);
    }
    for (let hop = 0; hop <= 3; hop++) {
      this.assertDownloadAllowed(url);
      let res: Response;
      try {
        res = await this.fetchImpl(url, { method: 'GET', headers: { Accept: 'image/png,image/jpeg,image/svg+xml' }, redirect: 'manual', signal: this.abortSignal() });
      } catch {
        throw new FigmaError('network', 'Downloading an image from Figma failed.', 'Retry the import.', true);
      }
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        await res.body?.cancel().catch(() => undefined);
        if (!loc) throw new FigmaError('bad_response', 'A download redirect had no destination.', 'Retry the import.', true);
        url = new URL(loc, url);
        continue;
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        // Expired render/fill links come back as 403 from the storage host.
        throw new FigmaError('render_failed', `An image download failed (${res.status}).`, 'Retry the import — Figma creates fresh download links each time.', true);
      }
      const ct = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
      const type = IMAGE_TYPES[ct];
      if (!type) {
        await res.body?.cancel().catch(() => undefined);
        throw new FigmaError('bad_content_type', `Figma sent ${ct || 'an unknown type'} instead of an image.`, 'Retry the import.', false);
      }
      const declared = Number(res.headers.get('content-length') ?? '0');
      if (declared > maxBytes) {
        await res.body?.cancel().catch(() => undefined);
        throw new FigmaError('too_large', `An image from Figma is larger than ${Math.round(maxBytes / 1048576)} MB.`, 'Use a smaller frame or a lower render scale.', false);
      }
      const chunks: Buffer[] = [];
      let total = 0;
      const reader = res.body?.getReader();
      if (!reader) throw new FigmaError('bad_response', 'Empty download.', 'Retry the import.', true);
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw new FigmaError('too_large', `An image from Figma is larger than ${Math.round(maxBytes / 1048576)} MB.`, 'Use a smaller frame or a lower render scale.', false);
        }
        chunks.push(Buffer.from(value));
      }
      return { data: Buffer.concat(chunks), type };
    }
    throw new FigmaError('too_many_redirects', 'Too many redirects while downloading from Figma.', 'Retry the import.', true);
  }
}

/** Editor types the adapter supports. FigJam, Slides, Sites, Buzz and Make files are refused. */
export function assertDesignFile(editorType: string | undefined): void {
  if (editorType && editorType !== 'figma') {
    const names: Record<string, string> = { figjam: 'FigJam board', slides: 'Figma Slides deck', sites: 'Figma Sites file', buzz: 'Figma Buzz file', make: 'Figma Make file' };
    throw new FigmaError(
      'unsupported_editor',
      `This is a ${names[editorType] ?? `${editorType} file`}, not a Figma Design file.`,
      'Only Figma Design files can be imported. Export the screens as PNG/JPEG/SVG and upload them instead.',
      false,
    );
  }
}
