// Hidden acceptance tests: a validator agent turns each spec scenario into a
// black-box test before any code is written, in the factory's data folder
// (data/hidden-tests/<runId>/tests), outside every worktree. Builders never
// see them; the factory copies the ones a work order can satisfy into its
// worktree only for the length of the run, then deletes them.
//
// Each test file starts with a header the factory reads:
//
//   // scenario: Unknown claim
//   // requirement: Look up a claim by number
//   // requires: WO-2, WO-3
//
// A test runs for a work order once everything it requires is that work
// order or already merged. A failing test reaches the builder by scenario
// name and first assertion line only; its source and full output are for
// people. The factory hashes every file when the validator finishes, so a
// test that changes afterwards (weakened, or edited by an agent that found
// the folder) is refused instead of run.
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { runGates, type GateResult } from "./gates.js";
import type { Finding } from "./ledger.js";

export const HIDDEN_DIR = ".factory-hidden"; // inside a worktree, only while the factory runs them

export interface HiddenTest {
  file: string; // relative to the tests folder, posix
  scenario: string;
  requirement: string | null;
  requires: number[]; // work-order seqs
  sha256: string;
}

const TEST_FILE = /\.test\.(?:m?js|cjs|ts|mts)$/;

/** The header of one test file. Without a scenario it isn't a hidden test. */
export function parseHeader(text: string): Pick<HiddenTest, "scenario" | "requirement" | "requires"> | null {
  const head = text.split(/\r?\n/).slice(0, 20).join("\n");
  const field = (name: string) => new RegExp(`^\\s*//\\s*${name}\\s*:\\s*(.+?)\\s*$`, "im").exec(head)?.[1] ?? null;
  const scenario = field("scenario");
  if (!scenario) return null;
  const requires = [...(field("requires") ?? "").matchAll(/(\d+)/g)].map((m) => Number(m[1]));
  return { scenario, requirement: field("requirement"), requires: [...new Set(requires)].sort((a, b) => a - b) };
}

const sha = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");

/** Every hidden test in `testsDir` (one folder level deep), sorted by file. */
export function listHiddenTests(testsDir: string): HiddenTest[] {
  if (!existsSync(testsDir)) return [];
  const out: HiddenTest[] = [];
  for (const entry of readdirSync(testsDir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !TEST_FILE.test(entry.name)) continue;
    const full = path.join(entry.parentPath, entry.name);
    const text = readFileSync(full, "utf8");
    const header = parseHeader(text);
    if (header) out.push({ file: path.relative(testsDir, full).replaceAll("\\", "/"), ...header, sha256: sha(text) });
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

/** The tests a work order can be held to: everything they require is `seq` or merged. */
export function testsFor(tests: HiddenTest[], seq: number, merged: Set<number>): HiddenTest[] {
  return tests.filter((t) => t.requires.length > 0 && t.requires.includes(seq) && t.requires.every((r) => r === seq || merged.has(r)));
}

/** The tests the integration branch can be held to once `seq` merges into it. */
export function testsAfterMerge(tests: HiddenTest[], seq: number, merged: Set<number>): HiddenTest[] {
  const all = new Set([...merged, seq]);
  return tests.filter((t) => t.requires.length > 0 && t.requires.every((r) => all.has(r)));
}

/** The first line that says what went wrong, from a failed test's output. */
export function firstAssertion(output: string): string {
  const lines = output.split(/\r?\n/).map((l) => l.trim());
  const hit =
    lines.find((l) => /^(?:AssertionError|Error|TypeError|ReferenceError)\b/.test(l)) ??
    lines.find((l) => /expected|actual|!==|===/i.test(l)) ??
    lines.find((l) => l.startsWith("✖") && !/failing tests/.test(l));
  return (hit ?? "it failed").replace(/\s+/g, " ").slice(0, 200);
}

export interface HiddenResult {
  test: HiddenTest;
  result: GateResult;
}

/**
 * Runs `tests` from `testsDir` in the worktree `dir`, one process per file
 * (`run` + the file), then removes them. Files whose hash no longer matches
 * the manifest aren't run: they fail as tampered.
 */
export async function runHiddenTests(
  dir: string,
  testsDir: string,
  tests: HiddenTest[],
  run: string,
  manifest: Map<string, string>,
  signal?: AbortSignal,
): Promise<HiddenResult[]> {
  const target = path.join(dir, HIDDEN_DIR);
  const results: HiddenResult[] = [];
  try {
    for (const t of tests) {
      if (signal?.aborted) break;
      const source = path.join(testsDir, t.file);
      const now = existsSync(source) ? sha(readFileSync(source)) : null;
      if (now !== manifest.get(t.file)) {
        const output = `The hidden test ${t.file} changed after the validator finished (or is gone), so it wasn't run.`;
        results.push({ test: t, result: { name: `hidden:${t.file}`, run, ok: false, exitCode: null, durationMs: 0, output, timedOut: false } });
        continue;
      }
      const copy = path.join(target, t.file);
      mkdirSync(path.dirname(copy), { recursive: true });
      cpSync(source, copy);
      const file = `${HIDDEN_DIR}/${t.file}`;
      const { results: [result] } = await runGates(dir, [{ name: `hidden:${t.file}`, run: `${run} ${JSON.stringify(file)}`, timeoutSec: 300 }], { signal });
      if (result) results.push({ test: t, result });
    }
  } finally {
    rmSync(target, { recursive: true, force: true, maxRetries: 3 });
  }
  return results;
}

/** One finding per failed hidden test, by scenario: what the builder may know. */
export function hiddenFindings(results: HiddenResult[], where: "work order" | "integration"): Finding[] {
  return results
    .filter((r) => !r.result.ok)
    .map((r) => ({
      source: "hidden" as const,
      severity: "high" as const,
      title: `${where === "integration" ? "After merging into the integration branch, a" : "A"} hidden acceptance test fails: ${firstAssertion(r.result.output)}`,
      detail: r.result.output, // for people; clusterFindings leaves it out of repair messages
      scenario: r.test.scenario,
    }));
}
