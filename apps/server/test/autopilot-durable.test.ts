import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { ConversationSnapshot, StartInput } from "../src/autopilot/openhands.js";

const dataRoot = mkdtempSync(path.join(tmpdir(), "sf-durable-"));
process.env.SF_DATA_DIR = path.join(dataRoot, "audit");
process.env.SF_WORKSPACE = dataRoot;
delete process.env.SF_REQUIRE_ISOLATION;
const { createOrchestrator } = await import("../src/autopilot/orchestrator.js");
const { openLedger, StaleWorker } = await import("../src/autopilot/ledger.js");
const { OpenHandsClient, OpenHandsError } = await import("../src/autopilot/openhands.js");
const { DEFAULT_POLICY, policyHash } = await import("../src/autopilot/policy.js");
const { createAutopilotRoutes } = await import("../src/autopilot/routes.js");

/** The agent server, in memory: conversations keep their messages and event ids; sends can be refused, lost or rejected. */
class Agents extends OpenHandsClient {
  conversations = new Map<string, { status: ConversationSnapshot["status"]; cost: number; messages: string[]; events: string[] }>();
  sendFault: "refused" | "lost" | "gone" | null = null;
  searchable = true;
  starts: StartInput[] = [];
  pauses: string[] = [];
  constructor() {
    super({ baseUrl: "http://127.0.0.1:1" });
  }
  override async resolveProfile() {
    return { id: "p", name: "p", kind: "acp", server: "claude-code" };
  }
  override async get(id: string) {
    const c = this.conversations.get(id);
    return c ? { id, status: c.status, costUsd: c.cost, workingDir: null } : null;
  }
  override async start(input: StartInput) {
    this.starts.push(input);
    this.conversations.set(input.conversationId, { status: "running", cost: 0, messages: [input.text], events: ["e1"] });
    return (await this.get(input.conversationId))!;
  }
  override async send(id: string, text: string) {
    if (this.sendFault === "refused") throw new OpenHandsError(0, "Agent server unreachable", "not_sent");
    if (this.sendFault === "gone") throw new OpenHandsError(404, "Conversation not found");
    const c = this.conversations.get(id)!;
    c.messages.push(text);
    c.status = "running";
    c.events.push(`e${c.events.length + 1}`);
    if (this.sendFault === "lost") throw new OpenHandsError(0, "did not answer within 30000 ms", "unknown");
  }
  override async findUserMessage(id: string, marker: string) {
    if (!this.searchable) throw new OpenHandsError(404, "Not Found");
    return !!this.conversations.get(id)?.messages.some((m) => m.includes(marker));
  }
  override async latestEvent(id: string) {
    return this.conversations.get(id)?.events.at(-1) ?? null;
  }
  override async pause(id: string) {
    this.pauses.push(id);
    const c = this.conversations.get(id);
    if (c) c.status = "paused";
  }
  override async resume(id: string) {
    const c = this.conversations.get(id);
    if (c) c.status = "running";
  }
  override async finalResponse() {
    return "Done.";
  }
}

const QUESTIONS = [
  { id: "answer", label: "Send answers", needsNote: true },
  { id: "proceed", label: "Proceed" },
  { id: "cancel", label: "Cancel run" },
];
const ANSWER = "Look claims up by claim number.";

