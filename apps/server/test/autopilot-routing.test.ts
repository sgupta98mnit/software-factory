import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.SF_DATA_DIR = mkdtempSync(path.join(tmpdir(), "sf-routing-data-"));
process.env.SF_WORKSPACE = mkdtempSync(path.join(tmpdir(), "sf-routing-unused-"));
delete process.env.SF_AUTONOMY_CAP;
const { startFakeOpenHands } = await import("../src/demo/fake-agent-server.js");
const { createOrchestrator } = await import("../src/autopilot/orchestrator.js");
const { openLedger } = await import("../src/autopilot/ledger.js");
const { OpenHandsClient } = await import("../src/autopilot/openhands.js");
const { audit, listAudit } = await import("../src/audit.js");

const PASS = 'Reviewed.\n\n```json\n{"verdict":"pass","findings":[]}\n```';
const PROFILES = [
  { id: "p-default", name: "Default", agent_kind: "acp", acp_server: "claude-code" },
  { id: "p-cheap", name: "Cheap", agent_kind: "acp", acp_server: "claude-code" },
  { id: "p-mid", name: "Mid", agent_kind: "acp", acp_server: "codex" },
  { id: "p-strong", name: "Strong", agent_kind: "acp", acp_server: "claude-code" },
];

test("builders are routed by the work order's risk; a fresh builder after a failed one moves up a level", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "sf-routing-ws-"));
  writeFileSync(path.join(workspace, "README.md"), "# Demo\n");
  mkdirSync(path.join(workspace, ".factory"));
  writeFileSync(path.join(workspace, ".factory", "policy.yml"), "routing: { low: Cheap, medium: Mid, high: Strong }\nrepair: { sameConversation: 0, fresh: 1 }\n");
  let failedOnce = false;
  const fake = await startFakeOpenHands({
    profiles: PROFILES,
    onMessage: (conv) => {
      if (conv.tags.sfrole !== "builder") return { response: PASS, cost: 0.01 };
      // WO-1's first builder gives up; everyone else builds.
      if (conv.tags.sfwo === "1" && !failedOnce) {
        failedOnce = true;
        return { response: "I can't.", status: "error" };
      }
      writeFileSync(path.join(conv.workingDir, "package.json"), JSON.stringify({ name: "x", private: true, scripts: { test: "node --test" } }));
      writeFileSync(path.join(conv.workingDir, `wo-${conv.tags.sfwo}.test.js`), 'import { test } from "node:test";\ntest("ok", () => {});\n');
      return { response: "Built.", cost: 0.1 };
    },
  });
  const ledger = openLedger(":memory:");
  const o = createOrchestrator({ ledger, client: new OpenHandsClient({ baseUrl: fake.url }), workspace, dataDir: mkdtempSync(path.join(tmpdir(), "sf-routing-run-")), graceMs: 0 });
  try {
    const run = await o.createRun({ goal: "Add a page", actor: "user:test" });
    ledger.addWorkOrders(run.id, [
      { seq: 1, title: "Page", acceptance: ["x"], controls: [], dependsOn: [], wave: 1, risk: "low" },
      { seq: 2, title: "Sign-in", acceptance: ["x"], controls: [], dependsOn: [], wave: 1, risk: "high" },
    ]);
    ledger.updateRun(run.id, { state: "building" });
    for (let i = 0; i < 60 && ledger.getRun(run.id)?.state !== "done"; i++) {
      for (const item of ledger.listInbox({ runId: run.id })) if (item.kind === "merge_approval") await o.decide(item.id, { choice: "merge" }, "user:test");
      await o.tick();
      await o.idle();
      await fake.settled();
    }
    assert.equal(ledger.getRun(run.id)?.state, "done");
    const profileOf = (seq: number) => ledger.listAttempts({ runId: run.id, workOrderId: `${run.id}/WO-${seq}`, role: "builder" }).map((a) => a.agentProfile);
    assert.deepEqual(profileOf(1), ["p-cheap", "p-mid"]); // low, then escalated to medium
    assert.deepEqual(profileOf(2), ["p-strong"]);
    await audit("test", "test.flush", "test");
    const why = listAudit(5000).filter((e) => e.subject === run.id && e.action === "autopilot.work_order_dispatched").reverse().map((e) => [e.data.workOrder, e.data.routedBy]);
    assert.deepEqual(why.sort(), [
      ["WO-1", "escalated to medium after 1 builder(s) (routing.medium)"],
      ["WO-1", "risk low (routing.low)"],
      ["WO-2", "risk high (routing.high)"],
    ]);
  } finally {
    o.stop();
    await o.idle();
    await fake.close();
    ledger.close();
  }
});

test("a routing profile the agent server lacks starts no run", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "sf-routing-ws2-"));
  writeFileSync(path.join(workspace, "README.md"), "# Demo\n");
  mkdirSync(path.join(workspace, ".factory"));
  writeFileSync(path.join(workspace, ".factory", "policy.yml"), "routing: { high: Opus Max }\n");
  const fake = await startFakeOpenHands({ profiles: PROFILES });
  const ledger = openLedger(":memory:");
  const o = createOrchestrator({ ledger, client: new OpenHandsClient({ baseUrl: fake.url }), workspace, dataDir: mkdtempSync(path.join(tmpdir(), "sf-routing-run2-")), graceMs: 0 });
  try {
    await assert.rejects(o.createRun({ goal: "Add a page", actor: "user:test" }), /no profile for routing\.high: "Opus Max"/);
  } finally {
    await fake.close();
    ledger.close();
  }
});
