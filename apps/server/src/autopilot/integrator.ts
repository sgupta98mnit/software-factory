// The integrate stage's git side: merge one work order's branch into the
// run's integration worktree and run the gates again on the combined code.
// The orchestrator merges one work order at a time, so each merge is tested
// on top of everything merged before it. A merge whose gates fail is undone
// with a reset to the sha before it: the integration branch is local and
// unpublished, and a `git revert` of the merge would stop the same commits
// from merging again once the builder has fixed them.
import { rmSync } from "node:fs";
import path from "node:path";
import { detectGates, gateFindings, runGates, type Gate, type GateResult, type GatesOutcome } from "./gates.js";
import { diffStat, discardChanges, headSha, isAncestor, merge, resetHard } from "./git.js";
import type { Finding } from "./ledger.js";

export type MergeResult =
  | { outcome: "merged"; sha: string; files: number; linesChanged: number; results: GateResult[] }
  | { outcome: "conflict"; conflicts: string[]; results: GateResult[]; findings: Finding[] }
  | { outcome: "reverted"; results: GateResult[]; findings: Finding[] };

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

export type Prepared =
  | { outcome: "conflict"; conflicts: string[]; results: GateResult[]; findings: Finding[] }
  | { outcome: "ready"; sha: string; files: number; linesChanged: number; installed: string[] };

/**
 * The merge half: merges `branch` into the integration worktree `dir`, or
 * finds it already merged. `preMergeSha` is the integration sha before this
 * merge, which the caller has saved first, so this is safe to run again
 * after a restart: a merge left half done is thrown away and made again, and
 * one already made is just reported. A conflict leaves `dir` as it was.
 * Installed packages for manifests the merge changed are removed, so the
 * gates install them fresh.
 */
export async function prepareMerge(dir: string, branch: string, message: string, preMergeSha: string): Promise<Prepared> {
  await discardChanges(dir); // also ends a merge that a restart interrupted
  if (!(await isAncestor(dir, branch, "HEAD"))) {
    const merged = await merge(dir, branch, message);
    if (!merged.ok) return { outcome: "conflict", conflicts: merged.conflicts, results: [], findings: [conflictFinding(merged.conflicts)] };
  }
  const sha = await headSha(dir);
  const stat = await diffStat(dir, preMergeSha, sha);
  const installed = stat.files.filter((f) => MANIFEST.test(f.path)).map((f) => path.join(dir, path.posix.dirname(f.path), "node_modules"));
  installed.forEach((d) => rmSync(d, { recursive: true, force: true, maxRetries: 3 }));
  return { outcome: "ready", sha, files: stat.files.length, linesChanged: stat.linesChanged, installed };
}

/**
 * The settle half, once the gates ran on the merged code: kept, or reset to
 * `preMergeSha` with the findings for the builder.
 */
export async function settleMerge(dir: string, prepared: Extract<Prepared, { outcome: "ready" }>, preMergeSha: string, gates: GatesOutcome): Promise<MergeResult> {
  await discardChanges(dir); // what the gates left behind (build output)
  if (!gates.ok) {
    await resetHard(dir, preMergeSha);
    // Installed for the merge that's gone; the next merge installs from the reset manifest.
    prepared.installed.forEach((d) => rmSync(d, { recursive: true, force: true, maxRetries: 3 }));
    return { outcome: "reverted", results: gates.results, findings: integrationFindings(gates.results) };
  }
  return { outcome: "merged", sha: prepared.sha, files: prepared.files, linesChanged: prepared.linesChanged, results: gates.results };
}

/** Both halves at once: merge, the gates (the policy's, or those detected once merged), then keep or reset. */
export async function mergeAndTest(dir: string, branch: string, message: string, preMergeSha: string, gates: Gate[] | null = null): Promise<MergeResult> {
  const prepared = await prepareMerge(dir, branch, message, preMergeSha);
  if (prepared.outcome === "conflict") return prepared;
  return settleMerge(dir, prepared, preMergeSha, await runGates(dir, gates ?? detectGates(dir)));
}
