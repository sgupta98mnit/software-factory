// Only this machine's browser may use the API. The API binds 127.0.0.1, but
// the browser reaches it through Canvas's ingress and Vite, and both rewrite
// Host on the way (changeOrigin), so a DNS-rebound page (evil.example resolving
// to 127.0.0.1) would arrive here as "127.0.0.1:4317". So:
//
// - Changes: a browser always sends Origin on a POST, and a page can't forge
//   it. An Origin that isn't this machine is refused, whatever Host says.
//   Clients that aren't browsers (curl, a webhook relay) send none.
// - Reads: the Host the browser used, from X-Forwarded-Host when a proxy set
//   it, must be this machine. A page can set that header itself, so this stops
//   ordinary rebinding, not a page written for this API: sign-in closes that.
// - Changes are JSON only (a cross-site form can't send it without CORS).
//
// GitHub and webhook intake prove themselves with a signature and come through
// a relay, which may name its own public host in X-Forwarded-Host: for them the
// Host check stays as it always was.
import type { MiddlewareHandler } from "hono";

const SIGNED = /\/autopilot\/intake\/(github|webhook)\/?$/;

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

/** "localhost:8000", "[::1]:8000" or "http://127.0.0.1:3001" -> is it this machine? */
export function isLoopback(hostOrUrl: string): boolean {
  const value = hostOrUrl.trim();
  if (!value) return false;
  try {
    const hostname = new URL(value.includes("://") ? value : `http://${value}`).hostname.replace(/^\[|\]$/g, "");
    return LOOPBACK.has(hostname) || hostname.endsWith(".localhost");
  } catch {
    return false;
  }
}

export function localOnly(): MiddlewareHandler {
  return async (c, next) => {
    const forwarded = SIGNED.test(c.req.path) ? undefined : c.req.header("x-forwarded-host")?.split(",")[0];
    if (!isLoopback(forwarded ?? c.req.header("host") ?? "")) return c.json({ error: "Forbidden host" }, 403);
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      const origin = c.req.header("origin");
      if (origin !== undefined && !isLoopback(origin)) return c.json({ error: "Forbidden origin" }, 403);
      if (!(c.req.header("content-type") ?? "").includes("application/json")) return c.json({ error: "Send JSON" }, 415);
    }
    await next();
  };
}
