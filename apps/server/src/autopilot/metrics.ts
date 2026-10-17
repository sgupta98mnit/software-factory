// How the factory is doing, for the Metrics page: how long a change takes
// from goal to release, how much of the work the policy merged without a
// person, what a change costs, and what goes wrong most often. Computed from
// the ledger and the audit log for runs started in the window; nothing is
// stored. The per-policy view (learning.ts) comes along, so a team can see
// which rules earn their keep.
import type { AuditEvent } from "../audit.js";
import { buildInsights, type PolicyInsight } from "./learning.js";
import type { Ledger, Run } from "./ledger.js";

export interface Metrics {
  window: { days: number; from: string; to: string };
  runs: { started: number; released: number; done: number; failed: number; cancelled: number; active: number };
  /** Goal to release, and goal to ready (done or released): median and 90th percentile, in ms. */
  leadTime: { toRelease: Spread; toReady: Spread };
  autonomy: {
    merged: number;
    byPolicy: number;
    byPerson: number;
    /** Share of merged work orders the policy merged by itself (null with none merged). */
    rate: number | null;
    /** Finished runs where no person decided anything but the release. */
    runsWithoutPeople: number;
    /** Decisions people made in the Inbox. */
    personDecisions: number;
  };
  cost: { totalUsd: number; perChangeUsd: number | null; perMergedWorkOrderUsd: number | null };
  failures: { reason: string; count: number }[];
  policies: PolicyInsight[];
}

export interface Spread {
  medianMs: number | null;
  p90Ms: number | null;
  samples: number;
}

const DAY = 86_400_000;
const money = (usd: number) => Math.round(usd * 100) / 100;

function spread(values: number[]): Spread {
  const v = values.filter((x) => Number.isFinite(x) && x >= 0).sort((a, b) => a - b);
  if (!v.length) return { medianMs: null, p90Ms: null, samples: 0 };
  const at = (q: number) => v[Math.min(v.length - 1, Math.ceil(q * v.length) - 1)] ?? null;
  return { medianMs: at(0.5), p90Ms: at(0.9), samples: v.length };
}

