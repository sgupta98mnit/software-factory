import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { mock, test } from "node:test";

const dataDir = mkdtempSync(path.join(tmpdir(), "sf-evidence-data-"));
process.env.SF_DATA_DIR = dataDir;
process.env.SF_WORKSPACE = mkdtempSync(path.join(tmpdir(), "sf-evidence-unused-"));
const { audit, canonicalJson, sha256, auditFor } = await import("../src/audit.js");
const { openLedger } = await import("../src/autopilot/ledger.js");
const { createOrchestrator } = await import("../src/autopilot/orchestrator.js");
const { createAutopilotRoutes } = await import("../src/autopilot/routes.js");
const { OpenHandsClient } = await import("../src/autopilot/openhands.js");
const { ensureRepo, git, headSha } = await import("../src/autopilot/git.js");

async function fixture() {
  const workspace = mkdtempSync(path.join(tmpdir(), "sf-evidence-ws-"));
  writeFileSync(path.join(workspace, "README.md"), "baseline\n");
  await ensureRepo(workspace);
  const commit = await headSha(workspace);
  const ledger = openLedger(":memory:");
  const run = ledger.createRun({ goal: "PRIVATE_GOAL", change: "claim-status", autonomy: "supervised", baseBranch: "main", integrationBranch: "main", createdBy: "user:tester", state: "done", policyHash: "policy-hash" });
  const o = createOrchestrator({ ledger, workspace, dataDir, client: new OpenHandsClient({ baseUrl: "http://127.0.0.1:1" }) });
  const app = createAutopilotRoutes(o);
  const request = (id = run.id) => app.request(`/runs/${id}/evidence`, { method: "POST" });
  return { workspace, commit, ledger, run, request };
}

test("exports durable evidence tied to the recorded commit after branch movement, omitting sensitive fields", async () => {
  const t = await fixture();
  try {
    const [wo] = t.ledger.addWorkOrders(t.run.id, [{ seq: 1, title: "Lookup", acceptance: ["Return claim status"], controls: ["AC-3"], dependsOn: [], wave: 1, risk: "low", state: "merged", worktree: null, mergedBy: "user:reviewer" }]);
    const check = t.ledger.addCheck({ runId: t.run.id, workOrderId: wo!.id, stage: "integrate", name: "test", ok: true, output: "PRIVATE_OUTPUT", exitCode: 0 });
    t.ledger.addCheck({ runId: t.run.id, workOrderId: wo!.id, stage: "build", name: "test", ok: false, output: "PRIVATE_FAILED_OUTPUT", exitCode: 1 });
    t.ledger.addAttempt({ runId: t.run.id, workOrderId: wo!.id, role: "reviewer", conversationId: "conv-1", state: "finished", costUsd: 1.25, result: { verdict: "pass", reply: "PRIVATE_REPLY" } });
    const inbox = t.ledger.openInbox({ runId: t.run.id, kind: "merge_approval", title: "PRIVATE_INBOX_TITLE", body: "PRIVATE_BODY", options: [] });
    t.ledger.decideInbox(inbox.id, { decision: "merge", by: "user:reviewer", note: "PRIVATE_NOTE" });
    await audit("system", "autopilot.work_order_merged", t.run.id, { workOrder: "WO-1", sha: t.commit });
    // Deliberately don't await: export must drain already queued writes.
    void audit("system", "autopilot.run_completed", t.run.id, { sha: t.commit, fullPrompt: "PRIVATE_AUDIT_PAYLOAD" });
    writeFileSync(path.join(t.workspace, "README.md"), "branch moved\n");
    await git(t.workspace, ["add", "."]);
    await git(t.workspace, ["commit", "-m", "Later unrelated change"]);
    assert.notEqual(await headSha(t.workspace), t.commit);

    const res = await t.request();
    assert.equal(res.status, 200);
    const { packet, digest } = await res.json() as any;
    assert.equal(packet.schemaVersion, 1);
    assert.equal(packet.artifact.commit, t.commit);
    assert.equal(packet.artifact.available, true);
    assert.equal(packet.run.costUsd, 1.25);
    assert.equal(packet.run.policyHash, "policy-hash");
    assert.deepEqual(packet.workOrders[0].acceptance, ["Return claim status"]);
    assert.deepEqual(packet.workOrders[0].checkIds, [check.id, check.id + 1]);
    assert.deepEqual(packet.controls, [{ control: "AC-3", workOrderIds: [wo!.id] }]);
    assert.deepEqual(packet.checks.map((c: any) => c.ok), [true, false]);
    assert.equal(packet.checks[0].outputSha256, sha256("PRIVATE_OUTPUT"));
    assert.equal(packet.checks[0].commitBinding, "not_recorded");
    assert.equal(packet.assurance.independentValidation, "not_recorded");
    assert.equal(packet.assurance.securityScan, "not_recorded");
    assert.equal(packet.assurance.signature, "unsigned");
    assert.equal(packet.audit.verified, true);
    assert.equal(digest.value, sha256(canonicalJson(packet)));
    assert.equal(JSON.stringify(packet).includes("PRIVATE_"), false);
    const exported = auditFor(t.run.id).at(-1)!;
    assert.equal(exported.action, "autopilot.evidence_exported");
    assert.equal(exported.data.digest, digest.value);
    assert.equal(JSON.stringify(exported).includes("PRIVATE_"), false);
  } finally { t.ledger.close(); }
});

