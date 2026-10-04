import { expect, test } from '@playwright/test';
import { createSample } from './helpers.ts';

test('dashboard: search, rename, duplicate and confirmed delete', async ({ page, request, baseURL }) => {
  await createSample(request, baseURL!);
  await page.goto('/');
  const card = (name: string) => page.locator('.project-card', { hasText: name });
  const menu = async (name: string, item: string) => {
    await page.getByRole('button', { name: `More actions for ${name}` }).first().click();
    await page.getByRole('menuitem', { name: item }).click();
  };

  // Rename.
  await menu('Air Traffic Control — Coordinate Mission', 'Rename');
  await page.locator('#rename-input').fill('Tower Practice');
  await page.getByRole('button', { name: 'Save name' }).click();
  await expect(card('Tower Practice')).toBeVisible();

  // Duplicate creates an independent copy.
  await menu('Tower Practice', 'Duplicate');
  await expect(page.getByRole('button', { name: 'Tower Practice (copy)', exact: true })).toBeVisible();

  // Search filters by name.
  await page.getByPlaceholder(/Search by name/).fill('copy');
  await expect(page.locator('.project-card')).toHaveCount(1);
  await page.getByPlaceholder(/Search by name/).fill('');

  // Delete requires typing the exact name.
  const copyName = (await page.locator('.project-card .title-link', { hasText: /copy/i }).first().innerText()).trim();
  await menu(copyName, 'Delete…');
  const confirm = page.getByRole('button', { name: 'Delete project' });
  await expect(confirm).toBeDisabled();
  await page.getByRole('dialog').getByRole('textbox').fill(copyName);
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(page.locator('.project-card', { hasText: copyName })).toHaveCount(0);
  await expect(card('Tower Practice')).toBeVisible();
});

test('version history: restoring an earlier version creates a new current version', async ({ page, request, baseURL }) => {
  const projectId = await createSample(request, baseURL!);
  await page.goto(`/p/${projectId}/build`);
  await page.locator('.scene-item-main', { hasText: 'Taxi to Runway Alpha' }).click();
  const composer = page.getByLabel('Describe a change for Claude');
  await composer.fill('Make the grid and points easier to see');
  await composer.press('Enter');
  await page.locator('.proposal').last().getByRole('button', { name: /^Apply/ }).click();
  await expect(page.locator('.version-chip')).toContainText('v2');

  await page.locator('.version-chip').click();
  await page.getByRole('menuitem', { name: 'Restore v1 as a new version' }).click();
  await expect(page.locator('.version-chip')).toContainText('v3');
  const versions = await request.get(`/api/projects/${projectId}/versions`);
  const list = ((await versions.json()) as { versions: Array<{ number: number }> }).versions.map((v) => v.number).sort();
  expect(list).toEqual([1, 2, 3]);
});
