import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const dir = mkdtempSync(path.join(tmpdir(), "sf-backlog-"));
process.env.SF_WORKSPACE = path.join(dir, "workspace");
process.env.SF_DATA_DIR = path.join(dir, "data");
const { audit, auditFor, verifyAudit } = await import("../src/audit.js");
const { getWorkOrder, listWorkOrders, runBacklog, setStatus } = await import("../src/backlog.js");

before(async () => {
  mkdirSync(process.env.SF_WORKSPACE!, { recursive: true });
  await runBacklog([
    "init", "Approval tests", "--defaults", "--no-git", "--task-prefix", "WO",
    "--integration-mode", "none", "--check-branches", "false",
  ]);
});
after(() => rmSync(dir, { recursive: true, force: true }));

async function createWorkOrder(title: string, status: string) {
  await runBacklog(["task", "create", title, "--status", status, "--plain"]);
  const wo = listWorkOrders().workOrders.find((entry) => entry.title === title);
  assert.ok(wo);
  return wo;
}

test("explicit approval records a person after an agent already marked the work order Done", async () => {
  const wo = await createWorkOrder("Agent completed", "Done");
  await audit("filesystem", "work_order.done_without_approval", wo.id, { from: "In Progress", to: "Done" });
  assert.equal(getWorkOrder(wo.id).doneWithoutApproval, true);

  await setStatus(wo.id.toLowerCase(), "Done", "user:reviewer", { approve: true, note: "Accepted evidence" });

  const approvals = auditFor(wo.id).filter((event) => event.action === "work_order.approved");
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0]!.actor, "user:reviewer");
  assert.deepEqual(approvals[0]!.data, { from: "Done", to: "Done", note: "Accepted evidence" });
  assert.deepEqual(getWorkOrder(wo.id).approval, { by: "user:reviewer", at: approvals[0]!.at });
  assert.equal(getWorkOrder(wo.id).doneWithoutApproval, false);
  const taskFile = path.join(process.env.SF_WORKSPACE!, wo.file);
  const approvedFile = readFileSync(taskFile, "utf8");
  assert.ok(approvedFile.includes("Accepted evidence"));

  await setStatus(wo.id, "Done", "user:retry", { approve: true, note: "Retry should do nothing" });
  assert.equal(auditFor(wo.id).filter((event) => event.action === "work_order.approved").length, 1);
  assert.equal(readFileSync(taskFile, "utf8"), approvedFile);
  assert.equal(getWorkOrder(wo.id).approval?.by, "user:reviewer");
  assert.equal(verifyAudit().ok, true);
});

test("Done work orders present before startup are unapproved without approval evidence", async () => {
  const wo = await createWorkOrder("Completed while factory was stopped", "Done");
  assert.deepEqual(auditFor(wo.id), []);
  assert.equal(getWorkOrder(wo.id).approval, undefined);
  assert.equal(getWorkOrder(wo.id).doneWithoutApproval, true);
  assert.equal(listWorkOrders().workOrders.find((entry) => entry.id === wo.id)?.doneWithoutApproval, true);
});

test("moving to Done through approval edits the task and records the transition", async () => {
  const wo = await createWorkOrder("Ready for review", "In Progress");
  await setStatus(wo.id, "Done", "user:owner", { approve: true });
  const completed = getWorkOrder(wo.id);
  assert.equal(completed.status, "Done");
  assert.equal(completed.approval?.by, "user:owner");
  assert.equal(completed.doneWithoutApproval, false);
  assert.deepEqual(auditFor(wo.id).map((event) => ({ action: event.action, data: event.data })), [
    { action: "work_order.approved", data: { from: "In Progress", to: "Done" } },
  ]);
});

test("Done still requires explicit approval when the task is already Done", async () => {
  const wo = await createWorkOrder("Unapproved final status", "Done");
  await assert.rejects(setStatus(wo.id, "Done", "user:owner"), /Use "Approve" instead/);
  assert.deepEqual(auditFor(wo.id), []);
  assert.equal(getWorkOrder(wo.id).approval, undefined);
});
