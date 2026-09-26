/* GET /projects-index.json — the hub's project list, from the bucket (rebuilt by the admin API
   whenever a project is published, unpublished, deleted or renamed). An empty list until then. */
import { handle } from "../server/http.js";
import { INDEX_KEY } from "../server/store.js";

export const onRequestGet = handle(async ({ env }) => {
  const object = await env.BUCKET.get(INDEX_KEY);
  const body = object ? await object.text() : JSON.stringify({ projects: [] }, null, 2) + "\n";
  return new Response(body, { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-cache" } });
});
