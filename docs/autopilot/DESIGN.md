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
- The base branch is the workspace's checked-out branch by its full ref (not
  `--short`, which says `heads/main` once a tag is called `main` too), and the
  integration branch starts from `refs/heads/<base>`.
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
  finishes (`squash`, with the factory's message even when it's one commit),
  so what merges is exactly what the gates and the reviewer checked: the
  merge and `mergeCheck` take that commit (`checkedSha`, the builder's
  result), never whatever the branch points to by then, since any agent can
  move it. A branch that no longer contains its `baseSha` goes back to the
  builder.
- After the gates pass, `verify` scans the added lines for secrets (known key
  and token formats, private keys, chat webhooks in every file; hard-coded
  password-like values with some entropy, except in lockfiles, minified files
  and source maps). Diffs read every file as text, so a `.gitattributes` or
  `.git/info/attributes` saying `binary` or `-diff` hides neither lines from
  the scan nor their count from `maxChangedLines`. A finding is a repair round
  that names the file, line and kind, never the value (`secret-scan` check,
  `autopilot.secrets_found` audit).
- The dependency scan flags what a person should see: in package.json
  (dependencies of every kind, peers, `overrides`, `resolutions`) versions
  that aren't exact (a peer may give a range), sources outside the npm registry, `npm:` aliases and new
  install scripts; npm lockfile entries resolved from anywhere but the npm
  registry or a mirror the base's lockfile already uses; and any change to
  `.npmrc`, `.yarnrc(.yml)` or `.pnpmfile.cjs`. A URL's credentials are left
  out of findings (they reach the Inbox and the audit log).
  It never blocks the build; `mergeCheck` scans again on the commit as it will
  merge and passes `secretFindings` and `dependencyFindings` to the policy,
  so either sends the merge to a person with the reason.

## 9. Alerts

