import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.SF_DATA_DIR = mkdtempSync(path.join(tmpdir(), "sf-scan-data-"));
process.env.SF_WORKSPACE = mkdtempSync(path.join(tmpdir(), "sf-scan-unused-"));
const { describeFindings, scanDependencies, scanManifest, scanSecrets } = await import("../src/autopilot/scan.js");
const { addedLines, commitAll, ensureRepo, git, headSha } = await import("../src/autopilot/git.js");

// Assembled at run time so this file itself doesn't trip secret scanners.
const AWS = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
const GH = ["ghp_", "a".repeat(20), "B".repeat(16)].join("");
const PEM = ["-----BEGIN", "RSA PRIVATE KEY-----"].join(" ");

test("scanSecrets: known credential formats and hard-coded secrets, never the secret itself in the finding", () => {
  const found = scanSecrets([
    { path: "src/aws.js", line: `const id = "${AWS}";`, number: 3 },
    { path: "src/gh.js", line: `token: "${GH}"`, number: 1 },
    { path: "keys/id_rsa", line: PEM, number: 1 },
    { path: "src/db.js", line: 'const password = "Tr0ub4dor&3xK9";', number: 7 },
  ]);
  assert.deepEqual(
    found.map((f) => [f.rule, f.file, f.line]),
    [
      ["aws-access-key", "src/aws.js", 3],
      ["github-token", "src/gh.js", 1],
      ["private-key", "keys/id_rsa", 1],
      ["hardcoded-secret", "src/db.js", 7],
    ],
  );
  const text = describeFindings(found);
  for (const secret of [AWS, GH, "Tr0ub4dor"]) assert.ok(!text.includes(secret), `leaked ${secret}`);
  assert.match(text, /^src\/aws\.js:3: Looks like a aws access key \(aws-access-key\)$/m);
});

test("scanSecrets: placeholders, environment lookups, plain words and lockfile hashes are not secrets", () => {
  assert.deepEqual(
    scanSecrets([
      { path: "src/a.js", line: 'const password = "changeme";' },
      { path: "src/a.js", line: 'const apiKey = "<your-key-here>";' },
      { path: "src/a.js", line: "const token = process.env.TOKEN;" },
      { path: "src/a.js", line: 'const secret = "${SECRET}";' },
      { path: "src/a.js", line: 'const password = "aaaaaaaaaaaa";' }, // no entropy
      { path: "README.md", line: "Set the password in the vault." },
      { path: "package-lock.json", line: `"integrity": "sha512-${"x".repeat(80)}", "auth_token": "Tr0ub4dor&3xK9"` }, // a known key format would count (autopilot-review-p3)
    ]),
    [],
  );
});

test("scanManifest: unpinned versions, sources outside the registry and new install scripts; unchanged entries are fine", () => {
  const before = { dependencies: { hono: "4.13.12", old: "^1.0.0" }, scripts: { test: "node --test" } };
  const after = {
    dependencies: { hono: "4.13.12", old: "^1.0.0", zod: "^3.0.0", tool: "git+https://example.com/tool.git", fork: "someone/fork", exact: "1.2.3" },
    devDependencies: { tsx: "latest", beta: "2.0.0-beta.1" },
    scripts: { test: "node --test", postinstall: "node setup.js" },
  };
  assert.deepEqual(
    scanManifest("package.json", before, after).map((f) => [f.rule, f.detail]),
    [
      ["dependency-unpinned", "zod@^3.0.0 isn't pinned to an exact version"],
      ["dependency-source", "tool installs from outside the npm registry (git+https://example.com/tool.git)"],
      ["dependency-source", "fork installs from outside the npm registry (someone/fork)"],
      ["dependency-unpinned", "tsx@latest isn't pinned to an exact version"],
      ["install-script", 'Adds or changes the "postinstall" script, which runs on every install'],
    ],
  );
  assert.deepEqual(scanManifest("package.json", after, after), []);
});

test("addedLines and scanDependencies on real git history: line numbers in the new file, manifests compared with the base", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sf-scan-ws-"));
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "x", dependencies: { a: "1.0.0" } }));
  writeFileSync(path.join(dir, "app.js"), "line 1\nline 2\n");
  await ensureRepo(dir);
  const base = await headSha(dir);
  await git(dir, ["checkout", "-q", "-b", "work"]);
  writeFileSync(path.join(dir, "app.js"), `line 1\n++ looks like a header\nline 2\nconst k = "${AWS}";\n`);
  mkdirSync(path.join(dir, "pkg"));
  writeFileSync(path.join(dir, "pkg", "package.json"), "{ not json");
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "x", dependencies: { a: "1.0.0", b: "~2.0.0" } }));
  await commitAll(dir, "work");

  const lines = await addedLines(dir, base, "work");
  assert.deepEqual(
    lines.filter((l) => l.path === "app.js").map((l) => [l.number, l.line]),
    [
      [2, "++ looks like a header"],
      [4, `const k = "${AWS}";`],
    ],
  );
  assert.deepEqual(scanSecrets(lines).map((f) => `${f.file}:${f.line}`), ["app.js:4"]);
  const deps = await scanDependencies(dir, base, "work", ["package.json", "pkg/package.json", "app.js"]);
  assert.deepEqual(deps.map((f) => [f.rule, f.file]), [["dependency-unpinned", "package.json"], ["manifest-invalid", "pkg/package.json"]]);
});

