import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yauzl from 'yauzl';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { GameConfig } from '../../shared/src/schemas/game.ts';
import { playThrough, previewConfig } from './helpers.ts';

/**
 * Grade 8 trapezium matching game, end to end through the studio UI:
 * real uploads (the sample PPTX, Swiftee's frames, background, blank panel and
 * button art marked as made with ChatGPT), the sample design from a LOCAL MOCK
 * of the Figma REST API (never live Figma), the Source-to-Screen map, grade
 * suggestions, four creator animations, playtest, and a static offline export.
 * No Claude key: AI steps replay prepared demo answers for this bundled sample.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TRAP = path.join(root, 'fixtures', 'trapezium');
const ART = path.join(TRAP, 'art');
const SWIFTEE_FRAMES = Array.from({ length: 10 }, (_, i) => path.join(ART, `swiftee-${String(i + 1).padStart(2, '0')}.png`));
const FIGMA_LINK = 'https://www.figma.com/design/TrapQuestDemo8x2026/Trapezium-Quest';
const LESSON_DEFINITION = 'A trapezium is a quadrilateral with at least one pair of parallel sides.';

let projectId = '';
let builtConfig: GameConfig | null = null;

const card = (page: Page, title: string) => page.locator('.setup-card').filter({ hasText: title });
const uploader = (page: Page, label: string) => page.locator('.asset-uploader').filter({ has: page.getByRole('button', { name: label, exact: true }) });

async function config(request: APIRequestContext): Promise<GameConfig> {
  return previewConfig(request, projectId);
}

async function openSetup(page: Page, title: string): Promise<void> {
  const c = card(page, title);
  if ((await c.getByRole('button', { name: 'Close' }).count()) === 0) await c.getByRole('button', { name: 'Edit' }).click();
}

/** Animate: pick a screen (and optionally an object), add one preset and apply it. */
async function addAnimation(page: Page, screen: string, object: string | null, preset: string): Promise<void> {
  await page.locator('.screen-row', { hasText: screen }).click();
  await expect(page.locator('.chip-scope').first()).toHaveText(screen);
  if (object) {
    await page.locator('.entity-chip', { hasText: object }).first().click();
    await expect(page.locator('.context-chips')).toContainText(`Object: ${object}`);
  }
  await page.locator('.preset-group').getByRole('button', { name: preset, exact: true }).click();
  const bar = page.locator('.draft-bar');
  await expect(bar).toContainText('1 unsaved change');
  await expect(bar).toContainText(`Scope: ${screen}`);
  await bar.getByRole('button', { name: 'Apply' }).click();
  await expect(bar).toContainText('Last change applied.');
}

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

const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2', '.wav': 'audio/wav', '.txt': 'text/plain' };

test.describe.configure({ mode: 'serial' });

