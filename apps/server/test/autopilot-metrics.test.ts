// The Metrics page's numbers: lead time, autonomy rate, cost per change, top failure reasons.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.SF_DATA_DIR = mkdtempSync(path.join(tmpdir(), "sf-metrics-data-"));
process.env.SF_WORKSPACE = mkdtempSync(path.join(tmpdir(), "sf-metrics-unused-"));
delete process.env.SF_AUTONOMY_CAP;
const { startFakeOpenHands } = await import("../src/demo/fake-agent-server.js");
const { scriptedAgents } = await import("../src/demo/scripted-agents.js");
const { createOrchestrator } = await import("../src/autopilot/orchestrator.js");
const { openLedger } = await import("../src/autopilot/ledger.js");
const { OpenHandsClient } = await import("../src/autopilot/openhands.js");
const { createAutopilotRoutes } = await import("../src/autopilot/routes.js");
const { ensureRepo } = await import("../src/autopilot/git.js");
const { computeMetrics } = await import("../src/autopilot/metrics.js");
const { policyHash, DEFAULT_POLICY } = await import("../src/autopilot/policy.js");
import type { AuditEvent } from "../src/audit.js";

const H = 3_600_000;

test("computeMetrics: lead time, who merged, cost per finished change and the failures, from the ledger and the audit", () => {
  const ledger = openLedger(":memory:");
  try {
    const base = { goal: "g", autonomy: "supervised" as const, baseBranch: "main", integrationBranch: "factory/x", createdBy: "user:po", policyHash: "aaaaaaaaaaaa" };
    const a = ledger.createRun({ ...base, change: "a" });
    const b = ledger.createRun({ ...base, change: "b" });
    const c = ledger.createRun({ ...base, change: "c" });
    const t0 = Date.parse(a.createdAt);
    const iso = (ms: number) => new Date(ms).toISOString();
    ledger.updateRun(a.id, { state: "released", releasedAt: iso(t0 + 5 * H), releasedBy: "user:alice" });
    ledger.updateRun(b.id, { state: "done" });
    ledger.updateRun(c.id, { state: "failed" });
    const wo = { title: "t", acceptance: [], controls: [], dependsOn: [], wave: 1, risk: "low" as const };
    const [a1, a2, a3] = ledger.addWorkOrders(a.id, [1, 2, 3].map((seq) => ({ ...wo, seq })));
    const [b1] = ledger.addWorkOrders(b.id, [{ ...wo, seq: 1 }]);
    const [c1] = ledger.addWorkOrders(c.id, [{ ...wo, seq: 1 }]);
    ledger.updateWorkOrder(a1!.id, { state: "merged", mergedBy: "policy@aaaaaaaaaaaa" });
    ledger.updateWorkOrder(a2!.id, { state: "merged", mergedBy: "policy@aaaaaaaaaaaa" });
    ledger.updateWorkOrder(a3!.id, { state: "merged", mergedBy: "user:isso" });
    ledger.updateWorkOrder(b1!.id, { state: "merged", mergedBy: "policy@aaaaaaaaaaaa" });
    ledger.updateWorkOrder(c1!.id, { state: "failed" });

    const attempt = (runId: string, workOrderId: string | null, costUsd: number, more: Record<string, unknown> = {}) =>
      ledger.addAttempt({ runId, workOrderId, role: workOrderId ? "builder" : "spec", conversationId: `${runId}-${Math.random()}`, costUsd, state: "finished", ...more });
    attempt(a.id, null, 1);
    attempt(a.id, a1!.id, 2);
    attempt(a.id, a2!.id, 3);
    attempt(a.id, a3!.id, 4);
    attempt(b.id, b1!.id, 2);
    attempt(c.id, c1!.id, 5, { state: "stuck", result: { error: "No progress", watchdog: true } });
    attempt(c.id, c1!.id, 0, { state: "error", result: { error: "gone", lost: true } }); // a lost conversation is forgiven
    attempt(c.id, c1!.id, 0, { state: "error", result: { error: "crashed" } });

    // WO-1 failed its test twice and a hidden test twice: one "test" and one "hidden" each.
    for (const name of ["test", "test", "hidden:a.test.js", "hidden:b.test.js", "secret-scan", "reviewer-edits-discarded"]) ledger.addCheck({ runId: a.id, workOrderId: a1!.id, stage: "build", name, ok: false });
    ledger.addCheck({ runId: a.id, workOrderId: a1!.id, stage: "build", name: "test", ok: true });
    ledger.addCheck({ runId: c.id, workOrderId: c1!.id, stage: "build", name: "test", ok: false });
    ledger.addCheck({ runId: a.id, stage: "release", name: "test", ok: false }); // not a work order's gate

    const decide = (runId: string, kind: "release" | "merge_approval" | "work_order_failed" | "plan_approval", by: string, decision = "ok") => {
      const item = ledger.openInbox({ runId, kind, title: kind, body: "", options: [] });
      ledger.decideInbox(item.id, { decision, by });
    };
    decide(a.id, "plan_approval", "user:po");
    decide(a.id, "merge_approval", "user:isso");
    decide(a.id, "release", "user:alice");
    decide(b.id, "release", "user:alice", "hold");
    decide(b.id, "merge_approval", "user:bob", "superseded"); // the plan changed under it; nobody decided it
    decide(b.id, "plan_approval", "policy@aaaaaaaaaaaa");
    decide(c.id, "work_order_failed", "user:po", "cancel");

    let seq = 0;
    const ev = (subject: string, action: string, at: number, data: Record<string, unknown> = {}): AuditEvent => ({ seq: ++seq, at: iso(at), actor: "autopilot", action, subject, data, prevHash: "", hash: "" });
    const events = [
      ev(a.id, "autopilot.run_completed", t0 + 4 * H),
      ev(b.id, "autopilot.run_completed", Date.parse(b.createdAt) + 1 * H),
      ev(a.id, "autopilot.review_verdict", t0, { workOrder: "WO-2", passed: false }),
      ev(a.id, "autopilot.review_verdict", t0, { workOrder: "WO-2", passed: false }),
      ev(a.id, "autopilot.review_verdict", t0, { workOrder: "WO-1", passed: true }),
      ev(a.id, "autopilot.merge_conflicted", t0, { workOrder: "WO-3" }),
      ev(a.id, "autopilot.release_failed", t0, { reason: "x" }),
      ev("ap-elsewhere", "autopilot.release_failed", t0, { reason: "another workspace's run" }),
    ].reverse(); // listAudit is newest first

    const m = computeMetrics(ledger, events);
    assert.deepEqual(m.runs, { started: 3, released: 1, done: 1, failed: 1, cancelled: 0, active: 0 });
    assert.deepEqual(m.leadTime.toRelease, { medianMs: 5 * H, p90Ms: 5 * H, samples: 1 });
    assert.deepEqual(m.leadTime.toReady, { medianMs: 1 * H, p90Ms: 4 * H, samples: 2 });
    assert.deepEqual(m.autonomy, { merged: 4, byPolicy: 3, byPerson: 1, rate: 0.75, runsWithoutPeople: 1, personDecisions: 5 });
    // Cost: everything spent (17), per finished change ((10 + 2) / 2), per merged work order ((2+3+4+2) / 4).
    assert.deepEqual(m.cost, { totalUsd: 17, perChangeUsd: 6, perMergedWorkOrderUsd: 2.75 });
    assert.deepEqual(m.failures, [
      { reason: 'Gate "test" failed', count: 2 },
      { reason: "A hidden acceptance test failed", count: 1 },
      { reason: "A merge conflicted with another work order", count: 1 },
      { reason: "A release didn't go through", count: 1 },
      { reason: "A work order ran out of repair rounds", count: 1 },
      { reason: "An agent made no progress and was stopped", count: 1 },
      { reason: "An agent stopped with an error", count: 1 },
      { reason: "The review asked for changes", count: 1 },
      { reason: "The secret scan caught a credential", count: 1 },
    ]);
    assert.deepEqual(m.policies.map((p) => [p.hash, p.runs]), [["aaaaaaaaaaaa", 3]]);
    assert.equal(m.window.days, 30);

    // The window: runs started before it don't count, and the days are kept sensible.
    const later = computeMetrics(ledger, events, { days: 7, now: new Date(t0 + 8 * 24 * H) });
    assert.deepEqual([later.runs.started, later.autonomy.rate, later.cost.perChangeUsd, later.leadTime.toReady.medianMs, later.failures, later.policies], [0, null, null, null, [], []]);
    assert.equal(computeMetrics(ledger, events, { days: 9, now: new Date(t0 + 8 * 24 * H) }).runs.started, 3);
    assert.deepEqual([computeMetrics(ledger, [], { days: 0 }).window.days, computeMetrics(ledger, [], { days: 10_000 }).window.days], [1, 365]);
  } finally {
    ledger.close();
  }
});

