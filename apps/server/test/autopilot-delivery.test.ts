import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { FakeHandler } from "./fake-openhands.js";

const dataRoot = mkdtempSync(path.join(tmpdir(), "sf-delivery-"));
process.env.SF_DATA_DIR = path.join(dataRoot, "audit");
process.env.SF_WORKSPACE = mkdtempSync(path.join(tmpdir(), "sf-delivery-unused-"));
delete process.env.SF_AUTONOMY_CAP;
delete process.env.SF_REQUIRE_ISOLATION;
const TOKEN = "github_pat_TEST_TOKEN_never_recorded";
process.env.SF_GITHUB_TOKEN = TOKEN;
const { createOrchestrator } = await import("../src/autopilot/orchestrator.js");
const { openLedger } = await import("../src/autopilot/ledger.js");
const { OpenHandsClient } = await import("../src/autopilot/openhands.js");
const { git } = await import("../src/autopilot/git.js");
const { audit, listAudit } = await import("../src/audit.js");
const { startFakeOpenHands } = await import("./fake-openhands.js");
const { startFakeGitHub } = await import("./fake-github.js");
type Delivery = import("../src/autopilot/orchestrator.js").Delivery;

const PASS = '```json\n{"verdict":"pass","findings":[]}\n```';
const REPO = "acme/benefits";

async function setup(opts: { handler: FakeHandler; maxCiRepairs?: number }) {
  const workspace = mkdtempSync(path.join(tmpdir(), "sf-delivery-ws-"));
  writeFileSync(path.join(workspace, "README.md"), "# Demo\n");
  const remoteDir = mkdtempSync(path.join(tmpdir(), "sf-delivery-remote-"));
  await git(remoteDir, ["init", "--bare", "-b", "main"]);
  const dataDir = mkdtempSync(path.join(dataRoot, "case-"));
  const gh = await startFakeGitHub({ token: TOKEN, repo: REPO, remoteDir });
  const { mkdirSync } = await import("node:fs");
  mkdirSync(path.join(workspace, ".factory"));
  writeFileSync(
    path.join(workspace, ".factory", "policy.yml"),
    `gates: [{ name: ok, run: "node -e 0" }]\ndelivery: { mode: github, repository: ${REPO}, apiUrl: "${gh.url}", requiredChecks: [ci/test], maxCiRepairs: ${opts.maxCiRepairs ?? 1} }\n`,
  );
  const fake = await startFakeOpenHands({ onMessage: opts.handler });
  const ledger = openLedger(path.join(dataDir, "autopilot.db"));
  const o = createOrchestrator({ ledger, client: new OpenHandsClient({ baseUrl: fake.url }), workspace, dataDir, graceMs: 0 });
  const t = {
    workspace,
    remoteDir,
    dataDir,
    gh,
    fake,
    ledger,
    o,
    delivery: (runId: string) => ledger.getRun(runId)?.delivery as Delivery,
    async until(done: () => boolean, max = 80) {
      for (let i = 0; i < max; i++) {
        await o.tick();
        await o.idle();
        await fake.settled();
        if (done()) return;
      }
      const runs = ledger.listRuns().map((r) => ({ state: r.state, delivery: r.delivery, wos: ledger.listWorkOrders(r.id).map((w) => `${w.seq}:${w.state}`), inbox: ledger.listInbox({ state: "all", runId: r.id }).map((i) => `${i.kind}:${i.state}`) }));
      assert.fail(`the run didn't get there: ${JSON.stringify(runs)}`);
    },
    async run() {
      const run = await o.createRun({ goal: "Add a feature", autonomy: "autonomous", actor: "user:test" });
      await git(workspace, ["remote", "add", "origin", remoteDir]);
      ledger.addWorkOrders(run.id, [{ seq: 1, title: "Feature", acceptance: ["It works"], controls: [], dependsOn: [], wave: 1, risk: "low" }]);
      return ledger.updateRun(run.id, { state: "building" });
    },
    async close() {
      o.stop();
      await o.idle();
      await fake.close();
      await gh.close();
      ledger.close();
    },
  };
  return t;
}

