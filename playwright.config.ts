import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.E2E_PORT ?? 5194);

/**
 * Browser tests run against a production build served by the API on its own
 * port, with a throw-away data directory and no API key (see tests/e2e/start-servers.ts).
 */
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: 'test-results',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
  webServer: {
    command: 'npm run build && node_modules/.bin/tsx tests/e2e/start-servers.ts',
    url: `http://127.0.0.1:${port}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { E2E_PORT: String(port) },
  },
});
