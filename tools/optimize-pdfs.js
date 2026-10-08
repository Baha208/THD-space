#!/usr/bin/env node
/* Makes the PDFs in a project's Working-documents/ and Reports/ smaller without changing what
   they show in the presentation's PDF viewer.

   Usage, from THD SPACE/:  npm install --prefix tools                       (once: sharp)
                            winget install --id QPDF.QPDF -e                  (once: qpdf)
                            node tools/optimize-pdfs.js projects/<slug> [options]

     (no option)   optimize every PDF that isn't done yet, then run engine/generate-manifest.js
     --dry-run     do all the work in a temp folder and report; change nothing, no generator run
     --preview     like --dry-run, but keep the optimized copies, a report and side-by-side
                   comparison images in a preview folder (printed at the end)
     --check       list PDFs that still need optimizing; exit code 1 if there are any
     --force       re-derive every PDF from its original in _originals/, with current settings
     --headroom=N  override "headroom" from the config (only with --dry-run / --preview)
     --out=DIR     where --preview writes (default: <system temp>/thd-pdf-preview/<slug>/<time>-h<headroom>)
     --only=TEXT   only PDFs whose path contains TEXT (case-insensitive)

   How (surgical; settings and reasoning: tools/pdf-optimize.config.json, CLAUDE.md):
   - Reads the PDF with qpdf, works out where every image is drawn and how large (from the page
     content), and re-encodes only JPEG images that are well above the target resolution: the most
     the viewer can show for that page size (its canvases are capped at viewerMaxCanvasPixels per
     page), times "headroom". Their soft masks are resized with them. Nothing is ever rasterized.
   - Everything else (vector linework, text, fonts, links, bookmarks, layers, annotations,
     transparency) is kept: qpdf writes the new image streams back and repacks the file losslessly.
   - Gates, all must pass or the original is kept: every object reachable from the document
     catalog is unchanged apart from the resampled images (so pages, sizes, rotation, text, fonts,
     links, bookmarks and layers are identical); each resampled image matches a high-quality
     downscale of its original (PSNR); sample pages rendered before/after match (when Ghostscript
     is found); and the file is at least minSavingPercent smaller.
   - Originals are copied to projects/<slug>/_originals/<same path> (gitignored) before a PDF is
     replaced, and output is always derived from the original, never from an optimized file. The
     same file name is kept (labels and dates come from it). projects/<slug>/pdf-optimized.json
     (tracked) records what was done, so a rerun, or a teammate without _originals, skips it. */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const CONFIG_FILE = path.join(__dirname, "pdf-optimize.config.json");
const GENERATOR = path.join(ROOT, "engine", "generate-manifest.js");
const LEDGER_NAME = "pdf-optimized.json";
const ORIGINALS_DIR = "_originals";
const PDF_DIRS = { documents: "Working-documents", reports: "Reports" }; // defaults, as the generator

let sharp;
try {
  sharp = require("sharp");
} catch (err) {
  console.error("sharp is not installed. Once per computer, from THD SPACE/, run:  npm install --prefix tools");
  process.exit(1);
}

// ===================== ENGINES =====================

function tryVersion(exe, args) {
  try {
    return execFileSync(exe, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch (err) {
    return null;
  }
}

// Newest match of <base>\<prefix>*\<rest> (e.g. "C:\Program Files\qpdf 12.4.2\bin\qpdf.exe").
function globInstall(base, prefix, rest) {
  if (!fs.existsSync(base)) return [];
  const collator = new Intl.Collator("en", { numeric: true });
  return fs.readdirSync(base).filter((d) => d.toLowerCase().startsWith(prefix))
    .sort(collator.compare).reverse()
    .map((d) => path.join(base, d, rest)).filter((p) => fs.existsSync(p));
}

const PROGRAM_FILES = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]].filter(Boolean);

// qpdf: PATH first, then the standard install folders, then PDF24's bundled copy.
function findQpdf() {
  const candidates = ["qpdf"];
  for (const pf of PROGRAM_FILES) candidates.push(...globInstall(pf, "qpdf", path.join("bin", "qpdf.exe")));
  for (const pf of PROGRAM_FILES) candidates.push(path.join(pf, "PDF24", "qpdf", "bin", "qpdf.exe"));
  for (const exe of candidates) {
    const v = tryVersion(exe, ["--version"]);
    if (v) return { exe, version: v.split("\n")[0] };
  }
  return null;
}

// Ghostscript (optional, only to render pages for the comparison gate): same search order.
function findGhostscript() {
  const candidates = ["gswin64c", "gs"];
  for (const pf of PROGRAM_FILES) {
    for (const dir of globInstall(path.join(pf, "gs"), "gs", "bin")) candidates.push(path.join(dir, "gswin64c.exe"));
  }
  for (const pf of PROGRAM_FILES) candidates.push(path.join(pf, "PDF24", "gs", "bin", "gswin64c.exe"));
  for (const exe of candidates) {
    const v = tryVersion(exe, ["--version"]);
    if (v) return { exe, version: v };
  }
  return null;
}

// ===================== FILES, LEDGER =====================

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const MB = (n) => (n / 1048576).toFixed(2) + " MB";

function listPdfs(projectDir, project) {
  const out = [];
  for (const key of Object.keys(PDF_DIRS)) {
    const dir = (project[key] && project[key].dir) || PDF_DIRS[key];
    const abs = path.join(projectDir, dir);
    if (!fs.existsSync(abs)) continue;
    for (const name of fs.readdirSync(abs).sort()) {
      if (name.startsWith(".") || path.extname(name).toLowerCase() !== ".pdf") continue;
      if (!fs.statSync(path.join(abs, name)).isFile()) continue;
      out.push(dir + "/" + name);
    }
  }
  return out;
}

