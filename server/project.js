/* ===== THD Space server — project model =====
   The same project.json the presentations read (see CLAUDE.md "project.json"), with three
   admin-only fields the engine ignores: status ("draft" | "published" | "deleted"), createdAt,
   updatedAt (and templateId, for information). Paths are relative to the project's folder in
   the bucket, exactly as they are relative to the folder on disk for a generated project.

   validateProject() applies the generator's rules (unique ids, labels, safe paths) and, for
   publishing, the engine's own start-up checks from engine/app.js validate(): every floor has a
   plan and every room has at least one image, so a published presentation never opens on the
   loader's error list. */
import { slugify, camelCase, uniqueId, collator } from "./text.js";

export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const STATUSES = ["draft", "published", "deleted"];
export const IMAGE_EXT = /\.(webp|avif|jpe?g|png)$/i;
export const DOC_EXT = /\.pdf$/i;
// Made by the serving function from project.json and the engine templates; never stored.
export const RESERVED_FILES = new Set(["project.json", "manifest.json", "index.html", "sw.js"]);
export const MAX_SLUG = 64;

const str = (v) => (typeof v === "string" ? v.trim() : "");

// A path inside a project folder, as project.json stores it: relative, forward slashes, no "."
// or ".." segments, no control characters, not a file the serving function makes itself.
// Spaces and "&" are fine (the villa's folders have both); the engine URL-encodes each segment.
export function isSafePath(p) {
  if (typeof p !== "string" || !p || p.length > 500) return false;
  if (p.startsWith("/") || p.includes("\\") || /[\u0000-\u001f\u007f]/.test(p)) return false;
  const segments = p.split("/");
  if (segments.some((s) => s === "" || s === "." || s === ".." || s.trim() !== s)) return false;
  return !RESERVED_FILES.has(p);
}

export function floorIdFor(label, taken) {
  return uniqueId(slugify(label), taken, "floor");
}

export function roomIdFor(label, taken) {
  return uniqueId(camelCase(label), taken, "room");
}

// A new draft from a template (floors with rooms, no images). Ids are made the way the
// generator makes them from folder names.
export function newProject({ client, title, slug, template, now = new Date() }) {
  const stamp = now.toISOString();
  const floorIds = new Set();
  const floors = ((template && template.floors) || []).map((f) => {
    const id = floorIdFor(f.label, floorIds);
    floorIds.add(id);
    const roomIds = new Set();
    const floor = { id, label: str(f.label) || "Floor" };
    if (str(f.tabLabel)) floor.tabLabel = str(f.tabLabel);
    floor.plan = null;
    floor.rooms = (f.rooms || []).map((r) => {
      const label = typeof r === "string" ? r : r && r.label;
      const rid = roomIdFor(label, roomIds);
      roomIds.add(rid);
      return { id: rid, label: str(label) || "Room", images: [], medium: [] };
    });
    return floor;
  });
  return {
    schemaVersion: 1,
    slug,
    client: str(client),
    title: str(title),
    status: "draft",
    templateId: template ? template.id : null,
    createdAt: stamp,
    updatedAt: stamp,
    floors,
    documents: { files: [] }
  };
}

// Fills in what a hand-written or generated project.json may leave out, so the rest of the
// server and the admin panel can rely on the shape. Never changes authored values.
export function normalizeProject(input) {
  const p = Object.assign({}, input);
  if (p.schemaVersion == null) p.schemaVersion = 1;
  if (!STATUSES.includes(p.status)) p.status = "draft";
  p.floors = Array.isArray(p.floors) ? p.floors.map((f) => {
    const floor = Object.assign({}, f);
    if (floor.plan === undefined) floor.plan = null;
    floor.rooms = Array.isArray(floor.rooms) ? floor.rooms.map((r) => {
      const room = Object.assign({}, r);
      room.images = Array.isArray(room.images) ? room.images : [];
      room.medium = Array.isArray(room.medium) ? room.medium.slice(0, room.images.length) : [];
      while (room.medium.length < room.images.length) room.medium.push(null);
      return room;
    }) : [];
    return floor;
  }) : [];
  const docs = p.documents && typeof p.documents === "object" ? Object.assign({}, p.documents) : {};
  docs.files = Array.isArray(docs.files) ? docs.files.map((d) => (typeof d === "string" ? { file: d, label: d.split("/").pop() } : Object.assign({}, d))) : [];
  p.documents = docs;
  return p;
}

