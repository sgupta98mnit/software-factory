import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Hono } from "hono";

const dataRoot = mkdtempSync(path.join(tmpdir(), "sf-auth-"));
process.env.SF_DATA_DIR = path.join(dataRoot, "audit");
process.env.SF_WORKSPACE = mkdtempSync(path.join(tmpdir(), "sf-auth-unused-"));
const { createAuth, authConfigFromEnv } = await import("../src/auth.js");
const { createOrchestrator } = await import("../src/autopilot/orchestrator.js");
const { createAutopilotRoutes } = await import("../src/autopilot/routes.js");
const { openLedger } = await import("../src/autopilot/ledger.js");
const { OpenHandsClient } = await import("../src/autopilot/openhands.js");
const { audit, listAudit } = await import("../src/audit.js");
const { startFakeIssuer } = await import("./fake-oidc.js");

const OPTIONS = [
  { id: "approve", label: "Approve" },
  { id: "revise", label: "Revise", needsNote: true },
  { id: "cancel", label: "Cancel run" },
];

async function setup(env: Record<string, string>) {
  const workspace = mkdtempSync(path.join(dataRoot, "ws-"));
  writeFileSync(path.join(workspace, "README.md"), "# Demo\n");
  const dataDir = mkdtempSync(path.join(dataRoot, "data-"));
  const ledger = openLedger(path.join(dataDir, "autopilot.db"));
  const o = createOrchestrator({ ledger, client: new OpenHandsClient({ baseUrl: "http://127.0.0.1:1" }), workspace, dataDir, graceMs: 0 });
  const auth = createAuth(authConfigFromEnv(env, "user:local"), ledger);
  // As index.ts mounts them: sign-in first, then the API.
  const app = new Hono().basePath("/sf-api");
  app.use("*", auth.middleware);
  app.route("/auth", auth.routes);
  app.route("/autopilot", createAutopilotRoutes(o));
  const call = async (method: string, pathname: string, cookie?: string, body?: unknown) => {
    const res = await app.request(`/sf-api${pathname}`, {
      method,
      headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, unknown> | null, headers: res.headers };
  };
  /** A run waiting for plan approval, to decide. */
  const planItem = () => {
    const run = ledger.createRun({ goal: "Approve me", change: `c-${Math.random().toString(16).slice(2, 8)}`, autonomy: "supervised", baseBranch: "main", integrationBranch: "main", integrationDir: workspace, createdBy: "user:someone", state: "awaiting_plan_approval" });
    return ledger.openInbox({ runId: run.id, kind: "plan_approval", title: "Approve the plan", body: "Plan", options: OPTIONS });
  };
  return {
    app,
    call,
    ledger,
    planItem,
    async close() {
      o.stop();
      await o.idle();
      ledger.close();
    },
  };
}

/** Walks the browser's sign-in: the factory sends it to the issuer, which sends it back with a code. */
async function signIn(t: Awaited<ReturnType<typeof setup>>) {
  const login = await t.app.request("/sf-api/auth/login?return=/autopilot");
  assert.equal(login.status, 302);
  const authorize = await fetch(login.headers.get("location")!, { redirect: "manual" });
  const back = new URL(authorize.headers.get("location")!);
  const callback = await t.app.request(`${back.pathname}${back.search}`);
  const cookie = callback.headers.get("set-cookie")?.split(";")[0];
  return { callback, cookie, path: `${back.pathname}${back.search}` };
}

test("OIDC: nothing without a session; an engineer starts work but can't approve; an approver can, recorded as the issuer's subject; signing out ends it", async () => {
  const idp = await startFakeIssuer({ clientId: "factory" });
  const t = await setup({ SF_AUTH: "oidc", SF_OIDC_ISSUER: idp.url, SF_OIDC_CLIENT_ID: "factory", SF_OIDC_ROLES_CLAIM: "groups", SF_OIDC_ROLE_MAP: JSON.stringify({ "factory-engineers": "engineer", "factory-approvers": "approver" }) });
  try {
    assert.equal((await t.call("GET", "/autopilot/runs")).status, 401);
    assert.deepEqual((await t.call("GET", "/auth/me")).json, { mode: "oidc", user: null });

    idp.as({ sub: "eng-7", name: "Erin Engineer", groups: ["factory-engineers", "unrelated-group"] });
    const engineer = await signIn(t);
    assert.equal(engineer.callback.status, 302);
    assert.equal(engineer.callback.headers.get("location"), "/autopilot");
    assert.match(engineer.callback.headers.get("set-cookie") ?? "", /HttpOnly.*SameSite=Strict|SameSite=Strict.*HttpOnly/i);
    assert.deepEqual((await t.call("GET", "/auth/me", engineer.cookie)).json?.user, { actor: `oidc:eng-7@${new URL(idp.url).host}`, name: "Erin Engineer", roles: ["engineer"] });
    assert.equal((await t.call("GET", "/autopilot/runs", engineer.cookie)).status, 200);
    const item = t.planItem();
    const refused = await t.call("POST", `/autopilot/inbox/${item.id}/decide`, engineer.cookie, { choice: "approve" });
    assert.equal(refused.status, 403);
    assert.match(String(refused.json?.error), /needs the approver role; Erin Engineer has engineer/);

    idp.as({ sub: "appr-3", name: "Ana Approver", groups: ["factory-approvers"] });
    const approver = await signIn(t);
    const decided = await t.call("POST", `/autopilot/inbox/${item.id}/decide`, approver.cookie, { choice: "approve" });
    assert.equal(decided.status, 200);
    assert.equal(decided.json?.decidedBy, `oidc:appr-3@${new URL(idp.url).host}`, "the actor is the issuer's subject, not the display name");
    await audit("test", "test.flush", "test");
    assert.ok(listAudit().some((e) => e.action === "auth.signed_in" && e.actor === `oidc:appr-3@${new URL(idp.url).host}`));
    assert.ok(!JSON.stringify(listAudit()).includes(approver.cookie!.split("=")[1]!), "the session id is never audited");

    assert.equal((await t.call("POST", "/auth/logout", approver.cookie, {})).status, 200);
    assert.equal((await t.call("GET", "/autopilot/runs", approver.cookie)).status, 401);
  } finally {
    await t.close();
    await idp.close();
  }
});

test("a forged, mis-addressed or replayed ID token is refused and makes no session; an expired session is gone", async () => {
  const idp = await startFakeIssuer({ clientId: "factory" });
  const t = await setup({ SF_AUTH: "oidc", SF_OIDC_ISSUER: idp.url, SF_OIDC_CLIENT_ID: "factory", SF_OIDC_ROLES_CLAIM: "groups" });
  try {
    idp.as({ sub: "x-1", name: "Mallory", groups: ["approver"] });
    idp.tamper.key = idp.otherKey;
    const forged = await signIn(t);
    assert.equal(forged.callback.status, 401);
    assert.match(String((await forged.callback.json()).error), /signature doesn't verify/);
    assert.equal(forged.cookie, undefined);

    idp.tamper.key = null;
    idp.tamper.audience = "another-app";
    assert.match(String(await (await signIn(t)).callback.text()), /for another client/);
    idp.tamper.audience = null;
    idp.tamper.nonce = "not-this-sign-in";
    assert.match(String(await (await signIn(t)).callback.text()), /nonce doesn't match/);

    idp.tamper.nonce = null;
    const good = await signIn(t);
    assert.equal(good.callback.status, 302);
    const replay = await t.app.request(good.path);
    assert.equal(replay.status, 400, "a callback works once");

    const { createHash } = await import("node:crypto");
    t.ledger.createSession({ idHash: createHash("sha256").update("old-session").digest("hex"), subject: "s", issuer: idp.url, name: "Old", roles: ["approver"], expiresAt: new Date(Date.now() - 1000).toISOString() });
    assert.equal((await t.call("GET", "/autopilot/runs", "sf_session=old-session")).status, 401);
  } finally {
    await t.close();
    await idp.close();
  }
});

test("local mode: this machine's user, with every role unless SF_LOCAL_ROLES narrows them", async () => {
  const t = await setup({ SF_LOCAL_ROLES: "engineer" });
  try {
    assert.deepEqual((await t.call("GET", "/auth/me")).json, { mode: "local", user: { actor: "user:local", name: "local", roles: ["engineer"] } });
    const item = t.planItem();
    assert.equal((await t.call("POST", `/autopilot/inbox/${item.id}/decide`, undefined, { choice: "approve" })).status, 403);
  } finally {
    await t.close();
  }
  const full = await setup({});
  try {
    const item = full.planItem();
    assert.equal((await full.call("POST", `/autopilot/inbox/${item.id}/decide`, undefined, { choice: "approve" })).status, 200);
  } finally {
    await full.close();
  }
});
