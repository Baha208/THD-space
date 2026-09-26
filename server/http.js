/* ===== THD Space server — HTTP helpers for the Pages Functions ===== */

export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers }
  });
}

export function text(body, status = 200, headers = {}) {
  return new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", ...headers } });
}

// Wraps a handler so a thrown HttpError becomes a JSON error response with its status, and
// anything else a 500 that still says what happened (never a blank failure).
export function handle(fn) {
  return async (context) => {
    try {
      return await fn(context);
    } catch (err) {
      if (err instanceof HttpError) {
        return json({ error: err.message, details: err.details || undefined }, err.status);
      }
      console.error(err);
      return json({ error: "Server error: " + (err && err.message ? err.message : String(err)) }, 500);
    }
  };
}

export async function readJsonBody(request) {
  let body;
  try {
    body = await request.json();
  } catch (err) {
    throw new HttpError(400, "Request body is not valid JSON");
  }
  if (!body || typeof body !== "object") throw new HttpError(400, "Request body must be a JSON object");
  return body;
}

export function methodNotAllowed(allowed) {
  return json({ error: "Method not allowed" }, 405, { allow: allowed.join(", ") });
}
