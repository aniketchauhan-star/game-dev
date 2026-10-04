import sharp from 'sharp';
import { expect, test } from '@playwright/test';
import { createSample, csrfHeaders } from './helpers.ts';

interface AssetLite {
  id: string;
  name: string;
  metadata: { placement: { scale: number; rotation: number; anchorX: number; anchorY: number } };
  usage: Array<{ kind: string }>;
}

test('replacing an asset keeps its placement, saves a new game version, and SVG uploads never reach the DOM as markup', async ({ page, request, baseURL }) => {
  const projectId = await createSample(request, baseURL!);
  const list = async () => ((await (await request.get(`/api/projects/${projectId}/assets`)).json()) as { assets: AssetLite[] }).assets;
  const aircraft = (await list()).find((a) => a.name === 'aircraft')!;
  expect(aircraft.usage.length).toBeGreaterThan(0);

  // Give the aircraft a distinctive placement.
  const placement = { scale: 1.6, rotation: 15, anchorX: 0.3, anchorY: 0.7, crop: null };
  const patched = await request.patch(`/api/assets/${aircraft.id}`, { headers: csrfHeaders(baseURL!), data: { metadata: { placement } } });
  expect(patched.ok(), await patched.text()).toBeTruthy();

  await page.goto(`/p/${projectId}/assets`);
  await page.locator('.asset-card', { hasText: 'aircraft' }).click();
  const png = await sharp({ create: { width: 300, height: 300, channels: 4, background: { r: 30, g: 90, b: 200, alpha: 1 } } }).png().toBuffer();
  await page.locator('.asset-detail input[type=file]').setInputFiles({ name: 'jet-v2.png', mimeType: 'image/png', buffer: png });
  await expect(page.getByText(/Placement kept/)).toBeVisible();

  const replacement = (await list()).find((a) => a.name === 'jet-v2')!;
  expect(replacement.metadata.placement).toMatchObject({ scale: 1.6, rotation: 15, anchorX: 0.3, anchorY: 0.7 });
  // The current game version now uses the replacement, as a new version.
  const bundle = (await (await request.get(`/api/projects/${projectId}/preview-bundle`)).json()) as { version: { number: number }; config: { assets: Record<string, unknown> } };
  expect(bundle.version.number).toBe(2);
  expect(Object.keys(bundle.config.assets)).toContain(replacement.id);
  expect(Object.keys(bundle.config.assets)).not.toContain(aircraft.id);

  // A hostile SVG is refused with a reason; a clean one is shown only as a raster image.
  await page.locator('.asset-uploader input[type=file], input[type=file]').first().setInputFiles([
    { name: 'evil.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script><rect width="10" height="10"/></svg>') },
    { name: 'clean.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><rect width="120" height="60" fill="#2a9d8f"/><text x="60" y="38" text-anchor="middle" fill="#fff">CLEAN</text></svg>') },
  ]);
  await expect(page.getByText('evil.svg')).toBeVisible();
  await expect(page.getByText('SVG contains scripts.')).toBeVisible();
  await expect(page.locator('.asset-card', { hasText: 'clean' })).toBeVisible();
  const inlineSvgWithUploadedText = await page.evaluate(() => [...document.querySelectorAll('svg')].some((s) => s.textContent?.includes('CLEAN')));
  expect(inlineSvgWithUploadedText).toBe(false);
  const src = await page.locator('.asset-card', { hasText: 'clean' }).locator('img').getAttribute('src');
  const served = await request.get(src!);
  expect(served.headers()['content-type']).toMatch(/^image\/(png|webp)/);
});
