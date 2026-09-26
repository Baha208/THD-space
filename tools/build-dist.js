#!/usr/bin/env node
/* Assembles dist/, the folder Cloudflare Pages serves (wrangler.toml: pages_build_output_dir).
   Plain copy, no transformation: engine/, hub/ and admin/ as they are, plus the root files in
   site/ (_redirects, _routes.json). projects/, tools/, the brand folder and everything else
   never leave the repo; project content is served from the bucket by functions/.

   Usage, from THD SPACE/:  node tools/build-dist.js      (npm run build) */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const DIST = path.join(ROOT, "dist");
const FOLDERS = ["engine", "hub", "admin"];
const JUNK = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

const keep = (src) => !JUNK.has(path.basename(src));

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST);
for (const folder of FOLDERS) {
  const src = path.join(ROOT, folder);
  if (!fs.existsSync(src)) throw new Error(`${folder}/ not found`);
  fs.cpSync(src, path.join(DIST, folder), { recursive: true, filter: keep });
}
for (const entry of fs.readdirSync(path.join(ROOT, "site"))) {
  if (keep(entry)) fs.copyFileSync(path.join(ROOT, "site", entry), path.join(DIST, entry));
}

let files = 0, bytes = 0;
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else { files++; bytes += fs.statSync(p).size; }
  }
})(DIST);
console.log(`built dist/: ${files} files, ${(bytes / 1024 / 1024).toFixed(1)} MB (${FOLDERS.join(", ")} + site/)`);
