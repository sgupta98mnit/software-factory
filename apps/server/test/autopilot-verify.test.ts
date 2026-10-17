import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { type FakeConversation, type FakeHandler, type FakeProfile, startFakeOpenHands } from "./fake-openhands.js";

// Audit log and worktrees in a temp folder, and never the real workspace, before config is read.
const dataRoot = mkdtempSync(path.join(tmpdir(), "sf-verify-data-"));
process.env.SF_DATA_DIR = dataRoot;
process.env.SF_WORKSPACE = mkdtempSync(path.join(tmpdir(), "sf-verify-unused-"));
delete process.env.SF_AUTONOMY_CAP;
const { createOrchestrator } = await import("../src/autopilot/orchestrator.js");
const { openLedger } = await import("../src/autopilot/ledger.js");
const { OpenHandsClient } = await import("../src/autopilot/openhands.js");
const { currentBranch, git, headSha } = await import("../src/autopilot/git.js");
const { audit, listAudit } = await import("../src/audit.js");

const CLAUDE: FakeProfile = { id: "11111111-1111-4111-8111-111111111111", name: "claude", agent_kind: "acp", acp_server: "claude-code" };
const CODEX: FakeProfile = { id: "22222222-2222-4222-8222-222222222222", name: "codex", agent_kind: "acp", acp_server: "codex" };
const PASS = 'Reviewed.\n\n```json\n{"verdict":"pass","findings":[]}\n```';
const flushAudit = () => audit("test", "test.flush", "test");
/** Runs here are in suggest mode, so work that passes verify waits for a merge approval, worktree and branch intact. */
const PASSED = "awaiting_merge_approval";

/** Plays a builder: a tiny node:test package whose one test passes only when `sum` adds. */
function writePackage(dir: string, body: "a + b" | "a - b") {
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "wo", private: true, type: "module", scripts: { test: "node --test" } }));
  writeFileSync(path.join(dir, "sum.js"), `export const sum = (a, b) => ${body};\n`);
  writeFileSync(
    path.join(dir, "sum.test.js"),
    'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { sum } from "./sum.js";\ntest("sum adds", () => assert.equal(sum(1, 2), 3));\n',
  );
  return { response: "Built it and tested it.", cost: 0.1 };
}

/** Handlers by the conversation's role tag; reviewers pass unless told otherwise. */
function byRole(roles: Partial<Record<string, FakeHandler>>): FakeHandler {
  return (conv, text) => (roles[conv.tags.sfrole ?? ""] ?? (() => ({ response: PASS, cost: 0.02 })))(conv, text);
}

async function setup(handler: FakeHandler) {
  const workspace = mkdtempSync(path.join(tmpdir(), "sf-verify-ws-"));
  writeFileSync(path.join(workspace, "README.md"), "# Demo\n");
  const dataDir = mkdtempSync(path.join(dataRoot, "case-"));
  const fake = await startFakeOpenHands({ onMessage: handler, profiles: [CLAUDE, CODEX] });
  const ledger = openLedger(path.join(dataDir, "autopilot.db"));
  const o = createOrchestrator({ ledger, client: new OpenHandsClient({ baseUrl: fake.url }), workspace, dataDir, graceMs: 0 });
  const t = {
    workspace,
    fake,
    ledger,
    o,
    async until(done: () => boolean, max = 60) {
      for (let i = 0; i < max; i++) {
        await o.tick();
        await o.idle();
        await fake.settled();
        if (done()) return;
      }
      assert.fail("the run didn't get there");
    },
    async close() {
      o.stop();
      await o.idle();
      await fake.close();
      ledger.close();
    },
    /** A run in building with independent work orders 1..n, skipping the spec stage. */
    async buildingRun(n = 1) {
      const run = await o.createRun({ goal: "Add claim status lookup", autonomy: "suggest", actor: "user:test" });
      const seqs = Array.from({ length: n }, (_, i) => i + 1);
      ledger.addWorkOrders(run.id, seqs.map((seq) => ({ seq, title: `Task ${seq}`, acceptance: [`Criterion ${seq}.1`], controls: [], dependsOn: [], wave: 1, risk: "low" as const })));
      return ledger.updateRun(run.id, { state: "building" });
    },
    wo: (runId: string, seq = 1) => ledger.getWorkOrder(`${runId}/WO-${seq}`)!,
    attempts: (runId: string, role: "builder" | "reviewer", seq = 1) => ledger.listAttempts({ runId, workOrderId: `${runId}/WO-${seq}`, role }),
    // Gate results (the secret and dependency scans have their own tests in autopilot-scan.test.ts).
    checks: (runId: string, seq = 1) =>
      ledger
        .listChecks({ runId, workOrderId: `${runId}/WO-${seq}` })
        .filter((c) => !c.name.endsWith("-scan"))
        .map((c) => `${c.name}:${c.ok ? "ok" : "failed"}`),
    conv: (id: string | undefined) => fake.conversations.get(id ?? "") as FakeConversation,
  };
  return t;
}

