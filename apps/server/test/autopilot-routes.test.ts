import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { startFakeOpenHands } from "./fake-openhands.js";

// Audit log and worktrees in a temp folder, a known user, before config is read.
const dataDir = mkdtempSync(path.join(tmpdir(), "sf-routes-data-"));
process.env.SF_DATA_DIR = dataDir;
process.env.SF_WORKSPACE = mkdtempSync(path.join(tmpdir(), "sf-routes-unused-"));
process.env.SF_USER = "tester";
delete process.env.SF_AUTONOMY_CAP;
const { createAutopilotRoutes } = await import("../src/autopilot/routes.js");
const { createOrchestrator } = await import("../src/autopilot/orchestrator.js");
const { openLedger } = await import("../src/autopilot/ledger.js");
const { OpenHandsClient } = await import("../src/autopilot/openhands.js");
const { branchExists } = await import("../src/autopilot/git.js");
const { DEFAULT_POLICY, policyHash } = await import("../src/autopilot/policy.js");

type Json = Record<string, any>;

const APPROVAL = [
  { id: "approve", label: "Approve", tone: "primary" as const },
  { id: "revise", label: "Ask for changes", needsNote: true },
  { id: "cancel", label: "Cancel run", tone: "danger" as const },
];

async function withApp(fn: (t: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const t = await setup();
  try {
    await fn(t);
  } finally {
    await t.o.idle();
    await t.fake.close();
    t.ledger.close();
  }
}

async function setup(agentServerUrl?: string) {
  const workspace = mkdtempSync(path.join(tmpdir(), "sf-routes-ws-"));
  writeFileSync(path.join(workspace, "README.md"), "# Demo\n");
  const fake = await startFakeOpenHands();
  const ledger = openLedger(":memory:");
  const client = new OpenHandsClient({ baseUrl: agentServerUrl ?? fake.url, timeoutMs: 2000 });
  const o = createOrchestrator({ ledger, client, workspace, dataDir: mkdtempSync(path.join(dataDir, "case-")), graceMs: 0 });
  const app = createAutopilotRoutes(o);
  async function call(method: "GET" | "POST", url: string, body?: unknown): Promise<{ status: number; json: Json }> {
    const res = await app.request(url, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as Json };
  }
  return { workspace, fake, ledger, o, call };
}

test("POST /runs checks the goal, autonomy and budget; GET /runs and /runs/:id show the run", () =>
  withApp(async ({ call }) => {
    const bad: [unknown, RegExp][] = [
      [{}, /goal/],
      [{ goal: "   " }, /goal/],
      [{ goal: "x".repeat(4001) }, /goal/],
      [{ goal: 42 }, /goal/],
      [{ goal: "Add a status page", autonomy: "yolo" }, /Autonomy must be one of: suggest, supervised, autonomous/],
      [{ goal: "Add a status page", budgetUsd: -1 }, /budget/],
      [{ goal: "Add a status page", budgetUsd: "5" }, /budget/],
    ];
    for (const [body, error] of bad) {
      const r = await call("POST", "/runs", body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.match(r.json.error, error);
    }

    const created = await call("POST", "/runs", { goal: "  Add a status page  ", budgetUsd: 12.5 });
    assert.equal(created.status, 200);
    const run = created.json;
    assert.match(run.id, /^ap-[0-9a-f]{8}$/);
    assert.deepEqual(run, {
      id: run.id,
      goal: "Add a status page",
      change: "add-a-status-page",
      autonomy: "supervised",
      state: "spec",
      pausedReason: null,
      baseBranch: "main",
      integrationBranch: "autopilot/add-a-status-page",
      costUsd: 0,
      budgetUsd: 12.5,
      budgetSource: "run",
      policyHash: policyHash(DEFAULT_POLICY), // no policy.yml: the defaults, pinned
      releasedBy: null,
      releasedSha: null,
      releasedAt: null,
      createdBy: "user:tester",
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      counts: { total: 0, merged: 0, active: 0, failed: 0, pending: 0 },
      openInbox: 0,
    });

    // The org-wide cap clamps autonomy; the same goal gets the next free name.
    process.env.SF_AUTONOMY_CAP = "supervised";
    let capped: Json;
    try {
      capped = (await call("POST", "/runs", { goal: "Add a status page", autonomy: "autonomous" })).json;
    } finally {
      delete process.env.SF_AUTONOMY_CAP;
    }
    assert.equal(capped.autonomy, "supervised");
    assert.equal(capped.change, "add-a-status-page-2");

    const list = await call("GET", "/runs");
    assert.deepEqual(list.json.map((r: Json) => r.id), [capped.id, run.id]);

    const detail = (await call("GET", `/runs/${run.id}`)).json;
    assert.deepEqual(Object.keys(detail).sort(), [...Object.keys(run), "workOrders", "attempts", "checks", "inbox", "hiddenTests", "etaMs", "projectedCostUsd"].sort());
    assert.deepEqual([detail.workOrders, detail.attempts, detail.checks, detail.inbox, detail.hiddenTests, detail.etaMs, detail.projectedCostUsd], [[], [], [], [], [], null, null]);
    assert.equal((await call("GET", "/runs/ap-00000000")).status, 404);
  }));

test("two POST /runs at once (a double-click) both succeed with their own change names", () =>
  withApp(async ({ call }) => {
    const [a, b] = await Promise.all([call("POST", "/runs", { goal: "Add a status page" }), call("POST", "/runs", { goal: "Add a status page" })]);
    assert.deepEqual([a.status, b.status], [200, 200], JSON.stringify([a.json, b.json]));
    assert.deepEqual([a.json.change, b.json.change].sort(), ["add-a-status-page", "add-a-status-page-2"]);
  }));

test("costs are summed from attempts and rounded to a tenth of a cent, for the run, its work orders and each attempt", () =>
  withApp(async ({ call, ledger }) => {
    const run = (await call("POST", "/runs", { goal: "Add a status page" })).json;
    const [wo] = ledger.addWorkOrders(run.id, [{ seq: 1, title: "Page", acceptance: ["It shows"], controls: [], dependsOn: [], wave: 1, risk: "low" }]);
    ledger.addAttempt({ runId: run.id, workOrderId: wo!.id, role: "builder", conversationId: "c1", costUsd: 0.1 });
    ledger.addAttempt({ runId: run.id, workOrderId: wo!.id, role: "reviewer", conversationId: "c2", costUsd: 0.2 });
    ledger.addAttempt({ runId: run.id, role: "spec", conversationId: "c3", costUsd: 1 / 3 });
    const detail = (await call("GET", `/runs/${run.id}`)).json;
    assert.equal(detail.costUsd, 0.633);
    assert.equal(detail.workOrders[0].costUsd, 0.3); // 0.1 + 0.2 is 0.30000000000000004 in floats
    assert.deepEqual(detail.attempts.map((a: Json) => a.costUsd), [0.1, 0.2, 0.333]);
  }));

test("POST /inbox/:id/decide takes only the item's choices, needs a note where asked, and decides once", () =>
  withApp(async ({ call, ledger }) => {
    const run = (await call("POST", "/runs", { goal: "Add a status page" })).json;
    ledger.updateRun(run.id, { state: "awaiting_plan_approval" });
    const item = ledger.openInbox({ runId: run.id, kind: "plan_approval", title: "Approve the plan", body: "The plan.", options: APPROVAL });

    assert.equal((await call("POST", "/inbox/999/decide", { choice: "approve" })).status, 404);
    assert.equal((await call("POST", "/inbox/abc/decide", { choice: "approve" })).status, 404);
    const decide = (body: unknown) => call("POST", `/inbox/${item.id}/decide`, body);
    let r = await decide({});
    assert.equal(r.status, 400);
    assert.match(r.json.error, /choice/);
    r = await decide({ choice: "maybe" });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /Choose one of: approve, revise, cancel/);
    r = await decide({ choice: "revise", note: "  " });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /needs a note/);
    r = await decide({ choice: "approve", note: 7 });
    assert.equal(r.status, 400);

    assert.deepEqual((await call("GET", "/inbox/count")).json, { open: 1 });
    const open = (await call("GET", "/inbox")).json;
    assert.equal(open.length, 1);
    assert.equal("notifiedAt" in open[0], false);
    assert.deepEqual([open[0].change, open[0].workOrderKey], [run.change, null]); // where it belongs, for the Inbox page
    assert.equal((await call("GET", `/runs/${run.id}`)).json.openInbox, 1);

    r = await decide({ choice: "approve", note: " Looks right " });
    assert.equal(r.status, 200);
    assert.equal(r.json.state, "decided");
    assert.equal(r.json.decision, "approve");
    assert.equal(r.json.note, "Looks right");
    assert.equal(r.json.decidedBy, "user:tester");
    assert.equal(ledger.getRun(run.id)?.state, "building");

    r = await decide({ choice: "approve" });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /already decided/);
    assert.deepEqual((await call("GET", "/inbox")).json, []);
    assert.equal((await call("GET", "/inbox?state=decided")).json.length, 1);
    assert.equal((await call("GET", "/inbox?state=all")).json.length, 1);
    assert.deepEqual((await call("GET", "/inbox/count")).json, { open: 0 });
  }));

