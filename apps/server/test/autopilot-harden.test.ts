// Regression tests for the defects in docs/autopilot/OPEN-ISSUES.md. Each test
// names the issue it holds fixed.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { type FakeConversation, type FakeHandler, startFakeOpenHands } from "./fake-openhands.js";

const dataRoot = mkdtempSync(path.join(tmpdir(), "sf-harden-data-"));
process.env.SF_DATA_DIR = dataRoot;
process.env.SF_WORKSPACE = mkdtempSync(path.join(tmpdir(), "sf-harden-unused-"));
delete process.env.SF_AUTONOMY_CAP;
const { createOrchestrator } = await import("../src/autopilot/orchestrator.js");
const { openLedger } = await import("../src/autopilot/ledger.js");
const { OpenHandsClient } = await import("../src/autopilot/openhands.js");
const { commitAll, ensureRepo } = await import("../src/autopilot/git.js");

const PASS = 'Reviewed.\n\n```json\n{"verdict":"pass","findings":[]}\n```';
const PKG = JSON.stringify({ name: "demo", private: true, type: "module", scripts: { test: "node --test" } });

/** Plays a builder: wo-<seq>.js and a passing node:test for it. */
export function build(conv: FakeConversation) {
  const seq = conv.tags.sfwo ?? "0";
  writeFileSync(path.join(conv.workingDir, "package.json"), PKG);
  writeFileSync(path.join(conv.workingDir, `wo-${seq}.js`), `export const wo${seq} = true;\n`);
  writeFileSync(path.join(conv.workingDir, `wo-${seq}.test.js`), `import { test } from "node:test";\nimport "./wo-${seq}.js";\ntest("WO-${seq}", () => {});\n`);
  return { response: "Built it.", cost: 0.1 };
}

function byRole(roles: Partial<Record<string, FakeHandler>>): FakeHandler {
  return (conv, text) => (roles[conv.tags.sfrole ?? ""] ?? (() => ({ response: PASS, cost: 0.02 })))(conv, text);
}

async function setup(handler: FakeHandler, opts: { apiKey?: string; clientKey?: string; policy?: string } = {}) {
  const workspace = mkdtempSync(path.join(tmpdir(), "sf-harden-ws-"));
  writeFileSync(path.join(workspace, "README.md"), "# Demo\n");
  if (opts.policy) {
    mkdirSync(path.join(workspace, ".factory"));
    writeFileSync(path.join(workspace, ".factory", "policy.yml"), opts.policy);
  }
  await ensureRepo(workspace);
  const dataDir = mkdtempSync(path.join(dataRoot, "case-"));
  const fake = await startFakeOpenHands({ onMessage: handler, apiKey: opts.apiKey });
  const ledger = openLedger(path.join(dataDir, "autopilot.db"));
  const key = opts.clientKey ?? opts.apiKey;
  const o = createOrchestrator({ ledger, client: new OpenHandsClient({ baseUrl: fake.url, apiKey: () => key }), workspace, dataDir, graceMs: 0 });
  const t = {
    workspace,
    fake,
    ledger,
    o,
    async step(times = 1) {
      for (let i = 0; i < times; i++) {
        await o.tick();
        await o.idle();
        await fake.settled();
      }
    },
    async until(done: () => boolean, max = 80) {
      for (let i = 0; i < max && !done(); i++) await t.step();
      assert.ok(done(), "the run didn't get there");
    },
    /** A run in building with independent work orders 1..n, skipping the spec stage. */
    async buildingRun(n: number, autonomy: "suggest" | "supervised" = "supervised") {
      const run = await o.createRun({ goal: "Add claim status lookup", autonomy, actor: "user:test" });
      ledger.addWorkOrders(run.id, Array.from({ length: n }, (_, i) => ({ seq: i + 1, title: `Task ${i + 1}`, acceptance: [`Criterion ${i + 1}`], controls: [], dependsOn: [], wave: 1, risk: "low" as const })));
      return ledger.updateRun(run.id, { state: "building" });
    },
    states: (runId: string) => ledger.listWorkOrders(runId).map((w) => `${w.seq}:${w.state}`),
    builders: (runId: string, seq: number) => ledger.listAttempts({ runId, workOrderId: `${runId}/WO-${seq}`, role: "builder" }),
    async close() {
      o.stop();
      await o.idle();
      await fake.close();
      ledger.close();
    },
  };
  return t;
}

