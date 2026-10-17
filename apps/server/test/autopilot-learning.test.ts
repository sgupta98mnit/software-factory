import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.SF_DATA_DIR = mkdtempSync(path.join(tmpdir(), "sf-learning-data-"));
process.env.SF_WORKSPACE = mkdtempSync(path.join(tmpdir(), "sf-learning-unused-"));
delete process.env.SF_AUTONOMY_CAP;
const { startFakeOpenHands } = await import("../src/demo/fake-agent-server.js");
const { scriptedAgents } = await import("../src/demo/scripted-agents.js");
const { createOrchestrator } = await import("../src/autopilot/orchestrator.js");
const { openLedger } = await import("../src/autopilot/ledger.js");
const { OpenHandsClient } = await import("../src/autopilot/openhands.js");
const { createAutopilotRoutes } = await import("../src/autopilot/routes.js");
const { fileAt, git } = await import("../src/autopilot/git.js");
const { findLessons, reasonKind, withLesson } = await import("../src/autopilot/learning.js");
const { audit, listAudit } = await import("../src/audit.js");

test("withLesson: adds the factory's section, or a bullet at the end of it, leaving the rest alone", () => {
  assert.equal(withLesson(null, "Run `npm run lint`."), "# Instructions for agents\n\n## Learned by the Software Factory\n\n- Run `npm run lint`.\n");
  assert.equal(withLesson("# Repo\n\nUse tabs.\n", "A."), "# Repo\n\nUse tabs.\n\n## Learned by the Software Factory\n\n- A.\n");
  const twice = withLesson(withLesson("# Repo\n", "A."), "B.");
  assert.equal(twice, "# Repo\n\n## Learned by the Software Factory\n\n- A.\n- B.\n");
  const middle = "# Repo\n\n## Learned by the Software Factory\n\n- A.\n\n## Deploying\n\nAsk ops.\n";
  assert.equal(withLesson(middle, "B."), "# Repo\n\n## Learned by the Software Factory\n\n- A.\n- B.\n\n## Deploying\n\nAsk ops.\n");
});

test("reasonKind groups reasons that differ only in numbers and details", () => {
  assert.equal(reasonKind("Changes sensitive paths: src/auth/a.js (**/auth/**)."), "Changes sensitive paths");
  assert.equal(reasonKind("Changes 512 lines, over the limit of 400."), "Changes N lines, over the limit of N.");
});

test("findLessons: a gate failing on the first try in enough work orders, secrets and unpinned dependencies; not below the threshold", () => {
  const ledger = openLedger(":memory:");
  const run = ledger.createRun({ goal: "g", change: "add-x", autonomy: "supervised", baseBranch: "main", integrationBranch: "autopilot/add-x", createdBy: "user:t" });
  ledger.addWorkOrders(run.id, [1, 2, 3].map((seq) => ({ seq, title: `T${seq}`, acceptance: ["a"], controls: [], dependsOn: [], wave: 1, risk: "low" as const })));
  for (const seq of [1, 2, 3]) {
    const workOrderId = `${run.id}/WO-${seq}`;
    ledger.addCheck({ runId: run.id, workOrderId, stage: "build", name: "web:lint", ok: false, output: "x" });
    ledger.addCheck({ runId: run.id, workOrderId, stage: "build", name: "web:lint", ok: true, output: "" }); // fixed later: still a first-try failure
    ledger.addCheck({ runId: run.id, workOrderId, stage: "build", name: "test", ok: seq === 3, output: "" }); // only twice
    ledger.addCheck({ runId: run.id, workOrderId, stage: "build", name: "secret-scan", ok: false, output: "aws-key" });
    ledger.addCheck({ runId: run.id, workOrderId, stage: "build", name: "dependency-scan", ok: false, output: "package.json: left-pad ^1.0.0 isn't pinned to an exact version" });
  }
  const lessons = findLessons(ledger, 3);
  assert.deepEqual(lessons.map((l) => [l.key, l.count]), [["gate:web:lint", 3], ["secrets", 3], ["deps-pinned", 3]]);
  assert.match(lessons[0]!.line, /^Run `cd web && npm run lint` before you finish/);
  assert.deepEqual(lessons[0]!.seen, ["add-x WO-1", "add-x WO-2", "add-x WO-3"]);
  assert.deepEqual(findLessons(ledger, 4), []);
  ledger.close();
});

