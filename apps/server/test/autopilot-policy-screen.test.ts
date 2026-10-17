// The Policy page's API, the policy in plain words, and a plain reason on every automated decision.
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.SF_DATA_DIR = mkdtempSync(path.join(tmpdir(), "sf-policy-screen-data-"));
process.env.SF_WORKSPACE = mkdtempSync(path.join(tmpdir(), "sf-policy-screen-unused-"));
delete process.env.SF_AUTONOMY_CAP;
const { startFakeOpenHands } = await import("../src/demo/fake-agent-server.js");
const { scriptedAgents } = await import("../src/demo/scripted-agents.js");
const { createOrchestrator } = await import("../src/autopilot/orchestrator.js");
const { openLedger } = await import("../src/autopilot/ledger.js");
const { OpenHandsClient } = await import("../src/autopilot/openhands.js");
const { createAutopilotRoutes } = await import("../src/autopilot/routes.js");
const { buildEvidence } = await import("../src/autopilot/evidence.js");
const { commitAll, ensureRepo, fileAt } = await import("../src/autopilot/git.js");
const { DEFAULT_POLICY, evaluateMerge, parsePolicy, policyHash } = await import("../src/autopilot/policy.js");
const { explainPolicy } = await import("../src/autopilot/explain.js");
const { templateById } = await import("../src/autopilot/policy-templates.js");
const { audit, listAudit } = await import("../src/audit.js");

test("explainPolicy says what the defaults do, in plain sentences", () => {
  const lines = explainPolicy(DEFAULT_POLICY);
  assert.match(lines[0]!, /^Runs start supervised \(a person approves the plan; merges follow the rules below\)\. Anyone can choose up to autonomous\.$/);
  assert.match(lines.join("\n"), /changes fewer than 400 lines, and it changes none of the \d+ sensitive path patterns/);
  assert.ok(lines.includes("A person releases every run into the base branch."));
  assert.ok(lines.includes("Each change may spend $30.00 and each work order $5.00 before a person is asked to raise it."));
  assert.match(explainPolicy(parsePolicy("autonomy: { default: suggest, max: suggest }\n")).join("\n"), /Nobody can choose more\.\nEvery merge waits for a person\./);
});

test("evaluateMerge says why in one sentence, either way", () => {
  const facts = { autonomy: "supervised" as const, gatesOk: true, hiddenTestsOk: null, reviewPassed: true, secretFindings: 0, dependencyFindings: [], files: ["src/a.js"], linesChanged: 12, newDependencies: [] };
  assert.equal(
    evaluateMerge(DEFAULT_POLICY, facts).why,
    "The policy merged it: the gates and the review passed, the scans found no secrets or risky dependencies, it adds no dependency outside the allowlist, it changes no sensitive path, and it changes 12 lines (the limit is 400).",
  );
  assert.match(evaluateMerge(DEFAULT_POLICY, { ...facts, files: ["src/auth/x.js"] }).why, /^The policy left it to a person: Changes sensitive paths: src\/auth\/x\.js \(\*\*\/auth\/\*\*\)\.$/);
});

async function setup(handler = scriptedAgents({ noBugs: true })) {
  const workspace = mkdtempSync(path.join(tmpdir(), "sf-policy-screen-ws-"));
  writeFileSync(path.join(workspace, "README.md"), "# Demo\n");
  await ensureRepo(workspace);
  const fake = await startFakeOpenHands({ onMessage: handler });
  const ledger = openLedger(":memory:");
  const o = createOrchestrator({ ledger, client: new OpenHandsClient({ baseUrl: fake.url }), workspace, dataDir: mkdtempSync(path.join(tmpdir(), "sf-policy-screen-run-")), graceMs: 0 });
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
    call,
    async close() {
      o.stop();
      await o.idle();
      await fake.close();
      ledger.close();
    },
  };
}

