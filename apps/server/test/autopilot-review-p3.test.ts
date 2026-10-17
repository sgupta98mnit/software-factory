// Regression tests for the review of Phase 3 (scans, budgets, evidence). Each
// one failed before its fix; OPEN-ISSUES.md lists them.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { type FakeConversation, type FakeHandler, startFakeOpenHands } from "./fake-openhands.js";

const dataRoot = mkdtempSync(path.join(tmpdir(), "sf-review-p3-data-"));
process.env.SF_DATA_DIR = dataRoot;
process.env.SF_WORKSPACE = mkdtempSync(path.join(tmpdir(), "sf-review-p3-unused-"));
delete process.env.SF_AUTONOMY_CAP;
const { createOrchestrator } = await import("../src/autopilot/orchestrator.js");
const { openLedger } = await import("../src/autopilot/ledger.js");
const { OpenHandsClient } = await import("../src/autopilot/openhands.js");
const { addedLines, commitAll, diffStat, ensureRepo, fileAt, git, headSha, squash } = await import("../src/autopilot/git.js");
const { scanDependencies, scanManifest, scanSecrets } = await import("../src/autopilot/scan.js");
const { buildEvidence } = await import("../src/autopilot/evidence.js");

// Assembled at run time so this file itself doesn't trip secret scanners.
const AWS = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
const GH = ["ghp_", "a".repeat(20), "B".repeat(16)].join("");

async function repo() {
  const dir = mkdtempSync(path.join(tmpdir(), "sf-review-p3-git-"));
  writeFileSync(path.join(dir, "README.md"), "# Demo\n");
  await ensureRepo(dir);
  return { dir, base: await headSha(dir) };
}

// ---- scans ----

test("scans: code marked binary in .gitattributes or .git/info/attributes still has its added lines scanned and its lines counted", async () => {
  const committed = await repo();
  writeFileSync(path.join(committed.dir, ".gitattributes"), "*.js -diff\n");
  writeFileSync(path.join(committed.dir, "config.js"), `export const id = "${AWS}";\n${"export const x = 1;\n".repeat(500)}`);
  await commitAll(committed.dir, "work");
  assert.deepEqual(scanSecrets(await addedLines(committed.dir, committed.base)).map((f) => `${f.file}:${f.line}`), ["config.js:1"]);
  assert.ok((await diffStat(committed.dir, committed.base)).linesChanged > 500, "the policy's line limit doesn't see the change");

  // The repo's own attributes file: any agent can write it, and it shows in no diff.
  const local = await repo();
  writeFileSync(path.join(local.dir, ".git", "info", "attributes"), "* binary\n");
  writeFileSync(path.join(local.dir, "config.js"), `export const id = "${AWS}";\n`);
  await commitAll(local.dir, "work");
  assert.deepEqual(scanSecrets(await addedLines(local.dir, local.base)).map((f) => `${f.file}:${f.line}`), ["config.js:1"]);
  assert.equal((await diffStat(local.dir, local.base)).linesChanged, 1);
});

test("scans: known credential formats are found in minified files, source maps and lockfiles too (a lockfile can hold a token in a git URL)", () => {
  assert.deepEqual(
    scanSecrets([
      { path: "src/config.min.js", line: `var k="${AWS}";`, number: 1 },
      { path: "package-lock.json", line: `"resolved": "git+https://${GH}@github.com/org/private.git#abc123"`, number: 9 },
      { path: "dist/app.js.map", line: `{"sourcesContent":["const t = '${GH}';"]}`, number: 1 },
    ]).map((f) => [f.rule, f.file, f.line]),
    [
      ["aws-access-key", "src/config.min.js", 1],
      ["github-token", "package-lock.json", 9],
      ["github-token", "dist/app.js.map", 1],
    ],
  );
  // Hashes and minified identifiers there still aren't taken for hard-coded passwords.
  assert.deepEqual(scanSecrets([{ path: "package-lock.json", line: `"integrity": "sha512-${"x".repeat(80)}"` }, { path: "dist/app.min.js", line: 'var password="Tr0ub4dor&3xK9"' }]), []);
});

