// Only this machine's browser may use the API, even through Canvas's proxies, which rewrite Host.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import { isLoopback, localOnly } from "../src/guard.js";

const app = new Hono().basePath("/sf-api");
app.use("*", localOnly());
app.get("/health", (c) => c.json({ ok: true }));
app.post("/autopilot/runs/:id/release", (c) => c.json({ released: true }));
app.post("/autopilot/intake/:source", (c) => c.json({ taken: true }));

const call = async (method: string, path: string, headers: Record<string, string>) => {
  const res = await app.request(`/sf-api${path}`, { method, headers, ...(method === "POST" ? { body: "{}" } : {}) });
  return { status: res.status, error: ((await res.json()) as { error?: string }).error };
};
// What Canvas's ingress and Vite deliver: Host rewritten to the API, the browser's Host in X-Forwarded-Host.
const proxied = (browserHost: string, more: Record<string, string> = {}) => ({ host: "127.0.0.1:4317", "x-forwarded-host": browserHost, ...more });
const json = { "content-type": "application/json" };

test("isLoopback: this machine by any of its names, nothing that only looks like it", () => {
  for (const yes of ["localhost", "localhost:8000", "127.0.0.1:4317", "[::1]:8000", "http://localhost:8000", "http://127.0.0.1:3001", "app.localhost:3000"]) assert.equal(isLoopback(yes), true, yes);
  for (const no of ["", "evil.example", "evil.example:8000", "http://evil.example:8000", "localhost.evil.example", "127.0.0.1.nip.io", "null", "192.168.1.5:8000"]) assert.equal(isLoopback(no), false, no);
});

test("reads: the browser's Host decides, through the proxies too, so a DNS-rebound page is refused", async () => {
  assert.equal((await call("GET", "/health", { host: "localhost:8000" })).status, 200);
  assert.equal((await call("GET", "/health", { host: "evil.example" })).status, 403);
  assert.equal((await call("GET", "/health", proxied("localhost:8000"))).status, 200);
  // Before: the proxies' rewritten Host (127.0.0.1:4317) let this through.
  assert.deepEqual(await call("GET", "/health", proxied("evil.example:8000")), { status: 403, error: "Forbidden host" });
});

test("changes: an Origin that isn't this machine is refused whatever Host says; curl and relays send none", async () => {
  // The rebound page's POST: Host rewritten to loopback, but the browser's Origin can't be forged.
  assert.deepEqual(await call("POST", "/autopilot/runs/ap-1/release", { host: "127.0.0.1:4317", origin: "http://evil.example:8000", ...json }), { status: 403, error: "Forbidden origin" });
  assert.equal((await call("POST", "/autopilot/runs/ap-1/release", { host: "127.0.0.1:4317", origin: "null", ...json })).status, 403);
  assert.equal((await call("POST", "/autopilot/runs/ap-1/release", proxied("localhost:8000", { origin: "http://localhost:8000", ...json }))).status, 200);
  assert.equal((await call("POST", "/autopilot/runs/ap-1/release", { host: "localhost:3001", origin: "http://127.0.0.1:3001", ...json })).status, 200);
  assert.equal((await call("POST", "/autopilot/runs/ap-1/release", { host: "127.0.0.1:4317", ...json })).status, 200, "no Origin: not a browser");
  assert.deepEqual(await call("POST", "/autopilot/runs/ap-1/release", { host: "127.0.0.1:4317", "content-type": "text/plain" }), { status: 415, error: "Send JSON" });
});

test("signed intake through a relay keeps working; the unsigned bug form doesn't get the relay's pass", async () => {
  const relay = { host: "127.0.0.1:4317", "x-forwarded-host": "hooks.agency.example", ...json };
  assert.equal((await call("POST", "/autopilot/intake/github", relay)).status, 200);
  assert.equal((await call("POST", "/autopilot/intake/webhook", relay)).status, 200);
  assert.equal((await call("POST", "/autopilot/intake/bug", relay)).status, 403);
  assert.equal((await call("POST", "/autopilot/intake/github", { ...relay, host: "evil.example" })).status, 403, "Host still has to be this machine");
});
