import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { startFakeOpenHands } from "./fake-openhands.js";

// Audit log and worktrees in a temp folder, and never the real workspace, before config is read.
const dataDir = mkdtempSync(path.join(tmpdir(), "sf-policy-data-"));
process.env.SF_DATA_DIR = dataDir;
process.env.SF_WORKSPACE = mkdtempSync(path.join(tmpdir(), "sf-policy-unused-"));
delete process.env.SF_AUTONOMY_CAP;
const { DEFAULT_POLICY, evaluateMerge, loadPolicy, newDependencies, parsePolicy, policyHash, sensitiveMatch } = await import("../src/autopilot/policy.js");
const { commitAll, diffStat, ensureRepo, git } = await import("../src/autopilot/git.js");
const { createOrchestrator } = await import("../src/autopilot/orchestrator.js");
const { openLedger } = await import("../src/autopilot/ledger.js");
const { OpenHandsClient } = await import("../src/autopilot/openhands.js");
const { audit, listAudit } = await import("../src/audit.js");

type MergeFacts = Parameters<typeof evaluateMerge>[1];

/** A workspace repo whose main branch has `policy` as .factory/policy.yml (none when undefined). */
async function repo(policy?: string) {
  const dir = mkdtempSync(path.join(tmpdir(), "sf-policy-ws-"));
  writeFileSync(path.join(dir, "README.md"), "# Demo\n");
  if (policy !== undefined) {
    mkdirSync(path.join(dir, ".factory"));
    writeFileSync(path.join(dir, ".factory", "policy.yml"), policy);
  }
  await ensureRepo(dir);
  return dir;
}

const writePolicy = (dir: string, yaml: string) => writeFileSync(path.join(dir, ".factory", "policy.yml"), yaml);

test("loadPolicy reads policy.yml from the base branch only: an uncommitted edit and a commit on another branch are ignored", async () => {
  const dir = await repo("parallel: 2\n");
  await git(dir, ["checkout", "-q", "-b", "relaxed"]);
  writePolicy(dir, "parallel: 9\n");
  await commitAll(dir, "Relax the policy");
  await git(dir, ["tag", "main"]); // a tag named like the base branch, on the relaxed commit
  await git(dir, ["checkout", "-q", "main"]);
  writePolicy(dir, "parallel: 7\n"); // in the working tree, never committed

  const loaded = await loadPolicy(dir, "main");
  assert.equal(loaded.policy.parallel, 2);
  assert.equal(loaded.source, ".factory/policy.yml@main");
  assert.equal(loaded.hash, policyHash(loaded.policy));
  assert.equal((await loadPolicy(dir, "relaxed")).policy.parallel, 9); // only when that's the base branch asked for
});

test("loadPolicy: no policy.yml on the base branch means the defaults", async () => {
  const loaded = await loadPolicy(await repo(), "main");
  assert.deepEqual(loaded, { policy: DEFAULT_POLICY, hash: policyHash(DEFAULT_POLICY), source: "defaults" });
  assert.deepEqual(parsePolicy(""), DEFAULT_POLICY);
  assert.deepEqual(parsePolicy("# nothing set yet\n"), DEFAULT_POLICY);
  // Saved with a byte order mark (Windows editors), with or without a leading ---.
  assert.equal(parsePolicy("\uFEFFparallel: 2\n").parallel, 2);
  assert.equal(parsePolicy("\uFEFF---\r\nparallel: 2\r\n").parallel, 2);
});

test("parsePolicy: the file over the defaults, mapping by mapping; lists replace", () => {
  const p = parsePolicy(
    [
      "---",
      "version: 1",
      "autonomy: { max: supervised }",
      "agents:",
      "  critic: codex",
      "review:",
      "  blocking: [critical]",
      "autoMerge:",
      "  maxChangedLines: 100",
      "  sensitivePaths: ['secure/**']",
      "gates:",
      "  - { name: unit, run: npm test, timeoutSec: 120 }",
      "budget:", // nothing under it: the defaults
    ].join("\r\n"),
  );
  assert.deepEqual(p.autonomy, { default: "supervised", max: "supervised" });
  assert.deepEqual(p.agents, { ...DEFAULT_POLICY.agents, critic: "codex" });
  assert.deepEqual(p.review.blocking, ["critical"]);
  assert.deepEqual(p.autoMerge, { maxChangedLines: 100, sensitivePaths: ["secure/**"], dependencyAllowlist: [] });
  assert.deepEqual(p.gates, [{ name: "unit", run: "npm test", timeoutSec: 120 }]);
  assert.deepEqual(p.budget, DEFAULT_POLICY.budget);
  assert.equal(p.parallel, 3);
  // The defaults themselves are untouched.
  assert.equal(DEFAULT_POLICY.autoMerge.maxChangedLines, 400);
  assert.equal(DEFAULT_POLICY.autonomy.max, "autonomous");
});

