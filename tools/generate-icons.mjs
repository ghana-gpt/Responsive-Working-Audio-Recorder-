#!/usr/bin/env node
/**
 * Generate the PWA icons without any dependency.
 *
 * The artwork (rounded indigo square + white microphone) is drawn with simple
 * signed-distance tests and supersampled for smooth edges, then written as a
 * PNG using the standard zlib + CRC32 pair. The CRC32 implementation is shared
 * with the app's ZIP writer so the two stay consistent.
 *
 * Usage: node tools/generate-icons.mjs
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

import { crc32 } from '../scripts/modules/zip.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'icons');

/** Samples per axis (3 x 3 = 9 samples per pixel). */
const SUPERSAMPLE = 3;

const INDIGO = [79, 70, 229];
const INDIGO_DEEP = [67, 56, 202];
const WHITE = [255, 255, 255];

// ------------------------------------------------------------ PNG writer ---

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Build one PNG chunk: length + type + data + CRC32(type + data). */
function chunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBytes, data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(new Uint8Array(body)), body.length + 4);
  return out;
}

/**
 * Encode raw RGBA pixels as a PNG.
 * @param {number} size
 * @param {Uint8Array} rgba size * size * 4 bytes
 * @returns {Buffer}
 */
function encodePng(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: truecolour + alpha
  header[10] = 0; // deflate
  header[11] = 0; // adaptive filtering
  header[12] = 0; // no interlacing

  // Each scanline is prefixed with filter type 0 (none).
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --------------------------------------------------------------- geometry ---

const insideCircle = (x, y, cx, cy, r) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;

function insideRoundedRect(x, y, left, top, right, bottom, radius) {
  if (x < left || x > right || y < top || y > bottom) return false;
  const nearestX = Math.min(Math.max(x, left + radius), right - radius);
  const nearestY = Math.min(Math.max(y, top + radius), bottom - radius);
  return (x - nearestX) ** 2 + (y - nearestY) ** 2 <= radius * radius;
}

/** Thick line segment test (used for the stand and the base). */
function insideSegment(x, y, x1, y1, x2, y2, width) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSquared = dx * dx + dy * dy || 1;
  const t = Math.min(1, Math.max(0, ((x - x1) * dx + (y - y1) * dy) / lengthSquared));
  const px = x1 + t * dx;
  const py = y1 + t * dy;
  return insideCircle(x, y, px, py, width / 2);
}

/** Bottom half of a ring: the microphone's cradle. */
function insideArc(x, y, cx, cy, radius, thickness) {
  if (y < cy) return false;
  const distance = Math.hypot(x - cx, y - cy);
  return Math.abs(distance - radius) <= thickness / 2;
}

/** @param {number} x @param {number} y normalised 0..1 coordinates */
function insideGlyph(x, y) {
  return (
    // capsule (body)
    insideRoundedRect(x, y, 0.38, 0.2, 0.62, 0.5, 0.12) ||
    // cradle
    insideArc(x, y, 0.5, 0.42, 0.26, 0.055) ||
    // stand
    insideSegment(x, y, 0.5, 0.68, 0.5, 0.755, 0.05) ||
    // base
    insideSegment(x, y, 0.36, 0.775, 0.64, 0.775, 0.055)
  );
}

function lerp(a, b, t) {
  return Math.round(a + (b - a) * t);
}

/**
 * Render one icon.
 * @param {number} size pixels
 * @param {{ maskable?: boolean }} [options]
 * @returns {Buffer} PNG bytes
 */
function render(size, { maskable = false } = {}) {
  const rgba = new Uint8Array(size * size * 4);
  const radius = maskable ? 0 : 0.22;
  const glyphScale = maskable ? 0.72 : 1;
  const glyphOffset = (1 - glyphScale) / 2;
  const samples = SUPERSAMPLE * SUPERSAMPLE;

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let glyph = 0;
      let background = 0;
      let shade = 0;

      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          const x = (px + (sx + 0.5) / SUPERSAMPLE) / size;
          const y = (py + (sy + 0.5) / SUPERSAMPLE) / size;
          if (!insideRoundedRect(x, y, 0, 0, 1, 1, radius)) continue;
          background += 1;
          shade += (x + y) / 2;
          const gx = (x - glyphOffset) / glyphScale;
          const gy = (y - glyphOffset) / glyphScale;
          if (gx >= 0 && gx <= 1 && gy >= 0 && gy <= 1 && insideGlyph(gx, gy)) glyph += 1;
        }
      }

      const offset = (py * size + px) * 4;
      if (background === 0) continue; // transparent corner

      const mix = shade / background;
      const alpha = Math.round((background / samples) * 255);
      const coverage = glyph / background;

      for (let channel = 0; channel < 3; channel += 1) {
        const base = lerp(INDIGO[channel], INDIGO_DEEP[channel], mix);
        rgba[offset + channel] = Math.round(base + (WHITE[channel] - base) * coverage);
      }
      rgba[offset + 3] = alpha;
    }
  }

  return encodePng(size, rgba);
}

mkdirSync(OUT_DIR, { recursive: true });

const targets = [
  { file: 'icon-192.png', size: 192, maskable: false },
  { file: 'icon-512.png', size: 512, maskable: false },
  { file: 'icon-maskable-512.png', size: 512, maskable: true },
];

for (const { file, size, maskable } of targets) {
  const png = render(size, { maskable });
  writeFileSync(join(OUT_DIR, file), png);
  console.log(`icons/${file}  ${size}x${size}  ${png.length} bytes`);
}

console.log('Icons written to', OUT_DIR);