export function computeMetrics(ledger: Ledger, events: AuditEvent[], opts: { days?: number; now?: Date } = {}): Metrics {
  const days = Math.max(1, Math.min(365, Math.round(opts.days ?? 30)));
  const now = opts.now ?? new Date();
  const from = new Date(now.getTime() - days * DAY).toISOString();
  const runs = ledger.listRuns().filter((r) => r.createdAt >= from);
  const ids = new Set(runs.map((r) => r.id));
  const byRun = new Map<string, AuditEvent[]>();
  for (const e of events) {
    if (!ids.has(e.subject)) continue;
    const list = byRun.get(e.subject);
    if (list) list.push(e);
    else byRun.set(e.subject, [e]);
  }
  for (const list of byRun.values()) list.sort((a, b) => a.seq - b.seq);
  const eventsOf = (run: Run) => byRun.get(run.id) ?? [];
  const when = (run: Run, action: string) => eventsOf(run).find((e) => e.action === action)?.at;

  // Lead time: from the run's creation to its release, or to the moment it was ready to release.
  const toRelease = runs.filter((r) => r.releasedAt).map((r) => Date.parse(r.releasedAt as string) - Date.parse(r.createdAt));
  const toReady = runs
    .map((r) => when(r, "autopilot.run_completed"))
    .flatMap((at, i) => (at ? [Date.parse(at) - Date.parse(runs[i]!.createdAt)] : []));

  // Autonomy: who merged each work order, and which runs needed people for anything but the release.
  let byPolicy = 0;
  let byPerson = 0;
  let mergedCost = 0;
  let runsWithoutPeople = 0;
  let personDecisions = 0;
  for (const run of runs) {
    for (const wo of ledger.listWorkOrders(run.id)) {
      if (wo.state !== "merged") continue;
      if (wo.mergedBy?.startsWith("policy@")) byPolicy++;
      else if (wo.mergedBy) byPerson++;
      mergedCost += ledger.workOrderCost(wo.id);
    }
    const decided = ledger.listInbox({ state: "decided", runId: run.id }).filter((i) => i.decidedBy?.startsWith("user:") && i.decision !== "superseded");
    personDecisions += decided.length;
    if ((run.state === "done" || run.state === "released") && decided.every((i) => i.kind === "release")) runsWithoutPeople++;
  }
  const merged = byPolicy + byPerson;

  const finished = runs.filter((r) => r.state === "done" || r.state === "released");
  const total = runs.reduce((sum, r) => sum + ledger.runCost(r.id), 0);
  const finishedCost = finished.reduce((sum, r) => sum + ledger.runCost(r.id), 0);

  // What goes wrong, counted once per work order (or run) it happened to.
  const counts = new Map<string, number>();
  const count = (reason: string, n = 1) => counts.set(reason, (counts.get(reason) ?? 0) + n);
  const perWorkOrder = (audit: AuditEvent[], action: string, test: (e: AuditEvent) => boolean = () => true) => new Set(audit.filter((e) => e.action === action && test(e)).map((e) => String(e.data.workOrder))).size;
  for (const run of runs) {
    for (const wo of ledger.listWorkOrders(run.id)) {
      const failed = new Set(ledger.listChecks({ runId: run.id, workOrderId: wo.id }).filter((c) => !c.ok && c.stage === "build").map((c) => c.name));
      for (const name of failed) {
        if (name === "secret-scan") count("The secret scan caught a credential");
        else if (name === "dependency-scan") count("The dependency scan flagged a dependency");
        else if (name === "gates") count("The workspace has no gates to run");
        else if (!name.startsWith("hidden:") && !name.endsWith("-edits-discarded")) count(`Gate "${name}" failed`);
      }
      if ([...failed].some((n) => n.startsWith("hidden:"))) count("A hidden acceptance test failed");
    }
    for (const a of ledger.listAttempts({ runId: run.id })) {
      const result = (a.result ?? {}) as { watchdog?: boolean; lost?: boolean };
      if (result.watchdog) count("An agent made no progress and was stopped");
      else if (a.state === "error" && !result.lost) count("An agent stopped with an error");
    }
    const items = ledger.listInbox({ state: "all", runId: run.id });
    count("A work order ran out of repair rounds", items.filter((i) => i.kind === "work_order_failed").length);
    count("The spec didn't validate or couldn't be planned", items.some((i) => i.kind === "spec_failed") ? 1 : 0);
    count("A budget was reached", items.filter((i) => i.kind === "budget_reached").length);
    const audit = eventsOf(run);
    count("The review asked for changes", perWorkOrder(audit, "autopilot.review_verdict", (e) => e.data.passed === false));
    count("A merge conflicted with another work order", perWorkOrder(audit, "autopilot.merge_conflicted"));
    count("Tests failed after merging", perWorkOrder(audit, "autopilot.merge_reverted"));
    count("A release didn't go through", audit.filter((e) => e.action === "autopilot.release_failed").length);
  }
  const failures = [...counts.entries()].filter(([, n]) => n > 0).map(([reason, n]) => ({ reason, count: n })).sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)).slice(0, 10);

  return {
    window: { days, from, to: now.toISOString() },
    runs: {
      started: runs.length,
      released: runs.filter((r) => r.state === "released").length,
      done: runs.filter((r) => r.state === "done").length,
      failed: runs.filter((r) => r.state === "failed").length,
      cancelled: runs.filter((r) => r.state === "cancelled").length,
      active: runs.filter((r) => !["done", "released", "failed", "cancelled"].includes(r.state)).length,
    },
    leadTime: { toRelease: spread(toRelease), toReady: spread(toReady) },
    autonomy: { merged, byPolicy, byPerson, rate: merged ? Math.round((byPolicy / merged) * 1000) / 1000 : null, runsWithoutPeople, personDecisions },
    cost: { totalUsd: money(total), perChangeUsd: finished.length ? money(finishedCost / finished.length) : null, perMergedWorkOrderUsd: merged ? money(mergedCost / merged) : null },
    failures,
    policies: buildInsights(ledger, events).filter((p) => p.lastRun >= from),
  };
}
