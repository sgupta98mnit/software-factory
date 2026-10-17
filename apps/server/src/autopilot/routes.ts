// Autopilot's HTTP API, mounted at /sf-api/autopilot. The response shapes are
// a contract with the Canvas pages (canvas/src/factory/api.ts): camelCase
// JSON, costs summed from attempts, nothing about prompts or keys.
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { LOCAL_USER } from "../config.js";
import type { Attempt, InboxItem, Run, WorkOrder } from "./ledger.js";
import type { Orchestrator } from "./orchestrator.js";
import { pinnedPolicy } from "./policy.js";

// Work-order states that count as in progress.
const ACTIVE_WO = new Set<string>(["building", "verifying", "reviewing", "ready", "awaiting_merge_approval", "merging"]);
const FINISHED_WO = new Set<string>(["merged", "skipped", "cancelled"]);

/** Dollars to a tenth of a cent: sums of float costs pick up noise (0.45999999999999996). */
const money = (usd: number) => Math.round(usd * 1000) / 1000;
const attemptView = ({ seenRunning: _s, lastSentAt: _l, ...a }: Attempt) => ({ ...a, costUsd: money(a.costUsd) });

/**
 * median(dispatch -> merged) of merged work orders times the rounds of work
 * left: each wave with unfinished work orders takes ceil(their number /
 * parallel) rounds. null until one has merged, and for a run that isn't building.
 */
function etaMs(state: string, workOrders: WorkOrder[], attempts: Attempt[], parallel: number): number | null {
  if (state !== "building") return null;
  const durations = workOrders
    .filter((w) => w.state === "merged")
    .map((w) => {
      const first = attempts.find((a) => a.workOrderId === w.id && a.role === "builder");
      return first ? Date.parse(w.updatedAt) - Date.parse(first.startedAt) : NaN;
    })
    .filter((d) => Number.isFinite(d))
    .sort((a, b) => a - b);
  if (!durations.length) return null;
  const mid = durations.length / 2;
  const median = durations.length % 2 ? (durations[Math.floor(mid)] ?? 0) : ((durations[mid - 1] ?? 0) + (durations[mid] ?? 0)) / 2;
  const perWave = new Map<number, number>();
  for (const w of workOrders) if (!FINISHED_WO.has(w.state)) perWave.set(w.wave, (perWave.get(w.wave) ?? 0) + 1);
  const rounds = [...perWave.values()].reduce((sum, n) => sum + Math.ceil(n / parallel), 0);
  return median * rounds;
}

