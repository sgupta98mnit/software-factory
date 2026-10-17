// Spec drift: the spec changing while a run builds, by a person's request or
// a work order a person let change it, and the re-plan that follows.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { FakeConversation, FakeHandler } from "./fake-openhands.js";

process.env.SF_DATA_DIR = mkdtempSync(path.join(tmpdir(), "sf-drift-data-"));
process.env.SF_WORKSPACE = mkdtempSync(path.join(tmpdir(), "sf-drift-unused-"));
process.env.SF_USER = "po";
delete process.env.SF_AUTONOMY_CAP;
const { startFakeOpenHands } = await import("../src/demo/fake-agent-server.js");
const { capabilityOf, scriptedAgents } = await import("../src/demo/scripted-agents.js");
const { createOrchestrator } = await import("../src/autopilot/orchestrator.js");
const { openLedger } = await import("../src/autopilot/ledger.js");
const { OpenHandsClient } = await import("../src/autopilot/openhands.js");
const { createAutopilotRoutes } = await import("../src/autopilot/routes.js");
const { fileAt } = await import("../src/autopilot/git.js");
const { diffPlan } = await import("../src/autopilot/waves.js");
const { audit, listAudit } = await import("../src/audit.js");

const write = (file: string, text: string) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};
const tasksOf = (conv: FakeConversation) => {
  const change = /`(let-[^`]+?)`/.exec(conv.messages[0] ?? "")?.[1] ?? "";
  return { change, file: path.join(conv.workingDir, "openspec", "changes", change, "tasks.md") };
};
/** WO-4, when a revision adds it: a module and its test of its own. */
const receipt = (conv: FakeConversation) => {
  const cap = capabilityOf(/openspec\/changes\/([^/`]+)\//.exec(conv.messages[0] ?? "")?.[1] ?? "x");
  write(path.join(conv.workingDir, `src/${cap}/receipt.js`), "export const receipt = (id) => `Receipt for ${id}`;\n");
  write(path.join(conv.workingDir, `src/${cap}/receipt.test.js`), 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { receipt } from "./receipt.js";\ntest("receipt", () => assert.equal(receipt("A1"), "Receipt for A1"));\n');
  return { response: "Built the receipt.", cost: 0.3 };
};

