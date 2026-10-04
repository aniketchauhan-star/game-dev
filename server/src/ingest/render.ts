import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RendererStatus } from '@shared/schemas/settings.ts';
import type { ServerConfig } from '../config.ts';

/**
 * Optional slide renderer. Converts the uploaded .pptx to PDF with LibreOffice
 * (locally, or inside a network-less container). Capability is verified at
 * startup and reported truthfully; without it the studio shows an
 * “Extracted content view”, never a fake screenshot.
 *
 * The child process gets a minimal environment — never the API key.
 */

const CANDIDATES = [
  '/Applications/LibreOffice.app/Contents/MacOS/soffice',
  '/opt/homebrew/bin/soffice',
  '/usr/local/bin/soffice',
  '/usr/bin/soffice',
  '/usr/bin/libreoffice',
  '/snap/bin/libreoffice',
];

function minimalEnv(home: string): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, LANG: 'en_US.UTF-8', TMPDIR: home };
}

function run(cmd: string, args: string[], timeoutMs: number, env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, env, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) return reject(Object.assign(err, { stderr }));
      resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

function onPath(name: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const p = path.join(dir, name);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      // keep looking
    }
  }
  return null;
}

export function findSoffice(config: ServerConfig): string | null {
  const list = [config.renderer.sofficePath, ...CANDIDATES, onPath('soffice'), onPath('libreoffice')].filter((p): p is string => Boolean(p));
  for (const p of list) {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      // not here
    }
  }
  return null;
}

export async function detectRenderer(config: ServerConfig): Promise<RendererStatus> {
  const checkedAt = new Date().toISOString();
  const mode = config.renderer.mode;
  if (mode === 'off') return { state: 'disabled', mode, detail: 'Slide rendering is turned off (RENDERER=off).', version: null, checkedAt };
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-render-check-'));
  try {
    if (mode === 'docker') {
      const image = config.renderer.dockerImage;
      if (!image) return { state: 'unavailable', mode, detail: 'RENDERER=docker but RENDERER_DOCKER_IMAGE is not set.', version: null, checkedAt };
      try {
        const v = await run('docker', ['version', '--format', '{{.Server.Version}}'], 15_000, minimalEnv(home));
        await run('docker', ['image', 'inspect', image], 15_000, minimalEnv(home));
        return { state: 'available', mode, detail: `Docker ${v.stdout.trim()} with image ${image}.`, version: v.stdout.trim(), checkedAt };
      } catch (err) {
        return { state: 'unavailable', mode, detail: `Docker renderer not usable: ${(err as Error).message.split('\n')[0]}`, version: null, checkedAt };
      }
    }
    const soffice = findSoffice(config);
    if (!soffice) {
      return {
        state: 'unavailable',
        mode,
        detail: 'LibreOffice was not found. Slides are shown as an Extracted content view. Install LibreOffice or set SOFFICE_PATH to enable rendering.',
        version: null,
        checkedAt,
      };
    }
    try {
      const v = await run(soffice, ['--version'], 20_000, minimalEnv(home));
      return { state: 'available', mode, detail: `LibreOffice at ${soffice}`, version: v.stdout.trim().split('\n')[0] ?? null, checkedAt };
    } catch (err) {
      return { state: 'error', mode, detail: `LibreOffice was found at ${soffice} but did not start: ${(err as Error).message.split('\n')[0]}`, version: null, checkedAt };
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

/** Render a deck to PDF (hidden slides included so page N is slide N). Returns the PDF bytes. */
export async function renderDeckToPdf(config: ServerConfig, pptxPath: string, signal?: AbortSignal): Promise<Buffer> {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-render-'));
  try {
    const input = path.join(work, 'deck.pptx');
    fs.copyFileSync(pptxPath, input);
    const filter = 'pdf:impress_pdf_Export:{"ExportHiddenSlides":{"type":"boolean","value":"true"}}';
    if (signal?.aborted) throw new Error('Cancelled');
    if (config.renderer.mode === 'docker') {
      const image = config.renderer.dockerImage;
      if (!image) throw new Error('RENDERER_DOCKER_IMAGE is not set');
      await run(
        'docker',
        ['run', '--rm', '--network', 'none', '--read-only', '--tmpfs', '/tmp', '--memory', '1g', '--cpus', '1', '--pids-limit', '256', '-v', `${work}:/work`, image,
          'soffice', '--headless', '--norestore', '--nolockcheck', '--convert-to', filter, '--outdir', '/work', '/work/deck.pptx'],
        config.renderer.timeoutMs,
        minimalEnv(work),
      );
    } else {
      const soffice = findSoffice(config);
      if (!soffice) throw new Error('LibreOffice is not installed');
      const profile = path.join(work, 'profile');
      await run(
        soffice,
        ['--headless', '--norestore', '--nolockcheck', '--nodefault', '--nofirststartwizard', `-env:UserInstallation=file://${profile}`, '--convert-to', filter, '--outdir', work, input],
        config.renderer.timeoutMs,
        minimalEnv(work),
      );
    }
    const out = path.join(work, 'deck.pdf');
    if (!fs.existsSync(out)) throw new Error('The renderer finished without producing a PDF');
    return fs.readFileSync(out);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
