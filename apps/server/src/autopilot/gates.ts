// The checks the factory runs itself on a builder's work, never trusting the
// agent's word that tests pass: install where needed, then typecheck, lint
// and test for every npm package at the worktree root and one folder down.
// Each gate is a shell command with a timeout; the output kept is its tail.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { OUTPUT_LIMIT, type Finding } from "./ledger.js";

/** One gate, as policy.yml's `gates` list gives it. `cwd` is relative to the worktree. */
export interface Gate {
  name: string;
  run: string;
  cwd?: string;
  timeoutSec?: number;
}

export interface GateResult {
  name: string;
  run: string;
  ok: boolean;
  exitCode: number | null; // null when it timed out or couldn't start
  durationMs: number;
  output: string; // the tail, at most OUTPUT_LIMIT chars
  timedOut: boolean;
}

export const NO_GATES = "No gates: add a test script (package.json) or list gates in .factory/policy.yml";
const DEFAULT_TIMEOUT_SEC = 600;
const CLOSE_GRACE_MS = 3000; // after the gate exits or is killed, for the rest of its output
const FINDING_OUTPUT = 3000; // of a failed gate's output, in the builder's repair message
const SCRIPTS = ["typecheck", "lint", "test"];

/** The gates for one package.json in `sub` ("" = the root): install if needed, then its scripts. */
function packageGates(root: string, sub: string): Gate[] {
  const dir = path.join(root, sub);
  let pkg: { scripts?: Record<string, unknown>; dependencies?: object; devDependencies?: object };
  try {
    pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
  } catch {
    return [];
  }
  const scripts = SCRIPTS.filter((s) => typeof pkg.scripts?.[s] === "string");
  if (!scripts.length) return []; // nothing to check, so nothing to install for
  const name = (n: string) => (sub ? `${sub}:${n}` : n);
  const cwd = sub || undefined;
  const hasDeps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).length > 0;
  const locked = existsSync(path.join(dir, "package-lock.json")) || existsSync(path.join(dir, "npm-shrinkwrap.json"));
  const install: Gate[] =
    hasDeps && !existsSync(path.join(dir, "node_modules"))
      ? [{ name: name("install"), run: `npm ${locked ? "ci" : "install"} --no-audit --no-fund`, cwd }]
      : [];
  return [...install, ...scripts.map((s) => ({ name: name(s), run: `npm run ${s}`, cwd }))];
}

/** npm gates for the package.json at `dir` and one folder down (not node_modules or dot folders). */
export function detectGates(dir: string): Gate[] {
  const subs = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== "node_modules" && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort();
  return ["", ...subs].flatMap((sub) => packageGates(dir, sub));
}

/** Kills the gate and everything it started (a shell's children keep the output pipe open otherwise). */
function killTree(child: ChildProcess) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }).on("error", () => undefined);
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL"); // the gate's process group (it was started detached)
  } catch {
    child.kill("SIGKILL");
  }
}

/** Runs one gate on this machine, in `dir` (or its cwd under it), with `base` as its environment. */
export function runGate(dir: string, gate: Gate, base: NodeJS.ProcessEnv = process.env): Promise<GateResult> {
  const started = Date.now();
  const timeoutSec = gate.timeoutSec ?? DEFAULT_TIMEOUT_SEC;
  // Plain, non-interactive output. NODE_TEST_CONTEXT is dropped so `node --test` in a gate
  // reports normally when the factory itself runs under node --test.
  const { NODE_TEST_CONTEXT: _, ...env } = base;
  return new Promise((resolve) => {
    let output = "";
    let timedOut = false;
    const add = (text: string) => (output = (output + text).slice(-OUTPUT_LIMIT));
    const child = spawn(gate.run, {
      cwd: gate.cwd ? path.join(dir, gate.cwd) : dir,
      shell: true,
      env: { ...env, CI: "1", NO_COLOR: "1", FORCE_COLOR: "0" },
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    child.stdout?.setEncoding("utf8").on("data", add);
    child.stderr?.setEncoding("utf8").on("data", add);
    let done = false;
    let grace: NodeJS.Timeout | undefined;
    // A process the gate left behind (a test's detached server) can hold the output pipe open
    // after the gate exits or is killed, so "close" may never come: stop waiting for it soon after.
    const finishSoon = (exitCode: number | null, ms: number) => {
      grace ??= setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(exitCode);
      }, ms);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
      finishSoon(null, CLOSE_GRACE_MS);
    }, timeoutSec * 1000);
    const finish = (exitCode: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(grace);
      if (timedOut) add(`\n[Stopped: still running after ${timeoutSec} s]`);
      resolve({ name: gate.name, run: gate.run, ok: !timedOut && exitCode === 0, exitCode: timedOut ? null : exitCode, durationMs: Date.now() - started, output, timedOut });
    };
    child.on("error", (err) => {
      add(`\n${err.message}`);
      finish(null);
    });
    child.on("exit", (code) => finishSoon(code, CLOSE_GRACE_MS));
    child.on("close", (code) => finish(code));
  });
}

/**
 * Runs the gates one after another in `dir`, on this machine unless `run`
 * says otherwise (a container, execution.ts). A failing install stops the
 * rest, since nothing after it can pass. No gates at all is a failure too.
 */
export async function runGates(
  dir: string,
  gates: Gate[],
  run: (gate: Gate) => Promise<GateResult> = (gate) => runGate(dir, gate),
): Promise<{ ok: boolean; results: GateResult[] }> {
  if (!gates.length) {
    return { ok: false, results: [{ name: "gates", run: "", ok: false, exitCode: null, durationMs: 0, output: NO_GATES, timedOut: false }] };
  }
  const results: GateResult[] = [];
  for (const gate of gates) {
    const result = await run(gate);
    results.push(result);
    if (!result.ok && /(^|:)install$/.test(gate.name)) break;
  }
  return { ok: results.every((r) => r.ok), results };
}

/** One finding per failed gate, with the end of its output for the builder. */
export function gateFindings(results: GateResult[]): Finding[] {
  return results
    .filter((r) => !r.ok)
    .map((r) => {
      const how = r.timedOut ? "timed out" : r.exitCode === null ? "couldn't start" : `failed with exit code ${r.exitCode}`;
      return r.run
        ? { source: "gate", severity: "high", title: `Gate ${r.name}: \`${r.run}\` ${how}`, detail: r.output.slice(-FINDING_OUTPUT) }
        : { source: "gate", severity: "high", title: r.output, detail: "" }; // no gates at all
    });
}
