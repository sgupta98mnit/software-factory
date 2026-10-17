import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { type Finding, type InboxOption, type Ledger, openLedger, OUTPUT_LIMIT } from "../src/autopilot/ledger.js";

const OPTIONS: InboxOption[] = [
  { id: "approve", label: "Approve", tone: "primary" },
  { id: "revise", label: "Revise", needsNote: true },
  { id: "cancel", label: "Cancel run", tone: "danger" },
];

function withLedger(fn: (l: Ledger) => void) {
  const ledger = openLedger(":memory:");
  try {
    fn(ledger);
  } finally {
    ledger.close();
  }
}

function newRun(l: Ledger, change = "add-claim-status") {
  return l.createRun({
    goal: "Let claimants see their claim status",
    change,
    autonomy: "supervised",
    baseBranch: "main",
    integrationBranch: `autopilot/${change}`,
    createdBy: "user:test",
  });
}

function twoWorkOrders(l: Ledger, runId: string) {
  return l.addWorkOrders(runId, [
    { seq: 2, title: "Status lookup", acceptance: ["GET /claims/:id/status", "400 for bad ids"], controls: ["SI-10"], dependsOn: [1], wave: 2, risk: "medium" },
    { seq: 1, title: "Service skeleton", acceptance: ["Test runner"], controls: [], dependsOn: [], wave: 1, risk: "low", riskScore: 1 },
  ]);
}

test("runs: create with defaults, get, list newest first, update", () =>
  withLedger((l) => {
    const first = newRun(l, "first");
    const second = newRun(l, "second");
    assert.match(first.id, /^ap-[0-9a-f]{8}$/);
    assert.equal(first.state, "spec");
    assert.equal(first.budgetUsd, null);
    assert.equal(first.policy, null);
    assert.equal(first.integrationDir, null);
    assert.equal(first.createdAt, first.updatedAt);
    assert.deepEqual(l.getRun(first.id), first);
    assert.equal(l.getRun("ap-missing"), undefined);
    assert.deepEqual(
      l.listRuns().map((r) => r.id),
      [second.id, first.id],
    );

    const policy = { parallel: 3, review: { blocking: ["critical", "high"] } };
    const paused = l.updateRun(first.id, { state: "paused", resumeState: "building", pausedReason: "3 failing", policy, policyHash: "abc123" });
    assert.equal(paused.state, "paused");
    assert.equal(paused.resumeState, "building");
    assert.equal(paused.pausedReason, "3 failing");
    assert.deepEqual(paused.policy, policy);
    assert.ok(paused.updatedAt >= first.updatedAt);
    assert.throws(() => l.updateRun("ap-missing", { state: "done" }), /No runs row/);
  }));

test("runs: a chosen id is kept, and fields that aren't columns are refused", () =>
  withLedger((l) => {
    const run = l.createRun({ id: "ap-12345678", goal: "g", change: "c", autonomy: "suggest", baseBranch: "main", integrationBranch: "autopilot/c", createdBy: "user:test", budgetUsd: 12.5 });
    assert.equal(run.id, "ap-12345678");
    assert.equal(run.budgetUsd, 12.5);
    assert.throws(() => l.updateRun(run.id, { nope: 1 } as never), /no column for "nope"/);
  }));

test("create helpers: a field passed as undefined keeps its default", () =>
  withLedger((l) => {
    const run = l.createRun({ goal: "g", change: "c", autonomy: "suggest", baseBranch: "main", integrationBranch: "autopilot/c", createdBy: "user:test", state: undefined });
    assert.equal(run.state, "spec");
    const [wo] = l.addWorkOrders(run.id, [{ seq: 1, title: "x", acceptance: [], controls: [], dependsOn: [], wave: 1, risk: "low", state: undefined }]);
    assert.equal(wo?.state, "pending");
    const attempt = l.addAttempt({ runId: run.id, role: "spec", conversationId: "c1", state: undefined, lastSentAt: undefined, startedAt: undefined });
    assert.equal(attempt.state, "starting");
    assert.ok(attempt.startedAt);
  }));

