#!/usr/bin/env node
/**
 * Dev runner: API (`node --watch`) + Vite side by side, with prefixed output and a
 * single Ctrl-C that tears both down. Deliberately avoids `npx` (this project bans
 * it) by executing the installed Vite entry with the current Node binary.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const SERVER = path.join(REPO, 'server');
const WEB = path.join(REPO, 'web');
const VITE_ENTRY = path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js');

const COLOR = {
  api: '\x1b[36m',
  web: '\x1b[35m',
  run: '\x1b[33m',
  reset: '\x1b[0m',
};

const useColor = !process.env.NO_COLOR && process.stdout.isTTY !== false;
const paint = (color, text) => (useColor ? `${COLOR[color]}${text}${COLOR.reset}` : text);

function note(message) {
  console.log(paint('run', `[dev]`) + ' ' + message);
}

const children = [];
let shuttingDown = false;

function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  if (process.platform === 'win32') {
    // `node --watch` runs the app in a *child* process, so a bare child.kill() would
    // orphan the server and leave port 8787 bound. Kill the whole tree.
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try {
    child.kill('SIGTERM');
  } catch {
    /* already gone */
  }
}

function prefixStream(stream, label) {
  if (!stream) return;
  stream.setEncoding('utf8');
  let buffer = '';
  const flush = (force) => {
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, '');
      buffer = buffer.slice(index + 1);
      if (line) process.stdout.write(`${paint(label, `[${label}]`)} ${line}\n`);
      index = buffer.indexOf('\n');
    }
    if (force && buffer.trim()) {
      process.stdout.write(`${paint(label, `[${label}]`)} ${buffer}\n`);
      buffer = '';
    }
  };
  stream.on('data', (chunk) => {
    buffer += chunk;
    flush(false);
  });
  stream.on('end', () => flush(true));
}

function start(label, command, args, options) {
  const child = spawn(command, args, options);
  child.on('error', (error) => {
    console.error(`${paint(label, `[${label}]`)} failed to start: ${error.message}`);
    shutdown(1);
  });
  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    note(`${label} exited (${signal || code}); stopping the dev stack`);
    shutdown(code === 0 ? 0 : 1);
  });
  prefixStream(child.stdout, label);
  prefixStream(child.stderr, label);
  children.push(child);
  return child;
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) killTree(child);
  process.exit(code);
}

process.on('SIGINT', () => {
  note('Ctrl-C received, stopping api + web');
  shutdown(0);
});
process.on('SIGTERM', () => shutdown(0));

function main() {
  if (!fs.existsSync(VITE_ENTRY)) {
    console.error('[dev] node_modules/vite/bin/vite.js is missing.');
    console.error('[dev] install dependencies first:  npm install   (run at the repo root)');
    process.exit(1);
  }
  if (!fs.existsSync(path.join(WEB, 'vite.config.ts')) && !fs.existsSync(path.join(WEB, 'index.html'))) {
    console.error(`[dev] no Vite app found in ${WEB}`);
    process.exit(1);
  }

  const webPort = process.env.DY_WEB_PORT || '5173';
  note(`api  -> http://127.0.0.1:${process.env.DY_PORT || 8787}`);
  note(`web  -> http://127.0.0.1:${webPort} (proxies /api and /media to the api)`);

  start('api', process.execPath, ['--watch', 'src/index.js'], {
    cwd: SERVER,
    env: { ...process.env, FORCE_COLOR: useColor ? '1' : '0' },
    stdio: ['inherit', 'pipe', 'pipe'],
  });

  start('web', process.execPath, [VITE_ENTRY, '--port', webPort], {
    cwd: WEB,
    env: { ...process.env, FORCE_COLOR: useColor ? '1' : '0' },
    stdio: ['inherit', 'pipe', 'pipe'],
  });
}

main();
