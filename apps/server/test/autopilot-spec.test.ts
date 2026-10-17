import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { type FakeConversation, type FakeHandler, type FakeProfile, startFakeOpenHands } from "./fake-openhands.js";

// Audit log and worktrees in a temp folder, and never the real workspace, before config is read.
const dataRoot = mkdtempSync(path.join(tmpdir(), "sf-spec-data-"));
process.env.SF_DATA_DIR = dataRoot;
process.env.SF_WORKSPACE = mkdtempSync(path.join(tmpdir(), "sf-spec-unused-"));
delete process.env.SF_AUTONOMY_CAP;
const { assumptionsOf, changeNameFor, openQuestions, parseCriticVerdict } = await import("../src/autopilot/spec.js");
const { criticBrief, specBrief } = await import("../src/autopilot/prompts.js");
const { createOrchestrator } = await import("../src/autopilot/orchestrator.js");
const { openLedger } = await import("../src/autopilot/ledger.js");
const { OpenHandsClient, OpenHandsError } = await import("../src/autopilot/openhands.js");
const { fileAt, git } = await import("../src/autopilot/git.js");
const { audit, listAudit } = await import("../src/audit.js");

// The demo workspace's OpenSpec folder, copied (never changed) into each test's workspace.
const FIXTURE = path.resolve(import.meta.dirname, "../../../workspaces/benefits-portal/openspec");
const EXAMPLE = "add-claim-status-lookup";
const CLAUDE: FakeProfile = { id: "11111111-1111-4111-8111-111111111111", name: "claude", agent_kind: "acp", acp_server: "claude-code" };
const CODEX: FakeProfile = { id: "22222222-2222-4222-8222-222222222222", name: "codex", agent_kind: "acp", acp_server: "codex" };

// ---- pure pieces ----

test("changeNameFor: kebab-case, starts with a letter, at most 48 chars cut at a dash, unique", () => {
  assert.equal(changeNameFor("Add claim status lookup"), "add-claim-status-lookup");
  assert.equal(changeNameFor("  Let applicants upload PDFs (≤10 MB)!  "), "let-applicants-upload-pdfs-10-mb");
  assert.equal(changeNameFor("2FA for staff sign-in"), "change-2fa-for-staff-sign-in");
  assert.equal(changeNameFor("!!!"), "change");
  assert.equal(
    changeNameFor("Show every applicant a plain-language explanation of each claim status and what happens next"),
    "show-every-applicant-a-plain-language",
  );
  const taken = new Set(["add-claim-status-lookup", "add-claim-status-lookup-2"]);
  assert.equal(changeNameFor("Add claim status lookup", taken), "add-claim-status-lookup-3");
  // The suffix still fits in 48 chars.
  const long = `${"a".repeat(20)}-${"b".repeat(27)}`;
  assert.equal(changeNameFor(long.replace("-", " "), new Set([long])), `${"a".repeat(20)}-2`);
});

test("parseCriticVerdict: the last json block, a bare object, odd values, and no verdict at all", () => {
  const fenced = parseCriticVerdict(
    'For example:\n```json\n{"verdict":"revise","findings":[]}\n```\nMy verdict:\n```json\n{"verdict":"pass","findings":[{"severity":"LOW","where":"tasks.md","issue":"Nit","suggestion":"Fix it"}]}\n```',
  );
  assert.deepEqual(fenced, { verdict: "pass", findings: [{ source: "critic", severity: "low", title: "Nit", detail: "Fix it", file: "tasks.md" }] });

  const bare = parseCriticVerdict(
    'I think {this} matters.\n{"verdict": "Revise", "findings": [{"severity": "blocker", "issue": "Scenario {Unknown claim} has no THEN"}, {"severity": "high"}]}\nThanks',
  );
  assert.deepEqual(bare, {
    verdict: "revise",
    findings: [{ source: "critic", severity: "medium", title: "Scenario {Unknown claim} has no THEN", detail: "", file: null }],
  });

  assert.equal(parseCriticVerdict('{"verdict":"approved"}').verdict, "pass");
  // A fence that doesn't parse falls back to the last object that does.
  assert.equal(parseCriticVerdict('```json\n{"verdict": "pass",\n```\n{"verdict":"revise","findings":[]}').verdict, "revise");
  assert.deepEqual(parseCriticVerdict("Looks good to me!"), {
    verdict: "revise",
    findings: [{ source: "critic", severity: "medium", title: "The critic's reply had no readable verdict", detail: "" }],
    unreadable: true,
  });
});

