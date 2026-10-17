# Autopilot

Autopilot turns a goal ("Let applicants check a claim's status") into a change ready to release into your base branch. Agents write the spec, the code and the tests. The factory checks their work itself, and people make the decisions that matter. What the factory may do on its own is set by a policy file on the base branch, `.factory/policy.yml`. Every step is recorded in a tamper-evident audit log.

This page is for the team using it. `docs/autopilot/DESIGN.md` is the engineering contract (states, API shapes, invariants), and `docs/autopilot/OPEN-ISSUES.md` lists what's known not to work yet.

## See it in five minutes

```powershell
pnpm demo
```

This runs the whole factory with scripted agents: no model, no keys, no network. Open the address it prints and type a goal:
1. The spec agent writes an OpenSpec change. You approve the plan in the Inbox.
2. Three work orders build in two waves. WO-2's first try has a bug its test catches, and the factory repairs it.
3. WO-3 touches `src/auth`, so its merge waits for you.
4. At the end, the preview runs the app and the release decision shows its screenshots.

Then look at the run's **Evidence**, the **Policy** page and **Metrics**. `pnpm demo --reset` starts over.

## How a run goes

```
Goal ─▶ spec agent ─▶ openspec validate --strict ─▶ critic ─▶ plan: work orders in waves
     ─▶ plan approval (a person, or the critic for an autonomous run)
     ─▶ a builder per work order, each in its own git worktree, a few at a time
     ─▶ the factory's gates (typecheck, lint, test), secret and dependency scans, hidden tests
     ─▶ a reviewer agent ─▶ merge: by the policy, or by a person
     ─▶ merged one at a time into the run's integration branch, tested again each time
     ─▶ preview (optional) ─▶ release into the base branch: a person's click
```

1. **Spec.** A spec agent writes an OpenSpec change (proposal, scenarios, design with NIST 800-53 controls, tasks). The factory validates it strictly, sending it back up to three times, and commits it. If the spec agent has open questions, the Inbox asks you. A critic agent then reads the spec. It never edits; anything it changes is thrown away.
2. **Plan.** `tasks.md` becomes work orders without a model: one per task group, with their dependencies, cut into waves that can build in parallel. Each gets a risk score.
3. **Build.** Each work order gets a builder agent in a worktree and branch of its own. Agents never branch or merge; the factory does.
4. **Verify.** The factory runs the gates itself, never trusting an agent's word that tests pass. It scans the added lines for credentials and the dependency changes for risky packages. With hidden tests on, it also runs black-box tests a validator wrote from the scenarios before any code existed; builders never see them. A reviewer agent reads the diff against the acceptance criteria.
5. **Repair.** Work that fails goes back to its builder twice, then to a fresh builder once, then to a person. A builder gets the findings, never the hidden tests' source.
6. **Merge.** The policy merges a work order by itself only when everything above passed, it stays out of sensitive paths (auth, crypto, infrastructure, CI, the policy itself…), it adds no dependency outside the allowlist, and it changes fewer than 400 lines. Otherwise a person decides, with the reasons in front of them. Each merge into the integration branch is tested again on top of everything merged before it.
7. **Release.** A finished run asks a person to release it. Releasing merges the integration branch into the base branch, testing again if the base moved meanwhile. Releases into one branch go one at a time, in the order they were asked for.

## Who decides what

| Autonomy | Spec | Plan | Merges | Release |
| --- | --- | --- | --- | --- |
| `suggest` | a person | a person | a person, every one | a person |
| `supervised` (default) | — | a person | the policy, within its rules; a person for the rest | a person |
| `autonomous` | — | the critic | the policy, within its rules; a person for the rest | a person, unless the policy says `release: { auto: true }` |

The effective level is the lowest of: what the run asked for, the policy's `autonomy.max`, and `SF_AUTONOMY_CAP`.

**These hold whatever the settings:**
- Release to production is a person's click by default. `release.auto` is a visible setting in the policy file, off by default and in every template.
- Agents never approve their own work. Reviewers and critics only read, and a merge is either a person's decision or the policy's, recorded as `policy@<hash>` naming the exact rules.
- The policy is read from the base branch when a run starts, and the run keeps it until it ends. It's never read from a worktree or a work-order branch, so a change can't relax its own rules. A change to the spec (`openspec/`), the policy (`.factory/`), `AGENTS.md` or `CLAUDE.md` always needs a person's merge, whatever the policy's sensitive paths say.
- Every state change is recorded with `audit()`. The audit log never holds secrets or full prompts: a goal or note is kept as a short clip plus its SHA-256.
- The factory's API listens on 127.0.0.1 only.

Every decision the policy makes on its own carries a plain reason, for example:
> The policy merged it: the gates and the review passed, the scans found no secrets or risky dependencies, …, and it changes 42 lines (the limit is 400).

The reason appears on the work order, in the audit log and in the run's evidence.