function readLedger(projectDir) {
  const file = path.join(projectDir, LEDGER_NAME);
  if (!fs.existsSync(file)) return { files: {} };
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeLedger(projectDir, ledger) {
  const sorted = {};
  for (const k of Object.keys(ledger.files).sort()) sorted[k] = ledger.files[k];
  fs.writeFileSync(path.join(projectDir, LEDGER_NAME), JSON.stringify({
    _about: "Written by tools/optimize-pdfs.js: which PDFs are optimized, from which original, with which settings. Tracked in git; the originals themselves are in _originals/ (not tracked).",
    files: sorted,
  }, null, 2) + "\n");
}

// What to do with one PDF, from the ledger, the file on disk and _originals/.
//   done        output recorded with current settings and unchanged on disk
//   new         not in the ledger (or changed since): it is itself the original
//   rederive    settings changed or --force, and the original is in _originals/
//   stale       settings changed or --force, but there is no original to re-derive from
function plan(projectDir, rel, ledger, cfg, force) {
  const file = path.join(projectDir, rel);
  const backup = path.join(projectDir, ORIGINALS_DIR, rel);
  const current = fs.readFileSync(file);
  const sha = sha256(current);
  const entry = ledger.files[rel];
  const hasBackup = fs.existsSync(backup);
  if (entry && entry.outputSha256 === sha) {
    const fresh = entry.settingsVersion === cfg.settingsVersion && !force;
    if (fresh) return { action: "done", entry, sha, bytes: current.length };
    return hasBackup ? { action: "rederive", source: backup, entry, sha, bytes: current.length }
      : { action: "stale", entry, sha, bytes: current.length };
  }
  // Not recorded, or the file was replaced since (a newer export): this file is the original.
  return { action: "new", source: file, entry, sha, bytes: current.length, replacedSinceLedger: !!entry };
}

// ===================== PDF OBJECT MODEL (qpdf JSON v2) =====================

// qpdf exits with 3 when it succeeded with warnings (e.g. a slightly damaged input); that counts
// as success, and the warnings are kept for the report.
function runQpdf(qpdf, args, warnings) {
  try {
    return execFileSync(qpdf.exe, args, { maxBuffer: 1 << 30, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    if (err.status === 3) {
      if (warnings) warnings.push(String(err.stderr || "").trim().split("\n").slice(0, 3).join(" | "));
      return err.stdout;
    }
    throw err;
  }
}

function qpdfJson(qpdf, file, warnings) {
  const j = JSON.parse(runQpdf(qpdf, ["--json=2", "--json-stream-data=inline", "--decode-level=none", file], warnings));
  return { header: j.qpdf[0], objs: j.qpdf[1] };
}

const isRef = (v) => typeof v === "string" && /^\d+ \d+ R$/.test(v);

function model(dump) {
  const objs = dump.objs;
  const raw = (ref) => objs["obj:" + ref];
  const resolve = (v) => {
    for (let i = 0; i < 32 && isRef(v); i++) {
      const o = raw(v);
      if (!o) return null;
      v = o.stream ? o.stream.dict : o.value;
    }
    return v;
  };
  const stream = (ref) => (isRef(ref) && raw(ref) && raw(ref).stream) || null;
  return { header: dump.header, objs, raw, resolve, stream, trailer: objs.trailer.value };
}

// Decode a stream's filters in order, as far as this script can (Flate without predictor,
// ASCII85, ASCIIHex). Stops before DCT and returns what is left.
function decodeStream(m, st, allowPredictor) {
  const d = st.dict;
  let filters = m.resolve(d["/Filter"]);
  filters = filters == null ? [] : Array.isArray(filters) ? filters.slice() : [filters];
  let parms = m.resolve(d["/DecodeParms"]);
  parms = parms == null ? [] : Array.isArray(parms) ? parms : [parms];
  let data = Buffer.from(st.data || "", "base64");
  let i = 0;
  for (; i < filters.length; i++) {
    const f = filters[i];
    const p = m.resolve(parms[i]);
    if (f === "/FlateDecode" || f === "/Fl") {
      if (p && m.resolve(p["/Predictor"]) > 1 && !allowPredictor) return { data, rest: filters.slice(i), unsupported: "Flate predictor" };
      data = zlib.inflateSync(data);
    } else if (f === "/ASCII85Decode" || f === "/A85") data = ascii85(data);
    else if (f === "/ASCIIHexDecode" || f === "/AHx") data = Buffer.from(data.toString("latin1").replace(/[^0-9a-fA-F]/g, "").replace(/^(([0-9a-fA-F]{2})*)([0-9a-fA-F])$/, "$1$30"), "hex");
    else break;
  }
  const rest = filters.slice(i);
  return { data, rest, unsupported: rest.length && rest[0] !== "/DCTDecode" ? rest[0] : null };
}

function ascii85(buf) {
  const s = buf.toString("latin1").replace(/\s+/g, "").replace(/^<~/, "").replace(/~>.*$/s, "");
  const out = [];
  let group = [];
  for (const ch of s) {
    if (ch === "z" && group.length === 0) { out.push(0, 0, 0, 0); continue; }
    group.push(ch.charCodeAt(0) - 33);
    if (group.length === 5) {
      let n = 0;
      for (const g of group) n = n * 85 + g;
      out.push((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
      group = [];
    }
  }
  if (group.length) {
    const k = group.length;
    while (group.length < 5) group.push(84);
    let n = 0;
    for (const g of group) n = n * 85 + g;
    const bytes = [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
    out.push(...bytes.slice(0, k - 1));
  }
  return Buffer.from(out);
}

// ===================== PAGES AND IMAGE PLACEMENTS =====================

function pagesOf(m) {
  const root = m.resolve(m.trailer["/Root"]);
  const pages = [];
  const walk = (ref, inherited, depth) => {
    const node = m.resolve(ref);
    if (!node || depth > 64) return;
    const inh = Object.assign({}, inherited);
    for (const k of ["/MediaBox", "/CropBox", "/Rotate", "/Resources"]) if (node[k] !== undefined) inh[k] = node[k];
    if (node["/Type"] === "/Pages" || (node["/Kids"] && !node["/Contents"])) {
      for (const kid of m.resolve(node["/Kids"]) || []) walk(kid, inh, depth + 1);
      return;
    }
    const box = (m.resolve(inh["/CropBox"]) || m.resolve(inh["/MediaBox"])).map((v) => Number(m.resolve(v)));
    pages.push({ ref, node, box, rotate: Number(m.resolve(inh["/Rotate"]) || 0), resources: inh["/Resources"] });
  };
  walk(root["/Pages"], {}, 0);
  return pages;
}

const concat = (a, b) => [
  a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3],
  a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3],
  a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5],
];

const WS = new Set([0, 9, 10, 12, 13, 32]);
const DELIM = new Set("()<>[]{}/%".split("").map((c) => c.charCodeAt(0)));

// Walks a content stream for q / Q / cm / Do, calling onDo(name, ctm). Strings, arrays,
// dictionaries, comments and inline images are skipped properly, so their bytes can't be
// mistaken for operators.
function scanContent(buf, ctm0, onDo) {
  let ctm = ctm0;
  const stack = [];
  let operands = [];
  let i = 0;
  const n = buf.length;
  while (i < n) {
    const c = buf[i];
    if (WS.has(c)) { i++; continue; }
    if (c === 37) { while (i < n && buf[i] !== 10 && buf[i] !== 13) i++; continue; } // %
    if (c === 40) { // ( string )
      let depth = 1; i++;
      while (i < n && depth) { if (buf[i] === 92) i += 2; else { if (buf[i] === 40) depth++; else if (buf[i] === 41) depth--; i++; } }
      operands.push(null); continue;
    }
    if (c === 60 && buf[i + 1] === 60) { operands.push(null); i += 2; continue; } // <<
    if (c === 62 && buf[i + 1] === 62) { i += 2; continue; }                      // >>
    if (c === 60) { while (i < n && buf[i] !== 62) i++; i++; operands.push(null); continue; } // <hex>
    if (c === 91 || c === 93 || c === 123 || c === 125) { i++; continue; }      // [ ] { }
    if (c === 47) { // /Name
      let j = i + 1;
      while (j < n && !WS.has(buf[j]) && !DELIM.has(buf[j])) j++;
      operands.push(buf.toString("latin1", i, j).replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))));
      i = j; continue;
    }
    let j = i;
    while (j < n && !WS.has(buf[j]) && !DELIM.has(buf[j])) j++;
    if (j === i) { i++; continue; }
    const tok = buf.toString("latin1", i, j);
    i = j;
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(tok)) { operands.push(Number(tok)); continue; }
    if (tok === "true" || tok === "false" || tok === "null") { operands.push(null); continue; }
    // operator
    if (tok === "q") stack.push(ctm);
    else if (tok === "Q") { if (stack.length) ctm = stack.pop(); }
    else if (tok === "cm") {
      const v = operands.slice(-6);
      if (v.length === 6 && v.every((x) => typeof x === "number")) ctm = concat(v, ctm);
    } else if (tok === "Do") {
      const name = operands[operands.length - 1];
      if (typeof name === "string") onDo(name, ctm);
    } else if (tok === "BI") {
      // inline image: skip its dictionary and binary data up to a whitespace-delimited EI
      const id = buf.indexOf("ID", i, "latin1");
      let k = id < 0 ? n : id + 3;
      while (k < n) {
        if (buf[k] === 69 && buf[k + 1] === 73 && WS.has(buf[k - 1]) && (k + 2 >= n || WS.has(buf[k + 2]))) { k += 2; break; }
        k++;
      }
      i = k;
    }
    operands = [];
  }
}

