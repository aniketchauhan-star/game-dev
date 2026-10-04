import { loadDotEnv } from './config.ts';

/**
 * The only place the Anthropic API key is read. It stays in this module: it is
 * never returned by an API route, written to the database, logged, sent to the
 * preview iframe, or included in exports.
 */

let cachedKey: string | null | undefined;

export function getApiKey(): string | null {
  if (cachedKey === undefined) {
    loadDotEnv();
    const raw = process.env.ANTHROPIC_API_KEY;
    cachedKey = raw && raw.trim() !== '' ? raw.trim() : null;
  }
  return cachedKey;
}

export function hasApiKey(): boolean {
  return getApiKey() !== null;
}

let cachedFigma: string | null | undefined;

/**
 * The server-configured Figma personal access token (local single-creator use).
 * Same rules as the Anthropic key: it never leaves this module except as a
 * request header to the Figma API; it is not stored, logged, shown, sent to
 * Claude, the preview or an export.
 */
export function getFigmaToken(): string | null {
  if (cachedFigma === undefined) {
    loadDotEnv();
    const raw = process.env.FIGMA_ACCESS_TOKEN;
    cachedFigma = raw && raw.trim() !== '' ? raw.trim() : null;
  }
  return cachedFigma;
}

export function hasFigmaToken(): boolean {
  return getFigmaToken() !== null;
}

/** Test hook: forget the cached key so a test can change the environment. */
export function resetSecretsForTests(): void {
  cachedKey = undefined;
  cachedFigma = undefined;
}

/** Remove any occurrence of secrets from a string before it is logged, stored or returned. */
export function redactSecrets(text: string): string {
  let out = text;
  const key = getApiKey();
  if (key && key.length >= 8) out = out.split(key).join('[redacted]');
  const figma = getFigmaToken();
  if (figma && figma.length >= 8) out = out.split(figma).join('[redacted]');
  // Also redact anything that looks like an Anthropic key or a Figma personal access token.
  out = out.replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, 'sk-ant-[redacted]');
  out = out.replace(/figd_[A-Za-z0-9_-]{8,}/g, 'figd_[redacted]');
  return out;
}
