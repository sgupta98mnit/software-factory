// Regression tests for the review of Phase 5 (`pnpm demo`, the setup
// checklist, the Policy page and the reasons on automated decisions, the
// Metrics page). Each one failed before its fix; OPEN-ISSUES.md lists them.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { FakeConversation, FakeHandler } from "./fake-openhands.js";

const dataRoot = mkdtempSync(path.join(tmpdir(), "sf-review-p5-data-"));
process.env.SF_DATA_DIR = dataRoot;
process.env.SF_WORKSPACE = mkdtempSync(path.join(tmpdir(), "sf-review-p5-unused-"));
process.env.SF_USER = "po";
delete process.env.SF_AUTONOMY_CAP;
delete process.env.SF_NOTIFY_WEBHOOK;
const { startFakeOpenHands } = await import("../src/demo/fake-agent-server.js");
const { capabilityOf, scriptedAgents } = await import("../src/demo/scripted-agents.js");
const { createOrchestrator } = await import("../src/autopilot/orchestrator.js");
const { openLedger } = await import("../src/autopilot/ledger.js");
const { OpenHandsClient } = await import("../src/autopilot/openhands.js");
const { createAutopilotRoutes } = await import("../src/autopilot/routes.js");
const { commitAll, ensureRepo, fileAt, git } = await import("../src/autopilot/git.js");
const { loadPolicy, parsePolicy, policyHash } = await import("../src/autopilot/policy.js");
const { explainPolicy } = await import("../src/autopilot/explain.js");
const { templateById } = await import("../src/autopilot/policy-templates.js");
const { computeMetrics } = await import("../src/autopilot/metrics.js");
const { freePort } = await import("../src/autopilot/preview.js");
const { audit, listAudit } = await import("../src/audit.js");
import type { AuditEvent } from "../src/audit.js";

const script = path.resolve(import.meta.dirname, "../../../scripts/demo.mjs");
const { prepareDemo } = (await import(script)) as { prepareDemo: (dir: string, opts?: { reset?: boolean }) => { workspace: string; data: string } };

const write = (file: string, text: string) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};

/** A workspace (a repo with one commit, a fresh `git init`, or none) and an orchestrator on it, with the fake agent server. */
async function make(opts: { repo?: "committed" | "empty" | "none"; policy?: string; files?: Record<string, string>; handler?: FakeHandler } = {}) {
  const workspace = mkdtempSync(path.join(tmpdir(), "sf-review-p5-ws-"));
  writeFileSync(path.join(workspace, "README.md"), "# Demo\n");
  for (const [file, text] of Object.entries(opts.files ?? {})) write(path.join(workspace, file), text);
  if (opts.policy) write(path.join(workspace, ".factory", "policy.yml"), opts.policy);
  const repo = opts.repo ?? "committed";
  if (repo === "committed") await ensureRepo(workspace);
  if (repo === "empty") await git(workspace, ["init", "-q", "-b", "main"]);
  const fake = await startFakeOpenHands({ onMessage: opts.handler });
  const ledger = openLedger(":memory:");
  const o = createOrchestrator({ ledger, client: new OpenHandsClient({ baseUrl: fake.url }), workspace, dataDir: mkdtempSync(path.join(dataRoot, "case-")), graceMs: 0 });
  const app = createAutopilotRoutes(o);
  const call = async (method: string, url: string, body?: unknown) => {
    const res = await app.request(url, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }) });
    return { status: res.status, json: (await res.json()) as any };
  };
  return {
    workspace,
    fake,
    ledger,
    o,
    app,
    call,
    async close() {
      o.stop();
      await o.idle();
      await fake.close();
      ledger.close();
    },
  };
}

const auditOf = async (action: string) => {
  await audit("test", "test.flush", "test");
  return listAudit(5000).filter((e) => e.action === action).reverse();
};

// ---- pnpm demo ----