test("work orders: ids, defaults, plan order, JSON columns round-trip, update", () =>
  withLedger((l) => {
    const run = newRun(l);
    const rows = twoWorkOrders(l, run.id);
    assert.deepEqual(
      rows.map((w) => w.id),
      [`${run.id}/WO-1`, `${run.id}/WO-2`],
    );
    const wo2 = l.getWorkOrder(`${run.id}/WO-2`);
    assert.ok(wo2);
    assert.deepEqual(wo2.acceptance, ["GET /claims/:id/status", "400 for bad ids"]);
    assert.deepEqual(wo2.controls, ["SI-10"]);
    assert.deepEqual(wo2.dependsOn, [1]);
    assert.equal(wo2.state, "pending");
    assert.equal(wo2.riskScore, 0);
    assert.equal(wo2.budgetExtraUsd, 0);
    assert.equal(wo2.findings, null);
    assert.equal(rows[0]?.riskScore, 1);

    const findings: Finding[] = [{ source: "gate", severity: "high", title: "test failed", detail: "expected 404, got 500", file: "src/routes.ts", criterion: 2, scenario: null }];
    const updated = l.updateWorkOrder(wo2.id, { state: "building", findings, branch: "autopilot/add-claim-status/wo-2", baseSha: "abc" });
    assert.equal(updated.state, "building");
    assert.deepEqual(updated.findings, findings);
    assert.equal(updated.branch, "autopilot/add-claim-status/wo-2");
    assert.equal(l.updateWorkOrder(wo2.id, { findings: null }).findings, null);
  }));

test("work orders: a duplicate task group rolls back the whole batch", () =>
  withLedger((l) => {
    const run = newRun(l);
    const row = { title: "x", acceptance: [], controls: [], dependsOn: [], wave: 1, risk: "low" as const };
    assert.throws(() => l.addWorkOrders(run.id, [{ ...row, seq: 1 }, { ...row, seq: 1 }]));
    assert.deepEqual(l.listWorkOrders(run.id), []);
  }));

test("work orders: deleted to plan again, but not once an agent worked on one", () =>
  withLedger((l) => {
    const run = newRun(l);
    const other = newRun(l, "other");
    twoWorkOrders(l, run.id);
    twoWorkOrders(l, other.id);
    assert.equal(l.deleteWorkOrders(run.id), 2);
    assert.deepEqual(l.listWorkOrders(run.id), []);
    assert.equal(l.listWorkOrders(other.id).length, 2);
    l.addAttempt({ runId: other.id, workOrderId: `${other.id}/WO-1`, role: "builder", conversationId: "c-1" });
    assert.throws(() => l.deleteWorkOrders(other.id), /FOREIGN KEY/);
  }));

test("attempts: write-ahead defaults, lookups, filters, active ones, JSON result", () =>
  withLedger((l) => {
    const run = newRun(l);
    twoWorkOrders(l, run.id);
    const spec = l.addAttempt({ runId: run.id, role: "spec", conversationId: "conv-spec" });
    assert.equal(spec.state, "starting");
    assert.equal(spec.turns, 1);
    assert.equal(spec.seenRunning, false);
    assert.equal(spec.costUsd, 0);
    assert.equal(spec.result, null);
    assert.equal(spec.workOrderId, null);
    assert.equal(spec.lastSentAt, spec.startedAt);

    const builder = l.addAttempt({ runId: run.id, workOrderId: `${run.id}/WO-1`, role: "builder", conversationId: "conv-b1", agentProfile: "claude" });
    const reviewer = l.addAttempt({ runId: run.id, workOrderId: `${run.id}/WO-1`, role: "reviewer", conversationId: "conv-r1", state: "running" });
    assert.throws(() => l.addAttempt({ runId: run.id, role: "spec", conversationId: "conv-spec" }), /UNIQUE/);

    const result = { verdict: "pass", findings: [] };
    const done = l.updateAttempt(spec.id, { state: "finished", seenRunning: true, result, finishedAt: new Date().toISOString() });
    assert.equal(done.seenRunning, true);
    assert.deepEqual(done.result, result);
    assert.deepEqual(l.getAttemptByConversation("conv-spec"), done);
    assert.equal(l.getAttemptByConversation("nope"), undefined);

    assert.deepEqual(
      l.listAttempts({ runId: run.id }).map((a) => a.id),
      [spec.id, builder.id, reviewer.id],
    );
    assert.deepEqual(
      l.listAttempts({ runId: run.id, workOrderId: `${run.id}/WO-1` }).map((a) => a.id),
      [builder.id, reviewer.id],
    );
    assert.deepEqual(
      l.listAttempts({ runId: run.id, workOrderId: `${run.id}/WO-1`, role: "builder" }).map((a) => a.id),
      [builder.id],
    );
    assert.deepEqual(
      l.activeAttempts().map((a) => a.id),
      [builder.id, reviewer.id],
    );
  }));