test("pause, resume and cancel a run; cancel removes the integration worktree and keeps the branch", () =>
  withApp(async ({ call, ledger, workspace }) => {
    const run = (await call("POST", "/runs", { goal: "Add a status page" })).json;
    const dir = ledger.getRun(run.id)?.integrationDir ?? "";
    assert.ok(existsSync(dir));
    const post = (action: string, body: unknown = {}) => call("POST", `/runs/${run.id}/${action}`, body);

    let r = await post("resume");
    assert.equal(r.status, 400);
    assert.match(r.json.error, /isn't paused/);
    r = await post("pause", { note: "Back after lunch" });
    assert.equal(r.status, 200);
    assert.equal(r.json.state, "paused");
    assert.equal(r.json.pausedReason, "Back after lunch");
    assert.equal((await post("pause")).status, 400);

    // While paused, decisions wait (cancel excepted).
    const item = ledger.openInbox({
      runId: run.id,
      kind: "spec_failed",
      title: "The spec agent couldn't finish",
      body: "...",
      options: [{ id: "retry", label: "Retry" }, { id: "cancel", label: "Cancel run" }],
    });
    r = await call("POST", `/inbox/${item.id}/decide`, { choice: "retry" });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /paused/);

    r = await post("resume");
    assert.equal(r.status, 200);
    assert.equal(r.json.state, "spec");
    assert.equal(r.json.pausedReason, null);

    r = await post("cancel", { note: "Not needed after all" });
    assert.equal(r.status, 200);
    assert.equal(r.json.state, "cancelled");
    assert.equal(existsSync(dir), false);
    assert.equal(await branchExists(workspace, run.integrationBranch), true);
    assert.equal(ledger.getInbox(item.id)?.state, "dismissed");
    assert.equal((await post("cancel")).status, 400);
    assert.equal((await post("pause")).status, 400);
    assert.equal((await call("POST", "/runs/ap-00000000/pause", {})).status, 404);
  }));

