import { expect, test } from '@playwright/test';
import { playThrough, previewConfig } from './helpers.ts';

test.describe('bundled sample', () => {
  test('opens from the empty dashboard, is labelled demo content, and plays to completion in the sandboxed preview', async ({ page, request }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
    await page.getByRole('button', { name: 'Try sample project' }).first().click();
    await page.waitForURL(/\/p\/[^/]+\/build/);
    const projectId = page.url().match(/\/p\/([^/]+)/)![1]!;

    // Sample content is labelled everywhere it appears.
    await expect(page.getByText('Bundled sample').first()).toBeVisible();
    await expect(page.getByText('Demo mode — sample content').first()).toBeVisible();

    // The preview is sandboxed: scripts only, never same-origin.
    const iframe = page.locator('iframe.preview-iframe');
    await expect(iframe).toHaveAttribute('sandbox', 'allow-scripts');

    const config = await previewConfig(request, projectId);
    expect(config.scenes.map((s) => s.interaction.type)).toEqual(expect.arrayContaining(['coordinate-navigation', 'drag-match', 'sequence-sort']));
    const frame = page.frameLocator('iframe.preview-iframe');
    await playThrough(frame, config);

    // The studio's diagnostics show the real events reported by the game.
    await page.getByRole('button', { name: /Diagnostics/ }).click();
    await expect(page.locator('.diag-log')).toContainText('attempt 1 — correct');
    expect(errors).toEqual([]);
  });

  test('demo refinement proposes before/after changes that apply and undo as new versions', async ({ page, request, baseURL }) => {
    const res = await request.post('/api/projects/sample', { headers: { 'x-nexus-csrf': '1', origin: baseURL!, 'content-type': 'application/json' }, data: {} });
    const body = (await res.json()) as { project?: { id: string }; id?: string };
    const projectId = body.project?.id ?? body.id!;
    await page.goto(`/p/${projectId}/build`);
    await page.locator('.scene-item-main', { hasText: 'Taxi to Runway Alpha' }).click();

    const composer = page.getByLabel('Describe a change for Claude');
    await composer.fill('Make the grid and points easier to see');
    await composer.press('Enter');
    const proposal = page.locator('.proposal').last();
    await expect(proposal).toContainText('Demo template');
    await expect(proposal.locator('.change-diff')).toContainText('grid emphasis: standard');
    await expect(proposal.locator('.change-diff')).toContainText('grid emphasis: high');

    await proposal.getByRole('button', { name: /^Apply/ }).click();
    await expect(page.locator('.version-chip')).toContainText('v2');
    await proposal.getByRole('button', { name: /Undo/ }).click();
    await expect(page.locator('.version-chip')).toContainText('v3');

    // A request no template covers is answered honestly, with no proposal.
    const before = await page.locator('.proposal').count();
    await composer.fill('Turn this into a racing game with lasers');
    await composer.press('Enter');
    await expect(page.locator('.msg').last()).toContainText('only replay prepared changes');
    expect(await page.locator('.proposal').count()).toBe(before);
  });
});
