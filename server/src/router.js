import { MAX_JSON_BYTES } from './config.js';
import { HttpError, httpError, sendError, sendJson } from './util.js';

function compile(pattern) {
  const names = [];
  const parts = pattern.split('/').filter(Boolean);
  const source = parts
    .map((part) => {
      if (part.startsWith(':')) {
        names.push(part.slice(1));
        return '([^/]+)';
      }
      if (part === '*') {
        names.push('wildcard');
        return '(.*)';
      }
      return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { regex: new RegExp(`^/${source}/?$`), names };
}

export class Router {
  constructor() {
    this.entries = [];
  }

  add(method, pattern, handler, options = {}) {
    const compiled = compile(pattern);
    this.entries.push({
      method: method.toUpperCase(),
      pattern,
      handler,
      options,
      regex: compiled.regex,
      names: compiled.names,
    });
    return this;
  }

  get(pattern, handler, options) { return this.add('GET', pattern, handler, options); }
  post(pattern, handler, options) { return this.add('POST', pattern, handler, options); }
  put(pattern, handler, options) { return this.add('PUT', pattern, handler, options); }
  patch(pattern, handler, options) { return this.add('PATCH', pattern, handler, options); }
  delete(pattern, handler, options) { return this.add('DELETE', pattern, handler, options); }

  /** `{ entry, params }` on a hit, `{ mismatch: true }` when the path exists but not for this method. */
  match(method, pathname) {
    let mismatch = false;
    for (const entry of this.entries) {
      const found = entry.regex.exec(pathname);
      if (!found) continue;
      if (entry.method !== method) {
        mismatch = true;
        continue;
      }
      const params = {};
      entry.names.forEach((name, index) => {
        params[name] = decodeParam(found[index + 1]);
      });
      return { entry, params };
    }
    return mismatch ? { mismatch: true } : null;
  }
}

function decodeParam(value) {
  if (value === undefined) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function jsonish(contentType) {
  const base = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (!base || base === 'text/plain') return true;
  return base === 'application/json' || /^application\/[\w.+-]+\+json$/.test(base);
}

/** Reads a JSON body with a hard byte cap so a hostile client cannot exhaust memory. */
export function readJsonBody(req, cap = MAX_JSON_BYTES) {
  if (!jsonish(req.headers['content-type'])) {
    throw httpError(415, 'unsupported_media', 'Content-Type must be application/json');
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let received = 0;
    let failed = false;

    const bail = (error) => {
      if (failed) return;
      failed = true;
      req.removeAllListeners('data');
      // Pause instead of destroy(): the caller still has to flush the 413/415
      // response, and `Connection: close` retires the socket right afterwards.
      req.pause();
      reject(error);
    };

    req.on('data', (chunk) => {
      received += chunk.length;
      if (received > cap) {
        bail(httpError(413, 'payload_too_large', `request body exceeds ${cap} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', (error) => bail(httpError(400, 'bad_request', error.message)));
    req.on('end', () => {
      if (failed) return;
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) {
        resolve({});
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        reject(httpError(400, 'invalid_json', 'body is not valid JSON'));
        return;
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        reject(httpError(400, 'invalid_json', 'body must be a JSON object'));
        return;
      }
      resolve(parsed);
    });
  });
}

export function status(statusCode, payload, headers) {
  return { __status: statusCode, payload, headers };
}

function isResponder(value) {
  return Boolean(value && typeof value === 'object' && '__status' in value);
}

/** Runs a handler and maps its return value / thrown error onto a response. */
export async function dispatch(entry, ctx) {
  try {
    const result = await entry.handler(ctx);
    if (result === undefined) return;
    if (isResponder(result)) {
      sendJson(ctx.res, result.__status, result.payload === undefined ? null : result.payload);
      return;
    }
    sendJson(ctx.res, 200, result);
  } catch (error) {
    fail(ctx.res, error, ctx.route);
  }
}

export function fail(res, error, route) {
  const http = error instanceof HttpError ? error : null;
  const statusCode = http ? http.status : 500;
  const code = http ? http.code : 'internal_error';
  const message = http ? http.message : 'internal server error';
  if (!http) {
    // Real error stays in the log; the client only ever sees a generic message.
    console.error(`[error] ${route || 'unrouted'}:`, error && (error.stack || error.message || error));
  }
  if (res.headersSent || res.writableEnded) {
    res.destroy();
    return;
  }
  sendError(res, statusCode, code, message);
}
