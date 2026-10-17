import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  addWorktree,
  addedLines,
  branchExists,
  commitAll,
  currentBranch,
  deleteBranch,
  diffStat,
  discardChanges,
  ensureRepo,
  fileAt,
  git,
  headSha,
  isAncestor,
  isClean,
  isRepoRoot,
  merge,
  mergeInto,
  removeWorktree,
  resetHard,
  squash,
} from "../src/autopilot/git.js";

const tmp = (name: string) => mkdtempSync(path.join(tmpdir(), `sf-git-${name}-`));

async function repo(): Promise<string> {
  const dir = tmp("repo");
  writeFileSync(path.join(dir, "a.txt"), "one\ntwo\nthree\n");
  await ensureRepo(dir);
  return dir;
}

test("ensureRepo makes a folder inside another repo its own repo, with a baseline commit", async () => {
  const outer = tmp("outer");
  await git(outer, ["init", "-b", "main"]);
  const inner = path.join(outer, "workspaces", "demo");
  mkdirSync(inner, { recursive: true });
  writeFileSync(path.join(inner, "README.md"), "hi\n");
  assert.equal(await isRepoRoot(inner), false); // it's inside the outer repo

  assert.deepEqual(await ensureRepo(inner), { initialized: true });
  assert.equal(await isRepoRoot(inner), true);
  assert.equal(await currentBranch(inner), "main");
  assert.equal(await fileAt(inner, "HEAD", "README.md"), "hi\n");
  assert.equal(await isClean(inner), true);
  assert.deepEqual(await ensureRepo(inner), { initialized: false });

  // A repo without commits gets the baseline too.
  const empty = tmp("empty");
  await git(empty, ["init", "-b", "main"]);
  assert.deepEqual(await ensureRepo(empty), { initialized: true });
  assert.match(await headSha(empty), /^[0-9a-f]{40}$/);
});

test("worktrees: added on a new branch, replaced when added again, removed with the branch kept", async () => {
  const r = await repo();
  const wt = path.join(tmp("wt"), "run", "integration");
  await addWorktree(r, wt, "autopilot/demo", "main");
  assert.equal(await currentBranch(wt), "autopilot/demo");

  writeFileSync(path.join(wt, "b.txt"), "new\n");
  const sha = await commitAll(wt, "Add b");
  assert.match(sha ?? "", /^[0-9a-f]{40}$/);
  assert.equal(await commitAll(wt, "Nothing"), null);
  assert.equal(await headSha(r, "autopilot/demo"), sha);
  // An agent's npm install never lands in a commit, even without a .gitignore.
  for (const dir of ["node_modules/left-pad", "svc/node_modules/x"]) {
    mkdirSync(path.join(wt, dir), { recursive: true });
    writeFileSync(path.join(wt, dir, "index.js"), "module.exports = 1;\n");
  }
  assert.equal(await commitAll(wt, "Only packages"), null);
  writeFileSync(path.join(wt, "svc", "app.js"), "1;\n");
  const withApp = await commitAll(wt, "Add app");
  assert.deepEqual((await git(wt, ["ls-tree", "-r", "--name-only", withApp ?? ""])).stdout.trim().split("\n"), ["a.txt", "b.txt", "svc/app.js"]);
  assert.equal(await isAncestor(r, "main", "autopilot/demo"), true);
  assert.equal(await isAncestor(r, "autopilot/demo", "main"), false);

  // Adding the same folder and branch again starts over from the start point.
  await addWorktree(r, wt, "autopilot/demo", "main");
  assert.equal(existsSync(path.join(wt, "b.txt")), false);
  assert.equal(await headSha(r, "autopilot/demo"), await headSha(r, "main"));

  await removeWorktree(r, wt);
  assert.equal(existsSync(wt), false);
  assert.equal(await branchExists(r, "autopilot/demo"), true);
  await removeWorktree(r, wt); // already gone is fine
  await deleteBranch(r, "autopilot/demo");
  assert.equal(await branchExists(r, "autopilot/demo"), false);
});

test("discardChanges throws away edits and new files but keeps installed packages, which don't make a tree dirty", async () => {
  const r = await repo();
  mkdirSync(path.join(r, "pkg", "node_modules", "dep"), { recursive: true });
  writeFileSync(path.join(r, "pkg", "node_modules", "dep", "index.js"), "x\n");
  assert.equal(await isClean(r), true);
  writeFileSync(path.join(r, "a.txt"), "edited\n");
  writeFileSync(path.join(r, "stray.txt"), "x\n");
  assert.equal(await isClean(r), false);
  await discardChanges(r);
  assert.equal(await isClean(r), true);
  assert.equal(readFileSync(path.join(r, "a.txt"), "utf8"), "one\ntwo\nthree\n");
  assert.equal(existsSync(path.join(r, "stray.txt")), false);
  assert.equal(existsSync(path.join(r, "pkg", "node_modules", "dep", "index.js")), true);
});

