'use strict';
/**
 * Douyin Clone - Windows desktop shell (Electron main process).
 *
 * Two launch modes, chosen by argv/env:
 *   dev   the window points at the Vite dev server (http://127.0.0.1:5173),
 *         which already proxies /api and /media to the running backend.
 *   prod  forks src/child-server.cjs (the repo's own `startServer({ staticDir })`
 *         serving path), waits until GET /api/feed answers, then loads
 *         http://127.0.0.1:<DY_PORT>.
 *
 * Security posture:
 *   - contextIsolation on, nodeIntegration off, sandbox on, no remote module;
 *   - the renderer reaches main only through the named functions preload.cjs
 *     exposes; every payload is re-validated here against src/ipc-schema.cjs
 *     before any privileged call, and the sender must be the main window's
 *     app-origin frame;
 *   - navigation is pinned to the app origin, window.open is denied (external
 *     http(s) is handed to the OS browser instead), every session permission is
 *     denied except notifications from the app origin.
 */

const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');

const { app, BrowserWindow, dialog, ipcMain, Menu, Notification, session, shell } = require('electron');

const {
  CH,
  envelopeLooksSane,
  isSameAppOrigin,
  validateExternalUrl,
  validateFeedAction,
  validateNavigate,
  validateNotify,
  validateWindowControl,
} = require('./src/ipc-schema.cjs');
const { resolveLayout, seedDataDir, startEmbeddedBackend, stopEmbeddedBackend } = require('./src/backend.cjs');
const { loadingPage } = require('./src/loading-page.cjs');
const { DEFAULT_BOUNDS, MINIMUM, WindowStateStore } = require('./src/window-state.cjs');

const PRODUCT_NAME = 'Douyin Clone';
const APP_ID = 'com.douyinclone.desktop';
const DESKTOP_DIR = __dirname;

const argv = process.argv.slice(1);
const hasFlag = (name) => argv.includes(`--${name}`);
const envFlagOn = (name) => process.env[name] === '1' || process.env[name] === 'true';

const wantsDev = hasFlag('dev') || process.env.DY_DESKTOP_MODE === 'dev';
const MODE = wantsDev ? 'dev' : 'prod';
const TARGET_URL_OVERRIDE = (process.env.DY_DESKTOP_URL || '').trim();
const ALLOW_DEVTOOLS = MODE === 'dev' || envFlagOn('DY_DESKTOP_DEVTOOLS');
const SMOKE = envFlagOn('DY_DESKTOP_SMOKE');
const SMOKE_MS = Math.min(Math.max(Number(process.env.DY_DESKTOP_SMOKE_MS || 2500), 800), 120000);

const state = {
  win: null,
  layout: null,
  backend: null,
  appUrl: '',
  appOrigin: '',
  internalUrls: new Set(),
  shuttingDown: false,
  starting: false,
  smokeDone: false,
};

/* ------------------------------------------------------------------ logging */

function log(...parts) {
  console.log('[desktop]', ...parts);
}

/* ------------------------------------------------------------ small helpers */

function parseUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function portOf(parsed) {
  if (!parsed) return '';
  return parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
}

/** GET probe against any http(s) target, used before the window navigates. */
function probeTarget(target, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const parsed = parseUrl(target);
    if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) return resolve(false);
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request(
      { host: parsed.hostname, port: portOf(parsed), path: parsed.pathname + parsed.search, method: 'GET', timeout: timeoutMs },
      (res) => {
        res.resume();
        res.on('end', () => resolve(true));
      }
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
    req.end();
  });
}

function iconPath() {
  const candidates = [path.join(DESKTOP_DIR, 'build', 'icon.ico'), path.join(DESKTOP_DIR, 'build', 'icon.png')];
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

/** Frames the shell trusts: the app origin, and the loading page we drew ourselves. */
function frameAllowed(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl) return false;
  if (state.internalUrls.has(rawUrl)) return true;
  if (isSameAppOrigin(rawUrl, state.appOrigin)) return true;
  // Vite answers on both 127.0.0.1 and localhost, and server/src/config.js
  // allowlists both for CORS. Keep that twin usable in dev, nothing else.
  if (MODE === 'dev' && state.appOrigin) {
    const parsed = parseUrl(state.appOrigin);
    return isSameAppOrigin(rawUrl, `http://localhost:${portOf(parsed)}`);
  }
  return false;
}

/**
 * IPC is stricter than navigation: the loading/error page we paint is trusted to
 * be displayed, never to be handed `openExternal`/`notify`/window control. A
 * data: URL has an opaque origin, so nothing there ever needs the bridge.
 */
function ipcFrameAllowed(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl) return false;
  if (state.internalUrls.has(rawUrl)) return false;
  return frameAllowed(rawUrl);
}

/* ------------------------------------------------------- external and guards */

