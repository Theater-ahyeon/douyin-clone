'use strict';
/**
 * The one and only definition of the desktop <-> renderer contract.
 *
 * Both sides of every message go through the validators in this file:
 *   - `main.cjs` calls them before touching any privileged API, and
 *   - `preload.cjs` only ever subscribes to the channels listed here.
 *
 * There is deliberately no generic `invoke(channel, ...args)` passthrough: the
 * renderer can only name a channel by using one of the five functions the
 * contextBridge exposes, and the main process answers exactly those five.
 *
 * `src/check.cjs` asserts that the channel strings duplicated inside the
 * sandboxed preload still match this table (a sandboxed preload cannot
 * `require()` a plain local module, so the constants are copied there).
 */

const CHANNELS = {
  /* renderer -> main, request/response via ipcRenderer.invoke */
  invoke: {
    windowControl: 'desktop:window-control',
    openExternal: 'desktop:open-external',
    notify: 'desktop:notify',
    appInfo: 'desktop:app-info',
    backendInfo: 'desktop:backend-info',
  },
  /* main -> renderer, one-way push the preload listens for */
  push: {
    feedAction: 'desktop:feed-action',
    navigate: 'desktop:navigate',
  },
};

const WINDOW_ACTIONS = Object.freeze(['minimize', 'toggleMaximize', 'close', 'toggleFullscreen']);

const FEED_ACTIONS = Object.freeze(['playPause', 'next', 'previous', 'toggleSound']);

/** Hash routes the web app actually resolves (web/src/router/routes.tsx). */
const NAV_PATHS = Object.freeze(['/', '/follow', '/friends', '/live', '/my', '/messages', '/search', '/upload', '/login']);

/* Key the untouched web app is already listening for (web/src/components/FeedScroller.tsx:149).
   The preload replays one of these as a DOM KeyboardEvent so the native menu drives the feed
   without a single line of web/src changing. No modifier flags: FeedScroller ignores events
   whose target is a text field, and App.tsx turns Ctrl+K into "focus search". */
const FEED_KEYS = Object.freeze({
  playPause: { key: ' ', code: 'Space' },
  next: { key: 'j', code: 'KeyJ' },
  previous: { key: 'k', code: 'KeyK' },
  toggleSound: { key: 'm', code: 'KeyM' },
});

const LIMITS = { url: 2048, title: 120, body: 600, path: 200 };

/**
 * Flat view of the same table, for call sites that just want a channel name:
 * `CH.windowControl`, `CH.feedAction`, ... Keeping both views avoids the
 * `CHANNELS.appInfo` vs `CHANNELS.invoke.appInfo` footgun.
 */
const CH = Object.freeze({ ...CHANNELS.invoke, ...CHANNELS.push });

const CRLF = /[\u0000-\u001f\u007f]/;

const fail = (reason) => ({ ok: false, reason });
const pass = (value) => ({ ok: true, value });

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** A printable string of at most `max` chars; control codes are dropped outright. */
function textish(value, max, { label }) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) return fail(`${label} must be a 1-${max} char string`);
  if (CRLF.test(value)) return fail(`${label} contains control characters`);
  return pass(value.trim());
}

/**
 * `desktop:window-control` -> { action }
 * Only frame-level moves; never a raw webContents/browserwindow handle.
 */
function validateWindowControl(payload) {
  if (!isPlainObject(payload)) return fail('payload must be an object');
  const extra = Object.keys(payload).filter((k) => k !== 'action');
  if (extra.length) return fail(`unexpected keys: ${extra.join(',')}`);
  if (!WINDOW_ACTIONS.includes(payload.action)) return fail('action is not allowlisted');
  return pass({ action: payload.action });
}

/**
 * `desktop:open-external` -> { url, origin }
 * Rejects anything that is not a plain http(s) URL, and rejects the app's own
 * origin: a page that wants to move around inside the app should navigate, not
 * hand a loopback URL to the OS browser. Credentials in the authority and
 * file:/javascript:-style targets are refused before `shell.openExternal`.
 */