// Every placement of every image XObject: { ref -> [{ page, dpiX, dpiY, drawnW, drawnH }] },
// plus the resource dictionaries that were walked (to prove an image is used nowhere else).
function placements(m, pages) {
  const found = new Map();
  const walkedXObjectDicts = new Set();
  const unparsed = [];
  const add = (ref, rec) => { if (!found.has(ref)) found.set(ref, []); found.get(ref).push(rec); };

  function run(contentRefs, resources, ctm, pageIndex, depth, label) {
    const res = m.resolve(resources) || {};
    const xobjRaw = res["/XObject"];
    const xobjects = m.resolve(xobjRaw) || {};
    walkedXObjectDicts.add(isRef(xobjRaw) ? xobjRaw : xobjects);
    const parts = [];
    for (const cref of contentRefs) {
      const st = isRef(cref) ? m.stream(cref) : null;
      if (!st) { unparsed.push(label + ": content is not a stream"); return; }
      const dec = decodeStream(m, st);
      if (dec.rest.length) { unparsed.push(label + ": content filter " + dec.rest.join("+")); return; }
      parts.push(dec.data);
    }
    scanContent(Buffer.concat(parts.map((p) => Buffer.concat([p, Buffer.from("\n")]))), ctm, (name, at) => {
      const ref = xobjects[name];
      if (!isRef(ref)) return;
      const st = m.stream(ref);
      if (!st) return;
      const d = st.dict;
      if (d["/Subtype"] === "/Image") {
        const ax = Math.hypot(at[0], at[1]) / 72, ay = Math.hypot(at[2], at[3]) / 72; // inches
        add(ref, { page: pageIndex, inX: ax, inY: ay });
      } else if (d["/Subtype"] === "/Form" && depth < 24) {
        const matrix = (m.resolve(d["/Matrix"]) || [1, 0, 0, 1, 0, 0]).map((v) => Number(m.resolve(v)));
        run([ref], d["/Resources"] || resources, concat(matrix, at), pageIndex, depth + 1, label + " > form " + ref);
      }
    });
  }

  pages.forEach((p, i) => {
    const c = p.node["/Contents"];
    const list = c == null ? [] : isRef(c) && m.stream(c) ? [c] : [].concat(m.resolve(c) || []);
    run(list, p.resources, [1, 0, 0, 1, 0, 0], i, 0, "page " + (i + 1));
  });
  return { found, walkedXObjectDicts, unparsed };
}

// How many times each indirect reference appears anywhere in the file (values only).
function refCounts(m) {
  const counts = new Map();
  const visit = (v) => {
    if (isRef(v)) counts.set(v, (counts.get(v) || 0) + 1);
    else if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === "object") Object.values(v).forEach(visit);
  };
  for (const [k, o] of Object.entries(m.objs)) {
    if (k === "trailer") continue;
    visit(o.stream ? o.stream.dict : o.value);
  }
  return counts;
}

// ===================== RESAMPLING =====================

