import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { FakeHandler, FakeProfile } from "./fake-openhands.js";

const dataRoot = mkdtempSync(path.join(tmpdir(), "sf-isolation-"));
process.env.SF_DATA_DIR = path.join(dataRoot, "audit");
process.env.SF_WORKSPACE = mkdtempSync(path.join(tmpdir(), "sf-isolation-unused-"));
delete process.env.SF_AUTONOMY_CAP;
delete process.env.SF_REQUIRE_ISOLATION;
const { createOrchestrator } = await import("../src/autopilot/orchestrator.js");
const { openLedger } = await import("../src/autopilot/ledger.js");
const { OpenHandsClient } = await import("../src/autopilot/openhands.js");
const { audit, listAudit } = await import("../src/audit.js");
const { createFakeDocker } = await import("./fake-docker.js");
const { startFakeOpenHands } = await import("./fake-openhands.js");

const IMAGE = `ghcr.io/openhands/agent-server@sha256:${"b".repeat(64)}`;
const CLAUDE: FakeProfile = { id: "11111111-1111-4111-8111-111111111111", name: "claude", agent_kind: "acp", acp_server: "claude-code" };
const CODEX: FakeProfile = { id: "22222222-2222-4222-8222-222222222222", name: "codex", agent_kind: "acp", acp_server: "codex" };
const PASS = '```json\n{"verdict":"pass","findings":[]}\n```';
const CONTAINER_POLICY = `execution:\n  provider: container\n  container:\n    image: '${IMAGE}'\n    network: sf-agents\n    credentials: { builder: [ANTHROPIC_API_KEY] }\n`;

function writePackage(dir: string) {
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "wo", private: true, type: "module", scripts: { test: "node --test" } }));
  writeFileSync(path.join(dir, "sum.js"), "export const sum = (a, b) => a + b;\n");
  writeFileSync(path.join(dir, "sum.test.js"), 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { sum } from "./sum.js";\ntest("sum adds", () => assert.equal(sum(1, 2), 3));\n');
  return { response: "Built and tested.", cost: 0.1 };
}

async function setup(opts: { policy?: string; handler: FakeHandler }) {
  const workspace = mkdtempSync(path.join(tmpdir(), "sf-isolation-ws-"));
  writeFileSync(path.join(workspace, "README.md"), "# Demo\n");
  if (opts.policy) {
    mkdirSync(path.join(workspace, ".factory"));
    writeFileSync(path.join(workspace, ".factory", "policy.yml"), opts.policy);
  }
  const dataDir = mkdtempSync(path.join(dataRoot, "case-"));
  const host = await startFakeOpenHands({ profiles: [CLAUDE, CODEX], onMessage: opts.handler });
  const docker = createFakeDocker({ images: [IMAGE], networks: ["sf-agents"], onMessage: opts.handler });
  const file = path.join(dataDir, "autopilot.db");
  let ledger = openLedger(file);
  const make = () =>
    createOrchestrator({ ledger, client: new OpenHandsClient({ baseUrl: host.url }), workspace, dataDir, graceMs: 0, docker: docker.docker, env: { ANTHROPIC_API_KEY: "sk-test" }, controlPorts: [4317] });
  let o = make();
  return {
    workspace,
    dataDir,
    host,
    docker,
    get ledger() { return ledger; },
    get o() { return o; },
    restart() {
      o.stop();
      ledger.close();
      ledger = openLedger(file);
      o = make();
    },
    /** Ticks until `done`; `settle: false` doesn't wait for agent turns (one a test holds open). */
    async until(done: () => boolean, { max = 80, settle = true } = {}) {
      for (let i = 0; i < max; i++) {
        await o.tick();
        await o.idle();
        if (settle) {
          await host.settled();
          for (const c of docker.state.containers.values()) await c.server?.settled();
        } else await new Promise((resolve) => setTimeout(resolve, 20));
        if (done()) return;
      }
      assert.fail("the run didn't get there");
    },
    async buildingRun() {
      const run = await o.createRun({ goal: "Add a sum function", autonomy: "supervised", actor: "user:test" });
      ledger.addWorkOrders(run.id, [{ seq: 1, title: "Sum", acceptance: ["sum adds"], controls: [], dependsOn: [], wave: 1, risk: "low" }]);
      return ledger.updateRun(run.id, { state: "building" });
    },
    async close() {
      o.stop();
      await o.idle();
      await docker.close();
      await host.close();
      ledger.close();
    },
  };
}

const byRole = (roles: Record<string, FakeHandler>): FakeHandler => (conv, text) => (roles[conv.tags.sfrole ?? ""] ?? (() => ({ response: PASS, cost: 0.02 })))(conv, text);

