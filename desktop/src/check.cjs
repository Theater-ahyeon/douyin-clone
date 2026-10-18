'use strict';
/**
 * `npm run check` - fast, GUI-free gate that protects the parts of this shell a
 * reviewer cannot eyeball:
 *
 *   1. every .cjs file parses (child_process `node --check`);
 *   2. the channel strings duplicated inside the sandboxed preload.cjs still
 *      match src/ipc-schema.cjs (a sandboxed preload cannot require local files,
 *      so the table is copied - this test is what keeps the copy honest);
 *   3. preload.cjs never references ipcRenderer outside its own two `on()`
 *      subscriptions and exposes only the allowlisted member names;
 *   4. every allowlisted channel actually has a handler / a sender, and the
 *      allowlists the preload copies by hand have not drifted;
 *   5. the hardened webPreferences are still there and no TLS bypass crept in;
 *   6. electron-builder.yml ships every module the main process and the forked
 *      child require, and nothing dev-only;
 *   7. the payload validators reject the shapes a compromised page would send.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const desktopDir = path.resolve(__dirname, '..');
const schema = require('./ipc-schema.cjs');

let failures = 0;
const ok = (label) => console.log(`  ok   ${label}`);
const bad = (label, detail) => {
  failures += 1;
  console.log(`  FAIL ${label}${detail ? ` - ${detail}` : ''}`);
};

function section(title) {
  console.log(`\n[${title}]`);
}

/* ---------------------------------------------------------------- 1. parse */

function cjsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...cjsFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.cjs')) out.push(full);
  }
  return out.sort();
}

section('node --check');
for (const file of cjsFiles(desktopDir)) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  const rel = path.relative(desktopDir, file).replace(/\\/g, '/');
  if (result.status === 0) ok(rel);
  else bad(rel, (result.stderr || result.stdout || '').trim().split('\n').slice(0, 3).join(' | '));
}

/* ------------------------------------------------- 2. channel table parity */

section('IPC channel parity (preload.cjs vs src/ipc-schema.cjs)');
const preloadSource = fs.readFileSync(path.join(desktopDir, 'preload.cjs'), 'utf8');
const expectedChannels = [...Object.values(schema.CHANNELS.invoke), ...Object.values(schema.CHANNELS.push)];

for (const channel of expectedChannels) {
  const inSchema = JSON.stringify(schema).includes(channel);
  const inPreload = preloadSource.includes(`'${channel}'`);
  if (inSchema && inPreload) ok(channel);
  else bad(channel, `schema=${inSchema} preload=${inPreload}`);
}

const preloadChannels = [...preloadSource.matchAll(/'desktop:[a-z-]+'/g)].map((m) => m[0].slice(1, -1));
const unknown = [...new Set(preloadChannels)].filter((c) => !expectedChannels.includes(c));
if (unknown.length === 0) ok('preload subscribes/invokes no channel outside the table');
else bad('preload references unlisted channels', unknown.join(', '));

/* ------------------------------------------------- 3. preload surface shape */

section('main.cjs channel references');
/* Regression guard: `CHANNELS.appInfo` (nested) vs `CH.appInfo` (flat) silently
   registered handlers under the key `undefined`, so every invoke from the page
   failed with "No handler registered". Any CH.x in main.cjs must resolve. */
