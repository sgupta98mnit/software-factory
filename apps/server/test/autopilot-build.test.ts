import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { type FakeConversation, type FakeHandler, startFakeOpenHands } from "./fake-openhands.js";

// Audit log and worktrees in a temp folder, and never the real workspace, before config is read.
const dataRoot = mkdtempSync(path.join(tmpdir(), "sf-build-data-"));
process.env.SF_DATA_DIR = dataRoot;
process.env.SF_WORKSPACE = mkdtempSync(path.join(tmpdir(), "sf-build-unused-"));
delete process.env.SF_AUTONOMY_CAP;
const { createOrchestrator } = await import("../src/autopilot/orchestrator.js");
const { openLedger } = await import("../src/autopilot/ledger.js");
const { OpenHandsClient, OpenHandsError } = await import("../src/autopilot/openhands.js");
const { branchExists, fileAt, git, headSha } = await import("../src/autopilot/git.js");
const { audit, listAudit } = await import("../src/audit.js");

// The demo workspace's OpenSpec folder, copied (never changed) into each test's workspace.
const FIXTURE = path.resolve(import.meta.dirname, "../../../workspaces/benefits-portal/openspec");
const EXAMPLE = "add-claim-status-lookup";
const PASS = 'Reviewed.\n\n```json\n{"verdict":"pass","findings":[]}\n```';

/** Groups 1-3 build in parallel; 4 waits for all three. */
const FAN_IN = `## 1. Service skeleton
Depends on: none
- [ ] 1.1 Create claim-status-service with GET /health

## 2. Status lookup
Depends on: none
- [ ] 2.1 Return 400 for malformed claim IDs

## 3. Audit
Depends on: none
- [ ] 3.1 Write one audit record per lookup

## 4. Wire it together
Depends on: 1, 2, 3
- [ ] 4.1 Serve the lookup from the service
`;

const flushAudit = () => audit("test", "test.flush", "test");

/** A gate a fake agent waits at, opened by the test. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
}

/** Handlers by the conversation's role tag; reviewers (and anyone else) pass unless told otherwise. */
function byRole(roles: Partial<Record<string, FakeHandler>>): FakeHandler {
  return (conv, text) => (roles[conv.tags.sfrole ?? ""] ?? (() => ({ response: PASS, cost: 0.01 })))(conv, text);
}

