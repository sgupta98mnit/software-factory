import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { type FakeConversation, type FakeHandler, startFakeOpenHands } from "./fake-openhands.js";

// Audit log and worktrees in a temp folder, and never the real workspace, before config is read.
const dataRoot = mkdtempSync(path.join(tmpdir(), "sf-e2e-data-"));
process.env.SF_DATA_DIR = dataRoot;
process.env.SF_WORKSPACE = mkdtempSync(path.join(tmpdir(), "sf-e2e-unused-"));
delete process.env.SF_AUTONOMY_CAP;
const { createOrchestrator } = await import("../src/autopilot/orchestrator.js");
const { openLedger } = await import("../src/autopilot/ledger.js");
const { OpenHandsClient } = await import("../src/autopilot/openhands.js");
const { branchExists, fileAt, git, headSha } = await import("../src/autopilot/git.js");
const { audit, listAudit } = await import("../src/audit.js");
const { DEFAULT_POLICY, loadPolicy, policyHash } = await import("../src/autopilot/policy.js");

// The demo workspace's OpenSpec folder, copied (never changed) into the full run's workspace.
const FIXTURE = path.resolve(import.meta.dirname, "../../../workspaces/benefits-portal/openspec");
const EXAMPLE = "add-claim-status-lookup";
const PASS = 'Reviewed.\n\n```json\n{"verdict":"pass","findings":[]}\n```';
// The same in every work order, so it merges cleanly.
const PKG = JSON.stringify({ name: "demo", private: true, type: "module", scripts: { test: "node --test" } });

/** Groups 1 and 2 build in parallel; 3 uses both. */
const THREE = `## 1. Sum
Depends on: none
- [ ] 1.1 Export sum(a, b) from wo-1.js

## 2. Product
Depends on: none
- [ ] 2.1 Export product(a, b) from wo-2.js

## 3. Report
Depends on: 1, 2
- [ ] 3.1 Export report(a, b) from wo-3.js, built on sum and product
`;

const CODE: Record<string, string> = {
  "1": "export const sum = (a, b) => a + b;\n",
  "2": "export const product = (a, b) => a * b;\n",
  "3": 'import { sum } from "./wo-1.js";\nimport { product } from "./wo-2.js";\nexport const report = (a, b) => `${sum(a, b)} ${product(a, b)}`;\n',
};

const testFile = (seq: string, body: string) =>
  `import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { existsSync } from "node:fs";\nimport * as m from "./wo-${seq}.js";\ntest("WO-${seq}", () => {\n${body}\n});\n`;

/** Plays a builder: wo-<seq>.js and a node:test for it. `check` replaces the test's default assertion. */
function build(conv: FakeConversation, check = "assert.ok(Object.keys(m).length);") {
  const seq = conv.tags.sfwo ?? "0";
  writeFileSync(path.join(conv.workingDir, "package.json"), PKG);
  writeFileSync(path.join(conv.workingDir, `wo-${seq}.js`), CODE[seq] ?? `export const wo${seq} = true;\n`);
  writeFileSync(path.join(conv.workingDir, `wo-${seq}.test.js`), testFile(seq, check));
  return { response: "Built it and tested it.", cost: 0.1 };
}

/** Handlers by the conversation's role tag; critics and reviewers pass. */
function byRole(roles: Partial<Record<string, FakeHandler>>): FakeHandler {
  return (conv, text) => (roles[conv.tags.sfrole ?? ""] ?? (() => ({ response: PASS, cost: 0.02 })))(conv, text);
}

const flushAudit = () => audit("test", "test.flush", "test");
/** A run's audit events with this action, oldest first. */
async function auditOf(runId: string, action: string) {
  await flushAudit();
  return listAudit(5000)
    .filter((e) => e.subject === runId && e.action === action)
    .reverse();
}