// Returns a list of problems (empty = valid). forPublish adds the engine's start-up checks.
export function validateProject(p, { forPublish = false } = {}) {
  const errors = [];
  if (!p || typeof p !== "object") return ["project must be an object"];
  if (p.schemaVersion !== 1) errors.push(`schemaVersion must be 1 (got ${JSON.stringify(p.schemaVersion)})`);
  if (!SLUG_RE.test(String(p.slug || "")) || String(p.slug).length > MAX_SLUG) errors.push(`slug "${p.slug}" must be lowercase letters, digits and single hyphens (max ${MAX_SLUG})`);
  if (!str(p.client)) errors.push("client is empty");
  if (!str(p.title)) errors.push("title is empty");
  if (!STATUSES.includes(p.status)) errors.push(`status must be one of ${STATUSES.join(", ")}`);
  if (!Array.isArray(p.floors)) {
    errors.push("floors must be a list");
    return errors;
  }
  if (forPublish && p.floors.length === 0) errors.push("a published project needs at least one floor");

  const floorIds = new Set();
  p.floors.forEach((floor, fi) => {
    const where = `floor ${fi + 1}${floor && floor.label ? ` "${floor.label}"` : ""}`;
    if (!floor || typeof floor !== "object") return errors.push(`${where}: must be an object`);
    if (!str(floor.id)) errors.push(`${where}: missing id`);
    else if (floorIds.has(floor.id)) errors.push(`${where}: duplicate floor id "${floor.id}"`);
    floorIds.add(floor.id);
    if (!str(floor.label)) errors.push(`${where}: label is empty`);
    if (floor.tabLabel != null && typeof floor.tabLabel !== "string") errors.push(`${where}: tabLabel must be text`);
    if (floor.plan != null && !(isSafePath(floor.plan) && IMAGE_EXT.test(floor.plan))) errors.push(`${where}: plan "${floor.plan}" is not a valid image path`);
    if (forPublish && !floor.plan) errors.push(`${where}: no floor plan yet`);
    if (!Array.isArray(floor.rooms)) return errors.push(`${where}: rooms must be a list`);

    const roomIds = new Set();
    floor.rooms.forEach((room, ri) => {
      const rw = `${where}, room ${ri + 1}${room && room.label ? ` "${room.label}"` : ""}`;
      if (!room || typeof room !== "object") return errors.push(`${rw}: must be an object`);
      if (!str(room.id)) errors.push(`${rw}: missing id`);
      else if (roomIds.has(room.id)) errors.push(`${rw}: duplicate room id "${room.id}" on this floor`);
      roomIds.add(room.id);
      if (!str(room.label)) errors.push(`${rw}: label is empty`);
      if (!Array.isArray(room.images)) return errors.push(`${rw}: images must be a list`);
      room.images.forEach((img) => {
        if (!(isSafePath(img) && IMAGE_EXT.test(img))) errors.push(`${rw}: image "${img}" is not a valid image path`);
      });
      if (room.medium != null) {
        if (!Array.isArray(room.medium) || room.medium.length !== room.images.length) errors.push(`${rw}: medium must list one entry (or null) per image`);
        else room.medium.forEach((m) => {
          if (m != null && !(isSafePath(m) && IMAGE_EXT.test(m))) errors.push(`${rw}: medium copy "${m}" is not a valid image path`);
        });
      }
      if (forPublish && room.images.length === 0) errors.push(`${rw}: no renders yet`);
    });
  });

  if (p.documents != null) {
    if (typeof p.documents !== "object") errors.push("documents must be an object");
    else if (p.documents.files != null) {
      if (!Array.isArray(p.documents.files)) errors.push("documents.files must be a list");
      else p.documents.files.forEach((d, di) => {
        const dw = `drawing ${di + 1}`;
        if (!d || typeof d !== "object") return errors.push(`${dw}: must be an object`);
        if (!(isSafePath(d.file) && DOC_EXT.test(d.file))) errors.push(`${dw}: file "${d.file}" is not a valid PDF path`);
        if (!str(d.label)) errors.push(`${dw}: label is empty`);
      });
    }
  }
  return errors;
}