/** Plays a spec agent: the fixture's example change under the requested name, with `tasks` as its tasks.md. */
function writeChange(conv: FakeConversation, tasks?: string) {
  const change = /The change is called `([^`]+)`/.exec(conv.messages[0] ?? "")?.[1] ?? "missing";
  const dir = path.join(conv.workingDir, "openspec", "changes", change);
  cpSync(path.join(conv.workingDir, "openspec", "changes", EXAMPLE), dir, { recursive: true });
  if (tasks) writeFileSync(path.join(dir, "tasks.md"), tasks);
}

/** Plays a builder: writes wo-<seq>.txt and a package whose test passes, and leaves the commit to the factory. */
function build(conv: FakeConversation) {
  writeFileSync(path.join(conv.workingDir, `wo-${conv.tags.sfwo}.txt`), `built by ${conv.id}\n`);
  writeFileSync(path.join(conv.workingDir, "package.json"), JSON.stringify({ name: "wo", private: true, scripts: { test: "node --test" } }));
  writeFileSync(path.join(conv.workingDir, "wo.test.mjs"), 'import { test } from "node:test";\ntest("works", () => {});\n');
  return { response: "Built it and tested it.", cost: 0.1 };
}

async function setup(handler: FakeHandler, opts: { fixture?: boolean } = {}) {
  const workspace = mkdtempSync(path.join(tmpdir(), "sf-build-ws-"));
  if (opts.fixture) cpSync(FIXTURE, path.join(workspace, "openspec"), { recursive: true });
  else writeFileSync(path.join(workspace, "README.md"), "# Demo\n");
  const dataDir = mkdtempSync(path.join(dataRoot, "case-"));
  const fake = await startFakeOpenHands({ onMessage: handler });
  const ledger = openLedger(path.join(dataDir, "autopilot.db"));
  const o = createOrchestrator({ ledger, client: new OpenHandsClient({ baseUrl: fake.url }), workspace, dataDir, graceMs: 0 });
  return {
    workspace,
    dataDir,
    fake,
    ledger,
    o,
    /** One scheduler pass, without waiting for the agents (some are held at a gate). */
    async step(times = 1) {
      for (let i = 0; i < times; i++) {
        await o.tick();
        await o.idle();
      }
    },
    async until(done: () => boolean, max = 40) {
      for (let i = 0; i < max; i++) {
        await o.tick();
        await o.idle();
        await fake.settled();
        if (done()) return;
      }
      assert.fail("the run didn't get there");
    },
    /** Like until, while some agents are held at a gate (so the fake never settles). */
    async stepUntil(done: () => boolean, max = 200) {
      for (let i = 0; i < max; i++) {
        await o.tick();
        await o.idle();
        if (done()) return;
        await new Promise((resolve) => setTimeout(resolve, 10)); // let the released agents finish their turns
      }
      assert.fail("the run didn't get there");
    },
    async close() {
      o.stop();
      await o.idle();
      await fake.close();
      ledger.close();
    },
  };
}
type Setup = Awaited<ReturnType<typeof setup>>;

/** A run that skips the spec stage: building, with work orders [seq, dependsOn]. */
async function buildingRun(t: Pick<Setup, "o" | "ledger">, rows: [number, number[]][]) {
  const run = await t.o.createRun({ goal: "Add claim status lookup", autonomy: "supervised", actor: "user:test" });
  t.ledger.addWorkOrders(
    run.id,
    rows.map(([seq, dependsOn]) => ({ seq, title: `Task ${seq}`, acceptance: [`Criterion ${seq}.1`], controls: [], dependsOn, wave: dependsOn.length ? 2 : 1, risk: "low" as const })),
  );
  return t.ledger.updateRun(run.id, { state: "building" });
}

const states = (t: Pick<Setup, "ledger">, runId: string) => t.ledger.listWorkOrders(runId).map((w) => `${w.seq}:${w.state}`);

test("plan and dispatch: tasks.md becomes waves; three builders start at once in their own worktrees from the integration tip while WO-4 waits", async () => {
  const builders = gate();
  const t = await setup(
    byRole({
      spec: (conv) => {
        writeChange(conv, FAN_IN);
        return { response: "Wrote the change." };
      },
      critic: () => ({ response: PASS }),
      builder: async (conv) => {
        await builders.opened;
        return build(conv);
      },
    }),
    { fixture: true },
  );
  try {
    const run = await t.o.createRun({ goal: "Add claim status lookup", autonomy: "autonomous", actor: "user:test" });
    await t.until(() => t.ledger.getRun(run.id)?.state === "building");
    const planned = t.ledger.listWorkOrders(run.id);
    assert.deepEqual(
      planned.map((w) => [w.seq, w.title, w.wave, w.dependsOn, w.state]),
      [
        [1, "Service skeleton", 1, [], "pending"],
        [2, "Status lookup", 1, [], "pending"],
        [3, "Audit", 1, [], "pending"],
        [4, "Wire it together", 2, [1, 2, 3], "pending"],
      ],
    );
    assert.deepEqual(planned[1]?.controls, ["SI-10"]);

    await t.step();
    const tip = await headSha(t.workspace, run.integrationBranch);
    const attempts = t.ledger.listAttempts({ runId: run.id, role: "builder" });
    assert.equal(attempts.length, 3);
    assert.deepEqual(states(t, run.id), ["1:building", "2:building", "3:building", "4:pending"]);
    for (const seq of [1, 2, 3]) {
      const wo = t.ledger.getWorkOrder(`${run.id}/WO-${seq}`)!;
      const a = attempts.find((x) => x.workOrderId === wo.id)!;
      assert.equal(a.state, "running");
      assert.equal(wo.worktree, path.join(t.dataDir, "worktrees", run.id, `wo-${seq}`));
      assert.equal(wo.branch, `autopilot/${run.change}--wo-${seq}`);
      assert.equal(wo.baseSha, tip);
      assert.equal(await headSha(t.workspace, wo.branch), tip); // branched from the integration tip
      const conv = t.fake.conversations.get(a.conversationId)!;
      assert.equal(conv.workingDir, wo.worktree);
      assert.deepEqual(conv.tags, { sfrun: run.id, sfrole: "builder", sfwo: String(seq) });
      const brief = conv.messages[0] ?? "";
      for (const part of [`WO-${seq}: ${wo.title}`, `1. ${wo.acceptance[0]}`, `openspec/changes/${run.change}/`, `(\`${wo.branch}\`)`, "npm run test", "Backlog.md"]) {
        assert.ok(brief.includes(part), part);
      }
    }
    assert.match(t.fake.conversations.get(attempts[1]!.conversationId)?.messages[0] ?? "", /Security controls .*: SI-10\./);

    // Nothing more starts while they work: WO-4 waits for 1-3.
    await t.step(2);
    assert.equal(t.ledger.listAttempts({ runId: run.id, role: "builder" }).length, 3);

    builders.open();
    await t.until(() => states(t, run.id).filter((s) => s.endsWith(":ready")).length === 3);
    assert.deepEqual(states(t, run.id), ["1:ready", "2:ready", "3:ready", "4:pending"]);
    for (const seq of [1, 2, 3]) {
      const wo = t.ledger.getWorkOrder(`${run.id}/WO-${seq}`)!;
      const subject = (await git(t.workspace, ["log", "-1", "--format=%s", wo.branch!])).stdout.trim();
      assert.equal(subject, `WO-${seq}: ${wo.title}`);
      assert.match((await fileAt(t.workspace, wo.branch!, `wo-${seq}.txt`)) ?? "", /built by/);
    }
    assert.equal(await headSha(t.workspace, run.integrationBranch), tip); // nothing merged yet

    // A free slot isn't enough: WO-4 waits until all of 1-3 are merged or skipped.
    t.ledger.updateWorkOrder(`${run.id}/WO-1`, { state: "merged" });
    await t.step(2);
    assert.equal(t.ledger.getWorkOrder(`${run.id}/WO-4`)?.state, "pending");
    t.ledger.updateWorkOrder(`${run.id}/WO-2`, { state: "skipped" });
    t.ledger.updateWorkOrder(`${run.id}/WO-3`, { state: "merged" });
    await t.until(() => t.ledger.getWorkOrder(`${run.id}/WO-4`)?.state === "ready");

    await flushAudit();
    const events = listAudit().filter((e) => e.subject === run.id);
    assert.equal(events.filter((e) => e.action === "autopilot.work_order_dispatched").length, 4);
    const plannedEvent = events.find((e) => e.action === "autopilot.work_orders_planned");
    assert.deepEqual([plannedEvent?.data.workOrders, plannedEvent?.data.waves], [4, 2]);
  } finally {
    builders.open();
    await t.close();
  }
});