function validateExternalUrl(payload, { appOrigin }) {
  if (!isPlainObject(payload)) return fail('payload must be an object');
  const extra = Object.keys(payload).filter((k) => k !== 'url');
  if (extra.length) return fail(`unexpected keys: ${extra.join(',')}`);
  const raw = payload.url;
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > LIMITS.url) return fail('url must be a short string');

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return fail('url is not absolute');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return fail('only http(s) may leave the app');
  if (parsed.username || parsed.password) return fail('url must not carry credentials');
  if (!parsed.hostname || parsed.hostname.length > 253) return fail('url hostname is malformed');
  if (appOrigin && parsed.origin === appOrigin) return fail('url belongs to the app origin');
  return pass({ url: parsed.toString(), origin: parsed.origin });
}

/**
 * `desktop:notify` -> { title, body?, silent? }
 * Fixed shape, length-capped, control characters rejected.
 */
function validateNotify(payload) {
  if (!isPlainObject(payload)) return fail('payload must be an object');
  const allowed = new Set(['title', 'body', 'silent']);
  const extra = Object.keys(payload).filter((k) => !allowed.has(k));
  if (extra.length) return fail(`unexpected keys: ${extra.join(',')}`);

  const title = textish(payload.title, LIMITS.title, { label: 'title' });
  if (!title.ok) return title;
  const out = { title: title.value };

  if (payload.body !== undefined) {
    const body = textish(payload.body, LIMITS.body, { label: 'body' });
    if (!body.ok) return body;
    out.body = body.value;
  }
  if (payload.silent !== undefined) {
    if (typeof payload.silent !== 'boolean') return fail('silent must be a boolean');
    out.silent = payload.silent;
  }
  return pass(out);
}

/** `desktop:feed-action` payload produced by the native menu. */
function validateFeedAction(payload) {
  if (!isPlainObject(payload)) return fail('payload must be an object');
  if (!FEED_ACTIONS.includes(payload.action)) return fail('action is not allowlisted');
  return pass({ action: payload.action });
}

/** `desktop:navigate` payload: an exact hash route from the app's own route table. */
function validateNavigate(payload) {
  if (!isPlainObject(payload)) return fail('payload must be an object');
  if (typeof payload.path !== 'string' || payload.path.length > LIMITS.path) return fail('path must be a short string');
  if (!NAV_PATHS.includes(payload.path)) return fail('path is not a known route');
  return pass({ path: payload.path });
}

/** Coarse pre-screen for anything the renderer sends: primitive-ish and small. */
function envelopeLooksSane(payload) {
  if (payload === undefined || payload === null) return true;
  if (typeof payload === 'string') return payload.length <= LIMITS.url && !CRLF.test(payload);
  if (typeof payload === 'number' || typeof payload === 'boolean') return true;
  if (!isPlainObject(payload)) return false;
  if (Object.keys(payload).length > 8) return false;
  let serialized;
  try {
    serialized = JSON.stringify(payload);
  } catch {
    return false;
  }
  return typeof serialized === 'string' && serialized.length <= 8 * 1024;
}

/** Reloaded from a packaged app: guard `will-navigate`/`setWindowOpenHandler` with this. */
function isSameAppOrigin(rawUrl, appOrigin) {
  if (!rawUrl || typeof rawUrl !== 'string') return false;
  try {
    return new URL(rawUrl).origin === appOrigin;
  } catch {
    return false;
  }
}

module.exports = {
  CH,
  CHANNELS,
  FEED_ACTIONS,
  FEED_KEYS,
  NAV_PATHS,
  WINDOW_ACTIONS,
  envelopeLooksSane,
  isSameAppOrigin,
  validateExternalUrl,
  validateFeedAction,
  validateNavigate,
  validateNotify,
  validateWindowControl,
};
