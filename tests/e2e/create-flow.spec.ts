import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { previewConfig, solveScene } from './helpers.ts';

const DECK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures', 'sample', 'air-traffic-control.pptx');

test('without Claude: import a deck, write a brief, author and approve a blueprint, build and play it', async ({ page, request }) => {
  page.on('dialog', (d) => void d.accept());
  await page.goto('/');
  await page.getByRole('button', { name: 'Create game', exact: true }).first().click();
  await page.waitForURL(/\/create\/source/);

  // 1. Source — real PPTX ingestion through the worker.
  await page.locator('input[type=file]').first().setInputFiles(DECK);
  const summary = page.getByLabel('Import summary');
  await expect(summary).toBeVisible({ timeout: 60_000 });
  await expect(summary).toContainText('9 slides');
  await expect(summary).toContainText('1 hidden');

  // 2. Brief — the project name follows the working title.
  await page.getByRole('button', { name: /Continue/ }).last().click();
  await page.locator('#brief-prompt').fill('Learners guide aircraft to runway coordinates.');
  await page.locator('#brief-title').fill('Runway Coordinates');
  await page.locator('#brief-grade').fill('Grade 8');
  await page.locator('#brief-subject').fill('Mathematics');
  await page.locator('#brief-objective').fill('Plot and read ordered pairs in all four quadrants.');
  await page.getByRole('radio', { name: /Coordinate navigation/ }).check();
  await expect(page.locator('input.project-name')).toHaveValue('Runway Coordinates');

  // 3. Visual direction and 4. Review (shows exactly what would be sent to Claude).
  await page.getByRole('button', { name: /Continue/ }).last().click();
  await page.waitForURL(/\/create\/visual/);
  await page.getByRole('button', { name: /Continue/ }).last().click();
  await page.waitForURL(/\/create\/review/);
  await expect(page.getByText('What will be sent to Claude')).toBeVisible();
  await expect(page.getByText('Claude is not configured')).toBeVisible();
  await page.getByRole('button', { name: /Continue without Claude/ }).click();
  await page.waitForURL(/\/source$/);
  const projectId = page.url().match(/\/p\/([^/]+)/)![1]!;

  // Blueprint by hand: approval is blocked until the premise is written.
  await page.goto(`/p/${projectId}/blueprint`);
  await page.getByRole('button', { name: 'Start one yourself' }).click();
  const approve = page.getByRole('button', { name: /Approve blueprint/ });
  await expect(page.getByText('Before you can approve')).toBeVisible();
  await expect(approve).toBeDisabled();
  await page.locator('#bp-premise').fill('You are the tower controller at a busy airfield laid out on a coordinate grid.');
  await expect(approve).toBeEnabled({ timeout: 10_000 });

  // Turn scene 2 into a coordinate-navigation interaction.
  await page.locator('.scene-item-main').nth(1).click();
  await page.getByLabel('Scene type').selectOption('coordinate-navigation');
  await expect(page.getByText(/Success rule:/)).toBeVisible();
  await page.getByRole('button', { name: /All scenes/ }).click();
  await approve.click();
  await expect(page.getByText('Approved · immutable').first()).toBeVisible();

  // Build from the exact approved revision and play the coordinate scene.
  await page.getByRole('button', { name: /Build game from r1/ }).click();
  await page.waitForURL(/\/build/);
  await expect(page.locator('.version-chip')).toContainText('v1', { timeout: 30_000 });
  const config = await previewConfig(request, projectId);
  const frame = page.frameLocator('iframe.preview-iframe');
  await frame.getByRole('button', { name: config.screens.title.startLabel }).click();
  await solveScene(frame, config.scenes[0]!);
  await solveScene(frame, config.scenes[1]!);
  await expect(frame.locator('.nx-scene-title')).toContainText(config.scenes[2]!.title);
});