test("GET /status reports the agent server, the workspace and the counts", async () => {
  await withApp(async ({ call, fake, workspace }) => {
    let s = (await call("GET", "/status")).json;
    assert.deepEqual(s, {
      agentServer: {
        url: fake.url,
        reachable: true,
        error: null,
        profiles: [{ id: "00000000-0000-4000-8000-000000000001", name: "default", kind: "acp", server: "claude-code" }],
        activeProfileId: "00000000-0000-4000-8000-000000000001",
      },
      workspace: { path: workspace, isRepo: false, branch: null },
      policy: { source: "defaults", hash: policyHash(DEFAULT_POLICY), error: null, autonomy: { default: "supervised", max: "autonomous" }, budget: { perWorkOrderUsd: 5, perChangeUsd: 30 } },
      notifications: { channel: null, digestHour: 17 },
      openInbox: 0,
      activeRuns: 0,
    });
    await call("POST", "/runs", { goal: "Add a status page" });
    s = (await call("GET", "/status")).json;
    assert.deepEqual(s.workspace, { path: workspace, isRepo: true, branch: "main" });
    assert.equal(s.activeRuns, 1);
    // The org-wide cap lowers what Home offers, and what it preselects.
    process.env.SF_AUTONOMY_CAP = "suggest";
    try {
      assert.deepEqual((await call("GET", "/status")).json.policy.autonomy, { default: "suggest", max: "suggest" });
    } finally {
      delete process.env.SF_AUTONOMY_CAP;
    }
  });

  // Nothing listens on port 9: the status says so instead of failing.
  const down = await setup("http://127.0.0.1:9");
  try {
    const s = (await down.call("GET", "/status")).json;
    assert.equal(s.agentServer.reachable, false);
    assert.match(s.agentServer.error, /unreachable/);
    assert.deepEqual(s.agentServer.profiles, []);
  } finally {
    await down.fake.close();
    down.ledger.close();
  }
});