const pageMaxDpi = (cfg, page) => {
  const wIn = Math.abs(page.box[2] - page.box[0]) / 72, hIn = Math.abs(page.box[3] - page.box[1]) / 72;
  return Math.sqrt(cfg.viewerMaxCanvasPixels / (wIn * hIn));
};

function hasIccOrAdobe(jpeg) {
  for (let i = 2; i + 4 < jpeg.length;) {
    if (jpeg[i] !== 0xff) return false;
    const marker = jpeg[i + 1];
    const len = jpeg.readUInt16BE(i + 2);
    if (marker === 0xe2 && jpeg.toString("latin1", i + 4, i + 15) === "ICC_PROFILE") return true;
    if (marker === 0xee && jpeg.toString("latin1", i + 4, i + 9) === "Adobe") return true;
    if (marker === 0xda) return false;
    i += 2 + len;
  }
  return false;
}

// Which images to resample and to what size. Conservative: anything unusual is left alone.
function choose(m, pages, cfg, headroom) {
  const { found, walkedXObjectDicts, unparsed } = placements(m, pages);
  const counts = refCounts(m);
  // references from the walked XObject resource dictionaries
  const fromWalked = new Map();
  for (const dict of walkedXObjectDicts) {
    const d = isRef(dict) ? m.resolve(dict) : dict;
    for (const v of Object.values(d || {})) if (isRef(v)) fromWalked.set(v, (fromWalked.get(v) || 0) + 1);
  }
  const smaskUsers = new Map();
  for (const [k, o] of Object.entries(m.objs)) {
    if (!o.stream || o.stream.dict["/Subtype"] !== "/Image") continue;
    const sm = o.stream.dict["/SMask"];
    if (isRef(sm)) smaskUsers.set(sm, (smaskUsers.get(sm) || 0) + 1);
  }

  const chosen = [];
  const skipped = {};
  const skip = (why) => { skipped[why] = (skipped[why] || 0) + 1; };
  for (const [ref, recs] of found) {
    const st = m.stream(ref);
    const d = st.dict;
    const w = Number(m.resolve(d["/Width"])), h = Number(m.resolve(d["/Height"]));
    if (w * h < cfg.minResamplePixels || Math.min(w, h) < cfg.minResampleSide) { skip("small (kept as is)"); continue; }
    // needed scale: the most demanding placement wins
    let scale = 0;
    for (const r of recs) {
      const target = headroom * pageMaxDpi(cfg, pages[r.page]);
      const eff = Math.max(w / r.inX, h / r.inY);
      scale = Math.max(scale, target / eff);
    }
    if (!(scale > 0) || scale * cfg.resampleAbove >= 1) { skip("already at or under the target"); continue; }
    let filters = m.resolve(d["/Filter"]);
    filters = filters == null ? [] : [].concat(filters);
    if (filters[filters.length - 1] !== "/DCTDecode") { skip("not JPEG (kept lossless)"); continue; }
    const cs = m.resolve(d["/ColorSpace"]);
    const csName = Array.isArray(cs) ? cs[0] : cs;
    let channels = csName === "/DeviceRGB" ? 3 : csName === "/DeviceGray" ? 1 : 0;
    if (csName === "/ICCBased") {
      const icc = m.stream(cs[1]);
      const nComp = icc && Number(m.resolve(icc.dict["/N"]));
      channels = nComp === 3 || nComp === 1 ? nComp : 0;
    }
    if (!channels || Number(m.resolve(d["/BitsPerComponent"])) !== 8 || d["/Decode"] || d["/ImageMask"] || d["/Mask"]) {
      skip("colour space / mask not handled"); continue;
    }
    if ((counts.get(ref) || 0) !== (fromWalked.get(ref) || 0)) { skip("also used outside page content"); continue; }
    const smRef = d["/SMask"];
    if (smRef !== undefined && smRef !== "/None") {
      const sm = isRef(smRef) && m.stream(smRef);
      // Referenced only by this image, plus (AutoCAD does this) resource listings that were walked,
      // and never painted on its own.
      if (!sm || smaskUsers.get(smRef) !== 1 || (counts.get(smRef) || 0) !== 1 + (fromWalked.get(smRef) || 0) ||
        found.has(smRef) || sm.dict["/Matte"] ||
        Number(m.resolve(sm.dict["/BitsPerComponent"])) !== 8 || m.resolve(sm.dict["/ColorSpace"]) !== "/DeviceGray" ||
        decodeStream(m, sm).rest.length) { skip("soft mask not handled"); continue; }
    }
    const nw = Math.max(1, Math.round(w * scale)), nh = Math.max(1, Math.round(h * scale));
    chosen.push({ ref, w, h, nw, nh, channels, smRef: isRef(smRef) ? smRef : null, pages: [...new Set(recs.map((r) => r.page))] });
  }
  return { chosen, skipped, unparsed };
}

function psnr(a, b) {
  let se = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; se += d * d; }
  const mse = se / a.length;
  return mse === 0 ? 99 : 10 * Math.log10((255 * 255) / mse);
}