test("dependency scan: peer dependencies, overrides, resolutions, npm aliases and every script npm runs on install", () => {
  const before = { peerDependencies: { react: "^18.0.0" }, overrides: { semver: "7.6.0" }, scripts: { test: "node --test" } };
  const after = {
    dependencies: { lodash: "npm:lodash-fork@4.17.21" },
    peerDependencies: { react: "github:someone/react", "react-dom": "^18.0.0" }, // a peer's range is fine
    overrides: { semver: "7.6.0", minimist: "1.2.8", foo: { bar: "git+https://example.com/bar.git" }, react: "$react" },
    resolutions: { "**/ms": "https://example.com/ms.tgz" },
    scripts: { test: "node --test", preprepare: "node a.js", postprepare: "node b.js", prepublish: "node c.js", dependencies: "node d.js" },
  };
  assert.deepEqual(
    scanManifest("package.json", before, after).map((f) => [f.rule, f.detail]),
    [
      ["dependency-alias", "lodash installs another package under its name (npm:lodash-fork@4.17.21)"],
      ["dependency-source", "react installs from outside the npm registry (github:someone/react)"],
      ["dependency-source", "foo > bar installs from outside the npm registry (git+https://example.com/bar.git)"],
      ["dependency-source", "**/ms installs from outside the npm registry (https://example.com/ms.tgz)"],
      ["install-script", 'Adds or changes the "preprepare" script, which runs on every install'],
      ["install-script", 'Adds or changes the "postprepare" script, which runs on every install'],
      ["install-script", 'Adds or changes the "prepublish" script, which runs on every install'],
      ["install-script", 'Adds or changes the "dependencies" script, which runs on every install'],
    ],
  );
});

test("dependency scan: a registry set in .npmrc or .yarnrc.yml, and a lockfile entry resolved from somewhere new, are flagged; the base's own mirror isn't", async () => {
  const { dir } = await repo();
  const mirror = (name: string) => `https://npm.mirror.example.gov/api/npm/npm/${name}/-/${name}-1.0.0.tgz`;
  const lock = (packages: Record<string, object>) => JSON.stringify({ name: "x", lockfileVersion: 3, requires: true, packages: { "": { name: "x" }, ...packages } });
  writeFileSync(path.join(dir, "package-lock.json"), lock({ "node_modules/a": { version: "1.0.0", resolved: mirror("a") } }));
  const base = (await commitAll(dir, "lock")) as string;
  writeFileSync(path.join(dir, ".npmrc"), "registry=https://npm.evil.example/\n");
  mkdirSync(path.join(dir, "web"));
  writeFileSync(path.join(dir, "web", ".yarnrc.yml"), 'npmRegistryServer: "https://npm.evil.example"\n');
  writeFileSync(
    path.join(dir, "package-lock.json"),
    lock({
      "node_modules/a": { version: "1.0.0", resolved: mirror("a") },
      "node_modules/b": { version: "1.0.0", resolved: mirror("b") }, // the mirror the base already uses
      "node_modules/c": { version: "1.0.0", resolved: "https://registry.npmjs.org/c/-/c-1.0.0.tgz" },
      "node_modules/d": { version: "1.0.0", resolved: "https://npm.evil.example/d/-/d-1.0.0.tgz" },
      "node_modules/e": { version: "1.0.0", resolved: "git+ssh://git@github.com/someone/e.git#0123abcd" },
      "node_modules/w": { resolved: "packages/w", link: true }, // a workspace package in this repo
    }),
  );
  await commitAll(dir, "work");
  const files = (await diffStat(dir, base)).files.map((f) => f.path);
  assert.deepEqual(
    (await scanDependencies(dir, base, "HEAD", files)).map((f) => [f.rule, f.file, f.detail]),
    [
      ["package-manager-config", ".npmrc", "Changes the package manager's settings (the registry it installs from, or scripts it runs)"],
      ["dependency-source", "package-lock.json", "node_modules/d resolves from outside the npm registry (https://npm.evil.example/d/-/d-1.0.0.tgz)"],
      ["dependency-source", "package-lock.json", "node_modules/e resolves from outside the npm registry (git+ssh://git@github.com/someone/e.git#0123abcd)"],
      ["package-manager-config", "web/.yarnrc.yml", "Changes the package manager's settings (the registry it installs from, or scripts it runs)"],
    ],
  );
});

