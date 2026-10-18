import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { MEDIA_DIR, MEDIA_TYPES, MAX_UPLOAD_BYTES, UPLOAD_TYPES } from './config.js';
import { HttpError, httpError, randomId } from './util.js';

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function mediaDir() {
  return MEDIA_DIR;
}

export async function ensureMediaDir() {
  await fsp.mkdir(MEDIA_DIR, { recursive: true });
  return MEDIA_DIR;
}

export function mediaUrl(filename) {
  return `/media/${encodeURIComponent(filename)}`;
}

// Two independent guards: a syntactic whitelist that refuses separators/`..` at all,
// and a resolved-prefix check so a symlink or odd encoding can never escape MEDIA_DIR.
export function resolveMediaPath(rawName) {
  const name = String(rawName || '');
  if (!name || name.includes('/') || name.includes('\\') || name.includes('..') || !SAFE_NAME.test(name)) {
    throw httpError(400, 'bad_path', 'media filename is not allowed');
  }
  const ext = path.extname(name).toLowerCase();
  if (!MEDIA_TYPES.has(ext)) {
    throw httpError(404, 'not_found', 'media not found');
  }
  const absolute = path.resolve(MEDIA_DIR, name);
  const root = MEDIA_DIR.endsWith(path.sep) ? MEDIA_DIR : MEDIA_DIR + path.sep;
  if (!absolute.startsWith(root)) throw httpError(400, 'bad_path', 'media filename is not allowed');
  return absolute;
}

/* ------------------------------------------------------------- range core -- */

export function contentTypeForFile(filePath) {
  return MEDIA_TYPES.get(path.extname(filePath).toLowerCase()) || 'application/octet-stream';
}

export function etagFor(stat) {
  return `W/"${stat.size.toString(16)}-${Math.trunc(stat.mtimeMs).toString(16)}"`;
}

/**
 * Returns `null` when the request has no usable Range (serve whole file),
 * `{ ranges: [] }` when it is unsatisfiable (416), otherwise the clamped list.
 */
export function parseRange(header, size) {
  if (!header) return null;
  const text = String(header).trim();
  const match = /^bytes=(.+)$/i.exec(text);
  if (!match) return null;
  const specs = match[1].split(',').map((s) => s.trim()).filter(Boolean);
  if (specs.length === 0 || specs.length > 8) return { ranges: [], tooMany: specs.length > 8 };

  const ranges = [];
  for (const spec of specs) {
    const parts = /^(\d*)-(\d*)$/.exec(spec);
    if (!parts) return null; // syntactically invalid: ignore per RFC 9110
    const [, rawStart, rawEnd] = parts;
    if (rawStart === '' && rawEnd === '') return null;
    if (rawStart === '') {
      const suffix = Number(rawEnd);
      if (!Number.isFinite(suffix) || suffix <= 0) return null;
      if (size === 0) continue;
      const start = Math.max(0, size - Math.min(suffix, size));
      ranges.push({ start, end: size - 1 });
      continue;
    }
    const start = Number(rawStart);
    if (!Number.isFinite(start)) return null;
    if (rawEnd === '') {
      if (start >= size) continue;
      ranges.push({ start, end: size - 1 });
      continue;
    }
    const end = Number(rawEnd);
    if (!Number.isFinite(end)) return null;
    // first > last makes the byte-range-spec invalid (not merely unsatisfiable),
    // and an invalid byte-range-set must be ignored outright by the recipient.
    if (end < start) return null;
    if (start >= size) continue;
    ranges.push({ start, end: Math.min(end, size - 1) });
  }
  return { ranges };
}

function pipeOne(stream, res) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    // Pause on a `false` return from write() instead of dropping data or buffering it:
    // that is how a slow client keeps memory flat while we stream megabytes.
    stream.on('data', (chunk) => {
      if (!res.write(chunk)) stream.pause();
    });
    stream.on('end', finish);
    stream.on('error', finish);
    stream.on('close', finish);
    res.on('drain', () => {
      if (!stream.destroyed) stream.resume();
    });
  });
}