// Re-encode one image (and its soft mask) at the new size; returns qpdf update entries + PSNR.
async function resample(m, item, cfg) {
  const st = m.stream(item.ref);
  const dec = decodeStream(m, st);
  const jpeg = dec.data;
  if (hasIccOrAdobe(jpeg)) return { skip: "JPEG carries its own colour profile / Adobe transform" };
  let rawMask = null;
  if (item.smRef) {
    const sm = m.stream(item.smRef);
    const n = Number(m.resolve(sm.dict["/Width"])) * Number(m.resolve(sm.dict["/Height"]));
    rawMask = decodeStream(m, sm).data;
    if (rawMask.length < n) return { skip: "soft mask data too short" };
    let clear = 0;
    for (let i = 0; i < n; i++) if (rawMask[i] === 0) clear++;
    if ((100 * clear) / n > cfg.maxMaskTransparentPercent) return { skip: "shaped overlay / line art (kept as is)" };
  }
  const input = sharp(jpeg, { failOn: "error" });
  const meta = await input.metadata();
  if (meta.width !== item.w || meta.height !== item.h || meta.channels !== item.channels) return { skip: "JPEG doesn't match its PDF dictionary" };
  const resizeOpts = { width: item.nw, height: item.nh, fit: "fill", kernel: "lanczos3" };
  const reference = await sharp(jpeg).resize(resizeOpts).raw().toBuffer();
  // Fine textures (cane mesh, fabric) can fall short at the configured quality; step it up for
  // that image only, until it meets minImagePsnrDb (the gate then decides at the best one tried).
  let out, quality;
  for (const q of [cfg.jpegQuality, 85, 90, 95].filter((v, i, all) => v >= cfg.jpegQuality && all.indexOf(v) === i)) {
    let pipe = sharp(jpeg).resize(resizeOpts);
    if (item.channels === 1) pipe = pipe.toColourspace("b-w");
    const opts = { quality: q, mozjpeg: true };
    if (item.channels === 3) opts.chromaSubsampling = q >= 90 ? "4:4:4" : "4:2:0";
    out = await pipe.jpeg(opts).toBuffer();
    quality = psnr(reference, await sharp(out).raw().toBuffer());
    if (quality >= cfg.minImagePsnrDb) break;
  }
  const deflated = zlib.deflateSync(out, { level: 9 });
  const wrap = deflated.length < out.length * 0.98;
  const dict = Object.assign({}, st.dict);
  delete dict["/Length"]; delete dict["/DecodeParms"]; delete dict["/DL"];
  dict["/Width"] = item.nw; dict["/Height"] = item.nh;
  dict["/Filter"] = wrap ? ["/FlateDecode", "/DCTDecode"] : "/DCTDecode";
  const updates = { ["obj:" + item.ref]: { stream: { dict, data: (wrap ? deflated : out).toString("base64") } } };
  let bytesAfter = (wrap ? deflated : out).length;
  if (item.smRef) {
    const sm = m.stream(item.smRef);
    const smw = Number(m.resolve(sm.dict["/Width"])), smh = Number(m.resolve(sm.dict["/Height"]));
    const resized = await sharp(rawMask.subarray(0, smw * smh), { raw: { width: smw, height: smh, channels: 1 } })
      .resize(resizeOpts).raw().toBuffer();
    const smDict = Object.assign({}, sm.dict);
    delete smDict["/Length"]; delete smDict["/DecodeParms"]; delete smDict["/DL"];
    smDict["/Width"] = item.nw; smDict["/Height"] = item.nh; smDict["/Filter"] = "/FlateDecode";
    const smData = zlib.deflateSync(resized, { level: 9 });
    updates["obj:" + item.smRef] = { stream: { dict: smDict, data: smData.toString("base64") } };
    bytesAfter += smData.length;
  }
  return { updates, psnr: quality, bytesBefore: Buffer.from(st.data, "base64").length, bytesAfter };
}

// ===================== STRUCTURAL GATE =====================

// Everything reachable from the catalog and /Info must be the same in both files, except the
// streams that were deliberately replaced (compared by their non-size keys only). Stream data is
// compared decoded, since qpdf recompresses Flate.
function compareStructure(a, b, replaced) {
  const pairs = new Map();
  const problems = [];
  const IGNORE_STREAM_KEYS = new Set(["/Length", "/Filter", "/DecodeParms", "/DL"]);
  const REPLACED_KEYS = new Set(["/Width", "/Height"]);
  const streamData = (m, st) => {
    const dec = decodeStream(m, st, true);
    if (dec.unsupported) return { unsupported: dec.unsupported };
    // Only parameters that change the bytes count (a real predictor); qpdf drops no-op ones
    // such as /Predictor 1 or [null null] when it repacks.
    const parms = [].concat(m.resolve(st.dict["/DecodeParms"]) || []).map((p) => m.resolve(p))
      .filter((p) => p && Number(m.resolve(p["/Predictor"])) > 1);
    return { hash: sha256(dec.data), rest: dec.rest.join("+"), parms: JSON.stringify(parms) };
  };
  function cmp(va, vb, where, depth) {
    if (problems.length > 20 || depth > 400) return;
    if (isRef(va) || isRef(vb)) {
      if (!isRef(va) || !isRef(vb)) {
        const ra = isRef(va) ? a.resolve(va) : va, rb = isRef(vb) ? b.resolve(vb) : vb;
        return cmp(ra, rb, where, depth + 1);
      }
      if (pairs.has(va)) { if (pairs.get(va) !== vb) problems.push(where + ": object identity changed"); return; }
      pairs.set(va, vb);
      const oa = a.raw(va), ob = b.raw(vb);
      if (!oa || !ob) { if (!!oa !== !!ob) problems.push(where + ": object missing"); return; }
      if (!!oa.stream !== !!ob.stream) { problems.push(where + ": stream/non-stream mismatch"); return; }
      if (!oa.stream) return cmp(oa.value, ob.value, where, depth + 1);
      const isReplaced = replaced.has(va);
      const ka = Object.keys(oa.stream.dict).filter((k) => !IGNORE_STREAM_KEYS.has(k) && !(isReplaced && REPLACED_KEYS.has(k)));
      const kb = Object.keys(ob.stream.dict).filter((k) => !IGNORE_STREAM_KEYS.has(k) && !(isReplaced && REPLACED_KEYS.has(k)));
      if (ka.sort().join() !== kb.sort().join()) { problems.push(where + ": stream keys differ (" + va + ")"); return; }
      for (const k of ka) cmp(oa.stream.dict[k], ob.stream.dict[k], where + k, depth + 1);
      if (isReplaced) return;
      const da = streamData(a, oa.stream), db = streamData(b, ob.stream);
      if (da.unsupported || db.unsupported) problems.push(where + ": can't verify stream " + va + " (" + (da.unsupported || db.unsupported) + ")");
      else if (da.hash !== db.hash || da.rest !== db.rest || da.parms !== db.parms) problems.push(where + ": stream data changed (" + va + ")");
      return;
    }
    if (Array.isArray(va) || Array.isArray(vb)) {
      if (!Array.isArray(va) || !Array.isArray(vb) || va.length !== vb.length) { problems.push(where + ": array differs"); return; }
      va.forEach((x, i) => cmp(x, vb[i], where + "[" + i + "]", depth + 1));
      return;
    }
    if (va && typeof va === "object" && vb && typeof vb === "object") {
      const ka = Object.keys(va).sort(), kb = Object.keys(vb).sort();
      if (ka.join() !== kb.join()) { problems.push(where + ": keys differ (" + ka.filter((k) => !kb.includes(k)).concat(kb.filter((k) => !ka.includes(k))).join(" ") + ")"); return; }
      for (const k of ka) cmp(va[k], vb[k], where + k, depth + 1);
      return;
    }
    if (typeof va === "number" && typeof vb === "number" ? Math.abs(va - vb) > 1e-9 : va !== vb) problems.push(where + ": " + JSON.stringify(va) + " -> " + JSON.stringify(vb));
  }
  cmp(a.trailer["/Root"], b.trailer["/Root"], "Root", 0);
  if (a.trailer["/Info"] || b.trailer["/Info"]) cmp(a.trailer["/Info"], b.trailer["/Info"], "Info", 0);
  return problems;
}

