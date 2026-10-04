import './env.ts';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { previewCsp, STUDIO_CSP } from '../../../server/src/http/security.ts';
import { databaseBytes, DIST_SENTINEL, FAKE_KEY, sampleDeck, setApiKey, startClaudeSink, STUDIO_HOST, Studio, type Res } from './helpers.ts';

/** Parse a CSP header into directive → sources. */
function csp(header: string | string[] | number | undefined): Map<string, string[]> {
  expect(typeof header, 'Content-Security-Policy header').toBe('string');
  const out = new Map<string, string[]>();
  for (const part of String(header).split(';')) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name) out.set(name, values);
  }
  return out;
}

describe('security boundary', () => {
  let s: Studio;
  let projectId: string;
  let projectName: string;

  beforeAll(async () => {
    s = await Studio.start();
    const p = await s.createProject('Security fixture');
    projectId = p.id;
    projectName = p.name;
  });

  afterAll(async () => {
    await s.close();
  });

  const count = (table: string) => s.app.db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM ${table}`)!.c;

  describe('Host allowlist (DNS rebinding)', () => {
    it('answers 421 to requests addressed to any other host, for API, studio and preview routes', async () => {
      const before = count('projects');
      const hosts = ['evil.example', 'evil.example:5174', 'localhost.evil.example:5174', '127.0.0.1:8080', '127.0.0.1', '192.168.1.20:5174', '0.0.0.0:5174'];
      const routes = [
        ['GET', '/api/health'],
        ['GET', '/api/projects'],
        ['GET', `/api/projects/${projectId}`],
        ['GET', '/'],
        ['GET', '/preview/index.html'],
        ['POST', '/api/projects'],
      ] as const;
      for (const host of hosts) {
        for (const [method, url] of routes) {
          const res = await s.request(method, url, method === 'POST' ? { name: 'rebinding attempt' } : undefined, { host });
          expect(res.statusCode, `${method} ${url} with Host ${host}`).toBe(421);
          expect(res.json().error.code).toBe('host_not_allowed');
          expect(res.body).not.toContain('Security fixture');
        }
      }
      expect(count('projects')).toBe(before);
    });

    it('accepts the loopback names on the API and studio dev ports', async () => {
      for (const host of [STUDIO_HOST, 'localhost:5174', '[::1]:5174', '127.0.0.1:5173', 'localhost:5173', 'LOCALHOST:5174']) {
        const res = await s.get('/api/health', { host });
        expect(res.statusCode, `Host ${host}`).toBe(200);
        expect(res.json().ok).toBe(true);
      }
    });
  });

  describe('CSRF header, Origin and Fetch Metadata on state-changing requests', () => {
    it('GET requests work without the CSRF header', async () => {
      for (const url of ['/api/health', '/api/projects', `/api/projects/${projectId}`, `/api/projects/${projectId}/slides`, `/api/projects/${projectId}/jobs`]) {
        const res = await s.inject({ method: 'GET', url, headers: { host: STUDIO_HOST } });
        expect(res.statusCode, url).toBe(200);
      }
    });

    it('refuses POST/PUT/PATCH/DELETE without X-Nexus-CSRF: 1 and changes nothing', async () => {
      const before = { projects: count('projects'), documents: count('source_documents') };
      const p = await s.project(projectId);
      const attempts: Array<() => Promise<Res>> = [];
      for (const csrf of [undefined, '0', 'true', '']) {
        const h = { 'x-nexus-csrf': csrf };
        attempts.push(
          () => s.post('/api/projects', { name: 'csrf' }, h),
          () => s.post('/api/projects/sample', undefined, h),
          () => s.patch(`/api/projects/${projectId}`, { name: 'Hijacked', revision: p.revision }, h),
          () => s.put(`/api/projects/${projectId}/brief`, { brief: { ...p.brief, title: 'Hijacked' }, revision: p.briefRevision }, h),
          () => s.post(`/api/projects/${projectId}/duplicate`, undefined, h),
          () => s.del(`/api/projects/${projectId}`, { confirmName: projectName }, h),
          () => s.upload(projectId, { filename: 'deck.pptx', data: sampleDeck() }, {}, h),
        );
      }
      for (const attempt of attempts) {
        const res = await attempt();
        expect(res.statusCode, res.body).toBe(403);
        expect(res.json().error.code).toBe('csrf');
      }
      const after = await s.project(projectId);
      expect(after.name).toBe(projectName);
      expect(after.revision).toBe(p.revision);
      expect(after.briefRevision).toBe(p.briefRevision);
      expect(count('projects')).toBe(before.projects);
      expect(count('source_documents')).toBe(before.documents);
      expect(fs.readdirSync(path.join(s.dataDir, 'tmp'))).toEqual([]);
    });

    it('refuses a foreign Origin even when the CSRF header is present', async () => {
      const before = count('projects');
      for (const origin of ['http://evil.example', 'http://127.0.0.1:9999', 'https://127.0.0.1:5174', 'null', 'http://localhost.evil.example:5174']) {
        const res = await s.post('/api/projects', { name: 'cross-site' }, { origin });
        expect(res.statusCode, `Origin ${origin}`).toBe(403);
        expect(res.json().error.code).toBe('origin');
      }
      expect(count('projects')).toBe(before);
    });

    it('refuses cross-site and same-site Fetch Metadata, accepts same-origin and user-initiated (none)', async () => {
      const before = count('projects');
      for (const site of ['cross-site', 'same-site']) {
        const res = await s.post('/api/projects', { name: 'fetch metadata' }, { 'sec-fetch-site': site });
        expect(res.statusCode, `Sec-Fetch-Site ${site}`).toBe(403);
        expect(res.json().error.code).toBe('fetch_site');
      }
      expect(count('projects')).toBe(before);
      for (const site of ['same-origin', 'none']) {
        const res = await s.post('/api/projects', { name: `fetch metadata ${site}` }, { 'sec-fetch-site': site });
        expect(res.statusCode, `Sec-Fetch-Site ${site}`).toBe(201);
      }
    });

    it('accepts the studio dev-server origin and same-machine clients that send no Origin', async () => {
      expect((await s.post('/api/projects', { name: 'dev origin' }, { origin: 'http://localhost:5173', host: 'localhost:5173' })).statusCode).toBe(201);
      expect((await s.post('/api/projects', { name: 'no origin' }, { origin: undefined, 'sec-fetch-site': undefined })).statusCode).toBe(201);
    });

    it('cannot be bypassed by percent-encoding the /api prefix', async () => {
      // A cross-site page can send these without a preflight (POST, no custom headers, no body).
      const before = count('projects');
      const attacker = { 'x-nexus-csrf': undefined, origin: 'http://evil.example', 'sec-fetch-site': 'cross-site' };
      const outcome: Record<string, number | 'refused'> = {};
      for (const url of ['/%61pi/projects', '/%61pi/projects/sample', `/%61pi/projects/${projectId}/duplicate`]) {
        const res = await s.post(url, undefined, attacker);
        outcome[`POST ${url}`] = res.statusCode === 403 || res.statusCode === 404 ? 'refused' : res.statusCode;
      }
      expect({ outcome, projectsCreated: count('projects') - before }).toEqual({
        outcome: { 'POST /%61pi/projects': 'refused', 'POST /%61pi/projects/sample': 'refused', [`POST /%61pi/projects/${projectId}/duplicate`]: 'refused' },
        projectsCreated: 0,
      });
    });
  });

  describe('response headers and CSP', () => {
    it('serves the studio page with the strict studio CSP and framing denied', async () => {
      for (const url of ['/', '/projects/prj_abcdef123456/build']) {
        const res = await s.get(url, { accept: 'text/html' });
        expect(res.statusCode, url).toBe(200);
        expect(res.headers['content-type']).toMatch(/^text\/html/);
        expect(res.body).toContain('<div id="root">');
        expect(res.headers['content-security-policy']).toBe(STUDIO_CSP);
        const d = csp(res.headers['content-security-policy']);
        expect(d.get('frame-ancestors')).toEqual(["'none'"]);
        expect(d.get('object-src')).toEqual(["'none'"]);
        expect(d.get('base-uri')).toEqual(["'none'"]);
        expect(d.get('script-src')).toEqual(["'self'"]);
        expect(d.get('connect-src')).toEqual(["'self'"]);
        expect(res.headers['x-frame-options']).toBe('DENY');
        expect(res.headers['cross-origin-resource-policy']).toBe('same-origin');
        expect(res.headers['x-content-type-options']).toBe('nosniff');
        expect(res.headers['referrer-policy']).toBe('no-referrer');
      }
      const asset = await s.get('/assets/index-stub.js');
      expect(asset.statusCode).toBe(200);
      expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');
      const unknownApi = await s.get('/api/does-not-exist');
      expect(unknownApi.statusCode).toBe(404);
      expect(unknownApi.headers['content-type']).toMatch(/application\/json/);
      expect(unknownApi.body).not.toContain('<div id="root">');
    });

    it('serves the preview document with its own CSP that blocks all network access, framable by the studio only', async () => {
      for (const host of [STUDIO_HOST, 'localhost:5173']) {
        const res = await s.get('/preview/index.html', { host });
        expect(res.statusCode).toBe(200);
        expect(res.headers['content-type']).toMatch(/^text\/html/);
        expect(res.headers['content-security-policy']).toBe(previewCsp(`http://${host}`));
        const d = csp(res.headers['content-security-policy']);
        expect(d.get('default-src')).toEqual(["'none'"]);
        expect(d.get('connect-src')).toEqual(["'none'"]);
        expect(d.get('form-action')).toEqual(["'none'"]);
        expect(d.get('base-uri')).toEqual(["'none'"]);
        expect(d.get('frame-ancestors')).toEqual(["'self'"]);
        expect(d.get('script-src')).toEqual(["'self'", `http://${host}`]);
        for (const directive of ['script-src', 'style-src', 'font-src', 'img-src', 'media-src']) {
          expect(d.get(directive)?.join(' ') ?? '', directive).not.toMatch(/unsafe-eval|\*|https?:\/\/(?!127\.0\.0\.1|localhost)/);
        }
        // Loaded inside the studio's sandboxed iframe (opaque origin): cross-origin readable, no X-Frame-Options.
        expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');
        expect(res.headers['x-frame-options']).toBeUndefined();
        expect(res.headers['cache-control']).toBe('no-store');
        expect(res.body).toContain('<script src="/preview/runtime.js"></script>');
        expect(res.body.match(/<script(?![^>]*\ssrc=)[^>]*>/g), 'no inline scripts in the preview document').toBeNull();
      }
      const js = await s.get('/preview/runtime.js');
      expect(js.statusCode).toBe(200);
      expect(js.headers['content-type']).toMatch(/javascript/);
      expect(js.headers['cross-origin-resource-policy']).toBe('cross-origin');
      expect(js.headers['x-frame-options']).toBeUndefined();
      const font = await s.get('/preview/fonts/stub-font.woff2');
      expect(font.statusCode).toBe(200);
      expect(font.headers['access-control-allow-origin']).toBe('*');
      const missing = await s.get('/preview/runtime-missing.js');
      expect(missing.statusCode).toBe(404);
      expect(missing.body).toContain('Runtime not built yet');
    });

    it('never serves files outside the runtime directory through /preview/', async () => {
      const attempts = [
        '/preview/..%2fOUTSIDE-SENTINEL.txt',
        '/preview/%2e%2e/OUTSIDE-SENTINEL.txt',
        '/preview/%2e%2e%2fOUTSIDE-SENTINEL.txt',
        '/preview/fonts/..%2f..%2fOUTSIDE-SENTINEL.txt',
        '/preview/..%2f..%2fpackage.json',
        '/preview/%2e%2e%2f%2e%2e%2fpackage.json',
        `/preview/..%2f..%2f..%2f..%2f..%2f..%2f..%2f..%2f..%2f..%2f${encodeURIComponent(path.join(s.distDir, 'OUTSIDE-SENTINEL.txt').slice(1))}`,
      ];
      for (const url of attempts) {
        const res = await s.get(url);
        expect(res.body, url).not.toContain(DIST_SENTINEL);
        expect(res.body, url).not.toContain('"name": "nexus-play-studio"');
      }
    });

    it('API responses are no-store, nosniff, never framable and never carry CORS headers', async () => {
      const res = await s.get('/api/projects', { origin: 'http://evil.example' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.headers['cross-origin-resource-policy']).toBe('same-origin');
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
      const preflight = await s.inject({
        method: 'OPTIONS',
        url: '/api/projects',
        headers: { host: STUDIO_HOST, origin: 'http://evil.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'x-nexus-csrf,content-type' },
      });
      expect(preflight.statusCode).toBeGreaterThanOrEqual(400);
      for (const name of Object.keys(preflight.headers)) expect(name.startsWith('access-control-'), `${name} on a refused preflight`).toBe(false);
    });
  });

  describe('Anthropic key handling', () => {
    it('reports no key by default', async () => {
      const health = (await s.get('/api/health')).json();
      expect(health.claude.keyPresent).toBe(false);
      expect(health.claude.state).toBe('not_configured');
      expect(health.limits.maxUploadBytes).toBe(40 * 1024 * 1024);
    });

    it('never exposes the key in any response (health, settings, projects, jobs) or in the database', async () => {
      const sink = await startClaudeSink();
      const k = await Studio.start({ claude: { baseUrl: sink.url, maxRetries: 0, timeoutMs: 5_000 } });
      setApiKey(FAKE_KEY);
      const bodies: Array<[string, string]> = [];
      const seen = async (label: string, res: Promise<Res>) => {
        const r = await res;
        bodies.push([label, `${JSON.stringify(r.headers)}\n${r.body}`]);
        return r;
      };
      try {
        const p = await k.createProject('Key exposure check');
        await k.importDeck(p.id);

        const health = (await seen('health', k.get('/api/health'))).json();
        expect(health.claude.keyPresent).toBe(true);
        expect(health.claude.state).toBe('unverified');

        // Settings: no model chosen → explained without any network call.
        const test = (await seen('settings test', k.post('/api/settings/claude/test', { testRequest: false }))).json();
        expect(test.claude.lastError).toMatch(/No model selected/);
        // Choosing a model verifies it — against the local sink, which drops the connection.
        const chosen = await seen('settings model', k.post('/api/settings/claude/model', { model: 'claude-it-model' }));
        expect(chosen.statusCode).toBe(200);
        expect(chosen.json().claude.state).toBe('connection_failed');
        const models = await seen('settings models', k.get('/api/settings/claude/models'));
        expect(models.statusCode).toBe(502);
        expect(models.json().error.code).toBe('models_unavailable');
        await seen('health after verify', k.get('/api/health'));
        await seen('usage', k.get('/api/usage'));

        // Projects and jobs.
        await seen('projects', k.get('/api/projects'));
        await seen('project', k.get(`/api/projects/${p.id}`));
        await seen('slides', k.get(`/api/projects/${p.id}/slides`));
        const preview = await seen('ai preview', k.get(`/api/projects/${p.id}/ai-preview?countTokens=1`));
        expect(preview.statusCode).toBe(200);
        expect(preview.json().tokenCount).toBeNull();
        const analyze = await seen('analyze job', k.post(`/api/projects/${p.id}/jobs`, { type: 'analyze', input: {} }));
        expect(analyze.statusCode).toBe(409);
        expect(analyze.json().error.code).toBe('claude_unverified');
        const jobs = (await seen('jobs', k.get(`/api/projects/${p.id}/jobs`))).json().jobs as Array<{ id: string }>;
        expect(jobs.length).toBeGreaterThan(0);
        for (const j of jobs) {
          await seen(`job ${j.id}`, k.get(`/api/jobs/${j.id}`));
          await seen(`job events ${j.id}`, k.get(`/api/jobs/${j.id}/events`));
        }

        for (const [label, text] of bodies) {
          expect(text, label).not.toContain(FAKE_KEY);
          expect(text, label).not.toContain('FAKEKEY');
        }
        expect(databaseBytes(k.dataDir).includes(Buffer.from('FAKEKEY')), 'the key must never be written to the database').toBe(false);
        // The gateway's connection attempts (model verify / list) went to the local sink, not to Anthropic.
        expect(sink.connections()).toBeGreaterThan(0);
      } finally {
        setApiKey(null);
        await k.close();
        await sink.close();
      }
    });
  });
});