export function summarize(p) {
  const floors = p.floors || [];
  return {
    floors: floors.length,
    plans: floors.filter((f) => f.plan).length,
    rooms: floors.reduce((n, f) => n + (f.rooms || []).length, 0),
    images: floors.reduce((n, f) => n + (f.rooms || []).reduce((m, r) => m + (r.images || []).length, 0), 0),
    documents: ((p.documents && p.documents.files) || []).length
  };
}

// Every file path a project refers to (for deleting a whole project's objects, or checking uploads).
export function referencedPaths(p) {
  const paths = [];
  (p.floors || []).forEach((f) => {
    if (f.plan) paths.push(f.plan);
    (f.rooms || []).forEach((r) => {
      (r.images || []).forEach((i) => paths.push(i));
      (r.medium || []).forEach((m) => { if (m) paths.push(m); });
    });
  });
  ((p.documents && p.documents.files) || []).forEach((d) => paths.push(d.file));
  return paths;
}

// The hub's list (projects-index.json): published projects only, sorted by title, the same
// entries tools/generate-projects-index.js writes.
export function buildIndex(projects) {
  const list = projects
    .filter((p) => p.status === "published" && str(p.client) && str(p.title))
    .map((p) => ({ slug: p.slug, client: str(p.client), title: str(p.title) }))
    .sort((a, b) => collator.compare(a.title, b.title));
  return { projects: list };
}

// Templates: [{ id, name, description?, floors: [{ label, tabLabel?, rooms: [label] }] }]
export function validateTemplates(templates) {
  const errors = [];
  if (!Array.isArray(templates)) return ["templates must be a list"];
  const ids = new Set();
  templates.forEach((t, ti) => {
    const where = `template ${ti + 1}${t && t.name ? ` "${t.name}"` : ""}`;
    if (!t || typeof t !== "object") return errors.push(`${where}: must be an object`);
    if (!SLUG_RE.test(String(t.id || ""))) errors.push(`${where}: id "${t.id}" must be lowercase letters, digits and hyphens`);
    else if (ids.has(t.id)) errors.push(`${where}: duplicate id "${t.id}"`);
    ids.add(t.id);
    if (!str(t.name)) errors.push(`${where}: name is empty`);
    if (t.description != null && typeof t.description !== "string") errors.push(`${where}: description must be text`);
    if (!Array.isArray(t.floors) || t.floors.length === 0) return errors.push(`${where}: needs at least one floor`);
    t.floors.forEach((f, fi) => {
      const fw = `${where}, floor ${fi + 1}`;
      if (!f || typeof f !== "object") return errors.push(`${fw}: must be an object`);
      if (!str(f.label)) errors.push(`${fw}: label is empty`);
      if (f.tabLabel != null && typeof f.tabLabel !== "string") errors.push(`${fw}: tabLabel must be text`);
      if (!Array.isArray(f.rooms)) return errors.push(`${fw}: rooms must be a list`);
      f.rooms.forEach((r, ri) => {
        if (!str(typeof r === "string" ? r : r && r.label)) errors.push(`${fw}, room ${ri + 1}: label is empty`);
      });
    });
  });
  return errors;
}

// Normalised copy of a template list: trimmed strings, rooms as plain labels.
export function cleanTemplates(templates) {
  return templates.map((t) => ({
    id: str(t.id),
    name: str(t.name),
    description: str(t.description),
    floors: t.floors.map((f) => {
      const floor = { label: str(f.label) };
      if (str(f.tabLabel)) floor.tabLabel = str(f.tabLabel);
      floor.rooms = f.rooms.map((r) => str(typeof r === "string" ? r : r.label));
      return floor;
    })
  }));
}
