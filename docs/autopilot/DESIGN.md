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
| `hidden.ts` | Hidden acceptance tests: headers, selection, running, findings by scenario |
| `routes.ts` | HTTP API under `/sf-api/autopilot` (§5) |
| `../demo/` | Fake agent server and scripted agents (tests, `pnpm demo`) |

## 3. States

Run: `spec → critic → (awaiting_answers) → (awaiting_spec_approval) → (awaiting_plan_approval) → building → done → releasing → released`,
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

| `budget_reached` (run) | raise_half, raise_double, cancel |
| `budget_reached` (work order) | raise, skip, cancel |
| `release` | release, hold |

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

## 10. Hidden acceptance tests (opt-in: `hiddenTests.enabled`)

- When a run starts building, the validator (role `validator`, profile
  `agents.validator`) works in `data/hidden-tests/<runId>/`: a copy of the
  change in `spec/`, the plan in `plan.md`, its tests in `tests/`, one per
  scenario with a `// scenario / requirement / requires: WO-n` header.
- When it finishes, each file's SHA-256 goes into `hidden_tests` (schema v5);
  a file that changes later fails as tampered instead of running.
- A work order's gate job runs its gates, then the tests it can satisfy (all
  it `requires` is it or merged), copied into `<worktree>/.factory-hidden/`
  for the run and removed after. A merge's job runs everything merged so far.
  Work orders wait in `verifying` until the validator has finished.
- Failures reach the builder as `Scenario "X": A hidden acceptance test fails:
  <first assertion line>`; the output is a check for people.
- No tests written (the validator failed or wrote none) puts every merge in
  front of a person (`hiddenTestsMissing`).
- `GET /runs/:id` includes `hiddenTests` (file, scenario, requires, sha256,
  runs, lastOk); the Pipeline lists them.

## 11. Budgets

Checked in every step from the agents' accumulated cost, before the stage
moves on. The change's budget is the run's (`budgetUsd`, typed on Home) or
`policy.budget.perChangeUsd`; reaching it pauses the run and its agents with a
run-level `budget_reached` item (raise by half or double, or cancel), and
Resume refuses until it's raised. A work order in `building` or `reviewing`
that reaches `perWorkOrderUsd + budgetExtraUsd` has its conversations paused
and goes to `needs_attention` with its own `budget_reached` item (raise by one
more `perWorkOrderUsd`, skip, cancel); the rest of the run goes on. Raising is
audited (`autopilot.budget_raised`). `GET /runs/:id` reports the effective
budgets and `projectedCostUsd` (spent so far plus the merged average for each
work order left).

## 12. Builder routing

`builderRoute`: the profile `policy.routing[risk]` names, else
`agents.builder`, else Canvas's active profile. Each fresh builder after one
that failed moves the level up (low → medium → high), so a cheaper model that
couldn't do the work hands it to a stronger one. The reason is audited with
the dispatch (`routedBy`). Profiles named in `routing` are checked at
`createRun` and in `/status`, like `agents`.

## 13. Release

A run that finishes with something merged opens a `release` item (release,
not now). Release moves the run to `releasing`; `releaseStep` merges the
integration branch into the base branch's tip in a detached worktree
(`worktrees/<run>/release`). If the base didn't move since the run branched,
the merge is exactly the tested tree; otherwise the gates run on it (a job;
checks with stage `release`). Then the base branch moves to the merge with a
compare-and-swap: `merge --ff-only` in the workspace when it has the base
checked out (refused with uncommitted tracked changes), `update-ref <new>
<old>` otherwise. A conflict, failing gates, a moved integration branch or a
base that moved during the test sends the run back to `done` with a new item
saying why. `released` records `releasedBy` (the person, or `policy@<hash>`
when `release.auto` and autonomy is autonomous), `releasedSha` and
`releasedAt`; audited as `autopilot.release_requested`, `release_failed` and
`run_released`. `POST /runs/:id/release` is the Pipeline's Release button.

