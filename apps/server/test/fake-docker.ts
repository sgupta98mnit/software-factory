// A stand-in for the Docker CLI, in process, so isolation tests need no
// container engine. "Containers" started with -d are fake agent servers
// (fake-openhands.ts) whose handlers see the mounted folders on this machine;
// foreground runs execute the gate command here, in the folder mounted at
// the working directory; the probe's cat and python3 are answered directly.
// Every call is kept, with the environment the CLI would have had.
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { DockerResult, DockerRunner } from "../src/autopilot/execution.js";
import { type FakeHandler, startFakeOpenHands } from "./fake-openhands.js";

type FakeServer = Awaited<ReturnType<typeof startFakeOpenHands>>;

export interface FakeMount {
  source: string;
  target: string;
  readonly: boolean;
}

export interface FakeContainer {
  name: string;
  args: string[];
  env: Record<string, string>;
  labels: Record<string, string>;
  mounts: FakeMount[];
  running: boolean;
  server: FakeServer | null;
}

// Flags that take a value, as the factory uses them.
const VALUED = new Set(["--name", "--label", "--cap-drop", "--security-opt", "--ulimit", "--user", "--memory", "--memory-swap", "--cpus", "--pids-limit", "--network", "-p", "--mount", "-e", "-w", "--entrypoint"]);

/** A --mount value: CSV fields, quoted ones with doubled quotes inside. */
function parseMount(value: string): FakeMount {
  const fields: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    if (quoted) {
      if (ch === '"' && value[i + 1] === '"') (field += '"'), i++;
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") fields.push(field), (field = "");
    else field += ch;
  }
  fields.push(field);
  const get = (key: string) => fields.find((f) => f.startsWith(`${key}=`))?.slice(key.length + 1) ?? "";
  return { source: get("source"), target: get("target"), readonly: fields.includes("readonly") };
}

/** The folder on this machine behind a path in the container, from the mount with the longest matching target. */
export function hostPathOf(containerPath: string, mounts: FakeMount[]): string {
  const m = [...mounts].sort((a, b) => b.target.length - a.target.length).find((x) => containerPath === x.target || containerPath.startsWith(`${x.target}/`));
  if (!m) throw new Error(`No mount for ${containerPath}`);
  return path.join(m.source, containerPath.slice(m.target.length));
}

