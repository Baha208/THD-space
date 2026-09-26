#!/usr/bin/env node
/* Brings a generated project folder (projects/<slug>/, made by engine/generate-manifest.js) into
   the bucket through the admin API, so it is served by functions/ like a project made in the
   panel. Uploads every file project.json refers to, then the project itself as published.

   Usage, from THD SPACE/, with the server running (npm run dev, or a deployed site):
     node tools/import-project.js projects/<slug> [--server http://localhost:8788] [--draft]
   Against a deployed site behind Cloudflare Access, pass a service token:
     CF_ACCESS_CLIENT_ID=… CF_ACCESS_CLIENT_SECRET=… node tools/import-project.js … --server https://…

   Safe to rerun: files are overwritten with the same bytes. Plain Node 18+. */
"use strict";

const fs = require("fs");
const path = require("path");

const TYPES = { webp: "image/webp", avif: "image/avif", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", pdf: "application/pdf" };

function parseArgs(argv) {
  const args = { server: "http://localhost:8788", draft: false, positional: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--server") args.server = argv[++i];
    else if (argv[i] === "--draft") args.draft = true;
    else args.positional.push(argv[i]);
  }
  return args;
}

function authHeaders() {
  const id = process.env.CF_ACCESS_CLIENT_ID, secret = process.env.CF_ACCESS_CLIENT_SECRET;
  return id && secret ? { "CF-Access-Client-Id": id, "CF-Access-Client-Secret": secret } : {};
}

async function call(server, method, url, body, type) {
  const res = await fetch(server + url, { method, body, headers: Object.assign({ "content-type": type }, authHeaders()) });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch (e) { data = { error: text.slice(0, 300) }; }
  if (!res.ok) throw new Error(`${method} ${url}: HTTP ${res.status} ${data.error || ""}${data.details ? "\n  - " + data.details.join("\n  - ") : ""}`);
  return data;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dir = args.positional[0];
  if (!dir) {
    console.error("Usage: node tools/import-project.js projects/<slug> [--server URL] [--draft]");
    process.exit(2);
  }
  const project = JSON.parse(fs.readFileSync(path.join(dir, "project.json"), "utf8"));
  const slug = project.slug;
  if (!slug) throw new Error("project.json has no slug");

  const files = [];
  for (const floor of project.floors || []) {
    if (floor.plan) files.push(floor.plan);
    for (const room of floor.rooms || []) {
      files.push(...(room.images || []));
      files.push(...(room.medium || []).filter(Boolean));
    }
  }
  for (const doc of ((project.documents && project.documents.files) || [])) files.push(typeof doc === "string" ? doc : doc.file);

  // The project first (as a draft, so files can be attached), then every file, then its status.
  project.status = "draft";
  const base = `/admin/api/projects/${encodeURIComponent(slug)}`;
  await call(args.server, "PUT", base, JSON.stringify({ project }), "application/json");
  console.log(`project ${slug}: ${files.length} files to upload`);

  let done = 0, bytes = 0;
  const queue = files.slice();
  async function worker() {
    while (queue.length) {
      const rel = queue.shift();
      const abs = path.join(dir, rel);
      if (!fs.existsSync(abs)) { console.warn(`warning: missing on disk, skipped: ${rel}`); continue; }
      const data = fs.readFileSync(abs);
      const type = TYPES[path.extname(rel).slice(1).toLowerCase()] || "application/octet-stream";
      await call(args.server, "PUT", `${base}/files?path=${encodeURIComponent(rel)}`, data, type);
      done++; bytes += data.length;
      if (done % 25 === 0 || done === files.length) console.log(`  ${done}/${files.length} uploaded (${(bytes / 1024 / 1024).toFixed(1)} MB)`);
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()]);

  if (!args.draft) {
    await call(args.server, "POST", `${base}/status`, JSON.stringify({ status: "published" }), "application/json");
    console.log(`published: ${args.server}/projects/${slug}/`);
  } else {
    console.log(`left as draft: ${args.server}/projects/${slug}/`);
  }
}

main().catch((err) => {
  console.error("error: " + err.message);
  process.exit(1);
});
