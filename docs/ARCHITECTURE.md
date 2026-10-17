# How the Software Factory fits together

```
Browser: Agent Canvas (canvas/, our OpenHands clone)
   │  Chat, conversations, settings ........ OpenHands, unchanged
   │  Autopilot: Home · Pipeline · Inbox · Evidence · Policy · Metrics
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
                                          ├── events.ts    Server-Sent Events: "something changed"
                                          └── autopilot/   goal → spec → plan → build → verify → merge → release
                                               ├── orchestrator.ts  state machine, tick() every 3 s
                                               ├── ledger.ts        data/autopilot.db (SQLite): runs, work orders, attempts, checks, inbox
                                               ├── openhands.ts     drives agents as OpenHands conversations (/api)
                                               └── registry.ts      more workspaces: data/workspaces/<id>/

Workspace repo (workspaces/benefits-portal, or SF_WORKSPACE)
   openspec/   requirements: changes/<name>/{proposal,design,tasks}.md + specs/
   backlog/    work orders: tasks/wo-N - Title.md
   .factory/policy.yml   Autopilot's rules, read from the base branch only
   AGENTS.md, CLAUDE.md, .claude/, .agents/   rules and skills the agents load

Factory data (data/, or SF_DATA_DIR; git-ignored)
   audit.jsonl, autopilot.db, worktrees/ (one per run and work order),
   hidden-tests/ (outside every worktree), previews/, workspaces/<id>/
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

Autopilot runs the life of a work order above without a person at each step: a goal becomes a validated OpenSpec change, the change becomes work orders in dependency waves, builders work in their own git worktrees, and the factory checks their work itself before anything merges. `docs/AUTOPILOT.md` describes it for the team using it. `docs/autopilot/DESIGN.md` is the contract: states, API shapes, invariants, and one section per feature.

- **One loop, restartable.** `orchestrator.ts` reads each run's state from the SQLite ledger, takes one step (start an agent, record its result, run gates as a job, merge), and writes the new state, every 3 seconds. A run is handled by one thing at a time. A restart resumes where it stopped: attempts are written before the agent server is called, with a fixed conversation id.
- **Agents are OpenHands conversations.** Each role (spec, critic, validator, builder, reviewer) is a normal Canvas conversation started with a brief from `prompts.ts`, so every transcript and diff stays visible in Canvas. Agents never branch, merge or approve; the factory does, in `git.ts` and `integrator.ts`.
- **The factory checks for itself.** It runs these itself and never takes an agent's word for them:
  - gates (`gates.ts`);
  - secret and dependency scans (`scan.ts`);
  - hidden acceptance tests (`hidden.ts`);
  - the merge policy (`policy.ts`);
  - the preview (`preview.ts`).
- **People decide through the Inbox.** Anything the policy doesn't allow becomes an Inbox item with options and reasons. A person's choice is recorded with their name. The policy's own decisions are recorded as `policy@<hash>`, with a plain-language `why`.
- **The policy lives on the base branch.** `.factory/policy.yml` is read from `refs/heads/<base>` when a run starts and pinned to the run. Release is a person's click unless the policy says `release: { auto: true }` for autonomous runs. A person always merges changes to `openspec/`, `.factory/`, `AGENTS.md` and `CLAUDE.md`.
- **Around the loop:**
  - intake (`intake.ts`: GitHub issues, signed webhooks, the bug form);
  - alerts (`notify.ts`);
  - evidence for assessors (`evidence.ts`);
  - lessons and per-policy insights (`learning.ts`);
  - metrics (`metrics.ts`);
  - the setup checklist and policy templates (`policy-templates.ts`, `explain.ts`);
  - more than one workspace (`registry.ts`).
- **No model needed to try it.** `src/demo/` has a fake agent server and scripted agents. The tests and `pnpm demo` use them, so the whole factory runs with no keys and no network.

## The audit log

`data/audit.jsonl` has one JSON record per line. Each record's `hash` is SHA-256 over the previous record's hash plus its own contents (keys sorted). Editing, deleting or reordering any line breaks every hash after it. **Audit log → Verify chain** recomputes them. Work order files are recorded by content hash each time they change. Agent transcripts stay in OpenHands; the audit log stores the conversation id.

## Security notes

- **OpenHands auto-approves every ACP permission request**, and its defaults start Claude Code in `bypassPermissions` and Codex in `agent-full-access`. Running Canvas without a sandbox (what `pnpm dev` does) means agents can run any command as you. For real agency work, run the agent server in Docker (Canvas README, Option 2) and set `SF_AGENT_WORKSPACE` to the path the container sees.
- The factory API listens on 127.0.0.1 only, rejects other Host headers, and only accepts JSON for changes.
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
| Add an Autopilot step or decision | `apps/server/src/autopilot/orchestrator.ts` (a state, a step, an Inbox kind with its options), then DESIGN.md §3 and §6 |
| Add a policy setting | `DEFAULT_POLICY` and `RULES` in `autopilot/policy.ts`, a sentence in `explain.ts`, the README's policy block. Changing a default changes the default policy's hash |
| Add an Autopilot API | `autopilot/routes.ts`, a method and type in `canvas/src/factory/api.ts`, DESIGN.md §5 |
| Test against agents | `src/demo/fake-agent-server.ts` with a handler, or `scripted-agents.ts`; temp dirs and `openLedger(":memory:")`, no network |

## Next milestones

1. **Sign-in and roles** (product owner, engineer, ISSO) instead of `SF_USER`. The API has no authentication today: anything that can reach 127.0.0.1 can decide, release or change the policy.
2. **Sandboxed agents, gates and previews:** agent server in Docker with the workspace mounted (`SF_AGENT_WORKSPACE`), and gates and the preview run in a container instead of on the host.
3. **Pull requests:** release to a branch and open a pull request instead of merging into the base branch, for teams whose base branch is protected.
4. **A federal OpenSpec schema:** `openspec schema fork` to add a `controls.md` artifact mapped to NIST 800-53, then OSCAL output from the evidence.
5. **Hosted intake:** receive GitHub and other webhooks without a relay you run.

`docs/autopilot/OPEN-ISSUES.md` lists the known defects and the plausible ones not fixed yet.
