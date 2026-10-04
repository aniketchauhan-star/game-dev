import type { RendererStatus } from '@shared/schemas/settings.ts';
import { ClaudeGateway } from './claude/gateway.ts';
import { loadConfig, type ServerConfig } from './config.ts';
import { openDb, type Db } from './db/db.ts';
import { getSetting, setSetting } from './db/misc.ts';
import { detectRenderer } from './ingest/render.ts';
import { Storage } from './storage.ts';

/** Everything a route, job handler or service needs. Created once per process. */
export interface App {
  config: ServerConfig;
  db: Db;
  storage: Storage;
  gateway: ClaudeGateway;
  renderer(): RendererStatus;
  refreshRenderer(): Promise<RendererStatus>;
}

export function createApp(overrides: Partial<ServerConfig> = {}): App {
  const config = loadConfig(overrides);
  const storage = new Storage(config.dataDir);
  const db = openDb(config.dataDir);
  const gateway = new ClaudeGateway(db, config);
  const fallback: RendererStatus = {
    state: 'unavailable',
    mode: config.renderer.mode,
    detail: 'Renderer capability has not been checked yet.',
    version: null,
    checkedAt: new Date(0).toISOString(),
  };
  return {
    config,
    db,
    storage,
    gateway,
    renderer: () => getSetting<RendererStatus>(db, 'renderer.status', fallback),
    refreshRenderer: async () => {
      const status = await detectRenderer(config);
      setSetting(db, 'renderer.status', status);
      return status;
    },
  };
}
