# Autopilot: research findings and a proposal

Claude, 17 Oct 2026. Sources are vendor docs and engineering posts read that
day (list at the end). Web search was unavailable, so this covers what the
docs say, not user reviews. Codex's answers to `docs/RESEARCH_BRIEF.md` can
fill that gap.

**In short:** nobody ships the whole chain from goal to release, local-first.
The pieces exist, and most of them are proven. The proposal is **Autopilot**: our factory API
becomes a deterministic orchestrator that runs OpenHands conversations as
workers. A person types a goal and only hears back when the factory gets stuck,
or when a change is too risky for the policy to merge on its own.

---

## 1. What the leaders do (shipped, as of Oct 2026)

| Product | How far it goes alone | Patterns worth copying |
| --- | --- | --- |
| **Factory** (Missions, Software Factory) | One plan approval, then orchestrator → workers → validators across milestones. Autonomy levels Off/Low/Medium/High, with an org cap | Approving the plan also sets the autonomy level. Amber "needs response" status. Automations pause after 5 consecutive failures, with one email then a daily digest |
| **Factory research** (27 Aug 2026) | A validator builds a hidden test "instrument" before any code is written. The implementer never sees it, and the validator can extend it but never weaken it | **Hidden acceptance tests**. The cost: runs took far longer (8.5h → 96h in one case) |
| **8090** | Requirements → Blueprints → Work Orders; outside tools (Claude Code, Cursor) pull work orders over MCP | A traceability graph and a "Drift Bot" that flags stale content. It stops at work orders and doesn't execute |
| **Devin** (Managed Devins) | A coordinator splits work across child sessions in parallel VMs and is notified when a child finishes or needs input | Optional approval per batch. The reviewer fixes its own findings before posting. Status chips in Slack and Teams |
| **Kiro** (AWS) | Spec (requirements, design, tasks) → "Run all tasks" builds a dependency graph and runs it in **waves** (in order, parallel within a wave). Autonomous mode moves unclear tasks to "Needs attention" | Waves, and a "Needs attention" state. Denied commands are never bypassed |
| **Cursor** | Cloud agents in parallel VMs. Fixes CI on its own PRs (up to 10 follow-ups, stops if a human pushes). **Auto-approves PRs below a risk threshold**, never when security or Bugbot findings exist | `APPROVAL_POLICY.md` read from the **base branch**, so a PR can't relax its own rules. Agents can wait on events (a review, a Slack reply) |
| **Codex** | `/goal` runs long tasks, pauses for decisions and notifies you. Scheduled tasks act as an inbox | The goal doubles as the completion criteria |
| **Copilot** | One task → one branch → one draft PR. It can't approve or merge itself, and the requester can't approve | Guardrails built into the platform |
| **Jules** | Plans auto-approve after a timeout, then a Planning Critic reviews them | A critic that replaces the plan-approval click |

**Gaps nobody fills**, which are our opening:

1. **Goal to merged, end to end.** 8090 stops at work orders. Copilot, Codex and Cursor start from a single task.
2. **Local-first.** Execution is vendor-hosted almost everywhere.
3. **Deterministic merging of parallel work.** Devin "compiles results", and the others don't document it.
4. **Verification contracts as code.** Acceptance criteria are prose everywhere except Factory's research harness.
5. **Spec drift.** 8090 work orders don't update when blueprints change.
6. **Cost ledger.** Every vendor uses its own opaque credits.

## 2. What the evidence says about autonomy