const mainSource = fs.readFileSync(path.join(desktopDir, 'main.cjs'), 'utf8');
const mainChannelRefs = [...new Set([...mainSource.matchAll(/\bCH\.(\w+)/g)].map((m) => m[1]))];
if (!mainChannelRefs.length) bad('main.cjs channel references', 'none found - did the naming change?');
for (const ref of mainChannelRefs) {
  if (typeof schema.CH[ref] === 'string' && schema.CH[ref].startsWith('desktop:')) ok(`CH.${ref} -> ${schema.CH[ref]}`);
  else bad(`CH.${ref}`, 'does not resolve to a channel string');
}
const registeredHandlers = [...mainSource.matchAll(/(?:^|\n)\s*registerHandler\(\s*([^,]+),/g)]
  .map((m) => m[1].trim())
  .filter((expr) => expr !== 'channel'); // drop the function declaration itself
const unregistered = registeredHandlers.filter((expr) => !expr.startsWith('CH.'));
if (!unregistered.length) ok(`all ${registeredHandlers.length} ipcMain handlers use a named channel`);
else bad('registerHandler channel expressions', unregistered.join(', '));

/* An allowlisted channel with no handler hangs the renderer's await forever. */
for (const [key, channel] of Object.entries(schema.CHANNELS.invoke)) {
  const re = new RegExp(`registerHandler\\(\\s*CH\\.${key}\\b`);
  if (re.test(mainSource)) ok(`${channel} has a handler`);
  else bad(`${channel} has no ipcMain handler`, `preload can invoke it and never get an answer`);
}
/* A push channel nothing sends is dead weight in the allowlist; a name typo is
   silently ignored by the renderer. */
for (const [key, channel] of Object.entries(schema.CHANNELS.push)) {
  const re = new RegExp(`sendToRenderer\\(\\s*CH\\.${key}\\b`);
  if (re.test(mainSource)) ok(`${channel} is sent from main`);
  else bad(`${channel} is never sent`, 'no menu/producer path found in main.cjs');
}
const pushSubscriptions = [...preloadSource.matchAll(/ipcRenderer\.on\((CHANNELS\.\w+)/g)].map((m) => m[1]);
if (pushSubscriptions.length === 2) ok(`preload subscribes exactly the two push channels (${pushSubscriptions.join(', ')})`);
else bad('preload push subscriptions', `found ${pushSubscriptions.length}, expected 2`);
for (const ref of [...new Set([...mainSource.matchAll(/\bCHANNELS\.(\w+)/g)].map((m) => m[1]))]) {
  if (schema.CHANNELS[ref]) ok(`CHANNELS.${ref} resolves`);
  else bad(`CHANNELS.${ref}`, 'not a key of the schema table');
}

section('preload.cjs surface');
const exposeMatch = preloadSource.match(/exposeInMainWorld\('([^']+)'/);
if (exposeMatch && exposeMatch[1] === 'douyinDesktop') ok(`single global: window.${exposeMatch[1]}`);
else bad('exposeInMainWorld', exposeMatch ? exposeMatch[1] : 'not found');

const ipcRendererUses = [...preloadSource.matchAll(/ipcRenderer\.(\w+)/g)].map((m) => m[1]);
const allowedUses = new Set(['invoke', 'on']);
const uniqueUses = [...new Set(ipcRendererUses)];
if (uniqueUses.every((u) => allowedUses.has(u))) ok(`ipcRenderer only used via: ${uniqueUses.join(', ')}`);
else bad('ipcRenderer usage', uniqueUses.join(', '));

if (/Object\.freeze\(\{[^}]*ipcRenderer/.test(preloadSource)) bad('ipcRenderer object is exposed to the page');
else ok('ipcRenderer is never handed to the page');

if (preloadSource.includes('channel, ...args') || preloadSource.includes('(channel)')) {
  bad('a generic channel passthrough appears in preload.cjs');
} else {
  ok('no generic invoke(channel, ...) passthrough');
}

const bridgeBlockMatch = preloadSource.match(/const bridge = \{([\s\S]*?)\n\};/);
if (!bridgeBlockMatch) bad('bridge object', 'could not locate `const bridge = { ... }`');
const bridgeBlock = bridgeBlockMatch ? bridgeBlockMatch[1] : '';
const exposedMembers = [...bridgeBlock.matchAll(/^  (\w+):/gm)].map((m) => m[1]);
const expectedMembers = [
  'name', 'bridgeVersion', 'minimize', 'maximizeToggle', 'fullscreenToggle', 'closeWindow',
  'openExternal', 'notify', 'getAppInfo', 'getBackendInfo', 'onFeedAction', 'onNavigate',
];
const missingMembers = expectedMembers.filter((m) => !exposedMembers.includes(m));
const extraMembers = exposedMembers.filter((m) => !expectedMembers.includes(m));
if (!missingMembers.length && !extraMembers.length) ok(`bridge members exactly as documented (${exposedMembers.length})`);
else bad('bridge members', `missing=${missingMembers.join(',') || '-'} extra=${extraMembers.join(',') || '-'}`);

/* The two allowlists the sandboxed preload copies by hand: a drifted entry makes
   the preload drop a menu action (or accept one main never sends). */
section('preload allowlist parity');
for (const [name, expected] of [['FEED_ACTIONS', schema.FEED_ACTIONS], ['NAV_PATHS', schema.NAV_PATHS]]) {
  const literal = preloadSource.match(new RegExp(`const ${name} = Object\\.freeze\\(\\[([^\\]]*)\\]`));
  if (!literal) {
    bad(`preload ${name}`, 'not found as a frozen inline array');
    continue;
  }
  const got = [...literal[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  if (got.length === expected.length && got.every((v, i) => v === expected[i])) ok(`${name} matches src/ipc-schema.cjs`);
  else bad(`${name} drifted`, `preload=[${got.join(',')}] schema=[${expected.join(',')}]`);
}
const feedMenuBlock = mainSource.match(/const FEED_MENU_ITEMS = \[([\s\S]*?)\n\];/);
const navMenuBlock = mainSource.match(/const NAV_MENU_ITEMS = \[([\s\S]*?)\n\];/);
if (!feedMenuBlock || !navMenuBlock) bad('menu templates', 'FEED_MENU_ITEMS / NAV_MENU_ITEMS block not found');
const menuFeedActions = [...new Set([...(feedMenuBlock ? feedMenuBlock[1] : '').matchAll(/action: '(\w+)'/g)].map((m) => m[1]))];
const badFeed = menuFeedActions.filter((a) => !schema.FEED_ACTIONS.includes(a));
if (!menuFeedActions.length) bad('menu feed items', 'none parsed');
else if (!badFeed.length) ok(`menu feed items all allowlisted (${menuFeedActions.join(', ')})`);
else bad('menu uses actions outside the allowlist', badFeed.join(', '));
const menuRoutes = [...new Set([...(navMenuBlock ? navMenuBlock[1] : '').matchAll(/path: '(\/[\w-]*)'/g)].map((m) => m[1]))];
const badRoutes = menuRoutes.filter((p) => !schema.NAV_PATHS.includes(p));
if (!menuRoutes.length) bad('menu jump targets', 'none parsed');
else if (!badRoutes.length) ok(`menu jump targets all allowlisted (${menuRoutes.join(', ')})`);
else bad('menu routes outside the allowlist', badRoutes.join(', '));

section('webPreferences and certificate posture');
const dangerous = [
  [/nodeIntegration:\s*true/, 'nodeIntegration: true'],
  [/contextIsolation:\s*false/, 'contextIsolation: false'],
  [/sandbox:\s*false/, 'sandbox: false'],
  [/webSecurity:\s*false/, 'webSecurity: false'],
  [/allowRunningInsecureContent:\s*true/, 'allowRunningInsecureContent: true'],
  [/enableRemoteModule:\s*true/, 'enableRemoteModule: true'],
  [/'certificate-error'/, "a 'certificate-error' handler (TLS bypass)"],
  [/ignoreCertificateErrors|--ignore-certificate-errors/, 'an --ignore-certificate-errors switch'],
  [/webPreferences:\s*\{\s*\}/, 'an empty webPreferences block'],
];
for (const [re, label] of dangerous) {
  if (!re.test(mainSource)) ok(`no ${label}`);
  else bad(label);
}
for (const required of ['contextIsolation: true', 'nodeIntegration: false', 'sandbox: true', 'webSecurity: true']) {
  if (mainSource.includes(required)) ok(`webPreferences declares ${required}`);
  else bad('webPreferences', `${required} missing from the window options`);
}

/* ------------------------------------------------- packaging file list */

section('electron-builder.yml payload');
const builderSource = fs.readFileSync(path.join(desktopDir, 'electron-builder.yml'), 'utf8');
const filesBlock = builderSource.match(/^files:\n((?:[ \t]*-[ \t]*\S+[ \t]*\n)+)/m);
if (!filesBlock) bad('electron-builder files', 'no `-` list under `files:`');
const listed = new Set(
  (filesBlock ? filesBlock[1] : '')
    .split('\n')
    .map((line) => line.replace(/^[ \t]*-[ \t]*/, '').trim())
    .filter(Boolean)
);
const runtimeDeps = new Set();
for (const rel of ['main.cjs', 'preload.cjs', 'src/backend.cjs', 'src/child-server.cjs', 'src/window-state.cjs']) {
  const src = fs.readFileSync(path.join(desktopDir, rel), 'utf8');
  for (const m of src.matchAll(/require\(['"](\.[^'"]+\.cjs)['"]\)/g)) {
    runtimeDeps.add(path.relative(desktopDir, path.resolve(path.dirname(path.join(desktopDir, rel)), m[1])).replace(/\\/g, '/'));
  }
  for (const m of src.matchAll(/'src',\s*'([\w-]+\.cjs)'/g)) runtimeDeps.add(`src/${m[1]}`);
}
const notShipped = [...runtimeDeps].filter((f) => !listed.has(f));
if (!notShipped.length) ok(`every runtime module is in files: (${[...runtimeDeps].sort().join(', ')})`);
else bad('runtime modules missing from files:', notShipped.join(', '));
for (const devOnly of ['src/launch.cjs', 'src/build.cjs', 'src/check.cjs']) {
  if (!listed.has(devOnly)) ok(`${devOnly} stays out of the package`);
  else bad('dev-only file shipped', devOnly);
}
if (listed.has('build/icon.png')) ok('build/icon.png shipped (the window/taskbar icon reads it at runtime)');
else bad('build/icon.png missing from files:', 'main.cjs falls back to the Electron default icon');
for (const needed of ['asar: false', 'backend/server/src', 'backend/web/dist', 'backend-data-seed']) {
  if (builderSource.includes(needed)) ok(`packaging declares ${needed}`);
  else bad('packaging', `${needed} missing - the packaged layout cannot be resolved`);
}
const appIds = [...builderSource.matchAll(/^appId:\s*(\S+)/gm)].map((m) => m[1]);
const pkg = JSON.parse(fs.readFileSync(path.join(desktopDir, 'package.json'), 'utf8'));
if (appIds.includes(pkg.appId)) ok(`appId agrees with package.json (${pkg.appId})`);
else bad('appId mismatch', `yml=${appIds.join('/')} package.json=${pkg.appId}`);
if (!/\.?douyin\.com/i.test(appIds.join(' '))) ok('appId claims no third-party domain');
else bad('appId squats a third-party domain', appIds.join(' '));

/* -------------------------------------------------- validator behaviour */

section('validator unit tests');
const APP_ORIGIN = 'http://127.0.0.1:8798';
const cases = [
  ['windowControl minimize', schema.validateWindowControl({ action: 'minimize' }), true],
  ['windowControl close', schema.validateWindowControl({ action: 'close' }), true],
  ['windowControl arbitrary action', schema.validateWindowControl({ action: 'destroyEverything' }), false],
  ['windowControl with extra key', schema.validateWindowControl({ action: 'close', target: 1 }), false],
  ['windowControl string', schema.validateWindowControl('close'), false],
  ['openExternal https', schema.validateExternalUrl({ url: 'https://www.douyin.com/' }, { appOrigin: APP_ORIGIN }), true],
  ['openExternal app origin refused', schema.validateExternalUrl({ url: `${APP_ORIGIN}/follow` }, { appOrigin: APP_ORIGIN }), false],
  ['openExternal javascript: refused', schema.validateExternalUrl({ url: 'javascript:alert(1)' }, { appOrigin: APP_ORIGIN }), false],
  ['openExternal file: refused', schema.validateExternalUrl({ url: 'file:///C:/Windows/System32/cmd.exe' }, { appOrigin: APP_ORIGIN }), false],
  ['openExternal credentials refused', schema.validateExternalUrl({ url: 'https://user:pw@example.com/' }, { appOrigin: APP_ORIGIN }), false],
  ['openExternal relative refused', schema.validateExternalUrl({ url: '/relative' }, { appOrigin: APP_ORIGIN }), false],
  ['openExternal garbage refused', schema.validateExternalUrl({ url: 'ht' }, { appOrigin: APP_ORIGIN }), false],
  ['openExternal oversized url refused', schema.validateExternalUrl({ url: `https://a.com/${'x'.repeat(3000)}` }, { appOrigin: APP_ORIGIN }), false],
  ['notify title only', schema.validateNotify({ title: '新消息' }), true],
  ['notify full shape', schema.validateNotify({ title: 'a', body: 'b', silent: true }), true],
  ['notify missing title', schema.validateNotify({ body: 'b' }), false],
  ['notify non-boolean silent', schema.validateNotify({ title: 'a', silent: 1 }), false],
  ['notify control chars', schema.validateNotify({ title: 'a\u0007b' }), false],
  ['notify oversized body', schema.validateNotify({ title: 'a', body: 'x'.repeat(5000) }), false],
  ['notify unexpected key', schema.validateNotify({ title: 'a', icon: 'http://evil/' }), false],
  ['feedAction next', schema.validateFeedAction({ action: 'next' }), true],
  ['feedAction executeJavaScript', schema.validateFeedAction({ action: 'eval' }), false],
  ['navigate /follow', schema.validateNavigate({ path: '/follow' }), true],
  ['navigate /../../etc', schema.validateNavigate({ path: '/../../etc' }), false],
  ['navigate javascript url', schema.validateNavigate({ path: 'javascript:alert(1)' }), false],
  ['navigate data url', schema.validateNavigate({ path: 'data:text/html,hi' }), false],
];

for (const [label, result, wantOk] of cases) {
  if (result.ok === wantOk) ok(`${label} -> ${wantOk ? 'accepted' : 'rejected'} (${result.reason || 'ok'})`);
  else bad(label, `expected ok=${wantOk}, got ok=${result.ok} (${result.reason || 'accepted'})`);
}

section('envelope guard');
const envelopes = [
  ['undefined', undefined, true],
  ['{}', {}, true],
  ['array', [1, 2], false],
  ['string', 'hello', true],
  ['oversized string', 'x'.repeat(5000), false],
  ['object with 20 keys', Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, i])), false],
  ['deep blob', { a: 'x'.repeat(9000) }, false],
];
for (const [label, payload, want] of envelopes) {
  const got = schema.envelopeLooksSane(payload);
  if (got === want) ok(`${label} -> ${got}`);
  else bad(label, `expected ${want}, got ${got}`);
}

section('origin guard');
const originCases = [
  [`${APP_ORIGIN}/follow`, APP_ORIGIN, true],
  ['http://localhost:5173/', APP_ORIGIN, false],
  ['file:///C:/x.html', APP_ORIGIN, false],
  ['data:text/html,<script>', APP_ORIGIN, false],
  ['', APP_ORIGIN, false],
  ['not a url', APP_ORIGIN, false],
];
for (const [url, origin, want] of originCases) {
  const got = schema.isSameAppOrigin(url, origin);
  if (got === want) ok(`${JSON.stringify(url)} -> ${got}`);
  else bad(JSON.stringify(url), `expected ${want}, got ${got}`);
}

/* ---------------------------------------------------------------- report */

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