test("checks: ok flag, output kept to its tail, filter by work order", () =>
  withLedger((l) => {
    const run = newRun(l);
    const spec = l.addCheck({ runId: run.id, stage: "spec", name: "openspec-validate", ok: false, output: "1 issue" });
    assert.equal(spec.ok, false);
    assert.equal(spec.workOrderId, null);
    assert.equal(spec.exitCode, null);
    const long = `${"a".repeat(100)}${"b".repeat(OUTPUT_LIMIT)}`;
    const gate = l.addCheck({ runId: run.id, workOrderId: `${run.id}/WO-1`, stage: "build", name: "test", ok: true, exitCode: 0, durationMs: 1234, output: long });
    assert.equal(gate.ok, true);
    assert.equal(gate.durationMs, 1234);
    assert.equal(gate.output, "b".repeat(OUTPUT_LIMIT));
    assert.equal(l.addCheck({ runId: run.id, stage: "build", name: "lint", ok: true }).output, "");
    assert.equal(l.listChecks({ runId: run.id }).length, 3);
    assert.deepEqual(
      l.listChecks({ runId: run.id, workOrderId: `${run.id}/WO-1` }).map((c) => c.id),
      [gate.id],
    );
  }));

test("inbox: dedupe, list, decide once, count, dismiss", () =>
  withLedger((l) => {
    const run = newRun(l, "one");
    const other = newRun(l, "two");
    const plan = l.openInbox({ runId: run.id, kind: "plan_approval", title: "Approve the plan", body: "**3** work orders", options: OPTIONS });
    assert.equal(plan.state, "open");
    assert.deepEqual(plan.options, OPTIONS);
    assert.equal(plan.workOrderId, null);

    // Same run, work order and kind while open: the existing item comes back unchanged.
    const again = l.openInbox({ runId: run.id, kind: "plan_approval", title: "Different", body: "", options: [] });
    assert.deepEqual(again, plan);
    // A different work order or kind is a new item.
    const wo1 = l.openInbox({ runId: run.id, workOrderId: `${run.id}/WO-1`, kind: "work_order_failed", title: "WO-1 failed", body: "", options: OPTIONS });
    const wo1Merge = l.openInbox({ runId: run.id, workOrderId: `${run.id}/WO-1`, kind: "merge_approval", title: "Merge WO-1?", body: "", options: OPTIONS });
    const otherItem = l.openInbox({ runId: other.id, kind: "plan_approval", title: "Approve", body: "", options: OPTIONS });
    assert.equal(new Set([plan.id, wo1.id, wo1Merge.id, otherItem.id]).size, 4);
    assert.equal(l.openInboxCount(), 4);
    assert.deepEqual(
      l.listInbox().map((i) => i.id),
      [otherItem.id, wo1Merge.id, wo1.id, plan.id],
    );
    assert.deepEqual(
      l.listInbox({ runId: other.id }).map((i) => i.id),
      [otherItem.id],
    );

    const decided = l.decideInbox(plan.id, { decision: "revise", note: "Split WO-2", by: "user:test" });
    assert.equal(decided.state, "decided");
    assert.equal(decided.decision, "revise");
    assert.equal(decided.note, "Split WO-2");
    assert.equal(decided.decidedBy, "user:test");
    assert.ok(decided.decidedAt);
    assert.throws(() => l.decideInbox(plan.id, { decision: "approve", by: "user:test" }), /not open/);
    assert.equal(l.openInboxCount(), 3);
    // Once decided, the same kind can be opened again.
    assert.notEqual(l.openInbox({ runId: run.id, kind: "plan_approval", title: "Approve the new plan", body: "", options: OPTIONS }).id, plan.id);

    assert.equal(l.dismissInbox({ runId: run.id }), 3);
    assert.equal(l.openInboxCount(), 1);
    assert.deepEqual(
      l.listInbox({ state: "decided" }).map((i) => i.id),
      [plan.id],
    );
    assert.equal(l.listInbox({ state: "all", runId: run.id }).length, 4);
    assert.equal(l.getInbox(wo1.id)?.state, "dismissed");
  }));