// ===================== RENDER GATE (Ghostscript, optional) =====================

function seededRandom(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function samplePages(pages, chosen, cfg) {
  const n = pages.length;
  const area = new Array(n).fill(0);
  for (const c of chosen) for (const p of c.pages) area[p] += c.w * c.h;
  const pick = new Set([0, n - 1]);
  [...area.keys()].filter((i) => area[i] > 0).sort((x, y) => area[y] - area[x]).slice(0, cfg.sample.heaviest).forEach((i) => pick.add(i));
  const rnd = seededRandom(cfg.sample.seed);
  for (let k = 0; k < cfg.sample.random * 4 && pick.size < 2 + cfg.sample.heaviest + cfg.sample.random && pick.size < n; k++) pick.add(Math.floor(rnd() * n));
  return [...pick].sort((x, y) => x - y);
}

async function renderPage(gs, file, pageIndex, dpi, out) {
  execFileSync(gs.exe, ["-q", "-dNOPAUSE", "-dBATCH", "-dSAFER", "-sDEVICE=png16m", "-r" + dpi.toFixed(2),
    "-dTextAlphaBits=4", "-dGraphicsAlphaBits=4", "-dDOINTERPOLATE", "-dFirstPage=" + (pageIndex + 1), "-dLastPage=" + (pageIndex + 1),
    "-sOutputFile=" + out, file], { stdio: "ignore" });
  const { data, info } = await sharp(out).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, info };
}

// Whole page at the viewer's 1x, and the worst of a 4 x 4 grid at the viewer's maximum zoom. Images are
// drawn interpolated (-dDOINTERPOLATE), as PDF.js does on its canvas; Ghostscript's default
// nearest-neighbour sampling would exaggerate aliasing in fine textures.
async function renderCheck(gs, cfg, fileA, fileB, pages, sample, tmp, compareDir) {
  const results = [];
  for (const p of sample) {
    const page = pages[p];
    const longIn = Math.max(Math.abs(page.box[2] - page.box[0]), Math.abs(page.box[3] - page.box[1])) / 72;
    const dpi1x = cfg.render1xLongEdgePx / longIn;
    const dpiZoom = pageMaxDpi(cfg, page);
    const r = { page: p + 1 };
    for (const [kind, dpi] of [["1x", dpi1x], ["zoom", dpiZoom]]) {
      const A = await renderPage(gs, fileA, p, dpi, path.join(tmp, `a-${p}-${kind}.png`));
      const B = await renderPage(gs, fileB, p, dpi, path.join(tmp, `b-${p}-${kind}.png`));
      if (A.info.width !== B.info.width || A.info.height !== B.info.height) { r[kind] = { error: "render size differs" }; continue; }
      if (kind === "1x") {
        r["1x"] = { psnr: +psnr(A.data, B.data).toFixed(2) };
        if (compareDir) await sideBySide(A, B, null, path.join(compareDir, `p${String(p + 1).padStart(2, "0")}-1x.png`));
      } else {
        const { width: W, height: H } = A.info;
        let worst = { psnr: 99 };
        for (let ty = 0; ty < 4; ty++) for (let tx = 0; tx < 4; tx++) {
          const x0 = Math.floor((tx * W) / 4), x1 = Math.floor(((tx + 1) * W) / 4), y0 = Math.floor((ty * H) / 4), y1 = Math.floor(((ty + 1) * H) / 4);
          const ta = [], tb = [];
          for (let y = y0; y < y1; y++) { ta.push(A.data.subarray((y * W + x0) * 3, (y * W + x1) * 3)); tb.push(B.data.subarray((y * W + x0) * 3, (y * W + x1) * 3)); }
          const v = psnr(Buffer.concat(ta), Buffer.concat(tb));
          if (v < worst.psnr) worst = { psnr: v, tile: [x0, y0, x1 - x0, y1 - y0] };
        }
        r.zoom = { worstTilePsnr: +worst.psnr.toFixed(2), dpi: +dpiZoom.toFixed(1) };
        if (compareDir) await sideBySide(A, B, worst.tile, path.join(compareDir, `p${String(p + 1).padStart(2, "0")}-zoom-worst-tile.png`));
      }
    }
    r.pass = !!(r["1x"] && r["1x"].psnr >= cfg.minRender1xPsnrDb && r.zoom && r.zoom.worstTilePsnr >= cfg.minRenderZoomTilePsnrDb);
    results.push(r);
  }
  return results;
}

// original | optimized, optionally cropped to a tile, with a thin gap.
async function sideBySide(A, B, tile, out) {
  const raw = (X) => sharp(X.data, { raw: { width: X.info.width, height: X.info.height, channels: 3 } });
  const crop = (X) => (tile ? raw(X).extract({ left: tile[0], top: tile[1], width: tile[2], height: tile[3] }) : raw(X));
  const a = await crop(A).png().toBuffer(), b = await crop(B).png().toBuffer();
  const w = tile ? tile[2] : A.info.width, h = tile ? tile[3] : A.info.height;
  await sharp({ create: { width: w * 2 + 16, height: h, channels: 3, background: { r: 254, g: 251, b: 40 } } })
    .composite([{ input: a, left: 0, top: 0 }, { input: b, left: w + 16, top: 0 }]).png().toFile(out);
}