test("demo: --reset never deletes a folder that holds more than the demo makes, and an empty SF_DEMO_DIR isn't the folder pnpm runs in", () => {
  const mine = mkdtempSync(path.join(tmpdir(), "sf-review-p5-mine-"));
  writeFileSync(path.join(mine, "thesis.docx"), "years of work\n");
  assert.throws(() => prepareDemo(mine, { reset: true }), /has more in it than the demo makes \(thesis\.docx\), so --reset leaves it alone/);
  assert.equal(readFileSync(path.join(mine, "thesis.docx"), "utf8"), "years of work\n");
  // Without --reset: a `workspace` folder that's already there (and not the demo's repo) doesn't get the demo's files.
  const theirs = mkdtempSync(path.join(tmpdir(), "sf-review-p5-theirs-"));
  write(path.join(theirs, "workspace", "README.md"), "# Our real project\n");
  assert.throws(() => prepareDemo(theirs), /already has files and isn't the demo's repo/);
  assert.deepEqual([readFileSync(path.join(theirs, "workspace", "README.md"), "utf8"), existsSync(path.join(theirs, "workspace", ".git"))], ["# Our real project\n", false]);

  // A folder the demo made still starts over.
  const demo = mkdtempSync(path.join(tmpdir(), "sf-review-p5-demo-"));
  const { workspace } = prepareDemo(demo);
  writeFileSync(path.join(workspace, "mine.txt"), "x\n");
  prepareDemo(demo, { reset: true });
  assert.equal(existsSync(path.join(workspace, "mine.txt")), false);
  assert.ok(existsSync(path.join(workspace, ".git")));

  // `SF_DEMO_DIR= pnpm demo --reset` (set, but empty): a copy of the script, so its default folder is a temp one.
  // Its servers can't start there (no apps/server), so it stops right after preparing.
  const root = mkdtempSync(path.join(tmpdir(), "sf-review-p5-root-"));
  mkdirSync(path.join(root, "scripts"));
  copyFileSync(script, path.join(root, "scripts", "demo.mjs"));
  const cwd = path.join(root, "where-pnpm-runs");
  mkdirSync(cwd);
  writeFileSync(path.join(cwd, "keep.txt"), "the repo\n");
  const r = spawnSync(process.execPath, [path.join(root, "scripts", "demo.mjs"), "--reset", "--no-canvas"], {
    cwd,
    env: { ...process.env, SF_DEMO_DIR: "", SF_DEMO_API_PORT: "1", SF_DEMO_AGENTS_PORT: "1", NODE_TEST_CONTEXT: "" },
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.ok(existsSync(path.join(cwd, "keep.txt")), `the folder it ran in was wiped:\n${r.stdout}\n${r.stderr}`);
  assert.ok(existsSync(path.join(root, "data", "demo", "workspace", ".git")), "an empty SF_DEMO_DIR means the default folder");
});

test("demo: a team webhook in the shell doesn't reach the demo's API (scripted runs never post to a real channel)", { skip: process.platform === "win32", timeout: 90_000 }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sf-review-p5-hook-"));
  const [apiPort, agentsPort] = [await freePort(), await freePort()];
  const child = spawn(process.execPath, [script, "--no-canvas"], {
    env: { ...process.env, SF_DEMO_DIR: dir, SF_DEMO_API_PORT: String(apiPort), SF_DEMO_AGENTS_PORT: String(agentsPort), SF_FAKE_AGENT_TURN_MS: "0", SF_NOTIFY_WEBHOOK: "http://127.0.0.1:9/team-channel", NODE_TEST_CONTEXT: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));
  try {
    let status: { agentServer: { reachable: boolean }; notifications: { channel: string | null } } | null = null;
    for (let i = 0; i < 120 && !status?.agentServer.reachable; i++) {
      status = await fetch(`http://127.0.0.1:${apiPort}/sf-api/autopilot/status`).then((r) => (r.ok ? (r.json() as never) : null), () => null);
      if (!status?.agentServer.reachable) await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert.ok(status?.agentServer.reachable, `the demo didn't come up:\n${output}`);
    assert.equal(status.notifications.channel, null);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
  }
});

// ---- the Policy page and the setup checklist ----

test("on a detached HEAD, the Policy page, Home's status and the checklist show the policy runs pin (main's), not the defaults", async () => {
  const yaml = "autonomy: { default: suggest, max: suggest }\nrelease: { auto: false }\n";
  const t = await make({ policy: yaml });
  try {
    await git(t.workspace, ["checkout", "-q", "--detach"]);
    const view = (await t.call("GET", "/policy")).json;
    assert.deepEqual([view.source, view.hash, view.yaml], [".factory/policy.yml@main", policyHash(parsePolicy(yaml)), yaml]);
    assert.ok(view.explanation.includes("Every merge waits for a person."));
    const status = (await t.call("GET", "/status")).json;
    assert.deepEqual([status.workspace.branch, status.policy.source, status.policy.autonomy], [null, ".factory/policy.yml@main", { default: "suggest", max: "suggest" }]);
    const setup = (await t.call("GET", "/setup")).json as { id: string; ok: boolean }[];
    assert.deepEqual(setup.filter((i) => i.id === "policy" || i.id === "agents-md").map((i) => [i.id, i.ok]), [["policy", true], ["agents-md", false]]);
    // What a run started now pins: the same.
    const run = await t.o.createRun({ goal: "Let applicants check a claim's status", actor: "user:po" });
    assert.deepEqual([run.autonomy, run.policyHash], ["suggest", view.hash]);
  } finally {
    await t.close();
  }
});

test("explainPolicy says what runs really get: a default above autonomy.max, SF_AUTONOMY_CAP, release.auto with no autonomous run, no blocking severities", async () => {
  const lines = explainPolicy(parsePolicy("autonomy: { default: autonomous, max: supervised }\nrelease: { auto: true }\nintake: { autonomy: autonomous }\n"));
  assert.equal(lines[0], "Runs start supervised (a person approves the plan; merges follow the rules below). Nobody can choose more. The file's autonomy.default is autonomous, but its autonomy.max is supervised.");
  assert.ok(lines.includes("The policy has release.auto on, but no run here can be autonomous, so a person releases every run into the base branch."));
  assert.match(lines.join("\n"), /runs from outside are at most supervised\./);
  const review = explainPolicy(parsePolicy("review: { blocking: [] }\n"))[2];
  assert.equal(review, "Only the reviewer's verdict blocks: no finding stops a work order by its severity alone.");

  // The org-wide cap, on the Policy page and in a check.
  const t = await make();
  process.env.SF_AUTONOMY_CAP = "suggest";
  try {
    const view = (await t.call("GET", "/policy")).json;
    assert.equal(view.explanation[0], "Runs start suggest (a person approves the spec, the plan and every merge). Nobody can choose more. This factory's SF_AUTONOMY_CAP is suggest, below the file's autonomy.max of autonomous.");
    assert.ok(view.explanation.includes("Every merge waits for a person."));
    const hands = view.templates.find((x: { id: string }) => x.id === "autonomous");
    assert.match(hands.explanation[0], /^Runs start suggest /);
    const check = (await t.call("POST", "/policy/check", { yaml: "release: { auto: true }\n" })).json;
    assert.ok(check.explanation.includes("The policy has release.auto on, but no run here can be autonomous, so a person releases every run into the base branch."));
  } finally {
    delete process.env.SF_AUTONOMY_CAP;
    await t.close();
  }
});

test("each template does what its summary says: cautious keeps every merge for a person (outside requests too); federal doesn't claim the preview it leaves off", () => {
  const cautious = templateById("cautious")!;
  assert.match(cautious.summary, /every merge/);
  const lines = explainPolicy(parsePolicy(cautious.yaml));
  assert.ok(lines.includes("Every merge waits for a person."), lines.join("\n"));
  assert.match(lines.join("\n"), /runs from outside are at most suggest\./);

  const federal = templateById("federal")!;
  assert.equal(parsePolicy(federal.yaml).preview.enabled, false);
  assert.doesNotMatch(`${federal.summary}\n${federal.yaml}`, /a preview before release|preview (is|are) on/);
  assert.match(templateById("recommended")!.summary, /^Runs start supervised/);
});

test("a .factory/policy.yml that is a link is replaced by the file the person committed, never written through to the link's target", async () => {
  const t = await make({ files: { "src/config.yml": "port: 8080\n" } });
  try {
    mkdirSync(path.join(t.workspace, ".factory"));
    symlinkSync("../src/config.yml", path.join(t.workspace, ".factory", "policy.yml"));
    await commitAll(t.workspace, "The policy as a link");
    const cautious = templateById("cautious")!;
    const res = await t.call("POST", "/policy", { template: "cautious" });
    assert.equal(res.status, 200, res.json.error);
    assert.equal(await fileAt(t.workspace, "refs/heads/main", "src/config.yml"), "port: 8080\n", "the link's target is untouched");
    assert.match((await git(t.workspace, ["ls-tree", "refs/heads/main", ".factory/policy.yml"])).stdout, /^100644 blob /);
    const loaded = await loadPolicy(t.workspace, "main");
    assert.equal(loaded.hash, policyHash(parsePolicy(cautious.yaml)));
    assert.equal(res.json.hash, loaded.hash);
    assert.equal((await auditOf("autopilot.policy_written")).at(-1)?.data.hash, loaded.hash, "the audit names the policy that's on main");
  } finally {
    await t.close();
  }
});

test("setup: a repo with no commit yet isn't ready; its fix makes the first commit, and the file fixes say why they wait", async () => {
  const t = await make({ repo: "empty" });
  const item = (list: { id: string }[], id: string) => list.find((i) => i.id === id) as { ok: boolean; title: string; fix: { id: string; label: string } | null };
  try {
    let list = (await t.call("GET", "/setup")).json;
    assert.deepEqual([item(list, "workspace").ok, item(list, "workspace").title, item(list, "workspace").fix], [false, "The workspace is a git repo with no commits yet", { id: "init-repo", label: "Make the first commit" }]);
    assert.deepEqual([item(list, "policy").fix, item(list, "agents-md").fix], [null, null]);
    for (const [url, body] of [["/setup/policy", {}], ["/setup/agents-md", {}], ["/policy", { template: "recommended" }]] as const) {
      const r = await t.call("POST", url, body);
      assert.deepEqual([r.status, r.json.error], [400, "The workspace's repo has no commits yet. Make the first commit, then try again."], url);
    }
    list = (await t.call("POST", "/setup/init-repo", {})).json;
    assert.equal(item(list, "workspace").ok, true);
    assert.equal(item(list, "policy").fix?.label, "Add the recommended policy to main");
    list = (await t.call("POST", "/setup/policy", {})).json;
    assert.equal(item(list, "policy").ok, true);
    assert.deepEqual((await auditOf("autopilot.workspace_initialized")).filter((e) => e.data.path === t.workspace).map((e) => e.actor), ["user:po"]);
  } finally {
    await t.close();
  }
});

// ---- reasons on automated decisions ----

test("a merged work order a re-plan reopens loses its merge reason until it merges again", async () => {
  const scripted = scriptedAgents({ noBugs: true });
  const tasksOf = (conv: FakeConversation) => {
    const change = /`(let-[^`]+?)`/.exec(conv.messages[0] ?? "")?.[1] ?? "";
    return path.join(conv.workingDir, "openspec", "changes", change, "tasks.md");
  };
  const t = await make({
    handler: async (conv, text) => {
      if (conv.tags.sfrole === "spec" && conv.messages[0]?.includes("<change-request>")) {
        const file = tasksOf(conv);
        writeFileSync(file, readFileSync(file, "utf8").replace("- [ ] 1.2 Test it with node:test", "- [ ] 1.2 Test it with node:test\n- [ ] 1.3 Return a receipt id with the result"));
        return { response: "Added the receipt id to the spec.", cost: 0.2 };
      }
      if (conv.tags.sfrole === "builder" && conv.tags.sfwo === "1" && conv.messages[0]?.includes("after it was merged")) {
        const cap = capabilityOf(/openspec\/changes\/([^/`]+)\//.exec(conv.messages[0] ?? "")?.[1] ?? "x");
        write(path.join(conv.workingDir, `src/${cap}/receipt-id.js`), "export const receiptId = (n) => `R-${n}`;\n");
        return { response: "Added the receipt id.", cost: 0.2 };
      }
      return scripted(conv, text);
    },
  });
  try {
    const run = await t.o.createRun({ goal: "Let applicants check a claim's status", autonomy: "supervised", actor: "user:po" });
    const wo1 = () => t.ledger.getWorkOrder(`${run.id}/WO-1`);
    const step = async () => {
      for (const i of t.ledger.listInbox({ runId: run.id })) {
        if (i.kind === "plan_approval") await t.o.decide(i.id, { choice: "approve" }, "user:po");
        if (i.kind === "replan_approval") await t.o.decide(i.id, { choice: "replan" }, "user:po");
      }
      await t.o.tick();
      await t.o.idle();
      await t.fake.settled();
    };
    for (let i = 0; i < 150 && wo1()?.state !== "merged"; i++) await step();
    assert.match(wo1()?.mergeWhy ?? "", /^The policy merged it/);
    assert.equal((await t.call("POST", `/runs/${run.id}/revise`, { note: "Also return a receipt id." })).status, 200);
    const replanned = () => t.ledger.listInbox({ state: "decided", runId: run.id }).some((i) => i.kind === "replan_approval");
    for (let i = 0; i < 150 && !(replanned() && wo1()?.state !== "merged"); i++) await step();
    assert.ok(replanned() && wo1()?.state !== "merged", "WO-1 wasn't reopened");
    assert.deepEqual([wo1()?.mergedBy, wo1()?.mergeWhy], [null, null]);
    const detail = (await t.call("GET", `/runs/${run.id}`)).json;
    assert.equal(detail.workOrders[0].mergeWhy, null);
  } finally {
    await t.close();
  }
});