test("openQuestions and assumptionsOf read the proposal's bullets; 'None' doesn't count", () => {
  const md = [
    "## Why", "- not this", "",
    "## Assumptions", "- Claim numbers are case-sensitive", "* Staff use the same page", "",
    "## Open Questions", "- Which offices pilot it?", "- None", "",
    "## Impact", "- not this either",
  ].join("\n");
  assert.deepEqual(assumptionsOf(md), ["Claim numbers are case-sensitive", "Staff use the same page"]);
  assert.deepEqual(openQuestions(md), ["Which offices pilot it?"]);
  assert.deepEqual(openQuestions("## Open questions\n\nNone.\n"), []);
});

test("briefs: the spec agent gets the goal, the change, the CLI and the rules; the critic gets the verdict format", () => {
  const brief = specBrief({ goal: "Add claim status lookup", change: "add-claim-status-lookup-2", autonomy: "autonomous", openspecVersion: "1.14.0" });
  for (const part of [
    "Add claim status lookup",
    "`add-claim-status-lookup-2`",
    "openspec new change add-claim-status-lookup-2",
    "npx -y @fission-ai/openspec@1.14.0",
    "openspec validate add-claim-status-lookup-2 --strict",
    "#### Scenario:",
    "## Controls",
    "## N. Title",
    "- [ ] N.M item",
    "Depends on: 1, 3",
    "Don't write application code",
    "Don't commit",
    "backlog/",
    "## Assumptions",
    "## Open questions",
    "don't ask questions",
  ]) {
    assert.ok(brief.includes(part), part);
  }
  assert.ok(specBrief({ goal: "x", change: "x", autonomy: "suggest", openspecVersion: "1.14.0" }).includes("A person reviews the spec"));

  const critic = criticBrief({ change: "add-x" });
  for (const part of ["openspec/changes/add-x/", "Section 508", "Don't edit any files", "```json", '"verdict": "pass" | "revise"']) {
    assert.ok(critic.includes(part), part);
  }
});

// ---- the spec stage end to end: fake agent server, real git and openspec ----

/** The change name the spec brief asks for. */
const changeIn = (conv: FakeConversation) => /The change is called `([^`]+)`/.exec(conv.messages[0] ?? "")?.[1] ?? "missing";
const changeDir = (conv: FakeConversation) => path.join(conv.workingDir, "openspec", "changes", changeIn(conv));

/** Plays a spec agent that writes a valid change: a copy of the fixture's example, plus `extra` in the proposal. */
function writeValid(conv: FakeConversation, extra = "") {
  const dir = changeDir(conv);
  cpSync(path.join(conv.workingDir, "openspec", "changes", EXAMPLE), dir, { recursive: true });
  writeFileSync(path.join(dir, "proposal.md"), readFileSync(path.join(dir, "proposal.md"), "utf8") + extra);
}

/** A proposal with no spec deltas: strict validation fails. */
function writeInvalid(conv: FakeConversation) {
  mkdirSync(changeDir(conv), { recursive: true });
  writeFileSync(path.join(changeDir(conv), "proposal.md"), "## Why\n\nBecause.\n");
}

const verdict = (v: object) => `Reviewed.\n\n\`\`\`json\n${JSON.stringify(v)}\n\`\`\``;
const PASS = verdict({ verdict: "pass", findings: [] });

function byRole(roles: Partial<Record<string, FakeHandler>>): FakeHandler {
  return (conv, text) => (roles[conv.tags.sfrole ?? ""] ?? (() => ({ response: "Done.", cost: 0.01 })))(conv, text);
}

/** Waits until queued audit records are written. */
const flushAudit = () => audit("test", "test.flush", "test");