test("dependency scan: credentials in a dependency's URL stay out of its finding, which reaches the Inbox and the audit log", async () => {
  const token = ["s3cr3t", "Tok3n", "99"].join("");
  const manifest = scanManifest("package.json", {}, { dependencies: { tool: `https://ci:${token}@npm.example.com/tool-1.0.0.tgz`, lib: `git+https://${token}@github.com/org/lib.git` } });
  const { scanLockfile } = await import("../src/autopilot/scan.js");
  const lock = scanLockfile("package-lock.json", {}, { packages: { "node_modules/tool": { resolved: `https://ci:${token}@npm.example.com/tool/-/tool-1.0.0.tgz` } } });
  const details = [...manifest, ...lock].map((f) => f.detail);
  assert.equal(details.length, 3);
  assert.ok(details.every((d) => !d.includes(token)), details.join("\n"));
  assert.deepEqual(details, [
    "tool installs from outside the npm registry (https://***@npm.example.com/tool-1.0.0.tgz)",
    "lib installs from outside the npm registry (git+https://***@github.com/org/lib.git)",
    "node_modules/tool resolves from outside the npm registry (https://***@npm.example.com/tool/-/tool-1.0.0.tgz)",
  ]);
});

test("squash: a single commit gets the factory's message too, so nothing the builder wrote in it rides along unscanned", async () => {
  const { dir, base } = await repo();
  writeFileSync(path.join(dir, "a.js"), "export const a = 1;\n");
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-q", "-m", `wip\n\ndeploy token ${GH}`]);
  const sha = await squash(dir, base, "WO-1: A");
  assert.equal((await git(dir, ["log", "-1", "--format=%B", sha])).stdout.trim(), "WO-1: A");
  assert.equal(await squash(dir, base, "WO-1: A"), sha); // already the factory's: left as it is
});

// ---- alerts ----

test("alerts: a work-order title an agent wrote can't ping the channel or pass off a link in Slack", async () => {
  const { payload } = await import("../src/autopilot/notify.js");
  const title = "Merge WO-1 of add-claims: <!channel> see <https://evil.example/login|Open the Inbox> & sign in";
  const { text } = payload("slack", "Autopilot needs you", [title], "http://localhost:8000/inbox") as { text: string };
  assert.equal(text, "Autopilot needs you\n• Merge WO-1 of add-claims: &lt;!channel&gt; see &lt;https://evil.example/login|Open the Inbox&gt; &amp; sign in\nhttp://localhost:8000/inbox");
});

// ---- evidence ----

test("evidence: a hidden test covers the scenario of its own requirement, not a scenario with the same name under another requirement", async () => {
  const { dir } = await repo();
  const change = "add-claims";
  const specDir = path.join(dir, "openspec", "changes", change, "specs", "claims");
  mkdirSync(specDir, { recursive: true });
  writeFileSync(path.join(specDir, "spec.md"), "## ADDED Requirements\n\n### Requirement: Look up\n\n#### Scenario: Bad input\n\n### Requirement: Update\n\n#### Scenario: Bad input\n");
  const sha = await commitAll(dir, "spec");
  const ledger = openLedger(":memory:");
  try {
    const run = ledger.createRun({ goal: "Claims", change, autonomy: "supervised", baseBranch: "main", integrationBranch: "main", integrationSha: sha, createdBy: "user:test" });
    ledger.setHiddenTests(run.id, [{ file: "lookup-bad-input.test.mjs", scenario: "Bad input", requirement: "Look up", requires: [1], sha256: "0".repeat(64) }]);
    const e = await buildEvidence(ledger, dir, run);
    assert.deepEqual(e.traceability.map((s) => [s.requirement, s.scenario, s.hiddenTests.map((h) => h.file)]), [
      ["Look up", "Bad input", ["lookup-bad-input.test.mjs"]],
      ["Update", "Bad input", []],
    ]);
  } finally {
    ledger.close();
  }
});

// ---- runs ----

const PASS = 'Reviewed.\n\n```json\n{"verdict":"pass","findings":[]}\n```';
const PKG = JSON.stringify({ name: "demo", private: true, type: "module", scripts: { test: "node --test" } });

