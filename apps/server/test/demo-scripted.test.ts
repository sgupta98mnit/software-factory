import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const dataDir = mkdtempSync(path.join(tmpdir(), "sf-demo-data-"));
process.env.SF_DATA_DIR = dataDir;
process.env.SF_WORKSPACE = mkdtempSync(path.join(tmpdir(), "sf-demo-unused-"));
delete process.env.SF_AUTONOMY_CAP;
const { startFakeOpenHands } = await import("../src/demo/fake-agent-server.js");
const { scriptedAgents } = await import("../src/demo/scripted-agents.js");
const { createOrchestrator } = await import("../src/autopilot/orchestrator.js");
const { openLedger } = await import("../src/autopilot/ledger.js");
const { OpenHandsClient } = await import("../src/autopilot/openhands.js");
const { fileAt } = await import("../src/autopilot/git.js");

test("scripted agents: a valid spec first time, WO-2 repaired after its test fails, WO-3 (src/auth) waits for a person, then done", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "sf-demo-ws-"));
  writeFileSync(path.join(workspace, "README.md"), "# Demo\n");
  const fake = await startFakeOpenHands({ onMessage: scriptedAgents() });
  const ledger = openLedger(":memory:");
  const o = createOrchestrator({ ledger, client: new OpenHandsClient({ baseUrl: fake.url }), workspace, dataDir, graceMs: 0 });
  const step = async () => {
    await o.tick();
    await o.idle();
    await fake.settled();
  };
  const until = async (done: () => boolean) => {
    for (let i = 0; i < 80 && !done(); i++) await step();
    assert.ok(done(), "the run didn't get there");
  };
  try {
    const run = await o.createRun({ goal: "Let applicants check a claim's status", autonomy: "supervised", actor: "user:test" });
    const open = (kind: string) => ledger.listInbox({ runId: run.id }).find((i) => i.kind === kind);
    await until(() => !!open("plan_approval"));
    assert.deepEqual(ledger.listChecks({ runId: run.id }).map((c) => `${c.name}:${c.ok}`), ["openspec-validate:true"]);
    assert.deepEqual(ledger.listWorkOrders(run.id).map((w) => [w.seq, w.wave, w.dependsOn]), [[1, 1, []], [2, 1, []], [3, 2, [1, 2]]]);
    await o.decide(open("plan_approval")!.id, { choice: "approve" }, "user:test");

    await until(() => !!open("merge_approval"));
    assert.match(open("merge_approval")!.body, /Changes sensitive paths: src\/auth\/check\.js/);
    const wo2 = ledger.listChecks({ runId: run.id, workOrderId: `${run.id}/WO-2` }).filter((c) => c.stage === "build");
    assert.deepEqual(wo2.map((c) => c.ok), [false, true]); // the deliberate bug, then the repair
    await o.decide(open("merge_approval")!.id, { choice: "merge" }, "user:test");

    await until(() => ledger.getRun(run.id)?.state === "done");
    assert.deepEqual(ledger.listWorkOrders(run.id).map((w) => w.mergedBy), [`policy@${run.policyHash}`, `policy@${run.policyHash}`, "user:test"]);
    assert.notEqual(await fileAt(workspace, run.integrationBranch, "src/auth/check.js"), null);
    assert.ok(ledger.runCost(run.id) > 0);
  } finally {
    o.stop();
    await o.idle();
    await fake.close();
    ledger.close();
  }
});
