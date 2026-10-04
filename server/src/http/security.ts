import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ServerConfig } from '../config.ts';

/**
 * Local-only protections:
 *  - Host allowlist (blocks DNS-rebinding attacks against the loopback API);
 *  - mutating requests need the custom `X-Nexus-CSRF` header (forces a CORS
 *    preflight that we never approve), an allowed Origin when one is sent, and a
 *    same-origin Fetch Metadata hint when the browser provides one;
 *  - no CORS headers are ever sent for the API;
 *  - restrictive response headers.
 */

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export const STUDIO_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; font-src 'self'; connect-src 'self'; worker-src 'self' blob:; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** CSP for the sandboxed preview document. `self` is spelled out because a sandboxed document has an opaque origin. */
export function previewCsp(origin: string): string {
  return [
    "default-src 'none'",
    `script-src 'self' ${origin}`,
    `style-src 'self' ${origin}`,
    `font-src 'self' ${origin}`,
    'img-src blob: data:',
    'media-src blob:',
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "frame-ancestors 'self'",
  ].join('; ');
}

function reject(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.code(status).type('application/json').send({ error: { code, message } });
}

export function registerSecurity(app: FastifyInstance, config: ServerConfig): void {
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    const host = (req.headers.host ?? '').toLowerCase();
    if (!config.allowedHosts.has(host)) {
      return reject(reply, 421, 'host_not_allowed', 'This server only answers requests addressed to localhost.');
    }
    // Every state-changing request is checked, whatever its spelling: the router decodes
    // percent-encoded paths (/%61pi/… reaches /api/…), so a prefix test on the raw URL is not enough.
    if (MUTATING.has(req.method)) {
      if (req.headers['x-nexus-csrf'] !== '1') return reject(reply, 403, 'csrf', 'Missing request protection header.');
      const origin = req.headers.origin;
      if (origin !== undefined && !config.allowedOrigins.has(origin)) return reject(reply, 403, 'origin', 'Cross-site requests are not allowed.');
      const site = req.headers['sec-fetch-site'];
      if (site !== undefined && site !== 'same-origin' && site !== 'none') return reject(reply, 403, 'fetch_site', 'Cross-site requests are not allowed.');
    }
  });

  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    // The matched route pattern, not the raw (possibly percent-encoded) URL.
    const route = req.routeOptions?.url ?? req.url;
    if (route.startsWith('/preview/')) {
      reply.header('Cross-Origin-Resource-Policy', 'cross-origin');
    } else {
      reply.header('Cross-Origin-Resource-Policy', 'same-origin');
      reply.header('X-Frame-Options', 'DENY');
    }
    if (route.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
    return payload;
  });
}
