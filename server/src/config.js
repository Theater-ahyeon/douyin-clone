import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const srcDir = path.dirname(fileURLToPath(import.meta.url));

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
