#!/usr/bin/env node
/* Writes projects-index.json at the THD Space root: the list the hub's Projects tab shows,
   and brings hub/manifest.json's colours in line with engine/tokens.css.

   Usage, from THD SPACE/:  node tools/generate-projects-index.js
   Plain Node 18+; unlike the other tools/ scripts it needs no npm install.

   Scans each folder in projects/ and lists every one whose project.json is valid:
     - parses as JSON,
     - "slug" equals the folder name (the hub links to projects/<slug>/),
     - "client" and "title" are filled in,
     - has at least one floor, and the folder has index.html (a presentation you can open).
   Anything else is skipped with a warning saying why. Entries: { slug, client, title },
   sorted by title (natural order). Rerun whenever a project is added, removed or renamed,
   or its client/title changes.

   hub/manifest.json: "theme_color" and "background_color" are set from --ink in
   engine/tokens.css (as generate-manifest.js does for each project's manifest). Every other
   field in that file is authored by hand and left as it is. Rerun after changing --ink. */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const PROJECTS = path.join(ROOT, "projects");
const OUT = path.join(ROOT, "projects-index.json");
const HUB_MANIFEST = path.join(ROOT, "hub", "manifest.json");
const { readToken } = require("./lib/tokens");

const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

function check(dir) {
  const file = path.join(PROJECTS, dir, "project.json");
  if (!fs.existsSync(file)) return { reason: "no project.json" };
  let p;
  try {
    p = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    return { reason: `project.json is not valid JSON (${err.message})` };
  }
  const text = (v) => typeof v === "string" && v.trim() !== "";
  if (p.slug !== dir) return { reason: `"slug" is ${JSON.stringify(p.slug)}, but the folder is "${dir}"` };
  if (!text(p.client)) return { reason: `"client" is empty` };
  if (!text(p.title)) return { reason: `"title" is empty` };
  if (!Array.isArray(p.floors) || p.floors.length === 0) return { reason: "no floors" };
  if (!fs.existsSync(path.join(PROJECTS, dir, "index.html"))) return { reason: "no index.html (run generate-manifest.js --init)" };
  return { entry: { slug: p.slug, client: p.client.trim(), title: p.title.trim() } };
}

function main() {
  const dirs = fs.readdirSync(PROJECTS, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name);
  const projects = [];
  for (const dir of dirs) {
    const { entry, reason } = check(dir);
    if (entry) projects.push(entry);
    else console.warn(`warning: skipped projects/${dir}/: ${reason}`);
  }
  projects.sort((a, b) => collator.compare(a.title, b.title));
  fs.writeFileSync(OUT, JSON.stringify({ projects }, null, 2) + "\n");
  console.log(`wrote ${path.relative(process.cwd(), OUT) || OUT}: ${projects.length} project${projects.length === 1 ? "" : "s"}`);
  projects.forEach((p) => console.log(`  ${p.slug}  —  ${p.title} (${p.client})`));
}

// Generated colours in the hub's otherwise hand-written manifest.
function syncHubManifest() {
  const manifest = JSON.parse(fs.readFileSync(HUB_MANIFEST, "utf8"));
  const ink = readToken("ink");
  const before = [manifest.theme_color, manifest.background_color].join(" / ");
  manifest.theme_color = ink;
  manifest.background_color = ink;
  fs.writeFileSync(HUB_MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
  const after = [manifest.theme_color, manifest.background_color].join(" / ");
  console.log(`wrote ${path.relative(process.cwd(), HUB_MANIFEST) || HUB_MANIFEST}: theme_color / background_color ${after}${before === after ? " (unchanged)" : ` (was ${before})`}`);
}

main();
syncHubManifest();
