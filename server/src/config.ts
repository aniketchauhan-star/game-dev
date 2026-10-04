import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Limits } from '@shared/schemas/settings.ts';

/**
 * Server configuration from the environment. The Anthropic API key is NOT part
 * of this object (see secrets.ts) so it can never be serialized by accident.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, '..', '..');

let envLoaded = false;
export function loadDotEnv(): void {
  if (envLoaded) return;
  envLoaded = true;
  const file = process.env.NEXUS_ENV_FILE ?? path.join(REPO_ROOT, '.env');
  if (fs.existsSync(file)) {
    try {
      process.loadEnvFile(file);
    } catch (err) {
      console.error(`Could not read ${file}: ${(err as Error).message}`);
    }
  }
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number`);
  return Math.floor(n);
}

/** Like int() but allows zero (e.g. "no retries"). */
function count(name: string, fallback: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be zero or a positive number`);
  return Math.min(Math.floor(n), max);
}

function str(name: string): string | null {
  const v = process.env[name];
  return v && v.trim() !== '' ? v.trim() : null;
}

export interface ServerConfig {
  host: string;
  port: number;
  studioDevPort: number;
  isProduction: boolean;
  dataDir: string;
  allowedHosts: Set<string>;
  allowedOrigins: Set<string>;
  claude: {
    model: string | null;
    baseUrl: string | null;
    refusalFallback: 'default' | 'off';
    timeoutMs: number;
    maxRetries: number;
    maxRepairAttempts: number;
  };
  limits: Limits;
  renderer: {
    mode: 'libreoffice' | 'docker' | 'off';
    sofficePath: string | null;
    dockerImage: string | null;
    timeoutMs: number;
  };
  figma: {
    /** Official API origin. Only https://api.figma.com, or a loopback mock for tests. */
    apiBaseUrl: string;
    /** Hosts asset downloads may come from (render and image-fill URLs). */
    assetHosts: string[];
    timeoutMs: number;
    /** Longest Retry-After the server waits automatically; longer waits fail with a manual retry. */
    maxAutoWaitSeconds: number;
    maxDownloadBytes: number;
  };
  pricingFile: string | null;
  distDir: string;
}

const FIGMA_DEFAULT_ASSET_HOSTS = ['figma-alpha-api.s3.us-west-2.amazonaws.com', 's3-alpha-sig.figma.com', 's3-alpha.figma.com'];

/** Accept the official API origin, or a loopback origin (local mock server for tests). */
function figmaBaseUrl(raw: string | null): string {
  const value = raw ?? 'https://api.figma.com';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('FIGMA_API_BASE_URL must be a URL');
  }
  const loopback = isLoopback(url.hostname) || url.hostname === '[::1]';
  if (!(url.protocol === 'https:' && url.hostname === 'api.figma.com' && !url.port) && !loopback) {
    throw new Error('FIGMA_API_BASE_URL must be https://api.figma.com (or a loopback mock server for tests)');
  }
  if (url.username || url.password || (url.pathname !== '/' && url.pathname !== '')) throw new Error('FIGMA_API_BASE_URL must be an origin without a path');
  return url.origin;
}

export function loadConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  loadDotEnv();
  const host = str('HOST') ?? '127.0.0.1';
  const port = int('PORT', 5174);
  const studioDevPort = int('STUDIO_DEV_PORT', 5173);
  const isProduction = process.env.NODE_ENV === 'production';
  const dataDir = path.resolve(REPO_ROOT, str('NEXUS_DATA_DIR') ?? 'data');

  const loopbackNames = ['localhost', '127.0.0.1', '[::1]'];
  const allowedHosts = new Set<string>();
  const allowedOrigins = new Set<string>();
  for (const name of loopbackNames) {
    for (const p of [port, studioDevPort]) {
      allowedHosts.add(`${name}:${p}`);
      allowedOrigins.add(`http://${name}:${p}`);
    }
  }
  for (const extra of (str('ALLOWED_HOSTS') ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    allowedHosts.add(extra);
    allowedOrigins.add(`http://${extra}`);
  }

  const fallback = (str('CLAUDE_REFUSAL_FALLBACK') ?? 'default').toLowerCase();
  const mode = (str('RENDERER') ?? 'libreoffice').toLowerCase();

  const config: ServerConfig = {
    host,
    port,
    studioDevPort,
    isProduction,
    dataDir,
    allowedHosts,
    allowedOrigins,
    claude: {
      model: str('CLAUDE_MODEL'),
      baseUrl: str('ANTHROPIC_BASE_URL'),
      refusalFallback: fallback === 'off' ? 'off' : 'default',
      timeoutMs: int('CLAUDE_TIMEOUT_MS', 10 * 60 * 1000),
      maxRetries: count('CLAUDE_MAX_RETRIES', 2, 5),
      maxRepairAttempts: count('CLAUDE_MAX_REPAIR_ATTEMPTS', 1, 2),
    },
    limits: {
      maxUploadBytes: int('MAX_UPLOAD_MB', 40) * 1024 * 1024,
      maxSlides: int('MAX_SLIDES', 80),
      maxExpandedBytes: int('MAX_EXPANDED_MB', 300) * 1024 * 1024,
      maxEntries: int('MAX_ZIP_ENTRIES', 4000),
      maxXmlBytes: int('MAX_XML_MB', 8) * 1024 * 1024,
      maxImagePixels: int('MAX_IMAGE_MEGAPIXELS', 50) * 1_000_000,
      maxAssetBytes: int('MAX_ASSET_MB', 25) * 1024 * 1024,
      maxPdfPages: int('MAX_PDF_PAGES', 200),
    },
    renderer: {
      mode: mode === 'docker' ? 'docker' : mode === 'off' ? 'off' : 'libreoffice',
      sofficePath: str('SOFFICE_PATH'),
      dockerImage: str('RENDERER_DOCKER_IMAGE'),
      timeoutMs: int('RENDER_TIMEOUT_MS', 120_000),
    },
    figma: (() => {
      const apiBaseUrl = figmaBaseUrl(str('FIGMA_API_BASE_URL'));
      const loopbackApi = isLoopback(new URL(apiBaseUrl).hostname);
      const extra = (str('FIGMA_ASSET_HOSTS') ?? '')
        .split(',')
        .map((h) => h.trim().toLowerCase())
        .filter((h) => /^[a-z0-9.-]+(:\d+)?$/.test(h));
      // A loopback mock API may serve its own downloads; the real API only uses the allowlisted hosts.
      return {
        apiBaseUrl,
        assetHosts: [...FIGMA_DEFAULT_ASSET_HOSTS, ...extra, ...(loopbackApi ? [new URL(apiBaseUrl).host] : [])],
        timeoutMs: int('FIGMA_TIMEOUT_MS', 30_000),
        maxAutoWaitSeconds: count('FIGMA_MAX_AUTO_WAIT_SECONDS', 20, 120),
        maxDownloadBytes: int('FIGMA_MAX_DOWNLOAD_MB', 20) * 1024 * 1024,
      };
    })(),
    pricingFile: str('CLAUDE_PRICING_FILE') ? path.resolve(REPO_ROOT, str('CLAUDE_PRICING_FILE')!) : null,
    distDir: path.join(REPO_ROOT, 'dist'),
    ...overrides,
  };

  if (!isLoopback(config.host) && process.env.NEXUS_ALLOW_REMOTE !== 'yes-i-understand') {
    throw new Error(
      `Refusing to bind to ${config.host}: NEXUS Play Studio has no authentication and must stay on loopback. ` +
        'See README “Hosting boundaries”.',
    );
  }
  return config;
}

export function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}