function maybeOpenExternal(rawUrl) {
  const checked = validateExternalUrl({ url: rawUrl }, { appOrigin: state.appOrigin });
  if (!checked.ok) {
    log(`blocked external hand-off (${String(rawUrl).slice(0, 120)}): ${checked.reason}`);
    return false;
  }
  return shell
    .openExternal(checked.value.url)
    .then(() => {
      log(`opened in system browser: ${checked.value.origin}`);
      return true;
    })
    .catch((error) => {
      log(`shell.openExternal failed: ${error.message}`);
      return false;
    });
}

function hardenWebContents(contents) {
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) maybeOpenExternal(url);
    else log(`denied window.open for a non-http url: ${String(url).slice(0, 120)}`);
    return { action: 'deny' };
  });

  contents.on('will-navigate', (event, url) => {
    if (frameAllowed(url)) return;
    event.preventDefault();
    log(`blocked will-navigate -> ${String(url).slice(0, 160)}`);
    if (/^https?:/i.test(url)) maybeOpenExternal(url);
  });

  // Electron 30+: sub-frame navigations get their own veto.
  if (typeof contents.on === 'function') {
    contents.on('will-frame-navigate', (event) => {
      if (frameAllowed(event.url)) return;
      event.preventDefault();
      log(`blocked sub-frame -> ${String(event.url).slice(0, 160)}`);
    });
  }

  contents.on('context-menu', (_event, params) => {
    const items = [];
    if (params.selectionText) items.push({ label: '复制', role: 'copy' });
    if (params.linkURL && !isSameAppOrigin(params.linkURL, state.appOrigin)) {
      items.push({ label: '在浏览器中打开链接', click: () => maybeOpenExternal(params.linkURL) });
    }
    if (!items.length) return;
    const win = state.win;
    if (win && !win.isDestroyed()) Menu.buildFromTemplate(items).popup({ window: win });
  });

  contents.on('did-fail-load', (_e, errorCode, errorText, validatedUrl, isMainFrame) => {
    if (errorCode === -3 /* ERR_ABORTED: a navigation we replaced ourselves */) return;
    log(`did-fail-load ${validatedUrl} ${errorCode} ${errorText} mainFrame=${isMainFrame}`);
    if (isMainFrame && !state.shuttingDown) {
      showLoading({ tone: 'error', title: '无法连接到本地服务', detail: `${errorText} (${errorCode})`, hint: state.appUrl });
    }
  });

  contents.on('render-process-gone', (_e, details) => {
    log(`render-process-gone ${JSON.stringify(details)}`);
    if (!state.shuttingDown) showLoading({ tone: 'error', title: '渲染进程已退出', detail: String(details.reason), hint: state.appUrl });
  });

  contents.on('unresponsive', () => log('render process unresponsive'));
  contents.on('responsive', () => log('render process responsive'));
}

/** Deny every session permission except notifications, and only for our origin. */
function lockdownPermissions() {
  const handler = (permissionRequestingOrigin, permission, callback) => {
    const allowed = permission === 'notifications' && permissionRequestingOrigin === state.appOrigin;
    if (!allowed) log(`permission denied: ${permission} from ${permissionRequestingOrigin}`);
    callback(allowed);
  };
  session.defaultSession.setPermissionRequestHandler(handler);
  session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
    return permission === 'notifications' && requestingOrigin === state.appOrigin;
  });
}

/* ------------------------------------------------------------------ windows */

function showLoading(options) {
  const win = state.win;
  const page = loadingPage(options);
  state.internalUrls.add(page.url);
  if (!win || win.isDestroyed()) return;
  win.loadURL(page.url).catch((error) => log(`loading page failed: ${error.message}`));
}

function createWindow(store) {
  const bounds = store.resolveBounds();
  const restoreMaximized = store.isMaximized();
  const icon = iconPath();
  log(`window icon = ${icon || 'Electron default (build/icon.png missing)'}`);

  const win = new BrowserWindow({
    ...bounds,
    minWidth: MINIMUM.width,
    minHeight: MINIMUM.height,
    show: false,
    title: PRODUCT_NAME,
    backgroundColor: '#0b0b0f',
    autoHideMenuBar: false,
    ...(icon ? { icon } : {}),
    webPreferences: {
      preload: path.join(DESKTOP_DIR, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      spellcheck: false,
      devTools: ALLOW_DEVTOOLS,
    },
  });

  win.setTitle(PRODUCT_NAME);
  if (restoreMaximized) win.maximize();

  /* ---- keep the frame geometry in the JSON store ---- */
  let saveTimer = null;
  const scheduleSave = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      persistGeometry(win, store);
    }, 300);
  };
  win.on('resize', scheduleSave);
  win.on('move', scheduleSave);
  win.on('maximize', scheduleSave);
  win.on('unmaximize', scheduleSave);
  win.on('close', () => {
    if (saveTimer) clearTimeout(saveTimer);
    persistGeometry(win, store);
  });

  /* The page owns its own <title>; keep the product name on the frame. */
  win.on('page-title-updated', (event, title) => {
    event.preventDefault();
    win.setTitle(`${title} · ${PRODUCT_NAME}`);
  });

  win.once('ready-to-show', () => {
    win.show();
    log(`window shown ${win.getBounds().width}x${win.getBounds().height} maximized=${win.isMaximized()}`);
  });

  win.webContents.on('dom-ready', () => log(`dom-ready ${win.webContents.getURL()}`));
  win.webContents.on('did-finish-load', () => log(`did-finish-load ${win.webContents.getURL()}`));
  win.webContents.on('did-navigate-in-page', (_e, url) => log(`did-navigate-in-page ${url}`));

  // The menu and every IPC gate read this at call time, so a window that is
  // destroyed mid-handler can never be touched through the saved reference.
  win.on('closed', () => {
    if (state.win === win) state.win = null;
  });

  return win;
}

