/* ===== THD Space server — text helpers =====
   Ported from engine/generate-manifest.js so ids and labels made by the admin panel match the
   ones the generator makes from folders: same slugify / camelCase / titleCase / natural sort. */

export const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

export const naturalSort = (list) => list.slice().sort(collator.compare);

// "Ground Floor" -> "ground-floor"   (floor ids, project slugs)
export function slugify(s) {
  return String(s == null ? "" : s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

// "master bedroom" -> "masterBedroom"   (room ids)
export function camelCase(s) {
  return String(s == null ? "" : s).toLowerCase().replace(/[^a-z0-9]+(.)?/g, (_, c) => (c ? c.toUpperCase() : ""));
}

// "guest toilet" -> "Guest Toilet"
export function titleCase(s) {
  return String(s == null ? "" : s).toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

// "GF-electrical_layout.pdf" -> "GF Electrical Layout". All-caps words (MEP, GF) are kept.
export function documentLabel(file) {
  const base = String(file).split("/").pop().replace(/\.[^.]+$/, "");
  return base
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .map((w) => (/^[A-Z0-9]+$/.test(w) && /[A-Z]/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()))
    .join(" ");
}

// First of base, base-2, base-3, … not in `taken`. An empty base falls back to `fallback`.
export function uniqueId(base, taken, fallback = "item") {
  const root = base || fallback;
  let id = root;
  for (let n = 2; taken.has(id); n++) id = `${root}-${n}`;
  return id;
}

// File name for an upload: the original base name, made URL-safe, with a short random suffix so a
// replaced render never reuses a path (the presentations cache images by path, forever).
export function uploadName(originalName, ext) {
  const base = slugify(String(originalName).replace(/\.[^.]+$/, "")) || "file";
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${base.slice(0, 60)}-${suffix}.${ext}`;
}
