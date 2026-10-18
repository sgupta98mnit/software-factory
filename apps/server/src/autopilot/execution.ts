// Where Autopilot's agents, and the gates that run the code they write,
// execute. "local": on this machine, through Canvas's agent server, with your
// permissions; nothing is isolated, and runs, attempts and evidence say so.
// "container": each attempt gets its own agent-server container, started by
// the factory with the lifecycle of the agent server's Docker runtime and the
// SDK's DockerWorkspace: only the attempt's worktree mounted, its .git file
// hidden (so nothing inside can point the factory's git somewhere else), the
// role's credentials, resource limits, the policy's network and a loopback
// port. Gates run in throwaway containers without credentials. What a policy
// asks for and can't get is refused; it never quietly runs locally instead.
import { execFile } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isolationRequired } from "../config.js";
import { runGate, type Gate, type GateResult } from "./gates.js";
import { OUTPUT_LIMIT, type Attempt, type AttemptRole } from "./ledger.js";
import { OpenHandsClient, type AgentProfile } from "./openhands.js";
import type { ContainerPolicy, Policy } from "./policy.js";

export type ExecutionKind = "local" | "container";

/** What an attempt actually ran with. Kept on the attempt and in evidence: no secrets, no host paths. */
export interface ExecutionFacts {
  provider: ExecutionKind;
  isolated: boolean;
  container?: string;
  image?: string;
  imageId?: string | null;
  network?: string;
  user?: string | null;
  limits?: { memory: string; cpus: number; pids: number };
  credentials?: string[]; // environment variable names, never values
  mounts?: string[]; // where things appear inside the container
  released?: boolean; // the container was removed
}

export interface Preflight {
  provider: ExecutionKind;
  isolated: boolean;
  required: boolean; // SF_REQUIRE_ISOLATION
  ok: boolean;
  problems: string[]; // each one refuses execution
  notes: string[]; // what couldn't be checked
  facts: ExecutionFacts;
  checkedAt: string;
}

/** The container engine can't be reached: leave everything as it is and try again later. */
export class RuntimeUnavailable extends Error {}
/** The attempt's container is gone, and its conversation with it. */
export class RuntimeGone extends Error {}

export interface DockerResult {
  code: number; // -1: the Docker CLI itself couldn't be started
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}
/** Runs the Docker CLI. `env` adds variables to its environment: that's how `-e NAME` gets a value without it showing in argv. */
export type DockerRunner = (args: string[], opts?: { env?: Record<string, string>; timeoutMs?: number }) => Promise<DockerResult>;

export const dockerCli = (command = process.env.SF_DOCKER || "docker"): DockerRunner => cliRunner(command);

/** Runs an external command without a shell (Docker, Trivy). `code` -1: it couldn't be started; 124: it timed out and was killed. */
export function cliRunner(command: string): DockerRunner {
  return (args, opts = {}) =>
    new Promise((resolve) => {
      execFile(
        command,
        args,
        { env: { ...process.env, ...opts.env }, timeout: opts.timeoutMs ?? 0, killSignal: "SIGKILL", windowsHide: true, maxBuffer: 50 * 1024 * 1024, encoding: "utf8" },
        (error, stdout, stderr) => {
          if (error && typeof error.code !== "number") {
            const timedOut = Boolean(error.killed);
            resolve({ code: timedOut ? 124 : -1, stdout: stdout ?? "", stderr: stderr || error.message, timedOut });
            return;
          }
          resolve({ code: typeof error?.code === "number" ? error.code : 0, stdout, stderr });
        },
      );
    });
}

/** How the Docker CLI spells a path on this machine. Docker Desktop takes Windows paths; a WSL engine wants /mnt/<drive>/…. */
export function dockerPath(hostPath: string, style: ContainerPolicy["hostPathStyle"]): string {
  if (/^[\\/]{2}/.test(hostPath)) throw new Error(`Docker can't mount a network path: ${hostPath}`);
  if (style === "native") return hostPath;
  const drive = /^([A-Za-z]):[\\/]?(.*)$/.exec(hostPath);
  return drive ? `/mnt/${drive[1]!.toLowerCase()}/${drive[2]!.replaceAll("\\", "/")}`.replace(/\/$/, "") : hostPath.replaceAll("\\", "/");
}