test("a mistake two runs made becomes an AGENTS.md lesson in the Inbox; accepted, it's committed to main in the person's name and never proposed again; insights show what the policy did", { timeout: 300_000 }, async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "sf-learning-ws-"));
  writeFileSync(path.join(workspace, "README.md"), "# Demo\n");
  writeFileSync(path.join(workspace, "AGENTS.md"), "# Agents\n\nUse plain JavaScript.\n");
  mkdirSync(path.join(workspace, ".factory"));
  writeFileSync(path.join(workspace, ".factory", "policy.yml"), "learning: { threshold: 2 }\n");
  // The scripted builders' WO-2 fails its test on the first try, every run.
  const fake = await startFakeOpenHands({ onMessage: scriptedAgents() });
  const ledger = openLedger(":memory:");
  const o = createOrchestrator({ ledger, client: new OpenHandsClient({ baseUrl: fake.url }), workspace, dataDir: mkdtempSync(path.join(tmpdir(), "sf-learning-run-")), graceMs: 0 });
  const app = createAutopilotRoutes(o);
  const drive = async (runId: string) => {
    for (let i = 0; i < 150 && ledger.getRun(runId)?.state !== "done"; i++) {
      for (const item of ledger.listInbox({ runId })) {
        if (item.kind === "plan_approval") await o.decide(item.id, { choice: "approve" }, "user:po");
        if (item.kind === "merge_approval") await o.decide(item.id, { choice: "merge" }, "user:isso");
      }
      await o.tick();
      await o.idle();
      await fake.settled();
    }
    assert.equal(ledger.getRun(runId)?.state, "done");
  };
  try {
    const first = await o.createRun({ goal: "Let applicants check a claim's status", autonomy: "supervised", actor: "user:po" });
    await drive(first.id);
    assert.equal(ledger.listInbox({ runId: first.id }).filter((i) => i.kind === "lesson").length, 0, "once isn't a pattern");
    const second = await o.createRun({ goal: "Let clerks export claims", autonomy: "supervised", actor: "user:po" });
    await drive(second.id);
    const item = ledger.listInbox({ runId: second.id }).find((i) => i.kind === "lesson")!;
    assert.match(item.title, /^Add to AGENTS\.md: Run `npm run test` before you finish/);
    assert.match(item.body, /2 work orders, most recently `let-clerks-export-claims WO-2`, `let-applicants-check-a-claim-s-status WO-2`/);
    assert.deepEqual(ledger.listLessons().map((l) => [l.key, l.state]), [["gate:test", "open"]]);

    await o.decide(item.id, { choice: "accept" }, "user:po");
    const agents = await fileAt(workspace, "refs/heads/main", "AGENTS.md");
    assert.match(agents ?? "", /^# Agents\n\nUse plain JavaScript\.\n\n## Learned by the Software Factory\n\n- Run `npm run test` before you finish and fix everything it reports: in this repo it failed on the first try in 2 work orders\.\n$/);
    assert.match((await git(workspace, ["log", "-1", "--format=%s", "main"])).stdout.trim(), /^agents: Run `npm run test` .*\(po\)$/);
    const lesson = ledger.getLesson("gate:test")!;
    assert.deepEqual([lesson.state, lesson.decidedBy], ["accepted", "user:po"]);
    assert.equal(lesson.sha, (await git(workspace, ["rev-parse", "main"])).stdout.trim());

    // A third run with the same mistake doesn't ask again.
    const third = await o.createRun({ goal: "Let supervisors reassign claims", autonomy: "supervised", actor: "user:po" });
    await drive(third.id);
    assert.equal(ledger.listInbox({ state: "all" }).filter((i) => i.kind === "lesson").length, 1);

    const insights = (await (await app.request("/insights")).json()) as { hash: string; runs: number; merges: { policy: number; person: number }; reasons: { reason: string; asked: number; merged: number }[]; notes: string[] }[];
    assert.equal(insights.length, 1);
    assert.deepEqual([insights[0]!.runs, insights[0]!.merges], [3, { policy: 6, person: 3 }]);
    assert.deepEqual(insights[0]!.reasons.map((r) => [r.reason, r.asked, r.merged]), [["Changes sensitive paths", 3, 3]]);
    assert.match(insights[0]!.notes.join(" "), /The policy merged 6 of 9 work orders by itself\./);
    await audit("test", "test.flush", "test");
    assert.deepEqual(listAudit(5000).filter((e) => e.action === "autopilot.lesson_accepted").map((e) => [e.actor, e.data.key]), [["user:po", "gate:test"]]);
  } finally {
    o.stop();
    await o.idle();
    await fake.close();
    ledger.close();
  }
});