test("costs: attempt = latest cost, work order and run = sums over attempts", () =>
  withLedger((l) => {
    const run = newRun(l, "one");
    const other = newRun(l, "two");
    twoWorkOrders(l, run.id);
    const wo1 = `${run.id}/WO-1`;
    const builder = l.addAttempt({ runId: run.id, workOrderId: wo1, role: "builder", conversationId: "b1" });
    l.updateAttempt(builder.id, { costUsd: 0.25 });
    // A later poll reports the accumulated cost; it replaces, never adds.
    assert.equal(l.updateAttempt(builder.id, { costUsd: 0.5 }).costUsd, 0.5);
    l.addAttempt({ runId: run.id, workOrderId: wo1, role: "reviewer", conversationId: "r1", costUsd: 0.25 });
    l.addAttempt({ runId: run.id, role: "spec", conversationId: "s1", costUsd: 1 });
    l.addAttempt({ runId: other.id, role: "spec", conversationId: "s2", costUsd: 4 });

    assert.equal(l.workOrderCost(wo1), 0.75);
    assert.equal(l.workOrderCost(`${run.id}/WO-2`), 0);
    assert.equal(l.runCost(run.id), 1.75);
    assert.equal(l.runCost(other.id), 4);
    assert.equal(l.runCost("ap-missing"), 0);
  }));

test("transaction: everything inside rolls back on a throw", () =>
  withLedger((l) => {
    const run = newRun(l);
    assert.throws(() =>
      l.transaction(() => {
        l.updateRun(run.id, { state: "building" });
        l.openInbox({ runId: run.id, kind: "error", title: "x", body: "", options: [] });
        throw new Error("boom");
      }),
    );
    assert.equal(l.getRun(run.id)?.state, "spec");
    assert.equal(l.openInboxCount(), 0);
  }));

test("resumable: a file ledger keeps everything across close and reopen", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sf-ledger-"));
  const file = path.join(dir, "nested", "autopilot.db");
  try {
    const before = openLedger(file);
    const run = newRun(before);
    before.updateRun(run.id, { state: "building", integrationDir: "/tmp/wt/integration" });
    twoWorkOrders(before, run.id);
    before.updateWorkOrder(`${run.id}/WO-1`, { state: "building" });
    before.addAttempt({ runId: run.id, workOrderId: `${run.id}/WO-1`, role: "builder", conversationId: "b1", state: "running", costUsd: 0.5 });
    before.addCheck({ runId: run.id, stage: "spec", name: "openspec-validate", ok: true });
    before.openInbox({ runId: run.id, kind: "questions", title: "Two questions", body: "- a\n- b", options: OPTIONS });
    const snapshot = {
      run: before.getRun(run.id),
      workOrders: before.listWorkOrders(run.id),
      attempts: before.listAttempts({ runId: run.id }),
      checks: before.listChecks({ runId: run.id }),
      inbox: before.listInbox({ state: "all" }),
    };
    before.close();

    const after = openLedger(file);
    try {
      assert.deepEqual(
        {
          run: after.getRun(run.id),
          workOrders: after.listWorkOrders(run.id),
          attempts: after.listAttempts({ runId: run.id }),
          checks: after.listChecks({ runId: run.id }),
          inbox: after.listInbox({ state: "all" }),
        },
        snapshot,
      );
      assert.deepEqual(
        after.activeAttempts().map((a) => a.conversationId),
        ["b1"],
      );
      assert.equal(after.runCost(run.id), 0.5);
      assert.equal(after.openInboxCount(), 1);
    } finally {
      after.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
