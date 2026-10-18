#!/usr/bin/env node
/**
 * Self-contained load harness for the zero-dependency Douyin-clone server.
 *
 * It boots its OWN server instance (DY_PORT default 8799) against a throwaway copy
 * of the seeded database so it can never corrupt `server/data/app.sqlite`, drives
 * concurrent keep-alive requests with configurable concurrency/duration, and prints
 * p50/p95/p99 latency, throughput, event-loop lag and Range-throughput.
 *
 * Built-ins only (node:http, node:sqlite, node:child_process, node:perf_hooks).
 * `npx` and third-party load tools are banned on this machine, hence the hand-rolled
 * concurrency pool below. Exit code is non-zero if the server cannot be reached.
 *
 *   node scripts/benchmark.mjs                          # default run
 *   node scripts/benchmark.mjs --concurrency 50 --duration 6000
 *   node scripts/benchmark.mjs --scenario feed,mixed
 *   node scripts/benchmark.mjs --json                   # machine-readable dump
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const SERVER_SRC = path.join(REPO, 'server', 'src', 'index.js');
const SEED_DATA = path.join(REPO, 'server', 'data');

/* ------------------------------------------------------------------ args ---- */

const ALL_KEYS = ['feed', 'feed-auth', 'comments', 'media-full', 'media-range', 'mixed'];

function parseArgs(argv) {
  const out = {
    port: 8799,
    concurrency: 20,
    durationMs: 4000,
    scenario: null,
    media: 'seed-flower.mp4',
    commentsVideo: 1,
    json: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--port') out.port = Number(next());
    else if (a === '--concurrency' || a === '-c') out.concurrency = Number(next());
    else if (a === '--duration' || a === '-d') out.durationMs = Number(next());
    else if (a === '--scenario' || a === '-s') out.scenario = next().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--media') out.media = next();
    else if (a === '--comments-video') out.commentsVideo = Number(next());
    else if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else { console.error(`unknown argument: ${a}`); printHelp(); process.exit(2); }
  }
  if (!Number.isInteger(out.port) || out.port <= 0) die('port must be a positive integer');
  if (!Number.isInteger(out.concurrency) || out.concurrency < 1) die('concurrency must be >= 1');
  if (!Number.isInteger(out.durationMs) || out.durationMs < 200) die('duration must be >= 200ms');
  if (out.scenario) {
    for (const s of out.scenario) if (!ALL_KEYS.includes(s)) die(`unknown scenario key '${s}' (pick from ${ALL_KEYS.join(', ')})`);
  }
  return out;
}

function printHelp() {
  console.log(`usage: node scripts/benchmark.mjs [options]

  --port <n>             server port (default 8799; never touches the dev server on 8787)
  --concurrency, -c <n>  parallel in-flight requests (default 20)
  --duration, -d <ms>    per-scenario load window (default 4000)
  --scenario, -s <list>  comma list of: ${ALL_KEYS.join(', ')}
                         (mixed interleaves feed + Range requests to expose stutter)
  --media <file>         media file under server/data/videos for Range tests (default seed-flower.mp4)
  --comments-video <id>  video id to list comments for (default 1)
  --json                 also emit a JSON blob for docs
`);
}

function die(msg) {
  console.error(`[benchmark] ERROR: ${msg}`);
  process.exit(1);
}

/* --------------------------------------------------------- temp workspace --- */

// Copy the DB into a private dir so writes (registered users, the upload token
// secret) never touch seeded rows, and so a crash can't leave the real WAL dirty.
// `VACUUM INTO` is used instead of a file copy: it snapshots through SQLite while
// the dev server is mid-commit, whereas a byte copy of a hot WAL database can land
// a torn page and make the run die with "database image is malformed".
function makeWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dy-bench-'));
  const source = new DatabaseSync(path.join(SEED_DATA, 'app.sqlite'), { readOnly: true });
  try {
    source.exec('PRAGMA busy_timeout = 5000');
    source.prepare('VACUUM INTO ?').run(path.join(dir, 'app.sqlite'));
  } finally {
    source.close();
  }
  const db = new DatabaseSync(path.join(dir, 'app.sqlite'));
  try { db.exec('PRAGMA journal_mode = WAL'); db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } finally { db.close(); }

  const videos = path.join(dir, 'videos');
  fs.mkdirSync(videos, { recursive: true });
  const srcVideos = path.join(SEED_DATA, 'videos');
  if (fs.existsSync(srcVideos)) {
    for (const name of fs.readdirSync(srcVideos)) {
      const from = path.join(srcVideos, name);
      if (fs.statSync(from).isFile()) fs.copyFileSync(from, path.join(videos, name));
    }
  }
  return dir;
}

