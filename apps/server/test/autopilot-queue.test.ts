import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.SF_DATA_DIR = mkdtempSync(path.join(tmpdir(), "sf-queue-data-"));
process.env.SF_WORKSPACE = mkdtempSync(path.join(tmpdir(), "sf-queue-unused-"));
delete process.env.SF_AUTONOMY_CAP;
const { startFakeOpenHands } = await import("../src/demo/fake-agent-server.js");
const { scriptedAgents } = await import("../src/demo/scripted-agents.js");
const { createOrchestrator } = await import("../src/autopilot/orchestrator.js");
const { openLedger } = await import("../src/autopilot/ledger.js");
const { OpenHandsClient } = await import("../src/autopilot/openhands.js");
const { createAutopilotRoutes } = await import("../src/autopilot/routes.js");
const { branchExists, commitAll, headSha, git } = await import("../src/autopilot/git.js");
const { audit, listAudit } = await import("../src/audit.js");

async function setup(policy?: string) {
  const workspace = mkdtempSync(path.join(tmpdir(), "sf-queue-ws-"));
  writeFileSync(path.join(workspace, "README.md"), "# Demo\n");
  if (policy) {
    mkdirSync(path.join(workspace, ".factory"));
    writeFileSync(path.join(workspace, ".factory", "policy.yml"), policy);
  }
  const fake = await startFakeOpenHands({ onMessage: scriptedAgents({ noBugs: true }) });
  const ledger = openLedger(":memory:");
  const o = createOrchestrator({ ledger, client: new OpenHandsClient({ baseUrl: fake.url }), workspace, dataDir: mkdtempSync(path.join(tmpdir(), "sf-queue-run-")), graceMs: 0 });
  const app = createAutopilotRoutes(o);
  const t = {
    workspace,
    fake,
    ledger,
    o,
    summary: async (id: string) => (await (await app.request(`/runs/${id}`)).json()) as { state: string; queuePosition: number | null; releaseAfter: string | null },
    async step() {
      for (const i of ledger.listInbox({})) {
        if (i.kind === "plan_approval") await o.decide(i.id, { choice: "approve" }, "user:test");
        if (i.kind === "merge_approval") await o.decide(i.id, { choice: "merge" }, "user:test");
      }
      await o.tick();
      await o.idle();
      await fake.settled();
    },
    async until(done: () => boolean) {
      for (let i = 0; i < 120 && !done(); i++) await t.step();
      assert.ok(done(), "didn't get there");
    },
    async close() {
      o.stop();
      await o.idle();
      await fake.close();
      ledger.close();
    },
  };
  return t;
}

const auditOf = async (subject: string, action: string) => {
  await audit("test", "test.flush", "test");
  return listAudit(5000).filter((e) => e.subject === subject && e.action === action).reverse();
};

test("queue: past maxActiveRuns a run waits in line with no branch yet; it starts when a slot frees, from the base as it is then", async () => {
  const t = await setup("queue: { maxActiveRuns: 1 }\n");
  try {
    const a = await t.o.createRun({ goal: "Let applicants check a claim's status", actor: "user:test" });
    const b = await t.o.createRun({ goal: "Let clerks export claims", actor: "user:test" });
    const c = await t.o.createRun({ goal: "Let supervisors reassign claims", actor: "user:test" });
    assert.deepEqual([a, b, c].map((r) => r.state), ["spec", "queued", "queued"]);
    assert.equal(b.integrationDir, null);
    assert.equal(await branchExists(t.workspace, b.integrationBranch), false);
    assert.deepEqual([(await t.summary(b.id)).queuePosition, (await t.summary(c.id)).queuePosition, (await t.summary(a.id)).queuePosition], [1, 2, null]);
    assert.equal((await t.o.status()).queuedRuns, 2);
    await t.o.tick();
    await t.o.idle();
    assert.equal(t.ledger.getRun(b.id)?.state, "queued", "A is working, so B waits");

    // Meanwhile the base moves (someone released something), then A is cancelled: B starts from the new base.
    writeFileSync(path.join(t.workspace, "NOTES.md"), "released meanwhile\n");
    await commitAll(t.workspace, "Release something else");
    const base = await headSha(t.workspace);
    await t.o.cancel(a.id, { actor: "user:test" });
    await t.o.tick();
    await t.o.idle();
    const started = t.ledger.getRun(b.id)!;
    assert.equal(started.state, "spec");
    assert.equal(started.integrationSha, base);
    assert.equal(t.ledger.getRun(c.id)?.state, "queued");
    assert.equal((await t.summary(c.id)).queuePosition, 1);
    const [event] = await auditOf(b.id, "autopilot.run_started");
    assert.equal(event?.data.base, base);
    assert.ok(typeof event?.data.waitedSeconds === "number");
  } finally {
    await t.close();
  }
});

test("queue: a run waiting on a person doesn't hold a slot", async () => {
  const t = await setup("queue: { maxActiveRuns: 1 }\n");
  try {
    const a = await t.o.createRun({ goal: "Let applicants check a claim's status", autonomy: "supervised", actor: "user:test" });
    const b = await t.o.createRun({ goal: "Let clerks export claims", actor: "user:test" });
    for (let i = 0; i < 40 && t.ledger.getRun(a.id)?.state !== "awaiting_plan_approval"; i++) {
      await t.o.tick();
      await t.o.idle();
      await t.fake.settled();
    }
    assert.equal(t.ledger.getRun(a.id)?.state, "awaiting_plan_approval");
    await t.o.tick();
    await t.o.idle();
    assert.notEqual(t.ledger.getRun(b.id)?.state, "queued");
  } finally {
    await t.close();
  }
});

test("releases into one base branch go one at a time, in the order asked: the second waits, then merges onto the first and is tested again", async () => {
  const t = await setup();
  try {
    const a = await t.o.createRun({ goal: "Let applicants check a claim's status", actor: "user:test" });
    const b = await t.o.createRun({ goal: "Let clerks export claims", actor: "user:test" });
    await t.until(() => [a, b].every((r) => t.ledger.getRun(r.id)?.state === "done"));
    await t.o.release(a.id, "user:ao");
    await t.o.release(b.id, "user:ao");
    assert.equal((await t.summary(b.id)).releaseAfter, a.change);
    assert.equal((await t.summary(a.id)).releaseAfter, null);
    await t.until(() => [a, b].every((r) => t.ledger.getRun(r.id)?.state === "released"));
    assert.deepEqual([...(await auditOf(a.id, "autopilot.release_failed")), ...(await auditOf(b.id, "autopilot.release_failed"))], []);
    // B's release merge sits on top of A's, and B was tested again because the base had moved.
    const second = t.ledger.getRun(b.id)!;
    assert.equal((await git(t.workspace, ["rev-parse", `${second.releasedSha}^1`])).stdout.trim(), t.ledger.getRun(a.id)?.releasedSha);
    assert.ok(t.ledger.listChecks({ runId: b.id }).some((c) => c.stage === "release"));
    assert.deepEqual((await auditOf(b.id, "autopilot.run_released")).map((e) => e.data.retested), [true]);
  } finally {
    await t.close();
  }
});
