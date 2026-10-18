# Issues reviewers found but did not fix (C1–C7)

Verify each against the CURRENT code before acting — later commits may already have fixed it.

Hardening update: critic commits/branch changes and failed resume acknowledgements listed below are fixed.
Automatic run pauses now reach live agents and retry failed pause requests after restart. Run and work-order
budgets are enforced through Inbox decisions; startup dispatch and lost resume responses have regression coverage.
Historical reviewer notes remain below for context.

Durable commands update (milestone 4): follow-ups are now outbox commands written with their state change and reconciled by marker, so the duplicate-follow-up windows noted for C2 (429 and start timeouts), C5 (repair) and C6 (repair after a merge) are closed; a start whose answer was lost is looked up before it is retried. The C3 gap (a spec conversation gone) now offers a new spec agent that is told the lost message.

## review:C1-ledger
- [low] Schema-creation race: openLedger reads PRAGMA user_version outside the BEGIN IMMEDIATE transaction. If two processes open a brand-new DB file at the same moment, both see version 0, and the second fails with 'table runs already exists'. This only matters when two servers start together against a fresh data dir, and the second would fail to bind the port anyway. Not fixed. If it ever matters, re-read user_version inside the transaction.
- [low] transaction() calls ROLLBACK unconditionally in its catch. If SQLite has already rolled back the transaction itself (for example on SQLITE_FULL or an I/O error), ROLLBACK throws 'no transaction is active' and hides the original error. I could not reproduce it cheaply, so it is not fixed. The fix would be to guard it with `if (db.isTransaction)`.
- [low] transaction(fn) only works with synchronous fn, but its type also accepts a function that returns a Promise. An async fn would COMMIT before its await, so writes made after the await would land outside the transaction with no error. It is documented as synchronous, so this is not a defect today. It is a trap for the orchestrator commits.

Reviewer notes: - The run's policy column is named `policy`, not `policy_json`. Write it with updateRun(id, { policy, policyHash }); it is parsed back into run.policy, typed unknown, so cast or validate it in policy.ts (C7).
- ledger.transaction(fn) is synchronous only. Never pass an async function, or it commits at the first await. Do the side effects (agent calls, git) outside it, then write the ledger inside it.
- listAttempts({ workOrderId }) cannot select attempts that have no work order (spec, critic, validator); use the role filter for those. Status and state-name strings are plain TEXT, not validated by the DB.
- decideInbox does not check that the decision is one of the item's option ids, or that needsNote options have a note. The routes layer (C3+) must do that and return 400, as design section 7 says.
- Update helpers throw "No <table> row" for unknown ids. Get helpers return undefined.
- apps/server/tsconfig.json only includes src/, so `pnpm typecheck` does not typecheck test files (tsx strips their types). This was the case before this commit. Keep tests type-correct by hand.
- index.ts is not wired yet. Commit 3 should open the ledger with openLedger(AUTOPILOT_DB) and close it on shutdown.

## review:C2-driver
- [low] Not fixed, note for the orchestrator: POST /conversations/{id}/events can answer 429 when run capacity is full (max_concurrent_runs, default 10). The message is already saved at that point, and the server says to retry /run rather than send the message again. send() throws OpenHandsError(429). If the caller sends again, the message is duplicated. If it ignores the error, the conversation stays idle, and classify() calls it done after the 20 s grace period. POST /conversations can also answer 429, but before anything is created, so retrying start with the same id is safe.
- [low] Not fixed, note: start() uses the default 30 s timeout. An ACP launch that is slow can time out on the client (status 0) while the server is still creating the conversation. A retry with the same id while that create is still running is not covered by the server's existence check. The orchestrator should not retry start more often than once per tick.