test("parsePolicy: a wrong value or an unknown key is an error naming the key", async () => {
  const cases: [string, RegExp][] = [
    ["autonomy: { max: yolo }", /autonomy\.max must be one of: suggest, supervised, autonomous$/],
    ["autonomy: { default: Autonomous }", /autonomy\.default must be one of/],
    ["parallel: three", /parallel must be a whole number from 1 up$/],
    ["parallel: 0", /parallel must be a whole number from 1 up$/],
    ["repair: { fresh: -1 }", /repair\.fresh must be a whole number from 0 up$/],
    ["spec: { validateTries: 2.5 }", /spec\.validateTries must be a whole number from 1 up$/],
    ["autoMerge: { maxChangedLines: '400' }", /autoMerge\.maxChangedLines must be a whole number/],
    ["budget: { perChangeUsd: free }", /budget\.perChangeUsd must be a number above 0$/],
    ["notify: { digestHour: 24 }", /notify\.digestHour must be a whole number from 0 to 23$/],
    ["review: { blocking: [high, severe] }", /review\.blocking\[1\] must be one of: critical, high, medium, low$/],
    ["autoMerge: { sensitivePaths: 'auth/**' }", /autoMerge\.sensitivePaths must be a list$/],
    ["agents: { builder: 42 }", /agents\.builder must be an agent profile id or name, or null$/],
    ["hiddenTests: { enabled: yes please }", /hiddenTests\.enabled must be true or false$/],
    ["gates: []", /gates must list at least one gate, or be null$/],
    ["gates: [{ name: test }]", /gates\[0\]\.run must be a non-empty string$/],
    ["gates: [{ name: test, run: npm test, timeout: 5 }]", /gates\[0\]\.timeout isn't a gate setting/],
    ["version: 2", /version must be 1$/],
    ["autoMerge: { maxChangedLine: 100 }", /autoMerge\.maxChangedLine isn't a policy setting$/],
    ["repair: 2", /repair must be a mapping$/],
    ["- parallel: 2", /The policy must be a mapping$/],
    ["parallel: 2\nsensitivePaths: [**/auth/**]", /isn't valid YAML \(line 2\): unidentified alias/],
    ["---\nparallel: 2\nsensitivePaths: [**/auth/**]", /isn't valid YAML \(line 3\): unidentified alias/], // the file's lines, its --- too
    ["parallel: 2\n---\nparallel: 9", /must be one YAML document/],
    ["gates: [{ name: test, run: npm test, timeoutSec: 3000000 }]", /gates\[0\]\.timeoutSec must be at most 86400/],
  ];
  for (const [yaml, error] of cases) assert.throws(() => parsePolicy(yaml), error, yaml);
  // Read from a branch, the error says where.
  const dir = await repo("autonomy:\n  max: yolo\n");
  await assert.rejects(loadPolicy(dir, "main"), /\.factory\/policy\.yml@main: autonomy\.max must be one of/);
});

test("policyHash: the same rules always hash the same, however the file writes them", () => {
  const a = parsePolicy("parallel: 2\nrepair: { fresh: 0, sameConversation: 1 }\n");
  const b = parsePolicy("# reordered, block style, a default spelled out\nrepair:\n  sameConversation: 1\n  fresh: 0\nversion: 1\nparallel: 2\n");
  assert.match(policyHash(a), /^[0-9a-f]{12}$/);
  assert.equal(policyHash(a), policyHash(b));
  assert.notEqual(policyHash(a), policyHash(parsePolicy("parallel: 2\nrepair: { fresh: 0, sameConversation: 2 }\n")));
  assert.equal(policyHash(parsePolicy("parallel: 3\n")), policyHash(DEFAULT_POLICY)); // the defaults, written out
  // Pinned: changing a default changes the actor of every new run's policy approvals. Update this on purpose.
  assert.equal(policyHash(DEFAULT_POLICY), "e649538d0b98"); // execution (isolated execution) added
});

const OK: MergeFacts = {
  autonomy: "supervised",
  gatesOk: true,
  hiddenTestsOk: true,
  reviewPassed: true,
  secretFindings: 0,
  files: ["src/sum.js", "src/sum.test.js"],
  linesChanged: 40,
  newDependencies: [],
};

test("evaluateMerge: auto only when every check holds; each one that doesn't is a reason a person sees", () => {
  const with_ = (facts: Partial<MergeFacts>, policy = DEFAULT_POLICY) => evaluateMerge(policy, { ...OK, ...facts });
  assert.deepEqual(with_({}), { auto: true, reasons: [] });
  assert.deepEqual(with_({ autonomy: "autonomous", hiddenTestsOk: null }), { auto: true, reasons: [] }); // hidden tests not run
  assert.equal(with_({ linesChanged: 399 }).auto, true);

  const cases: [Partial<MergeFacts>, string][] = [
    [{ autonomy: "suggest" }, "Autonomy is suggest: a person approves every merge."],
    [{ gatesOk: false }, "Not every gate passed."],
    [{ hiddenTestsOk: false }, "Hidden acceptance tests failed."],
    [{ reviewPassed: false }, "The review didn't pass, or found something critical or high."],
    [{ secretFindings: 2 }, "The secret scan found 2 possible secret(s) in the added lines."],
    [{ newDependencies: ["left-pad"] }, "New dependencies not on the allowlist: left-pad."],
    [{ files: ["src/sum.js", "src/auth/login.ts"] }, "Changes sensitive paths: src/auth/login.ts (**/auth/**)."],
    [{ linesChanged: 400 }, "Changes 400 lines; the policy merges fewer than 400 on its own."],
  ];
  for (const [facts, reason] of cases) assert.deepEqual(with_(facts), { auto: false, reasons: [reason] }, reason);
  const all = cases.reduce<Partial<MergeFacts>>((acc, [facts]) => ({ ...acc, ...facts }), {});
  assert.deepEqual(with_(all).reasons, cases.map(([, reason]) => reason));

  // The policy's own limits and allowlist.
  const strict = parsePolicy("autoMerge: { maxChangedLines: 50, dependencyAllowlist: [zod, '@types/*'] }\n");
  assert.deepEqual(with_({ linesChanged: 50, newDependencies: ["@types/node", "lodash", "zod"] }, strict).reasons, [
    "New dependencies not on the allowlist: lodash.",
    "Changes 50 lines; the policy merges fewer than 50 on its own.",
  ]);
});

test("sensitiveMatch: the default sensitive paths, whatever the case, in dot folders too; a bare file name matches in any folder", () => {
  const { sensitivePaths } = DEFAULT_POLICY.autoMerge;
  const sensitive: [string, string][] = [
    ["src/auth/login.ts", "**/auth/**"],
    ["auth/session.js", "**/auth/**"],
    ["src/Auth/Login.ts", "**/auth/**"],
    [".config/auth/keys.json", "**/auth/**"],
    ["lib/crypto/aes.ts", "**/crypto/**"],
    ["infra/network/vpc.yml", "infra/**"],
    ["modules/vpc.tf", "**/*.tf"],
    ["main.tf", "**/*.tf"],
    ["Dockerfile", "Dockerfile"],
    ["services/api/Dockerfile", "Dockerfile"],
    [".github/workflows/ci.yml", ".github/**"],
    [".gitlab-ci.yml", ".gitlab-ci.yml"],
    [".factory/policy.yml", ".factory/**"],
    ["AGENTS.md", "AGENTS.md"],
    ["docs/CLAUDE.md", "CLAUDE.md"],
    ["db/migrations/001_init.sql", "**/migrations/**"],
  ];
  for (const [file, pattern] of sensitive) assert.equal(sensitiveMatch(file, sensitivePaths), pattern, file);
  for (const file of ["src/author.ts", "src/routes/authors.ts", "docs/infra/README.md", "infrastructure.md", "Dockerfile.dev", "README.md", "package.json"]) {
    assert.equal(sensitiveMatch(file, sensitivePaths), undefined, file);
  }
});

test("newDependencies: package names a branch adds to any package.json, against the base; a version bump isn't new", async () => {
  const dir = await repo();
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "demo", dependencies: { hono: "4.0.0" }, devDependencies: { tsx: "4.0.0" } }));
  const base = (await commitAll(dir, "Base")) as string;
  await git(dir, ["checkout", "-q", "-b", "wo"]);
  writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "demo", dependencies: { hono: "4.1.0", zod: "3.0.0" }, devDependencies: { tsx: "4.0.0", "@types/node": "24.0.0" } }),
  );
  mkdirSync(path.join(dir, "svc"));
  // With a byte order mark, as PowerShell 5 writes it; npm reads it fine, and so must the merge check.
  writeFileSync(path.join(dir, "svc", "package.json"), "\uFEFF" + JSON.stringify({ name: "svc", optionalDependencies: { "left-pad": "1.0.0" } }));
  writeFileSync(path.join(dir, "notes.md"), "Not a manifest.\n");
  const head = (await commitAll(dir, "Add dependencies")) as string;

  const files = (await diffStat(dir, base, head)).files.map((f) => f.path);
  const added = await newDependencies(dir, base, head, files);
  assert.deepEqual(added, ["@types/node", "left-pad", "zod"]);
  assert.deepEqual(await newDependencies(dir, base, head, ["notes.md"]), []);
  const policy = parsePolicy("autoMerge: { dependencyAllowlist: ['@types/*', zod] }\n");
  assert.deepEqual(evaluateMerge(policy, { ...OK, files, newDependencies: added }).reasons, ["New dependencies not on the allowlist: left-pad."]);
});

