// Self-healing: the watchdog for quiet agents, agent-server outages, and
// agents restarted once before anyone is asked.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { type FakeConversation, type FakeHandler, startFakeOpenHands } from "./fake-openhands.js";

const dataRoot = mkdtempSync(path.join(tmpdir(), "sf-heal-data-"));
process.env.SF_DATA_DIR = dataRoot;
process.env.SF_WORKSPACE = mkdtempSync(path.join(tmpdir(), "sf-heal-unused-"));
delete process.env.SF_AUTONOMY_CAP;
const { createOrchestrator } = await import("../src/autopilot/orchestrator.js");
const { openLedger } = await import("../src/autopilot/ledger.js");
const { OpenHandsClient } = await import("../src/autopilot/openhands.js");
const { ensureRepo } = await import("../src/autopilot/git.js");
const { DEFAULT_POLICY, pinnedPolicy } = await import("../src/autopilot/policy.js");
const { scriptedAgents } = await import("../src/demo/scripted-agents.js");
const { audit, listAudit } = await import("../src/audit.js");

const PASS = 'Reviewed.\n\n```json\n{"verdict":"pass","findings":[]}\n```';
const PKG = JSON.stringify({ name: "demo", private: true, type: "module", scripts: { test: "node --test" } });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function build(conv: FakeConversation) {
  const seq = conv.tags.sfwo ?? "0";
  writeFileSync(path.join(conv.workingDir, "package.json"), PKG);
  writeFileSync(path.join(conv.workingDir, `wo-${seq}.js`), `export const wo${seq} = true;\n`);
  writeFileSync(path.join(conv.workingDir, `wo-${seq}.test.js`), `import { test } from "node:test";\nimport "./wo-${seq}.js";\ntest("WO-${seq}", () => {});\n`);
  return { response: "Built it.", cost: 0.1 };
}

/** A turn that doesn't end until `release()`: an agent hanging on a command. */
function hang() {
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  return { gate, release };
}

