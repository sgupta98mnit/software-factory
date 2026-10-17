// Finds the OpenSpec and Backlog.md CLIs installed as dependencies, and builds
// the environment they run with. We always launch them as `node <script>` so
// the same code works on Windows (no .cmd shims) and macOS/Linux.
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { SERVER_DIR } from "./config.js";

const require = createRequire(import.meta.url);

function packageDir(name: string): string {
  for (const base of require.resolve.paths(name) ?? []) {
    const dir = path.join(base, name);
    if (existsSync(path.join(dir, "package.json"))) return dir;
  }
  throw new Error(`Package ${name} is not installed. Run pnpm install.`);
}

function binScript(name: string, binName: string): { script: string; version: string } {
  const dir = packageDir(name);
  const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as {
    version: string;
    bin?: string | Record<string, string>;
  };
  const rel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.[binName];
  if (!rel) throw new Error(`${name} has no "${binName}" bin.`);
  return { script: path.join(dir, rel), version: pkg.version };
}

export const tools = {
  openspec: binScript("@fission-ai/openspec", "openspec"),
  backlog: binScript("backlog.md", "backlog"),
};

/** Environment for the CLIs: telemetry off (federal default), no color codes in output. */
export function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, OPENSPEC_TELEMETRY: "0", DO_NOT_TRACK: "1", NO_COLOR: "1", ...extra };
  const binDir = path.join(SERVER_DIR, "node_modules", ".bin");
  // Windows spells it "Path"; reuse whichever key exists so we don't create a duplicate.
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "PATH";
  env[pathKey] = [binDir, env[pathKey]].filter(Boolean).join(path.delimiter);
  return env;
}