/** A --mount value. Docker reads it as CSV, so a field with a comma or quote is quoted. */
export function mountArg(source: string, target: string, readonly = false): string {
  const field = (f: string) => (/[",]/.test(f) ? `"${f.replaceAll('"', '""')}"` : f);
  return ["type=bind", field(`source=${source}`), field(`target=${target}`), ...(readonly ? ["readonly"] : [])].join(",");
}

const LABEL = "ai.software-factory";
const WORKDIR = "/workspace";
const MOUNTS = ["/workspace (work folder, read-write)", "/workspace/.git (hidden)", "/var/openhands (agent state)", "/factory (inputs, read-only)"];
const DEFAULT_GATE_TIMEOUT_SEC = 600;
const LOCAL: ExecutionFacts = { provider: "local", isolated: false };

const firstLine = (text: string) => text.trim().split(/\r?\n/)[0]?.slice(0, 300) ?? "";
/** The engine is down or the CLI is missing, rather than the command failing. */
const engineDown = (r: DockerResult) =>
  r.code === -1 || /cannot connect|error during connect|failed to connect|docker daemon (is not|isn't) running|is the docker daemon running/i.test(r.stderr);
const gone = (r: DockerResult) => /no such (object|container)/i.test(r.stderr);

/** A random key kept in the data folder; container session keys are derived from it, so none is stored. */
function runtimeSecret(dataDir: string): Buffer {
  const file = path.join(dataDir, "runtime.key");
  const read = () => Buffer.from(readFileSync(file, "utf8").trim(), "hex");
  try {
    return read();
  } catch {
    mkdirSync(dataDir, { recursive: true });
    try {
      writeFileSync(file, randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 });
    } catch {
      /* another process made it first */
    }
    return read();
  }
}

export interface Execution {
  readonly kind: ExecutionKind;
  preflight(opts?: { probe?: boolean }): Promise<Preflight>;
  /** Makes the attempt's agent runtime ready: the client to talk to, the folder as the agent sees it, and the profile id there. Safe to repeat. */
  prepare(a: Attempt, hostDir: string, profile: AgentProfile, inputs?: Record<string, string>): Promise<{ client: OpenHandsClient; workingDir: string; profileId: string; facts: ExecutionFacts }>;
  /** The client of an attempt prepared before, also after a restart. Throws RuntimeGone when its container is gone. */
  clientFor(a: Attempt): Promise<OpenHandsClient>;
  /** Removes the attempt's container. Its state folder (the transcript) stays. */
  release(a: Attempt): Promise<void>;
  /** Runs one gate on `dir`: on this machine, or in a throwaway container. */
  gateRunner(dir: string, runId: string): (gate: Gate) => Promise<GateResult>;
}

export interface ExecutionDeps {
  dataDir: string;
  hostClient: OpenHandsClient; // Canvas's agent server, where the agent profiles are
  docker?: DockerRunner;
  env?: NodeJS.ProcessEnv; // where credential values come from
  controlPorts?: number[]; // the factory API and Canvas on this machine, which agents must not reach
}

/** Labels mark a container as this factory's: the same data folder, the same owner. */
const ownerOf = (dataDir: string) => createHash("sha256").update(path.resolve(dataDir)).digest("hex").slice(0, 16);

/** Removes containers this factory owns whose names aren't in `keep`. Quiet when Docker isn't there. */
export async function sweepContainers(deps: Pick<ExecutionDeps, "dataDir" | "docker">, keep: Set<string>): Promise<string[]> {
  const docker = deps.docker ?? dockerCli();
  const r = await docker(["ps", "-a", "--filter", `label=${LABEL}.owner=${ownerOf(deps.dataDir)}`, "--format", "{{.Names}}"]);
  if (r.code !== 0) return [];
  const stale = r.stdout.split(/\r?\n/).map((s) => s.trim()).filter((n) => n && !keep.has(n));
  if (stale.length) await docker(["rm", "-f", ...stale]);
  return stale;
}

/** The provider the pinned policy asks for. */
export function createExecution(policy: Pick<Policy, "execution">, deps: ExecutionDeps): Execution {
  return policy.execution.provider === "container" ? containerExecution(policy.execution.container, deps) : localExecution(deps);
}

/** The factory's own settings stay out of the gates' environment. */
function gateEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^SF_/.test(k) && k !== "LOCAL_BACKEND_API_KEY"));
}