function newWorkspace(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "sf-spec-ws-"));
  cpSync(FIXTURE, path.join(dir, "openspec"), { recursive: true });
  return dir;
}

async function setup(handler: FakeHandler) {
  const workspace = newWorkspace();
  const dataDir = mkdtempSync(path.join(dataRoot, "case-"));
  const fake = await startFakeOpenHands({ onMessage: handler, profiles: [CLAUDE, CODEX] });
  const ledger = openLedger(path.join(dataDir, "autopilot.db"));
  const o = createOrchestrator({ ledger, client: new OpenHandsClient({ baseUrl: fake.url }), workspace, dataDir, graceMs: 0 });
  return {
    workspace,
    fake,
    ledger,
    o,
    async until(done: () => boolean, max = 40) {
      for (let i = 0; i < max; i++) {
        await o.tick();
        await o.idle();
        await fake.settled();
        if (done()) return;
      }
      assert.fail("the run didn't get there");
    },
    async close() {
      o.stop();
      await o.idle();
      await fake.close();
      ledger.close();
    },
  };
}

test("spec stage: a valid change is validated, committed on autopilot/<change>, critiqued by another vendor, then plan approval (supervised)", async () => {
  const t = await setup(
    byRole({
      spec: (conv) => {
        writeValid(conv, "\n## Assumptions\n\n- Claim numbers are case-sensitive\n\n## Open questions\n\n- None\n");
        return { response: "Wrote the change.", cost: 0.5 };
      },
      critic: () => ({
        response: verdict({ verdict: "pass", findings: [{ severity: "low", where: "tasks.md", issue: "Group 3 could name its log sink", suggestion: "Name it" }] }),
        cost: 0.25,
      }),
    }),
  );
  try {
    const run = await t.o.createRun({ goal: "Add claim status lookup", autonomy: "supervised", actor: "user:test" });
    assert.equal(run.change, "add-claim-status-lookup-2"); // the base branch already has add-claim-status-lookup
    assert.equal(run.integrationBranch, "autopilot/add-claim-status-lookup-2");
    assert.equal(run.state, "spec");
    await t.until(() => t.ledger.getRun(run.id)?.state === "awaiting_plan_approval");

    const [spec, critic, ...more] = t.ledger.listAttempts({ runId: run.id });
    assert.equal(more.length, 0);
    assert.equal(spec?.role, "spec");
    assert.equal(spec.agentProfile, CLAUDE.id);
    assert.equal(spec.state, "finished");
    assert.equal(critic?.role, "critic");
    assert.equal(critic.agentProfile, CODEX.id); // another vendor than the spec agent
    assert.equal((critic.result as { verdict: string }).verdict, "pass");
    const conv = t.fake.conversations.get(spec.conversationId);
    assert.equal(conv?.workingDir, run.integrationDir);
    assert.deepEqual(conv.tags, { sfrun: run.id, sfrole: "spec", sfwo: "" });
    assert.equal(conv.messages.length, 1);
    assert.match(conv.messages[0] ?? "", /<goal>\nAdd claim status lookup\n<\/goal>/);

    assert.deepEqual(
      t.ledger.listChecks({ runId: run.id }).map((c) => [c.name, c.ok]),
      [["openspec-validate", true]],
    );
    // Committed on the integration branch of the workspace repo, not on main.
    assert.match((await fileAt(t.workspace, run.integrationBranch, `openspec/changes/${run.change}/proposal.md`)) ?? "", /case-sensitive/);
    assert.equal(await fileAt(t.workspace, "main", `openspec/changes/${run.change}/proposal.md`), null);
    const subject = (await git(t.workspace, ["log", "-1", "--format=%s", run.integrationBranch])).stdout.trim();
    assert.equal(subject, `spec(${run.change}): Add claim status lookup`);

    const items = t.ledger.listInbox({ runId: run.id });
    assert.equal(items.length, 1);
    const item = items[0]!;
    assert.equal(item.kind, "plan_approval");
    assert.deepEqual(item.options.map((o) => o.id), ["approve", "revise", "cancel"]);
    assert.match(item.body, /Claim numbers are case-sensitive/);
    assert.match(item.body, /Critic: pass/);
    assert.match(item.body, /Group 3 could name its log sink/);
    assert.ok(Math.abs(t.ledger.runCost(run.id) - 0.75) < 1e-9);

    const decided = await t.o.decide(item.id, { choice: "approve" }, "user:test");
    assert.equal(decided.state, "decided");
    assert.equal(t.ledger.getRun(run.id)?.state, "building");
    await flushAudit();
    const events = listAudit().filter((e) => e.subject === run.id);
    for (const action of ["autopilot.run_created", "autopilot.agent_started", "autopilot.spec_committed", "autopilot.critic_verdict", "autopilot.inbox_decided"]) {
      assert.ok(events.some((e) => e.action === action), action);
    }
    assert.equal(events.find((e) => e.action === "autopilot.plan_approved")?.actor, "user:test");
    assert.equal(events.find((e) => e.action === "autopilot.run_created")?.data.goalSummary, "Add claim status lookup");
  } finally {
    await t.close();
  }
});

