#!/usr/bin/env node
/**
 * Production entrypoint: one Node HTTP server on 8787 that serves both the API and
 * the built frontend (web/dist) with an SPA fallback.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { HOST, LOG, PORT } from '../server/src/config.js';
import { get, openDatabase } from '../server/src/db.js';
import { ensureMediaDir } from '../server/src/media.js';
import { startServer } from '../server/src/server.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const DIST = process.env.DY_WEB_DIST ? path.resolve(process.env.DY_WEB_DIST) : path.join(REPO, 'web', 'dist');

async function main() {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) {
    console.error(`[start] ${path.relative(REPO, path.join(DIST, 'index.html'))} does not exist.`);
    console.error('[start] Build the frontend first:   npm run build');
    console.error('[start] (or run the dev stack with:  npm run dev)');
    process.exit(1);
  }

  openDatabase();
  const users = get(`SELECT COUNT(*) AS n FROM users`, []).n;
  if (!users && LOG) {
    console.log('[start] the database has no users yet - demo data:  npm run seed');
  }
  await ensureMediaDir();

  const port = Number(process.env.DY_PORT || PORT);
  const host = process.env.DY_HOST || HOST;
  const { server } = await startServer({ staticDir: DIST, port, host });
  if (LOG) {
    console.log(`[start] serving api + web on http://${host}:${port}`);
    console.log(`[start]   /api/*  -> json api      /media/* -> range-streamed video`);
    console.log(`[start]   /*      -> ${path.relative(REPO, DIST)} (SPA fallback to index.html)`);
  }

  let closing = false;
  const shutdown = (signal) => {
    if (closing) return;
    closing = true;
    if (LOG) console.log(`[start] ${signal} received, closing server`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error) => {
  console.error('[start] failed:', error && (error.stack || error.message || error));
  process.exit(1);
});
