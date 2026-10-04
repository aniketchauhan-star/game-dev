import './env.ts';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { openDb } from '../../../server/src/db/db.ts';
import { MIGRATIONS } from '../../../server/src/db/migrations.ts';
import { REPO_ROOT, tempDir } from './helpers.ts';

/**
 * Regression test for the "database is locked" race: the API server and the
 * worker are separate processes that usually open a brand-new database at the
 * same moment. Each child waits on a file barrier so both call openDb() together.
 */
const CHILD_SOURCE = `
import fs from 'node:fs';
import path from 'node:path';

const [dbModuleUrl, dataDir, barrierDir, id, total] = process.argv.slice(2);
const { openDb } = await import(dbModuleUrl);
fs.writeFileSync(path.join(barrierDir, 'ready-' + id), String(process.pid));
const pause = new Int32Array(new SharedArrayBuffer(4));
const deadline = Date.now() + 30000;
while (fs.readdirSync(barrierDir).filter((n) => n.startsWith('ready-')).length < Number(total)) {
  if (Date.now() > deadline) {
    process.stdout.write(JSON.stringify({ id, ok: false, error: 'barrier timeout' }));
    process.exit(3);
  }
  Atomics.wait(pause, 0, 0, 1);
}
const startedAt = Date.now();
try {
  const db = openDb(dataDir);
  const versions = db.all('SELECT version FROM schema_migrations ORDER BY version').map((r) => r.version);
  const journal = db.get('PRAGMA journal_mode').journal_mode;
  db.close();
  process.stdout.write(JSON.stringify({ id, ok: true, startedAt, finishedAt: Date.now(), versions, journal }));
} catch (err) {
  process.stdout.write(JSON.stringify({ id, ok: false, startedAt, error: String((err && err.message) || err) }));
  process.exit(2);
}
`;

interface ChildResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runChild(script: string, args: string[]): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', script, ...args], { cwd: REPO_ROOT, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('two processes opening the same new database at the same moment', () => {
  const dirs: string[] = [];
  const scriptDir = tempDir('nexus-it-race-script-');
  dirs.push(scriptDir);
  const script = path.join(scriptDir, 'open-db.mts');
  fs.writeFileSync(script, CHILD_SOURCE);
  const dbModuleUrl = pathToFileURL(path.join(REPO_ROOT, 'server', 'src', 'db', 'db.ts')).href;

  afterAll(() => {
    if (!process.env.NEXUS_IT_KEEP) for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });

  const ROUNDS = 8;
  it(`both succeed and every migration is applied exactly once (${ROUNDS} rounds)`, async () => {
    const expectedVersions = MIGRATIONS.map((m) => m.version);
    for (let round = 1; round <= ROUNDS; round++) {
      const dataDir = tempDir('nexus-it-');
      const barrierDir = tempDir('nexus-it-barrier-');
      dirs.push(dataDir, barrierDir);
      expect(fs.existsSync(path.join(dataDir, 'nexus.sqlite'))).toBe(false);

      const results = await Promise.all(['api', 'worker'].map((id) => runChild(script, [dbModuleUrl, dataDir, barrierDir, id, '2'])));
      const parsed = results.map((r, i) => {
        expect(r.code, `round ${round} child ${i}: exit ${r.code}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`).toBe(0);
        return JSON.parse(r.stdout) as { id: string; ok: boolean; startedAt: number; versions: number[]; journal: string; error?: string };
      });
      for (const p of parsed) {
        expect(p, `round ${round}`).toMatchObject({ ok: true, versions: expectedVersions, journal: 'wal' });
      }
      // The barrier really released both together (otherwise the race was not exercised).
      expect(Math.abs(parsed[0]!.startedAt - parsed[1]!.startedAt), `round ${round} start skew`).toBeLessThan(1_000);

      const db = openDb(dataDir);
      try {
        const counts = db.all<{ version: number; c: number }>('SELECT version, COUNT(*) AS c FROM schema_migrations GROUP BY version ORDER BY version');
        expect(counts).toEqual(expectedVersions.map((version) => ({ version, c: 1 })));
        const objects = db.all<{ type: string; name: string }>("SELECT type, name FROM sqlite_master WHERE type IN ('table', 'trigger') AND name NOT LIKE 'sqlite_%'");
        const names = objects.map((o) => o.name);
        expect(new Set(names).size).toBe(names.length);
        for (const required of ['projects', 'jobs', 'job_events', 'blueprint_revisions', 'game_versions', 'schema_migrations', 'blueprint_approved_content_immutable', 'game_versions_immutable']) {
          expect(names, required).toContain(required);
        }
        expect(db.get<{ journal_mode: string }>('PRAGMA journal_mode')?.journal_mode).toBe('wal');
      } finally {
        db.close();
      }
    }
  }, 180_000);
});
