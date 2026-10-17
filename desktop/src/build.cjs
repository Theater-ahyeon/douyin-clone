'use strict';
/**
 * npx-free electron-builder runner.
 *
 * electron-builder ships a plain JS entrypoint, so instead of the (banned)
 * `npx electron-builder` or the cmd.exe `.bin` shim, this resolves the package's
 * `bin` path from its own package.json and spawns it with the current Node.
 *
 *   node desktop/src/build.cjs --win                 # per electron-builder.yml targets
 *   node desktop/src/build.cjs --win --dir          # unpacked resources only, much faster
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const desktopDir = path.resolve(__dirname, '..');

function locateCli() {
  const literal = path.join(desktopDir, 'node_modules', 'electron-builder', 'package.json');
  let pkgPath = null;
  try {
    pkgPath = require.resolve('electron-builder/package.json');
  } catch {
    /* the exports map may hide it; the literal install path still works */
  }
  if (!pkgPath && fs.existsSync(literal)) pkgPath = literal;
  if (!pkgPath) throw new Error('electron-builder is not installed in desktop/ - run: cd desktop && npm install');

  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin && (pkg.bin['electron-builder'] || Object.values(pkg.bin)[0]);
  if (!bin) throw new Error(`${pkgPath} declares no bin entry`);
  const script = path.resolve(path.dirname(pkgPath), bin);
  if (!fs.existsSync(script)) throw new Error(`electron-builder entrypoint missing at ${script}`);
  return script;
}

let cli;
try {
  cli = locateCli();
} catch (error) {
  console.error(`[build] ${error.message}`);
  process.exit(1);
}

const args = process.argv.slice(2);
if (!args.length) args.push('--win');

const env = { ...process.env, USE_HARD_LINKS: 'false' };
delete env.ELECTRON_RUN_AS_NODE;

console.log(`[build] ${process.execPath} ${cli} ${args.join(' ')}  (cwd ${desktopDir})`);
const child = spawn(process.execPath, [cli, ...args], { cwd: desktopDir, env, stdio: 'inherit', windowsHide: true });
child.on('exit', (code, signal) => {
  if (signal) console.error(`[build] electron-builder terminated by ${signal}`);
  process.exit(code === null ? 1 : code);
});
child.on('error', (error) => {
  console.error(`[build] could not start electron-builder: ${error.message}`);
  process.exit(1);
});