async function writeText(res, text) {
  if (res.destroyed) return;
  if (res.write(text)) return;
  // 'drain' never arrives once the socket is gone, so resolve on close/error too
  // instead of stranding the multipart loop on a dead client.
  await new Promise((resolve) => {
    res.once('drain', resolve);
    res.once('close', resolve);
    res.once('error', resolve);
  });
}

/**
 * Streams `filePath` honouring HTTP Range requests: 206 with Content-Range for a
 * single range, multipart/byteranges for several, 416 when unsatisfiable, 200 plain.
 */
export async function streamFile(req, res, filePath, opts = {}) {
  const acceptRanges = opts.acceptRanges !== false;
  const cacheControl = opts.cacheControl || 'public, max-age=31536000, immutable';
  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    throw httpError(404, 'not_found', 'media not found');
  }
  if (!stat.isFile()) throw httpError(404, 'not_found', 'media not found');

  const size = stat.size;
  const type = opts.contentType || contentTypeForFile(filePath);
  const etag = etagFor(stat);
  const isHead = req.method === 'HEAD';
  const wantsRange = acceptRanges && req.headers.range !== undefined && req.headers.range !== '';
  const parsed = wantsRange ? parseRange(req.headers.range, size) : null;

  if (!wantsRange && req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag, 'Cache-Control': cacheControl });
    res.end();
    return;
  }

  const baseHeaders = {
    'Content-Type': type,
    'Last-Modified': stat.mtime.toUTCString(),
    ETag: etag,
    'Cache-Control': cacheControl,
    'Accept-Ranges': acceptRanges ? 'bytes' : 'none',
  };

  if (parsed && parsed.tooMany) {
    res.writeHead(416, { ...baseHeaders, 'Content-Range': `bytes */${size}` });
    res.end();
    return;
  }
  if (parsed && parsed.ranges.length === 0) {
    res.writeHead(416, { ...baseHeaders, 'Content-Range': `bytes */${size}` });
    res.end();
    return;
  }

  let aborted = false;
  const openStreams = new Set();
  const abort = () => {
    aborted = true;
    for (const stream of openStreams) stream.destroy();
    openStreams.clear();
  };
  req.on('aborted', abort);
  req.on('close', () => {
    if (!res.writableEnded) abort();
  });
  res.on('error', abort);

  try {
    if (!parsed) {
      res.writeHead(200, { ...baseHeaders, 'Content-Length': String(size) });
      if (isHead || size === 0) {
        res.end();
        return;
      }
      const stream = fs.createReadStream(filePath);
      openStreams.add(stream);
      await pipeOne(stream, res);
      res.end();
      return;
    }

    const ranges = parsed.ranges;
    if (ranges.length === 1) {
      const { start, end } = ranges[0];
      res.writeHead(206, {
        ...baseHeaders,
        'Content-Length': String(end - start + 1),
        'Content-Range': `bytes ${start}-${end}/${size}`,
      });
      if (isHead) {
        res.end();
        return;
      }
      const stream = fs.createReadStream(filePath, { start, end });
      openStreams.add(stream);
      await pipeOne(stream, res);
      res.end();
      return;
    }

    const boundary = `dy${randomId(8)}`;
    const parts = ranges.map(({ start, end }) => {
      const head =
        `--${boundary}\r\n` +
        `Content-Type: ${type}\r\n` +
        `Content-Range: bytes ${start}-${end}/${size}\r\n\r\n`;
      return { start, end, head, tail: '\r\n', headBytes: Buffer.byteLength(head) };
    });
    const total =
      parts.reduce((sum, p) => sum + p.headBytes + (p.end - p.start + 1) + p.tail.length, 0) +
      Buffer.byteLength(`--${boundary}--\r\n`);

    res.writeHead(206, {
      ...baseHeaders,
      'Content-Type': `multipart/byteranges; boundary=${boundary}`,
      'Content-Length': String(total),
    });
    if (isHead) {
      res.end();
      return;
    }
    for (const part of parts) {
      if (aborted || res.destroyed) return;
      await writeText(res, part.head);
      const stream = fs.createReadStream(filePath, { start: part.start, end: part.end });
      openStreams.add(stream);
      await pipeOne(stream, res);
      openStreams.delete(stream);
      await writeText(res, part.tail);
    }
    await writeText(res, `--${boundary}--\r\n`);
    res.end();
  } catch (error) {
    abort();
    if (!(error instanceof HttpError && error.code === 'client_aborted')) {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      try {
        res.end();
      } catch {
        /* response already gone */
      }
    }
  } finally {
    for (const stream of openStreams) stream.destroy();
  }
}

