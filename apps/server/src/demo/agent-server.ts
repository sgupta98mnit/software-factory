// A fake OpenHands agent server with the scripted agents, for the demo and
// for working on the Canvas pages without model logins:
//
//   pnpm --filter @sf/server fake-agents        (port 18100, 2 s per turn)
//
// Point the factory API at it with SF_AGENT_SERVER_URL=http://127.0.0.1:18100.
// It listens on 127.0.0.1 only and never calls a model.
import { startFakeOpenHands } from "./fake-agent-server.js";
import { scriptedAgents } from "./scripted-agents.js";

const port = Number(process.env.SF_FAKE_AGENT_PORT ?? 18100);
const turnMs = Number(process.env.SF_FAKE_AGENT_TURN_MS ?? 2000);

const server = await startFakeOpenHands({
  port,
  onMessage: scriptedAgents({ turnMs }),
  profiles: [
    { id: "00000000-0000-4000-8000-00000000c1a0", name: "Scripted Claude Code", agent_kind: "acp", acp_server: "claude-code" },
    { id: "00000000-0000-4000-8000-00000000c0de", name: "Scripted Codex", agent_kind: "acp", acp_server: "codex" },
  ],
});
console.log(`Fake agent server (scripted agents, ${turnMs} ms a turn) on ${server.url}`);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => void server.close().finally(() => process.exit(0)));
}