/** Plays a builder: wo-<seq>.js and a passing node:test for it. */
function build(conv: FakeConversation) {
  const seq = conv.tags.sfwo ?? "0";
  writeFileSync(path.join(conv.workingDir, "package.json"), PKG);
  writeFileSync(path.join(conv.workingDir, `wo-${seq}.js`), `export const wo${seq} = true;\n`);
  writeFileSync(path.join(conv.workingDir, `wo-${seq}.test.js`), `import { test } from "node:test";\nimport "./wo-${seq}.js";\ntest("WO-${seq}", () => {});\n`);
  return { response: "Built it.", cost: 0.1 };
}

function byRole(roles: Partial<Record<string, FakeHandler>>): FakeHandler {
  return (conv, text) => (roles[conv.tags.sfrole ?? ""] ?? (() => ({ response: PASS, cost: 0.02 })))(conv, text);
}

async function setup(handler: FakeHandler, opts: { policy?: string } = {}) {
  const workspace = mkdtempSync(path.join(tmpdir(), "sf-review-p3-ws-"));
  writeFileSync(path.join(workspace, "README.md"), "# Demo\n");
  if (opts.policy) {
    mkdirSync(path.join(workspace, ".factory"));
    writeFileSync(path.join(workspace, ".factory", "policy.yml"), opts.policy);
  }
  await ensureRepo(workspace);
  const fake = await startFakeOpenHands({ onMessage: handler });
  const ledger = openLedger(":memory:");
  const o = createOrchestrator({ ledger, client: new OpenHandsClient({ baseUrl: fake.url }), workspace, dataDir: mkdtempSync(path.join(dataRoot, "case-")), graceMs: 0 });
  const t = {
    workspace,
    fake,
    ledger,
    o,
    /** Steps without waiting for the agents' turns (a test may hold one open). */
    async until(done: () => boolean, max = 80) {
      for (let i = 0; i < max && !done(); i++) {
        await o.tick();
        await o.idle();
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.ok(done(), "the run didn't get there");
    },
    /** A run in building with independent work orders 1..n, skipping the spec stage. */
    async buildingRun(n: number, autonomy: "suggest" | "supervised" = "supervised") {
      const run = await o.createRun({ goal: "Add claim status lookup", autonomy, actor: "user:test" });
      ledger.addWorkOrders(run.id, Array.from({ length: n }, (_, i) => ({ seq: i + 1, title: `Task ${i + 1}`, acceptance: [`Criterion ${i + 1}`], controls: [], dependsOn: [], wave: 1, risk: "low" as const })));
      return ledger.updateRun(run.id, { state: "building" });
    },
    states: (runId: string) => ledger.listWorkOrders(runId).map((w) => `${w.seq}:${w.state}`),
    item: (runId: string, kind: string) => ledger.listInbox({ runId }).find((i) => i.kind === kind),
    async close() {
      o.stop();
      await o.idle();
      await fake.close();
      ledger.close();
    },
  };
  return t;
}

test("merge: what merges is the commit the gates and the reviewer checked, even when an agent moves the work order's branch before a person approves it", async () => {
  const t = await setup(byRole({ builder: build }));
  try {
    const run = await t.buildingRun(1, "suggest");
    await t.until(() => t.states(run.id)[0] === "1:awaiting_merge_approval");
    // Agents share the repo, so any of them can put a commit on the branch after the review.
    const wo = t.ledger.getWorkOrder(`${run.id}/WO-1`)!;
    writeFileSync(path.join(wo.worktree!, "backdoor.js"), "export const open = true;\n");
    await git(wo.worktree!, ["add", "-A"]);
    await git(wo.worktree!, ["commit", "-q", "-m", "one more thing"]);
    await t.o.decide(t.item(run.id, "merge_approval")!.id, { choice: "merge" }, "user:isso");
    await t.until(() => t.ledger.getRun(run.id)?.state === "done");
    assert.notEqual(await fileAt(t.workspace, run.integrationBranch, "wo-1.js"), null);
    assert.equal(await fileAt(t.workspace, run.integrationBranch, "backdoor.js"), null, "unreviewed code merged under the person's approval");
    assert.equal(t.ledger.getWorkOrder(wo.id)?.mergedBy, "user:isso");
  } finally {
    await t.close();
  }
});

test("hidden tests: a work order whose hidden test failed once and passes after its repair merges by the policy, not as a failure", async () => {
  const hidden = '// scenario: Works\n// requirement: Core\n// requires: WO-1\nimport { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { wo1 } from "../wo-1.js";\ntest("works", () => assert.equal(wo1, true));\n';
  const t = await setup(
    byRole({
      validator: (conv) => {
        mkdirSync(path.join(conv.workingDir, "tests"), { recursive: true });
        writeFileSync(path.join(conv.workingDir, "tests", "works.test.mjs"), hidden);
        return { response: "Wrote works.test.mjs.", cost: 0.02 };
      },
      builder: (conv) => {
        const reply = build(conv);
        writeFileSync(path.join(conv.workingDir, "wo-1.js"), `export const wo1 = ${conv.messages.length > 1};\n`); // right on the repair
        return reply;
      },
    }),
    { policy: "hiddenTests: { enabled: true }\n" },
  );
  try {
    const run = await t.buildingRun(1);
    await t.until(() => ["1:merged", "1:awaiting_merge_approval"].includes(t.states(run.id)[0]!));
    assert.deepEqual(t.ledger.listChecks({ runId: run.id }).filter((c) => c.name === "hidden:works.test.mjs" && c.stage === "build").map((c) => c.ok), [false, true]);
    assert.equal(t.item(run.id, "merge_approval")?.body.match(/Hidden acceptance tests failed/)?.[0], undefined);
    assert.equal(t.ledger.getWorkOrder(`${run.id}/WO-1`)?.mergedBy, `policy@${run.policyHash}`);
  } finally {
    await t.close();
  }
});

/** A run whose one work order's builder spends past its budget ($0.50) while it's still working, held there. */
async function overBudget() {
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  const t = await setup(
    byRole({
      builder: async (conv) => {
        if (conv.messages.length === 1) {
          conv.cost = 1;
          await held;
        }
        return build(conv);
      },
    }),
    { policy: "budget: { perWorkOrderUsd: 0.5 }\n" },
  );
  const run = await t.buildingRun(1);
  await t.until(() => !!t.item(run.id, "budget_reached"));
  const builder = t.ledger.listAttempts({ runId: run.id, role: "builder" })[0]!;
  assert.equal(t.fake.conversations.get(builder.conversationId)?.status, "paused");
  return { t, run, builder, release };
}

test("budgets: resuming a paused run leaves the agents of a work order over its budget, or skipped there, paused", async () => {
  const { t, run, builder, release } = await overBudget();
  const conversation = () => t.fake.conversations.get(builder.conversationId)?.status;
  try {
    await t.o.pause(run.id, { actor: "user:test" });
    await t.o.resume(run.id, { actor: "user:test" });
    assert.equal(conversation(), "paused", "it spends past its budget with nobody holding it to one");
    assert.equal(t.ledger.getAttempt(builder.id)?.state, "paused");

    await t.o.decide(t.item(run.id, "budget_reached")!.id, { choice: "skip" }, "user:test");
    await t.o.pause(run.id, { actor: "user:test" });
    await t.o.resume(run.id, { actor: "user:test" });
    assert.equal(conversation(), "paused");
  } finally {
    release();
    await t.close();
  }
});

test("budgets: a work order given more while its run is paused keeps its agents paused until the run resumes", async () => {
  const { t, run, builder, release } = await overBudget();
  const conversation = () => t.fake.conversations.get(builder.conversationId)?.status;
  try {
    await t.o.pause(run.id, { actor: "user:test" });
    await t.o.decide(t.item(run.id, "budget_reached")!.id, { choice: "raise" }, "user:test");
    // Nobody polls a paused run's agents, or holds them to a budget: they wait for Resume.
    assert.equal(conversation(), "paused");
    assert.equal(t.ledger.getAttempt(builder.id)?.state, "paused");
    assert.equal(t.ledger.getWorkOrder(`${run.id}/WO-1`)?.state, "building");

    await t.o.resume(run.id, { actor: "user:test" });
    assert.notEqual(conversation(), "paused");
    assert.equal(t.ledger.getAttempt(builder.id)?.state, "running");
  } finally {
    release();
    await t.close();
  }
});
