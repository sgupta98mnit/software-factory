import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
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

/** Local state: the audit log and Autopilot's ledger, worktrees and hidden tests. Git-ignored. */
export const DATA_DIR = path.resolve(process.env.SF_DATA_DIR ?? path.join(ROOT, "data"));

/** Autopilot's run ledger (SQLite): runs, work orders, agent attempts, checks, inbox. */
export const AUTOPILOT_DB = path.join(DATA_DIR, "autopilot.db");

/** Git worktrees Autopilot creates: one per run for the integration branch, one per work order. */
export const WORKTREES_DIR = path.join(DATA_DIR, "worktrees");

/** Hidden acceptance tests, kept outside every worktree so builders never see them. */
export const HIDDEN_TESTS_DIR = path.join(DATA_DIR, "hidden-tests");

/** Canvas's ingress; its /api/* reaches the OpenHands agent server that runs Autopilot's agents. */
export const AGENT_SERVER_URL = process.env.SF_AGENT_SERVER_URL ?? "http://127.0.0.1:8000";

/**
 * The agent server's session key, sent as X-Session-API-Key. Read on every call
 * so a Canvas restart with a new key needs no factory restart. Canvas's dev
 * launcher persists the key in ~/.openhands/agent-canvas/api-key.txt.
 */
export function agentServerKey(): string | undefined {
  const fromEnv = process.env.SF_AGENT_SERVER_KEY || process.env.LOCAL_BACKEND_API_KEY;
  if (fromEnv) return fromEnv;
  try {
    return readFileSync(path.join(homedir(), ".openhands", "agent-canvas", "api-key.txt"), "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * SF_REQUIRE_ISOLATION=1: never run agents or the code they write on this
 * machine itself, whatever a workspace's policy says. Read on every call.
 */
export const isolationRequired = () => /^(1|true|yes)$/i.test(process.env.SF_REQUIRE_ISOLATION ?? "");

export const PORT = Number(process.env.SF_PORT ?? 4317);

/** Bind to localhost only: agents run commands on this machine, so never expose this server. */
export const HOST = "127.0.0.1";

/** Who the local user is, for audit records. Real sign-in comes later. */
export const LOCAL_USER = `user:${process.env.SF_USER ?? process.env.USERNAME ?? process.env.USER ?? "local"}`;
