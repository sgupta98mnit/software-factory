# Autopilot — design contract

Source of intent: `docs/research/00-claude-findings.md` §4–6 in the repo. This file is the
binding contract between the people (agents) implementing each commit. Where this file is
silent, follow the repo's existing style and the research doc. Where reality (a CLI's real
output, a type error) contradicts this file, follow reality and note the deviation in your
commit message body.

Repo: `C:\Users\sgupt\Documents\software-factory` (git repo, branch `main`).
Server: `apps/server` (Node 26 at runtime, engines >=24, Hono, TS strict, ES modules,
imports end in `.js`, `noUncheckedIndexedAccess` on). Canvas UI: `canvas/` (its own git
repo, git-ignored by the root repo).

## 0. Ground rules for every implementer

- **pnpm** (only on the owner's Windows machine; elsewhere plain `pnpm` works): the corepack shim on PATH is broken. In Git Bash always run
  `export PATH="/c/Users/sgupt/AppData/Roaming/npm:$PATH"` first in the same command
  (shell state doesn't persist between calls), e.g.
  `cd /c/Users/sgupt/Documents/software-factory && export PATH="/c/Users/sgupt/AppData/Roaming/npm:$PATH" && pnpm typecheck && pnpm test`.
- **Before each commit**: `pnpm typecheck` and `pnpm test` at the repo root must pass.
  Canvas changes additionally: in `canvas/`, `npx tsc --noEmit` and `npx eslint src/factory`,
  then `pnpm export:canvas-patch` at the root.
- **Commits**: one feature per commit, imperative subject prefixed `autopilot:`, short body,
  and end the message with the trailer line
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
  Use `git commit -F <file>` with a message file written to the scratchpad (multi-line `-m`
  gets mangled). `git add -A` at the root is safe (canvas/, data/, node_modules are ignored)
  but check `git status --short` first and never commit anything under `workspaces/` that a
  test or run created.
- **No new dependencies** unless unavoidable; if you add one, exact version pin
  (no ^/~), `pnpm add --save-exact`. `node:sqlite`, `node:test`, `node:child_process`,
  `path.posix.matchesGlob`, global `fetch` are all available — use them.
- **audit() every change** (`apps/server/src/audit.ts`). Never put secrets or full prompts
  (goals, briefs, agent messages) in audit data — store a short summary (≤120 chars) and/or
  a sha256 instead.
- **API stays on 127.0.0.1**; the existing host-check middleware in `index.ts` covers new routes.
- **Never edit OpenSpec or Backlog.md files by hand from server code.** Read OpenSpec through
  `openspec … --json` (tasks.md/design.md raw reads for planning are existing precedent in
  `planner.ts`, that's allowed). Agents write the spec; the factory only validates/commits.
- **Tests**: node:test files in `apps/server/test/*.test.ts` (flat; the test script globs
  `test/*.test.ts`). Helpers that aren't tests go in `apps/server/test/` with names that do
  NOT end in `.test.ts`. Every server module gets tests. Tests must:
  - use temp dirs (`mkdtempSync(path.join(tmpdir(), "sf-…"))`) — never the real
    `workspaces/benefits-portal` or `data/`;
  - set `process.env.SF_DATA_DIR` (and `SF_WORKSPACE` if relevant) BEFORE dynamically
    importing modules that read `config.ts` (see `test/audit.test.ts`);
  - close every server/timer/DB so the process exits (node --test hangs otherwise);
  - be deterministic and fast (no real network, no real agents; the fake OpenHands server
    in `test/fake-openhands.ts` stands in for the agent server).
- Windows: spawn commands with `execFile`/`spawn` (no shell) for git and node; gate commands
  (strings from policy) use `spawn(cmd, { shell: true })`. Git outputs forward-slash paths.
- Keep code in the repo's voice: short header comment per file explaining why it exists,
  small functions, plain English comments only where the why isn't obvious.

## 1. Files

```
apps/server/src/config.ts            + AGENT_SERVER_URL, agentServerKey(), AUTOPILOT_DB, WORKTREES_DIR, HIDDEN_TESTS_DIR
apps/server/src/events.ts            + { type: "autopilot.changed"; runId?: string }
apps/server/src/openspec.ts          run(args, cwd = WORKSPACE); + validateChange(change, cwd) (strict, json)
apps/server/src/autopilot/ledger.ts       C1  SQLite run ledger (node:sqlite DatabaseSync)
apps/server/src/autopilot/openhands.ts    C2  OpenHands agent-server conversation driver
apps/server/src/autopilot/git.ts          C3  git helpers (nested repo, worktrees, merge, diff)
apps/server/src/autopilot/prompts.ts      C3+ role briefs (spec, critic, builder, reviewer, validator) — pure functions
apps/server/src/autopilot/spec.ts         C3  spec stage: change naming, validate loop, critic verdict parsing
apps/server/src/autopilot/orchestrator.ts C3+ the state machine + scheduler (grows each commit)
apps/server/src/autopilot/routes.ts       C3+ Hono sub-app mounted at /sf-api/autopilot
apps/server/src/autopilot/waves.ts        C4  tasks.md → work orders, dependency graph → waves, risk
apps/server/src/autopilot/gates.ts        C5  gate detection + running
apps/server/src/autopilot/review.ts       C5  reviewer verdict parsing + finding clustering
apps/server/src/autopilot/integrator.ts   C6  one-at-a-time merge, re-test, revert, cleanup
apps/server/src/autopilot/policy.ts       C7  .factory/policy.yml from the base branch, merge decision
apps/server/test/fake-openhands.ts        C2  scriptable fake agent server (node:http)
apps/server/test/autopilot-*.test.ts      one per module + autopilot-e2e.test.ts
canvas/src/factory/...                    C8  Home, Pipeline, Inbox + sidebar badge
```

`index.ts` mounts `app.route("/autopilot", createAutopilotRoutes(orchestrator))` and starts
the orchestrator scheduler after `serve()`. Modules must not start anything on import.
Prefer dependency injection (`createOrchestrator({ ledger, client, workspace, dataDir, … })`)
so tests pass temp dirs and a fake client; index.ts wires the real ones from config.

## 2. Config (C1/C2)

- `AUTOPILOT_DB = path.join(DATA_DIR, "autopilot.db")`
- `WORKTREES_DIR = path.join(DATA_DIR, "worktrees")`, `HIDDEN_TESTS_DIR = path.join(DATA_DIR, "hidden-tests")`
- `AGENT_SERVER_URL = process.env.SF_AGENT_SERVER_URL ?? "http://127.0.0.1:8000"` (Canvas
  ingress; `/api/*` reaches the agent server).
- `agentServerKey(): string | undefined` — read at call time: `SF_AGENT_SERVER_KEY` ??
  `LOCAL_BACKEND_API_KEY` ?? trimmed contents of `~/.openhands/agent-canvas/api-key.txt`
  (Canvas's dev launcher persists the agent server's session key there) ?? undefined.
  Sent as header `X-Session-API-Key`.

## 3. Ledger (C1) — `autopilot/ledger.ts`

`openLedger(file: string): Ledger` (`":memory:"` allowed). `PRAGMA journal_mode=WAL`
(skip for :memory:), `foreign_keys=ON`, `busy_timeout=5000`. Schema versioned with
`PRAGMA user_version` (start at 1; later commits bump it with `ALTER TABLE` migrations if
they need columns — prefer to use the columns already reserved below).

```sql
CREATE TABLE runs (
  id TEXT PRIMARY KEY,                 -- "ap-" + 8 hex (randomBytes)
  goal TEXT NOT NULL,
  change TEXT NOT NULL,                -- OpenSpec change name (kebab), chosen at creation
  autonomy TEXT NOT NULL,              -- suggest|supervised|autonomous (already clamped by cap)
  budget_usd REAL,                     -- per-change budget; NULL = policy default
  base_branch TEXT NOT NULL,
  integration_branch TEXT NOT NULL,    -- "autopilot/<change>"
  integration_dir TEXT,                -- worktree path of the integration branch
  state TEXT NOT NULL,                 -- RunState
  resume_state TEXT,                   -- state to return to after paused
  paused_reason TEXT,
  policy_hash TEXT,                    -- C7
  policy_json TEXT,                    -- C7: effective policy pinned for the run
  spec_conversation TEXT,              -- current spec agent conversation id
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE work_orders (
  id TEXT PRIMARY KEY,                 -- "<runId>/WO-<seq>"
  run_id TEXT NOT NULL REFERENCES runs(id),
  seq INTEGER NOT NULL,                -- task group number N from "## N. Title"
  title TEXT NOT NULL,
  acceptance TEXT NOT NULL,            -- JSON string[]
  controls TEXT NOT NULL,              -- JSON string[]
  depends_on TEXT NOT NULL,            -- JSON number[] (seqs)
  wave INTEGER NOT NULL,
  risk TEXT NOT NULL,                  -- low|medium|high
  risk_score INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL,                 -- WorkOrderState
  resume_state TEXT,
  branch TEXT,                         -- "autopilot/<change>/wo-<seq>"
  worktree TEXT,
  base_sha TEXT,                       -- integration sha the branch was created from / last synced with
  pre_merge_sha TEXT,                  -- integration sha before the current merge (for revert)
  findings TEXT,                       -- JSON Finding[] that triggered the latest repair
  budget_extra_usd REAL NOT NULL DEFAULT 0,
  merged_by TEXT,                      -- "policy@<hash>" or "user:<name>"
  updated_at TEXT NOT NULL,
  UNIQUE (run_id, seq)
);
CREATE TABLE attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id),
  work_order_id TEXT REFERENCES work_orders(id),   -- NULL for spec/critic/validator
  role TEXT NOT NULL,                  -- spec|critic|builder|reviewer|validator
  conversation_id TEXT NOT NULL UNIQUE,-- UUID generated BEFORE calling the agent server (idempotent start)
  agent_profile TEXT,
  state TEXT NOT NULL,                 -- starting|running|finished|error|stuck|paused|cancelled
  turns INTEGER NOT NULL DEFAULT 1,    -- user messages sent (1 = initial brief)
  seen_running INTEGER NOT NULL DEFAULT 0,  -- saw status=running since the last message
  last_sent_at TEXT NOT NULL,
  cost_usd REAL NOT NULL DEFAULT 0,    -- latest metrics.accumulated_cost
  result TEXT,                         -- JSON (final response summary, verdict)
  started_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE TABLE checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id),
  work_order_id TEXT,
  stage TEXT NOT NULL,                 -- spec|build|integrate
  name TEXT NOT NULL,                  -- openspec-validate, install, typecheck, lint, test, hidden, secrets, …
  ok INTEGER NOT NULL,
  exit_code INTEGER,
  duration_ms INTEGER,
  output TEXT NOT NULL DEFAULT '',     -- tail, ≤ 8000 chars
  at TEXT NOT NULL
);
CREATE TABLE inbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id),
  work_order_id TEXT,
  kind TEXT NOT NULL,                  -- InboxKind
  title TEXT NOT NULL,
  body TEXT NOT NULL,                  -- markdown
  options TEXT NOT NULL,               -- JSON InboxOption[]
  state TEXT NOT NULL DEFAULT 'open',  -- open|decided|dismissed
  decision TEXT, note TEXT, decided_by TEXT, decided_at TEXT,
  created_at TEXT NOT NULL,
  notified_at TEXT                     -- v1 digest
);
```

Costs are derived, never stored twice: attempt cost = latest `metrics.accumulated_cost`;
work order cost = SUM over its attempts; run cost = SUM over all its attempts.

Exported types (camelCase row mappers, JSON columns parsed):

```ts
export type Autonomy = "suggest" | "supervised" | "autonomous";
export type RunState = "spec" | "critic" | "awaiting_spec_approval" | "awaiting_answers"
  | "awaiting_plan_approval" | "building" | "done" | "paused" | "failed" | "cancelled";
export type WorkOrderState = "pending" | "building" | "verifying" | "reviewing" | "ready"
  | "awaiting_merge_approval" | "merging" | "merged" | "needs_attention" | "skipped" | "cancelled";
export type AttemptRole = "spec" | "critic" | "builder" | "reviewer" | "validator";
export type AttemptState = "starting" | "running" | "finished" | "error" | "stuck" | "paused" | "cancelled";
export type InboxKind = "spec_approval" | "plan_approval" | "questions" | "spec_failed"
  | "merge_approval" | "work_order_failed" | "budget_reached" | "run_paused" | "error" | "release";
export interface InboxOption { id: string; label: string; tone?: "primary" | "danger" | "default"; needsNote?: boolean }
```

Ledger API (synchronous, typed; names are a guide, keep them close):
`createRun`, `getRun`, `listRuns` (newest first), `updateRun(id, patch)`,
`addWorkOrders(runId, rows)`, `listWorkOrders(runId)`, `getWorkOrder(id)`, `updateWorkOrder(id, patch)`,
`addAttempt`, `updateAttempt(id, patch)`, `getAttemptByConversation(id)`, `listAttempts({ runId, workOrderId?, role? })`, `activeAttempts()` (state starting|running),
`addCheck`, `listChecks({ runId, workOrderId? })`,
`openInbox(item)` — **dedupes**: if an open item with the same run_id/work_order_id/kind exists, returns it unchanged,
`listInbox({ state?: "open" | "decided" | "all", runId? })` newest first, `getInbox(id)`, `decideInbox(id, { decision, note, by })`, `dismissInbox({ runId })`, `openInboxCount()`,
`runCost(runId)`, `workOrderCost(id)`, `transaction(fn)`, `close()`.
Timestamps: ISO strings. `updated_at` maintained by update helpers.

## 4. Conversation driver (C2) — `autopilot/openhands.ts`

Agent server 1.55.1 REST (all under `${baseUrl}/api`, header `X-Session-API-Key` when a key exists):

| Call | Request | Response |
| --- | --- | --- |
| `GET /agent-profiles` | — | `{ profiles: [{ id, name, agent_kind, acp_server?, … }], active_agent_profile_id }` |
| `POST /conversations` | see body below | `ConversationInfo` (201 new, 200 if `conversation_id` already exists) |
| `GET /conversations/{id}` | — | `ConversationInfo` or 404 |
| `POST /conversations/{id}/events` | `{ role: "user", content: [{ type: "text", text }], run: true }` | `{ success: true }` |
| `POST /conversations/{id}/pause` | — | `{ success: true }` |
| `POST /conversations/{id}/run` | — | `{ success: true }` (409 if already running — treat as ok) |
| `GET /conversations/{id}/agent_final_response` | — | `{ response: string }` |

Start body (exact):
```json
{
  "conversation_id": "<uuid we generated>",
  "agent_profile_id": "<resolved id>",
  "workspace": { "kind": "LocalWorkspace", "working_dir": "<absolute dir>" },
  "initial_message": { "role": "user", "content": [{ "type": "text", "text": "<brief>" }], "run": true },
  "worktree": false,
  "confirmation_policy": { "kind": "NeverConfirm" },
  "max_iterations": 500,
  "stuck_detection": true,
  "autotitle": false,
  "tags": { "sfrun": "<runId>", "sfrole": "<role>", "sfwo": "<seq or empty>" },
  "client_tools": []
}
```
Why `worktree: false`: the agent server's own worktrees always branch from local `main` and
tell the agent to make its own branch. The factory creates the worktree itself (branch from
the integration branch tip, deterministic name) and points the conversation at it.

`ConversationInfo` fields we read: `id`, `execution_status` (`idle|running|paused|
waiting_for_confirmation|finished|error|stuck`), `metrics?.accumulated_cost`, fallback sum of
`stats.usage_to_metrics[*].metrics.accumulated_cost` or `stats.usage_to_metrics[*].accumulated_cost`
(be lenient), `workspace.working_dir`, `title`. Unknown fields ignored.

```ts
export interface ConversationSnapshot { id: string; status: ExecutionStatus | "unknown"; costUsd: number; workingDir: string | null }
export class OpenHandsClient {
  constructor(opts: { baseUrl: string; apiKey?: () => string | undefined; fetch?: typeof fetch; timeoutMs?: number });
  listProfiles(): Promise<{ profiles: AgentProfile[]; activeId: string | null }>;
  resolveProfile(ref?: string | null, opts?: { avoidServerOf?: string }): Promise<AgentProfile>; // id or name; undefined → active; avoidServerOf → prefer a profile whose acp_server differs (critic/reviewer "other vendor"), else fall back
  start(input: StartInput): Promise<ConversationSnapshot>;
  get(id: string): Promise<ConversationSnapshot | null>;   // 404 → null
  send(id: string, text: string): Promise<void>;
  pause(id: string): Promise<void>;
  resume(id: string): Promise<void>;
  finalResponse(id: string): Promise<string>;
  ping(): Promise<{ ok: boolean; error?: string }>;        // GET /agent-profiles
}
export function classify(snapshot, attempt: { seenRunning: boolean; lastSentAt: string }, now: Date, graceMs = 20_000):
  "running" | "done" | "failed" | "paused";
```
`classify`: `running`/`waiting_for_confirmation` → running. `finished` → done, `error`/`stuck` → failed,
`paused` → paused — but only if `seenRunning` or `now - lastSentAt > graceMs`; otherwise "running"
(guards the race where a follow-up was just sent and the server still reports the previous
turn's `finished`). `idle` → done under the same rule (ACP turns may end idle), else running.
Errors: non-2xx → throw `OpenHandsError(status, message)` with the server's `detail` when present.
Network failure → `OpenHandsError(0, "Agent server unreachable at <url>")`. Per-request timeout.

Fake server `test/fake-openhands.ts` (C2), used by every later test:
```ts
export interface FakeConversation { id: string; workingDir: string; profileId: string; tags: Record<string,string>;
  status: string; cost: number; messages: string[]; finalResponse: string }
export async function startFakeOpenHands(opts?: {
  apiKey?: string;
  profiles?: { id: string; name: string; agent_kind: string; acp_server?: string }[];  // default one "default" claude-code profile + active
  onMessage?: (conv: FakeConversation, text: string) => Promise<{ response?: string; cost?: number; status?: "finished" | "error" | "stuck" }> | …;
}): Promise<{ url: string; conversations: Map<string, FakeConversation>; setHandler(fn); close(): Promise<void> }>;
```
Behavior: POST /conversations stores the conversation, status `running`, then runs `onMessage`
for the initial text asynchronously (setImmediate), adds `cost` to `conv.cost`, sets
`finalResponse` and status (default `finished`). POST /events does the same for follow-ups.
Idempotent create (same id → 200, no second onMessage). 401 when apiKey set and header wrong.
Pause → status `paused`. Run → status `running` then re-finishes. Default handler: respond "Done." at cost 0.01.
Handlers can do real work in `conv.workingDir` (write files, `git commit`) — that's how tests
script spec agents, builders and reviewers.

## 5. Git helpers (C3) — `autopilot/git.ts`

All via `execFile("git", ["-c","core.autocrlf=false","-c","user.name=Software Factory","-c","user.email=factory@localhost", ...args], { cwd })`.
- `git(cwd, args, { allowFail? })` → `{ code, stdout, stderr }` (throws on non-zero unless allowFail).
- `ensureRepo(dir)`: if `git rev-parse --show-toplevel` (allowFail) doesn't resolve to `dir`
  (compare with `realpathSync` + case-insensitive on win32) → `git init -b main`, `git add -A`,
  `git commit --allow-empty -m "Baseline (Software Factory)"`; returns `{ initialized }`.
  (The demo workspace sits inside the factory repo; it becomes its own nested repo. Git handles
  that fine.) Also if the repo exists but has no commits → commit baseline.
- `currentBranch(dir)`, `headSha(dir, ref = "HEAD")`, `branchExists(repo, name)`, `isAncestor(repo, a, b)`.
- `addWorktree(repo, dir, branch, startPoint)` — per-repo async lock (promise chain); if `dir`
  exists → `worktree remove --force` (allowFail) + rm; `worktree prune`; if branch exists → `branch -D`;
  `worktree add -b <branch> <dir> <startPoint>`.
- `removeWorktree(repo, dir)` (locked; force; prune; tolerate missing), `deleteBranch(repo, name)` (locked; allowFail).
- `commitAll(dir, message)` → sha or null when nothing to commit. If a merge is in progress
  (MERGE_HEAD exists) commit with `--no-edit` semantics to conclude it.
- `isClean(dir)`, `discardChanges(dir)` (`reset --hard` + `clean -fd`, used after critic/reviewer runs
  to throw away edits they weren't supposed to make — record a check when it happens).
- `diffStat(dir, base, head = "HEAD")` → `{ files: { path, added, deleted }[]; linesChanged }` from `diff --numstat base...head` (binary "-" counts 0).
- `addedLines(dir, base, head)` → `{ path, line }[]` (for the secret scan, C9).
- `fileAt(dir, ref, path)` → string | null (`git show ref:path`, allowFail).
- `merge(dir, branch, message)` → `{ ok: true, sha } | { ok: false, conflicts: string[] }`
  (`merge --no-ff -m`; on failure list `diff --name-only --diff-filter=U`, then `merge --abort`).
- `mergeInto(dir, branch)` for syncing a WO branch with the integration branch: like merge but
  on conflict LEAVES the conflict markers in place (the builder resolves them) → `{ ok, conflicts }`.
- `resetHard(dir, sha)`.

## 6. Run lifecycle (C3–C6) — `autopilot/orchestrator.ts`

`createOrchestrator(deps)` → `{ createRun, decide, pause, resume, cancel, tick, idle, start(intervalMs), stop, status }`.
- **Scheduler**: `start()` runs `tick()` every 3 s (index.ts) — `tick()` is cheap: it loads non-terminal
  runs and for each pending step calls `launch(key, fn)`; `launch` skips keys already in flight
  (in-memory `Map<string, Promise>`), catches errors. `idle()` resolves when nothing is in flight
  (tests: `for (;;) { await o.tick(); await o.idle(); if (cond()) break; }` with a max loop count).
- **Resumable**: every step reads state from the ledger, does the side effect, writes the new
  state. Write-ahead for conversations: insert the attempt (state `starting`, uuid) *before*
  calling `client.start`; on restart, `starting` attempts are started again with the same id
  (the agent server returns 200 for an existing id). `merging` on restart: if MERGE_HEAD exists
  → abort; if the WO branch is already an ancestor of HEAD → continue to post-merge gates; else merge again.
- **Polling**: every tick, each attempt in starting/running → `client.get()` → update cost,
  `seen_running`, state via `classify()`. Agent server unreachable → leave as is (status shows it).
- Every state change: ledger update + `audit()` + `broadcast({ type: "autopilot.changed", runId })`.
- Step exception → WO `needs_attention` (resume_state = previous) + inbox `error`
  (options retry/skip/cancel); run-level → run `paused` + inbox `error` (retry/cancel).

### createRun({ goal, autonomy?, budgetUsd?, actor })
Validate goal (1–4000 chars after trim). `ensureRepo(workspace)`. base = current branch of the
workspace (fallback "main"). Change name = `changeNameFor(goal)`: lowercase, non `[a-z0-9]` → `-`,
collapse, trim, ≤ 48 chars cut at a `-`, must start with a letter (prefix `change-`), unique
against `openspec/changes/<name>` on the base branch (`git ls-tree`), existing branches
`autopilot/<name>`, and other runs (suffix `-2`, `-3`, …). Integration branch
`autopilot/<change>`, worktree `<dataDir>/worktrees/<runId>/integration` from base.
Autonomy clamped by the cap (C7: policy `autonomy.max` and env `SF_AUTONOMY_CAP`; before C7
just env). Audit `autopilot.run_created` (subject runId; data: change, autonomy, goalSummary ≤120 chars,
goalSha256, budgetUsd). State `spec`; the spec attempt starts on the next tick.

### Spec stage (C3) — `spec.ts` + prompts
1. Spec attempt (role spec, profile `agents.spec`) in the integration worktree with
   `specBrief({ goal, change, autonomy, openspecVersion })`. The brief tells the agent to:
   create the change with `openspec new change <change>` (or `npx -y @fission-ai/openspec@<ver> …`);
   write proposal.md, specs/<capability>/spec.md (requirements with `#### Scenario:` WHEN/THEN), design.md
   (with a `## Controls` table `| <ID> <name> | how it's met |` for NIST 800-53 controls when relevant),
   tasks.md in the factory format (below); run `openspec validate <change> --strict` until clean;
   **not** write application code, **not** commit, **not** touch backlog/.
   Autonomy ≠ suggest: don't ask questions; record assumptions under `## Assumptions` in
   proposal.md and anything an assumption can't settle under `## Open questions` (bullets).
   tasks.md format: `## N. Title` groups (each one work order an agent can build and test on its
   own, small), checklist lines `- [ ] N.M item`, and optionally one line `Depends on: 1, 3` or
   `Depends on: none` per group (omitted → depends on the previous group). Prefer independent
   groups where the design allows so they can be built in parallel.
2. When the attempt is done → `validateChange(change, integrationDir)` (openspec.ts; `validate <change>
   --strict --json`, cwd = integration worktree) → check `openspec-validate` (stage spec, output = issues).
   Invalid → follow-up to the same conversation listing the issues (`turns` ≤ `spec.validateTries` = 3)
   → else inbox `spec_failed` (retry → new spec attempt; cancel). Spec attempt failed/stuck → same inbox.
3. Valid → `commitAll(integrationDir, "spec(<change>): <first line of proposal title or goal summary>")`
   → audit `autopilot.spec_committed` (sha) → state `critic`.
4. Critic attempt (role critic, profile `agents.critic`, else `resolveProfile(undefined, { avoidServerOf: spec profile's acp_server })`)
   in the integration worktree, `criticBrief({ change })`: read the change; check for untestable or
   vague scenarios, missing error cases, missing accessibility (Section 508) for user-facing work,
   security controls without a task, tasks too big for one work order, bad dependencies;
   restrict to correctness and requirements — no style nits, don't invent scope; **don't edit files**;
   end the reply with exactly one fenced ```json block:
   `{ "verdict": "pass" | "revise", "findings": [{ "severity": "high"|"medium"|"low", "where": "...", "issue": "...", "suggestion": "..." }] }`.
   After it finishes: if the worktree isn't clean → `discardChanges` + check `critic-edits-discarded` (ok=false).
   `parseCriticVerdict(text)` (lenient: last ```json block, else last balanced `{…}`; normalize; on failure → `{ verdict: "revise", findings: [{severity:"medium", issue:"The critic's reply had no readable verdict"}], unreadable: true }`).
   Audit `autopilot.critic_verdict` (verdict, finding count).
5. Verdict `revise` with any high/medium finding and critic rounds < `spec.criticRounds` (2) →
   follow-up to the spec conversation with the findings → state `spec` (validate → commit → critic again).
   Otherwise continue (remaining findings travel into the approval body).
6. Open questions (read `## Open questions` bullets from proposal.md in the worktree) in autonomy
   `autonomous` → inbox `questions` (answer[needsNote]/proceed/cancel), state `awaiting_answers`.
   answer → follow-up to spec conversation with the answer → state `spec`.
7. Plan: `waves.ts` (C4) builds work orders from tasks.md/design.md in the integration worktree
   (before C4 exists, C3 stops at "plan ready" with no work orders). Then by autonomy:
   - suggest: inbox `spec_approval` (approve / revise[needsNote] / cancel) → state `awaiting_spec_approval`;
     approve → inbox `plan_approval` → `awaiting_plan_approval`.
   - supervised: inbox `plan_approval` (approve / revise[needsNote] / cancel) → `awaiting_plan_approval`.
   - autonomous: audit `autopilot.plan_approved` with actor `policy@<hash>` (before C7: `policy@default`),
     data { critic: verdict, conversation } → state `building`.
   Approval bodies (markdown): change name, link text `openspec/changes/<change>/`, assumptions,
   open questions, critic verdict + findings, the work-order table (WO, title, wave, risk, depends on, controls).
   revise → follow-up to spec conversation with the note → state `spec`; work orders are rebuilt next plan.
   Approve by a person → audit `autopilot.plan_approved` actor = user.

### Build stage (C4) — dispatch
- Eligible WO: state `pending` and every `depends_on` WO is `merged` or `skipped`. Order by wave, seq.
- Concurrency: at most `parallel` (default 3) WOs per run in building|verifying|reviewing.
- Dispatch = new builder attempt: worktree `<dataDir>/worktrees/<runId>/wo-<seq>` on branch
  `autopilot/<change>/wo-<seq>` from the integration branch tip (`base_sha` = that sha); fresh
  attempts recreate both. Profile `agents.builder` (C9: `routing[risk]`). `builderBrief(...)`:
  WO title, acceptance criteria, controls, `openspec/changes/<change>/` to read, the gates that will be
  run (names + commands), rules: work only in this folder; write tests for each criterion; make the
  gates pass; commit on the current branch when done; don't create/switch branches, merge, rebase,
  or touch `openspec/`, `.factory/`, `backlog/`; finish with a short summary of what changed and how you
  tested it. This is an Autopilot work order — don't use Backlog.md for it.
- Audit `autopilot.work_order_dispatched` (attempt id, conversation id, profile, round).

### Verify stage (C5) — gates, reviewer, repair
- Builder attempt done → `commitAll(worktree, "WO-<seq>: <title>")` (agent may already have committed)
  → state `verifying` → `runGates(worktree, gates)` → one check per gate (stage build).
  Builder attempt failed/stuck/error → treat as a failed round with finding "The agent stopped with status X".
- Gates: policy `gates` list (C7) or `detectGates(dir)`: every package.json at the root and one level
  down (skip node_modules, dot-dirs). For each: if it declares dependencies/devDependencies and has no
  node_modules → gate `install` (`npm ci` with a lockfile else `npm install`, flags `--no-audit --no-fund`);
  then scripts present among `typecheck`, `lint`, `test` → gates `npm run <script>`; names prefixed with the
  dir for subdirs (`claim-status-service:test`). Nothing detected → one failing check `gates`:
  "No gates: add a test script (package.json) or list gates in .factory/policy.yml".
  Run sequentially, `shell: true`, cwd, env `{ ...process.env, CI: "1", NO_COLOR: "1", FORCE_COLOR: "0" }`,
  per-gate timeout (default 600 s; kill the tree on Windows with `taskkill /pid <pid> /T /F`), output tail ≤ 8000 chars.
  A failing `install` stops the rest. Result `{ ok, results: GateResult[] }`.
- Gates fail → repair (skip the reviewer). Gates pass → reviewer attempt (role reviewer, profile
  `agents.reviewer`, else other-vendor resolution vs the builder's profile) in the WO worktree with
  `reviewerBrief(...)`: the WO, criteria, scenarios dir, `git diff <base_sha>...HEAD` to review; correctness
  and requirements only; don't edit; end with one fenced json block
  `{ "verdict": "pass" | "fail", "findings": [{ "severity": "critical"|"high"|"medium"|"low", "criterion": <n>|null, "scenario": "<name>"|null, "file": "<path>"|null, "issue": "...", "fix": "..." }] }`.
  Worktree dirty afterwards → discardChanges + failing check `reviewer-edits-discarded`.
  `parseVerdict` (review.ts) lenient like the critic's; unreadable → send one follow-up "Reply with only
  the JSON verdict block"; still unreadable → WO `needs_attention` + inbox `error`.
  Pass = verdict pass AND no finding with severity in `review.blocking` (default critical, high).
- `Finding` (shared shape, ledger stores JSON):
  `{ source: "gate"|"review"|"hidden"|"integration"|"critic"|"agent"; severity: "critical"|"high"|"medium"|"low"; title: string; detail: string; file?: string|null; criterion?: number|null; scenario?: string|null }`.
  `clusterFindings(findings)` → markdown grouped by scenario / criterion / gate, e.g.
  `- Scenario "Unknown claim": expected 404, got 500 (src/routes.ts)`. Never paste hidden test source.
- Repair (per WO): last builder attempt with `turns < 1 + repair.sameConversation` (2) → follow-up message
  `repairMessage(findings)` to the same conversation (turns+1, seen_running=0, last_sent_at=now) → state
  `building`. Else if builder attempts < 1 + `repair.fresh` (1) → fresh attempt (new worktree from the current
  integration tip) with `builderBrief(..., { previousFindings })` ("A previous attempt failed: …"). Else →
  state `needs_attention` + inbox `work_order_failed` (retry → one more fresh attempt / skip / cancel run).
  Audit `autopilot.repair_requested` (round, finding count) and `autopilot.work_order_failed`.
- 3 WOs in `needs_attention` in one run → run `paused` (resume_state building) + inbox `run_paused` (resume / cancel).
- Pass → state `ready` (C6 picks it up). Audit `autopilot.review_verdict`.

### Integrate stage (C6) — `integrator.ts`
- One merge at a time per run (`launch("integrate:<runId>")`). Pick the lowest (wave, seq) `ready` WO.
- Merge decision: before C7 — suggest → inbox `merge_approval` (merge / send_back[needsNote] / skip),
  others → auto with actor `policy@default`. C7 replaces this with `evaluateMerge(policy, facts)`.
- Merge: `pre_merge_sha = headSha(integrationDir)` (persist first) → state `merging` →
  `merge(integrationDir, wo.branch, "Merge WO-<seq>: <title>")`.
  - Conflict → `mergeInto(woWorktree, integrationBranch)` (leaves markers) → repair follow-up "Merging the
    latest integration branch into your branch conflicts in: … Resolve, keep tests passing, commit." →
    state `building` (counts as a repair round). `base_sha` = integration tip.
  - Clean → run the integration gates in `integrationDir` (stage integrate; install if needed).
    Fail → `resetHard(integrationDir, pre_merge_sha)` (the integration branch is local and unpublished,
    so a reset is the honest "revert": `git revert` of a merge would block re-merging the same commits later)
    → audit `autopilot.merge_reverted` → `mergeInto(woWorktree, integrationBranch)` + repair follow-up with
    source "integration" findings → `building`.
    Pass → state `merged`, `merged_by` = actor → audit `autopilot.work_order_merged` (actor = `policy@<hash>`
    or the approving user; data: sha, linesChanged, files count, reasons) → cleanup: `removeWorktree` +
    `deleteBranch(wo.branch)` → audit `autopilot.branch_cleaned`.
- All WOs `merged`/`skipped` (and at least one merged) → run `done`, audit `autopilot.run_completed`
  (integration branch, sha, cost) → remove the integration worktree (keep the branch — it's the deliverable).
  (v1 adds inbox `release`.)
- Cancel: pause active conversations, remove WO worktrees + branches and the integration worktree (keep the
  integration branch), dismiss open inbox items, state `cancelled`, audit `autopilot.run_cancelled`.

### Policy (C7) — `policy.ts`
Read `.factory/policy.yml` **from the base branch** (`fileAt(workspace, baseBranch, ".factory/policy.yml")`),
never from the working tree or a WO branch, so a change can't relax its own rules. Parse YAML with the
already-installed `gray-matter` (`matter(\`---\n${text}\n---\n\`, {}).data` — pass `{}` options to skip its cache),
deep-merge over defaults (arrays replace), validate (unknown autonomy / non-numeric limits → error naming the key).
```yaml
version: 1
autonomy: { default: supervised, max: autonomous }
agents: { spec: null, critic: null, builder: null, reviewer: null, validator: null }   # profile id or name; null = Canvas's active profile (critic/reviewer prefer another vendor)
routing: { low: null, medium: null, high: null }   # builder profile by risk (C9)
parallel: 3
repair: { sameConversation: 2, fresh: 1 }
spec: { validateTries: 3, criticRounds: 2 }
review: { blocking: [critical, high] }
gates: null              # null = detect npm scripts; else [{ name, run, cwd?, timeoutSec? }]
autoMerge:
  maxChangedLines: 400
  sensitivePaths: ["**/auth/**", "**/crypto/**", "infra/**", "**/*.tf", "Dockerfile", ".github/**", ".gitlab-ci.yml", ".factory/**", "AGENTS.md", "CLAUDE.md", "**/migrations/**"]
  dependencyAllowlist: []
budget: { perWorkOrderUsd: 5, perChangeUsd: 30 }
hiddenTests: { enabled: true, run: "node --test" }   # C10
notify: { digestHour: 17 }                           # C12
```
`loadPolicy(workspace, baseBranch)` → `{ policy, hash, source }`: hash = first 12 hex of sha256 over
`canonicalJson(effective policy)` (from audit.ts); source `".factory/policy.yml@<base>"` or `"defaults"`.
Pinned on the run at creation (`policy_json`, `policy_hash`); audit `autopilot.policy_loaded` (hash, source,
the effective policy — it holds no secrets) once per run.
`evaluateMerge(policy, facts)` pure → `{ auto: boolean; reasons: string[] }`, auto only when **all** hold:
gates ok; hidden tests ok (when run); review pass with no blocking findings; no secret findings; no new
dependencies outside the allowlist; no changed file matching `sensitivePaths` (`path.posix.matchesGlob`; a
pattern also matches when it's a plain file name equal to the path); `linesChanged < maxChangedLines`.
Autonomy `suggest` → never auto. Facts come from git (`diffStat`, package.json deps diff via `fileAt`).
Auto → actor `policy@<hash>`; else inbox `merge_approval` whose body lists the reasons, files, lines.

## 7. HTTP API (C3+) — `routes.ts`, mounted at `/sf-api/autopilot`

Response shapes are a contract with the Canvas UI (`canvas/src/factory/api.ts`). camelCase JSON.
```ts
type Autonomy = "suggest" | "supervised" | "autonomous";
interface Counts { total: number; merged: number; active: number; failed: number; pending: number }
interface RunSummary {
  id: string; goal: string; change: string; autonomy: Autonomy; state: RunState; pausedReason: string | null;
  baseBranch: string; integrationBranch: string; costUsd: number; budgetUsd: number | null;
  policyHash: string | null; createdBy: string; createdAt: string; updatedAt: string;
  counts: Counts; openInbox: number;
}
interface WorkOrderView {
  id: string; runId: string; seq: number; key: string /* "WO-2" */; title: string; acceptance: string[];
  controls: string[]; dependsOn: number[]; wave: number; risk: "low" | "medium" | "high"; state: WorkOrderState;
  branch: string | null; costUsd: number; attempts: number /* builder conversations */; round: number /* turns of the current builder conversation */;
  conversationId: string | null /* latest builder conversation */; findings: Finding[] | null; mergedBy: string | null; updatedAt: string;
}
interface AttemptView {
  id: number; runId: string; workOrderId: string | null; role: AttemptRole; conversationId: string; agentProfile: string | null;
  state: AttemptState; turns: number; costUsd: number; result: unknown; startedAt: string; finishedAt: string | null;
}
interface CheckView { id: number; runId: string; workOrderId: string | null; stage: "spec" | "build" | "integrate"; name: string; ok: boolean; exitCode: number | null; durationMs: number | null; output: string; at: string }
interface InboxItemView { id: number; runId: string; workOrderId: string | null; kind: InboxKind; title: string; body: string; options: InboxOption[];
  state: "open" | "decided" | "dismissed"; decision: string | null; note: string | null; decidedBy: string | null; decidedAt: string | null; createdAt: string }
interface RunDetail extends RunSummary { workOrders: WorkOrderView[]; attempts: AttemptView[]; checks: CheckView[]; inbox: InboxItemView[]; etaMs: number | null }
interface AutopilotStatus {
  agentServer: { url: string; reachable: boolean; error: string | null; profiles: { id: string; name: string; kind: string; server: string | null }[]; activeProfileId: string | null };
  workspace: { path: string; isRepo: boolean; branch: string | null };
  policy: { source: string; hash: string; error: string | null };
  openInbox: number; activeRuns: number;
}
```
| Method & path | Body | Returns |
| --- | --- | --- |
| GET `/status` | — | AutopilotStatus |
| GET `/runs` | — | RunSummary[] newest first |
| POST `/runs` | `{ goal: string; autonomy?: Autonomy; budgetUsd?: number }` | RunSummary |
| GET `/runs/:id` | — | RunDetail |
| POST `/runs/:id/pause` · `/resume` · `/cancel` | `{ note?: string }` | RunSummary |
| GET `/inbox?state=open\|decided\|all` (default open) | — | InboxItemView[] newest first |
| GET `/inbox/count` | — | `{ open: number }` |
| POST `/inbox/:id/decide` | `{ choice: string; note?: string }` | InboxItemView |
| GET `/runs/:id/evidence` (C11) | — | Evidence (see v1) |

`choice` must be one of the item's option ids; `needsNote` options require a non-empty note; deciding a
non-open item → 400. Decisions audit `autopilot.inbox_decided` (actor = LOCAL_USER; data: kind, choice,
note summary ≤120 chars). etaMs: if ≥1 WO merged, median(dispatch→merged duration of merged WOs) ×
ceil(remaining WOs / parallel); else null. The run's SSE events: `autopilot.changed`.

## 8. Canvas UI (C8) — `canvas/src/factory/`

Follow `canvas/AGENTS.md` and the existing factory pages (FactoryPage frame, copy.ts en+es strings,
React Query hooks in hooks.ts, typed client in api.ts, Tailwind with Canvas theme tokens — look at
requirements.tsx / work-orders.tsx and reuse their classes/components, BrandButton, ModalBackdrop).
Upstream files: add routes in `src/routes.ts` only (one line each). Sidebar entries go in
`factory-nav-links.tsx` (already rendered by `sidebar-rail-body.tsx`).
- **Home** `/autopilot`: "What should we build?" — goal textarea, autonomy dial (three segmented choices with
  one-line explanations: Suggest "You approve the spec, the plan and every merge" · Supervised (default)
  "You approve the plan; merges follow the policy" · Autonomous "You write the goal; you hear back only when
  it's stuck"), budget in dollars (optional), workspace (read-only, from health), agent-server status line
  (from `/autopilot/status`: reachable or not, with the hint to run `pnpm dev`), Start → POST /runs →
  navigate to `/autopilot/runs/:id`. Below: recent runs (goal, change, state chip, cost, counts) linking to the pipeline.
- **Pipeline** `/autopilot/runs/:runId`: header (goal, change, integration branch, autonomy, cost / budget, ETA,
  state; Pause/Resume/Cancel). Stage lanes Spec → Plan → Build → Verify → Integrate → Done with the current stage
  highlighted and per-lane counts (Spec = run in spec/critic/awaiting_spec_approval/awaiting_answers; Plan =
  awaiting_plan_approval; Build = WOs pending/building; Verify = verifying/reviewing; Integrate = ready/
  awaiting_merge_approval/merging; Done = merged/skipped). Open inbox items for the run as a banner linking to the Inbox.
  Wave view: one column per wave, a card per work order (key, title, state chip, risk, attempt/round, cost,
  "Open conversation" → `/conversations/<id>`); expanding a card shows its timeline: attempts (role, state, cost,
  conversation link), gate checks (name, ok, duration, output in a `<details>` pre), review findings. A spec section
  shows spec/critic attempts, the openspec-validate checks and the critic verdict.
- **Inbox** `/inbox`: open items as cards (kind chip, run goal/change link to the pipeline, title, body via the
  existing FactoryMarkdown, a note textarea when any option needsNote, one button per option, danger tone for
  cancel/skip), plus a "Decided" toggle listing history (who/when/choice).
- **Sidebar**: entries "Autopilot" (Home) and "Inbox" with a count badge of open items
  (`GET /autopilot/inbox/count`, `refetchInterval` 15 s, plus SSE invalidation on factory pages). Badge must be
  accessible (`aria-label` like "Inbox, 2 need you").
- api.ts: the types and methods of §7; hooks.ts: queries/mutations; SSE: handle `autopilot.changed` by
  invalidating autopilot queries. Audit-log page: add labels for the new `autopilot.*` actions in copy.ts.
- Accessibility: buttons are buttons, state chips have text, focus rings via existing classes, no colour-only meaning.

## 9. v1 (after the MVP, as time allows; one commit each)

- **C9 Budgets + model routing** (budgets implemented in the hardening pass; model routing remains future work): per-WO budget (`budget.perWorkOrderUsd` + `budget_extra_usd`) and per-run budget
  (`runs.budget_usd` ?? `budget.perChangeUsd`) enforced on each poll: over limit → `pause` the conversation(s);
  WO → `needs_attention` + inbox `budget_reached` (continue[raises by the base amount]/skip); run → `paused` +
  inbox `budget_reached` (continue/cancel). Builder profile = `routing[risk]` ?? `agents.builder`.
- **C10 Secret + dependency scans**: gate `secrets` on added lines (`addedLines`) with a small regex set (private key
  headers, AWS `AKIA…`, GitHub `gh[pousr]_…`, Slack `xox…`, generic `(api[_-]?key|secret|token|password)\s*[:=]\s*['"][^'"]{12,}`),
  never echoing the secret itself in output (mask). Dependency facts: new package names vs base; feed both into
  `evaluateMerge` and findings.
- **C11 Hidden acceptance tests (validator)**: after plan approval, a validator attempt in a throwaway worktree
  (`<dataDir>/worktrees/<runId>/validator`, branch `autopilot/<change>/validator` from the integration tip) writes
  black-box `node:test` files to `.hidden-tests/wo-<seq>-<scenario-slug>.test.mjs` (one per scenario, n = the task group
  that makes it pass). The factory copies them to `<dataDir>/hidden-tests/<runId>/`, deletes the worktree + branch.
  Gate `hidden` (after the normal gates): copy files for merged WOs + the current WO into `<worktree>/.sf-hidden/`,
  run `hiddenTests.run` with those files, then delete the folder (try/finally). Findings name the scenario and the
  first assertion line only — never the test source. Validator may add tests on later rounds, never remove.
- **C12 Notifications**: `SF_NOTIFY_WEBHOOK` (Teams/Slack incoming webhook). First open inbox item while none were
  open → immediate POST; otherwise mark for the daily digest at `notify.digestHour`. JSON `{ text }`. Audit `autopilot.notified`.
- **C13 Evidence**: `GET /runs/:id/evidence` → `{ run, change, requirements: [{ name, scenarios: [{ name, hiddenTests: string[], workOrders: string[] }] }], workOrders: [{ key, title, controls, mergedBy, mergeSha, checks: {name, ok}[], review }], approvals: AuditEvent[] }`
  (requirements via `openspec show <change> --json` in the integration branch/worktree or the latest sha);
  Canvas screen `/autopilot/runs/:runId/evidence` with a "Download JSON" button.
- **C14 Release**: on `done`, inbox `release` (merge into <base> / keep branch). merge → only if the workspace's main
  checkout is on <base> and clean; `merge --no-ff`; audit `autopilot.released` with the person's name.
- Not planned overnight (document as left): Stryker mutation gate, axe + screenshots, Docker sandbox for builders,
  digest email, preview deploys.

## 10. As built (deviations recorded by commits C1–C4 — these override the sections above)

- The pinned policy column is `runs.policy` (JSON, read as `run.policy`), not `policy_json`.
- Work-order branches are `autopilot/<change>--wo-<seq>` (git can't nest refs under the existing
  `autopilot/<change>` branch). Change names never contain `--`.
- Scheduling is one task per run: `launch(runId, fn)` (scheduler, skips a busy run) and
  `locked(runId, fn)` (a person's action; waits, then holds the run). `advance(runId)` starts/polls
  attempts then switches on run.state. Slow work (gates) blocks that run's polling while it runs.
- An attempt is "handled" when `attempt.result.turn === attempt.turns`; `markHandled(a, result)`.
  Follow-ups raise `turns`. Errored or unreadable critic/reviewer attempts don't use up rounds.
- `moveWorkOrder(wo, to, …)` is the one way to change a WO's state; `openItem(run, kind, title, body, options, workOrderId?)`.
- `PARALLEL` exported from orchestrator.ts (replace with policy.parallel in C7).
- Builder stop with error/stuck → (C4) needs_attention; C5 routes it through repair rounds first.
- Extra audit actions exist (run_state_changed, agent_started, agent_finished, followup_sent, inbox_opened,
  edits_discarded, spec_approved, run_paused, run_resumed, workspace_initialized, work_orders_planned,
  work_order_dispatched, work_order_state_changed, work_order_failed). All `autopilot.*`, subject = runId,
  `data.workOrder = "WO-N"` for WO events.
- Known gaps from reviews: a spec conversation gone from the agent server (404)
  deadlocks revise/answer/critic follow-ups (should start a new spec attempt); criticStep throws before
  marking handled when finalResponse keeps failing with a non-network error.
- Hardening: critics, like reviewers, restore the expected branch and validated commit before their verdict
  is used. Every successful spec validation retains its SHA, even when no new commit is needed.
- Paused runs keep reconciling their active conversations until pause requests succeed, including after a
  restart. Resume requests write intent before contacting the agent server, so a lost response is reconciled
  back to paused rather than leaving an untracked running agent. Work orders awaiting a budget decision
  stay paused when the rest of their run resumes.
- Budget checks run before scheduling and after conversation costs update. Run exhaustion pauses the run;
  work-order exhaustion holds just that order. Inbox Continue increases the limit by the pinned policy's
  base amount (run: `budget.perChangeUsd`; WO: `budget.perWorkOrderUsd`), with an audit record. Normal Resume
  cannot bypass a run's budget item. Starting an agent that reaches a limit stops further dispatch that tick.
  Enforcement uses reported costs: spending can rise between polls and while a pause request completes.
