# How the Software Factory fits together

```
Browser: Agent Canvas (canvas/, our OpenHands clone)
   │  Chat, conversations, settings ........ OpenHands, unchanged
   │  Requirements · Work orders · Audit log  canvas/src/factory/ (ours)
   │
   ▼  http://localhost:8000  (Canvas ingress)
   ├── /api, /sockets ──▶ OpenHands agent server (Python, started by Canvas with uv)
   │                          └─ spawns Claude Code / Codex over ACP, in the workspace folder
   └── /sf-api ─────────▶ Vite proxy ─▶ Factory API (apps/server, Node + Hono, 127.0.0.1:4317)
                                          ├── openspec.ts  runs `openspec … --json`
                                          ├── planner.ts   tasks.md → work orders
                                          ├── backlog.ts   reads backlog/tasks/*.md, edits via `backlog` CLI, watches the folder
                                          ├── briefs.ts    the first message an agent gets
                                          ├── audit.ts     data/audit.jsonl (hash chain)
                                          └── events.ts    Server-Sent Events: "something changed"

Workspace repo (workspaces/benefits-portal, or SF_WORKSPACE)
   openspec/   requirements: changes/<name>/{proposal,design,tasks}.md + specs/
   backlog/    work orders: tasks/wo-N - Title.md
   AGENTS.md, CLAUDE.md, .claude/, .agents/   rules and skills the agents load
```

## The split

**OpenHands does the agents.** Canvas already runs Claude Code, Codex, Gemini CLI and its own agent, through the Agent Client Protocol (ACP). It reuses the logins on your machine, streams every step, and keeps conversation history. We don't rebuild any of that.

**We add the factory around it:** requirements you can read, work orders an agent picks up, a person's approval at the end, and a tamper-evident record of what happened. Those live in plain files in the workspace (OpenSpec and Backlog.md own their formats), so everything also has git history.

**Our Canvas changes stay in one folder.** `canvas/src/factory/` holds the pages; three upstream files get a line or two each (routes, sidebar, Vite proxy). That keeps `git pull` from OpenHands simple. `patches/canvas-factory.patch` stores the same changes in this repo, so `pnpm setup:canvas` can rebuild `canvas/` from scratch.

## Life of a work order

1. **Requirements → Create work orders.** The API reads the change's `tasks.md`: one work order per `## N.` group, checklist items become acceptance criteria, each depends on the previous one, and NIST 800-53 controls from `design.md`'s Controls table become `control:` labels. You see the plan first; confirming creates them with `backlog task create` and records `work_orders.created_from_change` with your name.
2. **Work orders → Start with an agent.** You pick an agent profile (Claude Code, Codex, OpenHands…). The API writes a brief that points the agent at the work order, the OpenSpec change and `AGENTS.md`, and tells it to keep the work order current with the Backlog.md CLI. Canvas starts a normal conversation in the workspace folder with that brief. The API records `work_order.conversation_started`, and the work order links to the conversation.
3. **The agent works in Canvas.** As it runs `backlog task edit WO-1 --status "In Progress"`, `--check-ac 1`, `--final-summary …`, the API's file watcher hashes each change into the audit log and tells open pages to refresh (SSE), so the board moves while you watch.
4. **You approve.** Approve moves it to the last status (Done) through the CLI and records `work_order.approved` with your name and note.
5. **If anything else marks it Done** (an agent, a hand edit), the watcher records `work_order.done_without_approval` and the board shows **Not approved** until a person approves it or moves it back.

## Autopilot

`apps/server/src/autopilot/` adds a SQLite-backed orchestrator around OpenHands conversations: goal → specification/critic → plan → builders in isolated Git worktrees → gates/reviewer/repair → serialized merge and integration gates. The resulting integration branch remains available after worktree cleanup. Worktrees separate Git changes; they do not sandbox processes or credentials. `execution.ts` decides where agents and gates run: locally (the default, labelled as not isolated) or, with `execution.provider: container`, in one hardened agent-server container per attempt and throwaway gate containers, refused when its preflight fails. A run pins its checks from the base branch at creation; `verify` restores protected paths, runs the pinned gates, then scans (Trivy, `scanner.ts`) and runs a test writer's hidden tests on a clean checkout of the commit, and records a commit-bound `verified` check that merging requires. Follow-up messages go through a `commands` outbox written with the state change behind them and reconciled by a marker after a lost answer; a scheduler lease with generation fencing keeps a second process on the same data folder standing by. With `delivery.mode: github`, finished runs go to `delivering`: `github.ts` pushes the branch (fast-forward only) and keeps one draft pull request whose CI and reviews on the pushed head either finish the run or become fix work orders through the same pipeline. Budget holds and human decisions persist in the ledger, with actions recorded in the audit log.

