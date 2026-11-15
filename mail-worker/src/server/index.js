import { serve } from '@hono/node-server';
import { loadConfig } from './config.js';
import { createEnvironment } from './environment.js';
import { createApp } from './app.js';
import { startScheduler } from './scheduler.js';
import { startMailServices } from './mail.js';
import { acquireDataLock } from './lock.js';
import { startVerificationRuntime } from '../modules/verification/service.js';
import { startNodeRuntime } from '../modules/nodes/service.js';

async function main() {
  const config = loadConfig();
  const releaseLock = await acquireDataLock(config.sqlitePath);
  let env, mail, scheduler, http, stopVerification, stopNodes;
  let closing;
  const close = () => closing ||= (async () => {
    const drained = http ? new Promise(resolve => { http.close(resolve); http.closeIdleConnections(); }) : Promise.resolve();
    await stopVerification?.();
    await stopNodes?.();
    await drained;
    await scheduler?.close();
    await mail?.close();
    if (env?.db.open) { env.db.pragma('wal_checkpoint(TRUNCATE)'); env.db.close(); }
    await releaseLock();
  })();
  try {
    env = await createEnvironment(config);
    stopNodes = await startNodeRuntime(env);
    if (env.node_role !== 'replica') {
      mail = await startMailServices(env);
      env.mailReady = true;
      scheduler = startScheduler(env);
      stopVerification = await startVerificationRuntime(env);
    }
    const app = createApp(env);
    http = serve({
      fetch: (request, bindings) => app.fetch(request, { ...env, remote_address: bindings.incoming.socket.remoteAddress }),
      port: env.port, hostname: env.httpHost,
    });
    http.on('error', async error => { console.error('HTTP server failed:', error.message); await close(); process.exitCode = 1; });
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { void close().then(() => { process.exitCode = 0; }); });
    console.info(`Cloud Mail listening on ${env.httpHost}:${env.port}; role=${env.node_role}`);
  } catch (error) {
    await close();
    throw error;
  }
}

main().catch(error => { console.error('Startup failed:', error.message); process.exitCode = 1; });
