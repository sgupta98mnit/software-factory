# Autopilot design (as built)

The original design contract wasn't kept in this repo. This document records the
contract as the code implements it, and every later change updates it. Where it
and the code disagree, the code and its tests win; fix this file. The product
thesis behind it is `docs/research/00-claude-findings.md` §4–6.

## 1. Shape

```
Goal ─▶ spec agent ─▶ openspec validate --strict ─▶ commit ─▶ critic ─▶ plan (waves)
     ─▶ approval (by autonomy) ─▶ builders in worktrees (policy.parallel at once)
     ─▶ gates (run by the factory) ─▶ reviewer ─▶ merge decision (policy or person)
     ─▶ integrator (one merge at a time, gates again) ─▶ done: the integration branch
                      ▲                       │
                      └──── repair ◀──────────┘  same builder ×2, fresh ×1, then a person
```

- Workers are OpenHands conversations (`apps/server/src/autopilot/openhands.ts`).
  The factory makes every worktree and branch; agents never branch or merge.
- State lives in SQLite (`data/autopilot.db`, `ledger.ts`). Each scheduler step
  reads state, does one side effect, writes the new state, so a restart resumes.
- Every state change is an `audit()` record. Audit data never holds a full goal,
  note or prompt: a one-line clip plus a SHA-256.

## 2. Modules

| File | Does |
| --- | --- |
| `ledger.ts` | Tables `runs`, `work_orders`, `attempts`, `checks`, `inbox`; costs summed from attempts |
| `openhands.ts` | REST driver: profiles, start (caller-chosen UUID), get, send, pause, resume, final response; `classify()` |
| `orchestrator.ts` | The state machine and scheduler (`tick()` every 3 s), people's actions (`decide`, `pause`, `resume`, `cancel`) |
| `spec.ts` | Change names, `openspec validate`, critic verdict parsing, proposal sections |
| `waves.ts` | tasks.md → work orders, dependency waves, risk score |
| `gates.ts` | npm gate detection, gate runner with timeouts and process-tree kill |
| `review.ts` | Reviewer verdict parsing, finding clusters for repair messages |
| `integrator.ts` | Merge into the integration worktree, gates again, reset on failure |
| `policy.ts` | `.factory/policy.yml` from the base branch, validation, `evaluateMerge` |
| `prompts.ts` | Every brief and follow-up, rebuilt from the ledger |
| `scan.ts` | Secret scan of added lines, dependency scan of package.json changes |
| `notify.ts` | Slack/Teams webhook alerts: one alert, then a daily digest |
| `routes.ts` | HTTP API under `/sf-api/autopilot` (§5) |
| `../demo/` | Fake agent server and scripted agents (tests, `pnpm demo`) |

## 3. States

Run: `spec → critic → (awaiting_answers) → (awaiting_spec_approval) → (awaiting_plan_approval) → building → done`,
plus `paused` (with `resumeState`), `failed` (nothing merged) and `cancelled`.

Work order: `pending → building → verifying → reviewing → ready → (awaiting_merge_approval) → merging → merged`,
plus `needs_attention` (with `resumeState`), `skipped`, `cancelled`. `building`,
`verifying` and `reviewing` count against `policy.parallel`. Dependents wait for
`merged` or `skipped`.

Autonomy: `suggest` (person approves spec, plan, every merge), `supervised`
(person approves the plan; merges follow the policy), `autonomous` (the critic
replaces the plan approval). The effective level is the lowest of the request,
`policy.autonomy.max` and `SF_AUTONOMY_CAP`.

## 4. Who decides

- Merges the policy allows are recorded with actor `policy@<hash>`, where the
  hash is the first 12 hex of SHA-256 over the policy's canonical JSON.
- Everything else is an inbox item with options; `decide()` checks the choice is
  one of them and that a `needsNote` option has a note. A person's merge is
  recorded with their name.
- The policy is read from `refs/heads/<base>` when the run is created and pinned
  on the run; worktrees and work-order branches are never consulted.

## 5. HTTP API (`/sf-api/autopilot`)

All JSON, camelCase. Errors are `{ error }` with 404 (missing run or item) or
400. Changes require `Content-Type: application/json` (index.ts).

| Method and path | Returns |
| --- | --- |
| `GET /status` | `{ agentServer: { url, reachable, error, profiles[], activeProfileId }, workspace: { path, isRepo, branch }, policy: { source, hash, error, autonomy: { default, max } \| null }, openInbox, activeRuns }` |
| `GET /runs` | `RunSummary[]`, newest first |
| `POST /runs` `{ goal, autonomy?, budgetUsd? }` | `RunSummary` |
| `GET /runs/:id` | `RunDetail` = summary + `workOrders[]`, `attempts[]`, `checks[]`, `inbox[]` (all states), `etaMs` |
| `POST /runs/:id/pause\|resume\|cancel` `{ note? }` | `RunSummary` |
| `GET /inbox?state=open\|decided\|all` | `InboxItem[]`, newest first |
| `GET /inbox/count` | `{ open }` |
| `POST /inbox/:id/decide` `{ choice, note? }` | `InboxItem` |

`RunSummary`: `id, goal, change, autonomy, state, pausedReason, baseBranch,
integrationBranch, costUsd, budgetUsd, policyHash, createdBy, createdAt,
updatedAt, counts { total, merged, active, failed, pending }, openInbox`.