- **Separate the builder from the judge.** Agents grading their own work "reliably skew positive". A skeptical evaluator in a clean context works better. Restrict it to correctness and requirements, or it invents gaps. (Anthropic, Mar 2026; Claude Code best practices)
- **Agree on "done" before building.** Anthropic's planner → generator → evaluator harness had the builder and judge agree on testable criteria first. Factory hides the tests from the builder entirely. **OpenSpec's WHEN/THEN scenarios are exactly the raw material for this.**
- **Retry limits:** after 2 failed corrections, start a fresh context with a better prompt (Anthropic). Cursor caps CI autofix at 10 follow-ups and Bugbot at 3 attempts.
- **Autonomy costs more, and it's worth it:**
  - Anthropic's harness ran 6h for $200, against 20 min for $9 solo. The solo run's core feature didn't work.
  - Factory's system ran roughly 10x longer than a single agent.
  - So budget per work order and show cost live.
- **Parallel agents conflict.** Anthropic's 16-agent C compiler run had frequent merge conflicts, and agents broke existing features until CI was added. **Integrate one at a time and re-test after each merge.**
- **No one publishes thresholds for auto-merge.** Cursor's policy-file approach is the best model. The default policy below is our proposal.

## 3. What OpenHands gives us vs. what we build

Reuse:

- **Workers:** `POST /api/conversations` with `agent_profile_id` (Claude Code or Codex), `workspace.working_dir`, `worktree: true` and `initial_message`.
  - Status (`idle/running/finished/error/stuck`), `metrics.accumulated_cost`, and `agent_final_response`.
  - Follow-up messages go to `/events`; pause with `/pause`.
  - **Every run shows up in Canvas** with its transcript and diff, which is a big usability win.
- **Isolation:** `worktree: true` puts each run on its own `openhands/<id>` branch under a per-conversation folder.
- **Triggers (later):** the automation service's cron, GitHub/Jira events and signed webhooks, for bug-report and feedback intake.