export function createAutopilotRoutes(o: Orchestrator) {
  const { ledger } = o;
  const app = new Hono();

  // Errors come back as { error }: 404 for a missing run or item, 400 for everything else.
  app.onError((err, c) => c.json({ error: err.message }, err instanceof HTTPException ? err.status : 400));

  const body = async <T>(c: { req: { json: () => Promise<unknown> } }) => (await c.req.json().catch(() => ({}))) as T;
  /** An inbox item with what a person needs to place it: its run's change and the work order's key. */
  const inboxView = ({ notifiedAt: _n, ...item }: InboxItem) => {
    const seq = item.workOrderId ? ledger.getWorkOrder(item.workOrderId)?.seq : undefined;
    return { ...item, change: ledger.getRun(item.runId)?.change ?? null, workOrderKey: seq === undefined ? null : `WO-${seq}` };
  };
  const mustRun = (id: string) => {
    const run = ledger.getRun(id);
    if (!run) throw new HTTPException(404, { message: `No run ${id}` });
    return run;
  };

  function summary(run: Run) {
    const wos = ledger.listWorkOrders(run.id);
    const count = (state: string) => wos.filter((w) => w.state === state).length;
    return {
      id: run.id,
      goal: run.goal,
      change: run.change,
      autonomy: run.autonomy,
      state: run.state,
      pausedReason: run.pausedReason,
      baseBranch: run.baseBranch,
      integrationBranch: run.integrationBranch,
      costUsd: money(ledger.runCost(run.id)),
      budgetUsd: run.budgetUsd,
      policyHash: run.policyHash,
      createdBy: run.createdBy,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      counts: {
        total: wos.length,
        merged: count("merged"),
        active: wos.filter((w) => ACTIVE_WO.has(w.state)).length,
        failed: count("needs_attention"),
        pending: count("pending"),
      },
      openInbox: ledger.listInbox({ runId: run.id }).length,
    };
  }

  function workOrderView(wo: WorkOrder, attempts: Attempt[]) {
    const builds = attempts.filter((a) => a.workOrderId === wo.id && a.role === "builder");
    const last = builds.at(-1);
    return {
      id: wo.id,
      runId: wo.runId,
      seq: wo.seq,
      key: `WO-${wo.seq}`,
      title: wo.title,
      acceptance: wo.acceptance,
      controls: wo.controls,
      dependsOn: wo.dependsOn,
      wave: wo.wave,
      risk: wo.risk,
      state: wo.state,
      branch: wo.branch,
      costUsd: money(ledger.workOrderCost(wo.id)),
      attempts: builds.length,
      round: last?.turns ?? 0,
      conversationId: last?.conversationId ?? null,
      findings: wo.findings,
      mergedBy: wo.mergedBy,
      updatedAt: wo.updatedAt,
    };
  }

  app.get("/status", async (c) => c.json(await o.status()));

  app.get("/runs", (c) => c.json(ledger.listRuns().map(summary)));

  app.post("/runs", async (c) => {
    const b = await body<{ goal?: unknown; autonomy?: unknown; budgetUsd?: unknown }>(c);
    // createRun checks the values; these casts only satisfy the types.
    const run = await o.createRun({
      goal: b.goal as string,
      autonomy: (b.autonomy ?? undefined) as Run["autonomy"] | undefined,
      budgetUsd: b.budgetUsd as number | null | undefined,
      actor: LOCAL_USER,
    });
    return c.json(summary(run));
  });

  app.get("/runs/:id", (c) => {
    const run = mustRun(c.req.param("id"));
    const workOrders = ledger.listWorkOrders(run.id);
    const attempts = ledger.listAttempts({ runId: run.id });
    return c.json({
      ...summary(run),
      workOrders: workOrders.map((w) => workOrderView(w, attempts)),
      attempts: attempts.map(attemptView),
      checks: ledger.listChecks({ runId: run.id }),
      inbox: ledger.listInbox({ state: "all", runId: run.id }).map(inboxView),
      etaMs: etaMs(run.state, workOrders, attempts, pinnedPolicy(run).parallel),
    });
  });

  for (const action of ["pause", "resume", "cancel"] as const) {
    app.post(`/runs/:id/${action}`, async (c) => {
      const run = mustRun(c.req.param("id"));
      const { note } = await body<{ note?: unknown }>(c);
      const updated = await o[action](run.id, { note: typeof note === "string" ? note : null, actor: LOCAL_USER });
      return c.json(summary(updated));
    });
  }

  app.get("/inbox", (c) => {
    const s = c.req.query("state");
    const state = s === "decided" || s === "all" ? s : "open";
    return c.json(ledger.listInbox({ state }).map(inboxView));
  });

  app.get("/inbox/count", (c) => c.json({ open: ledger.openInboxCount() }));

  app.post("/inbox/:id/decide", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || !ledger.getInbox(id)) throw new HTTPException(404, { message: `No inbox item ${c.req.param("id")}` });
    const { choice, note } = await body<{ choice?: unknown; note?: unknown }>(c);
    if (typeof choice !== "string") throw new Error("Send a choice.");
    if (note != null && typeof note !== "string") throw new Error("The note must be text.");
    return c.json(inboxView(await o.decide(id, { choice, note: note as string | null | undefined }, LOCAL_USER)));
  });

  return app;
}