Governance sits around that pipeline. `auth.ts` signs people in (this machine's user by default, or OpenID Connect with `SF_AUTH=oidc`), and every change checks the role it needs; each Inbox kind names the role that decides it. A new agent starts only when its run, its work order and the day have room for its budget reservation. With `governance` in the policy, an ISSO approves each verified commit that implements mapped controls before it can merge, and a release manager other than the run's creator approves the commit a finished run ends with. `evidence-store.ts` keeps evidence packets, release envelopes, attestations and assessment results write-once under `data/evidence/`. `attest.ts` signs in-toto statements with the factory's own Ed25519 key and writes OSCAL assessment results, each only when the facts behind it are recorded. `backup.ts` backs up and restores the ledger, the audit log and the evidence, and `notify.ts` posts new Inbox items and a daily digest to a webhook.

Canvas's Autopilot run page can download evidence for terminal runs through `POST /sf-api/autopilot/runs/:id/evidence`. The orchestrator serializes generation with run actions; `evidence.ts` combines a ledger snapshot with a verified, queued audit snapshot. It identifies the artifact using a recorded terminal commit, excludes raw prompts/results/output/notes, and audits the exported packet's digest. Historical checks lack commit binding, and the unsigned packet marks security scanning and independent validation as unrecorded.

The [roadmap](autopilot/ROADMAP.md) describes the selected open-source approaches and the remaining isolation, trusted verification, recovery, PR and governance work. It supersedes the older milestone list below for Autopilot development.

## The audit log

`data/audit.jsonl` has one JSON record per line. Each record's `hash` is SHA-256 over the previous record's hash plus its own contents (keys sorted). Editing, deleting or reordering any line breaks every hash after it. **Audit log → Verify chain** recomputes them. Work order files are recorded by content hash each time they change. Agent transcripts stay in OpenHands; the audit log stores the conversation id.

## Security notes

- **OpenHands auto-approves every ACP permission request**, and its defaults start Claude Code in `bypassPermissions` and Codex in `agent-full-access`. Running Canvas without a sandbox (what `pnpm dev` does) means agents can run any command as you. For real agency work, run the agent server in Docker (Canvas README, Option 2) and set `SF_AGENT_WORKSPACE` to the path the container sees.
- The factory API listens on 127.0.0.1 only, rejects other Host headers, and only accepts JSON for changes.
- With `SF_AUTH=oidc`, every request but sign-in needs a person's session, and each change checks that person's roles. In local mode (the default) this machine's user holds every role.
- Keys stay on this machine: `data/runtime.key` (container session keys) and `data/signing/` (the attestation key) never go into a backup, the audit log, evidence or a response, except the attestation key's public half.
- Telemetry: `pnpm setup:canvas` writes `VITE_DO_NOT_TRACK=1` to `canvas/.env`, which stops Canvas's PostHog client. OpenSpec runs with `OPENSPEC_TELEMETRY=0`.
- With telemetry off, the browser still contacts Google Fonts and the npm registry (Canvas's update check). For an offline or locked-down network, self-host the fonts and turn off the update check.
- The agent server runs `git init` in a workspace that isn't a git repo, the first time a conversation starts there, for its Changes tab.

## Where to extend

| You want to | Change |
| --- | --- |
| Add a factory page | `canvas/src/factory/routes/`, a route in `canvas/src/routes.ts`, a link in `factory-nav-links.tsx` |
| Add an API | `apps/server/src/index.ts`, plus a method in `canvas/src/factory/api.ts` |
| Change how work orders are split | `apps/server/src/planner.ts` |
| Change what agents are told | `apps/server/src/briefs.ts`, and the conventions block in the workspace's `AGENTS.md` / `CLAUDE.md` |
| Add a gate (for example, no approval until every criterion is checked) | `setStatus` in `apps/server/src/backlog.ts` |
| Record something new | `audit(actor, action, subject, data)`, plus a label in `canvas/src/factory/copy.ts` |

## Next milestones

1. **Sandboxed agents:** agent server in Docker, workspace mounted, `SF_AGENT_WORKSPACE` set.
2. **Gates:** approval only when acceptance criteria are checked and tests passed; ISSO sign-off for work orders with controls.
3. **Git worktree per work order:** Canvas can already start a conversation in a new worktree; wire it to branches and pull requests.
4. **A federal OpenSpec schema:** `openspec schema fork` to add a `controls.md` artifact mapped to NIST 800-53, then OSCAL output.
5. **Sign-in and roles** (product owner, engineer, ISSO) instead of `SF_USER`.