/** A run waiting for answers, its spec conversation finished: answering queues a follow-up to it. */
function setup(extra: Partial<Parameters<typeof createOrchestrator>[0]> = {}) {
  const dir = mkdtempSync(path.join(dataRoot, "case-"));
  const db = path.join(dir, "ledger.db");
  let ledger = openLedger(db);
  const client = new Agents();
  const policy = structuredClone(DEFAULT_POLICY);
  const run = ledger.createRun({ goal: "Durable", change: "durable", autonomy: "autonomous", baseBranch: "main", integrationBranch: "main", integrationDir: dir, policy, policyHash: policyHash(policy), createdBy: "user:test", state: "awaiting_answers" });
  const spec = ledger.addAttempt({ runId: run.id, role: "spec", conversationId: "spec-1", agentProfile: "p", state: "finished" });
  client.conversations.set("spec-1", { status: "finished", cost: 0, messages: ["The brief"], events: ["e1"] });
  const item = ledger.openInbox({ runId: run.id, kind: "questions", title: "Questions", body: "Which key?", options: QUESTIONS });
  const make = () => createOrchestrator({ ledger, client, workspace: dir, dataDir: dir, graceMs: 0, commandRetryMs: 0, reconcileMs: 0, ...extra });
  let o = make();
  return {
    dir,
    db,
    client,
    run,
    spec,
    item,
    get ledger() {
      return ledger;
    },
    get o() {
      return o;
    },
    /** The process dies: no stop, no lease released. A new one starts on the same ledger. */
    crash() {
      ledger.close();
      ledger = openLedger(db);
      o = make();
    },
    async tick(n = 1) {
      for (let i = 0; i < n; i++) {
        await o.tick();
        await o.idle();
      }
    },
    messages: () => client.conversations.get("spec-1")!.messages,
    commands: () => ledger.listCommands({ runId: run.id }),
    answer: () => o.decide(item.id, { choice: "answer", note: ANSWER }, "user:test"),
    async close() {
      o.stop();
      await o.idle();
      ledger.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("a message written before a crash is delivered once after it: the decision, the run's move and the message commit together", async () => {
  const t = setup();
  try {
    t.client.sendFault = "refused";
    await t.answer();
    assert.equal(t.ledger.getRun(t.run.id)?.state, "spec");
    assert.equal(t.ledger.getInbox(t.item.id)?.state, "decided");
    assert.equal(t.ledger.getAttempt(t.spec.id)?.turns, 2, "the next turn is recorded with the message");
    assert.deepEqual(t.commands().map((c) => `${c.state}:${c.tries}`), ["pending:1"]);
    assert.equal(t.messages().length, 1, "nothing reached the agent");

    t.crash();
    t.client.sendFault = null;
    await t.tick(3);
    assert.deepEqual(t.commands().map((c) => c.state), ["delivered"]);
    assert.equal(t.messages().length, 2, "delivered exactly once");
    assert.match(t.messages()[1]!, new RegExp(`${ANSWER}[\\s\\S]*\\(sf-msg-${t.commands()[0]!.id}\\)$`));
  } finally {
    await t.close();
  }
});

test("a send whose answer was lost, or that a crash cut off, is found by its marker and not sent again", async () => {
  const t = setup();
  try {
    t.client.sendFault = "lost";
    await t.answer();
    assert.deepEqual(t.commands().map((c) => c.state), ["ambiguous"]);
    t.client.sendFault = null;
    await t.tick();
    assert.deepEqual(t.commands().map((c) => c.state), ["delivered"]);
    assert.equal(t.messages().length, 2);

    // The process stopped after handing the message over, before recording the answer.
    t.ledger.updateCommand(t.commands()[0]!.id, { state: "sending" });
    t.crash();
    await t.tick(2);
    assert.deepEqual(t.commands().map((c) => c.state), ["delivered"]);
    assert.equal(t.messages().length, 2, "found by its marker: no second copy");
  } finally {
    await t.close();
  }
});

test("when the agent server can't be searched, a person settles an unconfirmed message: send it again, or confirm it arrived", async () => {
  for (const choice of ["resend", "delivered"] as const) {
    const t = setup();
    try {
      t.client.sendFault = "lost";
      t.client.searchable = false;
      await t.answer();
      await t.tick();
      assert.deepEqual(t.commands().map((c) => c.state), ["quarantined"]);
      const item = t.ledger.listInbox({ runId: t.run.id }).find((i) => i.kind === "undelivered")!;
      assert.deepEqual(item.options.map((o) => o.id), ["resend", "delivered", "cancel"]);
      assert.equal(item.ref, `command:${t.commands()[0]!.id}`);
      t.client.sendFault = null;
      await t.o.decide(item.id, { choice }, "user:test");
      await t.tick();
      assert.deepEqual(t.commands().map((c) => c.state), ["delivered"]);
      // The lost send had arrived: resending shows it twice, as the person chose; confirming sends nothing more.
      assert.equal(t.messages().length, choice === "resend" ? 3 : 2);
    } finally {
      await t.close();
    }
  }
});

test("refused sends back off and go to a person after ten tries; a conversation that's gone offers a new spec agent with the message", async () => {
  const t = setup();
  try {
    t.client.sendFault = "refused";
    await t.answer();
    await t.tick(12);
    const [cmd] = t.commands();
    assert.equal(cmd?.state, "failed");
    assert.equal(cmd?.tries, 10);
    const item = t.ledger.listInbox({ runId: t.run.id }).find((i) => i.kind === "undelivered")!;
    assert.deepEqual(item.options.map((o) => o.id), ["resend", "cancel"]);
  } finally {
    await t.close();
  }

  const gone = setup();
  try {
    gone.client.sendFault = "gone";
    await gone.answer();
    const item = gone.ledger.listInbox({ runId: gone.run.id }).find((i) => i.kind === "undelivered")!;
    assert.deepEqual(item.options.map((o) => o.id), ["restart", "resend", "cancel"]);
    await gone.o.decide(item.id, { choice: "restart" }, "user:test");
    const restarted = gone.client.starts.at(-1)!;
    assert.notEqual(restarted.conversationId, "spec-1");
    assert.match(restarted.text, new RegExp(ANSWER), "the new spec agent is told what the lost message said");
    assert.deepEqual(gone.commands().map((c) => c.state), ["cancelled"]);
  } finally {
    await gone.close();
  }
});

test("one process acts on a ledger at a time: the other stands by, takes over when the first dies, and the first's writes are refused", async () => {
  const t = setup();
  const alive = new Set([111, 222]);
  const second = openLedger(t.db);
  try {
    const a = createOrchestrator({ ledger: t.ledger, client: t.client, workspace: t.dir, dataDir: t.dir, graceMs: 0, owner: `${hostname()}:111:a`, pidAlive: (pid) => alive.has(pid) });
    const b = createOrchestrator({ ledger: second, client: t.client, workspace: t.dir, dataDir: t.dir, graceMs: 0, owner: `${hostname()}:222:b`, pidAlive: (pid) => alive.has(pid) });
    await a.tick();
    await b.tick();
    await assert.rejects(b.pause(t.run.id, { actor: "user:test" }), /Another factory process is running Autopilot/);
    assert.deepEqual((await b.status()).scheduler, { active: false, heldBy: `${hostname()}:111:a` });

    alive.delete(111); // the first process died without letting go
    await b.tick();
    assert.equal(second.getLease("scheduler")?.owner, `${hostname()}:222:b`);
    assert.equal(second.getLease("scheduler")?.generation, 2);
    assert.throws(() => t.ledger.updateRun(t.run.id, { pausedReason: "late write" }), StaleWorker);
    alive.add(111); // say it comes back: it doesn't take over from a live owner
    await a.tick();
    assert.equal(second.getLease("scheduler")?.owner, `${hostname()}:222:b`);
    await a.idle();
    await b.idle();
    a.stop();
    b.stop();
  } finally {
    second.close();
    await t.close().catch(() => undefined);
  }
});

test("a conversation whose start answer was lost isn't created again; the watchdog stops an agent with no new events and spares one that has them", async () => {
  const t = setup({ owner: undefined });
  try {
    // Created on the agent server, but the factory never heard back.
    t.ledger.updateRun(t.run.id, { state: "critic" });
    const critic = t.ledger.addAttempt({ runId: t.run.id, role: "critic", conversationId: "critic-1", agentProfile: "p", state: "starting" });
    t.client.conversations.set("critic-1", { status: "running", cost: 0, messages: ["The critic brief"], events: ["c1"] });
    await t.tick();
    assert.equal(t.client.starts.length, 0, "found by its id: not created a second time");
    assert.equal(t.ledger.getAttempt(critic.id)?.state, "running");

    const policy = structuredClone(DEFAULT_POLICY);
    policy.watchdog.idleMinutes = 1;
    t.ledger.updateRun(t.run.id, { policy });
    const longAgo = new Date(Date.now() - 5 * 60_000).toISOString();
    t.ledger.updateAttempt(critic.id, { progressAt: longAgo, lastEvent: "c1" });
    await t.tick();
    assert.equal(t.ledger.getAttempt(critic.id)?.state, "error");
    // The stopped critic goes the way of any failed critic: the run waits for a person, saying why.
    assert.match(t.ledger.getRun(t.run.id)?.pausedReason ?? "", /watchdog stopped it/);
    assert.deepEqual(t.client.pauses, ["critic-1"]);

    // Another one, quiet in cost but still producing events.
    t.ledger.updateRun(t.run.id, { state: "critic", resumeState: null, pausedReason: null });
    const busy = t.ledger.addAttempt({ runId: t.run.id, role: "critic", conversationId: "critic-2", agentProfile: "p", state: "running", progressAt: longAgo, lastEvent: "d1" });
    t.client.conversations.set("critic-2", { status: "running", cost: 0, messages: ["brief"], events: ["d1", "d2"] });
    await t.tick();
    assert.equal(t.ledger.getAttempt(busy.id)?.state, "running");
    assert.equal(t.ledger.getAttempt(busy.id)?.lastEvent, "d2");
  } finally {
    await t.close();
  }
});

test("a repeated Idempotency-Key gets the first answer: one run, one decision", async () => {
  const workspace = mkdtempSync(path.join(dataRoot, "ws-"));
  writeFileSync(path.join(workspace, "README.md"), "# Demo\n");
  const dataDir = mkdtempSync(path.join(dataRoot, "keys-"));
  const ledger = openLedger(path.join(dataDir, "autopilot.db"));
  const o = createOrchestrator({ ledger, client: new Agents(), workspace, dataDir, graceMs: 0 });
  const app = createAutopilotRoutes(o);
  const call = async (pathname: string, body: unknown, key?: string) => {
    const res = await app.request(pathname, { method: "POST", headers: { "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) }, body: JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };
  try {
    const [first, again] = await Promise.all([call("/runs", { goal: "Add a status page" }, "run-key-0001"), call("/runs", { goal: "Add a status page" }, "run-key-0001")]);
    assert.equal(first.status, 200, JSON.stringify(first.json));
    assert.equal(again.json.id, first.json.id);
    const later = await call("/runs", { goal: "Add a status page" }, "run-key-0001");
    assert.equal(later.json.id, first.json.id, "remembered after the first finished");
    assert.equal(ledger.listRuns().length, 1);
    assert.equal((await call("/runs/" + String(first.json.id) + "/pause", {}, "run-key-0001")).status, 400, "a key belongs to one request");

    const item = ledger.openInbox({ runId: String(first.json.id), kind: "questions", title: "Q", body: "B", options: QUESTIONS });
    ledger.updateRun(String(first.json.id), { state: "awaiting_answers" });
    const decided = await call(`/inbox/${item.id}/decide`, { choice: "cancel" }, "decide-key-01");
    const repeated = await call(`/inbox/${item.id}/decide`, { choice: "cancel" }, "decide-key-01");
    assert.equal(decided.status, 200);
    assert.equal(repeated.status, 200);
    assert.deepEqual(repeated.json, decided.json);
    assert.equal((await call(`/inbox/${item.id}/decide`, { choice: "cancel" })).status, 400, "without a key, deciding twice is refused as before");
  } finally {
    o.stop();
    await o.idle();
    ledger.close();
  }
});
