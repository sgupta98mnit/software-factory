# Software Factory

An 8090-style software factory for federal delivery teams, built on [OpenHands Agent Canvas](https://github.com/OpenHands/OpenHands).

Canvas gives you the agent UI: chat with Claude Code, Codex or OpenHands, using the logins you already have. This repo adds the factory around it.

**Autopilot** takes a goal to a change ready to release ([docs/AUTOPILOT.md](docs/AUTOPILOT.md)):
- Agents write the spec, the code and the tests.
- The factory runs the gates, scans and hidden acceptance tests itself.
- People decide in one Inbox what the workspace's policy doesn't allow.
- Release into the base branch is a person's click by default.

Its pages:
- **Home:** start a run and see the runs, with a setup checklist.
- **Pipeline:** watch a run move.
- **Inbox:** every decision waiting for a person.
- **Evidence:** each scenario traced to its test, its work orders and who approved them.
- **Policy:** the rules in plain words, with templates.
- **Metrics:** lead time, autonomy rate, cost per change and what goes wrong most.

The hands-on pages are for doing it step by step:
- **Requirements:** [OpenSpec](https://github.com/Fission-AI/OpenSpec) changes (proposal, specs with WHEN/THEN scenarios, design, tasks). Validate them, or ask an agent to review them.
- **Work orders:** [Backlog.md](https://github.com/MrLesk/Backlog.md) tasks on a board, created from a change's task list, tagged with NIST 800-53 controls. Start an agent on one; approve it when it's done.
- **Audit log:** every approval, status change, work order edit and Autopilot step, in a hash chain you can verify.

Requirements, work orders and the policy are plain files in the workspace repo, so they also have git history.

## What's in this folder

```
apps/server/                 Factory API: OpenSpec, Backlog.md, approvals, audit log, Autopilot (port 4317)
canvas/                      Your OpenHands Canvas clone (created by pnpm setup:canvas; its own git repo)
patches/canvas-factory.patch Our changes to Canvas: src/factory/ plus three small edits
canvas.lock.json             The OpenHands commit the patch is built on
workspaces/benefits-portal/  Demo workspace the agents work in (OpenSpec + Backlog.md set up)
scripts/                     setup-canvas, dev, demo, export-canvas-patch, setup-workspace
docs/AUTOPILOT.md            Autopilot for the team using it: how a run goes, who decides, the pages
docs/ARCHITECTURE.md         How it fits together, and where to extend it
docs/autopilot/              DESIGN.md (the contract as built), CONTRACT.md (the original) and OPEN-ISSUES.md (known gaps)
data/                        Created when you run it: audit log, Autopilot ledger, worktrees (git-ignored)
```

## Set up (Windows)

You need:

- **Node.js 24 or newer.** Canvas requires it. Check with `node -v`.
- **Git** ([git-scm.com](https://git-scm.com)).
- **uv**, which Canvas uses to run the OpenHands agent server:
  `powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"`
- **Claude Code and/or Codex**, signed in once: run `claude` and log in, and `codex login`.

Then, in PowerShell:

```powershell
cd $HOME\Documents\software-factory
npm install -g pnpm@10.34.6   # Node 25+ no longer ships corepack, so install pnpm with npm
pnpm install
pnpm setup:canvas        # fetches OpenHands Canvas into canvas\, applies our patch, runs npm ci
```

`pnpm setup:canvas` takes a few minutes the first time. Run it again any time; it skips what's done.

## See it first: `pnpm demo`

```powershell
pnpm demo
```

The whole factory with scripted agents: no model login, no API keys, no network. It makes a sample workspace in `data\demo\` (hidden tests and the preview are on in its policy), starts a scripted agent server, the factory API and Canvas, and prints the address (**http://127.0.0.1:3001/autopilot**). The first time, Canvas shows its welcome steps and asks about usage data: choose **Skip for now**, then **Confirm** (nothing is sent; the demo runs with Do Not Track, though the question can come back after a reload). Type a goal such as *Let applicants check a claim's status* and watch the pipeline. The spec agent writes a valid OpenSpec change, you approve the plan, and three work orders build in two waves. WO-2's first try has a bug its test catches and is repaired; WO-3 touches `src/auth`, so its merge waits for you in the Inbox. At the end the preview runs the app and the release decision shows its screenshots. Evidence, budgets, the audit log and the metrics all work as they would with real agents.

`pnpm demo --reset` starts over with a fresh workspace (it deletes the demo's folder only when nothing else is in it); `pnpm demo --no-canvas` runs only the agents and the API. The agents are scripts, never models, so the demo can't spend anything or reach anything outside your machine.

## Run it

```powershell
pnpm dev
```

Open **http://localhost:8000**. The first run starts the OpenHands agent server (uv downloads it once), so give it a minute.

Canvas shows its onboarding the first time. Pick **Claude Code** or **Codex** as your agent; it reuses your CLI login, so you can leave the key fields empty. To have both, add a second profile under **Settings → Agents**.

## Try the flow (5 minutes)

1. **Requirements:** open `add-claim-status-lookup`, read the requirements, click **Create work orders**, then **Create 3 work orders**.
2. **Work orders:** open **WO-1**, click **Start with an agent**, choose Claude Code or Codex, and **Start conversation**. The first message is written from the work order; you can edit it.
3. Watch the agent work in Canvas. Back on **Work orders**, WO-1 moves to In Progress, its acceptance criteria get checked off and a final summary appears, as the agent updates the work order.
4. Review what it built (`workspaces\benefits-portal\claim-status-service`), then **Approve** WO-1. That's your name on the record.
5. **Audit log → Verify chain** proves nothing in the log was edited.

To start over: stop `pnpm dev`, then delete `data\` and `workspaces\benefits-portal\backlog\tasks\`.

## Setup checklist

Home's **Setup** panel checks what a workspace needs before (or for better) runs, and fixes what one click can:

- the agent server answers, with agent profiles;
- the workspace is a git repo (**Make it a git repo**);
- the base branch has a valid policy (**Add the recommended policy**);
- there are gates to run;
- AGENTS.md exists (**Add a starter AGENTS.md**);
- team alerts are configured (optional).

The fixes that add a file commit it to the base branch in your name, only if the branch hasn't moved and the checkout has no uncommitted changes, and the audit log records them.

## Use your own project

```powershell
cd C:\path\to\your-repo
npx @fission-ai/openspec@1.14.0 init --tools claude,codex
npx backlog.md@1.53.0 init "My Project" --defaults --integration-mode cli --agent-instructions claude,agents --task-prefix wo

cd $HOME\Documents\software-factory
$env:SF_WORKSPACE = "C:\path\to\your-repo"
pnpm dev
```

Copy the "Software Factory conventions" block from `workspaces\benefits-portal\AGENTS.md` into your repo's `AGENTS.md` and `CLAUDE.md`.

## Settings

| Variable | Default | What it does |
| --- | --- | --- |
| `SF_WORKSPACE` | `workspaces/benefits-portal` | The repo agents work in |
| `SF_AGENT_WORKSPACE` | same as `SF_WORKSPACE` | That repo's path as the agent server sees it (set it when agents run in Docker) |
| `SF_USER` | your Windows user name | Name recorded in the audit log |
| `SF_PORT` | `4317` | Factory API port. If you change it, change `SF_API_URL` in `canvas\.env` too |
| `SF_DATA_DIR` | `data` | Where the audit log, the Autopilot ledger (`autopilot.db`) and its worktrees are kept |
| `SF_AGENT_SERVER_URL` | `http://127.0.0.1:8000` | Where Autopilot reaches the OpenHands agent server (Canvas's address) |
| `SF_AGENT_SERVER_KEY` | Canvas's saved key | The agent server's session key, if Canvas keeps it somewhere else |
| `SF_AUTONOMY_CAP` | none | Highest Autopilot autonomy anyone can pick: `suggest`, `supervised` or `autonomous` |
| `SF_NOTIFY_WEBHOOK` | none | A Slack or Teams incoming webhook (or any URL that takes JSON). The first decision that waits for a person is posted right away; later ones wait for one daily digest at the policy's `notify.digestHour` |
| `SF_PUBLIC_URL` | `http://localhost:8000` | Where people open Canvas, for the Inbox link in alerts |
| `SF_GATE_CONCURRENCY` | `2` | Gate runs at once across the factory |
| `SF_GATE_ENV` | none | Comma-separated environment variables gates may see although they look like secrets |
| `SF_INTAKE_GITHUB_SECRET` | none | The secret of a GitHub issues webhook pointed (through a relay) at `/sf-api/autopilot/intake/github`. Unset: GitHub requests are refused |
| `SF_PREVIEW_BROWSER` | found automatically | The Chromium the preview takes screenshots with. Without it the factory looks where Playwright keeps browsers; with none, the preview still checks the pages and says why there are no screenshots |
| `SF_INTAKE_SECRET` | none | The HMAC secret for other systems' requests to `/sf-api/autopilot/intake/webhook` (header `X-SF-Signature: sha256=<hex>`). Unset: refused |

## Autopilot policy

The **Policy** page (sidebar) shows the policy in plain words, the file itself, and four templates (recommended, cautious, federal strict, hands-off; every one leaves release to a person). You can edit the file there: **Check** says what a draft would do, or what's wrong with it, without writing anything, and **Commit** puts it on the base branch in your name, after a confirmation. Runs already going keep the policy they started with. Every decision the policy makes on its own carries a plain-language reason: on the work order ("The policy merged it: the gates and the review passed, … 42 lines (the limit is 400)"), in the audit log, and in the run's evidence under **Decided by the policy**.

Each run reads `.factory/policy.yml` from the workspace's base branch when it starts and keeps it until the run ends. It never reads the file from a worktree or a work-order branch, so a change can't relax its own rules. Without the file, Autopilot uses these defaults. Set only the keys you want to change, and quote glob patterns:

```yaml
version: 1
autonomy: { default: supervised, max: autonomous }   # the lower of max and SF_AUTONOMY_CAP wins
agents: { spec: null, critic: null, builder: null, reviewer: null, validator: null }   # profile id or name; null = Canvas's active profile
parallel: 3                                          # work orders building at once
repair: { sameConversation: 2, fresh: 1 }
spec: { validateTries: 3, criticRounds: 2 }
review: { blocking: [critical, high] }
gates: null                                          # null = npm typecheck/lint/test scripts; or [{ name, run, cwd?, timeoutSec? }]
autoMerge:
  maxChangedLines: 400
  sensitivePaths: ["**/auth/**", "**/auth.*", "**/crypto/**", "**/*crypto*", "**/migrations/**",
                   ".env", ".env.local", ".env.*.local", ".env.production", ".env.development", "**/*.pem", "**/*.key",
                   "infra/**", "**/terraform/**", "**/*.tf", "**/*.tfvars", "**/k8s/**", "**/helm/**",
                   "Dockerfile*", "docker-compose*.yml", "docker-compose*.yaml",
                   "**/.github/**", ".gitlab/**", ".gitlab-ci.yml", "Jenkinsfile", ".factory/**", "AGENTS.md", "CLAUDE.md"]
  dependencyAllowlist: []
selfHealing: { quietMinutes: 20, rerunFailedGates: true, conflictRounds: 3 }   # watchdog, flaky gates, merge conflicts
queue: { maxActiveRuns: 2 }                          # runs working at once; more wait in line
intake: { github: inbox, webhook: off, bug: inbox, githubLabel: autopilot, autonomy: supervised }   # off | inbox | run
preview: { enabled: false, start: "npm start", paths: ["/"], readyTimeoutSec: 60 }   # the app, before release
learning: { proposals: true, threshold: 3 }          # AGENTS.md lines from repeated mistakes
```

A work order merges without a person only when its gates and review passed, the factory's secret scan found nothing in the lines it adds, its dependency scan found nothing (versions not pinned exactly, packages from outside the npm registry, new install scripts), it adds no dependency outside `dependencyAllowlist`, it changes no file under `sensitivePaths` (any case, dot folders included; a bare name like `Dockerfile` matches in every folder), and it changes fewer than `maxChangedLines` lines. A change to the spec (`openspec/`), the policy (`.factory/`), `AGENTS.md` or `CLAUDE.md` always waits for a person, even if your `sensitivePaths` leaves them out. In `suggest` mode a person approves every merge. Anything else goes to the Inbox with the reasons. The audit log records policy approvals as `policy@<hash>`, where the hash identifies the exact rules. An invalid file (unknown key or bad value) stops new runs, and `/sf-api/autopilot/status` shows the error. `hiddenTests: { enabled: true }` turns on hidden acceptance tests: a validator agent writes a black-box test per scenario before any code, kept in the factory's data folder where builders never see them; each work order must pass the ones it can satisfy, and the integration branch everything merged so far. A failure reaches the builder only as the scenario's name and the first assertion line. `notify.digestHour` sets the hour of the daily alert digest. `budget` limits what agents spend, from their accumulated cost: `perChangeUsd` (default $30, or the budget typed on Home) pauses the run and its agents; `perWorkOrderUsd` (default $5) pauses only that work order. Either asks a person to raise it. `release: { auto: true }` lets an autonomous run release itself into the base branch, recorded as `policy@<hash>`; without it (the default) a finished run asks a person to release it, in the Inbox or on the Pipeline. Releasing merges the integration branch into the base branch, tests the merge again if the base moved since the run started, and moves the base branch (and the workspace's checkout of it, when it has no uncommitted changes). `routing: { low, medium, high }` names the builder profile for each work-order risk (falling back to `agents.builder`); a fresh builder after a failed one moves up a level. The watchdog (`selfHealing.quietMinutes`) nudges a working agent that shows no progress (no new events, no new cost) for that long, and stops it if it stays quiet as long again; a builder then gets a fresh agent, and a spec agent, critic, validator or reviewer that stops without finishing is started again once before a person is asked. When the agent server can't be reached, runs wait instead of failing; after two minutes the alert webhook hears about it once, and again when it's back. Builders whose conversations it lost get a fresh agent that doesn't count against `repair`. A gate that fails runs once more (`rerunFailedGates`); if it passes then, it counts, and the check says it was flaky. A merge conflict caused by another work order's merge goes back to the builder without using up `repair` rounds, up to `conflictRounds` times. `queue.maxActiveRuns` caps the runs that work at once (writing the spec, building or releasing; a run waiting on a person doesn't count). A run started past it waits in line, oldest first, and gets its integration branch when it starts, from the base branch as it is then. Releases into one base branch go one at a time in the order they were asked for, so a later one is merged onto the earlier one and tested again instead of bouncing back to a person.

`intake` decides what requests from outside become: GitHub issues opened with (or given) `githubLabel`, signed JSON from other systems (a helpdesk's bug reports: `{ title, body, kind: feature|bug, reference, url }`), and the Report a bug form on Home. Per source, `off` ignores them, `inbox` (the default for GitHub and the bug form) puts a "New request" decision in the Inbox, where Start puts the run in line, and `run` starts it right away at no more than `intake.autonomy`. A request already behind a run isn't taken twice. The factory treats the text as untrusted: it's clipped, never put in the audit log beyond a short title, and the spec agent is told not to follow instructions in it. The API stays on 127.0.0.1, so GitHub reaches it through a relay you run, and every signed request is checked against its secret.

The spec can change while a run builds. **Change the spec** on the Pipeline sends your note to a fresh spec agent, which revises the change in a worktree of its own while the work under way goes on (nothing new starts). Once it validates, only the change's markdown is merged into the integration branch. A work order that edits the spec itself always needs a person's merge. Either way, when the change folder no longer matches what the work orders were planned from, the plan is made again from tasks.md: new task groups become work orders, removed ones stop, and changed ones start again (a merged one is reopened for a fresh builder to update). A person approves the new plan in the Inbox unless the run is autonomous, and the run doesn't finish while a spec change or a new plan is pending.

`preview: { enabled: true }` runs the app before a finished run is offered for release. It starts `start` from the integration branch with `PORT` set (to a free port on 127.0.0.1) and the gates' scrubbed environment, waits up to `readyTimeoutSec` for it to answer, checks that each of `paths` answers without an error, and takes a screenshot of each with a headless Chromium. The results and screenshots show on the Pipeline and in the release decision. A failed preview never stops a person from releasing, but `release.auto` doesn't release it on its own.

The factory learns from its runs without another agent. When builders make the same mistake `learning.threshold` times across runs (a gate that fails on the first try, secrets the scan catches, unpinned dependencies), it proposes a line for the workspace's `AGENTS.md`, which every agent reads, as an Inbox decision. Accepting commits that one line to the base branch in your name. Declining, or accepting, means it's never proposed again. `GET /sf-api/autopilot/insights` reports, per policy hash, how many work orders the policy merged by itself, and for each reason it held one for a person, how often people merged it, sent it back or skipped it. A reason people always merge is a rule stricter than it needs to be.

### Metrics

The **Metrics** page (sidebar) shows how the factory is doing for runs started in the last 7, 30 or 90 days:
- **Lead time:** from the goal to its release, as a median and 90th percentile.
- **Autonomy rate:** the share of merged work orders the policy merged without a person.
- **Cost per change:** agent spend per finished run, and per merged work order.
- **What goes wrong most:** gates that failed, scans that caught something, reviews that asked for changes, agents the watchdog stopped, merge conflicts, budgets reached, releases that didn't go through. Each is counted once per work order or run.

It also has one card per version of the policy (`policy@<hash>`), comparing how each set of rules did. Every number comes from the ledger and the audit log (`GET /sf-api/autopilot/metrics?days=30`).

### More than one project

`SF_WORKSPACE` is the factory's default workspace. Add others on Home (**Add a workspace**: a name and the project's folder on this machine). Each gets its own ledger, worktrees and hidden tests under `data/workspaces/<id>/`, and follows the policy on its own base branch. All of them share the agent server, the gate slots (`SF_GATE_CONCURRENCY` is factory-wide) and the one audit log. Home's picker chooses which one you're looking at. The Inbox lists every workspace's decisions, each labelled with its workspace, and its links open the run in the right one. The list is kept in `data/workspaces.json`; a workspace can be removed (`DELETE /sf-api/workspaces/<id>`) once its runs are finished, and its data stays on disk.

## Working on the Canvas side

Factory UI code lives in `canvas\src\factory\`. Canvas is its own git repo on a `factory` branch, with OpenHands as the `upstream` remote.

- **Save your Canvas changes into this repo:** `pnpm export:canvas-patch`, then commit `patches\canvas-factory.patch`.
- **Push Canvas to your own GitHub fork:** `git -C canvas remote add origin <your-fork-url>`, then `git -C canvas push -u origin factory`.
- **Take a newer OpenHands release:** in `canvas\`, `git fetch --depth 50 upstream main`, then `git rebase upstream/main`. Fix conflicts (normally only in the three files listed in `canvas\src\factory\README.md`), run `pnpm export:canvas-patch`, and put the new commit in `canvas.lock.json`.

## Federal notes

- **Agents run with full permissions.** OpenHands approves every Claude Code and Codex permission request automatically, and `pnpm dev` runs the agent server directly on your machine. That's fine for trying it on the demo workspace. For agency code, run the agent server in Docker (see `canvas\README.windows.md`) so agents only see the folders you mount, and set `SF_AGENT_WORKSPACE`.
- **Approval is the gate.** Agents can change a work order, but only the Approve button records a person's approval. Anything else that marks work Done is flagged **Not approved**.
- **Autopilot releases only when a person says so.**
  - By default a person clicks Release. `release: { auto: true }` in the policy is the only way around it; it's off in the defaults and in every template.
  - Agents never approve their own work: a merge is a person's or the policy's, recorded as `policy@<hash>` with its reason.
  - The policy is read from the base branch only, and a person always merges changes to it, to the spec and to `AGENTS.md`.
- **No sign-in yet.** The API trusts whoever can reach 127.0.0.1 and records them as `SF_USER`. On a shared machine, anyone with a shell there can decide, release or change the policy. Sign-in and roles are the first item in `docs/ARCHITECTURE.md`'s milestones.
- **Telemetry is off.** `pnpm setup:canvas` sets `VITE_DO_NOT_TRACK=1` for Canvas, and OpenSpec runs with telemetry disabled. With that set, the only outside requests the browser made in testing were Google Fonts and an npm registry version check.
- **Canvas makes the workspace a git repo.** The first conversation in a folder that isn't one runs `git init` (no commit) so Canvas can show the agent's changes as a diff.
- **Subscriptions vs. products.** Your own Claude and Codex logins are fine while you build. Something you ship to agencies must use API keys or an approved endpoint such as Bedrock. Anthropic's terms don't let third-party products use claude.ai logins.
- **Evidence per run.** The Pipeline's Evidence link traces each scenario of the spec to the hidden test that checks it, the work orders that built it, and who let each one in (a person, or the policy with its hash and reasons). It also lists the controls, the decisions made and whether the audit chain holds. Download JSON saves it for an assessor, and the export is recorded in the audit log.
- The factory API listens on 127.0.0.1 only, and refuses requests a web page from elsewhere makes through Canvas (DNS rebinding): changes must come from this machine's Origin. Keep Canvas on its default 127.0.0.1 address until sign-in lands.

## Troubleshooting

- **The factory pages say the API isn't running:** `pnpm dev` starts it. If you started Canvas separately, run `pnpm dev:api` in another terminal.
- **`pnpm setup:canvas` says the patch doesn't apply:** `canvas\` has other changes or a different commit. Commit or stash them, or move `canvas\` aside and run it again.
- **The agent server won't start on Windows:** OpenHands doesn't test native Windows in CI yet. Run the same steps inside WSL2 (Ubuntu) with Node 24 and uv installed there.
- **Codex says to sign in:** run `codex login`, then start a new conversation.
- **Port 8000 is in use:** stop the other app, or see `canvas\docs\DEVELOPMENT.md` for Canvas's port settings.

## Versions

OpenHands Agent Canvas 1.27.1 (commit `0452907`), OpenSpec 1.14.0, Backlog.md 1.53.0, Hono 4.13. Pinned in `canvas.lock.json` and `apps/server/package.json`.
