import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { Attempt } from "../src/autopilot/ledger.js";
import type { Policy } from "../src/autopilot/policy.js";

const root = mkdtempSync(path.join(tmpdir(), "sf-exec-"));
process.env.SF_DATA_DIR = path.join(root, "data");
delete process.env.SF_REQUIRE_ISOLATION;
const { createExecution, dockerPath, mountArg, RuntimeGone, RuntimeUnavailable, sweepContainers } = await import("../src/autopilot/execution.js");
const { DEFAULT_POLICY, parsePolicy } = await import("../src/autopilot/policy.js");
const { OpenHandsClient } = await import("../src/autopilot/openhands.js");
const { createFakeDocker } = await import("./fake-docker.js");
const { startFakeOpenHands } = await import("./fake-openhands.js");

const IMAGE = `ghcr.io/openhands/agent-server@sha256:${"a".repeat(64)}`;
const SECRET = "sk-test-not-for-argv";

function containerPolicy(patch: Partial<Policy["execution"]["container"]> = {}): Policy {
  const p = structuredClone(DEFAULT_POLICY);
  p.execution.provider = "container";
  Object.assign(p.execution.container, { image: IMAGE, network: "sf-agents", ...patch });
  return p;
}

const attempt = (id: number, patch: Partial<Attempt> = {}) =>
  ({ id, runId: "ap-0000feed", workOrderId: null, role: "builder", conversationId: `conv-${id}`, agentProfile: "p", state: "starting", turns: 1, seenRunning: false, lastSentAt: "", costUsd: 0, result: null, runtime: null, startedAt: "", finishedAt: null, ...patch }) as Attempt;

test("dockerPath and mountArg: this machine's paths reach Docker intact; network paths are refused", () => {
  assert.equal(dockerPath("C:\\Users\\a b\\wo-1", "native"), "C:\\Users\\a b\\wo-1");
  assert.equal(dockerPath("C:\\Users\\a b\\wo-1", "wsl"), "/mnt/c/Users/a b/wo-1");
  assert.equal(dockerPath("D:\\", "wsl"), "/mnt/d");
  assert.equal(dockerPath("/home/u/wo-1", "wsl"), "/home/u/wo-1");
  assert.throws(() => dockerPath("\\\\server\\share\\wo-1", "native"), /network path/);
  assert.throws(() => dockerPath("//server/share", "wsl"), /network path/);
  assert.equal(mountArg("C:\\x", "/w", true), "type=bind,source=C:\\x,target=/w,readonly");
  // Docker reads --mount as CSV: a comma or quote in a path must be quoted.
  assert.equal(mountArg("C:\\a,b\\c", "/workspace"), 'type=bind,"source=C:\\a,b\\c",target=/workspace');
  assert.equal(mountArg('C:\\a"b', "/workspace"), 'type=bind,"source=C:\\a""b",target=/workspace');
});

