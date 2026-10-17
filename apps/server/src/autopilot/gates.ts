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
  /** Failed, then passed when run again (runGates' rerunFailed). */
  flaky?: boolean;
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

/** Gates running right now, so shutdown can stop them (their process groups outlive the factory otherwise). */
const running = new Set<ChildProcess>();

/** Stops every gate still running: for the factory's shutdown. */
export function killAllGates() {
  for (const child of running) killTree(child);
}

/**
 * The environment a gate runs with: the factory's, minus anything that looks
 * like a credential. Gates run code agents wrote (tests, install scripts), so
 * they never see the agent server's key or other secrets. SF_GATE_ENV lists
 * names to pass through anyway (comma-separated), for a build that truly needs one.
 */
export function gateEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const keep = new Set((env.SF_GATE_ENV ?? "").split(",").map((n) => n.trim()).filter(Boolean));
  const secret = /KEY|TOKEN|SECRET|PASSW|CREDENTIAL|COOKIE/i;
  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (name === "NODE_TEST_CONTEXT") continue; // so `node --test` in a gate reports normally under the factory's own tests
    if (!keep.has(name) && (name.startsWith("SF_") || name.startsWith("LOCAL_BACKEND_") || secret.test(name))) continue;
    out[name] = value;
  }
  return { ...out, CI: "1", NO_COLOR: "1", FORCE_COLOR: "0" };
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

/**
 * A long-running command (the app, for a preview) started like a gate: the
 * scrubbed environment plus `env`, its own process group, and on the list
 * shutdown kills. `stop()` kills it and everything it started.
 */
export function startService(dir: string, command: string, env: Record<string, string>) {
  let output = "";
  let exited: number | null | undefined;
  const child = spawn(command, { cwd: dir, shell: true, env: { ...gateEnv(), ...env }, windowsHide: true, detached: process.platform !== "win32" });
  running.add(child);
  const add = (text: string) => (output = (output + text).slice(-OUTPUT_LIMIT));
  child.stdout?.setEncoding("utf8").on("data", add);
  child.stderr?.setEncoding("utf8").on("data", add);
  child.on("error", (err) => add(`\n${err.message}`));
  child.on("exit", (code) => (exited = code));
  return {
    output: () => output,
    /** The exit code once it has exited on its own (undefined while it runs). */
    exited: () => exited,
    stop() {
      killTree(child);
      running.delete(child);
      child.stdout?.destroy();
      child.stderr?.destroy();
    },
  };
}

function runGate(dir: string, gate: Gate, signal?: AbortSignal): Promise<GateResult> {
  const started = Date.now();
  const timeoutSec = gate.timeoutSec ?? DEFAULT_TIMEOUT_SEC;
  return new Promise((resolve) => {
    let output = "";
    let timedOut = false;
    const add = (text: string) => (output = (output + text).slice(-OUTPUT_LIMIT));
    const child = spawn(gate.run, {
      cwd: gate.cwd ? path.join(dir, gate.cwd) : dir,
      shell: true,
      env: gateEnv(),
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    running.add(child);
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
    // Stopped from outside (the run was paused or cancelled): kill it now; the caller ignores the result.
    const abort = () => {
      killTree(child);
      finishSoon(null, 500);
    };
    signal?.addEventListener("abort", abort, { once: true });
    const finish = (exitCode: number | null) => {
      if (done) return;
      done = true;
      running.delete(child);
      clearTimeout(timer);
      clearTimeout(grace);
      signal?.removeEventListener("abort", abort);
      if (timedOut) add(`\n[Stopped: still running after ${timeoutSec} s]`);
      resolve({ name: gate.name, run: gate.run, ok: !timedOut && exitCode === 0, exitCode: timedOut ? null : exitCode, durationMs: Date.now() - started, output, timedOut });
    };
    child.on("error", (err) => {
      add(`\n${err.message}`);
      finish(null);
    });
    child.on("exit", (code) => {
      // Whatever the gate left running in the background (a test's server, `sleep &`) goes with it.
      killTree(child);
      finishSoon(code, CLOSE_GRACE_MS);
    });
    child.on("close", (code) => finish(code));
  });
}

export interface GatesOutcome {
  ok: boolean;
  results: GateResult[];
  /** Stopped by the signal: the results say nothing about the work, so nobody should record them. */
  aborted: boolean;
}

const INSTALL = /(^|:)install$/;

/** One gate's two runs as one result: the second decides, and the output says what happened. */
function ranAgain(first: GateResult, second: GateResult): GateResult {
  const how = first.exitCode === null ? "couldn't start" : `exit code ${first.exitCode}`;
  const note = second.ok
    ? `\n[Flaky: it failed the first time (${how}) and passed when run again. The first run ended with the output above the line.]`
    : "\n[Run again once in case it was flaky: it failed both times.]";
  const body = second.ok ? `${first.output.slice(-1500)}\n${"-".repeat(40)}\n${second.output}` : second.output;
  return { ...second, durationMs: first.durationMs + second.durationMs, output: `${body.slice(-(OUTPUT_LIMIT - note.length))}${note}`, ...(second.ok ? { flaky: true } : {}) };
}

/**
 * Runs the gates one after another in `dir`. A failing install stops the
 * rest, since nothing after it can pass. No gates at all is a failure too.
 * `signal` stops the gate that's running and the rest. With `rerunFailed`,
 * a gate that fails (not an install, not a timeout) runs once more: a pass
 * then counts, marked flaky, so a flaky test costs a minute, not a repair.
 */
export async function runGates(dir: string, gates: Gate[], opts: { signal?: AbortSignal; rerunFailed?: boolean } = {}): Promise<GatesOutcome> {
  if (!gates.length) {
    return { ok: false, aborted: false, results: [{ name: "gates", run: "", ok: false, exitCode: null, durationMs: 0, output: NO_GATES, timedOut: false }] };
  }
  const results: GateResult[] = [];
  for (const gate of gates) {
    if (opts.signal?.aborted) break;
    let result = await runGate(dir, gate, opts.signal);
    if (!result.ok && opts.rerunFailed && !result.timedOut && !INSTALL.test(gate.name) && !opts.signal?.aborted) {
      result = ranAgain(result, await runGate(dir, gate, opts.signal));
    }
    results.push(result);
    if (!result.ok && INSTALL.test(gate.name)) break;
  }
  const aborted = !!opts.signal?.aborted;
  return { ok: !aborted && results.every((r) => r.ok), results, aborted };
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