// ---- the scans in a run ----

const { startFakeOpenHands } = await import("../src/demo/fake-agent-server.js");
const { createOrchestrator } = await import("../src/autopilot/orchestrator.js");
const { openLedger } = await import("../src/autopilot/ledger.js");
const { OpenHandsClient } = await import("../src/autopilot/openhands.js");

const PASS = 'Reviewed.\n\n```json\n{"verdict":"pass","findings":[]}\n```';

async function run(builder: (conv: import("../src/demo/fake-agent-server.js").FakeConversation) => Promise<unknown> | unknown) {
  const workspace = mkdtempSync(path.join(tmpdir(), "sf-scan-run-"));
  writeFileSync(path.join(workspace, "README.md"), "# Demo\n");
  const fake = await startFakeOpenHands({
    onMessage: async (conv) => (conv.tags.sfrole === "builder" ? ((await builder(conv)) as object) : { response: PASS, cost: 0.01 }),
  });
  const ledger = openLedger(":memory:");
  const o = createOrchestrator({ ledger, client: new OpenHandsClient({ baseUrl: fake.url }), workspace, dataDir: mkdtempSync(path.join(tmpdir(), "sf-scan-run-data-")), graceMs: 0 });
  const r = await o.createRun({ goal: "Add a lookup", autonomy: "supervised", actor: "user:test" });
  ledger.addWorkOrders(r.id, [{ seq: 1, title: "Lookup", acceptance: ["It works"], controls: [], dependsOn: [], wave: 1, risk: "low" }]);
  ledger.updateRun(r.id, { state: "building" });
  const until = async (done: () => boolean) => {
    for (let i = 0; i < 60 && !done(); i++) {
      await o.tick();
      await o.idle();
      await fake.settled();
    }
    assert.ok(done(), "the run didn't get there");
  };
  return { workspace, fake, ledger, o, r, until, close: async () => { o.stop(); await o.idle(); await fake.close(); ledger.close(); } };
}

const PKG = (deps: Record<string, string> = {}) => JSON.stringify({ name: "x", private: true, type: "module", scripts: { test: "node --test" }, dependencies: deps });
const passingTest = 'import { test } from "node:test";\ntest("ok", () => {});\n';

test("in a run: a committed secret goes back to the builder by file and line, never by value; squashed away, it's in no commit of the delivered branch", async () => {
  const t = await run(async (conv) => {
    const dir = conv.workingDir;
    writeFileSync(path.join(dir, "package.json"), PKG());
    writeFileSync(path.join(dir, "ok.test.js"), passingTest);
    if (conv.messages.length === 1) {
      writeFileSync(path.join(dir, "config.js"), `export const key = "${AWS}";\n`);
      await git(dir, ["add", "-A"]);
      await git(dir, ["commit", "-q", "-m", "first try"]);
    } else {
      writeFileSync(path.join(dir, "config.js"), "export const key = process.env.KEY;\n");
    }
    return { response: "Done.", cost: 0.1 };
  });
  try {
    await t.until(() => t.ledger.getRun(t.r.id)?.state === "done");
    const scans = t.ledger.listChecks({ runId: t.r.id }).filter((c) => c.name === "secret-scan");
    assert.deepEqual(scans.map((c) => c.ok), [false, true]);
    const [builder] = t.ledger.listAttempts({ runId: t.r.id, role: "builder" });
    const repair = t.fake.conversations.get(builder!.conversationId)!.messages[1] ?? "";
    assert.match(repair, /Secret scan: config\.js:1: Looks like a aws access key/);
    assert.ok(!repair.includes(AWS) && !scans[0]!.output.includes(AWS));
    const log = (await git(t.workspace, ["log", "-p", t.r.integrationBranch])).stdout;
    assert.ok(!log.includes(AWS), "the secret is somewhere in the delivered branch's history");
  } finally {
    await t.close();
  }
});

test("in a run: an unpinned dependency is recorded by the scan and puts the merge in front of a person, with the reason", async () => {
  const t = await run((conv) => {
    writeFileSync(path.join(conv.workingDir, "package.json"), PKG({ zod: "^3.23.0" }));
    writeFileSync(path.join(conv.workingDir, "ok.test.js"), passingTest);
    return { response: "Done.", cost: 0.1 };
  });
  try {
    await t.until(() => t.ledger.listInbox({ runId: t.r.id }).some((i) => i.kind === "merge_approval"));
    const scan = t.ledger.listChecks({ runId: t.r.id }).find((c) => c.name === "dependency-scan")!;
    assert.equal(scan.ok, false);
    assert.match(scan.output, /zod@\^3\.23\.0 isn't pinned to an exact version/);
    const item = t.ledger.listInbox({ runId: t.r.id }).find((i) => i.kind === "merge_approval")!;
    assert.match(item.body, /The dependency scan found: package\.json: zod@\^3\.23\.0 isn't pinned/);
    assert.match(item.body, /New dependencies not on the allowlist: zod/);
  } finally {
    await t.close();
  }
});