async function setup(handler: FakeHandler, opts: { fixture?: boolean } = {}) {
  const workspace = mkdtempSync(path.join(tmpdir(), "sf-e2e-ws-"));
  if (opts.fixture) cpSync(FIXTURE, path.join(workspace, "openspec"), { recursive: true });
  else writeFileSync(path.join(workspace, "README.md"), "# Demo\n");
  const dataDir = mkdtempSync(path.join(dataRoot, "case-"));
  const db = path.join(dataDir, "autopilot.db");
  const fake = await startFakeOpenHands({ onMessage: handler });
  const client = new OpenHandsClient({ baseUrl: fake.url });
  const t = {
    workspace,
    dataDir,
    fake,
    ledger: openLedger(db),
    o: undefined as unknown as ReturnType<typeof createOrchestrator>,
    /** A new orchestrator on the same database, as after a restart. */
    restart() {
      t.o?.stop();
      t.ledger.close();
      t.ledger = openLedger(db);
      t.o = createOrchestrator({ ledger: t.ledger, client, workspace, dataDir, graceMs: 0 });
    },
    async step(times = 1) {
      for (let i = 0; i < times; i++) {
        await t.o.tick();
        await t.o.idle();
        await fake.settled();
      }
    },
    async until(done: () => boolean, max = 80) {
      for (let i = 0; i < max; i++) {
        await t.step();
        if (done()) return;
      }
      assert.fail("the run didn't get there");
    },
    /** A run in building with independent work orders 1..n, skipping the spec stage. */
    async buildingRun(n: number, autonomy: "suggest" | "supervised" = "supervised") {
      const run = await t.o.createRun({ goal: "Add claim status lookup", autonomy, actor: "user:test" });
      const seqs = Array.from({ length: n }, (_, i) => i + 1);
      t.ledger.addWorkOrders(run.id, seqs.map((seq) => ({ seq, title: `Task ${seq}`, acceptance: [`Criterion ${seq}.1`], controls: [], dependsOn: [], wave: 1, risk: "low" as const })));
      return t.ledger.updateRun(run.id, { state: "building" });
    },
    wo: (runId: string, seq: number) => t.ledger.getWorkOrder(`${runId}/WO-${seq}`)!,
    states: (runId: string) => t.ledger.listWorkOrders(runId).map((w) => `${w.seq}:${w.state}`),
    builders: (runId: string, seq: number) => t.ledger.listAttempts({ runId, workOrderId: `${runId}/WO-${seq}`, role: "builder" }),
    integrateChecks: (runId: string, seq: number) =>
      t.ledger
        .listChecks({ runId, workOrderId: `${runId}/WO-${seq}` })
        .filter((c) => c.stage === "integrate")
        .map((c) => `${c.name}:${c.ok ? "ok" : "failed"}`),
    /** The integration branch's own merges, newest first (not those inside a work order's branch). */
    merges: async (branch: string) => (await git(workspace, ["log", "--merges", "--first-parent", "--format=%s", branch])).stdout.trim().split("\n").filter(Boolean),
    item: (runId: string, kind: string, seq: number) => t.ledger.listInbox({ runId }).find((i) => i.kind === kind && i.workOrderId === `${runId}/WO-${seq}`),
    async close() {
      t.o.stop();
      await t.o.idle();
      await fake.close();
      t.ledger.close();
    },
  };
  t.o = createOrchestrator({ ledger: t.ledger, client, workspace, dataDir, graceMs: 0 });
  return t;
}

