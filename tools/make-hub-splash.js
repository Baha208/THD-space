#!/usr/bin/env node
/* Writes hub/splash-mark.png: the "THD" letters for the hub's opening animation (one-time asset
   script, like make-hub-icons.js).

   Same source and extraction as the icon scripts (tools/lib/icon-mark.js lifts the mark out of
   engine/images/icons/icon-512.png as an alpha mask), in the accent colour on transparency. The
   icon's mark has a second line, "STUDIO", under "THD"; the splash shows "SPACE" there as live
   text instead, so the mark is cropped to its top line: everything above the first fully empty
   row band. At 468 px wide it covers the ~140 px display size at 3x screens (420 px).

   Usage, from THD SPACE/:  npm install --prefix tools   (once)
                            node tools/make-hub-splash.js */
"use strict";

const path = require("path");
const sharp = require("sharp");
const { readToken, hex, extractMark } = require("./lib/icon-mark");

const OUT = path.join(__dirname, "..", "hub", "splash-mark.png");
const ALPHA_EMPTY = 8; // a row is "empty" when no pixel is more than this opaque

async function main() {
  const { mark } = await extractMark(hex(readToken("accent")));
  const { data, info } = await sharp(mark).raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const rowHasInk = (y) => {
    for (let x = 0; x < width; x++) if (data[(y * width + x) * 4 + 3] > ALPHA_EMPTY) return true;
    return false;
  };
  // Top line = rows from the top down to the first empty row after some ink.
  let y = 0;
  while (y < height && rowHasInk(y)) y++;
  if (y === height) throw new Error("no gap between the mark's lines found; check the source icon");
  const top = await sharp(mark).extract({ left: 0, top: 0, width, height: y }).trim({ threshold: 0 }).png({ compressionLevel: 9 }).toBuffer({ resolveWithObject: true });
  await sharp(top.data).toFile(OUT);
  console.log(`wrote ${path.relative(path.join(__dirname, ".."), OUT)}: ${top.info.width}x${top.info.height} (mark ${width}x${height}, cropped above row ${y})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
