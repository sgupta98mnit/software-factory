import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { DockerResult } from "../src/autopilot/execution.js";
import type { FakeHandler, FakeProfile } from "./fake-openhands.js";

const dataRoot = mkdtempSync(path.join(tmpdir(), "sf-trusted-"));
process.env.SF_DATA_DIR = path.join(dataRoot, "audit");
process.env.SF_WORKSPACE = mkdtempSync(path.join(tmpdir(), "sf-trusted-unused-"));
delete process.env.SF_AUTONOMY_CAP;
delete process.env.SF_REQUIRE_ISOLATION;
const { createOrchestrator } = await import("../src/autopilot/orchestrator.js");
const { openLedger } = await import("../src/autopilot/ledger.js");
const { OpenHandsClient } = await import("../src/autopilot/openhands.js");
const { fileAt, git } = await import("../src/autopilot/git.js");
const { audit, listAudit } = await import("../src/audit.js");
const { startFakeOpenHands } = await import("./fake-openhands.js");

const CLAUDE: FakeProfile = { id: "11111111-1111-4111-8111-111111111111", name: "claude", agent_kind: "acp", acp_server: "claude-code" };
const CODEX: FakeProfile = { id: "22222222-2222-4222-8222-222222222222", name: "codex", agent_kind: "acp", acp_server: "codex" };
const PASS = '```json\n{"verdict":"pass","findings":[]}\n```';
const SUM_TEST = 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { sum } from "./sum.js";\ntest("sum adds", () => assert.equal(sum(1, 2), 3));\n';
const AWS_KEY = "AKIAIOSFODNN7EXAMPLE"; // AWS's documented example key: a secret-shaped value that must never be echoed

const byRole = (roles: Record<string, FakeHandler>): FakeHandler => (conv, text) => (roles[conv.tags.sfrole ?? ""] ?? (() => ({ response: PASS, cost: 0.01 })))(conv, text);

/** A fake Trivy CLI: its version and database date can be changed; scans report a base vulnerability and any AWS key in config.js. */
function fakeTrivy() {
  const state = { version: "0.58.1", dbAgeHours: 1, missing: false, scans: 0 };
  const runner = async (args: string[]): Promise<DockerResult> => {
    if (state.missing) return { code: -1, stdout: "", stderr: "spawn trivy ENOENT" };
    if (args[0] === "--version") {
      const updated = new Date(Date.now() - state.dbAgeHours * 3_600_000).toISOString();
      return { code: 0, stdout: JSON.stringify({ Version: state.version, VulnerabilityDB: { Version: 2, UpdatedAt: updated, NextUpdate: updated } }), stderr: "" };
    }
    state.scans++;
    const dir = args.at(-1)!;
    const results: unknown[] = [{ Target: "package-lock.json", Class: "lang-pkgs", Vulnerabilities: [{ VulnerabilityID: "CVE-2020-0001", PkgName: "old-lib", InstalledVersion: "1.0.0", FixedVersion: "1.0.1", Severity: "HIGH", Title: "Already on the base" }] }];
    const config = path.join(dir, "config.js");
    if (existsSync(config) && readFileSync(config, "utf8").includes("AKIA")) {
      results.push({ Target: "config.js", Class: "secret", Secrets: [{ RuleID: "aws-access-key-id", Category: "AWS", Severity: "CRITICAL", Title: "AWS Access Key ID", StartLine: 1, EndLine: 1, Match: `const key = "${AWS_KEY}"`, Code: { Lines: [{ Content: AWS_KEY }] } }] });
    }
    return { code: 0, stdout: JSON.stringify({ SchemaVersion: 2, Results: results }), stderr: "" };
  };
  return { state, runner };
}