test("terminal runs without a completion commit export explicit missing evidence rather than the current branch tip", async () => {
  const t = await fixture();
  try {
    for (const state of ["done", "failed", "cancelled"] as const) {
      t.ledger.updateRun(t.run.id, { state });
      const res = await t.request();
      assert.equal(res.status, 200);
      const { packet } = await res.json() as any;
      assert.deepEqual(packet.artifact, { commit: null, available: false, source: "not_recorded" });
      assert.deepEqual(packet.checks, []);
      assert.equal(packet.run.state, state);
    }
  } finally { t.ledger.close(); }
});

test("missing Git objects remain identified by their recorded SHA and are marked unavailable", async () => {
  const t = await fixture();
  try {
    const missing = "f".repeat(40);
    await audit("system", "autopilot.run_completed", t.run.id, { sha: missing });
    const res = await t.request();
    assert.equal(res.status, 200);
    const { packet } = await res.json() as any;
    assert.equal(packet.artifact.commit, missing);
    assert.equal(packet.artifact.available, false);
  } finally { t.ledger.close(); }
});

test("active runs and missing runs cannot produce terminal evidence", async () => {
  const t = await fixture();
  try {
    t.ledger.updateRun(t.run.id, { state: "building" });
    assert.equal((await t.request()).status, 409);
    assert.equal((await t.request("ap-missing")).status, 404);
  } finally { t.ledger.close(); }
});

test("a damaged or unparsable audit chain refuses export without appending evidence", async () => {
  const t = await fixture();
  const file = path.join(dataDir, "audit.jsonl");
  await audit("system", "autopilot.run_completed", t.run.id, { sha: t.commit });
  const original = readFileSync(file, "utf8");
  try {
    writeFileSync(file, original.replace("autopilot.run_completed", "autopilot.run_tampered"));
    assert.equal((await t.request()).status, 409);
    writeFileSync(file, "{invalid-json\n");
    const res = await t.request();
    assert.equal(res.status, 409);
    assert.doesNotMatch(await res.text(), /invalid-json/);
  } finally {
    writeFileSync(file, original);
    t.ledger.close();
  }
});

test("an export audit write failure returns a safe error without a filesystem path", async () => {
  const t = await fixture();
  await audit("system", "autopilot.run_completed", t.run.id, { sha: t.commit });
  const append = mock.method(fsPromises, "appendFile", async () => {
    throw new Error("EACCES: permission denied, open 'PRIVATE_AUDIT_PATH'");
  });
  syncBuiltinESMExports();
  try {
    const res = await t.request();
    assert.equal(res.status, 409);
    assert.doesNotMatch(await res.text(), /PRIVATE_AUDIT_PATH|EACCES/);
  } finally {
    append.mock.restore();
    syncBuiltinESMExports();
    t.ledger.close();
  }
});

test("an audit tail removed during this process is refused before export can break the chain", async () => {
  const t = await fixture();
  await audit("system", "autopilot.run_completed", t.run.id, { sha: t.commit });
  const file = path.join(dataDir, "audit.jsonl");
  const original = readFileSync(file, "utf8");
  const prefix = original.trimEnd().split("\n").slice(0, -1).join("\n") + "\n";
  writeFileSync(file, prefix);
  try {
    assert.equal((await t.request()).status, 409);
    assert.equal(readFileSync(file, "utf8"), prefix, "a refused export must not append");
  } finally {
    // On RED, preserve any new export event after restoring its missing parent.
    const appended = readFileSync(file, "utf8").slice(prefix.length);
    writeFileSync(file, original + appended);
    t.ledger.close();
  }
});