/** Builders write a different line each round; reviewers pass. */
function builders(): FakeHandler {
  let round = 0;
  return (conv) => {
    if (conv.tags.sfrole !== "builder") return { response: PASS, cost: 0.01 };
    writeFileSync(path.join(conv.workingDir, "feature.txt"), `round ${++round}\n`);
    return { response: "Done.", cost: 0.05 };
  };
}

test("delivery pushes the branch, opens one draft pull request (found again after a lost record), waits for CI on the exact head and finishes when it passes", async () => {
  const t = await setup({ handler: builders() });
  try {
    const run = await t.run();
    await t.until(() => t.delivery(run.id)?.status === "waiting" && !!t.delivery(run.id)?.pr);
    const head = t.gh.shaOf(run.integrationBranch);
    assert.equal(head, (await git(t.workspace, ["rev-parse", run.integrationBranch])).stdout.trim(), "the remote has the integration branch's tip");
    assert.equal(t.gh.shaOf("main"), "", "the base branch is never pushed");
    assert.equal(t.gh.state.pulls.length, 1);
    const [pull] = t.gh.state.pulls;
    assert.deepEqual([pull!.draft, pull!.head, pull!.base], [true, run.integrationBranch, "main"]);
    assert.match(pull!.body, new RegExp(`software-factory run: ${run.id}`));

    // The factory lost its record of the pull request (a crash right after opening it): it finds it again.
    t.ledger.updateRun(run.id, { delivery: { ...t.delivery(run.id), pr: null } });
    t.gh.check(head, "ci/test", null);
    t.gh.check("0".repeat(40), "ci/test", "success"); // a pass on another commit doesn't count
    await t.until(() => !!t.delivery(run.id)?.pr);
    await t.o.tick();
    await t.o.idle();
    assert.equal(t.gh.state.pulls.length, 1, "no second pull request");
    assert.equal(t.ledger.getRun(run.id)?.state, "delivering", "CI is still running on the head");

    t.gh.check(head, "ci/test", "success");
    await t.until(() => t.ledger.getRun(run.id)?.state === "done");
    assert.equal(t.delivery(run.id).status, "passed");
    assert.deepEqual(t.delivery(run.id).checks.map((c) => `${c.name}:${c.state}`), ["ci/test:success"]);
    const comment = t.gh.state.comments.find((c) => c.body.includes("software-factory evidence"))!;
    assert.match(comment.body, /Evidence packet digest \(sha256, sf-canonical-json-v1\): `[0-9a-f]{64}`/);
    assert.equal(t.gh.state.comments.length, 1, "one evidence comment, updated");

    // The token went only into request headers.
    assert.ok(t.gh.state.requests.every((r) => r.authorization === `Bearer ${TOKEN}`));
    await audit("test", "test.flush", "test");
    const records = JSON.stringify([t.ledger.listRuns(), t.ledger.listChecks({ runId: run.id }), t.ledger.listInbox({ state: "all" }), listAudit(), t.gh.state.pulls, t.gh.state.comments]);
    assert.ok(!records.includes(TOKEN), "the token is in no record, pull request or comment");
    const evidence = await t.o.evidence(run.id, "user:test");
    assert.equal(evidence.packet.delivery?.pullRequest?.number, 1);
    assert.equal(evidence.packet.artifact.commit, head);
    assert.ok(!JSON.stringify(evidence).includes(TOKEN));
  } finally {
    await t.close();
  }
});