test("spec stage: an invalid change gets a follow-up listing the issues; autonomous goes on to building by policy", async () => {
  const t = await setup(
    byRole({
      spec: (conv) => {
        if (conv.messages.length === 1) writeInvalid(conv);
        else writeValid(conv);
        return { response: "Done." };
      },
      // The first reply has no verdict block; asked again, it gives one.
      critic: (conv) => ({ response: conv.messages.length === 1 ? "Looks fine to me." : PASS }),
    }),
  );
  try {
    const run = await t.o.createRun({ goal: "Let applicants see claim status", autonomy: "autonomous", actor: "user:test" });
    await t.until(() => t.ledger.getRun(run.id)?.state === "building");

    const specs = t.ledger.listAttempts({ runId: run.id, role: "spec" });
    assert.equal(specs.length, 1);
    assert.equal(specs[0]?.turns, 2);
    const conv = t.fake.conversations.get(specs[0].conversationId);
    assert.equal(conv?.messages.length, 2);
    assert.match(conv.messages[1] ?? "", /openspec validate let-applicants-see-claim-status --strict/);
    assert.match(conv.messages[1] ?? "", /at least one delta/);
    assert.deepEqual(
      t.ledger.listChecks({ runId: run.id }).map((c) => [c.name, c.ok]),
      [["openspec-validate", false], ["openspec-validate", true]],
    );
    assert.equal(t.ledger.listInbox({ runId: run.id, state: "all" }).length, 0);
    const [critic, ...moreCritics] = t.ledger.listAttempts({ runId: run.id, role: "critic" });
    assert.equal(moreCritics.length, 0);
    assert.equal(critic?.turns, 2);
    assert.match(t.fake.conversations.get(critic.conversationId)?.messages[1] ?? "", /only the fenced json block/);

    await flushAudit();
    const approved = listAudit().find((e) => e.subject === run.id && e.action === "autopilot.plan_approved");
    assert.match(t.ledger.getRun(run.id)?.policyHash ?? "", /^[0-9a-f]{12}$/);
    assert.equal(approved?.actor, `policy@${t.ledger.getRun(run.id)?.policyHash}`);
    assert.equal(approved.data.critic, "pass");
  } finally {
    await t.close();
  }
});

