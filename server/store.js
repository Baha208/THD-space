/* ===== THD Space server — the bucket =====
   One R2 bucket (binding BUCKET) holds everything the admin panel manages:
     projects/<slug>/project.json        the project (see project.js)
     projects/<slug>/<path>              its floor plans, renders, medium copies and PDFs, at the
                                         paths project.json lists
     projects-index.json                 the hub's list: published projects only (buildIndex)
     templates.json                      { templates: [...] }, seeded from templates-default.js
   Locally, wrangler emulates the bucket under .wrangler/state/. */
import { HttpError } from "./http.js";
import { DEFAULT_TEMPLATES } from "./templates-default.js";
import { normalizeProject, buildIndex } from "./project.js";

export const PROJECTS_PREFIX = "projects/";
export const INDEX_KEY = "projects-index.json";
export const TEMPLATES_KEY = "templates.json";

export const projectKey = (slug, path = "project.json") => `${PROJECTS_PREFIX}${slug}/${path}`;

export async function readJson(bucket, key) {
  const obj = await bucket.get(key);
  if (!obj) return null;
  try {
    return await obj.json();
  } catch (err) {
    throw new HttpError(500, `${key} in the bucket is not valid JSON`);
  }
}

export async function writeJson(bucket, key, value) {
  await bucket.put(key, JSON.stringify(value, null, 2) + "\n", {
    httpMetadata: { contentType: "application/json; charset=utf-8" }
  });
}

export async function listKeys(bucket, prefix) {
  const keys = [];
  let cursor;
  do {
    const page = await bucket.list({ prefix, cursor, limit: 1000 });
    page.objects.forEach((o) => keys.push(o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return keys;
}

// Every project folder in the bucket (from the "projects/<slug>/" prefixes).
export async function listSlugs(bucket) {
  const slugs = [];
  let cursor;
  do {
    const page = await bucket.list({ prefix: PROJECTS_PREFIX, delimiter: "/", cursor, limit: 1000 });
    (page.delimitedPrefixes || []).forEach((p) => slugs.push(p.slice(PROJECTS_PREFIX.length, -1)));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return slugs;
}

export async function loadProject(bucket, slug) {
  const p = await readJson(bucket, projectKey(slug));
  return p ? normalizeProject(p) : null;
}

export async function requireProject(bucket, slug) {
  const p = await loadProject(bucket, slug);
  if (!p) throw new HttpError(404, `No project "${slug}"`);
  return p;
}

export async function saveProject(bucket, project) {
  project.updatedAt = new Date().toISOString();
  await writeJson(bucket, projectKey(project.slug), project);
  return project;
}

export async function loadAllProjects(bucket) {
  const slugs = await listSlugs(bucket);
  const all = await Promise.all(slugs.map((s) => loadProject(bucket, s)));
  return all.filter(Boolean);
}

// Rewrites projects-index.json from every project's current status. Called after anything
// that can change the hub's list (publish, unpublish, delete, restore, a title edit).
export async function rebuildIndex(bucket) {
  const index = buildIndex(await loadAllProjects(bucket));
  await writeJson(bucket, INDEX_KEY, index);
  return index;
}

export async function deleteKeys(bucket, keys) {
  for (let i = 0; i < keys.length; i += 1000) {
    await bucket.delete(keys.slice(i, i + 1000));
  }
}

export async function loadTemplates(bucket) {
  const stored = await readJson(bucket, TEMPLATES_KEY);
  if (stored && Array.isArray(stored.templates)) return stored.templates;
  await writeJson(bucket, TEMPLATES_KEY, { templates: DEFAULT_TEMPLATES });
  return DEFAULT_TEMPLATES;
}

export async function saveTemplates(bucket, templates) {
  await writeJson(bucket, TEMPLATES_KEY, { templates });
}
