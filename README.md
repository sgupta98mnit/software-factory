# Software Factory

An 8090-style software factory for federal delivery teams, built on [OpenHands Agent Canvas](https://github.com/OpenHands/OpenHands).

Canvas gives you the agent UI: chat with Claude Code, Codex or OpenHands, using the logins you already have. This repo adds three pages to it:

- **Requirements:** [OpenSpec](https://github.com/Fission-AI/OpenSpec) changes (proposal, specs with WHEN/THEN scenarios, design, tasks). Validate them, or ask an agent to review them.
- **Work orders:** [Backlog.md](https://github.com/MrLesk/Backlog.md) tasks on a board, created from a change's task list, tagged with NIST 800-53 controls. Start an agent on one; approve it when it's done.
- **Audit log:** every approval, status change and work order edit, in a hash chain you can verify.

Requirements and work orders are plain files in the workspace repo, so they also have git history.

## What's in this folder

```
apps/server/                 Factory API: OpenSpec, Backlog.md, approvals, audit log (port 4317)
canvas/                      Your OpenHands Canvas clone (created by pnpm setup:canvas; its own git repo)
patches/canvas-factory.patch Our changes to Canvas: src/factory/ plus three small edits
canvas.lock.json             The OpenHands commit the patch is built on
workspaces/benefits-portal/  Demo workspace the agents work in (OpenSpec + Backlog.md set up)
scripts/                     setup-canvas, dev, export-canvas-patch, setup-workspace
docs/ARCHITECTURE.md         How it fits together, and where to extend it
data/                        Created when you run it: audit.jsonl (git-ignored)
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
| `SF_REQUIRE_ISOLATION` | none | `1` refuses to run agents or their code on this machine: runs need `execution.provider: container` and a passing isolation check, whatever the workspace policy says |
| `SF_DOCKER` | `docker` | The Docker CLI Autopilot uses for isolated execution |
| `SF_TRIVY` | `trivy` | The Trivy binary Autopilot's security scan runs |
| `SF_TRIVY_SHA256` | none | The Trivy binary's sha256; with it set, `SF_TRIVY` must be the binary's full path and any other binary is refused |

## Autopilot policy

Each run reads `.factory/policy.yml` from the workspace's base branch when it starts and keeps it until the run ends. It never reads the file from a worktree or a work-order branch, so a change can't relax its own rules. Without the file, Autopilot uses these defaults. Set only the keys you want to change, and quote glob patterns:

```yaml
version: 1
autonomy: { default: supervised, max: autonomous }   # the lower of max and SF_AUTONOMY_CAP wins
agents: { spec: null, critic: null, builder: null, reviewer: null, validator: null }   # profile id or name; null = Canvas's active profile
parallel: 3                                          # work orders building at once
repair: { sameConversation: 2, fresh: 1 }
budget: { perWorkOrderUsd: 5, perChangeUsd: 30 }
spec: { validateTries: 3, criticRounds: 2 }
review: { blocking: [critical, high] }
gates: null                                          # null = npm typecheck/lint/test scripts; or [{ name, run, cwd?, timeoutSec? }]
autoMerge:
  maxChangedLines: 400
  sensitivePaths: ["**/auth/**", "**/crypto/**", "infra/**", "**/*.tf", "Dockerfile", ".github/**", ".gitlab-ci.yml", ".factory/**", "AGENTS.md", "CLAUDE.md", "**/migrations/**"]
  dependencyAllowlist: []
execution:
  provider: local                                    # local (agents and gates on this machine, not isolated) or container
  container:                                         # used when provider is container
    image: null                                      # required: agent-server image pinned by digest, already pulled
    gateImage: null                                  # image the gates run in; null = image
    network: null                                    # required: a Docker network you created (not host)
    gateNetwork: null                                # null = network
    user: null                                       # "uid:gid"; null = your ids on Linux/macOS, the image's user on Windows
    memory: 4g
    cpus: 2
    pids: 512
    hostPathStyle: native                            # native (Docker Desktop) or wsl (a WSL engine: C:\x becomes /mnt/c/x)
    credentials: { spec: [], critic: [], builder: [], reviewer: [], validator: [] }   # environment variable names each role gets
    startTimeoutSec: 120
hiddenTests: { enabled: false, run: "node --test" }  # a test writer's independent tests run on every work order
verification:
  protectedPaths: [".factory/**", ".hidden-tests/**", ".sf-hidden/**"]   # put back when a work order changes them
  trivy:
    mode: off                                        # off, advisory (findings go back) or required (fails closed too)
    version: null                                    # accept only this Trivy version, like "0.58.1"
    scanners: [vuln, secret, misconfig]
    severities: [critical, high]                     # new findings at these severities send the work back
    maxDbAgeHours: 72
    timeoutSec: 600
```

A work order merges without a person only when its gates and review passed, it adds no dependency outside `dependencyAllowlist`, it changes no file under `sensitivePaths` (any case, dot folders included; a bare name like `Dockerfile` matches in every folder), and it changes fewer than `maxChangedLines` lines. In `suggest` mode a person approves every merge. Anything else goes to the Inbox with the reasons. The audit log records policy approvals as `policy@<hash>`, where the hash identifies the exact rules. An invalid file (unknown key or bad value) stops new runs, and `/sf-api/autopilot/status` shows the error. `routing` and `notify` are accepted for features still to come; `execution` is described under [Isolated execution](#isolated-execution), `hiddenTests` and `verification` under [Trusted verification](#trusted-verification).

Autopilot checks reported conversation costs before starting more work and after each poll. At the run limit (the amount entered in Home, or `budget.perChangeUsd`), it pauses the run's agents and opens a budget decision in the Inbox. At a work order's limit, it pauses that order while the others continue. Continue adds the policy's base budget to the relevant limit; Skip ends that work order; Cancel ends the run. Limits and decisions persist across restarts, and a normal Resume cannot bypass a run budget decision. Spending can rise between checks or while a pause request completes; enforcement depends on the agent server reporting costs.

## Isolated execution

By default (`execution.provider: local`) Autopilot's agents, their tools and the gates run on this machine with your permissions, through Canvas's agent server. Nothing is isolated, and Home, the run page and evidence say so.

With `execution.provider: container`, the factory starts one agent-server container per agent attempt from the digest-pinned `image`, with the same lifecycle as the agent server's own Docker runtime: all capabilities dropped, `no-new-privileges`, the memory, CPU and process limits above, the policy's `network`, and the agent server published on 127.0.0.1 only, with a session key derived from `data/runtime.key`. Only the attempt's worktree is mounted (at `/workspace`), its `.git` file hidden behind a read-only empty file, so nothing in the container can point the factory's git elsewhere. Agents there have no git: the factory commits what they leave, and a reviewer reads the diff from `/factory/changes.diff`. Each role gets only the environment variables its `credentials` list names; values never appear in arguments, the ledger, the audit log or evidence. The factory copies the role's Canvas agent profile into the container, so use ACP profiles (Claude Code, Codex) whose keys come from those variables. Gates run in throwaway containers on `gateNetwork`, without credentials.

Before a run starts, and from **Check isolation** on Home, the factory checks that Docker answers, the image and networks exist, every named credential is set, a container can read a file the factory writes through the mount (path mapping), and that a container on the network can't reach the factory API or Canvas on this machine. Docker Desktop forwards `host.docker.internal` to this machine's loopback, so an agent on a plain bridge network could call the factory as you: use a network without access to this machine. A run that fails a check doesn't start. If Docker stops mid-run, the run waits for it, as it does for an unreachable agent server.

Containers are named after their attempt, so a restarted factory reconnects to running ones. A container that disappears ends its attempt, and the normal repair loop starts a fresh one. Containers are removed once their attempt can't get another message (its work order merged, a newer attempt replaced it, or the run ended); leftovers are swept at startup. Transcripts stay in `data/runtime/<run>/a<attempt>/state`, not in Canvas. The container provider has been tested against a stand-in Docker CLI, not yet against a live Docker engine and agent-server image.

## Trusted verification

A run fixes its checks when it starts, from the base branch: the policy's `gates`, or else the `typecheck`, `lint` and `test` scripts (with their `pre`/`post` scripts) of the base branch's package.json files, at the root and one folder down. The factory runs those script bodies itself, with `node_modules/.bin` on PATH, so a work order that rewrites a script, adds `.npmrc` settings or deletes a check doesn't change what runs. A work order that changes a pinned script needs a person's merge approval, because the next run would pin the change. When the base defines no checks, the work order's own scripts run, and evidence says the checks weren't pinned. Files under `verification.protectedPaths` that a work order changes are put back as they are on its base, and the run records it.

Every check records the commit it checked. When the gates pass, the factory checks the commit out again in a folder no agent sees and runs what the policy asks for:

- **Hidden tests** (`hiddenTests.enabled`). Before any work is checked, a test writer (another vendor than the spec agent, when there is one) writes one black-box `node:test` file per scenario from the spec. The factory keeps them in `data/hidden-tests/<run>/` with their digests, runs each work order's own after installing its dependencies, and runs all merged ones again on the integration branch after every merge. A builder hears the scenario and one line of the failure, never the test. With local execution agents run with your permissions and could read that folder: the tests stay hidden from builders only with isolated execution.
- **Trivy** (`verification.trivy.mode`). The factory runs the binary in `SF_TRIVY` without updating its database (keep it current with `trivy image --download-db-only`). It refuses a version other than `version`, a database older than `maxDbAgeHours`, and a binary that doesn't match `SF_TRIVY_SHA256`. Findings the work order's base already has don't count; new ones at the policy's `severities` go back to the builder as rule, package, file and line, never a secret's text. In `required` mode a scanner that can't answer stops the work order with a Retry in the Inbox; in `advisory` mode the run goes on and the check records why the scan didn't run.

When everything passes, the factory records a `verified` check for that commit. Merging needs one for the branch's current head: if the branch moved after verification it is verified again, and a merge approval given before that doesn't count. Evidence reports security scanning and independent validation as `recorded` only when every merged work order has them. The Trivy integration has been tested with a stand-in CLI, not yet with a real Trivy binary and database.

## Run evidence

On a finished, failed or cancelled run, choose **Download evidence** to save a JSON packet containing the recorded artifact commit, pinned policy hash, work order criteria/control mappings, gate metadata, agent costs and approval decisions. This works after worktrees are cleaned up. The API is `POST /sf-api/autopilot/runs/:id/evidence` with JSON `{}`; active runs return 409 and missing runs return 404. A damaged audit chain blocks export with a visible error.

The response contains `packet` and its SHA-256 `digest`. Hash only `packet` using `sf-canonical-json-v1`: recursively sort object keys, preserve array order and serialize with JSON.stringify (undefined object members omitted). The existing `canonicalJson` and `sha256` exports in `apps/server/src/audit.ts` implement this format. The digest detects edits; the packet is unsigned and does not authenticate its producer. Preserve the exported file with the relevant Git objects and audit log if you need to investigate it later.

Artifact identity comes from the run's terminal audit event, never the current branch tip. Missing commits are marked unavailable; older failed/cancelled runs may have no recorded artifact. Historical gate checks lack commit binding, and output hashes cover only the stored output tail, not the full command log. Raw goals/prompts, agent replies, gate output, approval notes and arbitrary audit payloads are excluded. Work order titles and criteria remain project content: review them before sharing. Security scanning and independent validation are explicitly unrecorded; control mappings do not establish compliance.

The [implementation roadmap](docs/autopilot/ROADMAP.md) selects approaches from the researched projects and sequences isolation, trusted verification, durable recovery, PR delivery and governance after this evidence foundation.

## Working on the Canvas side

Factory UI code lives in `canvas\src\factory\`. Canvas is its own git repo on a `factory` branch, with OpenHands as the `upstream` remote.

- **Save your Canvas changes into this repo:** `pnpm export:canvas-patch`, then commit `patches\canvas-factory.patch`.
- **Push Canvas to your own GitHub fork:** `git -C canvas remote add origin <your-fork-url>`, then `git -C canvas push -u origin factory`.
- **Take a newer OpenHands release:** in `canvas\`, `git fetch --depth 50 upstream main`, then `git rebase upstream/main`. Fix conflicts (normally only in the three files listed in `canvas\src\factory\README.md`), run `pnpm export:canvas-patch`, and put the new commit in `canvas.lock.json`.

## Federal notes

- **Agents run with full permissions.** OpenHands approves every Claude Code and Codex permission request automatically, and `pnpm dev` runs the agent server directly on your machine. That's fine for trying it on the demo workspace. For agency code, run the agent server in Docker (see `canvas\README.windows.md`) so agents only see the folders you mount, and set `SF_AGENT_WORKSPACE`.
- **Approval is the gate.** Agents can change a work order, but only the Approve button records a person's approval. Anything else that marks work Done is flagged **Not approved**.
- **Telemetry is off.** `pnpm setup:canvas` sets `VITE_DO_NOT_TRACK=1` for Canvas, and OpenSpec runs with telemetry disabled. With that set, the only outside requests the browser made in testing were Google Fonts and an npm registry version check.
- **Canvas makes the workspace a git repo.** The first conversation in a folder that isn't one runs `git init` (no commit) so Canvas can show the agent's changes as a diff.
- **Subscriptions vs. products.** Your own Claude and Codex logins are fine while you build. Something you ship to agencies must use API keys or an approved endpoint such as Bedrock. Anthropic's terms don't let third-party products use claude.ai logins.
- The factory API listens on 127.0.0.1 only.

## Troubleshooting

- **The factory pages say the API isn't running:** `pnpm dev` starts it. If you started Canvas separately, run `pnpm dev:api` in another terminal.
- **`pnpm setup:canvas` says the patch doesn't apply:** `canvas\` has other changes or a different commit. Commit or stash them, or move `canvas\` aside and run it again.
- **The agent server won't start on Windows:** OpenHands doesn't test native Windows in CI yet. Run the same steps inside WSL2 (Ubuntu) with Node 24 and uv installed there.
- **Codex says to sign in:** run `codex login`, then start a new conversation.
- **Port 8000 is in use:** stop the other app, or see `canvas\docs\DEVELOPMENT.md` for Canvas's port settings.

## Versions

OpenHands Agent Canvas 1.27.1 (commit `0452907`), OpenSpec 1.14.0, Backlog.md 1.53.0, Hono 4.13. Pinned in `canvas.lock.json` and `apps/server/package.json`.