// ===================== ONE FILE =====================

async function optimizeOne(ctx, rel, source) {
  const { qpdf, gs, cfg, headroom, tmpRoot, compareRoot } = ctx;
  const t0 = Date.now();
  const tmp = fs.mkdtempSync(path.join(tmpRoot, "f-"));
  const result = { file: rel, source: path.relative(ctx.projectDir, source).split(path.sep).join("/"), headroom };
  try {
    const srcBytes = fs.statSync(source).size;
    result.before = srcBytes;
    result.qpdfWarnings = [];
    const A = model(qpdfJson(qpdf, source, result.qpdfWarnings));
    const pages = pagesOf(A);
    result.pages = pages.length;
    const { chosen, skipped, unparsed } = choose(A, pages, cfg, headroom);
    result.imagesResampled = 0;
    result.imagesSkipped = skipped;
    if (unparsed.length) result.unparsedContent = unparsed.slice(0, 5);
    const updates = {};
    const replaced = new Set();
    const psnrs = [];
    for (const item of chosen) {
      const r = await resample(A, item, cfg);
      if (r.skip) { skipped[r.skip] = (skipped[r.skip] || 0) + 1; continue; }
      Object.assign(updates, r.updates);
      for (const k of Object.keys(r.updates)) replaced.add(k.replace(/^obj:/, ""));
      psnrs.push(r.psnr);
      result.imagesResampled++;
    }
    result.imagePsnrMin = psnrs.length ? +Math.min(...psnrs).toFixed(2) : null;
    const updFile = path.join(tmp, "update.json");
    fs.writeFileSync(updFile, JSON.stringify({ qpdf: [A.header, updates] }));
    const outFile = path.join(tmp, "out.pdf");
    runQpdf(qpdf, [source, "--update-from-json=" + updFile, "--object-streams=generate", "--compress-streams=y",
      "--recompress-flate", "--compression-level=9", outFile], result.qpdfWarnings);
    result.after = fs.statSync(outFile).size;

    // ---- gates ----
    const gates = {};
    const B = model(qpdfJson(qpdf, outFile, result.qpdfWarnings));
    const pagesB = pagesOf(B);
    gates.pages = pagesB.length === pages.length && pagesB.every((p, i) => p.rotate === pages[i].rotate &&
      p.box.every((v, k) => Math.abs(v - pages[i].box[k]) < 1e-6));
    const problems = compareStructure(A, B, replaced);
    gates.unchangedApartFromImages = problems.length === 0;
    if (problems.length) result.structureProblems = problems.slice(0, 8);
    gates.imagePsnr = psnrs.every((v) => v >= cfg.minImagePsnrDb);
    gates.smaller = result.after <= result.before * (1 - cfg.minSavingPercent / 100);
    if (gs) {
      const sample = samplePages(pages, chosen, cfg);
      const compareDir = compareRoot ? path.join(compareRoot, rel.replace(/[\\/]/g, "__").replace(/\.pdf$/i, "") + "--h" + headroom) : null;
      if (compareDir) fs.mkdirSync(compareDir, { recursive: true });
      result.render = await renderCheck(gs, cfg, source, outFile, pages, sample, tmp, compareDir);
      gates.render = result.render.every((r) => r.pass);
      if (compareDir) result.compareImages = compareDir;
    } else {
      result.render = "skipped: no Ghostscript found";
    }
    if (!result.qpdfWarnings.length) delete result.qpdfWarnings;
    result.gates = gates;
    result.pass = Object.values(gates).every(Boolean);
    result.outFile = outFile;
    result.seconds = +((Date.now() - t0) / 1000).toFixed(1);
    return result;
  } catch (err) {
    result.error = String(err.stderr || err.message || err).slice(0, 400);
    result.pass = false;
    result.seconds = +((Date.now() - t0) / 1000).toFixed(1);
    return result;
  }
}

// ===================== MAIN =====================

function runGenerator(projectDir) {
  try {
    execFileSync(process.execPath, [GENERATOR, projectDir], { stdio: "inherit" });
  } catch (err) {
    if (typeof err.status === "number") process.exit(err.status);
    throw err;
  }
}