/* --------------------------------------------------------------- server ---- */

let child = null;
let workspace = null;
let cleaned = false;

function cleanup(code) {
  if (cleaned) return;
  cleaned = true;
  try { if (child && child.exitCode === null && !child.killed) child.kill('SIGTERM'); } catch { /* already gone */ }
  try {
    if (workspace && fs.existsSync(workspace)) {
      // WAL/SHM may still be open on Windows; retry so rm doesn't throw.
      fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 120 });
    }
  } catch { /* best effort; temp dir lives under os.tmpdir */ }
  if (typeof code === 'number') process.exit(code);
}

process.on('SIGINT', () => { console.error('\n[benchmark] interrupted'); cleanup(130); });
process.on('SIGTERM', () => cleanup(143));
process.on('exit', () => cleanup());
process.on('uncaughtException', (e) => { console.error('[benchmark] fatal:', e && (e.stack || e)); cleanup(1); });

function bootServer(port) {
  workspace = makeWorkspace();
  child = spawn(process.execPath, [SERVER_SRC], {
    env: {
      ...process.env,
      DY_PORT: String(port),
      DY_HOST: '127.0.0.1',
      DY_DATA_DIR: workspace,
      DY_ELMONITOR: '1',
      DY_LOG: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderrBuf = '';
  child.stdout.on('data', (d) => { if (process.env.DY_BENCH_VERBOSE) process.stdout.write(`  [server] ${d}`); });
  child.stderr.on('data', (d) => { stderrBuf += d.toString(); if (process.env.DY_BENCH_VERBOSE) process.stderr.write(`  [server] ${d}`); });
  child.on('exit', (code, sig) => {
    if (!cleaned && code !== 0 && code !== null) {
      console.error(`[benchmark] server exited early (code=${code} sig=${sig})\n${stderrBuf}`);
      process.exit(1);
    }
  });
}

// Minimal HTTP request with a latency timer; reused by every scenario.
function requestOnce({ port, method, path: reqPath, headers = {}, body = null, agent }) {
  return new Promise((resolve, reject) => {
    const start = process.hrtime.bigint();
    const req = http.request({ host: '127.0.0.1', port, method, path: reqPath, headers, agent }, (res) => {
      let bytes = 0;
      res.on('data', (c) => { bytes += c.length; });
      res.on('end', () => {
        const ns = Number(process.hrtime.bigint() - start);
        resolve({ status: res.statusCode, bytes, ms: ns / 1e6, headers: res.headers });
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('timeout')));
    if (body) req.write(body);
    req.end();
  });
}

async function waitForHealth(port, tries = 50) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const r = await requestOnce({ port, method: 'GET', path: '/api/health' });
      if (r.status === 200) return;
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 120));
  }
  die(`server on port ${port} never became healthy (is another process holding it?)`);
}

/* ------------------------------------------------------------ load pool ---- */

// A fixed worker pool: `concurrency` async workers each issue requests back to
// back on keep-alive sockets until the deadline, then the in-flight set settles.
// spec.next() returns { path, headers, kind, body? }. kind groups samples so the
// mixed scenario can report feed vs media latency separately.
async function driveLoad(agent, spec, { port, concurrency, durationMs }) {
  const samples = []; // { ms, bytes, kind }
  const errors = [];
  let stop = false;

  async function worker() {
    while (!stop && Date.now() < deadline) {
      const r = spec.next();
      const p = requestOnce({ port, method: spec.method, path: r.path, headers: r.headers, body: r.body, agent });
      try {
        const res = await p;
        if (res.status >= 200 && res.status < 400) samples.push({ ms: res.ms, bytes: res.bytes, kind: r.kind || 'main' });
        else errors.push(`HTTP ${res.status}`);
      } catch (e) {
        errors.push(e.message);
      }
    }
  }

  const deadline = Date.now() + durationMs;
  const wallStart = Date.now();
  const workers = Array.from({ length: concurrency }, worker);
  await Promise.all(workers);
  const wallMs = Date.now() - wallStart;
  return { samples, errors, wallMs };
}

function percentile(sorted, p) {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

// One label-row per kind present in `samples`.
function summarizeRows(labelPrefix, load, perf) {
  const byKind = new Map();
  for (const s of load.samples) {
    if (!byKind.has(s.kind)) byKind.set(s.kind, { ms: [], bytes: 0 });
    const g = byKind.get(s.kind);
    g.ms.push(s.ms);
    g.bytes += s.bytes;
  }
  const rows = [];
  for (const [kind, g] of byKind) {
    const sorted = g.ms.sort((a, b) => a - b);
    const n = sorted.length;
    rows.push({
      scenario: kind === 'main' ? labelPrefix : `${labelPrefix} ${kind}`,
      requests: n,
      errors: kind === 'main' ? load.errors.length : 0,
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      p99: percentile(sorted, 99),
      max: n ? sorted[n - 1] : NaN,
      rps: n > 0 ? n / (load.wallMs / 1000) : 0,
      mbs: n > 0 ? (g.bytes / 1024 / 1024) / (load.wallMs / 1000) : 0,
      elP99: perf ? perf.elP99Ms : NaN,
      elMax: perf ? perf.elMaxMs : NaN,
    });
  }
  // Preserve a stable, readable order: media before feed etc. keeps the API/media
  // comparison adjacent, so sort by scenario name.
  rows.sort((a, b) => a.scenario.localeCompare(b.scenario));
  return rows;
}

/* -------------------------------------------------------------- scenarios -- */

const RANGE_SIZES = [65536, 262144, 1048576];

function makeScenarios(cfg, auth) {
  const mediaPath = `/media/${encodeURIComponent(cfg.media)}`;
  let rangeIdx = 0;
  const rangeReq = () => {
    const size = RANGE_SIZES[rangeIdx++ % RANGE_SIZES.length];
    return { path: mediaPath, headers: { Range: `bytes=0-${size - 1}` }, kind: '(media)' };
  };
  const feedReq = () => ({ path: '/api/feed?limit=12', headers: {}, kind: '(api)' });

  return [
    { name: 'feed (anon)', key: 'feed',
      build: () => ({ method: 'GET', next: () => ({ path: '/api/feed?limit=12', headers: {}, kind: 'main' }) }) },
    { name: 'feed (authed)', key: 'feed-auth',
      build: () => ({ method: 'GET', next: () => ({ path: '/api/feed?limit=12', headers: { Authorization: `Bearer ${auth.token}` }, kind: 'main' }) }) },
    { name: 'comments', key: 'comments',
      build: () => ({ method: 'GET', next: () => ({ path: `/api/videos/${cfg.commentsVideo}/comments?limit=20`, headers: {}, kind: 'main' }) }) },
    { name: 'media full', key: 'media-full',
      build: () => ({ method: 'GET', next: () => ({ path: mediaPath, headers: {}, kind: 'main' }) }) },
    { name: 'media range', key: 'media-range',
      build: () => ({ method: 'GET', next: rangeReq }) },
    // Interleave an API query with a Range read on the same sockets/pool. If the
    // sync DB work stalls the loop, the media latency here balloons versus the
    // isolated 'media range' row - that difference IS playback stutter 卡顿.
    { name: 'mixed', key: 'mixed',
      build: () => { let i = 0; return { method: 'GET', next: () => (i++ % 2 === 0 ? feedReq() : rangeReq()) }; } },
  ];
}

async function readPerfJson(port, reset) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: `/api/__perf${reset ? '?reset=1' : ''}` }, (r) => {
      let data = '';
      r.on('data', (c) => (data += c));
      r.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(3000, () => req.destroy());
    req.end();
  });
}

