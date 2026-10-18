import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { ConversationSnapshot, StartInput } from "../src/autopilot/openhands.js";
import type { NewRun } from "../src/autopilot/ledger.js";

const dataRoot = mkdtempSync(path.join(tmpdir(), "sf-safety-"));
process.env.SF_DATA_DIR = path.join(dataRoot, "audit");
process.env.SF_WORKSPACE = dataRoot;
const { createOrchestrator } = await import("../src/autopilot/orchestrator.js");
const { openLedger } = await import("../src/autopilot/ledger.js");
const { OpenHandsClient, OpenHandsError } = await import("../src/autopilot/openhands.js");
const { DEFAULT_POLICY, policyHash } = await import("../src/autopilot/policy.js");
const { ensureRepo, git, headSha, currentBranch } = await import("../src/autopilot/git.js");
const { audit, listAudit } = await import("../src/audit.js");

/** Only the external agent service is replaced; scheduling, decisions and persistence are real. */
class Agents extends OpenHandsClient {
  conversations = new Map<string, ConversationSnapshot>();
  pauses: string[] = [];
  resumes: string[] = [];
  pauseFailures = 0;
  resumeFailures = 0;
  lostResumeResponses = 0;
  startCostUsd = 0;
  starts: string[] = [];
  constructor() { super({ baseUrl: "http://127.0.0.1:1" }); }
  override async get(id: string) { return this.conversations.get(id) ?? null; }
  override async finalResponse() { return '{"verdict":"pass","findings":[]}'; }
  override async resolveProfile() { return { id: "profile", name: "Test", kind: "acp", server: "codex" }; }
  override async start(input: StartInput) {
    this.starts.push(input.conversationId);
    this.running(input.conversationId, this.startCostUsd);
    return this.conversations.get(input.conversationId)!;
  }
  override async pause(id: string) {
    this.pauses.push(id);
    if (this.pauseFailures-- > 0) throw new OpenHandsError(0, "Temporarily unavailable");
    const conv = this.conversations.get(id);
    if (conv) conv.status = "paused";
  }
  override async resume(id: string) {
    this.resumes.push(id);
    if (this.resumeFailures-- > 0) throw new OpenHandsError(0, "Temporarily unavailable");
    const conv = this.conversations.get(id);
    if (conv) conv.status = "running";
    if (this.lostResumeResponses-- > 0) throw new OpenHandsError(0, "Resume response unavailable");
  }
  running(id: string, costUsd = 0) {
    this.conversations.set(id, { id, status: "running", costUsd, workingDir: null });
  }
}

