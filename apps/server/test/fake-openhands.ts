// A scriptable stand-in for the OpenHands agent server, so Autopilot tests
// never run real agents or touch the network. It speaks the slice of the
// 1.55.1 REST API the driver uses, with the same shapes (costs live in
// stats.usage_to_metrics, the profile listing leaves out acp_server).
// Each user message runs the handler on the next tick; a handler can do real
// work in conv.workingDir (write files, git commit) to play an agent.
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeConversation {
  id: string;
  workingDir: string;
  profileId: string;
  tags: Record<string, string>;
  status: string;
  cost: number;
  messages: string[];
  finalResponse: string;
}

export interface FakeProfile {
  id: string;
  name: string;
  agent_kind: string;
  acp_server?: string;
}

/** `cost` is what this turn adds; `status` is how the turn ends (default finished). */
export type FakeReply = { response?: string; cost?: number; status?: "finished" | "error" | "stuck" | "idle" };
export type FakeHandler = (conv: FakeConversation, text: string) => FakeReply | void | Promise<FakeReply | void>;

const DEFAULT_PROFILE: FakeProfile = { id: "00000000-0000-4000-8000-000000000001", name: "default", agent_kind: "acp", acp_server: "claude-code" };
const done: FakeHandler = () => ({ response: "Done.", cost: 0.01 });

export async function startFakeOpenHands(
  opts: { apiKey?: string; profiles?: FakeProfile[]; activeProfileId?: string | null; onMessage?: FakeHandler } = {},
) {
  const profiles = opts.profiles ?? [DEFAULT_PROFILE];
  const activeId = opts.activeProfileId === undefined ? (profiles[0]?.id ?? null) : opts.activeProfileId;
  const conversations = new Map<string, FakeConversation>();
  const turns = new Set<Promise<void>>();
  let handler = opts.onMessage ?? done;

  const info = (c: FakeConversation) => ({
    id: c.id,
    title: null,
    execution_status: c.status,
    workspace: { kind: "LocalWorkspace", working_dir: c.workingDir },
    tags: c.tags,
    metrics: null,
    stats: { usage_to_metrics: { agent: { model_name: "fake", accumulated_cost: c.cost } } },
  });

  function runTurn(conv: FakeConversation, text: string) {
    conv.messages.push(text);
    conv.status = "running";
    const turn: Promise<void> = new Promise<void>((resolve) => setImmediate(resolve))
      .then(() => handler(conv, text))
      .then(
        (reply) => {
          conv.cost += reply?.cost ?? 0;
          conv.finalResponse = reply?.response ?? conv.finalResponse;
          // A pause during the turn wins, like the real server.
          if (conv.status === "running") conv.status = reply?.status ?? "finished";
        },
        (err: unknown) => {
          conv.finalResponse = err instanceof Error ? err.message : String(err);
          if (conv.status === "running") conv.status = "error";
        },
      )
      .finally(() => turns.delete(turn));
    turns.add(turn);
  }

  async function route(req: IncomingMessage, url: URL): Promise<[number, unknown]> {
    if (opts.apiKey && req.headers["x-session-api-key"] !== opts.apiKey) return [401, { detail: "Unauthorized" }];
    const path = url.pathname;
    const method = req.method ?? "GET";

    if (method === "GET" && path === "/api/agent-profiles") {
      const summaries = profiles.map((p) => ({ id: p.id, name: p.name, agent_kind: p.agent_kind, revision: 0, llm_profile_ref: null, mcp_server_refs: null }));
      return [200, { profiles: summaries, active_agent_profile_id: activeId }];
    }
    const profile = /^\/api\/agent-profiles\/([^/]+)$/.exec(path);
    if (method === "GET" && profile) {
      const p = profiles.find((x) => x.name === decodeURIComponent(profile[1]!));
      return p ? [200, { name: p.name, profile: p }] : [404, { detail: `Agent profile '${profile[1]}' not found` }];
    }

    if (method === "POST" && path === "/api/conversations") {
      const body = (await readJson(req)) as {
        conversation_id?: string;
        agent_profile_id?: string;
        workspace?: { working_dir?: string };
        initial_message?: { content?: { text?: string }[] };
        tags?: Record<string, string>;
      };
      const existing = body.conversation_id ? conversations.get(body.conversation_id) : undefined;
      if (existing) return [200, info(existing)];
      if (!body.workspace?.working_dir) return [422, { detail: [{ msg: "Field required: workspace.working_dir" }] }];
      if (!profiles.some((p) => p.id === body.agent_profile_id)) return [404, { detail: `Agent profile ${body.agent_profile_id} not found` }];
      const conv: FakeConversation = {
        id: body.conversation_id ?? randomUUID(),
        workingDir: body.workspace.working_dir,
        profileId: body.agent_profile_id!,
        tags: body.tags ?? {},
        status: "idle",
        cost: 0,
        messages: [],
        finalResponse: "",
      };
      conversations.set(conv.id, conv);
      const text = body.initial_message?.content?.[0]?.text;
      if (text !== undefined) runTurn(conv, text);
      return [201, info(conv)];
    }

    const m = /^\/api\/conversations\/([^/]+)(?:\/(events|pause|run|agent_final_response))?$/.exec(path);
    const conv = m ? conversations.get(decodeURIComponent(m[1]!)) : undefined;
    // The real server answers an unknown pause with a bare 400, everything else with 404.
    if (m && !conv && method === "POST" && m[2] === "pause") return [400, { detail: "Bad Request" }];
    if (!m || !conv) return [404, { detail: "Not Found" }];
    const action = `${method} ${m[2] ?? ""}`;
    if (action === "GET ") return [200, info(conv)];
    if (action === "GET agent_final_response") return [200, { response: conv.finalResponse }];
    if (action === "POST events") {
      const body = (await readJson(req)) as { content?: { text?: string }[] };
      runTurn(conv, body.content?.[0]?.text ?? "");
      return [200, { success: true }];
    }
    if (action === "POST pause") {
      conv.status = "paused";
      return [200, { success: true }];
    }
    if (action === "POST run") {
      if (conv.status === "running") return [409, { detail: "Conversation already running. Wait for completion or pause first." }];
      conv.status = "running";
      setImmediate(() => {
        if (conv.status === "running") conv.status = "finished";
      });
      return [200, { success: true }];
    }
    return [405, { detail: "Method Not Allowed" }];
  }

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    route(req, new URL(req.url ?? "/", "http://fake"))
      .catch((err: unknown) => [500, { detail: String(err) }] as [number, unknown])
      .then(([status, body]) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  /** Resolves when every turn in flight has finished. */
  async function settled() {
    while (turns.size) await Promise.allSettled([...turns]);
  }

  return {
    url: `http://127.0.0.1:${port}`,
    conversations,
    setHandler(fn: FakeHandler) {
      handler = fn;
    },
    settled,
    async close() {
      // Let handlers finish their work in conv.workingDir, but don't hang a
      // failing test on a turn that can never end (a gate left closed).
      await Promise.race([settled(), new Promise<void>((resolve) => setTimeout(resolve, 5000).unref())]);
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    },
  };
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let text = "";
  for await (const chunk of req) text += chunk;
  return text ? JSON.parse(text) : {};
}
