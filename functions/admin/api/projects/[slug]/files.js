/* /admin/api/projects/<slug>/files?path=<path inside the project>
   PUT  the request body is the file (Content-Type = its type). Stores it at that path; the
        caller then lists the path in project.json and saves the project.
   DELETE ?path=… or { paths: [...] } removes files (after they were dropped from project.json). */
import { handle, json, readJsonBody, HttpError } from "../../../../../server/http.js";
import { requireProject, projectKey, deleteKeys } from "../../../../../server/store.js";
import { isSafePath, IMAGE_EXT, DOC_EXT } from "../../../../../server/project.js";

const MAX_BYTES = 100 * 1024 * 1024;

function pathFrom(request) {
  const path = new URL(request.url).searchParams.get("path") || "";
  if (!isSafePath(path)) throw new HttpError(422, `"${path}" is not a valid file path`);
  if (!IMAGE_EXT.test(path) && !DOC_EXT.test(path)) throw new HttpError(422, `"${path}": only .webp, .avif, .jpg, .png and .pdf files`);
  return path;
}

export const onRequestPut = handle(async ({ request, env, params }) => {
  const project = await requireProject(env.BUCKET, params.slug);
  if (project.status === "deleted") throw new HttpError(409, "This project is in the trash; restore it first");
  const path = pathFrom(request);
  const length = Number(request.headers.get("content-length") || 0);
  if (length > MAX_BYTES) throw new HttpError(413, `File is larger than ${MAX_BYTES / 1024 / 1024} MB`);
  const data = await request.arrayBuffer();
  if (!data.byteLength) throw new HttpError(400, "Empty file");
  if (data.byteLength > MAX_BYTES) throw new HttpError(413, `File is larger than ${MAX_BYTES / 1024 / 1024} MB`);
  const contentType = request.headers.get("content-type") || (DOC_EXT.test(path) ? "application/pdf" : "application/octet-stream");
  await env.BUCKET.put(projectKey(params.slug, path), data, { httpMetadata: { contentType } });
  return json({ path, size: data.byteLength });
});

export const onRequestDelete = handle(async ({ request, env, params }) => {
  await requireProject(env.BUCKET, params.slug);
  const url = new URL(request.url);
  let paths = [];
  if (url.searchParams.get("path")) paths = [url.searchParams.get("path")];
  else paths = (await readJsonBody(request)).paths || [];
  if (!Array.isArray(paths) || !paths.length) throw new HttpError(400, "Nothing to delete");
  const bad = paths.filter((p) => !isSafePath(p));
  if (bad.length) throw new HttpError(422, `Invalid path: ${bad[0]}`);
  await deleteKeys(env.BUCKET, paths.map((p) => projectKey(params.slug, p)));
  return json({ deleted: paths.length });
});