// ---- metrics ----

test("metrics: what goes wrong counts once per work order (or run) however often it repeats there; a lesson answered after a run isn't a person the run needed; ?days= empty is the default", async () => {
  const ledger = openLedger(":memory:");
  try {
    const base = { goal: "g", autonomy: "supervised" as const, baseBranch: "main", integrationBranch: "factory/x", createdBy: "user:po", policyHash: "aaaaaaaaaaaa" };
    const a = ledger.createRun({ ...base, change: "a" });
    const b = ledger.createRun({ ...base, change: "b" });
    ledger.updateRun(a.id, { state: "done" });
    ledger.updateRun(b.id, { state: "released", releasedAt: new Date().toISOString(), releasedBy: "user:alice" });
    const wo = { title: "t", acceptance: [], controls: [], dependsOn: [], wave: 1, risk: "low" as const };
    const [a1, a2] = ledger.addWorkOrders(a.id, [1, 2].map((seq) => ({ ...wo, seq })));
    const decided = (runId: string, kind: "work_order_failed" | "budget_reached" | "release" | "lesson", workOrderId: string | undefined, decision: string) => {
      const item = ledger.openInbox({ runId, workOrderId, kind, title: kind, body: "", options: [] });
      ledger.decideInbox(item.id, { decision, by: "user:po" });
    };
    const attempt = (workOrderId: string, more: Record<string, unknown>) =>
      ledger.addAttempt({ runId: a.id, workOrderId, role: "builder", conversationId: `c-${Math.random()}`, costUsd: 0, ...more });
    // WO-1, twice over: a fresh builder after Retry ran out of rounds too, its budget raised and reached again,
    // two agents that crashed and two the watchdog stopped. WO-2: one crash.
    for (let i = 0; i < 2; i++) {
      decided(a.id, "work_order_failed", a1!.id, "retry");
      decided(a.id, "budget_reached", a1!.id, "raise");
      attempt(a1!.id, { state: "error", result: { error: "crashed" } });
      attempt(a1!.id, { state: "stuck", result: { error: "No progress", watchdog: true } });
    }
    attempt(a2!.id, { state: "error", result: "a plain string" });
    // Run b needed a person only to release; the lesson it proposed was answered afterwards.
    decided(b.id, "release", undefined, "release");
    decided(b.id, "lesson", undefined, "accept");
    let seq = 0;
    const ev = (subject: string, action: string): AuditEvent => ({ seq: ++seq, at: new Date().toISOString(), actor: "system", action, subject, data: { reason: "x" }, prevHash: "", hash: "" });
    const m = computeMetrics(ledger, [ev(a.id, "autopilot.release_failed"), ev(a.id, "autopilot.release_failed")]);
    assert.deepEqual(Object.fromEntries(m.failures.map((f) => [f.reason, f.count])), {
      "A work order ran out of repair rounds": 1,
      "A budget was reached": 1,
      "An agent stopped with an error": 2,
      "An agent made no progress and was stopped": 1,
      "A release didn't go through": 1,
    });
    assert.equal(m.autonomy.runsWithoutPeople, 1);

    // A run of the same policy from before the window isn't in its card.
    const old = new Date(Date.now() - 20 * 86_400_000).toISOString();
    ledger.createRun({ ...base, change: "old", createdAt: old } as never);
    const week = computeMetrics(ledger, [], { days: 7 });
    assert.deepEqual([week.runs.started, week.policies.map((p) => [p.hash, p.runs, p.released])], [2, [["aaaaaaaaaaaa", 2, 1]]]);
    assert.equal(week.policies[0]!.firstRun >= week.window.from, true);
  } finally {
    ledger.close();
  }
  const t = await make();
  try {
    assert.equal((await t.call("GET", "/metrics?days=")).json.window.days, 30);
    assert.equal((await t.call("GET", "/metrics?days=7")).json.window.days, 7);
  } finally {
    await t.close();
  }
});