test("spec stage: still invalid after three tries opens spec_failed; retry starts a new spec agent", async () => {
  const t = await setup(
    byRole({
      spec: (conv) => {
        writeInvalid(conv);
        return { response: "Done." };
      },
    }),
  );
  try {
    const run = await t.o.createRun({ goal: "Add claim status lookup", autonomy: "supervised", actor: "user:test" });
    await t.until(() => t.ledger.listInbox({ runId: run.id }).some((i) => i.kind === "spec_failed"));

    const [first] = t.ledger.listAttempts({ runId: run.id, role: "spec" });
    assert.equal(first?.turns, 3);
    assert.equal(t.fake.conversations.get(first.conversationId)?.messages.length, 3);
    assert.deepEqual(t.ledger.listChecks({ runId: run.id }).map((c) => c.ok), [false, false, false]);
    const item = t.ledger.listInbox({ runId: run.id })[0]!;
    assert.match(item.body, /still fails after 3 tries/);
    assert.deepEqual(item.options.map((o) => o.id), ["retry", "cancel"]);

    // While it waits for a person nothing else happens.
    for (let i = 0; i < 2; i++) {
      await t.o.tick();
      await t.o.idle();
    }
    assert.equal(t.ledger.listChecks({ runId: run.id }).length, 3);
    assert.equal(t.ledger.getRun(run.id)?.state, "spec");

    await t.o.decide(item.id, { choice: "retry" }, "user:test");
    const specs = t.ledger.listAttempts({ runId: run.id, role: "spec" });
    assert.equal(specs.length, 2);
    assert.equal(t.ledger.getRun(run.id)?.specConversation, specs[1]?.conversationId);
    assert.ok(t.fake.conversations.has(specs[1]!.conversationId));
  } finally {
    await t.close();
  }
});

test("spec stage: a critic's revise goes back to the spec conversation, its edits are thrown away; suggest asks for the spec, then the plan", async () => {
  let critiques = 0;
  const t = await setup(
    byRole({
      spec: (conv) => {
        writeValid(conv, conv.messages.length > 1 ? "\n## Assumptions\n\n- Unknown claims answer 404\n" : "");
        return { response: "Done." };
      },
      critic: (conv) => {
        critiques++;
        if (critiques > 1) return { response: PASS };
        writeFileSync(path.join(conv.workingDir, "critic-was-here.md"), "oops\n");
        return {
          response: verdict({
            verdict: "revise",
            findings: [{ severity: "high", where: "specs/claim-status/spec.md", issue: "The unknown-claim scenario has no status code", suggestion: "Say 404" }],
          }),
        };
      },
    }),
  );
  try {
    const run = await t.o.createRun({ goal: "Add claim status lookup", autonomy: "suggest", actor: "user:test" });
    await t.until(() => t.ledger.getRun(run.id)?.state === "awaiting_spec_approval");

    const [spec] = t.ledger.listAttempts({ runId: run.id, role: "spec" });
    const conv = t.fake.conversations.get(spec!.conversationId);
    assert.equal(conv?.messages.length, 2);
    assert.match(conv.messages[1] ?? "", /\(high\) specs\/claim-status\/spec.md: The unknown-claim scenario has no status code Suggestion: Say 404/);
    const critics = t.ledger.listAttempts({ runId: run.id, role: "critic" });
    assert.deepEqual(critics.map((c) => (c.result as { verdict: string }).verdict), ["revise", "pass"]);
    assert.deepEqual(
      t.ledger.listChecks({ runId: run.id }).map((c) => [c.name, c.ok]),
      [["openspec-validate", true], ["critic-edits-discarded", false], ["openspec-validate", true]],
    );
    assert.equal(existsSync(path.join(run.integrationDir!, "critic-was-here.md")), false);
    const log = (await git(t.workspace, ["log", "-2", "--format=%s", run.integrationBranch])).stdout.trim().split("\n");
    assert.deepEqual(log, [`spec(${run.change}): Add claim status lookup`, `spec(${run.change}): Add claim status lookup`]);

    const specItem = t.ledger.listInbox({ runId: run.id })[0]!;
    assert.equal(specItem.kind, "spec_approval");
    assert.match(specItem.body, /Unknown claims answer 404/);
    await t.o.decide(specItem.id, { choice: "approve" }, "user:test");
    assert.equal(t.ledger.getRun(run.id)?.state, "awaiting_plan_approval");
    const planItem = t.ledger.listInbox({ runId: run.id })[0]!;
    assert.equal(planItem.kind, "plan_approval");

    // Asking for changes needs a note, which goes to the spec agent.
    await assert.rejects(t.o.decide(planItem.id, { choice: "revise", note: " " }, "user:test"), /needs a note/);
    await t.o.decide(planItem.id, { choice: "revise", note: "Also cover claims that were withdrawn." }, "user:test");
    assert.equal(t.ledger.getRun(run.id)?.state, "spec");
    assert.match(conv.messages[2] ?? "", /Also cover claims that were withdrawn\./);
  } finally {
    await t.close();
  }
});