test("dispatch: with five independent work orders only three build at once; the next starts when one leaves; cancel cleans up", async () => {
  const builders = gate();
  const reviewers = gate();
  const t = await setup(
    byRole({
      builder: async (conv) => {
        await builders.opened;
        return build(conv);
      },
      reviewer: async () => {
        await reviewers.opened;
        return { response: PASS };
      },
    }),
  );
  try {
    const run = await buildingRun(t, [[1, []], [2, []], [3, []], [4, []], [5, []]]);
    await t.step(3);
    assert.deepEqual(states(t, run.id), ["1:building", "2:building", "3:building", "4:pending", "5:pending"]);
    assert.equal(t.fake.conversations.size, 3);

    builders.open();
    await t.stepUntil(() => states(t, run.id).filter((s) => s.endsWith(":reviewing")).length === 3);
    // Verifying and reviewing still count against the limit.
    assert.deepEqual(states(t, run.id), ["1:reviewing", "2:reviewing", "3:reviewing", "4:pending", "5:pending"]);

    // As if the integrator had merged WO-1: one slot opens.
    t.ledger.updateWorkOrder(`${run.id}/WO-1`, { state: "merged" });
    await t.stepUntil(() => t.ledger.getWorkOrder(`${run.id}/WO-4`)?.state === "reviewing");
    assert.equal(t.ledger.getWorkOrder(`${run.id}/WO-5`)?.state, "pending");

    const wo2 = t.ledger.getWorkOrder(`${run.id}/WO-2`)!;
    await t.o.cancel(run.id, { actor: "user:test" });
    assert.deepEqual(states(t, run.id), ["1:merged", "2:cancelled", "3:cancelled", "4:cancelled", "5:cancelled"]);
    assert.equal(existsSync(wo2.worktree!), false);
    assert.equal(await branchExists(t.workspace, wo2.branch!), false);
    assert.equal(await branchExists(t.workspace, run.integrationBranch), true); // the deliverable stays
  } finally {
    builders.open();
    reviewers.open();
    await t.close();
  }
});

