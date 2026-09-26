/* Root middleware: Cloudflare Access check for everything under /admin/ (the panel's static
   files and its API). Other routes pass straight through. Which routes reach Functions at all is
   set by site/_routes.json (copied to dist/); engine/ and hub/ files are served as plain static
   assets and never come here. */
import { verifyAccess } from "../server/access.js";
import { json, text } from "../server/http.js";

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);
  const isAdmin = url.pathname === "/admin" || url.pathname.startsWith("/admin/");
  if (!isAdmin) return next();

  try {
    context.data.user = await verifyAccess(request, env);
  } catch (err) {
    const status = err.status || 401;
    if (url.pathname.startsWith("/admin/api/")) return json({ error: err.message }, status);
    return text("THD Space admin: " + err.message, status);
  }
  const res = await next();
  const headers = new Headers(res.headers);
  headers.set("cache-control", "no-store"); // the panel must never be served stale
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
