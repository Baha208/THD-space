/* /admin/api/projects/<slug> — GET the project; PUT { project } saves it (creating it when it
   does not exist yet, which is how tools/import-project.js brings a generated project in);
   DELETE moves it to the trash (status "deleted": files stay in the bucket, restore undoes it). */
import { handle, json, readJsonBody, HttpError } from "../../../../server/http.js";
import { loadProject, requireProject, saveProject, rebuildIndex } from "../../../../server/store.js";
import { normalizeProject, validateProject } from "../../../../server/project.js";

export const onRequestGet = handle(async ({ env, params }) => json({ project: await requireProject(env.BUCKET, params.slug) }));

export const onRequestPut = handle(async ({ request, env, params }) => {
  const body = await readJsonBody(request);
  if (!body.project || typeof body.project !== "object") throw new HttpError(400, "Body must be { project }");
  const incoming = normalizeProject(body.project);
  if (incoming.slug !== params.slug) throw new HttpError(422, `project.slug "${incoming.slug}" does not match the URL "${params.slug}"`);

  const existing = await loadProject(env.BUCKET, params.slug);
  if (existing) {
    // Status and creation date only change through their own endpoints.
    incoming.status = existing.status;
    incoming.createdAt = existing.createdAt || incoming.createdAt || null;
  } else if (!incoming.createdAt) {
    incoming.createdAt = new Date().toISOString();
  }
  const errors = validateProject(incoming, { forPublish: incoming.status === "published" });
  if (errors.length) throw new HttpError(422, "Project is not valid", errors);

  const project = await saveProject(env.BUCKET, incoming);
  if (project.status === "published" || (existing && existing.status === "published")) await rebuildIndex(env.BUCKET);
  return json({ project });
});

export const onRequestDelete = handle(async ({ env, params }) => {
  const project = await requireProject(env.BUCKET, params.slug);
  const wasPublished = project.status === "published";
  project.status = "deleted";
  await saveProject(env.BUCKET, project);
  if (wasPublished) await rebuildIndex(env.BUCKET);
  return json({ project });
});
