/* ===== THD Space server — Cloudflare Access check for /admin/ =====
   In production Cloudflare Access sits in front of /admin/* (a dashboard setting, see
   CLAUDE.md "Deploying") and adds a signed JWT to every request it lets through. This verifies
   that token again inside the function, as Cloudflare recommends, so a misconfigured policy
   can't leave the admin API open. With ACCESS_TEAM_DOMAIN / ACCESS_AUD unset (local dev) every
   request is allowed as "local-dev". */
import { HttpError } from "./http.js";

const JWKS_TTL_MS = 60 * 60 * 1000;
let jwks = { domain: null, keys: [], fetchedAt: 0 };

export function accessConfigured(env) {
  return !!(env && env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD);
}

function base64url(s) {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob((s + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function decodeJson(part) {
  try {
    return JSON.parse(new TextDecoder().decode(base64url(part)));
  } catch (err) {
    throw new HttpError(401, "Access token is malformed");
  }
}

async function keysFor(domain) {
  if (jwks.domain === domain && Date.now() - jwks.fetchedAt < JWKS_TTL_MS) return jwks.keys;
  const res = await fetch(`https://${domain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new HttpError(503, `Could not fetch Access signing keys (HTTP ${res.status})`);
  const data = await res.json();
  jwks = { domain, keys: data.keys || [], fetchedAt: Date.now() };
  return jwks.keys;
}

function tokenFrom(request) {
  const header = request.headers.get("cf-access-jwt-assertion");
  if (header) return header;
  const cookie = request.headers.get("cookie") || "";
  const m = cookie.match(/(?:^|;\s*)CF_Authorization=([^;]+)/);
  return m ? m[1] : null;
}

// Resolves to { email, mode } or throws an HttpError (401/403).
export async function verifyAccess(request, env) {
  if (!accessConfigured(env)) return { email: "local-dev", mode: "open" };
  const token = tokenFrom(request);
  if (!token) throw new HttpError(401, "Sign-in required (no Cloudflare Access token)");
  const parts = token.split(".");
  if (parts.length !== 3) throw new HttpError(401, "Access token is malformed");
  const header = decodeJson(parts[0]);
  const payload = decodeJson(parts[1]);
  if (header.alg !== "RS256") throw new HttpError(401, "Access token uses an unexpected algorithm");

  let keys = await keysFor(env.ACCESS_TEAM_DOMAIN);
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) {
    jwks.fetchedAt = 0; // key rotation: refresh once
    keys = await keysFor(env.ACCESS_TEAM_DOMAIN);
    jwk = keys.find((k) => k.kid === header.kid);
  }
  if (!jwk) throw new HttpError(401, "Access token was signed with an unknown key");

  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5", key, base64url(parts[2]), new TextEncoder().encode(parts[0] + "." + parts[1])
  );
  if (!ok) throw new HttpError(401, "Access token signature is invalid");

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp < now) throw new HttpError(401, "Access token has expired");
  if (payload.iss !== `https://${env.ACCESS_TEAM_DOMAIN}`) throw new HttpError(401, "Access token issuer mismatch");
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(env.ACCESS_AUD)) throw new HttpError(403, "Access token is for a different application");

  return { email: payload.email || payload.common_name || "unknown", mode: "access" };
}
