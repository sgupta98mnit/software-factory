// The git work Autopilot does around its agents: make the workspace a repo,
// give each run an integration branch in its own worktree, commit what agents
// wrote, merge work-order branches one at a time and read diffs. Agents never
// branch or merge; the factory does, so branch names and history stay predictable.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import path from "node:path";

/**
 * A file an agent wrote under `root`, or null. Never one that a symlink (of
 * the file or a folder on the way) points outside `root` to: an agent in a
 * container could otherwise make the factory read this machine's files.
 */
export function readInside(root: string, rel: string): string | null {
  try {
    const top = realpathSync.native(root);
    const real = realpathSync.native(path.join(root, rel));
    const fold = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
    if (!fold(real).startsWith(fold(top + path.sep)) || !statSync(real).isFile()) return null;
    return readFileSync(real, "utf8");
  } catch {
    return null;
  }
}

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

// Same line endings and author on every machine, and paths printed as-is. The factory runs git in
// folders agents wrote: no fsmonitor command and no look inside nested repositories, whose config an
// agent could have written (these settings also reach the git processes git starts itself).
const BASE_ARGS = [
  "-c", "core.autocrlf=false",
  "-c", "core.quotepath=false",
  "-c", "core.fsmonitor=false",
  "-c", "diff.ignoreSubmodules=all",
  "-c", "user.name=Software Factory",
  "-c", "user.email=factory@localhost",
];

// Everything but installed packages: agents run npm install in worktrees that may have no .gitignore.
const ADD_ALL = ["add", "-A", "--", ".", ":(exclude,glob)**/node_modules/**"];

/** Runs git in `cwd`. Throws on a non-zero exit unless `allowFail`. */
export function git(cwd: string, args: string[], opts: { allowFail?: boolean } = {}): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      [...BASE_ARGS, ...args],
      { cwd, maxBuffer: 50 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        // A spawn failure (no git, missing cwd) has a string code; an exit status is a number.
        if (error && typeof error.code !== "number") return reject(error);
        const result = { code: typeof error?.code === "number" ? error.code : 0, stdout, stderr };
        if (result.code !== 0 && !opts.allowFail) {
          return reject(new Error(`git ${args.join(" ")} failed (${result.code}): ${stderr.trim() || stdout.trim()}`));
        }
        resolve(result);
      },
    );
  });
}

// Worktree and branch changes touch the repo's shared metadata, so they run one at a time per repo.
const locks = new Map<string, Promise<unknown>>();
function locked<T>(repo: string, fn: () => Promise<T>): Promise<T> {
  const key = process.platform === "win32" ? path.resolve(repo).toLowerCase() : path.resolve(repo);
  const next = (locks.get(key) ?? Promise.resolve()).then(fn);
  locks.set(key, next.catch(() => undefined));
  return next;
}

function samePath(a: string, b: string): boolean {
  const real = (p: string) => realpathSync.native(p);
  return process.platform === "win32" ? real(a).toLowerCase() === real(b).toLowerCase() : real(a) === real(b);
}

/** True when `dir` is the top of its own repo (not just a folder inside another one). */
export async function isRepoRoot(dir: string): Promise<boolean> {
  if (!existsSync(dir)) return false;
  const top = await git(dir, ["rev-parse", "--show-toplevel"], { allowFail: true });
  return top.code === 0 && samePath(top.stdout.trim(), dir);
}

/**
 * Makes `dir` a repo with at least one commit. The demo workspace sits inside
 * the factory repo; it becomes its own nested repo, which git handles fine.
 */
export async function ensureRepo(dir: string): Promise<{ initialized: boolean }> {
  const isRoot = await isRepoRoot(dir);
  if (isRoot && (await git(dir, ["rev-parse", "--verify", "-q", "HEAD"], { allowFail: true })).code === 0) {
    return { initialized: false };
  }
  if (!isRoot) await git(dir, ["init", "-b", "main"]);
  await git(dir, ADD_ALL);
  await git(dir, ["commit", "--allow-empty", "-m", "Baseline (Software Factory)"]);
  return { initialized: true };
}