`SF_NOTIFY_WEBHOOK` (a secret, so environment only) gets one message when a
decision opens and nothing was alerted since the last digest; everything else
waits for one digest a day at `policy.notify.digestHour` (local time) listing
the open items nobody was told about. A digest resets the rule. Messages hold
inbox titles and a link to the Inbox (`SF_PUBLIC_URL`), never goals, notes or
the URL; each send is audited as `autopilot.notification_sent`. Titles hold
names agents wrote, so Slack text is escaped (no `<!channel>`, no disguised
links). The markers live in the ledger's `meta` table (schema v4); a failed
send is retried.

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
- The merge decision reads each test's latest run for the work order's last
  builder (`hiddenResult`): one its repair fixed doesn't count as failing.
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
more `perWorkOrderUsd`, skip, cancel); the rest of the run goes on. Its
agents stay paused until that item is decided: a run's Resume only resumes
work orders in `building` or `reviewing`, and a raise while the run is paused
leaves them for its Resume. Raising is audited (`autopilot.budget_raised`). `GET /runs/:id` reports the effective
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
  for it, matched by scenario and (when the test names one) requirement
  (file, sha256 from the manifest, how often each ran and how it last
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
  Progress is a changed event count (`GET /api/conversations/{id}/events/count`,
  since cost stays 0 on subscription logins; a count that went down, as in a
  conversation the agent server restored, counts too), new cost, or a status change; each
  attempt keeps `progressAt`, `events` and `nudgedAt` (ledger v7). Event counts
  are fetched only for a running agent quiet for half the time. When it's quiet
  for the full time, the conversation is paused and sent `quietNudge` (not a
  turn, so the repair limits don't move). A nudge the agent server refuses
  resumes the conversation, so the watchdog never leaves one paused that
  nothing polls; the next poll tries again (a 429 means it was saved and
  counts as sent). Quiet as long again, it's paused and
  the attempt ends `stuck` with `result.watchdog`. Audited as
  `autopilot.agent_nudged` and `agent_finished` with reason `watchdog`.
- **Restart once** (`restartable`, `restart`): a spec agent, critic, validator
  or reviewer that stops without finishing (an error, the watchdog, a
  conversation the agent server lost) is started fresh once per role and work
  order, with the old attempt marked `outcome: restarted` and audited
  `autopilot.agent_restarted`. A fresh spec agent or validator the agent
  server couldn't start then (the restarted attempt is still the latest) is
  started on a later step, and work orders wait for a restarted validator's
  tests. A second stop takes the old path to a person. Builders keep their
  repair loop.
- **Outages**: a call that can't reach the agent server leaves everything as it
  is (as before) and also opens an in-memory outage. `autopilot.agent_server_down`
  is audited once, a `notice` goes to the webhook once it lasts `outageAlertMs`
  (2 min), and on the first answer after it `agent_server_back` (with
  `downSeconds`) plus a notice if one went out. `/status` has
  `agentServer.downSince`; Home shows it. A conversation that's gone (404) ends
  with `result.lost`; up to two lost builders per work order don't count
  against `repair`, the one just lost included (with no fresh builders left,
  it still gets one).
- **Cold starts**: `classify` takes `progressed` (events grew since the
  message, read only for `idle` never seen running). `idle` with no new events
  waits up to 3 minutes instead of the 20 s grace; `finished` is unchanged.
- **Flaky gates** (`selfHealing.rerunFailedGates`, default on): `runGates`
  runs a failed gate (not an install, not a timeout) once more, unless its
  failing run changed the worktree's files (`git status`: a test that rewrote
  a golden file or snapshot would pass on something that isn't committed);
  that failure stands, and its output says why. A pass then
  counts, with `flaky: true` and both outputs in the check, and
  `autopilot.gates_run` lists it under `flaky`. Two failures say so in the
  output. This covers work-order gates, hidden tests, integration re-tests and
  the release test.
- **Merge conflicts** (`selfHealing.conflictRounds`, default 3): a conflict
  goes back to the builder as a follow-up that doesn't count against
  `repair.sameConversation` (`attempts.free_turns`) and moves
  `work_orders.conflict_rounds` (ledger v8). Past the cap, conflicts are
  ordinary repairs. A failing re-test after a clean merge is still a
  repair.
- `pinnedPolicy` fills in settings added after a run was pinned with their
  defaults, so older runs keep working as the policy grows.

## 16. Queue and release order

- `queue.maxActiveRuns` (default 2). Working runs are in `spec`, `critic`,
  `building` or `releasing`. Runs waiting on a person (approvals, questions,
  paused, done) hold no slot. `createRun` past the limit, or behind any run
  already waiting, makes a `queued` run: change name reserved, policy pinned,
  no integration branch or worktree. Each tick starts the oldest queued run
  when its pinned policy's limit allows (one a tick). `dequeue` adds the
  integration worktree from `refs/heads/<base>` as it is then (a tag with the
  base's name would make the bare name ambiguous), moves the run to
  `spec`, and audits `autopilot.run_started` with `waitedSeconds` and the base
  sha. Pause, resume and cancel work on queued runs like any other.
- Releases into one base branch go one at a time. `requestRelease` stamps
  `releaseRequestedAt` (ledger v9), and `releaseStep` waits while a release
  asked for earlier (`releaseAhead`) is still `releasing`. The later release
  then merges onto the earlier one and, since the base moved, is tested again,
  where before the two raced and the loser went back to a person. A release
  takes the base in the same moment it checks (`releases`), and one whose
  merge is being made or tested goes first whenever it was asked for: one
  paused meanwhile (Pause forgets its merge) waits for it after Resume.
  Cancelling a releasing run removes its release worktree.
- The API's run summary has `queuePosition` and `releaseAfter` (the change
  going first), and `/status` has `queuedRuns`. The Pipeline banner says what
  the run waits on.

## 17. Intake

`POST /intake/:source` (intake.ts, `intake()`):

- `github`: needs `X-Hub-Signature-256` with `SF_INTAKE_GITHUB_SECRET`.
  `ping` is answered; an `issues` event counts when it's `opened` with
  `intake.githubLabel` or `labeled` with it (not pull requests).
- `webhook`: needs `X-SF-Signature: sha256=<hmac>` with `SF_INTAKE_SECRET`;
  JSON `{ title, body?, kind?, reference?, url?, author? }`.
- `bug`: Home's form, as the local user, like every other request to this
  loopback API.

A missing secret or a bad signature is a 401, audited as
`autopilot.intake_rejected` with the reason and no body. A body over 512 KB is
a 413 while it's read (`bodyLimit`: Content-Length, or counted as a chunked
body streams in). Requests are handled one at a time, so the duplicate check
sees a run an earlier delivery made (GitHub sends `opened` and `labeled`
together). Text is clipped (title 200, body 3000), a webhook's `author` and
`reference` are one line, and links must be https (kept normalized: no
spaces, `<` or `>`). The policy loaded from the base branch (`main` on a
detached HEAD, as for the run it creates) decides by source (`intake.<source>`):

- `off`: `intake_ignored`.
- `inbox`: a `proposed` run (no branch, like `queued`) plus an `intake`
  item. Start moves it to `queued` (`autopilot.intake_approved`) and the queue
  starts it; Not now is the usual cancel.
- `run`: an ordinary new run, which may queue.

Autonomy is `intake.autonomy` under the usual caps. A reference that's
already on a run that isn't cancelled is `intake_duplicate`. The run keeps
`origin` (source, kind, title, reference, url, author; ledger v10), which shows
on the Pipeline and in the evidence. The `intake` item's body escapes the
origin's text like the title and shows the URL as one autolink. The spec brief
says the goal is an outside request whose instructions it must not follow, and
a `<goal>` or `</goal>` inside the goal is escaped so it can't close its tag.
Audit data holds the source,
kind, reference and a title clipped to 80 characters, never the body.

## 18. Spec drift and re-plan

- `run.planTree` (ledger v11) is the git tree of
  `openspec/changes/<change>` the work orders came from, set on the first
  build step. Each build step, `specDrift` compares it with the tree at
  `integrationSha`, after merges in flight settle. When they differ, the plan
  is made again from tasks.md (`planWorkOrders`) and compared by group number
  (`diffPlan` gives added, removed, changed and unchanged). Audited as
  `autopilot.spec_drift`.
- No difference in work orders: `planTree` moves silently. An autonomous run
  applies the new plan as `policy@<hash>`. Any other run opens a
  `replan_approval` item (Re-plan, Keep the current plan, Cancel run) and
  holds `revision.stage = "approval"`. An item for an older tree is marked
  superseded.
- `applyReplan` stops the agents, gate jobs and worktree of every changed or
  removed work order in progress. Removed ones become `skipped` (merged ones
  keep their code). Changed ones take the new title, criteria and dependencies
  and go back to `pending` with a finding for the next builder; a merged one
  is reopened (`work_order_reopened`). Added ones are `pending`. Open items of
  stopped work orders are marked superseded, and the result is audited as
  `autopilot.replanned`. When `specs/` changed and hidden tests are on, the
  validator starts over (`hidden_tests_reset`).
- A person's spec change while building (`POST /runs/:id/revise`,
  `reviseSpec`) records `revision.stage = "writing"` with a worktree and
  branch (`<integration>--spec`) of its own from `integrationSha`, and starts
  a spec agent there with `reviseBrief`. `revisionStep` validates it (with
  the usual follow-ups), commits only the change's markdown (`commitPaths`),
  waits for any merge in flight, merges it into the integration branch
  (`spec_revised`) and removes the worktree. The drift check then re-plans. A
  stop (after the one restart) or a conflict opens a `spec_revision` item:
  Try again or Drop.