async function setup(handler: FakeHandler, policy?: string) {
  const workspace = mkdtempSync(path.join(tmpdir(), "sf-drift-ws-"));
  writeFileSync(path.join(workspace, "README.md"), "# Demo\n");
  if (policy) write(path.join(workspace, ".factory", "policy.yml"), policy);
  const fake = await startFakeOpenHands({ onMessage: handler });
  const ledger = openLedger(":memory:");
  const o = createOrchestrator({ ledger, client: new OpenHandsClient({ baseUrl: fake.url }), workspace, dataDir: mkdtempSync(path.join(tmpdir(), "sf-drift-run-")), graceMs: 0 });
  const app = createAutopilotRoutes(o);
  const t = {
    workspace,
    fake,
    ledger,
    o,
    app,
    decisions: { plan: true, merge: true, replan: true },
    async step() {
      for (const i of ledger.listInbox({})) {
        if (i.kind === "plan_approval" && t.decisions.plan) await o.decide(i.id, { choice: "approve" }, "user:po");
        if (i.kind === "merge_approval" && t.decisions.merge) await o.decide(i.id, { choice: "merge" }, "user:po");
        if (i.kind === "replan_approval" && t.decisions.replan) await o.decide(i.id, { choice: "replan" }, "user:po");
      }
      await o.tick();
      await o.idle();
      await fake.settled();
    },
    async until(done: () => boolean, max = 150) {
      for (let i = 0; i < max && !done(); i++) await t.step();
      assert.ok(done(), "the run didn't get there");
    },
    wo: (runId: string, seq: number) => ledger.getWorkOrder(`${runId}/WO-${seq}`),
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

test("diffPlan matches work orders to task groups by number", () => {
  const wo = (seq: number, title: string, acceptance = ["a"], dependsOn: number[] = []) => ({ seq, title, acceptance, dependsOn });
  const next = (seq: number, title: string, acceptance = ["a"], dependsOn: number[] = []) => ({ seq, title, acceptance, dependsOn, controls: [], wave: 1, risk: "low" as const });
  const d = diffPlan([wo(1, "One"), wo(2, "Two"), wo(3, "Three", ["a"], [1])], [next(1, "One"), next(2, "Two", ["a", "b"]), next(3, "Three", ["a"], [2]), next(4, "Four")]);
  assert.deepEqual(d.unchanged.map((c) => c.wo.seq), [1]);
  assert.deepEqual(d.changed.map((c) => c.wo.seq), [2, 3]);
  assert.deepEqual(d.added.map((n) => n.seq), [4]);
  assert.deepEqual(diffPlan([wo(1, "One"), wo(2, "Two")], [next(1, "One")]).removed.map((w) => w.seq), [2]);
});

test("a person changes the spec while building: a spec agent revises it in its own worktree, it's merged, and the re-plan (approved) reopens a merged work order and adds one", async () => {
  const scripted = scriptedAgents({ noBugs: true });
  const t = await setup(async (conv, text) => {
    const role = conv.tags.sfrole;
    if (role === "spec" && conv.messages[0]?.includes("<change-request>")) {
      // The revision: group 1 gets a criterion, and a new group 4 depends on it.
      const { file } = tasksOf(conv);
      const tasks = readFileSync(file, "utf8")
        .replace("- [ ] 1.2 Test it with node:test", "- [ ] 1.2 Test it with node:test\n- [ ] 1.3 Return a receipt id with the result")
        .concat("\n## 4. Receipts\n\nDepends on: 1\n\n- [ ] 4.1 Add `receipt(id)` returning a printable receipt\n");
      writeFileSync(file, tasks);
      return { response: "Added receipts to the spec.", cost: 0.2 };
    }
    if (role === "builder" && conv.tags.sfwo === "4") return receipt(conv);
    if (role === "builder" && conv.tags.sfwo === "1" && conv.messages[0]?.includes("The spec changed for this work order after it was merged")) {
      const cap = capabilityOf(/openspec\/changes\/([^/`]+)\//.exec(conv.messages[0] ?? "")?.[1] ?? "x");
      write(path.join(conv.workingDir, `src/${cap}/receipt-id.js`), "export const receiptId = (n) => `R-${n}`;\n");
      return { response: "Added the receipt id.", cost: 0.2 };
    }
    return scripted(conv, text);
  });
  try {
    const run = await t.o.createRun({ goal: "Let applicants check a claim's status", autonomy: "supervised", actor: "user:po" });
    await t.until(() => t.wo(run.id, 1)?.state === "merged");
    t.decisions.replan = false;
    // The Pipeline's Change the spec.
    const res = await t.app.request(`/runs/${run.id}/revise`, { method: "POST", body: JSON.stringify({ note: "Also give applicants a receipt they can print." }), headers: { "content-type": "application/json" } });
    assert.equal(res.status, 200);
    const revising = (await res.json()) as { revision: { stage: string; note: string } };
    assert.deepEqual(revising.revision && [revising.revision.stage, revising.revision.note], ["writing", "Also give applicants a receipt they can print."]);
    const spec = t.ledger.listAttempts({ runId: run.id, role: "spec" }).at(-1)!;
    assert.match(t.fake.conversations.get(spec.conversationId)!.workingDir, /[\\/]spec$/, "the revision has its own worktree");

    await t.until(() => t.ledger.listInbox({ runId: run.id }).some((i) => i.kind === "replan_approval"));
    const item = t.ledger.listInbox({ runId: run.id }).find((i) => i.kind === "replan_approval")!;
    assert.match(item.body, /\*\*Added\*\* WO-4: Receipts/);
    assert.match(item.body, /\*\*Changed\*\* WO-1: Core behavior \(already merged; it's reopened and a fresh builder updates it\)/);
    assert.equal(t.wo(run.id, 4), undefined, "nothing changes before a person decides");
    assert.match((await fileAt(t.workspace, run.integrationBranch, `openspec/changes/${run.change}/tasks.md`)) ?? "", /## 4\. Receipts/);
    assert.equal(existsSync(path.join(path.dirname(t.ledger.getRun(run.id)!.integrationDir!), "spec")), false, "the revision worktree is gone");
    assert.deepEqual((await auditOf(run.id, "autopilot.spec_revised")).map((e) => e.data.requestedBy), ["user:po"]);

    assert.equal(t.ledger.getRun(run.id)?.state, "building", "a run doesn't finish while a new plan waits");
    t.decisions.replan = true;
    await t.until(() => t.ledger.getRun(run.id)?.state === "done", 200);
    const [replanned] = await auditOf(run.id, "autopilot.replanned");
    assert.deepEqual([replanned?.actor, replanned?.data.added, replanned?.data.changed, replanned?.data.reopened], ["user:po", ["WO-4"], ["WO-1"], ["WO-1"]]);
    assert.deepEqual(t.ledger.listWorkOrders(run.id).map((w) => `${w.seq}:${w.state}`), ["1:merged", "2:merged", "3:merged", "4:merged"]);
    assert.deepEqual(t.wo(run.id, 1)?.acceptance.at(-1), "Return a receipt id with the result");
    assert.equal(t.ledger.listAttempts({ runId: run.id, workOrderId: `${run.id}/WO-1`, role: "builder" }).length, 2);
    assert.notEqual(await fileAt(t.workspace, run.integrationBranch, `src/${capabilityOf(run.change)}/receipt.js`), null);
  } finally {
    await t.close();
  }
});

test("a work order that changes the spec needs a person's merge; merged, an autonomous run re-plans by itself", async () => {
  const scripted = scriptedAgents({ noBugs: true });
  const t = await setup(async (conv, text) => {
    const role = conv.tags.sfrole;
    if (role === "builder" && conv.tags.sfwo === "2" && conv.messages.length === 1) {
      const reply = await scripted(conv, text);
      // While it's there, the builder "adjusts" the spec: a new task group.
      const change = /openspec\/changes\/([^/`]+)\//.exec(conv.messages[0] ?? "")?.[1] ?? "";
      const file = path.join(conv.workingDir, "openspec", "changes", change, "tasks.md");
      writeFileSync(file, `${readFileSync(file, "utf8")}\n## 4. Receipts\n\nDepends on: 1\n\n- [ ] 4.1 Add \`receipt(id)\`\n`);
      return reply;
    }
    if (role === "builder" && conv.tags.sfwo === "4") return receipt(conv);
    return scripted(conv, text);
  });
  t.decisions.merge = false;
  try {
    const run = await t.o.createRun({ goal: "Let applicants check a claim's status", autonomy: "autonomous", actor: "user:po" });
    await t.until(() => t.ledger.listInbox({ runId: run.id }).some((i) => i.kind === "merge_approval" && i.workOrderId === `${run.id}/WO-2`));
    const item = t.ledger.listInbox({ runId: run.id }).find((i) => i.workOrderId === `${run.id}/WO-2`)!;
    assert.match(item.body, /Changes the spec \(openspec\/changes\/[^)]+\/tasks\.md\)\. Only a person lets a work order change what it's measured against; merging it re-plans the run\./);
    t.decisions.merge = true;
    await t.until(() => t.ledger.getRun(run.id)?.state === "done", 200);
    const [replanned] = await auditOf(run.id, "autopilot.replanned");
    assert.deepEqual([replanned?.actor, replanned?.data.added], [`policy@${run.policyHash}`, ["WO-4"]]);
    assert.equal(t.ledger.listInbox({ state: "all", runId: run.id }).filter((i) => i.kind === "replan_approval").length, 0);
    assert.equal(t.wo(run.id, 4)?.state, "merged");
  } finally {
    await t.close();
  }
});

test("a spec change that stops twice waits for a person; Drop leaves the spec and plan as they were and building goes on", async () => {
  const scripted = scriptedAgents({ noBugs: true });
  const t = await setup(async (conv, text) => {
    if (conv.tags.sfrole === "spec" && conv.messages[0]?.includes("<change-request>")) return { response: "Crashed.", status: "error" as const };
    return scripted(conv, text);
  });
  try {
    const run = await t.o.createRun({ goal: "Let applicants check a claim's status", autonomy: "supervised", actor: "user:po" });
    await t.until(() => t.ledger.getRun(run.id)?.state === "building");
    await assert.rejects(t.o.reviseSpec(run.id, "  ", "user:po"), /Say what should change/);
    await t.o.reviseSpec(run.id, "Make the status page bilingual.", "user:po");
    await assert.rejects(t.o.reviseSpec(run.id, "And another thing.", "user:po"), /already under way/);
    await t.until(() => t.ledger.listInbox({ runId: run.id }).some((i) => i.kind === "spec_revision"));
    const item = t.ledger.listInbox({ runId: run.id }).find((i) => i.kind === "spec_revision")!;
    assert.match(item.body, /po asked for this change to the spec:\n\n> Make the status page bilingual\./);
    assert.equal((await auditOf(run.id, "autopilot.agent_restarted")).filter((e) => e.data.role === "spec").length, 1);
    await t.o.decide(item.id, { choice: "drop" }, "user:po");
    assert.equal(t.ledger.getRun(run.id)?.revision, null);
    await t.until(() => t.ledger.getRun(run.id)?.state === "done", 200);
    assert.deepEqual(await auditOf(run.id, "autopilot.replanned"), []);
  } finally {
    await t.close();
  }
});
