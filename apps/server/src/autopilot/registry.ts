// Several projects in one factory. The workspace the factory starts with
// (SF_WORKSPACE) is "default" and keeps its ledger where it always was; each
// workspace registered since gets a folder of its own under
// data/workspaces/<id>/ (ledger, worktrees, hidden tests, previews) and an
// orchestrator of its own, so each keeps to the policy on its own base
// branch. They share the agent server, the factory-wide gate slots and the
// one audit chain. The list lives in data/workspaces.json.
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { audit } from "../audit.js";
import { openLedger } from "./ledger.js";
import type { OpenHandsClient } from "./openhands.js";
import { createOrchestrator, type Orchestrator } from "./orchestrator.js";
import { createAutopilotRoutes } from "./routes.js";

export interface WorkspaceEntry {
  id: string;
  name: string;
  path: string;
  addedBy: string;
  addedAt: string;
}

interface Workspace {
  entry: WorkspaceEntry;
  orchestrator: Orchestrator;
  routes: Hono;
}

const TERMINAL = new Set(["done", "released", "failed", "cancelled"]);

/** "Benefits Portal" -> "benefits-portal". */
const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

export function createRegistry(deps: { dataDir: string; client: OpenHandsClient; defaultEntry: Omit<WorkspaceEntry, "id">; defaultOrchestrator: Orchestrator }) {
  const file = path.join(deps.dataDir, "workspaces.json");
  const spaces = new Map<string, Workspace>();
  let interval: number | null = null;

  const open = (entry: WorkspaceEntry): Workspace => {
    const dir = path.join(deps.dataDir, "workspaces", entry.id);
    mkdirSync(dir, { recursive: true });
    const orchestrator = createOrchestrator({ ledger: openLedger(path.join(dir, "autopilot.db")), client: deps.client, workspace: entry.path, dataDir: dir });
    return { entry, orchestrator, routes: createAutopilotRoutes(orchestrator) };
  };

  const save = () => {
    const list = [...spaces.values()].map((w) => w.entry).filter((e) => e.id !== "default");
    mkdirSync(deps.dataDir, { recursive: true });
    writeFileSync(`${file}.tmp`, `${JSON.stringify(list, null, 2)}\n`);
    renameSync(`${file}.tmp`, file); // never half a file
  };

  spaces.set("default", { entry: { id: "default", ...deps.defaultEntry }, orchestrator: deps.defaultOrchestrator, routes: createAutopilotRoutes(deps.defaultOrchestrator) });
  if (existsSync(file)) {
    const list = JSON.parse(readFileSync(file, "utf8")) as WorkspaceEntry[];
    for (const entry of list) if (entry.id !== "default" && !spaces.has(entry.id)) spaces.set(entry.id, open(entry));
  }

  const status = (w: Workspace) => {
    const runs = w.orchestrator.ledger.listRuns();
    return {
      ...w.entry,
      default: w.entry.id === "default",
      exists: existsSync(w.entry.path),
      activeRuns: runs.filter((r) => !TERMINAL.has(r.state)).length,
      queuedRuns: runs.filter((r) => r.state === "queued").length,
      openInbox: w.orchestrator.ledger.openInboxCount(),
    };
  };

  return {
    get: (id: string) => spaces.get(id),
    list: () => [...spaces.values()].map(status),
    all: () => [...spaces.values()],

    /** A new project. Its folder must exist; it becomes a git repo with its first run, like the default. */
    async add(input: { name?: unknown; path?: unknown }, actor: string) {
      const name = typeof input.name === "string" ? input.name.trim() : "";
      const where = typeof input.path === "string" ? input.path.trim() : "";
      const id = slug(name);
      if (!name || name.length > 60 || !id) throw new Error("Give the workspace a name (1 to 60 characters, with a letter or digit).");
      if (id === "default" || spaces.has(id)) throw new Error(`There's already a workspace called "${id}".`);
      if (!path.isAbsolute(where)) throw new Error("The path must be absolute (the folder on this machine).");
      if (!existsSync(where) || !statSync(where).isDirectory()) throw new Error(`${where} isn't a folder on this machine.`);
      const target = real(where);
      const data = real(deps.dataDir);
      if (target === data || target.startsWith(`${data}${path.sep}`) || data.startsWith(`${target}${path.sep}`)) throw new Error("A workspace can't be inside the factory's data folder, or contain it.");
      const taken = [...spaces.values()].find((w) => real(w.entry.path) === target);
      if (taken) throw new Error(`That folder is already the workspace "${taken.entry.name}".`);
      const entry: WorkspaceEntry = { id, name, path: target, addedBy: actor, addedAt: new Date().toISOString() };
      const w = open(entry);
      spaces.set(id, w);
      save();
      if (interval) w.orchestrator.start(interval);
      await audit(actor, "workspace.registered", `workspace:${id}`, { name, path: target });
      return status(w);
    },

    /** Off the list (its data folder stays). Not while it has runs that aren't finished. */
    async remove(id: string, actor: string) {
      const w = spaces.get(id);
      if (!w) throw new HTTPException(404, { message: `No workspace "${id}"` });
      if (id === "default") throw new Error("The default workspace is the one the factory started with (SF_WORKSPACE); it can't be removed.");
      const active = w.orchestrator.ledger.listRuns().filter((r) => !TERMINAL.has(r.state));
      if (active.length) throw new Error(`"${w.entry.name}" has ${active.length} run(s) that aren't finished. Finish or cancel them first.`);
      w.orchestrator.stop();
      await w.orchestrator.idle();
      w.orchestrator.ledger.close();
      spaces.delete(id);
      save();
      await audit(actor, "workspace.removed", `workspace:${id}`, { name: w.entry.name, path: w.entry.path });
    },

    start(intervalMs: number) {
      interval = intervalMs;
      for (const w of spaces.values()) w.orchestrator.start(intervalMs);
    },
    async stop() {
      interval = null;
      for (const w of spaces.values()) w.orchestrator.stop();
      await Promise.all([...spaces.values()].map((w) => w.orchestrator.idle()));
      for (const w of spaces.values()) if (w.entry.id !== "default") w.orchestrator.ledger.close();
    },
  };
}