test("the Policy page API: the file and what it means, templates, a draft checked without writing, and a person's policy committed to the base branch", async () => {
  const t = await setup();
  try {
    let view = (await t.call("GET", "/policy")).json;
    assert.deepEqual([view.base, view.source, view.yaml, view.error], ["main", "defaults", null, null]);
    assert.equal(view.hash, policyHash(DEFAULT_POLICY));
    assert.ok(view.explanation.length > 8);
    assert.deepEqual(view.templates.map((x: { id: string }) => x.id), ["recommended", "cautious", "federal", "autonomous"]);
    assert.ok(view.templates.every((x: { explanation: string[] }) => x.explanation.includes("A person releases every run into the base branch.")));

    const bad = (await t.call("POST", "/policy/check", { yaml: "autoMerge: { maxChangedLine: 10 }\n" })).json;
    assert.deepEqual([bad.ok, bad.error], [false, "autoMerge.maxChangedLine isn't a policy setting"]);
    const good = (await t.call("POST", "/policy/check", { yaml: "autoMerge: { maxChangedLines: 120 }\n" })).json;
    assert.equal(good.ok, true);
    assert.match(good.explanation.join(" "), /fewer than 120 lines/);
    assert.equal(await fileAt(t.workspace, "refs/heads/main", ".factory/policy.yml"), null, "checking writes nothing");

    view = (await t.call("POST", "/policy", { template: "cautious" })).json;
    assert.deepEqual([view.source, view.hash, view.yaml], [".factory/policy.yml@main", policyHash(parsePolicy(templateById("cautious")!.yaml)), templateById("cautious")!.yaml]);
    const refused = await t.call("POST", "/policy", { yaml: "release: { auto: maybe }\n" });
    assert.deepEqual([refused.status, refused.json.error], [400, "The policy isn't valid, so nothing was written: release.auto must be true or false"]);
    view = (await t.call("POST", "/policy", { yaml: "autoMerge: { maxChangedLines: 120 }" })).json;
    assert.equal(view.yaml, "autoMerge: { maxChangedLines: 120 }\n");
    assert.match(view.explanation.join(" "), /fewer than 120 lines/);

    await audit("test", "test.flush", "test");
    const written = listAudit(5000).filter((e) => e.action === "autopilot.policy_written").reverse();
    assert.deepEqual(written.map((e) => [e.actor, e.data.template, e.data.from]), [
      ["user:local", "cautious", policyHash(DEFAULT_POLICY)],
      ["user:local", null, policyHash(parsePolicy(templateById("cautious")!.yaml))],
    ]);
  } finally {
    await t.close();
  }
});

test("every automated decision carries its reason in plain words: the plan, each policy merge, a person's merge; the evidence lists the policy's", async () => {
  const t = await setup();
  try {
    const run = await t.o.createRun({ goal: "Let applicants check a claim's status", autonomy: "autonomous", actor: "user:po" });
    for (let i = 0; i < 150 && t.ledger.getRun(run.id)?.state !== "done"; i++) {
      for (const item of t.ledger.listInbox({ runId: run.id })) if (item.kind === "merge_approval") await t.o.decide(item.id, { choice: "merge", note: "Auth check reviewed" }, "user:isso");
      await t.o.tick();
      await t.o.idle();
      await t.fake.settled();
    }
    assert.equal(t.ledger.getRun(run.id)?.state, "done");
    const [wo1, , wo3] = t.ledger.listWorkOrders(run.id);
    assert.match(wo1!.mergeWhy ?? "", /^The policy merged it: the gates and the review passed, .* and it changes \d+ lines \(the limit is 400\)\.$/);
    assert.match(wo3!.mergeWhy ?? "", /^isso merged it \(“Auth check reviewed”\)\. The policy asked a person because: Changes sensitive paths: src\/auth\//);
    const detail = (await t.call("GET", `/runs/${run.id}`)).json;
    assert.equal(detail.workOrders[0].mergeWhy, wo1!.mergeWhy);
    const evidence = await buildEvidence(t.ledger, t.workspace, t.ledger.getRun(run.id)!);
    const automated = evidence.automated.map((a) => [a.action, a.workOrder]);
    assert.deepEqual(automated, [["plan_approved", null], ["work_order_merged", "WO-1"], ["work_order_merged", "WO-2"]]);
    assert.match(evidence.automated[0]!.why ?? "", /^The run is autonomous, so the policy approves the plan; the spec critic's verdict was pass\.$/);
    assert.ok(evidence.automated.every((a) => a.why && a.by === `policy@${run.policyHash}`));
    assert.equal(evidence.workOrders.find((w) => w.key === "WO-3")?.mergeWhy, wo3!.mergeWhy);
  } finally {
    await t.close();
  }
});

test("a policy write never follows a folder that links out of the repo", async () => {
  const t = await setup();
  try {
    const outside = mkdtempSync(path.join(tmpdir(), "sf-policy-screen-outside-"));
    symlinkSync(outside, path.join(t.workspace, ".factory"));
    await commitAll(t.workspace, "A .factory that points elsewhere");
    const res = await t.call("POST", "/policy", { template: "cautious" });
    assert.equal(res.status, 400);
    assert.match(res.json.error, /\.factory\/policy\.yml is in a folder that links out of the repo/);
    assert.deepEqual(readdirSync(outside), []);
  } finally {
    await t.close();
  }
});
