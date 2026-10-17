# Autopilot: open issues

Defects found by adversarial reviews, most important first. Each entry says
where, what breaks, and its status. "Fixed in" names the commit subject; the
regression test named there fails without the fix. Verify an entry against the
current code before acting on it.

Source: an audit of `apps/server/src/autopilot/*` on 17 Oct 2026 (repros were
run against the fake agent server), and the Phase 1 UI review.

## Confirmed

| # | Severity | Issue | Status |
| --- | --- | --- | --- |
| 1 | high | **A builder can put commits on the integration branch.** The factory never checked that the integration tip was the one it last wrote, so a builder that ran `git update-ref refs/heads/autopilot/<change> HEAD` from its worktree got code onto the deliverable with no gates, review or approval (`integrate`, `finish`). | Fixed in "the integration branch takes only what the factory checked" (`autopilot-harden.test.ts` #1) |
| 2 | high | **The spec commit took every file in the integration worktree.** In autonomous mode a spec agent that also wrote `src/auth/allow-all.js` and a relaxed `.factory/policy.yml` had both committed to the integration branch with no person seeing them (`specStep` → `commitAll`). | Fixed in "the integration branch takes only what the factory checked" (#2) |
| 3 | high | **A poll error on one conversation paused the whole run.** `advance()` polled every attempt before `buildStep`'s per-work-order catch, so a 500 for one builder's conversation reached `failed()`, paused the run, and resume hit it again. | Fixed in "one conversation's trouble stays with its work order" (`autopilot-harden.test.ts` #3) |
| 4 | medium-high | **A person's decision, pause or cancel waited behind running gates.** Gates ran inside the scheduler step that holds the run's lock, so an Inbox click or Cancel could hang for as long as a gate (600 s by default) and couldn't stop it. | Fixed in "gates run outside the run's lock" (#4) |
| 5 | medium | **Automatic pauses left agents running and spending.** Three failing work orders, or a step error, moved the run to `paused` without pausing its conversations; only a person's Pause did. | Fixed in "a paused run stops spending" (`autopilot-harden.test.ts` #5) |
| 6 | medium | **Gates left background processes running after they passed**, and gate process groups outlived the factory. | Fixed in "gates clean up after themselves and don't see secrets" (#6) |
| 7 | medium | **Gates got the factory's whole environment**, including `SF_AGENT_SERVER_KEY` and any other secret, for builder-written tests and install scripts to read. | Fixed in "gates clean up after themselves and don't see secrets" (#7; `SF_GATE_ENV` passes a named variable through) |
| 8 | medium-low | **Configuration errors were blamed on work orders.** A wrong session key (401/403) or a `policy.agents` profile that doesn't exist failed every work order one by one, burning their repairs, instead of stopping once with the real cause. | Fixed in "one conversation's trouble stays with its work order" (#8 tests) |
| 9 | low | ETA was median × ceil(remaining / parallel) rather than by waves, and 0 instead of null for a finished run. | Fixed in "small hardening" (#9) |
| 10 | low | A failed clean-up of a merged work order was never retried before the run finished. | Fixed in "small hardening": the run finishes only once every merged worktree is gone. Skipped work orders keep their branch on purpose (it holds work a person chose not to merge). |
| 11 | low | `ensureRepo` committed `.env` files when it initialised a workspace, and `commitAll` would commit a `.env` an agent wrote. | Fixed in "small hardening" (#11): `.env`, `.env.local`, `.env.*.local` and the per-environment files are never committed; `.env.example` is |
| 12 | low | Default `sensitivePaths` missed common sensitive files: `src/crypto.js`, `Dockerfile.prod`, `.env*`, `Jenkinsfile`, `.gitlab/**`, `docker-compose*.yml`, nested `.github/`. | Fixed in "small hardening" (#12; the default policy hash changes) |
| 13 | low | Audit records could be lost on shutdown: SIGINT/SIGTERM exited without draining the audit queue. | Fixed in "gates clean up after themselves and don't see secrets" (#13) |
| 14 | low | `pause()` marked attempts paused before moving the run, so a crash in between left a building run with paused attempts nobody polls. | Fixed in "a paused run stops spending": the run moves first, then its agents pause |

## Found by the review of the fixes above (all fixed in "review fixes for the hardening")

| # | Severity | Issue |
| --- | --- | --- |
| 15 | high | With gates out of the lock, a work order dispatched while a merge was still being re-tested branched from that untested merge (the live ref), so a merge that was then reset came back through it, outside any diff the policy checked. The "own merge" exception in #1's guard could also be forged: a two-parent commit of the factory's tip and the work order's branch, with any content. Now builders branch from `integrationSha`, merges start from it, and the guard accepts only the saved `mergeSha` (or, after a restart, a commit whose tree is exactly the clean merge of its two parents). |
| 16 | medium | Pause and Cancel still waited when the run's gate job was queued behind another run's gate slot. The slot wait is now abortable. |
| 17 | high | Git hooks (`pre-commit` and friends) an agent writes into the shared `.git/hooks`, or `core.hooksPath`/`core.fsmonitor` set in the repo's config, ran inside the factory's own commits and could add files to the spec commit. The factory's git runs with hooks pointed at `/dev/null` (`NUL` on Windows), fsmonitor off, and diffs without external diff or textconv. |
| 18 | medium | One failed poll of a conversation failed its attempt and threw away the builder's work; now it takes three in a row. |
| 19 | medium | A script placed in the change folder rode along in the spec commit; only the change's markdown and `.openspec.yaml` are committed now. |
| 20 | low | A deleted integration worktree wasn't treated as "moved", and couldn't be put back; it is, and Restore recreates it. A pause the agent server refused marked the attempt paused anyway; it stays running and is polled after Resume. |

## Found while clicking through Phase 3

| # | Severity | Issue |
| --- | --- | --- |
| 21 | medium | A builder whose commits added up to nothing (a repair that took its own work out again, or empty commits) stopped its work order on a raw `git commit` error ("nothing to commit"), because the squash tried to commit an unchanged tree. Fixed in "a work order whose commits add up to nothing goes back to its builder": the branch goes back to its base and the builder hears "Nothing was built", like a builder that never committed. |

## Found by the review of Phase 3 (all fixed in "review fixes for Phase 3", tests in `autopilot-review-p3.test.ts`)

| # | Severity | Issue |
| --- | --- | --- |
| 22 | high | The merge took the work order's branch as it was at merge time, not the commit the gates and reviewer checked. Any agent can move that ref, so a commit put on it after the review (or after a person approved the merge) went onto the integration branch unreviewed, recorded as that person's. The merge and `mergeCheck` now take the builder's squashed commit. |
| 23 | high | A `.gitattributes` (committed) or `.git/info/attributes` (shows in no diff) marking code `binary` or `-diff` hid its added lines from the secret scan and counted it as 0 lines against `maxChangedLines`. Diffs read every file as text now. |
| 24 | medium | The dependency scan missed `peerDependencies`, `overrides` and `resolutions`, the install scripts `prepublish`, `preprepare`, `postprepare` and `dependencies`, a lockfile entry resolved from anywhere (what `npm ci` installs), and a registry set in `.npmrc` or `.yarnrc`. An `npm:` alias was reported as "not pinned". |
| 25 | medium | A dependency URL's credentials (`https://user:token@host/...`) went verbatim into findings: the check output, the merge approval and the audit log (`work_order_merged` reasons). |
| 26 | medium | The secret scan skipped lockfiles, `*.min.js`, `*.map` and `*.lock` entirely, so a known token format there (a lockfile's authenticated git URL, a builder's `config.min.js`) went unflagged. Only the entropy check skips them now. |
| 27 | medium | A run's Resume resumed every paused conversation, including those of a work order paused at its budget (or skipped there), which then spent with nothing holding them to a budget; raising a work order's budget while its run was paused resumed its agents with nobody polling them. |
| 28 | low | `hiddenResult` counted every hidden-test run since the builder started, so a test that failed once and passed after the repair still put the merge in front of a person as "Hidden acceptance tests failed". |
| 29 | low | Evidence matched hidden tests to scenarios by name only: a scenario with the same name under another requirement showed as covered. |
| 30 | low | `squash` left a single commit's own message (never scanned) on what merges. |
| 31 | low | Slack alerts posted agent-written work-order titles unescaped (`<!channel>`, `<https://x\|Open the Inbox>`). |

## Found by the review of Phase 4 (all fixed in "review fixes for Phase 4", tests in `autopilot-review-p4.test.ts`)

| # | Severity | Issue |
| --- | --- | --- |
| 32 | high | A tag (or `refs/main`) any agent names after the base branch swapped the base's policy for the defaults: `currentBranch` used `--short`, which then says `heads/main`, so every new run, intake and `/status` read `refs/heads/heads/main` and pinned `DEFAULT_POLICY` (a stricter `autonomy.max`, gates or hidden tests on the base were gone). Queued runs couldn't start at all (`git worktree add ... main`: "ambiguous object name") and paused with a git error. The base is read by its full ref now, and integration branches start from `refs/heads/<base>`. |
| 33 | medium | The watchdog stranded an agent whose nudge the agent server refused (a 500, a 429): it had paused the conversation first, so the attempt stayed `running` in the ledger, the conversation paused, and nothing polled it as working again; the run waited for ever with nobody told. The watchdog now resumes it (a 429 counts as sent) and tries again on the next poll. |
| 34 | medium | A restarted spec agent or validator whose fresh agent couldn't start (the agent server away while its profile was looked up, or a missing profile a person then fixed) was never started: the restarted attempt counted as handled. The run sat in `spec` for ever, holding a queue slot; without a validator, work orders went on with hidden tests "missing". The steps start it now, and work orders wait for it. |
| 35 | medium | Two deliveries of one issue at once (GitHub sends `opened` and `labeled` together for an issue created with the label) both passed the duplicate check, so the same issue made two runs. Intake handles one request at a time. |
| 36 | medium | Intake text reached markdown and the spec brief unescaped: a webhook's `author` and `reference` (end-user text a helpdesk passes on) made links in the Inbox item, and their line breaks started lines of their own in the spec brief outside `<goal>`; the URL went in raw, so `https://x/1) [Open the Inbox](https://evil...` was a link elsewhere; and a body with `</goal>` closed the goal tag, so what followed read as the factory's instructions. Author and reference are one line and escaped, the URL is normalized and shown as an autolink, and the goal's own tags are escaped. |
| 37 | medium-low | A flaky-gate re-run could hide a failure that isn't flaky: a test that rewrites its golden file (or snapshot) when it doesn't match fails, then passes on the second run against files that aren't committed, at verify, on the integration branch and at release. A gate whose failing run changed the worktree's files isn't run again. |
| 38 | medium-low | The watchdog took only a higher event count as progress: after the count went down (a conversation the agent server restored with fewer events), a working agent was nudged and stopped until it passed the old count. Any change counts. |
| 39 | low-medium | A builder the agent server lost still counted against `repair` when it was the latest one: with the fresh builders used up (`repair.fresh` 1 after a failed first builder, or 0), an agent-server restart sent the work order to a person instead of a fresh agent. The latest lost one is forgiven too (two at most, as before). |
| 40 | low | A release paused while its merge was tested kept that merge in memory and, after Resume, skipped the order check, racing the release that went meanwhile (one of them failed back to a person, the race the order was for). Pause forgets the merge, a release takes the base in the same moment it checks, and one being made or tested goes first. |
| 41 | low | A run cancelled while releasing left its release worktree (`worktrees/<run>/release`, still in `git worktree list`). |
| 42 | low | `POST /intake/:source` read the whole body before checking its 512 KB limit, so a chunked body of any size (no Content-Length) sat in memory first. The limit applies while it's read (`hono/body-limit`). |
| 43 | low | On a detached HEAD, intake decided with the default policy while the run it made pinned `main`'s, so `intake.github: off` on `main` didn't stop GitHub issues. Intake uses `main` too. |

## Found by the review of Phase 4's second half (all fixed in "review fixes for Phase 4 (drift, preview, learning, registry)", tests in `autopilot-review-p4b.test.ts`)

| # | Severity | Issue |
| --- | --- | --- |
| 44 | medium-high | A spec change whose spec agent couldn't be started when a person asked for it (the agent server answered the profile lookup with an error) held the run for ever: the revision stayed `writing` with no agent, nothing new was dispatched, the run never finished, and no item said why. `revisionStep` now starts an agent whenever the latest spec attempt is one already dealt with, and `reviseSpec` and Try again record the change even when the start fails. |
| 45 | medium | A spec change asked for just as building started (before the first build step) was never re-planned: that step recorded the revised change folder as the tree the plan came from. `reviseSpec` records the plan's tree first. |
| 46 | medium | A re-plan a person approved while a work order's merge was being re-tested stopped that work order but left its untested merge commit on the integration branch, so the next step paused the run as "moved outside the factory". Stopping a work order mid-merge puts the branch back to its `preMergeSha`. |
| 47 | medium | A task group one re-plan removed and a later spec change brought back stayed skipped for ever: the plan's skip counted as a person's, so the group was never built and the run finished without it. A re-plan's skip is marked (`resumeState: pending`) and counts as changed when the group comes back. |
| 48 | medium | A spec change whose tasks.md validated but couldn't be planned (a `Depends on` a missing group, a cycle) was merged anyway; every build step then stopped the run on it, and Retry couldn't get past it. The revision is planned before it's committed, and the reason goes back to its spec agent like a validation failure. |
| 49 | medium | A preview that was running when a spec change was asked for was kept as the preview of the new integration sha, so the release decision (and `release.auto`) relied on a preview of older code. A preview's result keeps the sha it ran on; one of an older sha runs again. |
| 50 | medium-low | `preview.paths` like `/\host/x` or `/<tab>/host/x` passed the policy's "path, never another host" check, and the preview fetched and screenshot that host (URLs read both as `//host`). The policy refuses backslashes and whitespace, and `runPreview` skips any path whose URL isn't on the app. |
| 51 | low-medium | Pause or Cancel during a preview waited for every page's fetch (10 s each, up to 20 pages) and screenshot before the app was killed. Fetches end on the job's signal, and the browser closes when it's stopped. |
| 52 | low-medium | A re-plan whose scenarios changed started a fresh validator but left the old one running (and spending), writing into the folder the new one's tests are read from. Earlier validators are paused and marked cancelled. |
| 53 | medium-low | Accepting a lesson wrote through `AGENTS.md` when it was a symlink: one pointing out of the repo (merged work can make one) had its target overwritten, and one pointing at `CLAUDE.md` got the link's text instead of the file. Only a link to a file in the repo is followed; anything else is refused. |
| 54 | low-medium | A lesson for a detected gate put the gate's folder name into AGENTS.md as written, and agents name folders: a folder whose name closes the code span and adds a `curl … \| sh` became an instruction for every agent, one Accept away. Only plain folder names make a lesson. |
| 55 | low-medium | A removed workspace's name registered again for another folder took over the old project's data folder: its runs, open release and lesson items showed up under the new project, where Release would act on the wrong repo. Each data folder records its folder, and another folder can't take the name. |
| 56 | low | A workspace could be registered inside another's folder, or around it; one project's release (`merge --ff-only` in its checkout) rewrites files in the other's. Refused now. |
| 57 | low | `/w/<id>/autopilot/*` read the whole request body before forwarding it, so intake's 512 KB limit (#42) no longer applied while reading for registered workspaces. The body is forwarded as a stream. |
| 58 | low | A registered workspace's release decision linked its preview screenshots under `/sf-api/autopilot` (the default workspace's API), so they never loaded. Each orchestrator knows its own `apiPath`. |
| 59 | low-medium | Found while merging #53 with the Policy page: a write to the base branch (the policy, AGENTS.md, a lesson) checked only the file for a link out of the repo, not its folder, so a merged `.factory` symlinked elsewhere took the policy file with it. The folder is checked too (`autopilot-policy-screen.test.ts`). |
| 60 | medium | Found while writing docs/AUTOPILOT.md: `.factory/**`, `AGENTS.md` and `CLAUDE.md` were held for a person only through the default `sensitivePaths`, and a policy's list replaces the default. A team that wrote its own list without them let the policy merge a work order that loosened the next runs' policy or briefed every later agent. A person now merges those whatever the list says (`GOVERNING_PATHS`, `autopilot-policy-screen.test.ts`). |

## Plausible, not fixed yet (tracked for later phases)

- **A conversation paused by hand in Canvas** stays `running` in the ledger, and
  the watchdog leaves it alone (it only acts on `running` conversations). Nothing
  tells the run's people it's waiting on that pause.
- **Hidden tests share a process with the builder's code.** An import that
  calls `process.exit(0)` makes `node --test` pass the file (checked), and one
  that patches `node:assert` does too; the same code can read
  `.factory-hidden/` while it runs, and a committed `.factory-hidden` symlink
  sends the copies elsewhere. Needs the sandbox below.
- **The API has no authentication.** It listens on 127.0.0.1 only, but any
  local process, agents included, can decide Inbox items, raise budgets, release
  a run or read hidden-test output from `GET /runs/:id`. Agents in a sandbox
  (no route to the host's loopback) close most of it; a per-user session token
  between Canvas and the API closes the rest.
- **Teams cards render markdown links** in titles; only Slack text is escaped.
- **Release merges the integration branch by name** a moment after checking
  its tip, and a done run whose integration branch moved can't be released
  (there's no Restore at that stage).
- **A pause the agent server refuses at a work order's budget** leaves that
  conversation running, and nothing tries again; the change's budget still
  stops it.
- `release()` and `resume()` decide Inbox items without an
  `autopilot.inbox_decided` record (the release or resume itself is audited).
- After a restart the digest hour is the default (17) until `/status` or a
  new run loads the policy.
- **Repo-level git config is still the agents' to write.** Hooks and fsmonitor
  are off for the factory's git, but a `filter.<name>.clean` driver set in
  `.git/config` with a matching `.gitattributes` runs on `git add`. Gates also
  keep `HOME`, so `~/.npmrc` and similar files are readable by code agents wrote.
  Both need agents in a sandbox (Docker), not more flags.
- **The base branch is whatever the workspace has checked out.** A hand-started
  agent working in the workspace could switch it. The real fix is running agents
  in a sandbox (Docker), which also keeps them out of `data/` (hidden tests).
- **The watchdog's nudge, during an outage:** if the agent server goes away
  between the watchdog's pause and its nudge, the resume fails too and the
  conversation stays paused, like one paused by hand in Canvas.
- **Flaky re-runs see only what `git status` sees.** A gate whose failing run
  changed an ignored file (a SQLite file under an ignored folder, a cache) or
  something outside the worktree (a database, a deploy) is still run again. A
  per-gate `rerun: false` in `policy.gates` would let a migration or deploy
  step opt out.
- **A queued or proposed run keeps the policy of the day it was made.** One
  proposed by intake and started a week later runs under that week-old policy,
  not the base's current one. The line is by creation time, so it also goes
  ahead of runs queued meanwhile, and `waitedSeconds` counts the days it was
  proposed.
- `queue.maxActiveRuns` holds only at start: resuming a paused run or approving
  a plan can put more runs to work than the limit.
- **A slow agent server can flap the outage:** when one conversation's calls
  time out every tick and others answer, an outage opens and closes each tick
  (two audit records every 3 s); no notice goes out under `outageAlertMs`.
- **`POST /intake/bug` takes no signature** (it's Home's form, as the local
  user). A relay that forwards all of `/intake/*` lets anyone outside file bug
  reports; it should forward only `github` and `webhook`.
- Webhook requests without a `reference` aren't deduplicated (a redelivery is a
  new run), and nothing uses `X-GitHub-Delivery`; a `labeled` event on a closed
  issue is taken like any other.
- `takenChangeNames` and the integration branch checks (`integrationMoved`,
  `releaseStep`, `mergeInto`) still read refs by bare name: a tag called
  `autopilot/<change>` pauses that run as "moved" (a stop, not a way in).
- `unpause` and `resumeWorkOrder` keep `nudgedAt`: an agent nudged before a
  pause is stopped after one quiet spell after Resume, without a second nudge.
- **Re-plan reads tasks.md from the integration worktree's files**, which hold a
  merge being tested while a person decides; the new plan can come from a
  merge whose gates then fail. Reading it from the item's tree would close it.
- **A stale `replan_approval` item.** `applyReplan` supersedes only work orders'
  items, so when the spec changes again to a plan equal to the current work
  orders, the earlier item stays open: Re-plan on it errors, and Keep the
  current plan on it clears whatever spec change is under way by then.
- Between a spec change merging and its drift being handled (deferred while a
  merge is tested), work orders of the old plan can still be dispatched.
- **A person-approved work order that makes tasks.md unplannable** stops every
  build step (Retry can't get past it), and one that deletes the change folder
  is merged without a re-plan.
- Keep the current plan keeps the hidden tests of the old scenarios.
- **Restart once is per role, and every spec agent of a run shares one**: after a
  restart in the spec stage (or an earlier spec change), a revising spec agent
  that stops goes straight to a person.
- A cancelled run keeps its revision branch `<integration>--spec`.
- **The spec commit takes any `*.md` in the change folder, symlinks included.**
  A spec agent's `tasks.md` linking to a file outside `openspec/` would let a
  builder change the plan's source without the `openspec/` rule seeing it.
- `DELETE /workspaces/:id` doesn't wait for a `createRun` or intake in flight
  (`idle()` doesn't track them): the ledger can close under it, leaving a
  worktree and branch behind.
- **The preview's port** is free when chosen, but another process can take it
  before the app binds; readiness then sees that process. The app is asked to
  bind 127.0.0.1 (`HOST`) but can bind anything. Processes that leave the
  app's process group outlive it (as for gates).
- **Lessons and releases share the base branch** without an order: a lesson
  committed while a release is tested sends the release back to a person; a
  base checked out in another worktree moves under it (as for releases); a
  crash between the commit and recording it writes the line again on a second
  Accept.
- Insights don't count flaky re-runs in the release test (it records no
  `gates_run`).
- The combined Inbox's item ids repeat across workspaces; Canvas keys and
  routes have to use the workspace too.

## Phase 1 UI review (fixed in "Home, Pipeline and Inbox screens")

- A decision card shown twice on the Pipeline shared DOM ids, so "Send back"
  focused the other card's note.
- A run cancelled at plan approval showed Plan as passed.
- Paused runs showed their lane as active; a missing run retried its 404 forever;
  hidden-test details were hidden from people too.