// Register a throwaway user out-of-band and read its token; scrypt is slow and we
// want that cost outside the timed load pool.
async function registerToken(port, username) {
  const body = JSON.stringify({ username, password: 'password123' });
  const res = await new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method: 'POST', path: '/api/auth/register',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (r) => {
      let data = '';
      r.on('data', (c) => (data += c));
      r.on('end', () => resolve({ status: r.statusCode, data }));
    });
    req.on('error', reject);
    req.end(body);
  });
  if (res.status !== 200) throw new Error(`register ${username} failed: HTTP ${res.status} ${res.data}`);
  return JSON.parse(res.data).token;
}

/* ------------------------------------------------------------------ main ---- */

async function main() {
  const cfg = parseArgs(process.argv);
  const agent = new http.Agent({ keepAlive: true, maxSockets: cfg.concurrency + 8 });

  if (!fs.existsSync(path.join(SEED_DATA, 'app.sqlite'))) die(`seed DB not found at ${path.join(SEED_DATA, 'app.sqlite')}`);

  bootServer(cfg.port);
  console.log(`[benchmark] throwaway DB+media copied to ${workspace}`);
  console.log(`[benchmark] booting server on 127.0.0.1:${cfg.port} (the dev server on 8787 is left untouched)`);
  await waitForHealth(cfg.port);

  const auth = { token: null };
  const all = makeScenarios(cfg, auth);
  // authed feed needs a token, fetched out-of-band so its scrypt cost stays out of the pool.
  auth.token = await registerToken(cfg.port, `bench_${Date.now().toString(36)}`);

  const selected = cfg.scenario ? all.filter((s) => cfg.scenario.includes(s.key)) : all;
  if (!selected.length) die(`no scenarios match ${JSON.stringify(cfg.scenario)}`);

  const rows = [];
  for (const sc of selected) {
    // Reset the event-loop histogram so lag reflects only this scenario.
    await readPerfJson(cfg.port, true);
    const spec = sc.build();
    const load = await driveLoad(agent, spec, { port: cfg.port, concurrency: cfg.concurrency, durationMs: cfg.durationMs });
    const perf = await readPerfJson(cfg.port, false);
    rows.push(...summarizeRows(sc.name, load, perf));
  }

  agent.destroy();
  printTable(rows, cfg);
  if (cfg.json) console.log('\n' + JSON.stringify({ meta: { concurrency: cfg.concurrency, durationMs: cfg.durationMs, port: cfg.port }, rows }, null, 2));

  cleanup(0);
}

