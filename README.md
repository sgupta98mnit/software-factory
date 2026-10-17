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
| `SF_DATA_DIR` | `data` | Where the audit log is kept |

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
