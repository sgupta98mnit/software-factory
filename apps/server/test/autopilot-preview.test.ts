import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.SF_DATA_DIR = mkdtempSync(path.join(tmpdir(), "sf-preview-data-"));
process.env.SF_WORKSPACE = mkdtempSync(path.join(tmpdir(), "sf-preview-unused-"));
delete process.env.SF_AUTONOMY_CAP;
const { findBrowser, runPreview } = await import("../src/autopilot/preview.js");
const { startFakeOpenHands } = await import("../src/demo/fake-agent-server.js");
const { scriptedAgents } = await import("../src/demo/scripted-agents.js");
const { createOrchestrator } = await import("../src/autopilot/orchestrator.js");
const { openLedger } = await import("../src/autopilot/ledger.js");
const { OpenHandsClient } = await import("../src/autopilot/openhands.js");
const { createAutopilotRoutes } = await import("../src/autopilot/routes.js");
const { audit, listAudit } = await import("../src/audit.js");

// A tiny app: 200 with a heading everywhere but /missing, which is a 404.
const APP = `require("node:http").createServer((q, s) => { s.statusCode = q.url === "/missing" ? 404 : 200; s.setHeader("content-type", "text/html"); s.end("<h1>Claims " + q.url + "</h1>"); }).listen(Number(process.env.PORT), process.env.HOST);\n`;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const browser = await findBrowser();

test("runPreview: starts the app on a free port, checks each page, screenshots them, and stops the app", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sf-preview-app-"));
  writeFileSync(path.join(dir, "server.cjs"), APP);
  const out = path.join(dir, "shots");
  const r = await runPreview(dir, { start: "node server.cjs", paths: ["/", "/claims/status?id=7", "/missing"], readyTimeoutSec: 20 }, out, { browser });
  assert.equal(r.error, null);
  assert.deepEqual(r.pages.map((p) => [p.path, p.status, p.ok]), [["/", 200, true], ["/claims/status?id=7", 200, true], ["/missing", 404, false]]);
  assert.equal(r.ok, false);
  if (browser) {
    assert.deepEqual(r.pages.map((p) => p.screenshot), ["1-home.png", "2-claims-status-id-7.png", "3-missing.png"]);
    assert.deepEqual(readFileSync(path.join(out, "1-home.png")).subarray(0, 4), PNG);
    assert.equal(r.noScreenshots, null);
  } else {
    assert.match(r.noScreenshots ?? "", /SF_PREVIEW_BROWSER/);
  }
  const none = await runPreview(dir, { start: "node server.cjs", paths: ["/"], readyTimeoutSec: 20 }, out, { browser: null });
  assert.match(none.noScreenshots ?? "", /No Chromium for screenshots/);
  assert.equal(none.ok, true);
});

test("runPreview: an app that exits, or never answers, is a failed preview with the reason", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sf-preview-app-"));
  const exits = await runPreview(dir, { start: 'node -e "console.error(\'boom\'); process.exit(3)"', paths: ["/"], readyTimeoutSec: 10 }, path.join(dir, "o"), { browser: null });
  assert.equal(exits.ok, false);
  assert.match(exits.error ?? "", /exited \(code 3\) before answering/);
  assert.match(exits.output, /boom/);
  const silent = await runPreview(dir, { start: 'node -e "setInterval(() => {}, 1000)"', paths: ["/"], readyTimeoutSec: 1 }, path.join(dir, "o"), { browser: null });
  assert.match(silent.error ?? "", /Nothing answered on port \d+ within 1 s/);
});

test("a run with preview on: the app runs from the integration branch before release; a failing page keeps release.auto from releasing, and the screenshots are served", { timeout: 240_000 }, async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "sf-preview-ws-"));
  writeFileSync(path.join(workspace, "README.md"), "# Demo\n");
  writeFileSync(path.join(workspace, "server.cjs"), APP);
  mkdirSync(path.join(workspace, ".factory"));
  writeFileSync(path.join(workspace, ".factory", "policy.yml"), 'release: { auto: true }\npreview: { enabled: true, start: "node server.cjs", paths: ["/", "/missing"] }\n');
  const fake = await startFakeOpenHands({ onMessage: scriptedAgents({ noBugs: true }) });
  const ledger = openLedger(":memory:");
  const o = createOrchestrator({ ledger, client: new OpenHandsClient({ baseUrl: fake.url }), workspace, dataDir: mkdtempSync(path.join(tmpdir(), "sf-preview-run-")), graceMs: 0 });
  const app = createAutopilotRoutes(o);
  try {
    const run = await o.createRun({ goal: "Let applicants check a claim's status", autonomy: "autonomous", actor: "user:test" });
    for (let i = 0; i < 150 && ledger.getRun(run.id)?.state !== "done"; i++) {
      for (const item of ledger.listInbox({ runId: run.id })) if (item.kind === "merge_approval") await o.decide(item.id, { choice: "merge" }, "user:isso");
      await o.tick();
      await o.idle();
      await fake.settled();
    }
    const done = ledger.getRun(run.id)!;
    assert.equal(done.state, "done", "not released on its own: the preview failed");
    assert.deepEqual(done.preview?.pages.map((p) => [p.path, p.ok]), [["/", true], ["/missing", false]]);
    assert.equal(done.preview?.sha, done.integrationSha);
    const release = ledger.listInbox({ runId: run.id }).find((i) => i.kind === "release")!;
    assert.match(release.body, /\*\*The last release didn't go through:\*\* The preview failed, so the policy doesn't release it on its own\./);
    assert.match(release.body, /### Preview: some pages failed\n- `\/`: answered 200\n- `\/missing`: \*\*failed\*\* \(404\)/);
    assert.deepEqual(ledger.listChecks({ runId: run.id }).filter((c) => c.stage === "preview").map((c) => c.ok), [false]);
    await audit("test", "test.flush", "test");
    const [event] = listAudit(5000).filter((e) => e.subject === run.id && e.action === "autopilot.preview_run");
    assert.deepEqual(event?.data.pages, [{ path: "/", status: 200, ok: true, screenshot: !!browser }, { path: "/missing", status: 404, ok: false, screenshot: !!browser }]);

    const detail = (await (await app.request(`/runs/${run.id}`)).json()) as { preview: { pages: { screenshot: string | null }[] } };
    if (browser) {
      assert.match(release.body, /!\[\/\]\(\/sf-api\/autopilot\/runs\/ap-[0-9a-f]+\/preview\/1-home\.png\)/);
      const shot = await app.request(`/runs/${run.id}/preview/${detail.preview.pages[0]!.screenshot}`);
      assert.equal(shot.headers.get("content-type"), "image/png");
      assert.deepEqual(Buffer.from(await shot.arrayBuffer()).subarray(0, 4), PNG);
    }
    assert.equal((await app.request(`/runs/${run.id}/preview/..%2F..%2Faudit.jsonl`)).status, 404);
    assert.equal((await app.request(`/runs/${run.id}/preview/9-nothing.png`)).status, 404);
    // The app left nothing behind in the integration branch's tree.
    assert.equal(existsSync(path.join(workspace, "server.cjs")), true);
  } finally {
    o.stop();
    await o.idle();
    await fake.close();
    ledger.close();
  }
});