## The pages

All of these are in Canvas's sidebar.

| Page | What it's for |
| --- | --- |
| **Autopilot** (Home) | Start a run (goal, autonomy, budget), see the runs, the setup checklist, report a bug, switch workspace |
| **Pipeline** (a run) | Spec, plan and work orders by wave as they move. Each work order has its checks, agent conversations and why it merged. Pause, resume, cancel, change the spec, release |
| **Inbox** | Every decision waiting for a person, from every workspace, with the reasons and the choices. The sidebar badge counts them |
| **Evidence** (from a run) | Each scenario traced to its hidden test, the work orders that built it and who let each in. Also the controls, every decision and whether the audit chain holds. Download it as JSON for an assessor |
| **Policy** | The policy in plain words, the file itself, four templates, and an editor. **Check** writes nothing; **Commit** puts it on the base branch in your name |
| **Metrics** | Lead time, autonomy rate, cost per change, what goes wrong most, and how each version of the policy did |

Alerts: set `SF_NOTIFY_WEBHOOK` to a Slack or Teams incoming webhook. The first decision that waits for a person is posted right away; later ones wait for one daily digest.

## Starting a project

1. Point the factory at your repo (`SF_WORKSPACE`, or **Add a workspace** on Home).
2. Work through Home's **Setup** checklist:
   - the agent server answers;
   - the folder is a git repo (one click);
   - the base branch has a policy (one click adds the recommended one);
   - there are gates to run;
   - `AGENTS.md` exists (one click adds a starter).
3. Choose a template on the **Policy** page if the recommended one isn't right. **Cautious** suits a first project or a sensitive system; **Federal, strict** adds hidden tests, the preview and wider sensitive paths.
4. Start with `supervised` runs, read a few evidence records, and look at **Metrics** after a week. A rule that people always override is stricter than it needs to be; a rule that catches work people send back is earning its keep.

For agency code, run the agent server in Docker so agents only see the folders you mount (see `docs/ARCHITECTURE.md`, Security notes). Don't leave real agents running with nobody watching the Inbox.

## Requests from outside

Runs can also start from:
- a GitHub issue with the `autopilot` label (through a relay you run, since the API is local);
- signed JSON from another system, such as a helpdesk's bug reports;
- the **Report a bug** form on Home.

Per source, the policy's `intake` says whether a request is ignored, waits in the Inbox as "New request" (the default for GitHub and the form), or starts a run right away, at no more than `intake.autonomy`. Outside text is treated as untrusted. It's clipped and deduplicated, kept out of the audit log beyond a short title, and the spec agent is told not to follow instructions in it.

## When things go wrong

The factory heals what it safely can, and asks a person for the rest:
- **A quiet agent** (no new events or cost for `selfHealing.quietMinutes`, default 20) is nudged once, then stopped. A builder gets a fresh one. A spec agent, critic, validator or reviewer is started again once before a person is asked.
- **The agent server is down:** runs wait instead of failing, and the team hears about it once after two minutes, then again when it's back. Builders whose conversations were lost get a fresh agent that doesn't use up repairs.
- **A gate fails** and runs once more. If it passes then, it counts, and the check says it was flaky.
- **A merge conflict** caused by another work order's merge goes back to the builder, up to three times, without using up repairs.
- **Budgets:** a run pauses at `budget.perChangeUsd` (default $30, or what you typed on Home), and a work order at `perWorkOrderUsd` (default $5). Either way, a person decides whether to raise it.
- **The spec changes mid-run:** **Change the spec** on the Pipeline revises it while work goes on. The plan is made again from the new `tasks.md`: new groups become work orders, removed ones stop, changed ones build again. A person approves the new plan unless the run is autonomous.
- **The same mistake keeps happening:** after three times across runs, the factory proposes a line for `AGENTS.md` as an Inbox decision. Accepting commits it in your name.
- Too many runs at once: past `queue.maxActiveRuns` (default 2), new runs wait in line, oldest first.

Pause and Cancel are on every run. A paused run picks up where it left off, including after the factory restarts; its state lives in a SQLite ledger.

## More than one project

Add workspaces on Home. Each gets its own ledger, worktrees and policy (from its own base branch). All of them share the agent server, the gate slots and the one audit log. The Inbox shows everyone's decisions, each labelled with its workspace.

## Reference

- **Policy keys and defaults:** README.md, "Autopilot policy".
- **Settings** (`SF_*` environment variables): README.md, "Settings".
- **HTTP API:** `docs/autopilot/DESIGN.md` §5. It's served under `/sf-api/autopilot`; the Canvas client is `canvas/src/factory/api.ts`.
- **What's known not to work yet:** `docs/autopilot/OPEN-ISSUES.md`. These matter most before production use:
  - the API has no sign-in or roles (people are named by `SF_USER`);
  - gates and the preview run on the host without a sandbox;
  - GitHub intake needs a relay you run.
