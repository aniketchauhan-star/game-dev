import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import yauzl from 'yauzl';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { createSample, csrfHeaders, playThrough, previewConfig } from './helpers.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function unzip(buf: Buffer, dest: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err);
      const names: string[] = [];
      zip.on('entry', (entry: yauzl.Entry) => {
        names.push(entry.fileName);
        if (entry.fileName.endsWith('/')) return zip.readEntry();
        zip.openReadStream(entry, (e, stream) => {
          if (e || !stream) return reject(e);
          const target = path.join(dest, entry.fileName);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          stream.pipe(fs.createWriteStream(target)).on('finish', () => zip.readEntry());
        });
      });
      zip.on('end', () => resolve(names));
      zip.readEntry();
    });
  });
}

const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2', '.md': 'text/plain', '.txt': 'text/plain' };

/** Export the project's current version as a playable ZIP and serve it from /courses/grade-9/<folder>/ on a static server. */
async function serveExport(request: APIRequestContext, baseURL: string, projectId: string, siteName: string) {
  const created = await request.post(`/api/projects/${projectId}/exports`, { headers: csrfHeaders(baseURL), data: { kind: 'playable', includeSourceMaterial: false, nextChanges: '' } });
  expect(created.ok(), await created.text()).toBeTruthy();
  const rec = ((await created.json()) as { export: { id: string } }).export;
  const zip = await request.get(`/api/exports/${rec.id}/download`);
  expect(zip.ok()).toBeTruthy();

  const site = path.join(root, 'tests', '.tmp', siteName);
  fs.rmSync(site, { recursive: true, force: true });
  const names = await unzip(await zip.body(), path.join(site, 'courses', 'grade-9'));
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent((req.url ?? '/').split('?')[0]!);
    const file = path.normalize(path.join(site, url.endsWith('/') ? `${url}index.html` : url));
    if (!file.startsWith(site) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const folder = names[0]!.split('/')[0];
  return { names, prefix: `http://127.0.0.1:${port}/courses/grade-9/`, url: `http://127.0.0.1:${port}/courses/grade-9/${folder}/`, close: () => server.close() };
}

test('the playable export runs from a static server sub-folder with no network access beyond its own files', async ({ page, request, baseURL }) => {
  const projectId = await createSample(request, baseURL!);
  const site = await serveExport(request, baseURL!, projectId, 'e2e-site');
  try {
    expect(site.names.every((n) => !n.startsWith('/') && !n.includes('..'))).toBe(true);
    expect(site.names.some((n) => n.endsWith('/index.html'))).toBe(true);
    // Never in a playable export: deck, notes, env files.
    expect(site.names.some((n) => /\.pptx$|\.env|source-material/.test(n))).toBe(false);

    const outside: string[] = [];
    page.on('request', (r) => {
      if (!r.url().startsWith(site.prefix)) outside.push(r.url());
    });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(site.url);
    await playThrough(page, await previewConfig(request, projectId));
    expect(outside).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    site.close();
  }
});

test('exported game: audio starts only after the learner presses Start, mute toggles, and reduced motion is honoured', async ({ page, request, baseURL }) => {
  const projectId = await createSample(request, baseURL!);
  const site = await serveExport(request, baseURL!, projectId, 'e2e-site-audio');
  try {
    // Count AudioContext constructions made by the game.
    await page.addInitScript(() => {
      const w = window as unknown as { __audioContexts: number; AudioContext: typeof AudioContext };
      w.__audioContexts = 0;
      const Original = w.AudioContext;
      w.AudioContext = class extends Original {
        constructor(...args: ConstructorParameters<typeof AudioContext>) {
          super(...args);
          w.__audioContexts += 1;
        }
      };
    });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(site.url);
    await expect(page.getByRole('button', { name: 'Start' })).toBeVisible();
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => (window as unknown as { __audioContexts: number }).__audioContexts)).toBe(0);
    await expect(page.locator('.nx-root')).toHaveClass(/nx-reduced-motion/);

    await page.getByRole('button', { name: 'Start' }).click();
    expect(await page.evaluate(() => (window as unknown as { __audioContexts: number }).__audioContexts)).toBe(1);

    await page.getByRole('button', { name: 'Mute sound' }).click();
    await expect(page.getByRole('button', { name: 'Unmute sound' })).toBeVisible();
    await page.getByRole('button', { name: 'Unmute sound' }).click();
    await expect(page.getByRole('button', { name: 'Mute sound' })).toBeVisible();

    // Progressive hints: each press shows the next hint, labelled as a hint (text, not colour alone).
    const config = await previewConfig(request, projectId);
    const coordinate = config.scenes.find((s) => s.interaction.type === 'coordinate-navigation')!;
    await page.locator('.nx-btn-primary').first().click(); // leave the opening concept card
    await expect(page.locator('.nx-scene-title')).toContainText(coordinate.title);
    for (const expected of coordinate.feedback.hints.slice(0, 2)) {
      await page.getByRole('button', { name: 'Hint', exact: true }).click();
      await expect(page.locator('.nx-feedback')).toContainText('Hint');
      await expect(page.locator('.nx-feedback')).toContainText(expected.slice(0, 20));
    }
    // A wrong answer gets helpful, specific feedback rather than a bare "wrong".
    await page.getByRole('button', { name: 'Move right' }).click();
    await page.getByRole('button', { name: 'Check position' }).click();
    await expect(page.locator('.nx-feedback')).toContainText('Not yet');
  } finally {
    site.close();
  }
});
