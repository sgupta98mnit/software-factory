import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { classify, OpenHandsClient, OpenHandsError } from "../src/autopilot/openhands.js";
import { type FakeHandler, type FakeProfile, startFakeOpenHands } from "./fake-openhands.js";

const CLAUDE: FakeProfile = { id: "11111111-1111-4111-8111-111111111111", name: "claude", agent_kind: "acp", acp_server: "claude-code" };
const CODEX: FakeProfile = { id: "22222222-2222-4222-8222-222222222222", name: "codex", agent_kind: "acp", acp_server: "codex" };
const NATIVE: FakeProfile = { id: "33333333-3333-4333-8333-333333333333", name: "native", agent_kind: "openhands" };

async function withFake(
  opts: Parameters<typeof startFakeOpenHands>[0],
  fn: (fake: Awaited<ReturnType<typeof startFakeOpenHands>>, client: OpenHandsClient) => Promise<void>,
) {
  const fake = await startFakeOpenHands(opts);
  try {
    await fn(fake, new OpenHandsClient({ baseUrl: `${fake.url}/`, apiKey: () => opts?.apiKey }));
  } finally {
    await fake.close();
  }
}

const startInput = (conversationId = randomUUID()) => ({
  conversationId,
  profileId: CLAUDE.id,
  workingDir: path.join(tmpdir(), "sf-wo-2"),
  text: "Build work order 2",
  runId: "ap-12345678",
  role: "builder",
  seq: 2,
});

