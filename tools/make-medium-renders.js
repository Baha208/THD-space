#!/usr/bin/env node
/* Makes a medium-resolution copy of every render, for faster gallery opening.

   Usage, from THD SPACE/:  npm install --prefix tools   (once)
                            node tools/make-medium-renders.js projects/<slug>

   For each render listed in the project (as engine/generate-manifest.js would list it),
   writes <room folder>/medium/<name>.webp: long edge 1500 px, same aspect ratio, WebP
   quality 80. Non-destructive: originals are never touched, and a copy that already exists
   is skipped unless its original is newer (a render replaced under the same name).
   Originals whose long edge is 1600 px or less get no copy; the app shows them as they are.
   Then re-runs generate-manifest.js so project.json lists the copies (rooms[].medium). */
"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
let sharp;
try {
  sharp = require("sharp");
} catch (err) {
  console.error("sharp is not installed. Once per computer, from THD SPACE/, run:  npm install --prefix tools");
  process.exit(1);
}

const LONG_EDGE = 1500;
const MIN_SOURCE_EDGE = 1600;
const QUALITY = 80;
const MEDIUM_DIR = "medium"; // keep in sync with engine/generate-manifest.js
const GENERATOR = path.join(__dirname, "..", "engine", "generate-manifest.js");

// Runs generate-manifest.js. Its own errors (e.g. empty client/title) are already printed
// clearly on stderr, so a failed run just exits with its code, without a Node error dump.
function runGenerator(args, options) {
  try {
    return execFileSync(process.execPath, [GENERATOR].concat(args), options);
  } catch (err) {
    if (typeof err.status === "number") process.exit(err.status);
    throw err;
  }
}

function mediumPath(abs) {
  return path.join(path.dirname(abs), MEDIUM_DIR, path.basename(abs, path.extname(abs)) + ".webp");
}

async function main() {
  const projectDir = process.argv[2];
  if (!projectDir) {
    console.error("Usage: node tools/make-medium-renders.js projects/<slug>");
    process.exit(2);
  }
  // The render list exactly as the generator sees the disk right now (nothing written yet).
  const json = runGenerator([projectDir, "--dry-run"], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  const project = JSON.parse(json);

  const renders = [];
  for (const floor of project.floors) {
    for (const room of floor.rooms) renders.push(...room.images);
  }

  const seen = new Map();
  let made = 0, kept = 0, small = 0, clashes = 0;
  for (const file of renders) {
    const abs = path.join(projectDir, file);
    const out = mediumPath(abs);
    // "a.jpg" and "a.webp" in one room would share "medium/a.webp".
    if (seen.has(out)) {
      console.warn(`warning: ${file} and ${seen.get(out)} would share ${path.relative(projectDir, out)}; skipped (rename one)`);
      clashes++;
      continue;
    }
    seen.set(out, file);

    if (fs.existsSync(out) && fs.statSync(out).mtimeMs >= fs.statSync(abs).mtimeMs) {
      kept++;
      continue;
    }
    const meta = await sharp(abs).metadata();
    if (Math.max(meta.width, meta.height) <= MIN_SOURCE_EDGE) {
      small++;
      continue;
    }
    fs.mkdirSync(path.dirname(out), { recursive: true });
    await sharp(abs)
      .rotate() // honour EXIF orientation, as the browser does
      .resize(LONG_EDGE, LONG_EDGE, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: QUALITY })
      .toFile(out);
    const before = fs.statSync(abs).size, after = fs.statSync(out).size;
    console.log(`made ${path.relative(projectDir, out)}  (${meta.width}x${meta.height}, ${Math.round(before / 1024)} KB -> ${Math.round(after / 1024)} KB)`);
    made++;
  }
  console.log(`\n${renders.length} renders: ${made} made, ${kept} already up to date, ${small} small enough as is${clashes ? `, ${clashes} name clashes` : ""}.`);

  runGenerator([projectDir], { stdio: "inherit" });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
