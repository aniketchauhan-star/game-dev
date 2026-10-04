import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import type { App } from '../app.ts';
import { ClaudeError } from '../claude/gateway.ts';
import { HttpError } from '../errors.ts';
import { redactSecrets } from '../secrets.ts';
import { resolveInside } from '../storage.ts';
import { assetRoutes } from './routes/assets.ts';
import { designRoutes } from './routes/design.ts';
import { gradeRoutes } from './routes/grade.ts';
import { screenRoutes } from './routes/screens.ts';
import { motionRoutes } from './routes/motion.ts';
import { prepareRoutes } from './routes/prepare.ts';
import { exportRoutes } from './routes/exports.ts';
import { jobRoutes } from './routes/jobs.ts';
import { learningRoutes } from './routes/learning.ts';
import { projectRoutes } from './routes/projects.ts';
import { settingsRoutes } from './routes/settings.ts';
import { sourceRoutes } from './routes/sources.ts';
import { versionRoutes } from './routes/versions.ts';
import { previewCsp, registerSecurity, STUDIO_CSP } from './security.ts';
import { sendFile } from './util.ts';

export const PREVIEW_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Game preview</title>
<link rel="stylesheet" href="/preview/runtime.css">
</head>
<body>
<main id="nexus-game" class="nx-root" aria-label="Game preview"></main>
<script src="/preview/runtime.js"></script>
</body>
</html>
`;

export async function buildServer(app: App, opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const f = Fastify({
    logger: opts.logger ? { level: 'info', redact: ['req.headers.authorization', 'req.headers["x-api-key"]', 'req.headers.cookie'] } : false,
    bodyLimit: 6 * 1024 * 1024,
    trustProxy: false,
  });

  registerSecurity(f, app.config);
  await f.register(multipart, {
    limits: { fileSize: Math.max(app.config.limits.maxUploadBytes, app.config.limits.maxAssetBytes), files: 20, fields: 10, parts: 40 },
  });

  f.setErrorHandler((err: Error & { statusCode?: number; code?: string }, req, reply) => {
    if (err instanceof HttpError) {
      return reply.code(err.status).send({ error: { code: err.code, message: err.message, hint: err.hint ?? null, details: err.details ?? null } });
    }
    if (err instanceof ClaudeError) {
      const status = err.code === 'not_configured' || err.code === 'model_unverified' ? 409 : 502;
      return reply.code(status).send({ error: { code: `claude_${err.code}`, message: err.message, hint: null, details: null } });
    }
    if (err.code === 'FST_REQ_FILE_TOO_LARGE' || err.code === 'FST_FILES_LIMIT') {
      return reply.code(413).send({ error: { code: 'too_large', message: 'The upload is larger than allowed.', hint: `Files may be up to ${Math.round(app.config.limits.maxUploadBytes / 1048576)} MB.`, details: null } });
    }
    if (err.code === 'FST_INVALID_MULTIPART_CONTENT_TYPE') {
      return reply.code(415).send({ error: { code: 'not_multipart', message: 'Expected a file upload.', hint: null, details: null } });
    }
    if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
      return reply.code(err.statusCode).send({ error: { code: err.code ?? 'bad_request', message: redactSecrets(err.message), hint: null, details: null } });
    }
    const message = redactSecrets(err.message ?? String(err));
    if (/SQLITE_CONSTRAINT|constraint failed|immutable/i.test(message)) {
      return reply.code(409).send({ error: { code: 'conflict', message: message.includes('immutable') ? 'That record is immutable. Create a new draft or version instead.' : 'The change conflicts with saved data.', hint: null, details: null } });
    }
    req.log?.error({ err: message }, 'request failed');
    if (!opts.logger) console.error('[api] unexpected error:', message);
    return reply.code(500).send({ error: { code: 'internal', message: 'Unexpected server error. Your saved work is unchanged.', hint: null, details: null } });
  });

  settingsRoutes(f, app);
  projectRoutes(f, app);
  sourceRoutes(f, app);
  learningRoutes(f, app);
  jobRoutes(f, app);
  versionRoutes(f, app);
  assetRoutes(f, app);
  designRoutes(f, app);
  gradeRoutes(f, app);
  screenRoutes(f, app);
  motionRoutes(f, app);
  prepareRoutes(f, app);
  exportRoutes(f, app);

  // ── Sandboxed preview document and runtime files ──
  const runtimeDir = path.join(app.config.distDir, 'runtime');
  f.get('/preview/index.html', async (req, reply) => {
    reply.header('Content-Security-Policy', previewCsp(`http://${req.headers.host}`));
    reply.header('Cache-Control', 'no-store');
    return reply.type('text/html; charset=utf-8').send(PREVIEW_HTML);
  });
  f.get('/preview/*', async (req, reply) => {
    const rel = (req.params as { '*': string })['*'];
    let file: string;
    try {
      file = resolveInside(runtimeDir, rel);
    } catch {
      return reply.code(404).send('Not found');
    }
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      return reply.code(404).type('text/plain').send(rel.startsWith('runtime') ? 'Runtime not built yet — run `npm run build:runtime`.' : 'Not found');
    }
    if (file.endsWith('.woff2') || file.endsWith('.woff')) reply.header('Access-Control-Allow-Origin', '*');
    return sendFile(reply, file, { cache: 'no-cache' });
  });

  // ── Built studio (production). In development Vite serves the studio and proxies /api and /preview. ──
  const studioDir = path.join(app.config.distDir, 'studio');
  if (fs.existsSync(path.join(studioDir, 'index.html'))) {
    f.get('/*', async (req, reply) => {
      const url = (req.params as { '*': string })['*'];
      if (url.startsWith('api/')) return reply.code(404).send({ error: { code: 'not_found', message: 'Unknown API route.' } });
      let file = path.join(studioDir, 'index.html');
      if (url) {
        try {
          const candidate = resolveInside(studioDir, url);
          if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) file = candidate;
        } catch {
          // fall back to the SPA entry
        }
      }
      if (file.endsWith('index.html')) {
        reply.header('Content-Security-Policy', STUDIO_CSP);
        return sendFile(reply, file, { cache: 'no-cache' });
      }
      return sendFile(reply, file, { cache: url.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache' });
    });
  }
  return f;
}
