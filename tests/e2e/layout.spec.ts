import { expect, test } from '@playwright/test';
import { createSample, previewConfig } from './helpers.ts';

const SIZES = [
  { width: 1280, height: 800 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
  { width: 1024, height: 768 },
  { width: 390, height: 844 },
];

test('studio screens never scroll sideways at desktop, tablet or phone widths', async ({ page, request, baseURL }) => {
  const projectId = await createSample(request, baseURL!);
  for (const size of SIZES) {
    await page.setViewportSize(size);
    for (const url of ['/', `/p/${projectId}/source`, `/p/${projectId}/blueprint`, `/p/${projectId}/build`, `/p/${projectId}/export`, '/settings']) {
      await page.goto(url);
      await page.waitForLoadState('networkidle');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `${url} at ${size.width}×${size.height}`).toBeLessThanOrEqual(0);
    }
  }
  // Phones get a clear notice about the desktop-first studio.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByText(/works best on a larger display/)).toBeVisible();
});

test('keyboard: the dashboard is reachable by Tab and a coordinate scene is solvable with arrow keys', async ({ page, request, baseURL }) => {
  const projectId = await createSample(request, baseURL!);
  await page.goto('/');
  await page.keyboard.press('Tab');
  const first = await page.evaluate(() => document.activeElement?.tagName);
  expect(first).toBeTruthy();
  expect(first).not.toBe('BODY');

  const config = await previewConfig(request, projectId);
  const scene = config.scenes.find((s) => s.interaction.type === 'coordinate-navigation' && s.interaction.rule.kind === 'point-equals')!;
  await page.goto(`/p/${projectId}/build`);
  const frame = page.frameLocator('iframe.preview-iframe');
  await expect(frame.getByRole('button', { name: 'Start' })).toBeVisible();
  // Jump straight to the scene from the studio's scene selector, then use only the keyboard.
  await page.getByLabel('Jump to scene').selectOption(scene.id);
  const it = scene.interaction as Extract<typeof scene.interaction, { type: 'coordinate-navigation' }>;
  const target = (it.rule as { target: { x: number; y: number } }).target;
  const grid = frame.locator('[aria-label^="Coordinate grid"]');
  await grid.focus();
  for (let x = it.start.x; x !== target.x; x += x < target.x ? it.grid.step : -it.grid.step) await grid.press(x < target.x ? 'ArrowRight' : 'ArrowLeft');
  for (let y = it.start.y; y !== target.y; y += y < target.y ? it.grid.step : -it.grid.step) await grid.press(y < target.y ? 'ArrowUp' : 'ArrowDown');
  await grid.press('Enter');
  await expect(frame.locator('.nx-feedback')).toContainText(/Correct/i);
});

test('side panels resize with the pointer and keyboard, collapse, and the Claude panel becomes a drawer on narrower screens', async ({ page, request, baseURL }) => {
  const projectId = await createSample(request, baseURL!);
  await page.goto(`/p/${projectId}/source`);
  const left = page.locator('aside.panel-left');
  const handle = page.getByRole('separator', { name: 'Resize inspector panel' });
  const w0 = (await left.boundingBox())!.width;

  // Pointer drag widens the inspector.
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + 200, { steps: 4 });
  await page.mouse.up();
  const w1 = (await left.boundingBox())!.width;
  expect(w1).toBeGreaterThan(w0 + 40);

  // Keyboard narrows it again (12px per arrow press).
  await handle.focus();
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowLeft');
  expect((await left.boundingBox())!.width).toBeLessThan(w1 - 30);

  // Collapse and restore both side panels.
  await page.getByRole('button', { name: 'Hide slides' }).click();
  await expect(left).toBeHidden();
  await page.getByRole('button', { name: 'Show slides' }).click();
  await expect(left).toBeVisible();
  await page.getByRole('button', { name: 'Hide Claude panel' }).click();
  await expect(page.locator('aside.panel-right')).toBeHidden();
  await page.getByRole('button', { name: 'Show Claude panel' }).click();
  await expect(page.locator('aside.panel-right')).toBeVisible();

  // Between 1024 and 1279px the Claude panel opens as a dismissible drawer.
  await page.setViewportSize({ width: 1180, height: 820 });
  await page.getByRole('button', { name: 'Open Claude panel' }).click();
  const drawer = page.getByRole('dialog', { name: 'Claude' });
  await expect(drawer).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
});