Reviewer notes: - OpenHandsError status 0 now covers a refused connection, a timeout (including while reading the body), and 502/503/504 from Canvas's ingress. All of them mean "agent server unreachable, leave the step as is". Any other status is a real answer from the server.
- send() can throw 429. The message is already saved, so don't send it again: retry resume() (POST /run) on a later tick. Until then the conversation sits idle, and classify() will call it done after the grace period, so the orchestrator must remember a pending 429.
- start() can time out (status 0) while the server is still creating the conversation. Retry it with the same id on the next tick, not in a tight loop.
- pause() on an unknown conversation is 400 (both real and fake), not 404. get() on an unknown conversation gives null. Status 'deleting' maps to 'unknown', which classify() treats as running until get() returns null.
- The fake's close() waits at most 5 s for turns in flight. Tests whose handlers do git work should still await fake.settled() (or the orchestrator's idle()) before checking results.
- AGENT_SERVER_URL defaults to the ingress at 127.0.0.1:8000. The agent server itself is on 18000. Canvas's launcher can move the key file with OH_SESSION_API_KEY_PATH, which agentServerKey() does not read. Set SF_AGENT_SERVER_KEY in that case.

## review:C3-spec
- [low] If the spec conversation is gone from the agent server (404), a critic 'revise' or a person's revise/answer can never be delivered. sendFollowUp throws, the run pauses with an error item, and Retry hits the same 404 again, so the only way out is cancel. Not fixed: this is a design gap (it would need 'start a new spec agent when its conversation is gone'). Left for a later commit.
- [fixed] Critic commits and branch changes are reset to the validated spec SHA before planning or follow-ups. Spec validations retain the SHA even without a new commit.
- [low] When the critic's finalResponse keeps failing with a non-network error (for example a 404), criticStep throws before marking the attempt handled. Retry therefore re-reads the same critic instead of starting a new one, as the deviation note claims it does. It still loops back to the inbox. Not fixed.

Reviewer notes: - Work-order branches can't be autopilot/<change>/wo-<n>, because autopilot/<change> already exists as a branch and a git ref can't be both a file and a folder. Use a name that isn't nested under it, e.g. autopilot-wo/<change>/wo-<n>, as the git tests already do. takenChangeNames only scans refs/heads/autopilot/, so add the WO prefix there if it matters.
- Critic rounds now count only critic attempts whose result has a readable verdict. Mirror that for reviewer rounds in C5: errored or unreadable attempts shouldn't use up repair rounds.
- createRun is serialized inside the orchestrator through a promise chain; keep new git/ensureRepo work in createRun inside it.
- Known gaps, not fixed: (a) a spec conversation that's gone (404) deadlocks the revise, answer and critic follow-ups; consider starting a new spec attempt when that happens. (b) A critic or reviewer that commits isn't caught; compare HEAD with the expected sha as well as checking isClean. (c) criticStep throws before marking the attempt handled when finalResponse keeps failing (e.g. a 404), so Retry re-reads the same critic instead of starting a new one.
- An attempt counts as handled when attempt.result.turn equals attempt.turns, and markHandled replaces result. Keep that pattern for builder and reviewer attempts.
- The spec tests use the REAL openspec CLI on a temp copy of workspaces/benefits-portal/openspec. Each e2e test takes about 1.5–2.5 s.

## review:C4-waves
- [medium] Not implemented: design §6 says a step exception for a work order should put that WO in needs_attention and open an `error` item (retry/skip/cancel). Instead, any exception in buildStep (built()/commitAll, or addWorktree in dispatch) goes through failed() and pauses the whole run, with only retry or cancel. A failure that repeats for one WO (for example its worktree is broken) leaves no way to skip it, and one bad WO stops dispatch for the others. Left for C5, which adds more per-WO steps (gates, reviewer) that need the same per-WO wrapper. If an `error` item gets a workOrderId, resume() must stop auto-deciding it, because today it decides every `error` item.
- [fixed] Failed resume requests leave the run paused and are reconciled back to paused remotely, including requests that succeeded but lost their response. Retrying resumes the same conversation.
- [low] In approval bodies, a work-order title containing '|' breaks the markdown table. Titles are not escaped.
- [low] Audit `inbox_opened` puts the full WO id ('ap-xxxx/WO-1') in data.workOrder, while every other WO event uses 'WO-N' as design §10 specifies.
- [low] built() moves a WO to verifying even when the builder changed nothing (sha == base_sha) or committed on a different branch than wo.branch. C5 should check that HEAD is on wo.branch and that the diff against base_sha is not empty.

