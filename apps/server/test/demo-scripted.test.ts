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
const { capabilityOf, scriptedAgents } = await import("../src/demo/scripted-agents.js");
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
    assert.match(open("merge_approval")!.body, /Changes sensitive paths: src\/auth\/let-applicants-check\.js/);
    const wo2 = ledger.listChecks({ runId: run.id, workOrderId: `${run.id}/WO-2` }).filter((c) => c.stage === "build" && c.name === "test");
    assert.deepEqual(wo2.map((c) => c.ok), [false, true]); // the deliberate bug, then the repair
    await o.decide(open("merge_approval")!.id, { choice: "merge" }, "user:test");

    await until(() => ledger.getRun(run.id)?.state === "done");
    assert.deepEqual(ledger.listWorkOrders(run.id).map((w) => w.mergedBy), [`policy@${run.policyHash}`, `policy@${run.policyHash}`, "user:test"]);
    assert.notEqual(await fileAt(workspace, run.integrationBranch, "src/auth/let-applicants-check.js"), null);
    assert.ok(ledger.runCost(run.id) > 0);
  } finally {
    o.stop();
    await o.idle();
    await fake.close();
    ledger.close();
  }
});

test("capabilityOf: the change's first three words, and the number the factory gives a repeated goal", () => {
  assert.equal(capabilityOf("let-applicants-check-a-claim-s-status"), "let-applicants-check");
  assert.equal(capabilityOf("let-applicants-check-a-claim-s-status-2"), "let-applicants-check-2");
  assert.equal(capabilityOf("add-wcag-2"), "add-wcag-2");
  assert.equal(capabilityOf(""), "feature");
});

test("scripted agents: the same goal again, after the first run is released, builds new files and goes the same way", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "sf-demo-ws-"));
  writeFileSync(path.join(workspace, "README.md"), "# Demo\n");
  const fake = await startFakeOpenHands({ onMessage: scriptedAgents() });
  const ledger = openLedger(":memory:");
  const o = createOrchestrator({ ledger, client: new OpenHandsClient({ baseUrl: fake.url }), workspace, dataDir, graceMs: 0 });
  const drive = async (runId: string, until: string) => {
    for (let i = 0; i < 120 && ledger.getRun(runId)?.state !== until; i++) {
      for (const item of ledger.listInbox({ runId })) {
        const choice = { plan_approval: "approve", merge_approval: "merge", release: "release" }[item.kind as string];
        if (choice) await o.decide(item.id, { choice }, "user:test");
      }
      await o.tick();
      await o.idle();
      await fake.settled();
    }
    assert.equal(ledger.getRun(runId)?.state, until);
  };
  try {
    const first = await o.createRun({ goal: "Let applicants check a claim's status", autonomy: "supervised", actor: "user:test" });
    await drive(first.id, "released");
    const second = await o.createRun({ goal: "Let applicants check a claim's status", autonomy: "supervised", actor: "user:test" });
    assert.equal(second.change, `${first.change}-2`);
    await drive(second.id, "done");
    assert.deepEqual(ledger.listWorkOrders(second.id).map((w) => w.mergedBy), [`policy@${second.policyHash}`, `policy@${second.policyHash}`, "user:test"]);
    assert.match(ledger.listInbox({ state: "all", runId: second.id }).find((i) => i.kind === "merge_approval")!.body, /src\/auth\/let-applicants-check-2\.js/);
    assert.notEqual(await fileAt(workspace, second.integrationBranch, "src/let-applicants-check-2/core.js"), null);
  } finally {
    o.stop();
    await o.idle();
    await fake.close();
    ledger.close();
  }
});
