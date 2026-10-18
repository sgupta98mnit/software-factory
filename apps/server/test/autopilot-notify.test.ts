import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const dataRoot = mkdtempSync(path.join(tmpdir(), "sf-notify-"));
process.env.SF_DATA_DIR = path.join(dataRoot, "audit");
process.env.SF_WORKSPACE = mkdtempSync(path.join(tmpdir(), "sf-notify-unused-"));
const { createOrchestrator } = await import("../src/autopilot/orchestrator.js");
const { openLedger } = await import("../src/autopilot/ledger.js");
const { OpenHandsClient } = await import("../src/autopilot/openhands.js");
const { createNotifier } = await import("../src/autopilot/notify.js");
const { audit, listAudit } = await import("../src/audit.js");

/** A webhook that keeps what it's sent, and answers 500 while `failing` is above 0. */
async function startWebhook() {
  const posts: Record<string, unknown>[] = [];
  const state = { failing: 0 };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      if (state.failing > 0) {
        state.failing--;
        res.writeHead(500).end();
        return;
      }
      posts.push(JSON.parse(body) as Record<string, unknown>);
      res.writeHead(200).end("ok");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}/hook`, posts, state, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

test("new Inbox items are posted once, a failed post is retried without repeats, and the digest goes out once a day at its hour", async () => {
  const hook = await startWebhook();
  const dir = mkdtempSync(path.join(dataRoot, "case-"));
  const workspace = mkdtempSync(path.join(dataRoot, "ws-")); // not a repository: the default policy, digest at 17:00
  const ledger = openLedger(path.join(dir, "autopilot.db"));
  let now = new Date(2026, 9, 18, 9, 0);
  const o = createOrchestrator({
    ledger,
    client: new OpenHandsClient({ baseUrl: "http://127.0.0.1:1" }),
    workspace,
    dataDir: dir,
    graceMs: 0,
    env: { SF_NOTIFY_WEBHOOK: hook.url, SF_CANVAS_URL: "https://factory.example.gov/" },
    clock: () => now,
    notifyRetryMs: 0,
  });
  const tick = async () => {
    await o.tick();
    await o.idle();
  };
  try {
    const run = ledger.createRun({ goal: "SECRET GOAL: move the benefits database", change: "add-x", autonomy: "supervised", baseBranch: "main", integrationBranch: "autopilot/add-x", integrationDir: workspace, createdBy: "user:test", state: "awaiting_plan_approval" });
    const first = ledger.openInbox({ runId: run.id, kind: "plan_approval", title: "Approve the plan for add-x", body: "BODY: the plan in full", options: [{ id: "approve", label: "Approve" }] });
    hook.state.failing = 1;
    await tick();
    assert.equal(hook.posts.length, 0, "the first post failed");
    assert.equal(ledger.getInbox(first.id)?.notifiedAt, null, "so the item isn't marked sent");
    assert.match((await o.status()).notify.failing ?? "", /answered 500/);
    await tick();
    assert.deepEqual(hook.posts.slice(), [
      {
        type: "software-factory.inbox",
        text: "Software Factory: a decision needs you: Approve the plan for add-x. https://factory.example.gov/inbox",
        items: [{ id: first.id, kind: "plan_approval", title: "Approve the plan for add-x", run: run.id, change: "add-x", link: `https://factory.example.gov/autopilot/runs/${run.id}` }],
      },
    ]);
    assert.ok(ledger.getInbox(first.id)?.notifiedAt);
    assert.equal((await o.status()).notify.failing, null);
    await tick();
    assert.equal(hook.posts.length, 1, "posted once, and 09:00 is before the digest hour");

    const second = ledger.openInbox({ runId: run.id, kind: "questions", title: "Questions about add-x", body: "BODY: the questions", options: [{ id: "answer", label: "Send answers" }] });
    await tick();
    assert.deepEqual((hook.posts[1]?.items as { id: number }[]).map((i) => i.id), [second.id], "only the new item");

    now = new Date(2026, 9, 18, 17, 30);
    await tick();
    const digest = hook.posts[2] as { type: string; date: string; text: string; open: unknown[]; runs: { change: string; state: string }[] };
    assert.deepEqual([digest.type, digest.date, digest.open.length, digest.runs], ["software-factory.digest", "2026-10-18", 2, [{ id: run.id, change: "add-x", state: "awaiting_plan_approval", link: `https://factory.example.gov/autopilot/runs/${run.id}` }]]);
    assert.equal(digest.text, "Software Factory, 2026-10-18: 2 open decision(s), 1 run(s) going. https://factory.example.gov/inbox");
    await tick();
    assert.equal(hook.posts.length, 3, "one digest a day");
    now = new Date(2026, 9, 19, 16, 59);
    await tick();
    assert.equal(hook.posts.length, 3, "not before its hour");
    now = new Date(2026, 9, 19, 17, 0);
    await tick();
    assert.equal(hook.posts[3]?.date, "2026-10-19");

    const sent = JSON.stringify(hook.posts);
    assert.ok(!sent.includes("SECRET GOAL") && !sent.includes("BODY:"), "never goals or item bodies");
    await audit("test", "test.flush", "test");
    assert.deepEqual(listAudit().filter((e) => e.action === "autopilot.notified").map((e) => e.data.kind).reverse(), ["inbox", "inbox", "digest", "digest"]);
    assert.ok(!JSON.stringify(listAudit()).includes(hook.url), "the webhook's URL isn't audited");
  } finally {
    o.stop();
    await o.idle();
    ledger.close();
    await hook.close();
  }
});

test("a webhook that isn't https (or http on this machine) isn't used", () => {
  const ledger = openLedger(path.join(mkdtempSync(path.join(dataRoot, "case-")), "autopilot.db"));
  try {
    const notifier = (url: string) => createNotifier({ ledger, url, canvasUrl: "http://localhost:8000", record: () => undefined }).enabled;
    assert.deepEqual([notifier("http://hooks.example.com/x"), notifier("ftp://127.0.0.1/x"), notifier("https://hooks.example.com/x"), notifier("http://localhost:9000/x")], [false, false, true, true]);
  } finally {
    ledger.close();
  }
});