test("a builder that keeps failing goes to the inbox after its repair rounds: retry gets one more fresh agent told why, skip lets dependents go ahead", async () => {
  const t = await setup(
    byRole({
      builder: (conv) => {
        if (conv.tags.sfwo === "1") throw new Error("Out of credits");
        return build(conv);
      },
    }),
  );
  try {
    const run = await buildingRun(t, [[1, []], [2, [1]]]);
    const failedItem = () => t.ledger.listInbox({ runId: run.id }).find((i) => i.kind === "work_order_failed");
    await t.until(() => !!failedItem());
    assert.deepEqual(states(t, run.id), ["1:needs_attention", "2:pending"]);
    const item = failedItem()!;
    assert.equal(item.workOrderId, `${run.id}/WO-1`);
    assert.deepEqual(item.options.map((o) => o.id), ["retry", "skip", "cancel"]);
    assert.match(item.body, /The builder stopped with status "error"\. Its last message: Out of credits/);
    const first = t.ledger.getWorkOrder(`${run.id}/WO-1`)!;
    assert.equal(first.resumeState, "building");
    assert.equal(first.findings?.[0]?.source, "agent");

    await t.o.decide(item.id, { choice: "retry" }, "user:test");
    assert.equal(t.ledger.getWorkOrder(`${run.id}/WO-1`)?.state, "pending");
    await t.until(() => !!failedItem());
    // Two builders before the inbox (the repair rounds), one more for the retry.
    const attempts = t.ledger.listAttempts({ runId: run.id, role: "builder" });
    assert.deepEqual(attempts.map((a) => a.turns), [3, 3, 3]);
    assert.equal(new Set(attempts.map((a) => a.conversationId)).size, 3);
    assert.match(t.fake.conversations.get(attempts[2]!.conversationId)?.messages[0] ?? "", /A previous attempt at this work order failed:\n\n- \(high\) The builder stopped .*Out of credits/);

    await t.o.decide(failedItem()!.id, { choice: "skip" }, "user:test");
    assert.equal(existsSync(first.worktree!), false);
    await t.until(() => t.ledger.getWorkOrder(`${run.id}/WO-2`)?.state === "ready");
    assert.deepEqual(states(t, run.id), ["1:skipped", "2:ready"]);
    await flushAudit();
    const decided = listAudit().filter((e) => e.subject === run.id && e.action === "autopilot.work_order_state_changed" && e.actor === "user:test");
    assert.deepEqual(decided.map((e) => e.data.to).reverse(), ["pending", "skipped"]);
  } finally {
    await t.close();
  }
});

test("restart: a builder left 'starting' starts with the same id, and a new orchestrator polls it to verifying", async () => {
  const builder = gate();
  const fake = await startFakeOpenHands({
    onMessage: byRole({
      builder: async (conv) => {
        await builder.opened;
        return build(conv);
      },
    }),
  });
  const workspace = mkdtempSync(path.join(tmpdir(), "sf-build-ws-"));
  writeFileSync(path.join(workspace, "README.md"), "# Demo\n");
  const dataDir = mkdtempSync(path.join(dataRoot, "restart-"));
  const db = path.join(dataDir, "autopilot.db");
  class TimesOut extends OpenHandsClient {
    override async start(): Promise<never> {
      throw new OpenHandsError(0, "timed out");
    }
  }
  const factory = (client: InstanceType<typeof OpenHandsClient>) => {
    const ledger = openLedger(db);
    return { ledger, o: createOrchestrator({ ledger, client, workspace, dataDir, graceMs: 0 }) };
  };
  try {
    // First factory: the worktree and attempt are there, but the start never got through.
    let f = factory(new TimesOut({ baseUrl: fake.url }));
    const run = await buildingRun(f, [[1, []]]);
    await f.o.tick();
    await f.o.idle();
    const [attempt] = f.ledger.listAttempts({ runId: run.id, role: "builder" });
    assert.equal(attempt?.state, "starting");
    const wo = f.ledger.getWorkOrder(`${run.id}/WO-1`)!;
    assert.equal(wo.state, "building");
    assert.ok(existsSync(wo.worktree!));
    assert.equal(fake.conversations.size, 0);
    f.ledger.close();

    // Second factory: starts it with the id it recorded, in the same worktree.
    f = factory(new OpenHandsClient({ baseUrl: fake.url }));
    await f.o.tick();
    await f.o.idle();
    assert.equal(f.ledger.getAttempt(attempt.id)?.state, "running");
    assert.deepEqual([...fake.conversations.keys()], [attempt.conversationId]);
    assert.equal(fake.conversations.get(attempt.conversationId)?.workingDir, wo.worktree);
    f.ledger.close();

    // Third factory: the builder finished while nobody watched; polling picks it up.
    f = factory(new OpenHandsClient({ baseUrl: fake.url }));
    builder.open();
    await fake.settled();
    for (let i = 0; i < 10 && f.ledger.getWorkOrder(wo.id)?.state !== "verifying"; i++) {
      await f.o.tick();
      await f.o.idle();
    }
    assert.equal(f.ledger.getWorkOrder(wo.id)?.state, "verifying");
    assert.equal(f.ledger.getAttempt(attempt.id)?.state, "finished");
    assert.equal(f.ledger.listAttempts({ runId: run.id, role: "builder" }).length, 1);
    assert.equal(fake.conversations.size, 1);
    assert.match((await fileAt(workspace, wo.branch!, "wo-1.txt")) ?? "", /built by/);
    f.ledger.close();
  } finally {
    builder.open();
    await fake.close();
  }
});

