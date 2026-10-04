import type { FigmaStatus } from '@shared/schemas/settings.ts';
import type { App } from '../app.ts';
import { cacheGet, cachePut } from '../db/design.ts';
import { getSetting, setSetting } from '../db/misc.ts';
import { getFigmaToken, hasFigmaToken, redactSecrets } from '../secrets.ts';
import { FigmaClient, FigmaError } from './client.ts';

export { FigmaClient, FigmaError } from './client.ts';

/** A client for one project's job or request; responses are cached per project (never the token). */
export function figmaClient(app: App, opts: { projectId: string; signal?: AbortSignal; onWait?: (seconds: number, reason: string) => void; fetchImpl?: typeof fetch }): FigmaClient {
  const c = app.config.figma;
  return new FigmaClient({
    baseUrl: c.apiBaseUrl,
    token: getFigmaToken(),
    assetHosts: c.assetHosts,
    timeoutMs: c.timeoutMs,
    maxAutoWaitSeconds: c.maxAutoWaitSeconds,
    maxDownloadBytes: c.maxDownloadBytes,
    signal: opts.signal,
    onWait: opts.onWait,
    fetchImpl: opts.fetchImpl,
    cache: {
      get: <T>(key: string) => cacheGet<T>(app.db, `${opts.projectId}:${key}`),
      put: (key: string, value: unknown, ttlMs: number) => cachePut(app.db, opts.projectId, `${opts.projectId}:${key}`, value, ttlMs),
    },
  });
}

/** What Settings shows. Hosted multi-user OAuth is a separate integration and is reported as not configured. */
export function figmaStatus(app: App): FigmaStatus {
  const saved = getSetting<Partial<FigmaStatus> | null>(app.db, 'figma.status', null);
  const tokenPresent = hasFigmaToken();
  if (!tokenPresent) {
    return {
      state: 'not-configured',
      tokenPresent: false,
      account: null,
      detail: 'No FIGMA_ACCESS_TOKEN on the server. Paste-link import is unavailable; uploading exported screens still works.',
      checkedAt: null,
      oauth: 'not-configured',
      apiBaseUrl: app.config.figma.apiBaseUrl,
    };
  }
  return {
    state: saved?.state === 'verified' || saved?.state === 'error' ? saved.state : 'configured',
    tokenPresent: true,
    account: saved?.account ?? null,
    detail: saved?.detail ?? 'A personal access token is configured on the server. Use “Test connection” to check it.',
    checkedAt: saved?.checkedAt ?? null,
    oauth: 'not-configured',
    apiBaseUrl: app.config.figma.apiBaseUrl,
  };
}

/** Check the token against /v1/me. A missing current_user:read scope is reported, not treated as a broken token. */
export async function testFigma(app: App): Promise<FigmaStatus> {
  if (!hasFigmaToken()) return figmaStatus(app);
  const client = figmaClient(app, { projectId: 'settings' });
  let next: Partial<FigmaStatus>;
  try {
    const me = await client.me();
    next = { state: 'verified', account: me.handle, detail: `Connected${me.handle ? ` as ${me.handle}` : ''}. Files are read only; nothing is ever written back to Figma.` };
  } catch (err) {
    if (err instanceof FigmaError && err.code === 'forbidden') {
      next = { state: 'configured', account: null, detail: 'The token works but cannot read the account profile (it lacks current_user:read). File access is checked when you import a link.' };
    } else {
      const e = err instanceof FigmaError ? err : null;
      next = { state: 'error', account: null, detail: redactSecrets(e ? `${e.message} ${e.hint}` : `Unexpected error: ${(err as Error).message}`) };
    }
  }
  setSetting(app.db, 'figma.status', { ...next, checkedAt: new Date().toISOString() });
  return figmaStatus(app);
}