test("squash: one commit for the work; none when the commits add up to nothing (a builder that undid its own work)", async () => {
  const r = await repo();
  const base = await headSha(r);
  writeFileSync(path.join(r, "b.txt"), "b\n");
  await commitAll(r, "one");
  writeFileSync(path.join(r, "c.txt"), "c\n");
  await commitAll(r, "two");
  const sha = await squash(r, base, "WO-1: both");
  assert.equal((await git(r, ["rev-list", "--count", `${base}..HEAD`])).stdout.trim(), "1");
  assert.equal(sha, await headSha(r));
  assert.equal(await fileAt(r, "HEAD", "c.txt"), "c\n");

  // Two commits that cancel out, and an empty one: nothing to squash, the branch goes back to base.
  const base2 = await headSha(r);
  writeFileSync(path.join(r, "a.txt"), "changed\n");
  await commitAll(r, "change");
  writeFileSync(path.join(r, "a.txt"), "one\ntwo\nthree\n");
  await commitAll(r, "change back");
  assert.equal(await squash(r, base2, "WO-2: nothing"), base2);
  assert.equal(await headSha(r), base2);
  assert.equal(await isClean(r), true);
  await git(r, ["commit", "-q", "--allow-empty", "-m", "empty"]);
  assert.equal(await squash(r, base2, "WO-2: nothing"), base2);
});

test("merge: clean merges commit, conflicts abort and list the files; mergeInto leaves the markers", async () => {
  const r = await repo();
  const dir = tmp("merge");
  const integration = path.join(dir, "integration");
  await addWorktree(r, integration, "autopilot/x", "main");
  // Work-order branches can't live under "autopilot/x/" while "autopilot/x" exists (git refs are files).
  const wo1 = path.join(dir, "wo-1");
  const wo2 = path.join(dir, "wo-2");
  await addWorktree(r, wo1, "autopilot-wo/x/wo-1", "autopilot/x");
  await addWorktree(r, wo2, "autopilot-wo/x/wo-2", "autopilot/x");
  writeFileSync(path.join(wo1, "a.txt"), "one\nTWO\nthree\n");
  await commitAll(wo1, "WO-1");
  writeFileSync(path.join(wo2, "a.txt"), "one\nZWEI\nthree\n");
  await commitAll(wo2, "WO-2");

  const base = await headSha(integration);
  const first = await merge(integration, "autopilot-wo/x/wo-1", "Merge WO-1");
  assert.equal(first.ok, true);
  assert.equal((await git(integration, ["log", "-1", "--format=%s"])).stdout.trim(), "Merge WO-1");
  assert.deepEqual(await diffStat(integration, base), { files: [{ path: "a.txt", added: 1, deleted: 1 }], linesChanged: 2 });
  assert.deepEqual(await addedLines(integration, base), [{ path: "a.txt", line: "TWO", number: 2 }]);

  const second = await merge(integration, "autopilot-wo/x/wo-2", "Merge WO-2");
  assert.deepEqual(second, { ok: false, conflicts: ["a.txt"] });
  assert.equal(await isClean(integration), true); // the merge was aborted

  // Syncing the work-order branch leaves the conflict for its builder.
  assert.deepEqual(await mergeInto(wo2, "autopilot/x"), { ok: false, conflicts: ["a.txt"] });
  assert.match(readFileSync(path.join(wo2, "a.txt"), "utf8"), /<<<<<<<[\s\S]*=======[\s\S]*>>>>>>>/);
  writeFileSync(path.join(wo2, "a.txt"), "one\nTWO and ZWEI\nthree\n");
  await commitAll(wo2, "ignored: a merge keeps its own message");
  assert.equal(await isAncestor(r, "autopilot/x", "autopilot-wo/x/wo-2"), true);
  assert.equal((await merge(integration, "autopilot-wo/x/wo-2", "Merge WO-2")).ok, true);
  assert.equal(readFileSync(path.join(integration, "a.txt"), "utf8"), "one\nTWO and ZWEI\nthree\n");
  assert.deepEqual(await mergeInto(wo1, "autopilot/x"), { ok: true, conflicts: [] });

  // The integrator's revert is a reset to the sha before the merge.
  await resetHard(integration, base);
  assert.equal(await headSha(integration), base);
  assert.equal(await fileAt(integration, "autopilot/x", "a.txt"), "one\ntwo\nthree\n");
  assert.equal(await fileAt(integration, "autopilot/x", "missing.txt"), null);
});
