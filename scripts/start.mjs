// `pnpm start [your project folder]`: the factory on your own project, like an
// app. It sets up (or updates) canvas/, starts the factory API and Agent Canvas
// with the folder as the workspace, waits until they answer, and opens the
// browser on Autopilot. Ctrl+C stops everything.
//
//   pnpm start C:\path\to\your-repo        (PowerShell)
//   pnpm start ~/code/your-repo --no-open  (don't open a browser)
//
// Without a folder it uses SF_WORKSPACE, or the sample workspace. For a look
// around with no model or keys, use `pnpm demo` instead.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const isWindows = process.platform === "win32";

/** The workspace folder: the argument, else SF_WORKSPACE, else the sample. Throws a plain message when it can't be used. */
export function resolveWorkspace(arg, env = process.env, factoryRoot = root) {
  const raw = arg?.trim() || env.SF_WORKSPACE?.trim() || path.join(factoryRoot, "workspaces", "benefits-portal");
  const dir = path.resolve(raw.replace(/^~(?=$|[\\/])/, env.HOME ?? env.USERPROFILE ?? "~"));
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`${dir} isn't a folder. Give the path to your project's folder.`);
  const rel = path.relative(dir, factoryRoot);
  if (!rel || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
    throw new Error(`${dir} is the factory itself (or holds it). Point it at your project's own folder, outside ${factoryRoot}.`);
  }
  return dir;
}

/** How this OS opens a URL in the default browser. */
export function openCommand(platform, url) {
  if (platform === "win32") return { command: "cmd", args: ["/c", "start", "", url] };
  if (platform === "darwin") return { command: "open", args: [url] };
  return { command: "xdg-open", args: [url] };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function answers(url, headers = {}) {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(3000) });
    return res.status < 500;
  } catch {
    return false;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const open = !args.includes("--no-open");
  let workspace;
  try {
    workspace = resolveWorkspace(args.find((a) => !a.startsWith("--")));
  } catch (err) {
    console.error(`[start] ${err.message}`);
    process.exit(1);
  }

  // canvas/: fetched and patched the first time, brought up to date after a pull. Quick when nothing changed.
  const setup = spawnSync(process.execPath, [path.join(root, "scripts", "setup-canvas.mjs")], { stdio: "inherit" });
  if (setup.status !== 0) process.exit(setup.status ?? 1);

  const apiPort = Number(process.env.SF_PORT) || 4317;
  const url = "http://localhost:8000/autopilot";
  console.log(
    [
      "",
      "Software Factory",
      `  Workspace  ${workspace}`,
      `  Open       ${url}  (the first start downloads the agent server; give it a minute)`,
      "",
      "Home's Setup panel checks what the project needs: the agent server, a git repo, a policy, gates and AGENTS.md.",
      "The factory builds from your committed base branch: commit or stash your own work first.",
      "Agents run with full permissions on this machine. Start with supervised runs and keep an eye on the Inbox.",
      "Ctrl+C stops everything.",
      "",
    ].join("\n"),
  );

  const dev = spawn(process.execPath, [path.join(root, "scripts", "dev.mjs")], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, SF_WORKSPACE: workspace },
  });
  dev.on("exit", (code) => process.exit(code ?? 0));
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => dev.kill(sig));

  if (!open) return;
  const started = Date.now();
  let hinted = false;
  while (dev.exitCode === null) {
    const api = await answers(`http://127.0.0.1:${apiPort}/sf-api/health`, { host: "localhost" });
    if (api && (await answers("http://127.0.0.1:8000/"))) break;
    if (!hinted && Date.now() - started > 90_000) {
      console.log("[start] Still starting (the agent server's first download can take a few minutes)…");
      hinted = true;
    }
    if (Date.now() - started > 15 * 60_000) return console.log(`[start] Not answering yet; open ${url} yourself when it is.`);
    await sleep(2000);
  }
  if (dev.exitCode !== null) return;
  const { command, args: openArgs } = openCommand(process.platform, url);
  spawn(command, openArgs, { stdio: "ignore", detached: !isWindows }).on("error", () => console.log(`[start] Open ${url} in your browser.`)).unref();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) void main();
