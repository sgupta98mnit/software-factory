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
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { audit, sha256 } from "../audit.js";
import { broadcast } from "../events.js";
import { tools } from "../tools.js";
import { detectGates, gateFindings, runGates, type GateResult, type GatesOutcome } from "./gates.js";
import {
  addDetachedWorktree,
  fileAt,
  addWorktree,
  changedFiles,
  commitAll,
  commitPaths,
  currentBranch,
  deleteBranch,
  diffStat,
  discardChanges,
  ensureRepo,
  git,
  headSha,
  isClean,
  addedLines,
  isAncestor,
  isRepoRoot,
  merge,
  mergeTree,
  mergeInto,
  removeWorktree,
  resetHard,
  squash,
} from "./git.js";
import { describeFindings, scanDependencies, scanSecrets, type ScanFinding } from "./scan.js";
import { hiddenFindings, listHiddenTests as listHiddenTestFiles, runHiddenTests, testsAfterMerge, testsFor, type HiddenTest } from "./hidden.js";
import { integrationFindings, prepareMerge, settleMerge, type MergeResult, type Prepared } from "./integrator.js";
import type {
  Attempt,
  AttemptRole,
  Autonomy,
  Finding,
  InboxItem,
  InboxKind,
  InboxOption,
  Ledger,
  Risk,
  Run,
  RunState,
  WorkOrder,
  WorkOrderState,
} from "./ledger.js";
import { channelOf, createNotifier } from "./notify.js";
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
  quietNudge,
  reviseBrief,
  verdictReminder,
} from "./prompts.js";
import { describeOrigin, fromBugForm, fromGithub, fromWebhook, goalFor, originOf, type IntakeRequest, type IntakeSource, type RunOrigin } from "./intake.js";
import { DEFAULT_POLICY, evaluateMerge, loadPolicy, newDependencies, parsePolicy, pinnedPolicy, POLICY_FILE, policyHash, type Policy } from "./policy.js";
import { POLICY_TEMPLATES, STARTER_AGENTS_MD, templateById } from "./policy-templates.js";
import { explainPolicy } from "./explain.js";
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
import { diffPlan, planWorkOrders } from "./waves.js";
import { runPreview, type PreviewResult } from "./preview.js";
import { findLessons, withLesson } from "./learning.js";

export interface OrchestratorDeps {
  ledger: Ledger;
  client: OpenHandsClient;
  workspace: string; // the repo the runs work on
  dataDir: string; // worktrees go in <dataDir>/worktrees/<runId>/
  /** How long an end state right after a message is distrusted (see classify). Tests use 0. */
  graceMs?: number;
  /** For tests: the webhook alerts post with (default: the global fetch). */
  notifyFetch?: typeof fetch;
  /** For tests: overrides the policy's selfHealing.quietMinutes. */
  quietMs?: number;
  /** How long an agent server outage lasts before anyone is told (default 2 minutes). */
  outageAlertMs?: number;
}

const AUTONOMY: Autonomy[] = ["suggest", "supervised", "autonomous"];
const TERMINAL = new Set<RunState>(["done", "released", "failed", "cancelled"]);
const ACTIVE = new Set<string>(["starting", "running"]); // attempts the scheduler starts or polls
const WORKING = new Set<RunState>(["spec", "critic", "building", "releasing"]); // count against policy.queue (waiting on a person doesn't)
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
const INTEGRATION_MOVED: InboxOption[] = [
  { id: "restore", label: "Put it back and go on", tone: "primary" },
  { id: "cancel", label: "Cancel run", tone: "danger" },
];
const INTAKE: InboxOption[] = [
  { id: "start", label: "Start a run", tone: "primary" },
  { id: "cancel", label: "Not now" },
];
const REPLAN: InboxOption[] = [
  { id: "replan", label: "Re-plan", tone: "primary" },
  { id: "keep", label: "Keep the current plan" },
  { id: "cancel", label: "Cancel run", tone: "danger" },
];
const REVISION_FAILED: InboxOption[] = [
  { id: "retry", label: "Try again", tone: "primary" },
  { id: "drop", label: "Drop the spec change" },
];
const LESSON: InboxOption[] = [
  { id: "accept", label: "Add it to AGENTS.md", tone: "primary" },
  { id: "decline", label: "Don't add it" },
];
const RUN_PAUSED: InboxOption[] = [
  { id: "resume", label: "Resume", tone: "primary" },
  { id: "cancel", label: "Cancel run", tone: "danger" },
];