Work order view: `id, runId, seq, key ("WO-n"), title, acceptance[], controls[],
dependsOn[] (seqs), wave, risk, state, branch, costUsd, attempts (builder
conversations), round (messages to the latest builder), conversationId,
findings, mergedBy, updatedAt`.

Inbox item: `id, runId, workOrderId, kind, title, body (markdown), options[] {
id, label, tone?, needsNote? }, state, decision, note, decidedBy, decidedAt,
createdAt, change, workOrderKey`.

Costs are rounded to a tenth of a cent. `etaMs` is the median dispatch-to-merge
time of merged work orders times the waves of work left; null until one merges.

The Canvas client (`canvas/src/factory/api.ts`) mirrors these types; change both
together. `/sf-api/events` sends `autopilot.changed` (with `runId`) whenever a run
or its work orders move.

## 6. Inbox kinds and choices

| Kind | Options |
| --- | --- |
| `spec_approval`, `plan_approval` | approve, revise (note), cancel |
| `questions` | answer (note), proceed, cancel |
| `spec_failed`, `error` (run-level) | retry, cancel |
| `work_order_failed` | retry (one more fresh builder), skip, cancel |
| `error` (work order) | retry (from where it threw), skip, cancel |
| `merge_approval` | merge, send_back (note), skip |
| `run_paused` | resume, cancel |
| `integration_moved` | restore (put the branch back where the factory left it), cancel |

`budget_reached` and `release` are reserved kinds (see OPEN-ISSUES.md for status).

## 7. Invariants the tests hold

- A run is handled by one thing at a time (`inflight` per run): the scheduler's
  step, or a person's action, which waits for that step. Steps are short: gates
  and a merge's re-test run as jobs outside the lock (at most
  `SF_GATE_CONCURRENCY`, default 2, factory-wide); a step starts the job and a
  later step records its outcome. Pause, Cancel and a run-level stop kill the
  run's jobs; a stopped job records nothing and runs again on resume.
- Attempts are written before the agent server is called (write-ahead) with a
  fixed conversation id, so a restart can start the same conversation again.
- An end state right after a follow-up counts only once the conversation was
  seen running or 20 s passed (`classify`).
- The reviewer and critic only read: whatever they change or commit is thrown away and recorded.
- The integration branch is the factory's alone. The run keeps the sha it last
  wrote (`integrationSha`: branch creation, the spec commit, each tested merge);
  before every build step and before delivering, a branch that moved (or a
  worktree switched to another branch) pauses the run with an
  `integration_moved` item whose `restore` puts it back.
- Builders branch from `integrationSha`, never the live ref (a merge being
  re-tested isn't a base). While a merge is tested the guard accepts exactly its
  `mergeSha`; after a restart, only a commit whose tree is the clean merge of
  the factory's tip and the work order's branch.
- The factory's git never runs repo hooks or fsmonitor, and diffs without
  external diff drivers or textconv.
- The spec commit holds the change's markdown and `.openspec.yaml` in `openspec/changes/<change>/` only; anything else the
  spec agent wrote or committed is discarded and recorded (`spec-edits-discarded`).
- A merge whose gates fail is reset (not reverted) so the fixed branch can merge again.
- An exception in one work order's step, or a conversation of its that the
  agent server can't start or report on, stays with that work order: the step
  goes to `needs_attention`, the attempt fails and is repaired. Three such work
  orders pause the run. Only the factory's setup (a refused session key, a
  profile the policy names that doesn't exist) stops a run as a whole, once.
- The API binds to 127.0.0.1 and rejects other Host headers.

## 8. Scans

- A builder's branch is squashed to one commit after `baseSha` when it
  finishes (`squash`), so what merges is exactly what the gates and the
  reviewer checked; a branch that no longer contains its `baseSha` goes back
  to the builder.
- After the gates pass, `verify` scans the added lines for secrets (known key
  and token formats, private keys, chat webhooks, hard-coded password-like
  values with some entropy; lockfiles skipped). A finding is a repair round
  that names the file, line and kind, never the value (`secret-scan` check,
  `autopilot.secrets_found` audit).
- The dependency scan flags package.json changes a person should see: versions
  that aren't exact, sources outside the npm registry, new install scripts.
  It never blocks the build; `mergeCheck` scans again on the branch as it will
  merge and passes `secretFindings` and `dependencyFindings` to the policy,
  so either sends the merge to a person with the reason.

## 9. Alerts

`SF_NOTIFY_WEBHOOK` (a secret, so environment only) gets one message when a
decision opens and nothing was alerted since the last digest; everything else
waits for one digest a day at `policy.notify.digestHour` (local time) listing
the open items nobody was told about. A digest resets the rule. Messages hold
inbox titles and a link to the Inbox (`SF_PUBLIC_URL`), never goals, notes or
the URL; each send is audited as `autopilot.notification_sent`. The markers
live in the ledger's `meta` table (schema v4); a failed send is retried.

## 10. Changes since the first build

- Canvas pages: Home (`/autopilot`), Pipeline (`/autopilot/runs/:id`), Inbox
  (`/inbox`) with a sidebar badge, built against the JSON in §5 and checked in a
  browser against the scripted fake agent server.
- Inbox items carry `change` and `workOrderKey`; costs are rounded; `/status`
  reports the policy's autonomy default and cap.
- Merge reasons in inbox bodies are markdown-escaped (a `**/auth/**` glob used to
  render as bold text); the audit log keeps them as plain text.
