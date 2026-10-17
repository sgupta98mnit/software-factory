import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.SF_DATA_DIR = mkdtempSync(path.join(tmpdir(), "sf-setup-data-"));
process.env.SF_WORKSPACE = mkdtempSync(path.join(tmpdir(), "sf-setup-unused-"));
delete process.env.SF_NOTIFY_WEBHOOK;
const { startFakeOpenHands } = await import("../src/demo/fake-agent-server.js");
const { createOrchestrator } = await import("../src/autopilot/orchestrator.js");
const { openLedger } = await import("../src/autopilot/ledger.js");
const { OpenHandsClient } = await import("../src/autopilot/openhands.js");
const { createAutopilotRoutes } = await import("../src/autopilot/routes.js");
const { commitAll, fileAt, git } = await import("../src/autopilot/git.js");
const { loadPolicy, parsePolicy } = await import("../src/autopilot/policy.js");
const { POLICY_TEMPLATES, templateById } = await import("../src/autopilot/policy-templates.js");
const { audit, listAudit } = await import("../src/audit.js");

test("every policy template is a valid policy that leaves release to a person", () => {
  assert.deepEqual(POLICY_TEMPLATES.map((t) => t.id), ["recommended", "cautious", "federal", "autonomous"]);
  for (const t of POLICY_TEMPLATES) {
    const policy = parsePolicy(t.yaml);
    assert.equal(policy.release.auto, false, t.id);
    assert.match(t.yaml, /release: \{ auto: false \}/, `${t.id} says so in the file`);
    assert.ok(t.summary.length > 20);
  }
  assert.equal(parsePolicy(templateById("cautious")!.yaml).autonomy.max, "supervised");
  assert.equal(parsePolicy(templateById("federal")!.yaml).intake.webhook, "off");
  assert.ok(parsePolicy(templateById("federal")!.yaml).autoMerge.sensitivePaths.includes("**/*.sql"));
});

test("the setup checklist from a bare folder: each fix in turn, files committed to the base branch as the person, refusals that explain", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "sf-setup-ws-"));
  writeFileSync(path.join(workspace, "README.md"), "# Demo\n");
  const fake = await startFakeOpenHands();
  const ledger = openLedger(":memory:");
  const o = createOrchestrator({ ledger, client: new OpenHandsClient({ baseUrl: fake.url }), workspace, dataDir: mkdtempSync(path.join(tmpdir(), "sf-setup-run-")), graceMs: 0 });
  const app = createAutopilotRoutes(o);
  const get = async () => (await (await app.request("/setup")).json()) as { id: string; ok: boolean; optional?: boolean; title: string; fix: { id: string; label: string } | null }[];
  const fix = async (id: string, body: unknown = {}) => {
    const res = await app.request(`/setup/${id}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
    return { status: res.status, json: (await res.json()) as any };
  };
  const item = (list: Awaited<ReturnType<typeof get>>, id: string) => list.find((i) => i.id === id)!;
  try {
    let list = await get();
    assert.deepEqual(list.map((i) => i.id), ["agent-server", "workspace", "policy", "gates", "agents-md", "alerts"]);
    assert.equal(item(list, "agent-server").ok, true);
    assert.deepEqual([item(list, "workspace").ok, item(list, "workspace").fix?.id], [false, "init-repo"]);
    assert.equal(item(list, "policy").fix, null, "a policy needs a repo first");
    assert.deepEqual([item(list, "alerts").ok, item(list, "alerts").optional], [false, true]);
    assert.match((await fix("policy")).json.error, /git repo \(on a branch\) first/);

    list = (await fix("init-repo")).json;
    assert.equal(item(list, "workspace").ok, true);
    assert.deepEqual([item(list, "policy").ok, item(list, "policy").fix?.label], [false, "Add the recommended policy to main"]);
    assert.deepEqual([item(list, "agents-md").ok, item(list, "gates").ok], [false, false]);

    list = (await fix("policy")).json;
    assert.equal(item(list, "policy").ok, true);
    const { policy, source } = await loadPolicy(workspace, "main");
    assert.equal(source, ".factory/policy.yml@main");
    assert.deepEqual(policy, parsePolicy(templateById("recommended")!.yaml));
    assert.match((await git(workspace, ["log", "-1", "--format=%s", "main"])).stdout.trim(), /^factory: the recommended policy \(local\)$/);
    assert.match((await fix("policy")).json.error, /already a policy on main/);

    list = (await fix("agents-md")).json;
    assert.equal(item(list, "agents-md").ok, true);
    assert.match((await fileAt(workspace, "refs/heads/main", "AGENTS.md")) ?? "", /^# Instructions for agents/);

    writeFileSync(path.join(workspace, "package.json"), JSON.stringify({ name: "x", private: true, scripts: { test: "node --test" } }));
    await commitAll(workspace, "Add a test script");
    assert.deepEqual([item(await get(), "gates").ok, item(await get(), "gates").title], [true, "Gates: test"]);

    // A dirty checkout of the base branch isn't overwritten.
    await git(workspace, ["rm", "-q", "AGENTS.md"]);
    await commitAll(workspace, "No AGENTS.md after all");
    writeFileSync(path.join(workspace, "README.md"), "# Demo, edited\n");
    assert.match((await fix("agents-md")).json.error, /uncommitted changes on `main`/);
    assert.match((await fix("nothing")).json.error, /no setup fix called "nothing"/);

    await audit("test", "test.flush", "test");
    const written = listAudit(5000).filter((e) => e.action === "autopilot.policy_written" || e.action === "autopilot.agents_md_written" || e.action === "autopilot.workspace_initialized").reverse();
    assert.deepEqual(written.map((e) => [e.action, e.actor]), [
      ["autopilot.workspace_initialized", "user:local"],
      ["autopilot.policy_written", "user:local"],
      ["autopilot.agents_md_written", "user:local"],
    ]);
    assert.equal(written[1]!.data.template, "recommended");
  } finally {
    o.stop();
    await o.idle();
    await fake.close();
    ledger.close();
  }
});
