import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.SF_DATA_DIR = mkdtempSync(path.join(tmpdir(), "sf-hidden-data-"));
process.env.SF_WORKSPACE = mkdtempSync(path.join(tmpdir(), "sf-hidden-unused-"));
const { firstAssertion, hiddenFindings, listHiddenTests, parseHeader, runHiddenTests, testsAfterMerge, testsFor, HIDDEN_DIR } = await import("../src/autopilot/hidden.js");
const { clusterFindings } = await import("../src/autopilot/review.js");

const header = (scenario: string, requires: string, requirement = "Look up a claim") =>
  `// scenario: ${scenario}\n// requirement: ${requirement}\n// requires: ${requires}\n`;

test("parseHeader: scenario, requirement and the work orders it needs; no scenario, no hidden test", () => {
  assert.deepEqual(parseHeader(`${header("Unknown claim", "WO-3, WO-2, 3")}import x from "y";\n`), {
    scenario: "Unknown claim",
    requirement: "Look up a claim",
    requires: [2, 3],
  });
  assert.equal(parseHeader("// requires: WO-1\nimport x from 'y';\n"), null);
});

test("which tests a work order or a merge is held to", () => {
  const t = (file: string, requires: number[]) => ({ file, scenario: file, requirement: null, requires, sha256: "" });
  const tests = [t("a", [1]), t("b", [1, 2]), t("c", [2]), t("d", [])];
  assert.deepEqual(testsFor(tests, 1, new Set()).map((x) => x.file), ["a"]);
  assert.deepEqual(testsFor(tests, 2, new Set([1])).map((x) => x.file), ["b", "c"]);
  assert.deepEqual(testsFor(tests, 2, new Set()).map((x) => x.file), ["c"]); // b waits for WO-1 to merge
  assert.deepEqual(testsAfterMerge(tests, 2, new Set([1])).map((x) => x.file), ["a", "b", "c"]);
  assert.deepEqual(testsAfterMerge(tests, 1, new Set()).map((x) => x.file), ["a"]);
});

test("runHiddenTests: runs each file in the worktree, refuses one changed since the manifest, leaves nothing behind", async () => {
  const worktree = mkdtempSync(path.join(tmpdir(), "sf-hidden-wt-"));
  writeFileSync(path.join(worktree, "lookup.js"), "export const lookup = (id) => (id === 'AB-123456' ? { status: 'approved' } : null);\n");
  const testsDir = mkdtempSync(path.join(tmpdir(), "sf-hidden-tests-"));
  mkdirSync(path.join(testsDir, "nested"));
  const pre = 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { lookup } from "../lookup.js";\n';
  writeFileSync(path.join(testsDir, "known.test.mjs"), `${header("Known claim", "WO-1")}${pre}test("known", () => assert.equal(lookup("AB-123456").status, "approved"));\n`);
  writeFileSync(path.join(testsDir, "unknown.test.mjs"), `${header("Unknown claim", "WO-1")}${pre}test("unknown", () => assert.deepEqual(lookup("ZZ-000000"), { status: "not found" }));\n`);
  writeFileSync(path.join(testsDir, "nested", "later.test.mjs"), `${header("Later", "WO-1")}${pre}test("later", () => {});\n`);
  const tests = listHiddenTests(testsDir);
  assert.deepEqual(tests.map((t) => t.file), ["known.test.mjs", "nested/later.test.mjs", "unknown.test.mjs"]);
  const manifest = new Map(tests.map((t) => [t.file, t.sha256]));
  writeFileSync(path.join(testsDir, "nested", "later.test.mjs"), `${header("Later", "WO-1")}// weakened\n`);

  const results = await runHiddenTests(worktree, testsDir, tests, "node --test", manifest);
  assert.deepEqual(results.map((r) => [r.test.file, r.result.ok]), [
    ["known.test.mjs", true],
    ["nested/later.test.mjs", false],
    ["unknown.test.mjs", false],
  ]);
  assert.match(results[1]!.result.output, /changed after the validator finished/);
  assert.equal(existsSync(path.join(worktree, HIDDEN_DIR)), false);

  // What the builder hears: the scenario and the first assertion line, not the test's source or output.
  const findings = hiddenFindings(results, "work order");
  assert.deepEqual(findings.map((f) => f.scenario), ["Later", "Unknown claim"]);
  const message = clusterFindings(findings);
  assert.match(message, /Scenario "Unknown claim": \(high\) A hidden acceptance test fails: AssertionError/);
  assert.ok(!message.includes("ZZ-000000"), "the test's data stays hidden");
  assert.ok(!message.includes("lookup.js"));
});

test("firstAssertion picks the line that says what broke", () => {
  assert.equal(firstAssertion("✖ x (1ms)\n  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:\n  404 !== 500"), "AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:");
  assert.equal(firstAssertion("nothing useful"), "it failed");
});

// ---- hidden tests in a run ----

const { startFakeOpenHands } = await import("../src/demo/fake-agent-server.js");
const { scriptedAgents } = await import("../src/demo/scripted-agents.js");
const { createOrchestrator } = await import("../src/autopilot/orchestrator.js");
const { openLedger } = await import("../src/autopilot/ledger.js");
const { OpenHandsClient } = await import("../src/autopilot/openhands.js");
const { createAutopilotRoutes } = await import("../src/autopilot/routes.js");
const { audit, listAudit } = await import("../src/audit.js");
type Handler = import("../src/demo/fake-agent-server.js").FakeHandler;

