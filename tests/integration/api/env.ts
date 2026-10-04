/**
 * Imported FIRST by every API integration test file (and by helpers.ts), before
 * any server module is evaluated:
 *  - a developer's real `.env` is never loaded (NEXUS_ENV_FILE points to a file
 *    that does not exist);
 *  - no Anthropic key, model or base URL is visible, so real Claude can never be
 *    called (tests that need a key set a fake one and reset the secrets cache);
 *  - server tuning variables are cleared so every run uses the documented defaults
 *    (the Host/Origin allowlist depends on PORT, for example).
 *
 * This module must not import anything from the server.
 */
import os from 'node:os';
import path from 'node:path';

export const MISSING_ENV_FILE = path.join(os.tmpdir(), `nexus-it-no-env-${process.pid}`, 'this-file-does-not-exist.env');
process.env.NEXUS_ENV_FILE = MISSING_ENV_FILE;

const CLEARED = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
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
  'MAX_UPLOAD_MB',
  'MAX_SLIDES',
  'MAX_EXPANDED_MB',
  'MAX_ZIP_ENTRIES',
  'MAX_XML_MB',
  'MAX_IMAGE_MEGAPIXELS',
  'MAX_ASSET_MB',
  'MAX_PDF_PAGES',
  'RENDERER',
  'SOFFICE_PATH',
  'RENDERER_DOCKER_IMAGE',
  'RENDER_TIMEOUT_MS',
  'FIGMA_ACCESS_TOKEN',
  'FIGMA_API_BASE_URL',
  'FIGMA_ASSET_HOSTS',
  'FIGMA_TIMEOUT_MS',
  'FIGMA_MAX_AUTO_WAIT_SECONDS',
  'FIGMA_MAX_DOWNLOAD_MB',
];
for (const name of CLEARED) delete process.env[name];