async function setup(handler: FakeHandler, opts: { quietMs?: number; port?: number; notify?: unknown[]; policy?: string } = {}) {
  const workspace = mkdtempSync(path.join(tmpdir(), "sf-heal-ws-"));
  writeFileSync(path.join(workspace, "README.md"), "# Demo\n");
  if (opts.policy) {
    mkdirSync(path.join(workspace, ".factory"));
    writeFileSync(path.join(workspace, ".factory", "policy.yml"), opts.policy);
  }
  await ensureRepo(workspace);
  const dataDir = mkdtempSync(path.join(dataRoot, "case-"));
  const fake = await startFakeOpenHands({ onMessage: handler, port: opts.port });
  const ledger = openLedger(path.join(dataDir, "autopilot.db"));
  const notifyFetch = (async (_url: string, init: { body: string }) => {
    opts.notify?.push(JSON.parse(init.body));
    return new Response("ok");
  }) as unknown as typeof fetch;
  const o = createOrchestrator({ ledger, client: new OpenHandsClient({ baseUrl: fake.url }), workspace, dataDir, graceMs: 0, quietMs: opts.quietMs, outageAlertMs: 0, notifyFetch });
  const t = {
    fake,
    ledger,
    o,
    /** One tick, without waiting for the agent server's turns (some never end here). */
    async step() {
      await o.tick();
      await o.idle();
    },
    async until(done: () => boolean, opts: { max?: number; pause?: number } = {}) {
      for (let i = 0; i < (opts.max ?? 120) && !done(); i++) {
        await t.step();
        await sleep(opts.pause ?? 5);
      }
      assert.ok(done(), "the run didn't get there");
    },
    async buildingRun(n: number) {
      const run = await o.createRun({ goal: "Add claim status lookup", autonomy: "supervised", actor: "user:test" });
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

const auditOf = async (subject: string, action: string) => {
  await audit("test", "test.flush", "test");
  return listAudit(5000).filter((e) => e.subject === subject && e.action === action).reverse();
};

test("watchdog: a builder with no new events is nudged once, then stopped as stuck; a fresh builder takes over and nobody is asked", async () => {
  const stalled = hang();
  let first: string | undefined;
  const t = await setup(
    (conv) => {
      if (conv.tags.sfrole !== "builder") return { response: PASS, cost: 0.02 };
      first ??= conv.id;
      // The first builder hangs on every message, the nudge too; the next one builds.
      return conv.id === first ? stalled.gate.then(() => ({ response: "late" })) : build(conv);
    },
    { quietMs: 60 },
  );
  try {
    const run = await t.buildingRun(1);
    await t.until(() => t.ledger.getRun(run.id)?.state === "done", { pause: 25, max: 200 });
    const [stuck, fresh] = t.builders(run.id, 1);
    assert.equal(stuck?.state, "stuck");
    assert.match((stuck?.result as { error: string }).error, /No progress for 1 minute, even after a nudge, so Autopilot stopped it\./);
    assert.equal(stuck?.turns, 1, "the nudge isn't a repair turn");
    assert.equal(fresh?.state, "finished");
    const conv = t.fake.conversations.get(stuck!.conversationId)!;
    assert.equal(conv.messages.length, 2);
    assert.match(conv.messages[1]!, /hasn't seen any progress from you in 1 minute\..*If a command is hanging/s);
    assert.equal(conv.status, "paused");
    assert.deepEqual((await auditOf(run.id, "autopilot.agent_nudged")).map((e) => [e.data.role, e.data.attempt]), [["builder", stuck!.id]]);
    assert.deepEqual(t.ledger.listInbox({ state: "all", runId: run.id }).map((i) => i.kind), ["release"]);
  } finally {
    stalled.release();
    await t.close();
  }
});

test("watchdog: an agent whose events keep growing is left alone, however long it takes", async () => {
  const working = hang();
  let busy: FakeConversation | undefined;
  const t = await setup(
    (conv) => {
      if (conv.tags.sfrole !== "builder") return { response: PASS, cost: 0.02 };
      busy = conv;
      return working.gate.then(() => build(conv));
    },
    { quietMs: 60 },
  );
  try {
    const run = await t.buildingRun(1);
    for (let i = 0; i < 12; i++) {
      if (busy) busy.events++; // an action and its observation, and no cost (a subscription login)
      await t.step();
      await sleep(25);
    }
    working.release();
    await t.until(() => t.ledger.getRun(run.id)?.state === "done");
    assert.equal(t.builders(run.id, 1).length, 1);
    assert.deepEqual(await auditOf(run.id, "autopilot.agent_nudged"), []);
  } finally {
    working.release();
    await t.close();
  }
});

test("an agent server outage: runs wait, one notice after the outage lasts, one when it's back; builders it lost get a fresh agent that doesn't count", async () => {
  const notify: { title?: string; text?: string }[] = [];
  process.env.SF_NOTIFY_WEBHOOK = "https://hooks.example.test/factory";
  const working = hang();
  const t = await setup((conv) => (conv.tags.sfrole === "builder" ? working.gate.then(() => build(conv)) : { response: PASS, cost: 0.02 }), { notify });
  const port = Number(new URL(t.fake.url).port);
  let back: Awaited<ReturnType<typeof startFakeOpenHands>> | undefined;
  try {
    const run = await t.buildingRun(1);
    await t.until(() => t.builders(run.id, 1)[0]?.state === "running");
    working.release();
    await t.fake.close(); // the agent server goes away, and its conversations with it
    for (let i = 0; i < 4; i++) await t.step();
    assert.equal(t.ledger.getRun(run.id)?.state, "building", "nothing fails while it's away");
    assert.equal(t.builders(run.id, 1)[0]?.state, "running");
    const status = await t.o.status();
    assert.equal(status.agentServer.reachable, false);
    assert.ok(status.agentServer.downSince);
    assert.equal((await auditOf("agent-server", "autopilot.agent_server_down")).length, 1);

    back = await startFakeOpenHands({ onMessage: (conv) => (conv.tags.sfrole === "builder" ? build(conv) : { response: PASS, cost: 0.02 }), port });
    await t.until(() => t.ledger.getRun(run.id)?.state === "done");
    const [lost, fresh] = t.builders(run.id, 1);
    assert.deepEqual(lost?.result, { error: "The conversation is gone from the agent server.", lost: true });
    assert.equal(fresh?.state, "finished");
    assert.equal((await t.o.status()).agentServer.downSince, null);
    assert.equal((await auditOf("agent-server", "autopilot.agent_server_back")).length, 1);
    assert.deepEqual(t.ledger.listInbox({ state: "all", runId: run.id }).map((i) => i.kind), ["release"]);
    await t.o.idle();
    const notices = notify.map((n) => n.title).filter((x) => x !== "Autopilot needs you");
    assert.deepEqual(notices, ["Autopilot can't reach the agent server", "The agent server is back"]);
    assert.ok(!JSON.stringify(notify).includes("Add claim status lookup"), "no goals in notices");
  } finally {
    delete process.env.SF_NOTIFY_WEBHOOK;
    working.release();
    await t.close().catch(() => undefined);
    await back?.close();
  }
});

test("a spec agent or reviewer that stops without finishing is started again once; a second stop goes to a person", async () => {
  const scripted = scriptedAgents({ noBugs: true });
  const seen = new Map<string, number>();
  const t = await setup(async (conv, text) => {
    const role = conv.tags.sfrole ?? "";
    const key = `${role}:${conv.tags.sfwo ?? ""}`;
    if (conv.messages.length === 1) seen.set(key, (seen.get(key) ?? 0) + 1);
    const n = seen.get(key) ?? 0;
    // The first spec agent crashes; WO-1's reviewer crashes once, WO-2's twice.
    if ((role === "spec" && n === 1) || (key === "reviewer:1" && n === 1) || (key === "reviewer:2" && n <= 2)) return { response: "Crashed.", status: "error" as const };
    return scripted(conv, text);
  });
  try {
    const run = await t.o.createRun({ goal: "Let applicants check a claim's status", autonomy: "autonomous", actor: "user:test" });
    await t.until(() => t.ledger.listInbox({ runId: run.id }).some((i) => i.kind === "error"), { max: 200 });
    const restarts = (await auditOf(run.id, "autopilot.agent_restarted")).map((e) => `${e.data.role}:${e.data.workOrder ?? ""}`);
    assert.deepEqual(restarts.sort(), ["reviewer:" + `${run.id}/WO-1`, "reviewer:" + `${run.id}/WO-2`, "spec:"].sort());
    const item = t.ledger.listInbox({ runId: run.id }).find((i) => i.kind === "error")!;
    assert.equal(item.workOrderId, `${run.id}/WO-2`);
    assert.match(item.body, /The reviewer stopped with status "error"/);
    assert.equal(t.ledger.listAttempts({ runId: run.id, role: "spec" }).length, 2);
    assert.equal(t.ledger.getWorkOrder(`${run.id}/WO-1`)?.state !== "needs_attention", true);
  } finally {
    await t.close();
  }
});

test("pinnedPolicy: a setting added after a run was pinned reads as its default", () => {
  const { selfHealing: _s, release: _r, ...old } = DEFAULT_POLICY;
  const pinned = pinnedPolicy({ policy: { ...old, autoMerge: { maxChangedLines: 50, sensitivePaths: [], dependencyAllowlist: [] } } });
  assert.deepEqual(pinned.selfHealing, DEFAULT_POLICY.selfHealing);
  assert.deepEqual(pinned.release, { auto: false });
  assert.equal(pinned.autoMerge.maxChangedLines, 50);
  assert.equal(pinnedPolicy({ policy: null }), DEFAULT_POLICY);
});

test("a gate that fails once and passes when run again counts as passed, marked flaky; with rerunFailedGates off it goes to the builder", async () => {
  for (const rerun of [true, false]) {
    const marker = path.join(mkdtempSync(path.join(tmpdir(), "sf-flaky-")), "ran");
    const t = await setup(
      (conv) => {
        if (conv.tags.sfrole !== "builder") return { response: PASS, cost: 0.02 };
        if (conv.messages.length > 1) return { response: "Looked again; nothing to change." };
        writeFileSync(path.join(conv.workingDir, "package.json"), PKG);
        // Fails the first time it ever runs, passes after: a flaky test.
        const body = `const m = ${JSON.stringify(marker)}; if (!existsSync(m)) { writeFileSync(m, "1"); throw new Error("timing"); }`;
        writeFileSync(path.join(conv.workingDir, "flaky.test.js"), `import { test } from "node:test";\nimport { existsSync, writeFileSync } from "node:fs";\ntest("flaky", () => { ${body} });\n`);
        return { response: "Built it.", cost: 0.1 };
      },
      { policy: rerun ? undefined : "selfHealing: { rerunFailedGates: false }\n" },
    );
    try {
      const run = await t.buildingRun(1);
      await t.until(() => t.ledger.getRun(run.id)?.state === "done");
      const builder = t.builders(run.id, 1)[0]!;
      const checks = t.ledger.listChecks({ runId: run.id, workOrderId: `${run.id}/WO-1` }).filter((c) => c.stage === "build" && c.name === "test");
      if (rerun) {
        assert.equal(t.fake.conversations.get(builder.conversationId)?.messages.length, 1, "no repair round for a flaky test");
        assert.deepEqual(checks.map((c) => c.ok), [true]);
        assert.match(checks[0]!.output, /\[Flaky: it failed the first time \(exit code 1\) and passed when run again\./);
        const runs = (await auditOf(run.id, "autopilot.gates_run")).filter((e) => e.data.stage === "build");
        assert.deepEqual(runs.map((e) => e.data.flaky), [["test"]]);
      } else {
        assert.equal(t.fake.conversations.get(builder.conversationId)?.messages.length, 2);
        assert.deepEqual(checks.map((c) => c.ok), [false, true]);
      }
    } finally {
      await t.close();
    }
  }
});

test("merge conflicts have rounds of their own: with no repair rounds at all, the builder still resolves one; with conflictRounds 0 it's a failure", async () => {
  const builder: FakeHandler = (conv) => {
    if (conv.tags.sfrole !== "builder") return { response: PASS, cost: 0.02 };
    const shared = path.join(conv.workingDir, "shared.txt");
    if (conv.messages.length === 1) {
      writeFileSync(shared, `from WO-${conv.tags.sfwo}\n`);
      return build(conv);
    }
    assert.match(readFileSync(shared, "utf8"), /<<<<<<</);
    writeFileSync(shared, "from WO-1\nfrom WO-2\n");
    return { response: "Resolved the conflict." };
  };
  const t = await setup(builder, { policy: "repair: { sameConversation: 0, fresh: 0 }\n" });
  try {
    const run = await t.buildingRun(2);
    await t.until(() => t.ledger.getRun(run.id)?.state === "done");
    assert.deepEqual(t.states(run.id), ["1:merged", "2:merged"]);
    const [conflicted] = (await auditOf(run.id, "autopilot.merge_conflicted")).map((e) => Number(String(e.data.workOrder).slice(3)));
    const b = t.builders(run.id, conflicted!)[0]!;
    assert.deepEqual([b.turns, b.freeTurns], [2, 1]);
    assert.equal(t.ledger.getWorkOrder(`${run.id}/WO-${conflicted}`)?.conflictRounds, 1);
    assert.deepEqual((await auditOf(run.id, "autopilot.repair_requested")).map((e) => e.data.conflictRound), [1]);
  } finally {
    await t.close();
  }

  const capped = await setup(builder, { policy: "repair: { sameConversation: 0, fresh: 0 }\nselfHealing: { conflictRounds: 0 }\n" });
  try {
    const run = await capped.buildingRun(2);
    await capped.until(() => capped.ledger.listInbox({ runId: run.id }).some((i) => i.kind === "work_order_failed"));
    assert.match(capped.ledger.listInbox({ runId: run.id }).find((i) => i.kind === "work_order_failed")!.body, /conflicts in: shared\.txt/);
  } finally {
    await capped.close();
  }
});