function fmt(num, digits = 1) {
  if (num === null || Number.isNaN(num)) return '-';
  return num.toFixed(digits);
}

function printTable(rows, cfg) {
  console.log(`\n================= douyin-clone server benchmark =================`);
  console.log(`concurrency=${cfg.concurrency}  duration=${cfg.durationMs}ms/scenario  port=${cfg.port}`);
  const head = ['scenario', 'reqs', 'err', 'p50ms', 'p95ms', 'p99ms', 'maxms', 'req/s', 'MB/s', 'ELp99ms', 'ELmaxms'];
  const body = rows.map((r) => [
    r.scenario, String(r.requests), String(r.errors), fmt(r.p50), fmt(r.p95), fmt(r.p99), fmt(r.max),
    fmt(r.rps, 0), fmt(r.mbs, 1), fmt(r.elP99, 2), fmt(r.elMax, 2),
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((row) => row[i].length)));
  const line = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join('  ');
  console.log(line(head));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const row of body) console.log(line(row));
  console.log(`\nEL = event-loop delay (monitorEventLoopDelay). In 'mixed' the media row is`);
  console.log(`slower than standalone 'media range' only when sync DB work stalls the byte pump.\n`);
}

main().catch((e) => { console.error('[benchmark] fatal:', e && (e.stack || e)); cleanup(1); });
