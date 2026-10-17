// `pnpm dev`: the factory API and Agent Canvas together, in one terminal.
// Ctrl+C stops both.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const canvas = path.join(root, "canvas");

if (!existsSync(path.join(canvas, "node_modules"))) {
  console.error("[dev] canvas/ isn't set up yet. Run: pnpm setup:canvas");
  process.exit(1);
}

// OpenSpec's Claude Code / Codex skills for the workspace, if missing.
const setup = spawnSync(process.execPath, [path.join(root, "scripts", "setup-workspace.mjs")], { stdio: "inherit" });
if (setup.status !== 0) process.exit(setup.status ?? 1);

const colors = { api: "\x1b[36m", canvas: "\x1b[35m" };
const children = [];

const isWindows = process.platform === "win32";

function run(name, command, cwd) {
  // shell: true so npm/pnpm resolve to their .cmd shims on Windows. On macOS/Linux
  // each child gets its own process group, so shutdown can stop everything under it.
  const child = spawn(command, { cwd, shell: true, detached: !isWindows, env: { ...process.env, FORCE_COLOR: "1" } });
  const prefix = `${colors[name]}[${name}]\x1b[0m `;
  const pipe = (stream, out) => {
    let buffered = "";
    stream.on("data", (chunk) => {
      buffered += chunk;
      const lines = buffered.split(/\r?\n/);
      buffered = lines.pop() ?? "";
      for (const line of lines) out.write(prefix + line + "\n");
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on("exit", (code) => {
    console.log(`${prefix}stopped${code ? ` (exit ${code})` : ""}`);
    shutdown(code ?? 0);
  });
  children.push(child);
}

let stopping = false;
function shutdown(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (isWindows) {
      // /T stops the whole tree (npm, node, the agent server...).
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      try {
        process.kill(-child.pid, "SIGTERM"); // the child's whole process group
      } catch {
        /* already gone */
      }
    }
  }
  // Canvas stops its own services on SIGTERM; give it a moment.
  setTimeout(() => process.exit(code), isWindows ? 500 : 4000);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

run("api", "pnpm --filter @sf/server dev", root);
run("canvas", "npm run dev", canvas);
