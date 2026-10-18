// Autopilot's HTTP API, mounted at /sf-api/autopilot. The response shapes are
// a contract with the Canvas pages (canvas/src/factory/api.ts): camelCase
// JSON, costs summed from attempts, nothing about prompts or keys.
import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { Forbidden, principalOf, ROLES, Unauthenticated, type Principal, type Role } from "../auth.js";
import { LOCAL_USER } from "../config.js";
import { EvidenceConflict } from "./evidence.js";
import { StaleWorker, type Attempt, type Check, type InboxItem, type InboxKind, type Run, type WorkOrder } from "./ledger.js";
import { Standby, type Delivery, type Orchestrator, type Release, type Verification } from "./orchestrator.js";
import { pinnedPolicy } from "./policy.js";

// Work-order states that count as in progress.
const ACTIVE_WO = new Set<string>(["building", "verifying", "reviewing", "ready", "awaiting_control_approval", "awaiting_merge_approval", "merging"]);
const FINISHED_WO = new Set<string>(["merged", "skipped", "cancelled"]);

/** `execution`: where the attempt ran (ExecutionFacts); null for attempts from before isolation. */
const attemptView = ({ seenRunning: _s, lastSentAt: _l, runtime, ...a }: Attempt) => ({ ...a, execution: runtime ?? null });
/** A scan baseline's finding keys stay in the ledger: they can be thousands, and the page shows counts. */
const checkView = (c: Check) => {
  const { keys: _k, ...meta } = (c.meta ?? {}) as Record<string, unknown>;
  return { ...c, meta: c.meta == null ? null : meta };
};
const inboxView = ({ notifiedAt: _n, ...item }: InboxItem) => item;

/** median(dispatch -> merged) of merged work orders x the waves of work left; null until one has merged. */
function etaMs(workOrders: WorkOrder[], attempts: Attempt[], parallel: number): number | null {
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
  const remaining = workOrders.filter((w) => !FINISHED_WO.has(w.state)).length;
  return median * Math.ceil(remaining / parallel);
}

/**
 * How the run verifies work: where its checks came from (null for runs from
 * before pinning), its hidden tests (off, pending until the test writer is
 * done, or how many) and its scanner mode.
 */
function verificationView(run: Run) {
  const v = run.verification as Verification | null;
  const policy = pinnedPolicy(run);
  return {
    pinned: v?.source ?? null,
    gates: (v?.gates ?? []).map((g) => g.name),
    hiddenTests: !v || !policy.hiddenTests.enabled ? "off" : (v.hiddenTests?.files.length ?? "pending"),
    scan: v ? policy.verification.trivy.mode : "off",
  };
}

/** The delivered pull request and CI on its pushed head; null unless the run delivers. */
function deliveryView(run: Run) {
  const d = run.delivery as Delivery | null;
  if (!d) return null;
  return { repository: d.repository, status: d.status, pushedSha: d.pushedSha, pr: d.pr, checks: d.checks, approvals: d.approvals, repairs: d.repairs, blocked: d.blocked };
}

/** Who decides each kind of Inbox item. Merge approvals can't stand in for an ISSO's, nor a person's for release. */
export const DECIDES: Record<InboxKind, Role> = {
  spec_approval: "approver",
  plan_approval: "approver",
  merge_approval: "approver",
  budget_reached: "approver",
  control_approval: "isso",
  release: "release_manager",
  questions: "engineer",
  spec_failed: "engineer",
  work_order_failed: "engineer",
  run_paused: "engineer",
  error: "engineer",
  undelivered: "engineer",
  delivery: "engineer",
};

// Mounted without the sign-in middleware (tests), the routes act for this machine's user with every role.
const LOCAL: Principal = { actor: LOCAL_USER, name: LOCAL_USER.replace(/^user:/, ""), roles: [...ROLES], mode: "local" };