test("GET /metrics after a real run (scripted agents): a repair, a person's merge and a person's release", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "sf-metrics-ws-"));
  writeFileSync(path.join(workspace, "README.md"), "# Demo\n");
  await ensureRepo(workspace);
  const fake = await startFakeOpenHands({ onMessage: scriptedAgents() });
  const ledger = openLedger(":memory:");
  const o = createOrchestrator({ ledger, client: new OpenHandsClient({ baseUrl: fake.url }), workspace, dataDir: mkdtempSync(path.join(tmpdir(), "sf-metrics-run-")), graceMs: 0 });
  const app = createAutopilotRoutes(o);
  try {
    const run = await o.createRun({ goal: "Let applicants check a claim's status", autonomy: "supervised", actor: "user:po" });
    for (let i = 0; i < 150 && ledger.getRun(run.id)?.state !== "released"; i++) {
      for (const item of ledger.listInbox({ runId: run.id })) {
        if (item.kind === "plan_approval") await o.decide(item.id, { choice: "approve" }, "user:po");
        if (item.kind === "merge_approval") await o.decide(item.id, { choice: "merge" }, "user:isso");
        if (item.kind === "release") await o.decide(item.id, { choice: "release" }, "user:alice");
      }
      await o.tick();
      await o.idle();
      await fake.settled();
    }
    assert.equal(ledger.getRun(run.id)?.state, "released");
    const res = await app.request("/metrics?days=7");
    assert.equal(res.status, 200);
    const m = (await res.json()) as ReturnType<typeof computeMetrics>;
    assert.equal(m.window.days, 7);
    assert.deepEqual(m.runs, { started: 1, released: 1, done: 0, failed: 0, cancelled: 0, active: 0 });
    assert.deepEqual(m.autonomy, { merged: 3, byPolicy: 2, byPerson: 1, rate: 0.667, runsWithoutPeople: 0, personDecisions: 3 });
    assert.equal(m.leadTime.toRelease.samples, 1);
    assert.ok(m.leadTime.toReady.medianMs! <= m.leadTime.toRelease.medianMs!);
    const spent = Math.round(ledger.runCost(run.id) * 100) / 100;
    assert.ok(spent > 0);
    assert.deepEqual([m.cost.totalUsd, m.cost.perChangeUsd], [spent, spent]);
    assert.deepEqual(m.failures, [{ reason: 'Gate "test" failed', count: 1 }], "WO-2's first try had a bug its test caught");
    assert.deepEqual(m.policies.map((p) => [p.hash, p.runs, p.released]), [[policyHash(DEFAULT_POLICY), 1, 1]]);
    assert.equal((await app.request("/metrics?days=nonsense")).status, 200);
  } finally {
    o.stop();
    await o.idle();
    await fake.close();
    ledger.close();
  }
});