/** null on a detached HEAD. */
export async function currentBranch(dir: string): Promise<string | null> {
  const r = await git(dir, ["symbolic-ref", "--short", "-q", "HEAD"], { allowFail: true });
  return r.code === 0 ? r.stdout.trim() : null;
}

export async function headSha(dir: string, ref = "HEAD"): Promise<string> {
  return (await git(dir, ["rev-parse", "--verify", `${ref}^{commit}`])).stdout.trim();
}

export async function branchExists(repo: string, name: string): Promise<boolean> {
  return (await git(repo, ["show-ref", "--verify", "--quiet", `refs/heads/${name}`], { allowFail: true })).code === 0;
}

/** Is commit `a` already contained in `b`? */
export async function isAncestor(repo: string, a: string, b: string): Promise<boolean> {
  const r = await git(repo, ["merge-base", "--is-ancestor", a, b], { allowFail: true });
  if (r.code > 1) throw new Error(`git merge-base failed: ${r.stderr.trim()}`);
  return r.code === 0;
}

/** A fresh worktree at `dir` on a new `branch` from `startPoint`, replacing any old one with that folder or branch. */
export function addWorktree(repo: string, dir: string, branch: string, startPoint: string): Promise<void> {
  return locked(repo, async () => {
    if (existsSync(dir)) {
      await git(repo, ["worktree", "remove", "--force", dir], { allowFail: true });
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    }
    await git(repo, ["worktree", "prune"]);
    if (await branchExists(repo, branch)) await git(repo, ["branch", "-D", branch]);
    mkdirSync(path.dirname(dir), { recursive: true });
    await git(repo, ["worktree", "add", "-b", branch, dir, startPoint]);
  });
}

/** A throwaway checkout of `sha` at `dir`, on no branch: what the factory verifies, which no agent ever sees. */
export function addDetachedWorktree(repo: string, dir: string, sha: string): Promise<void> {
  return locked(repo, async () => {
    if (existsSync(dir)) {
      await git(repo, ["worktree", "remove", "--force", dir], { allowFail: true });
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    }
    await git(repo, ["worktree", "prune"]);
    mkdirSync(path.dirname(dir), { recursive: true });
    await git(repo, ["worktree", "add", "--detach", dir, sha]);
  });
}

/** Puts `paths` back as they are at `source` (deleting the ones it doesn't have), staged and in the folder. */
export async function restorePaths(dir: string, source: string, paths: string[]): Promise<void> {
  if (paths.length) await git(dir, ["restore", `--source=${source}`, "--staged", "--worktree", "--", ...paths]);
}

/** Removes the worktree folder; the branch stays. A missing folder is fine. */
export function removeWorktree(repo: string, dir: string): Promise<void> {
  return locked(repo, async () => {
    await git(repo, ["worktree", "remove", "--force", dir], { allowFail: true });
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    await git(repo, ["worktree", "prune"]);
  });
}

export function deleteBranch(repo: string, name: string): Promise<void> {
  return locked(repo, async () => {
    await git(repo, ["branch", "-D", name], { allowFail: true });
  });
}

const mergeInProgress = async (dir: string) =>
  (await git(dir, ["rev-parse", "-q", "--verify", "MERGE_HEAD"], { allowFail: true })).code === 0;

/** Commits everything in the worktree but node_modules; concludes a merge in progress. null when there was nothing to commit. */
export async function commitAll(dir: string, message: string): Promise<string | null> {
  await git(dir, ADD_ALL);
  const merging = await mergeInProgress(dir);
  if (!merging && (await git(dir, ["diff", "--cached", "--quiet"], { allowFail: true })).code === 0) return null;
  await git(dir, merging ? ["commit", "--no-edit"] : ["commit", "-m", message]);
  return headSha(dir);
}