/** A handler that waits until the test lets it finish. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  const handler: FakeHandler = async () => {
    await opened;
    return { response: "Released.", cost: 0.05 };
  };
  return { handler, open };
}

test("profiles: listed with their ACP backend, resolved by id, name, active pointer and other vendor", () =>
  withFake({ profiles: [CLAUDE, CODEX, NATIVE], activeProfileId: CLAUDE.id }, async (_fake, client) => {
    const { profiles, activeId } = await client.listProfiles();
    assert.equal(activeId, CLAUDE.id);
    assert.deepEqual(profiles, [
      { id: CLAUDE.id, name: "claude", kind: "acp", server: "claude-code" },
      { id: CODEX.id, name: "codex", kind: "acp", server: "codex" },
      { id: NATIVE.id, name: "native", kind: "openhands", server: null },
    ]);

    assert.equal((await client.resolveProfile(CODEX.id)).name, "codex");
    assert.equal((await client.resolveProfile("native")).id, NATIVE.id);
    assert.equal((await client.resolveProfile()).id, CLAUDE.id);
    assert.equal((await client.resolveProfile(null)).id, CLAUDE.id);
    await assert.rejects(client.resolveProfile("missing"), /No agent profile "missing"/);

    // The spec agent ran on claude-code, so the critic prefers another backend.
    assert.equal((await client.resolveProfile(undefined, { avoidServerOf: "claude-code" })).id, CODEX.id);
    // The active profile already differs: keep it.
    assert.equal((await client.resolveProfile(undefined, { avoidServerOf: "codex" })).id, CLAUDE.id);
    // An explicit choice wins over the preference.
    assert.equal((await client.resolveProfile("claude", { avoidServerOf: "claude-code" })).id, CLAUDE.id);
  }));

test("profiles: the active pointer wins, and with one backend only the active profile is the fallback", () =>
  withFake({ profiles: [CLAUDE, { ...CODEX, acp_server: "claude-code" }], activeProfileId: CODEX.id }, async (_fake, client) => {
    assert.equal((await client.resolveProfile()).id, CODEX.id);
    assert.equal((await client.resolveProfile(undefined, { avoidServerOf: "claude-code" })).id, CODEX.id);
  }));

test("profiles: an empty server is an error, not a guess", () =>
  withFake({ profiles: [] }, async (_fake, client) => {
    await assert.rejects(client.resolveProfile(), /no agent profiles/);
  }));

test("start sends the exact body; starting the same id again is idempotent", async () => {
  let calls = 0;
  const sent: { url: string; init: RequestInit }[] = [];
  const fake = await startFakeOpenHands({
    profiles: [CLAUDE],
    onMessage: () => {
      calls++;
      return { response: "Built it.", cost: 0.25 };
    },
  });
  try {
    const recording: typeof fetch = (url, init) => {
      sent.push({ url: String(url), init: init ?? {} });
      return fetch(url, init);
    };
    const client = new OpenHandsClient({ baseUrl: fake.url, fetch: recording });
    const input = startInput();
    const first = await client.start(input);
    assert.equal(first.id, input.conversationId);
    assert.equal(first.status, "running");
    assert.equal(first.workingDir, input.workingDir);

    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.url, `${fake.url}/api/conversations`);
    assert.equal(sent[0]!.init.method, "POST");
    assert.deepEqual(JSON.parse(String(sent[0]!.init.body)), {
      conversation_id: input.conversationId,
      agent_profile_id: CLAUDE.id,
      workspace: { kind: "LocalWorkspace", working_dir: input.workingDir },
      initial_message: { role: "user", content: [{ type: "text", text: "Build work order 2" }], run: true },
      worktree: false,
      confirmation_policy: { kind: "NeverConfirm" },
      max_iterations: 500,
      stuck_detection: true,
      autotitle: false,
      tags: { sfrun: "ap-12345678", sfrole: "builder", sfwo: "2" },
      client_tools: [],
    });

    await fake.settled();
    const again = await client.start(input);
    await fake.settled();
    assert.equal(again.id, input.conversationId);
    assert.equal(again.status, "finished");
    assert.equal(calls, 1);
    assert.deepEqual(fake.conversations.get(input.conversationId)!.messages, ["Build work order 2"]);

    // No work order (spec, critic, validator): the tag is empty.
    await client.start({ ...startInput(), role: "spec", seq: null });
    await fake.settled();
    const spec = [...fake.conversations.values()].find((c) => c.tags.sfrole === "spec");
    assert.equal(spec?.tags.sfwo, "");
  } finally {
    await fake.close();
  }
});

test("get maps status, cost and working dir; an unknown conversation is null", () =>
  withFake({ profiles: [CLAUDE], onMessage: () => ({ response: "ok", cost: 0.25 }) }, async (fake, client) => {
    const input = startInput();
    await client.start(input);
    await fake.settled();
    assert.deepEqual(await client.get(input.conversationId), {
      id: input.conversationId,
      status: "finished",
      costUsd: 0.25,
      workingDir: input.workingDir,
    });
    assert.equal(await client.get(randomUUID()), null);
  }));

test("send: a follow-up runs another turn, adds its cost and replaces the final response", () =>
  withFake({ profiles: [CLAUDE] }, async (fake, client) => {
    const input = startInput();
    await client.start(input);
    await fake.settled();
    assert.equal(await client.finalResponse(input.conversationId), "Done.");

    fake.setHandler((_conv, text) => ({ response: `Fixed: ${text}`, cost: 0.5, status: "stuck" }));
    await client.send(input.conversationId, "The test for scenario X fails");
    await fake.settled();

    const after = await client.get(input.conversationId);
    assert.equal(after?.status, "stuck");
    assert.equal(after?.costUsd, 0.51);
    assert.equal(await client.finalResponse(input.conversationId), "Fixed: The test for scenario X fails");
    assert.deepEqual(fake.conversations.get(input.conversationId)!.messages, ["Build work order 2", "The test for scenario X fails"]);

    await assert.rejects(client.send(randomUUID(), "hello"), (err: unknown) => err instanceof OpenHandsError && err.status === 404 && err.message === "Not Found");
  }));

test("pause and resume; resuming a running conversation is not an error", async () => {
  const slow = gate();
  await withFake({ profiles: [CLAUDE], onMessage: slow.handler }, async (fake, client) => {
    const input = startInput();
    await client.start(input);
    await client.resume(input.conversationId); // 409 from the server: already running

    await client.pause(input.conversationId);
    assert.equal((await client.get(input.conversationId))?.status, "paused");
    slow.open();
    await fake.settled();
    assert.equal((await client.get(input.conversationId))?.status, "paused", "the turn ending doesn't undo the pause");

    await client.resume(input.conversationId);
    assert.equal((await client.get(input.conversationId))?.status, "finished", "the fake re-finishes on the next tick");
    assert.equal(await client.finalResponse(input.conversationId), "Released.");

    // Like the real server, pausing an unknown conversation is a bare 400.
    await assert.rejects(client.pause(randomUUID()), (err: unknown) => err instanceof OpenHandsError && err.status === 400);
  });
});

test("the fake closes even when a turn never ends", async () => {
  const fake = await startFakeOpenHands({ profiles: [CLAUDE], onMessage: () => new Promise<never>(() => {}) });
  await new OpenHandsClient({ baseUrl: fake.url }).start(startInput());
  await fake.close();
});

test("the session key is sent, and without it the server answers 401", () =>
  withFake({ apiKey: "s3cret", profiles: [CLAUDE] }, async (fake, client) => {
    assert.deepEqual(await client.ping(), { ok: true });
    assert.equal((await client.resolveProfile()).id, CLAUDE.id);

    const keyless = new OpenHandsClient({ baseUrl: fake.url });
    await assert.rejects(keyless.listProfiles(), (err: unknown) => err instanceof OpenHandsError && err.status === 401);
    const wrongKey = new OpenHandsClient({ baseUrl: fake.url, apiKey: () => "nope" });
    await assert.rejects(wrongKey.get(randomUUID()), (err: unknown) => err instanceof OpenHandsError && err.status === 401);
    assert.deepEqual(await keyless.ping(), { ok: false, error: "Unauthorized" });
  }));

test("an unreachable server is OpenHandsError with status 0", async () => {
  const fake = await startFakeOpenHands();
  const url = fake.url;
  await fake.close();
  const client = new OpenHandsClient({ baseUrl: url, timeoutMs: 2000 });
  await assert.rejects(
    client.get(randomUUID()),
    (err: unknown) => err instanceof OpenHandsError && err.status === 0 && err.message === `Agent server unreachable at ${url}`,
  );
  const ping = await client.ping();
  assert.equal(ping.ok, false);
  assert.match(ping.error ?? "", /unreachable/);
});

test("classify: end states count only once seen running or after the grace period", () => {
  const sentAt = "2026-10-17T10:00:00.000Z";
  const at = (seconds: number) => new Date(Date.parse(sentAt) + seconds * 1000);
  const fresh = { seenRunning: false, lastSentAt: sentAt };
  const seen = { seenRunning: true, lastSentAt: sentAt };
  const cases: [string, { seenRunning: boolean; lastSentAt: string }, number, string][] = [
    ["running", fresh, 1, "running"],
    ["waiting_for_confirmation", seen, 1, "running"],
    ["finished", seen, 1, "done"],
    ["idle", seen, 1, "done"],
    ["error", seen, 1, "failed"],
    ["stuck", seen, 1, "failed"],
    ["paused", seen, 1, "paused"],
    // A follow-up was just sent and the server still shows the last turn's end.
    ["finished", fresh, 5, "running"],
    ["idle", fresh, 20, "running"],
    ["error", fresh, 5, "running"],
    ["paused", fresh, 5, "running"],
    // Never seen running, but the grace period is over.
    ["finished", fresh, 21, "done"],
    ["idle", fresh, 21, "done"],
    ["stuck", fresh, 21, "failed"],
    ["paused", fresh, 21, "paused"],
    ["unknown", seen, 60, "running"],
  ];
  for (const [status, attempt, seconds, expected] of cases) {
    assert.equal(classify({ status: status as never }, attempt, at(seconds)), expected, `${status} after ${seconds}s, seenRunning=${attempt.seenRunning}`);
  }
  assert.equal(classify({ status: "finished" }, fresh, at(5), 1000), "done", "custom grace");
  // Cold starts: idle with no new events since the message is an agent that hasn't started, for up to three minutes.
  assert.equal(classify({ status: "idle" }, { ...fresh, progressed: false }, at(60)), "running");
  assert.equal(classify({ status: "idle" }, { ...fresh, progressed: false }, at(181)), "done");
  assert.equal(classify({ status: "idle" }, { ...fresh, progressed: true }, at(1)), "done", "it ran between two polls");
  assert.equal(classify({ status: "finished" }, { ...fresh, progressed: false }, at(21)), "done", "finished is never a cold start");
});

test("config: agentServerKey reads the env first, then Canvas's persisted key file, at call time", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "sf-home-"));
  process.env.SF_DATA_DIR = mkdtempSync(path.join(tmpdir(), "sf-data-"));
  const names = ["HOME", "USERPROFILE", "SF_AGENT_SERVER_KEY", "LOCAL_BACKEND_API_KEY"] as const;
  const saved = names.map((name) => [name, process.env[name]] as const);
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.SF_AGENT_SERVER_KEY;
  delete process.env.LOCAL_BACKEND_API_KEY;
  try {
    const { agentServerKey, AGENT_SERVER_URL } = await import("../src/config.js");
    assert.match(AGENT_SERVER_URL, /^http:\/\//);
    assert.equal(agentServerKey(), undefined);

    mkdirSync(path.join(home, ".openhands", "agent-canvas"), { recursive: true });
    writeFileSync(path.join(home, ".openhands", "agent-canvas", "api-key.txt"), "from-file\n");
    assert.equal(agentServerKey(), "from-file");
    process.env.LOCAL_BACKEND_API_KEY = "from-canvas-env";
    assert.equal(agentServerKey(), "from-canvas-env");
    process.env.SF_AGENT_SERVER_KEY = "from-factory-env";
    assert.equal(agentServerKey(), "from-factory-env");
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

/** A stand-in for whatever answers at the URL when it isn't the agent server. */
async function withServer(status: number, contentType: string, body: string, fn: (url: string) => Promise<void>) {
  const server = createServer((_req, res) => {
    res.writeHead(status, { "content-type": contentType });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("Canvas's ingress answering 502 because the agent server behind it is down is status 0 too", () =>
  withServer(502, "text/plain", "Bad Gateway: connect ECONNREFUSED 127.0.0.1:18000", async (url) => {
    const client = new OpenHandsClient({ baseUrl: url });
    await assert.rejects(client.get(randomUUID()), (err: unknown) => err instanceof OpenHandsError && err.status === 0 && /unreachable/.test(err.message));
    assert.equal((await client.ping()).ok, false);
  }));

test("a 200 that isn't JSON (wrong URL) is an OpenHandsError, not a crash or a healthy ping", () =>
  withServer(200, "text/html", "<!doctype html><title>Canvas</title>", async (url) => {
    const client = new OpenHandsClient({ baseUrl: url });
    await assert.rejects(client.listProfiles(), (err: unknown) => err instanceof OpenHandsError && /JSON/.test(err.message));
    await assert.rejects(client.get(randomUUID()), OpenHandsError);
    assert.equal((await client.ping()).ok, false);
  }));
