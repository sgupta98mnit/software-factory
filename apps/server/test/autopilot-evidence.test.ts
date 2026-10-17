import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.SF_DATA_DIR = mkdtempSync(path.join(tmpdir(), "sf-evidence-data-"));
process.env.SF_WORKSPACE = mkdtempSync(path.join(tmpdir(), "sf-evidence-unused-"));
process.env.SF_USER = "assessor";
delete process.env.SF_AUTONOMY_CAP;
const { startFakeOpenHands } = await import("../src/demo/fake-agent-server.js");
const { scriptedAgents } = await import("../src/demo/scripted-agents.js");
const { createOrchestrator } = await import("../src/autopilot/orchestrator.js");
const { openLedger } = await import("../src/autopilot/ledger.js");
const { OpenHandsClient } = await import("../src/autopilot/openhands.js");
const { createAutopilotRoutes } = await import("../src/autopilot/routes.js");
const { parseScenarios } = await import("../src/autopilot/evidence.js");
const { audit, listAudit } = await import("../src/audit.js");

test("parseScenarios: each scenario under its requirement", () => {
  const md = "## ADDED Requirements\n\n### Requirement: Look up\n\nText.\n\n#### Scenario: Known claim\n\n- **WHEN** x\n\n#### Scenario: Unknown claim\n\n### Requirement: Audit\n\n#### Scenario: Audited\n";
  assert.deepEqual(parseScenarios("claims", md), [
    { capability: "claims", requirement: "Look up", scenario: "Known claim" },
    { capability: "claims", requirement: "Look up", scenario: "Unknown claim" },
    { capability: "claims", requirement: "Audit", scenario: "Audited" },
  ]);
});

test("evidence for a released run: every scenario traced to its hidden test, the work orders that built it and who approved them; controls, decisions, release and the audit chain", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "sf-evidence-ws-"));
  writeFileSync(path.join(workspace, "README.md"), "# Demo\n");
  mkdirSync(path.join(workspace, ".factory"));
  writeFileSync(path.join(workspace, ".factory", "policy.yml"), "hiddenTests: { enabled: true }\n");
  const fake = await startFakeOpenHands({ onMessage: scriptedAgents({ noBugs: true }) });
  const ledger = openLedger(":memory:");
  const o = createOrchestrator({ ledger, client: new OpenHandsClient({ baseUrl: fake.url }), workspace, dataDir: mkdtempSync(path.join(tmpdir(), "sf-evidence-run-")), graceMs: 0 });
  const app = createAutopilotRoutes(o);
  try {
    const run = await o.createRun({ goal: "Let applicants check a claim's status", autonomy: "supervised", actor: "user:po" });
    for (let i = 0; i < 120 && ledger.getRun(run.id)?.state !== "released"; i++) {
      for (const item of ledger.listInbox({ runId: run.id })) {
        if (item.kind === "plan_approval") await o.decide(item.id, { choice: "approve" }, "user:po");
        if (item.kind === "merge_approval") await o.decide(item.id, { choice: "merge", note: "Auth check reviewed" }, "user:isso");
        if (item.kind === "release") await o.decide(item.id, { choice: "release" }, "user:ao");
      }
      await o.tick();
      await o.idle();
      await fake.settled();
    }
    assert.equal(ledger.getRun(run.id)?.state, "released");

    const res = await app.request(`/runs/${run.id}/evidence?download=1`);
    assert.match(res.headers.get("content-disposition") ?? "", new RegExp(`attachment; filename="evidence-${run.change}-${run.id}\\.json"`));
    const e = (await res.json()) as any;

    // Scenario -> hidden test -> work order -> approval.
    assert.deepEqual(e.traceability.map((s: any) => [s.requirement, s.scenario, s.hiddenTests.map((h: any) => h.file), s.workOrders.map((w: any) => w.key)]), [
      ["Core behavior", "Valid request", ["valid-request.test.mjs"], ["WO-1"]],
      ["Input validation", "Missing input", ["missing-input.test.mjs"], ["WO-2"]],
      ["Audit every request", "Request is audited", ["request-is-audited.test.mjs"], ["WO-3"]],
    ]);
    assert.ok(e.traceability.every((s: any) => s.hiddenTests[0].lastOk === true && s.hiddenTests[0].sha256.length === 64));
    assert.deepEqual(e.traceability[0].workOrders[0].approval, { by: `policy@${run.policyHash}`, kind: "policy" });
    assert.deepEqual(e.traceability[2].workOrders[0].approval, { by: "user:isso", kind: "person" });

    const wo3 = e.workOrders.find((w: any) => w.key === "WO-3");
    assert.match(wo3.mergeReasons.join(" "), /Changes sensitive paths: src\/auth\/let-applicants-check\.js/);
    assert.deepEqual(e.workOrders.find((w: any) => w.key === "WO-1").mergeReasons, []);
    assert.deepEqual(e.controls.find((c: any) => c.control === "AC-3").workOrders.map((w: any) => w.key), ["WO-3"]);
    assert.deepEqual(e.spec.planApproval.by, "user:po");
    assert.deepEqual(e.decisions.map((d: any) => [d.kind, d.decision, d.by]).sort(), [
      ["merge_approval", "merge", "user:isso"],
      ["plan_approval", "approve", "user:po"],
      ["release", "release", "user:ao"],
    ]);
    assert.equal(e.release.by, "user:ao");
    assert.equal(e.policy.hiddenTests, true);
    assert.equal(e.audit.chain.ok, true);
    assert.ok(e.audit.events > 20);

    await audit("test", "test.flush", "test");
    assert.deepEqual(listAudit(5000).filter((x) => x.subject === run.id && x.action === "autopilot.evidence_exported").map((x) => x.actor), ["user:assessor"]);
  } finally {
    o.stop();
    await o.idle();
    await fake.close();
    ledger.close();
  }
});
