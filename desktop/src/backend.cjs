'use strict';
/**
 * Owns the embedded backend: where its files live, starting it, waiting for it
 * to answer, and stopping it without leaving a process bound to the port.
 *
 * The HTTP serving itself is NOT reimplemented here - the child process calls
 * the repo's own `startServer({ staticDir })` (server/src/server.js), i.e. the
 * same code path scripts/start.mjs uses. This module only supplies the env the
 * zero-dependency server needs to resolve its paths from a packaged layout.
 */

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { fork } = require('node:child_process');

const READINESS_PATH = '/api/feed?limit=1';
const APP_SNR_PATH = '/';
const APP_SNR_MARKER = '<div id="root">';
const POLL_INTERVAL_MS = 150;
const READY_TIMEOUT_MS = 25000;
const STOP_GRACE_MS = 2500;

function firstExisting(...candidates) {
  for (const candidate of candidates) if (candidate) return candidate;
  return null;
}

/**
 * Resolve every backend path for the current launch mode.
 * Packaged layout (electron-builder `extraResources`):
 *   <resources>/backend/scripts/start.mjs
 *   <resources>/backend/server/src/*.js
 *   <resources>/backend/web/dist/
 *   <resources>/backend-data-seed/{app.sqlite,videos/,thumbs/}
 * Dev layout: the repo root two levels above desktop/.
 */
function resolveLayout({ isPackaged, desktopDir, resourcesPath, userDataDir, env = process.env }) {
  const repoRoot = path.resolve(desktopDir, '..');
  const packagedBackendRoot = path.join(resourcesPath, 'backend');
  const backendRoot = env.DY_DESKTOP_BACKEND_ROOT
    ? path.resolve(env.DY_DESKTOP_BACKEND_ROOT)
    : (isPackaged ? packagedBackendRoot : repoRoot);

  const webDist = env.DY_DESKTOP_WEB_DIST
    ? path.resolve(env.DY_DESKTOP_WEB_DIST)
    : path.join(backendRoot, 'web', 'dist');

  const repoDataDir = path.join(backendRoot, 'server', 'data');
  const writableDataDir = path.join(userDataDir, 'server-data');
  const dataDir = firstExisting(
    env.DY_DATA_DIR ? path.resolve(env.DY_DATA_DIR) : null,
    isPackaged ? writableDataDir : repoDataDir
  );

  return {
    backendRoot,
    webDist,
    dataDir,
    seedDataDir: path.join(resourcesPath, 'backend-data-seed'),
    serverEntry: path.join(backendRoot, 'server', 'src', 'index.js'),
    startScript: path.join(backendRoot, 'scripts', 'start.mjs'),
    childScript: path.join(desktopDir, 'src', 'child-server.cjs'),
    host: env.DY_HOST || '127.0.0.1',
    port: Number(env.DY_PORT || 8787),
    log: env.DY_LOG !== '0',
  };
}

