/* GET /admin/api/me — who the panel is signed in as ("local-dev" when Access is not configured). */
import { json } from "../../../server/http.js";

export function onRequestGet({ data }) {
  return json({ user: data.user });
}
