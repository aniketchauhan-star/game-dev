/**
 * A local stand-in for the parts of the Figma REST API the studio's adapter
 * calls, serving the bundled “Trapezium Quest” sample data:
 *
 *   GET /v1/files/:key?depth=N          file document (trimmed to depth)
 *   GET /v1/files/:key/nodes?ids=…      node subtrees (null for missing ids)
 *   GET /v1/images/:key?ids=…           render URLs on this server (null = render failed)
 *   GET /v1/files/:key/images           image-fill URLs on this server
 *   GET /v1/me                          the token's user
 *   GET /renders/:id.png, /fills/:ref.png, /redirect?to=…   download hosts
 *
 * Scripted replies (429 with Retry-After, 403, 404, 500 …) can be queued per
 * path prefix. Every request is recorded so tests can assert, for example,
 * that the token is sent to the API but never to a download host.
 *
 * This is a test double: passing tests prove the adapter handles the API
 * contract as modelled here, not that live Figma behaves this way.
 */
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures', 'trapezium');

interface JsonNode {
  id: string;
  type: string;
  children?: JsonNode[];
  [k: string]: unknown;
}

export interface FigmaRecorded {
  method: string;
  pathname: string;
  query: Record<string, string>;
  headers: http.IncomingHttpHeaders;
  status: number;
}

export interface FigmaScripted {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
  /** Raw body bytes (for content-type tests). */
  raw?: Buffer;
}

export interface FigmaMockOptions {
  token: string;
  editorType?: string;
  /** Node ids whose render returns null. */
  failRenders?: string[];
  /** Node ids that behave as deleted (null in /nodes, absent from the file). */
  missingNodes?: string[];
}

export class FigmaMock {
  readonly requests: FigmaRecorded[] = [];
  private readonly scripts: Array<{ prefix: string; reply: FigmaScripted }> = [];
  private server: http.Server | null = null;
  private sockets = new Set<Socket>();
  origin = '';
  file: { name: string; version: string; lastModified: string; role: string; editorType: string; document: JsonNode };
  readonly assets: { renders: Record<string, string>; fills: Record<string, string> };

  constructor(readonly options: FigmaMockOptions) {
    this.file = JSON.parse(fs.readFileSync(path.join(root, 'figma', 'file.json'), 'utf8'));
    if (options.editorType) this.file.editorType = options.editorType;
    this.assets = JSON.parse(fs.readFileSync(path.join(root, 'figma', 'assets.json'), 'utf8'));
  }

  get fileKey(): string {
    return 'TrapQuestDemo8x2026';
  }

  /** Queue a one-off reply for the next request whose path starts with `prefix`. */
  queue(prefix: string, reply: FigmaScripted): void {
    this.scripts.push({ prefix, reply });
  }

  /** Simulate a designer editing the file (for refresh tests). */
  editText(nodeId: string, characters: string): void {
    const n = this.find(this.file.document, nodeId);
    if (!n) throw new Error(`no node ${nodeId}`);
    n.characters = characters;
    this.file.version = String(Number(this.file.version) + 1);
  }

  apiRequests(): FigmaRecorded[] {
    return this.requests.filter((r) => r.pathname.startsWith('/v1/'));
  }

  private find(n: JsonNode, id: string): JsonNode | null {
    if (n.id === id) return n;
    for (const c of n.children ?? []) {
      const hit = this.find(c, id);
      if (hit) return hit;
    }
    return null;
  }

  private trim(n: JsonNode, depth: number): JsonNode {
    const missing = new Set(this.options.missingNodes ?? []);
    const copy: JsonNode = { ...n };
    if (n.children) {
      if (depth <= 0) delete copy.children;
      else copy.children = n.children.filter((c) => !missing.has(c.id)).map((c) => this.trim(c, depth - 1));
    }
    return copy;
  }

  async start(port = 0): Promise<string> {
    this.server = http.createServer((req, res) => this.handle(req, res));
    this.server.on('connection', (s) => {
      this.sockets.add(s);
      s.on('close', () => this.sockets.delete(s));
    });
    await new Promise<void>((resolve) => this.server!.listen(port, '127.0.0.1', resolve));
    const addr = this.server.address() as AddressInfo;
    this.origin = `http://127.0.0.1:${addr.port}`;
    return this.origin;
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.server = null;
  }