const now = () => new Date().toISOString();
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
/** The agent server is down or slow: leave everything as it is and try again on a later tick. */
const unreachable = (err: unknown) => err instanceof OpenHandsError && err.status === 0;
/** The agent server refused the factory's session key: nothing works until a person fixes it. */
const refused = (err: unknown) => err instanceof OpenHandsError && (err.status === 401 || err.status === 403);
/** Something wrong with the factory's setup (a profile the policy names is missing), not with one work order. */
class SetupError extends Error {}
/** Errors that stop the whole run once, with one inbox item, instead of failing work orders one by one. */
const runWide = (err: unknown) => refused(err) || err instanceof SetupError;
/** One line, at most `max` chars: for audit data, which never holds full goals, notes or prompts. */
const clip = (text: string, max = 120) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};
const warn = (err: unknown) => console.warn(`[autopilot] ${errorText(err)}`);
// Plain text inside a markdown body: a sensitive-path glob's double stars must not turn bold.
const mdText = (text: string) => text.replace(/[\\`*_[\]<>#|~]/g, (c) => `\\${c}`);

// Gate jobs at once across the factory, every workspace's orchestrator included (SF_GATE_CONCURRENCY, default 2).
const gatePool = { capacity: 2, inUse: 0, waiting: [] as (() => void)[] };

/** A gate slot, or false when the job is stopped while it waits (so Pause never waits behind another run's gate). */
function slot(signal: AbortSignal) {
  return new Promise<boolean>((resolve) => {
    if (signal.aborted) return resolve(false);
    if (gatePool.inUse < gatePool.capacity) {
      gatePool.inUse++;
      return resolve(true);
    }
    const take = () => {
      signal.removeEventListener("abort", give);
      gatePool.inUse++;
      resolve(true);
    };
    const give = () => {
      const i = gatePool.waiting.indexOf(take);
      if (i >= 0) gatePool.waiting.splice(i, 1);
      resolve(false);
    };
    gatePool.waiting.push(take);
    signal.addEventListener("abort", give, { once: true });
  });
}

function freeSlot() {
  gatePool.inUse--;
  while (gatePool.inUse < gatePool.capacity && gatePool.waiting.length) gatePool.waiting.shift()?.();
}

export function createOrchestrator(deps: OrchestratorDeps) {
  const { ledger, client, workspace } = deps;
  const graceMs = deps.graceMs ?? 20_000;
  const worktrees = path.join(deps.dataDir, "worktrees");
  const inflight = new Map<string, Promise<void>>(); // runId -> what's being done for it
  let timer: NodeJS.Timeout | undefined;

  // ---- gate jobs: gates run outside the run's lock ----
  //
  // A step starts a work order's gates (or a merge's re-test) as a job and
  // returns; a later step records the outcome. So the run's lock is held for
  // moments, a person's decision never waits behind a test suite, and Pause
  // or Cancel can stop a gate that's running. Outcomes live in memory only:
  // after a restart the work order is still verifying (or merging) and its
  // gates simply run again.
  interface Job {
    runId: string;
    controller: AbortController;
    promise: Promise<void>;
    outcome?: GatesOutcome | { error: unknown };
  }
  const jobs = new Map<string, Job>(); // "<workOrderId>#build" | "<workOrderId>#integrate"
  const prepared = new Map<string, Extract<Prepared, { outcome: "ready" }>>(); // a merge's job key -> the merge it tests
  gatePool.capacity = Math.max(1, Number(process.env.SF_GATE_CONCURRENCY) || 2);

  function startJob(runId: string, key: string, work: (signal: AbortSignal) => Promise<GatesOutcome>) {
    const controller = new AbortController();
    const job: Job = { runId, controller, promise: Promise.resolve() };
    job.promise = (async () => {
      const got = await slot(controller.signal);
      try {
        job.outcome = !got || controller.signal.aborted ? { ok: false, results: [], aborted: true } : await work(controller.signal);
      } catch (err) {
        job.outcome = { error: err };
      } finally {
        if (got) freeSlot();
        changed(runId);
        if (timer) void tick(); // record the outcome now rather than on the next tick
      }
    })();
    jobs.set(key, job);
  }

  /** The job's outcome once it's done (and forgets the job), "running", or null when there's none. */
  function takeJob(key: string): GatesOutcome | "running" | null {
    const job = jobs.get(key);
    if (!job) return null;
    if (!job.outcome) return "running";
    jobs.delete(key);
    if ("error" in job.outcome) throw job.outcome.error;
    return job.outcome;
  }

  /** Stops the run's gate jobs (pause, cancel) and waits for their processes to go. A release merge being tested is made again after Resume. */
  async function stopJobs(runId: string) {
    const mine = [...jobs.entries()].filter(([, j]) => j.runId === runId);
    for (const [, j] of mine) j.controller.abort();
    await Promise.all(mine.map(([, j]) => j.promise));
    for (const [key] of mine) {
      jobs.delete(key);
      prepared.delete(key);
    }
    releases.delete(runId);
  }

  const changed = (runId: string) => broadcast({ type: "autopilot.changed", runId });
  // The digest hour of the last policy the factory loaded (a run created, or /status read it).
  let digestHour = DEFAULT_POLICY.notify.digestHour;
  const notifier = createNotifier({
    ledger,
    config: () => ({
      webhook: process.env.SF_NOTIFY_WEBHOOK?.trim() || null,
      inboxUrl: `${(process.env.SF_PUBLIC_URL ?? "http://localhost:8000").replace(/\/+$/, "")}/inbox`,
      digestHour,
    }),
    record: (action, data) => audit(SYSTEM, action, "notifications", data).catch(() => undefined),
    fetch: deps.notifyFetch,
  });
  const record = (actor: string, action: string, runId: string, data: Record<string, unknown> = {}) => {
    audit(actor, action, runId, data).catch(() => undefined); // audit.ts logs write failures
  };

  // ---- the agent server going away ----
  //
  // While it's unreachable, runs wait: nothing fails, attempts stay where they
  // are, and every tick tries again. Once an outage lasts outageAlertMs, people
  // hear about it (once), and again when it's back. Conversations the agent
  // server lost meanwhile come back as "gone": builders get a fresh agent that
  // doesn't count against the repair limits, other agents are restarted once.
  let outage: { since: string; alerted: boolean } | null = null;
  const outageAlertMs = deps.outageAlertMs ?? 120_000;
  function agentServerDown(err: unknown) {
    if (!outage) {
      outage = { since: now(), alerted: false };
      audit(SYSTEM, "autopilot.agent_server_down", "agent-server", { url: client.baseUrl, error: clip(errorText(err)) }).catch(() => undefined);
      broadcast({ type: "autopilot.changed" });
    }
    if (!outage.alerted && Date.now() - Date.parse(outage.since) >= outageAlertMs) {
      outage.alerted = true;
      void notifier.notice("Autopilot can't reach the agent server", [`Unreachable since ${outage.since} (${client.baseUrl}). Runs wait and go on by themselves when it's back.`]);
    }
  }
  function agentServerUp() {
    if (!outage) return;
    const down = Math.round((Date.now() - Date.parse(outage.since)) / 1000);
    audit(SYSTEM, "autopilot.agent_server_back", "agent-server", { downSeconds: down }).catch(() => undefined);
    if (outage.alerted) void notifier.notice("The agent server is back", [`It was unreachable for ${Math.max(1, Math.round(down / 60))} min. Runs go on.`]);
    outage = null;
    broadcast({ type: "autopilot.changed" });
  }

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
    track(runId, fn().catch((err) => failed(runId, err)));
  }

  /** A person's action: waits for the run's current step, then holds the run until it's done. */
  async function locked<T>(runId: string, fn: () => Promise<T>): Promise<T> {
    for (let busy = inflight.get(runId); busy; busy = inflight.get(runId)) await busy;
    const result = fn();
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

  function openItem(run: Run, kind: InboxKind, title: string, body: string, options: InboxOption[], workOrderId?: string): InboxItem {
    const item = ledger.openInbox({ runId: run.id, workOrderId, kind, title, body, options });
    record(SYSTEM, "autopilot.inbox_opened", run.id, { item: item.id, kind, ...(workOrderId ? { workOrder: workOrderId } : {}) });
    // After this transaction commits: the notifier runs on its own queue and never throws.
    queueMicrotask(() => void notifier.opened(item));
    return item;
  }

  /**
   * Pauses the run's working conversations on the agent server, so a paused
   * run stops spending. Ones still "starting" were never started; they start
   * when the run resumes.
   */
  async function pauseAgents(runId: string) {
    for (const a of ledger.listAttempts({ runId })) {
      if (a.state !== "running") continue;
      // Marked paused only when it is: one the agent server wouldn't pause stays "running" and is polled after Resume.
      const ok = await client.pause(a.conversationId).then(() => true, (err: unknown) => (warn(err), false));
      if (ok) ledger.updateAttempt(a.id, { state: "paused" });
    }
  }

  /** A step failed: pause the run and its agents, and ask a person (retry or cancel). */
  async function failed(runId: string, err: unknown) {
    if (unreachable(err)) return agentServerDown(err);
    console.error(`[autopilot] ${runId}:`, err);
    const run = ledger.getRun(runId);
    if (!run || TERMINAL.has(run.state) || run.state === "paused") return;
    const message = refused(err)
      ? `The agent server refused Autopilot's session key (${errorText(err)}). Set SF_AGENT_SERVER_KEY, or restart Canvas so it writes a fresh key, then Retry.`
      : errorText(err);
    ledger.transaction(() => {
      openItem(run, "error", `Autopilot stopped on ${run.change}`, `While in **${run.state}**:\n\n${message}\n\nRetry picks up from there.`, RETRY);
      moveRun(run, "paused", {
        patch: { resumeState: run.state, pausedReason: clip(message, 500) },
        action: "autopilot.run_paused",
        data: { error: clip(message) },
      });
    });
    await Promise.all([pauseAgents(runId), stopJobs(runId)]);
  }

  // ---- attempts (one agent conversation each) ----

  const latest = (runId: string, role: AttemptRole) => ledger.listAttempts({ runId, role }).at(-1);
  /** The orchestrator has acted on the attempt's latest turn: its result records that turn. */
  const handled = (a: Attempt) => (a.result as { turn?: number } | null)?.turn === a.turns;
  const markHandled = (a: Attempt, result: object) => ledger.updateAttempt(a.id, { result: { ...result, turn: a.turns } });

  /** Why an agent stopped, for a person: the start error, or its status and last message. */
  async function whyStopped(a: Attempt, who: string): Promise<string> {
    const error = (a.result as { error?: string } | null)?.error;
    if (error) return error;
    const last = await client.finalResponse(a.conversationId).catch(() => "");
    return `${who} stopped with status "${a.state}".${last ? ` Its last message: ${clip(last, 500)}` : ""}`;
  }

  /**
   * An agent that stopped without finishing (an error, the watchdog, a
   * conversation the agent server lost) is started again once, fresh, before
   * anyone is asked. Builders don't come here: their repair loop does this.
   */
  function restartable(a: Attempt): boolean {
    if (a.state === "finished") return false;
    const same = ledger.listAttempts({ runId: a.runId, role: a.role }).filter((x) => x.workOrderId === a.workOrderId);
    return !same.some(restarted);
  }
  /** Restarted: its fresh agent is the next attempt, or still to start when the agent server wasn't there for it. */
  const restarted = (a: Attempt) => (a.result as { outcome?: string } | null)?.outcome === "restarted";

  async function restart(run: Run, a: Attempt, why: string) {
    markHandled(a, { outcome: "restarted", error: (a.result as { error?: string } | null)?.error });
    record(SYSTEM, "autopilot.agent_restarted", run.id, { role: a.role, attempt: a.id, ...(a.workOrderId ? { workOrder: a.workOrderId } : {}), why: clip(why) });
    if (a.role === "reviewer") {
      const wo = ledger.getWorkOrder(a.workOrderId ?? "");
      if (wo) await startReviewer(run, wo);
    } else if (a.role !== "builder") await startAgent(run, a.role);
  }

  function specAttempt(run: Run): Attempt {
    const a = latest(run.id, "spec");
    if (!a) throw new Error("This run has no spec conversation yet.");
    return a;
  }

  /** A profile by id or name (none = Canvas's active one). One that doesn't exist is the setup's problem, not a work order's. */
  async function profile(ref: string | null, opts: { avoidServerOf?: string | null } = {}) {
    try {
      return await client.resolveProfile(ref, opts);
    } catch (err) {
      throw err instanceof OpenHandsError ? err : new SetupError(errorText(err));
    }
  }

  /**
   * The profile the policy names for a critic or reviewer; with none named,
   * another vendor than the agent whose work it checks, when the agent server has one.
   */
  async function checkerProfile(named: string | null, profileRef: string | null | undefined) {
    if (named) return profile(named);
    const other = profileRef ? await client.resolveProfile(profileRef).catch(() => null) : null;
    return profile(null, { avoidServerOf: other?.server });
  }

  /** Records a new attempt before asking the agent server for it (write-ahead), then starts it. */
  async function startAgent(run: Run, role: "spec" | "critic" | "validator") {
    const { agents } = pinnedPolicy(run);
    const who =
      role === "spec" ? await profile(agents.spec) : role === "validator" ? await profile(agents.validator) : await checkerProfile(agents.critic, latest(run.id, "spec")?.agentProfile);
    const attempt = ledger.transaction(() => {
      const a = ledger.addAttempt({ runId: run.id, role, conversationId: randomUUID(), agentProfile: who.id });
      if (role === "spec") ledger.updateRun(run.id, { specConversation: a.conversationId });
      return a;
    });
    record(SYSTEM, "autopilot.agent_started", run.id, { role, attempt: attempt.id, conversationId: attempt.conversationId, profile: who.name });
    await startConversation(attempt);
  }

  /** The first message of an attempt, rebuilt from the ledger so a restart sends the same one. */
  function briefFor(run: Run, a: Attempt, wo: WorkOrder | undefined): string {
    if (wo) return a.role === "reviewer" ? reviewerBrief({ change: run.change, wo }) : builderBrief({ change: run.change, wo, gates: pinnedPolicy(run).gates });
    if (a.role === "critic") return criticBrief({ change: run.change });
    if (a.role === "validator") return validatorBrief({ change: run.change, workOrders: ledger.listWorkOrders(run.id), run: pinnedPolicy(run).hiddenTests.run });
    if (run.revision?.stage === "writing" && run.revision.note) {
      return reviseBrief({ goal: run.goal, change: run.change, note: run.revision.note, openspecVersion: tools.openspec.version, origin: run.origin });
    }
    // A spec agent started after one that failed (or whose tasks.md couldn't be planned) hears why.
    const before = ledger.listAttempts({ runId: run.id, role: "spec" }).filter((x) => x.id < a.id).at(-1);
    const problem = (before?.result as { reason?: string } | null)?.reason ?? null;
    return specBrief({ goal: run.goal, change: run.change, autonomy: run.autonomy, openspecVersion: tools.openspec.version, problem, origin: run.origin });
  }

  /** Safe to repeat after a restart: the conversation id is fixed, so the agent server returns the existing one. */
  async function startConversation(a: Attempt) {
    const run = ledger.getRun(a.runId);
    const wo = a.workOrderId ? ledger.getWorkOrder(a.workOrderId) : undefined;
    // Builders and reviewers work in their work order's worktree; the validator in the hidden-tests folder.
    // A spec agent revising the spec while building works in the revision's worktree (the integration worktree is where merges happen).
    const revising = a.role === "spec" && run?.revision?.stage === "writing" ? run.revision.dir : undefined;
    const dir = wo ? wo.worktree : a.role === "validator" && run ? hiddenDir(run) : (revising ?? run?.integrationDir);
    if (!run || !dir || !a.agentProfile) throw new Error(`Attempt ${a.id} has no worktree or agent profile to start with`);
    try {
      const snap = await client.start({
        conversationId: a.conversationId,
        profileId: a.agentProfile,
        workingDir: dir,
        text: briefFor(run, a, wo),
        runId: run.id,
        role: a.role,
        seq: wo?.seq,
      });
      // The event count right after the brief: what "progress" is measured from (cold starts, the watchdog).
      const events = await client.eventCount(a.conversationId).catch(() => null);
      ledger.updateAttempt(a.id, { state: "running", seenRunning: snap.status === "running", costUsd: snap.costUsd, lastSentAt: now(), progressAt: now(), events, nudgedAt: null });
    } catch (err) {
      if (unreachable(err)) return agentServerDown(err); // stays "starting": a later tick starts it again with the same id
      if (refused(err)) throw err; // the key, not this conversation: the run stops once
      ledger.updateAttempt(a.id, { state: "error", finishedAt: now(), result: { error: errorText(err) } });
      record(SYSTEM, "autopilot.agent_finished", run.id, { role: a.role, attempt: a.id, state: "error", error: clip(errorText(err)) });
    }
    changed(run.id);
  }

  async function poll(a: Attempt) {
    const snap = await client.get(a.conversationId);
    if (!snap) {
      // `lost`: the agent server lost it (restarted, say), so it isn't held against the work order's repair limits.
      ledger.updateAttempt(a.id, { state: "error", finishedAt: now(), result: { error: "The conversation is gone from the agent server.", lost: true } });
      record(SYSTEM, "autopilot.agent_finished", a.runId, { role: a.role, attempt: a.id, state: "error", lost: true });
      return changed(a.runId);
    }
    const seenRunning = a.seenRunning || snap.status === "running";
    // Idle and never seen running: an agent that finished between two polls, or one still starting up. Its events tell.
    let progressed: boolean | undefined;
    if (snap.status === "idle" && !seenRunning && a.events !== null) {
      const events = await client.eventCount(a.conversationId);
      progressed = events === null ? undefined : events > a.events;
    }
    const outcome = classify(snap, { seenRunning, lastSentAt: a.lastSentAt, progressed }, new Date(), graceMs, graceMs ? 180_000 : 0);
    // "paused" means someone paused it in Canvas: keep polling until they resume it there.
    const state = outcome === "done" ? "finished" : outcome === "failed" ? (snap.status === "stuck" ? "stuck" : "error") : "running";
    const progress = snap.costUsd !== a.costUsd || seenRunning !== a.seenRunning;
    ledger.updateAttempt(a.id, { state, seenRunning, costUsd: snap.costUsd, finishedAt: state === "running" ? null : now(), ...(progress ? { progressAt: now() } : {}) });
    if (state !== "running") record(SYSTEM, "autopilot.agent_finished", a.runId, { role: a.role, attempt: a.id, state, costUsd: snap.costUsd });
    if (state !== a.state || snap.costUsd !== a.costUsd) changed(a.runId);
    if (state === "running" && snap.status === "running") await watch(ledger.getAttempt(a.id) ?? a);
  }

  /**
   * The watchdog. A working agent with no progress (no new events, cost or
   * status) for selfHealing.quietMinutes is nudged once; quiet as long again,
   * it's paused and its attempt ends "stuck", which its step handles like any
   * agent that stopped (a builder gets a fresh agent, a checker a restart).
   * Event counts are fetched only once half the quiet time has passed.
   */
  async function watch(a: Attempt) {
    const run = ledger.getRun(a.runId);
    if (!run) return;
    const quietMs = deps.quietMs ?? pinnedPolicy(run).selfHealing.quietMinutes * 60_000;
    const quiet = Date.now() - Date.parse(a.progressAt ?? a.lastSentAt);
    if (quiet < quietMs / 2) return;
    const events = await client.eventCount(a.conversationId);
    if (events === null) return; // the agent server can't say, so the watchdog can't either
    // Any change: a count that went down (a conversation the agent server restored) and grows again is work too.
    if (a.events === null || events !== a.events) {
      ledger.updateAttempt(a.id, a.events === null ? { events } : { events, progressAt: now() });
      return;
    }
    if (quiet < quietMs) return;
    const minutes = Math.max(1, Math.round(quietMs / 60_000));
    await client.pause(a.conversationId).catch(warn);
    if (!a.nudgedAt) {
      // Not a turn: the repair limits count the factory's findings, not this.
      try {
        await client.send(a.conversationId, quietNudge(minutes));
      } catch (err) {
        // Not left paused by the watchdog, where nothing would look at it again: it goes on, the next poll
        // tries the nudge again, and three errors in a row fail the attempt. 429: the nudge is saved; this starts it.
        await client.resume(a.conversationId).catch(warn);
        if (!(err instanceof OpenHandsError && err.status === 429)) throw err;
      }
      ledger.updateAttempt(a.id, { nudgedAt: now(), progressAt: now(), seenRunning: false, lastSentAt: now(), events: await client.eventCount(a.conversationId).catch(() => events) });
      record(SYSTEM, "autopilot.agent_nudged", a.runId, { role: a.role, attempt: a.id, quietMinutes: minutes });
    } else {
      ledger.updateAttempt(a.id, { state: "stuck", finishedAt: now(), result: { error: `No progress for ${minutes} minute${minutes === 1 ? "" : "s"}, even after a nudge, so Autopilot stopped it.`, watchdog: true } });
      record(SYSTEM, "autopilot.agent_finished", a.runId, { role: a.role, attempt: a.id, state: "stuck", reason: "watchdog", costUsd: a.costUsd });
    }
    changed(a.runId);
  }

  /** A follow-up message to an existing conversation; the agent starts on it right away. */
  async function sendFollowUp(a: Attempt, text: string, reason: string, opts: { free?: boolean } = {}) {
    try {
      await client.send(a.conversationId, text);
    } catch (err) {
      // 429: the message is saved but the agent didn't start on it; nudge it.
      if (!(err instanceof OpenHandsError && err.status === 429)) throw err;
      await client.resume(a.conversationId).catch(warn);
    }
    const events = await client.eventCount(a.conversationId).catch(() => null);
    ledger.updateAttempt(a.id, { state: "running", turns: a.turns + 1, freeTurns: a.freeTurns + (opts.free ? 1 : 0), seenRunning: false, lastSentAt: now(), finishedAt: null, progressAt: now(), events, nudgedAt: null });
    record(SYSTEM, "autopilot.followup_sent", a.runId, { role: a.role, attempt: a.id, conversationId: a.conversationId, turn: a.turns + 1, reason });
    changed(a.runId);
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
    if (!a || restarted(a)) return startAgent(run, "spec");
    if (ACTIVE.has(a.state) || a.state === "paused" || handled(a)) return; // working, or waiting for a person
    const dir = run.integrationDir as string;
    if (a.state !== "finished") {
      const why = await whyStopped(a, "The spec agent");
      return restartable(a) ? restart(run, a, why) : specFailed(run, a, why);
    }

    const check = await checkChange(run.change, dir);
    const tries = check.ok ? 0 : invalidStreak(run, a) + 1;
    // Sent before the check is recorded: if sending fails, the next tick validates and sends again.
    const { validateTries } = pinnedPolicy(run).spec;
    if (!check.ok && tries < validateTries) await sendFollowUp(a, validateFollowUp(run.change, check.output), "validate");
    ledger.addCheck({ runId: run.id, stage: "spec", name: "openspec-validate", ok: check.ok, exitCode: check.ok ? 0 : 1, durationMs: check.durationMs, output: check.output });
    changed(run.id);
    if (!check.ok) {
      if (tries >= validateTries) specFailed(run, a, `\`openspec validate ${run.change} --strict\` still fails after ${tries} tries:\n\n${check.output}`);
      return;
    }

    // The spec commit holds the change folder and nothing else: code, policy.yml or AGENTS.md the
    // spec agent wrote (or committed itself) never reaches the integration branch this way.
    const expected = run.integrationSha ?? (await headSha(dir));
    if ((await currentBranch(dir)) !== run.integrationBranch || (await headSha(dir)) !== expected) {
      // Back on the integration branch at the factory's last commit, keeping the agent's files to sort below.
      await git(dir, ["symbolic-ref", "HEAD", `refs/heads/${run.integrationBranch}`]);
      await git(dir, ["reset", "-q", "--mixed", expected]);
    }
    const title = proposalTitle(readProposal(dir, run.change)) ?? run.goal;
    // Markdown and the change's .openspec.yaml only: a test or script placed in the change folder isn't a spec.
    const changeDir = `openspec/changes/${run.change}`;
    const isSpec = (f: string) => f.startsWith(`${changeDir}/`) && (f.endsWith(".md") || f === `${changeDir}/.openspec.yaml`);
    const sha = await commitPaths(dir, isSpec, `spec(${run.change}): ${clip(title, 72)}`);
    if (sha) record(SYSTEM, "autopilot.spec_committed", run.id, { change: run.change, branch: run.integrationBranch, sha });
    const extra = await changedFiles(dir);
    if (extra.length) {
      await discardChanges(dir);
      ledger.addCheck({ runId: run.id, stage: "spec", name: "spec-edits-discarded", ok: false, output: `The spec agent changed files that aren't the change's markdown in openspec/changes/${run.change}/. They were thrown away:\n${extra.map((f) => `- ${f}`).join("\n")}` });
      record(SYSTEM, "autopilot.edits_discarded", run.id, { role: "spec", attempt: a.id, files: extra.length });
    }
    const tip = await headSha(dir);
    ledger.transaction(() => {
      markHandled(a, { outcome: "valid", sha });
      ledger.updateRun(run.id, { integrationSha: tip });
      moveRun(ledger.getRun(run.id) ?? run, "critic");
    });
  }

  async function criticStep(run: Run) {
    const c = latest(run.id, "critic");
    if (!c || handled(c)) return startAgent(run, "critic");
    if (ACTIVE.has(c.state) || c.state === "paused") return;
    if (c.state !== "finished") {
      const why = await whyStopped(c, "The spec critic");
      if (restartable(c)) return restart(run, c, why);
      markHandled(c, { outcome: "failed" });
      throw new Error(why);
    }

    const dir = run.integrationDir as string;
    const verdict = parseCriticVerdict(await client.finalResponse(c.conversationId));
    const committed = !!run.integrationSha && (await headSha(dir)) !== run.integrationSha;
    if (committed || !(await isClean(dir))) {
      if (committed) await git(dir, ["checkout", "-q", "-f", "-B", run.integrationBranch, run.integrationSha as string]);
      await discardChanges(dir);
      ledger.addCheck({ runId: run.id, stage: "spec", name: "critic-edits-discarded", ok: false, output: "The critic edited files. Its edits were thrown away." });
      record(SYSTEM, "autopilot.edits_discarded", run.id, { role: "critic", attempt: c.id });
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
      await sendFollowUp(specAttempt(run), criticFollowUp(verdict.findings), "critic");
      ledger.transaction(() => {
        markHandled(c, verdict);
        moveRun(run, "spec");
      });
      return;
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
    const why = actor.startsWith("policy@") ? `The run is autonomous, so the policy approves the plan; the spec critic's verdict was ${verdict ?? "missing"}.` : null;
    return moveRun(run, "building", {
      actor,
      action: "autopilot.plan_approved",
      data: { critic: verdict, conversation: critic?.conversationId ?? null, ...(why ? { why } : {}) },
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

  // ---- build stage: dispatch, gates, review, repair ----

  const builders = (wo: WorkOrder) => ledger.listAttempts({ runId: wo.runId, workOrderId: wo.id, role: "builder" });
  const reviewers = (wo: WorkOrder) => ledger.listAttempts({ runId: wo.runId, workOrderId: wo.id, role: "reviewer" });
  /** The commit the gates and the reviewer checked (the last builder's squash). Its branch is a ref any agent can move, so that's what merges. */
  const checkedSha = (wo: WorkOrder) => (builders(wo).at(-1)?.result as { sha?: string } | null)?.sha ?? (wo.branch as string);

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
    if (!(await guardIntegration(run))) return;
    await revisionStep(run);
    await specDrift(run);
    if (ledger.getRun(run.id)?.state !== "building") return;
    await validatorStep(run);
    for (const wo of ledger.listWorkOrders(run.id)) {
      try {
        if (wo.state === "building") await builderStep(run, wo);
        else if (wo.state === "reviewing") await reviewStep(run, wo);
        else if (wo.state === "verifying") await verify(run, wo);
      } catch (err) {
        if (runWide(err)) throw err;
        if (!unreachable(err)) workOrderError(run, wo, err);
      }
      if (ledger.getRun(run.id)?.state !== "building") return; // too many failures paused it
    }
    await integrateStep(run);
    if (ledger.getRun(run.id)?.state !== "building") return; // done, or too many failures paused it
    // Nothing new starts while the spec is being changed, or a new plan waits for a person: it may not need it.
    if (ledger.getRun(run.id)?.revision) return;
    // Pending work orders whose dependencies are merged or skipped, in wave order, while there's room.
    const wos = ledger.listWorkOrders(run.id);
    const stateOf = new Map(wos.map((w) => [w.seq, w.state]));
    let room = pinnedPolicy(run).parallel - wos.filter((w) => BUSY_WO.has(w.state)).length;
    for (const wo of wos) {
      if (room <= 0) break;
      if (wo.state !== "pending" || !wo.dependsOn.every((d) => DONE_WO.has(stateOf.get(d) ?? "pending"))) continue;
      try {
        await dispatch(run, wo);
        room--;
      } catch (err) {
        if (unreachable(err)) return;
        if (runWide(err)) throw err;
        workOrderError(run, wo, err); // resumes in pending: a retry dispatches it again
        if (ledger.getRun(run.id)?.state !== "building") return;
      }
    }
  }

  /**
   * Which profile builds a work order: policy.routing by its risk, falling
   * back to agents.builder (then Canvas's active profile). A fresh builder
   * after one that failed moves up a level, so a cheaper model that couldn't
   * do it hands over to a stronger one.
   */
  function builderRoute(run: Run, wo: WorkOrder): { profile: string | null; why: string } {
    const policy = pinnedPolicy(run);
    const levels: Risk[] = ["low", "medium", "high"];
    const before = builders(wo).length;
    const level = levels[Math.min(levels.indexOf(wo.risk) + before, levels.length - 1)] ?? wo.risk;
    const routed = policy.routing[level];
    const why = before && level !== wo.risk ? `escalated to ${level} after ${before} builder(s)` : `risk ${level}`;
    return routed ? { profile: routed, why: `${why} (routing.${level})` } : { profile: policy.agents.builder, why: `${why} (agents.builder)` };
  }

  /**
   * A builder in a fresh worktree on the work order's own branch from the
   * integration tip. Git first, then the attempt (write-ahead), then the
   * agent server: a restart in between redoes the worktree or restarts the
   * conversation with the same id. `findings` go into the brief.
   */
  async function dispatch(run: Run, wo: WorkOrder, findings = wo.findings) {
    const route = builderRoute(run, wo);
    const builder = await profile(route.profile);
    const dir = path.join(worktrees, run.id, `wo-${wo.seq}`);
    // Not autopilot/<change>/wo-N: git can't have that next to the branch autopilot/<change>.
    const branch = `${run.integrationBranch}--wo-${wo.seq}`;
    // The factory's last tested tip, never the live ref: a merge whose re-test is still running isn't a base to build on.
    // Read fresh: a merge earlier in this step moved it.
    const baseSha = ledger.getRun(run.id)?.integrationSha ?? (await headSha(workspace, run.integrationBranch));
    await addWorktree(workspace, dir, branch, baseSha);
    const round = builders(wo).length + 1;
    const attempt = ledger.transaction(() => {
      const a = ledger.addAttempt({ runId: run.id, workOrderId: wo.id, role: "builder", conversationId: randomUUID(), agentProfile: builder.id });
      moveWorkOrder(wo, "building", {
        patch: { branch, worktree: dir, baseSha, findings, resumeState: null },
        action: "autopilot.work_order_dispatched",
        data: { attempt: a.id, conversationId: a.conversationId, profile: builder.name, routedBy: route.why, round, branch, baseSha },
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
    const message = `WO-${wo.seq}: ${clip(wo.title, 72)}`;
    await commitAll(dir, message);
    const base = wo.baseSha as string;
    if (!(await isAncestor(dir, base, "HEAD"))) {
      return repair(run, wo, [{ source: "agent", severity: "high", title: `The branch no longer contains ${base.slice(0, 10)}, the integration commit it started from`, detail: `Don't reset or rebase \`${wo.branch}\`. Bring ${base.slice(0, 10)} back into it (git merge ${base.slice(0, 10)}) and keep your work on top.` }]);
    }
    // One commit per work order: what merges is exactly what the gates and the reviewer checked.
    const sha = await squash(dir, base, message);
    if (sha === base) {
      return repair(run, wo, [{ source: "agent", severity: "high", title: "Nothing was built: the branch has no changes", detail: "Build the work order with its tests, then commit." }]);
    }
    ledger.transaction(() => {
      markHandled(a, { outcome: "built", sha });
      moveWorkOrder(wo, "verifying", { data: { attempt: a.id, sha } });
    });
  }

  /** The factory's own checks on the committed work: pass -> a reviewer, fail -> a repair round. */
  async function verify(run: Run, wo: WorkOrder) {
    const dir = wo.worktree as string;
    const key = `${wo.id}#build`;
    const outcome = takeJob(key);
    if (outcome === "running") return;
    if (!outcome || outcome.aborted) {
      if (hiddenState(run) === "waiting") return; // its hidden tests aren't written yet
      const tests = testsFor(hiddenTests(run), wo.seq, mergedSeqs(run));
      startJob(run.id, key, (signal) => gatesThenHidden(run, dir, tests, signal));
      return;
    }
    const { ok, results } = outcome;
    recordGates(run, wo, "build", results);
    if (!ok) return repair(run, wo, splitFindings(run, results, "work order"));
    // The factory's own scans of what the work order adds: a secret goes back to the builder; dependency
    // findings are recorded here and decided at merge time by the policy (or a person).
    const base = wo.baseSha as string;
    const secrets = scanSecrets(await addedLines(dir, base, "HEAD"));
    ledger.addCheck({ runId: run.id, workOrderId: wo.id, stage: "build", name: "secret-scan", ok: !secrets.length, exitCode: secrets.length ? 1 : 0, output: secrets.length ? describeFindings(secrets) : "No secrets in the added lines." });
    if (secrets.length) {
      record(SYSTEM, "autopilot.secrets_found", run.id, { workOrder: `WO-${wo.seq}`, findings: secrets.length, rules: [...new Set(secrets.map((f) => f.rule))] });
      return repair(run, wo, secretRepairs(secrets));
    }
    const deps = await scanDependencies(dir, base, "HEAD", (await diffStat(dir, base, "HEAD")).files.map((f) => f.path));
    ledger.addCheck({ runId: run.id, workOrderId: wo.id, stage: "build", name: "dependency-scan", ok: !deps.length, exitCode: deps.length ? 1 : 0, output: deps.length ? `A person decides these at merge time:\n${describeFindings(deps)}` : "No dependency changes to look at." });
    await discardChanges(dir); // what the gates left (build output), so anything left after the review is the reviewer's
    await startReviewer(run, wo);
  }

  // ---- hidden acceptance tests ----

  const hiddenDir = (run: Run) => path.join(deps.dataDir, "hidden-tests", run.id);
  const testsDir = (run: Run) => path.join(hiddenDir(run), "tests");
  const hiddenTests = (run: Run): HiddenTest[] => ledger.listHiddenTests(run.id);
  const mergedSeqs = (run: Run) => new Set(ledger.listWorkOrders(run.id).filter((w) => w.state === "merged").map((w) => w.seq));

  /** off (the policy doesn't ask), waiting (the validator is writing), ready (there are tests), missing (it wrote none). */
  function hiddenState(run: Run): "off" | "waiting" | "ready" | "missing" {
    if (!pinnedPolicy(run).hiddenTests.enabled) return "off";
    const v = latest(run.id, "validator");
    if (!v || !handled(v) || restarted(v)) return "waiting";
    return hiddenTests(run).length ? "ready" : "missing";
  }

  /**
   * The validator: started when the run starts building, in a folder of its
   * own with a copy of the change and the plan. Builders start at the same
   * time; a work order's checks wait for its tests. What it wrote is hashed
   * into the ledger, so a test that changes afterwards isn't run.
   */
  async function validatorStep(run: Run) {
    if (!pinnedPolicy(run).hiddenTests.enabled) return;
    const v = latest(run.id, "validator");
    if (!v) return startValidator(run);
    if (restarted(v)) return startAgent(run, "validator");
    if (ACTIVE.has(v.state) || v.state === "paused" || handled(v)) return;
    if (restartable(v)) return restart(run, v, await whyStopped(v, "The validator"));
    const tests = v.state === "finished" ? listHiddenTestFiles(testsDir(run)) : [];
    ledger.transaction(() => {
      ledger.setHiddenTests(run.id, tests.map(({ file, scenario, requirement, requires, sha256 }) => ({ file, scenario, requirement, requires, sha256 })));
      markHandled(v, { outcome: tests.length ? "written" : "none", tests: tests.length });
    });
    record(SYSTEM, tests.length ? "autopilot.hidden_tests_written" : "autopilot.hidden_tests_missing", run.id, {
      tests: tests.length,
      scenarios: tests.map((t) => t.scenario).slice(0, 50),
      ...(v.state === "finished" ? {} : { validator: v.state }),
    });
    changed(run.id);
  }

  /** A validator in the hidden-tests folder with a fresh copy of the change and the plan. `reset`: the spec changed, so its tests start over. */
  async function startValidator(run: Run, reset = false) {
    const dir = hiddenDir(run);
    if (reset) {
      rmSync(dir, { recursive: true, force: true });
      ledger.setHiddenTests(run.id, []);
      record(SYSTEM, "autopilot.hidden_tests_reset", run.id, { reason: "the spec's scenarios changed" });
    }
    mkdirSync(path.join(dir, "tests"), { recursive: true });
    const change = path.join(run.integrationDir as string, "openspec", "changes", run.change);
    if (existsSync(change)) cpSync(change, path.join(dir, "spec"), { recursive: true });
    const plan = ledger.listWorkOrders(run.id).map((w) =>
      [`## WO-${w.seq}: ${w.title}`, `Wave ${w.wave}${w.dependsOn.length ? `, after ${w.dependsOn.map((d) => `WO-${d}`).join(", ")}` : ""}`, ...w.acceptance.map((x) => `- ${x}`), ""].join("\n"),
    );
    writeFileSync(path.join(dir, "plan.md"), `# Plan for ${run.change}\n\n${plan.join("\n")}`);
    await startAgent(run, "validator");
  }

  // ---- the spec changing while building ----

  /** The change folder's git tree at `ref` (a commit or a tree), or null when it has none. */
  async function treeAt(ref: string, sub: string): Promise<string | null> {
    const r = await git(workspace, ["rev-parse", "--verify", "-q", `${ref}:${sub}`], { allowFail: true });
    return r.code === 0 ? r.stdout.trim() : null;
  }

  /**
   * A spec change a person asked for while building: a fresh spec agent edits
   * the change in its own worktree (the integration worktree is where merges
   * happen). Once it validates, the change's markdown alone is committed and
   * merged into the integration branch (after any merge in flight); the drift
   * check then re-plans from it.
   */
  async function revisionStep(run: Run) {
    const rev = ledger.getRun(run.id)?.revision;
    if (!rev || (rev.stage !== "writing" && rev.stage !== "merge")) return;
    const dir = rev.dir as string;
    if (rev.stage === "writing") {
      const a = latest(run.id, "spec");
      // A restart whose fresh agent couldn't be started (the agent server looked away) starts it now.
      if (a && restarted(a)) return startAgent(ledger.getRun(run.id) ?? run, "spec");
      if (!a || ACTIVE.has(a.state) || a.state === "paused" || handled(a)) return;
      if (a.state !== "finished") {
        const why = await whyStopped(a, "The spec agent");
        if (restartable(a)) return restart(ledger.getRun(run.id) ?? run, a, why);
        markHandled(a, { outcome: "failed" });
        return revisionFailed(run, why);
      }
      const check = await checkChange(run.change, dir);
      const tries = check.ok ? 0 : invalidStreak(run, a) + 1;
      const { validateTries } = pinnedPolicy(run).spec;
      if (!check.ok && tries < validateTries) await sendFollowUp(a, validateFollowUp(run.change, check.output), "validate");
      ledger.addCheck({ runId: run.id, stage: "spec", name: "openspec-validate", ok: check.ok, exitCode: check.ok ? 0 : 1, durationMs: check.durationMs, output: check.output });
      changed(run.id);
      if (!check.ok) {
        if (tries >= validateTries) {
          markHandled(a, { outcome: "invalid" });
          return revisionFailed(run, `\`openspec validate ${run.change} --strict\` still fails after ${tries} tries:\n\n${check.output}`);
        }
        return;
      }
      // Back on the revision branch where it started if the agent moved it, keeping its files; then the change's markdown alone.
      if ((await currentBranch(dir)) !== rev.branch || (await headSha(dir)) !== rev.base) {
        await git(dir, ["symbolic-ref", "HEAD", `refs/heads/${rev.branch}`]);
        await git(dir, ["reset", "-q", "--mixed", rev.base as string]);
      }
      const changeDir = `openspec/changes/${run.change}`;
      const isSpec = (f: string) => f.startsWith(`${changeDir}/`) && (f.endsWith(".md") || f === `${changeDir}/.openspec.yaml`);
      const sha = await commitPaths(dir, isSpec, `spec(${run.change}): ${clip(rev.note ?? "revision", 72)}`);
      const extra = await changedFiles(dir);
      if (extra.length) {
        await discardChanges(dir);
        ledger.addCheck({ runId: run.id, stage: "spec", name: "spec-edits-discarded", ok: false, output: `The spec agent changed files that aren't the change's markdown. They were thrown away:\n${extra.map((f) => `- ${f}`).join("\n")}` });
        record(SYSTEM, "autopilot.edits_discarded", run.id, { role: "spec", attempt: a.id, files: extra.length });
      }
      markHandled(a, { outcome: "valid", sha });
      if (!sha) {
        await endRevision(run);
        record(SYSTEM, "autopilot.spec_revision_unchanged", run.id, { attempt: a.id });
        return;
      }
      record(SYSTEM, "autopilot.spec_committed", run.id, { change: run.change, branch: rev.branch, sha, revision: true });
      ledger.updateRun(run.id, { revision: { ...rev, stage: "merge", sha } });
      changed(run.id);
    }
    const ready = ledger.getRun(run.id)?.revision;
    if (ready?.stage !== "merge" || ledger.listWorkOrders(run.id).some((w) => w.state === "merging")) return;
    // Markdown only, so nothing for the gates to test; the merge is the factory's, like a work order's.
    const merged = await merge(run.integrationDir as string, ready.sha as string, `Merge the spec change for ${run.change}`);
    if (!merged.ok) return revisionFailed(run, `The changed spec conflicts with the integration branch in: ${merged.conflicts.join(", ")}.`);
    ledger.transaction(() => {
      ledger.updateRun(run.id, { integrationSha: merged.sha });
      record(SYSTEM, "autopilot.spec_revised", run.id, { sha: merged.sha, requestedBy: ready.requestedBy, note: ready.note ? clip(ready.note) : null });
    });
    await endRevision(run);
  }

  /** The revision is over (merged, unchanged or dropped): its worktree and branch go. */
  async function endRevision(run: Run) {
    const rev = ledger.getRun(run.id)?.revision;
    ledger.updateRun(run.id, { revision: null });
    if (rev?.dir) await removeWorktree(workspace, rev.dir).catch(warn);
    if (rev?.branch) await deleteBranch(workspace, rev.branch).catch(warn);
    changed(run.id);
  }

  function revisionFailed(run: Run, why: string) {
    const rev = ledger.getRun(run.id)?.revision;
    if (!rev) return;
    ledger.transaction(() => {
      ledger.updateRun(run.id, { revision: { ...rev, stage: "failed" } });
      openItem(
        run,
        "spec_revision",
        `The spec change for ${run.change} stopped`,
        `${rev.requestedBy ? `${rev.requestedBy.replace(/^user:/, "")} asked for this change to the spec:\n\n> ${mdText(rev.note ?? "")}\n\n` : ""}It stopped on this:\n\n${why}\n\nTry again starts a fresh spec agent in the same worktree. Drop keeps the spec and the plan as they are. Either way, building goes on.`,
        REVISION_FAILED,
      );
    });
  }

  /**
   * The change folder on the integration branch isn't the one the plan came
   * from: a person's spec change merged, or a work order a person let change
   * the spec. The plan is made again from tasks.md and compared with the work
   * orders; an autonomous run applies it at once, any other asks a person.
   * Merges in flight settle first.
   */
  async function specDrift(run: Run) {
    const fresh = ledger.getRun(run.id);
    if (!fresh?.integrationSha) return;
    const tree = await treeAt(fresh.integrationSha, `openspec/changes/${fresh.change}`);
    if (!fresh.planTree) {
      if (tree) ledger.updateRun(run.id, { planTree: tree });
      return;
    }
    if (!tree || tree === fresh.planTree) return;
    if (fresh.revision && !(fresh.revision.stage === "approval" && fresh.revision.tree !== tree)) return; // being written, or already waiting for a person
    if (ledger.listWorkOrders(run.id).some((w) => w.state === "merging")) return;
    let plan: ReturnType<typeof planWorkOrders>;
    try {
      plan = planWorkOrders(fresh.integrationDir as string, fresh.change);
    } catch (err) {
      throw new Error(`The spec changed, and its tasks.md can't be planned: ${errorText(err)}`);
    }
    const diff = diffPlan(ledger.listWorkOrders(run.id), plan);
    const scenarios = (await treeAt(fresh.planTree, "specs")) !== (await treeAt(tree, "specs"));
    const keys = (list: { seq: number }[]) => list.map((w) => `WO-${w.seq}`);
    record(SYSTEM, "autopilot.spec_drift", run.id, { from: fresh.planTree, to: tree, added: keys(diff.added), removed: keys(diff.removed), changed: keys(diff.changed.map((c) => c.wo)), scenarios });
    const nothing = !diff.added.length && !diff.removed.length && !diff.changed.length;
    if (nothing || fresh.autonomy === "autonomous") return applyReplan(fresh, plan, tree, nothing ? SYSTEM : policyActor(fresh), scenarios);
    ledger.transaction(() => {
      for (const old of ledger.listInbox({ runId: run.id }).filter((i) => i.kind === "replan_approval")) {
        ledger.decideInbox(old.id, { decision: "superseded", note: "The spec changed again", by: SYSTEM });
      }
      ledger.updateRun(run.id, { revision: { stage: "approval", tree, note: null, requestedBy: null, requestedAt: now() } });
      openItem(fresh, "replan_approval", `The spec for ${fresh.change} changed: re-plan?`, replanBody(diff, scenarios), REPLAN);
    });
  }

  function replanBody(diff: ReturnType<typeof diffPlan<WorkOrder>>, scenarios: boolean): string {
    const label = (w: { seq: number; title: string }) => `WO-${w.seq}: ${mdText(w.title)}`;
    const fate = (w: WorkOrder, verb: string) =>
      w.state === "merged" ? `already merged; ${verb === "removed" ? "its code stays on the integration branch" : "it's reopened and a fresh builder updates it"}` : w.state === "pending" ? "not started" : `${w.state.replaceAll("_", " ")} now; it stops${verb === "removed" ? "" : " and starts again from the new plan"}`;
    const lines = [
      ...diff.added.map((n) => `- **Added** ${label(n)}`),
      ...diff.changed.map(({ wo, next }) => `- **Changed** ${label(next)} (${fate(wo, "changed")})`),
      ...diff.removed.map((w) => `- **Removed** ${label(w)} (${fate(w, "removed")})`),
    ];
    return [
      "The change folder on the integration branch is no longer the one the work orders were planned from. tasks.md now gives:",
      "",
      ...lines,
      "",
      ...(scenarios ? ["The scenarios changed too, so the hidden acceptance tests are written again (when they're on).", ""] : []),
      "Re-plan applies this. Keep the current plan leaves the work orders as they are. Until you decide, the work under way goes on and nothing new starts.",
    ].join("\n");
  }

  /** Stops one work order's agents and gates and removes its worktree; its branch stays. */
  async function stopWorkOrder(run: Run, wo: WorkOrder) {
    for (const key of [`${wo.id}#build`, `${wo.id}#integrate`]) {
      const job = jobs.get(key);
      if (!job) continue;
      job.controller.abort();
      await job.promise;
      jobs.delete(key);
      prepared.delete(key);
    }
    for (const a of ledger.listAttempts({ runId: run.id, workOrderId: wo.id })) {
      if (!ACTIVE.has(a.state) && a.state !== "paused") continue;
      await client.pause(a.conversationId).catch(warn);
      ledger.updateAttempt(a.id, { state: "cancelled", finishedAt: now() });
    }
    if (wo.worktree) await removeWorktree(workspace, wo.worktree).catch(warn);
  }

  /**
   * The new plan, applied: added work orders wait their turn; removed ones
   * stop and are skipped (merged ones keep their code); changed ones take the
   * new title, criteria and dependencies and start again, a merged one
   * reopened with a note to its next builder. Hidden tests start over when the
   * scenarios changed.
   */
  async function applyReplan(run: Run, plan: ReturnType<typeof planWorkOrders>, tree: string, actor: string, scenarios: boolean) {
    const diff = diffPlan(ledger.listWorkOrders(run.id), plan);
    const touched = [...diff.removed, ...diff.changed.map((c) => c.wo)].filter((w) => !["merged", "skipped", "cancelled", "pending"].includes(w.state));
    for (const wo of touched) await stopWorkOrder(run, wo);
    const stopped = new Set(touched.map((w) => w.id));
    const keys = (list: { seq: number }[]) => list.map((w) => `WO-${w.seq}`);
    const reopened = diff.changed.filter((c) => c.wo.state === "merged").map((c) => c.wo);
    ledger.transaction(() => {
      for (const wo of diff.removed) {
        if (["merged", "skipped", "cancelled"].includes(wo.state)) continue;
        moveWorkOrder(ledger.getWorkOrder(wo.id) ?? wo, "skipped", { actor, patch: { worktree: null, resumeState: null }, action: "autopilot.work_order_superseded", data: { reason: "no longer in the plan" } });
      }
      for (const { wo, next } of diff.changed) {
        const fields = { title: next.title, acceptance: next.acceptance, controls: next.controls, dependsOn: next.dependsOn, wave: next.wave, risk: next.risk, riskScore: next.riskScore ?? 0 };
        if (wo.state === "skipped" || wo.state === "cancelled") {
          ledger.updateWorkOrder(wo.id, fields); // a person's skip stands
          continue;
        }
        const note = wo.state === "merged"
          ? "The spec changed for this work order after it was merged. Its earlier version is already on the integration branch your worktree starts from: update it to the acceptance criteria in your brief, with tests."
          : "The spec changed for this work order. Build it to the acceptance criteria in your brief.";
        moveWorkOrder(ledger.getWorkOrder(wo.id) ?? wo, "pending", {
          actor,
          patch: { ...fields, worktree: null, resumeState: null, mergedBy: null, findings: [{ source: "agent", severity: "high", title: note, detail: "" }] },
          action: wo.state === "merged" ? "autopilot.work_order_reopened" : "autopilot.work_order_replanned",
        });
      }
      for (const { wo, next } of diff.unchanged) ledger.updateWorkOrder(wo.id, { controls: next.controls, wave: next.wave, risk: next.risk, riskScore: next.riskScore ?? 0 });
      if (diff.added.length) ledger.addWorkOrders(run.id, diff.added);
      for (const item of ledger.listInbox({ runId: run.id })) {
        if (item.workOrderId && stopped.has(item.workOrderId)) ledger.decideInbox(item.id, { decision: "superseded", note: "The plan changed", by: actor });
      }
      ledger.updateRun(run.id, { planTree: tree, revision: null });
      const why = actor.startsWith("policy@") ? "The run is autonomous, so the policy applies the new plan." : actor === SYSTEM ? "The spec changed without changing any work order, so the plan stands as it is." : null;
      record(actor, "autopilot.replanned", run.id, { added: keys(diff.added), removed: keys(diff.removed), changed: keys(diff.changed.map((c) => c.wo)), reopened: keys(reopened), scenarios, ...(why ? { why } : {}) });
    });
    changed(run.id);
    if (scenarios && pinnedPolicy(run).hiddenTests.enabled) await startValidator(ledger.getRun(run.id) ?? run, true);
  }

  /** A person's spec change while the run is building (the Pipeline's Change the spec). */
  async function reviseSpec(runId: string, note: string, actor: string): Promise<Run> {
    return locked(runId, async () => {
      const run = mustRun(runId);
      const text = typeof note === "string" ? note.trim() : "";
      if (!text || text.length > 4000) throw new Error("Say what should change in the spec (1 to 4000 characters).");
      if (run.state !== "building") throw new Error(`The spec can be changed while the run is building (this one is ${run.state}).`);
      if (run.revision) throw new Error("A spec change is already under way for this run.");
      const dir = path.join(worktrees, run.id, "spec");
      const branch = `${run.integrationBranch}--spec`;
      const base = run.integrationSha ?? (await headSha(workspace, run.integrationBranch));
      await addWorktree(workspace, dir, branch, base);
      const revising = ledger.updateRun(run.id, { revision: { stage: "writing", note: text, requestedBy: actor, requestedAt: now(), dir, branch, base, sha: null } });
      record(actor, "autopilot.spec_revision_requested", run.id, { note: clip(text) });
      await startAgent(revising, "spec");
      return ledger.getRun(run.id) ?? revising;
    });
  }

  /** The gates, then (when they pass) the hidden tests in `tests`, as one outcome. */
  async function gatesThenHidden(run: Run, dir: string, tests: HiddenTest[], signal: AbortSignal): Promise<GatesOutcome> {
    const rerunFailed = pinnedPolicy(run).selfHealing.rerunFailedGates;
    const gates = await runGates(dir, pinnedPolicy(run).gates ?? detectGates(dir), { signal, rerunFailed });
    if (!gates.ok || !tests.length) return gates;
    const manifest = new Map(tests.map((t) => [t.file, t.sha256]));
    const hidden = await runHiddenTests(dir, testsDir(run), tests, pinnedPolicy(run).hiddenTests.run, manifest, signal, { rerunFailed });
    const results = [...gates.results, ...hidden.map((h) => h.result)];
    return { ok: !signal.aborted && results.every((r) => r.ok), results, aborted: signal.aborted };
  }

  /** Gate failures with their output; hidden-test failures by scenario and first assertion only. */
  function splitFindings(run: Run, results: GateResult[], where: "work order" | "integration"): Finding[] {
    const byFile = new Map(hiddenTests(run).map((t) => [`hidden:${t.file}`, t]));
    const gates = results.filter((r) => !byFile.has(r.name));
    const hidden = results.flatMap((r) => {
      const test = byFile.get(r.name);
      return test ? [{ test, result: r }] : [];
    });
    return [...(where === "integration" ? integrationFindings(gates) : gateFindings(gates)), ...hiddenFindings(hidden, where)];
  }

  /** What the builder hears about secrets: where and what kind, never the value. */
  const secretRepairs = (found: ScanFinding[]): Finding[] =>
    found.map((f) => ({
      source: "gate",
      severity: "critical",
      title: `Secret scan: ${f.file}${f.line ? `:${f.line}` : ""}: ${f.detail}`,
      detail: "Remove it and read it from the environment or a secret store instead. The factory squashes your commits, so it won't stay in history.",
      file: f.file,
    }));

  /** One check per gate, and one audit record for the lot. */
  function recordGates(run: Run, wo: WorkOrder, stage: "build" | "integrate", results: GateResult[]) {
    ledger.transaction(() => {
      for (const r of results) {
        ledger.addCheck({ runId: run.id, workOrderId: wo.id, stage, name: r.name, ok: r.ok, exitCode: r.exitCode, durationMs: r.durationMs, output: r.output });
      }
    });
    record(SYSTEM, "autopilot.gates_run", run.id, {
      workOrder: `WO-${wo.seq}`,
      stage,
      ok: results.every((r) => r.ok),
      gates: results.map((r) => r.name),
      failed: results.filter((r) => !r.ok).map((r) => r.name),
      ...(results.some((r) => r.flaky) ? { flaky: results.filter((r) => r.flaky).map((r) => r.name) } : {}),
    });
    changed(run.id);
  }

  /** Write-ahead like dispatch: the attempt and the move to reviewing, then the agent server. */
  async function startReviewer(run: Run, wo: WorkOrder) {
    const reviewer = await checkerProfile(pinnedPolicy(run).agents.reviewer, builders(wo).at(-1)?.agentProfile);
    const attempt = ledger.transaction(() => {
      const a = ledger.addAttempt({ runId: run.id, workOrderId: wo.id, role: "reviewer", conversationId: randomUUID(), agentProfile: reviewer.id });
      if (wo.state !== "reviewing") moveWorkOrder(wo, "reviewing", { data: { attempt: a.id } });
      return a;
    });
    record(SYSTEM, "autopilot.agent_started", run.id, { role: "reviewer", workOrder: `WO-${wo.seq}`, attempt: attempt.id, conversationId: attempt.conversationId, profile: reviewer.name });
    await startConversation(attempt);
  }

  async function reviewStep(run: Run, wo: WorkOrder) {
    const r = reviewers(wo).at(-1);
    if (!r || handled(r)) return startReviewer(run, wo); // a person's retry after the last reviewer failed
    if (ACTIVE.has(r.state) || r.state === "paused") return;
    if (r.state !== "finished") {
      const why = await whyStopped(r, "The reviewer");
      if (restartable(r)) return restart(run, r, why);
      markHandled(r, { outcome: "failed" });
      throw new Error(why);
    }

    const dir = wo.worktree as string;
    const verdict = parseVerdict(await client.finalResponse(r.conversationId));
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
      await repair(run, wo, verdict.findings);
      markHandled(r, verdict);
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
  async function repair(run: Run, wo: WorkOrder, findings: Finding[], opts: { conflict?: boolean } = {}) {
    // Builders whose conversation the agent server lost (an outage, a restart) aren't the work order's
    // failures: up to two of them don't count, so an agent server that keeps losing them still runs out.
    // The latest one too: it's the one a fresh builder replaces now.
    const everyone = builders(wo);
    const forgiven = new Set(everyone.filter((b) => (b.result as { lost?: boolean } | null)?.lost).slice(0, 2));
    const all = everyone.filter((b) => !forgiven.has(b));
    const last = everyone.at(-1);
    const data = { workOrder: `WO-${wo.seq}`, findings: findings.length };
    const limits = pinnedPolicy(run).repair;
    // A merge conflict comes from another work order's merge, not this builder's work: it has rounds of its own.
    const free = !!opts.conflict && wo.conflictRounds < pinnedPolicy(run).selfHealing.conflictRounds;
    // A conversation that never started, or is gone from the agent server, can't take a follow-up.
    if (last && !(last.result as { error?: string } | null)?.error && (free || last.turns - last.freeTurns < 1 + limits.sameConversation)) {
      await sendFollowUp(last, repairMessage(findings), free ? "conflict" : "repair", { free });
      moveWorkOrder(wo, "building", {
        patch: { findings, ...(free ? { conflictRounds: wo.conflictRounds + 1 } : {}) },
        action: "autopilot.repair_requested",
        data: { ...data, builder: all.length, turn: last.turns + 1, ...(free ? { conflictRound: wo.conflictRounds + 1 } : {}) },
      });
      return;
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
    kind: "work_order_failed" | "error" | "budget_reached",
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

  // ---- the integration branch is the factory's alone ----

  const short = (sha: string | null) => (sha ? sha.slice(0, 10) : "nothing");

  /**
   * Why the integration branch isn't where the factory left it, or null.
   * Agents run with full permissions, so a builder can move any ref from its
   * worktree; anything the factory didn't write never gets built on, merged
   * onto or delivered. A merge a restart interrupted (the tip is that work
   * order's merge commit on top of the expected sha) is the factory's own.
   */
  async function integrationMoved(run: Run): Promise<string | null> {
    const tip = await headSha(workspace, run.integrationBranch).catch(() => null);
    if (!tip) return `\`${run.integrationBranch}\` no longer exists.`;
    if (!run.integrationSha) {
      ledger.updateRun(run.id, { integrationSha: tip }); // a run from before this check: trust what's there now
      return null;
    }
    if (tip !== run.integrationSha && !(await ownMerge(run, tip))) {
      return `\`${run.integrationBranch}\` is at ${short(tip)}, but the factory left it at ${short(run.integrationSha)}.`;
    }
    if (run.integrationDir) {
      if (!existsSync(run.integrationDir)) return "The integration worktree is gone.";
      const branch = await currentBranch(run.integrationDir);
      if (branch !== run.integrationBranch) return `The integration worktree has ${branch ? `\`${branch}\`` : "a detached HEAD"} checked out instead of \`${run.integrationBranch}\`.`;
    }
    return null;
  }

  /**
   * Is `tip` the merge the factory made and is testing? Exactly the saved
   * mergeSha; or, when a restart came between the merge and saving its sha,
   * a commit whose parents are the factory's tip and the work order's branch
   * and whose tree is exactly their clean merge (so no one can pass content
   * of their own off as it).
   */
  async function ownMerge(run: Run, tip: string): Promise<boolean> {
    const merging = ledger.listWorkOrders(run.id).find((w) => w.state === "merging" && w.preMergeSha === run.integrationSha && w.branch);
    if (!merging) return false;
    if (merging.mergeSha) return tip === merging.mergeSha;
    const head = await headSha(workspace, checkedSha(merging)).catch(() => "");
    const parents = (await git(workspace, ["rev-list", "--parents", "-n", "1", tip])).stdout.trim().split(" ").slice(1);
    if (parents.length !== 2 || parents[0] !== run.integrationSha || parents[1] !== head) return false;
    const tree = (await git(workspace, ["rev-parse", `${tip}^{tree}`])).stdout.trim();
    return tree === (await mergeTree(workspace, run.integrationSha as string, head));
  }

  /** Stops the run for a person when the integration branch moved: nothing is built on it until it's put back. */
  async function guardIntegration(run: Run): Promise<boolean> {
    const why = await integrationMoved(run);
    if (!why) return true;
    ledger.transaction(() => {
      openItem(
        run,
        "integration_moved",
        `The integration branch of ${run.change} moved outside the factory`,
        `${why}\n\nOnly the factory writes to it: the spec commit, then one tested merge per work order. Something else (an agent, or a person) changed it, so Autopilot stopped before building on, merging onto or delivering anything that wasn't checked.\n\n**Put it back** resets the branch to ${short(run.integrationSha)} and goes on; whatever was added stays reachable in git's reflog. Or cancel the run.`,
        INTEGRATION_MOVED,
      );
      moveRun(run, "paused", {
        patch: { resumeState: run.state, pausedReason: "The integration branch moved outside the factory" },
        action: "autopilot.run_paused",
        data: { reason: "integration_moved" },
      });
    });
    return false;
  }

  /** Back to where the factory left it, on its branch, with nothing else in the worktree. */
  async function restoreIntegration(run: Run, actor: string) {
    const dir = run.integrationDir as string;
    const sha = run.integrationSha as string;
    const tip = await headSha(workspace, run.integrationBranch).catch(() => null);
    if (existsSync(dir)) {
      await git(dir, ["checkout", "-f", "-B", run.integrationBranch, sha]);
      await discardChanges(dir);
    } else {
      await addWorktree(workspace, dir, run.integrationBranch, sha); // gone: made again, the branch at the factory's sha
    }
    for (const w of ledger.listWorkOrders(run.id)) if (w.state === "merging") ledger.updateWorkOrder(w.id, { preMergeSha: null, mergeSha: null });
    record(actor, "autopilot.integration_restored", run.id, { branch: run.integrationBranch, from: tip, to: sha });
  }

  // ---- budgets ----

  const usd = (n: number) => `$${n.toFixed(2)}`;
  /** The change's budget: the run's own, or the policy's. */
  const runBudget = (run: Run) => run.budgetUsd ?? pinnedPolicy(run).budget.perChangeUsd;
  /** A work order's budget: the policy's, plus whatever people added when it ran out. */
  const workOrderBudget = (run: Run, wo: WorkOrder) => pinnedPolicy(run).budget.perWorkOrderUsd + wo.budgetExtraUsd;

  /**
   * Stops spending at the budget, from the agents' accumulated cost (polled
   * just before). The change's budget pauses the run and its agents; a work
   * order's pauses that work order's agents and asks a person, and the rest
   * of the run goes on. Returns true when the run stopped.
   */
  async function enforceBudgets(run: Run): Promise<boolean> {
    const cost = ledger.runCost(run.id);
    const limit = runBudget(run);
    if (cost >= limit) {
      ledger.transaction(() => {
        openItem(
          run,
          "budget_reached",
          `${run.change} reached its budget (${usd(limit)})`,
          [
            `Its agents have spent ${usd(cost)}, and the budget for this change is ${usd(limit)}${run.budgetUsd === null ? " (the policy's default)" : ""}. Autopilot paused the run and every agent working on it.`,
            "",
            `Raise the budget to go on, or cancel. ${ledger.listWorkOrders(run.id).filter((w) => w.state === "merged").length} of ${ledger.listWorkOrders(run.id).length} work orders are merged so far.`,
          ].join("\n"),
          [
            { id: "raise_half", label: `Add ${usd(limit / 2)} and go on`, tone: "primary" },
            { id: "raise_double", label: `Add ${usd(limit)} and go on` },
            { id: "cancel", label: "Cancel run", tone: "danger" },
          ],
        );
        moveRun(run, "paused", {
          patch: { resumeState: run.state, pausedReason: `Reached its budget (${usd(limit)})` },
          action: "autopilot.budget_reached",
          data: { scope: "change", costUsd: cost, budgetUsd: limit },
        });
      });
      await Promise.all([pauseAgents(run.id), stopJobs(run.id)]);
      return true;
    }
    for (const wo of ledger.listWorkOrders(run.id)) {
      if (!["building", "reviewing"].includes(wo.state)) continue; // states where its agents spend
      const spent = ledger.workOrderCost(wo.id);
      const woLimit = workOrderBudget(run, wo);
      if (spent < woLimit) continue;
      for (const a of ledger.listAttempts({ runId: run.id, workOrderId: wo.id })) {
        if (a.state !== "running") continue;
        const ok = await client.pause(a.conversationId).then(() => true, (err: unknown) => (warn(err), false));
        if (ok) ledger.updateAttempt(a.id, { state: "paused" });
      }
      const extra = pinnedPolicy(run).budget.perWorkOrderUsd;
      record(SYSTEM, "autopilot.budget_reached", run.id, { scope: "work_order", workOrder: `WO-${wo.seq}`, costUsd: spent, budgetUsd: woLimit });
      needsAttention(
        run,
        wo,
        "budget_reached",
        `WO-${wo.seq} of ${run.change} reached its budget (${usd(woLimit)}): ${wo.title}`,
        `Its agents have spent ${usd(spent)} of the ${usd(woLimit)} a work order may spend. They're paused; the rest of the run goes on.\n\nGive it more to go on from where it stopped, or skip it.`,
        [
          { id: "raise", label: `Give it another ${usd(extra)}`, tone: "primary" },
          { id: "skip", label: "Skip this work order" },
          { id: "cancel", label: "Cancel run", tone: "danger" },
        ],
      );
      if (ledger.getRun(run.id)?.state !== run.state) return true; // that made three failing: the run paused
    }
    return false;
  }

  /** Back to work where the budget stopped it: its state, and its paused conversations resumed. */
  async function resumeWorkOrder(wo: WorkOrder, actor: string) {
    // In a paused run they wait for its Resume: until then nobody polls them or holds them to a budget.
    const runPaused = ledger.getRun(wo.runId)?.state === "paused";
    for (const a of ledger.listAttempts({ runId: wo.runId, workOrderId: wo.id })) {
      if (a.state !== "paused" || runPaused) continue;
      await client.resume(a.conversationId).catch(warn);
      ledger.updateAttempt(a.id, { state: "running", seenRunning: false, lastSentAt: now() });
    }
    moveWorkOrder(wo, wo.resumeState ?? "pending", { actor, patch: { resumeState: null } });
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
    // Done once everything is merged or skipped, and every merged work order's worktree is gone (a failed clean-up retries first).
    const all = ledger.listWorkOrders(run.id);
    // Not while the spec is changing, or a new plan waits for a person: there may be more to build.
    const current = ledger.getRun(run.id);
    if (current?.state === "building" && !current.revision && all.every((w) => DONE_WO.has(w.state)) && !all.some((w) => w.state === "merged" && w.worktree)) await previewThenFinish(current);
  }

  /**
   * The pinned policy's merge decision for a work order, from what its
   * checked commit changes since base_sha (the integration sha it last
   * started from) and the dependencies it adds. The same answer until it's
   * built again, wherever the integration branch (or its own) has moved since.
   */
  async function mergeCheck(run: Run, wo: WorkOrder) {
    const policy = pinnedPolicy(run);
    const base = wo.baseSha ?? ledger.getRun(run.id)?.integrationSha ?? run.integrationBranch;
    const head = checkedSha(wo);
    const stat = await diffStat(workspace, base, head);
    const files = stat.files.map((f) => f.path);
    const review = reviewers(wo).at(-1)?.result as ReviewVerdict | null | undefined;
    const decision = evaluateMerge(policy, {
      autonomy: run.autonomy,
      gatesOk: true, // a work order is ready only once its gates have passed (verify)
      hiddenTestsOk: hiddenResult(run, wo),
      hiddenTestsMissing: hiddenState(run) === "missing",
      reviewPassed: !!review?.verdict && passed(review, policy.review.blocking),
      // Scanned again here, on the branch as it will merge (verify scanned the worktree).
      secretFindings: scanSecrets(await addedLines(workspace, base, head)).length,
      dependencyFindings: (await scanDependencies(workspace, base, head, files)).map((f) => `${f.file}: ${f.detail}`),
      files,
      linesChanged: stat.linesChanged,
      newDependencies: await newDependencies(workspace, base, head, files),
    });
    // A work order doesn't get to change what it's measured against on its own say-so.
    const spec = files.filter((f) => f.startsWith("openspec/"));
    if (spec.length) {
      const listed = `${spec.slice(0, 5).join(", ")}${spec.length > 5 ? ` and ${spec.length - 5} more` : ""}`;
      const reasons = [...decision.reasons, `Changes the spec (${listed}). Only a person lets a work order change what it's measured against; merging it re-plans the run.`];
      return { auto: false, reasons, why: `The policy left it to a person: ${reasons.map((r) => r.replace(/\.$/, "")).join("; ")}.`, stat };
    }
    return { ...decision, stat };
  }

  /** Did the hidden tests the work order was held to pass at its last verification? null when none applied. */
  function hiddenResult(run: Run, wo: WorkOrder): boolean | null {
    const lastBuild = builders(wo).at(-1);
    // Each test's latest run: a repair round of the same builder fixes what an earlier one failed.
    const latest = new Map<string, boolean>();
    for (const c of ledger.listChecks({ runId: run.id, workOrderId: wo.id })) {
      if (c.stage === "build" && c.name.startsWith("hidden:") && (!lastBuild || c.at >= lastBuild.startedAt)) latest.set(c.name, c.ok);
    }
    return latest.size ? [...latest.values()].every(Boolean) : null;
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
      bullets(check.reasons.map(mdText)),
      "",
      `### ${files.length} file(s), ${linesChanged} line(s) changed`,
      ...list,
      "",
      "Send back tells its builder what to change (write it in the note). Skip lets the work orders that depend on it go ahead without it.",
    ].join("\n");
    ledger.transaction(() => {
      // The reasons are kept with the move, so insights can tell what people do with each kind.
      moveWorkOrder(wo, "awaiting_merge_approval", { data: { reasons: check.reasons.map((r) => clip(r, 300)) } });
      openItem(run, "merge_approval", `Merge WO-${wo.seq} of ${run.change}: ${wo.title}`, body, MERGE, wo.id);
    });
  }

  /**
   * Who lets a work order merge, and why a person had to: the policy (asked
   * again, with the same answer for the same branch), or the person who
   * approved it last. Never merged without one on record.
   */
  async function mergeActor(run: Run, wo: WorkOrder): Promise<{ actor: string; reasons: string[]; why: string }> {
    const { auto, reasons, why } = await mergeCheck(run, wo);
    if (auto) return { actor: policyActor(run), reasons, why };
    const approval = ledger
      .listInbox({ state: "decided", runId: run.id })
      .find((i) => i.workOrderId === wo.id && i.kind === "merge_approval" && i.decision === "merge");
    if (!approval?.decidedBy) throw new Error(`WO-${wo.seq} has no merge approval on record.`);
    const who = approval.decidedBy.replace(/^user:/, "");
    return { actor: approval.decidedBy, reasons, why: `${who} merged it${approval.note ? ` (“${clip(approval.note, 200)}”)` : ""}. The policy asked a person because: ${reasons.map((r) => r.replace(/\.$/, "")).join("; ")}.` };
  }

  /**
   * Merge, re-test, then merged; or the integration branch goes back to where
   * it was and the work order back to its builder, its branch brought up to
   * date with the integration branch (a conflict's markers left for it to
   * resolve). That counts as a repair round.
   */
  async function integrate(run: Run, wo: WorkOrder) {
    const dir = run.integrationDir as string;
    const jobKey = `${wo.id}#integrate`;
    const outcome = takeJob(jobKey);
    if (outcome === "running") return;
    const { actor, reasons, why } = await mergeActor(run, wo);
    const key = `WO-${wo.seq}`;
    // Saved before merging, so a restart (or a failure) knows where the integration branch was.
    let pre = wo.preMergeSha;
    if (!pre) {
      // Where the factory left the branch (checked by guardIntegration), not whatever the ref says now.
      pre = ledger.getRun(run.id)?.integrationSha ?? (await headSha(dir));
      ledger.updateWorkOrder(wo.id, { preMergeSha: pre });
    }
    let r: MergeResult;
    const tested = prepared.get(jobKey);
    prepared.delete(jobKey);
    if (outcome && !outcome.aborted && tested) r = await settleMerge(dir, tested, pre, outcome);
    else {
      // Safe to repeat (after a restart, or a job that was stopped): a merge already made is found, not made twice.
      const merge = await prepareMerge(dir, checkedSha(wo), `Merge ${key}: ${clip(wo.title, 72)}`, pre);
      if (merge.outcome === "ready") {
        ledger.updateWorkOrder(wo.id, { mergeSha: merge.sha }); // the one tip besides integrationSha the guard accepts
        prepared.set(jobKey, merge);
        const tests = testsAfterMerge(hiddenTests(run), wo.seq, mergedSeqs(run));
        startJob(run.id, jobKey, (signal) => gatesThenHidden(run, dir, tests, signal));
        return;
      }
      r = merge;
    }
    // Hidden tests on the integration branch reach the builder by scenario only.
    if (r.outcome === "reverted") r = { ...r, findings: splitFindings(run, r.results, "integration") };
    if (r.results.length) recordGates(run, wo, "integrate", r.results);
    if (r.outcome === "merged") {
      ledger.transaction(() => {
        ledger.updateRun(run.id, { integrationSha: r.sha });
        moveWorkOrder(wo, "merged", {
          actor,
          patch: { mergedBy: actor, mergeSha: null, mergeWhy: why },
          action: "autopilot.work_order_merged",
          data: { sha: r.sha, linesChanged: r.linesChanged, files: r.files, reasons, why },
        });
      });
      return;
    }
    if (r.outcome === "conflict") record(SYSTEM, "autopilot.merge_conflicted", run.id, { workOrder: key, conflicts: r.conflicts });
    else record(SYSTEM, "autopilot.merge_reverted", run.id, { workOrder: key, resetTo: pre });
    const tip = await headSha(dir);
    await mergeInto(wo.worktree as string, run.integrationBranch);
    await repair(run, ledger.updateWorkOrder(wo.id, { baseSha: tip, preMergeSha: null, mergeSha: null }), r.findings, { conflict: r.outcome === "conflict" });
  }

  /** A merge step threw: an untested merge comes off the integration branch, and the work order waits for a person (retry merges again). */
  async function integrateFailed(run: Run, wo: WorkOrder, err: unknown) {
    if (unreachable(err)) return; // the next step merges or sends it back again
    const pre = ledger.getWorkOrder(wo.id)?.preMergeSha;
    if (pre) await resetIntegration(run, wo, pre, SYSTEM);
    ledger.updateWorkOrder(wo.id, { preMergeSha: null, mergeSha: null });
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
  // ---- the preview: the app itself, before release ----

  const previewDir = (run: Run) => path.join(deps.dataDir, "previews", run.id);
  const previewResults = new Map<string, PreviewResult>(); // a preview job's key -> what it found

  /**
   * With policy.preview on, the app runs from the integration branch (as a
   * job, outside the lock, in a gate slot) before the run finishes; the
   * result is kept on the run and shown with the release decision. Once per
   * integration sha: a run that comes back to building re-runs it.
   */
  async function previewThenFinish(run: Run) {
    const policy = pinnedPolicy(run);
    const merged = ledger.listWorkOrders(run.id).some((w) => w.state === "merged");
    if (!policy.preview.enabled || !merged || !run.integrationDir || run.preview?.sha === run.integrationSha) return finish(run);
    const key = `${run.id}#preview`;
    const outcome = takeJob(key);
    if (outcome === "running") return;
    const found = previewResults.get(key);
    previewResults.delete(key);
    if (!outcome || outcome.aborted || !found) {
      const dir = run.integrationDir;
      const out = previewDir(run);
      rmSync(out, { recursive: true, force: true }); // screenshots of an older sha go
      record(SYSTEM, "autopilot.preview_started", run.id, { sha: run.integrationSha, paths: policy.preview.paths });
      startJob(run.id, key, async (signal) => {
        const r = await runPreview(dir, policy.preview, out, { signal });
        previewResults.set(key, r);
        return { ok: r.ok, results: [], aborted: signal.aborted };
      });
      return;
    }
    await discardChanges(run.integrationDir); // whatever the app wrote (logs, caches); installed packages stay
    const lines = found.error ? [found.error] : found.pages.map((p) => `${p.ok ? "ok" : "FAILED"} ${p.path}: ${p.status ?? p.error ?? "no answer"}${p.screenshot ? ` (${p.screenshot})` : ""}`);
    ledger.transaction(() => {
      ledger.addCheck({ runId: run.id, stage: "preview", name: "preview", ok: found.ok, exitCode: found.ok ? 0 : 1, output: [...lines, ...(found.noScreenshots ? [found.noScreenshots] : []), "", found.output.slice(-2000)].join("\n") });
      ledger.updateRun(run.id, { preview: { ...found, sha: run.integrationSha as string } });
      record(SYSTEM, "autopilot.preview_run", run.id, {
        ok: found.ok,
        sha: run.integrationSha,
        pages: found.pages.map((p) => ({ path: p.path, status: p.status, ok: p.ok, screenshot: !!p.screenshot })),
        ...(found.error ? { error: clip(found.error) } : {}),
      });
    });
    await finish(ledger.getRun(run.id) ?? run);
  }

  /** A screenshot of the run's preview, by the name the preview gave it; null for anything else. */
  function previewFile(runId: string, file: string): string | null {
    const run = ledger.getRun(runId);
    if (!run?.preview?.pages.some((p) => p.screenshot === file) || !/^\d+-[a-zA-Z0-9-]+\.png$/.test(file)) return null;
    const full = path.join(previewDir(run), file);
    return existsSync(full) ? full : null;
  }

  async function finish(run: Run) {
    if (!(await guardIntegration(ledger.getRun(run.id) ?? run))) return;
    const wos = ledger.listWorkOrders(run.id);
    const merged = wos.filter((w) => w.state === "merged").length;
    const sha = await headSha(workspace, run.integrationBranch);
    if (run.integrationDir) await removeWorktree(workspace, run.integrationDir);
    const done = moveRun(run, merged ? "done" : "failed", {
      patch: { integrationDir: null, resumeState: null },
      action: merged ? "autopilot.run_completed" : "autopilot.run_failed",
      data: { branch: run.integrationBranch, sha, costUsd: ledger.runCost(run.id), merged, skipped: wos.length - merged },
    });
    if (merged) await offerRelease(done);
    await learn(done).catch(warn);
  }

  // ---- learning: lines for AGENTS.md from mistakes builders keep making ----

  /** After a run: a lesson a person hasn't been asked about yet goes to the Inbox (learning.ts). */
  async function learn(run: Run) {
    const policy = pinnedPolicy(run);
    if (!policy.learning.proposals) return;
    for (const lesson of findLessons(ledger, policy.learning.threshold)) {
      if (ledger.getLesson(lesson.key)) continue; // asked before, whatever the answer
      const body = [
        `Builders in this workspace keep making the same mistake (${lesson.count} work orders, most recently ${lesson.seen.map((s) => `\`${s}\``).join(", ")}). The factory proposes adding this line to \`AGENTS.md\` on \`${run.baseBranch}\`, which every agent reads:`,
        "",
        `> ${mdText(lesson.line)}`,
        "",
        `Adding it commits that one line to \`${run.baseBranch}\` in your name (under "Learned by the Software Factory"). If you don't add it, the factory won't propose it again.`,
      ].join("\n");
      ledger.transaction(() => {
        const item = openItem(run, "lesson", `Add to AGENTS.md: ${clip(lesson.line, 90)}`, body, LESSON);
        ledger.addLesson({ key: lesson.key, line: lesson.line, count: lesson.count, runId: run.id, itemId: item.id });
        record(SYSTEM, "autopilot.lesson_proposed", run.id, { key: lesson.key, count: lesson.count });
      });
    }
  }

  /**
   * One file changed on the base branch, as a person's decision (a lesson
   * accepted): committed in a detached worktree, then the branch moves only if
   * it's still where that started, like a release.
   */
  async function commitToBase(base: string, file: string, edit: (text: string | null) => string, message: string): Promise<string> {
    const ref = `refs/heads/${base}`;
    const tip = await headSha(workspace, ref);
    const dir = path.join(worktrees, `_base-${randomBytes(3).toString("hex")}`);
    await addDetachedWorktree(workspace, dir, tip);
    try {
      mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      writeFileSync(path.join(dir, file), edit(await fileAt(workspace, ref, file)));
      await git(dir, ["add", "--", file]);
      await git(dir, ["commit", "-q", "-m", message]);
      const sha = await headSha(dir);
      if ((await currentBranch(workspace)) === base) {
        if ((await git(workspace, ["diff", "--quiet", "HEAD"], { allowFail: true })).code !== 0) throw new Error(`The workspace has uncommitted changes on \`${base}\`. Commit or stash them, then try again.`);
        if ((await headSha(workspace)) !== tip) throw new Error(`\`${base}\` moved meanwhile. Try again.`);
        await git(workspace, ["merge", "--ff-only", "-q", sha]);
      } else {
        await git(workspace, ["update-ref", ref, sha, tip]);
      }
      return sha;
    } finally {
      await removeWorktree(workspace, dir).catch(warn);
    }
  }

  // ---- release: the integration branch into the base branch ----

  const RELEASE: InboxOption[] = [
    { id: "release", label: "Release", tone: "primary" },
    { id: "hold", label: "Not now" },
  ];
  const releaseDir = (run: Run) => path.join(worktrees, run.id, "release");
  const releases = new Map<string, { sha: string; baseTip: string } | null>(); // runId -> the release merge being tested (null: being made)

  /** What a person sees before releasing: what's in it, who let each part in, the checks and the cost. */
  async function releaseBody(run: Run, why?: string): Promise<string> {
    const wos = ledger.listWorkOrders(run.id);
    const stat = await diffStat(workspace, `refs/heads/${run.baseBranch}`, run.integrationBranch).catch(() => null);
    const integrate = ledger.listChecks({ runId: run.id }).filter((c) => c.stage === "integrate");
    const hidden = ledger.listHiddenTests(run.id);
    const lines = wos.map((w) =>
      w.state === "merged"
        ? `- WO-${w.seq}: ${w.title}: merged ${w.mergedBy?.startsWith("policy@") ? `automatically (${w.mergedBy})` : `by ${w.mergedBy}`}`
        : `- WO-${w.seq}: ${w.title}: ${w.state}`,
    );
    return [
      ...(why ? [`**The last release didn't go through:** ${why}`, ""] : []),
      `**${run.change}** is merged and re-tested on \`${run.integrationBranch}\` (${short(run.integrationSha)}). Releasing merges it into \`${run.baseBranch}\`; if \`${run.baseBranch}\` moved since the run started, the merge is tested again first.`,
      "",
      "### What's in it",
      ...lines,
      "",
      "### Checks",
      `- ${integrate.filter((c) => c.ok).length} of ${integrate.length} gate runs on the integration branch passed (failed merges were taken back off).`,
      ...(hidden.length ? [`- ${hidden.length} hidden acceptance test(s), one per scenario.`] : []),
      `- Cost: ${usd(ledger.runCost(run.id))} of ${usd(runBudget(run))}.`,
      ...(stat ? ["", `### ${stat.files.length} file(s), ${stat.linesChanged} line(s) changed from \`${run.baseBranch}\``] : []),
      ...previewLines(run),
      "",
      "Releasing is recorded in the audit log with your name.",
    ].join("\n");
  }

  /** The preview's part of the release decision: each page, and its screenshot (served by the API). */
  function previewLines(run: Run): string[] {
    const p = run.preview;
    if (!p) return [];
    if (p.error) return ["", "### Preview", `The app didn't come up from \`${run.integrationBranch}\`: ${mdText(p.error)}`];
    return [
      "",
      `### Preview: ${p.ok ? "every page answered" : "some pages failed"}`,
      ...p.pages.map((page) => `- \`${page.path}\`: ${page.ok ? `answered ${page.status}` : `**failed** (${page.status ?? mdText(page.error ?? "no answer")})`}`),
      ...p.pages.filter((page) => page.screenshot).map((page) => `\n![${page.path}](/sf-api/autopilot/runs/${run.id}/preview/${page.screenshot})`),
      ...(p.noScreenshots ? [`- ${mdText(p.noScreenshots)}`] : []),
    ];
  }

  /** At the end of a run: a person's release decision, or (policy release.auto, autonomous runs only) the policy's. */
  async function offerRelease(run: Run, why?: string) {
    const policy = pinnedPolicy(run);
    // A preview that failed is for a person to look at, whatever release.auto says.
    if (!why && run.preview && !run.preview.ok) why = "The preview failed, so the policy doesn't release it on its own.";
    if (!why && policy.release.auto && run.autonomy === "autonomous") {
      return requestRelease(run, policyActor(run), `The policy has release.auto on and the run is autonomous${run.preview ? ", and the preview passed" : ""}, so the policy releases it.`);
    }
    openItem(run, "release", `Release ${run.change} into ${run.baseBranch}`, await releaseBody(run, why), [{ ...RELEASE[0]!, label: `Release into ${run.baseBranch}` }, RELEASE[1]!]);
    changed(run.id);
  }

  // Strictly increasing, so two releases asked for in the same millisecond still have an order.
  let lastRequest = "";
  function requestRelease(run: Run, actor: string, why?: string) {
    let at = now();
    if (at <= lastRequest) at = new Date(Date.parse(lastRequest) + 1).toISOString();
    lastRequest = at;
    return moveRun(run, "releasing", { actor, patch: { releasedBy: actor, releaseRequestedAt: at }, action: "autopilot.release_requested", data: { base: run.baseBranch, branch: run.integrationBranch, ...(why ? { why } : {}) } });
  }

  /** Back to done with the reason, and a fresh release decision. */
  async function releaseFailed(run: Run, why: string) {
    releases.delete(run.id);
    await removeWorktree(workspace, releaseDir(run)).catch(warn);
    const done = moveRun(run, "done", { patch: { releasedBy: null }, action: "autopilot.release_failed", data: { reason: clip(why) } });
    await offerRelease(done, why);
  }

  /**
   * Merges the integration branch into the base branch's tip in a worktree of
   * its own. When the base hasn't moved since the run branched from it, the
   * merge is exactly the tested integration tree; otherwise the gates run on
   * it first (as a job). Then the base branch moves to the merge: with
   * `merge --ff-only` in the workspace when it has the base checked out (its
   * files move too), with a compare-and-swap update-ref otherwise.
   */
  async function releaseStep(run: Run) {
    const key = `${run.id}#release`;
    const outcome = takeJob(key);
    if (outcome === "running") return;
    // One release into a base branch at a time, in the order they were asked for: the base won't move under this one.
    if (!releases.has(run.id)) {
      if (releaseAhead(run)) return;
      releases.set(run.id, null); // this one has the base now, in the same moment it checked: a resumed one waits for it
    }
    const dir = releaseDir(run);
    const tip = await headSha(workspace, run.integrationBranch).catch(() => null);
    if (!tip || tip !== run.integrationSha) return releaseFailed(run, `\`${run.integrationBranch}\` moved since the run finished, so it isn't what was checked.`);
    let prepared = releases.get(run.id);
    if (!prepared || !outcome || outcome.aborted) {
      const baseTip = await headSha(workspace, `refs/heads/${run.baseBranch}`);
      await addDetachedWorktree(workspace, dir, baseTip);
      const merged = await merge(dir, run.integrationBranch, `Release ${run.change} (${run.id})`);
      if (!merged.ok) return releaseFailed(run, `Merging into \`${run.baseBranch}\` conflicts in: ${merged.conflicts.join(", ")}. Resolve that on \`${run.baseBranch}\` or start a new run for it.`);
      prepared = { sha: merged.sha, baseTip };
      releases.set(run.id, prepared);
      const untouched = (await git(workspace, ["merge-base", baseTip, tip])).stdout.trim() === baseTip;
      if (!untouched) {
        startJob(run.id, key, (signal) => runGates(dir, pinnedPolicy(run).gates ?? detectGates(dir), { signal, rerunFailed: pinnedPolicy(run).selfHealing.rerunFailedGates }));
        return;
      }
    } else {
      for (const r of outcome.results) ledger.addCheck({ runId: run.id, stage: "release", name: r.name, ok: r.ok, exitCode: r.exitCode, durationMs: r.durationMs, output: r.output });
      if (!outcome.ok) return releaseFailed(run, `\`${run.baseBranch}\` moved since the run started, and the gates fail on the merge: ${outcome.results.filter((r) => !r.ok).map((r) => r.name).join(", ")}.`);
    }
    // The base branch moves to the release merge, only if it's still where the merge started.
    const onBase = (await currentBranch(workspace)) === run.baseBranch;
    try {
      if (onBase) {
        if ((await git(workspace, ["diff", "--quiet", "HEAD"], { allowFail: true })).code !== 0) {
          return releaseFailed(run, `The workspace has uncommitted changes on \`${run.baseBranch}\`. Commit or stash them, then release again.`);
        }
        if ((await headSha(workspace)) !== prepared.baseTip) return releaseFailed(run, `\`${run.baseBranch}\` moved while the release was tested.`);
        await git(workspace, ["merge", "--ff-only", "-q", prepared.sha]);
      } else {
        await git(workspace, ["update-ref", `refs/heads/${run.baseBranch}`, prepared.sha, prepared.baseTip]);
      }
    } catch (err) {
      return releaseFailed(run, errorText(err));
    }
    releases.delete(run.id);
    await removeWorktree(workspace, dir).catch(warn);
    moveRun(run, "released", {
      actor: run.releasedBy ?? SYSTEM,
      patch: { releasedSha: prepared.sha, releasedAt: now() },
      action: "autopilot.run_released",
      data: { base: run.baseBranch, sha: prepared.sha, retested: !!outcome && !outcome.aborted },
    });
  }

  /** A person's Release from the Pipeline (the same as choosing it in the Inbox). */
  async function release(runId: string, actor: string): Promise<Run> {
    return locked(runId, async () => {
      const run = mustRun(runId);
      if (run.state !== "done") throw new Error(`Only a finished run can be released (this one is ${run.state}).`);
      for (const item of ledger.listInbox({ runId }).filter((i) => i.kind === "release")) {
        ledger.decideInbox(item.id, { decision: "release", note: "Released from the pipeline", by: actor });
      }
      return requestRelease(run, actor);
    });
  }

  // ---- the scheduler ----

  /**
   * One work order's conversation the factory can't start or poll (the agent
   * server answers 500 for it, say): the attempt fails with the reason and its
   * work order's own step repairs it or asks a person. The conversation is
   * paused first, so a fresh builder doesn't share a worktree with it.
   */
  async function attemptFailed(a: Attempt, err: unknown) {
    console.error(`[autopilot] ${a.runId} attempt ${a.id}:`, err);
    await client.pause(a.conversationId).catch(() => undefined);
    const doing = a.state === "starting" ? "start" : "follow";
    ledger.updateAttempt(a.id, { state: "error", finishedAt: now(), result: { error: `Autopilot couldn't ${doing} this conversation on the agent server: ${errorText(err)}` } });
    record(SYSTEM, "autopilot.agent_finished", a.runId, { role: a.role, attempt: a.id, state: "error", error: clip(errorText(err)) });
    changed(a.runId);
  }

  /** Errors in a row per attempt: one blip doesn't throw away a builder's work. In memory; a restart forgives. */
  const pollErrors = new Map<number, number>();
  const POLL_ERRORS_TO_FAIL = 3;

  /** Starts or polls the run's agents, then takes its next step. */
  async function advance(runId: string) {
    for (const a of ledger.listAttempts({ runId }).filter((x) => ACTIVE.has(x.state))) {
      try {
        await (a.state === "starting" ? startConversation(a) : poll(a));
        pollErrors.delete(a.id);
        if (ledger.getAttempt(a.id)?.state !== "starting") agentServerUp(); // it answered
      } catch (err) {
        // The agent server down or refusing the key, or the spec stage's own agents: the run waits or stops as a whole.
        if (unreachable(err) || runWide(err) || !a.workOrderId) throw err;
        const n = (pollErrors.get(a.id) ?? 0) + 1;
        pollErrors.set(a.id, n);
        if (n < POLL_ERRORS_TO_FAIL) {
          warn(err);
          continue;
        }
        pollErrors.delete(a.id);
        await attemptFailed(a, err);
      }
    }
    const run = ledger.getRun(runId);
    if (run && !TERMINAL.has(run.state) && run.state !== "paused" && (await enforceBudgets(run))) return;
    if (run?.state === "spec") await specStep(run);
    else if (run?.state === "critic") await criticStep(run);
    else if (run?.state === "building") await buildStep(run);
    else if (run?.state === "releasing") await releaseStep(run);
    // The step paused the run (three work orders failing, a moved integration branch): its agents stop too.
    if (run?.state !== "paused" && ledger.getRun(runId)?.state === "paused") await Promise.all([pauseAgents(runId), stopJobs(runId)]);
  }

  /** A queued run's turn: its integration branch from the base as it is now, then the spec stage. */
  async function dequeue(runId: string) {
    const run = ledger.getRun(runId);
    if (run?.state !== "queued") return;
    const integrationDir = path.join(worktrees, run.id, "integration");
    // refs/heads/: a tag (or refs/<base>) with the branch's name, which any agent can make, would make it ambiguous.
    await addWorktree(workspace, integrationDir, run.integrationBranch, `refs/heads/${run.baseBranch}`);
    const integrationSha = await headSha(integrationDir);
    moveRun(run, "spec", {
      patch: { integrationDir, integrationSha },
      action: "autopilot.run_started",
      data: { waitedSeconds: Math.round((Date.now() - Date.parse(run.createdAt)) / 1000), base: integrationSha },
    });
  }

  /**
   * What a run waits on, for people: its place in line (1 = next) while
   * queued, and the change whose release into the same base goes first
   * while releasing.
   */
  function waitingOn(run: Run): { queuePosition: number | null; releaseAfter: string | null } {
    const runs = ledger.listRuns();
    const line = runs.filter((r) => r.state === "queued").reverse();
    const ahead = run.state === "releasing" ? releaseAhead(run, runs) : undefined;
    return { queuePosition: run.state === "queued" ? line.findIndex((r) => r.id === run.id) + 1 : null, releaseAfter: ahead?.change ?? null };
  }

  /**
   * The release into the same base branch that goes before this one: one
   * whose merge is being tested (it went while an earlier one was paused),
   * else the earliest asked for before this one that's still going.
   */
  function releaseAhead(run: Run, runs = ledger.listRuns()): Run | undefined {
    const key = (r: Run) => `${r.releaseRequestedAt ?? ""}|${r.id}`;
    const going = runs.filter((r) => r.id !== run.id && r.state === "releasing" && r.baseBranch === run.baseBranch);
    return going.find((r) => releases.has(r.id)) ?? going.filter((r) => key(r) < key(run)).sort((a, b) => key(a).localeCompare(key(b)))[0];
  }

  /** Cheap: hands each live run to advance(), skipping runs that are still busy. */
  async function tick() {
    for (const run of ledger.listRuns()) {
      if (!TERMINAL.has(run.state) && !["paused", "queued", "proposed"].includes(run.state)) launch(run.id, () => advance(run.id));
    }
    // The oldest waiting run starts when a slot is free; one a tick, so the count is never stale.
    const runs = ledger.listRuns();
    const next = runs.filter((r) => r.state === "queued").at(-1);
    if (next && runs.filter((r) => WORKING.has(r.state)).length < pinnedPolicy(next).queue.maxActiveRuns) launch(next.id, () => dequeue(next.id));
    void notifier.tick(); // the daily digest, when it's time
  }

  /** Resolves when no step, gate job or notification is running (tests, shutdown). */
  async function idle() {
    while (inflight.size || [...jobs.values()].some((j) => !j.outcome)) {
      await Promise.all([...inflight.values(), ...[...jobs.values()].map((j) => j.promise)]);
    }
    await notifier.idle();
  }

  // ---- what people do ----

  /** The lowest of what was asked for, the policy's autonomy.max and the org-wide SF_AUTONOMY_CAP. */
  function clampAutonomy(requested: Autonomy, max: Autonomy): Autonomy {
    const env = process.env.SF_AUTONOMY_CAP as Autonomy | undefined;
    const caps = [max, ...(env && AUTONOMY.includes(env) ? [env] : [])];
    return AUTONOMY[Math.min(AUTONOMY.indexOf(requested), ...caps.map((c) => AUTONOMY.indexOf(c)))] ?? requested;
  }

  /**
   * Profiles the policy names that the agent server doesn't have, as
   * "agents.builder: \"x\"". Empty when the agent server can't be reached:
   * it may come up later, and every agent start checks again.
   */
  async function missingProfiles(policy: Policy): Promise<string[]> {
    const named: [string, string][] = [];
    for (const [role, ref] of Object.entries(policy.agents)) if (ref) named.push([`agents.${role}`, ref]);
    for (const [risk, ref] of Object.entries(policy.routing)) if (ref) named.push([`routing.${risk}`, ref]);
    if (!named.length) return [];
    const list = await client.listProfiles().catch(() => null);
    if (!list) return [];
    return named.filter(([, ref]) => !list.profiles.some((p) => p.id === ref || p.name === ref)).map(([key, ref]) => `${key}: "${ref}"`);
  }

  // One run is created at a time: two at once (a double-click) would both init the repo or pick the same change name.
  let creating: Promise<unknown> = Promise.resolve();
  type NewRunInput = { goal: string; autonomy?: Autonomy; budgetUsd?: number | null; actor: string; origin?: RunOrigin | null; proposed?: boolean };
  function createRun(input: NewRunInput): Promise<Run> {
    const next = creating.then(() => createRunNow(input));
    creating = next.catch(() => undefined);
    return next;
  }

  async function createRunNow(input: NewRunInput): Promise<Run> {
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
    digestHour = policy.notify.digestHour;
    const missing = await missingProfiles(policy);
    if (missing.length) throw new Error(`${source}: the agent server has no profile for ${missing.join(", ")}`);
    const requested = input.autonomy ?? policy.autonomy.default;
    const autonomy = clampAutonomy(requested, policy.autonomy.max);
    const taken = await takenChangeNames(workspace, baseBranch);
    for (const r of ledger.listRuns()) taken.add(r.change);
    const change = changeNameFor(goal, taken);
    const id = `ap-${randomBytes(4).toString("hex")}`;
    const integrationBranch = `autopilot/${change}`;
    // Past the policy's limit (or behind runs already waiting), it waits in line; its integration
    // branch is made when it starts, from the base as it is then (with anything released meanwhile).
    const runs = ledger.listRuns();
    const queued = runs.some((r) => r.state === "queued") || runs.filter((r) => WORKING.has(r.state)).length >= policy.queue.maxActiveRuns;
    // A request from outside that waits for a person to start it has no branch either.
    const state: RunState = input.proposed ? "proposed" : queued ? "queued" : "spec";
    let integrationDir: string | null = null;
    let integrationSha: string | null = null;
    if (state === "spec") {
      integrationDir = path.join(worktrees, id, "integration");
      await addWorktree(workspace, integrationDir, integrationBranch, `refs/heads/${baseBranch}`);
      integrationSha = await headSha(integrationDir);
    }

    const run = ledger.createRun({ id, goal, change, autonomy, budgetUsd, baseBranch, integrationBranch, integrationDir, integrationSha, policy, policyHash: hash, createdBy: input.actor, state, origin: input.origin ?? null });
    record(input.actor, "autopilot.run_created", id, {
      change,
      autonomy,
      ...(autonomy !== requested ? { requestedAutonomy: requested } : {}),
      goalSummary: clip(goal),
      goalSha256: sha256(goal),
      budgetUsd,
      policyHash: hash,
      ...(state !== "spec" ? { [state]: true } : {}),
      ...(input.origin ? { source: input.origin.source, reference: input.origin.reference } : {}),
    });
    record(SYSTEM, "autopilot.policy_loaded", id, { hash, source, policy });
    changed(id);
    return run;
  }

  /**
   * A request from outside (routes.ts has checked its signature). The
   * policy on the base branch decides: ignored, a proposed run waiting for a
   * person's Start in the Inbox, or a run. A reference already behind a run
   * that isn't cancelled is a duplicate (GitHub redelivers; a label can be
   * added twice). Audit data holds the source, reference and a clipped title,
   * never the body. One request at a time: two deliveries of one issue
   * (GitHub sends `opened` and `labeled` together) would both pass the check.
   */
  type IntakeInput = { source: IntakeSource; payload: unknown; event?: string };
  type IntakeResult = { outcome: "ignored" | "duplicate" | "proposed" | "started"; reason?: string; run?: Run };
  let intaking: Promise<unknown> = Promise.resolve();
  function intake(input: IntakeInput, actor: string): Promise<IntakeResult> {
    const next = intaking.then(() => intakeNow(input, actor));
    intaking = next.catch(() => undefined);
    return next;
  }

  async function intakeNow(input: IntakeInput, actor: string): Promise<IntakeResult> {
    // The base branch createRun will use (main on a detached HEAD), so the policy that decides is the one the run pins.
    const branch = (await isRepoRoot(workspace).catch(() => false)) ? ((await currentBranch(workspace)) ?? "main") : null;
    const { policy } = branch ? await loadPolicy(workspace, branch) : { policy: DEFAULT_POLICY };
    const request: IntakeRequest | null =
      input.source === "github" ? fromGithub(input.event, input.payload, policy.intake.githubLabel) : input.source === "webhook" ? fromWebhook(input.payload) : fromBugForm(input.payload, actor.replace(/^user:/, ""));
    const subject = `intake:${input.source}`;
    if (!request) {
      record(actor, "autopilot.intake_ignored", subject, { source: input.source, event: input.event ?? null, reason: "not for the factory" });
      return { outcome: "ignored", reason: `Only issues opened with the "${policy.intake.githubLabel}" label, or given it, start anything.` };
    }
    const data = { source: request.source, kind: request.kind, reference: request.reference, title: clip(request.title, 80) };
    const mode = policy.intake[request.source];
    if (mode === "off") {
      record(actor, "autopilot.intake_ignored", subject, { ...data, reason: "policy" });
      return { outcome: "ignored", reason: `The policy has intake.${request.source}: off.` };
    }
    const dup = request.reference ? ledger.listRuns().find((r) => r.origin?.reference === request.reference && r.state !== "cancelled") : undefined;
    if (dup) {
      record(actor, "autopilot.intake_duplicate", dup.id, data);
      return { outcome: "duplicate", run: dup };
    }
    const run = await createRun({ goal: goalFor(request), autonomy: policy.intake.autonomy, actor, origin: originOf(request), proposed: mode === "inbox" });
    if (mode === "inbox") {
      const body = [
        // A sender's author and reference are text like the title; the URL is one autolink (link() normalized it: no spaces or <>).
        `A ${mdText(describeOrigin(run.origin as RunOrigin))} asks for this${request.url ? ` (<${request.url}>)` : ""}:`,
        "",
        `> ${mdText(request.title)}`,
        ...(request.body ? ["", ...request.body.split("\n").map((l) => `> ${mdText(l)}`)] : []),
        "",
        `Start puts it in line as \`${run.change}\` at ${run.autonomy} autonomy (the policy's intake.autonomy, under its cap). Not now closes it; the same request can come in again later.`,
      ].join("\n");
      ledger.transaction(() => openItem(run, "intake", `New request: ${clip(request.title, 100)}`, body, INTAKE));
    }
    record(actor, "autopilot.intake_received", run.id, { ...data, mode, why: mode === "run" ? `The policy has intake.${request.source}: run, so it starts a run without asking.` : `The policy has intake.${request.source}: inbox, so a person decides whether it starts.` });
    return { outcome: mode === "inbox" ? "proposed" : "started", run: ledger.getRun(run.id) ?? run };
  }

  function mustRun(runId: string): Run {
    const run = ledger.getRun(runId);
    if (!run) throw new Error(`No run ${runId}`);
    return run;
  }

  async function cancelRun(run: Run, actor: string, note: string | null) {
    if (TERMINAL.has(run.state)) throw new Error(`The run is already ${run.state}.`);
    await stopJobs(run.id); // before their worktrees go
    for (const a of ledger.listAttempts({ runId: run.id })) {
      if (!ACTIVE.has(a.state) && a.state !== "paused") continue;
      await client.pause(a.conversationId).catch(warn);
      ledger.updateAttempt(a.id, { state: "cancelled", finishedAt: now() });
    }
    // A merge a restart interrupted before its gates ran doesn't stay on the deliverable.
    const merging = ledger.listWorkOrders(run.id).find((w) => w.state === "merging" && w.preMergeSha);
    if (merging?.preMergeSha && run.integrationDir) await resetIntegration(run, merging, merging.preMergeSha, actor).catch(warn);
    for (const wo of ledger.listWorkOrders(run.id)) {
      if (wo.worktree) await removeWorktree(workspace, wo.worktree).catch(warn);
      if (wo.branch) await deleteBranch(workspace, wo.branch).catch(warn);
      if (!DONE_WO.has(wo.state)) moveWorkOrder(wo, "cancelled", { actor, patch: { worktree: null, resumeState: null } });
    }
    if (run.revision?.dir) await removeWorktree(workspace, run.revision.dir).catch(warn);
    // The integration branch stays: it holds whatever was committed so far.
    if (run.integrationDir) await removeWorktree(workspace, run.integrationDir).catch(warn);
    if (run.state === "releasing" || run.resumeState === "releasing") await removeWorktree(workspace, releaseDir(run)).catch(warn); // a release merge it was testing
    ledger.dismissInbox({ runId: run.id });
    return moveRun(run, "cancelled", {
      patch: { integrationDir: null, resumeState: null },
      actor,
      action: "autopilot.run_cancelled",
      data: { branch: run.integrationBranch, note: note ? clip(note) : null },
    });
  }

  async function unpause(run: Run, actor: string) {
    // A work order's agents go on only where they work: not one over its budget (raising resumes them) or skipped.
    const working = new Set(ledger.listWorkOrders(run.id).filter((w) => ["building", "reviewing"].includes(w.state)).map((w) => w.id));
    for (const a of ledger.listAttempts({ runId: run.id })) {
      if (a.state !== "paused" || (a.workOrderId && !working.has(a.workOrderId))) continue;
      await client.resume(a.conversationId).catch(warn);
      ledger.updateAttempt(a.id, { state: "running", seenRunning: false, lastSentAt: now() });
    }
    return moveRun(run, run.resumeState ?? "spec", {
      patch: { resumeState: null, pausedReason: null },
      actor,
      action: "autopilot.run_resumed",
    });
  }

  async function pause(runId: string, opts: { note?: string | null; actor: string }): Promise<Run> {
    return locked(runId, async () => {
      const run = mustRun(runId);
      if (TERMINAL.has(run.state) || run.state === "paused") throw new Error(`The run is already ${run.state}.`);
      const note = opts.note?.trim();
      // The run first: a crash before its agents are paused leaves them running and polled after Resume, never orphaned.
      const paused = moveRun(run, "paused", {
        patch: { resumeState: run.state, pausedReason: note || `Paused by ${opts.actor}` },
        actor: opts.actor,
        action: "autopilot.run_paused",
        data: { note: note ? clip(note) : null },
      });
      await Promise.all([pauseAgents(runId), stopJobs(runId)]);
      return paused;
    });
  }

  async function resume(runId: string, opts: { note?: string | null; actor: string }): Promise<Run> {
    return locked(runId, async () => {
      const run = mustRun(runId);
      if (run.state !== "paused") throw new Error(`The run isn't paused (it's ${run.state}).`);
      if (ledger.listInbox({ runId }).some((i) => i.kind === "budget_reached" && !i.workOrderId)) {
        throw new Error("The run reached its budget. Raise it in the Inbox to go on, or cancel the run.");
      }
      // Resuming answers the item the pause came with. A work order's own error item stays for its work order.
      for (const item of ledger.listInbox({ runId })) {
        const decision = item.kind === "run_paused" ? "resume" : item.kind === "error" && !item.workOrderId ? "retry" : null;
        if (decision) ledger.decideInbox(item.id, { decision, note: "Resumed from the pipeline", by: opts.actor });
      }
      return unpause(run, opts.actor);
    });
  }

  async function cancel(runId: string, opts: { note?: string | null; actor: string }): Promise<Run> {
    return locked(runId, async () => cancelRun(mustRun(runId), opts.actor, opts.note?.trim() || null));
  }

  /** Carries out a person's choice on an inbox item (already validated). */
  async function act(run: Run, item: InboxItem, choice: string, note: string | null, actor: string) {
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
        await sendFollowUp(specAttempt(run), reviseFollowUp(note ?? ""), "revise");
        moveRun(run, "spec", { actor });
        return;
      case "questions:answer":
        await sendFollowUp(specAttempt(run), answerFollowUp(note ?? ""), "answer");
        moveRun(run, "spec", { actor });
        return;
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
        } else if (run.state === "paused") await unpause(run, actor);
        return;
      case "run_paused:resume":
        if (run.state === "paused") await unpause(run, actor);
        return;
      case "budget_reached:raise_half":
      case "budget_reached:raise_double": {
        const before = runBudget(run);
        const budgetUsd = Math.round(before * (choice === "raise_half" ? 1.5 : 2) * 100) / 100;
        record(actor, "autopilot.budget_raised", run.id, { scope: "change", from: before, to: budgetUsd });
        const raised = ledger.updateRun(run.id, { budgetUsd });
        if (raised.state === "paused") await unpause(raised, actor);
        return;
      }
      case "budget_reached:raise": {
        const wo = workOrderOf(item);
        const extra = pinnedPolicy(run).budget.perWorkOrderUsd;
        record(actor, "autopilot.budget_raised", run.id, { scope: "work_order", workOrder: `WO-${wo.seq}`, from: workOrderBudget(run, wo), to: workOrderBudget(run, wo) + extra });
        await resumeWorkOrder(ledger.updateWorkOrder(wo.id, { budgetExtraUsd: wo.budgetExtraUsd + extra }), actor);
        return;
      }
      case "release:release":
        if (run.state !== "done") throw new Error(`Only a finished run can be released (this one is ${run.state}).`);
        requestRelease(run, actor);
        return;
      case "release:hold":
        return; // stays done; Release on the Pipeline asks again
      case "replan_approval:replan": {
        const tree = run.revision?.stage === "approval" ? run.revision.tree : undefined;
        if (!tree) throw new Error("There's no new plan waiting for this run.");
        let plan: ReturnType<typeof planWorkOrders>;
        try {
          plan = planWorkOrders(run.integrationDir as string, run.change);
        } catch (err) {
          throw new Error(`The changed tasks.md can't be planned: ${errorText(err)}`);
        }
        const scenarios = run.planTree ? (await treeAt(run.planTree, "specs")) !== (await treeAt(tree, "specs")) : true;
        await applyReplan(run, plan, tree, actor, scenarios);
        return;
      }
      case "replan_approval:keep":
        // The spec as it is now becomes the plan's source; the work orders stay.
        ledger.updateRun(run.id, { planTree: run.revision?.tree ?? run.planTree, revision: null });
        record(actor, "autopilot.replan_declined", run.id, {});
        return;
      case "spec_revision:retry": {
        const rev = run.revision;
        if (rev?.stage !== "failed") throw new Error("There's no stopped spec change to try again.");
        const writing = ledger.updateRun(run.id, { revision: { ...rev, stage: "writing" } });
        await startAgent(writing, "spec");
        return;
      }
      case "spec_revision:drop":
        await endRevision(run);
        record(actor, "autopilot.spec_revision_dropped", run.id, {});
        return;
      case "lesson:accept": {
        const lesson = ledger.listLessons().find((l) => l.itemId === item.id);
        if (!lesson || lesson.state !== "open") throw new Error("This lesson isn't waiting for a decision.");
        const sha = await commitToBase(run.baseBranch, "AGENTS.md", (text) => withLesson(text, lesson.line), `agents: ${clip(lesson.line, 60)} (${actor.replace(/^user:/, "")})`);
        ledger.decideLesson(lesson.key, { state: "accepted", by: actor, sha });
        record(actor, "autopilot.lesson_accepted", run.id, { key: lesson.key, base: run.baseBranch, sha });
        return;
      }
      case "lesson:decline": {
        const lesson = ledger.listLessons().find((l) => l.itemId === item.id);
        if (lesson) ledger.decideLesson(lesson.key, { state: "declined", by: actor });
        record(actor, "autopilot.lesson_declined", run.id, { key: lesson?.key ?? null });
        return;
      }
      case "intake:start":
        // In line like any new run: it starts (and gets its branch) when the queue has room.
        if (run.state !== "proposed") throw new Error(`This run isn't waiting to be started (it's ${run.state}).`);
        moveRun(run, "queued", { actor, action: "autopilot.intake_approved", data: { source: run.origin?.source ?? null, reference: run.origin?.reference ?? null } });
        return;
      case "integration_moved:restore":
        await restoreIntegration(run, actor);
        if (run.state === "paused") await unpause(run, actor);
        return;
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
      case "budget_reached:skip":
      case "error:skip":
      case "work_order_failed:skip": {
        const wo = workOrderOf(item);
        if (wo.worktree) await removeWorktree(workspace, wo.worktree).catch(warn); // the branch keeps what it did
        moveWorkOrder(wo, "skipped", { actor, patch: { worktree: null, resumeState: null } });
        return;
      }
      default:
        throw new Error(`Autopilot doesn't know how to "${choice}" a ${item.kind} item.`);
    }
  }

  /** A person's decision on an inbox item. The choice must be one of its options; some need a note. */
  async function decide(id: number, input: { choice: string; note?: string | null }, actor: string): Promise<InboxItem> {
    const found = ledger.getInbox(id);
    if (!found) throw new Error(`No inbox item ${id}`);
    return locked(found.runId, async () => {
      const item = ledger.getInbox(id) as InboxItem;
      if (item.state !== "open") throw new Error(`Inbox item ${id} is already ${item.state}.`);
      const option = item.options.find((o) => o.id === input.choice);
      if (!option) throw new Error(`Choose one of: ${item.options.map((o) => o.id).join(", ")}.`);
      const note = input.note?.trim() || null;
      if (option.needsNote && !note) throw new Error(`"${option.label}" needs a note.`);
      const run = mustRun(item.runId);
      if (run.state === "paused" && !["error", "run_paused", "integration_moved", "budget_reached"].includes(item.kind) && input.choice !== "cancel") {
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
      await act(run, item, input.choice, note, actor); // throws -> the item stays open
      return close();
    });
  }

  // ---- setup: Home's checklist, with one-click fixes ----

  interface SetupItem {
    id: string;
    ok: boolean;
    /** Nice to have, not needed for a run (alerts). */
    optional?: boolean;
    title: string;
    detail: string;
    fix: { id: string; label: string } | null;
  }

  /** What a workspace needs before (or for better) runs, each with what's wrong and, where a click can fix it, how. */
  async function setup(): Promise<SetupItem[]> {
    const s = await status();
    const exists = existsSync(workspace);
    const branch = s.workspace.branch;
    const loaded = branch ? await loadPolicy(workspace, branch).catch(() => null) : { policy: DEFAULT_POLICY };
    const items: SetupItem[] = [];
    const agent = s.agentServer;
    items.push({
      id: "agent-server",
      ok: agent.reachable && agent.profiles.length > 0,
      title: agent.reachable ? `The agent server answers, with ${agent.profiles.length} agent profile${agent.profiles.length === 1 ? "" : "s"}` : "The agent server doesn't answer",
      detail: agent.reachable ? agent.url : `${agent.url}: ${agent.error}. Start Canvas (pnpm dev), or set SF_AGENT_SERVER_URL to where it runs.`,
      fix: null,
    });
    items.push({
      id: "workspace",
      ok: exists && s.workspace.isRepo,
      title: !exists ? "The workspace folder doesn't exist" : s.workspace.isRepo ? `The workspace is a git repo on ${branch ?? "a detached HEAD"}` : "The workspace isn't a git repo yet",
      detail: !exists ? `${workspace}: create it, or set SF_WORKSPACE to your project.` : s.workspace.isRepo ? workspace : `${workspace}: the factory works on branches of its own, so the workspace must be a repo. Its first commit takes the files as they are (.env files excluded).`,
      fix: exists && !s.workspace.isRepo ? { id: "init-repo", label: "Make it a git repo" } : null,
    });
    const hasPolicy = s.policy.source !== "defaults";
    items.push({
      id: "policy",
      ok: hasPolicy && !s.policy.error,
      title: s.policy.error ? "The policy has an error" : hasPolicy ? `Policy ${s.policy.source} (policy@${s.policy.hash})` : "No policy file yet: the factory's defaults apply",
      detail: s.policy.error ?? (hasPolicy ? "Runs pin these rules when they start. Change them on the Policy page." : "A .factory/policy.yml on the base branch writes the rules down where everyone can see and review them."),
      fix: !hasPolicy && s.workspace.isRepo && branch ? { id: "policy", label: `Add the recommended policy to ${branch}` } : null,
    });
    const gates = loaded ? (loaded.policy.gates ?? (exists ? detectGates(workspace) : [])) : [];
    items.push({
      id: "gates",
      ok: gates.length > 0,
      title: gates.length ? `Gates: ${gates.map((g) => g.name).join(", ")}` : "No gates found yet",
      detail: gates.length ? "The factory runs these on every work order before anything merges." : "Builders usually add a test script, but a repo that has one from the start gives every work order a check. Add a test script to package.json, or list gates in the policy.",
      fix: null,
    });
    const agentsMd = branch ? (await fileAt(workspace, `refs/heads/${branch}`, "AGENTS.md").catch(() => null)) !== null : false;
    items.push({
      id: "agents-md",
      ok: agentsMd,
      title: agentsMd ? "AGENTS.md tells agents how this repo works" : "No AGENTS.md",
      detail: agentsMd ? "Every agent reads it. The factory proposes lines for it when builders keep making the same mistake." : "Every agent reads AGENTS.md: a few lines on how this repo builds and tests save repair rounds.",
      fix: !agentsMd && s.workspace.isRepo && branch ? { id: "agents-md", label: `Add a starter AGENTS.md to ${branch}` } : null,
    });
    items.push({
      id: "alerts",
      ok: !!s.notifications.channel,
      optional: true,
      title: s.notifications.channel ? `Alerts go to ${s.notifications.channel === "json" ? "a webhook" : s.notifications.channel === "slack" ? "Slack" : "Teams"}` : "No team alerts",
      detail: s.notifications.channel ? `One alert for the first decision, then a daily digest at ${s.notifications.digestHour}:00.` : "Set SF_NOTIFY_WEBHOOK to a Slack or Teams incoming webhook to hear when Autopilot needs someone.",
      fix: null,
    });
    return items;
  }

  /** One of the checklist's fixes, as the person who clicked it. Files go onto the base branch in their name. */
  async function fixSetup(id: string, actor: string, opts: { template?: unknown } = {}): Promise<SetupItem[]> {
    const who = actor.replace(/^user:/, "");
    const branchOrThrow = async () => {
      const branch = (await isRepoRoot(workspace).catch(() => false)) ? await currentBranch(workspace) : null;
      if (!branch) throw new Error("Make the workspace a git repo (on a branch) first.");
      return branch;
    };
    if (id === "init-repo") {
      if (!existsSync(workspace)) throw new Error(`${workspace} doesn't exist.`);
      if ((await ensureRepo(workspace)).initialized) record(actor, "autopilot.workspace_initialized", path.basename(workspace), { path: workspace });
    } else if (id === "policy") {
      const branch = await branchOrThrow();
      if ((await fileAt(workspace, `refs/heads/${branch}`, POLICY_FILE)) !== null) throw new Error(`There's already a policy on ${branch}. Change it on the Policy page.`);
      const template = templateById(typeof opts.template === "string" ? opts.template : "recommended");
      if (!template) throw new Error("There's no policy template with that name.");
      const hash = policyHash(parsePolicy(template.yaml));
      const sha = await commitToBase(branch, POLICY_FILE, () => template.yaml, `factory: the ${template.name.toLowerCase()} policy (${who})`);
      record(actor, "autopilot.policy_written", path.basename(workspace), { template: template.id, hash, base: branch, sha });
    } else if (id === "agents-md") {
      const branch = await branchOrThrow();
      if ((await fileAt(workspace, `refs/heads/${branch}`, "AGENTS.md")) !== null) throw new Error(`${branch} already has an AGENTS.md.`);
      const sha = await commitToBase(branch, "AGENTS.md", () => STARTER_AGENTS_MD, `agents: a starter AGENTS.md (${who})`);
      record(actor, "autopilot.agents_md_written", path.basename(workspace), { base: branch, sha });
    } else {
      throw new Error(`There's no setup fix called "${id}".`);
    }
    broadcast({ type: "autopilot.changed" });
    return setup();
  }

  // ---- the Policy page ----

  /** The policy file on the base branch, what it makes the factory do, and the templates to start from. */
  async function policyView() {
    const branch = (await isRepoRoot(workspace).catch(() => false)) ? await currentBranch(workspace) : null;
    const yaml = branch ? await fileAt(workspace, `refs/heads/${branch}`, POLICY_FILE).catch(() => null) : null;
    let loaded: { policy: Policy; hash: string; source: string } | null = null;
    let error: string | null = null;
    try {
      loaded = branch ? await loadPolicy(workspace, branch) : { policy: DEFAULT_POLICY, hash: policyHash(DEFAULT_POLICY), source: "defaults" };
    } catch (err) {
      error = errorText(err);
    }
    return {
      base: branch,
      source: loaded?.source ?? `${POLICY_FILE}@${branch}`,
      hash: loaded?.hash ?? null,
      error,
      yaml,
      policy: loaded?.policy ?? null,
      explanation: loaded ? explainPolicy(loaded.policy) : [],
      templates: POLICY_TEMPLATES.map((t) => {
        const policy = parsePolicy(t.yaml);
        return { ...t, hash: policyHash(policy), explanation: explainPolicy(policy) };
      }),
    };
  }

  /** What a draft of policy.yml would mean, or what's wrong with it. Nothing is written. */
  function checkPolicy(yaml: unknown) {
    if (typeof yaml !== "string") return { ok: false, error: "Send the policy as text.", hash: null, explanation: [] as string[] };
    try {
      const policy = parsePolicy(yaml);
      return { ok: true, error: null, hash: policyHash(policy), explanation: explainPolicy(policy) };
    } catch (err) {
      return { ok: false, error: errorText(err), hash: null, explanation: [] as string[] };
    }
  }

  /**
   * A person's new policy (their text, or a template), committed to the base
   * branch in their name like any other change to it. Runs already going keep
   * the policy they pinned; new ones read this.
   */
  async function writePolicy(input: { yaml?: unknown; template?: unknown }, actor: string) {
    const template = typeof input.template === "string" ? templateById(input.template) : undefined;
    if (typeof input.template === "string" && !template) throw new Error("There's no policy template with that name.");
    const yaml = template?.yaml ?? (typeof input.yaml === "string" ? input.yaml : null);
    if (!yaml?.trim() || yaml.length > 100_000) throw new Error("Send the policy's text (at most 100,000 characters), or a template's name.");
    let policy: Policy;
    try {
      policy = parsePolicy(yaml);
    } catch (err) {
      throw new Error(`The policy isn't valid, so nothing was written: ${errorText(err)}`);
    }
    const branch = (await isRepoRoot(workspace).catch(() => false)) ? await currentBranch(workspace) : null;
    if (!branch) throw new Error("Make the workspace a git repo (on a branch) first.");
    const before = await loadPolicy(workspace, branch).then((p) => p.hash, () => null);
    const hash = policyHash(policy);
    const who = actor.replace(/^user:/, "");
    const sha = await commitToBase(branch, POLICY_FILE, () => (yaml.endsWith("\n") ? yaml : `${yaml}\n`), `factory: ${template ? `the ${template.name.toLowerCase()} policy` : "policy changed"} (${who})`);
    record(actor, "autopilot.policy_written", path.basename(workspace), { template: template?.id ?? null, hash, from: before, base: branch, sha });
    broadcast({ type: "autopilot.changed" });
    return policyView();
  }

  async function status() {
    const agent = await client.listProfiles().then(
      (r) => (agentServerUp(), { reachable: true, error: null as string | null, profiles: r.profiles, activeProfileId: r.activeId }),
      (err: unknown) => ({ reachable: false, error: errorText(err), profiles: [], activeProfileId: null }),
    );
    const isRepo = await isRepoRoot(workspace).catch(() => false);
    const branch = isRepo ? await currentBranch(workspace) : null;
    // The policy a run started now would pin; an invalid policy.yml shows here before anyone starts one.
    // `autonomy`: what Home preselects, and the most anyone can pick (the policy's max under SF_AUTONOMY_CAP).
    const autonomyOf = (p: Policy) => ({ default: clampAutonomy(p.autonomy.default, p.autonomy.max), max: clampAutonomy("autonomous", p.autonomy.max) });
    // A policy naming profiles the agent server lacks starts no run either, so it shows as the policy's error.
    const checked = async (p: { policy: Policy; hash: string; source: string }) => {
      digestHour = p.policy.notify.digestHour;
      const missing = agent.reachable ? await missingProfiles(p.policy) : [];
      const error = missing.length ? `${p.source}: the agent server has no profile for ${missing.join(", ")}` : null;
      return { source: p.source, hash: p.hash, error, autonomy: autonomyOf(p.policy) as ReturnType<typeof autonomyOf> | null, budget: p.policy.budget as Policy["budget"] | null };
    };
    const policy = branch
      ? await loadPolicy(workspace, branch).then(checked, (err: unknown) => ({ source: `${POLICY_FILE}@${branch}`, hash: "", error: errorText(err), autonomy: null, budget: null }))
      : await checked({ policy: DEFAULT_POLICY, hash: policyHash(DEFAULT_POLICY), source: "defaults" });
    const webhook = process.env.SF_NOTIFY_WEBHOOK?.trim();
    return {
      // downSince: when runs started waiting for it (null while it answers).
      agentServer: { url: client.baseUrl, ...agent, downSince: outage?.since ?? null },
      workspace: { path: workspace, isRepo, branch },
      policy,
      notifications: { channel: webhook ? channelOf(webhook) : null, digestHour },
      openInbox: ledger.openInboxCount(),
      activeRuns: ledger.listRuns().filter((r) => !TERMINAL.has(r.state)).length,
      queuedRuns: ledger.listRuns().filter((r) => r.state === "queued").length,
    };
  }

  return {
    ledger,
    workspace,
    waitingOn,
    createRun,
    intake,
    reviseSpec,
    previewFile,
    setup,
    fixSetup,
    policyView,
    checkPolicy,
    writePolicy,
    decide,
    pause,
    resume,
    cancel,
    release,
    tick,
    idle,
    status,
    /** Runs tick() every `intervalMs` (index.ts uses 3 s). */
    start(intervalMs = 3000) {
      if (timer) return;
      timer = setInterval(() => void tick(), intervalMs);
      timer.unref();
      void tick();
    },
    stop() {
      clearInterval(timer);
      timer = undefined;
    },
  };
}

export type Orchestrator = ReturnType<typeof createOrchestrator>;
