import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.SF_DATA_DIR = mkdtempSync(path.join(tmpdir(), "sf-budget-data-"));
process.env.SF_WORKSPACE = mkdtempSync(path.join(tmpdir(), "sf-budget-unused-"));
delete process.env.SF_AUTONOMY_CAP;
const { startFakeOpenHands } = await import("../src/demo/fake-agent-server.js");
const { scriptedAgents } = await import("../src/demo/scripted-agents.js");
const { createOrchestrator } = await import("../src/autopilot/orchestrator.js");
const { openLedger } = await import("../src/autopilot/ledger.js");
const { OpenHandsClient } = await import("../src/autopilot/openhands.js");
const { createAutopilotRoutes } = await import("../src/autopilot/routes.js");
const { audit, listAudit } = await import("../src/audit.js");

async function setup(policy?: string) {
  const workspace = mkdtempSync(path.join(tmpdir(), "sf-budget-ws-"));
  writeFileSync(path.join(workspace, "README.md"), "# Demo\n");
  if (policy) {
    mkdirSync(path.join(workspace, ".factory"));
    writeFileSync(path.join(workspace, ".factory", "policy.yml"), policy);
  }
  const fake = await startFakeOpenHands({ onMessage: scriptedAgents({ noBugs: true }) });
  const ledger = openLedger(":memory:");
  const o = createOrchestrator({ ledger, client: new OpenHandsClient({ baseUrl: fake.url }), workspace, dataDir: mkdtempSync(path.join(tmpdir(), "sf-budget-run-")), graceMs: 0 });
  const t = {
    fake,
    ledger,
    o,
    async until(done: () => boolean) {
      for (let i = 0; i < 80 && !done(); i++) {
        await o.tick();
        await o.idle();
        await fake.settled();
      }
      assert.ok(done(), "the run didn't get there");
    },
    item: (runId: string, kind: string) => ledger.listInbox({ runId }).find((i) => i.kind === kind),
    async close() {
      o.stop();
      await o.idle();
      await fake.close();
      ledger.close();
    },
  };
  return t;
}

const auditOf = async (runId: string, action: string) => {
  await audit("test", "test.flush", "test");
  return listAudit(5000).filter((e) => e.subject === runId && e.action === action).reverse();
};

test("the change's budget pauses the run and its agents; Resume alone won't go past it, raising it does", async () => {
  const t = await setup();
  try {
    // The spec agent spends 0.42 and the critic 0.08: the critic takes it over 0.45.
    const run = await t.o.createRun({ goal: "Let applicants check a claim's status", budgetUsd: 0.45, actor: "user:test" });
    await t.until(() => t.ledger.getRun(run.id)?.state === "paused");
    const item = t.item(run.id, "budget_reached")!;
    assert.equal(item.workOrderId, null);
    assert.deepEqual(item.options.map((o) => [o.id, o.label]), [["raise_half", "Add $0.23 and go on"], ["raise_double", "Add $0.45 and go on"], ["cancel", "Cancel run"]]);
    assert.match(item.body, /spent \$0\.50, and the budget for this change is \$0\.45\./);
    await assert.rejects(t.o.resume(run.id, { actor: "user:test" }), /reached its budget\. Raise it in the Inbox/);

    await t.o.decide(item.id, { choice: "raise_half" }, "user:test");
    assert.equal(t.ledger.getRun(run.id)?.budgetUsd, 0.68);
    await t.until(() => !!t.item(run.id, "plan_approval"));
    assert.deepEqual((await auditOf(run.id, "autopilot.budget_reached")).map((e) => [e.data.scope, e.data.budgetUsd]), [["change", 0.45]]);
    assert.deepEqual((await auditOf(run.id, "autopilot.budget_raised")).map((e) => [e.actor, e.data.from, e.data.to]), [["user:test", 0.45, 0.68]]);
  } finally {
    await t.close();
  }
});

test("a work order's budget pauses only that work order; given more, it goes on from where it stopped", async () => {
  // Builders spend 0.35 a turn; the policy allows 0.30 per work order.
  const t = await setup("budget: { perWorkOrderUsd: 0.3 }\n");
  try {
    const run = await t.o.createRun({ goal: "Let applicants check a claim's status", autonomy: "autonomous", actor: "user:test" });
    await t.until(() => t.ledger.listInbox({ runId: run.id }).filter((i) => i.kind === "budget_reached").length >= 2);
    assert.equal(t.ledger.getRun(run.id)?.state, "building"); // the run goes on
    const items = t.ledger.listInbox({ runId: run.id }).filter((i) => i.kind === "budget_reached");
    assert.ok(items.every((i) => i.workOrderId));
    assert.deepEqual(items[0]!.options.map((o) => o.id), ["raise", "skip", "cancel"]);

    // Detail: each work order's budget, and the change's (the policy's default).
    const detail = (await (await createAutopilotRoutes(t.o).request(`/runs/${run.id}`)).json()) as { budgetUsd: number; budgetSource: string; workOrders: { budgetUsd: number }[] };
    assert.deepEqual([detail.budgetUsd, detail.budgetSource], [30, "policy"]);
    assert.ok(detail.workOrders.every((w) => w.budgetUsd === 0.3));

    for (const item of items) await t.o.decide(item.id, { choice: "raise" }, "user:test");
    const raised = t.ledger.getWorkOrder(items[0]!.workOrderId!)!;
    assert.equal(raised.budgetExtraUsd, 0.3);
    assert.notEqual(raised.state, "needs_attention");
    // WO-3 touches src/auth: a person merges it. Everything else goes on by itself.
    await t.until(() => {
      for (const i of t.ledger.listInbox({ runId: run.id })) {
        if (i.kind === "merge_approval") void t.o.decide(i.id, { choice: "merge" }, "user:test");
        if (i.kind === "budget_reached") void t.o.decide(i.id, { choice: "raise" }, "user:test");
      }
      return t.ledger.getRun(run.id)?.state === "done";
    });
  } finally {
    await t.close();
  }
});

test("the projected cost: spent so far plus the merged average for each work order left", async () => {
  const t = await setup();
  try {
    const run = await t.o.createRun({ goal: "Add a page", actor: "user:test" });
    t.ledger.addWorkOrders(run.id, [1, 2, 3].map((seq) => ({ seq, title: `T${seq}`, acceptance: ["x"], controls: [], dependsOn: [], wave: 1, risk: "low" as const, state: (seq === 1 ? "merged" : "pending") as "pending" })));
    t.ledger.updateRun(run.id, { state: "building" });
    t.ledger.addAttempt({ runId: run.id, workOrderId: `${run.id}/WO-1`, role: "builder", conversationId: "c1", costUsd: 1 });
    t.ledger.addAttempt({ runId: run.id, workOrderId: `${run.id}/WO-2`, role: "builder", conversationId: "c2", costUsd: 0.4 });
    const detail = (await (await createAutopilotRoutes(t.o).request(`/runs/${run.id}`)).json()) as { projectedCostUsd: number | null };
    assert.equal(detail.projectedCostUsd, 1 + 0.4 + (2 * 1 - 0.4)); // 3.0
  } finally {
    await t.close();
  }
});
