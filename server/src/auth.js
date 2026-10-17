import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR, TOKEN_SECRET_FILE } from './config.js';
import { HttpError } from './util.js';

const KEY_LENGTH = 64;
const SALT_BYTES = 16;
const SCRYPT_PREFIX = 'scrypt$16384$8$1';

export function hashPassword(password, existingSalt) {
  const salt = existingSalt || crypto.randomBytes(SALT_BYTES).toString('hex');
  const derived = crypto.scryptSync(String(password), Buffer.from(salt, 'hex'), KEY_LENGTH);
  return { salt, hash: `${SCRYPT_PREFIX}$${salt}$${derived.toString('hex')}` };
}

export function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  // Format: scrypt$N$r$p$<saltHex>$<hashHex>
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const salt = parts[4];
  const expected = parts[5];
  if (!salt || !expected) return false;
  const expectedBuf = Buffer.from(expected, 'hex');
  if (expectedBuf.length !== KEY_LENGTH) return false;
  // scryptSync always returns KEY_LENGTH bytes, so timingSafeEqual cannot throw on size here.
  const actual = crypto.scryptSync(String(password), Buffer.from(salt, 'hex'), KEY_LENGTH);
  return crypto.timingSafeEqual(actual, expectedBuf);
}

let cachedSecret = null;

function loadSecret() {
  if (cachedSecret) return cachedSecret;
  const fromEnv = process.env.DY_TOKEN_SECRET;
  if (fromEnv && fromEnv.trim().length >= 16) {
    cachedSecret = Buffer.from(fromEnv.trim(), 'utf8');
    return cachedSecret;
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try {
    const disk = fs.readFileSync(TOKEN_SECRET_FILE, 'utf8').trim();
    if (disk.length >= 32) {
      cachedSecret = Buffer.from(disk, 'hex');
      return cachedSecret;
    }
  } catch {
    /* first run: no secret file yet */
  }
  const secret = crypto.randomBytes(32).toString('hex');
  try {
    // `wx` + 0600 so a second process racing us fails loudly instead of overwriting
    // a live secret (which would invalidate every issued token). Windows/NTFS
    // ignores the mode bits, hence the O_EXCL guard remains the real protection.
    const fd = fs.openSync(TOKEN_SECRET_FILE, 'wx', 0o600);
    fs.writeSync(fd, secret);
    fs.closeSync(fd);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const disk = fs.readFileSync(TOKEN_SECRET_FILE, 'utf8').trim();
    if (disk.length >= 32) {
      cachedSecret = Buffer.from(disk, 'hex');
      return cachedSecret;
    }
  }
  try {
    fs.chmodSync(TOKEN_SECRET_FILE, 0o600);
  } catch {
    /* best effort on platforms without POSIX permissions */
  }
  cachedSecret = Buffer.from(secret, 'hex');
  return cachedSecret;
}

export function tokenTtlMs() {
  const raw = Number(process.env.DY_TOKEN_TTL_MS || 0);
  return raw > 0 ? raw : 30 * 24 * 60 * 60 * 1000;
}

function sign(data) {
  return crypto.createHmac('sha256', loadSecret()).update(data).digest();
}

export function createToken(userId, { ttlMs = tokenTtlMs(), now = Date.now() } = {}) {
  const payload = { uid: Number(userId), iat: now, exp: now + ttlMs };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const mac = base64url(sign(body));
  return `${body}.${mac}`;
}

function base64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

export function verifyToken(token) {
  if (typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0 || dot === token.length - 1) return null;
  const body = token.slice(0, dot);
  const provided = Buffer.from(token.slice(dot + 1), 'base64url');
  const expected = sign(body);
  if (provided.length !== expected.length) {
    // Compare against a same-length buffer anyway: an early return here would leak
    // signature length through response timing.
    crypto.timingSafeEqual(expected, Buffer.alloc(expected.length));
    return null;
  }
  if (!crypto.timingSafeEqual(provided, expected)) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || !Number.isInteger(payload.uid) || payload.uid <= 0) return null;
  if (!Number.isFinite(payload.exp) || payload.exp <= Date.now()) return null;
  return { userId: payload.uid, exp: payload.exp };
}

export function bearerFrom(headers) {
  const raw = headers.authorization;
  if (!raw) return null;
  const match = /^Bearer\s+(.+)$/i.exec(String(raw).trim());
  return match ? match[1].trim() : null;
}

export function authenticate(headers) {
  const token = bearerFrom(headers);
  if (!token) return null;
  const result = verifyToken(token);
  return result ? result.userId : null;
}

export function requireUser(viewerId) {
  if (!viewerId) throw new HttpError(401, 'unauthorized', 'authentication required');
  return viewerId;
}

export function secretFile() {
  return path.resolve(TOKEN_SECRET_FILE);
}