export function createAutopilotRoutes(o: Orchestrator) {
  const { ledger } = o;
  const app = new Hono();

  // Errors: 404 for missing records, 409 for unavailable evidence or another process running Autopilot, otherwise 400.
  const conflict = (err: Error) => err instanceof EvidenceConflict || err instanceof Standby || err instanceof StaleWorker;
  const status = (err: Error) =>
    err instanceof HTTPException ? err.status : err instanceof Unauthenticated ? 401 : err instanceof Forbidden ? 403 : conflict(err) ? 409 : 400;
  app.onError((err, c) => c.json({ error: err.message }, status(err)));

  /** The person acting; with `role`, they must hold it. */
  const who = (c: Context, role?: Role): Principal => {
    const p = principalOf(c) ?? LOCAL;
    if (role && !p.roles.includes(role)) throw new Forbidden(`This needs the ${role} role; ${p.name} has ${p.roles.length ? p.roles.join(", ") : "none"}.`);
    return p;
  };

  const body = async <T>(c: { req: { json: () => Promise<unknown> } }) => (await c.req.json().catch(() => ({}))) as T;

  // A repeated Idempotency-Key gets the first answer, so a client that retries after a lost response
  // doesn't start a second run or decide twice. Kept a day in the ledger.
  const keyed = new Map<string, { route: string; answer: Promise<unknown> }>();
  async function once(c: Context, route: string, fn: () => Promise<unknown>) {
    const key = c.req.header("idempotency-key");
    if (!key) return c.json(await fn());
    if (!/^[A-Za-z0-9_-]{8,200}$/.test(key)) throw new Error("Idempotency-Key must be 8 to 200 letters, digits, - or _.");
    const stored = ledger.recallRequest(key);
    const inflight = keyed.get(key);
    const usedFor = stored?.route ?? inflight?.route;
    if (usedFor && usedFor !== route) throw new Error("This Idempotency-Key was already used for another request.");
    if (stored) return c.json(stored.response);
    if (inflight) return c.json(await inflight.answer);
    const answer = fn().then((response) => {
      ledger.rememberRequest(key, route, response);
      return response;
    });
    keyed.set(key, { route, answer });
    try {
      return c.json(await answer);
    } finally {
      keyed.delete(key);
    }
  }

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
      costUsd: ledger.runCost(run.id),
      budgetUsd: run.budgetUsd,
      policyHash: run.policyHash,
      execution: { provider: pinnedPolicy(run).execution.provider, isolated: pinnedPolicy(run).execution.provider === "container" },
      verification: verificationView(run),
      delivery: deliveryView(run),
      release: (run.release as Release | null) ?? null,
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
      costUsd: ledger.workOrderCost(wo.id),
      attempts: builds.length,
      round: last?.turns ?? 0,
      conversationId: last?.conversationId ?? null,
      findings: wo.findings,
      source: wo.source,
      mergedBy: wo.mergedBy,
      updatedAt: wo.updatedAt,
    };
  }

  app.get("/status", async (c) => c.json(await o.status()));

  // The checks a run started now would face, including a probe container when the policy isolates execution.
  app.post("/execution/preflight", async (c) => c.json(await o.checkExecution(who(c, "engineer").actor)));

  app.get("/runs", (c) => c.json(ledger.listRuns().map(summary)));

  app.post("/runs", async (c) => {
    const actor = who(c, "engineer").actor;
    const b = await body<{ goal?: unknown; autonomy?: unknown; budgetUsd?: unknown }>(c);
    // createRun checks the values; these casts only satisfy the types.
    return once(c, "POST /runs", async () =>
      summary(
        await o.createRun({
          goal: b.goal as string,
          autonomy: (b.autonomy ?? undefined) as Run["autonomy"] | undefined,
          budgetUsd: b.budgetUsd as number | null | undefined,
          actor,
        }),
      ),
    );
  });

  app.get("/runs/:id", (c) => {
    const run = mustRun(c.req.param("id"));
    const workOrders = ledger.listWorkOrders(run.id);
    const attempts = ledger.listAttempts({ runId: run.id });
    return c.json({
      ...summary(run),
      workOrders: workOrders.map((w) => workOrderView(w, attempts)),
      attempts: attempts.map(attemptView),
      checks: ledger.listChecks({ runId: run.id }).map(checkView),
      inbox: ledger.listInbox({ state: "all", runId: run.id }).map(inboxView),
      etaMs: etaMs(workOrders, attempts, pinnedPolicy(run).parallel),
    });
  });

  app.post("/runs/:id/evidence", async (c) => {
    const run = mustRun(c.req.param("id"));
    c.header("Cache-Control", "no-store");
    return c.json(await o.evidence(run.id, who(c).actor));
  });

  for (const action of ["pause", "resume", "cancel"] as const) {
    app.post(`/runs/:id/${action}`, async (c) => {
      const run = mustRun(c.req.param("id"));
      const actor = who(c, "engineer").actor;
      const { note } = await body<{ note?: unknown }>(c);
      return once(c, `POST /runs/${run.id}/${action}`, async () => summary(await o[action](run.id, { note: typeof note === "string" ? note : null, actor })));
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
    const item = Number.isInteger(id) ? ledger.getInbox(id) : undefined;
    if (!item) throw new HTTPException(404, { message: `No inbox item ${c.req.param("id")}` });
    const p = who(c, DECIDES[item.kind] ?? "engineer");
    const { choice, note } = await body<{ choice?: unknown; note?: unknown }>(c);
    if (typeof choice !== "string") throw new Error("Send a choice.");
    if (note != null && typeof note !== "string") throw new Error("The note must be text.");
    return once(c, `POST /inbox/${id}/decide`, async () => inboxView(await o.decide(id, { choice, note: note as string | null | undefined }, p.actor, p.roles)));
  });

  return app;
}
