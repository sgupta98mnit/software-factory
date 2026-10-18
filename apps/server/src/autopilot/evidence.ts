// Operator evidence, deliberately allowlisted: no prompts, raw tool output,
// agent replies, approval notes or arbitrary audit payloads leave this module.
import { audit, auditSnapshot, canonicalJson, sha256 } from "../audit.js";
import type { ExecutionFacts } from "./execution.js";
import { git } from "./git.js";
import type { Ledger } from "./ledger.js";
import { pinnedPolicy } from "./policy.js";

/** Where an attempt ran, without its container's name: images, limits, network and credential names only. */
function executionOf(runtime: unknown) {
  const f = runtime as ExecutionFacts | null;
  if (!f) return { provider: "not_recorded" as const };
  if (f.provider === "local") return { provider: "local" as const, isolated: false };
  return { provider: "container" as const, isolated: true, image: f.image ?? null, imageId: f.imageId ?? null, network: f.network ?? null, user: f.user ?? null, limits: f.limits ?? null, credentials: f.credentials ?? [], mounts: f.mounts ?? [] };
}

export class EvidenceConflict extends Error {}

const TERMINAL = new Set(["done", "failed", "cancelled"]);
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

/** Called under the orchestrator's run lock. No workspace worktree is needed. */
export async function exportEvidence(ledger: Ledger, workspace: string, runId: string, actor: string) {
  const snapshot = ledger.transaction(() => {
    const run = ledger.getRun(runId);
    if (!run) throw new Error("Run not found.");
    if (!TERMINAL.has(run.state)) throw new EvidenceConflict("Evidence is available after the run finishes, fails or is cancelled.");
    return {
      run,
      workOrders: ledger.listWorkOrders(runId),
      attempts: ledger.listAttempts({ runId }),
      checks: ledger.listChecks({ runId }),
      inbox: ledger.listInbox({ state: "all", runId }),
      costUsd: ledger.runCost(runId),
    };
  });
  let log: Awaited<ReturnType<typeof auditSnapshot>>;
  try {
    log = await auditSnapshot(runId);
  } catch {
    throw new EvidenceConflict("The audit log cannot be read. Repair it before exporting evidence.");
  }
  if (!log.verification.ok) throw new EvidenceConflict("The audit chain is invalid. Repair it before exporting evidence.");

  const { run, workOrders, checks, attempts, inbox } = snapshot;
  const terminalAction = run.state === "done" ? "autopilot.run_completed" : run.state === "failed" ? "autopilot.run_failed" : "autopilot.run_cancelled";
  const completed = log.events.findLast((e) => e.action === terminalAction);
  const commit = typeof completed?.data.sha === "string" && SHA.test(completed.data.sha) ? completed.data.sha : null;
  // Resolve only the recorded immutable SHA, never the branch's current tip.
  let available = false;
  if (commit) {
    try {
      available = (await git(workspace, ["cat-file", "-e", `${commit}^{commit}`], { allowFail: true })).code === 0;
    } catch { /* The workspace itself may have been removed; the identity survives. */ }
  }
  const controls = [...new Set(workOrders.flatMap((wo) => wo.controls))].sort().map((control) => ({
    control,
    workOrderIds: workOrders.filter((wo) => wo.controls.includes(control)).map((wo) => wo.id),
  }));
  const packet = {
    schemaVersion: 1 as const,
    generatedAt: new Date().toISOString(),
    run: {
      id: run.id, change: run.change, state: run.state, autonomy: run.autonomy,
      baseBranch: run.baseBranch, integrationBranch: run.integrationBranch,
      policyHash: run.policyHash, budgetUsd: run.budgetUsd, costUsd: snapshot.costUsd,
      createdBy: run.createdBy, createdAt: run.createdAt, updatedAt: run.updatedAt,
      execution: { provider: pinnedPolicy(run).execution.provider, isolated: pinnedPolicy(run).execution.provider === "container" },
    },
    artifact: { commit, available, source: commit ? "terminal_audit" as const : "not_recorded" as const },
    workOrders: workOrders.map((wo) => ({
      id: wo.id, seq: wo.seq, title: wo.title, state: wo.state,
      acceptance: wo.acceptance, controls: wo.controls, dependsOn: wo.dependsOn, risk: wo.risk,
      mergedBy: wo.mergedBy,
      checkIds: checks.filter((check) => check.workOrderId === wo.id).map((check) => check.id),
      attemptIds: attempts.filter((attempt) => attempt.workOrderId === wo.id).map((attempt) => attempt.id),
    })),
    controls,
    checks: checks.map((check) => ({
      id: check.id, workOrderId: check.workOrderId, stage: check.stage,
      name: check.name, ok: check.ok, exitCode: check.exitCode,
      durationMs: check.durationMs, at: check.at, outputSha256: sha256(check.output),
      commitBinding: "not_recorded" as const,
      runner: check.runner ?? "not_recorded",
    })),
    attempts: attempts.map((attempt) => {
      const result = attempt.result as { verdict?: unknown } | null;
      const verdict = result && typeof result.verdict === "string" && ["pass", "fail", "revise"].includes(result.verdict) ? result.verdict : null;
      return {
        id: attempt.id, workOrderId: attempt.workOrderId, role: attempt.role,
        conversationId: attempt.conversationId, agentProfile: attempt.agentProfile,
        state: attempt.state, turns: attempt.turns, costUsd: attempt.costUsd,
        startedAt: attempt.startedAt, finishedAt: attempt.finishedAt, verdict,
        execution: executionOf(attempt.runtime),
      };
    }),
    decisions: inbox.map((item) => ({
      id: item.id, workOrderId: item.workOrderId, kind: item.kind, state: item.state,
      decision: item.decision, decidedBy: item.decidedBy, decidedAt: item.decidedAt,
    })),
    audit: {
      verified: true as const, checked: log.verification.checked, checkpoint: log.checkpoint,
      // Metadata only. Hashes locate original events; payloads remain in the local log.
      events: log.events.filter((e) => e.action !== "autopilot.evidence_exported").map((e) => ({
        seq: e.seq, at: e.at, actor: e.actor, action: e.action, hash: e.hash,
      })),
    },
    assurance: {
      securityScan: "not_recorded" as const,
      independentValidation: "not_recorded" as const,
      signature: "unsigned" as const,
      // Every agent and every gate ran in a container; otherwise something ran on the operator's machine (or wasn't recorded).
      isolation: attempts.length > 0 && attempts.every((a) => (a.runtime as ExecutionFacts | null)?.provider === "container") && !checks.some((c) => c.runner === "local")
        ? ("container" as const)
        : ("none" as const),
    },
    limitations: [
      "This unsigned digest detects packet changes; it does not authenticate its producer.",
      "The audit checkpoint reports local verification at export time. Event payloads are omitted; this packet alone cannot reverify the audit chain or detect truncation.",
      "Historical checks have no recorded commit binding. Failed checks are retained, including earlier repair rounds.",
      "Check output digests cover only the persisted output tail, not the full command log.",
      "Acceptance criteria and control mappings are traceability, not independent validation or proof of compliance.",
      "Costs are provider-reported observations and may lag actual billing. A null budget means the pinned policy default.",
      "Work order titles and criteria may contain project information. Review them before sharing.",
    ],
  };
  const digest = { algorithm: "sha256" as const, canonicalization: "sf-canonical-json-v1" as const, value: sha256(canonicalJson(packet)) };
  try {
    await audit(actor, "autopilot.evidence_exported", runId, { digest: digest.value, commit, schemaVersion: packet.schemaVersion });
  } catch {
    // audit() logs the original write error locally; HTTP must not expose paths.
    throw new EvidenceConflict("Evidence could not be recorded in the audit log. Check server storage and retry.");
  }
  return { packet, digest };
}

export type EvidenceExport = Awaited<ReturnType<typeof exportEvidence>>;
