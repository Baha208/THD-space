#!/usr/bin/env node
/*
 * generate-manifest.js — fills a project's project.json from what is on disk.
 *
 * Usage:
 *   node engine/generate-manifest.js <projectDir> [--init] [--dry-run] [--in <file>] [--out <file>]
 *
 *   <projectDir>  Project folder, e.g. projects/jane-doe-villa
 *   --init        New project: scaffold project.json from the folder tree and write index.html
 *                 and sw.js from engine/templates/ (existing files are left alone). Needs
 *                 "3d-views/"; creates empty "Working-documents/" and "Reports/" if missing.
 *                 manifest.json is skipped until "client" and "title" are filled in. Review the
 *                 ids, labels and floor order it produces, then re-run without --init.
 *   --dry-run     Print the result instead of writing it.
 *   --in/--out    Read/write a project.json somewhere other than <projectDir>/project.json.
 *
 * Project folder layout (schemaVersion 2):
 *   3d-views/<floor>/floor plan/<image>, 3d-views/<floor>/<room>/<renders>   (sourceDir)
 *   Working-documents/<pdfs>   (documents.dir)   Reports/<pdfs>   (reports.dir)
 * A project.json with another schemaVersion (the old layout kept the PDFs inside
 * "3d views & working documents/") is refused with instructions; nothing is written.
 *
 * Also rewrites <projectDir>/manifest.json (the web app manifest) from project.json's title,
 * with colors taken from --ink in engine/tokens.css. Outside --init, an empty "client" or
 * "title" is an error and nothing is written.
 *
 * Authored fields (client, title, slug, floor/room ids, labels, order, dir names) are kept as-is.
 * Generated fields are overwritten on every run:
 *   floors[].plan, floors[].rooms[].images, floors[].rooms[].medium
 * rooms[].medium lists, per image, its medium-resolution copy in "<room>/medium/<name>.webp"
 * (made by tools/make-medium-renders.js) or null where there is none; it is left out when
 * a room has no copies at all. The app opens the copy first and the original for zoom.
 * documents.files and reports.files ([{ file, label, date? }], the PDFs in
 * "Working-documents/" and "Reports/") are merged instead: new PDFs are added with a label
 * made from the filename, existing labels are never overwritten, and listed files missing
 * from disk are warned about but kept. Non-PDF files there are skipped with a warning.
 * A filename starting "YYYY-MM-DD-" (a real date) gives "date" (regenerated every run) and
 * the label "<date> <the rest>" ("2026-09-30-Tiles schedule.pdf" -> "2026-09-30 Tiles schedule").
 * Each list is sorted newest date first; undated files follow in their existing order.
 *
 * Image lists come from whatever files are in each room folder, naturally sorted
 * (reception2 before reception10). Nothing is renamed and no prefix or count is assumed.
 * Folder names must match the disk exactly, including case, because production hosting
 * is case-sensitive even though Windows is not.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const IMAGE_EXT = new Set([".webp", ".avif", ".jpg", ".jpeg", ".png"]);
const IGNORED = new Set(["desktop.ini", "thumbs.db", ".ds_store"]);
const SCHEMA_VERSION = 2;
const DEFAULT_SOURCE_DIR = "3d-views";
const DEFAULT_PLAN_DIR = "floor plan";
// The two PDF lists, each in its own folder next to sourceDir in the project folder.
const PDF_LISTS = [
  { key: "documents", dir: "Working-documents" },
  { key: "reports", dir: "Reports" },
];
const MEDIUM_DIR = "medium"; // medium-resolution copies inside each room folder (tools/make-medium-renders.js)
const ORIGINALS_DIR = "_originals"; // PDF originals kept by tools/optimize-pdfs.js (not published, gitignored)
const PDF_LEDGER = "pdf-optimized.json"; // tools/optimize-pdfs.js's record of optimized PDFs
const TEMPLATES = ["index.html", "sw.js"];
const REQUIRED_TEXT = {
  client: "the client's name, e.g. \"Jane Doe\"",
  title: "the presentation title shown in the app, e.g. \"Jane Doe’s Villa\"",
};

const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
const naturalSort = (list) => list.slice().sort(collator.compare);

const errors = [];
const warnings = [];
const notes = [];

function parseArgs(argv) {
  const args = { flags: new Set(), positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--in" || a === "--out") args[a.slice(2)] = argv[++i];
    else if (a.startsWith("--")) args.flags.add(a.slice(2));
    else args.positional.push(a);
  }
  return args;
}

function entries(dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => !e.name.startsWith(".") && !IGNORED.has(e.name.toLowerCase()));
}

function subdirs(dir) {
  return naturalSort(entries(dir).filter((e) => e.isDirectory()).map((e) => e.name));
}

function images(dir) {
  return naturalSort(entries(dir)
    .filter((e) => e.isFile() && IMAGE_EXT.has(path.extname(e.name).toLowerCase()))
    .map((e) => e.name));
}

// Medium copies of a room's images: "<room>/medium/<name>.webp" where it exists, else null.
// Returns undefined when the room has none, so the field is left out.
function mediumImages(roomAbs, files, toRel) {
  const list = files.map((f) => {
    const name = path.basename(f, path.extname(f)) + ".webp";
    return fs.existsSync(path.join(roomAbs, MEDIUM_DIR, name)) ? toRel(MEDIUM_DIR + "/" + name) : null;
  });
  return list.some(Boolean) ? list : undefined;
}

// Resolve `name` inside `parent` with an exact, case-sensitive match against the real entries.
function resolveDir(parent, name, what) {
  if (!fs.existsSync(parent)) return null;
  const real = subdirs(parent);
  if (real.includes(name)) return name;
  const loose = real.find((r) => r.toLowerCase() === name.toLowerCase());
  if (loose) {
    errors.push(`${what}: "${name}" does not match the folder on disk "${loose}" (case differs). Use "${loose}".`);
  } else {
    errors.push(`${what}: folder "${name}" not found in ${parent}`);
  }
  return null;
}

// Paths in project.json are relative to the project folder, with forward slashes.
const rel = (...parts) => parts.join("/");

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
function camelCase(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+(.)?/g, (_, c) => (c ? c.toUpperCase() : ""));
}
function titleCase(s) {
  return s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

function scaffold(projectDir) {
  const sourceDir = DEFAULT_SOURCE_DIR;
  const srcAbs = path.join(projectDir, sourceDir);
  if (!fs.existsSync(srcAbs)) {
    throw new Error(`--init: "${sourceDir}" not found in ${projectDir}. Create ${sourceDir}/<floor>/floor plan/ and ` +
      `${sourceDir}/<floor>/<room>/ first (PDFs go in ${PDF_LISTS.map((l) => l.dir + "/").join(" and ")}, next to it).`);
  }
  const slug = path.basename(path.resolve(projectDir)).toLowerCase();
  const floors = subdirs(srcAbs)
    .map((d) => ({
      id: slugify(d),
      label: titleCase(d.replace(/\s+level$/i, "")),
      dir: d,
      rooms: subdirs(path.join(srcAbs, d))
        .filter((r) => r !== DEFAULT_PLAN_DIR)
        .map((r) => ({ id: camelCase(r), label: titleCase(r), dir: r })),
    }));
  warnings.push("--init: floor order is alphabetical and labels are guessed. Review project.json before publishing.");
  const project = { schemaVersion: SCHEMA_VERSION, slug, client: "", title: "", sourceDir, floors };
  for (const list of PDF_LISTS) project[list.key] = { dir: list.dir };
  return project;
}

// --init: the PDF folders, created empty so it is clear where PDFs go (git ignores them until
// they hold a file). Existing folders are left alone.
function createPdfFolders(projectDir) {
  for (const list of PDF_LISTS) {
    const abs = path.join(projectDir, list.dir);
    if (fs.existsSync(abs)) continue;
    fs.mkdirSync(abs);
    console.log(`created ${abs}${path.sep}`);
  }
}

// "2026-09-30-Tiles schedule.pdf" -> { date: "2026-09-30", rest: "Tiles schedule" }, only when
// the prefix is a real calendar date and something follows it; otherwise null.
function datedName(file) {
  const m = /^(\d{4})-(\d{2})-(\d{2})-(.+)$/.exec(path.basename(file, path.extname(file)));
  if (!m) return null;
  const [, y, mo, d] = m.map(Number);
  const real = new Date(Date.UTC(y, mo - 1, d));
  if (real.getUTCFullYear() !== y || real.getUTCMonth() !== mo - 1 || real.getUTCDate() !== d) return null;
  const rest = m[4].replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  return rest ? { date: `${m[1]}-${m[2]}-${m[3]}`, rest } : null;
}

// Default label. Dated names: the date, a space, then the rest as typed ("2026-09-30 Tiles
// schedule"). Others:
// "GF-electrical_layout.pdf" -> "GF Electrical Layout" (all-caps words such as MEP, GF kept).
function documentLabel(file) {
  const dated = datedName(file);
  if (dated) return dated.date + " " + dated.rest;
  return path.basename(file, path.extname(file))
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map((w) => (/^[A-Z0-9]+$/.test(w) && /[A-Z]/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()))
    .join(" ");
}

// Merge the PDFs on disk into a list ([{ file, label, date? }]) the same way rooms are merged:
// listed entries keep their hand-edited labels, new PDFs are added with a default label, and
// entries whose file has gone are warned about, not removed. "date" comes from the filename on
// every run. Order: dated entries newest first, then undated ones in their existing order.
function mergePdfs(what, existing, dirAbs, relPath) {
  const list = (existing || []).map((d) => (typeof d === "string" ? { file: d, label: documentLabel(d) } : Object.assign({}, d)));
  const onDisk = [];
  if (dirAbs) {
    for (const e of entries(dirAbs)) {
      if (!e.isFile()) continue;
      if (path.extname(e.name).toLowerCase() === ".pdf") onDisk.push(e.name);
      else warnings.push(`${what}: "${e.name}" is not a PDF; skipped`);
    }
  }
  const onDiskPaths = new Set(naturalSort(onDisk).map(relPath));
  const listed = new Set(list.map((d) => d.file));

  for (const d of list) {
    if (!d.label || !String(d.label).trim()) d.label = documentLabel(d.file);
    if (!onDiskPaths.has(d.file)) {
      warnings.push(`${what}: "${d.file}" is listed in project.json but not found on disk; kept. Remove it from project.json if it was deleted on purpose.`);
    }
  }
  for (const file of onDiskPaths) {
    if (listed.has(file)) continue;
    list.push({ file, label: documentLabel(file) });
    warnings.push(`${what}: added "${path.basename(file)}" as "${documentLabel(file)}". Edit its label in project.json if needed.`);
  }

  const withDates = list.map((d, i) => {
    const { file, label, date, ...rest } = d;
    const dated = datedName(file);
    return { i, entry: Object.assign({ file, label }, dated ? { date: dated.date } : {}, rest) };
  });
  withDates.sort((a, b) => {
    const da = a.entry.date, db = b.entry.date;
    if (da && db && da !== db) return da < db ? 1 : -1;
    if (!!da !== !!db) return da ? -1 : 1;
    return a.i - b.i;
  });
  return withDates.map((x) => x.entry);
}

// "client" and "title" left empty (as --init leaves them).
function missingText(project) {
  return Object.keys(REQUIRED_TEXT).filter((key) => !String(project[key] || "").trim());
}

function generate(projectDir, project, file, isInit) {
  if (project.schemaVersion !== SCHEMA_VERSION) {
    errors.push(`${file} is in the old layout ("schemaVersion": ${JSON.stringify(project.schemaVersion)}, expected ${SCHEMA_VERSION}).\n` +
      `  In schemaVersion ${SCHEMA_VERSION} the project folder holds "${DEFAULT_SOURCE_DIR}/" (floors and renders), "${PDF_LISTS[0].dir}/" and\n` +
      `  "${PDF_LISTS[1].dir}/" (PDFs) side by side; the old layout kept the PDFs inside "3d views & working documents/".\n` +
      `  Rename the folders on disk, then edit ${file} by hand:\n` +
      `    "schemaVersion": ${SCHEMA_VERSION}, "sourceDir": "${DEFAULT_SOURCE_DIR}", every "plan"/"images"/"medium" path starting\n` +
      `    with the old folder name, "documents": { "dir": "${PDF_LISTS[0].dir}", "files": [] } and\n` +
      `    "reports": { "dir": "${PDF_LISTS[1].dir}", "files": [] } (re-edit PDF labels after the next run).\n` +
      `  See "project.json" in CLAUDE.md.`);
    return project;
  }
  const sourceDir = project.sourceDir || DEFAULT_SOURCE_DIR;
  const srcAbs = path.join(projectDir, sourceDir);
  if (!fs.existsSync(srcAbs)) {
    errors.push(`sourceDir "${sourceDir}" not found in ${projectDir}`);
    return project;
  }

  if (!project.slug) warnings.push(`"slug" is empty`);
  if (!isInit) {
    for (const key of missingText(project)) {
      errors.push(`"${key}" is empty in ${file}. Fill in ${REQUIRED_TEXT[key]}.`);
    }
  }

  // Floor ids must be unique in the project; room ids only within their floor
  // (the same room name, e.g. "bathroom", can appear on several floors).
  const claimId = (seen, id, what) => {
    if (!id) errors.push(`${what}: missing id`);
    else if (seen.has(id)) errors.push(`${what}: duplicate id "${id}"`);
    seen.add(id);
  };
  const floorIds = new Set();

  const claimedFloorDirs = new Set();

  for (const floor of project.floors || []) {
    const floorWhat = `floor "${floor.id}"`;
    claimId(floorIds, floor.id, floorWhat);
    const roomIds = new Set();
    const floorDir = resolveDir(srcAbs, floor.dir, floorWhat);
    if (!floorDir) continue;
    claimedFloorDirs.add(floorDir);
    const floorAbs = path.join(srcAbs, floorDir);

    // Floor plan: the single image inside the floor's plan folder.
    const planDir = floor.planDir || DEFAULT_PLAN_DIR;
    const planDirReal = resolveDir(floorAbs, planDir, `${floorWhat} plan folder`);
    if (planDirReal) {
      const plans = images(path.join(floorAbs, planDirReal));
      if (plans.length === 0) errors.push(`${floorWhat}: no image in "${planDir}"`);
      else {
        if (plans.length > 1) warnings.push(`${floorWhat}: ${plans.length} images in "${planDir}", using "${plans[0]}"`);
        floor.plan = rel(sourceDir, floorDir, planDirReal, plans[0]);
      }
    }

    // Rooms: keep authored order, fill images.
    const claimedRoomDirs = new Set([planDirReal || planDir]);
    floor.rooms = floor.rooms || [];
    for (const room of floor.rooms) {
      const roomWhat = `room "${room.id}" (${floor.id})`;
      claimId(roomIds, room.id, roomWhat);
      const roomDir = resolveDir(floorAbs, room.dir, roomWhat);
      if (!roomDir) continue;
      claimedRoomDirs.add(roomDir);
      const files = images(path.join(floorAbs, roomDir));
      if (files.length === 0) errors.push(`${roomWhat}: no images in "${roomDir}"`);
      room.images = files.map((f) => rel(sourceDir, floorDir, roomDir, f));
      room.medium = mediumImages(path.join(floorAbs, roomDir), files, (f) => rel(sourceDir, floorDir, roomDir, f));
    }

    // Folders on disk that project.json does not mention yet: add them at the end so nothing is lost.
    const namedDirs = new Set(floor.rooms.map((r) => String(r.dir).toLowerCase()));
    for (const d of subdirs(floorAbs)) {
      if (claimedRoomDirs.has(d) || namedDirs.has(d.toLowerCase())) continue;
      const files = images(path.join(floorAbs, d));
      const room = { id: camelCase(d), label: titleCase(d), dir: d, images: files.map((f) => rel(sourceDir, floorDir, d, f)),
        medium: mediumImages(path.join(floorAbs, d), files, (f) => rel(sourceDir, floorDir, d, f)) };
      claimId(roomIds, room.id, `new room "${d}" (${floor.id})`);
      floor.rooms.push(room);
      warnings.push(`${floorWhat}: added new folder "${d}" as room "${room.id}" (${files.length} images). Check its label and position.`);
    }
  }

  // PDF lists: "Working-documents/" (Working Documents tab) and "Reports/" (Reports tab), next to
  // sourceDir in the project folder. A missing or empty folder is a placeholder, not an error
  // (the tab shows its empty state); a folder whose name only differs in case still is.
  const claimedTopDirs = new Set([sourceDir, ORIGINALS_DIR]);
  for (const list of PDF_LISTS) {
    const block = project[list.key] = Object.assign({ dir: list.dir }, project[list.key]);
    const name = block.dir;
    const exists = subdirs(projectDir).some((d) => d.toLowerCase() === name.toLowerCase());
    const real = exists ? resolveDir(projectDir, name, list.key) : null;
    if (real) claimedTopDirs.add(real);
    if (!exists || real) {
      block.files = mergePdfs(list.key, block.files, real && path.join(projectDir, real), (f) => rel(real || name, f));
    }
  }

  // Keep a readable key order: plan next to the floor's dir, rooms last.
  project.floors = (project.floors || []).map((floor) => {
    const { id, label, tabLabel, dir, planDir, plan, rooms, ...rest } = floor;
    return Object.assign({ id, label }, tabLabel ? { tabLabel } : {}, { dir }, planDir ? { planDir } : {}, { plan }, rest, { rooms });
  });

  for (const d of subdirs(srcAbs)) {
    if (!claimedFloorDirs.has(d)) warnings.push(`folder "${d}" in "${sourceDir}" is not listed as a floor; ignored`);
  }
  const expected = new Set([sourceDir, project.documents.dir, project.reports.dir].map((n) => n.toLowerCase()));
  for (const d of subdirs(projectDir)) {
    // (A name that only differs in case is already an error above.)
    if (!claimedTopDirs.has(d) && !expected.has(d.toLowerCase())) {
      warnings.push(`folder "${d}" in ${projectDir} is not "${sourceDir}", "${project.documents.dir}" or "${project.reports.dir}"; ignored`);
    }
  }

  pdfSizeChecks(projectDir, project);
  return project;
}

// Large PDFs download slowly on a phone. tools/optimize-pdfs.js makes them smaller and records each
// result in pdf-optimized.json; a PDF counts as optimized when it is there with the same content.
// Not optimized and over warnUnoptimizedMB: a warning with the command. Optimized and still over
// noteOptimizedMB: a soft note. Thresholds come from tools/pdf-optimize.config.json (defaults
// below if it's missing). Plain Node: only reads files.
function pdfSizeChecks(projectDir, project) {
  let cfg = { warnUnoptimizedMB: 15, noteOptimizedMB: 25 };
  try {
    cfg = Object.assign(cfg, JSON.parse(fs.readFileSync(path.join(__dirname, "..", "tools", "pdf-optimize.config.json"), "utf8")));
  } catch (err) {}
  let ledger = {};
  try {
    ledger = JSON.parse(fs.readFileSync(path.join(projectDir, PDF_LEDGER), "utf8")).files || {};
  } catch (err) {}
  const MBYTE = 1048576;
  for (const list of PDF_LISTS) {
    for (const entry of (project[list.key] && project[list.key].files) || []) {
      const abs = path.join(projectDir, entry.file);
      if (!fs.existsSync(abs)) continue;
      const bytes = fs.statSync(abs).size;
      const done = ledger[entry.file];
      const optimized = done && done.outputBytes === bytes &&
        crypto.createHash("sha256").update(fs.readFileSync(abs)).digest("hex") === done.outputSha256;
      const size = (bytes / MBYTE).toFixed(1) + " MB";
      if (!optimized && bytes > cfg.warnUnoptimizedMB * MBYTE) {
        warnings.push(`${list.key}: "${entry.file}" is ${size} and not optimized yet (slow to open on a phone). Run: node tools/optimize-pdfs.js ${projectDir}`);
      } else if (optimized && bytes > cfg.noteOptimizedMB * MBYTE) {
        notes.push(`${list.key}: "${entry.file}" is still ${size} after optimizing; export with a lower raster resolution`);
      }
    }
  }
}

// The web app manifest can't use CSS variables, so its colors are read from the
// engine's design tokens in tokens.css to keep a single source of truth.
function readToken(name) {
  const css = fs.readFileSync(path.join(__dirname, "tokens.css"), "utf8");
  const m = css.match(new RegExp(`--${name}:\\s*([^;]+);`));
  if (!m) throw new Error(`--${name} not found in engine/tokens.css`);
  return m[1].trim();
}

const ICON_SIZES = [48, 72, 96, 128, 144, 152, 180, 192, 384, 512];
const MASKABLE_SIZES = [192, 512];

// Relative URL from the project folder to engine/, e.g. "../../engine".
function engineRelPath(projectDir) {
  return path.relative(path.resolve(projectDir), __dirname).split(path.sep).join("/");
}

// --init: write the project's index.html and sw.js from engine/templates/. Never overwrites.
function writeShellFiles(projectDir) {
  const engineRel = engineRelPath(projectDir);
  for (const name of TEMPLATES) {
    const target = path.join(projectDir, name);
    if (fs.existsSync(target)) {
      console.log(`kept existing ${target}`);
      continue;
    }
    const template = fs.readFileSync(path.join(__dirname, "templates", name), "utf8");
    fs.writeFileSync(target, template.split("{{ENGINE}}").join(engineRel));
    console.log(`wrote ${target}`);
  }
}

function webManifest(projectDir, project) {
  const engineRel = engineRelPath(projectDir);
  // Maskable entries use the padded icon-maskable-*.png (mark inside Android's 80% safe
  // circle, made by tools/make-maskable-icons.js); everything else stays edge to edge.
  const icon = (size, purpose) => Object.assign(
    { src: `${engineRel}/images/icons/icon-${purpose === "maskable" ? "maskable-" : ""}${size}.png`, sizes: `${size}x${size}`, type: "image/png" },
    purpose ? { purpose } : {}
  );
  const icons = [];
  for (const size of ICON_SIZES) {
    icons.push(icon(size, MASKABLE_SIZES.includes(size) ? "any" : undefined));
    if (MASKABLE_SIZES.includes(size)) icons.push(icon(size, "maskable"));
  }
  const ink = readToken("ink");
  return {
    name: `${project.title} — THD Studio`,
    short_name: "THD Studio",
    start_url: ".",
    scope: ".",
    display: "standalone",
    background_color: ink,
    theme_color: ink,
    icons,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const projectDir = args.positional[0];
  if (!projectDir) {
    console.error("Usage: node engine/generate-manifest.js <projectDir> [--init] [--dry-run] [--in <file>] [--out <file>]");
    process.exit(2);
  }
  const inFile = args.in || path.join(projectDir, "project.json");
  const outFile = args.out || path.join(projectDir, "project.json");

  const isInit = args.flags.has("init");
  let project;
  if (isInit) {
    if (fs.existsSync(inFile)) throw new Error(`--init: ${inFile} already exists`);
    project = scaffold(projectDir);
  } else {
    if (!fs.existsSync(inFile)) throw new Error(`${inFile} not found. Run with --init to scaffold one.`);
    project = JSON.parse(fs.readFileSync(inFile, "utf8"));
  }

  generate(projectDir, project, outFile, isInit);

  warnings.forEach((w) => console.warn("warning: " + w));
  notes.forEach((n) => console.warn("note: " + n));
  if (errors.length) {
    errors.forEach((e) => console.error("error: " + e));
    console.error(`\n${errors.length} error(s). project.json was not written.`);
    process.exit(1);
  }

  const json = JSON.stringify(project, null, 2) + "\n";
  const floors = project.floors.length;
  const rooms = project.floors.reduce((n, f) => n + f.rooms.length, 0);
  const imgs = project.floors.reduce((n, f) => n + (f.plan ? 1 : 0) + f.rooms.reduce((m, r) => m + r.images.length, 0), 0);
  const count = (key) => (project[key] && project[key].files ? project[key].files.length : 0);
  const mediums = project.floors.reduce((n, f) => n + f.rooms.reduce((m, r) => m + (r.medium || []).filter(Boolean).length, 0), 0);
  const summary = `${floors} floors, ${rooms} rooms, ${imgs} images (${mediums} renders with a medium copy), ${count("documents")} documents, ${count("reports")} reports`;

  const manifestFile = path.join(projectDir, "manifest.json");
  const missing = missingText(project);

  if (args.flags.has("dry-run")) {
    process.stdout.write(json);
    console.error(`dry run: ${summary}`);
    return;
  }

  fs.writeFileSync(outFile, json);
  console.log(`wrote ${outFile}: ${summary}`);
  if (isInit) {
    writeShellFiles(projectDir);
    createPdfFolders(projectDir);
  }

  if (missing.length) {
    // Only reachable with --init: a manifest with an empty title would install as " — THD Studio".
    console.log(`\nskipped ${manifestFile}: ${missing.map((k) => `"${k}"`).join(" and ")} not filled in yet.`);
    console.log(`Next: open ${outFile} and fill in:`);
    missing.forEach((k) => console.log(`  "${k}": ${REQUIRED_TEXT[k]}`));
    console.log(`Put PDFs in ${PDF_LISTS.map((l) => path.join(projectDir, l.dir) + path.sep).join(" and ")} (either can stay empty).`);
    console.log(`Then check floor order, ids and labels, and run: node tools/make-medium-renders.js ${projectDir}`);
    console.log(`(It makes the medium copies of the renders, then runs this generator. First time on this`);
    console.log(`computer: npm install --prefix tools. Without it: node engine/generate-manifest.js ${projectDir})`);
    return;
  }
  fs.writeFileSync(manifestFile, JSON.stringify(webManifest(projectDir, project), null, 2) + "\n");
  console.log(`wrote ${manifestFile}`);
}

try {
  main();
} catch (e) {
  console.error("error: " + e.message);
  process.exit(1);
}
