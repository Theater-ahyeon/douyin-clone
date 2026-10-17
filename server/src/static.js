import fsp from 'node:fs/promises';
import path from 'node:path';

import { httpError } from './util.js';
import { streamFile } from './media.js';

const STATIC_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
  ['.ico', 'image/x-icon'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  ['.ttf', 'font/ttf'],
  ['.mp4', 'video/mp4'],
  ['.webm', 'video/webm'],
  ['.wasm', 'application/wasm'],
]);

// Reject any segment that could climb out of the web root, then re-verify with a
// resolved-prefix check so a crafted symlink cannot leak files above `root`.
export function resolveStaticPath(root, rawPathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(rawPathname);
  } catch {
    throw httpError(400, 'bad_path', 'malformed request path');
  }
  if (decoded.includes('\0')) throw httpError(400, 'bad_path', 'malformed request path');
  const relative = decoded.replace(/^[/\\]+/, '');
  const segments = relative.split(/[/\\]+/);
  if (segments.some((segment) => segment === '..' || segment === '.')) {
    throw httpError(400, 'bad_path', 'path traversal is not allowed');
  }
  const absolute = path.resolve(root, ...segments);
  const boundary = root.endsWith(path.sep) ? root : root + path.sep;
  if (absolute !== path.resolve(root) && !absolute.startsWith(boundary)) {
    throw httpError(400, 'bad_path', 'path traversal is not allowed');
  }
  return absolute;
}

async function statOrNull(target) {
  try {
    const stat = await fsp.stat(target);
    return stat.isFile() ? stat : null;
  } catch {
    return null;
  }
}

export function staticContentType(filePath) {
  return STATIC_TYPES.get(path.extname(filePath).toLowerCase()) || 'application/octet-stream';
}

/**
 * Serves the built frontend. Returns `false` when nothing matched so the caller can
 * fall through to a 404; otherwise it has already written the response.
 */
export async function serveStatic(req, res, root, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const target = resolveStaticPath(root, pathname);
  const indexFile = path.join(root, 'index.html');

  let filePath = target;
  let stat = await statOrNull(target);
  if (!stat) {
    const asDirIndex = path.join(target, 'index.html');
    stat = await statOrNull(asDirIndex);
    if (stat) {
      filePath = asDirIndex;
    } else {
      // SPA fallback: extension-less routes are app paths, not build assets.
      const lastSegment = pathname.split('/').filter(Boolean).pop() || '';
      const looksLikeAsset = /\.[a-z0-9]{2,5}$/i.test(lastSegment);
      if (looksLikeAsset) return false;
      if (!(await statOrNull(indexFile))) return false;
      await streamFile(req, res, indexFile, {
        acceptRanges: false,
        cacheControl: 'no-cache',
        contentType: 'text/html; charset=utf-8',
      });
      return true;
    }
  }

  const cacheControl = pathname.startsWith('/assets/')
    ? 'public, max-age=31536000, immutable'
    : 'no-cache';
  await streamFile(req, res, filePath, { cacheControl, contentType: staticContentType(filePath) });
  return true;
}

export { STATIC_TYPES };