async function setup(opts: { policy?: string; handler: FakeHandler }) {
  const workspace = mkdtempSync(path.join(tmpdir(), "sf-trusted-ws-"));
  writeFileSync(path.join(workspace, "package.json"), JSON.stringify({ name: "demo", private: true, type: "module", scripts: { test: "node --test" } }, null, 2));
  writeFileSync(path.join(workspace, "sum.js"), "export const sum = (a, b) => a + b;\n");
  writeFileSync(path.join(workspace, "sum.test.js"), SUM_TEST);
  mkdirSync(path.join(workspace, ".factory"));
  writeFileSync(path.join(workspace, ".factory", "policy.yml"), opts.policy ?? "parallel: 2\n");
  const dataDir = mkdtempSync(path.join(dataRoot, "case-"));
  const fake = await startFakeOpenHands({ profiles: [CLAUDE, CODEX], onMessage: opts.handler });
  const trivy = fakeTrivy();
  const ledger = openLedger(path.join(dataDir, "autopilot.db"));
  const o = createOrchestrator({ ledger, client: new OpenHandsClient({ baseUrl: fake.url }), workspace, dataDir, graceMs: 0, trivy: trivy.runner });
  return {
    workspace,
    dataDir,
    fake,
    trivy,
    ledger,
    o,
    async until(done: () => boolean, max = 80) {
      for (let i = 0; i < max; i++) {
        await o.tick();
        await o.idle();
        await fake.settled();
        if (done()) return;
      }
      const runs = ledger.listRuns().map((r) => ({ state: r.state, wos: ledger.listWorkOrders(r.id).map((w) => w.state), inbox: ledger.listInbox({ state: "all", runId: r.id }).map((i) => `${i.kind}:${i.state}`), checks: ledger.listChecks({ runId: r.id }).map((c) => `${c.name}:${c.ok}`) }));
      assert.fail(`the run didn't get there: ${JSON.stringify(runs)}`);
    },
    async buildingRun(autonomy: "suggest" | "supervised" = "supervised") {
      const run = await o.createRun({ goal: "Add a sum function", autonomy, actor: "user:test" });
      ledger.addWorkOrders(run.id, [{ seq: 1, title: "Sum", acceptance: ["sum adds"], controls: [], dependsOn: [], wave: 1, risk: "low" }]);
      return ledger.updateRun(run.id, { state: "building" });
    },
    wo: (runId: string) => ledger.getWorkOrder(`${runId}/WO-1`)!,
    checks: (runId: string) => ledger.listChecks({ runId, workOrderId: `${runId}/WO-1` }).map((c) => `${c.stage}:${c.name}:${c.ok ? "ok" : "failed"}`),
    builder: (runId: string) => fake.conversations.get(ledger.listAttempts({ runId, role: "builder" }).at(-1)!.conversationId)!,
    async close() {
      o.stop();
      await o.idle();
      await fake.close();
      ledger.close();
    },
  };
}

const audited = async (runId: string, action: string) => {
  await audit("test", "test.flush", "test");
  return listAudit().filter((e) => e.subject === runId && e.action === action);
};

test("pinned checks: the base branch's test script runs whatever the work order makes of it, its .factory edit is put back, and changing a pinned script needs a person", async () => {
  let rounds = 0;
  const t = await setup({
    handler: byRole({
      builder: (conv) => {
        const dir = conv.workingDir;
        if (++rounds === 1) {
          // Weakens the test script, breaks the code, and tries to loosen the factory's rules.
          writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "demo", private: true, type: "module", scripts: { test: "exit 0" } }, null, 2));
          writeFileSync(path.join(dir, "sum.js"), "export const sum = (a, b) => a - b;\n");
          writeFileSync(path.join(dir, ".factory", "policy.yml"), "parallel: 2\nautoMerge: { maxChangedLines: 100000 }\n");
        } else writeFileSync(path.join(dir, "sum.js"), "export const sum = (a, b) => a + b;\n");
        return { response: "Done.", cost: 0.05 };
      },
    }),
  });
  try {
    const run = await t.buildingRun();
    const pinned = run.verification as { source: string; gates: unknown[] };
    assert.equal(pinned.source, "base");
    assert.deepEqual(pinned.gates, [{ name: "test", run: "node --test", bin: true }]);
    await t.until(() => t.wo(run.id).state === "awaiting_merge_approval");

    assert.deepEqual(t.checks(run.id), ["build:protected-paths:failed", "build:test:failed", "build:test:ok", "build:verified:ok"]);
    // The base's `node --test` ran, not the branch's `exit 0`: the broken sum failed, and the builder heard why.
    assert.match(t.builder(run.id).messages[1] ?? "", /node --test/);
    assert.equal(await fileAt(t.workspace, t.wo(run.id).branch!, ".factory/policy.yml"), "parallel: 2\n", "the factory put its rules back");
    assert.equal((await audited(run.id, "autopilot.protected_paths_restored")).length, 1);
    const item = t.ledger.listInbox({ runId: run.id }).find((i) => i.kind === "merge_approval")!;
    assert.match(item.body, /Changes the checks this run pinned from its base, which later runs would pin: test/);
  } finally {
    await t.close();
  }
});

