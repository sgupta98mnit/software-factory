import { existsSync } from "node:fs";
import path from "node:path";

/** Walk up from this file to the repo root (the folder with pnpm-workspace.yaml). */
function findRoot(start: string): string {
  let dir = start;
  for (;;) {
    if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

export const ROOT = findRoot(import.meta.dirname);
export const SERVER_DIR = path.resolve(import.meta.dirname, "..");

/** The repo the agents work in. It holds openspec/ (requirements) and backlog/ (work orders). */
export const WORKSPACE = path.resolve(
  process.env.SF_WORKSPACE ?? path.join(ROOT, "workspaces", "benefits-portal"),
);

/**
 * The same folder as the agent server sees it. Usually identical; set it when
 * agents run in a Docker sandbox that mounts the workspace somewhere else
 * (for example /projects/benefits-portal).
 */
export const AGENT_WORKSPACE = process.env.SF_AGENT_WORKSPACE ?? WORKSPACE;

/** Local state: the audit log. Git-ignored. */
export const DATA_DIR = path.resolve(process.env.SF_DATA_DIR ?? path.join(ROOT, "data"));

export const PORT = Number(process.env.SF_PORT ?? 4317);

/** Bind to localhost only: agents run commands on this machine, so never expose this server. */
export const HOST = "127.0.0.1";

/** Who the local user is, for audit records. Real sign-in comes later. */
export const LOCAL_USER = `user:${process.env.SF_USER ?? process.env.USERNAME ?? process.env.USER ?? "local"}`;
