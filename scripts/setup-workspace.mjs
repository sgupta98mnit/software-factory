// Runs before `pnpm dev` / `pnpm start`. If the workspace is missing OpenSpec's
// Claude Code skills (.claude/skills), regenerate them with `openspec init`.
// Existing specs, changes and config are left as they are.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const workspace = path.resolve(process.env.SF_WORKSPACE ?? path.join(root, "workspaces", "benefits-portal"));

if (!existsSync(path.join(workspace, "openspec"))) {
  console.log(`[setup] ${workspace} has no openspec/ folder; skipping.`);
  process.exit(0);
}
if (existsSync(path.join(workspace, ".claude", "skills"))) process.exit(0);

const pkgDir = path.join(root, "apps", "server", "node_modules", "@fission-ai", "openspec");
if (!existsSync(pkgDir)) {
  console.log("[setup] OpenSpec isn't installed yet. Run `pnpm install` first.");
  process.exit(1);
}
const pkg = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8"));
const bin = path.join(pkgDir, typeof pkg.bin === "string" ? pkg.bin : pkg.bin.openspec);

console.log(`[setup] Adding OpenSpec skills for Claude Code and Codex to ${path.basename(workspace)}…`);
execFileSync(process.execPath, [bin, "init", "--tools", "claude,codex"], {
  cwd: workspace,
  stdio: "inherit",
  env: { ...process.env, OPENSPEC_TELEMETRY: "0", DO_NOT_TRACK: "1", OPENSPEC_NO_ANIMATION: "1" },
});
