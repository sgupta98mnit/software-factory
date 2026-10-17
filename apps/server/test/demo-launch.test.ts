// `pnpm demo`: the sample workspace it makes, and a real launch (without Canvas).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.SF_DATA_DIR = mkdtempSync(path.join(tmpdir(), "sf-demo-launch-data-"));
const { loadPolicy } = await import("../src/autopilot/policy.js");
const { currentBranch, isClean } = await import("../src/autopilot/git.js");
const { freePort } = await import("../src/autopilot/preview.js");
const script = path.resolve(import.meta.dirname, "../../../scripts/demo.mjs");
const { prepareDemo } = (await import(script)) as { prepareDemo: (dir: string, opts?: { reset?: boolean }) => { workspace: string; data: string } };

test("prepareDemo: a git repo on main with the demo's policy committed (hidden tests and preview on); made once, made again on reset", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sf-demo-prep-"));
  const { workspace, data } = prepareDemo(dir);
  assert.equal(await currentBranch(workspace), "main");
  assert.equal(await isClean(workspace), true);
  assert.ok(existsSync(data));
  const { policy, source } = await loadPolicy(workspace, "main");
  assert.equal(source, ".factory/policy.yml@main");
  assert.equal(policy.hiddenTests.enabled, true);
  assert.deepEqual([policy.preview.enabled, policy.preview.start, policy.preview.paths], [true, "node server.cjs", ["/", "/status"]]);
  writeFileSync(path.join(workspace, "mine.txt"), "kept\n");
  prepareDemo(dir);
  assert.ok(existsSync(path.join(workspace, "mine.txt")), "an existing demo workspace is left alone");
  prepareDemo(dir, { reset: true });
  assert.equal(existsSync(path.join(workspace, "mine.txt")), false);
});

test("pnpm demo --no-canvas starts the scripted agents and the API on the demo workspace; a run starts; Ctrl+C stops both", { skip: process.platform === "win32", timeout: 90_000 }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sf-demo-run-"));
  const [apiPort, agentsPort] = [await freePort(), await freePort()];
  const child = spawn(process.execPath, [script, "--no-canvas"], {
    env: { ...process.env, SF_DEMO_DIR: dir, SF_DEMO_API_PORT: String(apiPort), SF_DEMO_AGENTS_PORT: String(agentsPort), SF_FAKE_AGENT_TURN_MS: "0", NODE_TEST_CONTEXT: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));
  const api = `http://127.0.0.1:${apiPort}/sf-api`;
  try {
    let status: { agentServer: { reachable: boolean }; policy: { source: string } } | null = null;
    for (let i = 0; i < 120 && !status?.agentServer.reachable; i++) {
      status = await fetch(`${api}/autopilot/status`).then((r) => (r.ok ? (r.json() as never) : null), () => null);
      if (!status?.agentServer.reachable) await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert.ok(status?.agentServer.reachable, `the demo didn't come up:\n${output}`);
    assert.equal(status.policy.source, ".factory/policy.yml@main");
    assert.match(output, /Software Factory demo \(scripted agents: no model, no network\)/);
    const created = await fetch(`${api}/autopilot/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ goal: "Let applicants check a claim's status" }) });
    const run = (await created.json()) as { state: string; change: string };
    assert.deepEqual([created.status, run.state], [200, "spec"]);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const still = await fetch(`${api}/autopilot/status`).then(() => true, () => false);
  assert.equal(still, false, "the API stopped with the demo");
});
