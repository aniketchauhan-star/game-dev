import { createApp } from './app.ts';
import { buildServer } from './http/server.ts';
import { getApiKey } from './secrets.ts';

/** API server entry point. Binds to loopback; see README “Hosting boundaries”. */
const app = createApp();
const removed = app.storage.cleanupTmp();
const server = await buildServer(app, { logger: false });
await server.listen({ host: app.config.host, port: app.config.port });

const claude = app.gateway.status();
console.log(`NEXUS Play Studio API  http://${app.config.host}:${app.config.port}`);
console.log(`  data:     ${app.config.dataDir}${removed ? ` (cleaned ${removed} stale temp file(s))` : ''}`);
console.log(`  claude:   ${getApiKey() ? `key present · model ${claude.model ?? '(not selected)'} · ${claude.state}` : 'not configured (demo mode for the bundled sample only)'}`);

// Check the optional slide renderer in the background and record the true status.
void app.refreshRenderer().then((r) => console.log(`  renderer: ${r.state} — ${r.detail}`));
if (getApiKey() && claude.model && claude.state !== 'configured') {
  void app.gateway.verify({ testRequest: false }).then((s) => console.log(`  claude model check: ${s.state}${s.lastError ? ` — ${s.lastError}` : ''}`));
}

const shutdown = async () => {
  await server.close();
  app.db.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