const auditOf = async (runId: string, action: string) => {
  await flushAudit();
  return listAudit()
    .filter((e) => e.subject === runId && e.action === action)
    .reverse();
};

test("verify: passing code -> gates pass -> a reviewer from another vendor passes it -> merge approval; the reviewer's edits and commit are thrown away", async () => {
  const t = await setup(
    byRole({
      builder: (conv) => writePackage(conv.workingDir, "a + b"),
      reviewer: async (conv) => {
        // A reviewer that edits and commits, though told not to.
        writeFileSync(path.join(conv.workingDir, "sum.js"), "export const sum = () => 3;\n");
        await git(conv.workingDir, ["commit", "-am", "Simplify"]);
        await git(conv.workingDir, ["checkout", "-q", "-b", "reviewer-peek"]); // and leaves the worktree on its own branch
        writeFileSync(path.join(conv.workingDir, "notes.txt"), "stray\n");
        return { response: PASS };
      },
    }),
  );
  try {
    const run = await t.buildingRun();
    await t.until(() => t.wo(run.id).state === PASSED);
    const wo = t.wo(run.id);
    assert.deepEqual(t.checks(run.id), ["test:ok", "reviewer-edits-discarded:failed"]);

    const [builder] = t.attempts(run.id, "builder");
    assert.equal(builder?.turns, 1);
    assert.equal(builder?.agentProfile, CLAUDE.id);
    const reviewers = t.attempts(run.id, "reviewer");
    assert.equal(reviewers.length, 1);
    assert.equal(reviewers[0]?.agentProfile, CODEX.id); // another vendor than the builder
    assert.equal((reviewers[0]?.result as { verdict?: string }).verdict, "pass");
    const conv = t.conv(reviewers[0]?.conversationId);
    assert.deepEqual(conv.tags, { sfrun: run.id, sfrole: "reviewer", sfwo: "1" });
    assert.equal(conv.workingDir, wo.worktree);
    assert.ok(conv.messages[0]?.includes(`git diff ${wo.baseSha}...HEAD`));

    // The branch is the builder's work, as the factory committed it.
    const builtSha = (builder?.result as { sha: string }).sha;
    assert.equal(await headSha(t.workspace, wo.branch!), builtSha);
    assert.equal(await currentBranch(wo.worktree!), wo.branch); // back on the work order's branch
    assert.equal(await headSha(wo.worktree!), builtSha);
    assert.equal((await git(t.workspace, ["log", "-1", "--format=%s", wo.branch!])).stdout.trim(), "WO-1: Task 1");
    assert.match(readFileSync(path.join(wo.worktree!, "sum.js"), "utf8"), /a \+ b/);
    assert.equal(existsSync(path.join(wo.worktree!, "notes.txt")), false);

    assert.deepEqual((await auditOf(run.id, "autopilot.gates_run")).map((e) => [e.data.ok, e.data.gates]), [[true, ["test"]]]);
    assert.deepEqual((await auditOf(run.id, "autopilot.review_verdict")).map((e) => [e.data.verdict, e.data.passed]), [["pass", true]]);
    assert.deepEqual((await auditOf(run.id, "autopilot.edits_discarded")).map((e) => [e.data.role, e.data.committed]), [["reviewer", true]]);
  } finally {
    await t.close();
  }
});

