import os from 'node:os';
import { createApp } from './app.ts';
import { workerLoop } from './jobs/runner.ts';

/**
 * Worker process: claims queued jobs with persisted leases, heartbeats while
 * working, and marks jobs interrupted (never silently re-run) after a crash.
 */
const app = createApp();
const controller = new AbortController();
const workerId = `worker-${os.hostname()}-${process.pid}`;
console.log(`NEXUS worker ${workerId} started (data: ${app.config.dataDir})`);

const stop = () => {
  console.log('Worker stopping — running jobs will be marked interrupted if they do not finish.');
  controller.abort();
  setTimeout(() => process.exit(0), 1500).unref();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

await workerLoop(app, { workerId, signal: controller.signal });
app.db.close();