test("createRun pins the base branch's policy, audited: its autonomy default and max apply (the lower of max and SF_AUTONOMY_CAP wins); an invalid policy starts no run and /status says why", async () => {
  const workspace = await repo("autonomy:\n  default: autonomous\n  max: supervised\nparallel: 2\n");
  const fake = await startFakeOpenHands();
  const ledger = openLedger(":memory:");
  const o = createOrchestrator({ ledger, client: new OpenHandsClient({ baseUrl: fake.url }), workspace, dataDir: mkdtempSync(path.join(dataDir, "case-")), graceMs: 0 });
  try {
    const { policy, hash } = await loadPolicy(workspace, "main");
    const run = await o.createRun({ goal: "Add a status page", actor: "user:test" });
    assert.equal(run.autonomy, "supervised"); // the policy's default, autonomous, capped by its max
    assert.equal(run.policyHash, hash);
    assert.deepEqual(run.policy, policy);
    assert.equal((await o.createRun({ goal: "Add a status page", autonomy: "suggest", actor: "user:test" })).autonomy, "suggest");
    process.env.SF_AUTONOMY_CAP = "suggest";
    try {
      assert.equal((await o.createRun({ goal: "Add a status page", actor: "user:test" })).autonomy, "suggest");
    } finally {
      delete process.env.SF_AUTONOMY_CAP;
    }
    await audit("test", "test.flush", "test");
    const loaded = listAudit(5000).filter((e) => e.subject === run.id && e.action === "autopilot.policy_loaded");
    assert.deepEqual(loaded.map((e) => [e.actor, e.data]), [["autopilot", { hash, source: ".factory/policy.yml@main", policy }]]);
    assert.deepEqual((await o.status()).policy, { source: ".factory/policy.yml@main", hash, error: null });

    // A broken policy on the base branch: no run starts on rules nobody wrote, and the status shows why.
    writePolicy(workspace, "parallel: lots\n");
    await commitAll(workspace, "Break the policy");
    await assert.rejects(o.createRun({ goal: "Add a status page", actor: "user:test" }), /\.factory\/policy\.yml@main: parallel must be a whole number/);
    assert.equal(ledger.listRuns().length, 3);
    assert.deepEqual((await o.status()).policy, {
      source: ".factory/policy.yml@main",
      hash: "",
      error: ".factory/policy.yml@main: parallel must be a whole number from 1 up",
    });
    assert.equal(ledger.getRun(run.id)?.policyHash, hash); // runs already going keep theirs
  } finally {
    o.stop();
    await o.idle();
    await fake.close();
    ledger.close();
  }
});

test("diffStat lists a path with a quote in it as it is, so the sensitive-path check still sees it", async () => {
  const dir = await repo();
  const base = (await git(dir, ["rev-parse", "HEAD"])).stdout.trim();
  // Built with plumbing: Windows can't have a " in a file name, Linux can.
  const blob = (await git(dir, ["hash-object", "-w", "README.md"])).stdout.trim();
  await git(dir, ["-c", "core.protectNTFS=false", "update-index", "--add", "--cacheinfo", `100644,${blob},infra/a"b.tf`]);
  await git(dir, ["commit", "-q", "-m", "Odd name"]);
  const files = (await diffStat(dir, base, "HEAD")).files.map((f) => f.path);
  assert.deepEqual(files, ['infra/a"b.tf']);
  assert.equal(sensitiveMatch(files[0]!, DEFAULT_POLICY.autoMerge.sensitivePaths), "infra/**");
});
