#!/usr/bin/env node
/* Writes the hub's icon set into hub/icons/ (one-time asset script, like make-maskable-icons.js).

   PLACEHOLDER treatment, not a final design: the THD mark from engine/images/icons/icon-512.png,
   recoloured to ink, on a full-bleed accent-yellow square, so the hub is easy to tell apart
   from a client presentation (ink/grey icons) on a phone that has both installed.

   - icon-32/180/192/512.png: mark at the same size and position as in the project icons.
   - icon-maskable-192/512.png: mark inside Android's 80% safe circle (same rule as the
     project maskable icons).

   Usage, from THD SPACE/:  npm install --prefix tools   (once)
                            node tools/make-hub-icons.js */
"use strict";

const path = require("path");
const fs = require("fs");
const sharp = require("sharp");
const { readToken, hex, extractMark, SOURCE_SIZE } = require("./lib/icon-mark");

const OUT = path.join(__dirname, "..", "hub", "icons");
const SIZES = [32, 180, 192, 512];
const MASKABLE_SIZES = [192, 512];
const MARK_DIAMETER = 0.76; // as make-maskable-icons.js: inside the 80% circle, not touching it

async function write(file, size, mark, w, h, left, top, background) {
  const resized = await sharp(mark).resize(w, h, { kernel: "lanczos3" }).toBuffer();
  await sharp({ create: { width: size, height: size, channels: 4, background } })
    .composite([{ input: resized, left, top }])
    .flatten({ background })
    .png({ compressionLevel: 9 })
    .toFile(file);
  console.log(`wrote ${path.relative(path.join(__dirname, ".."), file)}: mark ${w}x${h}`);
}

async function main() {
  const ink = readToken("ink");
  const accent = readToken("accent");
  const { mark, box } = await extractMark(hex(ink));
  fs.mkdirSync(OUT, { recursive: true });

  for (const size of SIZES) {
    const k = size / SOURCE_SIZE;
    const w = Math.max(1, Math.round(box.width * k));
    const h = Math.max(1, Math.round(box.height * k));
    // Keep the source icon's placement: centred on the mark's own centre in the 512 original.
    const cx = (box.left + box.width / 2) * k;
    const cy = (box.top + box.height / 2) * k;
    await write(path.join(OUT, `icon-${size}.png`), size, mark, w, h, Math.round(cx - w / 2), Math.round(cy - h / 2), accent);
  }
  for (const size of MASKABLE_SIZES) {
    const k = MARK_DIAMETER * size / Math.hypot(box.width, box.height);
    const w = Math.floor(box.width * k);
    const h = Math.floor(box.height * k);
    await write(path.join(OUT, `icon-maskable-${size}.png`), size, mark, w, h, Math.round((size - w) / 2), Math.round((size - h) / 2), accent);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