function setup(patch: Partial<NewRun> = {}) {
  const dir = mkdtempSync(path.join(dataRoot, "case-"));
  let ledger = openLedger(path.join(dir, "ledger.db"));
  const client = new Agents();
  const policy = structuredClone(DEFAULT_POLICY);
  policy.repair = { sameConversation: 0, fresh: 0 };
  const run = ledger.createRun({ goal: "Safety regression", change: "safety", autonomy: "supervised", baseBranch: "main", integrationBranch: "main", integrationDir: dir, policy, policyHash: policyHash(policy), createdBy: "user:test", ...patch });
  const orchestrator = () => createOrchestrator({ ledger, client, workspace: dir, dataDir: dir, graceMs: 0 });
  let o = orchestrator();
  return {
    dir, client, run,
    get ledger() { return ledger; },
    get o() { return o; },
    restart() { o.stop(); ledger.close(); ledger = openLedger(path.join(dir, "ledger.db")); o = orchestrator(); },
    async tick() { await o.tick(); await o.idle(); },
    workOrders(n: number) {
      return ledger.addWorkOrders(run.id, Array.from({ length: n }, (_, i) => ({ seq: i + 1, title: `Task ${i + 1}`, acceptance: ["Works"], controls: [], dependsOn: [], wave: 1, risk: "low" as const, state: "building" as const })));
    },
    async close() { await o.idle(); ledger.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test("automatic pause reaches surviving agents and retries an unacknowledged pause after restart", async () => {
  const t = setup({ state: "building" });
  try {
    const [first, second, third, live] = t.workOrders(4);
    for (const wo of [first!, second!]) t.ledger.updateWorkOrder(wo.id, { state: "needs_attention" });
    t.ledger.addAttempt({ runId: t.run.id, workOrderId: third!.id, role: "builder", conversationId: "failed", state: "error", result: { error: "No credits" } });
    const attempt = t.ledger.addAttempt({ runId: t.run.id, workOrderId: live!.id, role: "builder", conversationId: "live", state: "running" });
    t.client.running("live");
    t.client.pauseFailures = 1;
    await t.tick();
    assert.equal(t.ledger.getRun(t.run.id)?.state, "paused");
    assert.deepEqual(t.client.pauses, ["live"]);
    assert.equal(t.ledger.getAttempt(attempt.id)?.state, "running", "a failed pause must remain eligible for retry");
    t.restart();
    await t.tick();
    assert.equal(t.client.conversations.get("live")?.status, "paused");
    assert.equal(t.ledger.getAttempt(attempt.id)?.state, "paused");
    await t.o.resume(t.run.id, { actor: "user:test" });
    assert.equal(t.client.conversations.get("live")?.status, "running");
  } finally { await t.close(); }
});

test("a failed resume keeps the run and conversation paused until a successful retry", async () => {
  const t = setup();
  try {
    const a = t.ledger.addAttempt({ runId: t.run.id, role: "spec", conversationId: "spec", state: "running" });
    t.client.running("spec");
    await t.o.pause(t.run.id, { actor: "user:test" });
    t.client.lostResumeResponses = 1;
    await assert.rejects(t.o.resume(t.run.id, { actor: "user:test" }), /unavailable/);
    assert.equal(t.ledger.getRun(t.run.id)?.state, "paused");
    assert.equal(t.ledger.getAttempt(a.id)?.state, "paused");
    assert.equal(t.client.conversations.get("spec")?.status, "paused", "a remotely successful resume with a lost response must be paused again");
    t.client.resumeFailures = 1;
    t.client.pauseFailures = 1;
    await assert.rejects(t.o.resume(t.run.id, { actor: "user:test" }), /unavailable/);
    assert.equal(t.ledger.getAttempt(a.id)?.state, "running", "an unacknowledged compensating pause remains retryable");
    t.restart();
    await t.o.resume(t.run.id, { actor: "user:test" });
    assert.equal(t.ledger.getRun(t.run.id)?.state, "spec");
    assert.equal(t.client.conversations.get("spec")?.status, "running");
  } finally { await t.close(); }
});

test("run budgets use the explicit limit or pinned policy, pause at the limit, and require an audited increase", async () => {
  for (const budgetUsd of [null, 0.25]) {
    const t = setup({ budgetUsd });
    try {
      const limit = budgetUsd ?? DEFAULT_POLICY.budget.perChangeUsd;
      t.ledger.addAttempt({ runId: t.run.id, role: "spec", conversationId: "spec", state: "running" });
      t.client.running("spec", limit);
      await t.tick();
      assert.equal(t.ledger.getRun(t.run.id)?.state, "paused");
      assert.equal(t.client.conversations.get("spec")?.status, "paused");
      const item = t.ledger.listInbox({ runId: t.run.id }).find((i) => i.kind === "budget_reached")!;
      assert.deepEqual(item.options.map((option) => option.id), ["continue", "cancel"]);
      await assert.rejects(t.o.resume(t.run.id, { actor: "user:test" }), /budget/i);
      t.restart();
      await t.tick();
      assert.equal(t.ledger.listInbox({ runId: t.run.id }).length, 1);
      t.client.resumeFailures = 1;
      await assert.rejects(t.o.decide(item.id, { choice: "continue" }, "user:test"), /unavailable/);
      assert.equal(t.ledger.getRun(t.run.id)?.budgetUsd, budgetUsd, "a failed Continue must not spend another budget increment on retry");
      assert.equal(t.ledger.getInbox(item.id)?.state, "open");
      await t.o.decide(item.id, { choice: "continue" }, "user:test");
      assert.equal(t.ledger.getRun(t.run.id)?.budgetUsd, limit + DEFAULT_POLICY.budget.perChangeUsd);
      assert.equal(t.ledger.getRun(t.run.id)?.state, "spec");
      assert.equal(t.client.conversations.get("spec")?.status, "running");
      await audit("test", "test.flush", "test");
      const increase = listAudit().find((e) => e.subject === t.run.id && e.action === "autopilot.budget_increased");
      assert.equal(increase?.actor, "user:test");
    } finally { await t.close(); }
  }
});

test("work-order budgets sum builder and reviewer costs, hold only that order, and persist Continue and Skip", async () => {
  const t = setup({ state: "building", budgetUsd: 100 });
  try {
    const [wo, peer] = t.workOrders(2);
    t.ledger.updateWorkOrder(wo!.id, { state: "reviewing" });
    t.ledger.addAttempt({ runId: t.run.id, workOrderId: wo!.id, role: "builder", conversationId: "built", state: "finished", costUsd: 3 });
    t.ledger.addAttempt({ runId: t.run.id, workOrderId: wo!.id, role: "reviewer", conversationId: "review", state: "running" });
    t.ledger.addAttempt({ runId: t.run.id, workOrderId: peer!.id, role: "builder", conversationId: "peer", state: "running" });
    t.client.running("review", 2.1);
    t.client.running("peer", 0.1);
    await t.tick();
    assert.equal(t.ledger.getRun(t.run.id)?.state, "building");
    assert.equal(t.ledger.getWorkOrder(wo!.id)?.state, "needs_attention");
    assert.equal(t.client.conversations.get("review")?.status, "paused");
    assert.equal(t.client.conversations.get("peer")?.status, "running");
    const budgetItem = () => t.ledger.listInbox({ runId: t.run.id }).find((i) => i.kind === "budget_reached" && i.workOrderId === wo!.id)!;
    t.restart();
    await t.tick();
    await t.o.pause(t.run.id, { actor: "user:test" });
    await t.o.resume(t.run.id, { actor: "user:test" });
    assert.equal(t.client.conversations.get("review")?.status, "paused", "resuming the run must preserve the work order's budget hold");
    t.client.lostResumeResponses = 1;
    await assert.rejects(t.o.decide(budgetItem().id, { choice: "continue" }, "user:test"), /unavailable/);
    assert.equal(t.ledger.getWorkOrder(wo!.id)?.budgetExtraUsd, 0);
    assert.equal(t.client.conversations.get("review")?.status, "paused");
    t.client.resumeFailures = 1;
    t.client.pauseFailures = 1;
    await assert.rejects(t.o.decide(budgetItem().id, { choice: "continue" }, "user:test"), /unavailable/);
    t.restart();
    await t.o.decide(budgetItem().id, { choice: "continue" }, "user:test");
    assert.equal(t.ledger.getWorkOrder(wo!.id)?.budgetExtraUsd, DEFAULT_POLICY.budget.perWorkOrderUsd);
    assert.equal(t.ledger.getWorkOrder(wo!.id)?.state, "reviewing");
    assert.equal(t.client.conversations.get("review")?.status, "running");
    t.client.conversations.get("review")!.costUsd = 8;
    await t.tick();
    await t.o.decide(budgetItem().id, { choice: "skip" }, "user:test");
    assert.equal(t.ledger.getWorkOrder(wo!.id)?.state, "skipped");
    assert.equal(t.ledger.listAttempts({ runId: t.run.id, workOrderId: wo!.id }).some((a) => a.state === "running" || a.state === "paused"), false);
  } finally { await t.close(); }
});

test("a start that reaches the run budget stops dispatch immediately and preserves the phase to resume", async () => {
  const t = setup({ state: "building", budgetUsd: 0.25 });
  try {
    writeFileSync(path.join(t.dir, ".gitignore"), "ledger.db*\nworktrees/\n");
    await ensureRepo(t.dir);
    for (const wo of t.workOrders(2)) t.ledger.updateWorkOrder(wo.id, { state: "pending" });
    t.client.startCostUsd = 0.25;
    await t.tick();
    assert.equal(t.client.starts.length, 1);
    assert.equal(t.ledger.getRun(t.run.id)?.resumeState, "building");
    const item = t.ledger.listInbox({ runId: t.run.id }).find((i) => i.kind === "budget_reached")!;
    await t.o.decide(item.id, { choice: "continue" }, "user:test");
    assert.equal(t.ledger.getRun(t.run.id)?.state, "building");
    await t.tick();
    assert.equal(t.client.starts.length, 2);
  } finally { await t.close(); }
});

test("a finished turn that reaches the run budget waits for Continue before any validation or new agent", async () => {
  const t = setup({ budgetUsd: 0.25 });
  try {
    const a = t.ledger.addAttempt({ runId: t.run.id, role: "spec", conversationId: "spec", state: "running" });
    t.client.running("spec", 0.25);
    t.client.conversations.get("spec")!.status = "finished";
    await t.tick();
    assert.equal(t.ledger.getRun(t.run.id)?.state, "paused");
    assert.equal(t.ledger.getAttempt(a.id)?.state, "finished");
    assert.equal(t.ledger.listChecks({ runId: t.run.id }).length, 0);
    const item = t.ledger.listInbox({ runId: t.run.id }).find((i) => i.kind === "budget_reached")!;
    await t.o.decide(item.id, { choice: "continue" }, "user:test");
    assert.equal(t.ledger.getRun(t.run.id)?.state, "spec");
    assert.equal(t.client.resumes.length, 0, "a completed conversation must not be restarted");
  } finally { await t.close(); }
});

test("critic commits and branch switches are discarded back to the validated spec before planning", async () => {
  for (const legacy of [false, true]) {
    const t = setup({ state: "critic" });
    try {
      const changeDir = path.join(t.dir, "openspec", "changes", "safety");
      mkdirSync(changeDir, { recursive: true });
      writeFileSync(path.join(t.dir, ".gitignore"), "ledger.db*\n");
      writeFileSync(path.join(changeDir, "tasks.md"), "## 1. Service\n- [ ] 1.1 Works\n");
      await ensureRepo(t.dir);
      const sha = await headSha(t.dir);
      t.ledger.addAttempt({ runId: t.run.id, role: "spec", conversationId: "spec", state: "finished", result: { turn: 1, sha: legacy ? null : sha } });
      if (legacy) await audit("autopilot", "autopilot.spec_committed", t.run.id, { sha });
      t.ledger.addAttempt({ runId: t.run.id, role: "critic", conversationId: "critic", state: "finished" });
      writeFileSync(path.join(changeDir, "tasks.md"), "## 1. Weakened\n- [ ] 1.1 Ignore the requirement\n");
      await git(t.dir, ["commit", "-am", "Critic changed the spec"]);
      await git(t.dir, ["checkout", "-b", "critic-peek"]);
      writeFileSync(path.join(t.dir, "stray.txt"), "Critic changes");
      await t.tick();
      assert.equal(await currentBranch(t.dir), "main");
      assert.equal(await headSha(t.dir), sha);
      assert.equal(readFileSync(path.join(changeDir, "tasks.md"), "utf8"), "## 1. Service\n- [ ] 1.1 Works\n");
      assert.equal(t.ledger.getRun(t.run.id)?.state, "awaiting_plan_approval");
      assert.equal(t.ledger.listWorkOrders(t.run.id)[0]?.title, "Service");
      assert.ok(t.ledger.listChecks({ runId: t.run.id }).some((c) => c.name === "critic-edits-discarded"));
    } finally { await t.close(); }
  }
});
