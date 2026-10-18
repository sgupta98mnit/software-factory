// Autopilot's state machine and scheduler. A run goes goal -> spec agent ->
// strict validation -> commit -> critic -> plan (work orders in waves) ->
// approval (by autonomy) -> building: one builder per work order, each in its
// own worktree and branch from the integration tip, a few at a time. Built
// work goes through the factory's gates and a reviewer; what fails goes back
// to the builder (repair), then to a fresh builder, then to a person. Work
// that passes is merged into the integration branch one work order at a
// time and tested again there; when everything is merged, the run is done.
// Every step reads its state from the ledger, does one side effect (an agent
// call, git, openspec) and writes the new state, so the factory can stop at
// any point and carry on after a restart.
//
// One run is handled by one thing at a time: the scheduler's step for it, or
// a person's decision, pause or cancel, which wait for that step to finish.
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { audit, auditFor, sha256 } from "../audit.js";
import { isolationRequired } from "../config.js";
import { broadcast } from "../events.js";
import { tools } from "../tools.js";
import { exportEvidence } from "./evidence.js";
import {
  createExecution,
  RuntimeGone,
  RuntimeUnavailable,
  sweepContainers,
  type DockerRunner,
  type ExecutionFacts,
  type Preflight,
} from "./execution.js";
import { detectGates, gateFindings, gatesAt, hiddenSummary, installGates, packageDirs, runGates, type Gate, type GateResult } from "./gates.js";
import {
  addDetachedWorktree,
  addWorktree,
  commitAll,
  currentBranch,
  deleteBranch,
  diffStat,
  discardChanges,
  ensureRepo,
  git,
  headSha,
  isClean,
  isRepoRoot,
  mergeInto,
  readInside,
  removeWorktree,
  resetHard,
  restorePaths,
} from "./git.js";
import { mergeAndTest } from "./integrator.js";
import { StaleWorker } from "./ledger.js";
import type {
  Attempt,
  AttemptRole,
  Autonomy,
  Command,
  CommandState,
  Finding,
  InboxItem,
  InboxKind,
  InboxOption,
  Ledger,
  Run,
  RunState,
  WorkOrder,
  WorkOrderState,
} from "./ledger.js";
import { classify, OpenHandsError, type OpenHandsClient } from "./openhands.js";
import {
  answerFollowUp,
  builderBrief,
  criticBrief,
  criticFollowUp,
  findingList,
  repairMessage,
  reviewerBrief,
  reviseFollowUp,
  specBrief,
  validateFollowUp,
  validatorBrief,
  validatorFollowUp,
  verdictReminder,
} from "./prompts.js";
import { DEFAULT_POLICY, evaluateMerge, loadPolicy, newDependencies, pinnedPolicy, POLICY_FILE, policyHash, sensitiveMatch } from "./policy.js";
import {
  counts,
  findingKey,
  scan,
  scanDigest,
  scanFindings,
  ScannerUnavailable,
  scannerInfo,
  trivyCli,
  describe as describeScan,
  type ScanFinding,
  type ScannerInfo,
  type ScannerRunner,
} from "./scanner.js";
import { clusterFindings, parseVerdict, passed, type ReviewVerdict } from "./review.js";
import {
  assumptionsOf,
  changeNameFor,
  checkChange,
  openQuestions,
  parseCriticVerdict,
  proposalTitle,
  readProposal,
  takenChangeNames,
  type CriticVerdict,
} from "./spec.js";
import { planWorkOrders } from "./waves.js";

/** This process isn't the one running Autopilot on its ledger (another holds the scheduler lease). */
export class Standby extends Error {}

export interface OrchestratorDeps {
  ledger: Ledger;
  client: OpenHandsClient;
  workspace: string; // the repo the runs work on
  dataDir: string; // worktrees go in <dataDir>/worktrees/<runId>/
  /** How long an end state right after a message is distrusted (see classify). Tests use 0. */
  graceMs?: number;
  /** The Docker CLI, for runs whose policy isolates execution in containers. Tests pass a fake. */
  docker?: DockerRunner;
  /** Where container credentials come from; defaults to the factory's environment. */
  env?: NodeJS.ProcessEnv;
  /** Ports on this machine that agents in containers must not reach: the factory API and Canvas. */
  controlPorts?: number[];
  /** The Trivy CLI, for policies that scan. Tests pass a fake. */
  trivy?: ScannerRunner;
  /** This process in the scheduler lease: "<host>:<pid>:<random>". Tests play other processes with it. */
  owner?: string;
  /** Whether a process on this machine is alive (a dead lease holder is taken over at once). */
  pidAlive?: (pid: number) => boolean;
  leaseTtlMs?: number;
  /** First retry delay of a message the agent server refused (doubles each time, at most 5 minutes). Tests use 0. */
  commandRetryMs?: number;
  /** How long a message that may have arrived is given to show up in its conversation before it's sent again. Tests use 0. */
  reconcileMs?: number;
}

/** What a run pinned to verify its work, at creation: the checks, where they came from, and the test writer's hidden tests. */
export interface Verification {
  gates: Gate[] | null; // null: the base branch defines none, so the work order's own scripts run (unpinned)
  source: "policy" | "base" | "worktree";
  baseSha: string;
  hiddenTests: { files: { name: string; seq: number; sha256: string }[]; digest: string } | null;
}

const LEASE = "scheduler";
const COMMAND_TRIES = 10; // refused sends before a person hears about it
const OPEN_COMMANDS: CommandState[] = ["pending", "sending", "ambiguous", "quarantined"];
const UNDELIVERED: InboxOption[] = [
  { id: "resend", label: "Send it again", tone: "primary" },
  { id: "cancel", label: "Cancel run", tone: "danger" },
];
const UNCONFIRMED: InboxOption[] = [
  { id: "resend", label: "Send it again", tone: "primary" },
  { id: "delivered", label: "It arrived: don't send it again" },
  { id: "cancel", label: "Cancel run", tone: "danger" },
];
const SPEC_GONE: InboxOption[] = [
  { id: "restart", label: "Start a new spec agent with this message", tone: "primary" },
  { id: "resend", label: "Send it again" },
  { id: "cancel", label: "Cancel run", tone: "danger" },
];

const HIDDEN_FILE = /^wo-(\d+)-[a-z0-9][a-z0-9-]*\.test\.mjs$/;
const HIDDEN_MAX_BYTES = 200_000;
const HIDDEN_MAX_FILES = 300;

const AUTONOMY: Autonomy[] = ["suggest", "supervised", "autonomous"];
const TERMINAL = new Set<RunState>(["done", "failed", "cancelled"]);
const ACTIVE = new Set<string>(["starting", "running"]); // attempts the scheduler starts or polls
const BUSY_WO = new Set<WorkOrderState>(["building", "verifying", "reviewing"]); // count against policy.parallel
const DONE_WO = new Set<WorkOrderState>(["merged", "skipped"]); // what dependents wait for
const SYSTEM = "autopilot";
const FAILING_TO_PAUSE = 3; // work orders needing attention that pause their run
/** Who approves what a run's pinned policy allows: "policy@<hash>". */
const policyActor = (run: Run) => `policy@${run.policyHash ?? "default"}`;

const APPROVAL: InboxOption[] = [
  { id: "approve", label: "Approve", tone: "primary" },
  { id: "revise", label: "Ask for changes", needsNote: true },
  { id: "cancel", label: "Cancel run", tone: "danger" },
];
const QUESTIONS: InboxOption[] = [
  { id: "answer", label: "Send answers", tone: "primary", needsNote: true },
  { id: "proceed", label: "Proceed with the assumptions" },
  { id: "cancel", label: "Cancel run", tone: "danger" },
];
const RETRY: InboxOption[] = [
  { id: "retry", label: "Retry", tone: "primary" },
  { id: "cancel", label: "Cancel run", tone: "danger" },
];
const WO_FAILED: InboxOption[] = [
  { id: "retry", label: "Retry with a fresh agent", tone: "primary" },
  { id: "skip", label: "Skip this work order" },
  { id: "cancel", label: "Cancel run", tone: "danger" },
];
const WO_ERROR: InboxOption[] = [
  { id: "retry", label: "Retry", tone: "primary" },
  { id: "skip", label: "Skip this work order" },
  { id: "cancel", label: "Cancel run", tone: "danger" },
];
const MERGE: InboxOption[] = [
  { id: "merge", label: "Merge", tone: "primary" },
  { id: "send_back", label: "Send back to the builder", needsNote: true },
  { id: "skip", label: "Skip this work order" },
];
const RUN_PAUSED: InboxOption[] = [
  { id: "resume", label: "Resume", tone: "primary" },
  { id: "cancel", label: "Cancel run", tone: "danger" },
];
const RUN_BUDGET: InboxOption[] = [
  { id: "continue", label: "Increase budget and continue", tone: "primary" },
  { id: "cancel", label: "Cancel run", tone: "danger" },
];
const WO_BUDGET: InboxOption[] = [
  { id: "continue", label: "Increase budget and continue", tone: "primary" },
  { id: "skip", label: "Skip this work order", tone: "danger" },
  { id: "cancel", label: "Cancel run", tone: "danger" },
];

const now = () => new Date().toISOString();
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
/** The agent server or the container engine is down or slow: leave everything as it is and try again on a later tick. */
const unreachable = (err: unknown) => (err instanceof OpenHandsError && err.status === 0) || err instanceof RuntimeUnavailable;
/** One line, at most `max` chars: for audit data, which never holds full goals, notes or prompts. */
const clip = (text: string, max = 120) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};
const warn = (err: unknown) => console.warn(`[autopilot] ${errorText(err)}`);

