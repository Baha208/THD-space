/* /admin/api/projects — GET every project (drafts, published and deleted, with counts);
   POST { client, title, slug?, templateId? } creates a draft from a template. */
import { handle, json, readJsonBody, HttpError } from "../../../../server/http.js";
import { loadAllProjects, loadProject, loadTemplates, saveProject } from "../../../../server/store.js";
import { newProject, validateProject, summarize, SLUG_RE, MAX_SLUG } from "../../../../server/project.js";
import { slugify } from "../../../../server/text.js";

export const onRequestGet = handle(async ({ env }) => {
  const projects = (await loadAllProjects(env.BUCKET)).map((p) => ({
    slug: p.slug, client: p.client, title: p.title, status: p.status,
    createdAt: p.createdAt || null, updatedAt: p.updatedAt || null, templateId: p.templateId || null,
    counts: summarize(p)
  }));
  return json({ projects });
});

export const onRequestPost = handle(async ({ request, env }) => {
  const body = await readJsonBody(request);
  const slug = String(body.slug || slugify(body.title || "")).trim();
  if (!SLUG_RE.test(slug) || slug.length > MAX_SLUG) {
    throw new HttpError(422, `"${slug}" is not a valid slug: lowercase letters, digits and single hyphens, max ${MAX_SLUG}`);
  }
  if (await loadProject(env.BUCKET, slug)) throw new HttpError(409, `A project with the slug "${slug}" already exists`);

  let template = null;
  if (body.templateId) {
    template = (await loadTemplates(env.BUCKET)).find((t) => t.id === body.templateId) || null;
    if (!template) throw new HttpError(422, `No template "${body.templateId}"`);
  }
  const project = newProject({ client: body.client, title: body.title, slug, template });
  const errors = validateProject(project);
  if (errors.length) throw new HttpError(422, "Project is not valid", errors);
  await saveProject(env.BUCKET, project);
  return json({ project }, 201);
});
