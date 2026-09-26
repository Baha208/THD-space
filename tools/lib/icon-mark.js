/* Shared by tools/make-maskable-icons.js and tools/make-hub-icons.js: reads brand tokens and
   lifts the THD mark out of engine/images/icons/icon-512.png as an alpha mask. The icon is two
   flat colours, so each pixel's position between background and mark colour gives its coverage,
   which keeps anti-aliased edges clean when the mark is recoloured or put on a new background. */
"use strict";

const path = require("path");
const sharp = require("sharp");
const { readToken } = require("./tokens");

const SOURCE = path.join(__dirname, "..", "..", "engine", "images", "icons", "icon-512.png");
const SOURCE_SIZE = 512;

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

// The THD mark from icon-512.png as a trimmed RGBA PNG: colour = the mark's own (or `color`),
// alpha = coverage. Also returns its box in the 512 source, and the source's two colours.
async function extractMark(color) {
  const { data, info } = await sharp(SOURCE).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  // The two most common colours: background, then the mark.
  const counts = new Map();
  for (let i = 0; i < data.length; i += channels) {
    if (data[i + 3] < 255) continue;
    const k = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const [bgKey, fgKey] = [...counts].sort((a, b) => b[1] - a[1]).map((e) => e[0]);
  const bg = [bgKey >> 16, (bgKey >> 8) & 255, bgKey & 255];
  const fg = [fgKey >> 16, (fgKey >> 8) & 255, fgKey & 255];
  const d = fg.map((v, i) => v - bg[i]);
  const dd = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];

  const out = Buffer.alloc(width * height * 4);
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels;
      const t = ((data[i] - bg[0]) * d[0] + (data[i + 1] - bg[1]) * d[1] + (data[i + 2] - bg[2]) * d[2]) / dd;
      const a = Math.round(Math.max(0, Math.min(1, t)) * 255);
      const o = (y * width + x) * 4;
      const c = color || fg;
      out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2]; out[o + 3] = a;
      if (a > 8) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  const box = { left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
  const mark = await sharp(out, { raw: { width, height, channels: 4 } }).extract(box).png().toBuffer();
  return { mark, box, bg, fg };
}

module.exports = { readToken, hex, extractMark, SOURCE, SOURCE_SIZE };
