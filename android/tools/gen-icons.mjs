#!/usr/bin/env node
/**
 * Regenerates the legacy launcher PNGs (needed for API 24/25, which predate adaptive icons).
 *
 *   node android/tools/gen-icons.mjs
 *
 * Zero dependencies: it writes PNG (RGBA8, filter 0) by hand with node:zlib. The artwork is a
 * geometric "play" mark on an indigo -> violet gradient, produced from math only, so there is
 * no third-party/brand asset in the repo.
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'); // android/
const RES = path.join(ROOT, 'app', 'src', 'main', 'res');

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const TOP = [0x24, 0x1b, 0x5a]; // #241B5A
const BOTTOM = [0x6a, 0x3d, 0xe8]; // #6A3DE8
const lerp = (a, b, t) => Math.round(a + (b - a) * t);

/** Draw one icon at `size`; `round` masks the canvas to a circle instead of a squircle. */
function render(size, round) {
  const px = Buffer.alloc(size * size * 4);
  const c = size / 2;
  const radius = size / 2;
  const corner = size * 0.225; // squircle radius, roughly the adaptive-icon look
  // Play triangle, sized to the ~66% safe zone of an adaptive icon.
  const tri = { x: size * 0.395, y: size * 0.335, w: size * 0.28, h: size * 0.33 };

  const inSquircle = (x, y) => {
    const dx = Math.abs(x - c) - (radius - corner);
    const dy = Math.abs(y - c) - (radius - corner);
    if (dx <= 0 || dy <= 0) return true;
    return Math.hypot(dx, dy) <= corner;
  };

  const inTriangle = (x, y) => {
    // Left edge vertical at tri.x, apex to the right at mid height.
    if (x < tri.x || x > tri.x + tri.w) return false;
    const t = (x - tri.x) / tri.w; // 0..1
    const half = (tri.h / 2) * (1 - t);
    return Math.abs(y - (tri.y + tri.h / 2)) <= half;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const inside = round ? Math.hypot(x - c, y - c) <= radius : inSquircle(x, y);
      if (!inside) continue; // fully transparent outside the badge
      const g = y / (size - 1);
      let r = lerp(TOP[0], BOTTOM[0], g);
      let gg = lerp(TOP[1], BOTTOM[1], g);
      let b = lerp(TOP[2], BOTTOM[2], g);
      // soft glow ring behind the mark
      const d = Math.hypot(x - c, y - c) / radius;
      const ring = Math.max(0, 1 - Math.abs(d - 0.62) * 9) * 0.16;
      r = lerp(r, 255, ring);
      gg = lerp(gg, 255, ring);
      b = lerp(b, 255, ring);
      if (inTriangle(x, y)) {
        r = 255; gg = 255; b = 255;
      }
      px[i] = r; px[i + 1] = gg; px[i + 2] = b; px[i + 3] = 255;
    }
  }
  return px;
}

const DENSITIES = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
let count = 0;
for (const [dpi, size] of Object.entries(DENSITIES)) {
  const dir = path.join(RES, `mipmap-${dpi}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'ic_launcher.png'), encodePng(size, render(size, false)));
  writeFileSync(path.join(dir, 'ic_launcher_round.png'), encodePng(size, render(size, true)));
  count += 2;
  console.log(`mipmap-${dpi}: ic_launcher.png + ic_launcher_round.png @ ${size}px`);
}
console.log(`wrote ${count} PNGs under ${RES}`);
