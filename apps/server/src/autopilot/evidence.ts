// The evidence for one run, for an assessor or an authorizing official:
// every scenario of the spec traced to the hidden test that checks it, the
// work orders that built it, and who let each one in (a person, or the
// policy with its hash and reasons), plus the NIST controls each work order
// touched, every decision people made, and whether the audit chain holds.
// Built from the ledger, git and the audit log; nothing here is new state.
import { auditFor, verifyAudit, type AuditEvent } from "../audit.js";
import { fileAt, git } from "./git.js";
import type { Ledger, Run } from "./ledger.js";
import { pinnedPolicy } from "./policy.js";

export interface SpecScenario {
  capability: string;
  requirement: string;
  scenario: string;
}

/** Requirements and scenarios from a change's spec files (`### Requirement:` and `#### Scenario:` headings). */
export function parseScenarios(capability: string, markdown: string): SpecScenario[] {
  const out: SpecScenario[] = [];
  let requirement = "";
  for (const line of markdown.split(/\r?\n/)) {
    const req = /^###\s+Requirement:\s*(.+?)\s*$/.exec(line);
    if (req) requirement = req[1] ?? "";
    const sc = /^####\s+Scenario:\s*(.+?)\s*$/.exec(line);
    if (sc && requirement) out.push({ capability, requirement, scenario: sc[1] ?? "" });
  }
  return out;
}

/** The change's scenarios as the run's integration branch (or a ref) has them. */
async function scenariosAt(workspace: string, ref: string, change: string): Promise<SpecScenario[]> {
  const dir = `openspec/changes/${change}/specs`;
  const listed = await git(workspace, ["ls-tree", "-r", "--name-only", ref, "--", dir], { allowFail: true });
  const files = listed.code === 0 ? listed.stdout.split("\n").filter((f) => f.endsWith("/spec.md")) : [];
  const out: SpecScenario[] = [];
  for (const file of files) {
    const capability = file.slice(dir.length + 1).split("/")[0] ?? "";
    out.push(...parseScenarios(capability, (await fileAt(workspace, ref, file)) ?? ""));
  }
  return out;
}

const approver = (actor: string | null) => (actor ? { by: actor, kind: actor.startsWith("policy@") ? ("policy" as const) : ("person" as const) } : null);