async function hiddenRun(handler: Handler) {
  const workspace = mkdtempSync(path.join(tmpdir(), "sf-hidden-run-"));
  writeFileSync(path.join(workspace, "README.md"), "# Demo\n");
  mkdirSync(path.join(workspace, ".factory"));
  writeFileSync(path.join(workspace, ".factory", "policy.yml"), "hiddenTests: { enabled: true }\n");
  const dataDir = mkdtempSync(path.join(tmpdir(), "sf-hidden-run-data-"));
  const fake = await startFakeOpenHands({ onMessage: handler });
  const ledger = openLedger(":memory:");
  const o = createOrchestrator({ ledger, client: new OpenHandsClient({ baseUrl: fake.url }), workspace, dataDir, graceMs: 0 });
  const run = await o.createRun({ goal: "Let applicants check a claim's status", autonomy: "autonomous", actor: "user:test" });
  // WO-3 touches src/auth, so its merge waits for a person: this one says yes.
  const until = async (done: () => boolean) => {
    for (let i = 0; i < 100 && !done(); i++) {
      for (const item of ledger.listInbox({ runId: run.id }).filter((x) => x.kind === "merge_approval")) await o.decide(item.id, { choice: "merge" }, "user:test");
      await o.tick();
      await o.idle();
      await fake.settled();
    }
    assert.ok(done(), `the run didn't get there (${ledger.getRun(run.id)?.state}: ${ledger.listWorkOrders(run.id).map((w) => w.state).join(", ")})`);
  };
  return { workspace, dataDir, fake, ledger, o, run, until, close: async () => { o.stop(); await o.idle(); await fake.close(); ledger.close(); } };
}

test("in a run: the validator writes a test per scenario outside every worktree; each work order is held to its own, the integration branch to everything merged", async () => {
  const t = await hiddenRun(scriptedAgents({ noBugs: true }));
  try {
    await t.until(() => t.ledger.getRun(t.run.id)?.state === "done");
    const tests = t.ledger.listHiddenTests(t.run.id);
    assert.deepEqual(tests.map((x) => [x.scenario, x.requires]), [["Missing input", [2]], ["Request is audited", [3]], ["Valid request", [1]]]);
    // Never in a worktree or on a branch.
    for (const branch of [t.run.integrationBranch, t.run.baseBranch]) {
      const files = (await import("../src/autopilot/git.js")).git(t.workspace, ["ls-tree", "-r", "--name-only", branch]);
      assert.ok(!(await files).stdout.includes("missing-input"), branch);
    }
    const checks = t.ledger.listChecks({ runId: t.run.id }).filter((c) => c.name.startsWith("hidden:"));
    assert.ok(checks.length >= 6 && checks.every((c) => c.ok)); // three at their work orders, and again after each merge
    const view = (await (await createAutopilotRoutes(t.o).request(`/runs/${t.run.id}`)).json()) as { hiddenTests: { scenario: string; lastOk: boolean; runs: number }[] };
    assert.ok(view.hiddenTests.every((h) => h.lastOk === true && h.runs >= 2));
    await audit("test", "test.flush", "test");
    const written = listAudit(5000).find((e) => e.subject === t.run.id && e.action === "autopilot.hidden_tests_written");
    assert.equal(written?.data.tests, 3);
  } finally {
    await t.close();
  }
});

test("in a run: code that passes its own tests but not the hidden one goes back by scenario and first assertion, never the test itself", async () => {
  const scripted = scriptedAgents({ noBugs: true });
  const t = await hiddenRun(async (conv, text) => {
    const reply = await scripted(conv, text);
    if (conv.tags.sfrole === "builder" && conv.tags.sfwo === "2" && conv.messages.length === 1) {
      // Lets an empty input through, and its own test doesn't notice.
      const dir = path.join(conv.workingDir, "src", "let-applicants-check");
      writeFileSync(path.join(dir, "validate.js"), 'export function validate(input) {\n  return String(input ?? "").length > 200 ? { ok: false, message: "Too long" } : { ok: true };\n}\n');
      writeFileSync(path.join(dir, "validate.test.js"), 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { validate } from "./validate.js";\ntest("long", () => assert.equal(validate("x".repeat(201)).ok, false));\n');
    }
    return reply;
  });
  try {
    await t.until(() => t.ledger.getRun(t.run.id)?.state === "done");
    const [builder] = t.ledger.listAttempts({ runId: t.run.id, workOrderId: `${t.run.id}/WO-2`, role: "builder" });
    const repair = t.fake.conversations.get(builder!.conversationId)!.messages[1] ?? "";
    assert.match(repair, /Scenario "Missing input": \(high\) A hidden acceptance test fails: AssertionError/);
    assert.ok(!repair.includes("missing-input.test.mjs") && !repair.includes("an empty input is rejected"), "the test stays hidden");
    const wo2 = t.ledger.listChecks({ runId: t.run.id, workOrderId: `${t.run.id}/WO-2` }).filter((c) => c.name === "hidden:missing-input.test.mjs");
    assert.deepEqual(wo2.map((c) => c.ok).slice(0, 2), [false, true]);
  } finally {
    await t.close();
  }
});

test("in a run: hidden tests turned on but none written put every merge in front of a person, saying why", async () => {
  const scripted = scriptedAgents({ noBugs: true });
  const t = await hiddenRun((conv, text) => (conv.tags.sfrole === "validator" ? { response: "I couldn't.", cost: 0.01 } : scripted(conv, text)));
  try {
    await t.until(() => t.ledger.getRun(t.run.id)?.state === "done");
    const items = t.ledger.listInbox({ state: "all", runId: t.run.id }).filter((i) => i.kind === "merge_approval");
    assert.equal(items.length, 3); // every work order, not just the one touching src/auth
    for (const item of items) assert.match(item.body, /Hidden acceptance tests are turned on, but the validator wrote none for this change\./);
  } finally {
    await t.close();
  }
});