test.describe('Grade 8 trapezium: upload → screens → animation → export', () => {
  test.setTimeout(180_000);

  test('adds the lesson, the (mock) Figma design, artwork and the grade through the setup cards', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await page.goto('/');
    await page.getByRole('button', { name: 'Grade 8 design sample' }).first().click();
    await page.waitForURL(/\/p\/[^/]+\/prepare/);
    projectId = page.url().match(/\/p\/([^/]+)/)![1]!;
    await expect(page.getByRole('heading', { name: /Prepare my game/ })).toBeVisible();
    // Nothing is invented: every card starts empty, and the grade is requested.
    await expect(card(page, 'PPT lesson / storyboard')).toContainText('Not added');
    await expect(card(page, 'Grade & learning profile')).toContainText('Needed');

    // PowerPoint lesson through the existing .pptx pipeline.
    await openSetup(page, 'PPT lesson / storyboard');
    await page.locator('#setup-lesson input[type="file"][accept^=".pptx"]').setInputFiles(path.join(TRAP, 'trapezium-lesson.pptx'));
    await expect(card(page, 'PPT lesson / storyboard')).toContainText('7 slides imported', { timeout: 60_000 });

    // Figma design: paste a link, choose frames, import (read-only).
    await openSetup(page, 'Figma design');
    await page.locator('#figma-link').fill(FIGMA_LINK);
    await page.getByRole('button', { name: 'Find frames' }).click();
    const grid = page.getByRole('list', { name: 'Frames in the Figma file' });
    await expect(grid.getByRole('button')).toHaveCount(6, { timeout: 60_000 });
    for (const name of ['01 Intro', '02 Spot the parallel sides', '02b Spot the parallel sides — hint state', '03 Match the shapes', '04 Well done']) {
      await grid.getByRole('button', { name }).click();
    }
    await page.getByRole('button', { name: 'Import 5 frames' }).click();
    await expect(card(page, 'Figma design')).toContainText('5 screens ready to map', { timeout: 60_000 });
    await expect(card(page, 'Figma design')).toContainText('5 from Figma');

    // Artwork: background and Swiftee's frames made with ChatGPT, blank panel and button art.
    await openSetup(page, 'Game assets');
    await uploader(page, 'Add backgrounds').locator('select').selectOption('chatgpt');
    await uploader(page, 'Add backgrounds').locator('input[type="file"]').setInputFiles(path.join(ART, 'ice-background.png'));
    await uploader(page, 'Add characters or sprite frames').locator('select').selectOption('chatgpt');
    await uploader(page, 'Add characters or sprite frames').locator('input[type="file"]').setInputFiles(SWIFTEE_FRAMES);
    await uploader(page, 'Add panels and buttons').locator('input[type="file"]').setInputFiles([path.join(ART, 'panel-blank.png'), path.join(ART, 'button-primary.png')]);
    // Files identical to ones already in the library are reported, not silently merged:
    // the background and Swiftee's first frame were also image fills in the Figma file; frames 4 and 6 are the same picture.
    await expect(uploader(page, 'Add backgrounds')).toContainText('ice-background.png is the same picture as', { timeout: 30_000 });
    await expect(uploader(page, 'Add backgrounds')).toContainText('it now has your name, role and origin note');
    await expect(uploader(page, 'Add characters or sprite frames')).toContainText('swiftee-06.png is the same picture as “swiftee-04”', { timeout: 30_000 });
    await expect(card(page, 'Game assets')).toContainText('10 made with an AI tool', { timeout: 30_000 });

    // Grade 8, from the product preset (labelled as such).
    await openSetup(page, 'Grade & learning profile');
    await page.getByRole('radiogroup', { name: 'Grade' }).getByRole('radio', { name: '8', exact: true }).click();
    await expect(page.getByText('Grades 6–8 preset')).toBeVisible();
    await page.getByRole('button', { name: 'Save grade profile' }).click();
    await expect(card(page, 'Grade & learning profile')).toContainText('Grade 8');
    expect(errors).toEqual([]);
  });

  test('combines Swiftee’s frames into a sprite with named clips in Assets', async ({ page, request }) => {
    await page.goto(`/p/${projectId}/assets`);
    await page.getByRole('button', { name: /^Characters/ }).click();
    await page.getByRole('button', { name: 'Combine frames' }).click();
    // Frame 6 is the same picture as frame 4, so swiftee-04 is used twice.
    for (const n of ['01', '02', '03', '04', '05', '04', '07', '08', '09', '10']) await page.getByRole('button', { name: new RegExp(`^Add swiftee-${n} as frame`) }).click();
    await expect(page.getByRole('list', { name: 'Frames in order' }).getByRole('listitem')).toHaveCount(10);
    await page.getByLabel('Sprite sheet name').fill('Swiftee');
    await page.getByRole('button', { name: 'Combine 10 frames' }).click();
    const detail = page.getByLabel('Details for Swiftee');
    await expect(detail).toBeVisible();
    await detail.locator('#asset-alt').fill('Swiftee, the expedition’s arctic bird guide');
    await detail.locator('#asset-alt').blur();
    await detail.getByText('Sprite sheet', { exact: true }).click();
    const clip = (i: number) => detail.locator('.clip-row').nth(i);
    await detail.getByRole('button', { name: 'Add clip' }).click();
    await clip(0).getByLabel('To').fill('1');
    await detail.getByRole('button', { name: 'Add clip' }).click();
    await clip(1).getByLabel('From').fill('2');
    await clip(1).getByLabel('To').fill('5');
    await detail.getByRole('button', { name: 'Add clip' }).click();
    await clip(2).getByLabel('From').fill('6');
    await clip(2).getByLabel('To').fill('9');
    await detail.getByRole('button', { name: 'Save clips' }).click();
    await expect(detail.getByRole('button', { name: 'Save clips' })).toBeDisabled();
    await detail.getByRole('button', { name: 'Preview wave' }).click();
    await expect(detail.getByText('Previewing “wave” (frames 2–5, plays once).')).toBeVisible();

    const assets = (await (await request.get(`/api/projects/${projectId}/assets`)).json()) as { assets: Array<{ name: string; role: string; metadata: { sprite: { frameCount: number; clips: Array<{ name: string; from: number; to: number; loop: boolean }> } | null; provenance: { kind: string; tool: string; figma: object | null } | null } }> };
    const swiftee = assets.assets.find((a) => a.name === 'Swiftee')!;
    expect(swiftee.role).toBe('character');
    expect(swiftee.metadata.sprite?.frameCount).toBe(10);
    expect(swiftee.metadata.sprite?.clips.map((c) => [c.name, c.from, c.to, c.loop])).toEqual([
      ['idle', 0, 1, true],
      ['wave', 2, 5, false],
      ['celebrate', 6, 9, false],
    ]);
    // Frames uploaded as ChatGPT artwork keep that origin (the two that also came from Figma keep both).
    expect(assets.assets.filter((a) => a.metadata.provenance?.tool === 'ChatGPT').length).toBe(10);
    expect(assets.assets.filter((a) => a.metadata.provenance?.kind === 'ai-tool' && a.metadata.provenance.figma !== null).map((a) => a.name).sort()).toEqual(['ice-background', 'swiftee-01']);
  });

  test('prepares staged proposals, maps the screens, keeps the lesson definition, and builds', async ({ page, request }) => {
    await page.goto(`/p/${projectId}/prepare`);
    await page.getByRole('button', { name: 'Prepare my game' }).click();
    await expect(page.locator('.stage-result')).toHaveCount(5, { timeout: 90_000 });
    // Grade suggestions approved; the staged motion plan is declined (motion is added by hand below).
    const gradePlan = page.getByRole('region', { name: /^Grade adaptation plan \d+$/ });
    await gradePlan.getByRole('button', { name: 'Accept all changes' }).click();
    await expect(gradePlan.getByRole('group', { name: /^Decision for/ }).first().getByRole('button', { name: 'Accept' })).toHaveAttribute('aria-pressed', 'true');
    const motionPlan = page.getByRole('region', { name: /^Motion plan \d+$/ });
    await motionPlan.getByRole('button', { name: 'Reject plan' }).click();
    await expect(motionPlan).toHaveCount(0);

    // Screens: intro, guided identification, matching and completion are linked to the design by evidence.
    await page.goto(`/p/${projectId}/screens`);
    const rows = page.getByRole('list', { name: 'Game screens' });
    await expect(rows.locator('.screen-row')).toHaveCount(5);
    const select = async (title: string) => {
      await rows.locator('.screen-row', { hasText: title }).click();
      await expect(page.locator('.screen-editor h2')).toHaveText(title);
    };
    const editor = page.locator('.screen-editor');
    const expectations: Array<[string, string[]]> = [
      ['Title', ['01 Intro']],
      ['What is a trapezium?', []],
      ['Spot the parallel sides', ['02 Spot the parallel sides', '02b Spot the parallel sides — hint state']],
      ['Match the shapes', ['03 Match the shapes']],
      ['Completion', ['04 Well done']],
    ];
    for (const [title, frames] of expectations) {
      await select(title);
      await expect(editor.locator('.frame-links li')).toHaveCount(frames.length);
      for (const f of frames) await expect(editor.locator('.frame-links')).toContainText(f);
      // Exact uploaded artwork: the background, the Swiftee sprite (idle), the blank panel and the button art.
      await expect(editor.locator(`select[id^="bg-"] option:checked`)).toHaveText('ice-background');
      await expect(editor.locator(`select[id^="char-"] option:checked`)).toHaveText(/^Swiftee \(sprite: idle, wave, celebrate\)/);
      if (title !== 'Title' && title !== 'Completion') {
        await expect(editor.locator(`select[id^="panel-"] option:checked`)).toHaveText('panel-blank');
        await expect(editor.locator(`select[id^="button-"] option:checked`)).toHaveText('button-primary');
      }
      if (title === 'Spot the parallel sides') {
        // The design says “exactly one pair”; the lesson says “at least one”. Flagged, never silently resolved.
        const conflict = editor.locator('.conflict');
        await expect(conflict).toHaveCount(1);
        await expect(conflict).toContainText('definition');
        await expect(conflict).toContainText('exactly one pair');
        await expect(conflict).toContainText('at least one pair');
        await conflict.getByRole('button', { name: 'Use the PowerPoint wording' }).click();
        await expect(conflict).toContainText('PowerPoint wording kept');
      }
      await editor.getByLabel('Reviewed', { exact: true }).check();
    }
    await expect(page.getByText('5/5 reviewed')).toBeVisible();
    await page.getByRole('button', { name: 'Save map revision' }).click();
    await expect(page.getByText('Saved map revision 2').first()).toBeVisible();

    // Approve & build.
    await page.goto(`/p/${projectId}/prepare`);
    await page.getByRole('button', { name: 'Approve & build' }).click();
    await expect(page.getByText('The new version includes your accepted grade changes and animations.')).toBeVisible({ timeout: 90_000 });

    builtConfig = await config(request);
    expect(builtConfig.meta.gradeLabel).toBe('Grade 8');
    expect(builtConfig.meta.screenMapNumber).toBe(2);
    expect(builtConfig.motion.bindings).toEqual([]);
    const intro = builtConfig.scenes.find((s) => s.id === 'scn_trap_intro')!;
    expect(intro.interaction.type === 'info' && intro.interaction.points[0]).toBe(LESSON_DEFINITION);
    expect(JSON.stringify(builtConfig)).not.toContain('exactly one pair');
    const identify = builtConfig.scenes.find((s) => s.id === 'scn_trap_identify')!;
    expect(identify.design?.source).toBe('figma');
    expect(identify.assets.characterClip).toBe('idle');
    // The approved grade suggestion is in: a precise question naming the rule.
    expect(identify.instruction).toBe('Sort each shape: does it have at least one pair of parallel sides?');
  });

  test('adds an entrance, an instructional highlight, valid-drop feedback and one celebration in Animate', async ({ page, request }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`/p/${projectId}/animate`);
    await expect(page.locator('iframe.preview-iframe')).toHaveAttribute('sandbox', 'allow-scripts');

    await addAnimation(page, 'Screen 2 · What is a trapezium?', null, 'Fade');
    await addAnimation(page, 'Screen 3 · Spot the parallel sides', 'Instruction panel', 'Outline highlight');
    await addAnimation(page, 'Screen 4 · Match the shapes', 'Target Trapezium', 'Valid-drop snap');
    await addAnimation(page, 'Screen 5 · Completion', 'Swiftee', 'Celebration clip');

    // Readable rules in the inspector.
    await page.locator('.screen-row', { hasText: 'Screen 5 · Completion' }).click();
    await expect(page.locator('.binding-list')).toContainText('When Screen 5 · Completion opens → play the “celebrate” clip on Swiftee once.');
    await page.locator('.screen-row', { hasText: 'Screen 4 · Match the shapes' }).click();
    await expect(page.locator('.binding-list')).toContainText('When an object lands on Target Trapezium on Screen 4 · Match the shapes → snap Target Trapezium into place.');

    // Only the intended changes: four animations; screens, wording, answers and assets untouched.
    const after = await config(request);
    expect(after.motion.bindings.map((b) => [b.screenId, b.target, b.presetId, b.trigger.event, b.trigger.entity, b.origin])).toEqual([
      ['scn_trap_intro', 'screen', 'scene-fade', 'scene-entered', null, 'creator'],
      ['scn_trap_identify', 'instruction', 'outline-highlight', 'scene-entered', null, 'creator'],
      ['scn_trap_match', 'target:t-trapezium', 'drop-snap', 'valid-drop', 'target:t-trapezium', 'creator'],
      ['completion', 'character', 'celebration-clip', 'scene-entered', null, 'creator'],
    ]);
    expect(after.scenes).toEqual(builtConfig!.scenes);
    expect(after.screens).toEqual(builtConfig!.screens);
    expect(after.assets).toEqual(builtConfig!.assets);

    // Preview controls: repeated events, stop, pause/resume and restart never touch game state.
    await page.locator('.screen-row', { hasText: 'Screen 4 · Match the shapes' }).click();
    await page.locator('.entity-chip', { hasText: 'Target Trapezium' }).click();
    await page.getByLabel('Event to simulate').selectOption('valid-drop');
    await page.getByRole('button', { name: 'Fire' }).click();
    await page.getByRole('button', { name: 'Fire' }).click();
    const activity = page.locator('.motion-log');
    await activity.locator('summary').click();
    await expect.poll(async () => (await activity.locator('li', { hasText: 'started' }).filter({ hasText: 'Target Trapezium' }).count())).toBeGreaterThanOrEqual(2);
    await page.getByRole('button', { name: 'Stop motion' }).click();
    await page.getByRole('button', { name: 'Pause' }).click();
    await expect(page.getByRole('button', { name: 'Resume' })).toBeVisible();
    await page.getByRole('button', { name: 'Resume' }).click();
    await page.getByRole('button', { name: 'Restart screen' }).click();
    expect((await config(request)).motion.bindings).toHaveLength(4);

    // Undo survives a reload: add a throwaway cue, undo it, reload — still the four animations.
    await addAnimationKeepingDraft(page);
    await page.locator('.draft-bar').getByRole('button', { name: 'Undo' }).click();
    await expect(page.getByText('Undone').first()).toBeVisible();
    await page.reload();
    await expect(page.locator('.screen-row', { hasText: 'Screen 3 · Spot the parallel sides' })).toContainText('1 animation');
    expect((await config(request)).motion.bindings).toHaveLength(4);
    expect(errors).toEqual([]);
  });

  test('reports unsupported motion requests honestly instead of faking them', async ({ page }) => {
    await page.goto(`/p/${projectId}/animate`);
    await page.locator('.screen-row', { hasText: 'Screen 4 · Match the shapes' }).click();
    await page.getByRole('tab', { name: 'Ask Claude' }).click();
    await page.locator('#motion-request').fill('Make Swiftee talk, shake the screen and add full-screen confetti');
    await page.getByRole('button', { name: 'Ask', exact: true }).click();
    const plan = page.getByRole('region', { name: /^Motion plan \d+$/ }).first();
    await expect(plan).toContainText('Make the character talk', { timeout: 60_000 });
    await expect(plan).toContainText('Shake or flash');
    await expect(plan).toContainText('Full-screen confetti');
    await expect(plan.getByRole('button', { name: 'Apply accepted rows' })).toBeDisabled();
  });

  test('plays through in the studio with and without reduced motion', async ({ page, request }) => {
    const cfg = await config(request);
    await page.goto(`/p/${projectId}/build`);
    await playThrough(page.frameLocator('iframe.preview-iframe'), cfg);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.reload();
    await playThrough(page.frameLocator('iframe.preview-iframe'), cfg);
  });

  test('exports a playable game that runs statically and offline, matching the preview', async ({ page, request }) => {
    const cfg = await config(request);
    await page.goto(`/p/${projectId}/export`);
    await page.locator('.export-card', { hasText: 'Playable game' }).click();
    const exportButton = page.getByRole('button', { name: /^Export Playable game/ });
    await expect(exportButton).toBeEnabled({ timeout: 30_000 });
    await expect(page.getByText('Animations validated')).toBeVisible();
    const [download] = await Promise.all([page.waitForEvent('download'), exportButton.click()]);
    const zipPath = await download.path();
    const site = path.join(root, 'tests', '.tmp', 'e2e-trapezium-site');
    fs.rmSync(site, { recursive: true, force: true });
    const names = await unzip(fs.readFileSync(zipPath!), site);
    const folder = names[0]!.split('/')[0]!;
    // Only what the game uses: no deck, no design references, no Figma data, no secrets.
    expect(names.some((n) => /\.pptx$|\.env|source-material|design-map|figma/i.test(n))).toBe(false);
    const js = fs.readFileSync(path.join(site, folder, 'game.config.js'), 'utf8');
    const exported = JSON.parse(js.slice(js.indexOf('=') + 1).trim().replace(/;$/, '')) as GameConfig;
    expect(exported.motion).toEqual(cfg.motion);
    expect(exported.scenes).toEqual(cfg.scenes);
    expect(js).not.toContain('figd_');

    const server = http.createServer((req, res) => {
      const url = decodeURIComponent((req.url ?? '/').split('?')[0]!);
      const file = path.normalize(path.join(site, url.endsWith('/') ? `${url}index.html` : url));
      if (!file.startsWith(site) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return void res.writeHead(404).end();
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const outside: string[] = [];
      page.on('request', (r) => {
        if (!r.url().startsWith(origin)) outside.push(r.url());
      });
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(`${origin}/${folder}/`);
      await playThrough(page, cfg);
      expect(outside).toEqual([]);
      expect(errors).toEqual([]);
    } finally {
      server.close();
    }
  });

  test('creates a Grade 6 version that changes independently of the Grade 8 version', async ({ page, request }) => {
    const g8 = await config(request);
    await page.goto(`/p/${projectId}/prepare`);
    await page.getByRole('button', { name: 'Create another grade version' }).click();
    await page.getByRole('radiogroup', { name: 'Grade for the new version' }).getByRole('radio', { name: '6', exact: true }).click();
    await page.getByRole('button', { name: 'Create Grade 6 version' }).click();
    await expect(page.getByText('Created “Grade 6 version”').first()).toBeVisible();
    const g6 = await config(request);
    expect(g6.meta.branchId).not.toBe(g8.meta.branchId);
    expect(g6.motion).toEqual(g8.motion);

    // Change pacing in the Grade 6 version only.
    await page.goto(`/p/${projectId}/animate`);
    await page.getByRole('tab', { name: 'Effects' }).click();
    await page.getByRole('group', { name: 'Pacing' }).getByRole('button', { name: g6.motion.pacing === 'calm' ? 'Standard' : 'Calm' }).click();
    await page.locator('.draft-bar').getByRole('button', { name: 'Apply' }).click();
    await expect(page.locator('.draft-bar')).toContainText('Last change applied.');
    expect((await config(request)).motion.pacing).not.toBe(g8.motion.pacing);

    // Back to the Grade 8 version: untouched.
    const project = (await (await request.get(`/api/projects/${projectId}`)).json()) as { project: { branches: Array<{ id: string; name: string }> } };
    const main = project.project.branches.find((b) => b.id === g8.meta.branchId)!;
    const res = await request.post(`/api/projects/${projectId}/branches/${main.id}/activate`, { headers: { 'x-nexus-csrf': '1', origin: new URL(page.url()).origin, 'content-type': 'application/json' }, data: {} });
    expect(res.ok(), await res.text()).toBeTruthy();
    const again = await config(request);
    expect(again.motion).toEqual(g8.motion);
    expect(again.scenes).toEqual(g8.scenes);
  });
});

/** Adds a gentle attention cue on Screen 3 and applies it (used to prove Undo). */
async function addAnimationKeepingDraft(page: Page): Promise<void> {
  await page.locator('.screen-row', { hasText: 'Screen 3 · Spot the parallel sides' }).click();
  await page.locator('.entity-chip', { hasText: 'Instruction panel' }).click();
  await page.locator('.preset-group').getByRole('button', { name: 'Gentle attention cue', exact: true }).click();
  await page.locator('.draft-bar').getByRole('button', { name: 'Apply' }).click();
  await expect(page.locator('.draft-bar')).toContainText('Last change applied.');
  await expect(page.locator('.screen-row', { hasText: 'Screen 3 · Spot the parallel sides' })).toContainText('2 animations');
}