function localExecution(deps: ExecutionDeps): Execution {
  return {
    kind: "local",
    async preflight() {
      const required = isolationRequired();
      return {
        provider: "local",
        isolated: false,
        required,
        ok: !required,
        problems: required
          ? ["This factory requires isolated execution (SF_REQUIRE_ISOLATION), but the policy runs agents on this machine. Set execution.provider: container in .factory/policy.yml on the base branch."]
          : [],
        notes: ["Agents, their tools and the gates run on this machine with your permissions."],
        facts: LOCAL,
        checkedAt: new Date().toISOString(),
      };
    },
    async prepare(_a, hostDir, profile) {
      if (isolationRequired()) throw new Error("This factory requires isolated execution (SF_REQUIRE_ISOLATION); this run's policy runs agents locally.");
      return { client: deps.hostClient, workingDir: hostDir, profileId: profile.id, facts: LOCAL };
    },
    clientFor: async () => deps.hostClient,
    release: async () => undefined,
    gateRunner: (dir) => (gate) => runGate(dir, gate, gateEnv()),
  };
}

function containerExecution(c: ContainerPolicy, deps: ExecutionDeps): Execution {
  const docker = deps.docker ?? dockerCli();
  const env = deps.env ?? process.env;
  const image = c.image as string; // parsePolicy requires both for provider container
  const network = c.network as string;
  const gateImage = c.gateImage ?? image;
  const gateNetwork = c.gateNetwork ?? network;
  const user = c.user ?? (typeof process.getuid === "function" ? `${process.getuid()}:${process.getgid?.() ?? process.getuid()}` : null);
  const owner = ownerOf(deps.dataDir);
  const runtimeRoot = path.join(deps.dataDir, "runtime");
  let secret: Buffer | undefined;
  const key = (purpose: string, name: string) => createHmac("sha256", (secret ??= runtimeSecret(deps.dataDir))).update(`${purpose}:${name}`).digest("hex");
  const host = (p: string) => dockerPath(p, c.hostPathStyle);

  const labels = (runId: string, kind: string) => ["--label", `${LABEL}.owner=${owner}`, "--label", `${LABEL}.run=${runId}`, "--label", `${LABEL}.kind=${kind}`];
  const hardening = () => [
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--ulimit", "core=0",
    ...(user ? ["--user", user] : []),
    "--memory", c.memory, "--memory-swap", c.memory,
    "--cpus", String(c.cpus),
    "--pids-limit", String(c.pids),
  ];
  const facts = (name: string | undefined, role: AttemptRole | null, imageId: string | null): ExecutionFacts => ({
    provider: "container",
    isolated: true,
    ...(name ? { container: name } : {}),
    image,
    imageId,
    network,
    user,
    limits: { memory: c.memory, cpus: c.cpus, pids: c.pids },
    credentials: role ? [...c.credentials[role]] : [...new Set(Object.values(c.credentials).flat())].sort(),
    mounts: MOUNTS,
  });

  /** An empty file the factory owns, mounted read-only over the worktree's .git file. */
  function gitShadow() {
    const file = path.join(runtimeRoot, "no-git");
    mkdirSync(runtimeRoot, { recursive: true });
    writeFileSync(file, "", { flag: "a" });
    return file;
  }

  async function run(args: string[], opts?: Parameters<DockerRunner>[1]) {
    const r = await docker(args, opts);
    if (engineDown(r)) throw new RuntimeUnavailable(`Docker isn't reachable: ${firstLine(r.stderr) || "no answer"}`);
    return r;
  }

  /** The container's loopback port, or null when it doesn't exist or isn't running. */
  async function live(name: string): Promise<number | null> {
    const state = await run(["inspect", "--format", "{{.State.Running}}", name]);
    if (state.code !== 0) {
      if (gone(state)) return null;
      throw new Error(`docker inspect ${name} failed: ${firstLine(state.stderr)}`);
    }
    if (state.stdout.trim() !== "true") return null;
    const port = await run(["port", name, "8000/tcp"]);
    const binding = /^(\S+):(\d+)$/m.exec(port.stdout.trim());
    if (port.code !== 0 || !binding) return null;
    if (binding[1] !== "127.0.0.1") throw new Error(`Container ${name} publishes its agent server on ${binding[1]}, not only on this machine.`);
    return Number(binding[2]);
  }

  const clientAt = (name: string, port: number) => new OpenHandsClient({ baseUrl: `http://127.0.0.1:${port}`, apiKey: () => key("session", name) });

  async function waitHealthy(name: string, port: number) {
    const deadline = Date.now() + c.startTimeoutSec * 1000;
    while (Date.now() < deadline) {
      const ok = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) }).then((r) => r.ok, () => false);
      if (ok) return;
      if ((await live(name)) === null) {
        const logs = await run(["logs", "--tail", "20", name]);
        throw new Error(`The agent container ${name} stopped while starting.${logs.stdout || logs.stderr ? ` Its last output: ${firstLine(logs.stderr || logs.stdout)}` : ""}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`The agent container ${name} didn't become healthy within ${c.startTimeoutSec} s.`);
  }

  async function imageId(ref: string) {
    const r = await run(["image", "inspect", "--format", "{{.Id}}", ref]);
    return r.code === 0 ? r.stdout.trim() : null;
  }

  const containerName = (a: Attempt) => `sf-${a.runId}-a${a.id}`;
  const runtimeDir = (a: Attempt) => path.join(runtimeRoot, a.runId, `a${a.id}`);

  return {
    kind: "container",

    async preflight(opts = {}) {
      const problems: string[] = [];
      const notes: string[] = [];
      const required = isolationRequired();
      let id: string | null = null;
      const done = (): Preflight => ({ provider: "container", isolated: true, required, ok: !problems.length, problems, notes, facts: facts(undefined, null, id), checkedAt: new Date().toISOString() });
      try {
        const version = await docker(["version", "--format", "{{.Server.Version}}"]);
        if (version.code !== 0) {
          problems.push(`Docker isn't reachable: ${firstLine(version.stderr) || "no answer"}`);
          return done();
        }
        for (const ref of new Set([image, gateImage])) {
          const found = await imageId(ref);
          if (ref === image) id = found;
          if (!found) problems.push(`The image ${ref} isn't on this machine. Pull it first: docker pull ${ref}`);
        }
        for (const net of new Set([network, gateNetwork])) {
          if ((await run(["network", "inspect", "--format", "{{.Name}}", net])).code !== 0) problems.push(`The Docker network ${net} doesn't exist.`);
        }
        for (const [role, names] of Object.entries(c.credentials)) {
          for (const name of names) if (!env[name]) problems.push(`The ${role} credential ${name} isn't set in the factory's environment.`);
        }
        if (opts.probe && !problems.length) await probe(problems, notes);
      } catch (err) {
        problems.push(err instanceof Error ? err.message : String(err));
      }
      return done();
    },

    async prepare(a, hostDir, profile, inputs = {}) {
      const name = containerName(a);
      const dir = runtimeDir(a);
      let port = await live(name);
      if (port === null) {
        await run(["rm", "-f", name]); // a stopped container with this name
        const state = path.join(dir, "state");
        const given = path.join(dir, "inputs");
        for (const d of ["home", "conversations", "persistence"]) mkdirSync(path.join(state, d), { recursive: true });
        rmSync(given, { recursive: true, force: true });
        mkdirSync(given, { recursive: true });
        for (const [file, text] of Object.entries(inputs)) writeFileSync(path.join(given, file), text);
        const names = c.credentials[a.role];
        const missing = names.filter((n) => !env[n]);
        if (missing.length) throw new Error(`The ${a.role} credential(s) ${missing.join(", ")} aren't set in the factory's environment.`);
        const secrets: Record<string, string> = { OH_SECRET_KEY: key("cipher", name), OH_SESSION_API_KEYS_0: key("session", name) };
        for (const n of names) secrets[n] = env[n] as string;
        const started = await run(
          [
            "run", "-d", "--name", name,
            ...labels(a.runId, "agent"),
            ...hardening(),
            "--network", network,
            "-p", "127.0.0.1::8000",
            "--mount", mountArg(host(hostDir), WORKDIR),
            "--mount", mountArg(host(gitShadow()), `${WORKDIR}/.git`, true),
            "--mount", mountArg(host(state), "/var/openhands"),
            "--mount", mountArg(host(given), "/factory", true),
            "-e", "HOME=/var/openhands/home",
            "-e", "OH_CONVERSATIONS_PATH=/var/openhands/conversations",
            "-e", "OH_PERSISTENCE_DIR=/var/openhands/persistence",
            "-e", "OH_CONVERSATION_RUNTIME=local",
            "-e", "OH_ENABLE_BROWSER=0",
            ...Object.keys(secrets).flatMap((n) => ["-e", n]),
            image, "--host", "0.0.0.0", "--port", "8000",
          ],
          { env: secrets },
        );
        if (started.code !== 0) throw new Error(`Docker couldn't start the agent container ${name}: ${firstLine(started.stderr)}`);
        port = await live(name);
        if (port === null) throw new Error(`The agent container ${name} stopped right after it started.`);
      }
      await waitHealthy(name, port);
      const client = clientAt(name, port);
      // The container's agent server starts empty: give it the profile the policy chose.
      const { profile: definition } = await deps.hostClient.getProfile(profile.name);
      await client.saveProfile(profile.name, definition);
      const inner = await client.resolveProfile(profile.name);
      return { client, workingDir: WORKDIR, profileId: inner.id, facts: facts(name, a.role, await imageId(image)) };
    },

    async clientFor(a) {
      const name = (a.runtime as ExecutionFacts | null)?.container ?? containerName(a);
      const port = await live(name);
      if (port === null) throw new RuntimeGone(`The agent's container ${name} is gone, and its conversation with it.`);
      return clientAt(name, port);
    },

    async release(a) {
      const name = (a.runtime as ExecutionFacts | null)?.container ?? containerName(a);
      const r = await run(["rm", "-f", name]);
      if (r.code !== 0 && !gone(r)) throw new Error(`docker rm ${name} failed: ${firstLine(r.stderr)}`);
    },

    gateRunner(dir, runId) {
      return async (gate) => {
        const name = `sf-${runId}-g${randomBytes(4).toString("hex")}`;
        const timeoutSec = gate.timeoutSec ?? DEFAULT_GATE_TIMEOUT_SEC;
        const started = Date.now();
        const r = await run(
          [
            "run", "--rm", "--name", name,
            ...labels(runId, "gate"),
            ...hardening(),
            "--network", gateNetwork,
            "--mount", mountArg(host(dir), WORKDIR),
            "--mount", mountArg(host(gitShadow()), `${WORKDIR}/.git`, true),
            "-w", path.posix.join(WORKDIR, (gate.cwd ?? "").replaceAll("\\", "/")),
            "-e", "CI=1", "-e", "NO_COLOR=1", "-e", "FORCE_COLOR=0",
            "--entrypoint", "sh",
            // A script body pinned from the base runs with node_modules/.bin on PATH, as npm would run it.
            gateImage, "-c", gate.bin ? `PATH="$PWD/node_modules/.bin:${WORKDIR}/node_modules/.bin:$PATH"; ${gate.run}` : gate.run,
          ],
          { timeoutMs: timeoutSec * 1000 },
        );
        if (r.timedOut) await docker(["rm", "-f", name]);
        // 125: Docker couldn't run the container at all (a missing image, a bad flag). Not the builder's doing.
        if (r.code === 125) throw new Error(`Docker couldn't run gate ${gate.name}: ${firstLine(r.stderr)}`);
        const output = `${r.stdout}${r.stderr}${r.timedOut ? `\n[Stopped: still running after ${timeoutSec} s]` : ""}`.slice(-OUTPUT_LIMIT);
        return { name: gate.name, run: gate.run, ok: !r.timedOut && r.code === 0, exitCode: r.timedOut ? null : r.code, durationMs: Date.now() - started, output, timedOut: !!r.timedOut };
      };
    },
  };

  /**
   * The checks only a container can answer: does it see what the factory
   * writes through the mount (the path mapping), and can it reach the factory
   * API or Canvas on this machine (Docker Desktop forwards host.docker.internal
   * to this machine's loopback, so an agent there could act as you).
   */
  async function probe(problems: string[], notes: string[]) {
    const dir = path.join(runtimeRoot, "probe");
    mkdirSync(dir, { recursive: true });
    const token = randomBytes(8).toString("hex");
    writeFileSync(path.join(dir, `${token}.txt`), token);
    const base = (kind: string) => ["run", "--rm", "--name", `sf-probe-${randomBytes(4).toString("hex")}`, ...labels("probe", kind), ...hardening(), "--network", network];
    try {
      const seen = await run([...base("probe"), "--mount", mountArg(host(dir), "/probe", true), "--entrypoint", "cat", image, `/probe/${token}.txt`], { timeoutMs: 120_000 });
      if (seen.code !== 0 || seen.stdout.trim() !== token) {
        problems.push(`A container can't read ${dir} through the mount (${host(dir)}): ${firstLine(seen.stderr) || "it saw something else"}. Check execution.container.hostPathStyle and Docker's file sharing.`);
      }
      for (const port of deps.controlPorts ?? []) {
        const script = `import socket,sys\ntry:\n  socket.create_connection(("host.docker.internal",${port}),3).close()\nexcept OSError:\n  sys.exit(1)`;
        const reach = await run([...base("probe"), "--entrypoint", "python3", image, "-c", script], { timeoutMs: 60_000 });
        if (reach.code === 0) {
          problems.push(`Containers on the network ${network} can reach port ${port} on this machine (the factory API or Canvas), so an agent could act as you. Use a network without access to this machine.`);
        } else if (reach.code !== 1) {
          notes.push(`Couldn't check whether containers reach port ${port} on this machine (the image can't run python3).`);
        }
      }
    } finally {
      rmSync(path.join(dir, `${token}.txt`), { force: true });
    }
  }
}