test("hidden tests: the test writer's tests are kept outside every worktree; a failing one sends back its scenario and one assertion line, never its source; integration runs them again", async () => {
  const hiddenTest = '// SOURCE-MARKER: the builder must never see this line\nimport { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { sum } from "../sum.js";\ntest("sum adds", () => assert.equal(sum(2, 2), 4));\n';
  let rounds = 0;
  const t = await setup({
    policy: "parallel: 2\nhiddenTests: { enabled: true }\n",
    handler: byRole({
      validator: (conv) => {
        mkdirSync(path.join(conv.workingDir, ".hidden-tests"), { recursive: true });
        writeFileSync(path.join(conv.workingDir, ".hidden-tests", "wo-1-sum-adds.test.mjs"), hiddenTest);
        writeFileSync(path.join(conv.workingDir, ".hidden-tests", "notes.txt"), "ignored: not a test file");
        return { response: "Wrote .hidden-tests/wo-1-sum-adds.test.mjs", cost: 0.02 };
      },
      builder: (conv) => {
        // Round 1 passes its own test (1 + 2) but not the hidden one (2 + 2).
        const body = ++rounds === 1 ? "a === 2 ? 5 : a + b" : "a + b";
        writeFileSync(path.join(conv.workingDir, "sum.js"), `export const sum = (a, b) => ${body};\n`);
        return { response: "Done.", cost: 0.05 };
      },
    }),
  });
  try {
    const run = await t.buildingRun();
    await t.until(() => t.ledger.getRun(run.id)?.state === "done");

    const v = t.ledger.getRun(run.id)!.verification as { hiddenTests: { files: { name: string; seq: number; sha256: string }[]; digest: string } };
    assert.deepEqual(v.hiddenTests.files.map((f) => `${f.seq}:${f.name}`), ["1:wo-1-sum-adds.test.mjs"]);
    assert.equal(readFileSync(path.join(t.dataDir, "hidden-tests", run.id, "wo-1-sum-adds.test.mjs"), "utf8"), hiddenTest);
    assert.ok(!existsSync(path.join(t.dataDir, "worktrees", run.id, "validator")), "the test writer's worktree is gone");
    assert.equal((await git(t.workspace, ["branch", "--list", `${run.integrationBranch}--validator`])).stdout.trim(), "");

    assert.deepEqual(t.checks(run.id).filter((c) => c.includes("hidden")), ["build:hidden:wo-1-sum-adds:failed", "build:hidden:wo-1-sum-adds:ok", "integrate:hidden:wo-1-sum-adds:ok"]);
    const repair = t.builder(run.id).messages[1] ?? "";
    assert.match(repair, /Hidden acceptance test for scenario "sum-adds" failed: .*(Expected|assert)/i);
    assert.ok(!repair.includes("SOURCE-MARKER") && !repair.includes("sum(2, 2)"), "the test's source stays hidden");
    const failed = t.ledger.listChecks({ runId: run.id }).find((c) => c.name === "hidden:wo-1-sum-adds" && !c.ok)!;
    assert.ok(!failed.output.includes("SOURCE-MARKER"));

    const evidence = await t.o.evidence(run.id, "user:test");
    assert.equal(evidence.packet.assurance.independentValidation, "recorded");
    assert.deepEqual(evidence.packet.verification?.hiddenTests, { count: 1, digest: v.hiddenTests.digest });
    assert.ok(evidence.packet.checks.every((c) => c.commitBinding === "recorded" || c.name === "hidden-tests-written"));
  } finally {
    await t.close();
  }
});

