import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.SF_DATA_DIR = mkdtempSync(path.join(tmpdir(), "sf-notify-data-"));
process.env.SF_WORKSPACE = mkdtempSync(path.join(tmpdir(), "sf-notify-unused-"));
const { channelOf, createNotifier, payload } = await import("../src/autopilot/notify.js");
const { openLedger } = await import("../src/autopilot/ledger.js");

const OPTIONS = [{ id: "approve", label: "Approve" }];

function setup(opts: { webhook?: string | null; status?: () => number; digestHour?: number } = {}) {
  const ledger = openLedger(":memory:");
  const run = ledger.createRun({ goal: "Add a status page", change: "add-a-status-page", autonomy: "supervised", baseBranch: "main", integrationBranch: "autopilot/add-a-status-page", createdBy: "user:test" });
  const sent: { url: string; body: any }[] = [];
  const records: [string, Record<string, unknown>][] = [];
  const clock = { now: new Date(2026, 9, 17, 8) };
  const fake: typeof fetch = async (url, init) => {
    sent.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response("ok", { status: opts.status?.() ?? 200 });
  };
  const notifier = createNotifier({
    ledger,
    config: () => ({ webhook: opts.webhook === undefined ? "https://hooks.slack.com/services/T0/B0/xyz" : opts.webhook, inboxUrl: "http://localhost:8000/inbox", digestHour: opts.digestHour ?? 17 }),
    record: (action, data) => records.push([action, data]),
    fetch: fake,
    now: () => clock.now,
  });
  const open = (title: string) => ledger.openInbox({ runId: run.id, kind: "plan_approval", title, body: "secret goal details", options: OPTIONS, workOrderId: undefined });
  return { ledger, run, sent, records, notifier, open, clock };
}

test("one alert, then a daily digest of what opened since; after the digest the next decision alerts again", async () => {
  const t = setup();
  // Distinct kinds, since the ledger keeps one open item per kind and run.
  const first = t.ledger.openInbox({ runId: t.run.id, kind: "plan_approval", title: "Approve the plan for add-a-status-page", body: "x", options: OPTIONS });
  await t.notifier.opened(first);
  const second = t.ledger.openInbox({ runId: t.run.id, kind: "questions", title: "Questions about add-a-status-page", body: "x", options: OPTIONS });
  await t.notifier.opened(second);
  assert.equal(t.sent.length, 1); // only the first
  assert.match(t.sent[0]!.body.text, /Autopilot needs you\n• Approve the plan for add-a-status-page\nhttp:\/\/localhost:8000\/inbox/);

  t.clock.now = new Date(2026, 9, 17, 9);
  await t.notifier.tick(); // before digestHour
  assert.equal(t.sent.length, 1);
  t.clock.now = new Date(2026, 9, 17, 17, 5);
  await t.notifier.tick();
  assert.equal(t.sent.length, 2);
  assert.match(t.sent[1]!.body.text, /^Autopilot: 2 decision\(s\) wait for you\n• Questions about add-a-status-page\n/);
  assert.ok(!t.sent[1]!.body.text.includes("Approve the plan"), "the alerted item isn't repeated");
  t.clock.now = new Date(2026, 9, 17, 18);
  await t.notifier.tick(); // once a day
  assert.equal(t.sent.length, 2);

  const third = t.ledger.openInbox({ runId: t.run.id, kind: "spec_failed", title: "The spec agent couldn't finish", body: "x", options: OPTIONS });
  await t.notifier.opened(third);
  assert.equal(t.sent.length, 3);
  assert.deepEqual(t.records.map(([a, d]) => [a, d.kind, d.items]), [
    ["autopilot.notification_sent", "alert", 1],
    ["autopilot.notification_sent", "digest", 1],
    ["autopilot.notification_sent", "alert", 1],
  ]);
  // Never the body (goals, notes), never the webhook URL.
  assert.ok(t.sent.every((s) => !JSON.stringify(s.body).includes("secret goal")));
  assert.ok(t.records.every(([, d]) => !JSON.stringify(d).includes("hooks.slack.com")));
  t.ledger.close();
});

