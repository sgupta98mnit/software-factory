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

## Phase 1 UI review (fixed in "Home, Pipeline and Inbox screens")

- A decision card shown twice on the Pipeline shared DOM ids, so "Send back"
  focused the other card's note.
- A run cancelled at plan approval showed Plan as passed.
- Paused runs showed their lane as active; a missing run retried its 404 forever;
  hidden-test details were hidden from people too.
