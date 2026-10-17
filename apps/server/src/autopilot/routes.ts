// Autopilot's HTTP API, mounted at /sf-api/autopilot. The response shapes are
// a contract with the Canvas pages (canvas/src/factory/api.ts): camelCase
// JSON, costs summed from attempts, nothing about prompts or keys.
import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { LOCAL_USER } from "../config.js";
import type { Attempt, InboxItem, Run, WorkOrder } from "./ledger.js";
import type { Orchestrator } from "./orchestrator.js";
import { pinnedPolicy } from "./policy.js";
import { buildEvidence } from "./evidence.js";
import { audit, listAudit } from "../audit.js";
import { buildInsights } from "./learning.js";
import { INTAKE_SOURCES, signatureOk, type IntakeSource } from "./intake.js";

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

/**
 * What the change will have cost when it's done: spent so far, plus the
 * average of merged work orders for each one still to finish. null until one
 * has merged, and once the run isn't building.
 */
function projectedCost(state: string, workOrders: WorkOrder[], spent: number, costOf: (id: string) => number): number | null {
  if (state !== "building") return null;
  const merged = workOrders.filter((w) => w.state === "merged");
  if (!merged.length) return null;
  const average = merged.reduce((sum, w) => sum + costOf(w.id), 0) / merged.length;
  const left = workOrders.filter((w) => !FINISHED_WO.has(w.state));
  const leftSpent = left.reduce((sum, w) => sum + costOf(w.id), 0);
  return money(spent + Math.max(0, left.length * average - leftSpent));
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
      // The budget that applies: the run's own, or the policy's per change.
      budgetUsd: run.budgetUsd ?? pinnedPolicy(run).budget.perChangeUsd,
      budgetSource: run.budgetUsd === null ? "policy" : "run",
      policyHash: run.policyHash,
      releasedBy: run.releasedBy,
      releasedSha: run.releasedSha,
      releasedAt: run.releasedAt,
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
      // Its place in line while queued; the change whose release goes first while releasing.
      ...o.waitingOn(run),
      origin: run.origin,
      // A spec change under way, or a new plan waiting for a person (no paths).
      revision: run.revision ? { stage: run.revision.stage, note: run.revision.note, requestedBy: run.revision.requestedBy, requestedAt: run.revision.requestedAt } : null,
    };
  }

  /** The run's hidden acceptance tests and how each last ran (for people; builders never see this page). */
  function hiddenView(runId: string) {
    const checks = ledger.listChecks({ runId }).filter((c) => c.name.startsWith("hidden:"));
    return ledger.listHiddenTests(runId).map((t) => {
      const runs = checks.filter((c) => c.name === `hidden:${t.file}`);
      const last = runs.at(-1);
      return { file: t.file, scenario: t.scenario, requirement: t.requirement, requires: t.requires, sha256: t.sha256, runs: runs.length, lastOk: last ? last.ok : null, lastAt: last?.at ?? null };
    });
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
      budgetUsd: money(pinnedPolicy(ledger.getRun(wo.runId) ?? { policy: null }).budget.perWorkOrderUsd + wo.budgetExtraUsd),
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
      hiddenTests: hiddenView(run.id),
      etaMs: etaMs(run.state, workOrders, attempts, pinnedPolicy(run).parallel),
      projectedCostUsd: projectedCost(run.state, workOrders, ledger.runCost(run.id), (id) => ledger.workOrderCost(id)),
      preview: run.preview,
    });
  });

  // A screenshot from the run's preview (only names the preview recorded).
  app.get("/runs/:id/preview/:file", (c) => {
    const run = mustRun(c.req.param("id"));
    const file = o.previewFile(run.id, c.req.param("file"));
    if (!file) throw new HTTPException(404, { message: "No such screenshot" });
    return c.body(readFileSync(file), 200, { "content-type": "image/png", "cache-control": "private, max-age=3600" });
  });

  for (const action of ["pause", "resume", "cancel"] as const) {
    app.post(`/runs/:id/${action}`, async (c) => {
      const run = mustRun(c.req.param("id"));
      const { note } = await body<{ note?: unknown }>(c);
      const updated = await o[action](run.id, { note: typeof note === "string" ? note : null, actor: LOCAL_USER });
      return c.json(summary(updated));
    });
  }

  // Requests from outside: GitHub's issues webhook and other systems' signed JSON (through a relay: this API is
  // on 127.0.0.1), and Home's bug form. The policy decides what each becomes (intake.ts).
  // The limit while reading (Content-Length, or counted as it streams in), not after: a chunked body never sits in memory whole.
  const limit = bodyLimit({ maxSize: 512_000, onError: (c) => c.json({ error: "The request is too large." }, 413) });
  app.post("/intake/:source", limit, async (c) => {
    const source = c.req.param("source") as IntakeSource;
    if (!INTAKE_SOURCES.includes(source)) throw new HTTPException(404, { message: `No intake source "${source}" (one of: ${INTAKE_SOURCES.join(", ")})` });
    const raw = await c.req.text();
    const secret = source === "github" ? process.env.SF_INTAKE_GITHUB_SECRET : source === "webhook" ? process.env.SF_INTAKE_SECRET : undefined;
    const header = source === "github" ? c.req.header("x-hub-signature-256") : c.req.header("x-sf-signature");
    if (source !== "bug" && !signatureOk(secret, raw, header)) {
      const reason = secret ? "bad or missing signature" : `${source === "github" ? "SF_INTAKE_GITHUB_SECRET" : "SF_INTAKE_SECRET"} isn't set`;
      await audit(`intake:${source}`, "autopilot.intake_rejected", `intake:${source}`, { reason });
      return c.json({ error: `Rejected: ${reason}.` }, 401);
    }
    const event = c.req.header("x-github-event");
    if (source === "github" && event === "ping") return c.json({ ok: true });
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      return c.json({ error: "The body must be JSON." }, 400);
    }
    // Signed sources act as themselves; the bug form is the person using Canvas.
    const result = await o.intake({ source, payload, event }, source === "bug" ? LOCAL_USER : `intake:${source}`);
    return c.json({ outcome: result.outcome, reason: result.reason ?? null, run: result.run ? summary(result.run) : null }, result.outcome === "duplicate" || result.outcome === "ignored" ? 200 : 202);
  });

  // Scenario <-> hidden test <-> work order <-> approval, for assessors. ?download=1 saves it as a file (and says so in the audit log).
  app.get("/runs/:id/evidence", async (c) => {
    const run = mustRun(c.req.param("id"));
    const evidence = await buildEvidence(ledger, o.workspace, run);
    if (c.req.query("download")) {
      await audit(LOCAL_USER, "autopilot.evidence_exported", run.id, { change: run.change, scenarios: evidence.traceability.length, workOrders: evidence.workOrders.length });
      c.header("Content-Disposition", `attachment; filename="evidence-${run.change}-${run.id}.json"`);
    }
    return c.json(evidence);
  });

  app.post("/runs/:id/release", async (c) => {
    const run = mustRun(c.req.param("id"));
    return c.json(summary(await o.release(run.id, LOCAL_USER)));
  });

  // Change the spec while the run is building: a spec agent revises it, then the plan follows (re-plan).
  app.post("/runs/:id/revise", async (c) => {
    const run = mustRun(c.req.param("id"));
    const { note } = await body<{ note?: string }>(c);
    return c.json(summary(await o.reviseSpec(run.id, note ?? "", LOCAL_USER)));
  });

  // What the factory has learned: per policy hash, how its merge rules fared; and the AGENTS.md lessons.
  app.get("/insights", (c) => c.json(buildInsights(ledger, listAudit(Number.MAX_SAFE_INTEGER))));
  app.get("/lessons", (c) => c.json(ledger.listLessons()));

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