function persistGeometry(win, store) {
  if (!win || win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
  store.write({ bounds: win.getBounds(), maximized: win.isMaximized(), fullscreen: false });
}

/* ------------------------------------------------------------------- the IPC */

/** Only the main window's app-origin frame may ask for anything. */
function rejectUntrusted(event) {
  const win = state.win;
  if (!win || win.isDestroyed()) return 'no window';
  if (!event.sender || event.sender.id !== win.webContents.id) return 'sender is not the main window';
  const frameUrl = event.senderFrame && event.senderFrame.url;
  if (!ipcFrameAllowed(frameUrl)) return `frame origin not allowed: ${String(frameUrl).slice(0, 90)}`;
  return null;
}

function registerHandler(channel, validate, action) {
  // A mistyped/undefined channel would otherwise register under the key
  // `undefined` and every call from the page would fail with a confusing
  // "No handler registered" - fail loudly at boot instead.
  if (typeof channel !== 'string' || !Object.values(CH).includes(channel)) {
    throw new Error(`refusing to register a handler for a non-channel value: ${String(channel)}`);
  }
  ipcMain.removeHandler(channel);
  ipcMain.handle(channel, async (event, payload) => {
    const untrusted = rejectUntrusted(event);
    if (untrusted) {
      log(`rejected ${channel}: ${untrusted}`);
      return { ok: false, reason: 'untrusted sender' };
    }
    if (!envelopeLooksSane(payload)) {
      log(`rejected ${channel}: envelope rejected`);
      return { ok: false, reason: 'malformed envelope' };
    }
    const checked = validate(payload);
    if (!checked.ok) {
      log(`rejected ${channel}: ${checked.reason}`);
      return { ok: false, reason: checked.reason };
    }
    try {
      const value = await action(checked.value);
      return { ok: true, value: value === undefined ? null : value };
    } catch (error) {
      log(`${channel} threw: ${(error && error.message) || error}`);
      return { ok: false, reason: 'handler failed' };
    }
  });
}

function applyWindowControl(action) {
  const win = state.win;
  if (!win || win.isDestroyed()) return { action, applied: false };
  switch (action) {
    case 'minimize':
      win.minimize();
      break;
    case 'toggleMaximize':
      if (win.isMaximized()) win.unmaximize();
      else win.maximize();
      break;
    case 'toggleFullscreen':
      win.setFullScreen(!win.isFullScreen());
      break;
    case 'close':
      win.close();
      break;
    default:
      return { action, applied: false };
  }
  return { action, applied: true };
}

function registerIpc() {
  registerHandler(CH.windowControl, validateWindowControl, ({ action }) => applyWindowControl(action));

  registerHandler(
    CH.openExternal,
    (payload) => validateExternalUrl(payload, { appOrigin: state.appOrigin }),
    ({ url }) =>
      shell.openExternal(url).then(() => {
        log(`shell.openExternal ${String(parseUrl(url) && parseUrl(url).origin)}`);
        return { opened: true };
      })
  );

  registerHandler(CH.notify, validateNotify, ({ title, body, silent }) => {
    if (!Notification.isSupported()) throw new Error('notifications unsupported on this platform');
    new Notification({ title, body, silent: Boolean(silent) }).show();
    log(`notification shown: ${title.slice(0, 40)}`);
    return { shown: true };
  });

  registerHandler(CH.appInfo, () => ({ ok: true, value: {} }), () => ({
    productName: PRODUCT_NAME,
    appId: APP_ID,
    version: app.getVersion(),
    mode: MODE,
    packaged: app.isPackaged,
    platform: process.platform,
    arch: process.arch,
    versions: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node },
  }));

  /* Deliberately no filesystem paths here: a page only learns where the API is. */
  registerHandler(CH.backendInfo, () => ({ ok: true, value: {} }), () => ({
    url: state.appUrl,
    host: state.backend ? state.backend.host : null,
    port: state.backend ? state.backend.port : null,
    embedded: Boolean(state.backend && state.backend.child),
    reused: Boolean(state.backend && state.backend.reused),
    pid: state.backend && state.backend.child ? state.backend.child.pid : null,
  }));
}