Build (OpenHands doesn't do these):

- A durable DAG/queue orchestrator. Automations can't chain runs, and their presets ignore ACP agent profiles.
- Deterministic gates, merge, branch cleanup and PRs. Today Canvas's "Git actions" are just prompts, and worktree branches are left behind.
- Result handoff from Claude Code and Codex workers: poll or subscribe per conversation, since webhooks are server-wide.
- Governance for ACP workers, whose permission requests are auto-approved: hidden tests outside the worktree, gates run by us rather than the agent, and Docker later.

## 4. The proposal: Autopilot

```
 Goal ──▶ Spec ──▶ Plan ──▶ Build (waves) ──▶ Verify ──▶ Integrate ──▶ Preview
  you    spec agent  planner   builders in       gates +      merge one at   app running,
         + critic    (waves,   worktrees, 1 per  hidden tests a time, re-test screenshots
                     risk)     work order        + reviewer
                                     ▲                │
                                     └── repair ◀─────┘  (2 tries, then fresh, then Inbox)
```

**Roles.** Each is an OpenHands conversation, except the planner and the gates:

| Role | Does | Model choice (default) |
| --- | --- | --- |
| Spec agent | Writes the OpenSpec change. In Autonomous mode it records assumptions in the proposal instead of asking. Must pass `openspec validate --strict` | Strong (Claude Opus / GPT-5.x) |
| Spec critic | Checks for untestable scenarios, missing error cases and accessibility. Replaces the plan-approval click in Autonomous mode (Jules pattern) | A different vendor than the spec agent |
| Planner | Our deterministic `planner.ts`, plus a dependency graph → waves (Kiro) and a risk score per work order | No model |
| Validator | Turns each scenario into **hidden acceptance tests** stored in the factory's data folder, outside every worktree. It can add tests, never weaken them (Factory) | Strong |
| Builder | One per work order, in its own worktree. Gets the brief. Runs in parallel within a wave, up to N at once | Routed by risk: small/low → cheaper model |
| Gates | Run by the orchestrator, not the agent: typecheck, lint, unit tests, hidden acceptance tests, secrets/dependency scans, axe for UI changes. Mutation testing (Stryker, incremental) later | No model |
| Reviewer | Clean context, other vendor (Codex reviews Claude, and vice versa). JSON verdict: pass/fail, severity, findings tied to scenarios | Strong |
| Integrator | Merges approved branches into the integration branch **one at a time**, re-runs the full suite, reverts and re-queues on failure. A conflict spawns a rebase run | No model (+ a builder for conflicts) |

**Repair loop:** the builder gets *clustered findings* ("Scenario 'Unknown claim': expected 404, got 500"), never the hidden tests. It gets two tries in the same conversation, then one fresh conversation with a sharper brief. After that the work order goes to the Inbox.

**Autonomy dial**, per project, with an org-wide cap:

| Level | A person… |
| --- | --- |
| Suggest | approves the spec, the plan and every merge |
| **Supervised** (default) | approves the plan with one click. Merges follow the policy |
| Autonomous | writes the goal. The critic approves the plan. The person sees only the Inbox and the release button |

Release to production stays a person's click at every level by default. On federal systems a named release approver is the norm, so it's a setting, not a hard rule.

**Default auto-merge policy** (our proposal; no vendor publishes one). Kept in `.factory/policy.yml`, **read from the base branch**. Auto-merge only when **all** of these hold:

- All gates are green, the hidden acceptance tests pass, and the reviewer verdict is pass with no severe findings.
- No secret or vulnerable-dependency findings, and no new dependencies outside an allowlist.
- No changed files under sensitive paths: `auth/`, `crypto/`, infrastructure, CI config, `.factory/`, `AGENTS.md`, migrations.
- The change is under 400 changed lines.

Anything else goes to the Inbox as a one-click decision with a summary. **Policy merges are recorded in the audit log as `actor: policy@<hash>`**, so automated approvals are as traceable as human ones.

**Escalation (what reaches a person):**

- questions the spec agent couldn't settle with an assumption (batched)
- a work order that failed after the fresh retry
- a policy-blocked merge
- budget reached for a work order or a change
- 3 failing work orders in one change (auto-pause)

Notifications follow Factory's rule: one alert, then a daily digest.

**Budgets:** per work order and per change, in dollars, taken from `metrics.accumulated_cost`. Show a live cost and ETA, and pause on reaching the limit.

## 5. Screens

You have 3 today; Autopilot adds 6.

1. **Home: "What should we build?"** Goal box, autonomy dial, budget, project. *(Factory Spec Mode, Codex /goal)*
2. **Pipeline (mission control)** for a change. Stage lanes Spec → Plan → Build → Verify → Integrate → Preview, a wave view, live agent cards (status, attempt, cost), and an ETA. *(Factory Mission Control, Kiro waves)*
3. **Inbox ("Needs you")**: escalations only, each a card with the decision buttons. Badge in the sidebar. *(Kiro "Needs attention", Factory amber status)*
4. **Run timeline** inside a work order: attempts, gate results, reviewer verdict, diff, cost, a link to the Canvas conversation. *(Devin progress, Cursor artifacts)*
5. **Evidence**: scenario ↔ hidden test ↔ code ↔ approval (human or policy), exportable. This is the federal differentiator. *(8090 traceability graph)*
6. **Policy and autonomy settings**: levels, sensitive paths, budgets, model routing. *(Cursor APPROVAL_POLICY.md, Factory org cap)*
7. Requirements, Work orders, Audit log (existing). They gain live stage badges, a "drift" flag when a spec changes after planning, and policy approvals in the log.

## 6. Roadmap

Effort is a rough guess for one engineer working with agents.

**MVP: Autopilot for one change (about 2–3 weeks).** Done when you can type a goal and get a merged integration branch, with no clicks except the goal (Autonomous) or one plan approval (Supervised).

| Feature | Days |
| --- | --- |
| Run ledger in SQLite (`node:sqlite`): changes, work orders, attempts, states; resumable after restart | 2 |
| Conversation driver: create, poll, follow-up, pause, cost, from the factory API | 2 |
| Spec agent + `openspec validate` loop + critic | 2 |
| Waves + builder dispatch in worktrees (max 3 in parallel) | 2 |
| Gates (typecheck/lint/test) + reviewer verdict + repair loop | 3 |
| Integrator (one-at-a-time merge, re-test, revert) + branch cleanup | 2 |
| Inbox + Pipeline screens, sidebar badge | 3 |
| Policy file + policy approvals in the audit log | 1 |

**v1: trust and scale (about 3–4 weeks)**

- Hidden acceptance tests (validator)
- Stryker incremental mutation score as a gate
- Secret and dependency scans
- axe accessibility checks and screenshots
- Model routing and budgets
- Teams/Slack/email digest
- Evidence screen
- Docker sandbox for builders

**v2: closed loop**

- Bug reports, errors and feedback become new changes (OpenHands automations: webhooks, GitHub, cron)
- Spec drift → automatic re-plan
- Lessons from repeated failures proposed as `AGENTS.md` edits
- Preview deploys
- Multiple projects

## 7. Decisions to make

1. **How workers run.** OpenHands conversations, which keep the Canvas transcript and diff for every run. The alternative is calling the Claude Agent SDK and `codex exec` directly, which gives hooks, budgets and structured output, but no Canvas visibility. **Recommend OpenHands conversations**, with the guarantees enforced outside the agent: hidden tests, gates and merging are all ours.
2. **Durable orchestration.** Start with our own state machine in SQLite. Move to **Temporal** (MIT) when this becomes hosted. Avoid Inngest (server SSPL) and Restate (BSL) for licensing reasons.
3. **Integration target.** A local integration branch first. GitHub PRs and a merge queue come when you have a remote. The merge queue needs GitHub Enterprise Cloud for private repos.

## Sources (read 17 Oct 2026)

- Factory:
  - Spec Mode and autonomy: https://docs.factory.com/docs/autonomy-and-safety/specification-mode
  - Missions: https://docs.factory.com/missions/overview
  - Software Factory: https://docs.factory.com/software-factory/overview
  - Hidden-validator research (27 Aug 2026): https://factory.com/news/what-it-takes-for-coding-agents-to-complete-large-software-tasks
- 8090 work orders: https://docs.8090.ai/modules/work-orders
- Devin:
  - Managed Devins: https://cognition.com/blog/devin-can-now-manage-devins
  - Devin Review: https://docs.devin.ai/work-with-devin/devin-review.md
- Kiro:
  - Specs and waves (updated 15 Oct 2026): https://kiro.dev/docs/specs/
  - Autonomous mode: https://kiro.dev/docs/web/autonomous-mode/
- Cursor:
  - Approval agents: https://cursor.com/docs/approval-agents
  - Cloud agent capabilities: https://cursor.com/docs/cloud-agent/capabilities
- Codex:
  - Long-running work: https://learn.chatgpt.com/codex/long-running-work
  - Non-interactive mode: https://learn.chatgpt.com/codex/non-interactive-mode
- GitHub Copilot cloud agent: https://docs.github.com/en/copilot/concepts/agents/cloud-agent/risks-and-mitigations
- Jules plan review: https://jules.google/docs/review-plan/
- Anthropic:
  - Harness design (24 Mar 2026): https://www.anthropic.com/engineering/harness-design-long-running-apps
  - Long-running agents: https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents
  - Parallel agents (C compiler): https://www.anthropic.com/engineering/building-c-compiler
  - Evals: https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents
  - Best practices: https://code.claude.com/docs/en/best-practices
- StrykerJS: https://stryker-mutator.io/docs/stryker-js/configuration/
- GitHub merge queue: https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue
- Temporal: https://github.com/temporalio
- OpenHands (agent server 1.55.1 source):
  - `agent_server/conversation_router.py`
  - `conversation_service.py` (worktrees)
  - `sdk/agent/acp_agent.py` (ACP auto-approve)
  - automation 1.20.1 `router.py`