test("a failing check and requested changes on the head become work orders through the pipeline; the new head is pushed and checked again", async () => {
  const t = await setup({ handler: builders(), maxCiRepairs: 2 });
  try {
    const run = await t.run();
    await t.until(() => t.delivery(run.id)?.status === "waiting" && !!t.delivery(run.id)?.pr);
    const first = t.gh.shaOf(run.integrationBranch);
    t.gh.check(first, "ci/test", "failure", "1 test failed: feature works");
    await t.until(() => t.ledger.listWorkOrders(run.id).some((w) => w.source === "ci"));
    const ci = t.ledger.listWorkOrders(run.id).find((w) => w.source === "ci")!;
    assert.equal(ci.seq, 2);
    assert.match(ci.title, /Fix the pull request's CI: ci\/test/);
    assert.match(ci.findings?.[0]?.detail ?? "", /1 test failed: feature works/);

    await t.until(() => t.delivery(run.id)?.status === "waiting" && t.gh.shaOf(run.integrationBranch) !== first);
    const brief = t.fake.conversations.get(t.ledger.listAttempts({ runId: run.id, workOrderId: ci.id, role: "builder" })[0]!.conversationId)!.messages[0]!;
    assert.match(brief, /It fixes the pull request delivered for the OpenSpec change/);
    assert.match(brief, /What to fix:[\s\S]*ci\/test/);

    // A reviewer asks for changes on this head (an old review on the first head doesn't count).
    const second = t.gh.shaOf(run.integrationBranch);
    t.gh.state.reviews.push({ user: "bob", state: "CHANGES_REQUESTED", commit: first, body: "Stale feedback" });
    t.gh.state.reviews.push({ user: "alice", state: "CHANGES_REQUESTED", commit: second, body: "Name the file after the feature." });
    t.gh.state.reviewComments.push({ path: "feature.txt", line: 1, commit: second, body: "Say which feature." });
    t.gh.check(second, "ci/test", "success");
    await t.until(() => t.ledger.listWorkOrders(run.id).some((w) => w.source === "review"));
    const review = t.ledger.listWorkOrders(run.id).find((w) => w.source === "review")!;
    const titles = (review.findings ?? []).map((f) => f.title).join("\n");
    assert.match(titles, /alice requested changes/);
    assert.match(titles, /Say which feature\./);
    assert.doesNotMatch(titles, /bob/);

    await t.until(() => t.delivery(run.id)?.status === "waiting" && t.gh.shaOf(run.integrationBranch) !== second);
    t.gh.check(t.gh.shaOf(run.integrationBranch), "ci/test", "success");
    await t.until(() => t.ledger.getRun(run.id)?.state === "done");
    assert.equal(t.delivery(run.id).repairs, 2);
    assert.equal(t.gh.state.pulls.length, 1);
  } finally {
    await t.close();
  }
});

test("repairs stop at the policy's limit for a person; a branch someone else moved is never force-pushed", async () => {
  const t = await setup({ handler: builders(), maxCiRepairs: 0 });
  try {
    const run = await t.run();
    await t.until(() => t.delivery(run.id)?.status === "waiting" && !!t.delivery(run.id)?.pr);
    t.gh.check(t.gh.shaOf(run.integrationBranch), "ci/test", "failure", "broken");
    await t.until(() => t.delivery(run.id)?.status === "blocked");
    const item = t.ledger.listInbox({ runId: run.id }).find((i) => i.kind === "delivery")!;
    assert.deepEqual(item.options.map((o) => o.id), ["retry", "finish", "cancel"]);
    assert.match(item.body, /after 0 repair round\(s\), the policy's limit/);
    assert.equal(t.ledger.listWorkOrders(run.id).length, 1, "no repair past the limit");
    await t.o.decide(item.id, { choice: "finish" }, "user:lead");
    assert.equal(t.ledger.getRun(run.id)?.state, "done");
    assert.equal(t.delivery(run.id).status, "finished");
    assert.equal(t.gh.state.pulls[0]?.state, "open", "the pull request stays for people");
  } finally {
    await t.close();
  }

  const moved = await setup({ handler: builders() });
  try {
    const run = await moved.run();
    // Someone pushes their own commit to the branch before the factory does.
    const other = mkdtempSync(path.join(tmpdir(), "sf-delivery-other-"));
    await git(other, ["clone", moved.remoteDir, "."]);
    writeFileSync(path.join(other, "theirs.txt"), "not the factory's\n");
    await git(other, ["checkout", "-b", run.integrationBranch]);
    await git(other, ["add", "theirs.txt"]);
    await git(other, ["commit", "-m", "theirs"]);
    await git(other, ["push", "origin", run.integrationBranch]);
    const theirs = moved.gh.shaOf(run.integrationBranch);
    await moved.until(() => moved.delivery(run.id)?.status === "blocked");
    assert.match(moved.delivery(run.id).blocked ?? "", /never force-pushes/);
    assert.equal(moved.gh.shaOf(run.integrationBranch), theirs, "their commit is still there");
    assert.equal(moved.gh.state.pulls.length, 0);
    assert.ok(readFileSync(path.join(other, "theirs.txt"), "utf8"));
  } finally {
    await moved.close();
  }
});
