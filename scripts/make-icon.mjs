/*
 * Generates media/icon.png — the 128x128 extension icon used by the
 * Marketplace listing. Pure Node (zlib only): shapes are rasterised with 4x
 * supersampling and the PNG is encoded by hand, so there is no image tooling
 * to install and the asset is reproducible from source.
 *
 *   node scripts/make-icon.mjs
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const SIZE = 128;
const SS = 4;
const N = SIZE * SS;

const here = path.dirname(fileURLToPath(import.meta.url));
const outFile = path.resolve(here, "..", "media", "icon.png");

/* ------------------------------------------------------------ png writer */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let value = i;
    for (let bit = 0; bit < 8; bit++) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i++) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc(height * (1 + width * 4));
  let p = 0;
  for (let y = 0; y < height; y++) {
    raw[p++] = 0;
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4;
      raw[p++] = rgba[at];
      raw[p++] = rgba[at + 1];
      raw[p++] = rgba[at + 2];
      raw[p++] = rgba[at + 3];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* --------------------------------------------------------------- drawing */

/** Supersampled RGBA canvas; colours are straight (non-premultiplied). */
const canvas = new Float64Array(N * N * 4);

const mix = (a, b, t) => a + (b - a) * t;

function paint(x, y, rgb, alpha = 1) {
  if (alpha <= 0) {
    return;
  }
  const at = (y * N + x) * 4;
  const previous = canvas[at + 3];
  const next = alpha + previous * (1 - alpha);
  if (next <= 0) {
    return;
  }
  for (let c = 0; c < 3; c++) {
    canvas[at + c] = (rgb[c] * alpha + canvas[at + c] * previous * (1 - alpha)) / next;
  }
  canvas[at + 3] = next;
}

function insideRoundedRect(x, y, x0, y0, x1, y1, radius) {
  if (x < x0 || x > x1 || y < y0 || y > y1) {
    return false;
  }
  const cx = Math.min(Math.max(x, x0 + radius), x1 - radius);
  const cy = Math.min(Math.max(y, y0 + radius), y1 - radius);
  if (x === cx || y === cy) {
    return true;
  }
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius * radius;
}

function insidePolygon(x, y, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** Rasterise a shape described by a predicate, in 128-space coordinates. */
function fill(predicate, colourAt) {
  for (let sy = 0; sy < N; sy++) {
    const y = (sy + 0.5) / SS;
    for (let sx = 0; sx < N; sx++) {
      const x = (sx + 0.5) / SS;
      if (!predicate(x, y)) {
        continue;
      }
      const rgb = typeof colourAt === "function" ? colourAt(x, y) : colourAt;
      paint(sx, sy, rgb, rgb[3] === undefined ? 1 : rgb[3]);
    }
  }
}

const polygon = (points) => (x, y) => insidePolygon(x, y, points);
const rect = (x0, y0, x1, y1) => (x, y) => x >= x0 && x <= x1 && y >= y0 && y <= y1;

const BG_TOP = [0x3a, 0x4e, 0x78];
const BG_BOTTOM = [0x18, 0x1f, 0x30];
const PAGE_LIGHT = [0xf8, 0xf2, 0xe6];
const PAGE_SHADE = [0xe7, 0xdc, 0xc5];
const SPINE = [0xcf, 0xc1, 0xa3];
const RIBBON = [0xe8, 0xa3, 0x3d];
const RIBBON_DARK = [0xcf, 0x8b, 0x2a];
const RULE = [0xb3, 0xa5, 0x89];

/* 1. rounded background with a vertical gradient */
fill(
  (x, y) => insideRoundedRect(x, y, 4, 4, SIZE - 4, SIZE - 4, 26),
  (_x, y) => {
    const t = Math.min(1, Math.max(0, (y - 4) / (SIZE - 8)));
    return [mix(BG_TOP[0], BG_BOTTOM[0], t), mix(BG_TOP[1], BG_BOTTOM[1], t), mix(BG_TOP[2], BG_BOTTOM[2], t), 1];
  },
);

/* 2. open book: two pages meeting at the spine, with a soft drop shadow */
const LEFT_PAGE = [
  [24, 46],
  [62.5, 39],
  [62.5, 93],
  [24, 86],
];
const RIGHT_PAGE = [
  [65.5, 39],
  [104, 46],
  [104, 86],
  [65.5, 93],
];
const shadow = (x, y) =>
  insidePolygon(x, y + 2.5, LEFT_PAGE) || insidePolygon(x, y + 2.5, RIGHT_PAGE);
fill(shadow, [0, 0, 0, 0.22]);
fill(polygon(LEFT_PAGE), PAGE_LIGHT);
fill(polygon(RIGHT_PAGE), PAGE_SHADE);

/* 3. spine crease */
fill(polygon([[62.5, 39], [65.5, 39], [65.5, 93], [62.5, 93]]), SPINE);

/* 4. text rules on both pages */
for (const y of [54, 62, 70]) {
  fill(rect(31, y, 56, y + 2), [RULE[0], RULE[1], RULE[2], 0.85]);
}
for (const y of [54, 62, 70]) {
  fill(rect(72, y, 97, y + 2), [RULE[0], RULE[1], RULE[2], 0.7]);
}

/* 5. bookmark ribbon on the right page */
fill(polygon([[86, 44], [95, 44], [95, 74], [90.5, 67], [86, 74]]), RIBBON);
fill(polygon([[86, 44], [95, 44], [95, 50], [86, 50]]), RIBBON_DARK);

/* ------------------------------------------------------------ downsample */

const rgba = Buffer.alloc(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 0;
    for (let dy = 0; dy < SS; dy++) {
      for (let dx = 0; dx < SS; dx++) {
        const at = ((y * SS + dy) * N + (x * SS + dx)) * 4;
        const alpha = canvas[at + 3];
        r += canvas[at] * alpha;
        g += canvas[at + 1] * alpha;
        b += canvas[at + 2] * alpha;
        a += alpha;
      }
    }
    const at = (y * SIZE + x) * 4;
    if (a > 0) {
      rgba[at] = Math.round(r / a);
      rgba[at + 1] = Math.round(g / a);
      rgba[at + 2] = Math.round(b / a);
      rgba[at + 3] = Math.round((a / (SS * SS)) * 255);
    }
  }
}

const png = encodePng(SIZE, SIZE, rgba);
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, png);

/* ---------------------------------------------------------------- report */

const opaque = rgba.filter((_value, index) => index % 4 === 3).filter((a) => a > 250).length;
console.log(`wrote ${path.relative(path.resolve(here, ".."), outFile)}`);
console.log(`  size      : ${SIZE}x${SIZE}, ${(png.length / 1024).toFixed(1)} KB`);
console.log(`  opaque px : ${opaque} / ${SIZE * SIZE}`);