test("container execution: the builder, its gates and its reviewer run isolated, and their containers go once the work merges", async () => {
  let reviewerSaw = "";
  const t = await setup({
    policy: CONTAINER_POLICY,
    handler: byRole({
      builder: (conv) => writePackage(conv.hostDir),
      reviewer: (conv, text) => {
        reviewerSaw = text;
        return { response: PASS, cost: 0.02 };
      },
    }),
  });
  try {
    const run = await t.buildingRun();
    await t.until(() => t.ledger.getRun(run.id)?.state === "done");

    const [builder] = t.ledger.listAttempts({ runId: run.id, role: "builder" });
    const [reviewer] = t.ledger.listAttempts({ runId: run.id, role: "reviewer" });
    for (const a of [builder!, reviewer!]) {
      const facts = a.runtime as { provider: string; container: string; released: boolean; image: string; credentials: string[] };
      assert.equal(facts.provider, "container");
      assert.equal(facts.container, `sf-${run.id}-a${a.id}`);
      assert.equal(facts.image, IMAGE);
      assert.equal(facts.released, true, `${a.role}'s container is removed once it can get no more messages`);
    }
    assert.deepEqual((builder!.runtime as { credentials: string[] }).credentials, ["ANTHROPIC_API_KEY"]);
    assert.deepEqual((reviewer!.runtime as { credentials: string[] }).credentials, [], "only the builder role gets the credential");
    assert.equal(t.docker.state.containers.size, 0);

    // The reviewer had no git: it read the diff the factory put in its read-only inputs.
    assert.match(reviewerSaw, /\/factory\/changes\.diff/);
    const diff = readFileSync(path.join(t.dataDir, "runtime", run.id, `a${reviewer!.id}`, "inputs", "changes.diff"), "utf8");
    assert.match(diff, /sum\.js/);

    // Every gate ran in a throwaway container, in build and after the merge.
    const checks = t.ledger.listChecks({ runId: run.id });
    assert.deepEqual(checks.map((c) => `${c.stage}:${c.name}:${c.runner}:${c.ok}`), ["build:test:container:true", "build:verified:null:true", "integrate:test:container:true"]);
    assert.equal(t.docker.callsOf("run", "--rm").filter((c) => c.args.includes("sh")).length, 2);

    const evidence = await t.o.evidence(run.id, "user:test");
    assert.equal(evidence.packet.assurance.isolation, "container");
    assert.deepEqual(evidence.packet.run.execution, { provider: "container", isolated: true });
    const text = JSON.stringify(evidence.packet);
    assert.ok(!text.includes(t.dataDir) && !text.includes(t.workspace), "no host paths in evidence");
    assert.ok(!text.includes(`sf-${run.id}-a`), "no container names in evidence");
    assert.ok(!text.includes("sk-test"), "no credential values in evidence");
    await audit("test", "test.flush", "test");
    assert.ok(listAudit().some((e) => e.subject === run.id && e.action === "autopilot.runtime_removed"));
  } finally {
    await t.close();
  }
});

test("container execution: after a restart the builder's container is found again; a lost container ends its attempt and a fresh builder takes over", async () => {
  let hold: (() => void) | undefined;
  let builds = 0;
  const t = await setup({
    policy: CONTAINER_POLICY,
    handler: byRole({
      builder: async (conv) => {
        if (++builds === 1) {
          await new Promise<void>((resolve) => (hold = resolve));
          return { response: "Lost.", cost: 0.01 };
        }
        return writePackage(conv.hostDir);
      },
    }),
  });
  try {
    const run = await t.buildingRun();
    await t.until(() => !!hold && t.ledger.listAttempts({ runId: run.id, role: "builder" })[0]?.state === "running", { settle: false });
    const [first] = t.ledger.listAttempts({ runId: run.id, role: "builder" });
    const name = `sf-${run.id}-a${first!.id}`;

    t.restart();
    await t.o.tick();
    await t.o.idle();
    assert.equal(t.ledger.getAttempt(first!.id)?.state, "running", "the new process reconnected to the running container");

    hold!();
    await t.docker.docker(["rm", "-f", name]); // the container dies (Docker restarted, someone removed it)
    await t.until(() => t.ledger.getRun(run.id)?.state === "done");
    const lost = t.ledger.getAttempt(first!.id)!;
    assert.equal(lost.state, "error");
    assert.match((lost.result as { error: string }).error, /container .* is gone/);
    const builders = t.ledger.listAttempts({ runId: run.id, role: "builder" });
    assert.equal(builders.length, 2, "a fresh builder in a new container replaced the lost one");
    assert.notEqual((builders[1]!.runtime as { container: string }).container, name);
  } finally {
    await t.close();
  }
});

test("execution a policy requires and this machine can't give is refused: no run starts, and a local run stops once isolation is required", async () => {
  const t = await setup({ policy: CONTAINER_POLICY, handler: () => ({ response: "Done.", cost: 0 }) });
  try {
    t.docker.state.up = false;
    await assert.rejects(t.o.createRun({ goal: "Add a sum function", actor: "user:test" }), /can't run agents the way the policy requires: Docker isn't reachable/);
    assert.equal(t.ledger.listRuns().length, 0);
    await audit("test", "test.flush", "test");
    const checked = listAudit().find((e) => e.action === "autopilot.execution_checked");
    assert.equal(checked?.data.ok, false);
  } finally {
    await t.close();
  }

  const local = await setup({ handler: byRole({ builder: () => ({ response: "Waiting.", cost: 0 }) }) });
  try {
    const run = await local.buildingRun();
    await local.until(() => local.ledger.listAttempts({ runId: run.id, role: "builder" }).length === 1);
    assert.deepEqual(local.ledger.listAttempts({ runId: run.id, role: "builder" })[0]?.runtime, { provider: "local", isolated: false });
    process.env.SF_REQUIRE_ISOLATION = "1";
    await assert.rejects(local.o.createRun({ goal: "Another one", actor: "user:test" }), /requires isolated execution/);
    await local.o.tick();
    await local.o.idle();
    const paused = local.ledger.getRun(run.id)!;
    assert.equal(paused.state, "paused");
    assert.match(paused.pausedReason ?? "", /SF_REQUIRE_ISOLATION/);
    assert.ok(existsSync(local.workspace));
  } finally {
    delete process.env.SF_REQUIRE_ISOLATION;
    await local.close();
  }
});
