/* POST /admin/api/projects/<slug>/status { status: "published" | "draft" }
   Publishing runs the engine's start-up checks first (every floor has a plan, every room has a
   render), so the hub never lists a presentation that would open on an error. "draft" also
   restores a deleted project. The hub's list is rebuilt either way. */
import { handle, json, readJsonBody, HttpError } from "../../../../../server/http.js";
import { requireProject, saveProject, rebuildIndex } from "../../../../../server/store.js";
import { validateProject } from "../../../../../server/project.js";

export const onRequestPost = handle(async ({ request, env, params }) => {
  const body = await readJsonBody(request);
  if (body.status !== "published" && body.status !== "draft") throw new HttpError(422, 'status must be "published" or "draft"');
  const project = await requireProject(env.BUCKET, params.slug);
  if (body.status === "published") {
    const errors = validateProject(project, { forPublish: true });
    if (errors.length) throw new HttpError(422, "Not ready to publish", errors);
  }
  project.status = body.status;
  await saveProject(env.BUCKET, project);
  await rebuildIndex(env.BUCKET);
  return json({ project });
});