test("plan: the approval shows the work orders; a revise rebuilds them, and a tasks.md that can't be planned opens spec_failed", async () => {
  const CYCLE = "## 1. A\nDepends on: 2\n- [ ] 1.1 a\n\n## 2. B\n- [ ] 2.1 b\n";
  const INDEPENDENT_AUDIT = readFileSync(path.join(FIXTURE, "changes", EXAMPLE, "tasks.md"), "utf8").replace(/## 3\. Audit\r?\n/, "## 3. Audit\n\nDepends on: none\n");
  const t = await setup(
    byRole({
      spec: (conv, text) => {
        if (text.includes("stopped on this problem")) writeChange(conv, INDEPENDENT_AUDIT);
        else writeChange(conv, conv.messages.length > 1 ? CYCLE : undefined);
        return { response: "Done." };
      },
      critic: () => ({ response: PASS }),
    }),
    { fixture: true },
  );
  try {
    const run = await t.o.createRun({ goal: "Add claim status lookup", autonomy: "supervised", actor: "user:test" });
    const openItem = (kind: string) => t.ledger.listInbox({ runId: run.id }).find((i) => i.kind === kind);
    await t.until(() => !!openItem("plan_approval"));
    assert.deepEqual(t.ledger.listWorkOrders(run.id).map((w) => [w.seq, w.wave, w.dependsOn]), [[1, 1, []], [2, 2, [1]], [3, 3, [2]]]);
    const body = openItem("plan_approval")!.body;
    assert.match(body, /\| WO-2 \| Status lookup \| 2 \| low \| 1 \| SI-10 \|/);
    assert.match(body, /\| WO-3 \| Audit \| 3 \| low \| 2 \| AU-2, AU-3, AU-12 \|/);

    // The revised tasks.md has a cycle: the old work orders go, and a person hears why.
    await t.o.decide(openItem("plan_approval")!.id, { choice: "revise", note: "Group 1 needs group 2's types." }, "user:test");
    await t.until(() => !!openItem("spec_failed"));
    assert.equal(t.ledger.getRun(run.id)?.state, "spec");
    assert.deepEqual(t.ledger.listWorkOrders(run.id), []);
    assert.match(openItem("spec_failed")!.body, /cycle \(1 → 2 → 1\)/);

    // Retry: a new spec agent is told what to fix, and the plan is rebuilt.
    await t.o.decide(openItem("spec_failed")!.id, { choice: "retry" }, "user:test");
    await t.until(() => !!openItem("plan_approval"));
    const specs = t.ledger.listAttempts({ runId: run.id, role: "spec" });
    assert.equal(specs.length, 2);
    assert.match(t.fake.conversations.get(specs[1]!.conversationId)?.messages[0] ?? "", /stopped on this problem\. Fix it:\n\n.*cycle \(1 → 2 → 1\)/);
    assert.deepEqual(t.ledger.listWorkOrders(run.id).map((w) => [w.seq, w.wave, w.dependsOn]), [[1, 1, []], [3, 1, []], [2, 2, [1]]]);
    await flushAudit();
    const plans = listAudit().filter((e) => e.subject === run.id && e.action === "autopilot.work_orders_planned");
    assert.deepEqual(plans.map((e) => e.data.replaced).reverse(), [0, 0]); // the failed plan already dropped the first one
  } finally {
    await t.close();
  }
});
