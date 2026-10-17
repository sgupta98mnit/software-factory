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

## Plausible, not fixed yet (tracked for later phases)

- **No watchdog.** An agent-server outage keeps attempts `starting` and the run
  "Building" with no Inbox signal; a conversation paused by hand in Canvas stays
  `running` in the ledger. (Phase 4: self-healing.)
- **Cold starts.** `classify`'s 20 s grace could count an ACP conversation that
  stays `idle` for 20 s after start as finished. (Phase 4: watchdog.)
- **The base branch is whatever the workspace has checked out.** A hand-started
  agent working in the workspace could switch it. The real fix is running agents
  in a sandbox (Docker), which also keeps them out of `data/` (hidden tests).

## Phase 1 UI review (fixed in "Home, Pipeline and Inbox screens")

- A decision card shown twice on the Pipeline shared DOM ids, so "Send back"
  focused the other card's note.
- A run cancelled at plan approval showed Plan as passed.
- Paused runs showed their lane as active; a missing run retried its 404 forever;
  hidden-test details were hidden from people too.
