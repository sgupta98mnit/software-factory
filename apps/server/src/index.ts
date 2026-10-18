// The factory API that the Canvas pages call, under /sf-api. Canvas's dev
// server proxies /sf-api here, so the browser only ever talks to Canvas.
// Agents themselves run in Canvas (OpenHands agent server), not here.
import { existsSync, watch } from "node:fs";
import path from "node:path";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { audit, listAudit, verifyAudit } from "./audit.js";
import { authConfigFromEnv, createAuth, Forbidden, requireRole, Unauthenticated } from "./auth.js";
import { openLedger } from "./autopilot/ledger.js";
import { OpenHandsClient } from "./autopilot/openhands.js";
import { createOrchestrator } from "./autopilot/orchestrator.js";
import { createAutopilotRoutes } from "./autopilot/routes.js";
import { getWorkOrder, linkConversation, listWorkOrders, setStatus, watchBacklog } from "./backlog.js";
import { changeBrief, workOrderBrief } from "./briefs.js";
import {
  AGENT_SERVER_URL,
  AGENT_WORKSPACE,
  AUTOPILOT_DB,
  DATA_DIR,
  HOST,
  LOCAL_USER,
  PORT,
  WORKSPACE,
  agentServerKey,
} from "./config.js";
import { broadcast, eventStream } from "./events.js";
import { assertChange, changeDetail, openspecDir, overview, specDetail, validateAll } from "./openspec.js";
import { createWorkOrders, planWorkOrders } from "./planner.js";
import { tools } from "./tools.js";

const app = new Hono().basePath("/sf-api");

// Errors come back as { error } so the UI can show the message: 401 to sign in, 403 for a missing role, else 400.
app.onError((err, c) => c.json({ error: err.message }, err instanceof Unauthenticated ? 401 : err instanceof Forbidden ? 403 : 400));

// Only answer requests addressed to this machine (blocks DNS-rebinding), and
// only accept JSON for changes (a cross-site form can't send it without CORS).
app.use("*", async (c, next) => {
  const host = (c.req.header("host") ?? "").replace(/:\d+$/, "");
  if (!["127.0.0.1", "localhost", "[::1]"].includes(host)) return c.json({ error: "Forbidden host" }, 403);
  if (c.req.method !== "GET" && !(c.req.header("content-type") ?? "").includes("application/json")) {
    return c.json({ error: "Send JSON" }, 415);
  }
  await next();
});

const body = async <T>(c: { req: { json: () => Promise<unknown> } }) => (await c.req.json().catch(() => ({}))) as T;

// Sign-in: this machine's user with every role (SF_AUTH=local, the default), or the agency's identity provider.
const ledger = openLedger(AUTOPILOT_DB);
const auth = createAuth(authConfigFromEnv(process.env, LOCAL_USER), ledger);
app.use("*", auth.middleware);
app.route("/auth", auth.routes);

app.get("/health", (c) =>
  c.json({
    workspace: { name: path.basename(WORKSPACE), path: WORKSPACE, agentPath: AGENT_WORKSPACE, exists: existsSync(WORKSPACE) },
    user: auth.principal(c)?.actor ?? LOCAL_USER,
    auth: auth.mode,
    versions: { openspec: tools.openspec.version, backlog: tools.backlog.version },
  }),
);
app.get("/events", (c) => eventStream(c));

// ---- requirements (OpenSpec) ----
app.get("/specs", async (c) => c.json(await overview()));
app.get("/specs/changes/:id", async (c) => c.json(await changeDetail(c.req.param("id"))));
app.get("/specs/specs/:id", async (c) => c.json(await specDetail(c.req.param("id"))));
app.post("/specs/validate", async (c) => {
  const actor = requireRole(c, "engineer").actor;
  const result = await validateAll();
  await audit(actor, "specs.validated", "openspec", { summary: (result as { summary?: unknown }).summary });
  return c.json(result);
});
app.get("/specs/changes/:id/brief/:purpose", (c) => {
  const purpose = c.req.param("purpose") === "review" ? "review" : "plan";
  assertChange(c.req.param("id"));
  return c.json({ text: changeBrief(c.req.param("id"), purpose) });
});

app.post("/specs/changes/:id/conversations", async (c) => {
  const id = c.req.param("id");
  assertChange(id);
  const { conversationId, agent } = await body<{ conversationId: string; agent?: string }>(c);
  if (!/^[\w-]{1,100}$/.test(conversationId ?? "")) throw new Error("Invalid conversation id");
  await audit(requireRole(c, "engineer").actor, "change.conversation_started", `change:${id}`, { conversationId, agent: agent ?? "" });
  return c.json({ ok: true });
});

// ---- work orders (Backlog.md) ----
app.get("/specs/changes/:id/work-order-plan", (c) => c.json(planWorkOrders(c.req.param("id"))));
app.post("/specs/changes/:id/work-orders", async (c) => c.json(await createWorkOrders(c.req.param("id"), requireRole(c, "engineer").actor)));
app.get("/workorders", (c) => c.json(listWorkOrders()));
app.get("/workorders/:id", (c) => c.json(getWorkOrder(c.req.param("id"))));
app.get("/workorders/:id/brief", (c) => c.json(workOrderBrief(c.req.param("id"))));
app.post("/workorders/:id/status", async (c) => {
  const { status, approve, note } = await body<{ status: string; approve?: boolean; note?: string }>(c);
  // Approving a work order is an approver's decision; moving it along is an engineer's.
  const actor = requireRole(c, approve ? "approver" : "engineer").actor;
  await setStatus(c.req.param("id"), status, actor, { approve, note: note?.trim() || undefined });
  return c.json({ ok: true });
});
app.post("/workorders/:id/conversations", async (c) => {
  const { conversationId, agent } = await body<{ conversationId: string; agent?: string }>(c);
  await linkConversation(c.req.param("id"), conversationId, agent ?? "", requireRole(c, "engineer").actor);
  return c.json({ ok: true });
});

// ---- audit ----
app.get("/audit", (c) => c.json(listAudit()));
app.get("/audit/verify", (c) => c.json(verifyAudit()));

// ---- autopilot: goal -> spec -> plan -> build, with agents on the OpenHands agent server ----
const autopilot = createOrchestrator({
  ledger,
  client: new OpenHandsClient({ baseUrl: AGENT_SERVER_URL, apiKey: agentServerKey }),
  workspace: WORKSPACE,
  dataDir: DATA_DIR,
  // Agents in containers must not reach this API or Canvas on this machine.
  controlPorts: [PORT, Number(new URL(AGENT_SERVER_URL).port) || 80],
});
app.route("/autopilot", createAutopilotRoutes(autopilot));

watchBacklog();
try {
  let t: NodeJS.Timeout | undefined;
  watch(openspecDir, { recursive: true }, () => {
    clearTimeout(t);
    t = setTimeout(() => broadcast({ type: "specs.changed" }), 300);
  });
} catch {
  console.warn(`[specs] not watching: ${openspecDir} not found`);
}

serve({ fetch: app.fetch, port: PORT, hostname: HOST }, () => {
  console.log(`Factory API on http://${HOST}:${PORT}/sf-api`);
  console.log(`Workspace: ${WORKSPACE}${existsSync(WORKSPACE) ? "" : "  (missing!)"}`);
  autopilot.start(3000);
});
void audit("system", "server.started", "server", { workspace: path.basename(WORKSPACE) });

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    autopilot.stop();
    ledger.close();
    process.exit(0);
  });
}