test("a failed send isn't recorded and is tried again; no webhook means nothing is sent", async () => {
  let status = 500;
  const t = setup({ status: () => status });
  const item = t.open("Approve the plan");
  await t.notifier.opened(item);
  assert.equal(t.records.length, 0);
  assert.equal(t.ledger.getInbox(item.id)?.notifiedAt, null);
  status = 200;
  await t.notifier.tick(new Date(2026, 9, 17, 17)); // the digest picks it up
  assert.deepEqual(t.records.map(([, d]) => d.kind), ["digest"]);
  assert.ok(t.ledger.getInbox(item.id)?.notifiedAt);
  t.ledger.close();

  const quiet = setup({ webhook: null });
  await quiet.notifier.opened(quiet.open("Approve the plan"));
  await quiet.notifier.tick(new Date(2026, 9, 17, 23));
  assert.equal(quiet.sent.length, 0);
  quiet.ledger.close();
});

test("channels: Slack text, a Teams Adaptive Card with a link to the Inbox, plain JSON otherwise", () => {
  assert.equal(channelOf("https://hooks.slack.com/services/T/B/x"), "slack");
  assert.equal(channelOf("https://contoso.webhook.office.com/webhookb2/abc"), "teams");
  assert.equal(channelOf("https://prod-12.westus.logic.azure.com/workflows/x"), "teams");
  assert.equal(channelOf("http://127.0.0.1:9000/hook"), "json");
  const card = payload("teams", "Autopilot needs you", ["Merge WO-3"], "http://localhost:8000/inbox") as any;
  const content = card.attachments[0].content;
  assert.equal(content.type, "AdaptiveCard");
  assert.deepEqual(content.body.map((b: any) => b.text), ["Autopilot needs you", "• Merge WO-3"]);
  assert.equal(content.actions[0].url, "http://localhost:8000/inbox");
  assert.deepEqual(payload("json", "T", ["a"], "L"), { title: "T", lines: ["a"], link: "L", text: "T\n• a\nL" });
});

test("ledger v2: meta values persist and are replaced", () => {
  const ledger = openLedger(":memory:");
  assert.equal(ledger.getMeta("x"), null);
  ledger.setMeta("x", "1");
  ledger.setMeta("x", "2");
  assert.equal(ledger.getMeta("x"), "2");
  ledger.close();
});

test("in a run: the first decision that opens is posted to the team's webhook; /status says where alerts go", async () => {
  const { startFakeOpenHands } = await import("../src/demo/fake-agent-server.js");
  const { scriptedAgents } = await import("../src/demo/scripted-agents.js");
  const { createOrchestrator } = await import("../src/autopilot/orchestrator.js");
  const { OpenHandsClient } = await import("../src/autopilot/openhands.js");
  const { writeFileSync } = await import("node:fs");
  const posts: { url: string; body: any }[] = [];
  const fake = await startFakeOpenHands({ onMessage: scriptedAgents() });
  const ledger = openLedger(":memory:");
  const workspace = mkdtempSync(path.join(tmpdir(), "sf-notify-ws-"));
  writeFileSync(path.join(workspace, "README.md"), "# Demo\n");
  process.env.SF_NOTIFY_WEBHOOK = "https://contoso.webhook.office.com/webhookb2/abc";
  process.env.SF_PUBLIC_URL = "http://factory.local:8000/";
  const o = createOrchestrator({
    ledger,
    client: new OpenHandsClient({ baseUrl: fake.url }),
    workspace,
    dataDir: mkdtempSync(path.join(tmpdir(), "sf-notify-run-")),
    graceMs: 0,
    notifyFetch: async (url, init) => {
      posts.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response("1", { status: 200 });
    },
  });
  try {
    assert.deepEqual((await o.status()).notifications, { channel: "teams", digestHour: 17 });
    const run = await o.createRun({ goal: "Let applicants check a claim's status", actor: "user:test" });
    for (let i = 0; i < 40 && !posts.length; i++) {
      await o.tick();
      await o.idle();
      await fake.settled();
    }
    assert.equal(posts.length, 1);
    assert.equal(posts[0]!.url, "https://contoso.webhook.office.com/webhookb2/abc");
    const card = posts[0]!.body.attachments[0].content;
    assert.equal(card.body[1].text, `• Approve the plan for ${run.change}`);
    assert.equal(card.actions[0].url, "http://factory.local:8000/inbox");
  } finally {
    delete process.env.SF_NOTIFY_WEBHOOK;
    delete process.env.SF_PUBLIC_URL;
    o.stop();
    await o.idle();
    await fake.close();
    ledger.close();
  }
});
