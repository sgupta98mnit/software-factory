// Sets up canvas/: OpenHands Agent Canvas at the commit in canvas.lock.json,
// on a "factory" branch, with our patch applied and its npm packages installed.
//
//   pnpm setup:canvas
//
// Safe to run again: it skips whatever is already done. It never deletes
// anything; if canvas/ exists but isn't what it expects, it stops and says why.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const lock = JSON.parse(readFileSync(path.join(root, "canvas.lock.json"), "utf8"));
const canvas = path.join(root, "canvas");
const patch = path.join(root, lock.patch);
const isWindows = process.platform === "win32";

const log = (msg) => console.log(`[setup:canvas] ${msg}`);
function fail(msg) {
  console.error(`[setup:canvas] ${msg}`);
  process.exit(1);
}
const git = (args, opts = {}) => execFileSync("git", ["-C", canvas, ...args], { stdio: "pipe", encoding: "utf8", ...opts }).trim();
const tryGit = (args) => spawnSync("git", ["-C", canvas, ...args], { encoding: "utf8" });

// 1. Tools
const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor < 24) fail(`Canvas needs Node.js 24 or newer; this is ${process.version}. Install Node 24 LTS, then run this again.`);
if (spawnSync("git", ["--version"]).status !== 0) fail("git isn't installed or isn't on PATH. Install Git for Windows (https://git-scm.com), then run this again.");
const uv = spawnSync(isWindows ? "uv.exe" : "uv", ["--version"], { encoding: "utf8" });
if (uv.status !== 0) {
  log("uv isn't installed. Canvas uses it to run the OpenHands agent server. Install it with:");
  log(isWindows ? '  powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"' : "  curl -LsSf https://astral.sh/uv/install.sh | sh");
  log("Continuing; you'll need it before `pnpm dev`.");
}

// 2. Get the pinned commit (shallow, so it's quick)
if (!existsSync(canvas)) {
  log(`Fetching OpenHands Agent Canvas ${lock.version} (${lock.commit.slice(0, 7)})…`);
  execFileSync("git", ["init", "--quiet", canvas], { stdio: "inherit" });
  git(["remote", "add", "upstream", lock.repo]);
  execFileSync("git", ["-C", canvas, "fetch", "--depth", "1", "upstream", lock.commit], { stdio: "inherit" });
  git(["checkout", "--quiet", "-b", lock.branch, lock.commit]);
} else if (!existsSync(path.join(canvas, ".git"))) {
  fail("canvas/ exists but isn't a git repository. Move it out of the way and run this again.");
}

// 3. Apply our changes once
const hasFactory = existsSync(path.join(canvas, "src", "factory", "factory-nav-links.tsx"));
if (!hasFactory) {
  const check = tryGit(["apply", "--check", patch]);
  if (check.status !== 0) {
    fail(`The patch doesn't apply cleanly to canvas/:\n${check.stderr}\nIs canvas/ at ${lock.commit.slice(0, 7)} with no other changes?`);
  }
  git(["apply", patch]);
  git(["add", "-A"]);
  const commit = tryGit(["commit", "--quiet", "-m", "Add Software Factory pages (requirements, work orders, audit log)"]);
  if (commit.status === 0) log(`Applied ${lock.patch} as a commit on branch "${lock.branch}".`);
  else log(`Applied ${lock.patch}. It isn't committed yet (set git user.name and user.email, then commit in canvas/).`);
} else {
  log("Factory pages are already in canvas/.");
}

// 4. Local settings: no telemetry, and where the factory API listens
const envFile = path.join(canvas, ".env");
if (!existsSync(envFile)) {
  writeFileSync(
    envFile,
    [
      "# Written by pnpm setup:canvas. Git-ignored by Canvas.",
      "# No usage data to OpenHands' PostHog (federal default).",
      "VITE_DO_NOT_TRACK=1",
      "DO_NOT_TRACK=1",
      "# The Software Factory API (apps/server). Vite proxies /sf-api here.",
      "SF_API_URL=http://127.0.0.1:4317",
      "",
    ].join("\n"),
  );
  log("Wrote canvas/.env (telemetry off).");
}

// 5. Packages
if (!existsSync(path.join(canvas, "node_modules"))) {
  log("Installing Canvas packages (npm ci). This takes a few minutes the first time…");
  const npm = spawnSync("npm ci --no-audit --no-fund", {
    cwd: canvas,
    stdio: "inherit",
    shell: true,
    env: { ...process.env, ELECTRON_SKIP_BINARY_DOWNLOAD: "1", PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1" },
  });
  if (npm.status !== 0) fail("npm ci failed. Fix the error above, then run this again.");
}

log("Done. Start everything with: pnpm dev");