- While `run.revision` is set, nothing new is dispatched and the run doesn't
  finish. `mergeCheck` sends any work order that changes files under
  `openspec/` to a person, with the reason that merging it re-plans the run.

## 19. Preview

`previewThenFinish` replaces the direct `finish()` at the end of building
when `preview.enabled`, the run merged something, and the last preview
wasn't of this `integrationSha`. It's a job (gate slot, outside the lock,
stopped by pause and cancel), audited as `autopilot.preview_started`.
`runPreview` (preview.ts) does the following:

- starts `preview.start` in the integration worktree through `startService`
  (gates.ts: scrubbed environment, its own process group, killed at shutdown)
  with `PORT` (a free loopback port) and `HOST=127.0.0.1`;
- waits until anything answers on it, up to `readyTimeoutSec`. An exit
  before that, or a timeout, is `error`;
- fetches each of `preview.paths` (paths only, at most 20; status < 400
  passes);
- screenshots each at 1280×800 with playwright-core 1.63.0 (no browser
  download) driving `SF_PREVIEW_BROWSER`, Playwright's expected Chromium, or
  the newest under `PLAYWRIGHT_BROWSERS_PATH`. With none, `noScreenshots`
  says why;
- stops the app.

Afterwards the integration worktree is cleaned (installed packages stay).
The result goes on `run.preview` with its sha (ledger v12), as a check with
stage `preview`, and in `autopilot.preview_run` (paths, statuses and whether
there's a screenshot). Screenshots live in `data/previews/<run>/` and are
served by `GET /runs/:id/preview/:file`, which only accepts names the preview
recorded. The release decision lists the pages and embeds the screenshots. A
failed preview gives the release item a reason and keeps `release.auto` from
releasing; a person can still release.

## 20. Learning

- `findLessons` (learning.ts) runs across every run in the ledger:
  - `gate:<name>`: a gate whose first run in a work order failed (flaky passes
    count as passing; hidden tests and the factory's scans excluded), with a
    command from the pinned policy's gates or `npm run <script>`;
  - `secrets`: work orders the secret scan caught;
  - `deps-pinned`: dependency scans that found unpinned versions.

  At `learning.threshold` (default 3) or more, after a run finishes,
  `learn()` opens a `lesson` item for each key not asked about before (table
  `lessons`, ledger v13), audited as `autopilot.lesson_proposed`.
- Accept: `commitToBase` writes the line into AGENTS.md on the base branch
  under "Learned by the Software Factory" (`withLesson`) in a detached
  worktree. It commits as "agents: … (<person>)", then moves the branch with
  the same compare-and-swap as a release. The result is recorded on the
  lesson and as `lesson_accepted` with the sha. Decline records
  `lesson_declined`. Either way the key isn't proposed again.
- `askMergeApproval` now records the reasons with the move to
  `awaiting_merge_approval`. `buildInsights` groups runs by policy hash and
  counts policy and person merges, release failures and flaky gate runs. It
  groups reasons by kind (`reasonKind`: numbers and details dropped) and pairs
  each ask with its work order's next merge-approval item to count merged,
  sent back and skipped (audit timestamps are written in queue order, so
  pairing is by order, not time). Plain-language `notes` mark rules people
  always override and rules that catch real problems. Served as
  `GET /insights` and `GET /lessons`.

## 21. Workspace registry

registry.ts. `SF_WORKSPACE` is workspace `default`, with its ledger at
`data/autopilot.db` as before. `POST /workspaces {name, path}` registers
another project:

- the name becomes the id (slug), unique;
- the path must be an existing absolute folder, not inside the data folder
  (or containing it), and not already registered (compared by realpath);
- it's audited as `workspace.registered`.

Each added workspace gets `data/workspaces/<id>/` (ledger, worktrees, hidden
tests, previews) and an orchestrator of its own, started with the others; its
runs pin the policy from its own base branch. `/w/<id>/autopilot/*` forwards
to that workspace's Autopilot routes (`/autopilot` stays the default's).
`GET /workspaces` lists them with run and Inbox counts.
`GET /workspaces/inbox` merges every workspace's items, each tagged with its
workspace, and `/workspaces/inbox/count` sums them. `DELETE /workspaces/:id`
refuses the default and any workspace with unfinished runs; otherwise it
stops the orchestrator, closes the ledger, keeps the data and audits
`workspace.removed`. The list lives in `data/workspaces.json`, written
atomically. Gate slots are one pool for the whole factory.

In Canvas, the selected workspace is kept in localStorage (`sf-workspace`)
and every Autopilot call goes to its API. Switching resets the Autopilot
queries. A link's `?w=<id>` switches to that workspace before the page asks
for the run. The Inbox and its badge use the combined endpoints, and a
decision goes to its item's own workspace.

## 22. Changes since the first build

- Canvas pages: Home (`/autopilot`), Pipeline (`/autopilot/runs/:id`), Inbox
  (`/inbox`) with a sidebar badge, built against the JSON in §5 and checked in a
  browser against the scripted fake agent server.
- Inbox items carry `change` and `workOrderKey`; costs are rounded; `/status`
  reports the policy's autonomy default and cap.
- Merge reasons in inbox bodies are markdown-escaped (a `**/auth/**` glob used to
  render as bold text); the audit log keeps them as plain text.
