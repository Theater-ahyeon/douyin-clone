import http from 'node:http';
import { performance } from 'node:perf_hooks';

import { authenticate } from './auth.js';
import { buildRouter } from './api.js';
import { allowedOrigins, HOST, LOG, PORT } from './config.js';
import { openDatabase } from './db.js';
import { dispatch, readJsonBody } from './router.js';
import { serveStatic } from './static.js';
import { userExistsCached } from './queries.js';
import { HttpError, httpError, sendError } from './util.js';

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function corsHeaders(origin, allowList) {
  if (!origin || !allowList.has(origin)) return null;
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Meta, Range, If-None-Match',
    'Access-Control-Expose-Headers': 'Content-Range, Accept-Ranges, Content-Length, X-Meta',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

function applyHeaders(res, headers) {
  if (!headers) return;
  for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
}

function logAccess({ method, route, status, ms, viewer }) {
  if (!LOG) return;
  const duration = ms >= 10 ? `${Math.round(ms)}ms` : `${ms.toFixed(1)}ms`;
  console.log(
    `${new Date().toISOString()} ${method.padEnd(6)} ${String(status).padEnd(3)} ${duration.padStart(8)}  ${route}${viewer ? ` uid=${viewer}` : ''}`
  );
}

function resolveViewer(req) {
  const userId = authenticate(req.headers);
  if (userId && userExistsCached(userId)) return { viewer: userId, authFailed: false };
  // An Authorization header that does not resolve is reported as 401 rather than
  // silently treated as anonymous, so a stale token never looks like success.
  return { viewer: 0, authFailed: Boolean(req.headers.authorization) };
}

export function createAppServer(options = {}) {
  const router = buildRouter();
  const staticDir = options.staticDir || null;
  const allowList = options.origins || allowedOrigins();
  openDatabase();

  const serve = async (req, res) => {
    const started = performance.now();
    let logged = false;
    let routeName = 'pending';
    const log = (status) => {
      if (logged) return;
      logged = true;
      logAccess({ method: req.method, route: routeName, status, ms: performance.now() - started, viewer });
    };

    let viewer = 0;
    res.on('finish', () => log(res.statusCode));
    res.on('close', () => log(res.statusCode || 499));

    applyHeaders(res, corsHeaders(req.headers.origin, allowList));

    if (req.method === 'OPTIONS') {
      routeName = 'preflight';
      res.writeHead(204, { 'Content-Length': '0' });
      res.end();
      return;
    }

    let pathname;
    let query;
    try {
      const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
      pathname = url.pathname;
      query = url.searchParams;
    } catch {
      routeName = 'malformed-url';
      sendError(res, 400, 'bad_request', 'malformed request target');
      req.destroy();
      return;
    }

    const matched = router.match(req.method, pathname);
    const entry = matched && matched.entry;
    routeName = entry
      ? entry.pattern
      : pathname.startsWith('/api')
        ? 'unmatched /api/*'
        : staticDir
          ? 'static'
          : 'unmatched';

    if (!entry) {
      if (matched && matched.mismatch) {
        sendError(res, 405, 'method_not_allowed', `${req.method} is not allowed on ${pathname}`);
        return;
      }
      if (staticDir) {
        try {
          if (await serveStatic(req, res, staticDir, pathname)) return;
        } catch (error) {
          const http = error instanceof HttpError ? error : null;
          sendError(res, http ? http.status : 500, http ? http.code : 'internal_error',
            http ? http.message : 'internal server error');
          return;
        }
      }
      sendError(res, 404, 'not_found', `no route for ${req.method} ${pathname}`);
      return;
    }

    const auth = resolveViewer(req);
    viewer = auth.viewer;

    let body = {};
    if (!entry.options.raw && BODY_METHODS.has(req.method)) {
      try {
        body = await readJsonBody(req);
      } catch (error) {
        const http = error instanceof HttpError ? error : httpError(400, 'bad_request', 'could not read request body');
        res.setHeader('Connection', 'close');
        sendError(res, http.status, http.code, http.message);
        return;
      }
    }

    await dispatch(entry, { req, res, params: matched.params, query, body, viewer, authFailed: auth.authFailed });
  };

  const server = http.createServer((req, res) => {
    serve(req, res).catch((error) => {
      console.error('[fatal] request handler:', error && (error.stack || error.message || error));
      if (!res.headersSent) sendError(res, 500, 'internal_error', 'internal server error');
      res.destroy();
    });
  });

  server.on('clientError', (error, socket) => {
    // A malformed request line should answer 400 without logging a stack trace.
    if (socket.writable && !socket.destroyed) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    } else {
      socket.destroy();
    }
  });

  server.on('error', (error) => {
    if (error && error.code === 'EADDRINUSE') {
      console.error(`[fatal] ${HOST}:${PORT} is already in use - stop the other server or set DY_PORT.`);
    }
  });

  return server;
}

export async function startServer(options = {}) {
  const port = Number(options.port || PORT);
  const host = options.host || HOST;
  const server = createAppServer({ ...options, port, host });
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
    server.listen(port, host);
  });
  return { server, port, host };
}