test("trivy: a required scanner of the wrong version or with a stale database stops the work order until it's fixed; a new secret goes back by rule and line, never its value; what the base already has doesn't block", async () => {
  let rounds = 0;
  const t = await setup({
    policy: "parallel: 2\nverification: { trivy: { mode: required, version: 0.58.1 } }\n",
    handler: byRole({
      builder: (conv) => {
        if (++rounds === 1) writeFileSync(path.join(conv.workingDir, "config.js"), `export const key = "${AWS_KEY}";\n`);
        else writeFileSync(path.join(conv.workingDir, "config.js"), "export const key = process.env.API_KEY;\n");
        return { response: "Done.", cost: 0.05 };
      },
    }),
  });
  try {
    t.trivy.state.version = "0.57.0";
    const run = await t.buildingRun();
    await t.until(() => t.wo(run.id).state === "needs_attention");
    let item = t.ledger.listInbox({ runId: run.id }).find((i) => i.kind === "error" && i.state === "open")!;
    assert.match(item.body, /required security scan can't run: Trivy 0\.57\.0 is installed; the policy accepts only 0\.58\.1/);

    t.trivy.state.version = "0.58.1";
    t.trivy.state.dbAgeHours = 24 * 10;
    await t.o.decide(item.id, { choice: "retry" }, "user:test");
    await t.until(() => t.wo(run.id).state === "needs_attention" && t.ledger.listInbox({ runId: run.id }).some((i) => i.kind === "error" && i.state === "open"));
    item = t.ledger.listInbox({ runId: run.id }).find((i) => i.kind === "error" && i.state === "open")!;
    assert.match(item.body, /more than 72 hours old/);
    assert.equal(t.wo(run.id).mergedBy, null);

    t.trivy.state.dbAgeHours = 1;
    await t.o.decide(item.id, { choice: "retry" }, "user:test");
    await t.until(() => t.ledger.getRun(run.id)?.state === "done");

    const repair = t.builder(run.id).messages[1] ?? "";
    assert.match(repair, /Possible secret \(aws-access-key-id\) in config\.js:1/);
    const everything = JSON.stringify([repair, t.ledger.listChecks({ runId: run.id }), t.ledger.listInbox({ state: "all", runId: run.id })]);
    assert.ok(!everything.includes(AWS_KEY), "the secret's value is nowhere in what the factory keeps");
    assert.ok(!everything.includes("CVE-2020-0001 in old-lib") || !repair.includes("CVE-2020-0001"), "the base's vulnerability never went back to the builder");
    assert.ok(!repair.includes("CVE-2020-0001"));

    const scans = t.ledger.listChecks({ runId: run.id }).filter((c) => c.name === "trivy");
    assert.deepEqual(scans.map((c) => (c.meta as { status: string }).status), ["unavailable", "unavailable", "findings", "passed"]);
    const passed = scans.at(-1)!.meta as { version: string; dbUpdatedAt: string; resultSha256: string; new: { vuln: number } };
    assert.equal(passed.version, "0.58.1");
    assert.match(passed.resultSha256, /^[0-9a-f]{64}$/);
    assert.equal(passed.new.vuln, 0, "the vulnerability the base already had isn't new");
    const evidence = await t.o.evidence(run.id, "user:test");
    assert.equal(evidence.packet.assurance.securityScan, "recorded");
    assert.ok(!JSON.stringify(evidence).includes(AWS_KEY));
  } finally {
    await t.close();
  }
});

test("a merge approval can't merge a commit that wasn't verified: the moved head is verified first and approved again", async () => {
  const t = await setup({
    handler: byRole({
      builder: (conv) => {
        writeFileSync(path.join(conv.workingDir, "sum.js"), "export const sum = (a, b) => a + b; // reviewed\n");
        return { response: "Done.", cost: 0.05 };
      },
    }),
  });
  try {
    const run = await t.buildingRun("suggest");
    await t.until(() => t.wo(run.id).state === "awaiting_merge_approval");
    const first = t.ledger.listInbox({ runId: run.id }).find((i) => i.kind === "merge_approval")!;
    // Something commits to the work order's branch after it was verified and shown to the approver.
    const wo = t.wo(run.id);
    writeFileSync(path.join(wo.worktree!, "extra.js"), "export const extra = 1;\n");
    await git(wo.worktree!, ["add", "extra.js"]);
    await git(wo.worktree!, ["commit", "-m", "unreviewed change"]);
    const moved = (await git(wo.worktree!, ["rev-parse", "HEAD"])).stdout.trim();

    await t.o.decide(first.id, { choice: "merge" }, "user:approver");
    await t.until(() => t.ledger.listInbox({ state: "all", runId: run.id }).filter((i) => i.kind === "merge_approval").length === 2);
    assert.equal(t.wo(run.id).state, "awaiting_merge_approval", "not merged on the old approval");
    assert.ok(t.ledger.listChecks({ runId: run.id }).some((c) => c.name === "verified" && c.sha === moved), "the moved head was verified first");
    assert.equal((await audited(run.id, "autopilot.verification_required")).length, 1);

    const second = t.ledger.listInbox({ runId: run.id }).find((i) => i.kind === "merge_approval" && i.state === "open")!;
    await t.o.decide(second.id, { choice: "merge" }, "user:approver");
    await t.until(() => t.wo(run.id).state === "merged");
    // The review step puts the branch back on what the builder built, so the commit nobody built never merges.
    const built = (t.ledger.listAttempts({ runId: run.id, role: "builder" }).at(-1)!.result as { sha: string }).sha;
    const contains = async (sha: string) => (await git(t.workspace, ["merge-base", "--is-ancestor", sha, run.integrationBranch], { allowFail: true })).code === 0;
    assert.equal(await contains(built), true);
    assert.equal(await contains(moved), false);
  } finally {
    await t.close();
  }
});

test("gatesAt pins script bodies (with pre/post scripts) from a commit, root and one folder down; parseReport keeps no secret text", async () => {
  const { gatesAt } = await import("../src/autopilot/gates.js");
  const { parseReport } = await import("../src/autopilot/scanner.js");
  const repo = mkdtempSync(path.join(tmpdir(), "sf-trusted-pin-"));
  writeFileSync(path.join(repo, "package.json"), JSON.stringify({ scripts: { pretest: "tsc", test: "node --test", lint: "eslint ." } }));
  mkdirSync(path.join(repo, "api"));
  writeFileSync(path.join(repo, "api", "package.json"), JSON.stringify({ scripts: { test: "vitest run", posttest: "node report.js" } }));
  mkdirSync(path.join(repo, "node_modules", "x"), { recursive: true });
  writeFileSync(path.join(repo, "node_modules", "x", "package.json"), JSON.stringify({ scripts: { test: "never" } }));
  await git(repo, ["init", "-b", "main"]);
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-m", "base"]);
  assert.deepEqual(await gatesAt(repo, "HEAD"), [
    { name: "lint", run: "eslint .", cwd: undefined, bin: true },
    { name: "test", run: "tsc && node --test", cwd: undefined, bin: true },
    { name: "api:test", run: "vitest run && node report.js", cwd: "api", bin: true },
  ]);
  const found = parseReport({ Results: [{ Target: "a.js", Secrets: [{ RuleID: "github-pat", Severity: "HIGH", Title: "GitHub token", StartLine: 3, Match: "ghp_SECRET", Code: { Lines: [{ Content: "ghp_SECRET" }] } }] }] });
  assert.deepEqual(found, [{ kind: "secret", severity: "high", id: "github-pat", target: "a.js", title: "GitHub token", line: 3 }]);
});
