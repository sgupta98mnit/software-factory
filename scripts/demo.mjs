// `pnpm demo`: the whole factory with scripted agents, no model login and no
// network: a sample workspace in data/demo/, the scripted agent server
// (apps/server/src/demo), the factory API and Canvas in mock mode. Ctrl+C
// stops everything. `pnpm demo --reset` starts over with a fresh workspace;
// `--no-canvas` runs only the agents and the API.
//
// The agents are scripts, never real models: the spec agent writes a valid
// OpenSpec change for any goal, the builders write small modules with tests
// (the second work order's first try has a bug its test catches), the third
// work order touches src/auth so its merge waits for a person, and the
// validator writes hidden acceptance tests. The demo's policy turns on
// hidden tests and the preview, so every screen has something to show.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");

const README = `# Claims portal (demo)

A sample project for the Software Factory demo. Autopilot builds into it on
branches of its own; releasing merges into main.
`;

const AGENTS = `# Instructions for agents

- Plain JavaScript modules on Node, tested with node:test (\`npm test\`).
- Keep each module small and give it a test next to it.
`;

// The app the preview starts: a page per path, so the screenshots show something.
const SERVER = `// The demo app the factory's preview runs (policy preview.start).
const http = require("node:http");
const page = (title, body) => \`<!doctype html><html><head><meta charset="utf-8"><title>\${title}</title>
<style>body{font-family:system-ui,sans-serif;margin:3rem;color:#1b1f24}h1{font-size:1.6rem}.card{border:1px solid #d0d7de;border-radius:12px;padding:1rem 1.25rem;max-width:32rem}</style>
</head><body><h1>\${title}</h1><div class="card">\${body}</div></body></html>\`;
http
  .createServer((req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    if (req.url === "/status") return res.end(page("Claim status", "<p>Claim <b>AB-123456</b> is <b>in review</b>.</p>"));
    if (req.url === "/") return res.end(page("Claims portal", '<p>Check the status of a claim.</p><p><a href="/status">Check a claim</a></p>'));
    res.statusCode = 404;
    res.end(page("Not found", "<p>There's no page here.</p>"));
  })
  .listen(Number(process.env.PORT) || 3500, process.env.HOST || "127.0.0.1");
`;

const POLICY = `# The demo's policy: hidden acceptance tests and the preview are on, so every
# screen has something to show. Everything else is the factory's default.
version: 1
hiddenTests: { enabled: true }
preview: { enabled: true, start: "node server.cjs", paths: ["/", "/status"] }
`;

const git = (dir, args) => {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
};

// What prepareDemo makes in its folder. --reset deletes the folder only when it holds nothing else, so
// an SF_DEMO_DIR that names a real folder (a home folder, this repo) is never wiped.
const DEMO_ENTRIES = new Set(["workspace", "data"]);

/** The demo's folders, made once (or again after --reset). Returns where they are. */
export function prepareDemo(dir, opts = {}) {
  if (opts.reset && existsSync(dir)) {
    const other = readdirSync(dir).filter((name) => !DEMO_ENTRIES.has(name));
    if (other.length) {
      throw new Error(`${dir} has more in it than the demo makes (${other.slice(0, 3).join(", ")}${other.length > 3 ? ", ..." : ""}), so --reset leaves it alone. Point SF_DEMO_DIR at a folder of its own, or delete it yourself.`);
    }
    rmSync(dir, { recursive: true, force: true });
  }
  const workspace = path.join(dir, "workspace");
  const data = path.join(dir, "data");
  mkdirSync(data, { recursive: true });
  if (!existsSync(path.join(workspace, ".git"))) {
    // Never the demo's files over someone's own (and then committed): a workspace folder already there must be empty.
    if (existsSync(workspace) && readdirSync(workspace).length) {
      throw new Error(`${workspace} already has files and isn't the demo's repo, so the demo doesn't write into it. Point SF_DEMO_DIR at a folder of its own.`);
    }
    mkdirSync(path.join(workspace, ".factory"), { recursive: true });
    writeFileSync(path.join(workspace, "README.md"), README);
    writeFileSync(path.join(workspace, "AGENTS.md"), AGENTS);
    writeFileSync(path.join(workspace, "server.cjs"), SERVER);
    writeFileSync(path.join(workspace, ".factory", "policy.yml"), POLICY);
    git(workspace, ["init", "-q", "-b", "main"]);
    git(workspace, ["config", "user.name", "Software Factory demo"]);
    git(workspace, ["config", "user.email", "demo@software-factory.invalid"]);
    git(workspace, ["add", "-A"]);
    git(workspace, ["commit", "-q", "-m", "Demo workspace"]);
  }
  return { workspace, data };
}

const isWindows = process.platform === "win32";

