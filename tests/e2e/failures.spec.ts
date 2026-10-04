import { expect, test } from '@playwright/test';

test('an unreadable or legacy deck fails with a clear reason and nothing is imported', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create game', exact: true }).first().click();
  await page.waitForURL(/\/create\/source/);

  // A legacy binary PowerPoint (OLE compound file) renamed to .pptx.
  const ole = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(4096)]);
  await page.locator('input[type=file]').first().setInputFiles({ name: 'old-lesson.pptx', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', buffer: ole });
  await expect(page.getByText(/password-protected or encrypted \(or is a legacy \.ppt renamed/).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('The deck could not be imported')).toBeVisible();
  await expect(page.getByLabel('Import summary')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Continue/ }).last()).toBeDisabled();

  // A macro-enabled deck is refused before upload, without a replace prompt.
  await page.locator('input[type=file]').first().setInputFiles({ name: 'macro.pptm', mimeType: 'application/vnd.ms-powerpoint.presentation.macroEnabled.12', buffer: Buffer.from('PK') });
  await expect(page.getByText('Macro-enabled presentations are not accepted.')).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // After a failed import, a good deck imports straight away (nothing to replace).
  const path = await import('node:path');
  const deck = path.resolve(process.cwd(), 'fixtures', 'sample', 'air-traffic-control.pptx');
  await page.locator('input[type=file]').first().setInputFiles(deck);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByLabel('Import summary')).toBeVisible({ timeout: 60_000 });
});
