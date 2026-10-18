// The integrate stage's git side: merge one work order's branch into the
// run's integration worktree and run the gates again on the combined code.
// The orchestrator merges one work order at a time, so each merge is tested
// on top of everything merged before it. A merge whose gates fail is undone
// with a reset to the sha before it: the integration branch is local and
// unpublished, and a `git revert` of the merge would stop the same commits
// from merging again once the builder has fixed them.
import { rmSync } from "node:fs";
import path from "node:path";
import { detectGates, gateFindings, runGates, type Gate, type GateResult } from "./gates.js";
import { diffStat, discardChanges, headSha, isAncestor, merge, resetHard } from "./git.js";
import type { Finding } from "./ledger.js";

export type MergeResult =
  | { outcome: "merged"; sha: string; files: number; linesChanged: number; results: GateResult[] }
  | { outcome: "conflict"; conflicts: string[]; results: GateResult[]; findings: Finding[] }
  | { outcome: "reverted"; sha: string; results: GateResult[]; findings: Finding[] }; // sha: the merge that failed its checks

// A package whose manifest or lockfile a merge changed gets a fresh install (detectGates installs where node_modules is missing).
const MANIFEST = /(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json)$/;

/** What the builder hears when its branch and the integration branch change the same lines. */
export function conflictFinding(files: string[]): Finding {
  return {
    source: "integration",
    severity: "high",
    title: `Merging the latest integration branch into your branch conflicts in: ${files.join(", ")}. Resolve the conflicts, keep every check passing, and commit.`,
    detail: "",
  };
}

/** Gates that failed on the integration branch once this work was merged into it. */
export const integrationFindings = (results: GateResult[]): Finding[] =>
  gateFindings(results).map((f) => ({ ...f, source: "integration", title: `After merging into the integration branch: ${f.title}` }));

/**
 * Merges `branch` into the integration worktree `dir` and runs the gates
 * there: the policy's `gates`, or those detected once merged. `preMergeSha`
 * is the integration sha before this merge, which the caller has saved
 * first, so this is safe to run again after a restart: a merge left half
 * done is thrown away and made again, and one already made goes straight to
 * the gates. A conflict leaves `dir` as it was; failing gates reset it to
 * `preMergeSha`.
 */
export async function mergeAndTest(
  dir: string,
  branch: string,
  message: string,
  preMergeSha: string,
  gates: Gate[] | null | ((dir: string) => Gate[]) = null, // a function is asked once the merge is in, so it sees what was installed
  run?: (gate: Gate) => Promise<GateResult>, // where gates run (execution.ts); this machine by default
  after?: () => Promise<GateResult[]>, // more checks once the gates pass (the hidden tests)
): Promise<MergeResult> {
  await discardChanges(dir); // also ends a merge that a restart interrupted
  if (!(await isAncestor(dir, branch, "HEAD"))) {
    const merged = await merge(dir, branch, message);
    if (!merged.ok) return { outcome: "conflict", conflicts: merged.conflicts, results: [], findings: [conflictFinding(merged.conflicts)] };
  }
  const sha = await headSha(dir);
  const stat = await diffStat(dir, preMergeSha, sha);
  const installed = stat.files.filter((f) => MANIFEST.test(f.path)).map((f) => path.join(dir, path.posix.dirname(f.path), "node_modules"));
  const uninstall = () => installed.forEach((d) => rmSync(d, { recursive: true, force: true, maxRetries: 3 }));
  uninstall();
  const list = typeof gates === "function" ? gates(dir) : (gates ?? detectGates(dir));
  const gated = await runGates(dir, list, run);
  const results = gated.ok && after ? [...gated.results, ...(await after())] : gated.results;
  const ok = results.every((r) => r.ok);
  await discardChanges(dir); // what the gates left behind (build output)
  if (!ok) {
    await resetHard(dir, preMergeSha);
    uninstall(); // installed for the merge that's gone; the next merge installs from the reset manifest
    return { outcome: "reverted", sha, results, findings: integrationFindings(results) };
  }
  return { outcome: "merged", sha, files: stat.files.length, linesChanged: stat.linesChanged, results };
}
