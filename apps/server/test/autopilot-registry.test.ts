import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const dataDir = mkdtempSync(path.join(tmpdir(), "sf-registry-data-"));
process.env.SF_DATA_DIR = dataDir;
process.env.SF_WORKSPACE = mkdtempSync(path.join(tmpdir(), "sf-registry-unused-"));
delete process.env.SF_AUTONOMY_CAP;
const { startFakeOpenHands } = await import("../src/demo/fake-agent-server.js");
const { scriptedAgents } = await import("../src/demo/scripted-agents.js");
const { createOrchestrator } = await import("../src/autopilot/orchestrator.js");
const { openLedger } = await import("../src/autopilot/ledger.js");
const { OpenHandsClient } = await import("../src/autopilot/openhands.js");
const { createRegistry, createRegistryRoutes } = await import("../src/autopilot/registry.js");
const { audit, listAudit } = await import("../src/audit.js");

const workspace = (name: string, policy?: string) => {
  const dir = mkdtempSync(path.join(tmpdir(), `sf-registry-${name}-`));
  writeFileSync(path.join(dir, "README.md"), `# ${name}\n`);
  if (policy) {
    mkdirSync(path.join(dir, ".factory"));
    writeFileSync(path.join(dir, ".factory", "policy.yml"), policy);
  }
  return dir;
};

test("the registry: workspaces of their own, each on its own policy and ledger; one Inbox across them; kept across restarts; removed only when idle", { timeout: 120_000 }, async () => {
  const fake = await startFakeOpenHands({ onMessage: scriptedAgents({ noBugs: true }) });
  const client = new OpenHandsClient({ baseUrl: fake.url });
  const defaultWs = workspace("default");
  const ledger = openLedger(path.join(dataDir, "autopilot.db"));
  const defaultOrchestrator = createOrchestrator({ ledger, client, workspace: defaultWs, dataDir, graceMs: 0 });
  const defaultEntry = { name: "benefits", path: defaultWs, addedBy: "SF_WORKSPACE", addedAt: new Date(0).toISOString() };
  let registry = createRegistry({ dataDir, client, defaultEntry, defaultOrchestrator });
  let app = createRegistryRoutes(registry, "user:admin");
  const call = async (method: string, url: string, body?: unknown) => {
    const res = await app.request(url, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }) });
    return { status: res.status, json: (await res.json()) as any };
  };
  const tickAll = async () => {
    for (const w of registry.all()) await w.orchestrator.tick();
    for (const w of registry.all()) await w.orchestrator.idle();
    await fake.settled();
  };
  try {
    // A second project, whose own policy only allows suggest.
    const claimsDir = workspace("claims", "autonomy: { default: suggest, max: suggest }\n");
    assert.match((await call("POST", "/workspaces", { name: "Claims", path: "relative/path" })).json.error, /must be absolute/);
    assert.match((await call("POST", "/workspaces", { name: "Claims", path: path.join(claimsDir, "nope") })).json.error, /isn't a folder/);
    assert.match((await call("POST", "/workspaces", { name: "Claims", path: dataDir })).json.error, /data folder/);
    assert.match((await call("POST", "/workspaces", { name: "Claims", path: defaultWs })).json.error, /already the workspace "benefits"/);
    assert.match((await call("POST", "/workspaces", { name: "!!!", path: claimsDir })).json.error, /Give the workspace a name/);
    const added = await call("POST", "/workspaces", { name: "Claims", path: claimsDir });
    assert.equal(added.status, 201);
    assert.equal(added.json.id, "claims");
    assert.match((await call("POST", "/workspaces", { name: "claims", path: workspace("other") })).json.error, /already a workspace called "claims"/);
    assert.deepEqual((await call("GET", "/workspaces")).json.map((w: { id: string; default: boolean }) => [w.id, w.default]), [["default", true], ["claims", false]]);
    assert.deepEqual(JSON.parse(readFileSync(path.join(dataDir, "workspaces.json"), "utf8")).map((e: { id: string }) => e.id), ["claims"]);

    // A run in each, through each one's own API.
    const a = await call("POST", "/w/default/autopilot/runs", { goal: "Let applicants check a claim's status", autonomy: "supervised" });
    const b = await call("POST", "/w/claims/autopilot/runs", { goal: "Let clerks export claims", autonomy: "autonomous" });
    assert.deepEqual([a.status, b.status], [200, 200]);
    assert.equal(b.json.autonomy, "suggest", "the claims workspace's own policy caps it");
    assert.equal(ledger.getRun(b.json.id), undefined, "its run is in its own ledger");
    assert.ok(existsSync(path.join(dataDir, "workspaces", "claims", "worktrees", b.json.id, "integration")));
    assert.equal((await call("GET", `/w/claims/autopilot/runs/${b.json.id}`)).json.id, b.json.id);
    assert.equal((await call("GET", `/w/default/autopilot/runs/${b.json.id}`)).status, 404);
    assert.equal((await call("GET", "/w/nowhere/autopilot/runs")).status, 404);

    for (let i = 0; i < 30 && (await call("GET", "/workspaces/inbox/count")).json.open < 2; i++) await tickAll();
    const inbox = (await call("GET", "/workspaces/inbox")).json as { id: number; kind: string; runId: string; workspace: { id: string; name: string } }[];
    assert.deepEqual(inbox.map((i) => [i.workspace.id, i.kind]).sort(), [["claims", "spec_approval"], ["default", "plan_approval"]]);
    const claimsItem = inbox.find((i) => i.workspace.id === "claims")!;
    const decided = await call("POST", `/w/claims/autopilot/inbox/${claimsItem.id}/decide`, { choice: "approve" });
    assert.equal(decided.status, 200);
    assert.equal((await call("GET", "/workspaces/inbox/count")).json.open, 2, "the suggest run asks again, for the plan");

    // A restart keeps the list.
    registry = createRegistry({ dataDir, client, defaultEntry, defaultOrchestrator });
    app = createRegistryRoutes(registry, "user:admin");
    assert.deepEqual((await call("GET", "/workspaces")).json.map((w: { id: string; activeRuns: number }) => [w.id, w.activeRuns]), [["default", 1], ["claims", 1]]);

    assert.match((await call("DELETE", "/workspaces/claims")).json.error, /1 run\(s\) that aren't finished/);
    assert.match((await call("DELETE", "/workspaces/default")).json.error, /can't be removed/);
    await call("POST", `/w/claims/autopilot/runs/${b.json.id}/cancel`, {});
    assert.deepEqual((await call("DELETE", "/workspaces/claims")).json, { ok: true });
    assert.deepEqual((await call("GET", "/workspaces")).json.map((w: { id: string }) => w.id), ["default"]);
    assert.ok(existsSync(path.join(dataDir, "workspaces", "claims", "autopilot.db")), "its data stays");
    await audit("test", "test.flush", "test");
    assert.deepEqual(listAudit(5000).filter((e) => e.action.startsWith("workspace.")).map((e) => [e.action, e.actor, e.subject]).reverse(), [
      ["workspace.registered", "user:admin", "workspace:claims"],
      ["workspace.removed", "user:admin", "workspace:claims"],
    ]);
  } finally {
    await registry.stop();
    await fake.close();
    ledger.close();
  }
});