test("repair: a failing test goes back to the same builder with the gate's output; fixed, it passes", async () => {
  const t = await setup(
    byRole({
      builder: (conv) => writePackage(conv.workingDir, conv.messages.length === 1 ? "a - b" : "a + b"),
    }),
  );
  try {
    const run = await t.buildingRun();
    await t.until(() => t.wo(run.id).state === PASSED);
    const builders = t.attempts(run.id, "builder");
    assert.equal(builders.length, 1);
    assert.equal(builders[0]?.turns, 2);
    const followUp = t.conv(builders[0]?.conversationId).messages[1] ?? "";
    assert.match(followUp, /isn't done yet/);
    assert.match(followUp, /Gate test: `npm run test` failed with exit code 1/);
    assert.match(followUp, /sum adds/); // the test output
    assert.deepEqual(t.checks(run.id), ["test:failed", "test:ok"]);
    assert.equal(t.wo(run.id).findings?.[0]?.source, "gate");
    assert.deepEqual((await auditOf(run.id, "autopilot.repair_requested")).map((e) => [e.data.builder, e.data.turn]), [[1, 2]]);
  } finally {
    await t.close();
  }
});

test("repair: still failing after two follow-ups goes to a fresh builder in a recreated worktree, then to a person; retry is one more fresh builder", async () => {
  let fixed = false;
  const freshTree = new Map<string, boolean>(); // conversation -> sum.js was absent when it started
  const t = await setup(
    byRole({
      builder: (conv) => {
        if (conv.messages.length === 1) freshTree.set(conv.id, !existsSync(path.join(conv.workingDir, "sum.js")));
        return writePackage(conv.workingDir, fixed ? "a + b" : "a - b");
      },
    }),
  );
  try {
    const run = await t.buildingRun();
    const failedItem = () => t.ledger.listInbox({ runId: run.id }).find((i) => i.kind === "work_order_failed");
    await t.until(() => !!failedItem(), 80);
    assert.equal(t.wo(run.id).state, "needs_attention");
    const builders = t.attempts(run.id, "builder");
    assert.deepEqual(builders.map((a) => a.turns), [3, 3]);
    assert.deepEqual(builders.map((a) => freshTree.get(a.conversationId)), [true, true]);
    assert.match(t.conv(builders[1]?.conversationId).messages[0] ?? "", /A previous attempt at this work order failed:\n\n- \(high\) Gate test: `npm run test` failed/);
    assert.equal(t.attempts(run.id, "reviewer").length, 0);
    assert.equal(t.checks(run.id).filter((c) => c === "test:failed").length, 6);

    const item = failedItem()!;
    assert.deepEqual(item.options.map((o) => o.id), ["retry", "skip", "cancel"]);
    assert.match(item.body, /After 2 builder conversation\(s\) it still fails:\n\n- \(high\) Gate test/);
    const repairs = await auditOf(run.id, "autopilot.repair_requested");
    assert.deepEqual(repairs.map((e) => [e.data.builder, e.data.turn]), [[1, 2], [1, 3], [2, 1], [2, 2], [2, 3]]);
    assert.equal((await auditOf(run.id, "autopilot.work_order_failed")).length, 1);

    fixed = true;
    await t.o.decide(item.id, { choice: "retry" }, "user:test");
    await t.until(() => t.wo(run.id).state === PASSED);
    assert.deepEqual(t.attempts(run.id, "builder").map((a) => a.turns), [3, 3, 1]);
  } finally {
    await t.close();
  }
});

test("repair: a reviewer's critical finding goes back to the builder, clustered by scenario; the next review passes", async () => {
  const FAIL = [
    "Two problems.",
    "```json",
    JSON.stringify({
      verdict: "fail",
      findings: [
        { severity: "low", criterion: null, scenario: null, file: null, issue: "Name the test better", fix: "" },
        { severity: "critical", criterion: 1, scenario: "Unknown claim", file: "src/routes.ts", issue: "expected 404, got 500", fix: "Return 404 when the claim isn't found" },
      ],
    }),
    "```",
  ].join("\n");
  const t = await setup(
    byRole({
      builder: (conv) => writePackage(conv.workingDir, "a + b"),
      reviewer: () => ({ response: t.ledger.listAttempts({ runId: runId!, role: "reviewer" }).length === 1 ? FAIL : PASS }),
    }),
  );
  let runId: string | undefined;
  try {
    const run = await t.buildingRun();
    runId = run.id;
    await t.until(() => t.wo(run.id).state === PASSED);
    const [builder] = t.attempts(run.id, "builder");
    assert.equal(builder?.turns, 2);
    const followUp = t.conv(builder?.conversationId).messages[1] ?? "";
    assert.match(followUp, /- Scenario "Unknown claim": \(critical\) expected 404, got 500 \(src\/routes\.ts\)\. Fix: Return 404 when the claim isn't found\n- \(low\) Name the test better/);
    const reviewers = t.attempts(run.id, "reviewer");
    assert.equal(reviewers.length, 2);
    assert.notEqual(reviewers[0]?.conversationId, reviewers[1]?.conversationId); // each review starts clean
    assert.deepEqual(t.checks(run.id), ["test:ok", "test:ok"]);
    assert.deepEqual((await auditOf(run.id, "autopilot.review_verdict")).map((e) => [e.data.verdict, e.data.passed]), [["fail", false], ["pass", true]]);
  } finally {
    await t.close();
  }
});

test("a reviewer with no readable verdict, even when asked again, stops only its work order with an error item; retry starts a new reviewer", async () => {
  let readable = false;
  const t = await setup(
    byRole({
      builder: (conv) => writePackage(conv.workingDir, "a + b"),
      reviewer: () => ({ response: readable ? PASS : "Looks fine to me." }),
    }),
  );
  try {
    const run = await t.buildingRun(2);
    const errorItem = (seq: number) => t.ledger.listInbox({ runId: run.id }).find((i) => i.kind === "error" && i.workOrderId === `${run.id}/WO-${seq}`);
    await t.until(() => t.ledger.listWorkOrders(run.id).every((w) => w.state === "needs_attention"));
    const item = errorItem(1)!;
    assert.deepEqual(item.options.map((o) => o.id), ["retry", "skip", "cancel"]);
    assert.match(item.body, /While in \*\*reviewing\*\*:\n\nThe reviewer's reply had no readable verdict, even when asked again\./);
    assert.equal(t.ledger.getRun(run.id)?.state, "building"); // the run goes on
    const [reviewer] = t.attempts(run.id, "reviewer");
    assert.equal(reviewer?.turns, 2);
    assert.match(t.conv(reviewer?.conversationId).messages[1] ?? "", /only the fenced json block/);
    assert.equal(t.wo(run.id).resumeState, "reviewing");

    readable = true;
    await t.o.decide(item.id, { choice: "retry" }, "user:test");
    await t.until(() => t.wo(run.id).state === PASSED);
    assert.equal(t.attempts(run.id, "reviewer").length, 2);
    assert.equal(t.attempts(run.id, "builder").length, 1); // the build wasn't redone

    // Skip on a work order's error item lets it go.
    await t.o.decide(errorItem(2)!.id, { choice: "skip" }, "user:test");
    assert.equal(t.wo(run.id, 2).state, "skipped");
  } finally {
    await t.close();
  }
});

test("three work orders needing attention pause the run with a run_paused item; resuming lets their own items be decided", async () => {
  const t = await setup(
    byRole({
      builder: (conv) => {
        if (conv.tags.sfwo !== "4") throw new Error("Out of credits");
        return writePackage(conv.workingDir, "a + b");
      },
    }),
  );
  try {
    const run = await t.buildingRun(4);
    await t.until(() => t.ledger.getRun(run.id)?.state === "paused", 80);
    const wos = t.ledger.listWorkOrders(run.id);
    assert.deepEqual(wos.filter((w) => w.state === "needs_attention").map((w) => w.seq), [1, 2, 3]);
    const failedFirst = t.attempts(run.id, "builder", 1);
    assert.deepEqual(failedFirst.map((a) => [a.state, a.turns]), [["error", 3], ["error", 3]]); // agent stops are repair rounds too
    assert.match(t.conv(failedFirst[0]?.conversationId).messages[1] ?? "", /The builder stopped with status "error"\. Its last message: Out of credits/);

    const items = t.ledger.listInbox({ runId: run.id });
    const paused = items.find((i) => i.kind === "run_paused")!;
    assert.deepEqual(paused.options.map((o) => o.id), ["resume", "cancel"]);
    assert.match(paused.body, /- WO-1: Task 1\n- WO-2: Task 2\n- WO-3: Task 3/);
    const run2 = t.ledger.getRun(run.id)!;
    assert.deepEqual([run2.resumeState, run2.pausedReason], ["building", "3 work orders need attention"]);

    const wo1Item = items.find((i) => i.kind === "work_order_failed" && i.workOrderId === `${run.id}/WO-1`)!;
    await assert.rejects(t.o.decide(wo1Item.id, { choice: "skip" }, "user:test"), /Resume it first/);
    await t.o.decide(paused.id, { choice: "resume" }, "user:test");
    assert.equal(t.ledger.getRun(run.id)?.state, "building");
    await t.o.decide(wo1Item.id, { choice: "skip" }, "user:test");
    await t.until(() => t.wo(run.id, 4).state === PASSED);
    assert.equal(t.ledger.getRun(run.id)?.state, "building"); // no new failure, no new pause

    const pauses = await auditOf(run.id, "autopilot.run_paused");
    assert.deepEqual(pauses.map((e) => [e.actor, e.data.failing]), [["autopilot", 3]]);
  } finally {
    await t.close();
  }
});

test("a dispatch that throws stops only its work order, with an error item whose retry dispatches it again", async () => {
  const t = await setup(byRole({ builder: (conv) => writePackage(conv.workingDir, "a + b") }));
  try {
    const run = await t.buildingRun();
    const tip = await headSha(t.workspace, run.integrationBranch);
    // A ref in the way of the work order's branch name (git can't have both x and x/y): its worktree can't be made.
    const blocker = `refs/heads/${run.integrationBranch}--wo-1/blocker`;
    await git(t.workspace, ["update-ref", blocker, tip]);
    await t.until(() => t.wo(run.id).state === "needs_attention");
    assert.equal(t.ledger.getRun(run.id)?.state, "building");
    const item = t.ledger.listInbox({ runId: run.id }).find((i) => i.kind === "error" && i.workOrderId === `${run.id}/WO-1`)!;
    assert.deepEqual(item.options.map((o) => o.id), ["retry", "skip", "cancel"]);
    assert.equal(t.wo(run.id).resumeState, "pending");

    await git(t.workspace, ["update-ref", "-d", blocker]);
    await t.o.decide(item.id, { choice: "retry" }, "user:test");
    await t.until(() => t.wo(run.id).state === PASSED);
  } finally {
    await t.close();
  }
});
