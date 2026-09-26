/* /admin/api/templates — GET the list, PUT { templates } to replace it. */
import { handle, json, readJsonBody, HttpError } from "../../../server/http.js";
import { loadTemplates, saveTemplates } from "../../../server/store.js";
import { validateTemplates, cleanTemplates } from "../../../server/project.js";

export const onRequestGet = handle(async ({ env }) => json({ templates: await loadTemplates(env.BUCKET) }));

export const onRequestPut = handle(async ({ request, env }) => {
  const body = await readJsonBody(request);
  const errors = validateTemplates(body.templates);
  if (errors.length) throw new HttpError(422, "Templates are not valid", errors);
  const templates = cleanTemplates(body.templates);
  await saveTemplates(env.BUCKET, templates);
  return json({ templates });
});
