'use strict';
/**
 * npx-free launcher. `npx` is banned on this machine, and the `node_modules/.bin`
 * shims are cmd.exe files that behave differently under Git Bash, so this script
 * resolves Electron's own binary through the package (`require('electron')`
 * returns the path to electron.exe when run by plain Node) and spawns it with
 * this app directory.
 *
 *   node desktop/src/launch.cjs --dev     # window -> Vite (http://127.0.0.1:5173)
 *   node desktop/src/launch.cjs --prod    # fork the backend, window -> http://127.0.0.1:<DY_PORT>
 *   node desktop/src/launch.cjs --prod --smoke
 *
 * Pass-through: everything after the flags goes to Electron as-is, so
 * `node src/launch.cjs --prod -- --js-flags=...` style debugging still works.
 */

const path = require('node:path');
const { spawn } = require('node:child_process');

const flags = process.argv.slice(2);
const smoke = flags.includes('--smoke');
const forward = flags.filter((flag) => flag !== '--smoke');

let electronBinary;
try {
  electronBinary = require('electron');
} catch (error) {
  console.error('[launch] Electron is not installed in desktop/. Run:  cd desktop && npm install');
  console.error(`[launch] ${error.message}`);
  process.exit(1);
}
if (typeof electronBinary !== 'string') {
  console.error("[launch] require('electron') did not return a binary path - are you running this inside Electron itself?");
  process.exit(1);
}

const appDir = path.resolve(__dirname, '..');

/**
 * `ELECTRON_RUN_AS_NODE` must NOT leak into the child or the spawned binary
 * becomes plain Node and opens no window. npm lifecycle hooks set it in some
 * configurations, so it is cleared explicitly.
 */
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_NO_ASAR;
if (smoke) env.DY_DESKTOP_SMOKE = '1';

const args = [appDir, ...forward];
console.log(`[launch] ${electronBinary} ${args.join(' ')}`);

const child = spawn(electronBinary, args, { stdio: 'inherit', env, windowsHide: false });
child.on('error', (error) => {
  console.error(`[launch] failed to spawn Electron: ${error.message}`);
  process.exit(1);
});
child.on('exit', (code, signal) => {
  if (signal) console.error(`[launch] Electron exited on signal ${signal}`);
  process.exit(code === null ? 1 : code);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    try {
      child.kill(signal === 'SIGINT' ? 'SIGINT' : 'SIGTERM');
    } catch {
      /* already gone */
    }
  });
}
