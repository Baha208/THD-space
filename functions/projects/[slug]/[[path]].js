/* Everything under /projects/<slug>/: shell, worker stub, manifest, project.json and files. */
import { handle } from "../../../server/http.js";
import { serveProject } from "../../../server/serve-project.js";

export const onRequestGet = handle(async ({ request, env, params }) => {
  const segments = Array.isArray(params.path) ? params.path : params.path ? [params.path] : [];
  let rel;
  try {
    rel = segments.map(decodeURIComponent).join("/");
  } catch (err) {
    return new Response("Bad path", { status: 400 });
  }
  return serveProject({ request, env, slug: params.slug, rel });
});