test("e2e, supervised: goal -> spec -> plan approval -> three work orders in two waves -> each merged and re-tested -> done, with branches and worktrees cleaned up", async () => {
  const t = await setup(
    byRole({
      spec: (conv) => {
        const change = /The change is called `([^`]+)`/.exec(conv.messages[0] ?? "")?.[1] ?? "missing";
        const dir = path.join(conv.workingDir, "openspec", "changes", change);
        cpSync(path.join(conv.workingDir, "openspec", "changes", EXAMPLE), dir, { recursive: true });
        writeFileSync(path.join(dir, "tasks.md"), THREE);
        return { response: "Wrote the change.", cost: 0.3 };
      },
      builder: (conv) => build(conv),
    }),
    { fixture: true },
  );
  try {
    const run = await t.o.createRun({ goal: "Add a sum and product report", autonomy: "supervised", actor: "user:test" });
    const POLICY = `policy@${run.policyHash}`; // no policy.yml: the defaults
    assert.equal(run.policyHash, policyHash(DEFAULT_POLICY));
    const approval = () => t.ledger.listInbox({ runId: run.id }).find((i) => i.kind === "plan_approval");
    await t.until(() => !!approval());
    assert.deepEqual(t.ledger.listWorkOrders(run.id).map((w) => [w.seq, w.wave]), [[1, 1], [2, 1], [3, 2]]);
    await t.o.decide(approval()!.id, { choice: "approve" }, "user:test");

    await t.until(() => t.ledger.getRun(run.id)?.state === "done");
    const done = t.ledger.getRun(run.id)!;
    assert.deepEqual(t.states(run.id), ["1:merged", "2:merged", "3:merged"]);
    assert.equal(done.integrationDir, null);
    assert.equal(existsSync(path.join(t.dataDir, "worktrees", run.id, "integration")), false);

    // The integration branch is the deliverable: the spec and every merge, each re-tested there.
    const tip = await headSha(t.workspace, run.integrationBranch);
    const merges = await t.merges(run.integrationBranch);
    assert.equal(merges[0], "Merge WO-3: Report"); // the second wave merged last
    assert.deepEqual([...merges].sort(), ["Merge WO-1: Sum", "Merge WO-2: Product", "Merge WO-3: Report"]);
    for (const file of ["wo-1.js", "wo-2.js", "wo-3.js", `openspec/changes/${run.change}/tasks.md`]) {
      assert.notEqual(await fileAt(t.workspace, tip, file), null, file);
    }
    for (const seq of [1, 2, 3]) {
      const wo = t.wo(run.id, seq);
      assert.equal(wo.mergedBy, POLICY);
      assert.equal(wo.worktree, null);
      assert.equal(existsSync(path.join(t.dataDir, "worktrees", run.id, `wo-${seq}`)), false);
      assert.equal(await branchExists(t.workspace, wo.branch!), false);
      assert.deepEqual(t.integrateChecks(run.id, seq), ["test:ok"]);
    }
    assert.equal(await branchExists(t.workspace, run.integrationBranch), true);
    // WO-3 started from the integration branch with both of its dependencies merged.
    assert.notEqual(await fileAt(t.workspace, t.wo(run.id, 3).baseSha!, "wo-1.js"), null);
    assert.notEqual(await fileAt(t.workspace, t.wo(run.id, 3).baseSha!, "wo-2.js"), null);

    // Waves: 1 and 2 were built at the same time, before anything merged; 3 only after both merged.
    await flushAudit();
    const events = listAudit(5000)
      .filter((e) => e.subject === run.id)
      .reverse();
    const at = (action: string, wo: string) => events.findIndex((e) => e.action === action && e.data.workOrder === wo);
    const firstMerge = events.findIndex((e) => e.action === "autopilot.work_order_merged");
    assert.ok(at("autopilot.work_order_dispatched", "WO-1") < firstMerge && at("autopilot.work_order_dispatched", "WO-2") < firstMerge);
    assert.ok(at("autopilot.work_order_dispatched", "WO-3") > Math.max(at("autopilot.work_order_merged", "WO-1"), at("autopilot.work_order_merged", "WO-2")));

    const merged = await auditOf(run.id, "autopilot.work_order_merged");
    assert.deepEqual(merged.map((e) => e.actor), [POLICY, POLICY, POLICY]);
    assert.equal(merged.at(-1)?.data.sha, tip);
    assert.ok(merged.every((e) => (e.data.files as number) > 0 && (e.data.linesChanged as number) > 0));
    assert.equal((await auditOf(run.id, "autopilot.branch_cleaned")).length, 3);
    assert.deepEqual((await auditOf(run.id, "autopilot.plan_approved")).map((e) => e.actor), ["user:test"]);
    const completed = await auditOf(run.id, "autopilot.run_completed");
    assert.deepEqual(completed.map((e) => [e.data.branch, e.data.sha, e.data.merged]), [[run.integrationBranch, tip, 3]]);
    assert.ok((completed[0]?.data.costUsd as number) > 0);
  } finally {
    await t.close();
  }
});

test("e2e: a merge that breaks the integration gates is reset and goes back to its builder with the latest integration branch; fixed, it merges", async () => {
  const t = await setup(
    byRole({
      // WO-2's first test only holds on its own; it fails once WO-1 (merged first) sits next to it.
      builder: (conv) =>
        build(conv, conv.tags.sfwo === "2" && conv.messages.length === 1 ? 'assert.ok(!existsSync("wo-1.js"), "WO-2 expects to be alone");' : "assert.ok(Object.keys(m).length);"),
    }),
  );
  try {
    const run = await t.buildingRun(2);
    await t.until(() => t.ledger.getRun(run.id)?.state === "done");
    assert.deepEqual(t.states(run.id), ["1:merged", "2:merged"]);

    const [wo1Merged] = await auditOf(run.id, "autopilot.work_order_merged");
    const reverted = await auditOf(run.id, "autopilot.merge_reverted");
    assert.deepEqual(reverted.map((e) => [e.data.workOrder, e.data.resetTo]), [["WO-2", wo1Merged?.data.sha]]);
    assert.deepEqual(t.integrateChecks(run.id, 1), ["test:ok"]);
    assert.deepEqual(t.integrateChecks(run.id, 2), ["test:failed", "test:ok"]);
    // Reset, not reverted: the failed merge isn't in the history.
    assert.deepEqual(await t.merges(run.integrationBranch), ["Merge WO-2: Task 2", "Merge WO-1: Task 1"]);

    // Re-queued as a repair round in the same builder conversation, its branch brought up to date first.
    const builders = t.builders(run.id, 2);
    assert.deepEqual(builders.map((a) => a.turns), [2]);
    const conv = t.fake.conversations.get(builders[0]!.conversationId)!;
    assert.match(conv.messages[1] ?? "", /After merging into the integration branch: Gate test: `npm run test` failed/);
    assert.match(conv.messages[1] ?? "", /WO-2 expects to be alone/);
    assert.equal(t.wo(run.id, 2).baseSha, wo1Merged?.data.sha);
    assert.equal(t.wo(run.id, 2).findings?.[0]?.source, "integration");
    assert.deepEqual((await auditOf(run.id, "autopilot.repair_requested")).map((e) => e.data.workOrder), ["WO-2"]);
  } finally {
    await t.close();
  }
});

test("e2e: a merge conflict goes back to the builder with the markers in its worktree; resolved, it merges", async () => {
  let sawMarkers = false;
  const t = await setup(
    byRole({
      builder: (conv) => {
        const shared = path.join(conv.workingDir, "shared.txt");
        if (conv.messages.length === 1) {
          writeFileSync(shared, `from WO-${conv.tags.sfwo}\n`);
          return build(conv);
        }
        sawMarkers = readFileSync(shared, "utf8").includes("<<<<<<<");
        writeFileSync(shared, "from WO-1\nfrom WO-2\n"); // resolved; the factory concludes the merge
        return { response: "Resolved the conflict." };
      },
    }),
  );
  try {
    const run = await t.buildingRun(2);
    await t.until(() => t.ledger.getRun(run.id)?.state === "done");
    assert.deepEqual(t.states(run.id), ["1:merged", "2:merged"]);
    assert.deepEqual((await auditOf(run.id, "autopilot.merge_conflicted")).map((e) => [e.data.workOrder, e.data.conflicts]), [["WO-2", ["shared.txt"]]]);
    const [builder] = t.builders(run.id, 2);
    assert.equal(builder?.turns, 2);
    assert.match(t.fake.conversations.get(builder!.conversationId)?.messages[1] ?? "", /conflicts in: shared\.txt/);
    assert.equal(sawMarkers, true);
    assert.deepEqual(t.integrateChecks(run.id, 2), ["test:ok"]); // the conflicted merge never got as far as the gates
    assert.equal(await fileAt(t.workspace, run.integrationBranch, "shared.txt"), "from WO-1\nfrom WO-2\n");
    assert.deepEqual(await t.merges(run.integrationBranch), ["Merge WO-2: Task 2", "Merge WO-1: Task 1"]);
  } finally {
    await t.close();
  }
});

test("e2e, suggest: nothing merges without a person; send back reaches the builder, skip lets it go, merge is recorded as theirs", async () => {
  const t = await setup(byRole({ builder: (conv) => build(conv) }));
  try {
    const run = await t.buildingRun(2, "suggest");
    const tip = await headSha(t.workspace, run.integrationBranch);
    await t.until(() => t.states(run.id).every((s) => s.endsWith(":awaiting_merge_approval")));
    await t.step(2);
    assert.equal(await headSha(t.workspace, run.integrationBranch), tip);

    const item = t.item(run.id, "merge_approval", 1)!;
    assert.deepEqual(item.options.map((o) => [o.id, !!o.needsNote]), [["merge", false], ["send_back", true], ["skip", false]]);
    assert.match(item.body, /### Why it needs you\n- Autonomy is suggest: a person approves every merge\./);
    assert.match(item.body, /### 3 file\(s\), \d+ line\(s\) changed\n- `package\.json` \(\+1 -0\)/);
    assert.match(item.body, /- `wo-1\.js` \(\+1 -0\)/);

    await assert.rejects(t.o.decide(item.id, { choice: "send_back" }, "user:test"), /needs a note/);
    await t.o.decide(item.id, { choice: "send_back", note: "Also export a default." }, "user:test");
    assert.equal(t.wo(run.id, 1).state, "building");
    assert.match(t.fake.conversations.get(t.builders(run.id, 1)[0]!.conversationId)?.messages[1] ?? "", /A person asks for changes before this merges\. Fix: Also export a default\./);

    const wo2 = t.wo(run.id, 2);
    await t.o.decide(t.item(run.id, "merge_approval", 2)!.id, { choice: "skip" }, "user:test");
    assert.equal(t.wo(run.id, 2).state, "skipped");
    assert.equal(existsSync(wo2.worktree!), false);

    await t.until(() => t.wo(run.id, 1).state === "awaiting_merge_approval");
    await t.o.decide(t.item(run.id, "merge_approval", 1)!.id, { choice: "merge" }, "user:test");
    assert.equal(t.wo(run.id, 1).state, "merging");
    await t.until(() => t.ledger.getRun(run.id)?.state === "done");
    assert.equal(t.wo(run.id, 1).mergedBy, "user:test");
    assert.deepEqual(await t.merges(run.integrationBranch), ["Merge WO-1: Task 1"]);
    const merged = await auditOf(run.id, "autopilot.work_order_merged");
    assert.deepEqual(merged.map((e) => [e.actor, e.data.reasons]), [["user:test", ["Autonomy is suggest: a person approves every merge."]]]);
    assert.deepEqual((await auditOf(run.id, "autopilot.run_completed")).map((e) => [e.data.merged, e.data.skipped]), [[1, 1]]);
  } finally {
    await t.close();
  }
});

test("e2e, supervised with .factory/policy.yml on the base branch: a work order touching a sensitive path waits for a person while the next one merges as policy@<hash>, through the policy's own gates", async () => {
  const t = await setup(
    byRole({
      builder: (conv) => {
        if (conv.tags.sfwo === "1") {
          mkdirSync(path.join(conv.workingDir, "secure"), { recursive: true });
          writeFileSync(path.join(conv.workingDir, "secure", "keys.js"), "export const rotate = () => true;\n");
        }
        return build(conv);
      },
    }),
  );
  try {
    mkdirSync(path.join(t.workspace, ".factory"));
    writeFileSync(
      path.join(t.workspace, ".factory", "policy.yml"),
      ["# Anything under secure/ needs a person.", "autoMerge:", "  sensitivePaths: ['secure/**', '.factory/**']", "gates:", "  - { name: unit, run: node --test }", "parallel: 1", ""].join("\n"),
    );
    const run = await t.buildingRun(2); // createRun commits the workspace as it is, policy.yml included, and pins that
    const { hash } = await loadPolicy(t.workspace, "main");
    assert.equal(run.policyHash, hash);
    assert.notEqual(hash, policyHash(DEFAULT_POLICY));
    const policy = `policy@${hash}`;

    let busy = 0; // the most work orders building, verifying or reviewing at once: the policy's parallel
    await t.until(() => {
      busy = Math.max(busy, t.ledger.listWorkOrders(run.id).filter((w) => ["building", "verifying", "reviewing"].includes(w.state)).length);
      return t.states(run.id).join() === "1:awaiting_merge_approval,2:merged";
    });
    assert.equal(busy, 1);
    assert.equal(t.wo(run.id, 2).mergedBy, policy);
    // The policy's gates, not the detected npm ones, in the work order's worktree and on the integration branch.
    assert.deepEqual(t.integrateChecks(run.id, 2), ["unit:ok"]);
    assert.deepEqual(t.ledger.listChecks({ runId: run.id, workOrderId: `${run.id}/WO-1` }).map((c) => `${c.stage}:${c.name}`), ["build:unit", "build:secret-scan", "build:dependency-scan"]);
    assert.match(t.fake.conversations.get(t.builders(run.id, 1)[0]!.conversationId)?.messages[0] ?? "", /these checks itself, in this order: unit \(`node --test`\)/);
    const item = t.item(run.id, "merge_approval", 1)!;
    // Escaped, so the glob's stars show as stars instead of turning the rest bold.
    assert.match(item.body, /### Why it needs you\n- Changes sensitive paths: secure\/keys\.js \(secure\/\\\*\\\*\)\.\n/);

    await t.o.decide(item.id, { choice: "merge" }, "user:test");
    await t.until(() => t.ledger.getRun(run.id)?.state === "done");
    assert.equal(t.wo(run.id, 1).mergedBy, "user:test");
    const merged = await auditOf(run.id, "autopilot.work_order_merged");
    assert.deepEqual(
      merged.map((e) => [e.data.workOrder, e.actor, e.data.reasons]),
      [
        ["WO-2", policy, []],
        ["WO-1", "user:test", ["Changes sensitive paths: secure/keys.js (secure/**)."]],
      ],
    );
    assert.deepEqual((await auditOf(run.id, "autopilot.policy_loaded")).map((e) => [e.data.hash, e.data.source]), [[hash, ".factory/policy.yml@main"]]);
  } finally {
    await t.close();
  }
});

/** A suggest-mode run whose one work order was approved, and a factory that stopped after making the merge but before its gates. */
async function stoppedMidMerge() {
  const t = await setup(byRole({ builder: (conv) => build(conv) }));
  const run = await t.buildingRun(1, "suggest");
  await t.until(() => t.wo(run.id, 1).state === "awaiting_merge_approval");
  await t.o.decide(t.item(run.id, "merge_approval", 1)!.id, { choice: "merge" }, "user:test");
  const pre = await headSha(t.workspace, run.integrationBranch);
  t.ledger.updateWorkOrder(`${run.id}/WO-1`, { preMergeSha: pre });
  await git(run.integrationDir!, ["merge", "--no-ff", "-m", "Merge WO-1: Task 1", t.wo(run.id, 1).branch!]);
  t.restart();
  return { t, run, pre };
}

test("restart: a merge made just before the factory stopped goes on to the integration gates and merges once, as the approver's", async () => {
  const { t, run } = await stoppedMidMerge();
  try {
    await t.until(() => t.ledger.getRun(run.id)?.state === "done");
    assert.deepEqual(await t.merges(run.integrationBranch), ["Merge WO-1: Task 1"]);
    assert.deepEqual(t.integrateChecks(run.id, 1), ["test:ok"]);
    assert.deepEqual((await auditOf(run.id, "autopilot.work_order_merged")).map((e) => e.actor), ["user:test"]);
  } finally {
    await t.close();
  }
});

test("cancel after a restart mid-merge: the untested merge comes off the integration branch, which stays; worktrees and work-order branches go", async () => {
  const { t, run, pre } = await stoppedMidMerge();
  try {
    const wo = t.wo(run.id, 1);
    await t.o.cancel(run.id, { actor: "user:test" });
    assert.equal(t.ledger.getRun(run.id)?.state, "cancelled");
    assert.equal(await headSha(t.workspace, run.integrationBranch), pre);
    assert.equal(existsSync(run.integrationDir!), false);
    assert.equal(existsSync(wo.worktree!), false);
    assert.equal(await branchExists(t.workspace, wo.branch!), false);
    assert.equal(await branchExists(t.workspace, run.integrationBranch), true);
    assert.deepEqual((await auditOf(run.id, "autopilot.merge_reverted")).map((e) => [e.actor, e.data.workOrder, e.data.resetTo]), [["user:test", "WO-1", pre]]);
  } finally {
    await t.close();
  }
});

test("a merge step that throws stops only its work order with an error item; the integration branch is unchanged and retry merges it", async () => {
  const t = await setup(byRole({ builder: (conv) => build(conv) }));
  try {
    const run = await t.buildingRun(1, "suggest");
    await t.until(() => t.wo(run.id, 1).state === "awaiting_merge_approval");
    const tip = await headSha(t.workspace, run.integrationBranch);
    const wo = t.wo(run.id, 1);
    const built = await headSha(t.workspace, wo.branch!);
    await git(t.workspace, ["update-ref", "-d", `refs/heads/${wo.branch}`]); // git can't read the branch any more
    await t.o.decide(t.item(run.id, "merge_approval", 1)!.id, { choice: "merge" }, "user:test");
    await t.step();
    assert.equal(t.wo(run.id, 1).state, "needs_attention");
    assert.equal(t.wo(run.id, 1).resumeState, "merging");
    assert.equal(t.wo(run.id, 1).preMergeSha, null);
    assert.equal(await headSha(t.workspace, run.integrationBranch), tip);
    assert.equal(t.ledger.getRun(run.id)?.state, "building");
    assert.deepEqual(await auditOf(run.id, "autopilot.merge_reverted"), []); // nothing had landed

    await git(t.workspace, ["update-ref", `refs/heads/${wo.branch}`, built]);
    await t.o.decide(t.item(run.id, "error", 1)!.id, { choice: "retry" }, "user:test");
    await t.until(() => t.ledger.getRun(run.id)?.state === "done");
    assert.equal(t.wo(run.id, 1).mergedBy, "user:test");
    assert.deepEqual(await t.merges(run.integrationBranch), ["Merge WO-1: Task 1"]);
  } finally {
    await t.close();
  }
});

test("a run whose every work order was skipped fails: there's nothing to deliver", async () => {
  const t = await setup(byRole({ builder: (conv) => build(conv) }));
  try {
    const run = await t.buildingRun(1, "suggest");
    await t.until(() => !!t.item(run.id, "merge_approval", 1));
    await t.o.decide(t.item(run.id, "merge_approval", 1)!.id, { choice: "skip" }, "user:test");
    await t.step();
    assert.equal(t.ledger.getRun(run.id)?.state, "failed");
    assert.equal(existsSync(run.integrationDir!), false);
    assert.deepEqual((await auditOf(run.id, "autopilot.run_failed")).map((e) => [e.data.merged, e.data.skipped]), [[0, 1]]);
  } finally {
    await t.close();
  }
});