## 14. Evidence

`GET /runs/:id/evidence` (evidence.ts) puts together, from the ledger, git and
the audit log, what an assessor asks for. Nothing in it is new state:

- `traceability`: every `#### Scenario:` of the change's specs, as the
  released commit (or the integration tip) has them, with the hidden tests
  for it (file, sha256 from the manifest, how often each ran and how it last
  ended) and the work orders it needs, each with who let it in: `{by, kind}`
  where `kind` is `policy` (`policy@<hash>`) or `person`.
- `workOrders`: risk, controls, acceptance, approval, the merge sha, and
  `mergeReasons`, the policy rules that sent it to a person (empty when the
  policy merged it because every rule held). Also the last review verdict,
  builder count, checks passed and failed, and cost.
- `controls`: each NIST control the plan names, and the work orders that carry it.
- `decisions`: every decided Inbox item in order, with the option label the
  person saw, their note, who and when.
- `spec` (validations, critic verdict, the plan's approver), `policy` (hash,
  source, cap, autoMerge, review blocking, hidden tests, release.auto),
  `release`, and `audit` (this run's event count and seq range, plus
  `verifyAudit()` over the whole chain).

`?download=1` adds `Content-Disposition: attachment;
filename="evidence-<change>-<run>.json"` and records
`autopilot.evidence_exported` (counts only). The Canvas page
`/autopilot/runs/:id/evidence` shows the same JSON, linked from the Pipeline.

## 15. Self-healing

- **Watchdog** (`watch`, policy `selfHealing.quietMinutes`, default 20).
  Progress is a new event count (`GET /api/conversations/{id}/events/count`,
  since cost stays 0 on subscription logins), new cost, or a status change; each
  attempt keeps `progressAt`, `events` and `nudgedAt` (ledger v7). Event counts
  are fetched only for a running agent quiet for half the time. When it's quiet
  for the full time, the conversation is paused and sent `quietNudge` (not a
  turn, so the repair limits don't move). Quiet as long again, it's paused and
  the attempt ends `stuck` with `result.watchdog`. Audited as
  `autopilot.agent_nudged` and `agent_finished` with reason `watchdog`.
- **Restart once** (`restartable`, `restart`): a spec agent, critic, validator
  or reviewer that stops without finishing (an error, the watchdog, a
  conversation the agent server lost) is started fresh once per role and work
  order, with the old attempt marked `outcome: restarted` and audited
  `autopilot.agent_restarted`. A second stop takes the old path to a person.
  Builders keep their repair loop.
- **Outages**: a call that can't reach the agent server leaves everything as it
  is (as before) and also opens an in-memory outage. `autopilot.agent_server_down`
  is audited once, a `notice` goes to the webhook once it lasts `outageAlertMs`
  (2 min), and on the first answer after it `agent_server_back` (with
  `downSeconds`) plus a notice if one went out. `/status` has
  `agentServer.downSince`; Home shows it. A conversation that's gone (404) ends
  with `result.lost`; up to two lost builders per work order don't count
  against `repair`.
- **Cold starts**: `classify` takes `progressed` (events grew since the
  message, read only for `idle` never seen running). `idle` with no new events
  waits up to 3 minutes instead of the 20 s grace; `finished` is unchanged.
- `pinnedPolicy` fills in settings added after a run was pinned with their
  defaults, so older runs keep working as the policy grows.

## 16. Changes since the first build

- Canvas pages: Home (`/autopilot`), Pipeline (`/autopilot/runs/:id`), Inbox
  (`/inbox`) with a sidebar badge, built against the JSON in §5 and checked in a
  browser against the scripted fake agent server.
- Inbox items carry `change` and `workOrderKey`; costs are rounded; `/status`
  reports the policy's autonomy default and cap.
- Merge reasons in inbox bodies are markdown-escaped (a `**/auth/**` glob used to
  render as bold text); the audit log keeps them as plain text.