function sendToRenderer(channel, payload, validate) {
  if (typeof channel !== 'string' || !Object.values(CH).includes(channel)) {
    log(`refusing to send on a non-channel value: ${String(channel)}`);
    return false;
  }
  const win = state.win;
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return false;
  const checked = validate(payload);
  if (!checked.ok) {
    log(`refused to send ${channel}: ${checked.reason}`);
    return false;
  }
  win.webContents.send(channel, checked.value);
  return true;
}

const pushFeedAction = (action) => sendToRenderer(CH.feedAction, { action }, validateFeedAction);
const pushNavigate = (route) => sendToRenderer(CH.navigate, { path: route }, validateNavigate);

/* -------------------------------------------------------------------- menu */

const FEED_MENU_ITEMS = [
  { action: 'playPause', label: '播放 / 暂停', pageKey: '空格', accelerator: 'CmdOrCtrl+Alt+P' },
  { action: 'previous', label: '上一条', pageKey: 'K / ↑', accelerator: 'CmdOrCtrl+Alt+Up' },
  { action: 'next', label: '下一条', pageKey: 'J / ↓', accelerator: 'CmdOrCtrl+Alt+Down' },
  { action: 'previous', label: '上一条（备用）', pageKey: 'K', accelerator: 'CmdOrCtrl+Alt+K' },
  { action: 'next', label: '下一条（备用）', pageKey: 'J', accelerator: 'CmdOrCtrl+Alt+J' },
  { action: 'toggleSound', label: '静音开关', pageKey: 'M', accelerator: 'CmdOrCtrl+Alt+M' },
];

const NAV_MENU_ITEMS = [
  { path: '/', label: '推荐', accelerator: 'CmdOrCtrl+Alt+1' },
  { path: '/follow', label: '关注', accelerator: 'CmdOrCtrl+Alt+2' },
  { path: '/messages', label: '消息', accelerator: 'CmdOrCtrl+Alt+3' },
  { path: '/my', label: '我的', accelerator: 'CmdOrCtrl+Alt+4' },
  { path: '/upload', label: '上传', accelerator: 'CmdOrCtrl+Alt+5' },
  { path: '/search', label: '搜索', accelerator: 'CmdOrCtrl+Alt+6' },
];