function parseArgs(argv) {
  const args = { flags: new Set(), positional: [] };
  for (const a of argv) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a);
    if (m && m[2] !== undefined) args[m[1]] = m[2];
    else if (m) args.flags.add(m[1]);
    else args.positional.push(a);
  }
  return args;
}

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const projectDir = args.positional[0];
  if (!projectDir) {
    console.error("Usage: node tools/optimize-pdfs.js projects/<slug> [--dry-run | --preview | --check] [--force] [--headroom=N] [--only=TEXT]");
    process.exit(2);
  }
  const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  const dry = args.flags.has("dry-run"), preview = args.flags.has("preview"), check = args.flags.has("check"), force = args.flags.has("force");
  const headroom = args.headroom !== undefined ? Number(args.headroom) : cfg.headroom;
  if (args.headroom !== undefined && !(dry || preview)) {
    console.error("--headroom only works with --dry-run or --preview (change it in tools/pdf-optimize.config.json to apply it).");
    process.exit(2);
  }
  if (!(headroom > 0)) { console.error("headroom must be a positive number"); process.exit(2); }

  const projectFile = path.join(projectDir, "project.json");
  if (!fs.existsSync(projectFile)) { console.error(`${projectFile} not found`); process.exit(1); }
  const project = JSON.parse(fs.readFileSync(projectFile, "utf8"));
  const ledger = readLedger(projectDir);
  let files = listPdfs(projectDir, project);
  if (args.only) files = files.filter((f) => f.toLowerCase().includes(args.only.toLowerCase()));

  const plans = files.map((rel) => Object.assign({ rel }, plan(projectDir, rel, ledger, cfg, force)));

  if (check) {
    let todo = 0;
    for (const p of plans) {
      const note = p.action === "done" ? "ok (optimized" + (p.entry.result === "kept-original" ? ", original kept" : "") + ")"
        : p.action === "new" ? (p.replacedSinceLedger ? "CHANGED since it was optimized" : "NOT optimized yet")
        : p.action === "rederive" ? "settings changed: will be re-derived from _originals/"
        : "settings changed, but no original in _originals/ to re-derive from";
      if (p.action !== "done") todo++;
      console.log(`${note.padEnd(48)} ${MB(p.bytes).padStart(10)}  ${p.rel}`);
    }
    if (todo) console.log(`\n${todo} PDF(s) need attention. Run: node tools/optimize-pdfs.js ${projectDir}`);
    process.exit(todo ? 1 : 0);
  }

  const qpdf = findQpdf();
  if (!qpdf) {
    console.error("qpdf is not installed. Once per computer, run:  winget install --id QPDF.QPDF -e");
    process.exit(1);
  }
  const gs = findGhostscript();
  console.log(`qpdf: ${qpdf.version} (${qpdf.exe})`);
  console.log(gs ? `Ghostscript ${gs.version} for the render check (${gs.exe})` : "Ghostscript not found: render check skipped (the structural and per-image checks still run)");

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "thd-optimize-pdfs-"));
  const previewDir = !preview ? null : args.out ? path.resolve(args.out)
    : path.join(os.tmpdir(), "thd-pdf-preview", path.basename(path.resolve(projectDir)), timestamp() + "-h" + headroom);
  if (previewDir && path.resolve(previewDir).startsWith(path.resolve(projectDir))) {
    console.error("--out must be outside the project folder."); process.exit(2);
  }
  if (previewDir) fs.mkdirSync(previewDir, { recursive: true });
  const ctx = { qpdf, gs, cfg, headroom, tmpRoot, projectDir, compareRoot: previewDir && path.join(previewDir, "compare") };

  const results = [];
  let changed = 0;
  for (const p of plans) {
    if (p.action === "done") { console.log(`skip  ${p.rel}  (already optimized with settings v${p.entry.settingsVersion})`); continue; }
    if (p.action === "stale") { console.log(`warn  ${p.rel}  settings changed, but _originals/${p.rel} is missing; left as it is`); continue; }
    console.log(`\n${p.rel}  (${MB(p.bytes)}, from ${p.action === "rederive" ? "_originals/" : "the file itself"})`);
    const r = await optimizeOne(ctx, p.rel, p.source);
    results.push(r);
    const gateText = r.gates ? Object.entries(r.gates).map(([k, v]) => `${k} ${v ? "ok" : "FAIL"}`).join(", ") : "";
    if (r.error) console.log(`  ERROR ${r.error}`);
    else console.log(`  ${MB(r.before)} -> ${MB(r.after)} (${(100 - (100 * r.after) / r.before).toFixed(1)}% smaller), ${r.imagesResampled} images resampled, ${r.seconds}s; ${gateText}`);
    if (r.imagesSkipped && Object.keys(r.imagesSkipped).length) console.log("  images left as they are: " + Object.entries(r.imagesSkipped).map(([k, v]) => v + " " + k).join(", "));
    if (r.unparsedContent) console.log("  content not read: " + r.unparsedContent.join("; "));
    if (r.structureProblems) console.log("  structure: " + r.structureProblems.join("; "));
    if (preview && r.outFile && fs.existsSync(r.outFile)) {
      const dest = path.join(previewDir, "optimized", p.rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(r.outFile, dest);
      r.previewCopy = dest;
    }
    if (dry || preview) continue;

    // ---- apply ----
    const target = path.join(projectDir, p.rel);
    const backup = path.join(projectDir, ORIGINALS_DIR, p.rel);
    const sourceBuf = fs.readFileSync(p.source);
    const entry = { originalSha256: sha256(sourceBuf), originalBytes: sourceBuf.length, settingsVersion: cfg.settingsVersion, headroom, date: new Date().toISOString().slice(0, 10) };
    if (p.action === "new") {
      // Back up the original first. A different earlier original is kept under a dated name.
      if (fs.existsSync(backup) && sha256(fs.readFileSync(backup)) !== entry.originalSha256) {
        fs.renameSync(backup, backup.replace(/\.pdf$/i, "") + ".replaced-" + timestamp() + ".pdf");
      }
      if (!fs.existsSync(backup)) {
        fs.mkdirSync(path.dirname(backup), { recursive: true });
        fs.copyFileSync(target, backup);
        if (sha256(fs.readFileSync(backup)) !== entry.originalSha256) throw new Error("backup of " + p.rel + " doesn't match; stopping");
      }
    }
    if (r.pass) {
      // Same drive as the target, then an atomic rename over it.
      const staging = path.join(path.dirname(target), "." + path.basename(target) + ".optimizing");
      fs.copyFileSync(r.outFile, staging);
      const out = fs.readFileSync(staging);
      if (out.length !== r.after) throw new Error("staging copy of " + p.rel + " is incomplete; stopping");
      fs.renameSync(staging, target);
      ledger.files[p.rel] = Object.assign(entry, { result: "optimized", outputSha256: sha256(out), outputBytes: out.length, imagesResampled: r.imagesResampled });
      changed++;
    } else {
      // Original kept (restored from the backup when re-deriving), and recorded so it isn't retried.
      if (p.action === "rederive") fs.copyFileSync(p.source, target);
      const why = r.error ? "error: " + r.error : "gate failed: " + Object.entries(r.gates).filter(([, v]) => !v).map(([k]) => k).join(", ");
      ledger.files[p.rel] = Object.assign(entry, { result: "kept-original", reason: why, outputSha256: entry.originalSha256, outputBytes: entry.originalBytes });
      changed++;
    }
  }

  const report = results.map((r) => { const c = Object.assign({}, r); delete c.outFile; return c; });
  if (previewDir) {
    fs.writeFileSync(path.join(previewDir, "report.json"), JSON.stringify({ headroom, settingsVersion: cfg.settingsVersion, results: report }, null, 2));
    console.log(`\nPreview (nothing in the project was changed): ${previewDir}`);
  }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  if (dry || preview) return;
  if (changed) writeLedger(projectDir, ledger);
  console.log(`\n${changed} PDF(s) recorded in ${path.join(projectDir, LEDGER_NAME)}. Running the generator:`);
  runGenerator(projectDir);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
