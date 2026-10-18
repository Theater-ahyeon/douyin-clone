# Douyin Clone — Windows desktop client

An Electron shell around the existing web client and the existing zero-dependency
Node backend. It is a real app window, not a wrapper page: the shell owns the
native frame, menu, window-geometry memory and the embedded backend process, and
it is the only thing in this directory that talks to Electron.

`desktop/` is a **standalone npm project** — it is deliberately *not* a member of
the root workspace (`package.json` `workspaces` stays `["web", "server"]`), so
installing Electron here can never disturb the root `node_modules` or the web
build.

---

## Layout

| file | role |
| --- | --- |
| `package.json` | standalone project, `"main": "main.cjs"`, scripts `dev` / `start` / `smoke` / `build:win` / `check` |
| `main.cjs` | Electron main process: window, geometry memory, menu, IPC handlers, navigation lockdown, retry, lifecycle |
| `preload.cjs` | the only renderer-visible surface (`window.douyinDesktop`) |
| `electron-builder.yml` | win32 portable + NSIS packaging, `extraResources` for backend sources and `web/dist` |
| `src/ipc-schema.cjs` | the channel table and every payload validator (single source of truth) |
| `src/backend.cjs` | path resolution, backend fork, `/api/feed` readiness poll, graceful stop, first-run data seed |
| `src/child-server.cjs` | the forked backend process (wraps the repo's own `startServer({ staticDir })`) |
| `src/window-state.cjs` | `window-state.json` read/write, multi-monitor sanity check |
| `src/loading-page.cjs` | the data-URL loading/error page painted while the backend boots |
| `src/launch.cjs` | npx-free launcher (resolves `electron.exe` through the package) |
| `src/build.cjs` | npx-free electron-builder runner |
| `src/check.cjs` | GUI-free gate: `node --check` + IPC contract parity + handler/allowlist coverage + packaging payload + validator unit tests |
| `build/icon.png` | 1024×1024 app icon (also used as the window/taskbar icon) |

---

## Install

```bash
cd desktop
npm install --no-audit --no-fund
```

`npm install` fetches the `electron` wrapper but the ~180 MB `electron.exe` binary
is downloaded by `node_modules/electron/install.js` **from GitHub releases**, not
from the npm registry. On this machine Node's `fetch` ignores `HTTPS_PROXY` unless
told otherwise, so if that download fails, re-run it with the env proxy honoured:

```bash
NODE_USE_ENV_PROXY=1 node node_modules/electron/install.js
node node_modules/electron/cli.js --version     # -> v44.9.0
```

`npx` is banned on this machine, so nothing here uses it — every binary is started
with `node <path-to>.cjs`.

---

## Run

### Development (against the Vite dev server)

```bash
cd desktop
npm run dev            # == node src/launch.cjs --dev
```

Loads `http://127.0.0.1:5173`, which already proxies `/api` and `/media` to the
backend on `8787`. **No backend is forked in this mode** — start the stack first
from the repo root (`npm run dev` there), otherwise the shell shows an error page
instead of a white window.

### Production behaviour from source

```bash
cd desktop
npm start              # == node src/launch.cjs --prod
```

Forks `src/child-server.cjs`, waits for `GET /api/feed` to answer, then loads
`http://127.0.0.1:${DY_PORT:-8787}`. Because the repo root `npm start` serves the
same port, the two are alternatives: if something already answers there **and serves
the SPA** (`/` returning `text/html` with `<div id="root">`), the shell reuses it and
forks nothing (look for `reusing it (no fork)` in the log). A port held by the
API-only dev entry (`server/src/index.js` has no static root) is reported as an error
with the fix in the message rather than loaded as a JSON 404 page.

Shutting down never touches a reused backend - only a process this shell forked.
The forked handle is booked the moment `fork()` returns, so a quit (or a boot
that then fails) during startup still stops the child instead of leaving an
orphan on the port.

### Recovery after a failed start

If the backend never comes up, the error page says why and **文件 → 重新加载**
(`Ctrl+R`) re-probes the target and forks a new backend if the old one died;
`Ctrl+Shift+R` is the same with Chromium's cache bypassed. A plain
`role: 'reload'` would only re-paint the loading page we drew ourselves.

The window is created with `--autoplay-policy=no-user-gesture-required`: the web
client persists the speaker state, and without it Chromium rejects the first
unmuted `play()` after a launch, so the feed silently falls back to muted.

`web/dist` must exist (`npm run build` at the repo root).

### Self-terminating smoke run

```bash
cd desktop
DY_PORT=8798 ELECTRON_ENABLE_LOGGING=1 npm run smoke
```

Opens the real window, waits for `did-finish-load` on the app origin, then prints
DOM/bridge/API/push probes and quits by itself (nothing stays running). Tunables:
`DY_DESKTOP_SMOKE_MS` (dwell time, default 2500 ms).

---

## Build the .exe

```bash
cd desktop
npm run build:win                       # portable + NSIS, x64
node src/build.cjs --win --dir          # resources only, no installer, much faster
```

Output lands in `desktop/dist_electron/`:

```
dist_electron/
├── win-unpacked/                            # the runnable app directory
├── Douyin Clone-1.0.0-portable.exe          # single-file app, no install
└── Douyin Clone-1.0.0-setup.exe             # NSIS installer (per-user, dir choosable)
```

Nothing is code-signed (`requestedExecutionLevel: asInvoker`, no certificate), so
SmartScreen will warn on first launch; that is expected for a local build.

### What the packaged app contains

```
Douyin Clone.exe
resources/
├── app/                       # the shell, unpacked (asar: false)
│   ├── main.cjs
│   ├── preload.cjs
│   ├── package.json
│   ├── build/icon.png
│   └── src/{ipc-schema,backend,child-server,window-state,loading-page}.cjs
└── resources/
    ├── backend/
    │   ├── server/{package.json,src/*.js}   # the zero-dependency API server
    │   ├── scripts/start.mjs                # console fallback: node it directly
    │   └── web/dist/                        # built React frontend
    └── backend-data-seed/
        ├── app.sqlite                       # demo data (no .token-secret!)
        └── videos/ thumbs/
```

`asar: false` is intentional: the forked `child-server.cjs` is launched by absolute
path with `ELECTRON_RUN_AS_NODE=1`, and forking a script out of `app.asar` on
Windows is a known source of trouble. The shell is seven small files; packing them
buys nothing.

First launch copies `backend-data-seed` into `%APPDATA%\Douyin Clone\server-data`
(the backend needs a writable media directory for uploads). `.token-secret` is never
copied, so each install generates its own token-signing secret. To ship different
demo data, replace `server/data/app.sqlite` before building, or run
`node scripts/seed.mjs` at the repo root.

---

## Pointing the client at a remote server

`DY_DESKTOP_URL` overrides the window target and **disables the fork** — the shell
then just loads whatever URL you give it:

```bash
DY_DESKTOP_URL=http://192.168.1.20:8787/ node src/launch.cjs --prod
DY_DESKTOP_URL=https://example.com/      node src/launch.cjs --prod
```

The navigation guards, the `openExternal` app-origin rejection and the notification
permission are all derived from that origin at runtime, so a remote deployment needs
no code change. Two things to check for a non-loopback target:

* the backend's `DY_CORS_ORIGINS` must list the origin the window loads
  (`server/src/config.js` allowlists only the dev origins by default);
* if the remote server does not also serve the built frontend, point the shell at
  the URL that does (`/api/feed` must answer for the readiness probe in local mode;
  remote mode only needs the URL to respond).

### Environment reference

| variable | default | effect |
| --- | --- | --- |
| `DY_PORT` | `8787` | embedded backend port (also the readiness probe port) |
| `DY_HOST` | `127.0.0.1` | embedded backend bind host |
| `DY_DESKTOP_URL` | — | window target; implies "no embedded backend" |
| `DY_DESKTOP_MODE` | `prod` | `dev` = load Vite; overridden by `--dev` / `--prod` |
| `DY_DESKTOP_DEV_URL`, `DY_WEB_PORT` | `http://127.0.0.1:5173` | dev target |
| `DY_DESKTOP_BACKEND_ROOT` | repo root / `<resources>/backend` | where `server/src` is looked up |
| `DY_DESKTOP_WEB_DIST` | `<backendRoot>/web/dist` | static root handed to the backend |
| `DY_DATA_DIR` | `server/data` (source) / `%APPDATA%\Douyin Clone\server-data` (packaged) | sqlite + uploads |
| `DY_LOG` | on | `0` silences the backend access log |
| `DY_DESKTOP_DEVTOOLS` | off | `1` enables DevTools in production mode |
| `DY_DESKTOP_SMOKE`, `DY_DESKTOP_SMOKE_MS` | off / 2500 | self-terminating probe run |

`window-state.json` (geometry + maximized) and `server-data/` live under
`%APPDATA%\Douyin Clone\`. Delete `window-state.json` if the window ever opens
somewhere unhelpful — a restored rectangle that no display covers is discarded
automatically.

---

## The IPC surface (all of it)

Renderer → main, all via `ipcRenderer.invoke`, all re-validated in `main.cjs`:

| channel | request | response | main-side effect |
| --- | --- | --- | --- |
| `desktop:window-control` | `{ action: 'minimize'\|'toggleMaximize'\|'close'\|'toggleFullscreen' }` | `{ ok, value: { action, applied } }` | frame-level moves on the one managed window |
| `desktop:open-external` | `{ url }` | `{ ok, value?: { opened } }` | `shell.openExternal` — http(s) only, no credentials, **app origin refused** |
| `desktop:notify` | `{ title, body?, silent? }` | `{ ok, value?: { shown } }` | native `Notification` (needs `setAppUserModelId`, which `main.cjs` sets) |
| `desktop:app-info` | `{}` | product/version/electron/platform, no paths | read-only |
| `desktop:backend-info` | `{}` | `{ url, host, port, embedded, reused, pid }` | read-only; deliberately no filesystem paths |

Main → renderer, the only two channels `preload.cjs` ever subscribes to:

| channel | payload | page-visible behaviour |
| --- | --- | --- |
| `desktop:feed-action` | `{ action: 'playPause'\|'next'\|'previous'\|'toggleSound' }` | calls `onFeedAction` subscribers **and** replays the equivalent `keydown` (Space / J / K / M) so the untouched `web/src/components/FeedScroller.tsx` reacts |
| `desktop:navigate` | `{ path }` from the app's own hash-route allowlist | sets `location.hash`, so the SPA routes without a reload |

Everything the page can reach is `window.douyinDesktop`: `name`, `bridgeVersion`,
`minimize`, `maximizeToggle`, `fullscreenToggle`, `closeWindow`, `openExternal`,
`notify`, `getAppInfo`, `getBackendInfo`, `onFeedAction`, `onNavigate`. There is no
generic `invoke(channel, args)` / `on(channel, cb)` passthrough, `ipcRenderer` never
crosses the bridge, and the two `on*` helpers hand subscribers a frozen
`{ action }` / `{ path }` — never the IPC `event`.

### Why the feed menu uses `Ctrl+Alt+…`

The web app binds bare `Space`, `J`, `K`, `↑`, `↓`, `M` itself. A menu accelerator on
`Space` would be swallowed by the menu framework before the page sees it and would
break typing a space into a comment, so the native menu items carry non-colliding
`Ctrl+Alt+P / ↑ / ↓ / J / K / M` accelerators, **send `desktop:feed-action`**, and the
preload turns that message back into the key the page already listens for. The page's
own keys keep working untouched. `帮助 → 键盘快捷键` lists both sets.

### Threat model, as tested

A compromised page cannot: reach `require`/`process`/`module`/`ipcRenderer`
(all `undefined` in the probe), name an arbitrary IPC channel, hand a
`javascript:`/`file:`/credentialed/loopback-app-origin URL to the OS browser, send
control characters or oversized bodies into a native notification, escape the app
origin via `window.open` (denied) or navigation (blocked; external http(s) is handed
to the browser instead), get any session permission except notifications, or call a
privileged handler from a frame that is not the main window's app-origin frame -
which also excludes the shell's own loading/error page, since a `data:` URL has an
opaque origin and never needs the bridge.
`npm run check` asserts the validators, the preload/main channel-table parity, that
every allowlisted channel has both a handler and a sender, and that
`electron-builder.yml` ships every module the app requires; `npm run smoke` re-runs
four of those attacks against the live window.

---

## Menu

`文件` 重新加载(`Ctrl+R`，必要时重启后端) 强制重新加载(`Ctrl+Shift+R`) / 在系统浏览器中打开 / 后端状态… / 退出
`编辑` 撤销 重做 剪切 复制 粘贴 删除 全选 (native roles, so text inputs behave)
`播放` the feed actions above
`视图` 全屏 最小化 缩放 开发者工具(prod needs `DY_DESKTOP_DEVTOOLS=1`) `跳转`(推荐/关注/消息/我的/上传/搜索)
`帮助` 键盘快捷键 / 关于 Douyin Clone

The window keeps the **native frame** (no frameless chrome) with the app icon and a
title of the form `<page title> · Douyin Clone`.

---

## Known limits

* Windows only (`electron-builder.yml` targets win32 x64); no macOS/Linux config.
* Not code-signed; no auto-update feed is configured (`--publish never` is not
  needed because no publish config exists).
* Tray icon, in-app "share" and multi-window are not implemented.
* `Ctrl+Alt+↑/↓` can be grabbed by Intel graphics hotkeys on some laptops; the
  `Ctrl+Alt+J`/`Ctrl+Alt+K` duplicates in the `播放` menu and the page's own `J`/`K`
  keys are the fallback.
* Launching a second instance while the first runs makes Chromium print a benign
  `Unable to move the cache: 拒绝访问` line from the short-lived handover process.
* Packaging reuses the Electron binary already cached by `npm install`; if that
  cache is cold, `electron-builder` downloads it (plus NSIS/winCodeSign) from GitHub
  and needs the same env-proxy reachability as the install step.
