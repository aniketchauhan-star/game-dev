import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FigmaMock } from '../support/figma-mock.ts';

/**
 * Starts the API and the worker for browser tests on their own port with a
 * fresh data directory. No .env is loaded and no API key is present, so the
 * live Anthropic API can never be reached from these tests.
 *
 * Figma: the server is pointed at a LOCAL MOCK of the Figma REST API serving
 * the bundled trapezium sample (tests/support/figma-mock.ts) with a fake
 * token. Browser tests therefore never reach live Figma, and passing them is
 * not evidence about live Figma behaviour.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const E2E_PORT = Number(process.env.E2E_PORT ?? 5194);
const dataDir = path.join(root, 'tests', '.tmp', 'e2e-data');
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });

export const E2E_FIGMA_TOKEN = 'figd_e2e-mock-token-not-real-000';
const figma = new FigmaMock({ token: E2E_FIGMA_TOKEN });
const figmaOrigin = await figma.start(E2E_PORT + 7);

const env: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  TMPDIR: process.env.TMPDIR,
  NODE_ENV: 'production',
  HOST: '127.0.0.1',
  PORT: String(E2E_PORT),
  STUDIO_DEV_PORT: String(E2E_PORT + 1),
  NEXUS_DATA_DIR: dataDir,
  NEXUS_ENV_FILE: path.join(dataDir, 'no-such.env'),
  RENDERER: 'off',
  FIGMA_ACCESS_TOKEN: E2E_FIGMA_TOKEN,
  FIGMA_API_BASE_URL: figmaOrigin,
};

const tsx = path.join(root, 'node_modules', '.bin', 'tsx');
const children: ChildProcess[] = [];
for (const entry of ['server/src/index.ts', 'server/src/worker.ts']) {
  const child = spawn(tsx, [entry], { cwd: root, env, stdio: 'inherit' });
  child.on('exit', (code) => {
    if (code && code !== 0) {
      console.error(`${entry} exited with ${code}`);
      shutdown(1);
    }
  });
  children.push(child);
}

function shutdown(code = 0): void {
  for (const c of children) c.kill('SIGTERM');
  void figma.stop();
  setTimeout(() => process.exit(code), 500).unref();
}
process.on('SIGINT', () => shutdown());
process.on('SIGTERM', () => shutdown());