  private send(res: http.ServerResponse, rec: FigmaRecorded, status: number, body: unknown, headers: Record<string, string> = {}): void {
    rec.status = status;
    const data = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    res.writeHead(status, { 'content-type': Buffer.isBuffer(body) ? 'image/png' : 'application/json', 'content-length': String(data.length), ...headers });
    res.end(data);
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const rec: FigmaRecorded = { method: req.method ?? 'GET', pathname: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, status: 0 };
    this.requests.push(rec);
    const scripted = this.scripts.findIndex((s) => url.pathname.startsWith(s.prefix));
    if (scripted >= 0) {
      const { reply } = this.scripts.splice(scripted, 1)[0]!;
      rec.status = reply.status;
      const data = reply.raw ?? Buffer.from(JSON.stringify(reply.body ?? {}));
      res.writeHead(reply.status, { 'content-type': reply.raw ? 'application/octet-stream' : 'application/json', ...(reply.headers ?? {}) });
      res.end(data);
      return;
    }

    // Download hosts (no token expected — and the adapter must not send one).
    if (url.pathname.startsWith('/renders/') || url.pathname.startsWith('/fills/')) {
      const key = decodeURIComponent(url.pathname.replace(/^\/(renders|fills)\//, '').replace(/\.png$/, ''));
      const rel = url.pathname.startsWith('/renders/') ? this.assets.renders[key] : this.assets.fills[key];
      if (!rel) return this.send(res, rec, 404, { err: 'not found' });
      return this.send(res, rec, 200, fs.readFileSync(path.join(root, rel)));
    }
    if (url.pathname === '/redirect') {
      rec.status = 302;
      res.writeHead(302, { location: url.searchParams.get('to') ?? '/' });
      res.end();
      return;
    }

    if (!url.pathname.startsWith('/v1/')) return this.send(res, rec, 404, { err: 'not found' });
    if (req.headers['x-figma-token'] !== this.options.token) return this.send(res, rec, 403, { status: 403, err: 'Invalid token' });
    if (url.pathname === '/v1/me') return this.send(res, rec, 200, { id: 'user-sample', handle: 'Sample Designer', email: 'designer@example.com' });

    const m = /^\/v1\/(files|images)\/([A-Za-z0-9]+)(\/nodes|\/images)?$/.exec(url.pathname);
    if (!m) return this.send(res, rec, 404, { status: 404, err: 'Not found' });
    if (m[2] !== this.fileKey) return this.send(res, rec, 404, { status: 404, err: 'Not found' });
    const meta = { name: this.file.name, lastModified: this.file.lastModified, version: this.file.version, role: this.file.role, editorType: this.file.editorType, thumbnailUrl: '' };
    const missing = new Set(this.options.missingNodes ?? []);

    if (m[1] === 'files' && !m[3]) {
      const depth = Number(url.searchParams.get('depth') ?? '100');
      return this.send(res, rec, 200, { ...meta, schemaVersion: 0, document: this.trim(this.file.document, depth), components: {}, styles: {} });
    }
    if (m[1] === 'files' && m[3] === '/nodes') {
      const ids = (url.searchParams.get('ids') ?? '').split(',').filter(Boolean);
      const depth = url.searchParams.get('depth');
      const nodes: Record<string, { document: JsonNode; components: object; styles: object } | null> = {};
      for (const id of ids) {
        const n = missing.has(id) ? null : this.find(this.file.document, id);
        nodes[id] = n ? { document: depth ? this.trim(n, Number(depth)) : this.trim(n, 100), components: {}, styles: {} } : null;
      }
      return this.send(res, rec, 200, { ...meta, nodes });
    }
    if (m[1] === 'files' && m[3] === '/images') {
      const images = Object.fromEntries(Object.keys(this.assets.fills).map((ref) => [ref, `${this.origin}/fills/${encodeURIComponent(ref)}.png`]));
      return this.send(res, rec, 200, { error: false, status: 200, meta: { images } });
    }
    if (m[1] === 'images') {
      const ids = (url.searchParams.get('ids') ?? '').split(',').filter(Boolean);
      const failing = new Set(this.options.failRenders ?? []);
      const images = Object.fromEntries(ids.map((id) => [id, failing.has(id) || !this.assets.renders[id] ? null : `${this.origin}/renders/${encodeURIComponent(id)}.png`]));
      return this.send(res, rec, 200, { err: null, images });
    }
    return this.send(res, rec, 404, { status: 404, err: 'Not found' });
  }
}
