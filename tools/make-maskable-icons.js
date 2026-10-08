#!/usr/bin/env node
/* One-time asset script: writes engine/images/icons/icon-maskable-192.png and -512.png.

   Android crops maskable icons to a shape of its choosing; only a centred circle covering
   80% of the canvas is guaranteed visible. The regular icons carry the THD mark almost edge
   to edge, so here the mark is lifted out of icon-512.png (as an alpha mask: the icon is two
   flat colours, so each pixel's position between background and accent gives its coverage,
   which keeps the anti-aliased edges clean on the new background) and placed on a full-bleed
   ink square, scaled so the mark's whole bounding box fits inside that circle.

   Usage, from THD SPACE/:  npm install --prefix tools   (once)
                            node tools/make-maskable-icons.js */
"use strict";

const path = require("path");
const sharp = require("sharp");
const { readToken, extractMark, SOURCE } = require("./lib/icon-mark");

const ICONS = path.join(__dirname, "..", "engine", "images", "icons");
const SAFE_DIAMETER = 0.8;       // Android's guaranteed-visible circle, as a share of the canvas
const MARK_DIAMETER = 0.76;      // mark kept a little inside it, so it doesn't touch a round mask's edge
const SIZES = [192, 512];

async function main() {
  const ink = readToken("ink");
  const { mark, box, bg, fg } = await extractMark();
  console.log(`source ${path.basename(SOURCE)}: background rgb(${bg}), mark rgb(${fg}), mark box ${box.width}x${box.height}`);
  for (const size of SIZES) {
    // Largest box with the mark's proportions whose diagonal fits the safe circle.
    const diameter = Math.min(MARK_DIAMETER, SAFE_DIAMETER) * size;
    const k = diameter / Math.hypot(box.width, box.height);
    const w = Math.floor(box.width * k);
    const h = Math.floor(box.height * k);
    const resized = await sharp(mark).resize(w, h, { kernel: "lanczos3" }).toBuffer();
    const file = path.join(ICONS, `icon-maskable-${size}.png`);
    await sharp({ create: { width: size, height: size, channels: 4, background: ink } })
      .composite([{ input: resized, left: Math.round((size - w) / 2), top: Math.round((size - h) / 2) }])
      .flatten({ background: ink })
      .png({ compressionLevel: 9 })
      .toFile(file);
    const pad = ((size - w) / 2 / size * 100).toFixed(1);
    console.log(`wrote ${file}: mark ${w}x${h} on ${ink}, ${pad}% side padding, corners at ${(Math.hypot(w, h) / size * 100).toFixed(1)}% diameter`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
