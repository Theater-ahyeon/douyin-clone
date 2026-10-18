'use strict';
/**
 * Forked backend process.
 *
 * It is a thin wrapper around the repo's own production serving path: the same
 * `startServer({ staticDir })` call that scripts/start.mjs makes, with the same
 * openDatabase() / ensureMediaDir() order. No HTTP, static or media serving is
 * reimplemented here - only the plumbing a GUI parent needs:
 *
 *   - paths resolved from env, because a packaged app lives under
 *     <resources>/backend while a dev run lives in the repo;
 *   - an IPC `ready` handshake plus a `{ type: 'shutdown' }` handler, so the
 *     main process can stop it cleanly on Windows where signals are not
 *     deliverable and an orphan would keep the port bound;
 *   - exit-on-disconnect, so a crashed parent cannot leak a server.
 *
 * Runnable standalone for debugging:
 *   DY_PORT=8798 node desktop/src/child-server.cjs
 */

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const env = process.env;
const log = env.DY_LOG === '0' ? () => {} : (line) => console.log(line);

function die(message, code = 1) {
  console.error(`[child-server] ${message}`);
  process.exit(code);
}

async function importEsm(file, label) {
  if (!fs.existsSync(file)) die(`${label} not found at ${file} - run the build or set DY_DESKTOP_BACKEND_ROOT`);
  return import(pathToFileURL(file).href);
}

async function main() {
  const backendRoot = path.resolve(env.DY_BACKEND_ROOT || path.resolve(__dirname, '..', '..'));
  const webDist = path.resolve(env.DY_WEB_DIST || path.join(backendRoot, 'web', 'dist'));
  const host = env.DY_HOST || '127.0.0.1';
  const port = Number(env.DY_PORT || 8787);

  env.DY_HOST = host;
  env.DY_PORT = String(port);
  if (env.DY_DATA_DIR) env.DY_DATA_DIR = path.resolve(env.DY_DATA_DIR);

  const send = (msg) => {
    try {
      if (typeof process.send === 'function') process.send(msg);
    } catch {
      /* parent already gone */
    }
  };

  let server = null;
  let closeDb = null;
  let closing = false;
  const shutdown = (reason) => {
    if (closing) return;
    closing = true;
    log(`[child-server] ${reason}, closing server`);
    const finish = () => {
      try {
        if (closeDb) closeDb();
      } catch {
        /* already closed */
      }
      process.exit(0);
    };
    if (!server) {
      finish();
      return;
    }
    server.close(finish);
    // A keep-alive connection must not pin the process past the parent's grace window.
    setTimeout(finish, 1500).unref();
  };

  // Installed before any slow work: an ESM import or a sqlite open can take a
  // second, and a parent that dies during it must not leave a server that goes
  // on to bind the port forever.
  process.on('message', (msg) => {
    if (msg && msg.type === 'shutdown') shutdown('shutdown requested by parent');
  });
  process.once('disconnect', () => shutdown('parent process disconnected'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    console.error('[child-server] unhandled rejection:', (reason && reason.stack) || reason);
  });

  const indexPath = path.join(webDist, 'index.html');
  if (!fs.existsSync(indexPath)) {
    die(`${indexPath} does not exist. Build the frontend first:  npm run build   (repo root)`);
  }

  const serverSrc = path.join(backendRoot, 'server', 'src');
  const { LOG } = await importEsm(path.join(serverSrc, 'config.js'), 'server/src/config.js');
  const db = await importEsm(path.join(serverSrc, 'db.js'), 'server/src/db.js');
  const { ensureMediaDir } = await importEsm(path.join(serverSrc, 'media.js'), 'server/src/media.js');
  const { startServer } = await importEsm(path.join(serverSrc, 'server.js'), 'server/src/server.js');

  db.openDatabase();
  try {
    const row = db.get('SELECT COUNT(*) AS n FROM users', []);
    if (!row || !row.n) log('[child-server] the database has no users yet - demo data: node scripts/seed.mjs');
  } catch {
    /* a brand new db file has no tables until openDatabase() ran; ignore */
  }
  await ensureMediaDir();

  try {
    server = (await startServer({ staticDir: webDist, host, port })).server;
  } catch (error) {
    // startServer rejects on listen errors, so a listener further down would be
    // too late for the collision case.
    if (error && error.code === 'EADDRINUSE') die(`${host}:${port} is already in use - stop the other server or set DY_PORT`, 3);
    throw error;
  }
  closeDb = db.closeDatabase;
  log(`[child-server] serving api + web at http://${host}:${port} (static ${webDist})`);

  send({ type: 'ready', pid: process.pid, host, port, webDist, dataDir: env.DY_DATA_DIR || null });

  server.on('error', (error) => {
    if (error && error.code === 'EADDRINUSE') {
      die(`${host}:${port} is already in use - stop the other server or set DY_PORT`, 3);
    }
  });

  if (LOG === false) {
    /* nothing to do; kept so DY_LOG=0 is honoured the same way config.js reads it */
  }
}

main().catch((error) => die(error && (error.stack || error.message) || String(error)));
