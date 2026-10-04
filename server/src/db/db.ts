import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { MIGRATIONS } from './migrations.ts';

export type Params = Record<string, SQLInputValue> | SQLInputValue[];

/**
 * Thin wrapper over node:sqlite. WAL mode lets the API server and the worker
 * process share the database; busy_timeout absorbs short write contention.
 */
export class Db {
  readonly raw: DatabaseSync;
  private depth = 0;

  constructor(file: string) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.raw = new DatabaseSync(file);
    // busy_timeout first: the API and the worker usually open the file at the same moment.
    this.raw.exec('PRAGMA busy_timeout = 8000;');
    // Switching a fresh file to WAL needs an exclusive lock and can report SQLITE_BUSY
    // without consulting the busy handler, so retry it briefly.
    for (let attempt = 0; ; attempt++) {
      try {
        this.raw.exec('PRAGMA journal_mode = WAL;');
        break;
      } catch (err) {
        if (attempt >= 40 || !/locked|busy/i.test((err as Error).message)) throw err;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      }
    }
    this.raw.exec('PRAGMA foreign_keys = ON;');
    this.raw.exec('PRAGMA synchronous = NORMAL;');
  }

  migrate(): void {
    this.raw.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`);
    for (const m of MIGRATIONS) {
      // Re-check inside the write lock so two processes starting together never apply a migration twice.
      this.tx(() => {
        if (this.get('SELECT 1 FROM schema_migrations WHERE version = ?', [m.version])) return;
        this.raw.exec(m.sql);
        this.run('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)', [m.version, m.name, new Date().toISOString()]);
      });
    }
  }

  all<T>(sql: string, params: Params = []): T[] {
    const stmt = this.raw.prepare(sql);
    return (Array.isArray(params) ? stmt.all(...params) : stmt.all(params)) as T[];
  }

  get<T>(sql: string, params: Params = []): T | undefined {
    const stmt = this.raw.prepare(sql);
    return (Array.isArray(params) ? stmt.get(...params) : stmt.get(params)) as T | undefined;
  }

  run(sql: string, params: Params = []): { changes: number; lastInsertRowid: number } {
    const stmt = this.raw.prepare(sql);
    const r = Array.isArray(params) ? stmt.run(...params) : stmt.run(params);
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  /** Run `fn` in a write transaction (BEGIN IMMEDIATE). Nested calls join the outer transaction. */
  tx<T>(fn: () => T): T {
    if (this.depth > 0) {
      this.depth++;
      try {
        return fn();
      } finally {
        this.depth--;
      }
    }
    this.raw.exec('BEGIN IMMEDIATE');
    this.depth = 1;
    try {
      const out = fn();
      this.raw.exec('COMMIT');
      return out;
    } catch (err) {
      try {
        this.raw.exec('ROLLBACK');
      } catch {
        // ignore — the original error is more useful
      }
      throw err;
    } finally {
      this.depth = 0;
    }
  }

  close(): void {
    this.raw.close();
  }
}

export function openDb(dataDir: string): Db {
  const db = new Db(path.join(dataDir, 'nexus.sqlite'));
  db.migrate();
  return db;
}

export const nowIso = () => new Date().toISOString();

export function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (text === null || text === undefined || text === '') return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}
