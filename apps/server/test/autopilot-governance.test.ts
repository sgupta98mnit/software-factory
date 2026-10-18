import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Hono } from "hono";
import type { FakeHandler } from "./fake-openhands.js";

const dataRoot = mkdtempSync(path.join(tmpdir(), "sf-governance-"));
process.env.SF_DATA_DIR = path.join(dataRoot, "audit");
process.env.SF_WORKSPACE = mkdtempSync(path.join(tmpdir(), "sf-governance-unused-"));
delete process.env.SF_AUTONOMY_CAP;
delete process.env.SF_REQUIRE_ISOLATION;
delete process.env.SF_EVIDENCE_DIR;
const { createOrchestrator } = await import("../src/autopilot/orchestrator.js");
const { createAutopilotRoutes } = await import("../src/autopilot/routes.js");
const { createAuth, authConfigFromEnv } = await import("../src/auth.js");
const { openLedger } = await import("../src/autopilot/ledger.js");
const { OpenHandsClient } = await import("../src/autopilot/openhands.js");
const { git } = await import("../src/autopilot/git.js");
const { audit, listAudit, sha256 } = await import("../src/audit.js");
const { pruneEvidence, storeEvidence, verifyEvidence, listEvidence } = await import("../src/autopilot/evidence-store.js");
const { startFakeOpenHands } = await import("./fake-openhands.js");
type Release = import("../src/autopilot/orchestrator.js").Release;

const PASS = '```json\n{"verdict":"pass","findings":[]}\n```';

/** Builders write a different line each round; reviewers pass. */
function builders(): FakeHandler {
  let round = 0;
  return (conv) => {
    if (conv.tags.sfrole !== "builder") return { response: PASS, cost: 0.01 };
    writeFileSync(path.join(conv.workingDir, "feature.txt"), `round ${++round}\n`);
    return { response: "Done.", cost: 0.05 };
  };
}

