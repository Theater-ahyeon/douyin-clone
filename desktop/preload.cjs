'use strict';
/**
 * Preload for the main window. Runs in an ISOLATED world with `sandbox: true`
 * and `nodeIntegration: false`, so the page never sees Node, `require`, or
 * `ipcRenderer`.
 *
 * Rules enforced here (mirrored by the main process, which validates again):
 *   - every bridge member is a purpose-built function; there is no
 *     `invoke(channel, args)` passthrough and no `on(channel, cb)` passthrough;
 *   - only the two channels the main process pushes to are ever subscribed to,
 *     by name, with the payload shape filtered before it reaches the page;
 *   - callbacks never receive the IPC `event` object (it can carry ports and
 *     frame identity), only a frozen plain object of allowlisted keys;
 *   - nothing is accepted back from the page except the small envelopes
 *     described in src/ipc-schema.cjs.
 *
 * A sandboxed preload cannot `require()` plain local files, so the channel
 * table below is a deliberate copy of src/ipc-schema.cjs. `npm run check`
 * fails if the two ever drift apart.
 */

const { contextBridge, ipcRenderer } = require('electron');

const CHANNELS = Object.freeze({
  windowControl: 'desktop:window-control',
  openExternal: 'desktop:open-external',
  notify: 'desktop:notify',
  appInfo: 'desktop:app-info',
  backendInfo: 'desktop:backend-info',
  feedAction: 'desktop:feed-action',
  navigate: 'desktop:navigate',
});

const FEED_ACTIONS = Object.freeze(['playPause', 'next', 'previous', 'toggleSound']);
const NAV_PATHS = Object.freeze(['/', '/follow', '/friends', '/live', '/my', '/messages', '/search', '/upload', '/login']);

/* What the untouched web app already reacts to (web/src/components/FeedScroller.tsx).
   Set window.__douyinOwnsFeedKeys = true in the page if it ever starts handling
   onFeedAction itself, so a menu press is not acted on twice. */
const FEED_KEYS = Object.freeze({
  playPause: { key: ' ', code: 'Space' },
  next: { key: 'j', code: 'KeyJ' },
  previous: { key: 'k', code: 'KeyK' },
  toggleSound: { key: 'm', code: 'KeyM' },
});

/** @type {Set<(payload: {action: string}) => void>} */
const feedSubscribers = new Set();
/** @type {Set<(payload: {path: string}) => void>} */
const navigateSubscribers = new Set();

function invoke(channel, payload) {
  return ipcRenderer.invoke(channel, payload).then(
    (value) => value,
    (error) => ({ ok: false, reason: String((error && error.message) || error) })
  );
}

function control(action) {
  return invoke(CHANNELS.windowControl, { action });
}

/** Replay a menu feed action as the key the page already listens for. */
function replayFeedKey(action) {
  const spec = FEED_KEYS[action];
  if (!spec || typeof KeyboardEvent !== 'function') return false;
  // No modifier flags on purpose: App.tsx maps Ctrl+K to "focus search".
  const event = new KeyboardEvent('keydown', {
    key: spec.key,
    code: spec.code,
    bubbles: true,
    cancelable: true,
  });
  window.dispatchEvent(event);
  return true;
}

function deliverFeedAction(payload) {
  const action = payload && payload.action;
  if (!FEED_ACTIONS.includes(action)) return;
  const frozen = Object.freeze({ action });
  for (const handler of [...feedSubscribers]) {
    try {
      handler(frozen);
    } catch {
      /* one broken subscriber must not stop the others */
    }
  }
  if (window.__douyinOwnsFeedKeys !== true) replayFeedKey(action);
}

function deliverNavigate(payload) {
  const target = payload && payload.path;
  if (!NAV_PATHS.includes(target)) return;
  const frozen = Object.freeze({ path: target });
  for (const handler of [...navigateSubscribers]) {
    try {
      handler(frozen);
    } catch {
      /* ignored, see above */
    }
  }
  // Hash routing: assigning the hash moves the SPA without a reload.
  const next = target === '/' ? '#/' : `#${target}`;
  if (window.location.hash !== next) window.location.hash = next;
}

ipcRenderer.on(CHANNELS.feedAction, (_event, payload) => deliverFeedAction(payload));
ipcRenderer.on(CHANNELS.navigate, (_event, payload) => deliverNavigate(payload));

const bridge = {
  /** Always this string; handy for a page that wants to gate desktop-only UI. */
  name: 'douyin-desktop',
  bridgeVersion: '1.0.0',

  /* ---- window frame (native frame is kept, these are menu/keyboard extras) ---- */
  minimize: () => control('minimize'),
  maximizeToggle: () => control('toggleMaximize'),
  fullscreenToggle: () => control('toggleFullscreen'),
  closeWindow: () => control('close'),

  /* ---- privileged actions ---- */
  openExternal: (url) => invoke(CHANNELS.openExternal, { url: String(url == null ? '' : url) }),
  notify: (title, body, options) =>
    invoke(CHANNELS.notify, {
      title: String(title == null ? '' : title),
      body: body == null ? undefined : String(body),
      silent: options && options.silent === true ? true : undefined,
    }),

  /* ---- read-only environment ---- */
  getAppInfo: () => invoke(CHANNELS.appInfo, {}),
  getBackendInfo: () => invoke(CHANNELS.backendInfo, {}),

  /* ---- main -> page, allowlisted channels only. Each returns an unsubscribe. ---- */
  onFeedAction: (handler) => {
    if (typeof handler !== 'function') return () => {};
    feedSubscribers.add(handler);
    return () => feedSubscribers.delete(handler);
  },
  onNavigate: (handler) => {
    if (typeof handler !== 'function') return () => {};
    navigateSubscribers.add(handler);
    return () => navigateSubscribers.delete(handler);
  },
};

contextBridge.exposeInMainWorld('douyinDesktop', bridge);
