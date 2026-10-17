// Requirements and blueprints come from OpenSpec. We never parse its files for
// structure ourselves: its CLI has a documented JSON contract (`--json`), so we
// call it and pass the result through. Raw markdown is read only for display.
import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { WORKSPACE } from "./config.js";
import { childEnv, tools } from "./tools.js";

const CHANGES_DIR = path.join(WORKSPACE, "openspec", "changes");
const SPECS_DIR = path.join(WORKSPACE, "openspec", "specs");
const SAFE_ID = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/i;

function run(args: string[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [tools.openspec.script, ...args, "--json"],
      { cwd: WORKSPACE, env: childEnv(), maxBuffer: 20 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        // `validate` exits 1 when something fails but still prints JSON, so try stdout first.
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error(stderr.trim() || error?.message || "openspec returned no JSON"));
        }
      },
    );
  });
}

function assertId(id: string) {
  if (!SAFE_ID.test(id) || id.includes("..")) throw new Error(`Invalid id "${id}"`);
}

/** Throws unless `id` names an existing change folder. */
export function assertChange(id: string) {
  assertId(id);
  if (!existsSync(path.join(CHANGES_DIR, id))) throw new Error(`No change named "${id}"`);
}

function readIfExists(file: string): string | null {
  return existsSync(file) ? readFileSync(file, "utf8") : null;
}

export async function overview() {
  const [changes, specs] = await Promise.all([run(["list"]), run(["list", "--specs"])]);
  return { changes, specs };
}

/** One change: OpenSpec's parsed view plus the raw markdown of each artifact. */
export async function changeDetail(id: string) {
  assertId(id);
  const dir = path.join(CHANGES_DIR, id);
  if (!existsSync(dir)) throw new Error(`No change named "${id}"`);
  const [show, status] = await Promise.all([run(["show", id, "--type", "change"]), run(["status", "--change", id])]);
  const specFiles: { path: string; markdown: string }[] = [];
  const specsDir = path.join(dir, "specs");
  if (existsSync(specsDir)) {
    for (const entry of readdirSync(specsDir, { recursive: true, withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".md")) {
        const full = path.join(entry.parentPath, entry.name);
        specFiles.push({ path: path.relative(dir, full).replaceAll("\\", "/"), markdown: readFileSync(full, "utf8") });
      }
    }
  }
  return {
    id,
    show,
    status,
    files: {
      proposal: readIfExists(path.join(dir, "proposal.md")),
      design: readIfExists(path.join(dir, "design.md")),
      tasks: readIfExists(path.join(dir, "tasks.md")),
      specs: specFiles,
    },
  };
}

export async function specDetail(id: string) {
  assertId(id);
  if (!existsSync(path.join(SPECS_DIR, id))) throw new Error(`No spec named "${id}"`);
  return run(["show", id, "--type", "spec"]);
}

export function validateAll() {
  return run(["validate", "--all"]);
}

export const openspecDir = path.join(WORKSPACE, "openspec");