test("policy: container execution needs a digest-pinned image and a network; host networking and the factory's variables are refused", () => {
  assert.throws(() => parsePolicy("execution: { provider: container }"), /image is required/);
  assert.throws(() => parsePolicy("execution:\n  provider: container\n  container: { image: 'node:24', network: sf }"), /pinned by digest/);
  const base = `execution:\n  provider: container\n  container:\n    image: '${IMAGE}'\n`;
  assert.throws(() => parsePolicy(`${base}    network: host\n`), /can't be host/);
  assert.throws(() => parsePolicy(base), /network is required/);
  assert.throws(() => parsePolicy(`${base}    network: sf\n    credentials: { builder: [SF_AGENT_SERVER_KEY] }\n`), /can't pass SF_AGENT_SERVER_KEY/);
  assert.throws(() => parsePolicy(`${base}    network: sf\n    credentials: { builder: [api_key] }\n`), /environment variable name/);
  assert.throws(() => parsePolicy(`${base}    network: sf\n    memory: 4\n`), /size with a unit/);
  const p = parsePolicy(`${base}    network: sf-agents\n    credentials: { builder: [ANTHROPIC_API_KEY] }\n`);
  assert.deepEqual(p.execution.container.credentials, { spec: [], critic: [], builder: ["ANTHROPIC_API_KEY"], reviewer: [], validator: [] });
  assert.equal(p.execution.container.memory, "4g");
});

test("local execution says it isn't isolated, and SF_REQUIRE_ISOLATION refuses it", async () => {
  const host = new OpenHandsClient({ baseUrl: "http://127.0.0.1:1" });
  const local = createExecution(DEFAULT_POLICY, { dataDir: root, hostClient: host });
  const p = await local.preflight();
  assert.equal(p.ok, true);
  assert.deepEqual(p.facts, { provider: "local", isolated: false });
  assert.match(p.notes.join(" "), /on this machine/);
  process.env.SF_REQUIRE_ISOLATION = "1";
  try {
    const refused = await local.preflight();
    assert.equal(refused.ok, false);
    assert.match(refused.problems[0] ?? "", /requires isolated execution/);
    await assert.rejects(local.prepare(attempt(1), root, { id: "p", name: "p", kind: "acp", server: null }), /requires isolated execution/);
  } finally {
    delete process.env.SF_REQUIRE_ISOLATION;
  }
});

test("container preflight lists what stops isolated execution, and passes once Docker can give it", async () => {
  const fake = createFakeDocker();
  const host = new OpenHandsClient({ baseUrl: "http://127.0.0.1:1" });
  const exec = (env: NodeJS.ProcessEnv = {}) =>
    createExecution(containerPolicy({ credentials: { ...DEFAULT_POLICY.execution.container.credentials, builder: ["ANTHROPIC_API_KEY"] } }), { dataDir: root, hostClient: host, docker: fake.docker, env, controlPorts: [4317] });
  fake.state.up = false;
  assert.deepEqual((await exec().preflight()).problems.map((p) => p.split(":")[0]), ["Docker isn't reachable"]);
  fake.state.up = true;
  const missing = await exec().preflight({ probe: true });
  assert.equal(missing.ok, false);
  assert.equal(missing.problems.length, 3, missing.problems.join("\n"));
  assert.match(missing.problems.join("\n"), /isn't on this machine[\s\S]*network sf-agents doesn't exist[\s\S]*credential ANTHROPIC_API_KEY isn't set/);
  assert.equal(fake.callsOf("run").length, 0, "no probe container while something basic is missing");

  fake.state.images.add(IMAGE);
  fake.state.networks.add("sf-agents");
  fake.state.reachable = true;
  const exposed = await exec({ ANTHROPIC_API_KEY: SECRET }).preflight({ probe: true });
  assert.deepEqual(exposed.problems.length, 1);
  assert.match(exposed.problems[0] ?? "", /can reach port 4317 on this machine/);

  fake.state.reachable = undefined; // the image has no python3
  const good = await exec({ ANTHROPIC_API_KEY: SECRET }).preflight({ probe: true });
  assert.equal(good.ok, true, good.problems.join("\n"));
  assert.match(good.notes.join(" "), /Couldn't check whether containers reach port 4317/);
  assert.match(good.facts.imageId ?? "", /^sha256:/);
  assert.deepEqual(good.facts.credentials, ["ANTHROPIC_API_KEY"]);
  assert.deepEqual(good.facts.limits, { memory: "4g", cpus: 2, pids: 512 });
  // The mount probe read the token the factory wrote, through the same path mapping.
  const cat = fake.state.calls.find((c) => c.args.includes("cat"))!;
  assert.ok(cat.args.some((a) => a.includes("target=/probe") && a.endsWith("readonly")));
  assert.ok(!JSON.stringify(fake.state.calls.map((c) => c.args)).includes(SECRET), "a credential value never reaches argv");
  await fake.close();
});

test("a container attempt: hardened docker run, credentials by name only, the profile copied in, reconnects after a restart, removed on release", async () => {
  const host = await startFakeOpenHands({ profiles: [{ id: "host-profile", name: "claude", agent_kind: "acp", acp_server: "claude-code" }] });
  const fake = createFakeDocker({ images: [IMAGE], networks: ["sf-agents"] });
  const dataDir = mkdtempSync(path.join(root, "case-"));
  const worktree = path.join(dataDir, "worktrees", "wo 1"); // a space in the path, as on many Windows profiles
  mkdirSync(worktree, { recursive: true });
  writeFileSync(path.join(worktree, ".git"), "gitdir: C:/somewhere/.git/worktrees/wo-1\n");
  const policy = containerPolicy({ credentials: { ...DEFAULT_POLICY.execution.container.credentials, builder: ["ANTHROPIC_API_KEY"] } });
  const deps = { dataDir, hostClient: new OpenHandsClient({ baseUrl: host.url }), docker: fake.docker, env: { ANTHROPIC_API_KEY: SECRET } };
  try {
    const a = attempt(7);
    const ready = await createExecution(policy, deps).prepare(a, worktree, { id: "host-profile", name: "claude", kind: "acp", server: "claude-code" });
    assert.equal(ready.workingDir, "/workspace");
    assert.equal(ready.facts.container, "sf-ap-0000feed-a7");
    assert.deepEqual(ready.facts.credentials, ["ANTHROPIC_API_KEY"]);
    const [started] = fake.callsOf("run", "-d");
    const args = started!.args;
    for (const flag of [["--cap-drop", "ALL"], ["--security-opt", "no-new-privileges"], ["--memory", "4g"], ["--pids-limit", "512"], ["--network", "sf-agents"], ["-p", "127.0.0.1::8000"], ["-e", "ANTHROPIC_API_KEY"]]) {
      assert.ok(args.some((x, i) => x === flag[0] && args[i + 1] === flag[1]), `docker run has ${flag.join(" ")}`);
    }
    const mounts = args.filter((_, i) => args[i - 1] === "--mount");
    assert.deepEqual(mounts.map((m) => /target=([^,]+)/.exec(m)?.[1]), ["/workspace", "/workspace/.git", "/var/openhands", "/factory"]);
    assert.ok(mounts[1]!.endsWith(",readonly") && mounts[3]!.endsWith(",readonly"), "the .git shadow and the inputs are read-only");
    assert.ok(!JSON.stringify(args).includes(SECRET), "the credential's value isn't in argv");
    assert.equal(started!.env?.ANTHROPIC_API_KEY, SECRET, "it reaches the Docker CLI's environment instead");
    assert.ok(started!.env?.OH_SESSION_API_KEYS_0, "the container's agent server gets a session key");

    // The container's agent server has the host profile under its own id, and takes a conversation on /workspace.
    const box = fake.state.containers.get("sf-ap-0000feed-a7")!;
    assert.notEqual(ready.profileId, "host-profile");
    await ready.client.start({ conversationId: "conv-7", profileId: ready.profileId, workingDir: ready.workingDir, text: "Build it", runId: a.runId, role: "builder" });
    assert.equal(box.server!.conversations.get("conv-7")?.hostDir, worktree);

    // A new factory process recomputes the session key and finds the container by name.
    const after = createExecution(policy, deps);
    const recorded = attempt(7, { runtime: ready.facts, state: "running" });
    assert.equal((await (await after.clientFor(recorded)).get("conv-7"))?.id, "conv-7");
    fake.state.up = false;
    await assert.rejects(after.clientFor(recorded), RuntimeUnavailable);
    fake.state.up = true;
    await after.release(recorded);
    await assert.rejects(after.clientFor(recorded), RuntimeGone);

    // Orphans of this data folder go; what's kept stays.
    await createExecution(policy, deps).prepare(attempt(8), worktree, { id: "host-profile", name: "claude", kind: "acp", server: "claude-code" });
    await createExecution(policy, deps).prepare(attempt(9), worktree, { id: "host-profile", name: "claude", kind: "acp", server: "claude-code" });
    assert.deepEqual(await sweepContainers(deps, new Set(["sf-ap-0000feed-a8"])), ["sf-ap-0000feed-a9"]);
    assert.deepEqual([...fake.state.containers.keys()], ["sf-ap-0000feed-a8"]);
  } finally {
    await fake.close();
    await host.close();
  }
});

test("gates in a container: no credentials, the gate network, stopped on a timeout; Docker failing to run one isn't the builder's failure", async () => {
  const fake = createFakeDocker({ images: [IMAGE], networks: ["sf-agents", "sf-gates"] });
  const dir = mkdtempSync(path.join(root, "gates-"));
  mkdirSync(path.join(dir, "pkg"));
  const policy = containerPolicy({ gateNetwork: "sf-gates", credentials: { ...DEFAULT_POLICY.execution.container.credentials, builder: ["ANTHROPIC_API_KEY"] } });
  const exec = createExecution(policy, { dataDir: root, hostClient: new OpenHandsClient({ baseUrl: "http://127.0.0.1:1" }), docker: fake.docker, env: { ANTHROPIC_API_KEY: SECRET } });
  const gate = exec.gateRunner(dir, "ap-0000feed");
  try {
    const failed = await gate({ name: "pkg:test", run: 'node -e "process.exit(3)"', cwd: "pkg" });
    assert.equal(failed.ok, false);
    assert.equal(failed.exitCode, 3);
    const [call] = fake.callsOf("run", "--rm");
    const args = call!.args;
    assert.ok(args.some((x, i) => x === "--network" && args[i + 1] === "sf-gates"));
    assert.ok(args.some((x, i) => x === "-w" && args[i + 1] === "/workspace/pkg"));
    assert.deepEqual(args.slice(-5), ["--entrypoint", "sh", IMAGE, "-c", 'node -e "process.exit(3)"']);
    assert.ok(!args.includes("ANTHROPIC_API_KEY") && call!.env === undefined, "gates get no credentials");

    const slow = await gate({ name: "slow", run: 'node -e "setTimeout(() => {}, 20000)"', timeoutSec: 1 });
    assert.equal(slow.timedOut, true);
    assert.equal(slow.ok, false);
    assert.match(slow.output, /Stopped: still running after 1 s/);
    const name = fake.callsOf("run", "--rm").at(-1)!.args[3]!;
    assert.ok(fake.callsOf("rm", "-f").some((c) => c.args.includes(name)), "the timed-out gate's container is removed");

    fake.state.images.delete(IMAGE);
    await assert.rejects(gate({ name: "test", run: "npm test" }), /Docker couldn't run gate test/);
    fake.state.up = false;
    await assert.rejects(gate({ name: "test", run: "npm test" }), RuntimeUnavailable);
  } finally {
    await fake.close();
  }
});