export function createFakeDocker(opts: { images?: string[]; networks?: string[]; onMessage?: FakeHandler; reachable?: boolean } = {}) {
  const state = {
    up: true,
    images: new Set(opts.images ?? []),
    networks: new Set(["bridge", "none", ...(opts.networks ?? [])]),
    containers: new Map<string, FakeContainer>(),
    calls: [] as { args: string[]; env?: Record<string, string> }[],
    /** Whether a probe container can reach this machine's ports; undefined: the image has no python3. */
    reachable: opts.reachable as boolean | undefined,
    handler: opts.onMessage,
  };
  const ok = (stdout = ""): DockerResult => ({ code: 0, stdout, stderr: "" });
  const fail = (code: number, stderr: string): DockerResult => ({ code, stdout: "", stderr });

  async function run(args: string[], env: Record<string, string>, timeoutMs?: number): Promise<DockerResult> {
    const c: FakeContainer = { name: `c${randomBytes(4).toString("hex")}`, args, env: {}, labels: {}, mounts: [], running: false, server: null };
    let detach = false;
    let workdir = "/";
    let entrypoint: string | null = null;
    let network = "bridge";
    let i = 1;
    for (; i < args.length; i++) {
      const a = args[i]!;
      if (a === "-d") detach = true;
      else if (a === "--rm") continue;
      else if (VALUED.has(a)) {
        const v = args[++i]!;
        if (a === "--name") c.name = v;
        else if (a === "--label") c.labels[v.slice(0, v.indexOf("="))] = v.slice(v.indexOf("=") + 1);
        else if (a === "--mount") c.mounts.push(parseMount(v));
        else if (a === "-e") c.env[v.split("=")[0]!] = v.includes("=") ? v.slice(v.indexOf("=") + 1) : (env[v] ?? "");
        else if (a === "-w") workdir = v;
        else if (a === "--entrypoint") entrypoint = v;
        else if (a === "--network") network = v;
      } else break;
    }
    const image = args[i] ?? "";
    const rest = args.slice(i + 1);
    if (!state.images.has(image)) return fail(125, `Unable to find image '${image}' locally`);
    if (!state.networks.has(network)) return fail(125, `Error response from daemon: network ${network} not found`);
    if (state.containers.has(c.name)) return fail(125, `Conflict. The container name "/${c.name}" is already in use`);

    if (detach) {
      // An agent-server container: a fake agent server that sees the mounts on this machine.
      c.server = await startFakeOpenHands({
        apiKey: c.env.OH_SESSION_API_KEYS_0,
        profiles: [],
        activeProfileId: null,
        mapDir: (dir) => hostPathOf(dir, c.mounts),
        onMessage: (conv, text) => (state.handler ?? (() => ({ response: "Done.", cost: 0.01 })))(conv, text),
      });
      c.running = true;
      state.containers.set(c.name, c);
      return ok(`${createHash("sha256").update(c.name).digest("hex")}\n`);
    }
    if (entrypoint === "cat") {
      try {
        return ok(readFileSync(hostPathOf(rest[0] ?? "", c.mounts), "utf8"));
      } catch (err) {
        return fail(1, `cat: ${String(err)}`);
      }
    }
    if (entrypoint === "python3") return state.reachable === undefined ? fail(127, "exec: python3: not found") : state.reachable ? ok() : fail(1, "");
    // A gate: `sh -c <command>` in the mounted folder, here.
    state.containers.set(c.name, c);
    try {
      const r = spawnSync(rest[1] ?? "", { shell: true, cwd: hostPathOf(workdir, c.mounts), env: { ...process.env, ...c.env }, encoding: "utf8", timeout: timeoutMs || undefined, windowsHide: true });
      const timedOut = (r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
      return { code: timedOut ? 124 : (r.status ?? 1), stdout: r.stdout ?? "", stderr: r.stderr ?? "", timedOut };
    } finally {
      // --rm: gone when it ends, unless the test looks for a leftover from a timeout.
      if (!args.includes("--rm")) c.running = false;
      else state.containers.delete(c.name);
    }
  }

  const docker: DockerRunner = async (args, o = {}) => {
    state.calls.push({ args, env: o.env });
    if (!state.up) return fail(1, "error during connect: open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified.");
    const [cmd, sub] = args;
    if (cmd === "version") return ok("27.3.1\n");
    if (cmd === "image" && sub === "inspect") {
      const ref = args.at(-1)!;
      return state.images.has(ref) ? ok(`sha256:${createHash("sha256").update(ref).digest("hex")}\n`) : fail(1, `Error: No such image: ${ref}`);
    }
    if (cmd === "network" && sub === "inspect") return state.networks.has(args.at(-1)!) ? ok(`${args.at(-1)}\n`) : fail(1, `Error: No such network: ${args.at(-1)}`);
    if (cmd === "inspect") {
      const c = state.containers.get(args.at(-1)!);
      return c ? ok(`${c.running}\n`) : fail(1, `Error: No such object: ${args.at(-1)}`);
    }
    if (cmd === "port") {
      const c = state.containers.get(args[1]!);
      return c?.running && c.server ? ok(`127.0.0.1:${new URL(c.server.url).port}\n`) : fail(1, `Error: No such container: ${args[1]}`);
    }
    if (cmd === "logs") return ok();
    if (cmd === "rm") {
      for (const name of args.slice(1).filter((a) => !a.startsWith("-"))) {
        const c = state.containers.get(name);
        state.containers.delete(name);
        await c?.server?.close();
      }
      return ok();
    }
    if (cmd === "ps") {
      const filter = args[args.indexOf("--filter") + 1]!.replace(/^label=/, "");
      const [key, value] = [filter.slice(0, filter.indexOf("=")), filter.slice(filter.indexOf("=") + 1)];
      return ok([...state.containers.values()].filter((c) => c.labels[key] === value).map((c) => `${c.name}\n`).join(""));
    }
    if (cmd === "run") return run(args, o.env ?? {}, o.timeoutMs);
    return fail(1, `fake docker: unknown command ${args.join(" ")}`);
  };

  return {
    docker,
    state,
    /** The calls whose arguments start with `prefix`. */
    callsOf: (...prefix: string[]) => state.calls.filter((c) => prefix.every((p, i) => c.args[i] === p)),
    async close() {
      for (const c of state.containers.values()) await c.server?.close();
      state.containers.clear();
    },
  };
}
