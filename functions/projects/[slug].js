/* /projects/<slug> (no trailing slash) redirects to the folder form, so the shell's relative
   URLs (sw.js, project.json, ../../engine/) resolve. /projects/<slug>/ itself is the shell. */
import { handle } from "../../server/http.js";
import { serveProject } from "../../server/serve-project.js";

export const onRequestGet = handle(async ({ request, env, params }) => {
  const url = new URL(request.url);
  if (!url.pathname.endsWith("/")) return Response.redirect(url.origin + url.pathname + "/" + url.search, 301);
  return serveProject({ request, env, slug: params.slug, rel: "" });
});
