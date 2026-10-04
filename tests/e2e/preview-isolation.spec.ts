import { expect, test, type Frame } from '@playwright/test';
import { createSample } from './helpers.ts';

/** The game preview must not be able to reach the studio, its storage, or the network. */
test('the sandboxed preview cannot reach the studio DOM, storage, cookies, the API or the network', async ({ page, request, baseURL }) => {
  const projectId = await createSample(request, baseURL!);
  await page.goto(`/p/${projectId}/build`);
  const frameEl = page.locator('iframe.preview-iframe');
  await expect(frameEl).toHaveAttribute('sandbox', 'allow-scripts');
  await expect(page.frameLocator('iframe.preview-iframe').getByRole('button', { name: 'Start' })).toBeVisible();

  const frame: Frame | null = await (await frameEl.elementHandle())!.contentFrame();
  expect(frame).not.toBeNull();
  const probe = await frame!.evaluate(async () => {
    const attempt = async (fn: () => unknown | Promise<unknown>) => {
      try {
        const v = await fn();
        return `allowed: ${String(v).slice(0, 40)}`;
      } catch (e) {
        return `blocked: ${(e as Error).name}`;
      }
    };
    return {
      origin: window.origin,
      parentDom: await attempt(() => window.parent.document.title),
      topLocation: await attempt(() => window.top!.location.href),
      localStorage: await attempt(() => window.localStorage.getItem('x')),
      cookie: await attempt(() => document.cookie),
      apiFetch: await attempt(() => fetch('/api/projects').then((r) => r.status)),
      externalFetch: await attempt(() => fetch('https://example.com/').then((r) => r.status)),
    };
  });

  expect(probe.origin).toBe('null');
  expect(probe.parentDom).toMatch(/^blocked/);
  expect(probe.topLocation).toMatch(/^blocked/);
  expect(probe.localStorage).toMatch(/^blocked/);
  expect(probe.cookie).toMatch(/^blocked/);
  expect(probe.apiFetch).toMatch(/^blocked/);
  expect(probe.externalFetch).toMatch(/^blocked/);
});

test('the preview document is served with a CSP that blocks network access', async ({ request }) => {
  const res = await request.get('/preview/index.html');
  expect(res.ok()).toBeTruthy();
  const csp = res.headers()['content-security-policy'] ?? '';
  expect(csp).toContain("connect-src 'none'");
  expect(csp).toMatch(/default-src 'none'|default-src 'self'/);
});
