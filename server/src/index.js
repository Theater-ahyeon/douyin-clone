import process from 'node:process';

import { HOST, LOG, PORT } from './config.js';
import { closeDatabase, openDatabase } from './db.js';
import { ensureMediaDir } from './media.js';
import { startPerfMon } from './perfmon.js';
import { startServer } from './server.js';

async function main() {
  openDatabase();
  startPerfMon();
  await ensureMediaDir();
  const { server } = await startServer({ host: process.env.DY_HOST || HOST, port: Number(process.env.DY_PORT || PORT) });
  if (LOG) console.log(`[api] listening on http://${HOST}:${PORT}`);

  let closing = false;
  const shutdown = (signal) => {
    if (closing) return;
    closing = true;
    if (LOG) console.log(`[api] ${signal} received, shutting down`);
    server.close(() => {
      closeDatabase();
      process.exit(0);
    });
    // Do not let a keep-alive connection block the shutdown.
    setTimeout(() => {
      closeDatabase();
      process.exit(0);
    }, 2000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    console.error('[api] unhandled rejection:', reason);
  });
}

main().catch((error) => {
  console.error('[api] failed to start:', error && (error.stack || error.message));
  process.exit(1);
});