/** true when something already answers the feed API on host:port. */
function probeBackend({ host, port, timeoutMs = 800 }) {
  return new Promise((resolve) => {
    const req = http.get(
      { host, port, path: READINESS_PATH, timeout: timeoutMs, headers: { accept: 'application/json' } },
      (res) => {
        res.resume();
        resolve(res.statusCode >= 200 && res.statusCode < 400);
      }
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
  });
}

/**
 * true when host:port also serves the built SPA, not just the JSON API.
 * The dev entry (server/src/index.js) answers /api/feed but has no static root,
 * so a bare readiness probe is not enough to decide "someone is already running
 * the production server, reuse it".
 */
function probeAppServed({ host, port, timeoutMs = 1200 }) {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: APP_SNR_PATH, timeout: timeoutMs }, (res) => {
      let body = '';
      const type = String(res.headers['content-type'] || '');
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        if (body.length < 64 * 1024) body += chunk;
      });
      res.on('end', () => {
        resolve(type.includes('text/html') && body.includes(APP_SNR_MARKER));
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForBackend({ host, port, timeoutMs = READY_TIMEOUT_MS, isAlive = () => true, log = () => {} }) {
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  while (Date.now() < deadline) {
    attempts += 1;
    if (!isAlive()) throw new Error('backend child exited before it became reachable');
    /* eslint-disable no-await-in-loop */
    if (await probeBackend({ host, port })) return { attempts };
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`backend never answered GET ${READINESS_PATH} on ${host}:${port}`);
}

/** Forward the child's stdout/stderr into the main log with a tag. */
function pipeChildStream(stream, tag, log, sink) {
  if (!stream) return;
  stream.setEncoding('utf8');
  let buffer = '';
  const flushLine = (line) => {
    if (!line.trim()) return;
    if (sink) {
      sink.push(line.trim());
      if (sink.length > 12) sink.shift();
    }
    log(`[server] ${line.replace(/\s+$/, '')}`);
  };
  stream.on('data', (chunk) => {
    buffer += chunk;
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      flushLine(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf('\n');
    }
  });
  stream.on('end', () => flushLine(buffer));
}

/**
 * First-run copy of the demo database + media into a writable userData dir.
 * `.token-secret` is deliberately never copied: every install gets its own
 * signing secret instead of sharing the developer's.
 */
function seedDataDir({ seedDir, targetDir, log }) {
  try {
    if (!fs.existsSync(seedDir)) return { seeded: false, reason: 'no seed dir' };
    fs.mkdirSync(targetDir, { recursive: true });
    let copied = 0;

    const dbFile = path.join(seedDir, 'app.sqlite');
    if (fs.existsSync(dbFile) && !fs.existsSync(path.join(targetDir, 'app.sqlite'))) {
      fs.copyFileSync(dbFile, path.join(targetDir, 'app.sqlite'));
      copied += 1;
    }

    for (const subdir of ['videos', 'thumbs']) {
      const from = path.join(seedDir, subdir);
      if (!fs.existsSync(from)) continue;
      const to = path.join(targetDir, subdir);
      fs.mkdirSync(to, { recursive: true });
      for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const target = path.join(to, entry.name);
        if (fs.existsSync(target)) continue;
        fs.copyFileSync(path.join(from, entry.name), target);
        copied += 1;
      }
    }
    log(`[desktop] seeded ${copied} file(s) into ${targetDir}`);
    return { seeded: copied > 0, copied };
  } catch (error) {
    log(`[desktop] data seed failed: ${error && error.message}`);
    return { seeded: false, reason: String(error && error.message) };
  }
}

/**
 * Start the embedded backend.
 * Resolves either with a forked child we own, or with `child: null` when a
 * backend was already listening (so a plain `npm run dev` stack is reused
 * instead of fighting over the port). `onChild` fires the instant the process
 * exists, so a quit during the boot below still has a handle to kill.
 */
async function startEmbeddedBackend({ layout, log, onChild }) {
  const { host, port } = layout;

  if (await probeBackend({ host, port })) {
    if (await probeAppServed({ host, port })) {
      log(`[desktop] backend already serving api + web on http://${host}:${port}; reusing it (no fork)`);
      return { child: null, reused: true, host, port };
    }
    throw new Error(
      `http://${host}:${port} answers /api/feed but does not serve the built frontend - that is ` +
      `the dev API entry (server/src/index.js has no static root). Stop it, or give the embedded ` +
      `server another port: DY_PORT=<other> node src/launch.cjs --prod`
    );
  }

  if (!fs.existsSync(layout.childScript)) throw new Error(`missing ${layout.childScript}`);
  if (!fs.existsSync(path.join(layout.webDist, 'index.html'))) {
    throw new Error(`${path.join(layout.webDist, 'index.html')} is missing - build the frontend first (npm run build at the repo root)`);
  }

  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    DY_HOST: host,
    DY_PORT: String(port),
    DY_BACKEND_ROOT: layout.backendRoot,
    DY_WEB_DIST: layout.webDist,
    DY_DATA_DIR: layout.dataDir,
    DY_LOG: layout.log ? '1' : '0',
  };
  // Never let the child inherit a dev-server override that would confuse it.
  delete env.ELECTRON_DEFAULT_ERROR_MODE;

  const child = fork(layout.childScript, [], {
    env,
    cwd: path.dirname(layout.childScript),
    execArgv: [],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
    detached: false,
  });
  if (typeof onChild === 'function') {
    try {
      onChild(child);
    } catch (error) {
      log(`[desktop] onChild failed: ${error.message}`);
    }
  }

  const lastErrLines = [];
  pipeChildStream(child.stdout, 'server', log);
  pipeChildStream(child.stderr, 'server', log, lastErrLines);

  let exitInfo = null;
  child.on('exit', (code, signal) => {
    exitInfo = { code, signal };
    log(`[desktop] backend child exited (code=${code} signal=${signal})`);
  });
  child.on('error', (error) => log(`[desktop] backend child error: ${error.message}`));

  const ready = new Promise((resolve, reject) => {
    let settled = false;
    const fail = (message) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // The child's own last words ("port already in use", "web/dist missing")
      // are what makes the error page actionable instead of `code=1`.
      const tail = lastErrLines.slice(-2).join(' | ');
      reject(new Error(tail ? `${message} - ${tail}` : message));
    };
    const timer = setTimeout(() => fail('backend did not report a listening port in time'), READY_TIMEOUT_MS);
    child.once('message', (msg) => {
      if (settled) return;
      if (msg && msg.type === 'ready') {
        settled = true;
        clearTimeout(timer);
        resolve(msg);
      } else {
        fail(`unexpected backend handshake: ${JSON.stringify(msg)}`);
      }
    });
    child.once('exit', () => fail(`backend exited before listening (code=${child.exitCode})`));
    // A failed spawn never emits 'exit'; without this the page waits the full
    // READY_TIMEOUT_MS for a process that does not exist.
    child.once('error', (error) => fail(`could not start the backend process: ${error.message}`));
  });

  log(`[desktop] forking backend on http://${host}:${port} (static ${layout.webDist}, data ${layout.dataDir})`);
  const handshake = await ready;
  const { attempts } = await waitForBackend({
    host,
    port,
    isAlive: () => exitInfo === null && child.connected !== false,
    log,
  });
  log(`[desktop] backend reachable (${handshake.pid ? `pid ${handshake.pid}, ` : ''}${attempts} probe(s))`);

  if (!(await probeAppServed({ host, port }))) {
    const error = new Error(
      `the forked backend answers /api/feed but not the SPA on http://${host}:${port} - ` +
      `check the static root (${layout.webDist})`
    );
    await stopEmbeddedBackend({ child }, log);
    throw error;
  }

  return { child, reused: false, host, port, handshake };
}

