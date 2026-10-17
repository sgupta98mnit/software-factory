import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.SF_DATA_DIR = mkdtempSync(path.join(tmpdir(), "sf-release-data-"));
process.env.SF_WORKSPACE = mkdtempSync(path.join(tmpdir(), "sf-release-unused-"));
delete process.env.SF_AUTONOMY_CAP;
const { startFakeOpenHands } = await import("../src/demo/fake-agent-server.js");
const { scriptedAgents } = await import("../src/demo/scripted-agents.js");
const { createOrchestrator } = await import("../src/autopilot/orchestrator.js");
const { openLedger } = await import("../src/autopilot/ledger.js");
const { OpenHandsClient } = await import("../src/autopilot/openhands.js");
const { createAutopilotRoutes } = await import("../src/autopilot/routes.js");
const { commitAll, fileAt, git, headSha } = await import("../src/autopilot/git.js");
const { audit, listAudit } = await import("../src/audit.js");

/** A finished run (scripted agents, every merge approved), ready to release. */
async function finishedRun(opts: { policy?: string; autonomy?: "supervised" | "autonomous" } = {}) {
  const workspace = mkdtempSync(path.join(tmpdir(), "sf-release-ws-"));
  writeFileSync(path.join(workspace, "README.md"), "# Demo\n");
  if (opts.policy) {
    mkdirSync(path.join(workspace, ".factory"));
    writeFileSync(path.join(workspace, ".factory", "policy.yml"), opts.policy);
  }
  const fake = await startFakeOpenHands({ onMessage: scriptedAgents({ noBugs: true }) });
  const ledger = openLedger(":memory:");
  const o = createOrchestrator({ ledger, client: new OpenHandsClient({ baseUrl: fake.url }), workspace, dataDir: mkdtempSync(path.join(tmpdir(), "sf-release-run-")), graceMs: 0 });
  const run = await o.createRun({ goal: "Let applicants check a claim's status", autonomy: opts.autonomy ?? "supervised", actor: "user:test" });
  const step = async () => {
    for (const i of ledger.listInbox({ runId: run.id })) {
      if (i.kind === "plan_approval") await o.decide(i.id, { choice: "approve" }, "user:test");
      if (i.kind === "merge_approval") await o.decide(i.id, { choice: "merge" }, "user:test");
    }
    await o.tick();
    await o.idle();
    await fake.settled();
  };
  const until = async (done: () => boolean) => {
    for (let i = 0; i < 100 && !done(); i++) await step();
    assert.ok(done(), `the run didn't get there (${ledger.getRun(run.id)?.state})`);
  };
  const state = () => ledger.getRun(run.id)?.state;
  await until(() => ["done", "released"].includes(state() ?? ""));
  const item = () => ledger.listInbox({ runId: run.id }).find((i) => i.kind === "release");
  return { workspace, fake, ledger, o, run, until, state, item, close: async () => { o.stop(); await o.idle(); await fake.close(); ledger.close(); } };
}

const auditOf = async (runId: string, action: string) => {
  await audit("test", "test.flush", "test");
  return listAudit(5000).filter((e) => e.subject === runId && e.action === action).reverse();
};