test("spec stage: open questions in autonomous mode go to the inbox, and the answer goes to the spec agent", async () => {
  const t = await setup(
    byRole({
      spec: (conv) => {
        writeValid(conv, conv.messages.length === 1 ? "\n## Open questions\n\n- Should staff see full claim numbers?\n" : "");
        return { response: "Done." };
      },
      critic: () => ({ response: PASS }),
    }),
  );
  try {
    const run = await t.o.createRun({ goal: "Add claim status lookup", autonomy: "autonomous", actor: "user:test" });
    await t.until(() => t.ledger.getRun(run.id)?.state === "awaiting_answers");
    const item = t.ledger.listInbox({ runId: run.id })[0]!;
    assert.equal(item.kind, "questions");
    assert.match(item.body, /Should staff see full claim numbers\?/);
    assert.deepEqual(item.options.map((o) => o.id), ["answer", "proceed", "cancel"]);

    await assert.rejects(t.o.decide(item.id, { choice: "answer" }, "user:test"), /needs a note/);
    await assert.rejects(t.o.decide(item.id, { choice: "approve" }, "user:test"), /Choose one of: answer, proceed, cancel/);
    await t.o.decide(item.id, { choice: "answer", note: "No: mask all but the last four digits." }, "user:test");
    const [spec] = t.ledger.listAttempts({ runId: run.id, role: "spec" });
    assert.match(t.fake.conversations.get(spec!.conversationId)?.messages[1] ?? "", /mask all but the last four digits/);

    await t.until(() => t.ledger.getRun(run.id)?.state === "building");
    assert.equal(t.ledger.listAttempts({ runId: run.id, role: "critic" }).length, 2); // every committed spec is critiqued
  } finally {
    await t.close();
  }
});

test("a step that fails pauses the run with an error item; retry picks up from there", async () => {
  let critiques = 0;
  const t = await setup(
    byRole({
      spec: (conv) => {
        writeValid(conv);
        return { response: "Done." };
      },
      critic: () => {
        if (++critiques === 1) throw new Error("The model provider is overloaded");
        // The critic that crashed didn't use up a round: this revise still goes to the spec agent.
        if (critiques === 2) return { response: verdict({ verdict: "revise", findings: [{ severity: "high", issue: "No error case for unknown claims" }] }) };
        return { response: PASS };
      },
    }),
  );
  try {
    const run = await t.o.createRun({ goal: "Add claim status lookup", autonomy: "supervised", actor: "user:test" });
    await t.until(() => t.ledger.getRun(run.id)?.state === "paused");
    const paused = t.ledger.getRun(run.id);
    assert.equal(paused?.resumeState, "critic");
    assert.match(paused.pausedReason ?? "", /overloaded/);
    const item = t.ledger.listInbox({ runId: run.id })[0]!;
    assert.equal(item.kind, "error");
    assert.deepEqual(item.options.map((o) => o.id), ["retry", "cancel"]);

    await t.o.decide(item.id, { choice: "retry" }, "user:test");
    assert.equal(t.ledger.getRun(run.id)?.state, "critic");
    await t.until(() => t.ledger.getRun(run.id)?.state === "awaiting_plan_approval");
    assert.deepEqual(t.ledger.listAttempts({ runId: run.id, role: "critic" }).map((c) => c.state), ["error", "finished", "finished"]);
    const [spec] = t.ledger.listAttempts({ runId: run.id, role: "spec" });
    assert.match(t.fake.conversations.get(spec!.conversationId)?.messages[1] ?? "", /No error case for unknown claims/);
  } finally {
    await t.close();
  }
});