export function createOrchestrator(deps: OrchestratorDeps) {
  const { ledger, client, workspace } = deps;
  const graceMs = deps.graceMs ?? 20_000;
  const worktrees = path.join(deps.dataDir, "worktrees");
  const inflight = new Map<string, Promise<void>>(); // runId -> what's being done for it
  let timer: NodeJS.Timeout | undefined;
  const execDeps = { dataDir: deps.dataDir, hostClient: client, docker: deps.docker, env: deps.env, controlPorts: deps.controlPorts };
  /** How the run's pinned policy executes agents and gates (execution.ts). */
  const executionFor = (run: Pick<Run, "policy">) => createExecution(pinnedPolicy(run), execDeps);
  const agents = new Map<number, OpenHandsClient>(); // container attempts' agent servers, by attempt id
  let lastPreflight: Preflight | null = null;
  const trivy = deps.trivy ?? trivyCli();
  /** Null for runs from before trusted verification: they keep their old checks. */
  const verificationOf = (run: Pick<Run, "verification">) => run.verification as Verification | null;
  const validatorDir = (run: Run) => path.join(worktrees, run.id, "validator");
  const validatorBranch = (run: Run) => `${run.integrationBranch}--validator`;
  // Outside every worktree, so no builder ever has them: the hidden tests, and the clean checkouts verified.
  const hiddenDir = (runId: string) => path.join(deps.dataDir, "hidden-tests", runId);
  const verifyDir = (runId: string, name: string) => path.join(deps.dataDir, "verify", runId, name);

  const changed = (runId: string) => broadcast({ type: "autopilot.changed", runId });
  const record = (actor: string, action: string, runId: string, data: Record<string, unknown> = {}) => {
    audit(actor, action, runId, data).catch(() => undefined); // audit.ts logs write failures
  };

  // ---- one thing per run at a time ----

  function track(runId: string, work: Promise<unknown>) {
    const done: Promise<void> = work
      .then(() => undefined, () => undefined)
      .finally(() => {
        if (inflight.get(runId) === done) inflight.delete(runId);
      });
    inflight.set(runId, done);
  }

  /** The scheduler's step for a run, skipped while something else is being done for it. */
  function launch(runId: string, fn: () => Promise<void>) {
    if (inflight.has(runId)) return;
    track(runId, fn().catch((err) => (err instanceof StaleWorker ? demote(err) : failed(runId, err))).finally(() => reconcilePauses(runId)));
  }

  // ---- one process acts on the ledger: the scheduler lease ----

  const owner = deps.owner ?? `${hostname()}:${process.pid}:${randomBytes(4).toString("hex")}`;
  const pidAlive =
    deps.pidAlive ??
    ((pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (err) {
        return (err as NodeJS.ErrnoException).code === "EPERM"; // alive, just not ours
      }
    });
  let generation: number | null = null;
  let stale = false;

  /** An earlier orchestrator of this process, or a process on this machine that's gone, is replaced at once; others when the lease expires. */
  function canTakeOver(holder: string) {
    const [host, pid] = holder.split(":");
    if (host !== hostname()) return false;
    return Number(pid) === process.pid || !pidAlive(Number(pid));
  }

  /** Takes or renews the lease; false while another live process holds it (this one stands by). */
  function lead(): boolean {
    if (stale) return false;
    const gen = ledger.acquireLease(LEASE, owner, deps.leaseTtlMs ?? 30_000, canTakeOver);
    if (gen === null) return false;
    if (gen !== generation) {
      generation = gen;
      ledger.fence({ name: LEASE, owner, generation: gen });
      record(SYSTEM, "autopilot.scheduler_lease", "scheduler", { owner, generation: gen });
    }
    return true;
  }

  function mustLead() {
    if (!lead()) throw new Standby("Another factory process is running Autopilot on this data folder. Use that one, or stop it first.");
  }

  /** Another process took over: this one stops acting and lets its writes go. */
  function demote(err: unknown) {
    if (stale) return;
    stale = true;
    clearInterval(timer);
    timer = undefined;
    console.warn(`[autopilot] standing down: ${errorText(err)}`);
  }

  /** A person's action: waits for the run's current step, then holds the run until it's done. */
  async function locked<T>(runId: string, fn: () => Promise<T>): Promise<T> {
    for (let busy = inflight.get(runId); busy; busy = inflight.get(runId)) await busy;
    const result = fn().finally(() => reconcilePauses(runId));
    track(runId, result);
    return result;
  }

  // ---- state changes ----

  /** The one way a run changes state: ledger, audit, then tell open pages. */
  function moveRun(
    run: Run,
    to: RunState,
    opts: { patch?: Partial<Omit<Run, "id" | "state" | "createdAt" | "updatedAt">>; actor?: string; action?: string; data?: Record<string, unknown> } = {},
  ): Run {
    const next = ledger.updateRun(run.id, { ...opts.patch, state: to });
    record(opts.actor ?? SYSTEM, opts.action ?? "autopilot.run_state_changed", run.id, { from: run.state, to, ...opts.data });
    changed(run.id);
    return next;
  }

  /** The one way a work order changes state. Audited under its run, like everything Autopilot does. */
  function moveWorkOrder(
    wo: WorkOrder,
    to: WorkOrderState,
    opts: { patch?: Partial<Omit<WorkOrder, "id" | "runId" | "seq" | "state" | "updatedAt">>; actor?: string; action?: string; data?: Record<string, unknown> } = {},
  ): WorkOrder {
    const next = ledger.updateWorkOrder(wo.id, { ...opts.patch, state: to });
    record(opts.actor ?? SYSTEM, opts.action ?? "autopilot.work_order_state_changed", wo.runId, { workOrder: `WO-${wo.seq}`, from: wo.state, to, ...opts.data });
    changed(wo.runId);
    return next;
  }

  function openItem(run: Run, kind: InboxKind, title: string, body: string, options: InboxOption[], workOrderId?: string, ref?: string): InboxItem {
    const item = ledger.openInbox({ runId: run.id, workOrderId, kind, title, body, options, ref });
    record(SYSTEM, "autopilot.inbox_opened", run.id, { item: item.id, kind, ...(workOrderId ? { workOrder: workOrderId } : {}) });
    return item;
  }

  /** A step failed: pause the run and ask a person (retry or cancel). */
  function failed(runId: string, err: unknown) {
    if (unreachable(err)) return;
    if (err instanceof StaleWorker) return demote(err);
    console.error(`[autopilot] ${runId}:`, err);
    const run = ledger.getRun(runId);
    if (!run || TERMINAL.has(run.state) || run.state === "paused") return;
    const message = errorText(err);
    ledger.transaction(() => {
      openItem(run, "error", `Autopilot stopped on ${run.change}`, `While in **${run.state}**:\n\n${message}\n\nRetry picks up from there.`, RETRY);
      moveRun(run, "paused", {
        patch: { resumeState: run.state, pausedReason: clip(message, 500) },
        action: "autopilot.run_paused",
        data: { error: clip(message) },
      });
    });
  }

  /** Pause intent lives in run/WO state; retry failed acknowledgements on later ticks, including after restart. */
  async function reconcilePauses(runId: string) {
    const run = ledger.getRun(runId);
    if (!run || TERMINAL.has(run.state)) return;
    for (const a of ledger.listAttempts({ runId })) {
      if (!ACTIVE.has(a.state)) continue;
      const held = a.workOrderId && ledger.getWorkOrder(a.workOrderId)?.state === "needs_attention";
      if (run.state !== "paused" && !held) continue;
      try {
        const agent = await remote(a);
        if (!agent) continue; // its container is gone: nothing left to pause
        // A write-ahead attempt may not exist remotely yet. Never start it just to pause it.
        if (a.state === "starting" && !(await agent.get(a.conversationId))) continue;
        await agent.pause(a.conversationId);
        ledger.updateAttempt(a.id, { state: "paused" });
        record(SYSTEM, "autopilot.agent_paused", runId, { attempt: a.id, role: a.role, conversationId: a.conversationId });
        changed(runId);
      } catch (err) {
        warn(err); // retain the active state so the pause is retried
      }
    }
  }

  const runBudget = (run: Run) => run.budgetUsd ?? pinnedPolicy(run).budget.perChangeUsd;

  /** Check reported costs before starting more work and after each conversation update. */
  function enforceBudgets(run: Run): boolean {
    if (run.state === "paused" || TERMINAL.has(run.state)) return false;
    const cost = ledger.runCost(run.id);
    const limit = runBudget(run);
    if (cost >= limit) {
      ledger.transaction(() => {
        openItem(run, "budget_reached", `Budget reached for ${run.change}`,
          `Reported spending is $${cost.toFixed(2)} against a $${limit.toFixed(2)} limit. Continue adds $${pinnedPolicy(run).budget.perChangeUsd.toFixed(2)} to this run's limit.`, RUN_BUDGET);
        moveRun(run, "paused", {
          patch: { resumeState: run.state, pausedReason: "Run budget reached" },
          action: "autopilot.budget_reached", data: { costUsd: cost, limitUsd: limit },
        });
      });
      return false;
    }
    const base = pinnedPolicy(run).budget.perWorkOrderUsd;
    for (const wo of ledger.listWorkOrders(run.id)) {
      if (DONE_WO.has(wo.state) || wo.state === "cancelled" || wo.state === "needs_attention") continue;
      const woCost = ledger.workOrderCost(wo.id);
      const woLimit = base + wo.budgetExtraUsd;
      if (woCost < woLimit) continue;
      ledger.transaction(() => {
        moveWorkOrder(wo, "needs_attention", { patch: { resumeState: wo.state }, action: "autopilot.budget_reached", data: { costUsd: woCost, limitUsd: woLimit } });
        openItem(run, "budget_reached", `Budget reached for WO-${wo.seq} of ${run.change}`,
          `Reported spending is $${woCost.toFixed(2)} against a $${woLimit.toFixed(2)} limit. Continue adds $${base.toFixed(2)} to this work order's limit. Other work orders may continue.`, WO_BUDGET, wo.id);
      });
    }
    return true;
  }

  // ---- attempts (one agent conversation each) ----

  const latest = (runId: string, role: AttemptRole) => ledger.listAttempts({ runId, role }).at(-1);
  /** The orchestrator has acted on the attempt's latest turn: its result records that turn. */
  const handled = (a: Attempt) => (a.result as { turn?: number } | null)?.turn === a.turns;
  const markHandled = (a: Attempt, result: object) => ledger.updateAttempt(a.id, { result: { ...result, turn: a.turns } });
  const isContainer = (a: Attempt) => (a.runtime as ExecutionFacts | null)?.provider === "container";

  /** The agent server an attempt's conversation lives on: Canvas's, or the attempt's own container's. */
  async function agentFor(a: Attempt): Promise<OpenHandsClient> {
    if (!isContainer(a)) return client;
    const known = agents.get(a.id);
    if (known) return known;
    const found = await executionFor(mustRun(a.runId)).clientFor(a);
    agents.set(a.id, found);
    return found;
  }

  /** Like agentFor, but a container that's gone ends its attempt (with the reason) and gives null. */
  async function remote(a: Attempt): Promise<OpenHandsClient | null> {
    try {
      return await agentFor(a);
    } catch (err) {
      if (!(err instanceof RuntimeGone)) throw err;
      if (ACTIVE.has(a.state) || a.state === "paused") {
        ledger.updateAttempt(a.id, { state: "error", finishedAt: now(), result: { ...(a.result as object | null), error: err.message } });
        record(SYSTEM, "autopilot.agent_finished", a.runId, { role: a.role, attempt: a.id, state: "error", error: clip(err.message) });
        changed(a.runId);
      }
      return null;
    }
  }

  /** An attempt that can't get another message: superseded, its work order finished, its verdict used, or its run over. */
  function retired(run: Run, a: Attempt, all: Attempt[]): boolean {
    if (TERMINAL.has(run.state)) return true;
    if (all.some((x) => x.id > a.id && x.role === a.role && x.workOrderId === a.workOrderId)) return true;
    const wo = a.workOrderId ? ledger.getWorkOrder(a.workOrderId) : undefined;
    if (wo && (DONE_WO.has(wo.state) || wo.state === "cancelled")) return true;
    if ((a.role === "critic" || a.role === "reviewer" || a.role === "validator") && handled(a)) return true;
    return a.role === "spec" && (run.state === "building" || run.resumeState === "building");
  }

  /** Removes an attempt's container (its state folder, the transcript, stays). A failure is tried again later. */
  async function releaseAttempt(run: Run, a: Attempt) {
    const facts = a.runtime as ExecutionFacts | null;
    if (facts?.provider !== "container" || facts.released) return;
    try {
      await executionFor(run).release(a);
    } catch (err) {
      return warn(err);
    }
    agents.delete(a.id);
    ledger.updateAttempt(a.id, { runtime: { ...facts, released: true } });
    record(SYSTEM, "autopilot.runtime_removed", run.id, { attempt: a.id, role: a.role, container: facts.container });
  }

  async function releaseRetired(runId: string) {
    const run = ledger.getRun(runId);
    if (!run) return;
    const all = ledger.listAttempts({ runId });
    for (const a of all) if (retired(run, a, all)) await releaseAttempt(run, a);
  }

  /** Before a worktree folder goes: the containers that have it mounted (a work order's, or with null the run's spec and critic; all with undefined). */
  async function releaseMounted(run: Run, workOrderId?: string | null) {
    for (const a of ledger.listAttempts({ runId: run.id })) {
      if (workOrderId === undefined || a.workOrderId === workOrderId) await releaseAttempt(run, a);
    }
  }

  /** Why an agent stopped, for a person: the start error, or its status and last message. */
  async function whyStopped(a: Attempt, who: string): Promise<string> {
    const error = (a.result as { error?: string } | null)?.error;
    if (error) return error;
    const last = await agentFor(a).then((c) => c.finalResponse(a.conversationId)).catch(() => "");
    return `${who} stopped with status "${a.state}".${last ? ` Its last message: ${clip(last, 500)}` : ""}`;
  }

  function specAttempt(run: Run): Attempt {
    const a = latest(run.id, "spec");
    if (!a) throw new Error("This run has no spec conversation yet.");
    return a;
  }

  /**
   * The profile the policy names for a critic or reviewer; with none named,
   * another vendor than the agent whose work it checks, when the agent server has one.
   */
  async function checkerProfile(named: string | null, profileRef: string | null | undefined) {
    if (named) return client.resolveProfile(named);
    const other = profileRef ? await client.resolveProfile(profileRef).catch(() => null) : null;
    return client.resolveProfile(null, { avoidServerOf: other?.server });
  }

  /** Records a new attempt before asking the agent server for it (write-ahead), then starts it. */
  async function startAgent(run: Run, role: "spec" | "critic") {
    const { agents } = pinnedPolicy(run);
    const profile =
      role === "spec" ? await client.resolveProfile(agents.spec) : await checkerProfile(agents.critic, latest(run.id, "spec")?.agentProfile);
    const attempt = ledger.transaction(() => {
      const a = ledger.addAttempt({ runId: run.id, role, conversationId: randomUUID(), agentProfile: profile.id });
      if (role === "spec") ledger.updateRun(run.id, { specConversation: a.conversationId });
      return a;
    });
    record(SYSTEM, "autopilot.agent_started", run.id, { role, attempt: attempt.id, conversationId: attempt.conversationId, profile: profile.name });
    await startConversation(attempt);
  }

  /** The first message of an attempt, rebuilt from the ledger so a restart sends the same one. */
  function briefFor(run: Run, a: Attempt, wo: WorkOrder | undefined): string {
    const isolated = executionFor(run).kind === "container";
    if (wo) return a.role === "reviewer" ? reviewerBrief({ change: run.change, wo, isolated }) : builderBrief({ change: run.change, wo, gates: verificationOf(run)?.gates ?? pinnedPolicy(run).gates, isolated });
    if (a.role === "critic") return criticBrief({ change: run.change });
    if (a.role === "validator") return validatorBrief({ change: run.change, workOrders: ledger.listWorkOrders(run.id), run: pinnedPolicy(run).hiddenTests.run });
    // A spec agent started after one that failed (or whose tasks.md couldn't be planned) hears why.
    const before = ledger.listAttempts({ runId: run.id, role: "spec" }).filter((x) => x.id < a.id).at(-1);
    const problem = (before?.result as { reason?: string } | null)?.reason ?? null;
    return specBrief({ goal: run.goal, change: run.change, autonomy: run.autonomy, openspecVersion: tools.openspec.version, problem });
  }

  /** Safe to repeat after a restart: the conversation id is fixed, so the agent server returns the existing one. */
  async function startConversation(a: Attempt) {
    const run = ledger.getRun(a.runId);
    const wo = a.workOrderId ? ledger.getWorkOrder(a.workOrderId) : undefined;
    // Builders and reviewers work in their work order's worktree, the test writer in its own.
    const dir = wo ? wo.worktree : a.role === "validator" && run ? validatorDir(run) : run?.integrationDir;
    if (!run || !dir || !a.agentProfile) throw new Error(`Attempt ${a.id} has no worktree or agent profile to start with`);
    const exec = executionFor(run);
    try {
      // A container's agent server needs the profile's definition, found by name on Canvas's server.
      const profile = exec.kind === "container" ? await client.resolveProfile(a.agentProfile) : { id: a.agentProfile, name: a.agentProfile, kind: "", server: null };
      // An isolated reviewer has no git: the diff it reviews comes in as a read-only file.
      const inputs = exec.kind === "container" && a.role === "reviewer" && wo ? { "changes.diff": (await git(dir, ["diff", "--no-color", `${wo.baseSha ?? "HEAD~1"}...HEAD`])).stdout } : undefined;
      const ready = await exec.prepare(a, dir, profile, inputs);
      if (exec.kind === "container") agents.set(a.id, ready.client);
      ledger.updateAttempt(a.id, { runtime: ready.facts });
      // A start whose answer was lost (a timeout) may have created it: look before creating it again.
      const snap =
        (await ready.client.get(a.conversationId)) ??
        (await ready.client.start({
          conversationId: a.conversationId,
          profileId: ready.profileId,
          workingDir: ready.workingDir,
          text: briefFor(run, a, wo),
          runId: run.id,
          role: a.role,
          seq: wo?.seq,
        }));
      ledger.updateAttempt(a.id, { state: "running", seenRunning: snap.status === "running", costUsd: snap.costUsd, lastSentAt: now(), progressAt: now() });
    } catch (err) {
      if (unreachable(err)) return; // stays "starting": a later tick starts it again with the same id
      ledger.updateAttempt(a.id, { state: "error", finishedAt: now(), result: { error: errorText(err) } });
      record(SYSTEM, "autopilot.agent_finished", run.id, { role: a.role, attempt: a.id, state: "error", error: clip(errorText(err)) });
    }
    changed(run.id);
    enforceBudgets(ledger.getRun(run.id) ?? run);
  }

  async function poll(a: Attempt) {
    const agent = await remote(a);
    if (!agent) return;
    const snap = await agent.get(a.conversationId).catch((err: unknown) => {
      if (unreachable(err)) agents.delete(a.id); // look its container up again next time
      throw err;
    });
    // A message it hasn't got (or that nobody can confirm) is its next turn: its end state now is the
    // previous turn's. Its cost still counts, though: a message that did arrive is being worked on.
    if (snap && ledger.listCommands({ attemptId: a.id, states: OPEN_COMMANDS }).length) {
      if (snap.costUsd !== a.costUsd) {
        ledger.updateAttempt(a.id, { costUsd: snap.costUsd });
        changed(a.runId);
      }
      return;
    }
    if (!snap) {
      ledger.updateAttempt(a.id, { state: "error", finishedAt: now(), result: { error: "The conversation is gone from the agent server." } });
      record(SYSTEM, "autopilot.agent_finished", a.runId, { role: a.role, attempt: a.id, state: "error" });
      return changed(a.runId);
    }
    const seenRunning = a.seenRunning || snap.status === "running";
    const outcome = classify(snap, { seenRunning, lastSentAt: a.lastSentAt }, new Date(), graceMs);
    // "paused" means someone paused it in Canvas: keep polling until they resume it there.
    let state: Attempt["state"] = outcome === "done" ? "finished" : outcome === "failed" ? (snap.status === "stuck" ? "stuck" : "error") : "running";
    let result = a.result;
    const watched = state === "running" && outcome !== "paused" ? await watchdog(a, agent, snap.costUsd) : { progressAt: a.progressAt, lastEvent: a.lastEvent, stalled: false };
    if (watched.stalled) {
      const idle = pinnedPolicy(mustRun(a.runId)).watchdog.idleMinutes;
      await agent.pause(a.conversationId).catch(warn);
      state = "error";
      result = { ...(a.result as object | null), error: `No new event or cost from the agent for ${idle} minutes: the watchdog stopped it.` };
      record(SYSTEM, "autopilot.watchdog_stopped", a.runId, { role: a.role, attempt: a.id, conversationId: a.conversationId, idleMinutes: idle });
    }
    ledger.updateAttempt(a.id, { state, seenRunning, costUsd: snap.costUsd, finishedAt: state === "running" ? null : now(), progressAt: watched.progressAt, lastEvent: watched.lastEvent, result });
    if (state !== "running") record(SYSTEM, "autopilot.agent_finished", a.runId, { role: a.role, attempt: a.id, state, costUsd: snap.costUsd });
    if (state !== a.state || snap.costUsd !== a.costUsd) changed(a.runId);
  }

  /**
   * Whether a running agent shows signs of life: its cost moved, or (asked at
   * most once a minute) its conversation has a newer event. Event ids, not
   * timestamps: a container's clock may not be this machine's.
   */
  async function watchdog(a: Attempt, agent: OpenHandsClient, costUsd: number) {
    const idle = pinnedPolicy(mustRun(a.runId)).watchdog.idleMinutes;
    let progressAt = a.progressAt ?? a.lastSentAt;
    let lastEvent = a.lastEvent;
    if (costUsd !== a.costUsd) progressAt = now();
    else if (Date.now() - Date.parse(progressAt) > 60_000) {
      const latest = await agent.latestEvent(a.conversationId).catch(() => undefined); // an engine without event search: costs only
      if (latest && latest !== lastEvent) {
        lastEvent = latest;
        progressAt = now();
      }
    }
    const stalled = idle > 0 && Date.now() - Date.parse(progressAt) > idle * 60_000;
    return { progressAt, lastEvent, stalled };
  }

  // ---- follow-up messages: the outbox ----

  const markerOf = (c: Command) => `sf-msg-${c.id}`;

  /**
   * Write-ahead: the message and the attempt's next turn, in the caller's
   * transaction with the state change that caused them. Nothing is sent until
   * that commits; deliver() sends it, and a later tick does if it can't now.
   */
  function queueFollowUp(a: Attempt, text: string, reason: string): Command {
    const at = now();
    const cmd = ledger.addCommand({ runId: a.runId, attemptId: a.id, reason, text, state: "pending", nextAt: at, generation });
    ledger.updateAttempt(a.id, { state: "running", turns: a.turns + 1, seenRunning: false, lastSentAt: at, finishedAt: null, progressAt: at });
    record(SYSTEM, "autopilot.followup_queued", a.runId, { role: a.role, attempt: a.id, command: cmd.id, turn: a.turns + 1, reason });
    return cmd;
  }

  /** A follow-up with no other state change: queued, then delivered. */
  async function sendFollowUp(a: Attempt, text: string, reason: string) {
    await deliver(ledger.transaction(() => queueFollowUp(a, text, reason)));
  }

  /**
   * Sends a queued message, tagged with its marker. Refused connections retry
   * with backoff and go to a person after COMMAND_TRIES; a send that may have
   * arrived waits for reconcile(); a definite refusal goes to a person.
   */
  async function deliver(cmd: Command) {
    const a = ledger.getAttempt(cmd.attemptId) as Attempt;
    const agent = await remote(a);
    if (!agent) {
      ledger.updateCommand(cmd.id, { state: "failed", error: "Its conversation is gone." }); // the attempt now says so, and its step deals with it
      return changed(cmd.runId);
    }
    ledger.updateCommand(cmd.id, { state: "sending", tries: cmd.tries + 1 }); // a crash from here on leaves it for reconcile()
    try {
      await agent.send(a.conversationId, `${cmd.text}\n\n(${markerOf(cmd)})`);
    } catch (err) {
      if (err instanceof OpenHandsError && err.status === 429) {
        await agent.resume(a.conversationId).catch(warn); // saved, but the agent didn't start on it: nudge it
      } else if ((err instanceof OpenHandsError && err.status === 0 && err.delivery === "not_sent") || err instanceof RuntimeUnavailable) {
        return retryLater(ledger.getCommand(cmd.id) as Command, err);
      } else if (err instanceof OpenHandsError && err.status === 0) {
        ledger.updateCommand(cmd.id, { state: "ambiguous", nextAt: later(deps.commandRetryMs ?? 3000), error: clip(err.message) });
        return changed(cmd.runId);
      } else {
        return undeliverable(cmd, a, err);
      }
    }
    delivered(cmd, a);
  }

  const later = (ms: number) => new Date(Date.now() + ms).toISOString();

  function retryLater(cmd: Command, err: unknown) {
    if (cmd.tries >= COMMAND_TRIES) return undeliverable(cmd, ledger.getAttempt(cmd.attemptId) as Attempt, err);
    const delay = Math.min(300_000, (deps.commandRetryMs ?? 3000) * 2 ** (cmd.tries - 1));
    ledger.updateCommand(cmd.id, { state: "pending", nextAt: later(delay), error: clip(errorText(err)) });
    changed(cmd.runId);
  }

  function delivered(cmd: Command, a: Attempt, by = SYSTEM) {
    ledger.transaction(() => {
      ledger.updateCommand(cmd.id, { state: "delivered", error: null });
      // Its next end state counts from now.
      ledger.updateAttempt(a.id, { seenRunning: false, lastSentAt: now(), progressAt: now() });
    });
    record(by, "autopilot.followup_sent", a.runId, { role: a.role, attempt: a.id, conversationId: a.conversationId, command: cmd.id, turn: a.turns, reason: cmd.reason });
    changed(a.runId);
  }

  /** The agent server refused the message, or kept refusing connections: a person decides. */
  function undeliverable(cmd: Command, a: Attempt, err: unknown) {
    const run = mustRun(a.runId);
    const gone = err instanceof OpenHandsError && err.status === 404;
    ledger.transaction(() => {
      ledger.updateCommand(cmd.id, { state: "failed", error: clip(errorText(err), 500) });
      openItem(
        run,
        "undelivered",
        `A message to the ${a.role} of ${run.change} wasn't delivered`,
        `The ${cmd.reason} message to this ${a.role} couldn't be delivered: ${errorText(err)}\n\n${gone && a.role === "spec" ? "Its conversation is gone. A new spec agent can start from the files already there, with this message." : "Send it again once the agent server can take it, or cancel the run."}`,
        gone && a.role === "spec" ? SPEC_GONE : UNDELIVERED,
        a.workOrderId ?? undefined,
        `command:${cmd.id}`,
      );
    });
    record(SYSTEM, "autopilot.delivery_failed", run.id, { attempt: a.id, command: cmd.id, reason: cmd.reason, error: clip(errorText(err)) });
    changed(run.id);
  }

  /**
   * A message that may or may not have arrived (its answer was lost, or the
   * factory stopped mid-send): found by its marker means delivered; missing
   * after reconcileMs means it never arrived, so it's sent again; an engine
   * that can't search goes to a person.
   */
  async function reconcile(cmd: Command) {
    const a = ledger.getAttempt(cmd.attemptId) as Attempt;
    const agent = await remote(a);
    if (!agent) {
      ledger.updateCommand(cmd.id, { state: "failed", error: "Its conversation is gone." });
      return changed(cmd.runId);
    }
    let found: boolean;
    try {
      found = await agent.findUserMessage(a.conversationId, markerOf(cmd));
    } catch (err) {
      if (unreachable(err)) return; // ask again later
      ledger.transaction(() => {
        ledger.updateCommand(cmd.id, { state: "quarantined", error: clip(errorText(err)) });
        const run = mustRun(a.runId);
        openItem(
          run,
          "undelivered",
          `Did a message reach the ${a.role} of ${run.change}?`,
          `The ${cmd.reason} message may or may not have reached this ${a.role}: the answer was lost, and the agent server can't be searched for it (${errorText(err)}). Check the conversation, then send it again or confirm that it arrived.`,
          UNCONFIRMED,
          a.workOrderId ?? undefined,
          `command:${cmd.id}`,
        );
      });
      record(SYSTEM, "autopilot.delivery_quarantined", a.runId, { attempt: a.id, command: cmd.id, reason: cmd.reason });
      return changed(a.runId);
    }
    if (found) return delivered(cmd, a);
    if (Date.now() - Date.parse(cmd.updatedAt) < (deps.reconcileMs ?? 60_000)) return; // it may still be on its way
    ledger.updateCommand(cmd.id, { state: "pending", nextAt: now() }); // it never arrived: send it again
    record(SYSTEM, "autopilot.delivery_retried", a.runId, { attempt: a.id, command: cmd.id, reason: cmd.reason });
  }

  /** The run's messages that are due: sent, or looked for. */
  async function processCommands(runId: string) {
    for (const cmd of ledger.listCommands({ runId, states: ["pending", "sending", "ambiguous"] })) {
      if (cmd.nextAt > now() && cmd.state !== "sending") continue;
      if (cmd.state === "pending") await deliver(cmd);
      else await reconcile(cmd); // "sending" left by a stop mid-send is as uncertain as a lost answer
    }
  }

  // ---- spec stage ----

  /** Consecutive failed validations of this spec attempt, newest last. */
  function invalidStreak(run: Run, a: Attempt): number {
    const checks = ledger.listChecks({ runId: run.id }).filter((c) => c.name === "openspec-validate" && c.at >= a.startedAt);
    let n = 0;
    for (const c of checks.reverse()) {
      if (c.ok) break;
      n++;
    }
    return n;
  }

  function specFailed(run: Run, a: Attempt, reason: string) {
    ledger.transaction(() => {
      markHandled(a, { outcome: "failed", reason: clip(reason, 2000) });
      openItem(
        run,
        "spec_failed",
        `The spec agent couldn't finish ${run.change}`,
        `${reason}\n\nRetry starts a new spec agent in the same worktree; it continues from the files already there.`,
        RETRY,
      );
    });
    changed(run.id);
  }

  async function specStep(run: Run) {
    const a = latest(run.id, "spec");
    if (!a) return startAgent(run, "spec");
    if (ACTIVE.has(a.state) || a.state === "paused" || handled(a)) return; // working, or waiting for a person
    const dir = run.integrationDir as string;
    if (a.state !== "finished") return specFailed(run, a, await whyStopped(a, "The spec agent"));

    const check = await checkChange(run.change, dir);
    const tries = check.ok ? 0 : invalidStreak(run, a) + 1;
    // The check and the message that asks for a fix are written together; then the message goes.
    const { validateTries } = pinnedPolicy(run).spec;
    const ask = ledger.transaction(() => {
      ledger.addCheck({ runId: run.id, stage: "spec", name: "openspec-validate", ok: check.ok, exitCode: check.ok ? 0 : 1, durationMs: check.durationMs, output: check.output });
      return !check.ok && tries < validateTries ? queueFollowUp(a, validateFollowUp(run.change, check.output), "validate") : null;
    });
    changed(run.id);
    if (ask) await deliver(ask);
    if (!check.ok) {
      if (tries >= validateTries) specFailed(run, a, `\`openspec validate ${run.change} --strict\` still fails after ${tries} tries:\n\n${check.output}`);
      return;
    }

    const title = proposalTitle(readProposal(dir, run.change)) ?? run.goal;
    const committed = await commitAll(dir, `spec(${run.change}): ${clip(title, 72)}`);
    const sha = committed ?? await headSha(dir);
    if (committed) record(SYSTEM, "autopilot.spec_committed", run.id, { change: run.change, branch: run.integrationBranch, sha });
    ledger.transaction(() => {
      markHandled(a, { outcome: "valid", sha });
      moveRun(run, "critic");
    });
  }

  async function criticStep(run: Run) {
    const c = latest(run.id, "critic");
    if (!c || handled(c)) return startAgent(run, "critic");
    if (ACTIVE.has(c.state) || c.state === "paused") return;
    if (c.state !== "finished") {
      const why = await whyStopped(c, "The spec critic");
      markHandled(c, { outcome: "failed" });
      throw new Error(why);
    }

    const dir = run.integrationDir as string;
    const verdict = parseCriticVerdict(await (await agentFor(c)).finalResponse(c.conversationId));
    // Older persisted runs could omit the SHA when revalidation made no new commit.
    const specSha = (specAttempt(run).result as { sha?: string } | null)?.sha
      ?? auditFor(run.id).findLast((e) => e.action === "autopilot.spec_committed")?.data.sha;
    if (typeof specSha !== "string" || !/^[a-f0-9]{40,64}$/i.test(specSha)) {
      throw new Error("The critic has no recorded validated spec commit. Restore the spec attempt's SHA before retrying, or cancel this run.");
    }
    const onBranch = (await currentBranch(dir)) === run.integrationBranch;
    if (!onBranch) await git(dir, ["checkout", "-f", run.integrationBranch]);
    const committed = (await headSha(dir)) !== specSha;
    if (!onBranch || committed || !(await isClean(dir))) {
      await resetHard(dir, specSha);
      await discardChanges(dir);
      ledger.addCheck({ runId: run.id, stage: "spec", name: "critic-edits-discarded", ok: false, output: "The critic changed the worktree. Its edits and commits were thrown away." });
      record(SYSTEM, "autopilot.edits_discarded", run.id, { role: "critic", attempt: c.id, committed, switchedBranch: !onBranch });
    }
    record(SYSTEM, "autopilot.critic_verdict", run.id, { verdict: verdict.verdict, findings: verdict.findings.length, unreadable: verdict.unreadable });
    // No verdict to act on: ask the critic once more, then a person.
    if (verdict.unreadable) {
      if (c.turns < 2) return sendFollowUp(c, verdictReminder(), "unreadable_verdict");
      markHandled(c, verdict);
      throw new Error("The spec critic's reply had no readable verdict, even when asked again.");
    }

    // Rounds are reviews that gave a verdict; a critic that crashed or never answered readably doesn't use one up.
    const reviewed = (x: Attempt) => !!(x.result as CriticVerdict | null)?.verdict && !(x.result as CriticVerdict).unreadable;
    const rounds = 1 + ledger.listAttempts({ runId: run.id, role: "critic" }).filter((x) => x.id !== c.id && reviewed(x)).length;
    const serious = verdict.findings.some((f) => f.severity !== "low");
    if (verdict.verdict === "revise" && serious && rounds < pinnedPolicy(run).spec.criticRounds) {
      const ask = ledger.transaction(() => {
        markHandled(c, verdict);
        moveRun(run, "spec");
        return queueFollowUp(specAttempt(run), criticFollowUp(verdict.findings), "critic");
      });
      return deliver(ask);
    }
    // Findings that remain travel into the approval.
    ledger.transaction(() => {
      markHandled(c, verdict);
      afterCritic(run);
    });
  }

  function afterCritic(run: Run) {
    const questions = openQuestions(readProposal(run.integrationDir ?? "", run.change));
    if (run.autonomy !== "autonomous" || !questions.length) return toPlan(run);
    openItem(run, "questions", `The spec agent has ${questions.length} open question(s) about ${run.change}`, questionsBody(run, questions), QUESTIONS);
    moveRun(run, "awaiting_answers");
  }

  /**
   * Work orders from tasks.md (replacing those of an earlier plan), then the
   * plan goes to whoever approves it at this autonomy. A tasks.md that can't
   * be planned goes back to a person as spec_failed; a retry's spec agent is told why.
   */
  function toPlan(run: Run) {
    const replaced = ledger.deleteWorkOrders(run.id);
    let plan: ReturnType<typeof planWorkOrders>;
    try {
      plan = planWorkOrders(run.integrationDir ?? "", run.change);
    } catch (err) {
      const reason = errorText(err);
      markHandled(specAttempt(run), { outcome: "unplannable", reason: clip(reason, 2000) });
      openItem(
        run,
        "spec_failed",
        `Autopilot couldn't plan ${run.change}`,
        `The change is valid, but its tasks.md can't be turned into work orders:\n\n${reason}\n\nRetry starts a new spec agent in the same worktree and tells it this.`,
        RETRY,
      );
      return moveRun(run, "spec", { data: { reason: clip(reason), workOrdersDropped: replaced } });
    }
    ledger.addWorkOrders(run.id, plan);
    record(SYSTEM, "autopilot.work_orders_planned", run.id, {
      change: run.change,
      workOrders: plan.length,
      waves: Math.max(...plan.map((w) => w.wave)),
      replaced,
    });
    if (run.autonomy === "suggest") {
      openItem(run, "spec_approval", `Approve the spec for ${run.change}`, approvalBody(run), APPROVAL);
      return moveRun(run, "awaiting_spec_approval");
    }
    if (run.autonomy === "supervised") return askPlanApproval(run);
    return approvePlan(run, policyActor(run));
  }

  function askPlanApproval(run: Run) {
    openItem(run, "plan_approval", `Approve the plan for ${run.change}`, approvalBody(run), APPROVAL);
    return moveRun(run, "awaiting_plan_approval");
  }

  function approvePlan(run: Run, actor: string) {
    const critic = latest(run.id, "critic");
    const verdict = (critic?.result as CriticVerdict | null)?.verdict ?? null;
    return moveRun(run, "building", {
      actor,
      action: "autopilot.plan_approved",
      data: { critic: verdict, conversation: critic?.conversationId ?? null },
    });
  }

  const bullets = (items: string[]) => (items.length ? items.map((i) => `- ${i}`).join("\n") : "None.");

  function approvalBody(run: Run): string {
    const proposal = readProposal(run.integrationDir ?? "", run.change);
    const critic = latest(run.id, "critic")?.result as CriticVerdict | null | undefined;
    const workOrders = ledger.listWorkOrders(run.id);
    const table = [
      "| WO | Title | Wave | Risk | Depends on | Controls |",
      "| --- | --- | --- | --- | --- | --- |",
      ...workOrders.map((w) => `| WO-${w.seq} | ${w.title} | ${w.wave} | ${w.risk} | ${w.dependsOn.join(", ") || "none"} | ${w.controls.join(", ")} |`),
    ].join("\n");
    return [
      `**Change:** \`${run.change}\` on branch \`${run.integrationBranch}\`. Read it in \`openspec/changes/${run.change}/\`.`,
      "",
      "### Assumptions",
      bullets(assumptionsOf(proposal)),
      "",
      "### Open questions",
      bullets(openQuestions(proposal)),
      "",
      `### Critic: ${critic?.verdict ?? "no verdict"}`,
      critic?.findings?.length ? findingList(critic.findings) : "No findings.",
      "",
      "### Work orders",
      workOrders.length ? table : "None yet.",
    ].join("\n");
  }

  function questionsBody(run: Run, questions: string[]): string {
    return [
      `The spec agent for \`${run.change}\` couldn't settle these with an assumption:`,
      "",
      bullets(questions),
      "",
      "Answer them in the note and the spec agent revises the change, or proceed with its assumptions:",
      "",
      bullets(assumptionsOf(readProposal(run.integrationDir ?? "", run.change))),
    ].join("\n");
  }

  // ---- independent acceptance tests: the test writer ----

  /**
   * With hiddenTests enabled, a test writer (another vendor than the spec
   * agent, when there is one) writes black-box tests from the spec in its own
   * worktree. The factory keeps them outside every worktree, with digests,
   * and removes that worktree. Until then, finished work waits in verifying.
   */
  async function validatorStep(run: Run) {
    const v = verificationOf(run);
    if (!v || !pinnedPolicy(run).hiddenTests.enabled || v.hiddenTests) return;
    const a = latest(run.id, "validator");
    // None yet, or a person's retry after the last one failed.
    if (!a || (handled(a) && (a.result as { outcome?: string } | null)?.outcome === "failed")) return startValidator(run);
    if (ACTIVE.has(a.state) || a.state === "paused" || handled(a)) return;
    if (a.state !== "finished") {
      const why = await whyStopped(a, "The test writer");
      markHandled(a, { outcome: "failed" });
      throw new Error(`${why} Retry starts a new test writer.`);
    }
    const files = collectHiddenTests(run);
    if (!files.length) {
      if (a.turns < 2) return sendFollowUp(a, validatorFollowUp(), "no_tests");
      markHandled(a, { outcome: "failed" });
      throw new Error("The test writer wrote no tests named .hidden-tests/wo-<N>-<scenario>.test.mjs, even when asked again. Retry starts a new test writer.");
    }
    const digest = sha256(files.map((f) => `${f.name}:${f.sha256}`).join("\n"));
    ledger.transaction(() => {
      markHandled(a, { outcome: "written", files: files.length });
      ledger.updateRun(run.id, { verification: { ...v, hiddenTests: { files, digest } } });
      ledger.addCheck({ runId: run.id, stage: "spec", name: "hidden-tests-written", ok: true, output: `${files.length} hidden test(s) for ${new Set(files.map((f) => f.seq)).size} work order(s), kept outside every worktree.`, meta: { files: files.length, digest } });
    });
    record(SYSTEM, "autopilot.hidden_tests_recorded", run.id, { attempt: a.id, files: files.length, digest });
    await releaseAttempt(run, ledger.getAttempt(a.id) ?? a);
    await removeWorktree(workspace, validatorDir(run)).catch(warn);
    await deleteBranch(workspace, validatorBranch(run)).catch(warn);
    changed(run.id);
  }

  async function startValidator(run: Run) {
    const profile = await checkerProfile(pinnedPolicy(run).agents.validator, latest(run.id, "spec")?.agentProfile);
    await releaseMounted(run, null); // an earlier test writer's container has the old worktree mounted
    await addWorktree(workspace, validatorDir(run), validatorBranch(run), await headSha(workspace, run.integrationBranch));
    const attempt = ledger.addAttempt({ runId: run.id, role: "validator", conversationId: randomUUID(), agentProfile: profile.id });
    record(SYSTEM, "autopilot.agent_started", run.id, { role: "validator", attempt: attempt.id, conversationId: attempt.conversationId, profile: profile.name });
    await startConversation(attempt);
  }

  /** The test writer's files that follow the naming rule, for work orders the run has: copied out, with their digests. */
  function collectHiddenTests(run: Run) {
    const source = path.join(validatorDir(run), ".hidden-tests");
    const seqs = new Set(ledger.listWorkOrders(run.id).map((w) => w.seq));
    let names: string[] = [];
    try {
      // Regular files only: a symlink could point anywhere on this machine.
      names = readdirSync(source).filter((n) => HIDDEN_FILE.test(n) && lstatSync(path.join(source, n)).isFile());
    } catch {
      return [];
    }
    const kept: { name: string; seq: number; sha256: string }[] = [];
    mkdirSync(hiddenDir(run.id), { recursive: true });
    for (const name of names.sort().slice(0, HIDDEN_MAX_FILES)) {
      const seq = Number(HIDDEN_FILE.exec(name)?.[1]);
      const text = seqs.has(seq) ? readInside(source, name) : null;
      if (text === null || text.length > HIDDEN_MAX_BYTES) continue;
      writeFileSync(path.join(hiddenDir(run.id), name), text);
      kept.push({ name, seq, sha256: sha256(text) });
    }
    return kept;
  }

  // ---- build stage: dispatch, gates, review, repair ----

  const builders = (wo: WorkOrder) => ledger.listAttempts({ runId: wo.runId, workOrderId: wo.id, role: "builder" });
  const reviewers = (wo: WorkOrder) => ledger.listAttempts({ runId: wo.runId, workOrderId: wo.id, role: "reviewer" });

  function workOrderOf(item: InboxItem): WorkOrder {
    const wo = item.workOrderId ? ledger.getWorkOrder(item.workOrderId) : undefined;
    if (!wo) throw new Error(`Inbox item ${item.id} has no work order.`);
    return wo;
  }

  /**
   * Moves each work order one step (builder stopped -> gates -> reviewer ->
   * ready, or a repair), merges one, then dispatches what's ready. A step
   * that throws stops only its work order, which goes to a person.
   */
  async function buildStep(run: Run) {
    await validatorStep(run); // builders start meanwhile; their work waits in verifying for the hidden tests
    // ponytail: one work order's gates and one merge's integration gates per step, so polling and a person's action wait for two gate runs at most; give gates their own task if suites get slow.
    let gated = false;
    for (const wo of ledger.listWorkOrders(run.id)) {
      try {
        if (wo.state === "building") await builderStep(run, wo);
        else if (wo.state === "reviewing") await reviewStep(run, wo);
        else if (wo.state === "verifying" && !gated) {
          gated = true;
          await verify(run, wo);
        }
      } catch (err) {
        if (!unreachable(err)) workOrderError(run, wo, err);
      }
      if (ledger.getRun(run.id)?.state !== "building") return; // too many failures paused it
    }
    await integrateStep(run);
    if (ledger.getRun(run.id)?.state !== "building") return; // done, or too many failures paused it
    // Pending work orders whose dependencies are merged or skipped, in wave order, while there's room.
    const wos = ledger.listWorkOrders(run.id);
    const stateOf = new Map(wos.map((w) => [w.seq, w.state]));
    let room = pinnedPolicy(run).parallel - wos.filter((w) => BUSY_WO.has(w.state)).length;
    for (const wo of wos) {
      if (room <= 0) break;
      if (wo.state !== "pending" || !wo.dependsOn.every((d) => DONE_WO.has(stateOf.get(d) ?? "pending"))) continue;
      try {
        await dispatch(run, wo);
        if (ledger.getRun(run.id)?.state !== "building") return;
        room--;
      } catch (err) {
        if (unreachable(err)) return;
        workOrderError(run, wo, err); // resumes in pending: a retry dispatches it again
        if (ledger.getRun(run.id)?.state !== "building") return;
      }
    }
  }

  /**
   * A builder in a fresh worktree on the work order's own branch from the
   * integration tip. Git first, then the attempt (write-ahead), then the
   * agent server: a restart in between redoes the worktree or restarts the
   * conversation with the same id. `findings` go into the brief.
   */
  async function dispatch(run: Run, wo: WorkOrder, findings = wo.findings) {
    const profile = await client.resolveProfile(pinnedPolicy(run).agents.builder);
    const dir = path.join(worktrees, run.id, `wo-${wo.seq}`);
    // Not autopilot/<change>/wo-N: git can't have that next to the branch autopilot/<change>.
    const branch = `${run.integrationBranch}--wo-${wo.seq}`;
    const baseSha = await headSha(workspace, run.integrationBranch);
    await releaseMounted(run, wo.id); // a previous attempt's container has the old worktree mounted
    await addWorktree(workspace, dir, branch, baseSha);
    const round = builders(wo).length + 1;
    const attempt = ledger.transaction(() => {
      const a = ledger.addAttempt({ runId: run.id, workOrderId: wo.id, role: "builder", conversationId: randomUUID(), agentProfile: profile.id });
      moveWorkOrder(wo, "building", {
        patch: { branch, worktree: dir, baseSha, findings, resumeState: null },
        action: "autopilot.work_order_dispatched",
        data: { attempt: a.id, conversationId: a.conversationId, profile: profile.name, round, branch, baseSha },
      });
      return a;
    });
    await startConversation(attempt);
  }

  async function builderStep(run: Run, wo: WorkOrder) {
    const a = builders(wo).at(-1);
    if (!a || ACTIVE.has(a.state) || a.state === "paused" || handled(a)) return;
    if (a.state === "finished") return built(run, wo, a);
    await repair(run, wo, [{ source: "agent", severity: "high", title: await whyStopped(a, "The builder"), detail: "" }]);
  }

  /**
   * The builder is done. Its work must be on its own branch and go beyond
   * where it started; what it left uncommitted is committed. Then the gates.
   */
  async function built(run: Run, wo: WorkOrder, a: Attempt) {
    const dir = wo.worktree as string;
    const branch = await currentBranch(dir);
    if (branch !== wo.branch) {
      const where = branch ? `branch \`${branch}\`` : "a detached HEAD";
      return repair(run, wo, [{ source: "agent", severity: "high", title: `The work is on ${where}, not on \`${wo.branch}\``, detail: `Bring your commits back to \`${wo.branch}\` and work only there.` }]);
    }
    const sha = (await commitAll(dir, `WO-${wo.seq}: ${clip(wo.title, 72)}`)) ?? (await headSha(dir));
    if (sha === wo.baseSha) {
      return repair(run, wo, [{ source: "agent", severity: "high", title: "Nothing was built: the branch has no changes", detail: "Build the work order with its tests, then commit." }]);
    }
    ledger.transaction(() => {
      markHandled(a, { outcome: "built", sha });
      moveWorkOrder(wo, "verifying", { data: { attempt: a.id, sha } });
    });
  }

  /**
   * The checks a run runs: the policy's or the base branch's pinned at
   * creation (with installs where needed), else the branch's own scripts.
   * Runs from before pinning keep the policy's gates or detection.
   */
  function gatesFor(run: Run, dir: string): Gate[] {
    const v = verificationOf(run);
    if (!v) return pinnedPolicy(run).gates ?? detectGates(dir);
    if (v.source === "policy" && v.gates) return v.gates;
    if (v.source === "base" && v.gates) return [...installGates(dir, v.gates.map((g) => g.cwd ?? "")), ...v.gates];
    return detectGates(dir);
  }

  /**
   * The factory's own checks on the committed work: protected paths put back,
   * the pinned gates, then (on a clean checkout of the commit) the security
   * scan and the hidden tests. All pass -> `verified` for that commit and a
   * reviewer; anything else -> a repair round.
   */
  async function verify(run: Run, wo: WorkOrder) {
    const v = verificationOf(run);
    // Independent tests exist before any work is judged.
    if (v && pinnedPolicy(run).hiddenTests.enabled && !v.hiddenTests) return;
    const dir = wo.worktree as string;
    if (v) await restoreProtected(run, wo);
    const sha = await headSha(dir);
    const exec = executionFor(run);
    const { ok, results } = await runGates(dir, gatesFor(run, dir), exec.gateRunner(dir, run.id));
    recordGates(run, wo, "build", results, sha);
    if (!ok) return repair(run, wo, gateFindings(results));
    await discardChanges(dir); // what the gates left (build output), so anything left after the review is the reviewer's
    if (v) {
      const findings = await verifyCommit(run, wo, sha);
      if (findings.length) return repair(run, wo, findings);
    }
    await startReviewer(run, wo);
  }

  /** What the work may not change (the factory's rules, the hidden tests) goes back to how its base has it, recorded. */
  async function restoreProtected(run: Run, wo: WorkOrder) {
    const dir = wo.worktree as string;
    const base = wo.baseSha as string;
    const { files } = await diffStat(dir, base, "HEAD");
    const hits = files.map((f) => f.path).filter((p) => sensitiveMatch(p, pinnedPolicy(run).verification.protectedPaths));
    if (!hits.length) return;
    await restorePaths(dir, base, hits);
    const sha = await commitAll(dir, `WO-${wo.seq}: put back paths verification protects`);
    const list = hits.map((h) => `- ${h}`).join("\n");
    ledger.addCheck({ runId: run.id, workOrderId: wo.id, stage: "build", name: "protected-paths", ok: false, sha, output: `The work changed paths that verification protects. The factory put them back as they are on its base (${base.slice(0, 12)}):\n${list}` });
    record(SYSTEM, "autopilot.protected_paths_restored", run.id, { workOrder: `WO-${wo.seq}`, paths: hits.slice(0, 20), sha });
    changed(run.id);
  }

  /**
   * The security scan and the hidden tests, on a throwaway checkout of `sha`
   * no agent has seen. Nothing found -> a `verified` check for that commit,
   * which is what merging asks for.
   */
  async function verifyCommit(run: Run, wo: WorkOrder, sha: string): Promise<Finding[]> {
    const policy = pinnedPolicy(run);
    const v = verificationOf(run) as Verification;
    const scanning = policy.verification.trivy.mode !== "off";
    const hidden = policy.hiddenTests.enabled ? (v.hiddenTests?.files ?? []).filter((f) => f.seq === wo.seq) : [];
    const findings: Finding[] = [];
    const facts: Record<string, unknown> = { gates: v.source, scan: scanning ? policy.verification.trivy.mode : "off", hidden: policy.hiddenTests.enabled ? (hidden.length ? hidden.length : "none for this work order") : "off" };
    if (scanning || hidden.length) {
      const tree = verifyDir(run.id, `wo-${wo.seq}`);
      await addDetachedWorktree(workspace, tree, sha);
      try {
        // The scan first, while the checkout has nothing installed in it.
        if (scanning) {
          const scanned = await scanStep(run, wo, tree, sha);
          findings.push(...scanned.findings);
          facts.scanStatus = scanned.status;
        }
        if (hidden.length) {
          const failed = await hiddenStep(run, wo, tree, hidden.map((f) => f.name), sha);
          findings.push(...failed);
          facts.hiddenStatus = failed.length ? "failed" : "passed";
        }
      } finally {
        await removeWorktree(workspace, tree).catch(warn);
      }
    }
    if (!findings.length) {
      ledger.addCheck({ runId: run.id, workOrderId: wo.id, stage: "build", name: "verified", ok: true, sha, output: `Every required check passed on ${sha.slice(0, 12)}.`, meta: facts });
      record(SYSTEM, "autopilot.commit_verified", run.id, { workOrder: `WO-${wo.seq}`, sha, ...facts });
      changed(run.id);
    }
    return findings;
  }

  /**
   * Trivy on the commit, compared with its base: only what the work adds
   * counts, and only the policy's severities send it back. A scanner that
   * can't answer is recorded; in required mode the work order stops for a person.
   */
  async function scanStep(run: Run, wo: WorkOrder, tree: string, sha: string): Promise<{ findings: Finding[]; status: string }> {
    const tp = pinnedPolicy(run).verification.trivy;
    try {
      const info = await scannerInfo(trivy, tp);
      const found = await scan(trivy, tree, tp);
      const baseline = await baselineKeys(run, wo.baseSha as string, info);
      const fresh = found.filter((f) => !baseline.has(findingKey(f)));
      const blocking = fresh.filter((f) => tp.severities.includes(f.severity));
      const lines = blocking.slice(0, 20).map((f) => `- (${f.severity}) ${describeScan(f)}`);
      ledger.addCheck({
        runId: run.id,
        workOrderId: wo.id,
        stage: "build",
        name: "trivy",
        ok: !blocking.length,
        sha,
        output: [`Trivy ${info.version}, database ${info.dbUpdatedAt ?? "not used"}: ${found.length} finding(s), ${fresh.length} new, ${blocking.length} at the policy's severities.`, ...lines].join("\n"),
        meta: { ...info, status: blocking.length ? "findings" : "passed", resultSha256: scanDigest(found), found: counts(found), new: counts(fresh), blocking: counts(blocking) },
      });
      record(SYSTEM, "autopilot.scanned", run.id, { workOrder: `WO-${wo.seq}`, sha, version: info.version, dbUpdatedAt: info.dbUpdatedAt, new: fresh.length, blocking: blocking.length });
      return { findings: scanFindings(blocking), status: blocking.length ? "findings" : "passed" };
    } catch (err) {
      if (!(err instanceof ScannerUnavailable)) throw err;
      ledger.addCheck({ runId: run.id, workOrderId: wo.id, stage: "build", name: "trivy", ok: false, sha, output: `Not run: ${err.message}`, meta: { scanner: "trivy", status: "unavailable", mode: tp.mode } });
      record(SYSTEM, "autopilot.scan_unavailable", run.id, { workOrder: `WO-${wo.seq}`, sha, mode: tp.mode, reason: clip(err.message) });
      if (tp.mode === "required") throw new Error(`The required security scan can't run: ${err.message} Nothing merges without it; fix the scanner, then retry.`);
      return { findings: [], status: "unavailable" };
    }
  }

  /** What the base commit already has, scanned once per commit and kept as a check, so it never counts against a work order. */
  async function baselineKeys(run: Run, base: string, info: ScannerInfo): Promise<Set<string>> {
    const known = ledger.listChecks({ runId: run.id }).find((c) => c.name === "trivy-baseline" && c.sha === base && c.ok);
    if (known) return new Set((known.meta as { keys?: string[] } | null)?.keys ?? []);
    const tree = verifyDir(run.id, `base-${base.slice(0, 12)}`);
    await addDetachedWorktree(workspace, tree, base);
    let found: ScanFinding[];
    try {
      found = await scan(trivy, tree, pinnedPolicy(run).verification.trivy);
    } finally {
      await removeWorktree(workspace, tree).catch(warn);
    }
    const keys = [...new Set(found.map(findingKey))];
    ledger.addCheck({ runId: run.id, stage: "build", name: "trivy-baseline", ok: true, sha: base, output: `Trivy ${info.version} on the base ${base.slice(0, 12)}: ${found.length} finding(s) already there.`, meta: { ...info, resultSha256: scanDigest(found), found: counts(found), keys } });
    return new Set(keys);
  }

  /**
   * The work order's hidden tests on the clean checkout, each file on its own,
   * after installing what the packages need. A failure tells the builder the
   * scenario and one line of the failure, never the test.
   */
  async function hiddenStep(run: Run, wo: WorkOrder, tree: string, files: string[], sha: string): Promise<Finding[]> {
    const runGate = executionFor(run).gateRunner(tree, run.id);
    const results: GateResult[] = [];
    for (const gate of installGates(tree, packageDirs(tree))) {
      const r = await runGate(gate);
      results.push(r);
      if (!r.ok) {
        recordGates(run, wo, "build", results, sha);
        return gateFindings(results);
      }
    }
    results.push(...(await runHidden(run, tree, files, runGate)));
    recordGates(run, wo, "build", results, sha);
    return results.filter((r) => !r.ok && r.name.startsWith("hidden:")).map((r) => hiddenFinding(r));
  }

  /** Copies the hidden tests (checked against the digests recorded when they were written) into `dir`, runs each, removes them. */
  async function runHidden(run: Run, dir: string, files: string[], runGate: (gate: Gate) => Promise<GateResult>): Promise<GateResult[]> {
    const manifest = verificationOf(run)?.hiddenTests?.files ?? [];
    const target = path.join(dir, ".sf-hidden");
    rmSync(target, { recursive: true, force: true });
    mkdirSync(target, { recursive: true });
    try {
      for (const name of files) {
        const text = readInside(hiddenDir(run.id), name);
        if (text === null || sha256(text) !== manifest.find((f) => f.name === name)?.sha256) {
          throw new Error(`The hidden test ${name} is missing or changed since the test writer wrote it.`);
        }
        writeFileSync(path.join(target, name), text);
      }
      const results: GateResult[] = [];
      for (const name of files) {
        const r = await runGate({ name: `hidden:${name.replace(/\.test\.mjs$/, "")}`, run: `${pinnedPolicy(run).hiddenTests.run} .sf-hidden/${name}` });
        results.push({ ...r, output: r.ok ? "" : hiddenSummary(r.output) });
      }
      return results;
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  }

  const hiddenFinding = (r: GateResult): Finding => {
    const scenario = r.name.replace(/^hidden:wo-\d+-/, "");
    return { source: "hidden", severity: "high", title: `Hidden acceptance test for scenario "${scenario}" failed: ${r.output}`, detail: "", scenario };
  };

  /** One check per gate, and one audit record for the lot. `sha`: the commit they checked. */
  function recordGates(run: Run, wo: WorkOrder, stage: "build" | "integrate", results: GateResult[], sha?: string) {
    const runner = executionFor(run).kind;
    ledger.transaction(() => {
      for (const r of results) {
        ledger.addCheck({ runId: run.id, workOrderId: wo.id, stage, name: r.name, ok: r.ok, exitCode: r.exitCode, durationMs: r.durationMs, output: r.output, runner, sha });
      }
    });
    record(SYSTEM, "autopilot.gates_run", run.id, {
      workOrder: `WO-${wo.seq}`,
      stage,
      ok: results.every((r) => r.ok),
      gates: results.map((r) => r.name),
      failed: results.filter((r) => !r.ok).map((r) => r.name),
    });
    changed(run.id);
  }

  /** Write-ahead like dispatch: the attempt and the move to reviewing, then the agent server. */
  async function startReviewer(run: Run, wo: WorkOrder) {
    const profile = await checkerProfile(pinnedPolicy(run).agents.reviewer, builders(wo).at(-1)?.agentProfile);
    const attempt = ledger.transaction(() => {
      const a = ledger.addAttempt({ runId: run.id, workOrderId: wo.id, role: "reviewer", conversationId: randomUUID(), agentProfile: profile.id });
      if (wo.state !== "reviewing") moveWorkOrder(wo, "reviewing", { data: { attempt: a.id } });
      return a;
    });
    record(SYSTEM, "autopilot.agent_started", run.id, { role: "reviewer", workOrder: `WO-${wo.seq}`, attempt: attempt.id, conversationId: attempt.conversationId, profile: profile.name });
    await startConversation(attempt);
  }

  async function reviewStep(run: Run, wo: WorkOrder) {
    const r = reviewers(wo).at(-1);
    if (!r || handled(r)) return startReviewer(run, wo); // a person's retry after the last reviewer failed
    if (ACTIVE.has(r.state) || r.state === "paused") return;
    if (r.state !== "finished") {
      const why = await whyStopped(r, "The reviewer");
      markHandled(r, { outcome: "failed" });
      throw new Error(why);
    }

    const dir = wo.worktree as string;
    const verdict = parseVerdict(await (await agentFor(r)).finalResponse(r.conversationId));
    // The reviewer only reads: whatever it changed or committed is thrown away.
    const builtSha = (builders(wo).at(-1)?.result as { sha?: string } | null)?.sha;
    const onBranch = (await currentBranch(dir)) === wo.branch;
    // Back on the work order's branch first, so the reset below undoes a commit made there.
    if (!onBranch && wo.branch) await git(dir, ["checkout", "-f", wo.branch]);
    const head = await headSha(dir);
    const committed = !!builtSha && head !== builtSha;
    if (!onBranch || committed || !(await isClean(dir))) {
      await resetHard(dir, builtSha ?? head);
      await discardChanges(dir);
      ledger.addCheck({ runId: run.id, workOrderId: wo.id, stage: "build", name: "reviewer-edits-discarded", ok: false, output: "The reviewer left changes in the worktree. They were thrown away." });
      record(SYSTEM, "autopilot.edits_discarded", run.id, { role: "reviewer", workOrder: `WO-${wo.seq}`, attempt: r.id, committed, switchedBranch: !onBranch });
    }
    const ok = passed(verdict, pinnedPolicy(run).review.blocking);
    record(SYSTEM, "autopilot.review_verdict", run.id, {
      workOrder: `WO-${wo.seq}`,
      attempt: r.id,
      verdict: verdict.verdict,
      findings: verdict.findings.length,
      passed: ok,
      unreadable: !!verdict.unreadable,
    });
    // No verdict to act on: ask the reviewer once more, then a person.
    if (verdict.unreadable) {
      if (r.turns < 2) return sendFollowUp(r, verdictReminder(), "unreadable_verdict");
      markHandled(r, verdict);
      throw new Error("The reviewer's reply had no readable verdict, even when asked again.");
    }
    if (!ok) {
      await repair(run, wo, verdict.findings, () => markHandled(r, verdict));
      if (!handled(ledger.getAttempt(r.id) ?? r)) markHandled(r, verdict); // a fresh builder or a person took it: still handled
      return;
    }
    ledger.transaction(() => {
      markHandled(r, verdict);
      moveWorkOrder(wo, "ready", { data: { attempt: r.id, findings: verdict.findings.length } });
    });
  }

  /**
   * A failed round (gates, review, or the builder stopped). The findings go
   * back to the same builder twice, then to one fresh builder in a new
   * worktree, then to a person, whose retry allows one more fresh builder.
   */
  async function repair(run: Run, wo: WorkOrder, findings: Finding[], also?: () => void) {
    const all = builders(wo);
    const last = all.at(-1);
    const data = { workOrder: `WO-${wo.seq}`, findings: findings.length };
    const limits = pinnedPolicy(run).repair;
    // A conversation that never started, or is gone from the agent server, can't take a follow-up.
    if (last && !(last.result as { error?: string } | null)?.error && last.turns < 1 + limits.sameConversation) {
      // The work order's move, the message and `also` (the reviewer marked handled) commit together; then the message goes.
      const ask = ledger.transaction(() => {
        also?.();
        moveWorkOrder(wo, "building", { patch: { findings }, action: "autopilot.repair_requested", data: { ...data, builder: all.length, turn: last.turns + 1 } });
        return queueFollowUp(last, repairMessage(findings, executionFor(run).kind === "container"), "repair");
      });
      return deliver(ask);
    }
    const retries = ledger
      .listInbox({ state: "decided", runId: run.id })
      .filter((i) => i.workOrderId === wo.id && i.kind === "work_order_failed" && i.decision === "retry").length;
    if (all.length < 1 + limits.fresh + retries) {
      record(SYSTEM, "autopilot.repair_requested", run.id, { ...data, builder: all.length + 1, turn: 1 });
      return dispatch(run, wo, findings);
    }
    needsAttention(
      run,
      wo,
      "work_order_failed",
      `WO-${wo.seq} of ${run.change} failed: ${wo.title}`,
      `After ${all.length} builder conversation(s) it still fails:\n\n${clusterFindings(findings)}\n\nRetry gives it to one more fresh agent in a new worktree from the integration branch, told what went wrong. Skip lets the work orders that depend on it go ahead without it.`,
      WO_FAILED,
      findings,
    );
  }

  /** A step for this work order threw: it waits for a person, and the rest of the run goes on. */
  function workOrderError(run: Run, wo: WorkOrder, err: unknown) {
    console.error(`[autopilot] ${run.id} WO-${wo.seq}:`, err);
    const state = ledger.getWorkOrder(wo.id)?.state ?? wo.state;
    const body = `While in **${state}**:\n\n${errorText(err)}\n\nRetry picks up from there. Skip lets the work orders that depend on it go ahead without it.`;
    needsAttention(run, wo, "error", `WO-${wo.seq} of ${run.change} stopped: ${wo.title}`, body, WO_ERROR);
  }

  /** A work order a person has to look at. The third one in a run pauses the run. */
  function needsAttention(
    run: Run,
    wo: WorkOrder,
    kind: "work_order_failed" | "error",
    title: string,
    body: string,
    options: InboxOption[],
    findings?: Finding[],
  ) {
    ledger.transaction(() => {
      const current = ledger.getWorkOrder(wo.id) ?? wo; // the step may have moved it
      moveWorkOrder(current, "needs_attention", {
        patch: { resumeState: current.state, ...(findings ? { findings } : {}) },
        action: "autopilot.work_order_failed",
        data: { kind },
      });
      openItem(run, kind, title, body, options, wo.id);
      const failing = ledger.listWorkOrders(run.id).filter((w) => w.state === "needs_attention");
      if (failing.length < FAILING_TO_PAUSE) return;
      openItem(
        run,
        "run_paused",
        `${run.change} paused: ${failing.length} work orders need attention`,
        `${bullets(failing.map((w) => `WO-${w.seq}: ${w.title}`))}\n\nThat many failures usually share a cause (the spec, the plan or the workspace). Resume lets the other work orders go on; decide these work orders' own items once the run is going again.`,
        RUN_PAUSED,
      );
      moveRun(ledger.getRun(run.id) ?? run, "paused", {
        patch: { resumeState: "building", pausedReason: `${failing.length} work orders need attention` },
        action: "autopilot.run_paused",
        data: { failing: failing.length },
      });
    });
  }

  // ---- integrate stage: one merge at a time ----

  /**
   * Merges one approved work order per step into the integration branch,
   * lowest wave and seq first, and tests it there on top of what's merged.
   * When every work order is merged or skipped, the run is done.
   */
  async function integrateStep(run: Run) {
    // Ready work orders: what the policy allows queues to merge (one at a time), the rest go to a person.
    let queued = ledger.listWorkOrders(run.id).some((w) => w.state === "merging");
    for (const wo of ledger.listWorkOrders(run.id)) {
      if (wo.state !== "ready") continue;
      try {
        const check = await mergeCheck(run, wo);
        if (!check.auto) await askMergeApproval(run, wo, check);
        else if (!queued) {
          moveWorkOrder(wo, "merging", { actor: policyActor(run), patch: { preMergeSha: null } });
          queued = true;
        }
      } catch (err) {
        workOrderError(run, wo, err); // resumes in ready: a retry decides again
        if (ledger.getRun(run.id)?.state !== "building") return;
      }
    }
    // A merge a restart interrupted first, then the next one queued.
    const wos = ledger.listWorkOrders(run.id);
    const next = wos.find((w) => w.state === "merging" && w.preMergeSha) ?? wos.find((w) => w.state === "merging");
    if (next) await integrate(run, next).catch((err) => integrateFailed(run, next, err));
    for (const wo of ledger.listWorkOrders(run.id)) if (wo.state === "merged" && wo.worktree) await cleanUp(run, wo);
    if (ledger.getRun(run.id)?.state === "building" && ledger.listWorkOrders(run.id).every((w) => DONE_WO.has(w.state))) await finish(run);
  }

  /**
   * The pinned policy's merge decision for a work order, from what its branch
   * changes since base_sha (the integration sha it last started from) and
   * the dependencies it adds. The same answer for as long as its branch
   * doesn't change, wherever the integration branch has moved since.
   */
  async function mergeCheck(run: Run, wo: WorkOrder) {
    const policy = pinnedPolicy(run);
    const base = wo.baseSha ?? run.integrationBranch;
    const head = wo.branch as string;
    const stat = await diffStat(workspace, base, head);
    const files = stat.files.map((f) => f.path);
    const review = reviewers(wo).at(-1)?.result as ReviewVerdict | null | undefined;
    // What verification recorded for the branch's current head.
    const atHead = ledger.listChecks({ runId: run.id, workOrderId: wo.id });
    const sha = await headSha(workspace, head);
    const verified = atHead.findLast((c) => c.name === "verified" && c.ok && c.sha === sha)?.meta as { hiddenStatus?: string } | undefined;
    const scanned = atHead.findLast((c) => c.name === "trivy" && c.sha === sha)?.meta as { new?: { secret?: number } } | undefined;
    // This run ignores a changed check script; once merged, the next run would pin it. A person sees that.
    const pinned = verificationOf(run);
    const scripts = pinned?.source === "base" && pinned.gates ? await gatesAt(workspace, sha) : [];
    const changedChecks = pinned?.source === "base" ? (pinned.gates ?? []).filter((g) => scripts.find((s) => s.name === g.name)?.run !== g.run).map((g) => g.name) : [];
    const decision = evaluateMerge(policy, {
      autonomy: run.autonomy,
      gatesOk: true, // a work order is ready only once its gates have passed (verify)
      hiddenTestsOk: verified?.hiddenStatus === "passed" ? true : verified?.hiddenStatus === "failed" ? false : null,
      reviewPassed: !!review?.verdict && passed(review, policy.review.blocking),
      // New possible secrets below the scan's blocking severities still need a person.
      secretFindings: scanned?.new?.secret ?? 0,
      changedChecks,
      files,
      linesChanged: stat.linesChanged,
      newDependencies: await newDependencies(workspace, base, head, files),
    });
    return { ...decision, stat };
  }

  /** A person sees why the policy didn't merge it, and what it changes. */
  async function askMergeApproval(run: Run, wo: WorkOrder, check: { reasons: string[]; stat: Awaited<ReturnType<typeof diffStat>> }) {
    const { files, linesChanged } = check.stat;
    const list = files.slice(0, 30).map((f) => `- \`${f.path}\` (+${f.added} -${f.deleted})`);
    if (files.length > 30) list.push(`- and ${files.length - 30} more`);
    const body = [
      `**WO-${wo.seq}: ${wo.title}** passed its gates and review. Merging brings \`${wo.branch}\` into \`${run.integrationBranch}\`, where the gates run again.`,
      "",
      "### Why it needs you",
      bullets(check.reasons),
      "",
      `### ${files.length} file(s), ${linesChanged} line(s) changed`,
      ...list,
      "",
      "Send back tells its builder what to change (write it in the note). Skip lets the work orders that depend on it go ahead without it.",
    ].join("\n");
    ledger.transaction(() => {
      moveWorkOrder(wo, "awaiting_merge_approval");
      openItem(run, "merge_approval", `Merge WO-${wo.seq} of ${run.change}: ${wo.title}`, body, MERGE, wo.id);
    });
  }

  /**
   * Who lets a work order merge, and why a person had to: the policy (asked
   * again, with the same answer for the same branch), or the person who
   * approved it last. Never merged without one on record.
   */
  async function mergeActor(run: Run, wo: WorkOrder): Promise<{ actor: string; reasons: string[] }> {
    const { auto, reasons } = await mergeCheck(run, wo);
    if (auto) return { actor: policyActor(run), reasons };
    // An approval counts for the commit verified before it was given, not for one verified since.
    const since = verificationOf(run) ? (verifiedAt(run, wo, await headSha(workspace, wo.branch as string)) ?? "") : "";
    const approval = ledger
      .listInbox({ state: "decided", runId: run.id })
      .find((i) => i.workOrderId === wo.id && i.kind === "merge_approval" && i.decision === "merge" && (i.decidedAt ?? "") >= since);
    if (!approval?.decidedBy) throw new Error(`WO-${wo.seq} has no merge approval on record for its verified commit.`);
    return { actor: approval.decidedBy, reasons };
  }

  /** When the factory recorded `sha` of the work order as verified, or undefined. Only verify() writes these. */
  const verifiedAt = (run: Run, wo: WorkOrder, sha: string) =>
    ledger.listChecks({ runId: run.id, workOrderId: wo.id }).findLast((c) => c.name === "verified" && c.ok && c.sha === sha)?.at;

  /**
   * Merge, re-test, then merged; or the integration branch goes back to where
   * it was and the work order back to its builder, its branch brought up to
   * date with the integration branch (a conflict's markers left for it to
   * resolve). That counts as a repair round.
   */
  async function integrate(run: Run, wo: WorkOrder) {
    const dir = run.integrationDir as string;
    const v = verificationOf(run);
    // Required verification can't be bypassed: a head that wasn't verified (it moved since) is verified first.
    if (v && !wo.preMergeSha) {
      const head = await headSha(workspace, wo.branch as string);
      if (!verifiedAt(run, wo, head)) {
        moveWorkOrder(wo, "verifying", { action: "autopilot.verification_required", data: { sha: head } });
        return;
      }
    }
    const { actor, reasons } = await mergeActor(run, wo);
    const key = `WO-${wo.seq}`;
    // Saved before merging, so a restart (or a failure) knows where the integration branch was.
    let pre = wo.preMergeSha;
    if (!pre) {
      pre = await headSha(dir);
      ledger.updateWorkOrder(wo.id, { preMergeSha: pre });
    }
    const runGate = executionFor(run).gateRunner(dir, run.id);
    // The merged work orders' hidden tests, and this one's, on the combined code.
    const merged = new Set([wo.seq, ...ledger.listWorkOrders(run.id).filter((w) => w.state === "merged").map((w) => w.seq)]);
    const hidden = v && pinnedPolicy(run).hiddenTests.enabled ? (v.hiddenTests?.files ?? []).filter((f) => merged.has(f.seq)).map((f) => f.name) : [];
    const after = hidden.length ? () => runHidden(run, dir, hidden, runGate) : undefined;
    const r = await mergeAndTest(dir, wo.branch as string, `Merge ${key}: ${clip(wo.title, 72)}`, pre, v ? (d: string) => gatesFor(run, d) : pinnedPolicy(run).gates, runGate, after);
    if (r.results.length) recordGates(run, wo, "integrate", r.results, r.outcome === "conflict" ? undefined : r.sha);
    if (r.outcome === "merged") {
      moveWorkOrder(wo, "merged", {
        actor,
        patch: { mergedBy: actor },
        action: "autopilot.work_order_merged",
        data: { sha: r.sha, linesChanged: r.linesChanged, files: r.files, reasons },
      });
      return;
    }
    if (r.outcome === "conflict") record(SYSTEM, "autopilot.merge_conflicted", run.id, { workOrder: key, conflicts: r.conflicts });
    else record(SYSTEM, "autopilot.merge_reverted", run.id, { workOrder: key, resetTo: pre });
    const tip = await headSha(dir);
    await mergeInto(wo.worktree as string, run.integrationBranch);
    await repair(run, ledger.updateWorkOrder(wo.id, { baseSha: tip, preMergeSha: null }), r.findings);
  }

  /** A merge step threw: an untested merge comes off the integration branch, and the work order waits for a person (retry merges again). */
  async function integrateFailed(run: Run, wo: WorkOrder, err: unknown) {
    if (unreachable(err)) return; // the next step merges or sends it back again
    const pre = ledger.getWorkOrder(wo.id)?.preMergeSha;
    if (pre) await resetIntegration(run, wo, pre, SYSTEM);
    ledger.updateWorkOrder(wo.id, { preMergeSha: null });
    workOrderError(run, wo, err);
  }

  /** Puts the integration branch back to `pre` (also ending a half-done merge), audited when a merge had landed on it. */
  async function resetIntegration(run: Run, wo: WorkOrder, pre: string, actor: string) {
    const dir = run.integrationDir as string;
    const landed = (await headSha(dir)) !== pre;
    await resetHard(dir, pre);
    if (landed) record(actor, "autopilot.merge_reverted", run.id, { workOrder: `WO-${wo.seq}`, resetTo: pre });
  }

  /** A merged work order's worktree and branch go; its commits live on in the integration branch. A failure is tried again next step. */
  async function cleanUp(run: Run, wo: WorkOrder) {
    try {
      await releaseMounted(run, wo.id);
      await removeWorktree(workspace, wo.worktree as string);
      if (wo.branch) await deleteBranch(workspace, wo.branch);
    } catch (err) {
      return warn(err);
    }
    ledger.updateWorkOrder(wo.id, { worktree: null });
    record(SYSTEM, "autopilot.branch_cleaned", run.id, { workOrder: `WO-${wo.seq}`, branch: wo.branch });
    changed(run.id);
  }

  /**
   * Every work order is merged or skipped. The integration branch is the
   * deliverable: its worktree goes, the branch stays. With nothing merged
   * (every work order skipped) there's nothing to deliver, and the run failed.
   */
  async function finish(run: Run) {
    const wos = ledger.listWorkOrders(run.id);
    const merged = wos.filter((w) => w.state === "merged").length;
    const sha = await headSha(workspace, run.integrationBranch);
    await releaseMounted(run);
    await removeWorktree(workspace, validatorDir(run)).catch(warn);
    await deleteBranch(workspace, validatorBranch(run)).catch(warn);
    if (run.integrationDir) await removeWorktree(workspace, run.integrationDir);
    moveRun(run, merged ? "done" : "failed", {
      patch: { integrationDir: null, resumeState: null },
      action: merged ? "autopilot.run_completed" : "autopilot.run_failed",
      data: { branch: run.integrationBranch, sha, costUsd: ledger.runCost(run.id), merged, skipped: wos.length - merged },
    });
  }

  // ---- the scheduler ----

  /** Starts or polls the run's agents, then takes its next step. */
  async function advance(runId: string) {
    await reconcilePauses(runId);
    // Set after the run started: its local agents stop here rather than run unisolated.
    if (isolationRequired() && executionFor(mustRun(runId)).kind === "local") {
      throw new Error("This factory now requires isolated execution (SF_REQUIRE_ISOLATION), but this run's pinned policy runs agents on this machine. Cancel it and start a new run with execution.provider: container.");
    }
    if (!enforceBudgets(mustRun(runId))) return;
    await processCommands(runId);
    for (const a of ledger.listAttempts({ runId }).filter((x) => ACTIVE.has(x.state))) {
      if (a.workOrderId && ledger.getWorkOrder(a.workOrderId)?.state === "needs_attention") continue;
      await (a.state === "starting" ? startConversation(a) : poll(a));
      const run = mustRun(runId);
      if (run.state === "paused" || !enforceBudgets(run)) return;
    }
    const run = ledger.getRun(runId);
    if (run?.state === "spec") await specStep(run);
    else if (run?.state === "critic") await criticStep(run);
    else if (run?.state === "building") await buildStep(run);
  }

  /** Cheap: hands each live run to advance(), skipping runs that are still busy, and removes containers no attempt needs. */
  async function tick() {
    if (!lead()) return; // another process acts on this ledger; this one stands by
    for (const run of ledger.listRuns()) {
      if (TERMINAL.has(run.state)) continue;
      launch(run.id, async () => {
        if (run.state !== "paused") await advance(run.id);
        await releaseRetired(run.id);
      });
    }
    // A finished run whose containers couldn't be removed when it ended.
    for (const runId of new Set(ledger.liveRuntimes().map((a) => a.runId))) {
      if (TERMINAL.has(ledger.getRun(runId)?.state ?? "done")) launch(runId, () => releaseRetired(runId));
    }
  }

  /** Containers this factory owns that no live attempt accounts for (a crash mid-gate, say) go when it starts. */
  async function sweepOrphans() {
    if (!ledger.usedContainers()) return; // nothing ever ran in a container: don't call Docker at all
    const keep = new Set<string>();
    for (const a of ledger.liveRuntimes()) {
      const run = ledger.getRun(a.runId);
      if (run && !TERMINAL.has(run.state)) keep.add((a.runtime as ExecutionFacts).container ?? "");
    }
    // Starting attempts may have a container whose facts weren't recorded yet.
    for (const a of ledger.activeAttempts()) keep.add(`sf-${a.runId}-a${a.id}`);
    await sweepContainers(execDeps, keep);
  }

  async function idle() {
    while (inflight.size) await Promise.all(inflight.values());
  }

  // ---- what people do ----

  /** The lowest of what was asked for, the policy's autonomy.max and the org-wide SF_AUTONOMY_CAP. */
  function clampAutonomy(requested: Autonomy, max: Autonomy): Autonomy {
    const env = process.env.SF_AUTONOMY_CAP as Autonomy | undefined;
    const caps = [max, ...(env && AUTONOMY.includes(env) ? [env] : [])];
    return AUTONOMY[Math.min(AUTONOMY.indexOf(requested), ...caps.map((c) => AUTONOMY.indexOf(c)))] ?? requested;
  }

  // One run is created at a time: two at once (a double-click) would both init the repo or pick the same change name.
  let creating: Promise<unknown> = Promise.resolve();
  function createRun(input: { goal: string; autonomy?: Autonomy; budgetUsd?: number | null; actor: string }): Promise<Run> {
    const next = creating.then(() => {
      mustLead();
      return createRunNow(input);
    });
    creating = next.catch(() => undefined);
    return next;
  }

  async function createRunNow(input: { goal: string; autonomy?: Autonomy; budgetUsd?: number | null; actor: string }): Promise<Run> {
    const goal = typeof input.goal === "string" ? input.goal.trim() : "";
    if (!goal || goal.length > 4000) throw new Error("The goal must be 1 to 4000 characters.");
    if (input.autonomy !== undefined && !AUTONOMY.includes(input.autonomy)) throw new Error(`Autonomy must be one of: ${AUTONOMY.join(", ")}.`);
    const budgetUsd = input.budgetUsd ?? null;
    if (budgetUsd !== null && !(typeof budgetUsd === "number" && Number.isFinite(budgetUsd) && budgetUsd > 0)) {
      throw new Error("The budget must be a positive number of dollars.");
    }
    if (!existsSync(workspace)) throw new Error(`The workspace ${workspace} doesn't exist.`);

    if ((await ensureRepo(workspace)).initialized) {
      record(input.actor, "autopilot.workspace_initialized", path.basename(workspace), { path: workspace });
    }
    const baseBranch = (await currentBranch(workspace)) ?? "main";
    // The rules this run keeps to the end, from the base branch: an invalid policy.yml stops it here.
    const { policy, hash, source } = await loadPolicy(workspace, baseBranch);
    // Execution the policy (or SF_REQUIRE_ISOLATION) asks for and this machine can't give is refused now.
    const preflight = await checked(createExecution(policy, execDeps).preflight({ probe: true }), input.actor);
    if (!preflight.ok) throw new Error(`Autopilot can't run agents the way the policy requires: ${preflight.problems.join(" ")}`);
    const requested = input.autonomy ?? policy.autonomy.default;
    const autonomy = clampAutonomy(requested, policy.autonomy.max);
    const taken = await takenChangeNames(workspace, baseBranch);
    for (const r of ledger.listRuns()) taken.add(r.change);
    const change = changeNameFor(goal, taken);
    const id = `ap-${randomBytes(4).toString("hex")}`;
    const integrationDir = path.join(worktrees, id, "integration");
    const integrationBranch = `autopilot/${change}`;
    const baseSha = await headSha(workspace, `refs/heads/${baseBranch}`);
    await addWorktree(workspace, integrationDir, integrationBranch, baseSha);
    // The checks every work order of this run faces, fixed now from the base: a work order can't change them.
    const based = policy.gates ? [] : await gatesAt(workspace, baseSha);
    const verification: Verification = {
      gates: policy.gates ?? (based.length ? based : null),
      source: policy.gates ? "policy" : based.length ? "base" : "worktree",
      baseSha,
      hiddenTests: null,
    };

    const run = ledger.createRun({ id, goal, change, autonomy, budgetUsd, baseBranch, integrationBranch, integrationDir, policy, policyHash: hash, verification, createdBy: input.actor });
    record(input.actor, "autopilot.run_created", id, {
      change,
      autonomy,
      ...(autonomy !== requested ? { requestedAutonomy: requested } : {}),
      goalSummary: clip(goal),
      goalSha256: sha256(goal),
      budgetUsd,
      policyHash: hash,
    });
    record(SYSTEM, "autopilot.policy_loaded", id, { hash, source, policy });
    record(SYSTEM, "autopilot.verification_pinned", id, { source: verification.source, baseSha, gates: (verification.gates ?? []).map((g) => g.name) });
    changed(id);
    return run;
  }

  /** Keeps and audits a preflight's outcome (no secrets: credential names at most). */
  async function checked(pending: Promise<Preflight>, actor: string): Promise<Preflight> {
    const result = await pending;
    lastPreflight = result;
    record(actor, "autopilot.execution_checked", path.basename(workspace), {
      provider: result.provider,
      ok: result.ok,
      required: result.required,
      problems: result.problems.map((p) => clip(p)),
    });
    return result;
  }

  /** The policy on the workspace's current branch, for what a run started now would pin. */
  async function currentPolicy() {
    const isRepo = await isRepoRoot(workspace).catch(() => false);
    const branch = isRepo ? await currentBranch(workspace) : null;
    if (!branch) return { isRepo, branch, policy: DEFAULT_POLICY, source: "defaults", hash: policyHash(DEFAULT_POLICY), error: null as string | null };
    return loadPolicy(workspace, branch).then(
      (p) => ({ isRepo, branch, ...p, error: null as string | null }),
      (err: unknown) => ({ isRepo, branch, policy: null, source: `${POLICY_FILE}@${branch}`, hash: "", error: errorText(err) }),
    );
  }

  /** Runs the execution checks a new run would face, including the container probe, for the Home page's button. */
  async function checkExecution(actor: string): Promise<Preflight> {
    const current = await currentPolicy();
    if (!current.policy) throw new Error(`The policy has a problem: ${current.error}`);
    return checked(createExecution(current.policy, execDeps).preflight({ probe: true }), actor);
  }

  function mustRun(runId: string): Run {
    const run = ledger.getRun(runId);
    if (!run) throw new Error(`No run ${runId}`);
    return run;
  }

  async function cancelRun(run: Run, actor: string, note: string | null) {
    if (TERMINAL.has(run.state)) throw new Error(`The run is already ${run.state}.`);
    for (const a of ledger.listAttempts({ runId: run.id })) {
      if (!ACTIVE.has(a.state) && a.state !== "paused") continue;
      await remote(a).then((agent) => agent?.pause(a.conversationId)).catch(warn);
      ledger.updateAttempt(a.id, { state: "cancelled", finishedAt: now() });
    }
    for (const cmd of ledger.listCommands({ runId: run.id, states: OPEN_COMMANDS })) ledger.updateCommand(cmd.id, { state: "cancelled" });
    await releaseMounted(run); // before the worktrees they mount go; one that fails is removed by a later tick
    // A merge a restart interrupted before its gates ran doesn't stay on the deliverable.
    const merging = ledger.listWorkOrders(run.id).find((w) => w.state === "merging" && w.preMergeSha);
    if (merging?.preMergeSha && run.integrationDir) await resetIntegration(run, merging, merging.preMergeSha, actor).catch(warn);
    for (const wo of ledger.listWorkOrders(run.id)) {
      if (wo.worktree) await removeWorktree(workspace, wo.worktree).catch(warn);
      if (wo.branch) await deleteBranch(workspace, wo.branch).catch(warn);
      if (!DONE_WO.has(wo.state)) moveWorkOrder(wo, "cancelled", { actor, patch: { worktree: null, resumeState: null } });
    }
    // The integration branch stays: it holds whatever was committed so far.
    await removeWorktree(workspace, validatorDir(run)).catch(warn);
    await deleteBranch(workspace, validatorBranch(run)).catch(warn);
    if (run.integrationDir) await removeWorktree(workspace, run.integrationDir).catch(warn);
    ledger.dismissInbox({ runId: run.id });
    return moveRun(run, "cancelled", {
      patch: { integrationDir: null, resumeState: null },
      actor,
      action: "autopilot.run_cancelled",
      data: { branch: run.integrationBranch, note: note ? clip(note) : null },
    });
  }

  /** Include uncertain active attempts: a previous resume and its compensating pause may both have lost their response. */
  async function resumeAgents(run: Run, actor: string, workOrderId?: string) {
    for (const a of ledger.listAttempts({ runId: run.id })) {
      if (a.state !== "paused" && !ACTIVE.has(a.state)) continue;
      if (workOrderId && a.workOrderId !== workOrderId) continue;
      if (!workOrderId && a.workOrderId && ledger.getWorkOrder(a.workOrderId)?.state === "needs_attention") continue;
      const agent = await remote(a);
      if (!agent) continue; // its container is gone; the attempt now says so and the run's next step deals with it
      if (a.state === "starting" && !(await agent.get(a.conversationId))) continue;
      ledger.updateAttempt(a.id, { state: "running", seenRunning: false, lastSentAt: now() });
      record(actor, "autopilot.agent_resume_requested", run.id, { attempt: a.id, role: a.role, conversationId: a.conversationId });
      await agent.resume(a.conversationId);
      record(actor, "autopilot.agent_resumed", run.id, { attempt: a.id, role: a.role, conversationId: a.conversationId });
    }
  }

  async function unpause(run: Run, actor: string) {
    await resumeAgents(run, actor);
    return moveRun(run, run.resumeState ?? "spec", {
      patch: { resumeState: null, pausedReason: null },
      actor,
      action: "autopilot.run_resumed",
    });
  }

  async function pause(runId: string, opts: { note?: string | null; actor: string }): Promise<Run> {
    mustLead();
    return locked(runId, async () => {
      const run = mustRun(runId);
      if (TERMINAL.has(run.state) || run.state === "paused") throw new Error(`The run is already ${run.state}.`);
      const note = opts.note?.trim();
      const paused = moveRun(run, "paused", {
        patch: { resumeState: run.state, pausedReason: note || `Paused by ${opts.actor}` },
        actor: opts.actor,
        action: "autopilot.run_paused",
        data: { note: note ? clip(note) : null },
      });
      await reconcilePauses(runId);
      return paused;
    });
  }

  async function resume(runId: string, opts: { note?: string | null; actor: string }): Promise<Run> {
    mustLead();
    return locked(runId, async () => {
      const run = mustRun(runId);
      if (run.state !== "paused") throw new Error(`The run isn't paused (it's ${run.state}).`);
      requireBudgetDecision(run);
      const resumed = await unpause(run, opts.actor);
      // Resuming answers the item the pause came with. A work order's own error item stays for its work order.
      for (const item of ledger.listInbox({ runId })) {
        const decision = item.kind === "run_paused" ? "resume" : item.kind === "error" && !item.workOrderId ? "retry" : null;
        if (decision) {
          ledger.decideInbox(item.id, { decision, note: "Resumed from the pipeline", by: opts.actor });
          record(opts.actor, "autopilot.inbox_decided", run.id, { item: item.id, kind: item.kind, choice: decision });
        }
      }
      return resumed;
    });
  }

  async function cancel(runId: string, opts: { note?: string | null; actor: string }): Promise<Run> {
    mustLead();
    return locked(runId, async () => cancelRun(mustRun(runId), opts.actor, opts.note?.trim() || null));
  }

  function requireBudgetDecision(run: Run) {
    if (ledger.listInbox({ runId: run.id }).some((i) => i.kind === "budget_reached" && !i.workOrderId)) {
      throw new Error("The run reached its budget. Increase the budget using its Inbox item before resuming.");
    }
  }

  /** Carries out a person's choice on an inbox item (already validated). */
  /** Carries out a person's choice. A message it queues comes back, to be sent once the decision is recorded. */
  async function act(run: Run, item: InboxItem, choice: string, note: string | null, actor: string): Promise<Command | void> {
    switch (`${item.kind}:${choice}`) {
      case "spec_approval:approve":
        record(actor, "autopilot.spec_approved", run.id, { change: run.change });
        ledger.transaction(() => askPlanApproval(run));
        return;
      case "plan_approval:approve":
        approvePlan(run, actor);
        return;
      case "spec_approval:revise":
      case "plan_approval:revise":
        return ledger.transaction(() => {
          moveRun(run, "spec", { actor });
          return queueFollowUp(specAttempt(run), reviseFollowUp(note ?? ""), "revise");
        });
      case "questions:answer":
        return ledger.transaction(() => {
          moveRun(run, "spec", { actor });
          return queueFollowUp(specAttempt(run), answerFollowUp(note ?? ""), "answer");
        });
      case "undelivered:resend": {
        // The same message (and marker) goes again; if the first did arrive, the agent sees it twice, as the person chose.
        const cmd = commandOf(item);
        ledger.updateCommand(cmd.id, { state: "pending", nextAt: now(), tries: 0, error: null });
        record(actor, "autopilot.delivery_resend", run.id, { command: cmd.id, attempt: cmd.attemptId });
        return ledger.getCommand(cmd.id) as Command;
      }
      case "undelivered:delivered": {
        const cmd = commandOf(item);
        delivered(cmd, ledger.getAttempt(cmd.attemptId) as Attempt, actor);
        return;
      }
      case "undelivered:restart": {
        // Its conversation is gone: a new spec agent starts from the files, told what the lost message said.
        const cmd = commandOf(item);
        const old = ledger.getAttempt(cmd.attemptId) as Attempt;
        ledger.transaction(() => {
          ledger.updateCommand(cmd.id, { state: "cancelled" });
          ledger.updateAttempt(old.id, { state: "error", finishedAt: old.finishedAt ?? now(), result: { outcome: "failed", turn: old.turns, reason: `The previous spec agent's conversation was gone, so this message never reached it:\n\n${cmd.text}` } });
        });
        if (run.state !== "spec") moveRun(run, "spec", { actor });
        await startAgent(mustRun(run.id), "spec");
        return;
      }
      case "questions:proceed":
        ledger.transaction(() => toPlan(run));
        return;
      case "spec_failed:retry":
        await startAgent(run, "spec");
        return;
      case "error:retry":
        if (item.workOrderId) {
          // The work order picks up where its step threw (a reviewer that failed is started again).
          const wo = workOrderOf(item);
          moveWorkOrder(wo, wo.resumeState ?? "pending", { actor, patch: { resumeState: null } });
        } else if (run.state === "paused") { requireBudgetDecision(run); await unpause(run, actor); }
        return;
      case "run_paused:resume":
        if (run.state === "paused") { requireBudgetDecision(run); await unpause(run, actor); }
        return;
      case "budget_reached:continue": {
        if (item.workOrderId) {
          const wo = workOrderOf(item);
          const extra = wo.budgetExtraUsd + pinnedPolicy(run).budget.perWorkOrderUsd;
          await resumeAgents(run, actor, wo.id);
          moveWorkOrder(wo, wo.resumeState ?? "building", { actor, patch: { budgetExtraUsd: extra, resumeState: null }, action: "autopilot.budget_increased", data: { limitUsd: pinnedPolicy(run).budget.perWorkOrderUsd + extra } });
        } else {
          const limit = runBudget(run) + pinnedPolicy(run).budget.perChangeUsd;
          await unpause(run, actor);
          ledger.updateRun(run.id, { budgetUsd: limit });
          record(actor, "autopilot.budget_increased", run.id, { limitUsd: limit });
        }
        return;
      }
      case "work_order_failed:retry":
        // Back in the queue: dispatch gives it a fresh worktree, and wo.findings go into the new brief.
        moveWorkOrder(workOrderOf(item), "pending", { actor, patch: { resumeState: null } });
        return;
      case "merge_approval:merge":
        // Queued: a later step merges it, one merge at a time, and runs the gates again.
        moveWorkOrder(workOrderOf(item), "merging", { actor, patch: { preMergeSha: null } });
        return;
      case "merge_approval:send_back":
        await repair(run, workOrderOf(item), [{ source: "review", severity: "high", title: "A person asks for changes before this merges", detail: note ?? "" }]);
        return;
      case "merge_approval:skip":
      case "error:skip":
      case "budget_reached:skip":
      case "work_order_failed:skip": {
        const wo = workOrderOf(item);
        for (const a of ledger.listAttempts({ runId: run.id, workOrderId: wo.id }).filter((x) => ACTIVE.has(x.state) || x.state === "paused")) {
          await (await remote(a))?.pause(a.conversationId);
          ledger.updateAttempt(a.id, { state: "cancelled", finishedAt: now() });
          record(actor, "autopilot.agent_cancelled", run.id, { attempt: a.id, role: a.role, conversationId: a.conversationId });
        }
        if (wo.worktree) await removeWorktree(workspace, wo.worktree).catch(warn); // the branch keeps what it did
        moveWorkOrder(wo, "skipped", { actor, patch: { worktree: null, resumeState: null } });
        return;
      }
      default:
        throw new Error(`Autopilot doesn't know how to "${choice}" a ${item.kind} item.`);
    }
  }

  function commandOf(item: InboxItem): Command {
    const id = Number(/^command:(\d+)$/.exec(item.ref ?? "")?.[1]);
    const cmd = Number.isInteger(id) ? ledger.getCommand(id) : undefined;
    if (!cmd) throw new Error(`Inbox item ${item.id} has no message on record.`);
    return cmd;
  }

  /** A person's decision on an inbox item. The choice must be one of its options; some need a note. */
  async function decide(id: number, input: { choice: string; note?: string | null }, actor: string): Promise<InboxItem> {
    const found = ledger.getInbox(id);
    if (!found) throw new Error(`No inbox item ${id}`);
    mustLead();
    return locked(found.runId, async () => {
      const item = ledger.getInbox(id) as InboxItem;
      if (item.state !== "open") throw new Error(`Inbox item ${id} is already ${item.state}.`);
      const option = item.options.find((o) => o.id === input.choice);
      if (!option) throw new Error(`Choose one of: ${item.options.map((o) => o.id).join(", ")}.`);
      const note = input.note?.trim() || null;
      if (option.needsNote && !note) throw new Error(`"${option.label}" needs a note.`);
      const run = mustRun(item.runId);
      if (run.state === "paused" && item.kind !== "error" && item.kind !== "run_paused" && !(item.kind === "budget_reached" && !item.workOrderId) && input.choice !== "cancel") {
        throw new Error("The run is paused. Resume it first.");
      }

      const close = () => {
        const decided = ledger.decideInbox(id, { decision: input.choice, note, by: actor });
        record(actor, "autopilot.inbox_decided", run.id, { item: id, kind: item.kind, choice: input.choice, note: note ? clip(note) : null });
        changed(run.id);
        return decided;
      };
      // Cancelling dismisses the run's open items, so record this decision first.
      if (input.choice === "cancel") {
        close();
        await cancelRun(run, actor, note);
        return ledger.getInbox(id) as InboxItem;
      }
      const ask = await act(run, item, input.choice, note, actor); // throws -> the item stays open
      await reconcilePauses(run.id);
      const decided = close();
      if (ask) await deliver(ask).catch(warn); // queued: a later tick sends it if this can't
      return decided;
    });
  }

  /** What verification a run started now would get, and whether its scanner answers as the policy requires. */
  async function verificationStatus(policy: typeof DEFAULT_POLICY) {
    const tp = policy.verification.trivy;
    const scanner =
      tp.mode === "off"
        ? { mode: tp.mode, ok: null, version: null, dbUpdatedAt: null, problem: null }
        : await scannerInfo(trivy, tp).then(
            (i) => ({ mode: tp.mode, ok: true, version: i.version, dbUpdatedAt: i.dbUpdatedAt, problem: null as string | null }),
            (err: unknown) => ({ mode: tp.mode, ok: false, version: null, dbUpdatedAt: null, problem: errorText(err) }),
          );
    return { hiddenTests: policy.hiddenTests.enabled, protectedPaths: policy.verification.protectedPaths, scanner };
  }

  /** heldBy: another live process that holds the lease, so this one only answers. */
  function schedulerStatus() {
    const lease = ledger.getLease(LEASE);
    const other = lease && lease.owner !== owner && Date.parse(lease.expiresAt) > Date.now() ? lease.owner : null;
    return { active: !stale && !other, heldBy: other };
  }

  async function status() {
    const agent = await client.listProfiles().then(
      (r) => ({ reachable: true, error: null as string | null, profiles: r.profiles, activeProfileId: r.activeId }),
      (err: unknown) => ({ reachable: false, error: errorText(err), profiles: [], activeProfileId: null }),
    );
    // The policy a run started now would pin; an invalid policy.yml shows here before anyone starts one.
    const { isRepo, branch, policy, source, hash, error } = await currentPolicy();
    const provider = (policy ?? DEFAULT_POLICY).execution.provider;
    const container = (policy ?? DEFAULT_POLICY).execution.container;
    return {
      agentServer: { url: client.baseUrl, ...agent },
      workspace: { path: workspace, isRepo, branch },
      policy: { source, hash, error },
      execution: {
        provider,
        isolated: provider === "container",
        required: isolationRequired(),
        image: provider === "container" ? container.image : null,
        network: provider === "container" ? container.network : null,
        // The last check, while it's about the same kind of execution.
        preflight: lastPreflight?.provider === provider ? lastPreflight : null,
      },
      verification: await verificationStatus(policy ?? DEFAULT_POLICY),
      scheduler: schedulerStatus(),
      openInbox: ledger.openInboxCount(),
      activeRuns: ledger.listRuns().filter((r) => !TERMINAL.has(r.state)).length,
    };
  }

  return {
    ledger,
    evidence: (runId: string, actor: string) => locked(runId, () => exportEvidence(ledger, workspace, runId, actor)),
    createRun,
    decide,
    pause,
    resume,
    cancel,
    tick,
    idle,
    status,
    checkExecution,
    sweepOrphans,
    /** Runs tick() every `intervalMs` (index.ts uses 3 s), after removing orphaned containers. */
    start(intervalMs = 3000) {
      if (timer) return;
      timer = setInterval(() => void tick(), intervalMs);
      timer.unref();
      void sweepOrphans().catch(warn).finally(() => void tick());
    },
    stop() {
      clearInterval(timer);
      timer = undefined;
      if (generation !== null && !stale) {
        try {
          ledger.releaseLease(LEASE, owner);
        } catch {
          /* the ledger is closed already */
        }
      }
    },
  };
}

export type Orchestrator = ReturnType<typeof createOrchestrator>;