export async function buildEvidence(ledger: Ledger, workspace: string, run: Run) {
  const policy = pinnedPolicy(run);
  const events = auditFor(run.id);
  const action = (name: string) => events.filter((e) => e.action === name);
  const workOrders = ledger.listWorkOrders(run.id);
  const checks = ledger.listChecks({ runId: run.id });
  const attempts = ledger.listAttempts({ runId: run.id });
  const hidden = ledger.listHiddenTests(run.id);
  const inbox = ledger.listInbox({ state: "all", runId: run.id });
  const ref = run.releasedSha ?? run.integrationSha ?? run.integrationBranch;
  const scenarios = await scenariosAt(workspace, ref, run.change).catch(() => []);
  const merges = action("autopilot.work_order_merged");
  const key = (seq: number) => `WO-${seq}`;

  const hiddenView = (file: string) => {
    const runs = checks.filter((c) => c.name === `hidden:${file}`);
    const last = runs.at(-1);
    return { runs: runs.length, lastOk: last ? last.ok : null, lastAt: last?.at ?? null };
  };

  const workOrderEvidence = workOrders.map((w) => {
    const merged = merges.filter((e) => e.data.workOrder === key(w.seq)).at(-1);
    const review = attempts.filter((a) => a.workOrderId === w.id && a.role === "reviewer").at(-1)?.result as { verdict?: string; findings?: unknown[] } | null | undefined;
    const own = checks.filter((c) => c.workOrderId === w.id);
    return {
      key: key(w.seq),
      title: w.title,
      risk: w.risk,
      controls: w.controls,
      acceptance: w.acceptance,
      state: w.state,
      approval: approver(w.mergedBy),
      mergedAt: merged?.at ?? null,
      mergeSha: (merged?.data.sha as string | undefined) ?? null,
      // Why a person had to decide (empty for a policy merge: every rule held).
      mergeReasons: (merged?.data.reasons as string[] | undefined) ?? [],
      review: review?.verdict ? { verdict: review.verdict, findings: review.findings?.length ?? 0 } : null,
      builders: attempts.filter((a) => a.workOrderId === w.id && a.role === "builder").length,
      checks: { passed: own.filter((c) => c.ok).length, failed: own.filter((c) => !c.ok).length, names: [...new Set(own.map((c) => c.name))] },
      costUsd: Math.round(ledger.workOrderCost(w.id) * 1000) / 1000,
    };
  });
  const byKey = new Map(workOrderEvidence.map((w) => [w.key, w]));

  const traceability = scenarios.map((s) => {
    const tests = hidden.filter((t) => t.scenario === s.scenario);
    const builtBy = [...new Set(tests.flatMap((t) => t.requires.map(key)))];
    return {
      ...s,
      hiddenTests: tests.map((t) => ({ file: t.file, sha256: t.sha256, requires: t.requires.map(key), ...hiddenView(t.file) })),
      workOrders: builtBy.map((k) => ({ key: k, title: byKey.get(k)?.title ?? null, state: byKey.get(k)?.state ?? null, approval: byKey.get(k)?.approval ?? null })),
    };
  });

  const controls = [...new Set(workOrders.flatMap((w) => w.controls))].sort().map((control) => ({
    control,
    workOrders: workOrderEvidence.filter((w) => w.controls.includes(control)).map((w) => ({ key: w.key, state: w.state, approval: w.approval })),
  }));

  const plan = action("autopilot.plan_approved").at(-1);
  const decisions = inbox
    .filter((i) => i.state !== "open")
    .map((i) => ({
      kind: i.kind,
      title: i.title,
      workOrder: i.workOrderId ? key(workOrders.find((w) => w.id === i.workOrderId)?.seq ?? 0) : null,
      decision: i.decision,
      // The option's label as the person saw it ("Merge", "Release into main").
      choice: i.options.find((o) => o.id === i.decision)?.label ?? i.decision,
      note: i.note,
      by: i.decidedBy,
      at: i.decidedAt,
    }))
    .sort((a, b) => (a.at ?? "").localeCompare(b.at ?? "")); // in the order they were made

  const verify = verifyAudit();
  const pick = (e: AuditEvent | undefined) => (e ? { at: e.at, by: e.actor, seq: e.seq } : null);
  return {
    generatedAt: new Date().toISOString(),
    run: {
      id: run.id,
      goal: run.goal,
      change: run.change,
      autonomy: run.autonomy,
      state: run.state,
      createdBy: run.createdBy,
      createdAt: run.createdAt,
      baseBranch: run.baseBranch,
      integrationBranch: run.integrationBranch,
      integrationSha: run.integrationSha,
      costUsd: Math.round(ledger.runCost(run.id) * 1000) / 1000,
      budgetUsd: run.budgetUsd ?? policy.budget.perChangeUsd,
    },
    policy: {
      hash: run.policyHash,
      actor: `policy@${run.policyHash ?? "default"}`,
      source: (action("autopilot.policy_loaded")[0]?.data.source as string | undefined) ?? null,
      autonomyMax: policy.autonomy.max,
      autoMerge: policy.autoMerge,
      reviewBlocking: policy.review.blocking,
      hiddenTests: policy.hiddenTests.enabled,
      releaseAuto: policy.release.auto,
    },
    spec: {
      validations: checks.filter((c) => c.name === "openspec-validate").map((c) => ({ ok: c.ok, at: c.at })),
      critic: (attempts.filter((a) => a.role === "critic").at(-1)?.result as { verdict?: string } | null)?.verdict ?? null,
      committed: pick(action("autopilot.spec_committed").at(-1)),
      planApproval: plan ? { ...approver(plan.actor), at: plan.at } : null,
    },
    traceability,
    workOrders: workOrderEvidence,
    controls,
    decisions,
    release: run.releasedSha ? { sha: run.releasedSha, at: run.releasedAt, ...approver(run.releasedBy) } : null,
    audit: {
      events: events.length,
      firstSeq: events[0]?.seq ?? null,
      lastSeq: events.at(-1)?.seq ?? null,
      chain: verify,
    },
  };
}

export type Evidence = Awaited<ReturnType<typeof buildEvidence>>;