test("pause and cancel reach the live conversation; resume restarts it and the run carries on", async () => {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  const t = await setup(
    byRole({
      spec: async (conv) => {
        await released;
        writeValid(conv);
        return { response: "Done." };
      },
      critic: () => ({ response: PASS }),
    }),
  );
  try {
    const run = await t.o.createRun({ goal: "Add claim status lookup", autonomy: "supervised", actor: "user:test" });
    await t.o.tick();
    await t.o.idle();
    const [a] = t.ledger.listAttempts({ runId: run.id });
    const conv = t.fake.conversations.get(a!.conversationId)!;

    await t.o.pause(run.id, { actor: "user:test" });
    assert.equal(t.ledger.getAttempt(a!.id)?.state, "paused");
    assert.equal(conv.status, "paused");
    await t.o.resume(run.id, { actor: "user:test" });
    assert.equal(t.ledger.getAttempt(a!.id)?.state, "running");
    assert.notEqual(conv.status, "paused");

    release();
    await t.until(() => t.ledger.getRun(run.id)?.state === "awaiting_plan_approval");
    // A spec agent still revising when the run is cancelled is paused on the agent server.
    t.fake.setHandler(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    await t.o.decide(t.ledger.listInbox({ runId: run.id })[0]!.id, { choice: "revise", note: "Cover withdrawn claims." }, "user:test");
    await t.o.cancel(run.id, { actor: "user:test" });
    assert.equal(conv.status, "paused");
    assert.deepEqual(t.ledger.listAttempts({ runId: run.id }).map((x) => x.state), ["cancelled", "finished"]);
  } finally {
    release();
    await t.close();
  }
});

test("restart: an attempt left 'starting' starts with the same id, and a new orchestrator keeps polling the same conversation", async () => {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  const fake = await startFakeOpenHands({
    profiles: [CLAUDE, CODEX],
    onMessage: byRole({
      spec: async (conv) => {
        await released;
        writeValid(conv);
        return { response: "Done." };
      },
      critic: () => ({ response: PASS }),
    }),
  });
  const workspace = newWorkspace();
  const dataDir = mkdtempSync(path.join(dataRoot, "restart-"));
  const db = path.join(dataDir, "autopilot.db");
  /** The agent server times out on start, as if it were slow to create the conversation. */
  class TimesOut extends OpenHandsClient {
    override async start(): Promise<never> {
      throw new OpenHandsError(0, "timed out");
    }
  }
  const factory = (client: InstanceType<typeof OpenHandsClient>) => {
    const ledger = openLedger(db);
    return { ledger, o: createOrchestrator({ ledger, client, workspace, dataDir, graceMs: 0 }) };
  };
  try {
    // First factory: the attempt is recorded, but the start never got through.
    let f = factory(new TimesOut({ baseUrl: fake.url }));
    const run = await f.o.createRun({ goal: "Add claim status lookup", autonomy: "supervised", actor: "user:test" });
    await f.o.tick();
    await f.o.idle();
    const attempt = f.ledger.listAttempts({ runId: run.id })[0]!;
    assert.equal(attempt.state, "starting");
    assert.equal(fake.conversations.size, 0);
    f.ledger.close();

    // Second factory: starts it with the id it recorded.
    f = factory(new OpenHandsClient({ baseUrl: fake.url }));
    await f.o.tick();
    await f.o.idle();
    assert.equal(f.ledger.getAttempt(attempt.id)?.state, "running");
    assert.deepEqual([...fake.conversations.keys()], [attempt.conversationId]);
    f.ledger.close();

    // Third factory: the agent finished while nobody watched; polling picks the same conversation up.
    f = factory(new OpenHandsClient({ baseUrl: fake.url }));
    release();
    await fake.settled();
    for (let i = 0; i < 20 && f.ledger.getRun(run.id)?.state !== "awaiting_plan_approval"; i++) {
      await f.o.tick();
      await f.o.idle();
      await fake.settled();
    }
    assert.equal(f.ledger.getRun(run.id)?.state, "awaiting_plan_approval");
    assert.equal(f.ledger.getAttempt(attempt.id)?.state, "finished");
    assert.equal(f.ledger.listAttempts({ runId: run.id, role: "spec" }).length, 1);
    assert.equal(fake.conversations.size, 2); // the spec agent and the critic, nothing started twice
    f.ledger.close();
  } finally {
    release();
    await fake.close();
  }
});