/** No uncommitted changes. Installed packages don't count: they're never part of the work. */
export async function isClean(dir: string): Promise<boolean> {
  return (await git(dir, ["status", "--porcelain", "--", ".", ":(exclude,glob)**/node_modules/**"])).stdout.trim() === "";
}

/** Throws away uncommitted edits and new files (a critic or reviewer that edited when it shouldn't have), keeping installed packages. */
export async function discardChanges(dir: string): Promise<void> {
  await git(dir, ["reset", "--hard"]);
  await git(dir, ["clean", "-fd", "-e", "node_modules"]);
}

export async function resetHard(dir: string, sha: string): Promise<void> {
  await git(dir, ["reset", "--hard", sha]);
}

/** Lines added and deleted per file between `base` and `head` (from their merge base). Binary files count 0. */
export async function diffStat(dir: string, base: string, head = "HEAD") {
  // -z: paths as they are. Without it git quotes one with a " or tab in it, and the policy's sensitive-path check would miss it.
  const out = (await git(dir, ["diff", "--numstat", "-z", "--no-renames", `${base}...${head}`])).stdout;
  const files = out
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const [added = "0", deleted = "0", ...rest] = line.split("\t");
      const count = (n: string) => (n === "-" ? 0 : Number(n));
      return { path: rest.join("\t"), added: count(added), deleted: count(deleted) };
    });
  return { files, linesChanged: files.reduce((sum, f) => sum + f.added + f.deleted, 0) };
}

/** Every added line between `base` and `head`, for the secret scan. */
export async function addedLines(dir: string, base: string, head = "HEAD"): Promise<{ path: string; line: string }[]> {
  const out = (await git(dir, ["diff", "--unified=0", "--no-color", "--no-renames", `${base}...${head}`])).stdout;
  const lines: { path: string; line: string }[] = [];
  let file = "";
  for (const line of out.split("\n")) {
    if (line.startsWith("+++ ")) file = line.slice(4).replace(/^b\//, "");
    else if (line.startsWith("+") && file !== "/dev/null") lines.push({ path: file, line: line.slice(1) });
  }
  return lines;
}

/** A file's content at a ref, or null when it isn't there. */
export async function fileAt(dir: string, ref: string, file: string): Promise<string | null> {
  const r = await git(dir, ["show", `${ref}:${file.replaceAll("\\", "/")}`], { allowFail: true });
  return r.code === 0 ? r.stdout : null;
}

async function conflictedFiles(dir: string): Promise<string[]> {
  return (await git(dir, ["diff", "--name-only", "--diff-filter=U"])).stdout.split("\n").filter(Boolean);
}

/** Merges `branch` into the checked-out branch with a merge commit. On a conflict, aborts and lists the files. */
export async function merge(
  dir: string,
  branch: string,
  message: string,
): Promise<{ ok: true; sha: string } | { ok: false; conflicts: string[] }> {
  const r = await git(dir, ["merge", "--no-ff", "-m", message, branch], { allowFail: true });
  if (r.code === 0) return { ok: true, sha: await headSha(dir) };
  const conflicts = await conflictedFiles(dir);
  await git(dir, ["merge", "--abort"], { allowFail: true });
  if (!conflicts.length) throw new Error(`git merge ${branch} failed: ${r.stderr.trim() || r.stdout.trim()}`);
  return { ok: false, conflicts };
}

/**
 * Brings `branch` into a work-order branch. On a conflict the markers stay in
 * place for the builder to resolve; commitAll() concludes the merge afterwards.
 */
export async function mergeInto(dir: string, branch: string): Promise<{ ok: boolean; conflicts: string[] }> {
  const r = await git(dir, ["merge", "--no-edit", branch], { allowFail: true });
  if (r.code === 0) return { ok: true, conflicts: [] };
  const conflicts = await conflictedFiles(dir);
  if (!conflicts.length) throw new Error(`git merge ${branch} failed: ${r.stderr.trim() || r.stdout.trim()}`);
  return { ok: false, conflicts };
}
