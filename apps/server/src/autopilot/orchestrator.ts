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
import { existsSync } from "node:fs";
import path from "node:path";
import { audit, sha256 } from "../audit.js";
import { broadcast } from "../events.js";
import { tools } from "../tools.js";
import { detectGates, gateFindings, runGates, type GateResult } from "./gates.js";
import {
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
  removeWorktree,
  resetHard,
} from "./git.js";
import { mergeAndTest } from "./integrator.js";
import type {
  Attempt,
  AttemptRole,
  Autonomy,
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
  verdictReminder,
} from "./prompts.js";
import { DEFAULT_POLICY, evaluateMerge, loadPolicy, newDependencies, pinnedPolicy, POLICY_FILE, policyHash, type Policy } from "./policy.js";
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

export interface OrchestratorDeps {
  ledger: Ledger;
  client: OpenHandsClient;
  workspace: string; // the repo the runs work on
  dataDir: string; // worktrees go in <dataDir>/worktrees/<runId>/
  /** How long an end state right after a message is distrusted (see classify). Tests use 0. */
  graceMs?: number;
}

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

const now = () => new Date().toISOString();
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
/** The agent server is down or slow: leave everything as it is and try again on a later tick. */
const unreachable = (err: unknown) => err instanceof OpenHandsError && err.status === 0;
/** One line, at most `max` chars: for audit data, which never holds full goals, notes or prompts. */
const clip = (text: string, max = 120) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};
const warn = (err: unknown) => console.warn(`[autopilot] ${errorText(err)}`);
// Plain text inside a markdown body: a sensitive-path glob's double stars must not turn bold.
const mdText = (text: string) => text.replace(/[\\`*_[\]<>#|~]/g, (c) => `\\${c}`);

export function createOrchestrator(deps: OrchestratorDeps) {
  const { ledger, client, workspace } = deps;
  const graceMs = deps.graceMs ?? 20_000;
  const worktrees = path.join(deps.dataDir, "worktrees");
  const inflight = new Map<string, Promise<void>>(); // runId -> what's being done for it
  let timer: NodeJS.Timeout | undefined;

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
    return item;
  }

  /** A step failed: pause the run and ask a person (retry or cancel). */
  function failed(runId: string, err: unknown) {
    if (unreachable(err)) return;
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
    if (wo) return a.role === "reviewer" ? reviewerBrief({ change: run.change, wo }) : builderBrief({ change: run.change, wo, gates: pinnedPolicy(run).gates });
    if (a.role === "critic") return criticBrief({ change: run.change });
    // A spec agent started after one that failed (or whose tasks.md couldn't be planned) hears why.
    const before = ledger.listAttempts({ runId: run.id, role: "spec" }).filter((x) => x.id < a.id).at(-1);
    const problem = (before?.result as { reason?: string } | null)?.reason ?? null;
    return specBrief({ goal: run.goal, change: run.change, autonomy: run.autonomy, openspecVersion: tools.openspec.version, problem });
  }

  /** Safe to repeat after a restart: the conversation id is fixed, so the agent server returns the existing one. */
  async function startConversation(a: Attempt) {
    const run = ledger.getRun(a.runId);
    const wo = a.workOrderId ? ledger.getWorkOrder(a.workOrderId) : undefined;
    const dir = wo ? wo.worktree : run?.integrationDir; // builders and reviewers work in their work order's worktree
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
      ledger.updateAttempt(a.id, { state: "running", seenRunning: snap.status === "running", costUsd: snap.costUsd, lastSentAt: now() });
    } catch (err) {
      if (unreachable(err)) return; // stays "starting": a later tick starts it again with the same id
      ledger.updateAttempt(a.id, { state: "error", finishedAt: now(), result: { error: errorText(err) } });
      record(SYSTEM, "autopilot.agent_finished", run.id, { role: a.role, attempt: a.id, state: "error", error: clip(errorText(err)) });
    }
    changed(run.id);
  }

  async function poll(a: Attempt) {
    const snap = await client.get(a.conversationId);
    if (!snap) {
      ledger.updateAttempt(a.id, { state: "error", finishedAt: now(), result: { error: "The conversation is gone from the agent server." } });
      record(SYSTEM, "autopilot.agent_finished", a.runId, { role: a.role, attempt: a.id, state: "error" });
      return changed(a.runId);
    }
    const seenRunning = a.seenRunning || snap.status === "running";
    const outcome = classify(snap, { seenRunning, lastSentAt: a.lastSentAt }, new Date(), graceMs);
    // "paused" means someone paused it in Canvas: keep polling until they resume it there.
    const state = outcome === "done" ? "finished" : outcome === "failed" ? (snap.status === "stuck" ? "stuck" : "error") : "running";
    ledger.updateAttempt(a.id, { state, seenRunning, costUsd: snap.costUsd, finishedAt: state === "running" ? null : now() });
    if (state !== "running") record(SYSTEM, "autopilot.agent_finished", a.runId, { role: a.role, attempt: a.id, state, costUsd: snap.costUsd });
    if (state !== a.state || snap.costUsd !== a.costUsd) changed(a.runId);
  }

  /** A follow-up message to an existing conversation; the agent starts on it right away. */
  async function sendFollowUp(a: Attempt, text: string, reason: string) {
    try {
      await client.send(a.conversationId, text);
    } catch (err) {
      // 429: the message is saved but the agent didn't start on it; nudge it.
      if (!(err instanceof OpenHandsError && err.status === 429)) throw err;
      await client.resume(a.conversationId).catch(warn);
    }
    ledger.updateAttempt(a.id, { state: "running", turns: a.turns + 1, seenRunning: false, lastSentAt: now(), finishedAt: null });
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
    if (!a) return startAgent(run, "spec");
    if (ACTIVE.has(a.state) || a.state === "paused" || handled(a)) return; // working, or waiting for a person
    const dir = run.integrationDir as string;
    if (a.state !== "finished") return specFailed(run, a, await whyStopped(a, "The spec agent"));

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

    const title = proposalTitle(readProposal(dir, run.change)) ?? run.goal;
    const sha = await commitAll(dir, `spec(${run.change}): ${clip(title, 72)}`);
    if (sha) record(SYSTEM, "autopilot.spec_committed", run.id, { change: run.change, branch: run.integrationBranch, sha });
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
    const verdict = parseCriticVerdict(await client.finalResponse(c.conversationId));
    if (!(await isClean(dir))) {
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

  /** The factory's own checks on the committed work: pass -> a reviewer, fail -> a repair round. */
  async function verify(run: Run, wo: WorkOrder) {
    const dir = wo.worktree as string;
    const { ok, results } = await runGates(dir, pinnedPolicy(run).gates ?? detectGates(dir));
    recordGates(run, wo, "build", results);
    if (!ok) return repair(run, wo, gateFindings(results));
    await discardChanges(dir); // what the gates left (build output), so anything left after the review is the reviewer's
    await startReviewer(run, wo);
  }

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
  async function repair(run: Run, wo: WorkOrder, findings: Finding[]) {
    const all = builders(wo);
    const last = all.at(-1);
    const data = { workOrder: `WO-${wo.seq}`, findings: findings.length };
    const limits = pinnedPolicy(run).repair;
    // A conversation that never started, or is gone from the agent server, can't take a follow-up.
    if (last && !(last.result as { error?: string } | null)?.error && last.turns < 1 + limits.sameConversation) {
      await sendFollowUp(last, repairMessage(findings), "repair");
      moveWorkOrder(wo, "building", { patch: { findings }, action: "autopilot.repair_requested", data: { ...data, builder: all.length, turn: last.turns + 1 } });
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
    const decision = evaluateMerge(policy, {
      autonomy: run.autonomy,
      gatesOk: true, // a work order is ready only once its gates have passed (verify)
      hiddenTestsOk: null, // not run yet (C11)
      reviewPassed: !!review?.verdict && passed(review, policy.review.blocking),
      secretFindings: 0, // no secret scan yet (C10)
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
      bullets(check.reasons.map(mdText)),
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
    const approval = ledger
      .listInbox({ state: "decided", runId: run.id })
      .find((i) => i.workOrderId === wo.id && i.kind === "merge_approval" && i.decision === "merge");
    if (!approval?.decidedBy) throw new Error(`WO-${wo.seq} has no merge approval on record.`);
    return { actor: approval.decidedBy, reasons };
  }

  /**
   * Merge, re-test, then merged; or the integration branch goes back to where
   * it was and the work order back to its builder, its branch brought up to
   * date with the integration branch (a conflict's markers left for it to
   * resolve). That counts as a repair round.
   */
  async function integrate(run: Run, wo: WorkOrder) {
    const dir = run.integrationDir as string;
    const { actor, reasons } = await mergeActor(run, wo);
    const key = `WO-${wo.seq}`;
    // Saved before merging, so a restart (or a failure) knows where the integration branch was.
    let pre = wo.preMergeSha;
    if (!pre) {
      pre = await headSha(dir);
      ledger.updateWorkOrder(wo.id, { preMergeSha: pre });
    }
    const r = await mergeAndTest(dir, wo.branch as string, `Merge ${key}: ${clip(wo.title, 72)}`, pre, pinnedPolicy(run).gates);
    if (r.results.length) recordGates(run, wo, "integrate", r.results);
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
    for (const a of ledger.listAttempts({ runId }).filter((x) => ACTIVE.has(x.state))) {
      await (a.state === "starting" ? startConversation(a) : poll(a));
    }
    const run = ledger.getRun(runId);
    if (run?.state === "spec") await specStep(run);
    else if (run?.state === "critic") await criticStep(run);
    else if (run?.state === "building") await buildStep(run);
  }

  /** Cheap: hands each live run to advance(), skipping runs that are still busy. */
  async function tick() {
    for (const run of ledger.listRuns()) {
      if (!TERMINAL.has(run.state) && run.state !== "paused") launch(run.id, () => advance(run.id));
    }
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
    const next = creating.then(() => createRunNow(input));
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
    const requested = input.autonomy ?? policy.autonomy.default;
    const autonomy = clampAutonomy(requested, policy.autonomy.max);
    const taken = await takenChangeNames(workspace, baseBranch);
    for (const r of ledger.listRuns()) taken.add(r.change);
    const change = changeNameFor(goal, taken);
    const id = `ap-${randomBytes(4).toString("hex")}`;
    const integrationDir = path.join(worktrees, id, "integration");
    const integrationBranch = `autopilot/${change}`;
    await addWorktree(workspace, integrationDir, integrationBranch, baseBranch);

    const run = ledger.createRun({ id, goal, change, autonomy, budgetUsd, baseBranch, integrationBranch, integrationDir, policy, policyHash: hash, createdBy: input.actor });
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
    changed(id);
    return run;
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
    // The integration branch stays: it holds whatever was committed so far.
    if (run.integrationDir) await removeWorktree(workspace, run.integrationDir).catch(warn);
    ledger.dismissInbox({ runId: run.id });
    return moveRun(run, "cancelled", {
      patch: { integrationDir: null, resumeState: null },
      actor,
      action: "autopilot.run_cancelled",
      data: { branch: run.integrationBranch, note: note ? clip(note) : null },
    });
  }

  async function unpause(run: Run, actor: string) {
    for (const a of ledger.listAttempts({ runId: run.id })) {
      if (a.state !== "paused") continue;
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
      for (const a of ledger.listAttempts({ runId })) {
        if (a.state !== "running") continue;
        await client.pause(a.conversationId).catch(warn);
        ledger.updateAttempt(a.id, { state: "paused" });
      }
      const note = opts.note?.trim();
      return moveRun(run, "paused", {
        patch: { resumeState: run.state, pausedReason: note || `Paused by ${opts.actor}` },
        actor: opts.actor,
        action: "autopilot.run_paused",
        data: { note: note ? clip(note) : null },
      });
    });
  }

  async function resume(runId: string, opts: { note?: string | null; actor: string }): Promise<Run> {
    return locked(runId, async () => {
      const run = mustRun(runId);
      if (run.state !== "paused") throw new Error(`The run isn't paused (it's ${run.state}).`);
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
      if (run.state === "paused" && item.kind !== "error" && item.kind !== "run_paused" && input.choice !== "cancel") {
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

  async function status() {
    const agent = await client.listProfiles().then(
      (r) => ({ reachable: true, error: null as string | null, profiles: r.profiles, activeProfileId: r.activeId }),
      (err: unknown) => ({ reachable: false, error: errorText(err), profiles: [], activeProfileId: null }),
    );
    const isRepo = await isRepoRoot(workspace).catch(() => false);
    const branch = isRepo ? await currentBranch(workspace) : null;
    // The policy a run started now would pin; an invalid policy.yml shows here before anyone starts one.
    // `autonomy`: what Home preselects, and the most anyone can pick (the policy's max under SF_AUTONOMY_CAP).
    const autonomyOf = (p: Policy) => ({ default: clampAutonomy(p.autonomy.default, p.autonomy.max), max: clampAutonomy("autonomous", p.autonomy.max) });
    const policy = branch
      ? await loadPolicy(workspace, branch).then(
          (p) => ({ source: p.source, hash: p.hash, error: null as string | null, autonomy: autonomyOf(p.policy) as ReturnType<typeof autonomyOf> | null }),
          (err: unknown) => ({ source: `${POLICY_FILE}@${branch}`, hash: "", error: errorText(err), autonomy: null }),
        )
      : { source: "defaults", hash: policyHash(DEFAULT_POLICY), error: null, autonomy: autonomyOf(DEFAULT_POLICY) };
    return {
      agentServer: { url: client.baseUrl, ...agent },
      workspace: { path: workspace, isRepo, branch },
      policy,
      openInbox: ledger.openInboxCount(),
      activeRuns: ledger.listRuns().filter((r) => !TERMINAL.has(r.state)).length,
    };
  }

  return {
    ledger,
    createRun,
    decide,
    pause,
    resume,
    cancel,
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