Reviewer notes: C5 implementer:
(1) Design §6 wants a step exception for one work order to put that WO in needs_attention and open an inbox `error` item (retry/skip/cancel), not to pause the whole run. Today any throw in buildStep (built/commitAll, addWorktree in dispatch) goes through failed() and pauses the run. Add a per-WO try/catch around the WO-level steps (built, gates, reviewer), skipping unreachable() errors. If those `error` items carry a workOrderId, change resume() so it only auto-decides run-level `error` items (workOrderId null).
(2) built() accepts a builder that changed nothing (sha == base_sha) or switched branches. Before running gates, check that HEAD is on wo.branch and the diff is not empty.
(3) commitAll and ensureRepo now exclude **/node_modules/** (ADD_ALL in git.ts), so the install gate's node_modules won't be committed on repair rounds.
(4) wo.findings stays on the WO after a retry and drives the brief's 'previous attempt failed' section. Clear it or overwrite it when repair rounds take over.
(5) WOs left in verifying keep their PARALLEL slot until C5 moves them.
(6) Existing C3 problem: unpause() marks paused attempts as running even when client.resume fails, and poll() then treats a server-side paused conversation as running forever.
(7) Minor: approvalBody does not escape '|' in work-order titles; inbox_opened audit uses the full WO id instead of 'WO-N'.
(8) Git for Windows silently skipped a 601-character path in a probe (core.longpaths is not set). Consider adding `-c core.longpaths=true` to BASE_ARGS if deep source paths show up.

## review:C5-verify
- [low] Duplicate repair follow-up if a crash or a network timeout lands between sendFollowUp and the state write. repair() sends to the builder before moving the work order, and the reviewer or failed builder is not yet marked handled, so the next tick sends again and uses up a second round. This is the same write-ordering pattern as the C3/C4 spec follow-ups.
- [low] detectGates decides on installs before any gate runs, and only where node_modules is missing. A builder that adds a dependency to an already-installed worktree gets no install, and gets 'cannot find module' instead. With npm workspaces, members get a redundant npm install after the root's npm ci.
- [low] Gate processes inherit the factory's full environment, which can include SF_AGENT_SERVER_KEY and, in future, SF_NOTIFY_WEBHOOK. That code is agent-written. The impact is small today because builders run as the same local user and can read ~/.openhands anyway.

Reviewer notes: - A gate now finishes 3 s (CLOSE_GRACE_MS) after its process exits, even if a leaked grandchild keeps the pipe open. That grandchild keeps running; nothing kills it.
- In reviewStep, `git checkout -f wo.branch` runs before the HEAD check. A branch the reviewer created (like reviewer-peek) is left in the workspace repo; C6 cleanup could prune stray branches.
- buildStep's dispatch loop catches per work order: a failure becomes an `error` item whose resumeState is `pending`. A network failure stops dispatching for that tick.
- Still open: in repair() the follow-up is sent before the work order moves and before the reviewer is marked handled, so a crash or network timeout in between can send a second repair follow-up.
- Install detection happens before any gate runs and only where node_modules is missing.
- To typecheck the tests, use a temporary tsconfig extending apps/server/tsconfig.json with include [src, test] and rootDir ".".
- In Git Bash, `python` is the Windows Store stub and hangs; don't use it in commands.

## review:C6-integrator
- [low] finish() calls removeWorktree(integrationDir) without a catch. On Windows an EBUSY (for example a process whose current folder is in the worktree) makes finish throw, and the run pauses with an error instead of reaching done. Each retry repeats that. cancelRun tolerates the same call with .catch(warn). I couldn't confirm the agent server keeps such a process open, so I left it unchanged.
- [low] cleanUp failures are retried on the next step. If the last merge's cleanup fails, finish() runs in that same step and the run goes to done, so that work order's worktree and branch are never retried and stay on disk.
- [low] Crash windows the design accepts: (a) a crash between act() moving a work order to 'merging' and close() deciding the merge_approval item leaves no approval on record. mergeActor then refuses with an error item, and the merge_approval item stays open. (b) A crash between repair's sendFollowUp and moveWorkOrder(building) repeats the merge and sends a second follow-up. Other repair callers have the same pattern.
- [low] askMergeApproval (diffStat) is not wrapped per work order. If it throws, the whole run pauses with a run-level error item instead of only that work order needing attention.
- [low] While the agent server is unreachable, an integration-gate failure re-merges and re-runs the integration gates on every tick. repair's follow-up throws 'unreachable' after preMergeSha is cleared, so the work order stays in 'merging'. The result is correct but wastes gate runs.

Reviewer notes: For C7 (policy): replace mergeDecision() in apps/server/src/autopilot/integrator.ts with evaluateMerge(policy, facts). mergeActor() and the reasons in work_order_merged read from that same function, so change them together; POLICY_ACTOR becomes policy@<hash>.

merged_by is written only when the merge lands. In suggest mode the approver comes from the latest decided merge_approval item, and a suggest-mode merge with no approval on record is refused.

Merging runs in the run's own task: buildStep runs the per-WO steps, then integrateStep, then dispatch. resetIntegration(run, wo, pre, actor) is the one audited way to reset the integration branch; use it for any new reset.

Open low-severity items for the hardening pass:
- finish() does not catch removeWorktree(integrationDir). On Windows an EBUSY pauses the run at the very end; cancelRun uses .catch(warn) for the same call.
- If the final cleanUp fails, finish still runs in the same step, so that worktree and branch are never retried.
- askMergeApproval is not wrapped per work order; if it throws, the whole run pauses.
- Crash windows: act() moving a WO to 'merging' before close() decides the item; repair's sendFollowUp before moveWorkOrder.
- While the agent server is down, integration-gate failures re-merge and re-run the gates on every tick.

Tests in test/ are not covered by pnpm typecheck. To check them, use a temporary tsconfig with include ["src","test"] and rootDir ".".

## review:C7-policy
- [low] Policy gates replace detectGates completely, so the integration branch gets no automatic install step. mergeAndTest still deletes node_modules in folders whose manifest changed, which matters only if a policy gate installed them. A policy.yml that lists gates has to include its own install gate. Left as is and noted.
- [low] Binary files count 0 in linesChanged, so a large binary passes maxChangedLines. Sensitive patterns are also normalised by removing leading dots, so a pattern like `**/.*` becomes `**/*` and matches everything; this errs on the safe side. Not fixed.
- [low] Tests don't cover the per-role agent profiles (agents.spec/critic/builder/reviewer), validateTries, criticRounds or repair counts as read from the policy. The code looks correct, but a regression back to constants would go unnoticed. Not added.

Reviewer notes: - **Gates and installs:** a policy.yml that lists gates gets no automatic install step, in verify or on the integration branch. Its gates must include one (`npm ci`, for example). Otherwise, consider prepending the gates `detectGates` would add for installs.
- **Base branch ref:** addWorktree and takenChangeNames still take baseBranch as a bare name, so a tag with the same name would shadow the branch there too. Pass `refs/heads/<base>` if this gets hardened later.
- **Missing facts:** gatesOk is hard-coded true, hiddenTestsOk is null (fill in C11) and secretFindings is 0 (fill in C10). `addedLines()` in git.ts is ready for the secret scan.
- **Untested policy keys:** the per-role agent profiles, validateTries, criticRounds and the repair counts from the policy have no tests yet.
- **Binary files:** they count 0 toward maxChangedLines.
- **Edit tool and escapes:** the Edit tool turned `﻿` escapes into literal BOM characters. Use a node script for edits that need escape sequences, and grep for `\xEF\xBB\xBF` afterwards.
- **`git hash-object --stdin` in tests:** it hangs under execFile because stdin stays open. Pass a file path instead.
