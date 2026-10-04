import { expect, type APIRequestContext, type FrameLocator, type Page } from '@playwright/test';
import type { GameConfig, GameScene } from '../../shared/src/schemas/game.ts';

export type Surface = Page | FrameLocator;

/** Headers the studio sends on state-changing requests. */
export function csrfHeaders(baseURL: string): Record<string, string> {
  return { 'x-nexus-csrf': '1', origin: baseURL, 'content-type': 'application/json' };
}

export async function createSample(request: APIRequestContext, baseURL: string): Promise<string> {
  const res = await request.post('/api/projects/sample', { headers: csrfHeaders(baseURL), data: {} });
  expect(res.ok(), await res.text()).toBeTruthy();
  const body = (await res.json()) as { project?: { id: string }; id?: string };
  return body.project?.id ?? body.id!;
}

export async function previewConfig(request: APIRequestContext, projectId: string): Promise<GameConfig> {
  const res = await request.get(`/api/projects/${projectId}/preview-bundle`);
  expect(res.ok()).toBeTruthy();
  return ((await res.json()) as { config: GameConfig }).config;
}

/** Solve one scene through the real UI using clicks and keys only (no dragging). */
export async function solveScene(surface: Surface, scene: GameScene): Promise<void> {
  const it = scene.interaction;
  const btn = (name: string) => surface.getByRole('button', { name, exact: true });
  if (it.type === 'info') {
    await btn(it.continueLabel).click();
    return;
  }
  if (it.type === 'coordinate-navigation') {
    const r = it.rule;
    const step = it.grid.step;
    const target =
      r.kind === 'point-equals'
        ? r.target
        : r.kind === 'point-in-set'
          ? r.targets[0]!
          : r.kind === 'in-quadrant'
            ? { x: r.quadrant === 1 || r.quadrant === 4 ? step : -step, y: r.quadrant <= 2 ? step : -step }
            : r.axis === 'x'
              ? { x: it.start.x === 0 ? step : it.start.x, y: 0 }
              : { x: 0, y: it.start.y === 0 ? step : it.start.y };
    let { x, y } = it.start;
    while (x !== target.x) {
      await btn(x < target.x ? 'Move right' : 'Move left').click();
      x += x < target.x ? step : -step;
    }
    while (y !== target.y) {
      await btn(y < target.y ? 'Move up' : 'Move down').click();
      y += y < target.y ? step : -step;
    }
    await btn('Check position').click();
  } else if (it.type === 'drag-match') {
    for (const a of it.rule.accepts) {
      if (a.targetIds.length === 0) continue;
      await surface.locator(`[data-item="${a.itemId}"]`).first().click();
      await surface.locator(`.nx-bay[data-target="${a.targetIds[0]}"] .nx-bay-head`).click();
    }
    await surface.locator('.nx-btn-primary').filter({ hasText: /Check/ }).first().click();
  } else if (it.type === 'sequence-sort') {
    const want =
      it.rule.kind === 'explicit-order'
        ? it.rule.order
        : [...it.items].sort((a, b) => (it.rule.kind === 'order-by-value' && it.rule.direction === 'descending' ? (b.value ?? 0) - (a.value ?? 0) : (a.value ?? 0) - (b.value ?? 0))).map((i) => i.id);
    const back = it.orientation === 'horizontal' ? 'ArrowLeft' : 'ArrowUp';
    for (let target = 0; target < want.length; target++) {
      const order = await surface.locator('.nx-sort-card').evaluateAll((els) => els.map((e) => e.getAttribute('data-item')));
      const at = order.indexOf(want[target]!);
      if (at === target) continue;
      const card = surface.locator(`.nx-sort-card[data-item="${want[target]}"]`);
      await card.click();
      for (let k = at; k > target; k--) await card.press(back);
      await card.press('Enter');
    }
    await surface.locator('.nx-btn-primary').filter({ hasText: /Check/ }).first().click();
  }
  await expect(surface.locator('.nx-feedback')).toContainText(/Correct/i);
  await surface.locator('.nx-btn-next').click();
}

/** Play every scene of a game from its title screen to the completion screen. */
export async function playThrough(surface: Surface, config: GameConfig): Promise<void> {
  await surface.getByRole('button', { name: config.screens.title.startLabel, exact: true }).click();
  for (const scene of config.scenes) await solveScene(surface, scene);
  await expect(surface.getByText(config.screens.completion.heading)).toBeVisible();
}