async function setup(governance: string) {
  const workspace = mkdtempSync(path.join(tmpdir(), "sf-governance-ws-"));
  writeFileSync(path.join(workspace, "README.md"), "# Demo\n");
  mkdirSync(path.join(workspace, ".factory"));
  writeFileSync(path.join(workspace, ".factory", "policy.yml"), `gates: [{ name: ok, run: "node -e 0" }]\ngovernance: ${governance}\n`);
  const dataDir = mkdtempSync(path.join(dataRoot, "case-"));
  const fake = await startFakeOpenHands({ onMessage: builders() });
  const ledger = openLedger(path.join(dataDir, "autopilot.db"));
  const o = createOrchestrator({ ledger, client: new OpenHandsClient({ baseUrl: fake.url }), workspace, dataDir, graceMs: 0 });
  /** The API as one person with these roles (local mode narrowed by SF_LOCAL_ROLES). */
  const as = (roles: string) => {
    const app = new Hono();
    app.use("*", createAuth(authConfigFromEnv({ SF_LOCAL_ROLES: roles }, "user:local"), ledger).middleware);
    app.route("/autopilot", createAutopilotRoutes(o));
    return (id: number, body: unknown) => app.request(`/autopilot/inbox/${id}/decide`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  };
  return {
    workspace,
    dataDir,
    ledger,
    o,
    as,
    wo: (runId: string) => ledger.getWorkOrder(`${runId}/WO-1`)!,
    open: (runId: string, kind: string) => ledger.listInbox({ runId }).find((i) => i.kind === kind)!,
    async until(done: () => boolean, max = 80) {
      for (let i = 0; i < max; i++) {
        await o.tick();
        await o.idle();
        await fake.settled();
        if (done()) return;
      }
      const runs = ledger.listRuns().map((r) => ({ state: r.state, wos: ledger.listWorkOrders(r.id).map((w) => w.state), inbox: ledger.listInbox({ state: "all", runId: r.id }).map((i) => `${i.kind}:${i.state}`) }));
      assert.fail(`the run didn't get there: ${JSON.stringify(runs)}`);
    },
    /** Started by this machine's user, the one t.as() acts as. */
    async run(controls: string[] = [], autonomy: "suggest" | "autonomous" = "autonomous") {
      const run = await o.createRun({ goal: "Add a feature", autonomy, actor: "user:local" });
      ledger.addWorkOrders(run.id, [{ seq: 1, title: "Validate input", acceptance: ["Bad input is refused"], controls, dependsOn: [], wave: 1, risk: "low" }]);
      return ledger.updateRun(run.id, { state: "building" });
    },
    async close() {
      o.stop();
      await o.idle();
      await fake.close();
      ledger.close();
    },
  };
}

const audited = async (runId: string, action: string) => {
  await audit("test", "test.flush", "test");
  return listAudit().filter((e) => e.subject === runId && e.action === action);
};

test("a work order with mapped controls waits for an ISSO's approval of its verified commit; an approver can't give it, and a new commit needs a new approval", async () => {
  const t = await setup("{ controlApproval: required }");
  try {
    const run = await t.run(["SI-10"], "suggest");
    await t.until(() => t.wo(run.id).state === "awaiting_control_approval");
    const first = t.open(run.id, "control_approval");
    const head = (await git(t.workspace, ["rev-parse", t.wo(run.id).branch!])).stdout.trim();
    assert.equal(first.ref, `commit:${head}`, "the item names the commit it's about");
    assert.ok(t.ledger.listChecks({ runId: run.id }).some((c) => c.name === "verified" && c.ok && c.sha === head), "that commit was verified first");
    assert.match(first.body, /SI-10/);
    assert.match(first.body, /Passed: verified/);
    assert.equal(t.ledger.listInbox({ runId: run.id }).filter((i) => i.kind === "merge_approval").length, 0, "the ISSO comes before the merge decision");

    // An approver (who approves merges) can't approve controls; an ISSO can, and then the merge is decided as usual.
    assert.equal((await t.as("engineer,approver")(first.id, { choice: "approve" })).status, 403);
    assert.equal((await t.as("isso")(first.id, { choice: "approve" })).status, 200);
    await t.until(() => t.wo(run.id).state === "awaiting_merge_approval");

    // The approver sends it back: the builder's new commit needs the ISSO again, verified first.
    const merge = t.open(run.id, "merge_approval");
    assert.equal((await t.as("engineer,approver")(merge.id, { choice: "send_back", note: "Use a clearer name" })).status, 200);
    await t.until(() => t.wo(run.id).state === "awaiting_control_approval");
    const second = t.open(run.id, "control_approval");
    const rebuilt = (await git(t.workspace, ["rev-parse", t.wo(run.id).branch!])).stdout.trim();
    assert.notEqual(rebuilt, head);
    assert.equal(second.ref, `commit:${rebuilt}`);
    assert.ok(t.ledger.listChecks({ runId: run.id }).some((c) => c.name === "verified" && c.ok && c.sha === rebuilt));

    await t.o.decide(second.id, { choice: "approve" }, "user:isso", ["isso"]);
    await t.until(() => t.wo(run.id).state === "awaiting_merge_approval");
    await t.o.decide(t.open(run.id, "merge_approval").id, { choice: "merge" }, "user:approver", ["approver"]);
    await t.until(() => t.ledger.getRun(run.id)?.state === "done");
    const [merged] = await audited(run.id, "autopilot.work_order_merged");
    assert.deepEqual([merged?.actor, merged?.data.controlsApprovedBy], ["user:approver", "user:isso"]);
    assert.equal((await audited(run.id, "autopilot.controls_approved")).length, 2);
  } finally {
    await t.close();
  }
});

test("release approval: a finished run waits for a release manager other than its creator, and the approval stores the evidence and an envelope bound to the commit, write-once", async () => {
  const t = await setup("{ releaseApproval: required }");
  try {
    const run = await t.run();
    await t.until(() => t.ledger.getRun(run.id)?.state === "done");
    const head = (await git(t.workspace, ["rev-parse", run.integrationBranch])).stdout.trim();
    const pending = t.ledger.getRun(run.id)?.release as Release;
    assert.deepEqual([pending.status, pending.commit], ["pending", head]);
    const item = t.open(run.id, "release");
    assert.equal(item.ref, `commit:${head}`);

    assert.equal((await t.as("engineer,approver")(item.id, { choice: "approve" })).status, 403, "approvers don't release");
    const own = await t.as("release_manager")(item.id, { choice: "approve" });
    assert.equal(own.status, 403, "four-eyes: the release manager who started the run can't release it");
    assert.match(String(((await own.json()) as { error: string }).error), /Four-eyes/);
    await assert.rejects(t.o.decide(item.id, { choice: "reject" }, "user:rm", ["release_manager"]), /needs a note/);
    assert.equal(t.ledger.getInbox(item.id)?.state, "open");

    await t.o.decide(item.id, { choice: "approve" }, "user:rm", ["release_manager"]);
    const release = t.ledger.getRun(run.id)?.release as Release;
    assert.deepEqual([release.status, release.decidedBy, release.roles, release.commit], ["approved", "user:rm", ["release_manager"], head]);
    const root = path.join(t.dataDir, "evidence");
    const envelopeFile = path.join(root, release.envelope!.file);
    const envelope = JSON.parse(readFileSync(envelopeFile, "utf8"));
    assert.equal(envelope.artifact.commit, head);
    assert.equal(envelope.evidence.digest, release.evidence!.sha256);
    assert.deepEqual(envelope.approver, { actor: "user:rm", roles: ["release_manager"] });
    assert.equal(envelope.policyHash, run.policyHash);
    const packet = readFileSync(path.join(root, release.evidence!.file), "utf8");
    assert.equal(sha256(packet), release.evidence!.sha256, "the packet hashes to its digest");
    assert.equal(JSON.parse(packet).artifact.commit, head);
    assert.equal((await audited(run.id, "autopilot.release_approved"))[0]?.data.envelope, release.envelope!.sha256);

    // Write-once: the factory refuses to replace a stored file, a changed file fails verification, and retention keeps it.
    if (process.getuid?.() !== 0) assert.throws(() => writeFileSync(envelopeFile, "{}"), "stored evidence is read-only");
    assert.deepEqual(storeEvidence(root, run.id, "release", envelope), release.envelope, "storing the same envelope again is the same file");
    assert.equal(verifyEvidence(root).ok, true);
    assert.deepEqual(pruneEvidence(root), [], "nothing is pruned inside the retention period");
    const { chmodSync } = await import("node:fs");
    chmodSync(envelopeFile, 0o644);
    writeFileSync(envelopeFile, JSON.stringify({ ...envelope, approver: { actor: "user:someone-else", roles: [] } }));
    assert.deepEqual(verifyEvidence(root).changed, [release.envelope!.file]);
    assert.throws(() => storeEvidence(root, run.id, "release", envelope), /has changed since it was written/);
    assert.equal(listEvidence(root).length, 2);
    assert.equal(pruneEvidence(root, 1, Date.now() + 2 * 86_400_000).length, 2, "after the retention period, files go");
  } finally {
    await t.close();
  }
});

test("a rejected release records who rejected it and why, and governance off keeps runs as before", async () => {
  const t = await setup("{ releaseApproval: required, fourEyes: false }");
  try {
    const run = await t.run();
    await t.until(() => t.ledger.getRun(run.id)?.state === "done");
    const item = t.open(run.id, "release");
    await t.o.decide(item.id, { choice: "reject", note: "Not this quarter" }, "user:test", ["release_manager"]);
    const release = t.ledger.getRun(run.id)?.release as Release;
    assert.deepEqual([release.status, release.decidedBy, release.envelope], ["rejected", "user:test", null]);
    assert.equal((await audited(run.id, "autopilot.release_rejected"))[0]?.data.note, "Not this quarter");
  } finally {
    await t.close();
  }
  const off = await setup("{}");
  try {
    const run = await off.run(["SI-10"]);
    await off.until(() => off.ledger.getRun(run.id)?.state === "done");
    assert.equal(off.ledger.getRun(run.id)?.release, null);
    assert.equal(off.ledger.listInbox({ state: "all", runId: run.id }).length, 0, "no ISSO or release item without the policy asking");
  } finally {
    await off.close();
  }
});
