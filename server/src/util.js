import crypto from 'node:crypto';

// Mirrors db.js PERF_BASELINE so the JSON writer can be A/B'd without importing the
// data layer (util sits below it); both read the same env var. See scripts/benchmark.mjs.
const PERF_BASELINE = process.env.DY_PERF_BASELINE === '1';

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message || code || 'error');
    this.name = 'HttpError';
    this.status = status;
    this.code = code || 'error';
  }
}

export function httpError(status, code, message) {
  return new HttpError(status, code, message);
}

export function now() {
  return Date.now();
}

export function sendJson(res, status, payload, headers) {
  const body = JSON.stringify(payload === undefined ? null : payload);
  let length;
  let out;
  if (PERF_BASELINE) {
    // Baseline path: copy the whole payload into a fresh Buffer on every response.
    out = Buffer.from(body, 'utf8');
    length = out.length;
  } else {
    // Fast path: byteLength is a cheap scan with no allocation; res.end(string) lets
    // Node encode the JSON to utf8 exactly once at write time.
    out = body;
    length = Buffer.byteLength(body);
  }
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(length),
    'Cache-Control': 'no-store',
    ...(headers || {}),
  });
  res.end(out);
}

export function sendError(res, status, code, message) {
  sendJson(res, status, { error: { code, message } });
}

export function randomId(bytes = 16) {
  return crypto.randomBytes(bytes).toString('hex');
}

/* ---------------------------------------------------------------- cursor -- */

export function encodeCursor(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function decodeCursor(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  let text;
  try {
    text = Buffer.from(String(raw), 'base64url').toString('utf8');
  } catch {
    throw httpError(400, 'bad_cursor', 'cursor is not valid base64url');
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw httpError(400, 'bad_cursor', 'cursor is malformed');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw httpError(400, 'bad_cursor', 'cursor is malformed');
  }
  return parsed;
}

// Keyset cursors carry the last emitted (sort_key, id); both must stay integers.
export function cursorPos(cursor, keys) {
  if (!cursor) return null;
  const out = [];
  for (const key of keys) {
    const value = cursor[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
      throw httpError(400, 'bad_cursor', 'cursor is malformed');
    }
    out.push(value);
  }
  return out;
}

export function limitFrom(raw, fallback = 12, max = 50) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw httpError(400, 'bad_limit', 'limit must be a positive integer');
  return Math.min(n, max);
}

/* ------------------------------------------------------------- validation -- */

export function requireString(body, field, { max = 2000, min = 1 } = {}) {
  const value = body?.[field];
  if (typeof value !== 'string') throw httpError(400, 'invalid_request', `${field} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length < min) throw httpError(400, 'invalid_request', `${field} is required`);
  if (trimmed.length > max) throw httpError(400, 'invalid_request', `${field} must be at most ${max} characters`);
  return trimmed;
}

export function optionalString(body, field, { max = 2000 } = {}) {
  const value = body?.[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw httpError(400, 'invalid_request', `${field} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw httpError(400, 'invalid_request', `${field} must be at most ${max} characters`);
  return trimmed;
}

export function optionalNumber(body, field, { min = 0, max = Number.MAX_SAFE_INTEGER, fallback = 0 } = {}) {
  const value = body?.[field];
  if (value === undefined || value === null || value === '') return fallback;
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max) {
    throw httpError(400, 'invalid_request', `${field} must be a number between ${min} and ${max}`);
  }
  return n;
}

export function optionalColor(value, field, fallback) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return '';
  if (typeof value !== 'string' || !/^#[0-9a-fA-F]{3,8}$/.test(value)) {
    throw httpError(400, 'invalid_request', `${field} must be a hex color such as #fe2c55`);
  }
  return value.toLowerCase();
}

export const AVATAR_COLORS = [
  '#fe2c55', '#12b7f5', '#25f4ee', '#ff7e5f', '#7c5cff',
  '#00c9a7', '#f5a623', '#e91e63', '#4a90d9', '#8e44ad',
];

export function hashSeed(value) {
  let h = 0;
  const text = String(value ?? '');
  for (let i = 0; i < text.length; i += 1) h = (h * 31 + text.charCodeAt(i)) >>> 0;
  return h;
}

export function pickColor(seed) {
  return AVATAR_COLORS[hashSeed(seed) % AVATAR_COLORS.length];
}

/* ---------------------------------------------------------------- poster -- */

const GRADIENTS = [
  ['#1f1230', '#fe2c55'],
  ['#04101f', '#12b7f5'],
  ['#0b1d16', '#25f4ee'],
  ['#241303', '#f5a623'],
  ['#160b26', '#7c5cff'],
  ['#001f1c', '#00c9a7'],
];

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function syntheticPoster(title, seed = 0) {
  const [from, to] = GRADIENTS[hashSeed(seed) % GRADIENTS.length];
  const label = escapeXml(String(title || '').slice(0, 24) || 'Douyin Clone');
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="540" height="960" viewBox="0 0 540 960" role="img">` +
    `<title>${label}</title>` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs>` +
    `<rect width="540" height="960" fill="url(#g)"/>` +
    `<circle cx="430" cy="180" r="150" fill="#ffffff" opacity="0.07"/>` +
    `</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
}
