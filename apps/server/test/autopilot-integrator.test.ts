import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { addWorktree, commitAll, ensureRepo, git, headSha, isClean } from "../src/autopilot/git.js";
import { mergeAndTest } from "../src/autopilot/integrator.js";

const PKG = JSON.stringify({ name: "demo", private: true, type: "module", scripts: { test: "node --test" } });
const passing = (name: string) => `import { test } from "node:test";\ntest("${name}", () => {});\n`;
const failing = (name: string) => `import { test } from "node:test";\nimport assert from "node:assert/strict";\ntest("${name}", () => assert.fail("${name} is broken"));\n`;

/** A workspace repo with a passing package on main, and the integration worktree on autopilot/x. */
async function setup() {
  const root = mkdtempSync(path.join(tmpdir(), "sf-integrator-"));
  const repo = path.join(root, "repo");
  mkdirSync(repo);
  writeFileSync(path.join(repo, "package.json"), PKG);
  writeFileSync(path.join(repo, "base.test.js"), passing("base"));
  writeFileSync(path.join(repo, "shared.txt"), "base\n");
  await ensureRepo(repo);
  const integration = path.join(root, "integration");
  await addWorktree(repo, integration, "autopilot/x", "main");
  /** A work-order branch from the integration tip with `files` committed on it. */
  const branch = async (name: string, files: Record<string, string>) => {
    const dir = path.join(root, name);
    await addWorktree(repo, dir, `autopilot/x--${name}`, "autopilot/x");
    for (const [file, text] of Object.entries(files)) writeFileSync(path.join(dir, file), text);
    await commitAll(dir, name);
    return `autopilot/x--${name}`;
  };
  const merges = async (since: string) => Number((await git(integration, ["rev-list", "--merges", "--count", `${since}..HEAD`])).stdout.trim());
  return { integration, branch, merges };
}

test("mergeAndTest: passing gates keep the merge; failing ones reset the integration branch to the sha before it", async () => {
  const t = await setup();
  // The first merge changes package.json, so the integration worktree's packages are installed afresh.
  mkdirSync(path.join(t.integration, "node_modules"));
  writeFileSync(path.join(t.integration, "node_modules", "stale.txt"), "old\n");
  const good = await t.branch("wo-1", { "one.test.js": passing("one"), "package.json": PKG.replace('"demo"', '"demo-1"') });
  const before = await headSha(t.integration);
  const merged = await mergeAndTest(t.integration, good, "Merge WO-1: One", before);
  assert.equal(merged.outcome, "merged");
  if (merged.outcome !== "merged") return;
  assert.equal(merged.sha, await headSha(t.integration));
  assert.deepEqual([merged.files, merged.linesChanged], [2, 4]);
  assert.deepEqual(merged.results.map((r) => [r.name, r.ok]), [["test", true]]);
  assert.equal((await git(t.integration, ["log", "-1", "--format=%s"])).stdout.trim(), "Merge WO-1: One");
  assert.equal(existsSync(path.join(t.integration, "node_modules")), false);

  const bad = await t.branch("wo-2", { "two.test.js": failing("two") });
  const r = await mergeAndTest(t.integration, bad, "Merge WO-2: Two", merged.sha);
  assert.equal(r.outcome, "reverted");
  if (r.outcome !== "reverted") return;
  assert.equal(await headSha(t.integration), merged.sha);
  assert.equal(await isClean(t.integration), true);
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0]?.source, "integration");
  assert.match(r.findings[0]?.title ?? "", /^After merging into the integration branch: Gate test: `npm run test` failed/);
  assert.match(r.findings[0]?.detail ?? "", /two is broken/);
});

test("mergeAndTest: a reverted merge that changed package.json takes the packages installed for it along", async () => {
  const t = await setup();
  const before = await headSha(t.integration);
  // Its test stands in for an install of the merge's own dependencies, then fails.
  const bad = await t.branch("wo-1", {
    "package.json": JSON.stringify({ name: "demo", private: true, type: "module", scripts: { test: "node install-then-fail.mjs" } }),
    "install-then-fail.mjs": 'import { mkdirSync, writeFileSync } from "node:fs";\nmkdirSync("node_modules", { recursive: true });\nwriteFileSync("node_modules/left-pad.txt", "2.0.0\\n");\nprocess.exit(1);\n',
  });
  const r = await mergeAndTest(t.integration, bad, "Merge WO-1", before);
  assert.equal(r.outcome, "reverted");
  assert.equal(await headSha(t.integration), before);
  assert.equal(existsSync(path.join(t.integration, "node_modules")), false); // the next merge installs from the reset lockfile
});

test("mergeAndTest: a conflict leaves the integration branch as it was and names the files", async () => {
  const t = await setup();
  const first = await t.branch("wo-1", { "shared.txt": "from WO-1\n" });
  const second = await t.branch("wo-2", { "shared.txt": "from WO-2\n" });
  const tip = (await mergeAndTest(t.integration, first, "Merge WO-1", await headSha(t.integration))) as { sha: string };
  const r = await mergeAndTest(t.integration, second, "Merge WO-2", tip.sha);
  assert.equal(r.outcome, "conflict");
  if (r.outcome !== "conflict") return;
  assert.deepEqual(r.conflicts, ["shared.txt"]);
  assert.deepEqual(r.results, []); // no gates on a merge that didn't happen
  assert.match(r.findings[0]?.title ?? "", /conflicts in: shared\.txt\. Resolve the conflicts/);
  assert.equal(await headSha(t.integration), tip.sha);
  assert.equal(await isClean(t.integration), true);
});

test("mergeAndTest after a restart: a half-done merge is made again; one already made goes straight to the gates", async () => {
  const t = await setup();
  const halfDone = await t.branch("wo-1", { "one.test.js": passing("one") });
  const before = await headSha(t.integration);
  await git(t.integration, ["merge", "--no-ff", "--no-commit", halfDone]); // the factory stopped here
  const first = await mergeAndTest(t.integration, halfDone, "Merge WO-1", before);
  assert.equal(first.outcome, "merged");
  assert.equal(await t.merges(before), 1);

  const done = await t.branch("wo-2", { "two.test.js": passing("two") });
  const pre = await headSha(t.integration);
  await git(t.integration, ["merge", "--no-ff", "-m", "Merge WO-2", done]); // ... or here, before the gates
  const second = await mergeAndTest(t.integration, done, "Merge WO-2", pre);
  assert.equal(second.outcome, "merged");
  assert.equal(await t.merges(pre), 1); // not merged twice
  assert.deepEqual(second.outcome === "merged" && second.results.map((r) => r.name), ["test"]);
});
