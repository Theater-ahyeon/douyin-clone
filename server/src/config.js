import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const srcDir = path.dirname(fileURLToPath(import.meta.url));

// Every environment variable the server and scripts read, so a fresh clone has one
// place to look:
//   DY_DATA_DIR          writable dir for app.sqlite, .token-secret and videos/
//   DY_HOST / DY_PORT    bind address (127.0.0.1 / 8787)
//   DY_LOG               0 disables the per-request access log
//   DY_CORS_ORIGINS      comma list appended to the dev origins below
//   DY_MAX_UPLOAD_BYTES  upload cap (256 MiB)
//   DY_TOKEN_SECRET      HMAC key; wins over <data-dir>/.token-secret (>=16 chars).
//                        Set it when several processes must share one token space.
//   DY_TOKEN_TTL_MS      token lifetime (30 days)
//   DY_WEB_DIST          web build served by scripts/start.mjs
//   DY_WEB_PORT          Vite port for scripts/dev.mjs
//   DY_DEBUG             print seed stack traces
//   DY_BENCH_VERBOSE     stream the benchmark child-server output
//   DY_ELMONITOR         enable /api/__perf event-loop instrumentation
//   DY_PERF_BASELINE     1 disables the read-path mitigations (benchmark A/B only)
export const SERVER_ROOT = path.resolve(srcDir, '..');
export const REPO_ROOT = path.resolve(SERVER_ROOT, '..');

const dataDir = process.env.DY_DATA_DIR
  ? path.resolve(process.env.DY_DATA_DIR)
  : path.join(SERVER_ROOT, 'data');

export const DATA_DIR = dataDir;
export const DB_FILE = path.join(dataDir, 'app.sqlite');
export const TOKEN_SECRET_FILE = path.join(dataDir, '.token-secret');
// Named `videos`/`thumbs` so the root .gitignore rule `data/videos/` and `data/thumbs/` keeps uploads out of version control.
export const MEDIA_DIR = path.join(dataDir, 'videos');
export const THUMB_DIR = path.join(dataDir, 'thumbs');

export const HOST = process.env.DY_HOST || '127.0.0.1';
export const PORT = Number(process.env.DY_PORT || 8787);

export const MAX_JSON_BYTES = 1024 * 1024;
export const MAX_UPLOAD_BYTES = Number(process.env.DY_MAX_UPLOAD_BYTES || 256 * 1024 * 1024);

export const LOG = process.env.DY_LOG !== '0';

export const DEV_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173'];

export function allowedOrigins() {
  const extra = (process.env.DY_CORS_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return new Set([...DEV_ORIGINS, ...extra]);
}

export const MEDIA_TYPES = new Map([
  ['.mp4', 'video/mp4'],
  ['.m4v', 'video/mp4'],
  ['.webm', 'video/webm'],
  ['.ogv', 'video/ogg'],
  ['.mov', 'video/quicktime'],
  ['.mkv', 'video/x-matroska'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
  ['.svg', 'image/svg+xml'],
]);

export const UPLOAD_TYPES = new Map([
  ['video/mp4', '.mp4'],
  ['video/webm', '.webm'],
  ['video/quicktime', '.mov'],
  ['video/x-matroska', '.mkv'],
  ['video/ogg', '.ogv'],
]);