function buildMenu() {
  const template = [
    {
      label: '文件(&F)',
      submenu: [
        { label: '重新加载', accelerator: 'CmdOrCtrl+R', click: () => void reloadTarget(false) },
        { label: '强制重新加载', accelerator: 'CmdOrCtrl+Shift+R', click: () => void reloadTarget(true) },
        { label: '在系统浏览器中打开', accelerator: 'CmdOrCtrl+Shift+B', click: () => maybeOpenExternal(state.appUrl) },
        { type: 'separator' },
        {
          label: '后端状态…',
          click: () => {
            const backend = state.backend;
            dialog.showMessageBox(state.win || undefined, {
              type: 'info',
              title: '后端状态',
              message: backend && backend.child ? `内嵌后端运行中 (pid ${backend.child.pid})` : '复用已在监听的后端',
              detail: [
                `地址: ${state.appUrl}`,
                `模式: ${MODE}${app.isPackaged ? ' (packaged)' : ' (source)'}`,
                `数据目录: ${state.layout ? state.layout.dataDir : '-'}`,
              ].join('\n'),
              buttons: ['好的'],
            });
          },
        },
        { role: 'quit', label: '退出(&Q)' },
      ],
    },
    {
      label: '编辑(&E)',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'delete', label: '删除' },
        { type: 'separator' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '播放(&P)',
      submenu: [
        ...FEED_MENU_ITEMS.map((item) => ({
          label: `${item.label}  ${item.pageKey}`,
          accelerator: item.accelerator,
          click: () => pushFeedAction(item.action),
        })),
      ],
    },
    {
      label: '视图(&V)',
      submenu: [
        { role: 'togglefullscreen', label: '全屏' },
        { role: 'minimize', label: '最小化' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { role: 'resetZoom', label: '实际大小' },
        { type: 'separator' },
        { label: '开发者工具', accelerator: 'CmdOrCtrl+Shift+I', enabled: ALLOW_DEVTOOLS, click: () => state.win && state.win.webContents.toggleDevTools() },
        { type: 'separator' },
        {
          label: '跳转',
          submenu: NAV_MENU_ITEMS.map((item) => ({
            label: item.label,
            accelerator: item.accelerator,
            click: () => pushNavigate(item.path),
          })),
        },
      ],
    },
    {
      label: '帮助(&H)',
      submenu: [
        {
          label: '键盘快捷键',
          click: () => {
            dialog.showMessageBox(state.win || undefined, {
              type: 'info',
              title: '键盘快捷键',
              message: '直接在页面按下以下按键即可（无需 Ctrl+Alt）：',
              detail: [
                '空格          播放 / 暂停',
                'J  或  ↓      下一条',
                'K  或  ↑      上一条',
                'M             静音开关',
                'Ctrl + K      定位到搜索框',
                'Esc           关闭评论抽屉 / 登录面板',
                '',
                '「播放」菜单的 Ctrl+Alt+P / ↑ / ↓ / M 与上面的按键等价，',
                '它们经 IPC 通道 desktop:feed-action 送回页面，由 preload 还原成对应按键。',
              ].join('\n'),
              buttons: ['知道了'],
            });
          },
        },
        {
          label: '关于 Douyin Clone',
          click: () => {
            const v = process.versions;
            const backend = state.backend;
            dialog.showMessageBox(state.win || undefined, {
              type: 'info',
              title: `关于 ${PRODUCT_NAME}`,
              message: `${PRODUCT_NAME} ${app.getVersion()}`,
              detail: [
                `服务地址: ${state.appUrl}`,
                `后端: ${backend && backend.child ? `内嵌 (pid ${backend.child.pid})` : '复用已在监听的服务'}`,
                `Electron ${v.electron} / Chromium ${v.chrome} / Node ${v.node}`,
              ].join('\n'),
              buttons: ['好的'],
            });
          },
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  log(`application menu installed (${template.length} top-level menus)`);
}

/* ------------------------------------------------------------------- smoke */

/**
 * DY_DESKTOP_SMOKE=1 - machine-checkable proof the shell really rendered, plus
 * four attempts the bridge is supposed to refuse. Runs in the page's MAIN
 * world, i.e. exactly what a compromised page could reach.
 */
const SMOKE_SCRIPT = `(async () => {
  const d = window.douyinDesktop || {};
  const probe = {
    url: location.href,
    title: document.title,
    bodyTextChars: (document.body && document.body.innerText || '').length,
    bridge: typeof d.getAppInfo,
    bridgeKeys: Object.keys(d).sort(),
    leakedRequire: typeof window.require,
    leakedProcess: typeof window.process,
    leakedIpcRenderer: typeof window.ipcRenderer,
    leakedModule: typeof window.module
  };
  const calls = {};
  if (typeof d.getAppInfo === 'function') calls.appInfo = await d.getAppInfo();
  if (typeof d.getBackendInfo === 'function') calls.backendInfo = await d.getBackendInfo();
  if (typeof d.openExternal === 'function') {
    calls.rejectJavascriptUrl = await d.openExternal('javascript:alert(1)');
    calls.rejectFileUrl = await d.openExternal('file:///C:/Windows/System32/cmd.exe');
    calls.rejectAppOrigin = await d.openExternal(location.origin + '/');
  }
  if (typeof d.notify === 'function') calls.rejectControlChars = await d.notify('bad\\u0007title', 'body');
  return JSON.stringify({ probe, calls });
})()`;

const SMOKE_API_SCRIPT = `(async () => {
  const r = await fetch('/api/feed?limit=1', { headers: { accept: 'application/json' } });
  const j = await r.json().catch(() => null);
  return JSON.stringify({ status: r.status, keys: Object.keys(j || {}).slice(0, 8), items: j && j.items ? j.items.length : -1 });
})()`;

/* Installs page-side listeners so the main->renderer push path is observable. */
const SMOKE_PUSH_SETUP = `(() => {
  window.__smokeFeed = [];
  window.__smokeKeys = [];
  window.addEventListener('keydown', (event) => {
    window.__smokeKeys.push({ key: event.key, code: event.code, trusted: event.isTrusted });
  });
  if (window.douyinDesktop && typeof window.douyinDesktop.onFeedAction === 'function') {
    window.douyinDesktop.onFeedAction((payload) => window.__smokeFeed.push(payload.action));
  }
  if (window.douyinDesktop && typeof window.douyinDesktop.onNavigate === 'function') {
    window.douyinDesktop.onNavigate((payload) => { window.__smokeNav = payload.path; });
  }
  return 'listeners installed';
})()`;

const SMOKE_PUSH_READ = `JSON.stringify({
  feed: window.__smokeFeed,
  keys: window.__smokeKeys.slice(-4),
  nav: window.__smokeNav || null,
  hash: location.hash
})`;

/*
 * Attempts to leave the app origin, chosen so that the shell's OWN handlers are
 * what stops them (and so an automated run never hands a URL to the system
 * browser, which is the designed fate of a blocked http(s) navigation):
 *   - window.open('about:blank')      -> setWindowOpenHandler must deny it;
 *   - an iframe at another origin     -> will-frame-navigate must block it;
 *   - a file: top-level navigation    -> must not change location.href.
 */
const SMOKE_GUARD_ATTEMPTS = `(async () => {
  const before = location.href;
  window.__guard = {};
  try {
    const popup = window.open('about:blank', '_blank');
    window.__guard.popup = popup === null ? 'null' : 'object';
  } catch (error) { window.__guard.popup = 'threw: ' + error.message; }
  try {
    const frame = document.createElement('iframe');
    frame.src = 'http://127.0.0.1:9/escape-attempt';
    frame.id = 'guard-frame';
    document.body.appendChild(frame);
    window.__guard.frameAttached = Boolean(document.getElementById('guard-frame'));
  } catch (error) { window.__guard.frameAttached = 'threw: ' + error.message; }
  try { location.assign('file:///C:/Windows/win.ini'); } catch (error) { window.__guard.navThrew = error.message; }
  await new Promise((resolve) => setTimeout(resolve, 700));
  const frame2 = document.getElementById('guard-frame');
  // A blocked frame keeps an empty same-origin about:blank document; if the
  // number were the target origin instead, the guard had leaked.
  let frameHref = 'no frame';
  try {
    frameHref = frame2 && frame2.contentDocument ? frame2.contentDocument.location.href : 'cross-origin (unreadable)';
  } catch (error) {
    frameHref = 'unreadable: ' + error.name;
  }
  return JSON.stringify({ before, after: location.href, changed: before !== location.href, guard: window.__guard, frameHref });
})()`;

async function probePushPaths(win) {
  try {
    await win.webContents.executeJavaScript(SMOKE_PUSH_SETUP, true);
  } catch (error) {
    log(`smoke push setup failed: ${(error && error.message) || error}`);
    return;
  }
  const bogusRefused = pushFeedAction('eval'); // main must refuse an unknown action
  const feedSent = pushFeedAction('next');
  const navSent = pushNavigate('/follow');
  await new Promise((resolve) => setTimeout(resolve, 400));
  try {
    const readback = await win.webContents.executeJavaScript(SMOKE_PUSH_READ, true);
    log(`smoke push probe bogusRefused=${bogusRefused} feedSent=${feedSent} navSent=${navSent} page=${readback}`);
  } catch (error) {
    log(`smoke push readback failed: ${(error && error.message) || error}`);
  }
}

async function runSmoke(win) {
  if (state.smokeDone) return;
  state.smokeDone = true;
  try {
    log(`smoke bridge probe ${await win.webContents.executeJavaScript(SMOKE_SCRIPT, true)}`);
    log(`smoke api probe ${await win.webContents.executeJavaScript(SMOKE_API_SCRIPT, true)}`);
    await probePushPaths(win);
    log(`smoke guard probe ${await win.webContents.executeJavaScript(SMOKE_GUARD_ATTEMPTS, true)}`);
  } catch (error) {
    log(`smoke probe failed: ${(error && error.message) || error}`);
  }
  log(`[desktop] smoke complete; quitting in ${SMOKE_MS}ms`);
  const timer = setTimeout(() => app.quit(), SMOKE_MS);
  if (timer.unref) timer.unref();
}

/* ------------------------------------------------------------------ launch */

/** A failed boot must not leave a GUI process behind when nobody is watching. */
function maybeSmokeAbort(reason) {
  if (!SMOKE) return;
  state.smokeDone = true;
  log(`smoke aborting (${reason}); quitting in ${SMOKE_MS}ms`);
  const timer = setTimeout(() => app.quit(), Math.min(SMOKE_MS, 1500));
  if (timer.unref) timer.unref();
}

function targetUrlFor(layout) {
  if (TARGET_URL_OVERRIDE) return TARGET_URL_OVERRIDE;
  if (MODE === 'dev') return process.env.DY_DESKTOP_DEV_URL || `http://127.0.0.1:${Number(process.env.DY_WEB_PORT || 5173)}`;
  return `http://${layout.host}:${layout.port}`;
}

/** A dev target or an explicit DY_DESKTOP_URL is not ours to start. */
function usesExternalTarget() {
  return MODE === 'dev' || Boolean(TARGET_URL_OVERRIDE);
}

/**
 * Book the child the instant `fork()` returns. Until startEmbeddedBackend
 * resolves, `state.backend` would otherwise be null, and a quit (or a boot that
 * then fails) in that window would leave an orphan holding the port.
 */
function adoptBackendChild(child) {
  state.backend = { child, host: state.layout.host, port: state.layout.port, reused: false };
}

async function startBackend(layout) {
  state.starting = true;
  try {
    state.backend = await startEmbeddedBackend({ layout, log, onChild: adoptBackendChild });
    // A remote/DY_DESKTOP_URL target keeps its own origin; the embedded one is exact.
    state.appUrl = `http://${state.backend.host}:${state.backend.port}`;
    state.appOrigin = new URL(state.appUrl).origin;
  } finally {
    state.starting = false;
  }
}

/**
 * Reload the app for real. `role: 'reload'` only re-paints the data: URL we drew
 * ourselves, so a backend that failed to come up would be unrecoverable; this
 * re-probes the target and forks a new backend if the old one died.
 */
let retrying = false;
async function reloadTarget(hard) {
  const win = state.win;
  if (!win || win.isDestroyed() || state.shuttingDown || state.starting || retrying) return;

  const child = state.backend && state.backend.child;
  if (child && (child.exitCode !== null || child.signalCode)) {
    log('embedded backend exited since boot; forking a new one');
    state.backend = null;
  }

  if (!usesExternalTarget() && !state.backend) {
    retrying = true;
    showLoading({ title: PRODUCT_NAME, detail: '正在重新启动本地服务…', hint: state.appUrl });
    try {
      await startBackend(state.layout);
    } catch (error) {
      const message = (error && error.message) || String(error);
      log(`retry: backend failed to start: ${message}`);
      showLoading({ tone: 'error', title: '本地服务启动失败', detail: message, hint: state.appUrl });
      return;
    } finally {
      retrying = false;
    }
  } else if (!(await probeTarget(state.appUrl))) {
    showLoading({ tone: 'error', title: '找不到目标服务', detail: '目标地址没有响应 - 请确认服务已经启动', hint: state.appUrl });
    return;
  }

  log(`retry: navigating window to ${state.appUrl}`);
  try {
    // From the real app origin a hard reload can keep Chromium's cache-bypass
    // semantics; on the loading page that would only re-paint the page itself.
    if (hard && isSameAppOrigin(win.webContents.getURL(), state.appOrigin)) win.webContents.reloadIgnoringCache();
    else await win.loadURL(state.appUrl);
  } catch (error) {
    log(`retry loadURL settled with: ${(error && error.message) || error}`);
  }
}

async function boot() {
  const layout = resolveLayout({
    isPackaged: app.isPackaged,
    desktopDir: DESKTOP_DIR,
    resourcesPath: process.resourcesPath,
    userDataDir: app.getPath('userData'),
  });
  state.layout = layout;

  log(`starting: mode=${MODE} packaged=${app.isPackaged} electron=${process.versions.electron} node=${process.versions.node}`);
  log(`backend root = ${layout.backendRoot}`);
  log(`static root  = ${layout.webDist}`);
  log(`data dir     = ${layout.dataDir}`);
  log(`userData     = ${app.getPath('userData')}`);

  if (app.isPackaged) seedDataDir({ seedDir: layout.seedDataDir, targetDir: layout.dataDir, log });

  state.appUrl = targetUrlFor(layout);
  const parsed = parseUrl(state.appUrl);
  if (!parsed) throw new Error(`DY_DESKTOP_URL is not a valid url: ${state.appUrl}`);
  state.appOrigin = parsed.origin;
  log(`target url   = ${state.appUrl} (embedded backend: ${!TARGET_URL_OVERRIDE && MODE === 'prod'})`);

  const store = new WindowStateStore(app.getPath('userData'), {
    width: DEFAULT_BOUNDS.width,
    height: DEFAULT_BOUNDS.height,
    minWidth: MINIMUM.width,
    minHeight: MINIMUM.height,
  });
  log(`window state file = ${store.file}`);

  lockdownPermissions();

  const win = createWindow(store);
  state.win = win;
  hardenWebContents(win.webContents);
  buildMenu();

  /* Paint the loading page first: a blank window looks like a crash. */
  const bootingDetail = MODE === 'dev' ? '正在连接 Vite 开发服务…' : '正在启动本地服务…';
  showLoading({ title: PRODUCT_NAME, detail: bootingDetail, hint: state.appUrl });

  if (usesExternalTarget()) {
    if (!(await probeTarget(state.appUrl))) {
      const why = '目标地址没有响应 - ';
      const advice = MODE === 'dev' ? '先在仓库根目录运行 npm run dev' : '检查 DY_DESKTOP_URL 指向的服务';
      log(`target ${state.appUrl} is not answering: ${why}${advice}`);
      showLoading({ tone: 'error', title: '找不到目标服务', detail: `${why}${advice}（可用 文件 → 重新加载 重试）`, hint: state.appUrl });
      maybeSmokeAbort('target not reachable');
      return;
    }
  } else {
    try {
      await startBackend(layout);
    } catch (error) {
      const message = (error && error.message) || String(error);
      log(`backend failed to start: ${message}`);
      showLoading({
        tone: 'error',
        title: '本地服务启动失败',
        detail: `${message}（可用 文件 → 重新加载 重试）`,
        hint: `调试: DY_PORT=${layout.port} node desktop/src/child-server.cjs`,
      });
      maybeSmokeAbort('backend failed to start');
      return;
    }
  }

  log(`navigating window to ${state.appUrl}`);
  try {
    await win.loadURL(state.appUrl);
  } catch (error) {
    // loadURL rejects on ERR_ABORTED; the did-fail-load handler covers real failures.
    log(`loadURL settled with: ${(error && error.message) || error}`);
  }
}

/* -------------------------------------------------------------- lifecycle */

if (!app.requestSingleInstanceLock({ product: PRODUCT_NAME })) {
  log('another instance already owns this app; handing over and exiting');
  app.quit();
} else {
  app.on('second-instance', (_event, forwardedArgv) => {
    log(`second-instance (argv tail: ${forwardedArgv.slice(-2).join(' ')})`);
    const win = state.win;
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) win.show();
    win.focus();
  });

  // The web app remembers "sound on" in localStorage; without this Chromium
  // refuses the first unmuted play() until a user gesture, so after a reload the
  // feed silently falls back to muted instead of starting like the real client.
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
  app.enableSandbox();
  app.setName(PRODUCT_NAME);
  if (process.platform === 'win32') app.setAppUserModelId(APP_ID);
  // Channels exist before the first frame loads, so an early invoke can never
  // be answered with "No handler registered".
  registerIpc();

  app.on('web-contents-created', (_event, contents) => {
    const kind = contents.getType();
    if (kind !== 'window' && kind !== 'devtools') {
      log(`destroying unexpected ${kind} webContents`);
      setImmediate(() => contents.destroy());
      return;
    }
    const managed = state.win && !state.win.isDestroyed() && contents.id === state.win.webContents.id;
    if (managed) return;
    // Anything else (a stray window from devtools, say) gets the same veto with
    // no external hand-off at all.
    contents.setWindowOpenHandler(({ url }) => {
      log(`denied window.open on an unmanaged webContents -> ${String(url).slice(0, 120)}`);
      return { action: 'deny' };
    });
    contents.on('will-navigate', (event, url) => {
      event.preventDefault();
      log(`blocked navigation on an unmanaged webContents -> ${String(url).slice(0, 120)}`);
    });
  });

  app.whenReady().then(boot).catch((error) => {
    const message = (error && error.message) || String(error);
    log(`fatal during boot: ${(error && error.stack) || error}`);
    const win = state.win;
    if (win && !win.isDestroyed()) {
      showLoading({ tone: 'error', title: '启动失败', detail: message, hint: state.appUrl });
    } else {
      // Nothing was ever painted, so a boot crash would look like a silent
      // no-op double-click. A modal is the only channel left.
      try {
        dialog.showErrorBox(`${PRODUCT_NAME} 无法启动`, message);
      } catch {
        /* no display: the log line is all there is */
      }
    }
    app.exit(1);
  });

  if (SMOKE) {
    app.on('browser-window-created', (_event, win) => {
      // Per-load logging lives in createWindow; this hook is what triggers the
      // probe, and only once the real app origin has finished loading (the
      // loading page is painted first and would otherwise match).
      win.webContents.on('did-finish-load', () => {
        if (!state.smokeDone && isSameAppOrigin(win.webContents.getURL(), state.appOrigin)) runSmoke(win);
      });
    });
  }

  app.on('window-all-closed', () => {
    app.quit();
  });

  /* Hold the quit exactly once so the forked backend dies with us instead of
     keeping 127.0.0.1:<port> bound for the next launch. */
  let backendStopHeld = false;
  app.on('before-quit', (event) => {
    // Set for every quit path, reused or not: it keeps the did-fail-load and
    // reload handlers from painting an error page while the window goes away.
    state.shuttingDown = true;
    const child = state.backend && state.backend.child;
    if (backendStopHeld || !child || child.exitCode !== null || child.signalCode) return;
    backendStopHeld = true;
    event.preventDefault();
    log('before-quit: stopping embedded backend');
    stopEmbeddedBackend(state.backend, log)
      .catch((error) => log(`backend stop failed: ${(error && error.message) || error}`))
      .finally(() => app.quit());
  });

  /* Last-resort synchronous guard for app.exit() or an uncaught crash. */
  process.on('exit', () => {
    const child = state.backend && state.backend.child;
    if (child && child.exitCode === null && !child.signalCode) {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }
  });

  process.on('uncaughtException', (error) => log(`uncaught exception: ${(error && error.stack) || error}`));
  process.on('unhandledRejection', (reason) => log(`unhandled rejection: ${(reason && reason.stack) || reason}`));
}
