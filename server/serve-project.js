/* ===== THD Space server — serving a presentation from the bucket =====
   Answers every URL under /projects/<slug>/ so the engine and its service worker work exactly as
   they do on a static host, with no project folder deployed:
     ./            index.html   the shell, from engine/templates/index.html ({{ENGINE}} filled in)
     sw.js                      the worker stub, from engine/templates/sw.js
     manifest.json              built from project.json (server/manifest.js)
     project.json               the stored project
     <any other path>           the stored file (floor plan, render, medium copy, PDF)
   Drafts are served too (that is how a project is previewed before publishing); a deleted
   project is a 404. Responses name the missing path, as the engine does. */
import { text } from "./http.js";
import { loadProject, projectKey } from "./store.js";
import { webManifest, inkFromTokens } from "./manifest.js";
import { SLUG_RE } from "./project.js";

const ENGINE_REL = "../../engine";
const TYPES = {
  webp: "image/webp", avif: "image/avif", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
  pdf: "application/pdf", json: "application/json; charset=utf-8"
};

async function assetText(env, request, path) {
  const res = await env.ASSETS.fetch(new URL(path, request.url));
  if (!res.ok) throw new Error(`deployed asset ${path} is missing (HTTP ${res.status})`);
  return res.text();
}

const fromTemplate = (source) => source.split("{{ENGINE}}").join(ENGINE_REL);

export async function serveProject({ request, env, slug, rel }) {
  const url = new URL(request.url);
  const pathname = url.pathname;
  if (!SLUG_RE.test(slug)) return text("Not found: " + pathname, 404);

  // The shell's URLs are relative (sw.js, project.json, ../../engine/): it only works at the
  // folder form of the address, so /projects/<slug> goes to /projects/<slug>/ first.
  if (rel === "" && !pathname.endsWith("/")) return Response.redirect(url.origin + pathname + "/" + url.search, 301);

  if (rel === "" || rel === "index.html") {
    const project = await loadProject(env.BUCKET, slug);
    if (!project || project.status === "deleted") return text(`No presentation at ${pathname}`, 404);
    const html = fromTemplate(await assetText(env, request, "/engine/templates/index.html"));
    return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
  }
  if (rel === "sw.js") {
    const js = fromTemplate(await assetText(env, request, "/engine/templates/sw.js"));
    return new Response(js, { headers: { "content-type": "application/javascript; charset=utf-8", "cache-control": "no-cache" } });
  }
  if (rel === "project.json" || rel === "manifest.json") {
    const project = await loadProject(env.BUCKET, slug);
    if (!project || project.status === "deleted") return text("Not found: " + pathname, 404);
    const body = rel === "project.json"
      ? project
      : webManifest(project, inkFromTokens(await assetText(env, request, "/engine/tokens.css")), ENGINE_REL);
    return new Response(JSON.stringify(body, null, 2) + "\n", {
      headers: { "content-type": rel === "manifest.json" ? "application/manifest+json" : "application/json; charset=utf-8", "cache-control": "no-cache" }
    });
  }

  const object = await env.BUCKET.get(projectKey(slug, rel));
  if (!object) return text("Not found: " + pathname, 404);
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  if (!headers.get("content-type")) {
    const ext = rel.split(".").pop().toLowerCase();
    headers.set("content-type", TYPES[ext] || "application/octet-stream");
  }
  headers.set("etag", object.httpEtag);
  headers.set("content-length", String(object.size));
  // Uploads get unique names (text.js uploadName), so a path's content never changes.
  headers.set("cache-control", "public, max-age=31536000, immutable");
  return new Response(object.body, { headers });
}