/** Ask nicely over IPC, then force. Idempotent. */
async function stopEmbeddedBackend(state, log = () => {}) {
  if (!state || !state.child || state.reused) return { stopped: true, wasForked: false };
  const { child } = state;
  if (child.exitCode !== null || child.signalCode) return { stopped: true, wasForked: true };

  const exited = new Promise((resolve) => child.once('exit', () => resolve(true)));
  try {
    child.send({ type: 'shutdown' });
  } catch {
    /* channel already closed */
  }
  const timer = new Promise((resolve) => setTimeout(() => resolve(false), STOP_GRACE_MS));
  const graceful = await Promise.race([exited, timer]);
  if (graceful) {
    log('[desktop] backend shut down gracefully');
    return { stopped: true, wasForked: true, graceful: true };
  }
  log('[desktop] backend ignored shutdown, sending SIGKILL');
  try {
    child.kill('SIGKILL');
  } catch {
    /* already gone */
  }
  // The port is only free once the process is really gone; returning early lets a
  // next launch race against a socket that is still bound.
  await Promise.race([exited, sleep(1500)]);
  return { stopped: child.exitCode !== null || child.signalCode !== null, wasForked: true, graceful: false };
}

module.exports = {
  APP_SNR_MARKER,
  READINESS_PATH,
  READY_TIMEOUT_MS,
  probeAppServed,
  probeBackend,
  resolveLayout,
  seedDataDir,
  startEmbeddedBackend,
  stopEmbeddedBackend,
  waitForBackend,
};