test("#3: a conversation the agent server can't report on fails only its work order's attempt; the others merge and the run never pauses", async () => {
  const t = await setup(byRole({ builder: build }));
  try {
    const run = await t.buildingRun(3);
    await t.until(() => t.builders(run.id, 2).length === 1);
    const broken = t.builders(run.id, 2)[0]!.conversationId;
    // GET for WO-2's first builder answers 500, every time.
    t.fake.setFault((method, p) => (method === "GET" && p === `/api/conversations/${broken}` ? [500, { detail: "Internal Server Error" }] : undefined));
    await t.until(() => t.ledger.getRun(run.id)?.state === "done");
    assert.deepEqual(t.states(run.id), ["1:merged", "2:merged", "3:merged"]);
    assert.equal(t.ledger.listInbox({ state: "all", runId: run.id }).length, 0); // nobody was asked
    const [first, second] = t.builders(run.id, 2);
    assert.equal(first?.state, "error");
    assert.match((first?.result as { error: string }).error, /couldn't follow this conversation on the agent server: Internal Server Error/);
    assert.equal(t.fake.conversations.get(broken)?.status, "paused"); // stopped before a fresh builder took its worktree
    assert.equal(second?.state, "finished");
  } finally {
    await t.close();
  }
});

test("#8: a refused session key stops the run once with the cause, instead of failing each work order", async () => {
  const t = await setup(byRole({ builder: build }), { apiKey: "right", clientKey: "right" });
  try {
    const run = await t.buildingRun(3);
    // The key changes under the factory (Canvas restarted with a new one).
    t.fake.setFault(() => [401, { detail: "Unauthorized" }]);
    await t.step(3);
    assert.equal(t.ledger.getRun(run.id)?.state, "paused");
    const items = t.ledger.listInbox({ runId: run.id });
    assert.deepEqual(items.map((i) => [i.kind, i.workOrderId]), [["error", null]]);
    assert.match(items[0]!.body, /refused Autopilot's session key \(Unauthorized\)\. Set SF_AGENT_SERVER_KEY/);
    assert.ok(t.ledger.listWorkOrders(run.id).every((w) => w.state !== "needs_attention"));

    t.fake.setFault(undefined);
    await t.o.decide(items[0]!.id, { choice: "retry" }, "user:test");
    await t.until(() => t.ledger.getRun(run.id)?.state === "done");
  } finally {
    await t.close();
  }
});

test("#8: a policy naming an agent profile the agent server lacks starts no run, and /status says which", async () => {
  const t = await setup(byRole({}), { policy: "agents:\n  reviewer: Codex Reviewer\n" });
  try {
    await assert.rejects(t.o.createRun({ goal: "Add a page", actor: "user:test" }), /\.factory\/policy\.yml@main: the agent server has no profile for agents\.reviewer: "Codex Reviewer"/);
    assert.equal(t.ledger.listRuns().length, 0);
    assert.match((await t.o.status()).policy.error ?? "", /no profile for agents\.reviewer/);
    // Fixed on the base branch: runs start again.
    writeFileSync(path.join(t.workspace, ".factory", "policy.yml"), "agents:\n  reviewer: default\n");
    await commitAll(t.workspace, "Use the default profile");
    assert.ok(await t.o.createRun({ goal: "Add a page", actor: "user:test" }));
    assert.equal((await t.o.status()).policy.error, null);
  } finally {
    await t.close();
  }
});