export type Registry = ReturnType<typeof createRegistry>;

/**
 * /workspaces: the list, add and remove, and one Inbox across them; and
 * /w/:id/autopilot/*, which is that workspace's Autopilot API (the same as
 * /autopilot for the default one).
 */
export function createRegistryRoutes(registry: Registry, actor: string) {
  const app = new Hono();
  app.onError((err, c) => c.json({ error: err.message }, err instanceof HTTPException ? err.status : 400));

  app.get("/workspaces", (c) => c.json(registry.list()));
  app.post("/workspaces", async (c) => c.json(await registry.add((await c.req.json().catch(() => ({}))) as { name?: unknown; path?: unknown }, actor), 201));
  app.delete("/workspaces/:id", async (c) => {
    await registry.remove(c.req.param("id"), actor);
    return c.json({ ok: true });
  });

  // Every workspace's decisions in one list, each with the workspace it belongs to.
  app.get("/workspaces/inbox", async (c) => {
    const state = c.req.query("state") ?? "open";
    const lists = await Promise.all(
      registry.all().map(async (w) => {
        const items = (await (await w.routes.request(`/inbox?state=${encodeURIComponent(state)}`)).json()) as Record<string, unknown>[];
        return items.map((item) => ({ ...item, createdAt: String(item.createdAt ?? ""), workspace: { id: w.entry.id, name: w.entry.name } }));
      }),
    );
    return c.json(lists.flat().sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  });
  app.get("/workspaces/inbox/count", (c) => c.json({ open: registry.list().reduce((n, w) => n + w.openInbox, 0) }));

  app.all("/w/:ws/autopilot/*", async (c) => {
    const w = registry.get(c.req.param("ws"));
    if (!w) throw new HTTPException(404, { message: `No workspace "${c.req.param("ws")}"` });
    const url = new URL(c.req.url);
    url.pathname = url.pathname.replace(/^.*?\/w\/[^/]+\/autopilot/, "") || "/";
    const method = c.req.method;
    const body = method === "GET" || method === "HEAD" ? undefined : await c.req.arrayBuffer();
    return w.routes.fetch(new Request(url, { method, headers: c.req.raw.headers, body }));
  });
  return app;
}