test("a finished run asks a person to release it; released, the base branch (and the workspace's files) move to the release merge", async () => {
  const t = await finishedRun();
  try {
    assert.equal(t.state(), "done");
    const item = t.item()!;
    assert.deepEqual(item.options.map((o) => [o.id, o.label]), [["release", "Release into main"], ["hold", "Not now"]]);
    assert.match(item.body, /- WO-1: Core behavior: merged automatically \(policy@[0-9a-f]{12}\)/);
    assert.match(item.body, /- WO-3: Audit and access: merged by user:test/);
    assert.match(item.body, /### \d+ file\(s\), \d+ line\(s\) changed from `main`/);

    await t.o.decide(item.id, { choice: "release" }, "user:alice");
    await t.until(() => t.state() === "released");
    const run = t.ledger.getRun(t.run.id)!;
    assert.equal(run.releasedBy, "user:alice");
    assert.equal(await headSha(t.workspace, "main"), run.releasedSha);
    assert.equal((await git(t.workspace, ["log", "-1", "--format=%s", "main"])).stdout.trim(), `Release ${run.change} (${run.id})`);
    assert.match(readFileSync(path.join(t.workspace, "src", "auth", "let-applicants-check.js"), "utf8"), /allowed/); // the checkout moved too
    assert.deepEqual((await auditOf(t.run.id, "autopilot.run_released")).map((e) => [e.actor, e.data.base, e.data.retested]), [["user:alice", "main", false]]);
  } finally {
    await t.close();
  }
});

test("release: a base branch that moved meanwhile is merged and tested again first; a conflict or uncommitted changes send it back to a person with the reason", async () => {
  const t = await finishedRun();
  try {
    // Someone commits on main: the release merge gets tested.
    writeFileSync(path.join(t.workspace, "NOTES.md"), "Notes\n");
    await commitAll(t.workspace, "Notes");
    // ...and leaves an uncommitted edit: the release can't move their checkout.
    writeFileSync(path.join(t.workspace, "README.md"), "# Demo, edited\n");
    await t.o.decide(t.item()!.id, { choice: "release" }, "user:test");
    await t.until(() => t.state() === "done" && !!t.item());
    assert.match(t.item()!.body, /The last release didn't go through:\*\* The workspace has uncommitted changes on `main`/);
    assert.ok(t.ledger.listChecks({ runId: t.run.id }).some((c) => c.stage === "release" && c.ok)); // tested again

    await git(t.workspace, ["checkout", "--", "README.md"]);
    await t.o.decide(t.item()!.id, { choice: "release" }, "user:test");
    await t.until(() => t.state() === "released");
    assert.notEqual(await fileAt(t.workspace, "main", "NOTES.md"), null);
    assert.notEqual(await fileAt(t.workspace, "main", "src/auth/let-applicants-check.js"), null);
    assert.deepEqual((await auditOf(t.run.id, "autopilot.run_released")).map((e) => e.data.retested), [true]);
  } finally {
    await t.close();
  }
});

test("release: a conflict with the base branch goes back to a person; Not now keeps the run done and Release on the Pipeline asks again", async () => {
  const t = await finishedRun();
  try {
    const change = t.run.change.split("-").slice(0, 3).join("-");
    mkdirSync(path.join(t.workspace, "src", change), { recursive: true });
    writeFileSync(path.join(t.workspace, "src", change, "core.js"), "export const handle = () => 'theirs';\n");
    await commitAll(t.workspace, "Someone else's core.js");
    await t.o.decide(t.item()!.id, { choice: "release" }, "user:test");
    await t.until(() => t.state() === "done" && !!t.item());
    assert.match(t.item()!.body, /Merging into `main` conflicts in: src\/let-applicants-check\/core\.js/);

    await t.o.decide(t.item()!.id, { choice: "hold" }, "user:test");
    assert.equal(t.state(), "done");
    assert.equal(t.item(), undefined);
    await git(t.workspace, ["reset", "-q", "--hard", "HEAD~1"]); // they take theirs back
    const res = await createAutopilotRoutes(t.o).request(`/runs/${t.run.id}/release`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(res.status, 200);
    await t.until(() => t.state() === "released");
  } finally {
    await t.close();
  }
});

test("release.auto releases an autonomous run on its own, recorded as the policy's; it's off unless the policy says so", async () => {
  const t = await finishedRun({ policy: "release: { auto: true }\n", autonomy: "autonomous" });
  try {
    await t.until(() => t.state() === "released");
    const run = t.ledger.getRun(t.run.id)!;
    assert.equal(run.releasedBy, `policy@${run.policyHash}`);
    assert.deepEqual((await auditOf(t.run.id, "autopilot.run_released")).map((e) => e.actor), [`policy@${run.policyHash}`]);
  } finally {
    await t.close();
  }
});