function main() {
  const args = new Set(process.argv.slice(2));
  // An empty SF_DEMO_DIR is unset, not "" (which path.resolve reads as the folder pnpm runs in: this repo).
  const dir = path.resolve(process.env.SF_DEMO_DIR?.trim() || path.join(root, "data", "demo"));
  const apiPort = Number(process.env.SF_DEMO_API_PORT) || 4417;
  const agentsPort = Number(process.env.SF_DEMO_AGENTS_PORT) || 18100;
  const canvasPort = Number(process.env.SF_DEMO_CANVAS_PORT) || 3001;
  const withCanvas = !args.has("--no-canvas");
  if (withCanvas && !existsSync(path.join(root, "canvas", "node_modules"))) {
    console.error("[demo] canvas/ isn't set up yet. Run: pnpm setup:canvas (or pnpm demo --no-canvas for the API alone)");
    process.exit(1);
  }
  let prepared;
  try {
    prepared = prepareDemo(dir, { reset: args.has("--reset") });
  } catch (err) {
    console.error(`[demo] ${err.message}`);
    process.exit(1);
  }
  const { workspace, data } = prepared;

  const children = [];
  let stopping = false;
  const shutdown = (code) => {
    if (stopping) return;
    stopping = true;
    for (const child of children) {
      if (isWindows) spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      else {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          /* already gone */
        }
      }
    }
    setTimeout(() => process.exit(code), isWindows ? 500 : 2000).unref();
  };
  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));

  const colors = { agents: "\x1b[33m", api: "\x1b[36m", canvas: "\x1b[35m" };
  const run = (name, command, cwd, env) => {
    const child = spawn(command, { cwd, shell: true, detached: !isWindows, env: { ...process.env, FORCE_COLOR: "1", ...env } });
    const prefix = `${colors[name]}[${name}]\x1b[0m `;
    for (const [stream, out] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
      let buffered = "";
      stream.on("data", (chunk) => {
        buffered += chunk;
        const lines = buffered.split(/\r?\n/);
        buffered = lines.pop() ?? "";
        for (const line of lines) out.write(prefix + line + "\n");
      });
    }
    child.on("exit", (code) => {
      if (!stopping) console.log(`${prefix}stopped${code ? ` (exit ${code})` : ""}`);
      shutdown(code ?? 0);
    });
    children.push(child);
  };

  const server = path.join(root, "apps", "server");
  run("agents", "pnpm exec tsx src/demo/agent-server.ts", server, { SF_FAKE_AGENT_PORT: String(agentsPort), SF_FAKE_AGENT_TURN_MS: process.env.SF_FAKE_AGENT_TURN_MS ?? "1500" });
  run("api", "pnpm exec tsx src/index.ts", server, {
    SF_PORT: String(apiPort),
    SF_WORKSPACE: workspace,
    SF_DATA_DIR: data,
    SF_AGENT_SERVER_URL: `http://127.0.0.1:${agentsPort}`,
    SF_AGENT_SERVER_KEY: "demo",
    SF_USER: process.env.SF_USER ?? "demo",
    SF_PUBLIC_URL: `http://127.0.0.1:${canvasPort}`,
    // No team alerts from scripted runs: a webhook set in this shell would post the demo to a real channel.
    SF_NOTIFY_WEBHOOK: "",
  });
  if (withCanvas) run("canvas", `npm run dev:mock -- --port ${canvasPort} --host 127.0.0.1`, path.join(root, "canvas"), {
      SF_API_URL: `http://127.0.0.1:${apiPort}`,
      VITE_DO_NOT_TRACK: "1",
      // A session key makes Canvas register its own (mock) backend and skip first-run setup.
      VITE_SESSION_API_KEY: "demo",
    });

  console.log(
    [
      "",
      "Software Factory demo (scripted agents: no model, no network)",
      withCanvas ? `  Open      http://127.0.0.1:${canvasPort}/autopilot` : `  API       http://127.0.0.1:${apiPort}/sf-api`,
      `  Workspace ${path.relative(root, workspace) || workspace} (hidden tests and the preview are on)`,
      `  Agents    http://127.0.0.1:${agentsPort} (scripts that write the spec, code and tests)`,
      ...(withCanvas ? ["", "The first time, Canvas shows its welcome steps and asks about usage data: choose", "Skip for now, then Confirm. Nothing is sent (the demo runs with Do Not Track)."] : []),
      "",
      'Try the goal "Let applicants check a claim\'s status". WO-2\'s first try has a bug its test',
      "catches; WO-3 touches src/auth, so its merge waits for you in the Inbox; at the end the",
      "preview runs the app and the release decision shows its screenshots.",
      "Ctrl+C stops everything. pnpm demo --reset starts over.",
      "",
    ].join("\n"),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