/* ---------------------------------------------------------------- upload --- */

function extensionForType(contentType) {
  const base = String(contentType || '').split(';')[0].trim().toLowerCase();
  const ext = UPLOAD_TYPES.get(base);
  if (!ext) {
    throw httpError(415, 'unsupported_media', `Content-Type must be one of ${[...UPLOAD_TYPES.keys()].join(', ')}`);
  }
  return { ext, mime: base };
}

/**
 * Streams the raw request body straight to disk. Never accumulates the upload in
 * memory; aborts (and deletes the partial file) once `maxBytes` is crossed.
 */
export async function saveUpload(req, { ownerId, contentType, maxBytes = MAX_UPLOAD_BYTES } = {}) {
  const { ext, mime } = extensionForType(contentType);
  await ensureMediaDir();
  const filename = `${Date.now().toString(36)}-${randomId(8)}${ext}`;
  const target = path.resolve(MEDIA_DIR, filename);

  const writeStream = fs.createWriteStream(target, { flags: 'wx' });
  let bytes = 0;
  let settled = false;

  const cleanup = () => {
    if (!writeStream.destroyed) writeStream.destroy();
    return fsp.rm(target, { force: true }).catch(() => {});
  };

  await new Promise((resolve, reject) => {
    const fail = (error) => {
      if (settled) return;
      settled = true;
      writeStream.off('finish', onFinish);
      cleanup().finally(() => reject(error));
    };
    const onFinish = () => {
      if (settled) return;
      // pipe() also ends the destination when the source closes early, so a
      // truncated body can reach 'finish'. Only a fully received message is a file.
      if (!req.complete) {
        fail(httpError(499, 'client_aborted', 'upload aborted'));
        return;
      }
      settled = true;
      resolve();
    };

    writeStream.on('error', (error) => fail(httpError(500, 'write_failed', error.message)));
    writeStream.on('finish', onFinish);
    req.on('aborted', () => fail(httpError(499, 'client_aborted', 'upload aborted')));
    req.on('close', () => {
      if (!settled && !req.complete) fail(httpError(499, 'client_aborted', 'upload aborted'));
    });
    req.on('data', (chunk) => {
      bytes += chunk.length;
      // Cannot rely on pipe() alone here: we must cap total bytes, so the size
      // check lives on 'data' while pipe() still owns backpressure.
      if (bytes > maxBytes) fail(httpError(413, 'payload_too_large', `upload exceeds ${maxBytes} bytes`));
    });
    req.pipe(writeStream);
  });

  const stat = await fsp.stat(target);
  if (stat.size === 0) {
    await fsp.rm(target, { force: true }).catch(() => {});
    throw httpError(400, 'empty_upload', 'uploaded body is empty');
  }
  return { filename, bytes: stat.size, contentType: mime };
}

export async function mediaExists(filename) {
  try {
    const absolute = resolveMediaPath(filename);
    const stat = await fsp.stat(absolute);
    return stat.isFile() ? stat : null;
  } catch {
    return null;
  }
}
